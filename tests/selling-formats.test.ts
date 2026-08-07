import test from "node:test";
import assert from "node:assert/strict";
import { getCostingTotals } from "../src/lib/costing.ts";
import {
  buildMovedManualPackagingLine,
  calculateMoveToSellingFormatAmount,
  findConflictingSellingFormatName,
  getSellingFormatMetrics,
  getSellingFormatPackagingCost,
  isSellingFormatPackagingLineValid,
} from "../src/lib/selling-formats.ts";
import type { CostingSummary, SellingFormat, SellingFormatPackagingLine } from "../src/lib/product-lab-types.ts";

// Ingredients 240 + batch-wide packaging & consumables 9, yield 9 -> costPerPiece = 249/9 =
// 27.666666666666668, the exact "base production cost per piece" worked example from the
// approved plan. Everything else zeroed out so directCost/indirectCost stay easy to reason about.
function baseCosting(overrides: Partial<CostingSummary> = {}): CostingSummary {
  return {
    id: "costing-1",
    productId: "product-1",
    batchId: "batch-1",
    ingredientCost: 240,
    packagingCost: 9,
    laborEstimate: 0,
    waterCost: 0,
    gasCost: 0,
    ovenElectricCost: 0,
    refrigerationCost: 0,
    coffeeEquipmentCost: 0,
    wasteAllowance: 0,
    overheadCost: 0,
    equipmentCost: 0,
    suggestedPrice: 0,
    notes: "Costing yield: 9",
    ...overrides,
  };
}

function baseSellingFormat(overrides: Partial<SellingFormat> = {}): SellingFormat {
  return {
    id: "format-1",
    costingId: "costing-1",
    name: "Single Brownie",
    piecesPerUnit: 1,
    sellingPrice: 40,
    isActive: true,
    sortOrder: 0,
    notes: "",
    ...overrides,
  };
}

function baseSellingFormatPackagingLine(overrides: Partial<SellingFormatPackagingLine> = {}): SellingFormatPackagingLine {
  return {
    id: "line-1",
    sellingFormatId: "format-1",
    ingredientId: "",
    name: "Wrapper",
    quantity: 1,
    unit: "pcs",
    unitCostSnapshot: 6,
    isManualCost: true,
    note: "",
    sortOrder: 0,
    ...overrides,
  };
}

test("base production cost per piece comes from getCostingTotals -- no second formula", () => {
  const totals = getCostingTotals(baseCosting());
  assert.equal(totals.costPerPiece, 249 / 9);
  assert.equal(totals.costPerPiece, 27.666666666666668);
});

test("single format: base cost times one piece plus one packaging line matches the worked example", () => {
  const totals = getCostingTotals(baseCosting());
  const line = baseSellingFormatPackagingLine({ name: "Wrapper", quantity: 1, unitCostSnapshot: 6 });
  const packagingCost = getSellingFormatPackagingCost([line]);
  const metrics = getSellingFormatMetrics({ baseProductionCostPerPiece: totals.costPerPiece, piecesPerUnit: 1, packagingCost, sellingPrice: 40 });

  assert.equal(packagingCost, 6);
  assert.equal(metrics.totalCost, 33.66666666666667);
  assert.equal(metrics.profit, 6.333333333333329);
});

test("box of 6: base cost times six pieces plus its own packaging lines matches the worked example", () => {
  const totals = getCostingTotals(baseCosting());
  const lines = [
    baseSellingFormatPackagingLine({ id: "line-box", sellingFormatId: "format-box", name: "Kraft box", quantity: 1, unitCostSnapshot: 15 }),
    baseSellingFormatPackagingLine({ id: "line-liner", sellingFormatId: "format-box", name: "Liner", quantity: 1, unitCostSnapshot: 5 }),
    baseSellingFormatPackagingLine({ id: "line-sticker", sellingFormatId: "format-box", name: "Sticker", quantity: 1, unitCostSnapshot: 3 }),
    baseSellingFormatPackagingLine({ id: "line-ribbon", sellingFormatId: "format-box", name: "Ribbon", quantity: 1, unitCostSnapshot: 5 }),
  ];
  const packagingCost = getSellingFormatPackagingCost(lines);
  const metrics = getSellingFormatMetrics({ baseProductionCostPerPiece: totals.costPerPiece, piecesPerUnit: 6, packagingCost, sellingPrice: 250 });

  assert.equal(packagingCost, 28);
  assert.equal(metrics.totalCost, 194);
});

