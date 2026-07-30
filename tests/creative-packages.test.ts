import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildCreativePackageContentFromCompletedJob,
  createCreativePackageFromCompletedJob,
  fromCreativePackageRow,
  getCreativePackageForJob,
  isCreativePackageContentV1,
  isCreativePackageStatus,
  runMockCreativeJobAndMaterializePackage,
  type CreativePackageRunnerClient,
  type CreativePackageRow,
} from "../src/lib/creative-packages.ts";
import { buildMockCreativeJobResult, fromCreativeJobRow, type CreativeJobRow } from "../src/lib/creative-jobs.ts";
import { type CreativeJobAttemptRow } from "../src/lib/creative-job-attempts.ts";
import { toOpportunityRow, type OpportunityDraft, type OpportunityRow } from "../src/lib/opportunities.ts";

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

function completedJobRow(overrides: Partial<CreativeJobRow> = {}): CreativeJobRow {
  const job = fromCreativeJobRow({
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
  });

  return {
    id: "job-1",
    opportunity_id: "opportunity-1",
    status: "completed",
    worker_type: "mock",
    attempt_count: 1,
    result: buildMockCreativeJobResult({
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
    }),
    last_error: null,
    created_at: job.createdAt,
    updated_at: fixedNow,
    started_at: startedAt,
    completed_at: fixedNow,
    failed_at: null,
    ...overrides,
  };
}

function creativePackageRow(overrides: Partial<CreativePackageRow> = {}): CreativePackageRow {
  const job = fromCreativeJobRow(completedJobRow());
  return {
    id: "package-1",
    creative_job_id: "job-1",
    status: "ready",
    schema_version: "v1",
    content: buildCreativePackageContentFromCompletedJob(job),
    created_at: "2026-07-29T10:05:00.000Z",
    updated_at: "2026-07-29T10:05:00.000Z",
    ...overrides,
  };
}

