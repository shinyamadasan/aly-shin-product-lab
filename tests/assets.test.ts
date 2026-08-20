import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildAssetContentFromCompletedJob,
  createAssetFromCompletedJob,
  fromAssetRow,
  getAssetForJob,
  isAssetContentV1,
  ASSET_OWNER_DECISIONS,
  ASSET_STATUSES,
  isAssetOwnerDecision,
  isAssetStatus,
  runMockAssetJobAndMaterializeAsset,
  type AssetRunnerClient,
  type AssetRow,
} from "../src/lib/assets.ts";
import { buildMockAssetJobResult, fromAssetJobRow, type AssetJobRow } from "../src/lib/asset-jobs.ts";
import { type AssetJobAttemptRow } from "../src/lib/asset-job-attempts.ts";
import { fromAssetFileRow, insertAssetFilesForAsset, listAssetFilesForAsset, type AssetFileClient, type AssetFileRow } from "../src/lib/asset-files.ts";
import { fromCreativePackageRow, type CreativePackageRow } from "../src/lib/creative-packages.ts";
import { GENERATED_ASSETS_BUCKET } from "../src/lib/asset-binary.ts";

type ErrorLike = { code?: string; message: string };

const fixedNow = "2026-07-31T10:00:00.000Z";
const startedAt = "2026-07-31T10:01:00.000Z";
// Stands in for finish_asset_job/finish_asset_job_attempt's own now() -- deliberately later than
// startedAt so latency/ordering assertions are meaningful.
const finishedAt = "2026-07-31T10:05:00.000Z";

function creativePackageRow(overrides: Partial<CreativePackageRow> = {}): CreativePackageRow {
  return {
    id: "package-1",
    creative_job_id: "job-1",
    status: "ready",
    schema_version: "v1",
    content: {
      output: { headline: "Launch-ready Brownies content", caption: "Brownies are ready." },
      metadata: {
        generatedFromOpportunity: "opportunity-1",
        generatorVersion: "1",
        sourceCreativeJobId: "job-1",
        sourceWorker: "mock",
        sourceJobResultSchemaVersion: "v1",
      },
      artifacts: [],
    },
    created_at: "2026-07-31T09:05:00.000Z",
    updated_at: "2026-07-31T09:05:00.000Z",
    ...overrides,
  };
}

function completedAssetJobRow(overrides: Partial<AssetJobRow> = {}): AssetJobRow {
  return {
    id: "asset-job-1",
    creative_package_id: "package-1",
    status: "completed",
    worker_type: "mock",
    asset_kind: "image",
    attempt_count: 1,
    result: buildMockAssetJobResult(fromCreativePackageRow(creativePackageRow()), "image"),
    last_error: null,
    created_at: "2026-07-31T09:10:00.000Z",
    updated_at: fixedNow,
    started_at: startedAt,
    completed_at: fixedNow,
    failed_at: null,
    ...overrides,
  };
}

function assetRow(overrides: Partial<AssetRow> = {}): AssetRow {
  const job = fromAssetJobRow(completedAssetJobRow());
  return {
    id: "asset-1",
    asset_job_id: "asset-job-1",
    status: "generated",
    asset_kind: "image",
    schema_version: "v1",
    content: buildAssetContentFromCompletedJob(job),
    created_at: "2026-07-31T10:05:00.000Z",
    updated_at: "2026-07-31T10:05:00.000Z",
    ...overrides,
  };
}

function assetFileRow(overrides: Partial<AssetFileRow> = {}): AssetFileRow {
  return {
    id: "file-1",
    asset_id: "asset-1",
    position: 0,
    storage_bucket: "mock",
    storage_path: "mock/package-1/0.png",
    public_url: "",
    mime_type: "image/png",
    file_size_bytes: 1024,
    width: 512,
    height: 512,
    duration_ms: null,
    checksum_sha256: null,
    created_at: "2026-07-31T10:05:00.000Z",
    ...overrides,
  };
}

