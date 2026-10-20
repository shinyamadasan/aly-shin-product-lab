// Financial Release 1 -- the monthly report, proven against a fixed golden dataset whose expected
// values were hand-calculated from tests/fixtures/finance-golden.ts before the code was run.
//
// HAND CALCULATION (Manila months)
//
//  OCTOBER  completed in Oct: O1 540 (paid), O2 300 (paid), O3 60 (UNPAID receivable), O5 100 (paid),
//           O9 200 (paid, refunded later, so still October revenue). O4 completed 00:30 Manila 1 Nov
//           is NOT October even though it is 31 Oct in UTC.
//    recognized revenue = 540 + 300 + 60 + 100 + 200            = 1,200.00   collected 1,140  receivable 60
//    refunds in Oct (of completed orders)                        = 0          (O9 refunded 3 Nov; O8 was never completed)
//    ingredient COGS    = O1 (6x33.33.. + 4x12.5 = 250) + O2 200 + O3 25 + O5 25 + O9 (4x33.33.. = 133.33..)
//                       = 633.33..                                = 633.33
//    product sales = 540 + 300 + 60 + 60 + 200 = 1,160 (O5's 40 delivery fee is a manual line); all costed
//    gross margin       = 1,200.00 - 633.33..                      = 566.67
//    expenses (live)    = 1,000 + 333.33 + (0.10 + 0.20 + 0.30) + 150.50 = 1,484.43  (E6 500 is void)
//    operating result   = 566.67 - 1,484.43                        = -917.76
//    cash received (by payment date) = O1 540 + O5 100 + O6 250 + O7 80 + O8 120 + O9 200 = 1,290; refunded 120 (O8)
//    inventory purchases = 5,000 + 1,234.56                        = 6,234.56   (memo, not profit)
//
//  NOVEMBER completed: O4 150. Refund of completed O9: 200 (contra-revenue in November).
//    net revenue = 150 - 200 = -50;  COGS 3x33.33.. = 100;  gross margin = -150;  no expenses -> result -150
//
//  SEPTEMBER completed: S1 100 (costed), S2 120 (NO cost), S3 160 (partial: brownie 100 costed, cookie 60 not)
//    recognized 380; COGS 66.67 + 66.67 = 133.33; product sales 380, costed 200, uncosted 180, coverage 200/380
//    -> gross margin WITHHELD (cost-coverage); operating result WITHHELD (pre-start)
//
//  BALANCES at 10 Nov 2026
//    deposits: O6 250.   cancelled-paid-not-refunded: O7 80.   receivable: O3 60, 31 days old.
//    raw inventory trusted: Flour 500 + Sugar 400 = 900; unverified: Butter 800; no cost: Cocoa; negative: Eggs
//    finished goods: lotA 1 x 33.33.. + lotB 22 x 12.5 + lotC 10 x 30 = 33.33 + 275 + 300 = 608.33 (33 pieces)

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { buildFinancialBalances, buildMonthlyFinancialReport, earliestRecordedMonth, FINANCIAL_EXCLUSIONS, POSTGREST_ROW_CAP, type FinanceInputs } from "../src/lib/finance/report.ts";
import { BROWNIE_PER_PIECE, buildGoldenInputs, makeCogs, makeExpense, makeLine, makeOrder } from "./fixtures/finance-golden.ts";

const NOW = Date.parse("2026-11-10T10:00:00+08:00");
const codes = (warnings: Array<{ code: string }>) => warnings.map((warning) => warning.code);

// ---------------------------------------------------------------------------------------------------
// October: the first official month
// ---------------------------------------------------------------------------------------------------

test("October: revenue is recognized when orders are COMPLETED, on Manila dates", () => {
  const october = buildMonthlyFinancialReport(buildGoldenInputs(), "2026-10");
  assert.equal(october.sales.completedOrders, 5, "O1, O2, O3, O5, O9 -- O4 completes 00:30 Manila on 1 Nov");
  assert.equal(october.sales.recognizedRevenue, 1200);
  assert.equal(october.sales.collected, 1140);
  assert.equal(october.sales.receivable, 60, "O3 is completed and unpaid: a receivable, recognized now");
  assert.equal(october.sales.refunds, 0, "O9's refund is in November; O8 was never completed");
  assert.equal(october.sales.netRevenue, 1200);
});

test("October: ingredient COGS comes from the frozen fulfilled-allocation cost and is rounded once", () => {
  const { cogs } = buildMonthlyFinancialReport(buildGoldenInputs(), "2026-10");
  assert.equal(cogs.ingredientCogs, 633.33);
  assert.deepEqual(cogs.orders, { costed: 5, partial: 0, uncosted: 0, "no-product": 0 });
  assert.equal(cogs.productSales, 1160);
  assert.equal(cogs.costedProductSales, 1160);
  assert.equal(cogs.uncostedProductSales, 0);
  assert.equal(cogs.manualLineSales, 40, "the delivery fee is a manual line with no product cost");
  assert.equal(cogs.coverage, 1);
  assert.equal(cogs.isComplete, true);
  assert.equal(cogs.costedSalesMargin, 526.67);
});

