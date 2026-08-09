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

// --- Absent columns (pre-migration projects) -----------------------------------------------------
//
// water/gas/oven_electric/refrigeration/coffee_equipment are added by
// supabase-update-costing-and-journal.sql, and overhead/equipment by
// supabase-add-costing-overhead-equipment-columns.sql -- both against an already existing
// costing_summaries table. A project that has not run them returns rows WITHOUT those keys, so the
// property is genuinely absent rather than null, and CostingSummaryRow's `number` is a promise the
// database has not yet kept.
//
// This was found on live production data, where five facts rendered as the literal string
// "undefined". The golden fixture has every column present, which is exactly why the existing proof
// layer could not see it.

// Deletes keys outright. `Partial<CostingSummaryRow>` cannot express absence -- only null -- so the
// row is built and then stripped, which is what PostgREST actually returns.
function rowWithoutColumns(...columns: string[]): CostingSummaryRow {
  const row = { ...costingRow() } as unknown as Record<string, unknown>;
  for (const column of columns) {
    delete row[column];
  }
  return row as unknown as CostingSummaryRow;
}

const LATER_MIGRATION_COLUMNS: Array<[string, keyof CostingSnapshot]> = [
  ["water_cost", "waterCost"],
  ["gas_cost", "gasCost"],
  ["oven_electric_cost", "ovenElectricCost"],
  ["refrigeration_cost", "refrigerationCost"],
  ["coffee_equipment_cost", "coffeeEquipmentCost"],
  ["overhead_cost", "overheadCost"],
  ["equipment_cost", "equipmentCost"],
];

for (const [column, factKey] of LATER_MIGRATION_COLUMNS) {
  test(`[absent-column] an absent ${column} is unknown, never known(undefined)`, () => {
    const row = rowWithoutColumns(column);
    assert.equal(column in (row as unknown as Record<string, unknown>), false, "the test must exercise a genuinely absent property");

    const fact = snapshots(buildCostingDomainContext({ costings: [row], entries: [] }))[0][factKey] as Fact<number>;

    assert.equal(fact.state, "unknown");
    assert.equal("value" in fact, false, "an unknown fact carries no value");
    assert.ok((fact as { because: string }).because.includes(column), "the reason must name the actual column");
    assert.match((fact as { because: string }).because, /does not exist in this project/);
  });

  test(`[absent-column] an explicit 0 in ${column} is still a real entered zero`, () => {
    const fact = snapshots(buildCostingDomainContext({ costings: [costingRow({ [column]: 0 } as Partial<CostingSummaryRow>)], entries: [] }))[0][factKey] as Fact<number>;

    // The whole point of the Fact vocabulary: a real zero is a value, and must never be confused
    // with an absent column in either direction.
    assert.equal(fact.state, "known");
    assert.equal((fact as { value: number }).value, 0);
  });
}

test("[absent-column] an absent column keeps truthful provenance naming the column", () => {
  const fact = snapshots(buildCostingDomainContext({ costings: [rowWithoutColumns("water_cost")], entries: [] }))[0].waterCost as Fact<number>;
  const provenance = (fact as { source: { kind: string; table?: string; column?: string } }).source;

  assert.equal(provenance.kind, "entered");
  assert.equal(provenance.table, "costing_summaries");
  assert.equal(provenance.column, "water_cost");
});

test("[absent-column] all five utility columns absent at once yields five unknowns and no undefined value", () => {
  const row = rowWithoutColumns("water_cost", "gas_cost", "oven_electric_cost", "refrigeration_cost", "coffee_equipment_cost");
  const snapshot = snapshots(buildCostingDomainContext({ costings: [row], entries: [] }))[0];

  for (const key of ["waterCost", "gasCost", "ovenElectricCost", "refrigerationCost", "coffeeEquipmentCost"] as const) {
    const fact = snapshot[key] as Fact<number>;
    assert.equal(fact.state, "unknown", `${key} must be unknown`);
    assert.equal((fact as { value?: unknown }).value, undefined);
    assert.equal("value" in fact, false);
  }

  // Untouched columns are unaffected -- this fix changes nothing for a fully migrated project.
  assert.equal((snapshot.ingredientCost as { state: string; value: number }).state, "known");
  assert.equal((snapshot.ingredientCost as { state: string; value: number }).value, 200);
});

test("[absent-column] suggested_price keeps three distinct states", () => {
  const absent = snapshots(buildCostingDomainContext({ costings: [rowWithoutColumns("suggested_price")], entries: [] }))[0].suggestedPrice as Fact<number>;
  const unfilled = snapshots(buildCostingDomainContext({ costings: [costingRow({ suggested_price: null })], entries: [] }))[0].suggestedPrice as Fact<number>;
  const priced = snapshots(buildCostingDomainContext({ costings: [costingRow({ suggested_price: 0 })], entries: [] }))[0].suggestedPrice as Fact<number>;

  // "the column is not here", "the owner never priced it", and "the owner priced it at zero" are
  // three different facts about the business.
  assert.equal(absent.state, "unknown");
  assert.equal(unfilled.state, "unset");
  assert.equal(priced.state, "known");
  assert.equal((priced as { value: number }).value, 0);
});

test("[absent-column] a fully migrated row is completely unchanged by this fix", () => {
  const snapshot = snapshots(buildCostingDomainContext(rows()))[0];

  for (const key of ["waterCost", "gasCost", "ovenElectricCost", "refrigerationCost", "coffeeEquipmentCost", "overheadCost", "equipmentCost"] as const) {
    assert.equal((snapshot[key] as Fact<number>).state, "known", `${key} must stay known when the column exists`);
  }
  assert.equal((snapshot.coffeeEquipmentCost as { value: number }).value, 0, "an entered zero stays an entered zero");
});

