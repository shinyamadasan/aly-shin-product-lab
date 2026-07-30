import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { createCreativePackageFromCompletedJob, type CreativePackageRow, type CreativePackageRunnerClient } from "../src/lib/creative-packages.ts";
import { type CreativeJobExecutorMap, type CreativeJobRow } from "../src/lib/creative-jobs.ts";
import { type CreativeJobAttemptClient, type CreativeJobAttemptRow } from "../src/lib/creative-job-attempts.ts";
import { toOpportunityRow, type OpportunityDraft, type OpportunityRecord, type OpportunityRow } from "../src/lib/opportunities.ts";
import { buildProductTextWorkerReadinessResult, runTrustedCreativeJobAndMaterializePackage } from "../scripts/creative-workers/runner.ts";

type ErrorLike = { code?: string; message: string };

const fixedNow = "2026-07-29T10:00:00.000Z";
const startedAt = "2026-07-29T10:01:00.000Z";
// Stands in for finish_creative_job/finish_creative_job_attempt's own now() -- deliberately
// later than startedAt so latency/ordering assertions are meaningful. options.now has no effect
// on it; nothing in production ever passes a timestamp into either RPC.
const finishedAt = "2026-07-29T10:05:00.000Z";

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
    worker_type: "product_text_worker",
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

