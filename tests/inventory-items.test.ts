import test from "node:test";
import assert from "node:assert/strict";
import { buildInventoryItemView, buildInventoryItemViews } from "../src/lib/inventory-items.ts";
import type { Ingredient, SupplyEntry } from "../src/lib/product-lab-types.ts";

function ingredient(overrides: Partial<Ingredient> = {}): Ingredient {
  return {
    id: crypto.randomUUID(),
    name: "Dark Chocolate Compound",
    baseUnit: "g",
    category: "ingredient",
    currentQuantity: 500,
    lowStockThreshold: 100,
    targetStockQuantity: 1000,
    nearestExpirationDate: "",
    averageUnitCost: 0,
    notes: "",
    isActive: true,
    ...overrides,
  };
}

function supply(overrides: Partial<SupplyEntry> = {}): SupplyEntry {
  return {
    id: crypto.randomUUID(),
    ingredientId: "",
    ingredientName: "Dark Chocolate Compound",
    brandName: "Van Houten",
    supplierName: "SM Supermarket",
    purchaseDate: "2026-01-01",
    createdAt: "2026-01-01T00:00:00.000Z",
    packQuantity: 1000,
    unit: "g",
    totalCost: 450,
    qualityRating: 4,
    notes: "",
    ...overrides,
  };
}

test("buildInventoryItemView composes the latest purchase's brand, supplier, package size, and unit price", () => {
  const view = buildInventoryItemView(ingredient(), [supply()]);

  assert.equal(view.latestBrand, "Van Houten");
  assert.equal(view.latestSupplier, "SM Supermarket");
  assert.equal(view.latestPackageSize, "1000g");
  assert.equal(view.latestUnitPrice, 0.45);
  assert.equal(view.purchaseHistory.length, 1);
});

test("buildInventoryItemView picks the most recent purchase, not the cheapest", () => {
  const older = supply({ id: "older", purchaseDate: "2026-01-01", totalCost: 300, brandName: "Beryl's" });
  const newer = supply({ id: "newer", purchaseDate: "2026-06-01", totalCost: 450, brandName: "Van Houten" });

  const view = buildInventoryItemView(ingredient(), [older, newer]);

  assert.equal(view.latestPurchase?.id, "newer");
  assert.equal(view.latestBrand, "Van Houten");
  assert.deepEqual(view.purchaseHistory.map((entry) => entry.id), ["newer", "older"]);
});

test("buildInventoryItemView matches purchase history by normalized ingredient name, tolerating package-size and punctuation variance", () => {
  const matching = supply({ ingredientName: "Dark Chocolate Compound, 1kg" });
  const unrelated = supply({ ingredientName: "Refined Sugar" });

  const view = buildInventoryItemView(ingredient(), [matching, unrelated]);

  assert.deepEqual(view.purchaseHistory.map((entry) => entry.id), [matching.id]);
});

test("buildInventoryItemView prefers ingredientId and only falls back to name for legacy rows", () => {
  const item = ingredient({ id: "ingredient-1", name: "Dark Chocolate Compound" });
  const durableMatch = supply({ id: "durable", ingredientId: "ingredient-1", ingredientName: "Legacy Typo" });
  const legacyMatch = supply({ id: "legacy", ingredientId: "", ingredientName: "Dark Chocolate Compound" });
  const otherItem = supply({ id: "other", ingredientId: "ingredient-2", ingredientName: "Dark Chocolate Compound" });

  const view = buildInventoryItemView(item, [durableMatch, legacyMatch, otherItem]);

  assert.deepEqual(view.purchaseHistory.map((entry) => entry.id), ["durable", "legacy"]);
});

test("buildInventoryItemView stays linked after an Item rename when purchases have ingredientId", () => {
  const item = ingredient({ id: "ingredient-1", name: "Chocolate Compound - Dark" });
  const durableMatch = supply({ id: "durable", ingredientId: "ingredient-1", ingredientName: "Dark Chocolate Compound" });
  const unknownId = supply({ id: "unknown", ingredientId: "missing-id", ingredientName: "Chocolate Compound - Dark" });

  const view = buildInventoryItemView(item, [durableMatch, unknownId]);

  assert.deepEqual(view.purchaseHistory.map((entry) => entry.id), ["durable"]);
  assert.equal(view.latestBrand, "Van Houten");
});

test("buildInventoryItemView returns empty composed fields for an item with no purchase history yet", () => {
  const view = buildInventoryItemView(ingredient({ name: "Brand New Item" }), [supply()]);

  assert.equal(view.latestPurchase, undefined);
  assert.equal(view.latestBrand, "");
  assert.equal(view.latestSupplier, "");
  assert.equal(view.latestPackageSize, "");
  assert.equal(view.latestUnitPrice, 0);
  assert.deepEqual(view.purchaseHistory, []);
});

test("buildInventoryItemView counts distinct brands and suppliers, normalizing spelling variance for brands", () => {
  const spelling1 = supply({ brandName: "Vanhouten", supplierName: "SM Supermarket" });
  const spelling2 = supply({ brandName: "Van Houten", supplierName: "SM Supermarket" });
  const differentBrand = supply({ brandName: "Beryl's", supplierName: "Main Street Market" });

  const view = buildInventoryItemView(ingredient(), [spelling1, spelling2, differentBrand]);

  assert.equal(view.distinctBrandCount, 2);
  assert.equal(view.distinctSupplierCount, 2);
});

test("buildInventoryItemViews composes one view per ingredient", () => {
  const chocolate = ingredient({ name: "Dark Chocolate Compound" });
  const sugar = ingredient({ name: "Refined Sugar" });
  const chocolateSupply = supply({ ingredientName: "Dark Chocolate Compound" });
  const sugarSupply = supply({ ingredientName: "Refined Sugar", brandName: "" });

  const views = buildInventoryItemViews([chocolate, sugar], [chocolateSupply, sugarSupply]);

  assert.equal(views.length, 2);
  assert.equal(views[0].ingredient.id, chocolate.id);
  assert.equal(views[0].latestBrand, "Van Houten");
  assert.equal(views[1].ingredient.id, sugar.id);
  assert.equal(views[1].latestBrand, "");
});