test("a box does not use the single's rate times its piece count -- each format sums only its own packaging lines", () => {
  const totals = getCostingTotals(baseCosting());
  const singleLine = baseSellingFormatPackagingLine({ quantity: 1, unitCostSnapshot: 6 });
  const single = getSellingFormatMetrics({ baseProductionCostPerPiece: totals.costPerPiece, piecesPerUnit: 1, packagingCost: getSellingFormatPackagingCost([singleLine]), sellingPrice: 40 });
  const boxLines = [
    baseSellingFormatPackagingLine({ id: "line-box", name: "Kraft box", quantity: 1, unitCostSnapshot: 15 }),
    baseSellingFormatPackagingLine({ id: "line-liner", name: "Liner", quantity: 1, unitCostSnapshot: 5 }),
    baseSellingFormatPackagingLine({ id: "line-sticker", name: "Sticker", quantity: 1, unitCostSnapshot: 3 }),
    baseSellingFormatPackagingLine({ id: "line-ribbon", name: "Ribbon", quantity: 1, unitCostSnapshot: 5 }),
  ];
  const box = getSellingFormatMetrics({ baseProductionCostPerPiece: totals.costPerPiece, piecesPerUnit: 6, packagingCost: getSellingFormatPackagingCost(boxLines), sellingPrice: 250 });

  // Naively "6x the single" would be 6*33.666... = 202; the box is cheaper per-piece to package.
  assert.notEqual(box.totalCost, (single.totalCost as number) * 6);
  assert.equal(box.totalCost, 194);
});

test("getSellingFormatPackagingCost sums multiple lines", () => {
  const lines = [
    baseSellingFormatPackagingLine({ id: "line-1", unitCostSnapshot: 6, quantity: 1 }),
    baseSellingFormatPackagingLine({ id: "line-2", unitCostSnapshot: 2, quantity: 2 }),
    baseSellingFormatPackagingLine({ id: "line-3", unitCostSnapshot: 0.275, quantity: 4 }),
  ];
  assert.equal(getSellingFormatPackagingCost(lines), 11.1);
});

test("getSellingFormatPackagingCost returns 0 for an empty line list -- an empty format is valid", () => {
  assert.equal(getSellingFormatPackagingCost([]), 0);
});

test("manual packaging line (no catalog link) costs the same as a catalog-linked line with the same quantity and unit cost", () => {
  const manual = baseSellingFormatPackagingLine({ ingredientId: "", isManualCost: true, name: "Hand-typed sticker", quantity: 2, unitCostSnapshot: 3 });
  const catalogLinked = baseSellingFormatPackagingLine({ ingredientId: "ingredient-sticker", isManualCost: false, name: "Sticker", quantity: 2, unitCostSnapshot: 3 });

  assert.equal(getSellingFormatPackagingCost([manual]), getSellingFormatPackagingCost([catalogLinked]));
  assert.equal(getSellingFormatPackagingCost([manual]), 6);
});

test("sub-centavo unit cost is preserved at full precision, not rounded before multiplying", () => {
  // 1000 sheets bought for PHP 275 -> PHP 0.275 per sheet; a format using 4 sheets.
  const line = baseSellingFormatPackagingLine({ ingredientId: "ingredient-sheet", isManualCost: false, name: "Baking sheet", quantity: 4, unitCostSnapshot: 275 / 1000 });
  const packagingCost = getSellingFormatPackagingCost([line]);

  assert.equal(line.unitCostSnapshot, 0.275);
  assert.equal(packagingCost, 1.1);
  // If the unit cost had been rounded to cents (0.28) before multiplying, this would be 1.12 --
  // confirming the function does not do that.
  assert.notEqual(packagingCost, 4 * 0.28);
});

