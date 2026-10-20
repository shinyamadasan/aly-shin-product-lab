// Monthly financial report, computed from sales, expense records and automatic stock attribution.
//
// PURE. No React, no Supabase, no clock: `timeZone` and every date arrive as parameters, so the same
// inputs always give the same report and a test can pin any month. It composes the existing owners
// and reproduces none of them -- cash received comes from orders/revenue.ts, an order's line total
// from orders/totals.ts, COGS from the order_raw_cogs view (Wave 3), stock from the finished-stock
// ledger. If a number here disagrees with one of those, this file is wrong.
//
// THE ACCOUNTING RULES (Release 1 sales basis plus Release 2 stock attribution):
//   * ACCRUAL AT FULFILMENT. An order is revenue in the Manila month it was COMPLETED, not the month
//     it was paid. Its ingredient COGS lands in that same month, so revenue and cost always meet.
//   * A paid order that is not yet completed is a customer DEPOSIT, not revenue. A completed order
//     that is unpaid is a RECEIVABLE: recognized now, collected later.
//   * Revenue is the order's frozen paid_amount when paid, else its line total.
//   * A refund of a COMPLETED order is contra-revenue in the month the refund happened (the past
//     month is never rewritten). A refund of an order that never completed returns a deposit, which
//     was never revenue, so it does not touch profit.
//   * Inventory PURCHASES are an asset and appear only as an "inventory purchases" memo line. They
//     reach profit only as COGS when an order is fulfilled. Baking moves cost into finished goods
//     without touching profit. COGS is read ONLY from fulfilled allocations (order_raw_cogs), never
//     from Bake consumption, so a Bake cannot be counted twice.
//   * Non-sale stock events arrive already valued/classified by the stock_financial_events view.
//     Business losses, samples and testing reduce operating result; household withdrawals do not.
//   * Owner's unpaid labor is not an expense. Product-costing ESTIMATES (labor, utilities, overhead)
//     are never substituted for real expenses; only recorded business_expenses count.
//
// WHAT IS WITHHELD, NOT GUESSED:
//   * If any of a month's product sales has no recorded ingredient cost, the gross margin and
//     operating result are WITHHELD (value null). Revenue minus an understated COGS looks like a
//     bigger profit than there is; showing it would be a plausible-looking wrong number. The like-for-
//     like margin on the sales that DO have a cost is shown instead, labelled as such.
//   * Before FINANCIAL_REPORTING_START_MONTH no operating result exists (expenses were not tracked).
//   * If a result needs data that failed to load or was cut off by the row cap, it is withheld.
//
// Every report carries a fixed list of EXCLUSIONS (packaging, labor, ...) so a reader cannot
// mistake an ingredient-only margin for a complete profit.

import type { Ingredient, FinishedStockMovement, OrderRawCogs, ProductionExecution, SupplyEntry } from "../product-lab-types.ts";
import { BUSINESS_TIMEZONE, resolveBusinessDay } from "../business-day.ts";
import { grossRevenue, refunds, type BusinessDayRange } from "../orders/revenue.ts";
import type { Order, OrderLine } from "../orders/types.ts";
import { isLiveExpense, type BusinessExpense, type ExpenseCategory } from "./expenses.ts";
import { daysBetweenDays, FINANCIAL_REPORTING_START_MONTH, monthKeyOfDay, monthKeyOfTimestamp, monthRange } from "./period.ts";
import { fromCentavos, roundToCentavo, toCentavos } from "./peso.ts";
import { summarizeStockFinancialEvents, type MonthlyStockAttribution, type StockFinancialEvent } from "./stock-events.ts";

// A completed order unpaid for longer than this is flagged for the owner to validate.
export const STALE_RECEIVABLE_DAYS = 14;

// PostgREST returns at most this many rows per request unless configured otherwise. A result that
// hits it may be cut off, which the report must say rather than silently under-count.
export const POSTGREST_ROW_CAP = 1000;

export type FinanceInputs = {
  orders: Order[];
  // Lines and COGS are loaded for COMPLETED orders (the only ones that carry revenue or COGS).
  linesByOrderId: Map<string, OrderLine[]>;
  cogsByOrderId: Map<string, OrderRawCogs>;
  // null = the expense ledger could not be read (table not applied yet, or the read failed).
  expenses: BusinessExpense[] | null;
  // Independent read: null means unavailable, not an empty ledger. Bake/orders/opening are excluded.
  stockFinancialEvents: StockFinancialEvent[] | null;
  stockEventsTruncated: boolean;
  supplies: SupplyEntry[];
  ingredients: Ingredient[];
  productionExecutions: ProductionExecution[];
  finishedStockMovements: FinishedStockMovement[];
  // True when a SALES or EXPENSE source hit POSTGREST_ROW_CAP and may be incomplete: the result is withheld.
  truncated: boolean;
  // True when a STOCK source (purchases, ingredients, production lots, stock movements) hit the cap: the
  // purchases memo and the stock values may be understated, which the page says. Profit does not read them.
  stockTruncated: boolean;
};

