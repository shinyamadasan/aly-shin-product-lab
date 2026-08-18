import assert from "node:assert/strict";
import { test } from "node:test";
import { buildDuplicateCostingDraft, buildDuplicateIngredientRows } from "../src/lib/costing-duplicate.ts";
import type { CostingEntry, CostingSummary, Ingredient, SellingFormat, SellingFormatPackagingLine, SupplyEntry } from "../src/lib/product-lab-types.ts";

const sourceCosting: CostingSummary = {
  id: "costing-v6",
  productId: "product-brownie",
  batchId: "batch-v6",
  ingredientCost: 100,
  packagingCost: 20,
  laborEstimate: 30,
  waterCost: 1,
  gasCost: 2,
  ovenElectricCost: 3,
  refrigerationCost: 4,
  coffeeEquipmentCost: 5,
  wasteAllowance: 6,
  overheadCost: 7,
  equipmentCost: 8,
  suggestedPrice: 45,
  notes: "Costing yield: 12\nProfessional costing detail: {\"targetFoodCost\":0.35}",
};

const sourceFormat: SellingFormat = {
  id: "format-box",
  costingId: "costing-v6",
  name: "Box of 6",
  piecesPerUnit: 6,
  sellingPrice: 250,
  isActive: true,
  sortOrder: 0,
  notes: "gift box",
};

const sourceLine: SellingFormatPackagingLine = {
  id: "line-wrapper",
  sellingFormatId: "format-box",
  ingredientId: "ingredient-wrapper",
  name: "Wrapper",
  quantity: 6,
  unit: "pcs",
  unitCostSnapshot: 0.275,
  isManualCost: false,
  note: "catalog-linked",
  sortOrder: 0,
};

const sourceIngredientEntry: CostingEntry = {
  id: "entry-old-flour",
  productId: "product-brownie",
  batchId: "batch-v6",
  brandName: "Miller",
  ingredientName: "Flour",
  quantityUsed: 250,
  unit: "g",
  cost: 10,
  supplierNote: "Old supplier / 2026-01-01 / PHP 0.04/g",
};

const currentSupply: SupplyEntry = {
  id: "supply-current-flour",
  ingredientId: "ingredient-flour",
  ingredientName: "Flour",
  brandName: "Miller",
  supplierName: "Current Supplier",
  purchaseDate: "2026-08-01",
  createdAt: "2026-08-01T00:00:00.000Z",
  packQuantity: 1000,
  unit: "g",
  totalCost: 80,
  qualityRating: 5,
  notes: "",
};

const flourIngredient: Ingredient = {
  id: "ingredient-flour",
  name: "Flour",
  baseUnit: "g",
  category: "ingredient",
  currentQuantity: 1000,
  lowStockThreshold: 0,
  targetStockQuantity: 0,
  nearestExpirationDate: "",
  averageUnitCost: 0,
  notes: "",
  isActive: true,
  archivedAt: "",
  baseUnitMigrationFlaggedReason: null,
};

test("buildDuplicateCostingDraft regenerates only costing-owned identities", () => {
  const draft = buildDuplicateCostingDraft(sourceCosting, [sourceFormat], [sourceLine]);

  assert.equal(draft.costing.id, "");
  assert.equal(draft.costing.productId, sourceCosting.productId);
  assert.equal(draft.costing.batchId, sourceCosting.batchId);
  assert.notEqual(draft.sellingFormats[0].id, sourceFormat.id);
  assert.equal(draft.sellingFormats[0].costingId, "");
  assert.equal(draft.sellingFormats[0].name, sourceFormat.name);
  assert.notEqual(draft.sellingFormatPackagingLines[0].id, sourceLine.id);
  assert.equal(draft.sellingFormatPackagingLines[0].sellingFormatId, draft.sellingFormats[0].id);
  assert.equal(draft.sellingFormatPackagingLines[0].ingredientId, sourceLine.ingredientId);
});

test("duplicate-save creates one new costing and leaves the source value-equivalent", () => {
  const before = [sourceCosting];
  const sourceSnapshot = structuredClone(sourceCosting);
  const draft = buildDuplicateCostingDraft(sourceCosting, [sourceFormat], [sourceLine]);
  const savedDuplicate: CostingSummary = { ...draft.costing, id: "costing-v7", batchId: "batch-v7" };
  const after = [savedDuplicate, ...before];

  assert.equal(after.length, before.length + 1);
  assert.deepEqual(before[0], sourceSnapshot);
  assert.deepEqual(after.find((costing) => costing.id === sourceCosting.id), sourceSnapshot);
  assert.notEqual(savedDuplicate.id, sourceCosting.id);
});

test("duplicate-cancel creates zero records and leaves the source unchanged", () => {
  const before = [sourceCosting];
  const sourceSnapshot = structuredClone(sourceCosting);
  buildDuplicateCostingDraft(sourceCosting, [sourceFormat], [sourceLine]);
  const afterCancel = before;

  assert.equal(afterCancel.length, before.length);
  assert.deepEqual(afterCancel[0], sourceSnapshot);
});

test("duplicate ingredient rows refresh old purchase-derived costs from current purchase history", () => {
  const sourceEntrySnapshot = structuredClone(sourceIngredientEntry);
  const rows = buildDuplicateIngredientRows([sourceIngredientEntry], [currentSupply], [flourIngredient]);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "");
  assert.notEqual(rows[0].rowId, sourceIngredientEntry.id);
  assert.equal(rows[0].productId, sourceIngredientEntry.productId);
  assert.equal(rows[0].batchId, sourceIngredientEntry.batchId);
  assert.equal(rows[0].ingredientName, sourceIngredientEntry.ingredientName);
  assert.equal(rows[0].brandName, sourceIngredientEntry.brandName);
  assert.equal(rows[0].quantityUsed, sourceIngredientEntry.quantityUsed);
  assert.equal(rows[0].unit, sourceIngredientEntry.unit);
  assert.equal(rows[0].cost, 20);
  assert.match(rows[0].supplierNote, /Current Supplier/);
  assert.deepEqual(sourceIngredientEntry, sourceEntrySnapshot);
});
