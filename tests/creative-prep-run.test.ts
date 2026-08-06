import test from "node:test";
import assert from "node:assert/strict";

import { CREATIVE_PREP_RUNNING_STALE_AFTER_MS, exitCodeForOutcome, runCreativePreparation, type CreativePrepClient } from "../scripts/creative-prep/run.ts";
import { toOpportunityRow, type OpportunityDraft, type OpportunityRow } from "../src/lib/opportunities.ts";
import type { CreativeJobRow } from "../src/lib/creative-jobs.ts";
import type { CreativeJobAttemptRow } from "../src/lib/creative-job-attempts.ts";
import type { CreativePackageRow } from "../src/lib/creative-packages.ts";

type ErrorLike = { code?: string; message: string };

const startedAt = "2026-07-30T09:01:00.000Z";
const finishedAt = "2026-07-30T09:05:00.000Z";

function opportunityDraft(overrides: Partial<OpportunityDraft> = {}): OpportunityDraft {
  return {
    opportunityType: "product_marketing_content",
    producer: "daily_advisor",
    sourceType: "daily_advisor",
    sourceId: "daily_advisor:2026-07-30:product_marketing_content:brownies",
    title: "Create product content for Brownies",
    summary: "Brownies has enough evidence for a marketing content Opportunity.",
    reason: "The Rule Engine found a product-backed marketing opportunity.",
    recommendedAction: "create_content",
    evidenceVersion: "v1",
    evidence: {},
    sourceRuleIds: ["RULE-001"],
    sourceFindings: [],
    detectedAt: "2026-07-30T01:00:00.000Z",
    expiresAt: "2026-08-02T01:00:00.000Z",
    deduplicationKey: "v1|producer=daily_advisor|finding_type=product_marketing_content|entity:product=brownies|action=create_content|business_date=2026-07-30",
    status: "new",
    ...overrides,
  };
}

function opportunityRow(overrides: Partial<OpportunityRow> = {}): OpportunityRow {
  return {
    ...toOpportunityRow(opportunityDraft()),
    id: "opportunity-1",
    created_at: "2026-07-30T01:05:00.000Z",
    updated_at: "2026-07-30T01:05:00.000Z",
    ...overrides,
  };
}

function creativeJobRow(overrides: Partial<CreativeJobRow> = {}): CreativeJobRow {
  return {
    id: "job-1",
    opportunity_id: "opportunity-1",
    status: "queued",
    worker_type: "opportunity_brief",
    attempt_count: 0,
    result: {},
    last_error: null,
    created_at: "2026-07-30T01:10:00.000Z",
    updated_at: "2026-07-30T01:10:00.000Z",
    started_at: null,
    completed_at: null,
    failed_at: null,
    ...overrides,
  };
}

function creativePackageRow(overrides: Partial<CreativePackageRow> = {}): CreativePackageRow {
  return {
    id: "package-1",
    creative_job_id: "job-1",
    status: "ready",
    schema_version: "v1",
    content: {
      output: { headline: "Create product content for Brownies", caption: "The Rule Engine found a product-backed marketing opportunity." },
      metadata: { generatedFromOpportunity: "opportunity-1", generatorVersion: "1", sourceCreativeJobId: "job-1", sourceWorker: "opportunity_brief", sourceJobResultSchemaVersion: "v1" },
      artifacts: [],
    },
    created_at: "2026-07-30T01:16:00.000Z",
    updated_at: "2026-07-30T01:16:00.000Z",
    ...overrides,
  };
}

