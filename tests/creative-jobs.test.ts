import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildMockCreativeJobResult,
  claimQueuedCreativeJob,
  claimQueuedCreativeJobWithAttempt,
  completeRunningCreativeJob,
  createCreativeJobForAcceptedOpportunity,
  fromCreativeJobRow,
  isCreativeJobResultEnvelope,
  isCreativeJobStatus,
  isCreativeJobWorkerType,
  runCreativeJobWithExecutors,
  runMockCreativeJob,
  runQueuedMockCreativeJobs,
  sanitizeCreativeJobErrorMessage,
  validateCreativeJobResultEnvelope,
  type CreativeJobExecutionClient,
  type CreativeJobExecutorMap,
  type CreativeJobResultEnvelope,
  type CreativeJobRow,
} from "../src/lib/creative-jobs.ts";
import { type CreativeJobAttemptRow } from "../src/lib/creative-job-attempts.ts";
import { fromOpportunityRow, toOpportunityRow, type OpportunityDraft, type OpportunityRecord, type OpportunityRow } from "../src/lib/opportunities.ts";

type ErrorLike = { code?: string; message: string };

const fixedNow = "2026-07-29T10:00:00.000Z";
const startedAt = "2026-07-29T10:01:00.000Z";

function opportunityDraft(overrides: Partial<OpportunityDraft> = {}): OpportunityDraft {
  return {
    opportunityType: "product_marketing_content",
    producer: "daily_advisor",
    sourceType: "daily_advisor",
    sourceId: "daily_advisor:2026-07-29:product_marketing_content:brownies",
    title: "Create launch-ready product content for Brownies",
    summary: "Brownies has enough proof for a marketing content Opportunity.",
    reason: "Rule Engine evidence supports creating marketing content.",
    recommendedAction: "create_content",
    evidenceVersion: "v1",
    evidence: { product: { id: "brownies", name: "Brownies" } },
    sourceRuleIds: ["RULE-001"],
    sourceFindings: [{ id: "RULE-001", category: "launch", severity: "info", passed: true, message: "Ready.", recommendation: "Create content." }],
    detectedAt: "2026-07-29T09:00:00.000Z",
    expiresAt: "2026-08-01T09:00:00.000Z",
    deduplicationKey: "v1|producer=daily_advisor|finding_type=product_marketing_content|entity:batch=batch-1|entity:costing=costing-1|entity:product=brownies|action=create_content|business_date=2026-07-29",
    status: "accepted",
    ...overrides,
  };
}

function opportunityRow(overrides: Partial<OpportunityRow> = {}): OpportunityRow {
  return {
    ...toOpportunityRow(opportunityDraft()),
    id: "opportunity-1",
    created_at: "2026-07-29T09:05:00.000Z",
    updated_at: "2026-07-29T09:05:00.000Z",
    ...overrides,
  };
}

function creativeJobRow(overrides: Partial<CreativeJobRow> = {}): CreativeJobRow {
  return {
    id: "job-1",
    opportunity_id: "opportunity-1",
    status: "queued",
    worker_type: "mock",
    attempt_count: 0,
    result: {},
    last_error: null,
    created_at: "2026-07-29T09:10:00.000Z",
    updated_at: "2026-07-29T09:10:00.000Z",
    started_at: null,
    completed_at: null,
    failed_at: null,
    ...overrides,
  };
}

