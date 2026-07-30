import test from "node:test";
import assert from "node:assert/strict";

import {
  parseSubcommand,
  resolveAnthropicApiKey,
  runApiCommand,
  runExportCommand,
  runImportCommand,
  type CreativeWorkerCliClient,
} from "../scripts/creative-workers/run.ts";
import type { CreativeJobRow } from "../src/lib/creative-jobs.ts";
import type { CreativeJobAttemptRow } from "../src/lib/creative-job-attempts.ts";
import type { CreativePackageRow } from "../src/lib/creative-packages.ts";
import { toOpportunityRow, type OpportunityDraft, type OpportunityRow } from "../src/lib/opportunities.ts";

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
    sourceFindings: [],
    detectedAt: "2026-07-29T09:00:00.000Z",
    expiresAt: "2026-08-01T09:00:00.000Z",
    deduplicationKey: "key",
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
  const attempts: CreativeJobAttemptRow[] = [];
  const packages = [...(options.packages ?? [])];
  let rpcCalls = 0;
  let jobUpdateCalls = 0;

  function matches(row: Record<string, unknown>, filters: Array<{ column: string; value: string }>): boolean {
    return filters.every(({ column, value }) => row[column] === value);
  }

  function selectBuilder<T>(rows: T[]) {
    const filters: Array<{ column: string; value: string }> = [];
    const builder = {
      eq(column: string, value: string) {
        filters.push({ column, value });
        return builder;
      },
      async maybeSingle() {
        return { data: rows.find((row) => matches(row as Record<string, unknown>, filters)) ?? null, error: null };
      },
      select() {
        return {
          maybeSingle: builder.maybeSingle,
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
            return selectBuilder(opportunities);
          },
          update() {
            throw new Error("Opportunity updates are out of scope for the creative-workers CLI.");
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
                    const index = attempts.findIndex((row) => matches(row as Record<string, unknown>, filters));
                    if (index === -1) return { data: null, error: null };
                    attempts[index] = { ...attempts[index], ...updateRow };
                    return { data: attempts[index], error: null };
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
            return selectBuilder(jobs);
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
                    jobUpdateCalls += 1;
                    const index = jobs.findIndex((row) => matches(row as Record<string, unknown>, filters));
                    if (index === -1) return { data: null, error: null };
                    jobs[index] = { ...jobs[index], ...updateRow };
                    return { data: jobs[index], error: null };
                  },
                };
              },
            };
            return builder;
          },
        };
      }

      assert.equal(table, "creative_packages");
      return {
        select() {
          return selectBuilder(packages);
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
                  return { data: inserted, error: null };
                },
              };
            },
          };
        },
      };
    },
    rpc(functionName: string, args: { p_job_id: string }) {
      assert.equal(functionName, "claim_creative_job_with_attempt");
      return {
        async maybeSingle() {
          rpcCalls += 1;
          const index = jobs.findIndex((row) => row.id === args.p_job_id && row.status === "queued");
          if (index === -1) return { data: null, error: null };
          jobs[index] = {
            ...jobs[index],
            status: "running",
            attempt_count: jobs[index].attempt_count + 1,
            started_at: startedAt,
            updated_at: startedAt,
          };
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
  } as unknown as CreativeWorkerCliClient;

  return {
    client,
    opportunities,
    jobs,
    attempts,
    packages,
    get rpcCalls() {
      return rpcCalls;
    },
    get jobUpdateCalls() {
      return jobUpdateCalls;
    },
  };
}

test("parseSubcommand recognizes only the three approved subcommands", () => {
  assert.equal(parseSubcommand(["export"]), "export");
  assert.equal(parseSubcommand(["import"]), "import");
  assert.equal(parseSubcommand(["run-api"]), "run-api");
  assert.equal(parseSubcommand([]), null);
  assert.equal(parseSubcommand(["run"]), null);
  assert.equal(parseSubcommand(["anthropic_api"]), null);
});

test("resolveAnthropicApiKey fails without ANTHROPIC_API_KEY set", () => {
  const result = resolveAnthropicApiKey({});
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.message, /ANTHROPIC_API_KEY is not set/);
  }
});

test("resolveAnthropicApiKey succeeds when ANTHROPIC_API_KEY is set", () => {
  const result = resolveAnthropicApiKey({ ANTHROPIC_API_KEY: "sk-test" });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.apiKey, "sk-test");
  }
});

test("runExportCommand reads a queued job without claiming or mutating it", async () => {
  const store = makeClient();
  const outcome = await runExportCommand(store.client, "job-1");

  assert.equal(outcome.exitCode, 0);
  assert.match(outcome.document ?? "", /job job-1/);
  assert.equal(store.rpcCalls, 0);
  assert.equal(store.jobUpdateCalls, 0);
  assert.equal(store.jobs[0].status, "queued");
  assert.equal(store.jobs[0].attempt_count, 0);
  assert.equal(store.jobs[0].started_at, null);
});

test("runExportCommand refuses a job that is not queued and still does not mutate it", async () => {
  const store = makeClient({ jobs: [creativeJobRow({ status: "running" })] });
  const outcome = await runExportCommand(store.client, "job-1");

  assert.equal(outcome.exitCode, 2);
  assert.match(outcome.message ?? "", /is not queued/);
  assert.equal(store.rpcCalls, 0);
  assert.equal(store.jobUpdateCalls, 0);
});

test("runImportCommand rejects an invalid manual result before claiming the job", async () => {
  const store = makeClient();
  const outcome = await runImportCommand(store.client, "job-1", "not json");

  assert.equal(outcome.exitCode, 2);
  assert.match(outcome.message ?? "", /invalid/i);
  assert.match(outcome.message ?? "", /NOT claimed/);
  assert.equal(store.rpcCalls, 0);
  assert.equal(store.jobs[0].status, "queued");
});

test("runImportCommand rejects an incomplete manual result before claiming the job", async () => {
  const store = makeClient();
  const outcome = await runImportCommand(store.client, "job-1", JSON.stringify({ headline: "" }));

  assert.equal(outcome.exitCode, 2);
  assert.equal(store.rpcCalls, 0);
  assert.equal(store.jobs[0].status, "queued");
});

test("runImportCommand completes the job and materializes a package end-to-end with zero network requests", async () => {
  const store = makeClient();
  const originalFetch = globalThis.fetch;
  const fetchSpy = (async () => {
    throw new Error("fetch must never be called on the manual import path");
  }) as typeof fetch;
  globalThis.fetch = fetchSpy;

  try {
    const outcome = await runImportCommand(store.client, "job-1", JSON.stringify({ headline: "Fresh Brownies Today", caption: "Warm from the oven." }));

    assert.equal(outcome.exitCode, 0);
    assert.equal(store.jobs[0].status, "completed");
    assert.match(JSON.stringify(store.jobs[0].result), /Fresh Brownies Today/);
    assert.equal(store.packages.length, 1);
    assert.equal(store.attempts[0].status, "completed");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("runApiCommand never constructs a client or calls fetch when ANTHROPIC_API_KEY is missing", async () => {
  let clientFactoryCalled = false;
  let fetchCalled = false;

  const outcome = await runApiCommand(
    async () => {
      clientFactoryCalled = true;
      throw new Error("client factory must not be called without an API key");
    },
    "job-1",
    {},
    (async () => {
      fetchCalled = true;
      throw new Error("fetch must not be called without an API key");
    }) as typeof fetch,
  );

  assert.equal(outcome.exitCode, 2);
  assert.match(outcome.message ?? "", /ANTHROPIC_API_KEY is not set/);
  assert.equal(clientFactoryCalled, false);
  assert.equal(fetchCalled, false);
});
