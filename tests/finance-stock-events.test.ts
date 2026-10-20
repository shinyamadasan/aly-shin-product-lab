import test from "node:test";
import assert from "node:assert/strict";
import { buildMonthlyFinancialReport, earliestRecordedMonth } from "../src/lib/finance/report.ts";
import { mapStockFinancialEventRow, type StockFinancialEvent } from "../src/lib/finance/stock-events.ts";
import { buildGoldenInputs, makeCogs, makeLine, makeOrder } from "./fixtures/finance-golden.ts";

function event(overrides: Partial<StockFinancialEvent> = {}): StockFinancialEvent {
  return { id: "raw-1", occurredAt: "2026-10-15T10:00:00+08:00", sourceKind: "raw", sourceId: "movement-1", classification: "operating_loss", quantity: 10, amount: 20, estimated: false, reviewId: null, ...overrides };
}

test("business stock losses reduce operating result once; sales-only margin and expense ledger stay unchanged", () => {
  const inputs = buildGoldenInputs();
  const before = buildMonthlyFinancialReport(inputs, "2026-10");
  inputs.stockFinancialEvents = [
    event({ amount: 25 }),
    event({ id: "lot-A", sourceKind: "finished", amount: 2 * (800 / 24), quantity: 2 }),
    event({ id: "lot-B", sourceKind: "finished", amount: 12.5, quantity: 1 }),
    event({ id: "sample", classification: "marketing", amount: 30 }),
    event({ id: "test", classification: "business_testing", amount: 40 }),
    event({ id: "home", classification: "household", amount: 500 }),
  ];
  const after = buildMonthlyFinancialReport(inputs, "2026-10");
  assert.deepEqual(after.sales, before.sales);
  assert.deepEqual(after.cogs, before.cogs);
  assert.deepEqual(after.expenses, before.expenses);
  assert.deepEqual(after.grossMargin, before.grossMargin);
  assert.equal(after.stockAttribution.operatingCost, 25 + 2 * (800 / 24) + 12.5 + 30 + 40);
  // October's sold ingredient cost is 633 1/3, event cost 174 1/6. Round only their final result.
  assert.equal(after.operatingResult.value, -1091.93);
  assert.equal(after.stockAttribution.byCategory.find((row) => row.classification === "household")?.total, 500);
});

test("household withdrawal alone does not reduce operating result", () => {
  const inputs = buildGoldenInputs();
  const before = buildMonthlyFinancialReport(inputs, "2026-10");
  inputs.stockFinancialEvents = [event({ classification: "household", amount: 100 })];
  assert.deepEqual(buildMonthlyFinancialReport(inputs, "2026-10").operatingResult, before.operatingResult);
});

test("signed reversals cancel only their allocated cost and recognize in their own Manila month", () => {
  const inputs = buildGoldenInputs();
  inputs.stockFinancialEvents = [event({ amount: 30 }), event({ id: "reversed", quantity: -10, amount: -30 })];
  const reversed = buildMonthlyFinancialReport(inputs, "2026-10");
  assert.equal(reversed.stockAttribution.operatingCost, 0);
  inputs.stockFinancialEvents[1].occurredAt = "2026-10-31T16:00:00Z"; // Nov 1 Manila.
  assert.equal(buildMonthlyFinancialReport(inputs, "2026-10").stockAttribution.operatingCost, 30);
  assert.equal(buildMonthlyFinancialReport(inputs, "2026-11").stockAttribution.operatingCost, -30);
});

test("raw event snapshots are never recomputed from today's ingredient average cost", () => {
  const inputs = buildGoldenInputs();
  inputs.stockFinancialEvents = [event({ amount: 35 })];
  const before = buildMonthlyFinancialReport(inputs, "2026-10").stockAttribution;
  inputs.ingredients = inputs.ingredients.map((ingredient) => ({ ...ingredient, averageUnitCost: 9999 }));
  assert.deepEqual(buildMonthlyFinancialReport(inputs, "2026-10").stockAttribution, before);
});

test("finished lot costs restate from the authoritative view without treating the change as another expense", () => {
  const inputs = buildGoldenInputs();
  inputs.stockFinancialEvents = [event({ sourceKind: "finished", amount: 800 / 24, quantity: 1 }), event({ id: "B", sourceKind: "finished", amount: 12.5, quantity: 1 })];
  const before = buildMonthlyFinancialReport(inputs, "2026-10");
  inputs.stockFinancialEvents[0].amount = 800 / 20; // Authoritative view after yield correction.
  const after = buildMonthlyFinancialReport(inputs, "2026-10");
  assert.equal(before.stockAttribution.operatingCost, 800 / 24 + 12.5);
  assert.equal(before.stockAttribution.byCategory[0].total, 45.83, "displayed category is rounded independently");
  assert.equal(after.stockAttribution.operatingCost, 52.5);
  assert.equal(after.stockAttribution.events.length, 2);
  assert.deepEqual(after.expenses, before.expenses);
});