function makeClient(
  options: {
    opportunities?: OpportunityRow[];
    jobs?: CreativeJobRow[];
    selectError?: ErrorLike;
    insertError?: ErrorLike;
    updateError?: ErrorLike;
    rpcError?: ErrorLike;
    uniqueRaceJob?: CreativeJobRow;
    beforeRpc?: (jobs: CreativeJobRow[]) => void;
    forceEmptyComplete?: boolean;
    attemptUpdateError?: ErrorLike;
  } = {},
) {
  const opportunities = [...(options.opportunities ?? [opportunityRow()])];
  const jobs = [...(options.jobs ?? [])];
  const attempts: CreativeJobAttemptRow[] = [];
  const events: string[] = [];
  let insertCalls = 0;
  let updateCalls = 0;
  let rpcCalls = 0;
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
      if (table === "opportunities") {
        return {
          select() {
            return queryBuilder(opportunities);
          },
        };
      }

      if (table === "creative_job_attempts") {
        return {
          update(updateRow: Partial<CreativeJobAttemptRow>) {
            const filters: Array<{ column: string; value: string }> = [];
            const builder = {
              eq(column: string, value: string) {
                filters.push({ column, value });
                return builder;
              },
              select() {
                return {
                  async maybeSingle() {
                    if (options.attemptUpdateError) {
                      return { data: null, error: options.attemptUpdateError };
                    }
                    const index = attempts.findIndex((row) => matches(row as Record<string, unknown>, filters));
                    if (index === -1) {
                      return { data: null, error: null };
                    }
                    attempts[index] = { ...attempts[index], ...updateRow };
                    events.push(
                      updateRow.status === "completed"
                        ? "finish-attempt-completed"
                        : updateRow.status === "timed_out"
                          ? "finish-attempt-timed-out"
                          : "finish-attempt-failed",
                    );
                    return { data: attempts[index], error: null };
                  },
                };
              },
            };
            return builder;
          },
        };
      }

      assert.equal(table, "creative_jobs");
      return {
        select() {
          return queryBuilder(jobs);
        },
        insert(row: Partial<CreativeJobRow>) {
          return {
            select() {
              return {
                async single() {
                  insertCalls += 1;
                  if (options.uniqueRaceJob && insertCalls === 1) {
                    jobs.push(options.uniqueRaceJob);
                    return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } };
                  }
                  if (options.insertError) {
                    return { data: null, error: options.insertError };
                  }
                  const inserted = {
                    opportunity_id: row.opportunity_id!,
                    status: row.status ?? "queued",
                    worker_type: row.worker_type ?? "mock",
                    attempt_count: row.attempt_count ?? 0,
                    result: row.result ?? {},
                    last_error: row.last_error ?? null,
                    id: `job-${jobs.length + 1}`,
                    created_at: fixedNow,
                    updated_at: fixedNow,
                    started_at: null,
                    completed_at: null,
                    failed_at: null,
                  } satisfies CreativeJobRow;
                  jobs.push(inserted);
                  return { data: inserted, error: null };
                },
              };
            },
          };
        },
        update(updateRow: Partial<CreativeJobRow>) {
          const filters: Array<{ column: string; value: string }> = [];
          const builder = {
            eq(column: string, value: string) {
              filters.push({ column, value });
              return builder;
            },
            select() {
              return {
                async maybeSingle() {
                  updateCalls += 1;
                  if (options.updateError) {
                    return { data: null, error: options.updateError };
                  }
                  if (options.forceEmptyComplete) {
                    return { data: null, error: null };
                  }
                  const index = jobs.findIndex((row) => matches(row as Record<string, unknown>, filters));
                  if (index === -1) {
                    return { data: null, error: null };
                  }
                  jobs[index] = { ...jobs[index], ...updateRow };
                  if (updateRow.status === "completed" || updateRow.status === "failed") {
                    events.push(updateRow.status === "completed" ? "complete-job" : "fail-job");
                  }
                  return { data: jobs[index], error: null };
                },
              };
            },
          };
          return builder;
        },
      };
    },
    rpc(functionName: string, args: { p_job_id: string }) {
      // Deprecated path: unchanged behavior, no attempt created, matching production's
      // claimQueuedCreativeJob (still callable, no longer used by runCreativeJobWithExecutors).
      if (functionName === "claim_creative_job") {
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
            const index = jobs.findIndex((row) => row.id === args.p_job_id && row.status === "queued");
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
            return { data: jobs[index], error: null };
          },
        };
      }

      assert.equal(functionName, "claim_creative_job_with_attempt");
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
          const index = jobs.findIndex((row) => row.id === args.p_job_id && row.status === "queued");
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
          const attempt: CreativeJobAttemptRow = {
            id: `attempt-${attempts.length + 1}`,
            creative_job_id: jobs[index].id!,
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
    },
  } as unknown as CreativeJobExecutionClient;

  return {
    client,
    opportunities,
    jobs,
    attempts,
    events,
    get insertCalls() {
      return insertCalls;
    },
    get updateCalls() {
      return updateCalls;
    },
    get rpcCalls() {
      return rpcCalls;
    },
  };
}

