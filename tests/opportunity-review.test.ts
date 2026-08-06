import test from "node:test";
import assert from "node:assert/strict";

import {
  buildOpportunityEvidenceSections,
  buildOpportunityListQuery,
  formatOpportunityRawJson,
  fromOpportunityListRow,
  getOpportunityActionAvailability,
  getOpportunityDetail,
  isOpportunityExpiredByTime,
  listOpportunities,
  OPPORTUNITY_LIST_COLUMNS,
  OPPORTUNITY_LIST_ORDER,
  resolveOpportunityStatusFilter,
  selectPreparationCandidate,
  updateOpportunityStatus,
  type OpportunityReviewClient,
} from "../src/lib/opportunity-review.ts";
import { toOpportunityRow, type OpportunityDraft, type OpportunityRow, type OpportunityStatus } from "../src/lib/opportunities.ts";

type ErrorLike = { code?: string; message: string };

const detectedAt = "2026-07-24T01:00:00.000Z";
const unexpiredAt = "2026-07-27T01:00:00.000Z";
const expiredAt = "2026-07-24T02:00:00.000Z";
const laterNow = "2026-07-24T03:00:00.000Z";

function draft(overrides: Partial<OpportunityDraft> = {}): OpportunityDraft {
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
    evidence: {
      briefing: { date: "2026-07-24", timezone: "Asia/Manila", dataSource: "supabase", markdownPath: "daily-advisor/output/2026-07-24.md" },
      producer: { name: "daily_advisor", version: "v1" },
      product: { id: "brownies", name: "Brownies", category: "Bakery", role: "hero", status: "active", decision: "launch" },
      latestBatch: { id: "batch-1", batchVersion: "V3", dateMade: "2026-07-24", usablePieces: 24, imperfectPieces: 2, launchDecision: "launch" },
      linkedCosting: { id: "costing-1", batchId: "batch-1", suggestedPrice: 120 },
      costingMetrics: { marginPercent: 62 },
      tastingSignal: { productTastingCount: 5, productAverageRating: 8.4, latestBatchTastingCount: 2 },
      ruleEngine: { productHealth: "good", readinessPercentage: 100, noActiveBlockersOrWarnings: true },
      qualifyingRuleResults: [
        { id: "RULE-001", category: "launch", severity: "blocker", passed: true, message: "Core proof exists.", recommendation: "Create a content brief." },
      ],
    },
    sourceRuleIds: ["RULE-001"],
    sourceFindings: [
      { id: "RULE-001", category: "launch", severity: "blocker", passed: true, message: "Core proof exists.", recommendation: "Create a content brief." },
    ],
    detectedAt,
    expiresAt: unexpiredAt,
    deduplicationKey: "v1|producer=daily_advisor|finding_type=product_marketing_content|entity:batch=batch-1|entity:costing=costing-1|entity:product=brownies|action=create_content|business_date=2026-07-24",
    ...overrides,
  };
}

function row(overrides: Partial<OpportunityRow> = {}): OpportunityRow {
  return {
    ...toOpportunityRow(draft()),
    id: overrides.id ?? "opportunity-1",
    created_at: overrides.created_at ?? "2026-07-24T01:05:00.000Z",
    updated_at: overrides.updated_at ?? "2026-07-24T01:05:00.000Z",
    ...overrides,
  };
}

