import test from "node:test";
import assert from "node:assert/strict";
import { archiveItem, buildHardDeleteBlockedMessage, canHardDeleteItem, getItemReferenceSummary, itemReferenceCount, restoreItem } from "../src/lib/inventory-safety.ts";
import type { CostingEntry, Ingredient, IngredientAlias, InventoryTransaction, ProductBatch, SellingFormatPackagingLine, SupplyEntry } from "../src/lib/product-lab-types.ts";

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

// These four tests prove the renamed-ingredient fix: saveIngredient's local/offline branch, and
// the ingredients_preserve_rename_history database trigger for the Supabase branch, both record an
// Item's old name as an ingredient_aliases row (source "rename") whenever a genuine rename happens.
// getItemReferenceSummary doesn't need to know anything about renames specifically -- it already
// treats ANY alias for this id as a durable reference, exactly like an alias created by CSV-import
// or bake-formula matching. These tests exist to prove that reuse actually closes the gap: a
// renamed Item whose old-name historical records (costing, batch formula, unmatched purchases) no
// longer match its CURRENT name under normalizeIngredientName must still be blocked, and it's the
// alias -- not the name match -- doing the blocking.
test("a rename-sourced alias blocks hard delete even when every name-matched category is zero under the current name", () => {
  const item = ingredient({ id: "flour-id", name: "APF (renamed)" });
  const oldNameAlias: IngredientAlias = {
    id: "alias-1",
    rawText: "All Purpose Flour",
    normalizedText: "all purpose flour",
    ingredientId: "flour-id",
    source: "rename",
  };
  // Historical records exist ONLY under the ingredient's OLD name -- none of them match "APF
  // (renamed)", so every name-matched category comes back zero. Only the rename alias reflects
  // that this Item has real history.
  const costingUnderOldName: CostingEntry = {
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
  const summary = summaryFor(item, { ingredientAliases: [oldNameAlias], costingEntries: [costingUnderOldName] });

  assert.equal(summary.legacyText.costingEntries, 0, "the old-name costing entry does not match the new name -- this is the exact gap being closed");
  assert.equal(summary.durable.aliases, 1);
  assert.equal(canHardDeleteItem(summary), false);
});

test("multiple renames leave multiple old-name aliases, and any one of them still blocks hard delete", () => {
  const item = ingredient({ id: "flour-id", name: "Current Name" });
  const aliases: IngredientAlias[] = [
    { id: "alias-1", rawText: "Original Name", normalizedText: "original name", ingredientId: "flour-id", source: "rename" },
    { id: "alias-2", rawText: "Intermediate Name", normalizedText: "intermediate name", ingredientId: "flour-id", source: "rename" },
  ];
  const summary = summaryFor(item, { ingredientAliases: aliases });

  assert.equal(summary.durable.aliases, 2);
  assert.equal(canHardDeleteItem(summary), false);
});

test("an Item that was created, then renamed, then genuinely never used stays blocked -- archive is the only option", () => {
  // Documents the intended, accepted trade-off: a typo fixed via rename (rather than delete-and-
  // recreate) permanently forfeits hard-delete eligibility even if the Item was never otherwise
  // used, because the system cannot distinguish "harmless typo fix" from "rename of something with
  // real history" after the fact. Archive remains fully available either way.
  const item = ingredient({ id: "typo-id", name: "Flour" });
  const renameAlias: IngredientAlias = {
    id: "alias-1",
    rawText: "Flur",
    normalizedText: "flur",
    ingredientId: "typo-id",
    source: "rename",
  };
  const summary = summaryFor(item, { ingredientAliases: [renameAlias] });

  assert.equal(itemReferenceCount(summary), 1);
  assert.equal(canHardDeleteItem(summary), false);
});

test("an Item that was never renamed and never used has zero aliases and can still be hard deleted", () => {
  // Confirms the fix is additive, not a regression: acceptance case #1 (brand-new unused Item)
  // still passes with zero aliases of any source.
  const item = ingredient();
  const summary = summaryFor(item);

  assert.equal(summary.durable.aliases, 0);
  assert.equal(canHardDeleteItem(summary), true);
});
