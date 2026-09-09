import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  ASSET_GENERATION_IMAGE_DIMENSIONS,
  buildAssetGenerationSpec,
  type AssetGenerationSpecV1,
} from "../src/lib/asset-generation-spec.ts";
import {
  type GeneratedAssetFileCandidate,
} from "../src/lib/asset-generation-validation.ts";
import type { ProductionSpecV1 } from "../src/lib/production-spec.ts";
import {
  ASSET_KINDS,
  EXECUTABLE_ASSET_KINDS,
  buildAssetGenerationSpecForJob,
  buildMockAssetJobResult,
  claimQueuedAssetJobWithAttempt,
  completeRunningAssetJob,
  createAssetJobForReadyCreativePackage,
  failRunningAssetJob,
  findQueuedExternalAssetJob,
  fromAssetJobRow,
  isAssetJobResultEnvelope,
  isAssetJobStatus,
  isAssetJobWorkerType,
  isAssetKind,
  runAssetJobWithExecutors,
  toExecutableAssetJobRoute,
  runMockAssetJob,
  runQueuedMockAssetJobs,
  sanitizeAssetJobErrorMessage,
  validateAssetJobResultEnvelope,
  type AssetJobExecutionClient,
  type AssetJobExecutorMap,
  type AssetJobRow,
} from "../src/lib/asset-jobs.ts";
import { isProductionRouteExecutable, resolveProductionRoute, type ProductionRoute } from "../src/lib/production-route.ts";
import { finishAssetJobAttempt, type AssetJobAttemptRow } from "../src/lib/asset-job-attempts.ts";
import { briefSha256 } from "../src/lib/asset-generation-brief.ts";
import { fromCreativePackageRow, type CreativePackageRow } from "../src/lib/creative-packages.ts";
import { BRAND_BIBLE } from "../src/lib/marketing-advisor-context.ts";
import { GENERATED_ASSETS_BUCKET } from "../src/lib/asset-binary.ts";

type ErrorLike = { code?: string; message: string };

const fixedNow = "2026-07-31T10:00:00.000Z";
const startedAt = "2026-07-31T10:01:00.000Z";
// The fake's finish_asset_job/finish_asset_job_attempt RPC handlers stamp this fixed "database
// now()" for every finish call, standing in for the SQL functions' own now() -- deliberately
// later than startedAt so latency/ordering assertions are meaningful. Nothing in production ever
// computes this value or passes it in.
const finishedAt = "2026-07-31T10:05:00.000Z";
const validBytes = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d,
  0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x04, 0x38,
  0x00, 0x00, 0x04, 0x38,
  0x08, 0x04, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00,
]);
// Real, decodable 1024x1024 bytes (not merely declared) -- an actual OpenAI/DALL-E-shaped output
// size, distinct from the 1080x1080 spec, so it exercises the P5 advisory path rather than the
// byte-level anti-tamper rejection.
const png1024 = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d,
  0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x04, 0x00,
  0x00, 0x00, 0x04, 0x00,
  0x08, 0x04, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00,
]);

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

function assetJobRow(overrides: Partial<AssetJobRow> = {}): AssetJobRow {
  return {
    id: "asset-job-1",
    creative_package_id: "package-1",
    status: "queued",
    worker_type: "mock",
    asset_kind: "image",
    attempt_count: 0,
    result: {},
    last_error: null,
    created_at: "2026-07-31T09:10:00.000Z",
    updated_at: "2026-07-31T09:10:00.000Z",
    started_at: null,
    completed_at: null,
    failed_at: null,
    ...overrides,
  };
}

