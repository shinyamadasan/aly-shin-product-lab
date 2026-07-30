import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildMockCreativeJobResult,
  claimQueuedCreativeJob,
  completeRunningCreativeJob,
  createCreativeJobForAcceptedOpportunity,
  fromCreativeJobRow,
  isCreativeJobResultEnvelope,
  isCreativeJobStatus,
  runMockCreativeJob,
  runQueuedMockCreativeJobs,
  type CreativeJobClient,
  type CreativeJobRow,
} from "../src/lib/creative-jobs.ts";
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
  } = {},
) {
  const opportunities = [...(options.opportunities ?? [opportunityRow()])];
  const jobs = [...(options.jobs ?? [])];
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
      assert.equal(functionName, "claim_creative_job");
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
    },
  } as unknown as CreativeJobClient;

  return {
    client,
    opportunities,
    jobs,
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

test("fromCreativeJobRow maps nullable timestamps to empty strings", () => {
  const record = fromCreativeJobRow(creativeJobRow());
  assert.equal(record.status, "queued");
  assert.equal(record.workerType, "mock");
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

test("isCreativeJobResultEnvelope validates the supported mock result shape", () => {
  const envelope = buildMockCreativeJobResult(fromOpportunityRow(opportunityRow()));

  assert.equal(isCreativeJobResultEnvelope(envelope), true);
  assert.equal(isCreativeJobResultEnvelope({ ...envelope, schemaVersion: "v2" }), false);
  assert.equal(isCreativeJobResultEnvelope({ ...envelope, output: { headline: "", caption: envelope.output.caption } }), false);
  assert.equal(isCreativeJobResultEnvelope({ ...envelope, metadata: { generatedFromOpportunity: "", generatorVersion: "1" } }), false);
  assert.equal(isCreativeJobResultEnvelope({ ...envelope, artifacts: "none" }), false);
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