test("October: gross margin, expenses and the provisional operating result", () => {
  const october = buildMonthlyFinancialReport(buildGoldenInputs(), "2026-10");
  assert.deepEqual(october.grossMargin, { value: 566.67, withheld: null });
  assert.equal(october.expenses.total, 1484.43);
  assert.equal(october.expenses.count, 6);
  assert.equal(october.expenses.voidedCount, 1, "E6 is void: kept in the ledger, never counted");
  assert.deepEqual(october.operatingResult, { value: -917.76, withheld: null });
});

test("October: expense categories add up to the total, largest first", () => {
  const { expenses } = buildMonthlyFinancialReport(buildGoldenInputs(), "2026-10");
  assert.deepEqual(
    expenses.byCategory.map((entry) => [entry.category, entry.total, entry.count]),
    [["rent", 1000, 1], ["utilities", 333.33, 1], ["delivery", 150.5, 1], ["fees", 0.6, 3]],
  );
  assert.equal(expenses.byCategory.reduce((sum, entry) => sum + entry.total, 0).toFixed(2), "1484.43");
});

test("cash received is a separate memo view, by payment date, never mixed into revenue", () => {
  const october = buildMonthlyFinancialReport(buildGoldenInputs(), "2026-10");
  assert.deepEqual(october.cash, { received: 1290, refunded: 120 });
  assert.notEqual(october.cash.received, october.sales.recognizedRevenue, "cash and recognized revenue are different questions");
  // O1 was paid at 05:00 Manila on 1 Oct (21:00Z on 30 Sep): a UTC clock would put 540 in September.
  assert.equal(buildMonthlyFinancialReport(buildGoldenInputs(), "2026-09").cash.received, 680);
});

test("a prepaid order is a deposit until completed; an unpaid completed order is a receivable", () => {
  const inputs = buildGoldenInputs();
  const balances = buildFinancialBalances(inputs, NOW);
  assert.deepEqual(balances.customerDeposits, { count: 1, amount: 250 }, "O6: paid, still open");
  assert.deepEqual(balances.cancelledPaidNotRefunded, { count: 1, amount: 80 }, "O7");
  assert.deepEqual(balances.receivables, { count: 1, amount: 60, oldestDays: 31, staleCount: 1 });
  // O6's 250 is not revenue in ANY month; O2 (prepaid in September) is revenue in October only.
  for (const month of ["2026-09", "2026-10", "2026-11"]) {
    const report = buildMonthlyFinancialReport(inputs, month);
    assert.ok(report.sales.recognizedRevenue !== 250, "a deposit is never revenue");
  }
  assert.equal(buildMonthlyFinancialReport(inputs, "2026-09").sales.recognizedRevenue, 380, "O2 paid in September, but revenue is October's");
});

test("an open or cancelled order is never revenue, by status, even when its data is odd", () => {
  const inputs = buildGoldenInputs();
  // A corrupt row: still open (confirmed) and prepaid, yet carrying a completion date inside October.
  inputs.orders.push(makeOrder({ id: "ODD", status: "confirmed", paymentStatus: "paid", paidAt: "2026-10-12T09:00:00+08:00", paidAmount: 999, completedAt: "2026-10-12T10:00:00+08:00" }));
  inputs.linesByOrderId.set("ODD", [makeLine("ODD", { itemName: "X", unitPrice: 999, quantity: 1 })]);
  inputs.orders.push(makeOrder({ id: "ODD2", status: "cancelled", paymentStatus: "paid", paidAt: "2026-10-12T09:00:00+08:00", paidAmount: 888, completedAt: "2026-10-12T10:00:00+08:00" }));
  inputs.linesByOrderId.set("ODD2", [makeLine("ODD2", { itemName: "Y", unitPrice: 888, quantity: 1 })]);
  const october = buildMonthlyFinancialReport(inputs, "2026-10");
  assert.equal(october.sales.recognizedRevenue, 1200, "only COMPLETED orders are revenue");
  assert.equal(october.sales.completedOrders, 5);
  assert.ok(!codes(october.warnings).includes("completed-order-without-date"), "an open order is not a completed order without a date");
});

test("October raises exactly the warnings it should, and no others", () => {
  const warnings = buildMonthlyFinancialReport(buildGoldenInputs(), "2026-10").warnings;
  assert.deepEqual(codes(warnings).sort(), ["deposit-refund", "manual-line-sales"]);
  assert.deepEqual(warnings.find((warning) => warning.code === "deposit-refund")?.amount, 120);
  assert.deepEqual(warnings.find((warning) => warning.code === "manual-line-sales")?.amount, 40);
});

test("purchases are a memo line and never reach profit", () => {
  const october = buildMonthlyFinancialReport(buildGoldenInputs(), "2026-10");
  assert.deepEqual(october.inventoryPurchases, { total: 6234.56, count: 2 });
  assert.equal(buildMonthlyFinancialReport(buildGoldenInputs(), "2026-09").inventoryPurchases.total, 800);
});

// ---------------------------------------------------------------------------------------------------
// The mandatory "does not double count" proofs
// ---------------------------------------------------------------------------------------------------