function makeClient(
  options: {
    creativePackages?: CreativePackageRow[];
    jobs?: AssetJobRow[];
    selectError?: ErrorLike;
    insertError?: ErrorLike;
    rpcError?: ErrorLike;
    beforeRpc?: (jobs: AssetJobRow[]) => void;
    finishJobRpcError?: ErrorLike;
    finishAttemptRpcError?: ErrorLike;
    // Forces materialization to fail AFTER the executor has already produced valid bytes -- the one
    // window in which a provider really was contacted but the job still ends up failed.
    uploadError?: { statusCode?: string; message: string };
  } = {},
) {
  const creativePackages = [...(options.creativePackages ?? [creativePackageRow()])];
  const jobs = [...(options.jobs ?? [])];
  const attempts: AssetJobAttemptRow[] = [];
  const events: string[] = [];
  // Which attempt-finish RPC each call actually used -- the difference between "provenance was
  // recorded" and "the provenance-aware function was needlessly called with nulls".
  const rpcNames: string[] = [];
  const uploadedObjects = new Map<string, Uint8Array>();
  let insertCalls = 0;
  let rpcCalls = 0;
  let creativePackageSelectCalls = 0;
  let beforeRpcCalled = false;

  function matches(row: Record<string, unknown>, filters: Array<{ column: string; value: string }>): boolean {
    return filters.every(({ column, value }) => row[column] === value);
  }

  function queryBuilder<T>(rows: T[]) {
    const filters: Array<{ column: string; value: string }> = [];
    const orders: Array<{ column: string; ascending: boolean }> = [];
    let limitCount: number | null = null;
    const builder = {
      eq(column: string, value: string) {
        filters.push({ column, value });
        return builder;
      },
      limit(count: number) {
        limitCount = count;
        return builder;
      },
      order(column: string, orderOptions: { ascending: boolean }) {
        orders.push({ column, ascending: orderOptions.ascending });
        return builder;
      },
      async maybeSingle() {
        if (options.selectError) {
          return { data: null, error: options.selectError };
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
        if (options.selectError) {
          return Promise.resolve({ data: null, error: options.selectError }).then(resolve, reject);
        }
        const data = rows
          .filter((row) => matches(row as Record<string, unknown>, filters))
          .sort((a, b) => {
            for (const order of orders) {
              const left = String((a as Record<string, unknown>)[order.column] ?? "");
              const right = String((b as Record<string, unknown>)[order.column] ?? "");
              const comparison = left.localeCompare(right);
              if (comparison !== 0) return comparison * (order.ascending ? 1 : -1);
            }
            return 0;
          })
          .slice(0, limitCount ?? undefined);
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
            creativePackageSelectCalls += 1;
            return queryBuilder(creativePackages);
          },
        };
      }

      // asset_job_attempts has no from(...) handler -- finishAssetJobAttempt only ever calls the
      // finish_asset_job_attempt RPC below, matching the production client type.
      assert.equal(table, "asset_jobs");
      return {
        select() {
          return queryBuilder(jobs);
        },
        insert(row: Partial<AssetJobRow>) {
          return {
            select() {
              return {
                async single() {
                  insertCalls += 1;
                  if (options.insertError) {
                    return { data: null, error: options.insertError };
                  }
                  const inserted = {
                    creative_package_id: row.creative_package_id!,
                    status: row.status ?? "queued",
                    worker_type: row.worker_type ?? "mock",
                    asset_kind: row.asset_kind ?? "image",
                    attempt_count: row.attempt_count ?? 0,
                    result: row.result ?? {},
                    last_error: row.last_error ?? null,
                    id: `asset-job-${jobs.length + 1}`,
                    created_at: fixedNow,
                    updated_at: fixedNow,
                    started_at: null,
                    completed_at: null,
                    failed_at: null,
                  } satisfies AssetJobRow;
                  jobs.push(inserted);
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
            rpcCalls += 1;
            if (!beforeRpcCalled) {
              beforeRpcCalled = true;
              options.beforeRpc?.(jobs);
            }
            if (options.rpcError) {
              return { data: null, error: options.rpcError };
            }
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
          // Mirrors finish_asset_job's own guards: id + status='running' + p_outcome in
          // ('completed','failed'). A mismatch on either produces zero rows, exactly like the SQL.
          async maybeSingle() {
            rpcCalls += 1;
            if (options.finishJobRpcError) {
              return { data: null, error: options.finishJobRpcError };
            }
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
            rpcCalls += 1;
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
            return {
              data: {
                job: jobs[index],
                asset: {
                  id: "asset-1",
                  asset_job_id: jobs[index].id,
                  status: "generated",
                  asset_kind: jobs[index].asset_kind,
                  schema_version: "v1",
                  content: { metadata: { generatedFromCreativePackage: jobs[index].creative_package_id, sourceAssetJobId: jobs[index].id, generatorVersion: "1" } },
                  created_at: finishedAt,
                  updated_at: finishedAt,
                },
                files: [
                  {
                    id: "file-1",
                    asset_id: "asset-1",
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
                  },
                ],
              },
              error: null,
            };
          },
        };
      }

      // Both finish RPCs land here. They share every guard and differ only in whether they carry
      // provider/model, exactly as the two SQL functions do.
      assert.ok(
        functionName === "finish_asset_job_attempt" || functionName === "finish_asset_job_attempt_with_provenance",
        `unexpected attempt RPC: ${functionName}`,
      );
      rpcNames.push(functionName);
      return {
        // Mirrors finish_asset_job_attempt's own guards: id + status='running' + p_outcome in
        // ('completed','failed','timed_out'). latency_ms uses the same fixed clock as
        // completed_at, exactly like `now() - started_at` inside the real function.
        async maybeSingle() {
          // PostgreSQL/PostgREST resolve a function by NAME PLUS ARGUMENT NAMES. The 4-argument
          // finish_asset_job_attempt has no p_provider/p_model parameters, so sending them does not
          // "get ignored" -- no candidate function matches and the call fails outright. The fake
          // reproduces that, so a miswiring that sends provenance to the base RPC fails here exactly
          // as it would against a real database, instead of being silently accepted.
          if (functionName === "finish_asset_job_attempt" && ("p_provider" in args || "p_model" in args)) {
            return {
              data: null,
              error: {
                code: "PGRST202",
                message: "Could not find the function public.finish_asset_job_attempt(p_attempt_id, p_error_code, p_error_message, p_model, p_outcome, p_provider) in the schema cache",
              },
            };
          }
          const carriesProvenance = functionName === "finish_asset_job_attempt_with_provenance";
          rpcCalls += 1;
          if (options.finishAttemptRpcError) {
            return { data: null, error: options.finishAttemptRpcError };
          }
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
            // `coalesce(p_provider, provider)` / `coalesce(p_model, model)`. The base RPC supplies
            // neither argument, so undefined behaves exactly like the SQL's NULL: it never erases a
            // value, and it never invents one.
            // Only the provenance RPC can touch these two columns. coalesce(p_x, x) so a null argument
            // never erases an already-recorded value.
            provider: carriesProvenance ? ((args.p_provider as string | null) ?? attempts[index].provider ?? null) : attempts[index].provider,
            model: carriesProvenance ? ((args.p_model as string | null) ?? attempts[index].model ?? null) : attempts[index].model,
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
            if (options.uploadError) {
              return { data: null, error: options.uploadError };
            }
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
            for (const path of paths) {
              uploadedObjects.delete(path);
            }
            return { data: [], error: null };
          },
        };
      },
    },
  } as unknown as AssetJobExecutionClient;

  return {
    client,
    creativePackages,
    jobs,
    attempts,
    events,
    rpcNames,
    get insertCalls() {
      return insertCalls;
    },
    get rpcCalls() {
      return rpcCalls;
    },
    get creativePackageSelectCalls() {
      return creativePackageSelectCalls;
    },
  };
}

function validGeneratedAssetFileCandidate(overrides: Partial<GeneratedAssetFileCandidate> = {}): GeneratedAssetFileCandidate {
  return {
    position: 0,
    mimeType: "image/png",
    width: ASSET_GENERATION_IMAGE_DIMENSIONS.width,
    height: ASSET_GENERATION_IMAGE_DIMENSIONS.height,
    durationMs: null,
    fileSizeBytes: validBytes.length,
    bytes: validBytes,
    ...overrides,
  };
}

test("isAssetJobStatus accepts only the approved statuses", () => {
  for (const status of ["queued", "running", "completed", "failed"]) {
    assert.equal(isAssetJobStatus(status), true);
  }
  for (const status of ["cancelled", "retrying", "converted", "ready"]) {
    assert.equal(isAssetJobStatus(status), false);
  }
});

test("isAssetJobWorkerType accepts only mock in this milestone", () => {
  assert.equal(isAssetJobWorkerType("mock"), true);
  for (const workerType of ["openai_image_worker", "gemini_image_worker", "openai", "gemini", "veo", "runway", ""]) {
    assert.equal(isAssetJobWorkerType(workerType), false);
  }
});

// Production MVP Wave A adds "short_video" to the asset-kind vocabulary. This is a structural
// addition only: ProductionSpecV1 and the candidate validator both need to be able to REPRESENT a
// video before any wave can produce one. No executor emits a short_video, and the generated-assets
// bucket still rejects video/mp4 until the authored migration is applied -- see the route
// executability test below, which is what actually holds that line.
test("isAssetKind accepts image and short_video in this milestone", () => {
  assert.equal(isAssetKind("image"), true);
  assert.equal(isAssetKind("short_video"), true);
  for (const kind of ["carousel", "reel", "story_graphic", ""]) {
    assert.equal(isAssetKind(kind), false);
  }
});

// --- Wave A activation boundary: the asset-kind half ----------------------------------------------
//
// ASSET_KINDS says what the domain can REPRESENT; EXECUTABLE_ASSET_KINDS says what the runtime can
// actually produce, and only the latter reaches the job-creation API. Reviewer finding P2-1: before
// this boundary existed, { workerType: "external", assetKind: "short_video" } type-checked, which
// would have queued a row no executor could honour and no bucket could store.
type AssetJobCreationOptions = NonNullable<Parameters<typeof createAssetJobForReadyCreativePackage>[2]>;

test("EXECUTABLE_ASSET_KINDS is the strictly narrower, image-only subset of ASSET_KINDS", () => {
  assert.deepEqual([...EXECUTABLE_ASSET_KINDS], ["image"]);
  for (const kind of EXECUTABLE_ASSET_KINDS) {
    assert.equal((ASSET_KINDS as readonly string[]).includes(kind), true, `${kind} must be a real AssetKind`);
  }
  // short_video stays REPRESENTABLE and stays NON-EXECUTABLE. Both halves matter: dropping it from
  // ASSET_KINDS would break ProductionSpecV1 and the candidate validator, and adding it here would
  // re-open exactly the hole this boundary closes.
  assert.equal((ASSET_KINDS as readonly string[]).includes("short_video"), true);
  assert.equal((EXECUTABLE_ASSET_KINDS as readonly string[]).includes("short_video"), false);
});

test("[type] the job-creation API accepts the image routes executable today", () => {
  const executable: AssetJobCreationOptions = { workerType: "external", assetKind: "image" };
  const staticRenderer: AssetJobCreationOptions = { workerType: "static_renderer", assetKind: "image" };
  const generativeImage: AssetJobCreationOptions = { workerType: "generative_image", assetKind: "image" };
  assert.deepEqual(executable, { workerType: "external", assetKind: "image" });
  assert.deepEqual(staticRenderer, { workerType: "static_renderer", assetKind: "image" });
  assert.deepEqual(generativeImage, { workerType: "generative_image", assetKind: "image" });
});

// COMPILE-TIME regression. Each @ts-expect-error below is load-bearing in both directions: it fails
// tsc today if the error stops being raised (someone widened the creation API), and it fails tsc
// tomorrow if the directive is deleted while the error remains. tsconfig includes tests/**, so
// `npx tsc --noEmit` is what actually enforces this.
test("[type] the job-creation API rejects non-executable workers and kinds", () => {
  // @ts-expect-error -- no executor emits a short_video in Wave B and the bucket rejects video/mp4
  const videoKind: AssetJobCreationOptions = { workerType: "external", assetKind: "short_video" };
  // @ts-expect-error -- image_provider was renamed before activation
  const imageProvider: AssetJobCreationOptions = { workerType: "image_provider", assetKind: "image" };
  // @ts-expect-error -- Wave C2A REGISTERS remotion as a claimable worker type, and this directive
  // still holds for a different and stronger reason than before: the creation API's worker union is
  // now derived from EXECUTABLE_ASSET_JOB_WORKER_TYPES (the app-creatable set), not from
  // AssetJobWorkerType (everything the worker runtime can claim). The worker knows how to run
  // remotion; the application still cannot ask it to.
  const remotion: AssetJobCreationOptions = { workerType: "remotion", assetKind: "image" };

  // Referenced so the bindings are used; the assertions that matter are the three directives above.
  assert.ok(videoKind && imageProvider && remotion);
});

test("fromAssetJobRow maps nullable timestamps to empty strings", () => {
  const record = fromAssetJobRow(assetJobRow());
  assert.equal(record.status, "queued");
  assert.equal(record.workerType, "mock");
  assert.equal(record.assetKind, "image");
  assert.equal(record.lastError, "");
  assert.equal(record.startedAt, "");
  assert.equal(record.completedAt, "");
  assert.equal(record.failedAt, "");
});

test("createAssetJobForReadyCreativePackage inserts one queued routed image job for a ready Creative Package", async () => {
  const store = makeClient();
  const result = await createAssetJobForReadyCreativePackage(store.client, "package-1");
  assert.equal(result.ok, true);
  assert.equal(store.insertCalls, 1);
  assert.equal(store.jobs.length, 1);
  assert.equal(store.creativePackages[0].status, "ready");
  if (result.ok) {
    assert.equal(result.outcome, "created");
    assert.equal(result.job.status, "queued");
    assert.equal(result.job.workerType, "external");
    assert.equal(result.job.assetKind, "image");
    assert.equal(result.job.attemptCount, 0);
    assert.deepEqual(result.job.result, {});
    assert.equal(result.job.lastError, "");
  }
});

test("createAssetJobForReadyCreativePackage allows a second Asset Job for the same Creative Package -- creative_package_id is deliberately not unique", async () => {
  const store = makeClient();
  const first = await createAssetJobForReadyCreativePackage(store.client, "package-1");
  const second = await createAssetJobForReadyCreativePackage(store.client, "package-1");

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(store.insertCalls, 2);
  assert.equal(store.jobs.length, 2);
  if (first.ok && second.ok) {
    assert.notEqual(first.job.id, second.job.id);
  }
});

test("buildAssetGenerationSpecForJob resolves the same spec as buildAssetGenerationSpec, pre-claim, from only creativePackageId and assetKind", async () => {
  const store = makeClient({ jobs: [assetJobRow()] });
  const result = await buildAssetGenerationSpecForJob(store.client, { creativePackageId: "package-1", assetKind: "image" });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.spec, buildAssetGenerationSpec(fromCreativePackageRow(creativePackageRow()), { assetKind: "image", brandBible: BRAND_BIBLE }));
  }
  // Pre-claim: nothing about resolving the spec touches asset_jobs or claims anything.
  assert.equal(store.jobs[0].status, "queued");
});

test("buildAssetGenerationSpecForJob reports unsupported-asset-kind, not-ready, and not-found distinctly", async () => {
  const badKind = await buildAssetGenerationSpecForJob(makeClient().client, { creativePackageId: "package-1", assetKind: "video" });
  assert.equal(badKind.ok, false);
  if (!badKind.ok) assert.equal(badKind.reason, "unsupported-asset-kind");

  const missing = await buildAssetGenerationSpecForJob(makeClient({ creativePackages: [] }).client, { creativePackageId: "package-1", assetKind: "image" });
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.reason, "not-found");
});