test("isCreativeJobStatus accepts only the approved statuses", () => {
  for (const status of ["queued", "running", "completed", "failed"]) {
    assert.equal(isCreativeJobStatus(status), true);
  }
  for (const status of ["cancelled", "retrying", "converted", "accepted"]) {
    assert.equal(isCreativeJobStatus(status), false);
  }
});

test("isCreativeJobWorkerType accepts only provider-neutral supported workers", () => {
  assert.equal(isCreativeJobWorkerType("mock"), true);
  assert.equal(isCreativeJobWorkerType("product_text_worker"), true);
  for (const workerType of ["claude", "openai", "gemini", "remotion", "image", ""]) {
    assert.equal(isCreativeJobWorkerType(workerType), false);
  }
});

test("fromCreativeJobRow maps nullable timestamps to empty strings", () => {
  const record = fromCreativeJobRow(creativeJobRow());
  assert.equal(record.status, "queued");
  assert.equal(record.workerType, "mock");
  assert.equal(record.lastError, "");
  assert.equal(record.startedAt, "");
  assert.equal(record.completedAt, "");
  assert.equal(record.failedAt, "");
});

test("createCreativeJobForAcceptedOpportunity inserts one queued mock job for an accepted Opportunity", async () => {
  const store = makeClient();
  const result = await createCreativeJobForAcceptedOpportunity(store.client, "opportunity-1");
  assert.equal(result.ok, true);
  assert.equal(store.insertCalls, 1);
  assert.equal(store.jobs.length, 1);
  assert.equal(store.opportunities[0].status, "accepted");
  if (result.ok) {
    assert.equal(result.outcome, "created");
    assert.equal(result.job.status, "queued");
    assert.equal(result.job.workerType, "mock");
    assert.equal(result.job.attemptCount, 0);
    assert.deepEqual(result.job.result, {});
    assert.equal(result.job.lastError, "");
  }
});

test("createCreativeJobForAcceptedOpportunity can queue the provider-neutral product text worker", async () => {
  const store = makeClient();
  const result = await createCreativeJobForAcceptedOpportunity(store.client, "opportunity-1", { workerType: "product_text_worker" });

  assert.equal(result.ok, true);
  assert.equal(store.insertCalls, 1);
  assert.equal(store.jobs.length, 1);
  if (result.ok) {
    assert.equal(result.job.workerType, "product_text_worker");
    assert.equal(result.job.status, "queued");
  }
});

test("createCreativeJobForAcceptedOpportunity refuses non-accepted Opportunities and leaves status unchanged", async () => {
  const store = makeClient({ opportunities: [opportunityRow({ status: "new" })] });
  const result = await createCreativeJobForAcceptedOpportunity(store.client, "opportunity-1");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "not-accepted");
  assert.equal(store.insertCalls, 0);
  assert.equal(store.jobs.length, 0);
  assert.equal(store.opportunities[0].status, "new");
});

test("createCreativeJobForAcceptedOpportunity returns an existing job instead of creating a duplicate", async () => {
  const store = makeClient({ jobs: [creativeJobRow()] });
  const result = await createCreativeJobForAcceptedOpportunity(store.client, "opportunity-1");
  assert.equal(result.ok, true);
  assert.equal(store.insertCalls, 0);
  assert.equal(store.jobs.length, 1);
  if (result.ok) {
    assert.equal(result.outcome, "existing");
    assert.equal(result.job.id, "job-1");
  }
});

test("createCreativeJobForAcceptedOpportunity handles a unique insert race by rereading the same job", async () => {
  const store = makeClient({ uniqueRaceJob: creativeJobRow({ id: "raced-job" }) });
  const result = await createCreativeJobForAcceptedOpportunity(store.client, "opportunity-1");
  assert.equal(result.ok, true);
  assert.equal(store.insertCalls, 1);
  assert.equal(store.jobs.length, 1);
  if (result.ok) {
    assert.equal(result.outcome, "existing");
    assert.equal(result.job.id, "raced-job");
  }
});

