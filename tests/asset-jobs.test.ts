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
import {
  buildMockAssetJobResult,
  claimQueuedAssetJobWithAttempt,
  completeRunningAssetJob,
  createAssetJobForReadyCreativePackage,
  failRunningAssetJob,
  fromAssetJobRow,
  isAssetJobResultEnvelope,
  isAssetJobStatus,
  isAssetJobWorkerType,
  isAssetKind,
  runAssetJobWithExecutors,
  runMockAssetJob,
  runQueuedMockAssetJobs,
  sanitizeAssetJobErrorMessage,
  validateAssetJobResultEnvelope,
  type AssetJobExecutionClient,
  type AssetJobExecutorMap,
  type AssetJobRow,
} from "../src/lib/asset-jobs.ts";
import { finishAssetJobAttempt, type AssetJobAttemptRow } from "../src/lib/asset-job-attempts.ts";
import { fromCreativePackageRow, type CreativePackageRow } from "../src/lib/creative-packages.ts";
import { BRAND_BIBLE } from "../src/lib/marketing-advisor-context.ts";

type ErrorLike = { code?: string; message: string };

const fixedNow = "2026-07-31T10:00:00.000Z";
const startedAt = "2026-07-31T10:01:00.000Z";
// The fake's finish_asset_job/finish_asset_job_attempt RPC handlers stamp this fixed "database
// now()" for every finish call, standing in for the SQL functions' own now() -- deliberately
// later than startedAt so latency/ordering assertions are meaningful. Nothing in production ever
// computes this value or passes it in.
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
  } = {},
) {
  const creativePackages = [...(options.creativePackages ?? [creativePackageRow()])];
  const jobs = [...(options.jobs ?? [])];
  const attempts: AssetJobAttemptRow[] = [];
  const events: string[] = [];
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

      assert.equal(functionName, "finish_asset_job_attempt");
      return {
        // Mirrors finish_asset_job_attempt's own guards: id + status='running' + p_outcome in
        // ('completed','failed','timed_out'). latency_ms uses the same fixed clock as
        // completed_at, exactly like `now() - started_at` inside the real function.
        async maybeSingle() {
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
          };
          events.push(outcome === "completed" ? "finish-attempt-completed" : outcome === "timed_out" ? "finish-attempt-timed-out" : "finish-attempt-failed");
          return { data: attempts[index], error: null };
        },
      };
    },
  } as unknown as AssetJobExecutionClient;

  return {
    client,
    creativePackages,
    jobs,
    attempts,
    events,
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
    fileSizeBytes: 1024,
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

test("isAssetKind accepts only image in this milestone", () => {
  assert.equal(isAssetKind("image"), true);
  for (const kind of ["carousel", "reel", "short_video", "story_graphic", ""]) {
    assert.equal(isAssetKind(kind), false);
  }
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

test("createAssetJobForReadyCreativePackage inserts one queued mock image job for a ready Creative Package", async () => {
  const store = makeClient();
  const result = await createAssetJobForReadyCreativePackage(store.client, "package-1");
  assert.equal(result.ok, true);
  assert.equal(store.insertCalls, 1);
  assert.equal(store.jobs.length, 1);
  assert.equal(store.creativePackages[0].status, "ready");
  if (result.ok) {
    assert.equal(result.outcome, "created");
    assert.equal(result.job.status, "queued");
    assert.equal(result.job.workerType, "mock");
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

// No "refuses non-ready Creative Packages" test here: CreativePackageStatus (creative-packages.ts)
// is currently the single-value union ["ready"], and its own row parser normalizes any other
// string back to "ready" -- so the not-ready branch in createAssetJobForReadyCreativePackage
// cannot be reached by any caller today. The check is kept anyway (mirroring
// createCreativeJobForAcceptedOpportunity's identical gate-on-parent-status pattern) so that if
// creative_packages ever gains a second status value, Asset Job creation is already guarded
// against it without a follow-up change here.

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
  ] as const) {
    const result = validateAssetJobResultEnvelope(candidate);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, reason);
    }
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
    assert.match(JSON.stringify(result.job.result), /"storageBucket":"mock"/);
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

test("runAssetJobWithExecutors finishes the job before finishing its attempt", async () => {
  const store = makeClient({ jobs: [assetJobRow()] });
  const result = await runMockAssetJob(store.client, "asset-job-1");

  assert.equal(result.ok, true);
  assert.deepEqual(store.events, ["claim-job", "complete-job", "finish-attempt-completed"]);
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
  assert.equal(store.jobs[0].last_error, "AssetGenerationSpecV1 requires Creative Package content v1.");
  assert.deepEqual(store.events, ["claim-job", "fail-job", "finish-attempt-failed"]);
});

test("runAssetJobWithExecutors passes a generated spec to the executor and never exposes raw Creative Package content", async () => {
  const store = makeClient({ jobs: [assetJobRow()] });
  const received: { spec: AssetGenerationSpecV1 | null } = { spec: null };
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
  assert.equal(spec.generationIntent.purpose, "marketing-social-feed");
  assert.equal(spec.generationIntent.outcome, "single-image");
  assert.equal(store.jobs[0].status, "completed");
});

test("runAssetJobWithExecutors rejects invalid candidates before completing the job", async () => {
  const store = makeClient({ jobs: [assetJobRow()] });
  const result = await runAssetJobWithExecutors(store.client, "asset-job-1", {
    mock: () => [validGeneratedAssetFileCandidate({ width: 512, height: 512 })],
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "failed");
  assert.equal(result.message, "Image asset generation candidate dimensions must be 1080x1080.");
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
    /Remotion/i,
    /\bfetch\s*\(/,
    /@supabase\/supabase-js/i,
    /from\("approvals"\)/i,
    /from\("publishing_jobs"\)/i,
    /from\("content_drafts"\)/i,
  ]) {
    assert.doesNotMatch(source, forbidden);
  }
});
