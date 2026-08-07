import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCostingDomainContext,
  buildCostingDomainContextFromFailure,
  type CostingRows,
  type CostingSnapshot,
} from "../src/lib/business-context/adapters/costing.ts";
import { COSTING_UPDATED_AT_RELIABLE_FROM } from "../src/lib/business-context/types.ts";
import type { DomainAdapter, Fact } from "../src/lib/business-context/types.ts";
import type { CostingSummaryRow } from "../src/lib/supabase-mappers.ts";

const AFTER_BOUNDARY = "2026-08-08T00:00:00.000Z";
const BEFORE_BOUNDARY = "2026-08-01T00:00:00.000Z";

function costingRow(overrides: Partial<CostingSummaryRow> = {}): CostingSummaryRow {
  return {
    id: "costing-1",
    product_id: "brownies",
    batch_id: "batch-1",
    ingredient_cost: 200,
    packaging_cost: 20,
    labor_estimate: 100,
    utilities_estimate: 25,
    water_cost: 5,
    gas_cost: 10,
    oven_electric_cost: 8,
    refrigeration_cost: 2,
    coffee_equipment_cost: 0,
    waste_allowance: 15,
    overhead_cost: 30,
    equipment_cost: 10,
    suggested_price: 50,
    notes: "Costing yield: 8",
    created_at: "2026-08-02T00:00:00.000Z",
    updated_at: AFTER_BOUNDARY,
    ...overrides,
  };
}

function rows(overrides: Partial<CostingRows> = {}): CostingRows {
  return { costings: [costingRow()], entries: [], ...overrides };
}

function snapshots(context: ReturnType<typeof buildCostingDomainContext>): CostingSnapshot[] {
  const fact = context.facts.byCosting as Fact<CostingSnapshot[]>;
  assert.equal(fact.state, "known");
  return (fact as { state: "known"; value: CostingSnapshot[] }).value;
}

test("costing adapter: derived metrics come from getCostingTotals and record it as computedBy", () => {
  const [snapshot] = snapshots(buildCostingDomainContext(rows()));

  assert.equal(snapshot.costPerPiece.state, "known");
  // direct 360 (200 + 20 + 100 + 25 utilities + 15 waste) + indirect 40 (30 + 10) = 400, over yield 8.
  assert.equal((snapshot.totalBatchCost as { value: number }).value, 400);
  assert.equal((snapshot.costPerPiece as { value: number }).value, 400 / 8);
  assert.equal(snapshot.costPerPiece.state === "known" && snapshot.costPerPiece.source.computedBy, "getCostingTotals");
});

test("costing adapter: a real 0 cost component is known(0), never unset", () => {
  // Every cost component is `not null default 0` in SQL, so 0 here is genuinely entered.
  const [snapshot] = snapshots(buildCostingDomainContext(rows({ costings: [costingRow({ refrigeration_cost: 0 })] })));
  assert.deepEqual(
    { state: snapshot.refrigerationCost.state, value: (snapshot.refrigerationCost as { value: number }).value },
    { state: "known", value: 0 },
  );
});

test("costing adapter: a null suggested_price is unset, and a real 0 is known(0)", () => {
  const [unpriced] = snapshots(buildCostingDomainContext(rows({ costings: [costingRow({ suggested_price: null })] })));
  assert.equal(unpriced.suggestedPrice.state, "unset");

  const [free] = snapshots(buildCostingDomainContext(rows({ costings: [costingRow({ suggested_price: 0 })] })));
  assert.equal(free.suggestedPrice.state, "known");
  assert.equal((free.suggestedPrice as { value: number }).value, 0);
});

test("costing adapter: an unreadable yield makes every per-piece metric unknown, never 0", () => {
  const [snapshot] = snapshots(buildCostingDomainContext(rows({ costings: [costingRow({ notes: "no yield line here" })] })));

  assert.equal(snapshot.costingYield.state, "unknown");
  for (const key of ["costPerPiece", "grossProfit", "margin", "foodCostPercent", "markup", "breakEvenUnits"] as const) {
    assert.equal(snapshot[key].state, "unknown", `${key} must be unknown when yield is unreadable`);
    assert.ok((snapshot[key] as { because: string }).because.length > 0, `${key} must say why`);
  }
  // Not yield-dependent -- the sum of entered components is always computable.
  assert.equal(snapshot.totalBatchCost.state, "known");
});

test("costing adapter: a malformed yield line is treated as unreadable, not as zero", () => {
  const [snapshot] = snapshots(buildCostingDomainContext(rows({ costings: [costingRow({ notes: "Costing yield: abc" })] })));
  assert.equal(snapshot.costingYield.state, "unknown");
});