export type WarningSeverity = "high" | "medium" | "info";

export type FinancialWarning = {
  code:
    | "cost-coverage-incomplete"
    | "manual-line-sales"
    | "paid-amount-differs-from-lines"
    | "completed-order-without-date"
    | "completed-order-without-lines"
    | "pre-start-period"
    | "no-expenses-recorded"
    | "expenses-unavailable"
    | "data-truncated"
    | "stock-data-truncated"
    | "stock-data-missing"
    | "estimated-cost-in-cogs"
    | "refund-before-completion"
    | "stale-receivables"
    | "cancelled-paid-not-refunded"
    | "deposit-refund"
    | "no-completed-orders"
    | "untrusted-inventory-cost"
    | "negative-inventory"
    | "estimated-finished-goods-cost"
    | "stock-events-unavailable"
    | "stock-events-truncated"
    | "stock-events-review"
    | "stock-count-valuation"
    | "estimated-stock-event-cost";
  severity: WarningSeverity;
  message: string;
  count?: number;
  amount?: number;
};

export type WithheldReason = "cost-coverage" | "needs-review" | "pre-start" | "expenses-unavailable" | "data-truncated" | "stock-events-unavailable" | "stock-events-truncated" | "stock-events-review";

// A reported figure is either a number or an explicit reason it is not shown. Never both.
export type Figure = { value: number; withheld: null } | { value: null; withheld: WithheldReason };

export type OrderCostClass = "costed" | "partial" | "uncosted" | "no-product";

export type ExpenseCategoryTotal = { category: ExpenseCategory; total: number; count: number };

export type MonthlyFinancialReport = {
  month: string;
  basis: "accrual-at-fulfilment";
  isBeforeReportingStart: boolean;
  sales: {
    completedOrders: number;
    // Revenue recognized for orders completed in the month (paid_amount when paid, else line total).
    recognizedRevenue: number;
    // The part of it already backed by a payment, and the part still owed (receivable).
    collected: number;
    receivable: number;
    // Contra-revenue: refunds, in this month, of orders that had completed.
    refunds: number;
    netRevenue: number;
  };
  cogs: {
    ingredientCogs: number;
    // The part of ingredientCogs that is a costing ESTIMATE (stock counted when tracking began, not baked
    // in the app), and how many orders drew on it. Never presented as recorded cost.
    estimatedCogs: number;
    estimatedOrders: number;
    orders: Record<OrderCostClass, number>;
    productSales: number;
    costedProductSales: number;
    uncostedProductSales: number;
    manualLineSales: number;
    // costedProductSales / productSales, 0..1. null when there were no product sales.
    coverage: number | null;
    isComplete: boolean;
    // Like-for-like: sales that DO have a recorded cost, less that cost. Always shown, because it is
    // honest even when the headline margin is withheld.
    costedSalesMargin: number;
  };
  expenses: { available: boolean; total: number; count: number; voidedCount: number; byCategory: ExpenseCategoryTotal[] };
  stockAttribution: MonthlyStockAttribution;
  grossMargin: Figure;
  operatingResult: Figure;
  // Memo lines. NOT part of profit.
  cash: { received: number; refunded: number };
  inventoryPurchases: { total: number; count: number };
  warnings: FinancialWarning[];
  exclusions: string[];
};

// Fixed disclosures shown with every month. Phrased as facts about what the figure leaves out.
export const FINANCIAL_EXCLUSIONS: readonly string[] = [
  "Packaging cost is not in COGS yet. Packaging is bought as stock but never deducted when an order is fulfilled, so margin is overstated by that amount.",
  "COGS is ingredients only, at the cost frozen when each batch was baked. If a batch's actual yield is corrected later, its cost per piece is restated, and so are the months that sold from it.",
  "Collected and unpaid amounts show payment status as of today, even for past months. Revenue uses the amount actually paid.",
  "Recorded stock spoilage/waste, marketing samples and business testing reduce the operating result automatically. Household withdrawals are separate. Unclassified corrections and unvalued losses or withdrawals withhold the result. Verified count gains create no expense or income and retain an unverified inventory valuation warning; no historical amount is invented.",
  "Finished-stock event cost uses allocated lots and is restated when Bake yield or cost is corrected, including past months. Raw events use their recorded cost-at-event snapshot, never today's average cost.",
  "Your own unpaid labor is not counted as an expense. Product-costing estimates (labor, utilities, overhead) are never used as real expenses.",
  "Equipment bought is expensed in full when recorded; there is no depreciation yet. Income tax and financing costs are not tracked.",
  "Delivery, fees, rent and the like appear only if you recorded them as expenses.",
];