// No "refuses non-ready Creative Packages" test here: CreativePackageStatus (creative-packages.ts)
// is currently the single-value union ["ready"], and its own row parser normalizes any other
// string back to "ready" -- so the not-ready branch in createAssetJobForReadyCreativePackage
// cannot be reached by any caller today. The check is kept anyway (mirroring
// createCreativeJobForAcceptedOpportunity's identical gate-on-parent-status pattern) so that if
// creative_packages ever gains a second status value, Asset Job creation is already guarded
// against it without a follow-up change here.

test("findQueuedExternalAssetJob returns null for an empty list", () => {
  assert.equal(findQueuedExternalAssetJob([]), null);
});

test("findQueuedExternalAssetJob ignores mock jobs regardless of status", () => {
  const jobs = [fromAssetJobRow(assetJobRow({ id: "job-1", status: "queued", worker_type: "mock" }))];
  assert.equal(findQueuedExternalAssetJob(jobs), null);
});

test("findQueuedExternalAssetJob ignores external jobs that are not queued", () => {
  const jobs = [
    fromAssetJobRow(assetJobRow({ id: "job-1", status: "completed", worker_type: "external" })),
    fromAssetJobRow(assetJobRow({ id: "job-2", status: "failed", worker_type: "external" })),
    fromAssetJobRow(assetJobRow({ id: "job-3", status: "running", worker_type: "external" })),
  ];
  assert.equal(findQueuedExternalAssetJob(jobs), null);
});

test("findQueuedExternalAssetJob returns the one queued external job among other jobs", () => {
  const target = fromAssetJobRow(assetJobRow({ id: "job-2", status: "queued", worker_type: "external" }));
  const jobs = [
    fromAssetJobRow(assetJobRow({ id: "job-1", status: "completed", worker_type: "external" })),
    target,
    fromAssetJobRow(assetJobRow({ id: "job-3", status: "queued", worker_type: "mock" })),
  ];
  assert.equal(findQueuedExternalAssetJob(jobs), target);
});

test("findQueuedExternalAssetJob returns the first match, trusting caller ordering rather than re-sorting", () => {
  const newest = fromAssetJobRow(assetJobRow({ id: "job-newest", status: "queued", worker_type: "external", created_at: "2026-08-02T00:00:00.000Z" }));
  const oldest = fromAssetJobRow(assetJobRow({ id: "job-oldest", status: "queued", worker_type: "external", created_at: "2026-08-01T00:00:00.000Z" }));
  // Pre-sorted newest-first, exactly like listAssetJobsForCreativePackage's own ordering contract.
  assert.equal(findQueuedExternalAssetJob([newest, oldest]), newest);
});

test("claimQueuedAssetJobWithAttempt claims a queued job and creates exactly one running attempt with attempt_number matching post-increment attempt_count", async () => {
  const store = makeClient({ jobs: [assetJobRow()] });
  const result = await claimQueuedAssetJobWithAttempt(store.client, "asset-job-1");

  assert.equal(result.ok, true);
  assert.equal(store.attempts.length, 1);
  if (result.ok) {
    assert.equal(result.attemptId, store.attempts[0].id);
    assert.equal(result.attemptNumber, 1);
  }
  assert.equal(store.attempts[0].attempt_number, 1);
  assert.equal(store.attempts[0].asset_job_id, "asset-job-1");
  assert.equal(store.attempts[0].worker_type, "mock");
  assert.equal(store.attempts[0].status, "running");
  assert.equal(store.attempts[0].started_at, startedAt);
});

test("claimQueuedAssetJobWithAttempt does not claim a job already taken by another runner and creates no attempt row", async () => {
  const store = makeClient({
    jobs: [assetJobRow()],
    beforeRpc(jobs) {
      jobs[0] = { ...jobs[0], status: "running", attempt_count: 1, started_at: startedAt };
    },
  });
  const result = await claimQueuedAssetJobWithAttempt(store.client, "asset-job-1");

  assert.equal(result.ok, false);
  assert.equal(result.reason, "not-queued");
  assert.equal(store.attempts.length, 0);
});

test("buildMockAssetJobResult is deterministic for the same Creative Package and clearly labels its files as mock", () => {
  const creativePackage = fromCreativePackageRow(creativePackageRow());

  assert.deepEqual(buildMockAssetJobResult(creativePackage, "image"), buildMockAssetJobResult(creativePackage, "image"));
  const result = buildMockAssetJobResult(creativePackage, "image");
  assert.equal(result.schemaVersion, "v1");
  assert.equal(result.worker, "mock");
  assert.equal(result.assetKind, "image");
  assert.equal(result.output.files.length, 1);
  assert.equal(result.output.files[0].position, 0);
  assert.equal(result.output.files[0].width, 1080);
  assert.equal(result.output.files[0].height, 1080);
  assert.equal(result.output.files[0].storageBucket, "mock");
  assert.match(result.output.files[0].storagePath, /^mock\//);
});

test("isAssetJobResultEnvelope validates the supported v1 result shape", () => {
  const envelope = buildMockAssetJobResult(fromCreativePackageRow(creativePackageRow()), "image");

  assert.equal(isAssetJobResultEnvelope(envelope), true);
  assert.equal(isAssetJobResultEnvelope({ ...envelope, schemaVersion: "v2" }), false);
  assert.equal(isAssetJobResultEnvelope({ ...envelope, worker: "openai_image_worker" }), false);
  assert.equal(isAssetJobResultEnvelope({ ...envelope, assetKind: "carousel" }), false);
  assert.equal(isAssetJobResultEnvelope({ ...envelope, output: { files: [] } }), false);
  assert.equal(isAssetJobResultEnvelope({ ...envelope, output: { files: [{ ...envelope.output.files[0], position: 1 }] } }), false);
  assert.equal(isAssetJobResultEnvelope({ ...envelope, metadata: { generatedFromCreativePackage: "", generatorVersion: "1" } }), false);
});

test("validateAssetJobResultEnvelope reports specific rejection reasons", () => {
  const envelope = buildMockAssetJobResult(fromCreativePackageRow(creativePackageRow()), "image");

  assert.equal(validateAssetJobResultEnvelope(envelope).ok, true);
  assert.deepEqual(validateAssetJobResultEnvelope({ ...envelope, schemaVersion: "v2" }), {
    ok: false,
    reason: "unsupported-schema-version",
    message: "Asset Job result schemaVersion must be v1.",
  });
  for (const [candidate, reason] of [
    [{ ...envelope, worker: "gemini_image_worker" }, "unsupported-worker"],
    [{ ...envelope, assetKind: "reel" }, "unsupported-asset-kind"],
    [{ ...envelope, output: { files: [] } }, "malformed-output"],
    [{ ...envelope, output: { files: [{ ...envelope.output.files[0], fileSizeBytes: 0 }] } }, "malformed-output"],
    [{ ...envelope, metadata: { generatedFromCreativePackage: "", generatorVersion: "1" } }, "malformed-metadata"],
    // PROP-027 P4 contract: sourceKind is a closed vocabulary. An arbitrary string here -- notably
    // including a tempting-but-wrong value like "api_generated" -- must be rejected, not silently
    // accepted, so it can never become an informal stand-in for a real API provider identity.
    [{ ...envelope, metadata: { ...envelope.metadata, sourceKind: "api_generated" } }, "malformed-metadata"],
    [{ ...envelope, metadata: { ...envelope.metadata, sourceWorkspace: 12345 } }, "malformed-metadata"],
  ] as const) {
    const result = validateAssetJobResultEnvelope(candidate);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, reason);
    }
  }
});

test("validateAssetJobResultEnvelope accepts sourceWorkspace/sourceKind/briefSchemaVersion/briefSha256 when valid, and never treats provider/model as part of this contract (PROP-027 P4)", () => {
  const envelope = buildMockAssetJobResult(fromCreativePackageRow(creativePackageRow()), "image");
  const withProvenance = {
    ...envelope,
    metadata: {
      ...envelope.metadata,
      sourceWorkspace: "chatgpt",
      sourceKind: "ai_generated" as const,
      briefSchemaVersion: "v1",
      briefSha256: "a".repeat(64),
    },
  };

  const result = validateAssetJobResultEnvelope(withProvenance);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.result.metadata.sourceWorkspace, "chatgpt");
    assert.equal(result.result.metadata.sourceKind, "ai_generated");
    // Lock the contract: this envelope's metadata type has no provider/model fields at all --
    // TypeScript itself refuses to let this object carry them (see AssetJobResultEnvelope). This
    // assertion is the runtime half of that guarantee: even a metadata object populated with every
    // real provenance field this milestone defines never contains the two reserved-for-API keys.
    assert.equal("provider" in result.result.metadata, false);
    assert.equal("model" in result.result.metadata, false);
  }

  // Every value in ASSET_SOURCE_KINDS must independently be accepted -- not just the one used above.
  for (const sourceKind of ["ai_generated", "photograph", "human_designed"] as const) {
    assert.equal(validateAssetJobResultEnvelope({ ...envelope, metadata: { ...envelope.metadata, sourceKind } }).ok, true);
  }
});

test("validateAssetJobResultEnvelope rejects a two-file result where both files claim the same position", () => {
  const envelope = buildMockAssetJobResult(fromCreativePackageRow(creativePackageRow()), "image");
  const [firstFile] = envelope.output.files;
  const duplicatePositionEnvelope = {
    ...envelope,
    output: {
      // Both files declare position 0 -- a genuine duplicate, not just an out-of-order single
      // file. Sequential-position validation requires files[i].position === i, so at most one of
      // these two entries can ever satisfy its own array index; the other is structurally
      // unvalidatable, regardless of which index it lands on.
      files: [
        { ...firstFile, position: 0 },
        { ...firstFile, position: 0, storagePath: "mock/package-1/1.png" },
      ],
    },
  };

  const result = validateAssetJobResultEnvelope(duplicatePositionEnvelope);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "malformed-output");
  }
});