function makeClient(options: { opportunities?: OpportunityRow[]; jobs?: CreativeJobRow[]; packages?: CreativePackageRow[] } = {}) {
  const opportunities = [...(options.opportunities ?? [])];
  const jobs = [...(options.jobs ?? [])];
  const packages = [...(options.packages ?? [])];
  const attempts: CreativeJobAttemptRow[] = [];

  function matches(row: Record<string, unknown>, filters: Array<{ column: string; value: string }>): boolean {
    return filters.every(({ column, value }) => row[column] === value);
  }

  function singleRowQueryBuilder<T extends Record<string, unknown>>(rows: T[]) {
    const filters: Array<{ column: string; value: string }> = [];
    const builder = {
      eq(column: string, value: string) {
        filters.push({ column, value });
        return builder;
      },
      async maybeSingle() {
        return { data: (rows.find((item) => matches(item, filters)) as T | undefined) ?? null, error: null as ErrorLike | null };
      },
    };
    return builder;
  }

  const client = {
    from(table: string) {
      if (table === "opportunities") {
        return {
          select() {
            const filters: Array<{ column: string; value: string }> = [];
            const orders: Array<{ column: string; ascending: boolean }> = [];
            const builder = {
              eq(column: string, value: string) {
                filters.push({ column, value });
                return builder;
              },
              order(column: string, optionsInput: { ascending: boolean }) {
                orders.push({ column, ascending: optionsInput.ascending });
                return builder;
              },
              limit() {
                return builder;
              },
              async maybeSingle() {
                return { data: opportunities.find((item) => matches(item, filters)) ?? null, error: null };
              },
              then(resolve: (value: { data: OpportunityRow[] | null; error: ErrorLike | null }) => unknown, reject?: (reason: unknown) => unknown) {
                const data = opportunities
                  .filter((item) => matches(item, filters))
                  .sort((a, b) => {
                    for (const order of orders) {
                      const left = String(a[order.column as keyof OpportunityRow] ?? "");
                      const right = String(b[order.column as keyof OpportunityRow] ?? "");
                      const direction = order.ascending ? 1 : -1;
                      const comparison = left.localeCompare(right);
                      if (comparison !== 0) return comparison * direction;
                    }
                    return 0;
                  });
                return Promise.resolve({ data, error: null }).then(resolve, reject);
              },
            };
            return builder;
          },
          update(updateRow: Partial<OpportunityRow>) {
            const filters: Array<{ column: string; value: string }> = [];
            const builder = {
              eq(column: string, value: string) {
                filters.push({ column, value });
                return builder;
              },
              select() {
                return {
                  async maybeSingle() {
                    const index = opportunities.findIndex((item) => matches(item, filters));
                    if (index === -1) {
                      return { data: null, error: null };
                    }
                    opportunities[index] = { ...opportunities[index], ...updateRow };
                    return { data: opportunities[index], error: null };
                  },
                };
              },
            };
            return builder;
          },
        };
      }

      if (table === "creative_jobs") {
        return {
          select() {
            return singleRowQueryBuilder(jobs);
          },
          insert(row: Partial<CreativeJobRow>) {
            return {
              select() {
                return {
                  async single() {
                    const inserted: CreativeJobRow = {
                      id: `job-${jobs.length + 1}`,
                      opportunity_id: row.opportunity_id!,
                      status: "queued",
                      worker_type: row.worker_type ?? "mock",
                      attempt_count: 0,
                      result: {},
                      last_error: null,
                      created_at: startedAt,
                      updated_at: startedAt,
                      started_at: null,
                      completed_at: null,
                      failed_at: null,
                    };
                    jobs.push(inserted);
                    return { data: inserted, error: null };
                  },
                };
              },
            };
          },
        };
      }

      if (table === "creative_packages") {
        return {
          select() {
            return singleRowQueryBuilder(packages);
          },
          insert(row: Partial<CreativePackageRow>) {
            return {
              select() {
                return {
                  async single() {
                    const inserted: CreativePackageRow = {
                      id: `package-${packages.length + 1}`,
                      creative_job_id: row.creative_job_id!,
                      status: row.status ?? "ready",
                      schema_version: row.schema_version ?? "v1",
                      content: row.content ?? {},
                      created_at: finishedAt,
                      updated_at: finishedAt,
                    };
                    packages.push(inserted);
                    return { data: inserted, error: null };
                  },
                };
              },
            };
          },
        };
      }

      throw new Error(`Unexpected table in test client: ${table}`);
    },
    rpc(functionName: string, args: Record<string, unknown>) {
      if (functionName === "claim_creative_job_with_attempt") {
        return {
          async maybeSingle() {
            const index = jobs.findIndex((row) => row.id === (args.p_job_id as string) && row.status === "queued");
            if (index === -1) {
              return { data: null, error: null };
            }
            jobs[index] = { ...jobs[index], status: "running", attempt_count: jobs[index].attempt_count + 1, started_at: startedAt, updated_at: startedAt };
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
              created_at: startedAt,
            };
            attempts.push(attempt);
            return { data: { ...jobs[index], attempt_id: attempt.id, attempt_number: attempt.attempt_number }, error: null };
          },
        };
      }

      if (functionName === "finish_creative_job") {
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
              status: outcome as CreativeJobRow["status"],
              result: outcome === "completed" ? (args.p_result as CreativeJobRow["result"]) : jobs[index].result,
              last_error: outcome === "failed" ? (args.p_last_error as string | null) : null,
              completed_at: outcome === "completed" ? finishedAt : null,
              failed_at: outcome === "failed" ? finishedAt : null,
              updated_at: finishedAt,
            };
            return { data: jobs[index], error: null };
          },
        };
      }

      return {
        async maybeSingle() {
          const outcome = args.p_outcome as string;
          const validOutcome = outcome === "completed" || outcome === "failed" || outcome === "timed_out";
          const index = attempts.findIndex((row) => row.id === (args.p_attempt_id as string) && row.status === "running");
          if (index === -1 || !validOutcome) {
            return { data: null, error: null };
          }
          attempts[index] = { ...attempts[index], status: outcome as CreativeJobAttemptRow["status"], completed_at: finishedAt };
          return { data: attempts[index], error: null };
        },
      };
    },
  } as unknown as CreativePrepClient;

  return { client, opportunities, jobs, packages, attempts };
}