type OrderRecognition = {
  order: Order;
  revenueCentavos: number;
  linesTotalCentavos: number;
  isPaid: boolean;
  hasLines: boolean;
  cost: OrderCostSplit;
};

type OrderCostSplit = {
  cls: OrderCostClass;
  productSalesCentavos: number;
  costedProductSalesCentavos: number;
  manualLineSalesCentavos: number;
  // Cost of this order's pieces that came from ESTIMATED lots.
  estimatedCogs: number;
};

// What the report may trust about a production lot. A lot the report cannot see, or one frozen at a zero
// cost, is not evidence of cost; a historical-estimate lot is cost, but an ESTIMATE, and is disclosed.
type LotTrust = { estimated: boolean };

function buildLotTrust(lots: FinanceInputs["productionExecutions"]): Map<string, LotTrust> {
  const trust = new Map<string, LotTrust>();
  for (const lot of lots) {
    if (lot.frozenCostPerPiece > 0) trust.set(lot.id, { estimated: lot.costBasisSource === "historical_estimate" });
  }
  return trust;
}

// unit_price is stored at full precision (33.335 is legal), so round the LINE TOTAL once, never the unit.
function lineTotalCentavos(line: OrderLine): number {
  return Math.round(line.unitPrice * line.quantity * 100);
}

// How much of an order's PRODUCT sales has a recorded ingredient cost.
//
//   * A line with a product and a recorded pack size is "stock-tracked": it needs
//     quantity x pieces of that product to appear in the order's fulfilled COGS lots.
//   * A line with a product but NO recorded pack size can never have a cost (nothing was reserved),
//     so it counts as uncosted product sales -- not as free.
//   * A line with no product (a delivery fee, a custom item) is "manual": no product cost is tracked
//     for it, reported separately and disclosed, and excluded from the coverage ratio.
function splitOrderCost(lines: OrderLine[], cogs: OrderRawCogs | undefined, lotTrust: Map<string, LotTrust>): OrderCostSplit {
  const requiredPieces = new Map<string, number>();
  const trackedSalesByProduct = new Map<string, number>();
  let productSales = 0;
  let manualSales = 0;
  let productLineCount = 0;
  // Product lines with no recorded pack size can never have a cost (nothing was reserved for them).
  let unsizedProductLines = 0;

  for (const line of lines) {
    const sales = lineTotalCentavos(line);
    if (!line.productId) {
      manualSales += sales;
      continue;
    }
    productLineCount += 1;
    productSales += sales;
    if (line.piecesPerUnitSnapshot === null) {
      unsizedProductLines += 1;
    } else {
      requiredPieces.set(line.productId, (requiredPieces.get(line.productId) ?? 0) + line.quantity * line.piecesPerUnitSnapshot);
      trackedSalesByProduct.set(line.productId, (trackedSalesByProduct.get(line.productId) ?? 0) + sales);
    }
  }

  // Only pieces from lots with a trustworthy positive cost count as costed.
  const fulfilledPieces = new Map<string, number>();
  let estimatedCogs = 0;
  for (const lot of cogs?.lots ?? []) {
    const trust = lotTrust.get(lot.productionExecutionId);
    if (!trust) continue;
    fulfilledPieces.set(lot.productId, (fulfilledPieces.get(lot.productId) ?? 0) + lot.fulfilledPieces);
    if (trust.estimated) estimatedCogs += lot.lotRawCogs;
  }

  let costedSales = 0;
  let underCostedProducts = 0;
  for (const [productId, required] of requiredPieces) {
    if ((fulfilledPieces.get(productId) ?? 0) >= required) {
      costedSales += trackedSalesByProduct.get(productId) ?? 0;
    } else {
      underCostedProducts += 1;
    }
  }

  // Completeness is decided by WHAT LEFT THE KITCHEN, not by pesos: a PHP 0 giveaway with no recorded
  // cost has 0 uncosted pesos, and a peso test would call it costed and let the margin look complete.
  // Money is used only to tell "partial" from "uncosted" and to size the coverage ratio.
  const uncostedUnits = unsizedProductLines + underCostedProducts;
  const cls: OrderCostClass =
    productLineCount === 0 ? "no-product" : uncostedUnits === 0 ? "costed" : costedSales === 0 ? "uncosted" : "partial";
  return { cls, productSalesCentavos: productSales, costedProductSalesCentavos: costedSales, manualLineSalesCentavos: manualSales, estimatedCogs };
}

