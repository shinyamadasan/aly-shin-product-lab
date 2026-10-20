// The fixed golden dataset for the financial report. EVERY expected figure in
// tests/finance-report.test.ts was calculated by hand from this file BEFORE the report code was
// run against it; the working is in the comments next to each record and again in the test file.
//
// All timestamps carry an explicit +08:00 offset (Asia/Manila) so the Manila-vs-UTC month boundary
// cases are visible in the data itself.
//
// Products and lots
//   brownie  lot A  24 pcs, ingredient cost 800.00  -> 33.333333333333336 / pc (a repeating decimal ON PURPOSE)
//   cookie   lot B  30 pcs, 12.50 / pc
//   brownie  lot C  10 pcs OPENING BALANCE, historical estimate 30.00 / pc

import type { FinishedStockMovement, Ingredient, OrderRawCogs, ProductionExecution, SupplyEntry } from "../../src/lib/product-lab-types.ts";
import type { BusinessExpense } from "../../src/lib/finance/expenses.ts";
import type { FinanceInputs } from "../../src/lib/finance/report.ts";
import type { Order, OrderLine } from "../../src/lib/orders/types.ts";

export const BROWNIE_PER_PIECE = 800 / 24; // 33.333333333333336
export const COOKIE_PER_PIECE = 12.5;

export function makeOrder(overrides: Partial<Order> & { id: string }): Order {
  return {
    customerId: "customer-1",
    status: "new",
    paymentStatus: "unpaid",
    paymentMethod: null,
    paidAt: null,
    paidAmount: null,
    refundedAt: null,
    fulfillmentMethod: "pickup",
    fulfillmentAt: null,
    fulfillmentAddress: "",
    fulfillmentNotes: "",
    source: "unknown",
    sourceRef: "",
    entryMethod: "manual",
    notes: "",
    placedAt: "2026-09-01T09:00:00+08:00",
    completedAt: null,
    cancelledAt: null,
    cancelReason: "",
    createdAt: "2026-09-01T09:00:00+08:00",
    updatedAt: "2026-09-01T09:00:00+08:00",
    ...overrides,
  };
}

let lineSeq = 0;
export function makeLine(orderId: string, overrides: Partial<OrderLine> & { itemName: string; unitPrice: number; quantity: number }): OrderLine {
  lineSeq += 1;
  return {
    id: `line-${lineSeq}`,
    orderId,
    productId: "",
    sellingFormatId: "",
    piecesPerUnitSnapshot: null,
    sortOrder: lineSeq,
    note: "",
    ...overrides,
  };
}

export function makeCogs(orderId: string, lots: Array<{ lot: string; productId: string; pieces: number; perPiece: number }>): OrderRawCogs {
  const mapped = lots.map((entry) => ({
    productionExecutionId: entry.lot,
    productId: entry.productId,
    fulfilledPieces: entry.pieces,
    frozenCostPerPiece: entry.perPiece,
    lotRawCogs: entry.pieces * entry.perPiece,
  }));
  return {
    orderId,
    fulfilledPieces: mapped.reduce((total, lot) => total + lot.fulfilledPieces, 0),
    rawProductionCogs: mapped.reduce((total, lot) => total + lot.lotRawCogs, 0),
    lots: mapped,
  };
}

export function makeExpense(overrides: Partial<BusinessExpense> & { id: string; expenseDate: string; amount: number }): BusinessExpense {
  return {
    operationId: `op-${overrides.id}`,
    category: "other",
    payee: "Payee",
    description: "",
    paymentMethod: null,
    paymentReference: "",
    correctsExpenseId: null,
    recordedAt: `${overrides.expenseDate}T12:00:00+08:00`,
    voidedAt: null,
    voidReason: "",
    ...overrides,
  };
}