test("operating result rounds only after both sales and stock event repeating lot costs are deducted", () => {
  const inputs = buildGoldenInputs();
  const order = makeOrder({ id: "REPEATING", status: "completed", completedAt: "2026-10-15T10:00:00+08:00", paymentStatus: "paid", paidAmount: 100, paidAt: "2026-10-15T10:00:00+08:00" });
  inputs.orders = [order];
  inputs.linesByOrderId = new Map([[order.id, [makeLine(order.id, { itemName: "Brownie", productId: "brownie", piecesPerUnitSnapshot: 1, unitPrice: 100, quantity: 1 })]]]);
  inputs.cogsByOrderId = new Map([[order.id, makeCogs(order.id, [{ lot: "lotA", productId: "brownie", pieces: 1, perPiece: 100 / 3 }])]]);
  inputs.expenses = [];
  inputs.stockFinancialEvents = [event({ sourceKind: "finished", amount: 100 / 3, quantity: 1 })];
  const report = buildMonthlyFinancialReport(inputs, "2026-10");
  assert.equal(report.cogs.ingredientCogs, 33.33);
  assert.equal(report.grossMargin.value, 66.67);
  assert.equal(report.stockAttribution.byCategory[0].total, 33.33);
  assert.equal(report.stockAttribution.operatingCost, 100 / 3);
  assert.deepEqual(report.operatingResult, { value: 33.33, withheld: null }, "100 - 100/3 - 100/3 = 33.333..., never rounded-margin 66.67 minus rounded-cost 33.33 = 33.34");
});

test("unknown or unclassified costs withhold operating result and affected totals, never gross margin", () => {
  for (const classification of ["operating_loss", "marketing", "business_testing", "household", "unclassified"] as const) {
    const inputs = buildGoldenInputs();
    const before = buildMonthlyFinancialReport(inputs, "2026-10");
    inputs.stockFinancialEvents = [event(), event({ id: "unknown", classification, amount: null })];
    const report = buildMonthlyFinancialReport(inputs, "2026-10");
    assert.deepEqual(report.operatingResult, { value: null, withheld: "stock-events-review" });
    assert.deepEqual(report.grossMargin, before.grossMargin);
    assert.equal(report.stockAttribution.byCategory.find((row) => row.classification === classification)?.total, null);
    assert.equal(report.stockAttribution.review.length, 1);
  }
  const inputs = buildGoldenInputs();
  inputs.stockFinancialEvents = [event({ classification: "unclassified", amount: -5, quantity: -1 })];
  assert.equal(buildMonthlyFinancialReport(inputs, "2026-10").operatingResult.withheld, "stock-events-review", "a valued physical correction is still unclassified");
  inputs.stockFinancialEvents[0].classification = "household";
  assert.equal(buildMonthlyFinancialReport(inputs, "2026-10").operatingResult.withheld, null, "review changes treatment without changing quantity or cost");
});

test("source unavailable or capped withholds every category total and operating result but not sales gross margin", () => {
  for (const source of [null, undefined, [event()]] as const) {
    const inputs = buildGoldenInputs();
    const before = buildMonthlyFinancialReport(inputs, "2026-10");
    inputs.stockFinancialEvents = source === undefined ? undefined as unknown as null : source === null ? null : [...source];
    inputs.stockEventsTruncated = Array.isArray(source);
    const report = buildMonthlyFinancialReport(inputs, "2026-10");
    assert.equal(report.operatingResult.withheld, Array.isArray(source) ? "stock-events-truncated" : "stock-events-unavailable");
    assert.deepEqual(report.grossMargin, before.grossMargin);
    assert.ok(report.stockAttribution.byCategory.every((row) => row.total === null));
  }
});

test("estimated costs are disclosed even if positive and reversal estimates net to zero", () => {
  const inputs = buildGoldenInputs();
  inputs.stockFinancialEvents = [event({ estimated: true, amount: 10 }), event({ id: "undo", estimated: true, amount: -10, quantity: -10 })];
  const report = buildMonthlyFinancialReport(inputs, "2026-10");
  assert.ok(report.warnings.some((row) => row.code === "estimated-stock-event-cost"));
  assert.equal(report.stockAttribution.byCategory[0].estimatedCount, 2);
  assert.equal(report.stockAttribution.byCategory[0].estimatedAmount, 0);
});

