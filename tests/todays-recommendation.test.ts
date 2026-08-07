import test from "node:test";
import assert from "node:assert/strict";

import { listReadyOpportunities, selectTodaysReadyOpportunity, type TodaysRecommendationClient } from "../src/lib/todays-recommendation.ts";
import { selectPreparationCandidate } from "../src/lib/opportunity-review.ts";
import { toOpportunityRow, type OpportunityDraft, type OpportunityRow } from "../src/lib/opportunities.ts";
import type { CreativeJobRow } from "../src/lib/creative-jobs.ts";
import type { CreativePackageRow } from "../src/lib/creative-packages.ts";

type ErrorLike = { code?: string; message: string };

function opportunityDraft(overrides: Partial<OpportunityDraft> = {}): OpportunityDraft {
  return {
    opportunityType: "product_marketing_content",
    producer: "daily_advisor",
    sourceType: "daily_advisor",
    sourceId: "daily_advisor:2026-07-24:product_marketing_content:brownies",
    title: "Create product content for Brownies",
    summary: "Brownies has enough evidence for a marketing content Opportunity.",
    reason: "The Rule Engine found a product-backed marketing opportunity.",
    recommendedAction: "create_content",
    evidenceVersion: "v1",
    evidence: {},
    sourceRuleIds: ["RULE-001"],
    sourceFindings: [],
    detectedAt: "2026-07-24T01:00:00.000Z",
    expiresAt: "2026-07-27T01:00:00.000Z",
    deduplicationKey: "v1|producer=daily_advisor|finding_type=product_marketing_content|entity:product=brownies|action=create_content|business_date=2026-07-24",
    status: "new",
    ...overrides,
  };
}

function opportunityRow(overrides: Partial<OpportunityRow> = {}): OpportunityRow {
  return {
    ...toOpportunityRow(opportunityDraft()),
    id: "opportunity-1",
    created_at: "2026-07-24T01:05:00.000Z",
    updated_at: "2026-07-24T01:05:00.000Z",
    ...overrides,
  };
}

function creativeJobRow(overrides: Partial<CreativeJobRow> = {}): CreativeJobRow {
  return {
    id: "job-1",
    opportunity_id: "opportunity-1",
    status: "completed",
    worker_type: "mock",
    attempt_count: 1,
    result: {},
    last_error: null,
    created_at: "2026-07-24T01:10:00.000Z",
    updated_at: "2026-07-24T01:15:00.000Z",
    started_at: "2026-07-24T01:11:00.000Z",
    completed_at: "2026-07-24T01:15:00.000Z",
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
      output: { headline: "Brownies", caption: "Real caption" },
      metadata: { generatedFromOpportunity: "opportunity-1", generatorVersion: "1", sourceCreativeJobId: "job-1", sourceWorker: "mock", sourceJobResultSchemaVersion: "v1" },
      artifacts: [],
    },
    created_at: "2026-07-24T01:16:00.000Z",
    updated_at: "2026-07-24T01:16:00.000Z",
    ...overrides,
  };
}

function makeClient(options: { opportunities?: OpportunityRow[]; jobs?: CreativeJobRow[]; packages?: CreativePackageRow[] } = {}): TodaysRecommendationClient {
  const opportunities = [...(options.opportunities ?? [])];
  const jobs = [...(options.jobs ?? [])];
  const packages = [...(options.packages ?? [])];

  function matches(row: Record<string, unknown>, filters: Array<{ column: string; value: string }>): boolean {
    return filters.every(({ column, value }) => row[column] === value);
  }

  function singleRowTable<T extends Record<string, unknown>>(rows: T[]) {
    return {
      select() {
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
      },
    };
  }

  return {
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
        };
      }
      if (table === "creative_jobs") {
        return singleRowTable(jobs);
      }
      if (table === "creative_packages") {
        return singleRowTable(packages);
      }
      throw new Error(`Unexpected table in test client: ${table}`);
    },
  } as unknown as TodaysRecommendationClient;
}

test("selectTodaysReadyOpportunity: skips an accepted Opportunity with no Creative Job", async () => {
  const opp = opportunityRow({ id: "opp-1", status: "accepted" });
  const client = makeClient({ opportunities: [opp], jobs: [], packages: [] });

  const result = await selectTodaysReadyOpportunity(client);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.ready, null);
  }
});