function lot(overrides: Partial<ProductionExecution> & { id: string; productId: string; quantityProducedPieces: number; frozenCostPerPiece: number }): ProductionExecution {
  return {
    productBatchId: "batch-1",
    batchVersionSnapshot: "v1",
    operationId: `op-${overrides.id}`,
    multiplier: 1,
    expectedPieces: overrides.quantityProducedPieces,
    frozenIngredientCostTotal: overrides.quantityProducedPieces * overrides.frozenCostPerPiece,
    sourceType: "bake",
    costBasisSource: "production",
    costBasisSnapshot: null,
    note: "",
    completedAt: "2026-09-10T09:00:00+08:00",
    createdAt: "2026-09-10T09:00:00+08:00",
    ...overrides,
  };
}

function move(lotId: string, productId: string, movementType: FinishedStockMovement["movementType"], onHandDelta: number, reservedDelta = 0): FinishedStockMovement {
  return { id: `${lotId}-${movementType}-${onHandDelta}-${reservedDelta}`, productId, productionExecutionId: lotId, movementType, onHandDelta, reservedDelta, operationId: `op-${lotId}-${movementType}`, note: "", createdAt: "2026-09-10T09:00:00+08:00" };
}

function ingredient(overrides: Partial<Ingredient> & { id: string; name: string; currentQuantity: number; averageUnitCost: number }): Ingredient {
  return { baseUnit: "g", category: "ingredient", lowStockThreshold: 0, targetStockQuantity: 0, nearestExpirationDate: "", notes: "", isActive: true, costReconciledAt: null, ...overrides };
}

function supply(id: string, purchaseDate: string, totalCost: number): SupplyEntry {
  return { id, ingredientId: "", ingredientName: "Item", brandName: "", supplierName: "Main", purchaseDate, createdAt: `${purchaseDate}T10:00:00+08:00`, packQuantity: 1, unit: "pcs", totalCost, qualityRating: 0, notes: "" };
}

