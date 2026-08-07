import test from "node:test";
import assert from "node:assert/strict";
import { areCostingFormSnapshotsEqual, buildCostingFormSnapshot, isCostingFormDirty, type CostingFormSnapshotInput } from "../src/lib/costing-form-snapshot.ts";
import type { CostingIngredientRow, SellingFormat, SellingFormatPackagingLine } from "../src/lib/product-lab-types.ts";

function ingredientRow(overrides: Partial<CostingIngredientRow> = {}): CostingIngredientRow {
  return {
    id: "",
    productId: "product-1",
    batchId: "batch-1",
    brandName: "",
    ingredientName: "Flour",
    quantityUsed: 250,
    unit: "g",
    cost: 20,
    supplierNote: "",
    rowId: "row-1",
    ...overrides,
  };
}

function sellingFormat(overrides: Partial<SellingFormat> = {}): SellingFormat {
  return {
    id: "format-1",
    costingId: "costing-1",
    name: "Single Brownie",
    piecesPerUnit: 1,
    sellingPrice: 35,
    isActive: true,
    sortOrder: 0,
    notes: "",
    ...overrides,
  };
}

function packagingLine(overrides: Partial<SellingFormatPackagingLine> = {}): SellingFormatPackagingLine {
  return {
    id: "line-1",
    sellingFormatId: "format-1",
    ingredientId: "",
    name: "Wrapper",
    quantity: 1,
    unit: "pcs",
    unitCostSnapshot: 1.25,
    isManualCost: true,
    note: "",
    sortOrder: 0,
    ...overrides,
  };
}

function snapshotInput(overrides: Partial<CostingFormSnapshotInput> = {}): CostingFormSnapshotInput {
  return {
    selectedBatchId: "batch-1",
    costingYield: 10,
    ingredientRows: [ingredientRow()],
    packagingRows: [{ name: "Parchment paper", cost: 10, note: "", rowId: "pkg-row-1" }],
    laborDetail: { activeRate: 75, cleaningMinutes: 10, cookingMinutes: 30, coolingMinutes: 20, packagingMinutes: 15, prepMinutes: 20 },
    utilityRows: [],
    gasDetail: { equipmentName: "", gasKg: 11, gasPrice: 950, gasUseKgPerHour: 0.2 },
    electricityDetail: { applianceWatts: 0, equipmentName: "", ratePerKwh: 12, minutes: 0 },
    waterDetail: { litersUsed: 0, ratePerCubicMeter: 30 },
    customGasEquipmentNames: [],
    customElectricEquipmentNames: [],
    wasteRows: [],
    overheadRows: [],
    equipmentUsage: [],
    notes: "What is estimated?",
    suggestedPrice: 35,
    targetFoodCost: 0.35,
    formatRows: [sellingFormat()],
    packagingLineRows: [packagingLine()],
    ...overrides,
  };
}

test("identical form state is clean", () => {
  const input = snapshotInput();
  const a = buildCostingFormSnapshot(input);
  const b = buildCostingFormSnapshot(snapshotInput());
  assert.equal(areCostingFormSnapshotsEqual(a, b), true);
  assert.equal(isCostingFormDirty(a, b), false);
});

test("selectedBatchId change is dirty", () => {
  const baseline = buildCostingFormSnapshot(snapshotInput());
  const live = buildCostingFormSnapshot(snapshotInput({ selectedBatchId: "batch-2" }));
  assert.equal(isCostingFormDirty(live, baseline), true);
});

test("costingYield change is dirty", () => {
  const baseline = buildCostingFormSnapshot(snapshotInput());
  const live = buildCostingFormSnapshot(snapshotInput({ costingYield: 12 }));
  assert.equal(isCostingFormDirty(live, baseline), true);
});