test("claimQueuedCreativeJob uses the atomic RPC and increments attempt_count", async () => {
  const store = makeClient({ jobs: [creativeJobRow()] });
  const result = await claimQueuedCreativeJob(store.client, "job-1");
  assert.equal(result.ok, true);
  assert.equal(store.rpcCalls, 1);
  assert.equal(store.jobs[0].status, "running");
  assert.equal(store.jobs[0].attempt_count, 1);
  assert.equal(store.jobs[0].started_at, startedAt);
});

test("claimQueuedCreativeJob does not claim a job already taken by another runner", async () => {
  const store = makeClient({
    jobs: [creativeJobRow()],
    beforeRpc(jobs) {
      jobs[0] = { ...jobs[0], status: "running", attempt_count: 1, started_at: startedAt };
    },
  });
  const result = await claimQueuedCreativeJob(store.client, "job-1");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "not-queued");
  assert.equal(store.jobs[0].status, "running");
  assert.equal(store.jobs[0].attempt_count, 1);
});

test("buildMockCreativeJobResult is deterministic for the same Opportunity", () => {
  const opportunity: OpportunityRecord = {
    id: "opportunity-1",
    opportunityType: "product_marketing_content",
    producer: "daily_advisor",
    sourceType: "daily_advisor",
    sourceId: "source-1",
    title: "Create launch-ready product content for Brownies",
    summary: "Brownies is ready.",
    reason: "Rule Engine evidence supports it.",
    recommendedAction: "create_content",
    evidenceVersion: "v1",
    evidence: {},
    sourceRuleIds: ["RULE-001"],
    sourceFindings: [],
    detectedAt: "2026-07-29T09:00:00.000Z",
    expiresAt: "2026-08-01T09:00:00.000Z",
    deduplicationKey: "key",
    status: "accepted",
    createdAt: "2026-07-29T09:00:00.000Z",
    updatedAt: "2026-07-29T09:00:00.000Z",
  };

  assert.deepEqual(buildMockCreativeJobResult(opportunity), buildMockCreativeJobResult(opportunity));
  assert.deepEqual(buildMockCreativeJobResult(opportunity).artifacts, []);
  assert.equal(buildMockCreativeJobResult(opportunity).schemaVersion, "v1");
});

test("isCreativeJobResultEnvelope validates both supported v1 result shapes", () => {
  const envelope = buildMockCreativeJobResult(fromOpportunityRow(opportunityRow()));
  const productTextEnvelope: CreativeJobResultEnvelope = { ...envelope, worker: "product_text_worker" };

  assert.equal(isCreativeJobResultEnvelope(envelope), true);
  assert.equal(isCreativeJobResultEnvelope(productTextEnvelope), true);
  assert.equal(isCreativeJobResultEnvelope({ ...envelope, schemaVersion: "v2" }), false);
  assert.equal(isCreativeJobResultEnvelope({ ...envelope, worker: "claude" }), false);
  assert.equal(isCreativeJobResultEnvelope({ ...envelope, output: { headline: "", caption: envelope.output.caption } }), false);
  assert.equal(isCreativeJobResultEnvelope({ ...envelope, output: { headline: envelope.output.headline, caption: "" } }), false);
  assert.equal(isCreativeJobResultEnvelope({ ...envelope, metadata: { generatedFromOpportunity: "", generatorVersion: "1" } }), false);
  assert.equal(isCreativeJobResultEnvelope({ ...envelope, artifacts: "none" }), false);
});

test("validateCreativeJobResultEnvelope reports specific rejection reasons", () => {
  const envelope = buildMockCreativeJobResult(fromOpportunityRow(opportunityRow()));

  assert.equal(validateCreativeJobResultEnvelope(envelope).ok, true);
  assert.deepEqual(validateCreativeJobResultEnvelope({ ...envelope, schemaVersion: "v2" }), {
    ok: false,
    reason: "unsupported-schema-version",
    message: "Creative Job result schemaVersion must be v1.",
  });
  for (const [candidate, reason] of [
    [{ ...envelope, worker: "openai" }, "unsupported-worker"],
    [{ ...envelope, output: { headline: "", caption: envelope.output.caption } }, "malformed-output"],
    [{ ...envelope, metadata: { generatedFromOpportunity: "", generatorVersion: "1" } }, "malformed-metadata"],
    [{ ...envelope, artifacts: [{ asset: "out-of-scope" }] }, "malformed-artifacts"],
  ] as const) {
    const result = validateCreativeJobResultEnvelope(candidate);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, reason);
    }
  }
});