test("runMockAssetJob separates claim, execution, and completion", async () => {
  const store = makeClient({ jobs: [assetJobRow()] });
  const result = await runMockAssetJob(store.client, "asset-job-1");
  assert.equal(result.ok, true);
  assert.equal(store.rpcCalls, 3);
  assert.equal(store.creativePackages[0].status, "ready");
  assert.equal(store.jobs[0].status, "completed");
  assert.equal(store.jobs[0].attempt_count, 1);
  assert.equal(store.jobs[0].started_at, startedAt);
  assert.equal(store.jobs[0].completed_at, finishedAt);
  assert.equal(store.jobs[0].failed_at, null);
  assert.equal(store.jobs[0].last_error, null);
  if (result.ok) {
    assert.equal(result.job.status, "completed");
    assert.match(JSON.stringify(result.job.result), /"storageBucket":"generated-assets"/);
  }
});

test("runMockAssetJob marks the job failed if the ready Creative Package cannot be read", async () => {
  const store = makeClient({ creativePackages: [], jobs: [assetJobRow()] });
  const result = await runMockAssetJob(store.client, "asset-job-1");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "failed");
  assert.equal(store.jobs[0].status, "failed");
  assert.equal(store.jobs[0].failed_at, finishedAt);
  assert.equal(store.jobs[0].completed_at, null);
  assert.equal(store.jobs[0].last_error, "Asset Job could not load a ready Creative Package.");
});

test("completeRunningAssetJob rejects invalid results and persists bounded last_error", async () => {
  const running = assetJobRow({ status: "running", attempt_count: 1, started_at: startedAt });
  const store = makeClient({ jobs: [running] });
  const invalidResult = {
    schemaVersion: "v1",
    worker: "mock",
    assetKind: "image",
    output: { files: [] },
    metadata: { generatedFromCreativePackage: "package-1", generatorVersion: "1" },
  };
  const result = await completeRunningAssetJob(store.client, fromAssetJobRow(running), invalidResult);

  assert.equal(result.ok, false);
  assert.equal(result.reason, "failed");
  assert.equal(store.jobs[0].status, "failed");
  assert.equal(store.jobs[0].completed_at, null);
  assert.equal(store.jobs[0].failed_at, finishedAt);
  assert.equal(store.jobs[0].attempt_count, 1);
  assert.equal(store.jobs[0].started_at, startedAt);
  assert.equal(store.jobs[0].last_error, "Asset Job result output must include a non-empty, 0-based, sequentially-positioned files array.");
  assert.deepEqual(store.jobs[0].result, {});
});

test("completeRunningAssetJob validates output and clears old failure diagnostics on success", async () => {
  const running = assetJobRow({ status: "running", attempt_count: 1, started_at: startedAt, failed_at: fixedNow, last_error: "Previous failure" });
  const store = makeClient({ jobs: [running] });
  const result = await completeRunningAssetJob(store.client, fromAssetJobRow(running), buildMockAssetJobResult(fromCreativePackageRow(creativePackageRow()), "image"));

  assert.equal(result.ok, true);
  assert.equal(store.jobs[0].status, "completed");
  assert.equal(store.jobs[0].failed_at, null);
  assert.equal(store.jobs[0].last_error, null);
  assert.equal(store.jobs[0].completed_at, finishedAt);
});

test("sanitizeAssetJobErrorMessage bounds and redacts operator-facing errors", () => {
  const message = sanitizeAssetJobErrorMessage(
    `Failure
 token=abc123 password=hunter2 ${"x".repeat(700)}`,
    80,
  );

  assert.ok(message.length <= 83);
  assert.doesNotMatch(message, /abc123|hunter2|\n/);
  assert.match(message, /token=\[redacted\]/);
});

test("completeRunningAssetJob does not mutate terminal or non-running jobs", async () => {
  const completed = assetJobRow({ status: "completed", result: { terminal: true }, completed_at: fixedNow });
  const store = makeClient({ jobs: [completed] });
  const result = await completeRunningAssetJob(store.client, fromAssetJobRow(completed), buildMockAssetJobResult(fromCreativePackageRow(creativePackageRow()), "image"));
  assert.equal(result.ok, false);
  assert.equal(result.reason, "conflict");
  assert.deepEqual(store.jobs[0].result, { terminal: true });
});

test("runQueuedMockAssetJobs finds queued mock jobs and processes only that set", async () => {
  const store = makeClient({
    jobs: [
      assetJobRow({ id: "job-older", created_at: "2026-07-31T09:00:00.000Z" }),
      assetJobRow({ id: "job-newer", created_at: "2026-07-31T09:30:00.000Z" }),
      assetJobRow({ id: "job-complete", status: "completed", created_at: "2026-07-31T08:00:00.000Z" }),
    ],
  });
  const result = await runQueuedMockAssetJobs(store.client, 1);
  assert.equal(result.ok, true);
  assert.equal(store.jobs.find((job) => job.id === "job-older")?.status, "completed");
  assert.equal(store.jobs.find((job) => job.id === "job-newer")?.status, "queued");
  assert.equal(store.jobs.find((job) => job.id === "job-complete")?.status, "completed");
});

test("runAssetJobWithExecutors materializes files and completes the job before finishing its attempt", async () => {
  const store = makeClient({ jobs: [assetJobRow()] });
  const result = await runMockAssetJob(store.client, "asset-job-1");

  assert.equal(result.ok, true);
  assert.equal(store.events[0], "claim-job");
  assert.equal(store.events[1]?.startsWith("upload:asset-jobs/asset-job-1/attempt-1/"), true);
  assert.deepEqual(store.events.slice(2), ["complete-job-with-files", "finish-attempt-completed"]);
});

test("runAssetJobWithExecutors records a completed attempt with a positive latency_ms and no error_code", async () => {
  const store = makeClient({ jobs: [assetJobRow()] });
  const result = await runMockAssetJob(store.client, "asset-job-1");

  assert.equal(result.ok, true);
  assert.equal(store.attempts[0].status, "completed");
  assert.equal(store.attempts[0].error_code, null);
  assert.equal(store.attempts[0].error_message, null);
  assert.equal(store.attempts[0].completed_at, finishedAt);
  assert.equal(store.attempts[0].latency_ms, Date.parse(finishedAt) - Date.parse(startedAt));
  assert.ok((store.attempts[0].latency_ms ?? -1) > 0);
});

test("runAssetJobWithExecutors reports attempt finalization failure after successful combined materialization without rollback", async () => {
  const store = makeClient({
    jobs: [assetJobRow()],
    finishAttemptRpcError: { message: "attempt write failed" },
  });
  const result = await runMockAssetJob(store.client, "asset-job-1");

  assert.equal(result.ok, true);
  assert.equal(store.jobs[0].status, "completed");
  assert.equal(store.jobs[0].completed_at, finishedAt);
  assert.equal(store.jobs[0].failed_at, null);
  assert.equal(result.materialization?.ok, true);
  assert.equal(result.attempt?.ok, false);
  if (result.attempt && !result.attempt.ok) {
    assert.equal(result.attempt.message, "attempt write failed");
  }
  assert.deepEqual(store.events, [
    "claim-job",
    result.materialization?.ok ? `upload:${result.materialization.materialized.files[0].storagePath}` : "upload",
    "complete-job-with-files",
  ]);
  assert.equal(store.events.includes("fail-job"), false);
  assert.equal(store.events.some((event) => event.startsWith("remove:")), false);
});

test("runAssetJobWithExecutors fails the job and marks the attempt failed with a bounded error_code and error_message", async () => {
  const store = makeClient({ creativePackages: [], jobs: [assetJobRow()] });
  const result = await runMockAssetJob(store.client, "asset-job-1");

  assert.equal(result.ok, false);
  assert.equal(store.jobs[0].status, "failed");
  assert.equal(store.attempts[0].status, "failed");
  assert.equal(store.attempts[0].error_code, "failed");
  assert.equal(store.attempts[0].error_message, "Asset Job could not load a ready Creative Package.");
});

test("runAssetJobWithExecutors fails the job and marks the attempt timed_out when the executor exceeds timeoutMs, without a false cancellation claim, and ignores a late resolution", async () => {
  const store = makeClient({ jobs: [assetJobRow()] });
  let resolveExecutor: (value: GeneratedAssetFileCandidate[]) => void = () => {};
  const executors: AssetJobExecutorMap = {
    mock: () =>
      new Promise((resolve) => {
        resolveExecutor = resolve;
      }),
  };

  const result = await runAssetJobWithExecutors(store.client, "asset-job-1", executors, { timeoutMs: 10 });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "timeout");
  assert.match(result.message, /exceeded 10ms timeout/);
  assert.doesNotMatch(result.message, /cancel/i);
  assert.equal(store.jobs[0].status, "failed");
  assert.equal(store.jobs[0].completed_at, null);
  assert.equal(store.jobs[0].failed_at, finishedAt);
  assert.equal(store.attempts[0].status, "timed_out");
  assert.equal(store.attempts[0].error_code, "timeout");
  assert.equal(store.attempts[0].completed_at, finishedAt);

  resolveExecutor([validGeneratedAssetFileCandidate()]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(store.jobs[0].status, "failed");
  assert.equal(store.attempts[0].status, "timed_out");
  assert.deepEqual(store.events, ["claim-job", "fail-job", "finish-attempt-timed-out"]);
});