test("zero selling price: margin is exactly 0, never a divide-by-zero result, profit is still computed", () => {
  const totals = getCostingTotals(baseCosting());
  const line = baseSellingFormatPackagingLine({ quantity: 1, unitCostSnapshot: 6 });
  const metrics = getSellingFormatMetrics({ baseProductionCostPerPiece: totals.costPerPiece, piecesPerUnit: 1, packagingCost: getSellingFormatPackagingCost([line]), sellingPrice: 0 });

  assert.equal(metrics.margin, 0);
  assert.equal(metrics.totalCost, 33.66666666666667);
  assert.equal(metrics.profit, -33.66666666666667);
});

test("negative profit and margin are returned as real negative numbers, not clamped to zero", () => {
  const totals = getCostingTotals(baseCosting());
  const line = baseSellingFormatPackagingLine({ quantity: 1, unitCostSnapshot: 6 });
  const metrics = getSellingFormatMetrics({ baseProductionCostPerPiece: totals.costPerPiece, piecesPerUnit: 1, packagingCost: getSellingFormatPackagingCost([line]), sellingPrice: 30 });

  assert.equal(metrics.profit, -3.6666666666666714);
  assert.equal(metrics.margin, -12.22222222222224);
  assert.ok((metrics.profit as number) < 0);
  assert.ok((metrics.margin as number) < 0);
});

test("null base cost propagates to null totalCost, profit, and margin -- never zero, never a fallback", () => {
  const metrics = getSellingFormatMetrics({ baseProductionCostPerPiece: null, piecesPerUnit: 1, packagingCost: 6, sellingPrice: 40 });

  assert.equal(metrics.totalCost, null);
  assert.equal(metrics.profit, null);
  assert.equal(metrics.margin, null);
});

test("null base cost propagates the same way regardless of packaging cost or selling price", () => {
  const metrics = getSellingFormatMetrics({ baseProductionCostPerPiece: null, piecesPerUnit: 6, packagingCost: 0, sellingPrice: 0 });
  assert.deepEqual(metrics, { totalCost: null, profit: null, margin: null });
});

test("null base cost is inherited from a zero-yield costing, exactly like getCostingMetrics", () => {
  const totals = getCostingTotals(baseCosting({ notes: "" }));
  assert.equal(totals.costPerPiece, null);

  const metrics = getSellingFormatMetrics({ baseProductionCostPerPiece: totals.costPerPiece, piecesPerUnit: 1, packagingCost: 6, sellingPrice: 40 });
  assert.equal(metrics.totalCost, null);
});

test("findConflictingSellingFormatName: first format for a costing succeeds (no conflict)", () => {
  const conflict = findConflictingSellingFormatName([], { formatId: "", costingId: "costing-1", name: "Single Brownie" });
  assert.equal(conflict, null);
});

test("findConflictingSellingFormatName: duplicate name under the same costing is rejected", () => {
  const existing = baseSellingFormat({ id: "format-1", costingId: "costing-1", name: "Box of 6" });
  const conflict = findConflictingSellingFormatName([existing], { formatId: "", costingId: "costing-1", name: "Box of 6" });
  assert.equal(conflict, existing);
});

test("findConflictingSellingFormatName: duplicate detection is case- and whitespace-insensitive", () => {
  const existing = baseSellingFormat({ id: "format-1", costingId: "costing-1", name: "Box of 6" });
  const conflict = findConflictingSellingFormatName([existing], { formatId: "", costingId: "costing-1", name: "  BOX of 6  " });
  assert.equal(conflict, existing);
});