test("buying ingredients does not reduce profit: a large purchase leaves margin and result unchanged", () => {
  const before = buildMonthlyFinancialReport(buildGoldenInputs(), "2026-10");
  const inputs = buildGoldenInputs();
  inputs.supplies.push({ ...inputs.supplies[0], id: "BIG", purchaseDate: "2026-10-12", totalCost: 250000 });
  const after = buildMonthlyFinancialReport(inputs, "2026-10");
  assert.deepEqual(after.grossMargin, before.grossMargin);
  assert.deepEqual(after.operatingResult, before.operatingResult);
  assert.deepEqual(after.expenses, before.expenses);
  assert.equal(after.inventoryPurchases.total, before.inventoryPurchases.total + 250000, "the purchase is visible, as a memo only");
});

test("baking does not double count: a new production lot moves finished goods, not COGS or profit", () => {
  const before = buildMonthlyFinancialReport(buildGoldenInputs(), "2026-10");
  const balancesBefore = buildFinancialBalances(buildGoldenInputs(), NOW);
  const inputs = buildGoldenInputs();
  inputs.productionExecutions.push({ ...inputs.productionExecutions[0], id: "lotD", quantityProducedPieces: 10, frozenCostPerPiece: 20, frozenIngredientCostTotal: 200, completedAt: "2026-10-25T09:00:00+08:00" });
  inputs.finishedStockMovements.push({ ...inputs.finishedStockMovements[0], id: "lotD-receipt", productionExecutionId: "lotD", movementType: "production_receipt", onHandDelta: 10, reservedDelta: 0 });
  const after = buildMonthlyFinancialReport(inputs, "2026-10");
  assert.deepEqual(after.cogs, before.cogs, "COGS is read only from fulfilled allocations, never from a Bake");
  assert.deepEqual(after.grossMargin, before.grossMargin);
  assert.deepEqual(after.operatingResult, before.operatingResult);
  assert.equal(buildFinancialBalances(inputs, NOW).finishedGoods.value, balancesBefore.finishedGoods.value + 200, "the baked cost shows up as finished goods");
});

test("fulfilment recognizes the FROZEN cost: a later change to a lot's cost does not reprice a past sale", () => {
  const before = buildMonthlyFinancialReport(buildGoldenInputs(), "2026-10");
  const inputs = buildGoldenInputs();
  inputs.productionExecutions[0] = { ...inputs.productionExecutions[0], frozenCostPerPiece: 999 };
  assert.equal(buildMonthlyFinancialReport(inputs, "2026-10").cogs.ingredientCogs, before.cogs.ingredientCogs);
});

test("October's known ingredient COGS reconciles with the production records", () => {
  const inputs = buildGoldenInputs();
  const lotsById = new Map(inputs.productionExecutions.map((lot) => [lot.id, lot]));
  let independent = 0;
  for (const order of inputs.orders) {
    if (order.status !== "completed" || !order.completedAt?.startsWith("2026-10")) continue;
    const cogs = inputs.cogsByOrderId.get(order.id);
    assert.ok(cogs, `${order.id} has a COGS row`);
    for (const lotRow of cogs.lots) {
      const execution = lotsById.get(lotRow.productionExecutionId);
      assert.ok(execution, "every COGS lot points at a real production record");
      assert.equal(lotRow.frozenCostPerPiece, execution.frozenCostPerPiece, "the cost used is the cost frozen at Bake");
      assert.equal(lotRow.productId, execution.productId);
      independent += lotRow.fulfilledPieces * execution.frozenCostPerPiece;
    }
    assert.equal(cogs.rawProductionCogs, cogs.lots.reduce((sum, lotRow) => sum + lotRow.lotRawCogs, 0));
  }
  assert.equal(Math.round(independent * 100) / 100, buildMonthlyFinancialReport(inputs, "2026-10").cogs.ingredientCogs);
  // No lot is oversold: pieces fulfilled never exceed pieces produced.
  const fulfilledByLot = new Map<string, number>();
  for (const cogs of inputs.cogsByOrderId.values()) for (const lotRow of cogs.lots) fulfilledByLot.set(lotRow.productionExecutionId, (fulfilledByLot.get(lotRow.productionExecutionId) ?? 0) + lotRow.fulfilledPieces);
  for (const [lotId, fulfilled] of fulfilledByLot) assert.ok(fulfilled <= (lotsById.get(lotId)?.quantityProducedPieces ?? 0), `${lotId} is not oversold`);
});

// ---------------------------------------------------------------------------------------------------
// September: incomplete cost data must never look like a profit
// ---------------------------------------------------------------------------------------------------