function recognize(order: Order, linesByOrderId: Map<string, OrderLine[]>, cogsByOrderId: Map<string, OrderRawCogs>, lotTrust: Map<string, LotTrust>): OrderRecognition {
  const lines = linesByOrderId.get(order.id) ?? [];
  const linesTotalCentavos = lines.reduce((total, line) => total + lineTotalCentavos(line), 0);
  const isPaid = order.paidAmount !== null;
  return {
    order,
    revenueCentavos: isPaid ? toCentavos(order.paidAmount as number) : linesTotalCentavos,
    linesTotalCentavos,
    isPaid,
    hasLines: lines.length > 0,
    // An order with no lines has no knowable cost: it is incomplete data, never "fully costed".
    cost: lines.length === 0
      ? { cls: "uncosted", productSalesCentavos: 0, costedProductSalesCentavos: 0, manualLineSalesCentavos: 0, estimatedCogs: 0 }
      : splitOrderCost(lines, cogsByOrderId.get(order.id), lotTrust),
  };
}

function groupExpensesByCategory(live: BusinessExpense[]): ExpenseCategoryTotal[] {
  const totals = new Map<ExpenseCategory, { centavos: number; count: number }>();
  for (const expense of live) {
    const entry = totals.get(expense.category) ?? { centavos: 0, count: 0 };
    entry.centavos += toCentavos(expense.amount);
    entry.count += 1;
    totals.set(expense.category, entry);
  }
  return [...totals.entries()]
    .map(([category, entry]) => ({ category, total: fromCentavos(entry.centavos), count: entry.count }))
    .sort((a, b) => b.total - a.total || a.category.localeCompare(b.category));
}

// Stock records come from the app's own state, which loads separately from the sales read. If it failed or has
// not arrived, the purchases memo and stock values are empty -- a convincing PHP 0 that means "not loaded".
function stockDataMissing(inputs: FinanceInputs): boolean {
  return inputs.ingredients.length === 0 && inputs.productionExecutions.length === 0 && inputs.finishedStockMovements.length === 0;
}

