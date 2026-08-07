import test from "node:test";
import assert from "node:assert/strict";
import { archiveItem, buildHardDeleteBlockedMessage, canHardDeleteItem, getItemReferenceSummary, restoreItem } from "../src/lib/inventory-safety.ts";
import type { CostingEntry, Ingredient, InventoryTransaction, ProductBatch, SellingFormatPackagingLine, SupplyEntry } from "../src/lib/product-lab-types.ts";

function ingredient(overrides: Partial<Ingredient> = {}): Ingredient {
  return {
    id: "flour-id",
    name: "All Purpose Flour",
    baseUnit: "g",
    category: "ingredient",
    currentQuantity: 1000,
    lowStockThreshold: 100,
    targetStockQuantity: 2000,
    nearestExpirationDate: "",
    averageUnitCost: 0.1,
    notes: "",
    isActive: true,
    archivedAt: "",
    ...overrides,
  };
}

function sellingFormatPackagingLine(overrides: Partial<SellingFormatPackagingLine> = {}): SellingFormatPackagingLine {
  return {
    id: "line-1",
    sellingFormatId: "format-1",
    ingredientId: "flour-id",
    name: "All Purpose Flour",
    quantity: 1,
    unit: "g",
    unitCostSnapshot: 0.1,
    isManualCost: false,
    note: "",
    sortOrder: 0,
    ...overrides,
  };
}

function summaryFor(item: Ingredient, overrides: Partial<Parameters<typeof getItemReferenceSummary>[0]> = {}) {
  return getItemReferenceSummary({
    ingredient: item,
    supplies: [],
    inventoryTransactions: [],
    ingredientAliases: [],
    purchaseImportRows: [],
    batches: [],
    costingEntries: [],
    sellingFormatPackagingLines: [],
    ...overrides,
  });
}

test("referenced Item cannot be hard deleted", () => {
  const item = ingredient();
  const transaction: InventoryTransaction = {
    id: "tx-1",
    ingredientId: item.id,
    transactionType: "purchase",
    quantityChange: 100,
    quantityBefore: 0,
    quantityAfter: 100,
    sourceType: "manual",
    sourceId: "manual-1",
    note: "",
    createdAt: "2026-01-01T00:00:00.000Z",
  };

  assert.equal(canHardDeleteItem(summaryFor(item, { inventoryTransactions: [transaction] })), false);
});

test("Item archive and restore preserve references", () => {
  const item = ingredient();
  const archived = archiveItem(item, "2026-01-01T00:00:00.000Z");
  const restored = restoreItem(archived);

  assert.equal(archived.isActive, false);
  assert.equal(archived.archivedAt, "2026-01-01T00:00:00.000Z");
  assert.equal(restored.isActive, true);
  assert.equal(restored.archivedAt, "");
  assert.equal(restored.id, item.id);
});

test("archived Item is excluded from active selectors that use isActive", () => {
  const active = ingredient({ id: "active" });
  const archived = archiveItem(ingredient({ id: "archived" }), "2026-01-01T00:00:00.000Z");

  assert.deepEqual([active, archived].filter((item) => item.isActive).map((item) => item.id), ["active"]);
});

test("Item reference summary distinguishes durable IDs from legacy text matches", () => {
  const item = ingredient({ id: "flour-id", name: "All Purpose Flour" });
  const durablePurchase: SupplyEntry = {
    id: "purchase-1",
    ingredientId: "flour-id",
    ingredientName: "Old Flour Name",
    brandName: "Brand",
    supplierName: "Supplier",
    purchaseDate: "2026-01-01",
    createdAt: "",
    packQuantity: 1000,
    unit: "g",
    totalCost: 100,
    qualityRating: 5,
    notes: "",
  };
  const legacyBatch: ProductBatch = {
    id: "batch-1",
    productId: "brownies",
    batchVersion: "V1",
    dateMade: "2026-01-01",
    ingredientsNotes: JSON.stringify({ formula: [{ ingredient: "All-Purpose Flour", quantity: 100, unit: "g" }], steps: [] }),
    prepTimeMinutes: 0,
    bakeTimeMinutes: 0,
    coolingTimeMinutes: 0,
    usablePieces: 0,
    imperfectPieces: 0,
    stressLevel: 3,
    tasteNotes: "",
    textureNotes: "",
    wentWrong: "",
    improveNext: "",
    launchDecision: "retest",
  };
  const costing: CostingEntry = {
    id: "cost-1",
    productId: "brownies",
    batchId: "",
    brandName: "",
    ingredientName: "All Purpose Flour",
    quantityUsed: 1,
    unit: "g",
    cost: 1,
    supplierNote: "",
  };
  const summary = summaryFor(item, { supplies: [durablePurchase], batches: [legacyBatch], costingEntries: [costing] });

  assert.equal(summary.durable.purchases, 1);
  assert.equal(summary.legacyText.formulaRows, 1);
  assert.equal(summary.legacyText.costingEntries, 1);
  assert.equal(canHardDeleteItem(summary), false);
});

