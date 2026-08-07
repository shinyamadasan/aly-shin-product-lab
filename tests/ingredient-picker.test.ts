import test from "node:test";
import assert from "node:assert/strict";
import { getEligibleIngredientsForPicker } from "../src/lib/ingredient-picker-filter.ts";
import type { Ingredient } from "../src/lib/product-lab-types.ts";

function ingredient(overrides: Partial<Ingredient> = {}): Ingredient {
  return {
    id: crypto.randomUUID(),
    name: "Item",
    baseUnit: "g",
    category: "ingredient",
    currentQuantity: 0,
    lowStockThreshold: 0,
    targetStockQuantity: 0,
    nearestExpirationDate: "",
    averageUnitCost: 0,
    notes: "",
    isActive: true,
    ...overrides,
  };
}

test("getEligibleIngredientsForPicker: with no options, returns every ingredient unchanged (every pre-existing caller's default)", () => {
  const flour = ingredient({ id: "flour", category: "ingredient" });
  const box = ingredient({ id: "box", category: "packaging" });
  assert.deepEqual(getEligibleIngredientsForPicker([flour, box]), [flour, box]);
});

test("getEligibleIngredientsForPicker: excludeCategories hard-excludes packaging items entirely (Bake/formula pickers)", () => {
  const flour = ingredient({ id: "flour", category: "ingredient" });
  const box = ingredient({ id: "box", category: "packaging" });
  const result = getEligibleIngredientsForPicker([flour, box], { excludeCategories: ["packaging"] });
  assert.deepEqual(result, [flour]);
});

test("getEligibleIngredientsForPicker: excludeCategories leaves non-packaging ingredients completely unaffected", () => {
  const flour = ingredient({ id: "flour", category: "ingredient" });
  const iceCubes = ingredient({ id: "ice", category: "consumable" });
  const misc = ingredient({ id: "misc", category: "other" });
  const uncategorized = ingredient({ id: "uncategorized", category: "" });
  const result = getEligibleIngredientsForPicker([flour, iceCubes, misc, uncategorized], { excludeCategories: ["packaging"] });
  assert.deepEqual(result, [flour, iceCubes, misc, uncategorized]);
});

test("getEligibleIngredientsForPicker: excludeCategories with no packaging items present is a no-op", () => {
  const flour = ingredient({ id: "flour", category: "ingredient" });
  const sugar = ingredient({ id: "sugar", category: "ingredient" });
  assert.deepEqual(getEligibleIngredientsForPicker([flour, sugar], { excludeCategories: ["packaging"] }), [flour, sugar]);
});

test("getEligibleIngredientsForPicker: scopeToCategory (Selling Formats' default) narrows to just that category", () => {
  const flour = ingredient({ id: "flour", category: "ingredient" });
  const box = ingredient({ id: "box", category: "packaging" });
  const sticker = ingredient({ id: "sticker", category: "packaging" });
  const result = getEligibleIngredientsForPicker([flour, box, sticker], { scopeToCategory: "packaging" });
  assert.deepEqual(result, [box, sticker]);
});

test("getEligibleIngredientsForPicker: scopeToCategory omitted (\"Use another supply\" broadened) returns the full catalog again", () => {
  const flour = ingredient({ id: "flour", category: "ingredient" });
  const box = ingredient({ id: "box", category: "packaging" });
  // The component clears scopeToCategory (by tracking "showAllCategories") rather than ever
  // calling this function with an exclusion that can't be lifted -- this asserts the underlying
  // function genuinely returns everything once scopeToCategory is absent, which is what makes
  // that broadening behavior possible in the first place.
  const result = getEligibleIngredientsForPicker([flour, box], {});
  assert.deepEqual(result, [flour, box]);
});

test("getEligibleIngredientsForPicker: an ingredient with no category set (\"\") is never matched by scopeToCategory", () => {
  const uncategorized = ingredient({ id: "uncategorized", category: "" });
  const box = ingredient({ id: "box", category: "packaging" });
  const result = getEligibleIngredientsForPicker([uncategorized, box], { scopeToCategory: "packaging" });
  assert.deepEqual(result, [box]);
});

test("getEligibleIngredientsForPicker: excludeCategories and scopeToCategory can combine (exclusion applies first)", () => {
  const box = ingredient({ id: "box", category: "packaging" });
  const flour = ingredient({ id: "flour", category: "ingredient" });
  // Contrived (no current caller combines both), but confirms the two options compose predictably.
  const result = getEligibleIngredientsForPicker([box, flour], { excludeCategories: ["packaging"], scopeToCategory: "ingredient" });
  assert.deepEqual(result, [flour]);
});

test("getEligibleIngredientsForPicker: does not mutate the input array or any ingredient record", () => {
  const flour = ingredient({ id: "flour", category: "ingredient" });
  const box = ingredient({ id: "box", category: "packaging" });
  const input = [flour, box];
  const inputSnapshot = [...input];
  getEligibleIngredientsForPicker(input, { excludeCategories: ["packaging"] });
  assert.deepEqual(input, inputSnapshot);
  assert.equal(box.category, "packaging"); // the excluded ingredient's own record is untouched
});