test("runAssetJobWithExecutors rejects unsupported assetKind before reading the Creative Package or invoking the executor", async () => {
  const store = makeClient({ jobs: [assetJobRow({ asset_kind: "carousel" })] });
  let executorCalls = 0;
  const result = await runAssetJobWithExecutors(store.client, "asset-job-1", {
    mock: () => {
      executorCalls += 1;
      return [validGeneratedAssetFileCandidate()];
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "failed");
  assert.equal(store.creativePackageSelectCalls, 0);
  assert.equal(executorCalls, 0);
  assert.equal(store.jobs[0].status, "failed");
  assert.equal(store.jobs[0].last_error, "Unsupported asset kind: carousel.");
  assert.deepEqual(store.events, ["claim-job", "fail-job", "finish-attempt-failed"]);
});

test("runAssetJobWithExecutors rejects malformed Creative Package content before invoking the executor", async () => {
  const store = makeClient({
    creativePackages: [creativePackageRow({ content: { output: { headline: "Missing metadata" } } })],
    jobs: [assetJobRow()],
  });
  let executorCalls = 0;
  const result = await runAssetJobWithExecutors(store.client, "asset-job-1", {
    mock: () => {
      executorCalls += 1;
      return [validGeneratedAssetFileCandidate()];
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "failed");
  assert.equal(store.creativePackageSelectCalls, 1);
  assert.equal(executorCalls, 0);
  assert.equal(store.jobs[0].status, "failed");
  // Message widened in S2 when the asset boundary began accepting v2 as well. The behaviour
  // this test guards -- reject malformed content BEFORE invoking the executor -- is unchanged.
  assert.equal(store.jobs[0].last_error, "AssetGenerationSpecV1 requires Creative Package content v1 or v2.");
  assert.deepEqual(store.events, ["claim-job", "fail-job", "finish-attempt-failed"]);
});

test("runAssetJobWithExecutors threads sourceWorkspace/sourceKind into the completed envelope for an external job, and never provider/model (PROP-027 P4)", async () => {
  const store = makeClient({ jobs: [assetJobRow({ worker_type: "external" })] });
  const result = await runAssetJobWithExecutors(
    store.client,
    "asset-job-1",
    { external: () => [validGeneratedAssetFileCandidate()] },
    { sourceWorkspace: "chatgpt", sourceKind: "ai_generated" },
  );

  assert.equal(result.ok, true);
  assert.equal(store.jobs[0].status, "completed");
  const envelope = store.jobs[0].result;
  assert.equal(isAssetJobResultEnvelope(envelope), true);
  if (isAssetJobResultEnvelope(envelope)) {
    assert.equal(envelope.worker, "external");
    assert.equal(envelope.metadata.sourceWorkspace, "chatgpt");
    assert.equal(envelope.metadata.sourceKind, "ai_generated");
    // Available at zero cost -- spec is already built before materialization is ever reached.
    assert.equal(envelope.metadata.briefSchemaVersion, "v1");
    // Matches an independently-computed hash of the same spec's rendered brief -- proves this is a
    // real fingerprint of the actual brief text, not merely "some string got set."
    const expectedSpec = buildAssetGenerationSpec(fromCreativePackageRow(creativePackageRow()), { assetKind: "image", brandBible: BRAND_BIBLE });
    assert.equal(envelope.metadata.briefSha256, await briefSha256(expectedSpec));
    // Lock the contract: no code path threading real creative-source provenance end to end ever
    // introduces provider/model -- those are reserved exclusively for a future real API executor.
    assert.equal("provider" in envelope.metadata, false);
    assert.equal("model" in envelope.metadata, false);
  }
});

test("runAssetJobWithExecutors surfaces the spec-dimension advisory warning on its success result (AC-4) -- a 1024x1024 image, actually decodable as 1024x1024, succeeds against the 1080x1080 spec with a warning naming the real dimensions", async () => {
  const store = makeClient({ jobs: [assetJobRow()] });
  const candidate = validGeneratedAssetFileCandidate({ width: 1024, height: 1024, fileSizeBytes: png1024.length, bytes: png1024 });
  const result = await runAssetJobWithExecutors(store.client, "asset-job-1", { mock: () => [candidate] });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /1024x1024/);
    assert.match(result.warnings[0], /1080x1080/);
  }
  assert.equal(store.jobs[0].status, "completed");
});

test("runAssetJobWithExecutors reports no warnings when the candidate matches the spec exactly", async () => {
  const store = makeClient({ jobs: [assetJobRow()] });
  const result = await runAssetJobWithExecutors(store.client, "asset-job-1", { mock: () => [validGeneratedAssetFileCandidate()] });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.warnings, []);
  }
});

test("runAssetJobWithExecutors leaves sourceWorkspace/sourceKind unset for a job whose caller declares neither, rather than inventing empty values", async () => {
  const store = makeClient({ jobs: [assetJobRow()] });
  const result = await runAssetJobWithExecutors(store.client, "asset-job-1", { mock: () => [validGeneratedAssetFileCandidate()] });

  assert.equal(result.ok, true);
  const envelope = store.jobs[0].result;
  assert.equal(isAssetJobResultEnvelope(envelope), true);
  if (isAssetJobResultEnvelope(envelope)) {
    assert.equal(envelope.metadata.sourceWorkspace, undefined);
    assert.equal(envelope.metadata.sourceKind, undefined);
    assert.equal(envelope.metadata.briefSchemaVersion, "v1");
  }
});

test("runAssetJobWithExecutors passes a generated spec to the executor and never exposes raw Creative Package content", async () => {
  const store = makeClient({ jobs: [assetJobRow()] });
  // Production MVP Wave A widened AssetJobExecutor's spec parameter to
  // AssetGenerationSpecV1 | ProductionSpecV1, so the capture reflects the real signature. What the
  // runner ACTUALLY passes is unchanged and is what this test still pins: an AssetGenerationSpecV1.
  const received: { spec: AssetGenerationSpecV1 | ProductionSpecV1 | null } = { spec: null };
  const result = await runAssetJobWithExecutors(store.client, "asset-job-1", {
    mock: (_job, spec) => {
      received.spec = spec;
      return [validGeneratedAssetFileCandidate()];
    },
  });

  assert.equal(result.ok, true);
  assert.ok(received.spec);
  const spec = received.spec;
  assert.deepEqual(spec, buildAssetGenerationSpec(fromCreativePackageRow(creativePackageRow()), { assetKind: "image", brandBible: BRAND_BIBLE }));
  // generationIntent exists only on AssetGenerationSpecV1, so this narrowing is itself the
  // assertion: Wave A must not have started handing executors the new spec.
  assert.ok("generationIntent" in spec, "the runner must still pass an AssetGenerationSpecV1 in Wave A -- no executor reads ProductionSpecV1 yet");
  assert.equal(spec.generationIntent.purpose, "marketing-social-feed");
  assert.equal(spec.generationIntent.outcome, "single-image");
  assert.equal(store.jobs[0].status, "completed");
});