test("runMockCreativeJob separates claim, execution, and completion", async () => {
  const store = makeClient({ jobs: [creativeJobRow()] });
  const result = await runMockCreativeJob(store.client, "job-1", { now: () => fixedNow });
  assert.equal(result.ok, true);
  assert.equal(store.rpcCalls, 1);
  assert.equal(store.updateCalls, 1);
  assert.equal(store.opportunities[0].status, "accepted");
  assert.equal(store.jobs[0].status, "completed");
  assert.equal(store.jobs[0].attempt_count, 1);
  assert.equal(store.jobs[0].started_at, startedAt);
  assert.equal(store.jobs[0].completed_at, fixedNow);
  assert.equal(store.jobs[0].failed_at, null);
  assert.equal(store.jobs[0].last_error, null);
  if (result.ok) {
    assert.equal(result.job.status, "completed");
    assert.match(JSON.stringify(result.job.result), /MOCK ONLY/);
  }
});

test("runMockCreativeJob marks the job failed if the accepted Opportunity cannot be read", async () => {
  const store = makeClient({ opportunities: [], jobs: [creativeJobRow()] });
  const result = await runMockCreativeJob(store.client, "job-1", { now: () => fixedNow });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "failed");
  assert.equal(store.jobs[0].status, "failed");
  assert.equal(store.jobs[0].failed_at, fixedNow);
  assert.equal(store.jobs[0].completed_at, null);
  assert.equal(store.jobs[0].last_error, "Creative Job could not load an accepted Opportunity.");
});

test("completeRunningCreativeJob rejects invalid results and persists bounded last_error", async () => {
  const running = creativeJobRow({ status: "running", attempt_count: 1, started_at: startedAt });
  const store = makeClient({ jobs: [running] });
  const invalidResult = {
    schemaVersion: "v1",
    worker: "product_text_worker",
    output: { headline: "", caption: "Caption" },
    metadata: { generatedFromOpportunity: "opportunity-1", generatorVersion: "1" },
    artifacts: [],
  };
  const result = await completeRunningCreativeJob(store.client, fromCreativeJobRow(running), invalidResult, fixedNow);

  assert.equal(result.ok, false);
  assert.equal(result.reason, "failed");
  assert.equal(store.jobs[0].status, "failed");
  assert.equal(store.jobs[0].completed_at, null);
  assert.equal(store.jobs[0].failed_at, fixedNow);
  assert.equal(store.jobs[0].attempt_count, 1);
  assert.equal(store.jobs[0].started_at, startedAt);
  assert.equal(store.jobs[0].last_error, "Creative Job result output must include non-empty headline and caption strings.");
  assert.deepEqual(store.jobs[0].result, {});
});

test("completeRunningCreativeJob validates output and clears old failure diagnostics on success", async () => {
  const running = creativeJobRow({ status: "running", attempt_count: 1, started_at: startedAt, failed_at: fixedNow, last_error: "Previous failure" });
  const store = makeClient({ jobs: [running] });
  const result = await completeRunningCreativeJob(store.client, fromCreativeJobRow(running), buildMockCreativeJobResult(fromOpportunityRow(opportunityRow())), fixedNow);

  assert.equal(result.ok, true);
  assert.equal(store.jobs[0].status, "completed");
  assert.equal(store.jobs[0].failed_at, null);
  assert.equal(store.jobs[0].last_error, null);
  assert.equal(store.jobs[0].completed_at, fixedNow);
});

test("sanitizeCreativeJobErrorMessage bounds and redacts operator-facing errors", () => {
  const message = sanitizeCreativeJobErrorMessage(
    `Failure
 token=abc123 password=hunter2 ${"x".repeat(700)}`,
    80,
  );

  assert.ok(message.length <= 83);
  assert.doesNotMatch(message, /abc123|hunter2|\n/);
  assert.match(message, /token=\[redacted\]/);
});