test("September: missing COGS withholds margin and result, shows a coverage warning, and says why", () => {
  const september = buildMonthlyFinancialReport(buildGoldenInputs(), "2026-09");
  assert.equal(september.sales.recognizedRevenue, 380);
  assert.deepEqual(september.cogs.orders, { costed: 1, partial: 1, uncosted: 1, "no-product": 0 });
  assert.equal(september.cogs.productSales, 380);
  assert.equal(september.cogs.costedProductSales, 200);
  assert.equal(september.cogs.uncostedProductSales, 180);
  assert.equal(september.cogs.coverage, 200 / 380);
  assert.equal(september.cogs.isComplete, false);
  assert.equal(september.cogs.ingredientCogs, 133.33);
  assert.deepEqual(september.grossMargin, { value: null, withheld: "cost-coverage" }, "revenue minus an understated COGS would overstate profit");
  assert.deepEqual(september.operatingResult, { value: null, withheld: "pre-start" });
  assert.equal(september.cogs.costedSalesMargin, 66.67, "the like-for-like margin on costed sales is still reported, labelled as such");
  const coverageWarning = september.warnings.find((warning) => warning.code === "cost-coverage-incomplete");
  assert.ok(coverageWarning);
  assert.equal(coverageWarning.severity, "high");
  assert.equal(coverageWarning.count, 2);
  assert.equal(coverageWarning.amount, 180);
  assert.ok(codes(september.warnings).includes("pre-start-period"));
});

test("a single uncosted October order is enough to withhold October's result", () => {
  const inputs = buildGoldenInputs();
  inputs.cogsByOrderId.delete("O3");
  const october = buildMonthlyFinancialReport(inputs, "2026-10");
  assert.equal(october.cogs.isComplete, false);
  assert.deepEqual(october.grossMargin, { value: null, withheld: "cost-coverage" });
  assert.deepEqual(october.operatingResult, { value: null, withheld: "cost-coverage" });
});

test("a PHP 0 (giveaway) product order with no recorded cost still withholds the month; a costed one does not", () => {
  // Found in real data during acceptance: coverage measured in pesos calls a PHP 0 order "costed" because
  // 0 of 0 pesos is uncosted, so a product could leave the kitchen with no cost recorded and the margin
  // would still look complete.
  const inputs = buildGoldenInputs();
  inputs.orders.push(makeOrder({ id: "FREE", status: "completed", paymentStatus: "paid", paidAt: "2026-10-26T10:00:00+08:00", paidAmount: 0, completedAt: "2026-10-26T10:00:00+08:00" }));
  inputs.linesByOrderId.set("FREE", [makeLine("FREE", { itemName: "Free sample", productId: "brownie", piecesPerUnitSnapshot: 1, unitPrice: 0, quantity: 2 })]);
  const uncosted = buildMonthlyFinancialReport(inputs, "2026-10");
  assert.equal(uncosted.cogs.orders.uncosted, 1);
  assert.equal(uncosted.cogs.isComplete, false);
  assert.deepEqual(uncosted.grossMargin, { value: null, withheld: "cost-coverage" });
  assert.deepEqual(uncosted.operatingResult, { value: null, withheld: "cost-coverage" });
  const warning = uncosted.warnings.find((entry) => entry.code === "cost-coverage-incomplete");
  assert.ok(warning && warning.count === 1);
  assert.ok(!/PHP 0 of product sales/.test(warning.message), "do not claim 'PHP 0 of product sales' as the problem");

  inputs.cogsByOrderId.set("FREE", makeCogs("FREE", [{ lot: "lotA", productId: "brownie", pieces: 2, perPiece: BROWNIE_PER_PIECE }]));
  const costed = buildMonthlyFinancialReport(inputs, "2026-10");
  assert.equal(costed.cogs.isComplete, true);
  assert.equal(costed.cogs.orders.costed, 6);
  assert.equal(costed.cogs.ingredientCogs, 700, "633.33 + the giveaway's 2 x 33.33");
  assert.deepEqual(costed.grossMargin, { value: 500, withheld: null }, "1,200 revenue - 700");
});

test("a product line with no recorded pack size is uncosted product sales, not free", () => {
  const inputs = buildGoldenInputs();
  const order = makeOrder({ id: "NP", status: "completed", paymentStatus: "paid", paidAt: "2026-10-22T10:00:00+08:00", paidAmount: 90, completedAt: "2026-10-22T10:00:00+08:00" });
  inputs.orders.push(order);
  inputs.linesByOrderId.set("NP", [makeLine("NP", { itemName: "Custom brownie", productId: "brownie", piecesPerUnitSnapshot: null, unitPrice: 90, quantity: 1 })]);
  const october = buildMonthlyFinancialReport(inputs, "2026-10");
  assert.equal(october.cogs.uncostedProductSales, 90);
  assert.deepEqual(october.grossMargin, { value: null, withheld: "cost-coverage" });
});

// ---------------------------------------------------------------------------------------------------
// November: refunds, the Manila boundary, and months with nothing recorded
// ---------------------------------------------------------------------------------------------------

test("November: a refund of a completed order is contra-revenue in the refund month, not the original month", () => {
  const november = buildMonthlyFinancialReport(buildGoldenInputs(), "2026-11");
  assert.equal(november.sales.completedOrders, 1, "O4: 00:30 Manila on 1 Nov is NOVEMBER even though it is 31 Oct in UTC");
  assert.equal(november.sales.recognizedRevenue, 150);
  assert.equal(november.sales.refunds, 200);
  assert.equal(november.sales.netRevenue, -50);
  assert.equal(november.cogs.ingredientCogs, 100, "a refund does not give the ingredients back");
  assert.deepEqual(november.grossMargin, { value: -150, withheld: null });
  assert.deepEqual(november.cash, { received: 150, refunded: 200 });
  const october = buildMonthlyFinancialReport(buildGoldenInputs(), "2026-10");
  assert.equal(october.sales.recognizedRevenue, 1200, "the past month is not rewritten by a later refund");
});