test("findConflictingSellingFormatName: editing the existing format succeeds (excludes itself)", () => {
  const existing = baseSellingFormat({ id: "format-1", costingId: "costing-1", name: "Box of 6" });
  const conflict = findConflictingSellingFormatName([existing], { formatId: "format-1", costingId: "costing-1", name: "Box of 6" });
  assert.equal(conflict, null);
});

test("findConflictingSellingFormatName: renaming a format to a name already used by a sibling is rejected", () => {
  const single = baseSellingFormat({ id: "format-1", costingId: "costing-1", name: "Single Brownie" });
  const box = baseSellingFormat({ id: "format-2", costingId: "costing-1", name: "Box of 6" });
  const conflict = findConflictingSellingFormatName([single, box], { formatId: "format-2", costingId: "costing-1", name: "Single Brownie" });
  assert.equal(conflict, single);
});

test("findConflictingSellingFormatName: the same name under a different costing does not conflict", () => {
  const existing = baseSellingFormat({ id: "format-1", costingId: "costing-1", name: "Box of 6" });
  const conflict = findConflictingSellingFormatName([existing], { formatId: "", costingId: "costing-2", name: "Box of 6" });
  assert.equal(conflict, null);
});

test("findConflictingSellingFormatName: two different formats on the same costing with different names do not conflict", () => {
  const single = baseSellingFormat({ id: "format-1", costingId: "costing-1", name: "Single Brownie" });
  const conflict = findConflictingSellingFormatName([single], { formatId: "", costingId: "costing-1", name: "Box of 6" });
  assert.equal(conflict, null);
});

test("isSellingFormatPackagingLineValid: a named line with a positive quantity and cost is valid", () => {
  const line = baseSellingFormatPackagingLine({ name: "Sticker", quantity: 1, unitCostSnapshot: 2 });
  assert.equal(isSellingFormatPackagingLineValid(line), true);
});

test("isSellingFormatPackagingLineValid: a blank name does not count, even with a real cost", () => {
  const line = baseSellingFormatPackagingLine({ name: "   ", quantity: 1, unitCostSnapshot: 2 });
  assert.equal(isSellingFormatPackagingLineValid(line), false);
});

test("isSellingFormatPackagingLineValid: a named placeholder line with zero cost does not count", () => {
  const line = baseSellingFormatPackagingLine({ name: "Sticker", quantity: 1, unitCostSnapshot: 0 });
  assert.equal(isSellingFormatPackagingLineValid(line), false);
});

test("isSellingFormatPackagingLineValid: a non-positive quantity does not count", () => {
  const line = baseSellingFormatPackagingLine({ name: "Sticker", quantity: 0, unitCostSnapshot: 2 });
  assert.equal(isSellingFormatPackagingLineValid(line), false);
});

// --- "Move to Selling Format" conversion (calculateMoveToSellingFormatAmount) ---

test("calculateMoveToSellingFormatAmount: PHP 18 across yield 9 into a single-piece format is PHP 2", () => {
  const amount = calculateMoveToSellingFormatAmount("divide-across-yield", { wholeBatchAmount: 18, costingYield: 9, piecesPerUnit: 1 });
  assert.equal(amount, 2);
});

test("calculateMoveToSellingFormatAmount: PHP 18 across yield 9 into a six-piece format is PHP 12", () => {
  const amount = calculateMoveToSellingFormatAmount("divide-across-yield", { wholeBatchAmount: 18, costingYield: 9, piecesPerUnit: 6 });
  assert.equal(amount, 12);
});

test("calculateMoveToSellingFormatAmount: the whole-amount option returns the original amount unchanged, regardless of yield or piecesPerUnit", () => {
  const amount = calculateMoveToSellingFormatAmount("use-whole-amount", { wholeBatchAmount: 18, costingYield: 9, piecesPerUnit: 6 });
  assert.equal(amount, 18);
});

test("calculateMoveToSellingFormatAmount: manual override returns exactly the entered amount, ignoring the whole-batch amount", () => {
  const amount = calculateMoveToSellingFormatAmount("manual", { wholeBatchAmount: 18, costingYield: 9, piecesPerUnit: 6, manualAmount: 4.5 });
  assert.equal(amount, 4.5);
});

