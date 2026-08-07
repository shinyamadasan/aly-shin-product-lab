import test from "node:test";
import assert from "node:assert/strict";

import { resolveTodayScreenState, type TodayScreenStateClient } from "../src/lib/today-screen-state.ts";
import { toOpportunityRow, type OpportunityDraft, type OpportunityRow } from "../src/lib/opportunities.ts";
import type { CreativeJobRow } from "../src/lib/creative-jobs.ts";
import type { CreativePackageRow } from "../src/lib/creative-packages.ts";
import type { AssetJobRow } from "../src/lib/asset-jobs.ts";

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
    worker_type: "opportunity_brief",
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
      metadata: { generatedFromOpportunity: "opportunity-1", generatorVersion: "1", sourceCreativeJobId: "job-1", sourceWorker: "opportunity_brief", sourceJobResultSchemaVersion: "v1" },
      artifacts: [],
    },
    created_at: "2026-07-24T01:16:00.000Z",
    updated_at: "2026-07-24T01:16:00.000Z",
    ...overrides,
  };
}

function assetJobRow(overrides: Partial<AssetJobRow> = {}): AssetJobRow {
  return {
    id: "asset-job-1",
    creative_package_id: "package-1",
    status: "queued",
    worker_type: "external",
    asset_kind: "image",
    attempt_count: 0,
    result: {},
    last_error: null,
    created_at: "2026-07-24T02:00:00.000Z",
    updated_at: "2026-07-24T02:00:00.000Z",
    started_at: null,
    completed_at: null,
    failed_at: null,
    ...overrides,
  };
}

function makeClient(
  options: { opportunities?: OpportunityRow[]; jobs?: CreativeJobRow[]; packages?: CreativePackageRow[]; assetJobs?: AssetJobRow[] } = {},
): TodayScreenStateClient {
  const opportunities = [...(options.opportunities ?? [])];
  const jobs = [...(options.jobs ?? [])];
  const packages = [...(options.packages ?? [])];
  const assetJobs = [...(options.assetJobs ?? [])];

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

  function orderedListTable<T extends Record<string, unknown>>(rows: T[]) {
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
          then(resolve: (value: { data: T[] | null; error: ErrorLike | null }) => unknown, reject?: (reason: unknown) => unknown) {
            const data = rows
              .filter((item) => matches(item, filters))
              .sort((a, b) => {
                for (const order of orders) {
                  const left = String(a[order.column] ?? "");
                  const right = String(b[order.column] ?? "");
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

  return {
    from(table: string) {
      if (table === "opportunities") {
        return orderedListTable(opportunities);
      }
      if (table === "creative_jobs") {
        return singleRowTable(jobs);
      }
      if (table === "creative_packages") {
        return singleRowTable(packages);
      }
      if (table === "asset_jobs") {
        return orderedListTable(assetJobs);
      }
      throw new Error(`Unexpected table in test client: ${table}`);
    },
  } as unknown as TodayScreenStateClient;
}

test("resolveTodayScreenState: fresh -- a ready candidate with no Asset Job yet", async () => {
  const opp = opportunityRow({ id: "opp-1", status: "accepted" });
  const job = creativeJobRow({ id: "job-1", opportunity_id: "opp-1", status: "completed" });
  const pkg = creativePackageRow({ id: "pkg-1", creative_job_id: "job-1" });
  const client = makeClient({ opportunities: [opp], jobs: [job], packages: [pkg], assetJobs: [] });

  const result = await resolveTodayScreenState(client);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.state.kind, "fresh");
    if (result.state.kind === "fresh") {
      assert.equal(result.state.candidate.opportunity.id, "opp-1");
    }
  }
});

test("resolveTodayScreenState: continue -- a ready candidate with a queued external Asset Job", async () => {
  const opp = opportunityRow({ id: "opp-1", status: "accepted" });
  const job = creativeJobRow({ id: "job-1", opportunity_id: "opp-1", status: "completed" });
  const pkg = creativePackageRow({ id: "pkg-1", creative_job_id: "job-1" });
  const queuedAssetJob = assetJobRow({ id: "aj-1", creative_package_id: "pkg-1", status: "queued", worker_type: "external" });
  const client = makeClient({ opportunities: [opp], jobs: [job], packages: [pkg], assetJobs: [queuedAssetJob] });

  const result = await resolveTodayScreenState(client);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.state.kind, "continue");
    if (result.state.kind === "continue") {
      assert.equal(result.state.assetJob.id, "aj-1");
    }
  }
});

test("resolveTodayScreenState: completed-today -- a ready candidate with a completed Asset Job", async () => {
  const opp = opportunityRow({ id: "opp-1", status: "accepted" });
  const job = creativeJobRow({ id: "job-1", opportunity_id: "opp-1", status: "completed" });
  const pkg = creativePackageRow({ id: "pkg-1", creative_job_id: "job-1" });
  const completedAssetJob = assetJobRow({ id: "aj-1", creative_package_id: "pkg-1", status: "completed", worker_type: "external" });
  const client = makeClient({ opportunities: [opp], jobs: [job], packages: [pkg], assetJobs: [completedAssetJob] });

  const result = await resolveTodayScreenState(client);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.state.kind, "completed-today");
    if (result.state.kind === "completed-today") {
      assert.equal(result.state.assetJob.id, "aj-1");
    }
  }
});