test("an ingredient row field change is dirty, and reverting it is clean again", () => {
  const baseline = buildCostingFormSnapshot(snapshotInput());
  const changed = buildCostingFormSnapshot(snapshotInput({ ingredientRows: [ingredientRow({ cost: 25 })] }));
  assert.equal(isCostingFormDirty(changed, baseline), true);

  const reverted = buildCostingFormSnapshot(snapshotInput({ ingredientRows: [ingredientRow({ cost: 20 })] }));
  assert.equal(isCostingFormDirty(reverted, baseline), false);
});

test("adding then removing an ingredient row returns to clean", () => {
  const baseline = buildCostingFormSnapshot(snapshotInput());
  const withAddedRow = buildCostingFormSnapshot(
    snapshotInput({ ingredientRows: [ingredientRow(), ingredientRow({ id: "", ingredientName: "Sugar", cost: 5, rowId: crypto.randomUUID() })] }),
  );
  assert.equal(isCostingFormDirty(withAddedRow, baseline), true);

  const afterRemoving = buildCostingFormSnapshot(snapshotInput());
  assert.equal(isCostingFormDirty(afterRemoving, baseline), false);
});

test("a fresh row's temporary rowId never affects the comparison, even when it differs from the baseline's", () => {
  const baseline = buildCostingFormSnapshot(snapshotInput({ ingredientRows: [ingredientRow({ rowId: "generated-on-first-mount" })] }));
  const live = buildCostingFormSnapshot(snapshotInput({ ingredientRows: [ingredientRow({ rowId: "a-completely-different-uuid" })] }));
  assert.equal(isCostingFormDirty(live, baseline), false);
});

test("batch-wide packaging row content change is dirty", () => {
  const baseline = buildCostingFormSnapshot(snapshotInput());
  const live = buildCostingFormSnapshot(snapshotInput({ packagingRows: [{ name: "Parchment paper", cost: 15, note: "", rowId: "pkg-row-1" }] }));
  assert.equal(isCostingFormDirty(live, baseline), true);
});

test("labor detail change is dirty", () => {
  const baseline = buildCostingFormSnapshot(snapshotInput());
  const live = buildCostingFormSnapshot(snapshotInput({ laborDetail: { activeRate: 90, cleaningMinutes: 10, cookingMinutes: 30, coolingMinutes: 20, packagingMinutes: 15, prepMinutes: 20 } }));
  assert.equal(isCostingFormDirty(live, baseline), true);
});

test("utility rows, gas/electricity/water detail, and custom equipment name list changes are each dirty", () => {
  const baseline = buildCostingFormSnapshot(snapshotInput());

  assert.equal(isCostingFormDirty(buildCostingFormSnapshot(snapshotInput({ utilityRows: [{ name: "Propane", cost: 100, note: "", rowId: "u-1" }] })), baseline), true);
  assert.equal(isCostingFormDirty(buildCostingFormSnapshot(snapshotInput({ gasDetail: { equipmentName: "", gasKg: 11, gasPrice: 1000, gasUseKgPerHour: 0.2 } })), baseline), true);
  assert.equal(isCostingFormDirty(buildCostingFormSnapshot(snapshotInput({ electricityDetail: { applianceWatts: 500, equipmentName: "", ratePerKwh: 12, minutes: 0 } })), baseline), true);
  assert.equal(isCostingFormDirty(buildCostingFormSnapshot(snapshotInput({ waterDetail: { litersUsed: 5, ratePerCubicMeter: 30 } })), baseline), true);
  assert.equal(isCostingFormDirty(buildCostingFormSnapshot(snapshotInput({ customGasEquipmentNames: ["Table oven"] })), baseline), true);
});

test("waste rows, overhead rows, and equipment usage changes are each dirty", () => {
  const baseline = buildCostingFormSnapshot(snapshotInput());

  assert.equal(isCostingFormDirty(buildCostingFormSnapshot(snapshotInput({ wasteRows: [{ name: "Spoilage", cost: 10, note: "", rowId: "w-1" }] })), baseline), true);
  assert.equal(isCostingFormDirty(buildCostingFormSnapshot(snapshotInput({ overheadRows: [{ name: "Rent", cost: 500, note: "", rowId: "o-1" }] })), baseline), true);
  assert.equal(isCostingFormDirty(buildCostingFormSnapshot(snapshotInput({ equipmentUsage: [{ equipmentId: "oven-1", rowId: "e-1", sharedBatches: 2 }] })), baseline), true);
});