export function buildMonthlyFinancialReport(inputs: FinanceInputs, month: string, timeZone: string = BUSINESS_TIMEZONE): MonthlyFinancialReport {
  const range: BusinessDayRange = monthRange(month, timeZone);
  const isBeforeReportingStart = month < FINANCIAL_REPORTING_START_MONTH;
  const warnings: FinancialWarning[] = [];
  const lotTrust = buildLotTrust(inputs.productionExecutions);

  // --- Sales: recognized when the order was completed ------------------------------------------
  const recognized: OrderRecognition[] = [];
  let undatedCompleted = 0;
  for (const order of inputs.orders) {
    if (order.status !== "completed") continue;
    const completedMonth = monthKeyOfTimestamp(order.completedAt, timeZone);
    if (completedMonth === null) {
      undatedCompleted += 1;
      continue;
    }
    if (completedMonth === month) recognized.push(recognize(order, inputs.linesByOrderId, inputs.cogsByOrderId, lotTrust));
  }

  const recognizedCentavos = recognized.reduce((total, entry) => total + entry.revenueCentavos, 0);
  const collectedCentavos = recognized.filter((entry) => entry.isPaid).reduce((total, entry) => total + entry.revenueCentavos, 0);
  const receivableCentavos = recognizedCentavos - collectedCentavos;

  // Refund of an order that HAD completed: contra-revenue in the refund's own month.
  let refundCentavos = 0;
  let depositRefundCentavos = 0;
  let depositRefundCount = 0;
  for (const order of inputs.orders) {
    if (monthKeyOfTimestamp(order.refundedAt, timeZone) !== month || order.paidAmount === null) continue;
    // Contra-revenue only when the order had ALREADY completed when the money went back. A refund that
    // came first returned a deposit; the later completion is flagged for review below.
    const completedFirst = order.status === "completed" && order.completedAt !== null && Date.parse(order.completedAt) <= Date.parse(order.refundedAt as string);
    if (completedFirst) {
      refundCentavos += toCentavos(order.paidAmount);
    } else {
      depositRefundCentavos += toCentavos(order.paidAmount);
      depositRefundCount += 1;
    }
  }
  const netCentavos = recognizedCentavos - refundCentavos;
  const refundedBeforeCompletion = recognized.filter((entry) => entry.order.refundedAt !== null && Date.parse(entry.order.refundedAt) < Date.parse(entry.order.completedAt as string));

  // --- COGS and coverage -----------------------------------------------------------------------
  const orderClasses: Record<OrderCostClass, number> = { costed: 0, partial: 0, uncosted: 0, "no-product": 0 };
  let productSales = 0;
  let costedProductSales = 0;
  let manualLineSales = 0;
  let ingredientCogs = 0;
  let estimatedCogs = 0;
  let estimatedOrders = 0;
  for (const entry of recognized) {
    orderClasses[entry.cost.cls] += 1;
    productSales += entry.cost.productSalesCentavos;
    costedProductSales += entry.cost.costedProductSalesCentavos;
    manualLineSales += entry.cost.manualLineSalesCentavos;
    ingredientCogs += inputs.cogsByOrderId.get(entry.order.id)?.rawProductionCogs ?? 0;
    if (entry.cost.estimatedCogs > 0) {
      estimatedCogs += entry.cost.estimatedCogs;
      estimatedOrders += 1;
    }
  }
  const uncostedProductSales = productSales - costedProductSales;
  const coverageComplete = orderClasses.uncosted + orderClasses.partial === 0;
  const coverage = productSales > 0 ? costedProductSales / productSales : null;

  // --- Operating expenses ----------------------------------------------------------------------
  const expensesAvailable = inputs.expenses !== null;
  const monthExpenses = (inputs.expenses ?? []).filter((expense) => monthKeyOfDay(expense.expenseDate) === month);
  const live = monthExpenses.filter(isLiveExpense);
  const expenseCentavos = live.reduce((total, expense) => total + toCentavos(expense.amount), 0);
  const stockAttribution = summarizeStockFinancialEvents(inputs.stockFinancialEvents, inputs.stockEventsTruncated, month, timeZone);

  // --- Memo lines (not profit) -----------------------------------------------------------------
  const purchases = inputs.supplies.filter((supply) => monthKeyOfDay(supply.purchaseDate) === month);
  const purchaseCentavos = purchases.reduce((total, supply) => total + toCentavos(supply.totalCost), 0);

  // --- Results, withheld rather than guessed ---------------------------------------------------
  const ingredientCogsRounded = roundToCentavo(ingredientCogs);
  let grossMargin: Figure;
  if (inputs.truncated) {
    grossMargin = { value: null, withheld: "data-truncated" };
  } else if (!coverageComplete) {
    grossMargin = { value: null, withheld: "cost-coverage" };
  } else if (refundedBeforeCompletion.length > 0) {
    grossMargin = { value: null, withheld: "needs-review" };
  } else {
    grossMargin = { value: roundToCentavo(fromCentavos(netCentavos) - ingredientCogs), withheld: null };
  }

  let operatingResult: Figure;
  if (inputs.truncated) {
    operatingResult = { value: null, withheld: "data-truncated" };
  } else if (isBeforeReportingStart) {
    operatingResult = { value: null, withheld: "pre-start" };
  } else if (grossMargin.value === null) {
    operatingResult = { value: null, withheld: grossMargin.withheld };
  } else if (!expensesAvailable) {
    operatingResult = { value: null, withheld: "expenses-unavailable" };
  } else if (!stockAttribution.available) {
    operatingResult = { value: null, withheld: "stock-events-unavailable" };
  } else if (stockAttribution.truncated) {
    operatingResult = { value: null, withheld: "stock-events-truncated" };
  } else if (stockAttribution.operatingCost === null) {
    operatingResult = { value: null, withheld: "stock-events-review" };
  } else {
    // Use full-precision lot costs, not the rounded display margin or category figures.
    operatingResult = { value: roundToCentavo(fromCentavos(netCentavos) - ingredientCogs - fromCentavos(expenseCentavos) - stockAttribution.operatingCost), withheld: null };
  }

  // --- Warnings --------------------------------------------------------------------------------
  if (!stockAttribution.available) {
    warnings.push({ code: "stock-events-unavailable", severity: "high", message: "Stock losses and withdrawals could not be loaded. The operating result is withheld; sales gross margin does not include these events." });
  } else if (stockAttribution.truncated) {
    warnings.push({ code: "stock-events-truncated", severity: "high", message: `Stock financial events reached the ${POSTGREST_ROW_CAP}-row limit. Category totals and the operating result are withheld; the review list may be incomplete.` });
  }
  if (stockAttribution.review.length > 0) {
    warnings.push({ code: "stock-events-review", severity: "high", message: `${stockAttribution.review.length} stock event rows are unclassified or have no trustworthy cost. Review their source below. Classifying an event cannot invent its missing cost. The operating result is withheld.`, count: stockAttribution.review.length });
  }
  if (stockAttribution.byCategory.some((category) => category.estimatedCount > 0)) {
    warnings.push({ code: "estimated-stock-event-cost", severity: "medium", message: "Some stock event costs are estimates from historical opening lots. The category breakdown labels these estimates; the operating result is provisional." });
  }
  if (stockAttribution.unvaluedCountGains.length > 0) {
    warnings.push({ code: "stock-count-valuation", severity: "medium", message: `${stockAttribution.unvaluedCountGains.length} verified stock-count increases have no trustworthy historical valuation. They create no operating expense or income and do not alone withhold the operating result. Inventory valuation remains unverified.`, count: stockAttribution.unvaluedCountGains.length });
  }
  if (inputs.truncated) {
    warnings.push({ code: "data-truncated", severity: "high", message: `A source returned ${POSTGREST_ROW_CAP} rows, the most one request returns, so figures may be incomplete. No result is shown.` });
  }
  if (inputs.stockTruncated) {
    warnings.push({ code: "stock-data-truncated", severity: "medium", message: `Purchases or stock records reached the ${POSTGREST_ROW_CAP}-row limit, so the purchases memo and stock values may be understated. Profit does not use them.` });
  }
  if (stockDataMissing(inputs)) {
    warnings.push({ code: "stock-data-missing", severity: "high", message: "No stock or production records are loaded, so ingredient cost cannot be verified and the purchases memo may read zero because nothing loaded. Reload the page." });
  }
  if (isBeforeReportingStart) {
    warnings.push({ code: "pre-start-period", severity: "medium", message: `Operating expenses were not tracked before ${FINANCIAL_REPORTING_START_MONTH}, so no operating result is shown for this month. Sales and ingredient cost are shown for reference only.` });
  }
  if (!coverageComplete) {
    const uncostedOrders = orderClasses.uncosted + orderClasses.partial;
    warnings.push({
      code: "cost-coverage-incomplete",
      severity: "high",
      message: `${uncostedOrders} of ${recognized.length} completed orders include products with no recorded ingredient cost${uncostedProductSales > 0 ? ` (PHP ${roundToCentavo(fromCentavos(uncostedProductSales))} of product sales)` : ""}. Margin and result are withheld because they would be overstated.`,
      count: uncostedOrders,
      amount: fromCentavos(uncostedProductSales),
    });
  }
  if (estimatedCogs > 0) {
    warnings.push({
      code: "estimated-cost-in-cogs",
      severity: "high",
      message: `PHP ${roundToCentavo(estimatedCogs)} of this month's ingredient cost is an ESTIMATE, from ${estimatedOrders} orders that sold stock counted when tracking began rather than baked in the app. The margin is only as reliable as that estimate.`,
      count: estimatedOrders,
      amount: roundToCentavo(estimatedCogs),
    });
  }
  if (refundedBeforeCompletion.length > 0) {
    warnings.push({ code: "refund-before-completion", severity: "high", message: `${refundedBeforeCompletion.length} orders were refunded before they were completed, so their revenue is unclear. Margin and result are withheld until you review them in Orders.`, count: refundedBeforeCompletion.length });
  }
  if (manualLineSales > 0) {
    // Manual lines carry no product cost. Small ones (delivery fees) are a note; a large share is not.
    const manualShareIsLarge = manualLineSales * 10 >= recognizedCentavos;
    warnings.push({ code: "manual-line-sales", severity: manualShareIsLarge ? "medium" : "info", message: "Some revenue comes from manual lines (for example delivery fees or custom items) that have no product cost tracked. It is counted as revenue with no cost.", amount: fromCentavos(manualLineSales) });
  }
  const divergent = recognized.filter((entry) => entry.isPaid && entry.hasLines && entry.revenueCentavos !== entry.linesTotalCentavos);
  if (divergent.length > 0) {
    warnings.push({ code: "paid-amount-differs-from-lines", severity: "medium", message: `${divergent.length} completed orders were paid a different amount than their line total. Revenue uses the amount actually paid.`, count: divergent.length, amount: fromCentavos(divergent.reduce((total, entry) => total + Math.abs(entry.revenueCentavos - entry.linesTotalCentavos), 0)) });
  }
  const noLines = recognized.filter((entry) => !entry.hasLines);
  if (noLines.length > 0) {
    warnings.push({ code: "completed-order-without-lines", severity: "high", message: `${noLines.length} completed orders have no line items loaded, so their sales and cost cannot be checked. Margin and result are withheld.`, count: noLines.length });
  }
  if (undatedCompleted > 0) {
    warnings.push({ code: "completed-order-without-date", severity: "high", message: `${undatedCompleted} completed orders have no completion date and are not in any month.`, count: undatedCompleted });
  }
  if (recognized.length === 0) {
    warnings.push({ code: "no-completed-orders", severity: "info", message: "No orders were completed in this month." });
  }
  if (depositRefundCount > 0) {
    warnings.push({ code: "deposit-refund", severity: "info", message: "Deposits were refunded on orders that were never completed. That is cash going back out; it was never revenue, so profit is unaffected.", count: depositRefundCount, amount: fromCentavos(depositRefundCentavos) });
  }
  if (!expensesAvailable) {
    warnings.push({ code: "expenses-unavailable", severity: "high", message: "The expense ledger could not be read, so no operating result is shown. If this database has not had the expenses migration applied yet, apply it first." });
  } else if (!isBeforeReportingStart && live.length === 0) {
    warnings.push({ code: "no-expenses-recorded", severity: "medium", message: "No operating expenses are recorded for this month. A zero here means nothing was entered, not that nothing was spent." });
  }

  return {
    month,
    basis: "accrual-at-fulfilment",
    isBeforeReportingStart,
    sales: {
      completedOrders: recognized.length,
      recognizedRevenue: fromCentavos(recognizedCentavos),
      collected: fromCentavos(collectedCentavos),
      receivable: fromCentavos(receivableCentavos),
      refunds: fromCentavos(refundCentavos),
      netRevenue: fromCentavos(netCentavos),
    },
    cogs: {
      ingredientCogs: ingredientCogsRounded,
      estimatedCogs: roundToCentavo(estimatedCogs),
      estimatedOrders,
      orders: orderClasses,
      productSales: fromCentavos(productSales),
      costedProductSales: fromCentavos(costedProductSales),
      uncostedProductSales: fromCentavos(uncostedProductSales),
      manualLineSales: fromCentavos(manualLineSales),
      coverage,
      isComplete: coverageComplete,
      costedSalesMargin: roundToCentavo(fromCentavos(costedProductSales) - ingredientCogs),
    },
    expenses: {
      available: expensesAvailable,
      total: fromCentavos(expenseCentavos),
      count: live.length,
      voidedCount: monthExpenses.length - live.length,
      byCategory: groupExpensesByCategory(live),
    },
    stockAttribution,
    grossMargin,
    operatingResult,
    cash: { received: roundToCentavo(grossRevenue(inputs.orders, range)), refunded: roundToCentavo(refunds(inputs.orders, range)) },
    inventoryPurchases: { total: fromCentavos(purchaseCentavos), count: purchases.length },
    warnings,
    exclusions: [...FINANCIAL_EXCLUSIONS],
  };
}