function makeClient(
  options: {
    rows?: OpportunityRow[];
    selectError?: ErrorLike;
    updateError?: ErrorLike;
    beforeConditionalUpdate?: (rows: OpportunityRow[]) => void;
  } = {},
) {
  const rows = [...(options.rows ?? [])];
  let updateCalls = 0;
  let beforeUpdateCalled = false;

  function matches(rowInput: OpportunityRow, filters: Array<{ column: string; value: string }>): boolean {
    return filters.every(({ column, value }) => rowInput[column as keyof OpportunityRow] === value);
  }

  const client = {
    from(table: string) {
      assert.equal(table, "opportunities");
      return {
        select() {
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
            order(column: string, optionsInput: { ascending: boolean }) {
              orders.push({ column, ascending: optionsInput.ascending });
              return builder;
            },
            async maybeSingle() {
              if (options.selectError) {
                return { data: null, error: options.selectError };
              }
              return { data: rows.find((item) => matches(item, filters)) ?? null, error: null };
            },
            then(resolve: (value: { data: OpportunityRow[] | null; error: ErrorLike | null }) => unknown, reject?: (reason: unknown) => unknown) {
              if (options.selectError) {
                return Promise.resolve({ data: null, error: options.selectError }).then(resolve, reject);
              }
              const data = rows
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
                })
                .slice(0, limitCount ?? undefined);
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
                  updateCalls += 1;
                  if (!beforeUpdateCalled) {
                    beforeUpdateCalled = true;
                    options.beforeConditionalUpdate?.(rows);
                  }
                  if (options.updateError) {
                    return { data: null, error: options.updateError };
                  }
                  const index = rows.findIndex((item) => matches(item, filters));
                  if (index === -1) {
                    return { data: null, error: null };
                  }
                  rows[index] = { ...rows[index], ...updateRow };
                  return { data: rows[index], error: null };
                },
              };
            },
          };
          return builder;
        },
      };
    },
  } as unknown as OpportunityReviewClient;

  return { client, rows, get updateCalls() { return updateCalls; } };
}

test("resolveOpportunityStatusFilter defaults missing and invalid filters to new", () => {
  assert.equal(resolveOpportunityStatusFilter(undefined), "new");
  assert.equal(resolveOpportunityStatusFilter("bad-status"), "new");
  assert.equal(resolveOpportunityStatusFilter(["dismissed", "accepted"]), "dismissed");
  assert.equal(resolveOpportunityStatusFilter("all"), "all");
});

test("buildOpportunityListQuery maps filters and orders by newest detected Opportunity", () => {
  assert.equal(buildOpportunityListQuery("new").columns, OPPORTUNITY_LIST_COLUMNS);
  assert.equal(buildOpportunityListQuery("new").status, "new");
  assert.equal(buildOpportunityListQuery("all").status, null);
  assert.deepEqual(buildOpportunityListQuery("accepted").order, OPPORTUNITY_LIST_ORDER);
  assert.match(OPPORTUNITY_LIST_COLUMNS, /producer/);
  assert.doesNotMatch(OPPORTUNITY_LIST_COLUMNS, /priority/);
});

test("listOpportunities applies status filtering and maps list rows", async () => {
  const older = row({ id: "older", status: "new", detected_at: "2026-07-23T01:00:00.000Z", created_at: "2026-07-23T01:05:00.000Z", title: "Older" });
  const newer = row({ id: "newer", status: "new", detected_at: "2026-07-24T01:00:00.000Z", created_at: "2026-07-24T01:05:00.000Z", title: "Newer" });
  const accepted = row({ id: "accepted", status: "accepted", title: "Accepted" });
  const { client } = makeClient({ rows: [older, accepted, newer] });

  const result = await listOpportunities(client, "new");
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.opportunities.map((item) => item.id), ["newer", "older"]);
    assert.equal(result.opportunities[0].producer, "daily_advisor");
    assert.equal(result.opportunities[0].recommendedAction, "create_content");
  }
});

test("fromOpportunityListRow preserves source and timing fields for the list", () => {
  const listRow = row({ summary: null });
  const record = fromOpportunityListRow(listRow as Required<OpportunityRow>);
  assert.equal(record.sourceType, "daily_advisor");
  assert.equal(record.sourceId, "daily_advisor:2026-07-24:product_marketing_content:brownies");
  assert.equal(record.summary, "");
  assert.equal(record.detectedAt, detectedAt);
  assert.equal(record.expiresAt, unexpiredAt);
});

test("expired-by-time presentation is derived without mutating status", () => {
  const expiredNew = { status: "new" as const, expiresAt: expiredAt };
  const activeNew = { status: "new" as const, expiresAt: unexpiredAt };
  const terminalExpired = { status: "accepted" as const, expiresAt: expiredAt };

  assert.equal(isOpportunityExpiredByTime(expiredNew, laterNow), true);
  assert.equal(isOpportunityExpiredByTime(activeNew, laterNow), false);
  assert.equal(isOpportunityExpiredByTime(terminalExpired, laterNow), false);

  const actions = getOpportunityActionAvailability(expiredNew, laterNow);
  assert.equal(actions.canAccept, true);
  assert.equal(actions.canDismiss, true);
  assert.equal(actions.canMarkExpired, true);
});