test("selectTodaysReadyOpportunity: skips queued and failed Creative Jobs", async () => {
  const queuedOpp = opportunityRow({ id: "opp-queued", status: "accepted", detected_at: "2026-07-24T02:00:00.000Z" });
  const failedOpp = opportunityRow({ id: "opp-failed", status: "accepted", detected_at: "2026-07-24T01:00:00.000Z" });
  const queuedJob = creativeJobRow({ id: "job-queued", opportunity_id: "opp-queued", status: "queued" });
  const failedJob = creativeJobRow({ id: "job-failed", opportunity_id: "opp-failed", status: "failed" });
  const client = makeClient({ opportunities: [queuedOpp, failedOpp], jobs: [queuedJob, failedJob], packages: [] });

  const result = await selectTodaysReadyOpportunity(client);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.ready, null);
  }
});

test("selectTodaysReadyOpportunity: skips a completed Creative Job with no materialized Creative Package", async () => {
  const opp = opportunityRow({ id: "opp-1", status: "accepted" });
  const job = creativeJobRow({ id: "job-1", opportunity_id: "opp-1", status: "completed" });
  const client = makeClient({ opportunities: [opp], jobs: [job], packages: [] });

  const result = await selectTodaysReadyOpportunity(client);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.ready, null);
  }
});

test("selectTodaysReadyOpportunity: returns the newest accepted Opportunity that actually has a ready package", async () => {
  const older = opportunityRow({ id: "opp-older", status: "accepted", detected_at: "2026-07-23T01:00:00.000Z" });
  const newer = opportunityRow({ id: "opp-newer", status: "accepted", detected_at: "2026-07-24T01:00:00.000Z" });
  const olderJob = creativeJobRow({ id: "job-older", opportunity_id: "opp-older", status: "completed" });
  const newerJob = creativeJobRow({ id: "job-newer", opportunity_id: "opp-newer", status: "completed" });
  const olderPackage = creativePackageRow({ id: "pkg-older", creative_job_id: "job-older" });
  const newerPackage = creativePackageRow({ id: "pkg-newer", creative_job_id: "job-newer" });
  const client = makeClient({ opportunities: [older, newer], jobs: [olderJob, newerJob], packages: [olderPackage, newerPackage] });

  const result = await selectTodaysReadyOpportunity(client);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.ready?.opportunity.id, "opp-newer");
    assert.equal(result.ready?.creativePackage.id, "pkg-newer");
  }
});

test("selectTodaysReadyOpportunity: returns null when no accepted Opportunity is ready", async () => {
  const client = makeClient({ opportunities: [], jobs: [], packages: [] });
  const result = await selectTodaysReadyOpportunity(client);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.ready, null);
  }
});

test("decoupling contract: newer unprepared B is chosen for preparation while older ready A is chosen for Today", async () => {
  const a = opportunityRow({ id: "opp-a", status: "accepted", detected_at: "2026-07-23T01:00:00.000Z", created_at: "2026-07-23T01:05:00.000Z" });
  const b = opportunityRow({ id: "opp-b", status: "new", detected_at: "2026-07-24T01:00:00.000Z", created_at: "2026-07-24T01:05:00.000Z" });
  const jobA = creativeJobRow({ id: "job-a", opportunity_id: "opp-a", status: "completed" });
  const packageA = creativePackageRow({ id: "pkg-a", creative_job_id: "job-a" });
  const client = makeClient({ opportunities: [a, b], jobs: [jobA], packages: [packageA] });

  const preparationPick = await selectPreparationCandidate(client);
  assert.equal(preparationPick.ok, true);
  if (preparationPick.ok) {
    assert.equal(preparationPick.opportunity?.id, "opp-b");
  }

  const todaysPick = await selectTodaysReadyOpportunity(client);
  assert.equal(todaysPick.ok, true);
  if (todaysPick.ok) {
    assert.equal(todaysPick.ready?.opportunity.id, "opp-a");
  }
});

test("decoupling contract: once B is prepared, Today switches from A to B", async () => {
  const a = opportunityRow({ id: "opp-a", status: "accepted", detected_at: "2026-07-23T01:00:00.000Z" });
  const b = opportunityRow({ id: "opp-b", status: "accepted", detected_at: "2026-07-24T01:00:00.000Z" });
  const jobA = creativeJobRow({ id: "job-a", opportunity_id: "opp-a", status: "completed" });
  const jobB = creativeJobRow({ id: "job-b", opportunity_id: "opp-b", status: "completed" });
  const packageA = creativePackageRow({ id: "pkg-a", creative_job_id: "job-a" });
  const packageB = creativePackageRow({ id: "pkg-b", creative_job_id: "job-b" });
  const client = makeClient({ opportunities: [a, b], jobs: [jobA, jobB], packages: [packageA, packageB] });

  const todaysPick = await selectTodaysReadyOpportunity(client);
  assert.equal(todaysPick.ok, true);
  if (todaysPick.ok) {
    assert.equal(todaysPick.ready?.opportunity.id, "opp-b");
  }
});