function makeClient(
  options: {
    creativePackages?: CreativePackageRow[];
    jobs?: AssetJobRow[];
    assets?: AssetRow[];
    files?: AssetFileRow[];
    assetSelectError?: ErrorLike;
    assetInsertError?: ErrorLike;
    fileInsertError?: ErrorLike;
    uniqueRaceAsset?: AssetRow;
    completeWithFilesError?: ErrorLike;
  } = {},
) {
  const creativePackages = [...(options.creativePackages ?? [creativePackageRow()])];
  const jobs = [...(options.jobs ?? [completedAssetJobRow()])];
  const assets = [...(options.assets ?? [])];
  const files = [...(options.files ?? [])];
  const attempts: AssetJobAttemptRow[] = [];
  const events: string[] = [];
  const uploadedObjects = new Map<string, Uint8Array>();
  let assetInsertCalls = 0;
  let fileInsertCalls = 0;

  function matches(row: Record<string, unknown>, filters: Array<{ column: string; value: string }>): boolean {
    return filters.every(({ column, value }) => row[column] === value);
  }

  function queryBuilder<T>(rows: T[], selectError?: ErrorLike) {
    const filters: Array<{ column: string; value: string }> = [];
    const orders: Array<{ column: string; ascending: boolean }> = [];
    const builder = {
      eq(column: string, value: string) {
        filters.push({ column, value });
        return builder;
      },
      order(column: string, orderOptions: { ascending: boolean }) {
        orders.push({ column, ascending: orderOptions.ascending });
        return builder;
      },
      async maybeSingle() {
        if (selectError) {
          return { data: null, error: selectError };
        }
        return { data: rows.find((row) => matches(row as Record<string, unknown>, filters)) ?? null, error: null };
      },
      select() {
        return {
          maybeSingle: builder.maybeSingle,
          async single() {
            const result = await builder.maybeSingle();
            return result.data ? result : { data: null, error: { message: "No row returned." } };
          },
        };
      },
      then(resolve: (value: { data: T[] | null; error: ErrorLike | null }) => unknown, reject?: (reason: unknown) => unknown) {
        if (selectError) {
          return Promise.resolve({ data: null, error: selectError }).then(resolve, reject);
        }
        const data = rows
          .filter((row) => matches(row as Record<string, unknown>, filters))
          .sort((a, b) => {
            for (const order of orders) {
              const left = Number((a as Record<string, unknown>)[order.column] ?? 0);
              const right = Number((b as Record<string, unknown>)[order.column] ?? 0);
              if (left !== right) return (left - right) * (order.ascending ? 1 : -1);
            }
            return 0;
          });
        return Promise.resolve({ data, error: null }).then(resolve, reject);
      },
    };
    return builder;
  }

  const client = {
    from(table: string) {
      if (table === "creative_packages") {
        return {
          select() {
            return queryBuilder(creativePackages);
          },
        };
      }

      if (table === "asset_jobs") {
        return {
          select() {
            return queryBuilder(jobs);
          },
        };
      }

      if (table === "asset_files") {
        return {
          select() {
            return queryBuilder(files);
          },
          insert(rows: Partial<AssetFileRow>[]) {
            return {
              async select() {
                fileInsertCalls += 1;
                events.push("insert-files");
                if (options.fileInsertError) {
                  return { data: null, error: options.fileInsertError };
                }
                const inserted = rows.map(
                  (row, index) =>
                    ({
                      asset_id: row.asset_id!,
                      position: row.position ?? index,
                      storage_bucket: row.storage_bucket!,
                      storage_path: row.storage_path!,
                      public_url: row.public_url!,
                      mime_type: row.mime_type!,
                      file_size_bytes: row.file_size_bytes!,
                      width: row.width ?? null,
                      height: row.height ?? null,
                      duration_ms: row.duration_ms ?? null,
                      checksum_sha256: row.checksum_sha256 ?? null,
                      id: `file-${files.length + index + 1}`,
                      created_at: fixedNow,
                    }) satisfies AssetFileRow,
                );
                files.push(...inserted);
                return { data: inserted, error: null };
              },
            };
          },
        };
      }

      assert.equal(table, "assets");
      return {
        select() {
          return queryBuilder(assets, options.assetSelectError);
        },
        insert(row: Partial<AssetRow>) {
          return {
            select() {
              return {
                async single() {
                  assetInsertCalls += 1;
                  events.push("insert-asset");
                  if (options.uniqueRaceAsset && assetInsertCalls === 1) {
                    assets.push(options.uniqueRaceAsset);
                    return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } };
                  }
                  if (options.assetInsertError) {
                    return { data: null, error: options.assetInsertError };
                  }
                  const inserted = {
                    asset_job_id: row.asset_job_id!,
                    status: row.status ?? "generated",
                    asset_kind: row.asset_kind ?? "image",
                    schema_version: row.schema_version ?? "v1",
                    content: row.content ?? {},
                    id: `asset-${assets.length + 1}`,
                    created_at: fixedNow,
                    updated_at: fixedNow,
                  } satisfies AssetRow;
                  assets.push(inserted);
                  return { data: inserted, error: null };
                },
              };
            },
          };
        },
      };
    },
    rpc(functionName: string, args: Record<string, unknown>) {
      if (functionName === "claim_asset_job_with_attempt") {
        return {
          async maybeSingle() {
            const index = jobs.findIndex((row) => row.id === (args.p_job_id as string) && row.status === "queued");
            if (index === -1) {
              return { data: null, error: null };
            }
            jobs[index] = {
              ...jobs[index],
              status: "running",
              attempt_count: jobs[index].attempt_count + 1,
              started_at: startedAt,
              updated_at: startedAt,
            };
            events.push("claim-job");
            const attempt: AssetJobAttemptRow = {
              id: `attempt-${attempts.length + 1}`,
              asset_job_id: jobs[index].id!,
              attempt_number: jobs[index].attempt_count,
              worker_type: jobs[index].worker_type,
              status: "running",
              started_at: startedAt,
              completed_at: null,
              latency_ms: null,
              error_code: null,
              error_message: null,
              provider: null,
              model: null,
              created_at: fixedNow,
            };
            attempts.push(attempt);
            return { data: { ...jobs[index], attempt_id: attempt.id, attempt_number: attempt.attempt_number }, error: null };
          },
        };
      }

      if (functionName === "finish_asset_job") {
        return {
          async maybeSingle() {
            const outcome = args.p_outcome as string;
            const validOutcome = outcome === "completed" || outcome === "failed";
            const index = jobs.findIndex((row) => row.id === (args.p_job_id as string) && row.status === "running");
            if (index === -1 || !validOutcome) {
              return { data: null, error: null };
            }
            jobs[index] = {
              ...jobs[index],
              status: outcome as AssetJobRow["status"],
              result: outcome === "completed" ? (args.p_result as AssetJobRow["result"]) : jobs[index].result,
              last_error: outcome === "failed" ? (args.p_last_error as string | null) : null,
              completed_at: outcome === "completed" ? finishedAt : null,
              failed_at: outcome === "failed" ? finishedAt : null,
              updated_at: finishedAt,
            };
            events.push(outcome === "completed" ? "complete-job" : "fail-job");
            return { data: jobs[index], error: null };
          },
        };
      }

      if (functionName === "complete_asset_job_with_files") {
        return {
          async maybeSingle() {
            if (options.completeWithFilesError) {
              return { data: null, error: options.completeWithFilesError };
            }
            const index = jobs.findIndex((row) => row.id === (args.p_asset_job_id as string) && row.status === "running");
            if (index === -1) {
              return { data: null, error: null };
            }
            jobs[index] = {
              ...jobs[index],
              status: "completed",
              result: args.p_result as AssetJobRow["result"],
              last_error: null,
              completed_at: finishedAt,
              failed_at: null,
              updated_at: finishedAt,
            };
            events.push("complete-job-with-files");
            const file = (args.p_files as Array<Record<string, unknown>>)[0];
            const asset = {
              id: "asset-1",
              asset_job_id: jobs[index].id!,
              status: "generated",
              asset_kind: jobs[index].asset_kind,
              schema_version: "v1",
              content: { metadata: { generatedFromCreativePackage: jobs[index].creative_package_id, sourceAssetJobId: jobs[index].id, generatorVersion: "1" } },
              created_at: finishedAt,
              updated_at: finishedAt,
            } satisfies AssetRow;
            const assetFile = {
              id: "file-1",
              asset_id: asset.id,
              position: Number(file.position),
              storage_bucket: String(file.storage_bucket),
              storage_path: String(file.storage_path),
              public_url: String(file.public_url),
              mime_type: String(file.mime_type),
              file_size_bytes: Number(file.file_size_bytes),
              width: Number(file.width),
              height: Number(file.height),
              duration_ms: null,
              checksum_sha256: String(file.checksum_sha256),
              created_at: finishedAt,
            } satisfies AssetFileRow;
            if (!assets.some((row) => row.id === asset.id)) assets.push(asset);
            if (!files.some((row) => row.id === assetFile.id)) files.push(assetFile);
            return { data: { job: jobs[index], asset, files: [assetFile] }, error: null };
          },
        };
      }

      assert.equal(functionName, "finish_asset_job_attempt");
      return {
        async maybeSingle() {
          const outcome = args.p_outcome as string;
          const validOutcome = outcome === "completed" || outcome === "failed" || outcome === "timed_out";
          const index = attempts.findIndex((row) => row.id === (args.p_attempt_id as string) && row.status === "running");
          if (index === -1 || !validOutcome) {
            return { data: null, error: null };
          }
          attempts[index] = {
            ...attempts[index],
            status: outcome as AssetJobAttemptRow["status"],
            completed_at: finishedAt,
            latency_ms: Date.parse(finishedAt) - Date.parse(attempts[index].started_at),
            error_code: outcome === "completed" ? null : (args.p_error_code as string | null),
            error_message: outcome === "completed" ? null : (args.p_error_message as string | null),
          };
          events.push(outcome === "completed" ? "finish-attempt-completed" : outcome === "timed_out" ? "finish-attempt-timed-out" : "finish-attempt-failed");
          return { data: attempts[index], error: null };
        },
      };
    },
    storage: {
      from(bucket: string) {
        assert.equal(bucket, GENERATED_ASSETS_BUCKET);
        return {
          async upload(path: string, body: Uint8Array) {
            events.push(`upload:${path}`);
            if (uploadedObjects.has(path)) {
              return { data: null, error: { statusCode: "409", message: "The resource already exists" } };
            }
            uploadedObjects.set(path, body);
            return { data: { path }, error: null };
          },
          async download(path: string) {
            events.push(`download:${path}`);
            const data = uploadedObjects.get(path);
            return data ? { data, error: null } : { data: null, error: { message: "not found" } };
          },
          async remove(paths: string[]) {
            events.push(`remove:${paths.join(",")}`);
            for (const path of paths) uploadedObjects.delete(path);
            return { data: [], error: null };
          },
        };
      },
    },
  } as unknown as AssetRunnerClient;

  return {
    client,
    creativePackages,
    jobs,
    assets,
    files,
    attempts,
    events,
    get assetInsertCalls() {
      return assetInsertCalls;
    },
    get fileInsertCalls() {
      return fileInsertCalls;
    },
  };
}