test("completeRunningCreativeJob does not mutate terminal or non-running jobs", async () => {
  const completed = creativeJobRow({ status: "completed", result: { terminal: true }, completed_at: fixedNow });
  const store = makeClient({ jobs: [completed] });
  const result = await completeRunningCreativeJob(store.client, fromCreativeJobRow(completed), buildMockCreativeJobResult(fromOpportunityRow(opportunityRow())), fixedNow);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "conflict");
  assert.deepEqual(store.jobs[0].result, { terminal: true });
});

test("runQueuedMockCreativeJobs finds queued jobs and processes only that set", async () => {
  const store = makeClient({
    jobs: [
      creativeJobRow({ id: "job-older", created_at: "2026-07-29T09:00:00.000Z" }),
      creativeJobRow({ id: "job-newer", created_at: "2026-07-29T09:30:00.000Z" }),
      creativeJobRow({ id: "job-complete", status: "completed", created_at: "2026-07-29T08:00:00.000Z" }),
    ],
  });
  const result = await runQueuedMockCreativeJobs(store.client, 1, { now: () => fixedNow });
  assert.equal(result.ok, true);
  assert.equal(store.jobs.find((job) => job.id === "job-older")?.status, "completed");
  assert.equal(store.jobs.find((job) => job.id === "job-newer")?.status, "queued");
  assert.equal(store.jobs.find((job) => job.id === "job-complete")?.status, "completed");
});

test("runQueuedMockCreativeJobs does not claim product_text_worker jobs", async () => {
  const store = makeClient({
    jobs: [
      creativeJobRow({ id: "job-product-text", worker_type: "product_text_worker" }),
      creativeJobRow({ id: "job-mock", worker_type: "mock", created_at: "2026-07-29T09:30:00.000Z" }),
    ],
  });
  const result = await runQueuedMockCreativeJobs(store.client, 2, { now: () => fixedNow });

  assert.equal(result.ok, true);
  assert.equal(store.jobs.find((job) => job.id === "job-product-text")?.status, "queued");
  assert.equal(store.jobs.find((job) => job.id === "job-mock")?.status, "completed");
});

test("claimQueuedCreativeJobWithAttempt claims a queued job and creates exactly one running attempt with attempt_number matching post-increment attempt_count", async () => {
  const store = makeClient({ jobs: [creativeJobRow({ worker_type: "product_text_worker" })] });
  const result = await claimQueuedCreativeJobWithAttempt(store.client, "job-1");

  assert.equal(result.ok, true);
  assert.equal(store.attempts.length, 1);
  if (result.ok) {
    assert.equal(result.attemptId, store.attempts[0].id);
    assert.equal(result.attemptNumber, 1);
  }
  assert.equal(store.attempts[0].attempt_number, 1);
  assert.equal(store.attempts[0].creative_job_id, "job-1");
  assert.equal(store.attempts[0].worker_type, "product_text_worker");
  assert.equal(store.attempts[0].status, "running");
  assert.equal(store.attempts[0].started_at, startedAt);
  assert.equal(store.attempts[0].completed_at, null);
});

test("claimQueuedCreativeJobWithAttempt does not claim a job already taken by another runner and creates no attempt row", async () => {
  const store = makeClient({
    jobs: [creativeJobRow()],
    beforeRpc(jobs) {
      jobs[0] = { ...jobs[0], status: "running", attempt_count: 1, started_at: startedAt };
    },
  });
  const result = await claimQueuedCreativeJobWithAttempt(store.client, "job-1");

  assert.equal(result.ok, false);
  assert.equal(result.reason, "not-queued");
  assert.equal(store.attempts.length, 0);
});

test("claimQueuedCreativeJobWithAttempt creates no attempt row when the underlying RPC reports an error", async () => {
  const store = makeClient({ jobs: [creativeJobRow()], rpcError: { message: "boom" } });
  const result = await claimQueuedCreativeJobWithAttempt(store.client, "job-1");

  assert.equal(result.ok, false);
  assert.equal(result.reason, "failed");
  assert.equal(store.attempts.length, 0);
});

test("runCreativeJobWithExecutors finishes the job before finishing its attempt", async () => {
  const store = makeClient({ jobs: [creativeJobRow()] });
  const result = await runMockCreativeJob(store.client, "job-1", { now: () => fixedNow });

  assert.equal(result.ok, true);
  assert.deepEqual(store.events, ["claim-job", "complete-job", "finish-attempt-completed"]);
});