function makeClient(
  options: {
    opportunities?: OpportunityRow[];
    jobs?: CreativeJobRow[];
    packages?: CreativePackageRow[];
    packageSelectError?: ErrorLike;
    packageInsertError?: ErrorLike;
    uniqueRacePackage?: CreativePackageRow;
  } = {},
) {
  const opportunities = [...(options.opportunities ?? [opportunityRow()])];
  const jobs = [...(options.jobs ?? [completedJobRow()])];
  const packages = [...(options.packages ?? [])];
  const attempts: CreativeJobAttemptRow[] = [];
  const events: string[] = [];
  let packageInsertCalls = 0;
  let opportunityUpdateCalls = 0;

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
      then(resolve: (value: { data: T[] | null; error: ErrorLike | null }) => unknown, reject?: (reason: unknown) => unknown) {
        if (selectError) {
          return Promise.resolve({ data: null, error: selectError }).then(resolve, reject);
        }
        return Promise.resolve({ data: rows.filter((row) => matches(row as Record<string, unknown>, filters)), error: null }).then(resolve, reject);
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
            opportunityUpdateCalls += 1;
            throw new Error("Opportunity updates are out of scope for package materialization.");
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
            throw new Error("Creative Job inserts are out of scope for package materialization.");
          },
        };
      }

      assert.equal(table, "creative_packages");
      return {
        select() {
          return queryBuilder(packages, options.packageSelectError);
        },
        insert(row: Partial<CreativePackageRow>) {
          return {
            select() {
              return {
                async single() {
                  packageInsertCalls += 1;
                  events.push("insert-package");
                  if (options.uniqueRacePackage && packageInsertCalls === 1) {
                    packages.push(options.uniqueRacePackage);
                    return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } };
                  }
                  if (options.packageInsertError) {
                    return { data: null, error: options.packageInsertError };
                  }
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
  } as unknown as CreativePackageRunnerClient;

  return {
    client,
    opportunities,
    jobs,
    packages,
    attempts,
    events,
    get packageInsertCalls() {
      return packageInsertCalls;
    },
    get opportunityUpdateCalls() {
      return opportunityUpdateCalls;
    },
  };
}

test("isCreativePackageStatus accepts only ready", () => {
  assert.equal(isCreativePackageStatus("ready"), true);
  for (const status of ["queued", "completed", "failed", "approved"]) {
    assert.equal(isCreativePackageStatus(status), false);
  }
});

test("fromCreativePackageRow maps one ready package", () => {
  const record = fromCreativePackageRow(creativePackageRow());
  assert.equal(record.id, "package-1");
  assert.equal(record.creativeJobId, "job-1");
  assert.equal(record.status, "ready");
  assert.equal(record.schemaVersion, "v1");
});

test("buildCreativePackageContentFromCompletedJob creates deterministic package content", () => {
  const job = fromCreativeJobRow(completedJobRow());
  const first = buildCreativePackageContentFromCompletedJob(job);
  const second = buildCreativePackageContentFromCompletedJob(job);

  assert.deepEqual(first, second);
  assert.deepEqual(first.artifacts, []);
  assert.equal(first.output.headline, "MOCK ONLY - Create launch-ready product content for Brownies");
  assert.equal(first.metadata.generatedFromOpportunity, "opportunity-1");
  assert.equal(first.metadata.sourceCreativeJobId, "job-1");
  assert.equal(first.metadata.sourceWorker, "mock");
  assert.equal(first.metadata.sourceJobResultSchemaVersion, "v1");
  assert.doesNotMatch(JSON.stringify(first), /2026-07-29T/);
});

test("buildCreativePackageContentFromCompletedJob supports product_text_worker without execution diagnostics", () => {
  const job = fromCreativeJobRow(
    completedJobRow({
      worker_type: "product_text_worker",
      result: {
        schemaVersion: "v1",
        worker: "product_text_worker",
        output: {
          headline: "NON-AI TEST - Brownies",
          caption: "NON-AI TEST - Brownies are ready.",
        },
        metadata: {
          generatedFromOpportunity: "opportunity-1",
          generatorVersion: "1",
        },
        artifacts: [],
      },
    }),
  );
  const content = buildCreativePackageContentFromCompletedJob(job);

  assert.equal(content.metadata.sourceWorker, "product_text_worker");
  assert.equal(content.output.headline, "NON-AI TEST - Brownies");
  assert.equal(content.metadata.generatedFromOpportunity, "opportunity-1");
  assert.doesNotMatch(JSON.stringify(content), /provider|model|tokens|prompt|raw_response|request/i);
});

test("isCreativePackageContentV1 requires the supported content shape", () => {
  assert.equal(isCreativePackageContentV1(creativePackageRow().content), true);
  assert.equal(isCreativePackageContentV1({ output: { headline: "x", caption: "x" }, metadata: { generatedFromOpportunity: "opportunity-1", generatorVersion: "1", sourceCreativeJobId: "job-1", sourceWorker: "product_text_worker", sourceJobResultSchemaVersion: "v1" }, artifacts: [] }), true);
  assert.equal(isCreativePackageContentV1({ output: { headline: "", caption: "x" }, metadata: {}, artifacts: [] }), false);
  assert.equal(isCreativePackageContentV1({ output: { headline: "x", caption: "x" }, metadata: { generatedFromOpportunity: "opportunity-1" }, artifacts: [] }), false);
  assert.equal(isCreativePackageContentV1({ output: { headline: "x", caption: "x" }, metadata: { generatedFromOpportunity: "opportunity-1", generatorVersion: "1", sourceCreativeJobId: "job-1", sourceWorker: "mock", sourceJobResultSchemaVersion: "v1" } }), false);
  assert.equal(isCreativePackageContentV1({ output: { headline: "x", caption: "x" }, metadata: { generatedFromOpportunity: "opportunity-1", generatorVersion: "1", sourceCreativeJobId: "job-1", sourceWorker: "claude", sourceJobResultSchemaVersion: "v1" }, artifacts: [] }), false);
});

test("createCreativePackageFromCompletedJob creates one ready package from a completed job", async () => {
  const store = makeClient();
  const originalJob = JSON.stringify(store.jobs[0]);
  const originalOpportunity = JSON.stringify(store.opportunities[0]);
  const result = await createCreativePackageFromCompletedJob(store.client, "job-1");

  assert.equal(result.ok, true);
  assert.equal(store.packageInsertCalls, 1);
  assert.equal(store.packages.length, 1);
  assert.equal(JSON.stringify(store.jobs[0]), originalJob);
  assert.equal(JSON.stringify(store.opportunities[0]), originalOpportunity);
  assert.equal(store.opportunityUpdateCalls, 0);
  if (result.ok) {
    assert.equal(result.outcome, "created");
    assert.equal(result.creativePackage.status, "ready");
    assert.equal(result.creativePackage.schemaVersion, "v1");
    assert.equal(isCreativePackageContentV1(result.creativePackage.content), true);
  }
});

test("createCreativePackageFromCompletedJob returns an existing package instead of creating a duplicate", async () => {
  const store = makeClient({ packages: [creativePackageRow()] });
  const result = await createCreativePackageFromCompletedJob(store.client, "job-1");

  assert.equal(result.ok, true);
  assert.equal(store.packageInsertCalls, 0);
  assert.equal(store.packages.length, 1);
  if (result.ok) {
    assert.equal(result.outcome, "existing");
    assert.equal(result.creativePackage.id, "package-1");
  }
});

test("createCreativePackageFromCompletedJob handles a unique insert race by rereading the same package", async () => {
  const store = makeClient({ uniqueRacePackage: creativePackageRow({ id: "raced-package" }) });
  const result = await createCreativePackageFromCompletedJob(store.client, "job-1");

  assert.equal(result.ok, true);
  assert.equal(store.packageInsertCalls, 1);
  assert.equal(store.packages.length, 1);
  if (result.ok) {
    assert.equal(result.outcome, "existing");
    assert.equal(result.creativePackage.id, "raced-package");
  }
});

test("createCreativePackageFromCompletedJob rejects non-completed jobs", async () => {
  for (const status of ["queued", "running", "failed"] as const) {
    const store = makeClient({ jobs: [completedJobRow({ status })] });
    const result = await createCreativePackageFromCompletedJob(store.client, "job-1");

    assert.equal(result.ok, false);
    assert.equal(result.reason, "invalid-job-status");
    assert.equal(store.packageInsertCalls, 0);
    assert.equal(store.packages.length, 0);
  }
});

test("createCreativePackageFromCompletedJob rejects missing jobs and malformed results", async () => {
  const missing = makeClient({ jobs: [] });
  const missingResult = await createCreativePackageFromCompletedJob(missing.client, "job-1");
  assert.equal(missingResult.ok, false);
  assert.equal(missingResult.reason, "not-found");

  const malformed = makeClient({ jobs: [completedJobRow({ result: { schemaVersion: "v1", worker: "mock", output: { headline: "", caption: "x" }, metadata: { generatedFromOpportunity: "opportunity-1", generatorVersion: "1" }, artifacts: [] } })] });
  const malformedResult = await createCreativePackageFromCompletedJob(malformed.client, "job-1");
  assert.equal(malformedResult.ok, false);
  assert.equal(malformedResult.reason, "unsupported-result");
  assert.equal(malformed.packageInsertCalls, 0);

  const unsupported = makeClient({ jobs: [completedJobRow({ result: { schemaVersion: "v2", worker: "mock", output: { headline: "x", caption: "x" }, metadata: { generatedFromOpportunity: "opportunity-1", generatorVersion: "1" }, artifacts: [] } })] });
  const unsupportedResult = await createCreativePackageFromCompletedJob(unsupported.client, "job-1");
  assert.equal(unsupportedResult.ok, false);
  assert.equal(unsupportedResult.reason, "unsupported-result");
});

test("createCreativePackageFromCompletedJob reports database failures honestly", async () => {
  const store = makeClient({ packageInsertError: { message: "write failed" } });
  const result = await createCreativePackageFromCompletedJob(store.client, "job-1");

  assert.equal(result.ok, false);
  assert.equal(result.reason, "failed");
  assert.equal(result.message, "write failed");
  assert.equal(store.packages.length, 0);
});

test("getCreativePackageForJob returns not-found without pretending a package exists", async () => {
  const store = makeClient();
  const result = await getCreativePackageForJob(store.client, "job-1");

  assert.equal(result.ok, false);
  assert.equal(result.reason, "not-found");
});

test("runMockCreativeJobAndMaterializePackage completes the job before materializing the package", async () => {
  const store = makeClient({ jobs: [completedJobRow({ status: "queued", attempt_count: 0, result: {}, started_at: null, completed_at: null })] });
  const result = await runMockCreativeJobAndMaterializePackage(store.client, "job-1");

  assert.equal(result.ok, true);
  assert.deepEqual(store.events, ["claim-job", "complete-job", "finish-attempt-completed", "insert-package"]);
  assert.equal(store.jobs[0].status, "completed");
  assert.equal(store.jobs[0].attempt_count, 1);
  assert.equal(store.packages.length, 1);
  assert.equal(store.opportunities[0].status, "accepted");
  assert.equal(store.attempts[0].status, "completed");
  if (result.ok) {
    assert.equal(result.packageOutcome, "created");
  }
});

test("runMockCreativeJobAndMaterializePackage keeps a completed job completed if materialization fails", async () => {
  const store = makeClient({
    jobs: [completedJobRow({ status: "queued", attempt_count: 0, result: {}, started_at: null, completed_at: null })],
    packageInsertError: { message: "package write failed" },
  });
  const result = await runMockCreativeJobAndMaterializePackage(store.client, "job-1");

  assert.equal(result.ok, false);
  assert.equal(result.reason, "failed");
  assert.equal(result.message, "package write failed");
  assert.deepEqual(store.events, ["claim-job", "complete-job", "finish-attempt-completed", "insert-package"]);
  assert.equal(store.jobs[0].status, "completed");
  assert.equal(store.jobs[0].completed_at, finishedAt);
  assert.equal(store.packages.length, 0);
});

test("runMockCreativeJobAndMaterializePackage is safe to invoke after a package already exists", async () => {
  const store = makeClient({ jobs: [completedJobRow({ status: "queued", attempt_count: 0, result: {}, started_at: null, completed_at: null })] });
  const first = await runMockCreativeJobAndMaterializePackage(store.client, "job-1");
  const second = await createCreativePackageFromCompletedJob(store.client, "job-1");

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(store.packages.length, 1);
  if (second.ok) {
    assert.equal(second.outcome, "existing");
  }
});

test("creative package code does not call external providers or create excluded records", () => {
  const packageSource = readFileSync(new URL("../src/lib/creative-packages.ts", import.meta.url), "utf8");
  const jobSource = readFileSync(new URL("../src/lib/creative-jobs.ts", import.meta.url), "utf8");

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
    assert.doesNotMatch(packageSource, forbidden);
  }

  assert.doesNotMatch(packageSource, /from\("opportunities"\)\.update/i);
  assert.doesNotMatch(jobSource, /creative-packages/i);
  assert.doesNotMatch(jobSource, /createCreativePackageFromCompletedJob/i);
});