test("the Asset review vocabulary is exactly what the pipeline writes plus what the OWNER decides", () => {
  // "generated" is the pipeline's. "accepted"/"rejected" are the owner's, added in Wave B's owner
  // workflow -- assets.status is plain text with no CHECK constraint, so this needed no migration.
  assert.deepEqual([...ASSET_STATUSES], ["generated", "accepted", "rejected"]);
  for (const status of ASSET_STATUSES) {
    assert.equal(isAssetStatus(status), true);
  }

  // Still closed against everything else. "approved" in particular stays OUT: the deferred human
  // review gate owns that word along with reviewed_by/reviewed_at/rejection_reason, and
  // supabase-add-assets.sql still refuses those columns.
  for (const status of ["queued", "completed", "failed", "approved", "draft", "published", "archived"]) {
    assert.equal(isAssetStatus(status), false, `${status} must not be an Asset status`);
  }
});

test("only the OWNER decisions are offered as decisions -- an Asset can never be returned to undecided", () => {
  assert.deepEqual([...ASSET_OWNER_DECISIONS], ["accepted", "rejected"]);
  assert.equal(isAssetOwnerDecision("accepted"), true);
  assert.equal(isAssetOwnerDecision("rejected"), true);
  // "generated" is a pipeline state, not a decision the owner may write back.
  assert.equal(isAssetOwnerDecision("generated"), false);
  for (const decision of ASSET_OWNER_DECISIONS) {
    assert.equal(isAssetStatus(decision), true, "every owner decision must be a valid Asset status");
  }
});