// --- Balances: where things stand now -----------------------------------------------------------
//
// Point-in-time, not per month. None of these is profit; they are what the business holds or is owed.

export type RawInventoryItem = { name: string; quantity: number; unitCost: number };

export type FinancialBalances = {
  customerDeposits: { count: number; amount: number };
  cancelledPaidNotRefunded: { count: number; amount: number };
  receivables: { count: number; amount: number; oldestDays: number | null; staleCount: number };
  rawInventory: {
    trustedValue: number;
    trustedItemCount: number;
    unverifiedValue: number;
    unverified: RawInventoryItem[];
    noCostItems: string[];
    negativeItems: string[];
  };
  finishedGoods: { pieces: number; value: number; estimatedValue: number; lotCount: number };
  warnings: FinancialWarning[];
};

const OPEN_ORDER_STATUSES: readonly string[] = ["new", "confirmed", "ready"];

export function buildFinancialBalances(inputs: FinanceInputs, nowMs: number, timeZone: string = BUSINESS_TIMEZONE): FinancialBalances {
  const warnings: FinancialWarning[] = [];
  const today = resolveBusinessDay(nowMs, timeZone);

  // Deposits: money received for orders not yet handed over (and not refunded).
  const deposits = inputs.orders.filter((order) => OPEN_ORDER_STATUSES.includes(order.status) && order.paymentStatus === "paid" && order.paidAmount !== null);
  const depositCentavos = deposits.reduce((total, order) => total + toCentavos(order.paidAmount as number), 0);

  // A cancelled order that is still marked paid: the money is held and nobody has decided what to do.
  const cancelledPaid = inputs.orders.filter((order) => order.status === "cancelled" && order.paymentStatus === "paid" && order.paidAmount !== null);
  const cancelledPaidCentavos = cancelledPaid.reduce((total, order) => total + toCentavos(order.paidAmount as number), 0);
  if (cancelledPaid.length > 0) {
    warnings.push({ code: "cancelled-paid-not-refunded", severity: "medium", message: "Cancelled orders are still marked paid. Refund them, or leave a note why the money is kept.", count: cancelledPaid.length, amount: fromCentavos(cancelledPaidCentavos) });
  }

  // Receivables: completed, not paid. Valued at the line total (nothing has been frozen yet).
  const owed = inputs.orders.filter((order) => order.status === "completed" && order.paymentStatus === "unpaid");
  let receivableCentavos = 0;
  let oldestDays: number | null = null;
  let staleCount = 0;
  for (const order of owed) {
    receivableCentavos += (inputs.linesByOrderId.get(order.id) ?? []).reduce((total, line) => total + lineTotalCentavos(line), 0);
    const completedDay = order.completedAt ? resolveBusinessDay(Date.parse(order.completedAt), timeZone) : null;
    if (completedDay !== null) {
      const age = daysBetweenDays(completedDay, today);
      oldestDays = oldestDays === null ? age : Math.max(oldestDays, age);
      if (age > STALE_RECEIVABLE_DAYS) staleCount += 1;
    }
  }
  if (staleCount > 0) {
    warnings.push({ code: "stale-receivables", severity: "medium", message: `${staleCount} completed orders have been unpaid for more than ${STALE_RECEIVABLE_DAYS} days. Check whether they were paid and not recorded.`, count: staleCount });
  }

  if (inputs.stockTruncated) {
    warnings.push({ code: "stock-data-truncated", severity: "high", message: `Stock records reached the ${POSTGREST_ROW_CAP}-row limit, so the stock values below may be understated.` });
  }

  if (stockDataMissing(inputs)) {
    warnings.push({ code: "stock-data-missing", severity: "high", message: "No stock or production records are loaded, so the stock values below read zero because nothing loaded, not because nothing is held. Reload the page." });
  }

  // Raw inventory: only stock whose cost the system can stand behind is valued.
  let trustedValue = 0;
  let trustedItemCount = 0;
  let unverifiedValue = 0;
  const unverified: RawInventoryItem[] = [];
  const noCostItems: string[] = [];
  const negativeItems: string[] = [];
  for (const ingredient of inputs.ingredients) {
    if (ingredient.currentQuantity < 0) {
      negativeItems.push(ingredient.name);
      continue;
    }
    if (ingredient.currentQuantity === 0) continue;
    const unitCost = ingredient.averageUnitCost || 0;
    if (unitCost <= 0) {
      noCostItems.push(ingredient.name);
    } else if (ingredient.costReconciledAt) {
      trustedValue += ingredient.currentQuantity * unitCost;
      trustedItemCount += 1;
    } else {
      unverifiedValue += ingredient.currentQuantity * unitCost;
      unverified.push({ name: ingredient.name, quantity: ingredient.currentQuantity, unitCost });
    }
  }
  if (unverified.length + noCostItems.length > 0) {
    warnings.push({ code: "untrusted-inventory-cost", severity: "medium", message: `${unverified.length + noCostItems.length} items in stock have no verified cost, so they are left out of the inventory value. Set their opening cost in Inventory.`, count: unverified.length + noCostItems.length });
  }
  if (negativeItems.length > 0) {
    warnings.push({ code: "negative-inventory", severity: "medium", message: "Some items show negative stock, which cannot be valued. Count and correct them in Inventory.", count: negativeItems.length });
  }

  // Finished goods: pieces still on hand per production lot, at that lot's frozen cost per piece.
  const onHandByLot = new Map<string, number>();
  for (const movement of inputs.finishedStockMovements) {
    if (movement.productionExecutionId) {
      onHandByLot.set(movement.productionExecutionId, (onHandByLot.get(movement.productionExecutionId) ?? 0) + movement.onHandDelta);
    }
  }
  let fgPieces = 0;
  let fgValue = 0;
  let fgEstimated = 0;
  let fgLots = 0;
  for (const lot of inputs.productionExecutions) {
    const onHand = onHandByLot.get(lot.id) ?? 0;
    if (onHand <= 0) continue;
    fgLots += 1;
    fgPieces += onHand;
    const value = onHand * lot.frozenCostPerPiece;
    fgValue += value;
    if (lot.costBasisSource === "historical_estimate") fgEstimated += value;
  }
  if (fgEstimated > 0) {
    warnings.push({ code: "estimated-finished-goods-cost", severity: "info", message: "Some finished stock was counted when stock tracking started and is valued at an estimated cost.", amount: roundToCentavo(fgEstimated) });
  }

  return {
    customerDeposits: { count: deposits.length, amount: fromCentavos(depositCentavos) },
    cancelledPaidNotRefunded: { count: cancelledPaid.length, amount: fromCentavos(cancelledPaidCentavos) },
    receivables: { count: owed.length, amount: fromCentavos(receivableCentavos), oldestDays, staleCount },
    rawInventory: { trustedValue: roundToCentavo(trustedValue), trustedItemCount, unverifiedValue: roundToCentavo(unverifiedValue), unverified, noCostItems, negativeItems },
    finishedGoods: { pieces: fgPieces, value: roundToCentavo(fgValue), estimatedValue: roundToCentavo(fgEstimated), lotCount: fgLots },
    warnings,
  };
}

// The earliest month any record could belong to, for the month selector. Never earlier than the
// first order, expense or stock event actually present; never later than `current`.
export function earliestRecordedMonth(inputs: Pick<FinanceInputs, "orders" | "expenses"> & Partial<Pick<FinanceInputs, "stockFinancialEvents">>, current: string, timeZone: string = BUSINESS_TIMEZONE): string {
  let earliest = current;
  for (const order of inputs.orders) {
    for (const timestamp of [order.completedAt, order.paidAt, order.placedAt]) {
      const key = monthKeyOfTimestamp(timestamp, timeZone);
      if (key !== null && key < earliest) earliest = key;
    }
  }
  for (const expense of inputs.expenses ?? []) {
    const key = monthKeyOfDay(expense.expenseDate);
    if (key !== null && key < earliest) earliest = key;
  }
  for (const event of inputs.stockFinancialEvents ?? []) {
    const key = monthKeyOfTimestamp(event.occurredAt, timeZone);
    if (key !== null && key < earliest) earliest = key;
  }
  return earliest;
}