test("runCreativePreparation: full happy path for a brand-new Opportunity", async () => {
  const store = makeClient({ opportunities: [opportunityRow({ status: "new" })] });
  const result = await runCreativePreparation(store.client);

  assert.equal(result.outcome, "ready");
  assert.equal(result.selectedOpportunityId, "opportunity-1");
  assert.equal(result.startingState, "new");
  assert.deepEqual(result.actionsTaken, ["accepted-opportunity", "created-creative-job", "executed-creative-job", "materialized-creative-package"]);
  assert.equal(store.opportunities[0].status, "accepted");
  assert.equal(store.jobs[0].worker_type, "opportunity_brief");
  assert.equal(store.jobs[0].status, "completed");
  assert.equal(store.packages.length, 1);
  assert.equal(result.creativePackageId, store.packages[0].id);

  const content = store.packages[0].content as { output: { headline: string } };
  assert.equal(content.output.headline, store.opportunities[0].title);
  assert.doesNotMatch(JSON.stringify(content), /MOCK ONLY|NON-AI TEST/);
});

test("runCreativePreparation: already-accepted Opportunity with no job does not re-issue the accept call", async () => {
  const store = makeClient({ opportunities: [opportunityRow({ status: "accepted" })] });
  const result = await runCreativePreparation(store.client);

  assert.equal(result.outcome, "ready");
  assert.equal(result.startingState, "accepted");
  assert.deepEqual(result.actionsTaken, ["created-creative-job", "executed-creative-job", "materialized-creative-package"]);
});

test("runCreativePreparation: a queued Creative Job is executed and materialized", async () => {
  const store = makeClient({
    opportunities: [opportunityRow({ status: "accepted" })],
    jobs: [creativeJobRow({ status: "queued" })],
  });
  const result = await runCreativePreparation(store.client);

  assert.equal(result.outcome, "ready");
  assert.deepEqual(result.actionsTaken, ["executed-creative-job", "materialized-creative-package"]);
  assert.equal(store.jobs[0].status, "completed");
  assert.equal(store.packages.length, 1);
});