test("notes, suggested price, and target food cost changes are each dirty", () => {
  const baseline = buildCostingFormSnapshot(snapshotInput());

  assert.equal(isCostingFormDirty(buildCostingFormSnapshot(snapshotInput({ notes: "Updated note" })), baseline), true);
  assert.equal(isCostingFormDirty(buildCostingFormSnapshot(snapshotInput({ suggestedPrice: 40 })), baseline), true);
  assert.equal(isCostingFormDirty(buildCostingFormSnapshot(snapshotInput({ targetFoodCost: 0.4 })), baseline), true);
});

test("Selling Format price, pieces per unit, active state, and notes changes each become dirty", () => {
  const baseline = buildCostingFormSnapshot(snapshotInput());

  assert.equal(isCostingFormDirty(buildCostingFormSnapshot(snapshotInput({ formatRows: [sellingFormat({ sellingPrice: 40 })] })), baseline), true);
  assert.equal(isCostingFormDirty(buildCostingFormSnapshot(snapshotInput({ formatRows: [sellingFormat({ piecesPerUnit: 6 })] })), baseline), true);
  assert.equal(isCostingFormDirty(buildCostingFormSnapshot(snapshotInput({ formatRows: [sellingFormat({ isActive: false })] })), baseline), true);
  assert.equal(isCostingFormDirty(buildCostingFormSnapshot(snapshotInput({ formatRows: [sellingFormat({ notes: "Sells fast on weekends" })] })), baseline), true);
});

test("Selling Format packaging line changes become dirty", () => {
  const baseline = buildCostingFormSnapshot(snapshotInput());
  const live = buildCostingFormSnapshot(snapshotInput({ packagingLineRows: [packagingLine({ quantity: 2, unitCostSnapshot: 1.5 })] }));
  assert.equal(isCostingFormDirty(live, baseline), true);
});

test("a confirmed Move to Selling Format (row removed, new manual line added) is dirty", () => {
  const baseline = buildCostingFormSnapshot(snapshotInput());
  const afterConfirmedMove = buildCostingFormSnapshot(
    snapshotInput({
      packagingRows: [],
      packagingLineRows: [packagingLine(), packagingLine({ id: "moved-line", name: "Parchment paper", ingredientId: "", quantity: 1, unitCostSnapshot: 10, isManualCost: true })],
    }),
  );
  assert.equal(isCostingFormDirty(afterConfirmedMove, baseline), true);
});

test("the Move to Selling Format dialog being open, with nothing confirmed yet, is not itself part of the snapshot and stays clean", () => {
  // pendingMove (the panel's own open/interpretation/manual-amount state) is never passed into
  // buildCostingFormSnapshot at all -- so a caller re-rendering with the panel open but nothing
  // confirmed produces the exact same snapshot as before the panel was opened.
  const baseline = buildCostingFormSnapshot(snapshotInput());
  const stillJustBrowsingTheDialog = buildCostingFormSnapshot(snapshotInput());
  assert.equal(isCostingFormDirty(stillJustBrowsingTheDialog, baseline), false);
});

test("reordering Selling Formats is dirty, since sortOrder is persisted and meaningful", () => {
  const first = sellingFormat({ id: "format-1", name: "Single", sortOrder: 0 });
  const second = sellingFormat({ id: "format-2", name: "Box of 6", sortOrder: 1 });
  const baseline = buildCostingFormSnapshot(snapshotInput({ formatRows: [first, second] }));
  const reordered = buildCostingFormSnapshot(snapshotInput({ formatRows: [{ ...second, sortOrder: 0 }, { ...first, sortOrder: 1 }] }));
  assert.equal(isCostingFormDirty(reordered, baseline), true);
});