test("runCreativeJobWithExecutors records a completed attempt with a positive latency_ms and no error_code", async () => {
  const laterNow = "2026-07-29T10:05:00.000Z";
  const store = makeClient({ jobs: [creativeJobRow()] });
  const result = await runMockCreativeJob(store.client, "job-1", { now: () => laterNow });

  assert.equal(result.ok, true);
  assert.equal(store.attempts[0].status, "completed");
  assert.equal(store.attempts[0].error_code, null);
  assert.equal(store.attempts[0].error_message, null);
  assert.equal(store.attempts[0].completed_at, laterNow);
  assert.equal(store.attempts[0].latency_ms, Date.parse(laterNow) - Date.parse(startedAt));
  assert.ok((store.attempts[0].latency_ms ?? -1) > 0);
});

test("runCreativeJobWithExecutors stays ok:true and reports the attempt outcome when finishing the attempt hits a missing-table error", async () => {
  const store = makeClient({ jobs: [creativeJobRow()], attemptUpdateError: { code: "PGRST205", message: "missing" } });
  const result = await runMockCreativeJob(store.client, "job-1", { now: () => fixedNow });

  assert.equal(result.ok, true);
  assert.equal(store.jobs[0].status, "completed");
  if (result.ok) {
    assert.equal(result.attempt?.ok, false);
    if (result.attempt && !result.attempt.ok) {
      assert.equal(result.attempt.reason, "missing-table");
    }
  }
});

test("runCreativeJobWithExecutors fails the job and marks the attempt failed with a bounded error_code and error_message", async () => {
  const store = makeClient({ opportunities: [], jobs: [creativeJobRow()] });
  const result = await runMockCreativeJob(store.client, "job-1", { now: () => fixedNow });

  assert.equal(result.ok, false);
  assert.equal(store.jobs[0].status, "failed");
  assert.equal(store.attempts[0].status, "failed");
  assert.equal(store.attempts[0].error_code, "failed");
  assert.equal(store.attempts[0].error_message, "Creative Job could not load an accepted Opportunity.");
});

test("runCreativeJobWithExecutors fails the job and marks the attempt timed_out when the executor exceeds timeoutMs, without a false cancellation claim, and ignores a late resolution", async () => {
  const store = makeClient({ jobs: [creativeJobRow({ worker_type: "product_text_worker" })] });
  let resolveExecutor: (value: unknown) => void = () => {};
  const executors: CreativeJobExecutorMap = {
    product_text_worker: () =>
      new Promise((resolve) => {
        resolveExecutor = resolve;
      }),
  };

  const result = await runCreativeJobWithExecutors(store.client, "job-1", executors, { now: () => fixedNow, timeoutMs: 10 });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "timeout");
  assert.match(result.message, /exceeded 10ms timeout/);
  assert.doesNotMatch(result.message, /cancel/i);
  assert.equal(store.jobs[0].status, "failed");
  assert.equal(store.jobs[0].completed_at, null);
  assert.equal(store.jobs[0].failed_at, fixedNow);
  assert.equal(store.attempts[0].status, "timed_out");
  assert.equal(store.attempts[0].error_code, "timeout");
  assert.equal(store.attempts[0].completed_at, fixedNow);

  resolveExecutor(buildMockCreativeJobResult(fromOpportunityRow(opportunityRow())));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(store.jobs[0].status, "failed");
  assert.equal(store.attempts[0].status, "timed_out");
  assert.deepEqual(store.events, ["claim-job", "fail-job", "finish-attempt-timed-out"]);
});

test("creative job code does not call external providers or create future-domain records", () => {
  const source = readFileSync(new URL("../src/lib/creative-jobs.ts", import.meta.url), "utf8");
  for (const forbidden of [
    /Claude/i,
    /OpenAI/i,
    /Gemini/i,
    /Remotion/i,
    /\bfetch\s*\(/,
    /from\("content_packages"\)/i,
    /from\("assets"\)/i,
    /from\("approvals"\)/i,
    /from\("publishing_jobs"\)/i,
  ]) {
    assert.doesNotMatch(source, forbidden);
  }
});