test("runAssetJobWithExecutors rejects invalid candidates before completing the job", async () => {
  const store = makeClient({ jobs: [assetJobRow()] });
  const result = await runAssetJobWithExecutors(store.client, "asset-job-1", {
    // width/height differing from the spec is advisory (PROP-027 P5) and no longer rejects here --
    // this candidate's declared 512x512 now disagrees with its own (unchanged, real 1080x1080)
    // bytes instead, so it is caught by the byte-level anti-tamper check one step later.
    mock: () => [validGeneratedAssetFileCandidate({ width: 512, height: 512 })],
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "failed");
  assert.equal(result.message, "Generated asset declared dimensions 512x512 do not match decoded dimensions 1080x1080.");
  assert.equal(store.jobs[0].status, "failed");
  assert.equal(store.jobs[0].completed_at, null);
  assert.equal(store.jobs[0].failed_at, finishedAt);
  assert.deepEqual(store.jobs[0].result, {});
  assert.deepEqual(store.events, ["claim-job", "fail-job", "finish-attempt-failed"]);
});

test("finish_asset_job and finish_asset_job_attempt always produce terminal timestamps at or after started_at (mixed-clock regression)", async () => {
  for (const outcome of ["completed", "failed"] as const) {
    const store = makeClient({
      jobs: [assetJobRow({ id: `job-${outcome}`, creative_package_id: "package-1" })],
      creativePackages: [creativePackageRow()],
    });
    const claim = await claimQueuedAssetJobWithAttempt(store.client, `job-${outcome}`);
    assert.equal(claim.ok, true);
    if (!claim.ok) continue;

    const job = fromAssetJobRow(store.jobs[0]);
    const jobResult =
      outcome === "completed"
        ? await completeRunningAssetJob(store.client, job, buildMockAssetJobResult(fromCreativePackageRow(creativePackageRow()), "image"))
        : await failRunningAssetJob(store.client, job, "Forced failure for regression test.");
    await finishAssetJobAttempt(store.client, claim.attemptId, outcome, outcome === "failed" ? { errorCode: "failed", errorMessage: "Forced failure for regression test." } : {});

    const terminalJobTimestamp = outcome === "completed" ? store.jobs[0].completed_at : store.jobs[0].failed_at;
    assert.ok(terminalJobTimestamp, `expected a ${outcome} timestamp to be set`);
    assert.ok(Date.parse(terminalJobTimestamp!) >= Date.parse(store.jobs[0].started_at!), `job terminal timestamp must not precede started_at for outcome ${outcome}`);
    assert.ok(Date.parse(store.attempts[0].completed_at!) >= Date.parse(store.attempts[0].started_at), `attempt completed_at must not precede started_at for outcome ${outcome}`);
    assert.equal(jobResult.ok, outcome === "completed");
  }
});

test("finish_asset_job rejects a second finish on an already-terminal job (double-finish conflict), for both completed and failed outcomes", async () => {
  for (const outcome of ["completed", "failed"] as const) {
    const store = makeClient({
      jobs: [assetJobRow({ id: `job-${outcome}`, creative_package_id: "package-1" })],
      creativePackages: [creativePackageRow()],
    });
    const claim = await claimQueuedAssetJobWithAttempt(store.client, `job-${outcome}`);
    assert.equal(claim.ok, true);
    if (!claim.ok) continue;

    const job = fromAssetJobRow(store.jobs[0]);
    const first =
      outcome === "completed"
        ? await completeRunningAssetJob(store.client, job, buildMockAssetJobResult(fromCreativePackageRow(creativePackageRow()), "image"))
        : await failRunningAssetJob(store.client, job, "First failure.");
    assert.equal(first.ok, outcome === "completed");
    const stateAfterFirst = { ...store.jobs[0] };

    const second =
      outcome === "completed"
        ? await completeRunningAssetJob(store.client, job, buildMockAssetJobResult(fromCreativePackageRow(creativePackageRow()), "image"))
        : await failRunningAssetJob(store.client, job, "Second failure attempt.");
    assert.equal(second.ok, false);
    assert.equal(second.reason, "conflict");
    assert.deepEqual(store.jobs[0], stateAfterFirst, `a second finish call must not mutate an already-terminal job for outcome ${outcome}`);
  }
});

test("attempt outcome guard: finish_asset_job_attempt rejects an invalid outcome and a non-running attempt", async () => {
  const store = makeClient({ jobs: [assetJobRow()], creativePackages: [creativePackageRow()] });
  const claim = await claimQueuedAssetJobWithAttempt(store.client, "asset-job-1");
  assert.equal(claim.ok, true);
  if (!claim.ok) return;

  const invalidOutcome = await store.client
    .rpc("finish_asset_job_attempt", { p_attempt_id: claim.attemptId, p_outcome: "cancelled", p_error_code: null, p_error_message: null })
    .maybeSingle();
  assert.equal(invalidOutcome.data, null);
  assert.equal(store.attempts[0].status, "running");

  const finished = await finishAssetJobAttempt(store.client, claim.attemptId, "completed");
  assert.equal(finished.ok, true);

  const alreadyTerminal = await store.client
    .rpc("finish_asset_job_attempt", { p_attempt_id: claim.attemptId, p_outcome: "failed", p_error_code: "failed", p_error_message: "too late" })
    .maybeSingle();
  assert.equal(alreadyTerminal.data, null);
  assert.equal(store.attempts[0].status, "completed");
});

test("fake finish_asset_job RPC enforces the same status and outcome guards as the SQL function", async () => {
  const store = makeClient({ jobs: [assetJobRow({ status: "queued" })], creativePackages: [creativePackageRow()] });

  const notRunning = await store.client.rpc("finish_asset_job", { p_job_id: "asset-job-1", p_outcome: "completed", p_result: {}, p_last_error: null }).maybeSingle();
  assert.equal(notRunning.data, null);

  const claim = await claimQueuedAssetJobWithAttempt(store.client, "asset-job-1");
  assert.equal(claim.ok, true);

  const invalidOutcome = await store.client.rpc("finish_asset_job", { p_job_id: "asset-job-1", p_outcome: "cancelled", p_result: {}, p_last_error: null }).maybeSingle();
  assert.equal(invalidOutcome.data, null);
  assert.equal(store.jobs[0].status, "running");
});

test("asset job code does not call external providers, use the Supabase SDK directly, or create future-domain records", () => {
  const source = readFileSync(new URL("../src/lib/asset-jobs.ts", import.meta.url), "utf8");
  for (const forbidden of [
    /OpenAI/i,
    /Gemini/i,
    /Veo/i,
    /Runway/i,
    /\bfetch\s*\(/,
    /@supabase\/supabase-js/i,
    /from\("approvals"\)/i,
    /from\("publishing_jobs"\)/i,
    /from\("content_drafts"\)/i,
  ]) {
    assert.doesNotMatch(source, forbidden);
  }

  // Wave C2A NARROWS the Remotion rule rather than dropping it.
  //
  // "remotion" is now a REGISTERED worker type, so asset-jobs.ts must name it in
  // ASSET_JOB_WORKER_TYPES -- exactly as it already names static_renderer and generative_image. What
  // the original blanket ban was actually protecting is that this module contains no execution
  // TECHNOLOGY: it must not import a renderer, call one, or know what a frame or a codec is. That is
  // what is asserted below, and it is a stricter statement than a ban on the word.
  //
  // NOTED, NOT FIXED: every other worker type is named by MECHANISM (static_renderer,
  // generative_image, manual_illustration) while "remotion" is a vendor name. That identifier was
  // frozen by Wave A in the production route table and job rows must match it, so renaming it is a
  // contract change and not C2A's to make.
  for (const forbiddenUsage of [
    /from\s+["']@remotion\//,
    /from\s+["']remotion["']/,
    /renderMedia/,
    /selectComposition/,
    /durationInFrames/,
    /\bcodec\b/i,
    /ffprobe/i,
  ]) {
    assert.doesNotMatch(source, forbiddenUsage, `asset-jobs.ts must not contain rendering technology (${forbiddenUsage})`);
  }
});

// --- the activation invariant (review section 5) -----------------------------------------------------

// v2 content carrying what the Production Route reads (format + productionSource decide the route),
// plus exactly the fields validateCreativePackageContentV2 requires for each production source --
// framing ONLY for capture_new (there is no camera to frame otherwise), and a structured visualBrief
// for the zero-capture sources. buildProductionSpec re-validates, so a looser fixture would fail for
// a reason that has nothing to do with routing.
function v2PackageRow(format: string, productionSource: string): CreativePackageRow {
  const isCapture = productionSource === "capture_new";
  const formatFields: Record<string, unknown> = format === "reel"
    ? { shots: [{ direction: "Board centred", onScreenText: "Mine.", approxSeconds: 3 }], targetDurationSeconds: 3, audioDirection: "Warm acoustic bed" }
    : isCapture
      ? { framing: "overhead" }
      : {
          visualBrief: {
            concept: "Two dessert characters in a stand-off over the last brownie",
            style: "Soft hand-drawn illustration, warm bakery palette",
            scene: ["Board centred with one brownie left", "Two characters lean in from opposite edges"],
            executionNotes: ["Keep the product obviously illustrated", "Use minimal background detail"],
          },
        };

  return {
    id: "package-1",
    creative_job_id: "job-1",
    status: "ready",
    schema_version: "v2",
    content: {
      schemaVersion: "v2",
      format,
      subject: "Brownies",
      angle: "Fresh batch",
      hook: "Still warm.",
      headline: "Brownies, still warm",
      caption: "Out of the oven at 7am.",
      cta: "Order today",
      visualDirection: "Overhead on the wooden board, morning light",
      overlayText: null,
      productionSource,
      ...formatFields,
      platformVariants: [{ platform: "instagram", caption: "Still warm.", hashtags: ["#brownies"] }],
      metadata: {
        generatedFromOpportunity: null,
        generatorVersion: "2",
        sourceCreativeJobId: "job-1",
        sourceWorker: "mock",
        sourceJobResultSchemaVersion: "v2",
        formatChosenBy: "ai",
        formatRationale: "A single hero shot suits one product.",
        subjectSource: "stated",
        subjectGrounding: null,
      },
    },
    created_at: "2026-08-01T09:05:00.000Z",
    updated_at: "2026-08-01T09:05:00.000Z",
  } as CreativePackageRow;
}

test("toExecutableAssetJobRoute narrows ONLY routes both activation halves admit, and never fabricates one", () => {
  assert.deepEqual(toExecutableAssetJobRoute({ workerType: "external", assetKind: "image" }), { workerType: "external", assetKind: "image" });
  assert.deepEqual(toExecutableAssetJobRoute({ workerType: "static_renderer", assetKind: "image" }), { workerType: "static_renderer", assetKind: "image" });
  assert.deepEqual(toExecutableAssetJobRoute({ workerType: "generative_image", assetKind: "image" }), { workerType: "generative_image", assetKind: "image" });

  // Unregistered worker, unproducible kind, and both at once.
  assert.equal(toExecutableAssetJobRoute({ workerType: "remotion", assetKind: "image" }), null);
  assert.equal(toExecutableAssetJobRoute({ workerType: "external", assetKind: "short_video" }), null);
  assert.equal(toExecutableAssetJobRoute({ workerType: "remotion", assetKind: "short_video" }), null);
});

test("toExecutableAssetJobRoute and isProductionRouteExecutable never disagree across the whole route space", () => {
  const workerTypes = ["external", "mock", "static_renderer", "generative_image", "remotion"] as const;
  const assetKinds = ["image", "short_video"] as const;

  for (const workerType of workerTypes) {
    for (const assetKind of assetKinds) {
      const route = { workerType, assetKind } as ProductionRoute;
      assert.equal(
        toExecutableAssetJobRoute(route) !== null,
        isProductionRouteExecutable(route),
        `the boolean predicate and the narrowing constructor disagree about ${workerType} + ${assetKind}`,
      );
    }
  }
});

test("createAssetJobForReadyCreativePackage refuses a non-executable route when NO options are supplied", async () => {
  const store = makeClient({ creativePackages: [v2PackageRow("reel", "template_only")] });
  const result = await createAssetJobForReadyCreativePackage(store.client, "package-1");

  assert.equal(result.ok, false);
  assert.equal(store.jobs.length, 0);
});

// THE REGRESSION THIS SECTION EXISTS FOR. The old guard fired only when BOTH options were absent, so
// supplying either one alone skipped the check entirely and the other half was cast in from a
// non-executable route -- producing a queued row nothing could ever claim.
test("a PARTIAL option cannot bypass route executability -- workerType alone", async () => {
  const store = makeClient({ creativePackages: [v2PackageRow("reel", "template_only")] });
  const result = await createAssetJobForReadyCreativePackage(store.client, "package-1", { workerType: "external" });

  assert.equal(result.ok, false);
  if (!result.ok) {
    // The message must name the FINAL pair that was rejected, including the half that came from the
    // route -- otherwise it reads as though "external" were the problem.
    assert.match(result.message, /short_video/);
  }
  assert.equal(store.jobs.length, 0, "no unclaimable row may be inserted");
});

test("a PARTIAL option cannot bypass route executability -- assetKind alone", async () => {
  const store = makeClient({ creativePackages: [v2PackageRow("reel", "template_only")] });
  const result = await createAssetJobForReadyCreativePackage(store.client, "package-1", { assetKind: "image" });

  assert.equal(result.ok, false);
  assert.equal(store.jobs.length, 0);
});

test("a PARTIAL option cannot bypass route executability -- reel capture_new still cannot queue a short_video", async () => {
  const store = makeClient({ creativePackages: [v2PackageRow("reel", "capture_new")] });
  const result = await createAssetJobForReadyCreativePackage(store.client, "package-1", { workerType: "external" });

  assert.equal(result.ok, false);
  assert.equal(store.jobs.length, 0);
});

test("no combination of options can ever queue an unregistered worker or an unproducible asset kind", async () => {
  const optionSets = [{}, { workerType: "external" as const }, { assetKind: "image" as const }, { workerType: "static_renderer" as const }];
  for (const [format, productionSource] of [["reel", "template_only"], ["reel", "capture_new"]] as const) {
    for (const options of optionSets) {
      const store = makeClient({ creativePackages: [v2PackageRow(format, productionSource)] });
      await createAssetJobForReadyCreativePackage(store.client, "package-1", options);
      for (const job of store.jobs) {
        assert.notEqual(job.worker_type, "remotion");
        assert.notEqual(job.asset_kind, "short_video");
      }
    }
  }
});

test("an EXPLICIT external + image stays creatable for any package -- the owner-facing path is unchanged", async () => {
  const store = makeClient({ creativePackages: [v2PackageRow("reel", "capture_new")] });
  const result = await createAssetJobForReadyCreativePackage(store.client, "package-1", { workerType: "external", assetKind: "image" });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.job.workerType, "external");
    assert.equal(result.job.assetKind, "image");
  }
});

test("the executable photo routes still resolve and queue by default", async () => {
  const cases = [["generate_visual", "generative_image"], ["template_only", "static_renderer"], ["capture_new", "external"]] as const;
  for (const [productionSource, expectedWorker] of cases) {
    const store = makeClient({ creativePackages: [v2PackageRow("photo", productionSource)] });
    const result = await createAssetJobForReadyCreativePackage(store.client, "package-1");

    assert.equal(result.ok, true, `photo:${productionSource} should be queueable`);
    if (result.ok) {
      assert.equal(result.job.workerType, expectedWorker);
      assert.equal(result.job.assetKind, "image");
      assert.deepEqual(resolveProductionRoute(fromCreativePackageRow(v2PackageRow("photo", productionSource))), {
        workerType: expectedWorker,
        assetKind: "image",
      });
    }
  }
});

// --- machine-executor source kind (review section 3) -------------------------------------------------

test("a generative_image job materializes as ai_generated WITHOUT any caller declaring it", async () => {
  const store = makeClient({
    creativePackages: [v2PackageRow("photo", "generate_visual")],
    jobs: [assetJobRow({ worker_type: "generative_image" })],
  });

  const result = await runAssetJobWithExecutors(store.client, "asset-job-1", { generative_image: () => [validGeneratedAssetFileCandidate()] });

  assert.equal(result.ok, true);
  const envelope = store.jobs[0].result;
  assert.equal(isAssetJobResultEnvelope(envelope), true);
  if (isAssetJobResultEnvelope(envelope)) {
    assert.equal(envelope.metadata.sourceKind, "ai_generated");
    // The production contract, not the legacy one.
    assert.equal(envelope.metadata.briefSchemaVersion, "production-v1");
    // Still never provider/model on this envelope -- those belong on asset_job_attempts.
    assert.equal("provider" in envelope.metadata, false);
    assert.equal("model" in envelope.metadata, false);
  }
});

test("a deterministic static_renderer job is NEVER mislabelled as ai_generated", async () => {
  const store = makeClient({
    creativePackages: [v2PackageRow("photo", "template_only")],
    jobs: [assetJobRow({ worker_type: "static_renderer" })],
  });

  const result = await runAssetJobWithExecutors(store.client, "asset-job-1", { static_renderer: () => [validGeneratedAssetFileCandidate()] });

  assert.equal(result.ok, true);
  const envelope = store.jobs[0].result;
  if (isAssetJobResultEnvelope(envelope)) {
    assert.equal(envelope.metadata.sourceKind, "human_designed");
    assert.notEqual(envelope.metadata.sourceKind, "ai_generated");
  }
});

test("an operator cannot relabel a machine executor's observed origin, but external stays operator-declared", async () => {
  const machine = makeClient({
    creativePackages: [v2PackageRow("photo", "generate_visual")],
    jobs: [assetJobRow({ worker_type: "generative_image" })],
  });
  await runAssetJobWithExecutors(machine.client, "asset-job-1", { generative_image: () => [validGeneratedAssetFileCandidate()] }, { sourceKind: "photograph" });
  const machineEnvelope = machine.jobs[0].result;
  if (isAssetJobResultEnvelope(machineEnvelope)) {
    assert.equal(machineEnvelope.metadata.sourceKind, "ai_generated", "a model's output must not be relabellable as a photograph");
  }

  const external = makeClient({ jobs: [assetJobRow({ worker_type: "external" })] });
  await runAssetJobWithExecutors(external.client, "asset-job-1", { external: () => [validGeneratedAssetFileCandidate()] }, { sourceKind: "photograph" });
  const externalEnvelope = external.jobs[0].result;
  if (isAssetJobResultEnvelope(externalEnvelope)) {
    assert.equal(externalEnvelope.metadata.sourceKind, "photograph", "only the operator knows how an external asset was really made");
  }
});

// --- durable provider/model provenance ---------------------------------------------------------------
//
// The persisted pair lives on asset_job_attempts, never on the result envelope. These tests assert
// what actually reaches the attempt row, and which RPC carried it there.

// A generative executor stand-in: reports the provenance a real provider call would, then succeeds.
function generativeExecutorReporting(provider: string, model: string): AssetJobExecutorMap {
  return {
    generative_image: (_job, _spec, context) => {
      context.recordProvenance?.({ provider, model });
      return [validGeneratedAssetFileCandidate()];
    },
  };
}

test("A: a successful generative_image attempt persists provider and model on the attempt row", async () => {
  const store = makeClient({
    creativePackages: [v2PackageRow("photo", "generate_visual")],
    jobs: [assetJobRow({ worker_type: "generative_image" })],
  });

  const result = await runAssetJobWithExecutors(store.client, "asset-job-1", generativeExecutorReporting("cloudflare-workers-ai", "@cf/black-forest-labs/flux-2-klein-9b"));

  assert.equal(result.ok, true);
  assert.equal(store.attempts.length, 1);
  assert.equal(store.attempts[0].status, "completed");
  assert.equal(store.attempts[0].provider, "cloudflare-workers-ai");
  assert.equal(store.attempts[0].model, "@cf/black-forest-labs/flux-2-klein-9b");
  // It must have gone through the provenance-aware RPC, not the base one.
  assert.ok(store.rpcNames.includes("finish_asset_job_attempt_with_provenance"));
});

test("B: a model override persists the model ACTUALLY used, not the default", async () => {
  const store = makeClient({
    creativePackages: [v2PackageRow("photo", "generate_visual")],
    jobs: [assetJobRow({ worker_type: "generative_image" })],
  });

  await runAssetJobWithExecutors(store.client, "asset-job-1", generativeExecutorReporting("cloudflare-workers-ai", "@cf/some/other-model"));

  assert.equal(store.attempts[0].model, "@cf/some/other-model");
  assert.notEqual(store.attempts[0].model, "@cf/black-forest-labs/flux-2-klein-9b");
});

test("C: a static_renderer attempt claims no provider and no model", async () => {
  const store = makeClient({
    creativePackages: [v2PackageRow("photo", "template_only")],
    jobs: [assetJobRow({ worker_type: "static_renderer" })],
  });

  const result = await runAssetJobWithExecutors(store.client, "asset-job-1", { static_renderer: () => [validGeneratedAssetFileCandidate()] });

  assert.equal(result.ok, true);
  assert.equal(store.attempts[0].status, "completed");
  assert.equal(store.attempts[0].provider, null, "a deterministic local render contacted no provider");
  assert.equal(store.attempts[0].model, null);
  // And it must not have needed the provenance RPC at all -- a deployment without that migration
  // still finishes deterministic renders normally.
  assert.deepEqual(store.rpcNames, ["finish_asset_job_attempt"]);
});

test("D: an external attempt with no provenance still finishes through the original, unchanged RPC", async () => {
  const store = makeClient({ jobs: [assetJobRow({ worker_type: "external" })] });

  const result = await runAssetJobWithExecutors(
    store.client,
    "asset-job-1",
    { external: () => [validGeneratedAssetFileCandidate()] },
    { sourceWorkspace: "chatgpt", sourceKind: "ai_generated" },
  );

  assert.equal(result.ok, true);
  assert.equal(store.attempts[0].status, "completed");
  assert.equal(store.attempts[0].provider, null);
  assert.equal(store.attempts[0].model, null);
  assert.deepEqual(store.rpcNames, ["finish_asset_job_attempt"]);
  // An operator-declared sourceKind is creative origin, never provider identity -- the two must not
  // bleed into each other.
  const envelope = store.jobs[0].result;
  if (isAssetJobResultEnvelope(envelope)) {
    assert.equal(envelope.metadata.sourceKind, "ai_generated");
    assert.equal("provider" in envelope.metadata, false);
  }
});

test("E: a FAILED provider attempt still records the provider and model that were actually contacted", async () => {
  const store = makeClient({
    creativePackages: [v2PackageRow("photo", "generate_visual")],
    jobs: [assetJobRow({ worker_type: "generative_image" })],
  });

  const result = await runAssetJobWithExecutors(store.client, "asset-job-1", {
    generative_image: (_job, _spec, context) => {
      // Provider and model settled, request attempted -- then the provider failed.
      context.recordProvenance?.({ provider: "cloudflare-workers-ai", model: "@cf/some/other-model" });
      throw new Error("Cloudflare Workers AI request failed with 500");
    },
  });

  assert.equal(result.ok, false);
  assert.equal(store.jobs[0].status, "failed");
  assert.equal(store.attempts[0].status, "failed");
  assert.equal(store.attempts[0].provider, "cloudflare-workers-ai", "which model we called matters most when the call failed");
  assert.equal(store.attempts[0].model, "@cf/some/other-model");
  assert.ok(store.rpcNames.includes("finish_asset_job_attempt_with_provenance"));
});

test("E: a TIMED-OUT provider attempt records the same provenance, and still reports as a timeout", async () => {
  const store = makeClient({
    creativePackages: [v2PackageRow("photo", "generate_visual")],
    jobs: [assetJobRow({ worker_type: "generative_image" })],
  });

  const result = await runAssetJobWithExecutors(
    store.client,
    "asset-job-1",
    {
      generative_image: async (_job, _spec, context) => {
        context.recordProvenance?.({ provider: "cloudflare-workers-ai", model: "@cf/black-forest-labs/flux-2-klein-9b" });
        await new Promise((resolve) => setTimeout(resolve, 50));
        return [validGeneratedAssetFileCandidate()];
      },
    },
    { timeoutMs: 5 },
  );

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "timeout");
  }
  assert.equal(store.attempts[0].status, "timed_out");
  assert.equal(store.attempts[0].error_code, "timeout");
  assert.equal(store.attempts[0].provider, "cloudflare-workers-ai");
  assert.equal(store.attempts[0].model, "@cf/black-forest-labs/flux-2-klein-9b");
});