test("costing adapter: yield and target food cost are inferred with a basis and never high confidence", () => {
  const [snapshot] = snapshots(
    buildCostingDomainContext(rows({ costings: [costingRow({ notes: 'Costing yield: 8\nProfessional costing detail: {"targetFoodCost":0.3}' })] })),
  );

  for (const fact of [snapshot.costingYield, snapshot.targetFoodCost]) {
    assert.equal(fact.state, "known");
    const known = fact as { source: { kind: string; basis?: string }; confidence?: string };
    assert.equal(known.source.kind, "inferred");
    assert.ok(known.source.basis && known.source.basis.length > 0, "inferred facts must carry a basis");
    assert.notEqual(known.confidence, "high", "inferred evidence can never be high confidence");
  }
});

test("costing adapter: reviewedAt is known at or after the reliability boundary", () => {
  const atBoundary = snapshots(buildCostingDomainContext(rows({ costings: [costingRow({ updated_at: COSTING_UPDATED_AT_RELIABLE_FROM })] })));
  assert.equal(atBoundary[0].reviewedAt.state, "known", "the boundary itself counts as reliable");

  const after = snapshots(buildCostingDomainContext(rows({ costings: [costingRow({ updated_at: AFTER_BOUNDARY })] })));
  assert.equal(after[0].reviewedAt.state, "known");
  assert.equal((after[0].reviewedAt as { value: string }).value, AFTER_BOUNDARY);
});

test("costing adapter: reviewedAt is unknown before the boundary, and never substitutes created_at", () => {
  const [snapshot] = snapshots(
    buildCostingDomainContext(rows({ costings: [costingRow({ updated_at: BEFORE_BOUNDARY, created_at: BEFORE_BOUNDARY })] })),
  );

  assert.equal(snapshot.reviewedAt.state, "unknown");
  const unknown = snapshot.reviewedAt as { because: string };
  assert.match(unknown.because, /were not maintained before/);
  // The rejected shortcut: created_at answers a different question and must not appear as a review time.
  assert.doesNotMatch(JSON.stringify(snapshot.reviewedAt), new RegExp(BEFORE_BOUNDARY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + '"\\s*,\\s*"source"'));
  assert.ok(!("value" in snapshot.reviewedAt), "an unknown reviewedAt must carry no value at all");
});

test("costing adapter: raw notes never appear in any fact", () => {
  const secret = "Professional costing detail: {\"targetFoodCost\":0.3,\"internal\":\"do-not-ship\"}";
  const context = buildCostingDomainContext(rows({ costings: [costingRow({ notes: `Costing yield: 8\n${secret}` })] }));
  assert.doesNotMatch(JSON.stringify(context), /do-not-ship/);
});

test("costing adapter: zero rows with a healthy read is empty, not unavailable", () => {
  const context = buildCostingDomainContext(rows({ costings: [] }));
  assert.equal(context.facts.byCosting.state, "empty");
  assert.equal(context.sourceAsOf.state, "empty");
  assert.deepEqual(context.readOutcome, { ok: true });
});

test("costing adapter: a failed read is unavailable; a missing table is not_configured", () => {
  const failed = buildCostingDomainContextFromFailure({ ok: false, reason: "failed", message: "boom" });
  assert.equal(failed.facts.byCosting.state, "unavailable");

  const missing = buildCostingDomainContextFromFailure({ ok: false, reason: "missing-table", message: "no table" });
  assert.equal(missing.facts.byCosting.state, "not_configured");
});

test("costing adapter: publishes no signals -- the freshness comparison is cross-domain", () => {
  // costing.staleVsPurchases needs Inventory's purchase history, so it belongs to a composer.
  const context = buildCostingDomainContext(rows());
  assert.deepEqual(context.signals, []);
  assert.doesNotMatch(JSON.stringify(context), /staleVsPurchases/);
});

test("costing adapter: is pure -- the same rows produce identical output", () => {
  const input = rows();
  assert.deepEqual(buildCostingDomainContext(input), buildCostingDomainContext(input));
});

test("costing adapter: sourceAsOf is the latest created_at, disclosed as a creation time", () => {
  const context = buildCostingDomainContext(
    rows({ costings: [costingRow({ created_at: "2026-08-02T00:00:00.000Z" }), costingRow({ id: "costing-2", created_at: "2026-08-05T00:00:00.000Z" })] }),
  );
  assert.equal((context.sourceAsOf as { value: string }).value, "2026-08-05T00:00:00.000Z");
  assert.ok(context.notes.some((note) => /creation time/.test(note)));
});

test("costing adapter: takes no BuildEnv, and is still assignable to DomainAdapter", () => {
  // It needs neither the clock nor the business day -- every costing fact is an entered value or an
  // arithmetic result. A shorter parameter list stays structurally assignable, so the registry in a
  // later slice can hold it without a wrapper. This assignment is the assertion; if the contract
  // ever stops accepting it, this file fails to typecheck.
  const registered: DomainAdapter<CostingRows> = buildCostingDomainContext;
  assert.equal(typeof registered, "function");
  assert.equal(buildCostingDomainContext.length, 1, "the adapter declares exactly one parameter");
});