test("a month with no expenses recorded says so instead of implying zero spend", () => {
  const november = buildMonthlyFinancialReport(buildGoldenInputs(), "2026-11");
  assert.equal(november.expenses.count, 0);
  assert.ok(codes(november.warnings).includes("no-expenses-recorded"));
  assert.deepEqual(november.operatingResult, { value: -150, withheld: null });
});

test("a refunded deposit on an order that never completed does not touch profit", () => {
  const october = buildMonthlyFinancialReport(buildGoldenInputs(), "2026-10");
  assert.ok(codes(october.warnings).includes("deposit-refund"));
  assert.equal(october.sales.refunds, 0);
  assert.equal(october.cash.refunded, 120, "but it is cash going out");
});

// ---------------------------------------------------------------------------------------------------
// Expenses: voided and corrected entries
// ---------------------------------------------------------------------------------------------------

test("a corrected expense counts once (the replacement), and the voided original is retained but not summed", () => {
  const september = buildMonthlyFinancialReport(buildGoldenInputs(), "2026-09");
  assert.equal(september.expenses.total, 950.5);
  assert.equal(september.expenses.count, 1);
  assert.equal(september.expenses.voidedCount, 1);
});

test("centavo sums are exact: 0.10 + 0.20 + 0.30 is 0.60, and a float-noisy stored payment is snapped, not carried", () => {
  const fees = buildMonthlyFinancialReport(buildGoldenInputs(), "2026-10").expenses.byCategory.find((entry) => entry.category === "fees");
  assert.equal(fees?.total, 0.6);
  assert.notEqual(0.1 + 0.2 + 0.3, 0.6, "sanity: plain doubles DO drift here");
  const inputs = buildGoldenInputs();
  inputs.orders.push(makeOrder({ id: "NOISE", status: "completed", paymentStatus: "paid", paidAt: "2026-10-23T10:00:00+08:00", paidAmount: 0.1 * 3, completedAt: "2026-10-23T10:00:00+08:00" }));
  inputs.linesByOrderId.set("NOISE", [makeLine("NOISE", { itemName: "Tiny", unitPrice: 0.1, quantity: 3 })]);
  const october = buildMonthlyFinancialReport(inputs, "2026-10");
  assert.equal(october.sales.recognizedRevenue, 1200.3);
  assert.equal(october.sales.collected, 1140.3);
});

test("expense totals are exact for amounts that DO drift in binary floating point", () => {
  // 4.35*100, 1.15*100, 0.07*100 and 8.2*100 are 434.99999999999994, 114.99999999999999, 7.000000000000001
  // and 819.9999999999999: a float sum is 1376.9999999999998, so the total would read 13.769999999999998.
  const amounts = [4.35, 1.15, 0.07, 8.2];
  assert.notEqual(amounts.reduce((total, amount) => total + amount * 100, 0) / 100, 13.77, "sanity: this data really drifts");
  const inputs = buildGoldenInputs();
  inputs.expenses = amounts.map((amount, index) => makeExpense({ id: `X${index}`, expenseDate: "2026-11-05", amount, category: "fees", payee: `Payee ${index}` }));
  const november = buildMonthlyFinancialReport(inputs, "2026-11");
  assert.equal(november.expenses.total, 13.77);
  assert.equal(november.expenses.byCategory[0].total, 13.77);
  assert.equal(november.operatingResult.value, -163.77, "-150 gross margin - 13.77 of expenses");
});

// ---------------------------------------------------------------------------------------------------
// Honesty about what is missing
// ---------------------------------------------------------------------------------------------------

test("every report discloses what its margin leaves out", () => {
  for (const month of ["2026-09", "2026-10", "2026-11"]) {
    const { exclusions } = buildMonthlyFinancialReport(buildGoldenInputs(), month);
    const text = exclusions.join(" ").toLowerCase();
    assert.deepEqual(exclusions, [...FINANCIAL_EXCLUSIONS]);
    for (const topic of ["packaging", "waste", "labor", "depreciation", "ingredients only"]) assert.ok(text.includes(topic), `${month} must disclose: ${topic}`);
  }
});

test("a result is withheld when its sources may be cut off, or the expense ledger could not be read", () => {
  const truncated = buildMonthlyFinancialReport({ ...buildGoldenInputs(), truncated: true }, "2026-10");
  assert.deepEqual(truncated.grossMargin, { value: null, withheld: "data-truncated" });
  assert.deepEqual(truncated.operatingResult, { value: null, withheld: "data-truncated" });
  assert.ok(codes(truncated.warnings).includes("data-truncated"));
  assert.equal(POSTGREST_ROW_CAP, 1000);

  const noLedger = buildMonthlyFinancialReport({ ...buildGoldenInputs(), expenses: null }, "2026-10");
  assert.deepEqual(noLedger.grossMargin, { value: 566.67, withheld: null }, "margin does not need the expense ledger");
  assert.deepEqual(noLedger.operatingResult, { value: null, withheld: "expenses-unavailable" });
  assert.equal(noLedger.expenses.available, false);
  assert.ok(codes(noLedger.warnings).includes("expenses-unavailable"));
});

