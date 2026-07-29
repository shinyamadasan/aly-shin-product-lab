import test from "node:test";
import assert from "node:assert/strict";

import { persistOpportunityDrafts, type OpportunityPersistenceClient } from "../scripts/daily-advisor/opportunity-persistence.ts";
import { toOpportunityRow, type OpportunityDraft, type OpportunityRow } from "../src/lib/opportunities.ts";

type ErrorLike = { code?: string; message: string };

const fixedNow = "2026-07-24T02:00:00.000Z";

function draft(overrides: Partial<OpportunityDraft> = {}): OpportunityDraft {
  return {
    opportunityType: "product_marketing_content",
    producer: "daily_advisor",
    sourceType: "daily_advisor",
    sourceId: "daily_advisor:2026-07-24:product_marketing_content:brownies",
    title: "Create launch-ready product content for Brownies",
    summary: "Brownies is launch-ready.",
    reason: "The Rule Engine says all required marketing eligibility rules passed.",
    recommendedAction: "create_content",
    evidenceVersion: "v1",
    evidence: { product: { id: "brownies" }, version: 1 },
    sourceRuleIds: ["LAUNCH-001"],
    sourceFindings: [{ id: "LAUNCH-001", category: "launch", severity: "blocker", passed: true, message: "Required data complete.", recommendation: "No action needed." }],
    detectedAt: "2026-07-24T01:00:00.000Z",
    expiresAt: "2026-07-27T01:00:00.000Z",
    deduplicationKey: "v1|producer=daily_advisor|finding_type=product_marketing_content|entity:batch=batch-1|entity:costing=costing-1|entity:product=brownies|action=create_content|business_date=2026-07-10",
    ...overrides,
  };
}

function storedRow(draftInput = draft(), overrides: Partial<OpportunityRow> = {}): OpportunityRow {
  return {
    ...toOpportunityRow(draftInput),
    id: "opportunity-1",
    created_at: "2026-07-24T01:01:00.000Z",
    updated_at: "2026-07-24T01:01:00.000Z",
    ...overrides,
  };
}

function makeClient(
  options: {
    rows?: OpportunityRow[];
    selectError?: ErrorLike;
    insertError?: ErrorLike;
    updateError?: ErrorLike;
    uniqueRaceRow?: OpportunityRow;
    beforeUpdate?: (rows: OpportunityRow[]) => void;
    forceEmptyUpdate?: boolean;
  } = {},
) {
  const rows = [...(options.rows ?? [])];
  let insertCalls = 0;
  let updateCalls = 0;
  let beforeUpdateCalled = false;

  const client: OpportunityPersistenceClient = {
    from(table) {
      assert.equal(table, "opportunities");
      return {
        select() {
          return {
            eq(column, value) {
              return {
                async maybeSingle() {
                  assert.equal(column, "deduplication_key");
                  if (options.selectError) {
                    return { data: null, error: options.selectError };
                  }
                  return { data: rows.find((row) => row.deduplication_key === value) ?? null, error: null };
                },
              };
            },
          };
        },
        insert(row) {
          return {
            select() {
              return {
                async single() {
                  insertCalls += 1;
                  if (options.uniqueRaceRow && insertCalls === 1) {
                    rows.push(options.uniqueRaceRow);
                    return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } };
                  }
                  if (options.insertError) {
                    return { data: null, error: options.insertError };
                  }
                  const inserted = { ...row, id: `opportunity-${rows.length + 1}`, created_at: fixedNow, updated_at: fixedNow };
                  rows.push(inserted);
                  return { data: inserted, error: null };
                },
              };
            },
          };
        },
        update(updateRow) {
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
                    options.beforeUpdate?.(rows);
                    beforeUpdateCalled = true;
                  }
                  if (options.updateError) {
                    return { data: null, error: options.updateError };
                  }
                  if (options.forceEmptyUpdate) {
                    return { data: null, error: null };
                  }
                  const index = rows.findIndex((row) => filters.every(({ column, value }) => row[column as keyof OpportunityRow] === value));
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
  };

  return { client, rows, get insertCalls() { return insertCalls; }, get updateCalls() { return updateCalls; } };
}

test("persistOpportunityDrafts inserts a new Opportunity", async () => {
  const store = makeClient();
  const result = await persistOpportunityDrafts(store.client, [draft()], { now: () => fixedNow });
  assert.equal(result.ok, true);
  assert.equal(result.inserted, 1);
  assert.equal(result.updated, 0);
  assert.equal(store.rows.length, 1);
  assert.equal(store.rows[0].status, "new");
});