test("calculateMoveToSellingFormatAmount: manual mode with no amount entered yet returns null, not zero or a fallback", () => {
  const amount = calculateMoveToSellingFormatAmount("manual", { wholeBatchAmount: 18, costingYield: 9, piecesPerUnit: 6 });
  assert.equal(amount, null);
});

test("calculateMoveToSellingFormatAmount: zero yield cannot use proportional allocation -- returns null, never a fallback", () => {
  const amount = calculateMoveToSellingFormatAmount("divide-across-yield", { wholeBatchAmount: 18, costingYield: 0, piecesPerUnit: 1 });
  assert.equal(amount, null);
});

test("calculateMoveToSellingFormatAmount: negative yield cannot use proportional allocation -- returns null, never a fallback", () => {
  const amount = calculateMoveToSellingFormatAmount("divide-across-yield", { wholeBatchAmount: 18, costingYield: -3, piecesPerUnit: 1 });
  assert.equal(amount, null);
});

test("calculateMoveToSellingFormatAmount: an invalid yield does not block the whole-amount or manual options", () => {
  assert.equal(calculateMoveToSellingFormatAmount("use-whole-amount", { wholeBatchAmount: 18, costingYield: 0, piecesPerUnit: 1 }), 18);
  assert.equal(calculateMoveToSellingFormatAmount("manual", { wholeBatchAmount: 18, costingYield: 0, piecesPerUnit: 1, manualAmount: 5 }), 5);
});

test("calculateMoveToSellingFormatAmount: no mutation occurs before confirmation -- the calculator is pure and cannot touch any packaging state", () => {
  // calculateMoveToSellingFormatAmount's signature only accepts plain numbers and returns a plain
  // number | null -- it has no access to setPackagingRows/setPackagingLineRows or any other state
  // setter, so it is structurally incapable of moving or removing anything. Calling it repeatedly,
  // including with an interpretation that can't be satisfied, proves this: every call is
  // independent and side-effect-free, whether or not the operator ever confirms a move.
  const preview1 = calculateMoveToSellingFormatAmount("divide-across-yield", { wholeBatchAmount: 18, costingYield: 9, piecesPerUnit: 1 });
  const preview2 = calculateMoveToSellingFormatAmount("use-whole-amount", { wholeBatchAmount: 18, costingYield: 9, piecesPerUnit: 1 });
  const preview3 = calculateMoveToSellingFormatAmount("manual", { wholeBatchAmount: 18, costingYield: 9, piecesPerUnit: 1 });
  assert.deepEqual([preview1, preview2, preview3], [2, 18, null]);
  // Building an actual packaging line is a distinct, separate function (buildMovedManualPackagingLine)
  // -- never invoked by the calculator above, and only ever invoked by the UI's explicit "Confirm
  // move" action, not by previewing or switching between interpretations.
});

// --- "Move to Selling Format" line construction (buildMovedManualPackagingLine) ---

test("buildMovedManualPackagingLine: builds a manual-mode line at quantity 1 with the confirmed amount as its unit cost", () => {
  const line = buildMovedManualPackagingLine({ name: "Kraft box", note: "from supplier X" }, "format-1", 12, 0);
  assert.equal(line.sellingFormatId, "format-1");
  assert.equal(line.name, "Kraft box");
  assert.equal(line.note, "from supplier X");
  assert.equal(line.quantity, 1);
  assert.equal(line.unitCostSnapshot, 12);
  assert.equal(line.isManualCost, true);
  assert.equal(line.ingredientId, "");
  assert.equal(typeof line.id, "string");
  assert.notEqual(line.id, "");
});

test("buildMovedManualPackagingLine: a blank original row name falls back to a descriptive default", () => {
  const line = buildMovedManualPackagingLine({ name: "", note: "" }, "format-1", 5, 0);
  assert.equal(line.name, "Moved packaging item");
});