export function buildGoldenInputs(): FinanceInputs {
  const orders: Order[] = [];
  const linesByOrderId = new Map<string, OrderLine[]>();
  const cogsByOrderId = new Map<string, OrderRawCogs>();
  const add = (order: Order, lines: OrderLine[], cogs?: OrderRawCogs) => {
    orders.push(order);
    linesByOrderId.set(order.id, lines);
    if (cogs) cogsByOrderId.set(order.id, cogs);
  };

  // ---------------- SEPTEMBER 2026 (before the reporting start; cost data is incomplete) ----------
  // S1 completed 15 Sep, paid 100.00. Brownie x2 @ 50. COGS 2 x 33.333.. = 66.67 -> COSTED.
  add(
    makeOrder({ id: "S1", status: "completed", paymentStatus: "paid", paymentMethod: "cash", paidAt: "2026-09-15T12:00:00+08:00", paidAmount: 100, completedAt: "2026-09-15T12:00:00+08:00" }),
    [makeLine("S1", { itemName: "Brownie", productId: "brownie", piecesPerUnitSnapshot: 1, unitPrice: 50, quantity: 2 })],
    makeCogs("S1", [{ lot: "lotA", productId: "brownie", pieces: 2, perPiece: BROWNIE_PER_PIECE }]),
  );
  // S2 completed 20 Sep, paid 120.00. Cookie x4 @ 30. NO COGS ROW (pre-tracking) -> UNCOSTED.
  add(
    makeOrder({ id: "S2", status: "completed", paymentStatus: "paid", paymentMethod: "gcash", paidAt: "2026-09-20T12:00:00+08:00", paidAmount: 120, completedAt: "2026-09-20T12:00:00+08:00" }),
    [makeLine("S2", { itemName: "Cookie", productId: "cookie", piecesPerUnitSnapshot: 1, unitPrice: 30, quantity: 4 })],
  );
  // S3 completed 22 Sep, paid 160.00. Brownie x2 @ 50 (costed, 66.67) + Cookie x2 @ 30 (no cookie lot) -> PARTIAL.
  add(
    makeOrder({ id: "S3", status: "completed", paymentStatus: "paid", paymentMethod: "cash", paidAt: "2026-09-22T12:00:00+08:00", paidAmount: 160, completedAt: "2026-09-22T12:00:00+08:00" }),
    [
      makeLine("S3", { itemName: "Brownie", productId: "brownie", piecesPerUnitSnapshot: 1, unitPrice: 50, quantity: 2 }),
      makeLine("S3", { itemName: "Cookie", productId: "cookie", piecesPerUnitSnapshot: 1, unitPrice: 30, quantity: 2 }),
    ],
    makeCogs("S3", [{ lot: "lotA", productId: "brownie", pieces: 2, perPiece: BROWNIE_PER_PIECE }]),
  );

  // ---------------- OCTOBER 2026 -------------------------------------------------------------------
  // O1 completed 5 Oct, PREPAID 540.00 at 05:00 Manila on 1 Oct (= 21:00Z on 30 Sep: a UTC clock would
  // file the cash in September). Brownie box of 6 x1 @ 420 (6 pcs) + Cookie x4 @ 30.
  // COGS = 6 x 33.333.. + 4 x 12.5 = 200 + 50 = 250.
  add(
    makeOrder({ id: "O1", status: "completed", paymentStatus: "paid", paymentMethod: "gcash", paidAt: "2026-10-01T05:00:00+08:00", paidAmount: 540, completedAt: "2026-10-05T10:00:00+08:00" }),
    [
      makeLine("O1", { itemName: "Brownie box of 6", productId: "brownie", piecesPerUnitSnapshot: 6, unitPrice: 420, quantity: 1 }),
      makeLine("O1", { itemName: "Cookie", productId: "cookie", piecesPerUnitSnapshot: 1, unitPrice: 30, quantity: 4 }),
    ],
    makeCogs("O1", [
      { lot: "lotA", productId: "brownie", pieces: 6, perPiece: BROWNIE_PER_PIECE },
      { lot: "lotB", productId: "cookie", pieces: 4, perPiece: COOKIE_PER_PIECE },
    ]),
  );
  // O2 completed 2 Oct but PAID 30 Sep 22:00 Manila: cash in September, REVENUE in October.
  // Brownie x6 @ 50 = 300. COGS = 6 x 33.333.. = 200.
  add(
    makeOrder({ id: "O2", status: "completed", paymentStatus: "paid", paymentMethod: "bank_transfer", paidAt: "2026-09-30T22:00:00+08:00", paidAmount: 300, completedAt: "2026-10-02T09:00:00+08:00" }),
    [makeLine("O2", { itemName: "Brownie", productId: "brownie", piecesPerUnitSnapshot: 1, unitPrice: 50, quantity: 6 })],
    makeCogs("O2", [{ lot: "lotA", productId: "brownie", pieces: 6, perPiece: BROWNIE_PER_PIECE }]),
  );
  // O3 completed 10 Oct, UNPAID -> a receivable of 60.00. Cookie x2 @ 30. COGS 25.
  add(
    makeOrder({ id: "O3", status: "completed", paymentStatus: "unpaid", completedAt: "2026-10-10T15:00:00+08:00" }),
    [makeLine("O3", { itemName: "Cookie", productId: "cookie", piecesPerUnitSnapshot: 1, unitPrice: 30, quantity: 2 })],
    makeCogs("O3", [{ lot: "lotB", productId: "cookie", pieces: 2, perPiece: COOKIE_PER_PIECE }]),
  );
  // O5 completed 20 Oct, paid 100.00 on 20 Oct. Cookie x2 @ 30 (COGS 25) + a manual delivery line 40.
  add(
    makeOrder({ id: "O5", status: "completed", paymentStatus: "paid", paymentMethod: "cash", paidAt: "2026-10-20T11:00:00+08:00", paidAmount: 100, completedAt: "2026-10-20T11:00:00+08:00" }),
    [
      makeLine("O5", { itemName: "Cookie", productId: "cookie", piecesPerUnitSnapshot: 1, unitPrice: 30, quantity: 2 }),
      makeLine("O5", { itemName: "Delivery fee", unitPrice: 40, quantity: 1 }),
    ],
    makeCogs("O5", [{ lot: "lotB", productId: "cookie", pieces: 2, perPiece: COOKIE_PER_PIECE }]),
  );
  // O9 completed 8 Oct, paid 200.00 on 8 Oct, REFUNDED IN FULL on 3 Nov (completed order -> contra-revenue
  // in NOVEMBER; October's revenue is not rewritten). Brownie x4 @ 50. COGS = 4 x 33.333.. = 133.33..
  add(
    makeOrder({ id: "O9", status: "completed", paymentStatus: "refunded", paymentMethod: "gcash", paidAt: "2026-10-08T10:00:00+08:00", paidAmount: 200, refundedAt: "2026-11-03T10:00:00+08:00", completedAt: "2026-10-08T10:00:00+08:00" }),
    [makeLine("O9", { itemName: "Brownie", productId: "brownie", piecesPerUnitSnapshot: 1, unitPrice: 50, quantity: 4 })],
    makeCogs("O9", [{ lot: "lotA", productId: "brownie", pieces: 4, perPiece: BROWNIE_PER_PIECE }]),
  );
  // O6 CONFIRMED (open), prepaid 250.00 on 15 Oct -> a customer DEPOSIT, not revenue.
  add(
    makeOrder({ id: "O6", status: "confirmed", paymentStatus: "paid", paymentMethod: "gcash", paidAt: "2026-10-15T10:00:00+08:00", paidAmount: 250 }),
    [makeLine("O6", { itemName: "Cookie", productId: "cookie", piecesPerUnitSnapshot: 1, unitPrice: 25, quantity: 10 })],
  );
  // O7 CANCELLED but still marked paid 80.00 (paid 3 Oct) -> money held, flagged.
  add(
    makeOrder({ id: "O7", status: "cancelled", paymentStatus: "paid", paymentMethod: "cash", paidAt: "2026-10-03T10:00:00+08:00", paidAmount: 80, cancelledAt: "2026-10-04T10:00:00+08:00" }),
    [makeLine("O7", { itemName: "Brownie", productId: "brownie", piecesPerUnitSnapshot: 1, unitPrice: 80, quantity: 1 })],
  );
  // O8 CANCELLED and REFUNDED 120.00 on 12 Oct (paid 2 Oct): a deposit going back, never revenue.
  add(
    makeOrder({ id: "O8", status: "cancelled", paymentStatus: "refunded", paymentMethod: "gcash", paidAt: "2026-10-02T10:00:00+08:00", paidAmount: 120, refundedAt: "2026-10-12T10:00:00+08:00", cancelledAt: "2026-10-11T10:00:00+08:00" }),
    [makeLine("O8", { itemName: "Cookie", productId: "cookie", piecesPerUnitSnapshot: 1, unitPrice: 30, quantity: 4 })],
  );

  // ---------------- NOVEMBER 2026 -------------------------------------------------------------------
  // O4 completed 00:30 Manila on 1 Nov (= 16:30Z on 31 Oct: a UTC clock would file it in OCTOBER).
  // Paid 150.00 on 1 Nov. Brownie x3 @ 50. COGS = 3 x 33.333.. = 100.
  add(
    makeOrder({ id: "O4", status: "completed", paymentStatus: "paid", paymentMethod: "cash", paidAt: "2026-11-01T00:45:00+08:00", paidAmount: 150, completedAt: "2026-11-01T00:30:00+08:00" }),
    [makeLine("O4", { itemName: "Brownie", productId: "brownie", piecesPerUnitSnapshot: 1, unitPrice: 50, quantity: 3 })],
    makeCogs("O4", [{ lot: "lotA", productId: "brownie", pieces: 3, perPiece: BROWNIE_PER_PIECE }]),
  );

  // ---------------- Expenses -------------------------------------------------------------------------
  const expenses: BusinessExpense[] = [
    makeExpense({ id: "E1", expenseDate: "2026-10-15", amount: 1000, category: "rent", payee: "Landlord" }),
    makeExpense({ id: "E2", expenseDate: "2026-10-05", amount: 333.33, category: "utilities", payee: "Meralco" }),
    // Three centavo-level fees: 0.10 + 0.20 + 0.30 must be EXACTLY 0.60.
    makeExpense({ id: "E3", expenseDate: "2026-10-31", amount: 0.1, category: "fees", payee: "GCash A" }),
    makeExpense({ id: "E4", expenseDate: "2026-10-31", amount: 0.2, category: "fees", payee: "GCash B" }),
    makeExpense({ id: "E5", expenseDate: "2026-10-31", amount: 0.3, category: "fees", payee: "GCash C" }),
    makeExpense({ id: "E7", expenseDate: "2026-10-18", amount: 150.5, category: "delivery", payee: "Rider" }),
    // Voided: kept in the ledger, never counted.
    makeExpense({ id: "E6", expenseDate: "2026-10-10", amount: 500, category: "marketing", payee: "Ad", voidedAt: "2026-10-11T09:00:00+08:00", voidReason: "Entered twice" }),
    // A correction: E8 (900.00) was voided and replaced by E9 (950.50). Only E9 counts. Sept date = outside October.
    makeExpense({ id: "E8", expenseDate: "2026-09-12", amount: 900, category: "utilities", payee: "Meralco", voidedAt: "2026-09-13T09:00:00+08:00", voidReason: "Corrected: misread bill" }),
    makeExpense({ id: "E9", expenseDate: "2026-09-12", amount: 950.5, category: "utilities", payee: "Meralco", correctsExpenseId: "E8" }),
  ];

  // ---------------- Inventory purchases (an asset; never in profit) ------------------------------------
  const supplies: SupplyEntry[] = [supply("P1", "2026-10-03", 5000), supply("P2", "2026-10-04", 1234.56), supply("P0", "2026-09-25", 800)];

  // ---------------- Stock on hand ------------------------------------------------------------------------
  const ingredients: Ingredient[] = [
    ingredient({ id: "i1", name: "Flour", currentQuantity: 10000, averageUnitCost: 0.05, costReconciledAt: "2026-10-01T09:00:00+08:00" }), // 500.00 trusted
    ingredient({ id: "i2", name: "Sugar", currentQuantity: 5000, averageUnitCost: 0.08, costReconciledAt: "2026-10-01T09:00:00+08:00" }), // 400.00 trusted
    ingredient({ id: "i3", name: "Butter", currentQuantity: 2000, averageUnitCost: 0.4 }), // 800.00 UNVERIFIED
    ingredient({ id: "i4", name: "Cocoa", currentQuantity: 500, averageUnitCost: 0 }), // no cost
    ingredient({ id: "i5", name: "Eggs", currentQuantity: -3, averageUnitCost: 7, costReconciledAt: "2026-10-01T09:00:00+08:00" }), // negative
    ingredient({ id: "i6", name: "Vanilla", currentQuantity: 0, averageUnitCost: 9 }), // empty: ignored
  ];

  const productionExecutions: ProductionExecution[] = [
    lot({ id: "lotA", productId: "brownie", quantityProducedPieces: 24, frozenCostPerPiece: BROWNIE_PER_PIECE }),
    lot({ id: "lotB", productId: "cookie", quantityProducedPieces: 30, frozenCostPerPiece: COOKIE_PER_PIECE }),
    lot({ id: "lotC", productId: "brownie", quantityProducedPieces: 10, frozenCostPerPiece: 30, sourceType: "opening_balance", costBasisSource: "historical_estimate", costBasisSnapshot: { note: "estimate" } }),
  ];
  // lotA 24 -(S1 2, S3 2, O1 6, O2 6, O9 4, O4 3 = 23)  -> 1 left
  // lotB 30 -(O1 4, O3 2, O5 2 = 8)                     -> 22 left;  O6 reserves 10 (reserved only: on hand unchanged)
  // lotC 10 opening balance, untouched                  -> 10
  const finishedStockMovements: FinishedStockMovement[] = [
    move("lotA", "brownie", "production_receipt", 24),
    ...[2, 2, 6, 6, 4, 3].map((pieces) => move("lotA", "brownie", "fulfill", -pieces, -pieces)),
    move("lotB", "cookie", "production_receipt", 30),
    ...[4, 2, 2].map((pieces) => move("lotB", "cookie", "fulfill", -pieces, -pieces)),
    move("lotB", "cookie", "reserve", 0, 10),
    move("lotC", "brownie", "production_receipt", 10),
  ];

  return { orders, linesByOrderId, cogsByOrderId, expenses, supplies, ingredients, productionExecutions, finishedStockMovements, truncated: false, stockTruncated: false };
}