// --- Absent columns must poison what was computed from them ---------------------------------------
//
// The direct facts were corrected first, which left a worse-looking state: waterCost said "unknown"
// while totalBatchCost, computed from a mapper-substituted zero for that same column, still said
// "known". The gate walks METRIC_INPUTS -- the dependency graph this adapter already publishes as
// provenance -- so the two cannot drift apart.

function snapshotWithout(...columns: string[]): CostingSnapshot {
  return snapshots(buildCostingDomainContext({ costings: [rowWithoutColumns(...columns)], entries: [] }))[0];
}

const stateOf = (fact: Fact<number>) => fact.state;

test("[derived] a missing water_cost makes waterCost AND totalBatchCost unknown", () => {
  const snapshot = snapshotWithout("water_cost");

  assert.equal(stateOf(snapshot.waterCost), "unknown");
  assert.equal(stateOf(snapshot.totalBatchCost), "unknown", "a sum computed from a substituted zero is not a known total");
  assert.equal("value" in snapshot.totalBatchCost, false);
  assert.match((snapshot.totalBatchCost as { because: string }).because, /water_cost/);
  assert.match((snapshot.totalBatchCost as { because: string }).because, /substituted zero/);
});

test("[derived] everything downstream of an absent direct cost is unknown", () => {
  const snapshot = snapshotWithout("water_cost");

  // The full transitive closure: nothing that reaches water_cost through the graph may stay known.
  for (const key of ["totalBatchCost", "costPerPiece", "grossProfit", "margin", "foodCostPercent", "markup", "targetPrice", "variableCostPerPiece", "contributionMarginPerPiece", "breakEvenUnits"] as const) {
    assert.equal(stateOf(snapshot[key]), "unknown", `${key} must not survive an absent direct cost input`);
    assert.equal("value" in snapshot[key], false, `${key} must carry no value`);
  }
});

test("[derived] a missing INDIRECT column spares the metrics that never depended on it", () => {
  const snapshot = snapshotWithout("overhead_cost");

  // totalBatchCost and its dependents include indirect costs, so they go.
  assert.equal(stateOf(snapshot.overheadCost), "unknown");
  assert.equal(stateOf(snapshot.totalBatchCost), "unknown");
  assert.equal(stateOf(snapshot.costPerPiece), "unknown");
  assert.equal(stateOf(snapshot.breakEvenUnits), "unknown", "break-even is computed from indirect costs");

  // variableCostPerPiece is direct costs + yield only -- it never read overhead, so invalidating it
  // would be indiscriminate rather than honest.
  assert.equal(stateOf(snapshot.variableCostPerPiece), "known");
  assert.equal(stateOf(snapshot.contributionMarginPerPiece), "known", "it depends on price and variable cost, neither of which moved");
});

test("[derived] a missing DIRECT column does invalidate variableCostPerPiece", () => {
  const snapshot = snapshotWithout("gas_cost");

  assert.equal(stateOf(snapshot.variableCostPerPiece), "unknown");
  assert.equal(stateOf(snapshot.contributionMarginPerPiece), "unknown", "it is computed from variable cost per piece");
});

test("[derived] explicit zeroes still permit every normal calculation", () => {
  const zeroed = costingRow({ water_cost: 0, gas_cost: 0, oven_electric_cost: 0, refrigeration_cost: 0, coffee_equipment_cost: 0, overhead_cost: 0, equipment_cost: 0 });
  const snapshot = snapshots(buildCostingDomainContext({ costings: [zeroed], entries: [] }))[0];

  // An entered zero is evidence. Only an absent column is not.
  for (const key of ["totalBatchCost", "costPerPiece", "grossProfit", "margin", "foodCostPercent", "markup", "targetPrice", "variableCostPerPiece", "contributionMarginPerPiece", "breakEvenUnits"] as const) {
    assert.equal(stateOf(snapshot[key]), "known", `${key} must stay computable from entered zeroes`);
  }
});

test("[derived] a fully migrated row publishes every metric exactly as before", () => {
  const snapshot = snapshots(buildCostingDomainContext(rows()))[0];

  for (const key of ["totalBatchCost", "costPerPiece", "grossProfit", "margin", "foodCostPercent", "markup", "targetPrice", "variableCostPerPiece", "contributionMarginPerPiece", "breakEvenUnits"] as const) {
    assert.equal(stateOf(snapshot[key]), "known", `${key} must be unaffected when no column is missing`);
  }
});

test("[derived] the gate uses the declared dependency graph, so provenance still matches", () => {
  const snapshot = snapshotWithout("water_cost");
  const gated = snapshot.costPerPiece as { source: { computedBy?: string; inputs?: string[] } };

  // An unknown metric keeps naming exactly what it would have been computed from.
  assert.equal(gated.source.computedBy, "getCostingTotals");
  assert.deepEqual(gated.source.inputs, ["costing.facts.byCosting[].totalBatchCost", "costing.facts.byCosting[].costingYield"]);
});

test("[derived] an unreadable yield still behaves exactly as it did, with no column missing", () => {
  const snapshot = snapshots(buildCostingDomainContext({ costings: [costingRow({ notes: "no yield here" })], entries: [] }))[0];

  // The pre-existing yield gate is untouched: totalBatchCost is not yield-dependent and stays known.
  assert.equal(stateOf(snapshot.totalBatchCost), "known");
  assert.equal(stateOf(snapshot.costPerPiece), "unknown");
  assert.match((snapshot.costPerPiece as { because: string }).because, /batch yield could not be read/);
});