test("a cut-off STOCK source warns about the memo and stock values, but does not withhold profit that never reads it", () => {
  const inputs = { ...buildGoldenInputs(), stockTruncated: true };
  const october = buildMonthlyFinancialReport(inputs, "2026-10");
  assert.ok(codes(october.warnings).includes("stock-data-truncated"));
  assert.deepEqual(october.operatingResult, { value: -917.76, withheld: null }, "profit does not read stock sources");
  const balances = buildFinancialBalances(inputs, NOW);
  assert.equal(balances.warnings.find((warning) => warning.code === "stock-data-truncated")?.severity, "high");
  assert.ok(!codes(buildMonthlyFinancialReport(buildGoldenInputs(), "2026-10").warnings).includes("stock-data-truncated"));
});

test("a completed order with no completion date is reported, not silently placed in a month", () => {
  const inputs = buildGoldenInputs();
  inputs.orders.push(makeOrder({ id: "UNDATED", status: "completed", paymentStatus: "paid", paidAt: "2026-10-23T10:00:00+08:00", paidAmount: 77 }));
  inputs.linesByOrderId.set("UNDATED", [makeLine("UNDATED", { itemName: "X", unitPrice: 77, quantity: 1 })]);
  const october = buildMonthlyFinancialReport(inputs, "2026-10");
  assert.equal(october.sales.recognizedRevenue, 1200, "not guessed into October");
  assert.ok(codes(october.warnings).includes("completed-order-without-date"));
});

test("a paid amount that differs from the line total is flagged and the amount actually paid is used", () => {
  const inputs = buildGoldenInputs();
  inputs.orders.push(makeOrder({ id: "DIFF", status: "completed", paymentStatus: "paid", paidAt: "2026-10-24T10:00:00+08:00", paidAmount: 90, completedAt: "2026-10-24T10:00:00+08:00" }));
  inputs.linesByOrderId.set("DIFF", [makeLine("DIFF", { itemName: "Cake", unitPrice: 100, quantity: 1 })]);
  const october = buildMonthlyFinancialReport(inputs, "2026-10");
  assert.equal(october.sales.recognizedRevenue, 1290, "uses the 90 actually paid");
  const warning = october.warnings.find((entry) => entry.code === "paid-amount-differs-from-lines");
  assert.ok(warning);
  assert.equal(warning.amount, 10);
});

// ---------------------------------------------------------------------------------------------------
// Balances: where things stand now
// ---------------------------------------------------------------------------------------------------

test("raw inventory values only stock whose cost is verified, and lists what it left out", () => {
  const { rawInventory, warnings } = buildFinancialBalances(buildGoldenInputs(), NOW);
  assert.equal(rawInventory.trustedValue, 900);
  assert.equal(rawInventory.trustedItemCount, 2);
  assert.equal(rawInventory.unverifiedValue, 800);
  assert.deepEqual(rawInventory.unverified.map((item) => item.name), ["Butter"]);
  assert.deepEqual(rawInventory.noCostItems, ["Cocoa"]);
  assert.deepEqual(rawInventory.negativeItems, ["Eggs"]);
  assert.ok(codes(warnings).includes("untrusted-inventory-cost") && codes(warnings).includes("negative-inventory"));
});

test("finished goods are valued per lot at each lot's frozen cost; estimated opening stock is identified", () => {
  const { finishedGoods, warnings } = buildFinancialBalances(buildGoldenInputs(), NOW);
  assert.deepEqual(finishedGoods, { pieces: 33, value: 608.33, estimatedValue: 300, lotCount: 3 });
  assert.ok(codes(warnings).includes("estimated-finished-goods-cost"));
  assert.equal(Math.round(BROWNIE_PER_PIECE * 1e9) / 1e9, 33.333333333);
});

test("receivables older than the threshold are flagged for the owner to validate", () => {
  const recent = buildFinancialBalances(buildGoldenInputs(), Date.parse("2026-10-20T10:00:00+08:00"));
  assert.equal(recent.receivables.staleCount, 0, "10 days old is within the window");
  assert.equal(recent.receivables.oldestDays, 10);
  assert.ok(!codes(recent.warnings).includes("stale-receivables"));
});


// ---------------------------------------------------------------------------------------------------
// Independent-review findings (acceptance round): estimated cost, line-less orders, refund ordering,
// fractional unit prices, manual-line severity.
// ---------------------------------------------------------------------------------------------------