test("unreferenced Item can be hard deleted by policy", () => {
  assert.equal(canHardDeleteItem(summaryFor(ingredient())), true);
});

test("a catalog-linked Selling Format packaging line blocks deletion", () => {
  const item = ingredient();
  const line = sellingFormatPackagingLine({ ingredientId: item.id });
  const summary = summaryFor(item, { sellingFormatPackagingLines: [line] });

  assert.equal(summary.durable.sellingFormatPackagingLines, 1);
  assert.equal(canHardDeleteItem(summary), false);
});

test("two referenced Selling Format packaging lines produce a reference count of 2", () => {
  const item = ingredient();
  const lines = [
    sellingFormatPackagingLine({ id: "line-1", sellingFormatId: "format-1", ingredientId: item.id }),
    sellingFormatPackagingLine({ id: "line-2", sellingFormatId: "format-2", ingredientId: item.id }),
  ];
  const summary = summaryFor(item, { sellingFormatPackagingLines: lines });

  assert.equal(summary.durable.sellingFormatPackagingLines, 2);
});

test("a packaging line belonging to an archived Selling Format still blocks deletion", () => {
  // getItemReferenceSummary never receives or inspects SellingFormat.isActive -- archiving a
  // format leaves its packaging_lines rows exactly as they were, so this line counts identically
  // whether its parent format is active or archived. No archived-format fixture is needed to
  // prove that: the absence of any isActive input to this function is the proof.
  const item = ingredient();
  const lineUnderArchivedFormat = sellingFormatPackagingLine({ sellingFormatId: "archived-format", ingredientId: item.id });
  const summary = summaryFor(item, { sellingFormatPackagingLines: [lineUnderArchivedFormat] });

  assert.equal(summary.durable.sellingFormatPackagingLines, 1);
  assert.equal(canHardDeleteItem(summary), false);
});

test("a manual packaging line (ingredientId \"\") does not block deletion", () => {
  const item = ingredient();
  const manualLine = sellingFormatPackagingLine({ ingredientId: "", name: "Custom ribbon" });
  const summary = summaryFor(item, { sellingFormatPackagingLines: [manualLine] });

  assert.equal(summary.durable.sellingFormatPackagingLines, 0);
  assert.equal(canHardDeleteItem(summary), true);
});

test("a packaging line referencing a different Ingredient does not block this one", () => {
  const item = ingredient({ id: "flour-id" });
  const lineForAnotherIngredient = sellingFormatPackagingLine({ ingredientId: "sugar-id" });
  const summary = summaryFor(item, { sellingFormatPackagingLines: [lineForAnotherIngredient] });

  assert.equal(summary.durable.sellingFormatPackagingLines, 0);
  assert.equal(canHardDeleteItem(summary), true);
});

test("existing reference-blocked deletion behavior is unchanged when there is no Selling Format reference", () => {
  const item = ingredient();
  const transaction: InventoryTransaction = {
    id: "tx-1",
    ingredientId: item.id,
    transactionType: "purchase",
    quantityChange: 100,
    quantityBefore: 0,
    quantityAfter: 100,
    sourceType: "manual",
    sourceId: "manual-1",
    note: "",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  const summary = summaryFor(item, { inventoryTransactions: [transaction] });

  assert.equal(canHardDeleteItem(summary), false);
  assert.equal(buildHardDeleteBlockedMessage(item, summary), "Permanent delete blocked. All Purpose Flour has 1 reference. Archive keeps history intact.");
});

test("buildHardDeleteBlockedMessage names Selling Format packaging usage, with correct pluralization", () => {
  const item = ingredient();
  const twoLines = summaryFor(item, {
    sellingFormatPackagingLines: [sellingFormatPackagingLine({ id: "line-1" }), sellingFormatPackagingLine({ id: "line-2", sellingFormatId: "format-2" })],
  });
  const oneLine = summaryFor(item, { sellingFormatPackagingLines: [sellingFormatPackagingLine()] });

  assert.equal(buildHardDeleteBlockedMessage(item, twoLines), "All Purpose Flour cannot be permanently deleted because it is used by 2 Selling Format packaging lines. Archive keeps history intact.");
  assert.equal(buildHardDeleteBlockedMessage(item, oneLine), "All Purpose Flour cannot be permanently deleted because it is used by 1 Selling Format packaging line. Archive keeps history intact.");
});