test("runCreativePreparation: a completed job with no package is materialized without being re-executed", async () => {
  const store = makeClient({
    opportunities: [opportunityRow({ status: "accepted" })],
    jobs: [creativeJobRow({ status: "completed", result: { schemaVersion: "v1", worker: "opportunity_brief", output: { headline: "H", caption: "C" }, metadata: { generatedFromOpportunity: "opportunity-1", generatorVersion: "1" }, artifacts: [] } })],
  });
  const result = await runCreativePreparation(store.client);

  assert.equal(result.outcome, "ready");
  assert.deepEqual(result.actionsTaken, ["materialized-creative-package"]);
  assert.equal(store.packages.length, 1);
});

test("runCreativePreparation: an already-ready Opportunity is a clean no-op with zero writes", async () => {
  const store = makeClient({
    opportunities: [opportunityRow({ status: "accepted" })],
    jobs: [creativeJobRow({ status: "completed" })],
    packages: [creativePackageRow()],
  });
  const result = await runCreativePreparation(store.client);

  assert.equal(result.outcome, "no-op");
  assert.deepEqual(result.actionsTaken, []);
  assert.equal(result.creativePackageId, "package-1");
  assert.equal(store.jobs.length, 1);
  assert.equal(store.packages.length, 1);
});

test("runCreativePreparation: reports a clean no-op when nothing is eligible at all", async () => {
  const store = makeClient({ opportunities: [] });
  const result = await runCreativePreparation(store.client);

  assert.equal(result.outcome, "no-op");
  assert.equal(result.selectedOpportunityId, null);
  assert.equal(result.startingState, null);
});

test("runCreativePreparation: a failed Creative Job is reported as a terminal failure, never silently retried", async () => {
  const store = makeClient({
    opportunities: [opportunityRow({ status: "accepted" })],
    jobs: [creativeJobRow({ status: "failed", last_error: "Worker execution failed." })],
  });
  const result = await runCreativePreparation(store.client);

  // Distinct from "skipped": the selected Opportunity cannot become ready without operator
  // attention, so this must surface as this run's own failure, not a benign shrug.
  assert.equal(result.outcome, "failed");
  assert.match(result.reason ?? "", /operator attention/);
  assert.match(result.reason ?? "", /Worker execution failed\./);
  assert.equal(store.packages.length, 0);
  assert.equal(exitCodeForOutcome(result.outcome), 1);
});

test("runCreativePreparation: a recently started running job is a benign skip, never force-advanced, never treated as a failure", async () => {
  const startedAt = "2026-07-30T09:00:00.000Z";
  const now = () => Date.parse(startedAt) + 60 * 1000; // 1 minute old -- well under the threshold
  const opportunity = opportunityRow({ status: "accepted" });
  const job = creativeJobRow({ status: "running", started_at: startedAt });
  const store = makeClient({ opportunities: [opportunity], jobs: [job] });

  const result = await runCreativePreparation(store.client, { now });

  // Distinct from "failed": another trusted-worker invocation likely already owns this job right
  // now, so this is not this run's problem to report as an error.
  assert.equal(result.outcome, "skipped");
  assert.match(result.reason ?? "", /running elsewhere/);
  assert.doesNotMatch(result.reason ?? "", /suspected stale|stuck/);
  assert.equal(exitCodeForOutcome(result.outcome), 0);
  assert.equal(store.packages.length, 0);
  assert.deepEqual(store.opportunities[0], opportunity);
  assert.deepEqual(store.jobs[0], job);
});