test("F: a failure BEFORE provider selection never fabricates a provider", async () => {
  const store = makeClient({
    creativePackages: [v2PackageRow("photo", "generate_visual")],
    jobs: [assetJobRow({ worker_type: "generative_image" })],
  });

  const result = await runAssetJobWithExecutors(store.client, "asset-job-1", {
    // Reference validation / spec rejection: this throws before any provider or model is chosen and
    // before any request is made, so it must never call recordProvenance.
    generative_image: () => {
      throw new Error("Generative image reference anchor.png is not a supported image.");
    },
  });

  assert.equal(result.ok, false);
  assert.equal(store.attempts[0].status, "failed");
  assert.equal(store.attempts[0].provider, null, "no provider was contacted, so none may be claimed");
  assert.equal(store.attempts[0].model, null);
  assert.deepEqual(store.rpcNames, ["finish_asset_job_attempt"]);
});

test("F: a job whose executor is missing entirely records no provenance", async () => {
  const store = makeClient({
    creativePackages: [v2PackageRow("photo", "generate_visual")],
    jobs: [assetJobRow({ worker_type: "generative_image" })],
  });

  const result = await runAssetJobWithExecutors(store.client, "asset-job-1", {});

  assert.equal(result.ok, false);
  assert.equal(store.attempts[0].provider, null);
  assert.equal(store.attempts[0].model, null);
});