test("[static] nothing in the production pipeline can mark its own output accepted", () => {
  // The ONLY writer of an owner decision is setAssetOwnerDecision, and it is called from the owner's
  // UI. If an executor, the runner, or materialization ever gained the ability to set this, a machine
  // would be declaring its own work visually accepted.
  for (const file of ["../src/lib/asset-jobs.ts", "../src/lib/asset-file-materialization.ts", "../src/lib/production-execution.ts", "../src/lib/production-asset-executors.ts"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.equal(source.includes("setAssetOwnerDecision"), false, `${file} must not decide acceptance`);
    assert.doesNotMatch(source, /status:\s*"accepted"/, `${file} must not write an accepted status`);
  }
});

test("fromAssetRow maps one generated asset", () => {
  const record = fromAssetRow(assetRow());
  assert.equal(record.id, "asset-1");
  assert.equal(record.assetJobId, "asset-job-1");
  assert.equal(record.status, "generated");
  assert.equal(record.assetKind, "image");
  assert.equal(record.schemaVersion, "v1");
});

test("buildAssetContentFromCompletedJob creates deterministic, small content that drops file descriptors", () => {
  const job = fromAssetJobRow(completedAssetJobRow());
  const first = buildAssetContentFromCompletedJob(job);
  const second = buildAssetContentFromCompletedJob(job);

  assert.deepEqual(first, second);
  assert.equal(first.metadata.generatedFromCreativePackage, "package-1");
  assert.equal(first.metadata.sourceAssetJobId, "asset-job-1");
  assert.equal(first.metadata.generatorVersion, "1");
  assert.doesNotMatch(JSON.stringify(first), /storageBucket|storagePath|mimeType/i);
});

test("buildAssetContentFromCompletedJob threads sourceWorkspace/sourceKind/briefSchemaVersion/briefSha256 through, and never provider/model (PROP-027 P4 contract)", () => {
  const baseResult = buildMockAssetJobResult(fromCreativePackageRow(creativePackageRow()), "image");
  const job = fromAssetJobRow(
    completedAssetJobRow({
      result: {
        ...baseResult,
        metadata: {
          ...baseResult.metadata,
          sourceWorkspace: "chatgpt",
          sourceKind: "ai_generated",
          briefSchemaVersion: "v1",
          briefSha256: "a".repeat(64),
        },
      },
    }),
  );

  const content = buildAssetContentFromCompletedJob(job);

  assert.equal(content.metadata.sourceWorkspace, "chatgpt");
  assert.equal(content.metadata.sourceKind, "ai_generated");
  assert.equal(content.metadata.briefSchemaVersion, "v1");
  assert.equal(content.metadata.briefSha256, "a".repeat(64));

  // Lock the contract: this exhaustive key list is the real enforcement -- if a future API-provider
  // milestone ever added provider/model to an Asset's own content instead of to asset_job_attempts
  // (where they belong), this assertion fails immediately, no matter what the new keys are named.
  assert.deepEqual(
    Object.keys(content.metadata).sort(),
    ["briefSchemaVersion", "briefSha256", "generatedFromCreativePackage", "generatorVersion", "sourceAssetJobId", "sourceKind", "sourceWorkspace"].sort(),
  );
});

test("buildAssetContentFromCompletedJob leaves sourceWorkspace/sourceKind/briefSchemaVersion/briefSha256 unset when the completed job declared none, matching every job before PROP-027 P4", () => {
  const job = fromAssetJobRow(completedAssetJobRow());
  const content = buildAssetContentFromCompletedJob(job);

  assert.equal(content.metadata.sourceWorkspace, undefined);
  assert.equal(content.metadata.sourceKind, undefined);
  assert.equal(content.metadata.briefSchemaVersion, undefined);
  assert.equal(content.metadata.briefSha256, undefined);
});

test("buildAssetContentFromCompletedJob rejects a non-completed job or an unsupported result", () => {
  assert.throws(() => buildAssetContentFromCompletedJob(fromAssetJobRow(completedAssetJobRow({ status: "running" }))), /can only be materialized from completed Asset Jobs/);
  assert.throws(() => buildAssetContentFromCompletedJob(fromAssetJobRow(completedAssetJobRow({ result: { schemaVersion: "v2" } }))), /not a supported v1 asset source/);
});

test("isAssetContentV1 requires the supported content shape", () => {
  assert.equal(isAssetContentV1(assetRow().content), true);
  assert.equal(isAssetContentV1({ metadata: { generatedFromCreativePackage: "package-1", sourceAssetJobId: "asset-job-1", generatorVersion: "1" } }), true);
  assert.equal(isAssetContentV1({ metadata: { generatedFromCreativePackage: "", sourceAssetJobId: "asset-job-1", generatorVersion: "1" } }), false);
  assert.equal(isAssetContentV1({ metadata: { generatedFromCreativePackage: "package-1" } }), false);
  assert.equal(isAssetContentV1({}), false);

  // PROP-027 P4: sourceWorkspace/sourceKind/briefSchemaVersion/briefSha256 are optional and, when
  // present, validated -- sourceKind especially must stay a closed vocabulary, never an arbitrary
  // string a future API integration could repurpose as an informal provider label.
  const base = { generatedFromCreativePackage: "package-1", sourceAssetJobId: "asset-job-1", generatorVersion: "1" as const };
  assert.equal(isAssetContentV1({ metadata: { ...base, sourceWorkspace: "chatgpt", sourceKind: "ai_generated", briefSchemaVersion: "v1", briefSha256: "abc" } }), true);
  assert.equal(isAssetContentV1({ metadata: { ...base, sourceKind: "photograph" } }), true);
  assert.equal(isAssetContentV1({ metadata: { ...base, sourceKind: "human_designed" } }), true);
  assert.equal(isAssetContentV1({ metadata: { ...base, sourceKind: "api_generated" } }), false);
  assert.equal(isAssetContentV1({ metadata: { ...base, sourceWorkspace: 123 } }), false);
  assert.equal(isAssetContentV1({ metadata: { ...base, briefSha256: 456 } }), false);
});

test("createAssetFromCompletedJob creates one generated asset and its ordered asset_files from a completed job", async () => {
  const store = makeClient();
  const originalJob = JSON.stringify(store.jobs[0]);
  const result = await createAssetFromCompletedJob(store.client, "asset-job-1");

  assert.equal(result.ok, true);
  assert.equal(store.assetInsertCalls, 1);
  assert.equal(store.fileInsertCalls, 1);
  assert.equal(store.assets.length, 1);
  assert.equal(store.files.length, 1);
  assert.equal(JSON.stringify(store.jobs[0]), originalJob);
  if (result.ok) {
    assert.equal(result.outcome, "created");
    assert.equal(result.asset.status, "generated");
    assert.equal(result.asset.assetKind, "image");
    assert.equal(isAssetContentV1(result.asset.content), true);
    assert.equal(result.files.length, 1);
    assert.equal(result.files[0].position, 0);
    assert.equal(result.files[0].storageBucket, "mock");
    assert.equal(result.files[0].assetId, result.asset.id);
  }
});

test("createAssetFromCompletedJob returns an existing asset with its real files instead of creating a duplicate", async () => {
  const existing = assetRow();
  const store = makeClient({ assets: [existing], files: [assetFileRow({ asset_id: existing.id! })] });
  const result = await createAssetFromCompletedJob(store.client, "asset-job-1");

  assert.equal(result.ok, true);
  assert.equal(store.assetInsertCalls, 0);
  assert.equal(store.fileInsertCalls, 0);
  assert.equal(store.assets.length, 1);
  if (result.ok) {
    assert.equal(result.outcome, "existing");
    assert.equal(result.asset.id, "asset-1");
    assert.equal(result.files.length, 1);
    assert.equal(result.files[0].id, "file-1");
  }
});

test("createAssetFromCompletedJob handles a unique insert race by rereading the same asset and its files", async () => {
  const raced = assetRow({ id: "raced-asset" });
  const store = makeClient({ uniqueRaceAsset: raced, files: [assetFileRow({ id: "raced-file", asset_id: "raced-asset" })] });
  const result = await createAssetFromCompletedJob(store.client, "asset-job-1");

  assert.equal(result.ok, true);
  assert.equal(store.assetInsertCalls, 1);
  assert.equal(store.assets.length, 1);
  if (result.ok) {
    assert.equal(result.outcome, "existing");
    assert.equal(result.asset.id, "raced-asset");
    assert.equal(result.files[0].id, "raced-file");
  }
});

test("createAssetFromCompletedJob rejects non-completed jobs", async () => {
  for (const status of ["queued", "running", "failed"] as const) {
    const store = makeClient({ jobs: [completedAssetJobRow({ status })] });
    const result = await createAssetFromCompletedJob(store.client, "asset-job-1");

    assert.equal(result.ok, false);
    assert.equal(result.reason, "invalid-job-status");
    assert.equal(store.assetInsertCalls, 0);
    assert.equal(store.assets.length, 0);
  }
});

test("createAssetFromCompletedJob rejects missing jobs and malformed results", async () => {
  const missing = makeClient({ jobs: [] });
  const missingResult = await createAssetFromCompletedJob(missing.client, "asset-job-1");
  assert.equal(missingResult.ok, false);
  assert.equal(missingResult.reason, "not-found");

  const malformed = makeClient({ jobs: [completedAssetJobRow({ result: { schemaVersion: "v1", worker: "mock", assetKind: "image", output: { files: [] }, metadata: { generatedFromCreativePackage: "package-1", generatorVersion: "1" } } })] });
  const malformedResult = await createAssetFromCompletedJob(malformed.client, "asset-job-1");
  assert.equal(malformedResult.ok, false);
  assert.equal(malformedResult.reason, "unsupported-result");
  assert.equal(malformed.assetInsertCalls, 0);

  const unsupported = makeClient({ jobs: [completedAssetJobRow({ result: { schemaVersion: "v2", worker: "mock", assetKind: "image", output: { files: [] }, metadata: { generatedFromCreativePackage: "package-1", generatorVersion: "1" } } })] });
  const unsupportedResult = await createAssetFromCompletedJob(unsupported.client, "asset-job-1");
  assert.equal(unsupportedResult.ok, false);
  assert.equal(unsupportedResult.reason, "unsupported-result");
});

test("createAssetFromCompletedJob reports database failures honestly", async () => {
  const store = makeClient({ assetInsertError: { message: "write failed" } });
  const result = await createAssetFromCompletedJob(store.client, "asset-job-1");

  assert.equal(result.ok, false);
  assert.equal(result.reason, "failed");
  assert.equal(result.message, "write failed");
  assert.equal(store.assets.length, 0);
});

test("createAssetFromCompletedJob leaves the Asset row in place, unreverted, when its Asset Files write fails -- a documented, accepted non-atomicity", async () => {
  const store = makeClient({ fileInsertError: { message: "files write failed" } });
  const result = await createAssetFromCompletedJob(store.client, "asset-job-1");

  assert.equal(result.ok, false);
  assert.equal(result.reason, "failed");
  assert.equal(result.message, "files write failed");
  assert.equal(store.assets.length, 1, "the Asset row must survive a downstream Asset Files failure, not be rolled back");
  assert.equal(store.files.length, 0);
});

test("getAssetForJob returns not-found without pretending an asset exists", async () => {
  const store = makeClient();
  const result = await getAssetForJob(store.client, "asset-job-1");

  assert.equal(result.ok, false);
  assert.equal(result.reason, "not-found");
});

test("runMockAssetJobAndMaterializeAsset uses the byte-backed runner materialization path", async () => {
  const store = makeClient({ jobs: [completedAssetJobRow({ status: "queued", attempt_count: 0, result: {}, started_at: null, completed_at: null })] });
  const result = await runMockAssetJobAndMaterializeAsset(store.client, "asset-job-1");

  assert.equal(result.ok, true);
  assert.equal(store.events[0], "claim-job");
  assert.equal(store.events[1]?.startsWith("upload:asset-jobs/asset-job-1/attempt-1/"), true);
  assert.deepEqual(store.events.slice(2), ["complete-job-with-files", "finish-attempt-completed"]);
  assert.equal(store.jobs[0].status, "completed");
  assert.equal(store.jobs[0].attempt_count, 1);
  assert.equal(store.assets.length, 1);
  assert.equal(store.files.length, 1);
  assert.equal(store.creativePackages[0].status, "ready");
  assert.equal(store.attempts[0].status, "completed");
  if (result.ok) {
    assert.equal(result.outcome, "created");
  }
});

test("runMockAssetJobAndMaterializeAsset fails the running job if byte-backed materialization fails", async () => {
  const store = makeClient({
    jobs: [completedAssetJobRow({ status: "queued", attempt_count: 0, result: {}, started_at: null, completed_at: null })],
    completeWithFilesError: { message: "asset write failed" },
  });
  const result = await runMockAssetJobAndMaterializeAsset(store.client, "asset-job-1");

  assert.equal(result.ok, false);
  assert.equal(result.reason, "failed");
  assert.equal(result.message, "asset write failed");
  assert.equal(store.jobs[0].status, "failed");
  assert.equal(store.jobs[0].completed_at, null);
  assert.equal(store.assets.length, 0);
});

test("runMockAssetJobAndMaterializeAsset is safe to invoke after an asset already exists", async () => {
  const store = makeClient({ jobs: [completedAssetJobRow({ status: "queued", attempt_count: 0, result: {}, started_at: null, completed_at: null })] });
  const first = await runMockAssetJobAndMaterializeAsset(store.client, "asset-job-1");
  const second = await createAssetFromCompletedJob(store.client, "asset-job-1");

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(store.assets.length, 1);
  if (second.ok) {
    assert.equal(second.outcome, "existing");
  }
});

test("asset code does not call external providers, use the Supabase SDK directly, or create excluded records", () => {
  const assetsSource = readFileSync(new URL("../src/lib/assets.ts", import.meta.url), "utf8");
  const assetFilesSource = readFileSync(new URL("../src/lib/asset-files.ts", import.meta.url), "utf8");

  for (const forbidden of [/OpenAI/i, /Gemini/i, /Veo/i, /Runway/i, /Remotion/i, /\bfetch\s*\(/, /from\("approvals"\)/i, /from\("publishing_jobs"\)/i, /from\("content_drafts"\)/i]) {
    assert.doesNotMatch(assetsSource, forbidden);
  }

  for (const forbidden of [/OpenAI/i, /Gemini/i, /Veo/i, /Runway/i, /Remotion/i, /\bfetch\s*\(/, /console\./, /@supabase\/supabase-js/i]) {
    assert.doesNotMatch(assetFilesSource, forbidden);
  }

  assert.doesNotMatch(assetsSource, /from\("opportunities"\)/i);
});

// -- Asset Files, in isolation --

test("fromAssetFileRow maps nullable fields to empty string or null defaults", () => {
  const record = fromAssetFileRow(assetFileRow());
  assert.equal(record.id, "file-1");
  assert.equal(record.assetId, "asset-1");
  assert.equal(record.position, 0);
  assert.equal(record.width, 512);
  assert.equal(record.height, 512);
  assert.equal(record.durationMs, null);
  assert.equal(record.checksumSha256, "");
});

test("fromAssetFileRow throws when id or created_at is missing", () => {
  assert.throws(() => fromAssetFileRow(assetFileRow({ id: undefined })), /missing id or created_at/);
  assert.throws(() => fromAssetFileRow(assetFileRow({ created_at: undefined })), /missing id or created_at/);
});

test("insertAssetFilesForAsset is a pure, order-preserving projection of descriptors onto rows", async () => {
  const store = makeClient();
  const descriptor = buildMockAssetJobResult(fromCreativePackageRow(creativePackageRow()), "image").output.files[0];
  const result = await insertAssetFilesForAsset(store.client as unknown as AssetFileClient, "asset-1", [descriptor]);

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.files.length, 1);
    assert.equal(result.files[0].assetId, "asset-1");
    assert.equal(result.files[0].position, descriptor.position);
    assert.equal(result.files[0].storageBucket, descriptor.storageBucket);
    assert.equal(result.files[0].storagePath, descriptor.storagePath);
    assert.equal(result.files[0].mimeType, descriptor.mimeType);
    assert.equal(result.files[0].fileSizeBytes, descriptor.fileSizeBytes);
  }
});

test("insertAssetFilesForAsset reports a missing-table error distinctly from a generic failure", async () => {
  const missingTableStore = makeClient({ fileInsertError: { code: "PGRST205", message: "missing" } });
  const missingTableResult = await insertAssetFilesForAsset(missingTableStore.client as unknown as AssetFileClient, "asset-1", [buildMockAssetJobResult(fromCreativePackageRow(creativePackageRow()), "image").output.files[0]]);
  assert.equal(missingTableResult.ok, false);
  if (!missingTableResult.ok) {
    assert.equal(missingTableResult.reason, "missing-table");
  }
});

test("listAssetFilesForAsset returns files ordered by position", async () => {
  const store = makeClient({
    files: [assetFileRow({ id: "file-b", position: 1 }), assetFileRow({ id: "file-a", position: 0 })],
  });
  const result = await listAssetFilesForAsset(store.client as unknown as AssetFileClient, "asset-1");

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(
      result.files.map((file) => file.id),
      ["file-a", "file-b"],
    );
  }
});