test("runCreativePreparation: a running job exactly at the staleness threshold is reported as suspected-stale and fails", async () => {
  const startedAt = "2026-07-30T09:00:00.000Z";
  const now = () => Date.parse(startedAt) + CREATIVE_PREP_RUNNING_STALE_AFTER_MS; // exactly at the boundary
  const opportunity = opportunityRow({ status: "accepted" });
  const job = creativeJobRow({ status: "running", started_at: startedAt });
  const store = makeClient({ opportunities: [opportunity], jobs: [job] });

  const result = await runCreativePreparation(store.client, { now });

  assert.equal(result.outcome, "failed");
  assert.match(result.reason ?? "", /suspected stale/);
  assert.doesNotMatch(result.reason ?? "", /running elsewhere/);
  assert.equal(exitCodeForOutcome(result.outcome), 1);
  assert.equal(store.packages.length, 0);
  assert.deepEqual(store.opportunities[0], opportunity);
  assert.deepEqual(store.jobs[0], job);
});

test("runCreativePreparation: a running job older than the staleness threshold is reported as suspected-stale and fails", async () => {
  const startedAt = "2026-07-30T09:00:00.000Z";
  const now = () => Date.parse(startedAt) + CREATIVE_PREP_RUNNING_STALE_AFTER_MS + 60 * 1000; // 1 minute past the boundary
  const opportunity = opportunityRow({ status: "accepted" });
  const job = creativeJobRow({ status: "running", started_at: startedAt });
  const store = makeClient({ opportunities: [opportunity], jobs: [job] });

  const result = await runCreativePreparation(store.client, { now });

  assert.equal(result.outcome, "failed");
  assert.match(result.reason ?? "", /suspected stale/);
  assert.match(result.reason ?? "", /operator attention/);
  assert.equal(exitCodeForOutcome(result.outcome), 1);
  assert.equal(store.packages.length, 0);
  assert.deepEqual(store.opportunities[0], opportunity);
  assert.deepEqual(store.jobs[0], job);
});

test("runCreativePreparation: a running job with a missing started_at cannot be trusted and fails", async () => {
  const opportunity = opportunityRow({ status: "accepted" });
  const job = creativeJobRow({ status: "running", started_at: null });
  const store = makeClient({ opportunities: [opportunity], jobs: [job] });

  const result = await runCreativePreparation(store.client);

  assert.equal(result.outcome, "failed");
  assert.match(result.reason ?? "", /missing or invalid/);
  assert.equal(exitCodeForOutcome(result.outcome), 1);
  assert.equal(store.packages.length, 0);
  assert.deepEqual(store.opportunities[0], opportunity);
  assert.deepEqual(store.jobs[0], job);
});

test("runCreativePreparation: a running job with an invalid started_at cannot be trusted and fails", async () => {
  const opportunity = opportunityRow({ status: "accepted" });
  const job = creativeJobRow({ status: "running", started_at: "not-a-real-timestamp" });
  const store = makeClient({ opportunities: [opportunity], jobs: [job] });

  const result = await runCreativePreparation(store.client);

  assert.equal(result.outcome, "failed");
  assert.match(result.reason ?? "", /missing or invalid/);
  assert.equal(exitCodeForOutcome(result.outcome), 1);
  assert.equal(store.packages.length, 0);
  assert.deepEqual(store.opportunities[0], opportunity);
  assert.deepEqual(store.jobs[0], job);
});

test("runCreativePreparation: running it twice in a row is idempotent -- second run is a truthful no-op with no duplicate rows", async () => {
  const store = makeClient({ opportunities: [opportunityRow({ status: "new" })] });

  const first = await runCreativePreparation(store.client);
  assert.equal(first.outcome, "ready");

  const second = await runCreativePreparation(store.client);
  assert.equal(second.outcome, "no-op");
  assert.equal(second.selectedOpportunityId, first.selectedOpportunityId);
  assert.equal(second.creativePackageId, first.creativePackageId);

  assert.equal(store.jobs.length, 1);
  assert.equal(store.packages.length, 1);
});