function withOrder(inputs: ReturnType<typeof buildGoldenInputs>, id: string, lines: Parameters<typeof makeLine>[1][], cogsLots: Parameters<typeof makeCogs>[1] | null, overrides: Parameters<typeof makeOrder>[0] extends infer O ? Partial<O> : never = {}) {
  const total = lines.reduce((sum, line) => sum + line.unitPrice * line.quantity, 0);
  inputs.orders.push(makeOrder({ id, status: "completed", paymentStatus: "paid", paidAt: "2026-10-27T10:00:00+08:00", paidAmount: total, completedAt: "2026-10-27T10:00:00+08:00", ...overrides }));
  inputs.linesByOrderId.set(id, lines.map((line) => makeLine(id, line)));
  if (cogsLots) inputs.cogsByOrderId.set(id, makeCogs(id, cogsLots));
}

test("cost drawn from an ESTIMATED lot is counted but disclosed with its amount, and never reads as recorded cost", () => {
  // Found in real production data: opening-balance lots carry a costing ESTIMATE and are the oldest lots, so
  // early post-tracking sales draw on them. lotC (historical_estimate) is 10 brownies at an estimated 30.00.
  const inputs = buildGoldenInputs();
  withOrder(inputs, "EST", [{ itemName: "Brownie", productId: "brownie", piecesPerUnitSnapshot: 1, unitPrice: 50, quantity: 6 }], [{ lot: "lotC", productId: "brownie", pieces: 6, perPiece: 30 }]);
  const october = buildMonthlyFinancialReport(inputs, "2026-10");
  assert.equal(october.cogs.estimatedCogs, 180);
  assert.equal(october.cogs.estimatedOrders, 1);
  assert.equal(october.cogs.ingredientCogs, 633.33 + 180, "it is still cost, so the margin stays honest about it");
  assert.equal(october.cogs.isComplete, true);
  const warning = october.warnings.find((entry) => entry.code === "estimated-cost-in-cogs");
  assert.ok(warning && warning.severity === "high" && warning.amount === 180 && warning.count === 1);
  assert.ok(!codes(buildMonthlyFinancialReport(buildGoldenInputs(), "2026-10").warnings).includes("estimated-cost-in-cogs"), "no warning when none is estimated");
});

test("a lot with a zero cost, or one the report cannot see, is NOT recorded cost: the month is withheld", () => {
  for (const [name, perPiece, lotsFn] of [
    ["zero-cost lot", 0, (lots: ReturnType<typeof buildGoldenInputs>["productionExecutions"]) => lots.map((lot) => (lot.id === "lotA" ? { ...lot, frozenCostPerPiece: 0 } : lot))],
    ["unknown lot", BROWNIE_PER_PIECE, (lots: ReturnType<typeof buildGoldenInputs>["productionExecutions"]) => lots.filter((lot) => lot.id !== "lotA")],
  ] as const) {
    const inputs = buildGoldenInputs();
    inputs.productionExecutions = lotsFn(inputs.productionExecutions);
    void perPiece;
    const october = buildMonthlyFinancialReport(inputs, "2026-10");
    assert.equal(october.cogs.isComplete, false, name);
    assert.deepEqual(october.grossMargin, { value: null, withheld: "cost-coverage" }, name);
    assert.deepEqual(october.operatingResult, { value: null, withheld: "cost-coverage" }, name);
  }
});

test("a completed order with revenue but no loaded lines withholds the month instead of passing as cost-free", () => {
  const inputs = buildGoldenInputs();
  inputs.orders.push(makeOrder({ id: "NOLINES", status: "completed", paymentStatus: "paid", paidAt: "2026-10-25T10:00:00+08:00", paidAmount: 5000, completedAt: "2026-10-25T10:00:00+08:00" }));
  const october = buildMonthlyFinancialReport(inputs, "2026-10");
  assert.equal(october.cogs.isComplete, false);
  assert.deepEqual(october.grossMargin, { value: null, withheld: "cost-coverage" });
  const warning = october.warnings.find((entry) => entry.code === "completed-order-without-lines");
  assert.ok(warning && warning.severity === "high");
  assert.equal(october.cogs.orders["no-product"], 0, "it is not counted as a fully costed order");
});

test("an order refunded BEFORE it was completed does not book contra-revenue and withholds the month for review", () => {
  const inputs = buildGoldenInputs();
  // paid 300 on 10 Sep, deposit refunded 20 Sep, completed 5 Oct with paid_amount retained.
  withOrder(inputs, "RBC", [{ itemName: "Brownie", productId: "brownie", piecesPerUnitSnapshot: 1, unitPrice: 50, quantity: 6 }], [{ lot: "lotA", productId: "brownie", pieces: 6, perPiece: BROWNIE_PER_PIECE }],
    { paymentStatus: "refunded", paidAt: "2026-09-10T10:00:00+08:00", refundedAt: "2026-09-20T10:00:00+08:00", completedAt: "2026-10-05T10:00:00+08:00", paidAmount: 300 });
  const september = buildMonthlyFinancialReport(inputs, "2026-09");
  assert.equal(september.sales.refunds, 0, "a deposit refund is not contra-revenue");
  assert.ok(codes(september.warnings).includes("deposit-refund"));
  const october = buildMonthlyFinancialReport(inputs, "2026-10");
  assert.deepEqual(october.grossMargin, { value: null, withheld: "needs-review" });
  assert.ok(october.warnings.some((entry) => entry.code === "refund-before-completion" && entry.severity === "high" && entry.count === 1));
  // The ordinary ordering (completed, THEN refunded) is unchanged.
  assert.equal(buildMonthlyFinancialReport(buildGoldenInputs(), "2026-11").sales.refunds, 200);
});