test("terminal Opportunities are read-only in action availability", () => {
  for (const status of ["accepted", "dismissed", "expired", "converted"] as OpportunityStatus[]) {
    const actions = getOpportunityActionAvailability({ status, expiresAt: expiredAt }, laterNow);
    assert.equal(actions.readOnly, true);
    assert.equal(actions.canAccept, false);
    assert.equal(actions.canDismiss, false);
    assert.equal(actions.canMarkExpired, false);
  }
});

test("buildOpportunityEvidenceSections renders readable business evidence and copied findings", () => {
  const record = draft();
  const sections = buildOpportunityEvidenceSections(record.evidence, record.sourceFindings);
  const titles = sections.map((section) => section.title);
  assert.deepEqual(titles.slice(0, 4), ["Briefing or source artifact", "Producer", "Product", "Latest batch"]);
  assert.ok(sections.some((section) => section.rows.some((item) => item.value.includes("Brownies"))));
  assert.ok(sections.some((section) => section.lines?.some((line) => line.includes("RULE-001 (passed): Core proof exists."))));
});

test("buildOpportunityEvidenceSections falls back safely for unknown evidence shapes", () => {
  const sections = buildOpportunityEvidenceSections({ custom_signal: "Keep this copied value" });
  assert.equal(sections[0].title, "Evidence snapshot");
  assert.deepEqual(sections[0].rows, [{ label: "Custom signal", value: "Keep this copied value" }]);
  assert.match(formatOpportunityRawJson({ custom_signal: "Keep this copied value" }), /custom_signal/);
});

test("getOpportunityDetail returns a mapped Opportunity record", async () => {
  const { client } = makeClient({ rows: [row()] });
  const result = await getOpportunityDetail(client, "opportunity-1");
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.opportunity.id, "opportunity-1");
    assert.equal(result.opportunity.evidenceVersion, "v1");
    assert.equal(result.opportunity.status, "new");
  }
});

for (const target of ["accepted", "dismissed"] as const) {
  test(`updateOpportunityStatus supports new to ${target}`, async () => {
    const store = makeClient({ rows: [row()] });
    const result = await updateOpportunityStatus(store.client, "opportunity-1", target, { now: () => laterNow });
    assert.equal(result.ok, true);
    assert.equal(store.updateCalls, 1);
    if (result.ok) {
      assert.equal(result.opportunity.status, target);
      assert.equal(result.opportunity.updatedAt, laterNow);
    }
  });
}

test("updateOpportunityStatus supports manually expiring a time-expired new Opportunity", async () => {
  const store = makeClient({ rows: [row({ expires_at: expiredAt })] });
  const result = await updateOpportunityStatus(store.client, "opportunity-1", "expired", { now: () => laterNow });
  assert.equal(result.ok, true);
  assert.equal(store.updateCalls, 1);
  if (result.ok) {
    assert.equal(result.opportunity.status, "expired");
  }
});

test("updateOpportunityStatus rejects marking an unexpired Opportunity expired", async () => {
  const store = makeClient({ rows: [row()] });
  const result = await updateOpportunityStatus(store.client, "opportunity-1", "expired", { now: () => detectedAt });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid-transition");
  assert.equal(store.updateCalls, 0);
});

test("updateOpportunityStatus hides terminal mutations before issuing a database update", async () => {
  const store = makeClient({ rows: [row({ status: "accepted", evidence: { terminal: true } })] });
  const result = await updateOpportunityStatus(store.client, "opportunity-1", "dismissed", { now: () => laterNow });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid-transition");
  assert.equal(result.currentStatus, "accepted");
  assert.equal(store.updateCalls, 0);
  assert.deepEqual(store.rows[0].evidence, { terminal: true });
});

