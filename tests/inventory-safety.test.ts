import test from "node:test";
import assert from "node:assert/strict";
import { archiveItem, canHardDeleteItem, getItemReferenceSummary, restoreItem } from "../src/lib/inventory-safety.ts";
import type { CostingEntry, Ingredient, InventoryTransaction, ProductBatch, SupplyEntry } from "../src/lib/product-lab-types.ts";

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

function summaryFor(item: Ingredient, overrides: Partial<Parameters<typeof getItemReferenceSummary>[0]> = {}) {
  return getItemReferenceSummary({
    ingredient: item,
    supplies: [],
    inventoryTransactions: [],
    ingredientAliases: [],
    purchaseImportRows: [],
    batches: [],
    costingEntries: [],
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