test("an unpaid order priced at a fractional-centavo unit price is rounded once, on the line total", () => {
  const inputs = buildGoldenInputs();
  withOrder(inputs, "FRAC", [{ itemName: "Bulk", unitPrice: 33.335, quantity: 3 }], null, { paymentStatus: "unpaid", paidAt: null, paidAmount: null });
  const october = buildMonthlyFinancialReport(inputs, "2026-10");
  // October already holds O3's 60.00 receivable; this adds 33.335 x 3 = 100.005 -> 100.01 (one rounding, not 100.02).
  assert.equal(october.sales.receivable, 160.01);
});

test("manual-line revenue is an info note when small and a medium warning once it is 10% or more of the month", () => {
  const small = buildMonthlyFinancialReport(buildGoldenInputs(), "2026-10").warnings.find((entry) => entry.code === "manual-line-sales");
  assert.equal(small?.severity, "info");
  const inputs = buildGoldenInputs();
  withOrder(inputs, "CAKE", [{ itemName: "Custom wedding cake", unitPrice: 4000, quantity: 1 }], null);
  const large = buildMonthlyFinancialReport(inputs, "2026-10").warnings.find((entry) => entry.code === "manual-line-sales");
  assert.equal(large?.severity, "medium");
});

test("two lines of the same product are summed against the lots, and a partly fulfilled order is under-covered", () => {
  const inputs = buildGoldenInputs();
  withOrder(inputs, "TWO", [
    { itemName: "Brownie", productId: "brownie", piecesPerUnitSnapshot: 1, unitPrice: 50, quantity: 3 },
    { itemName: "Brownie again", productId: "brownie", piecesPerUnitSnapshot: 1, unitPrice: 50, quantity: 3 },
  ], [{ lot: "lotA", productId: "brownie", pieces: 3, perPiece: BROWNIE_PER_PIECE }]);
  const partial = buildMonthlyFinancialReport(inputs, "2026-10");
  assert.equal(partial.cogs.orders.uncosted, 1, "6 pieces needed, only 3 fulfilled");
  assert.equal(partial.cogs.isComplete, false);
  inputs.cogsByOrderId.set("TWO", makeCogs("TWO", [{ lot: "lotA", productId: "brownie", pieces: 6, perPiece: BROWNIE_PER_PIECE }]));
  assert.equal(buildMonthlyFinancialReport(inputs, "2026-10").cogs.isComplete, true);
});


test("empty stock state (not loaded) warns loudly, and ingredient cost cannot pass as verified", () => {
  const inputs = { ...buildGoldenInputs(), ingredients: [], productionExecutions: [], finishedStockMovements: [], supplies: [] };
  const october = buildMonthlyFinancialReport(inputs, "2026-10");
  assert.ok(october.warnings.some((entry) => entry.code === "stock-data-missing" && entry.severity === "high"));
  assert.deepEqual(october.grossMargin, { value: null, withheld: "cost-coverage" }, "with no lots to vouch for the cost, the margin is withheld");
  assert.ok(buildFinancialBalances(inputs, NOW).warnings.some((entry) => entry.code === "stock-data-missing"));
  assert.ok(!codes(buildFinancialBalances(buildGoldenInputs(), NOW).warnings).includes("stock-data-missing"));
});

// ---------------------------------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------------------------------

test("the report module is pure and never touches purchases when computing profit", () => {
  const source = readFileSync(path.join(import.meta.dirname, "../src/lib/finance/report.ts"), "utf8");
  assert.ok(!/from "react"|supabase|Date\.now\(|new Date\(\)/.test(source), "no React, no client, no clock");
  const computation = source.slice(source.indexOf("// --- Results, withheld rather than guessed"), source.indexOf("// --- Warnings"));
  assert.ok(!/supplies|purchase/i.test(computation), "the result computation never reads purchases");
});

test("the month selector starts at the earliest recorded activity", () => {
  assert.equal(earliestRecordedMonth(buildGoldenInputs(), "2026-11"), "2026-09");
  assert.equal(earliestRecordedMonth({ orders: [], expenses: null }, "2026-11"), "2026-11");
});

test("an order set with no activity produces zeros, a clear message, and no invented figures", () => {
  const empty: FinanceInputs = { ...buildGoldenInputs(), orders: [], linesByOrderId: new Map(), cogsByOrderId: new Map(), expenses: [], supplies: [] };
  const month = buildMonthlyFinancialReport(empty, "2026-10");
  assert.equal(month.sales.recognizedRevenue, 0);
  assert.equal(month.cogs.coverage, null);
  assert.ok(codes(month.warnings).includes("no-completed-orders"));
  assert.deepEqual(month.operatingResult, { value: 0, withheld: null });
});