test("resolveTodayScreenState: empty -- nothing new or accepted exists at all", async () => {
  const client = makeClient({ opportunities: [], jobs: [], packages: [], assetJobs: [] });
  const result = await resolveTodayScreenState(client);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.state.kind, "empty");
  }
});

test("resolveTodayScreenState: prep-not-ready -- an accepted Opportunity exists but has no ready package yet", async () => {
  const opp = opportunityRow({ id: "opp-1", status: "accepted" });
  const client = makeClient({ opportunities: [opp], jobs: [], packages: [], assetJobs: [] });

  const result = await resolveTodayScreenState(client);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.state.kind, "prep-not-ready");
  }
});

test("resolveTodayScreenState: prep-not-ready -- a brand-new, not-yet-accepted Opportunity exists", async () => {
  const opp = opportunityRow({ id: "opp-1", status: "new" });
  const client = makeClient({ opportunities: [opp], jobs: [], packages: [], assetJobs: [] });

  const result = await resolveTodayScreenState(client);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.state.kind, "prep-not-ready");
  }
});

test("resolveTodayScreenState: exhausted -- the only ready candidate was excluded via Not today", async () => {
  const opp = opportunityRow({ id: "opp-1", status: "accepted" });
  const job = creativeJobRow({ id: "job-1", opportunity_id: "opp-1", status: "completed" });
  const pkg = creativePackageRow({ id: "pkg-1", creative_job_id: "job-1" });
  const client = makeClient({ opportunities: [opp], jobs: [job], packages: [pkg], assetJobs: [] });

  const result = await resolveTodayScreenState(client, { excludeOpportunityIds: ["opp-1"] });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.state.kind, "exhausted");
  }
});

test("resolveTodayScreenState: excluding one of several ready candidates falls through to the next as fresh, without a second selector call", async () => {
  const older = opportunityRow({ id: "opp-older", status: "accepted", detected_at: "2026-07-23T01:00:00.000Z" });
  const newer = opportunityRow({ id: "opp-newer", status: "accepted", detected_at: "2026-07-24T01:00:00.000Z" });
  const olderJob = creativeJobRow({ id: "job-older", opportunity_id: "opp-older", status: "completed" });
  const newerJob = creativeJobRow({ id: "job-newer", opportunity_id: "opp-newer", status: "completed" });
  const olderPackage = creativePackageRow({ id: "pkg-older", creative_job_id: "job-older" });
  const newerPackage = creativePackageRow({ id: "pkg-newer", creative_job_id: "job-newer" });
  const client = makeClient({ opportunities: [older, newer], jobs: [olderJob, newerJob], packages: [olderPackage, newerPackage], assetJobs: [] });

  const result = await resolveTodayScreenState(client, { excludeOpportunityIds: ["opp-newer"] });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.state.kind, "fresh");
    if (result.state.kind === "fresh") {
      assert.equal(result.state.candidate.opportunity.id, "opp-older");
    }
  }
});

test("resolveTodayScreenState never calls selectPreparationCandidate's table shape in a way that would require it -- new+accepted existence check only", async () => {
  // Regression guard for the documented architecture boundary: a "new" Opportunity that would be
  // selectPreparationCandidate's pick must still resolve through plain listOpportunities existence
  // checks, not through that selection algorithm. If this state is anything other than
  // "prep-not-ready", the existence-check approach has been replaced with something else.
  const newOpp = opportunityRow({ id: "opp-new", status: "new", detected_at: "2026-07-24T01:00:00.000Z" });
  const staleAcceptedOpp = opportunityRow({ id: "opp-accepted", status: "accepted", detected_at: "2026-07-20T01:00:00.000Z" });
  const client = makeClient({ opportunities: [newOpp, staleAcceptedOpp], jobs: [], packages: [], assetJobs: [] });

  const result = await resolveTodayScreenState(client);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.state.kind, "prep-not-ready");
  }
});