test("updateOpportunityStatus reports an honest conflict if the row becomes terminal during the conditional update", async () => {
  const store = makeClient({
    rows: [row({ evidence: { original: true } })],
    beforeConditionalUpdate(rows) {
      rows[0] = { ...rows[0], status: "accepted", evidence: { terminal: true }, updated_at: "2026-07-24T02:30:00.000Z" };
    },
  });
  const result = await updateOpportunityStatus(store.client, "opportunity-1", "dismissed", { now: () => laterNow });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "conflict");
  assert.equal(result.currentStatus, "accepted");
  assert.equal(store.updateCalls, 1);
  assert.deepEqual(store.rows[0].evidence, { terminal: true });
});

test("updateOpportunityStatus reports failed Supabase updates without claiming success", async () => {
  const store = makeClient({ rows: [row()], updateError: { message: "network timeout" } });
  const result = await updateOpportunityStatus(store.client, "opportunity-1", "accepted", { now: () => laterNow });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "failed");
  assert.match(result.message, /network timeout/);
});

test("updateOpportunityStatus reports not-found Opportunities", async () => {
  const store = makeClient();
  const result = await updateOpportunityStatus(store.client, "missing", "accepted", { now: () => laterNow });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "not-found");
  assert.equal(store.updateCalls, 0);
});

test("selectPreparationCandidate: newest new beats an older accepted Opportunity", async () => {
  const olderAccepted = row({ id: "older-accepted", status: "accepted", detected_at: "2026-07-23T01:00:00.000Z", created_at: "2026-07-23T01:05:00.000Z" });
  const newerNew = row({ id: "newer-new", status: "new", detected_at: "2026-07-24T01:00:00.000Z", created_at: "2026-07-24T01:05:00.000Z" });
  const { client } = makeClient({ rows: [olderAccepted, newerNew] });

  const result = await selectPreparationCandidate(client);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.opportunity?.id, "newer-new");
  }
});

test("selectPreparationCandidate: newer accepted beats an older new Opportunity", async () => {
  const newerAccepted = row({ id: "newer-accepted", status: "accepted", detected_at: "2026-07-24T01:00:00.000Z", created_at: "2026-07-24T01:05:00.000Z" });
  const olderNew = row({ id: "older-new", status: "new", detected_at: "2026-07-23T01:00:00.000Z", created_at: "2026-07-23T01:05:00.000Z" });
  const { client } = makeClient({ rows: [newerAccepted, olderNew] });

  const result = await selectPreparationCandidate(client);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.opportunity?.id, "newer-accepted");
  }
});

test("selectPreparationCandidate: dismissed, expired, and converted Opportunities are never eligible, regardless of recency", async () => {
  const veryRecentDismissed = row({ id: "recent-dismissed", status: "dismissed", detected_at: "2026-07-25T01:00:00.000Z", created_at: "2026-07-25T01:05:00.000Z" });
  const veryRecentExpired = row({ id: "recent-expired", status: "expired", detected_at: "2026-07-25T02:00:00.000Z", created_at: "2026-07-25T02:05:00.000Z" });
  const veryRecentConverted = row({ id: "recent-converted", status: "converted", detected_at: "2026-07-25T03:00:00.000Z", created_at: "2026-07-25T03:05:00.000Z" });
  const olderEligible = row({ id: "older-eligible", status: "new", detected_at: "2026-07-23T01:00:00.000Z", created_at: "2026-07-23T01:05:00.000Z" });
  const { client } = makeClient({ rows: [veryRecentDismissed, veryRecentExpired, veryRecentConverted, olderEligible] });

  const result = await selectPreparationCandidate(client);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.opportunity?.id, "older-eligible");
  }
});

test("selectPreparationCandidate: an Opportunity remains selected after new -> accepted when nothing newer is eligible", async () => {
  const alreadyAdvanced = row({ id: "already-advanced", status: "accepted", detected_at: "2026-07-24T01:00:00.000Z", created_at: "2026-07-24T01:05:00.000Z" });
  const { client } = makeClient({ rows: [alreadyAdvanced] });

  const result = await selectPreparationCandidate(client);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.opportunity?.id, "already-advanced");
  }
});

test("selectPreparationCandidate: returns null when no new or accepted Opportunity exists", async () => {
  const onlyDismissed = row({ id: "only-dismissed", status: "dismissed" });
  const { client } = makeClient({ rows: [onlyDismissed] });

  const result = await selectPreparationCandidate(client);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.opportunity, null);
  }
});