test("persistOpportunityDrafts updates a retry while status is new and preserves detected_at", async () => {
  const original = storedRow();
  const retry = draft({ title: "Updated title", evidence: { product: { id: "brownies" }, version: 2 }, detectedAt: "2026-07-25T01:00:00.000Z" });
  const store = makeClient({ rows: [original] });
  const result = await persistOpportunityDrafts(store.client, [retry], { now: () => fixedNow });
  assert.equal(result.ok, true);
  assert.equal(result.updated, 1);
  assert.equal(store.rows[0].title, "Updated title");
  assert.deepEqual(store.rows[0].evidence, { product: { id: "brownies" }, version: 2 });
  assert.equal(store.rows[0].detected_at, "2026-07-24T01:00:00.000Z");
  assert.equal(store.rows[0].updated_at, fixedNow);
});

test("persistOpportunityDrafts skips terminal records without overwriting evidence", async () => {
  for (const status of ["accepted", "dismissed", "expired", "converted"] as const) {
    const existing = storedRow(draft(), { id: `opportunity-${status}`, status, evidence: { terminal: true } });
    const store = makeClient({ rows: [existing] });
    const result = await persistOpportunityDrafts(store.client, [draft({ evidence: { terminal: false } })], { now: () => fixedNow });
    assert.equal(result.ok, true);
    assert.equal(result.skipped, 1);
    assert.equal(store.updateCalls, 0);
    assert.deepEqual(store.rows[0].evidence, { terminal: true });
  }
});

for (const status of ["accepted", "converted"] as const) {
  test(`persistOpportunityDrafts skips when a new row becomes ${status} before the conditional update`, async () => {
    const original = storedRow(draft(), { status: "new", evidence: { terminal: false } });
    const store = makeClient({
      rows: [original],
      beforeUpdate(rows) {
        rows[0] = { ...rows[0], status, evidence: { terminal: true, status } };
      },
    });
    const result = await persistOpportunityDrafts(store.client, [draft({ evidence: { retry: true } })], { now: () => fixedNow });
    assert.equal(result.ok, true);
    assert.equal(result.skipped, 1);
    assert.equal(result.details[0].reason, `existing-${status}`);
    assert.equal(store.updateCalls, 1);
    assert.equal(store.rows[0].status, status);
    assert.deepEqual(store.rows[0].evidence, { terminal: true, status });
  });
}

test("persistOpportunityDrafts reports a conflict when the conditional update affects zero rows and reread is still new", async () => {
  const original = storedRow();
  const store = makeClient({ rows: [original], forceEmptyUpdate: true });
  const result = await persistOpportunityDrafts(store.client, [draft({ evidence: { retry: true } })], { now: () => fixedNow });
  assert.equal(result.ok, false);
  assert.equal(result.failed, 1);
  assert.equal(result.details[0].reason, "conditional-update-conflict-still-new");
  assert.deepEqual(store.rows[0].evidence, { product: { id: "brownies" }, version: 1 });
});

test("persistOpportunityDrafts handles an insert unique race by re-reading and updating one row", async () => {
  const racedRow = storedRow(draft(), { id: "raced-opportunity", evidence: { raced: true } });
  const store = makeClient({ uniqueRaceRow: racedRow });
  const result = await persistOpportunityDrafts(store.client, [draft({ evidence: { retry: true } })], { now: () => fixedNow });
  assert.equal(result.ok, true);
  assert.equal(result.inserted, 0);
  assert.equal(result.updated, 1);
  assert.equal(store.rows.length, 1);
  assert.deepEqual(store.rows[0].evidence, { retry: true });
});

test("persistOpportunityDrafts reports a missing opportunities table as a non-throwing failure", async () => {
  const store = makeClient({ selectError: { code: "PGRST205", message: "Could not find the table 'opportunities' in the schema cache" } });
  const result = await persistOpportunityDrafts(store.client, [draft()], { now: () => fixedNow });
  assert.equal(result.ok, false);
  assert.equal(result.failed, 1);
  assert.equal(result.details[0].reason, "missing-table");
});

test("persistOpportunityDrafts reports a generic write failure without throwing", async () => {
  const store = makeClient({ insertError: { message: "network timeout" } });
  const result = await persistOpportunityDrafts(store.client, [draft()], { now: () => fixedNow });
  assert.equal(result.ok, false);
  assert.equal(result.failed, 1);
  assert.match(result.details[0].reason ?? "", /insert failed: network timeout/);
});