function makeClient(options: { opportunities?: OpportunityRow[]; jobs?: CreativeJobRow[]; packages?: CreativePackageRow[] } = {}) {
  const opportunities = [...(options.opportunities ?? [opportunityRow()])];
  const jobs = [...(options.jobs ?? [creativeJobRow()])];
  const packages = [...(options.packages ?? [])];
  const attempts: CreativeJobAttemptRow[] = [];
  const events: string[] = [];

  function matches(row: Record<string, unknown>, filters: Array<{ column: string; value: string }>): boolean {
    return filters.every(({ column, value }) => row[column] === value);
  }

  function queryBuilder<T>(rows: T[], selectError?: ErrorLike) {
    const filters: Array<{ column: string; value: string }> = [];
    const builder = {
      eq(column: string, value: string) {
        filters.push({ column, value });
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
          update() {
            throw new Error("Opportunity updates are out of scope for trusted worker execution.");
          },
        };
      }

      // creative_job_attempts has no from(...) handler -- finishing an attempt only ever calls
      // the finish_creative_job_attempt RPC below, matching the production client type.
      if (table === "creative_jobs") {
        return {
          select() {
            return queryBuilder(jobs);
          },
          insert() {
            throw new Error("Creative Job inserts are out of scope for trusted worker execution.");
          },
        };
      }

      assert.equal(table, "creative_packages");
      return {
        select() {
          return queryBuilder(packages);
        },
        insert(row: Partial<CreativePackageRow>) {
          return {
            select() {
              return {
                async single() {
                  const inserted = {
                    creative_job_id: row.creative_job_id!,
                    status: row.status ?? "ready",
                    schema_version: row.schema_version ?? "v1",
                    content: row.content ?? {},
                    id: `package-${packages.length + 1}`,
                    created_at: fixedNow,
                    updated_at: fixedNow,
                  } satisfies CreativePackageRow;
                  packages.push(inserted);
                  events.push("insert-package");
                  return { data: inserted, error: null };
                },
              };
            },
          };
        },
      };
    },
    rpc(functionName: string, args: Record<string, unknown>) {
      if (functionName === "claim_creative_job_with_attempt") {
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
      }

      if (functionName === "finish_creative_job") {
        return {
          // Mirrors finish_creative_job's own guards: id + status='running' + p_outcome in
          // ('completed','failed').
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
            events.push(outcome === "completed" ? "complete-job" : "fail-job");
            return { data: jobs[index], error: null };
          },
        };
      }

      assert.equal(functionName, "finish_creative_job_attempt");
      return {
        // Mirrors finish_creative_job_attempt's own guards: id + status='running' + p_outcome in
        // ('completed','failed','timed_out').
        async maybeSingle() {
          const outcome = args.p_outcome as string;
          const validOutcome = outcome === "completed" || outcome === "failed" || outcome === "timed_out";
          const index = attempts.findIndex((row) => row.id === (args.p_attempt_id as string) && row.status === "running");
          if (index === -1 || !validOutcome) {
            return { data: null, error: null };
          }
          attempts[index] = {
            ...attempts[index],
            status: outcome as CreativeJobAttemptRow["status"],
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
  } as unknown as CreativePackageRunnerClient & CreativeJobAttemptClient;

  return { client, opportunities, jobs, packages, attempts, events };
}

test("trusted runner completes a valid product_text_worker job and materializes one package", async () => {
  const store = makeClient();
  const result = await runTrustedCreativeJobAndMaterializePackage(store.client, "job-1");

  assert.equal(result.ok, true);
  assert.deepEqual(store.events, ["claim-job", "complete-job", "finish-attempt-completed", "insert-package"]);
  assert.equal(store.jobs[0].status, "completed");
  assert.equal(store.jobs[0].attempt_count, 1);
  assert.equal(store.jobs[0].last_error, null);
  assert.equal(store.packages.length, 1);
  assert.equal(store.opportunities[0].status, "accepted");
  assert.match(JSON.stringify(store.jobs[0].result), /NON-AI TEST/);
  assert.doesNotMatch(JSON.stringify(store.packages[0].content), /provider|model|tokens|prompt|raw_response|request/i);
  assert.equal(store.attempts.length, 1);
  assert.equal(store.attempts[0].status, "completed");
  assert.equal(store.attempts[0].worker_type, "product_text_worker");
  assert.equal(store.attempts[0].error_code, null);

  const duplicate = await createCreativePackageFromCompletedJob(store.client, "job-1");
  assert.equal(duplicate.ok, true);
  assert.equal(store.packages.length, 1);
});

test("trusted runner fails invalid product_text_worker output without creating a package", async () => {
  const invalidExecutors: CreativeJobExecutorMap = {
    product_text_worker: () => ({
      schemaVersion: "v1",
      worker: "product_text_worker",
      output: { headline: "", caption: "Caption" },
      metadata: { generatedFromOpportunity: "opportunity-1", generatorVersion: "1" },
      artifacts: [],
    }),
  };
  const store = makeClient();
  const result = await runTrustedCreativeJobAndMaterializePackage(store.client, "job-1", { executors: invalidExecutors });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "failed");
  assert.deepEqual(store.events, ["claim-job", "fail-job", "finish-attempt-failed"]);
  assert.equal(store.jobs[0].status, "failed");
  assert.equal(store.jobs[0].completed_at, null);
  assert.equal(store.jobs[0].failed_at, finishedAt);
  assert.equal(store.jobs[0].last_error, "Creative Job result output must include non-empty headline and caption strings.");
  assert.equal(store.packages.length, 0);
  assert.equal(store.opportunities[0].status, "accepted");
  assert.equal(store.attempts[0].status, "failed");
  assert.equal(store.attempts[0].error_code, "failed");
});

test("trusted runner fails unsupported worker types honestly", async () => {
  const store = makeClient({ jobs: [creativeJobRow({ worker_type: "local_video_worker" })] });
  const result = await runTrustedCreativeJobAndMaterializePackage(store.client, "job-1");

  assert.equal(result.ok, false);
  assert.equal(result.reason, "failed");
  assert.equal(store.jobs[0].status, "failed");
  assert.equal(store.jobs[0].last_error, "Unsupported worker type: local_video_worker.");
  assert.equal(store.packages.length, 0);
  assert.equal(store.opportunities[0].status, "accepted");
});

test("product text readiness result is deterministic and marked as non-AI", () => {
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

  assert.deepEqual(buildProductTextWorkerReadinessResult(opportunity), buildProductTextWorkerReadinessResult(opportunity));
  assert.equal(buildProductTextWorkerReadinessResult(opportunity).worker, "product_text_worker");
  assert.match(buildProductTextWorkerReadinessResult(opportunity).output.headline, /^NON-AI TEST/);
});

test("trusted runner boundary avoids client execution controls and excluded domains", () => {
  const runnerSource = readFileSync(new URL("../scripts/creative-workers/runner.ts", import.meta.url), "utf8");
  const pageSource = readFileSync(new URL("../src/components/opportunities-page.tsx", import.meta.url), "utf8");

  for (const forbidden of [
    /Claude/i,
    /OpenAI/i,
    /Gemini/i,
    /Remotion/i,
    /\bfetch\s*\(/,
    /from\("assets"\)/i,
    /from\("approvals"\)/i,
    /from\("publishing_jobs"\)/i,
    /from\("content_drafts"\)/i,
  ]) {
    assert.doesNotMatch(runnerSource, forbidden);
  }

  assert.doesNotMatch(pageSource, /runTrustedCreativeJobAndMaterializePackage/);
  assert.doesNotMatch(pageSource, /Run AI|Retry|Provider selector|Model selector|Prompt editor|API key/i);
  assert.doesNotMatch(pageSource, /from\("creative_job_attempts"\)/i);
});