test("stock-only activity appears in month selector and unvalued history is not silently backfilled", () => {
  const inputs = buildGoldenInputs();
  inputs.stockFinancialEvents = [event({ occurredAt: "2026-08-31T16:00:00Z", amount: null, classification: "unclassified" })];
  assert.equal(earliestRecordedMonth({ orders: [], expenses: [], stockFinancialEvents: inputs.stockFinancialEvents }, "2026-11"), "2026-09");
  assert.equal(buildMonthlyFinancialReport(inputs, "2026-09").stockAttribution.review[0].amount, null);
  assert.equal(buildMonthlyFinancialReport(inputs, "2026-10").stockAttribution.review.length, 0);
});

test("view mapping retains full precision and null costs; unknown classifications require review", () => {
  const row = { id: "f1", occurred_at: "2026-10-15T00:00:00Z", source_kind: "finished" as const, source_id: "move", classification: "future_type", quantity: "-1", amount: "-33.333333333333", estimated: true, review_id: "review" };
  const mapped = mapStockFinancialEventRow(row);
  assert.equal(mapped.amount, -33.333333333333);
  assert.equal(mapped.quantity, -1);
  assert.equal(mapped.classification, "unclassified");
  assert.equal(mapped.reviewId, "review");
  assert.equal(mapStockFinancialEventRow({ ...row, amount: null }).amount, null);
  assert.throws(() => mapStockFinancialEventRow({ ...row, amount: "invalid" }), /Invalid stock financial/);
  assert.throws(() => mapStockFinancialEventRow({ ...row, amount: "" }), /Invalid stock financial/);
  assert.throws(() => mapStockFinancialEventRow({ ...row, quantity: "" }), /Invalid stock financial/);
  assert.throws(() => mapStockFinancialEventRow({ ...row, occurred_at: "invalid" }), /Invalid stock financial/);
});

test("known zero event cost is retained, but zero-valued unclassified events still require review", () => {
  const inputs = buildGoldenInputs();
  const baseline = buildMonthlyFinancialReport(inputs, "2026-10");
  inputs.stockFinancialEvents = [event({ amount: 0 })];
  assert.deepEqual(buildMonthlyFinancialReport(inputs, "2026-10").operatingResult, baseline.operatingResult);
  assert.equal(buildMonthlyFinancialReport(inputs, "2026-10").stockAttribution.review.length, 0);
  inputs.stockFinancialEvents[0].classification = "unclassified";
  assert.equal(buildMonthlyFinancialReport(inputs, "2026-10").operatingResult.withheld, "stock-events-review");
});


test("verified unvalued count gains warn about valuation without creating expense, income or a result blocker", () => {
  const inputs = buildGoldenInputs();
  const before = buildMonthlyFinancialReport(inputs, "2026-10");
  inputs.stockFinancialEvents = [405, 18, 55].map((quantity, index) => event({ id: String(index), classification: "stock_count_gain", quantity: -quantity, amount: null }));
  const snapshot = structuredClone(inputs.stockFinancialEvents);
  const after = buildMonthlyFinancialReport(inputs, "2026-10");
  assert.deepEqual(after.sales, before.sales);
  assert.deepEqual(after.cogs, before.cogs);
  assert.deepEqual(after.grossMargin, before.grossMargin);
  assert.deepEqual(after.expenses, before.expenses);
  assert.deepEqual(after.operatingResult, before.operatingResult);
  assert.equal(after.stockAttribution.operatingCost, 0);
  assert.equal(after.stockAttribution.review.length, 0);
  assert.equal(after.stockAttribution.unvaluedCountGains.length, 3);
  assert.equal(after.stockAttribution.byCategory.find((c) => c.classification === "stock_count_gain")?.total, null);
  assert.ok(after.warnings.some((w) => w.code === "stock-count-valuation" && w.count === 3));
  assert.deepEqual(inputs.stockFinancialEvents, snapshot);
  inputs.stockFinancialEvents.push(event({ amount: null }));
  const loss = buildMonthlyFinancialReport(inputs, "2026-10");
  assert.equal(loss.operatingResult.withheld, "stock-events-review");
  assert.equal(loss.stockAttribution.review.length, 1);
  assert.ok(loss.warnings.some((w) => w.code === "stock-count-valuation"));
  inputs.stockFinancialEvents.pop();
  inputs.expenses = null;
  assert.equal(buildMonthlyFinancialReport(inputs, "2026-10").operatingResult.withheld, "expenses-unavailable");
  inputs.expenses = [];
  inputs.stockEventsTruncated = true;
  assert.equal(buildMonthlyFinancialReport(inputs, "2026-10").operatingResult.withheld, "stock-events-truncated");
});
