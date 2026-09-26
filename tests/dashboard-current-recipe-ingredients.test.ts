// Dashboard Inventory Attention V1 (Current Recipes Only): getCurrentRecipeIngredientIds must
// reuse Bake's own "current batch" definition (buildBakeBatchChoices -- newest non-voided batch
// per product) rather than inventing a second one, and must never hardcode a version string.

import test from "node:test";
import assert from "node:assert/strict";
import { getCurrentRecipeIngredientIds } from "../src/lib/dashboard/current-recipe-ingredients.ts";
import type { Ingredient, Product, ProductBatch } from "../src/lib/product-lab-types.ts";

const BROWNIE = { id: "product-brownie", name: "Brownies" } as Product;
const COOKIES = { id: "product-cookies", name: "Cookies" } as Product;

function ingredient(overrides: Partial<Ingredient> = {}): Ingredient {
  return {
    id: crypto.randomUUID(),
    name: "Fresh Milk",
    baseUnit: "g",
    category: "",
    currentQuantity: 1000,
    lowStockThreshold: 200,
    targetStockQuantity: 2000,
    nearestExpirationDate: "",
    averageUnitCost: 0,
    notes: "",
    isActive: true,
    ...overrides,
  };
}

// A version LABEL only -- arbitrary text, never compared or parsed by getCurrentRecipeIngredientIds
// (that would be hardcoding a version string). "Current" is decided entirely by dateMade + void
// state, exactly as buildBakeBatchChoices already decides it for Bake.
function batch(productId: string, ingredientsUsed: Ingredient[], overrides: Partial<ProductBatch> = {}): ProductBatch {
  return {
    id: crypto.randomUUID(),
    productId,
    batchVersion: overrides.batchVersion ?? "some label, never inspected",
    status: "completed",
    dateMade: "2026-08-01",
    ingredientsNotes: JSON.stringify(ingredientsUsed.map((item) => ({ ingredient: item.name, quantity: 1, unit: item.baseUnit }))),
    prepTimeMinutes: 0,
    bakeTimeMinutes: 0,
    coolingTimeMinutes: 0,
    usablePieces: 0,
    imperfectPieces: 0,
    stressLevel: 0,
    tasteNotes: "",
    textureNotes: "",
    wentWrong: "",
    improveNext: "",
    launchDecision: "launch",
    ...overrides,
  };
}

test("an ingredient used by a product's only batch is included", () => {
  const cocoa = ingredient({ name: "Cocoa Powder" });
  const ids = getCurrentRecipeIngredientIds([BROWNIE], [batch(BROWNIE.id, [cocoa])], [cocoa], []);
  assert.deepEqual([...ids], [cocoa.id]);
});

test("only the NEWEST batch's ingredients count -- an older version's now-unused ingredient is excluded", () => {
  // V-old used Coffee; the newer batch replaced it with Vanilla. Nothing here is compared by label,
  // only by dateMade -- proving no version string is hardcoded anywhere in the resolution.
  const coffee = ingredient({ name: "100% Colombian Regular Instant Coffee" });
  const vanilla = ingredient({ name: "Vanilla Extract" });
  const older = batch(BROWNIE.id, [coffee], { batchVersion: "V-old", dateMade: "2026-01-01" });
  const newer = batch(BROWNIE.id, [vanilla], { batchVersion: "V-new", dateMade: "2026-08-01" });

  const ids = getCurrentRecipeIngredientIds([BROWNIE], [older, newer], [coffee, vanilla], []);

  assert.deepEqual([...ids], [vanilla.id]);
});

test("a voided newest batch is skipped -- the first non-voided batch by date is current, matching Bake", () => {
  const retired = ingredient({ name: "Old Formula Ingredient" });
  const live = ingredient({ name: "Live Formula Ingredient" });
  const voided = batch(BROWNIE.id, [retired], { dateMade: "2026-08-05", status: "voided" });
  const olderButLive = batch(BROWNIE.id, [live], { dateMade: "2026-08-01", status: "completed" });

  const ids = getCurrentRecipeIngredientIds([BROWNIE], [voided, olderButLive], [retired, live], []);

  assert.deepEqual([...ids], [live.id]);
});

test("a product whose every batch is voided contributes no ingredients at all", () => {
  const ing = ingredient();
  const onlyBatch = batch(BROWNIE.id, [ing], { status: "voided" });
  const ids = getCurrentRecipeIngredientIds([BROWNIE], [onlyBatch], [ing], []);
  assert.deepEqual([...ids], []);
});

test("a product with no batches at all contributes no ingredients, and does not throw", () => {
  const ids = getCurrentRecipeIngredientIds([BROWNIE], [], [ingredient()], []);
  assert.deepEqual([...ids], []);
});

test("multiple products' current recipes are unioned together", () => {
  const chocolateCoins = ingredient({ name: "Chocolate Coins" });
  const flour = ingredient({ name: "Flour" });
  const ids = getCurrentRecipeIngredientIds(
    [BROWNIE, COOKIES],
    [batch(BROWNIE.id, [flour]), batch(COOKIES.id, [chocolateCoins])],
    [chocolateCoins, flour],
    [],
  );
  assert.deepEqual([...ids].sort(), [chocolateCoins.id, flour.id].sort());
});

test("a formula row that doesn't resolve to a real ingredient contributes nothing (never a guess)", () => {
  const ids = getCurrentRecipeIngredientIds([BROWNIE], [batch(BROWNIE.id, [ingredient({ name: "Ghost Ingredient" })])], [], []);
  assert.deepEqual([...ids], []);
});

test("a formula row whose unit does not convert to the ingredient's base unit is excluded, same as Bake would refuse to deduct it", () => {
  const flour = ingredient({ name: "Flour", baseUnit: "g" });
  // pcs cannot convert into a g-based ingredient -- resolveBakeFormula leaves convertedQuantity null.
  const unconvertible = batch(BROWNIE.id, [flour], { ingredientsNotes: JSON.stringify([{ ingredient: "Flour", quantity: 1, unit: "pcs" }]) });
  const ids = getCurrentRecipeIngredientIds([BROWNIE], [unconvertible], [flour], []);
  assert.deepEqual([...ids], []);
});

test("an alias resolves a raw formula name that doesn't exactly match the ingredient's own name", () => {
  const cocoa = ingredient({ name: "Cocoa Powder (Dutch)" });
  const withAlias = batch(BROWNIE.id, [], { ingredientsNotes: JSON.stringify([{ ingredient: "cocoa", quantity: 1, unit: cocoa.baseUnit }]) });
  const alias = { id: crypto.randomUUID(), rawText: "cocoa", normalizedText: "cocoa", ingredientId: cocoa.id, source: "test" };

  const ids = getCurrentRecipeIngredientIds([BROWNIE], [withAlias], [cocoa], [alias]);

  assert.deepEqual([...ids], [cocoa.id]);
});