test("G: only the two short identifiers are persisted -- no prompt, reference bytes, or credentials", async () => {
  const store = makeClient({
    creativePackages: [v2PackageRow("photo", "generate_visual")],
    jobs: [assetJobRow({ worker_type: "generative_image" })],
  });

  await runAssetJobWithExecutors(store.client, "asset-job-1", generativeExecutorReporting("cloudflare-workers-ai", "@cf/black-forest-labs/flux-2-klein-9b"));

  const persisted = JSON.stringify(store.attempts[0]);
  for (const forbidden of [/Bearer/i, /api[_-]?token/i, /Do not generate readable text/i, /promptSha256/i, /referenceImagePaths/i, /input_image_/i]) {
    assert.doesNotMatch(persisted, forbidden);
  }
  // The attempt row gains exactly the two provenance fields and nothing structurally new.
  assert.deepEqual(
    Object.keys(store.attempts[0]).sort(),
    ["asset_job_id", "attempt_number", "completed_at", "created_at", "error_code", "error_message", "id", "latency_ms", "model", "provider", "started_at", "status", "worker_type"],
  );
});

test("H: outcome, error and timestamp semantics are unchanged by the provenance path", async () => {
  const withProvenance = makeClient({
    creativePackages: [v2PackageRow("photo", "generate_visual")],
    jobs: [assetJobRow({ worker_type: "generative_image" })],
  });
  await runAssetJobWithExecutors(withProvenance.client, "asset-job-1", {
    generative_image: (_job, _spec, context) => {
      context.recordProvenance?.({ provider: "cloudflare-workers-ai", model: "@cf/m" });
      throw new Error("provider exploded");
    },
  });

  const withoutProvenance = makeClient({ jobs: [assetJobRow({ worker_type: "external" })] });
  await runAssetJobWithExecutors(withoutProvenance.client, "asset-job-1", {
    external: () => {
      throw new Error("provider exploded");
    },
  });

  const a = withProvenance.attempts[0];
  const b = withoutProvenance.attempts[0];

  // Everything except the two provenance columns must be identical between the two RPCs.
  assert.equal(a.status, b.status);
  assert.equal(a.error_code, b.error_code);
  assert.equal(a.error_message, b.error_message);
  assert.equal(a.completed_at, b.completed_at);
  assert.equal(a.latency_ms, b.latency_ms);
  assert.equal(a.status, "failed");
  assert.match(a.error_message ?? "", /provider exploded/);

  // And the terminal timestamp is still database-sourced and at or after started_at.
  assert.ok(Date.parse(a.completed_at ?? "") >= Date.parse(a.started_at));
});

// --- P3-1: provenance survives a materialization failure ---------------------------------------------

test("a provider that WAS contacted stays recorded even when materialization then fails", async () => {
  const store = makeClient({
    creativePackages: [v2PackageRow("photo", "generate_visual")],
    jobs: [assetJobRow({ worker_type: "generative_image" })],
    // The executor succeeds and returns real bytes; storage is what breaks.
    uploadError: { statusCode: "500", message: "storage is unavailable" },
  });

  const result = await runAssetJobWithExecutors(store.client, "asset-job-1", {
    generative_image: (_job, _spec, context) => {
      context.recordProvenance?.({ provider: "cloudflare-workers-ai", model: "@cf/some/other-model" });
      return [validGeneratedAssetFileCandidate()];
    },
  });

  // The job failed -- but it failed AFTER a real, successful provider call.
  assert.equal(result.ok, false);
  assert.equal(result.materialization?.ok, false);
  assert.equal(store.jobs[0].status, "failed");
  assert.equal(store.attempts[0].status, "failed");

  // That call really happened, so it is still recorded. Losing it here would mean the one attempt
  // that cost money and produced bytes is the one with no record of which model produced them.
  assert.equal(store.attempts[0].provider, "cloudflare-workers-ai");
  assert.equal(store.attempts[0].model, "@cf/some/other-model");
  assert.ok(store.rpcNames.includes("finish_asset_job_attempt_with_provenance"));
});

test("a materialization failure with NO provider contacted still records no provenance", async () => {
  const store = makeClient({
    creativePackages: [v2PackageRow("photo", "template_only")],
    jobs: [assetJobRow({ worker_type: "static_renderer" })],
    uploadError: { statusCode: "500", message: "storage is unavailable" },
  });

  const result = await runAssetJobWithExecutors(store.client, "asset-job-1", { static_renderer: () => [validGeneratedAssetFileCandidate()] });

  assert.equal(result.ok, false);
  assert.equal(store.attempts[0].status, "failed");
  assert.equal(store.attempts[0].provider, null);
  assert.equal(store.attempts[0].model, null);
  assert.deepEqual(store.rpcNames, ["finish_asset_job_attempt"]);
});

// --- P3-4: the fakes cannot mask incorrect RPC wiring ------------------------------------------------

test("the BASE attempt RPC rejects provenance arguments exactly as PostgreSQL would", async () => {
  const store = makeClient({ jobs: [assetJobRow()], creativePackages: [creativePackageRow()] });
  const claim = await claimQueuedAssetJobWithAttempt(store.client, "asset-job-1");
  assert.equal(claim.ok, true);
  if (!claim.ok) return;

  // PostgREST resolves by function name PLUS argument names. finish_asset_job_attempt has no
  // p_provider/p_model parameters, so this matches no candidate function and fails -- it is NOT
  // silently accepted-and-ignored. If the fake tolerated it, a miswiring that sent provenance to the
  // base RPC would pass every test here and then lose provenance in production.
  const rejected = await store.client
    .rpc("finish_asset_job_attempt", {
      p_attempt_id: claim.attemptId,
      p_outcome: "completed",
      p_error_code: null,
      p_error_message: null,
      p_provider: "cloudflare-workers-ai",
      p_model: "@cf/m",
    } as never)
    .maybeSingle();

  assert.equal(rejected.data, null);
  assert.equal(rejected.error?.code, "PGRST202");
  assert.equal(store.attempts[0].status, "running", "a rejected call must not finish the attempt");
  assert.equal(store.attempts[0].provider, null, "and must certainly not write provenance");
});

test("only the provenance RPC can write provider/model -- the base RPC leaves them untouched", async () => {
  const store = makeClient({ jobs: [assetJobRow()], creativePackages: [creativePackageRow()] });
  const claim = await claimQueuedAssetJobWithAttempt(store.client, "asset-job-1");
  assert.equal(claim.ok, true);
  if (!claim.ok) return;

  await store.client
    .rpc("finish_asset_job_attempt", { p_attempt_id: claim.attemptId, p_outcome: "completed", p_error_code: null, p_error_message: null })
    .maybeSingle();

  assert.equal(store.attempts[0].status, "completed");
  assert.equal(store.attempts[0].provider, null);
  assert.equal(store.attempts[0].model, null);
});