test("listReadyOpportunities: returns every ready candidate, newest-detected first", async () => {
  const older = opportunityRow({ id: "opp-older", status: "accepted", detected_at: "2026-07-23T01:00:00.000Z" });
  const newer = opportunityRow({ id: "opp-newer", status: "accepted", detected_at: "2026-07-24T01:00:00.000Z" });
  const olderJob = creativeJobRow({ id: "job-older", opportunity_id: "opp-older", status: "completed" });
  const newerJob = creativeJobRow({ id: "job-newer", opportunity_id: "opp-newer", status: "completed" });
  const olderPackage = creativePackageRow({ id: "pkg-older", creative_job_id: "job-older" });
  const newerPackage = creativePackageRow({ id: "pkg-newer", creative_job_id: "job-newer" });
  const client = makeClient({ opportunities: [older, newer], jobs: [olderJob, newerJob], packages: [olderPackage, newerPackage] });

  const result = await listReadyOpportunities(client);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(
      result.ready.map((entry) => entry.opportunity.id),
      ["opp-newer", "opp-older"],
    );
  }
});

test("listReadyOpportunities: returns an empty array, not null, when nothing is ready", async () => {
  const client = makeClient({ opportunities: [], jobs: [], packages: [] });
  const result = await listReadyOpportunities(client);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.ready, []);
  }
});

test("listReadyOpportunities: skips queued/failed jobs and package-less completed jobs, keeps only truly ready candidates", async () => {
  const readyOpp = opportunityRow({ id: "opp-ready", status: "accepted", detected_at: "2026-07-24T01:00:00.000Z" });
  const queuedOpp = opportunityRow({ id: "opp-queued", status: "accepted", detected_at: "2026-07-23T01:00:00.000Z" });
  const noPackageOpp = opportunityRow({ id: "opp-no-package", status: "accepted", detected_at: "2026-07-22T01:00:00.000Z" });

  const readyJob = creativeJobRow({ id: "job-ready", opportunity_id: "opp-ready", status: "completed" });
  const queuedJob = creativeJobRow({ id: "job-queued", opportunity_id: "opp-queued", status: "queued" });
  const noPackageJob = creativeJobRow({ id: "job-no-package", opportunity_id: "opp-no-package", status: "completed" });

  const readyPackage = creativePackageRow({ id: "pkg-ready", creative_job_id: "job-ready" });

  const client = makeClient({
    opportunities: [readyOpp, queuedOpp, noPackageOpp],
    jobs: [readyJob, queuedJob, noPackageJob],
    packages: [readyPackage],
  });

  const result = await listReadyOpportunities(client);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(
      result.ready.map((entry) => entry.opportunity.id),
      ["opp-ready"],
    );
  }
});

test("selectTodaysReadyOpportunity stays a behavior-preserving wrapper over listReadyOpportunities", async () => {
  const older = opportunityRow({ id: "opp-older", status: "accepted", detected_at: "2026-07-23T01:00:00.000Z" });
  const newer = opportunityRow({ id: "opp-newer", status: "accepted", detected_at: "2026-07-24T01:00:00.000Z" });
  const olderJob = creativeJobRow({ id: "job-older", opportunity_id: "opp-older", status: "completed" });
  const newerJob = creativeJobRow({ id: "job-newer", opportunity_id: "opp-newer", status: "completed" });
  const olderPackage = creativePackageRow({ id: "pkg-older", creative_job_id: "job-older" });
  const newerPackage = creativePackageRow({ id: "pkg-newer", creative_job_id: "job-newer" });
  const client = makeClient({ opportunities: [older, newer], jobs: [olderJob, newerJob], packages: [olderPackage, newerPackage] });

  const [listResult, wrapperResult] = await Promise.all([listReadyOpportunities(client), selectTodaysReadyOpportunity(client)]);
  assert.equal(listResult.ok, true);
  assert.equal(wrapperResult.ok, true);
  if (listResult.ok && wrapperResult.ok) {
    assert.equal(wrapperResult.ready?.opportunity.id, listResult.ready[0]?.opportunity.id);
  }
});
