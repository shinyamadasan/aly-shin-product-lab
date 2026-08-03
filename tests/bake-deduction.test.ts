import test from "node:test";
import assert from "node:assert/strict";
import { getInsufficientDeductions, groupDeductionsByIngredient, isBakeFormulaFullyResolved, resolveBakeFormula } from "../src/lib/bake-deduction.ts";
import type { BatchFormulaRow } from "../src/lib/batches.ts";
import type { Ingredient, IngredientAlias } from "../src/lib/product-lab-types.ts";

function ingredient(overrides: Partial<Ingredient> = {}): Ingredient {
  return {
    id: crypto.randomUUID(),
    name: "Cocoa Powder",
    baseUnit: "g",
    category: "",
    currentQuantity: 500,
    lowStockThreshold: 100,
    targetStockQuantity: 2000,
    nearestExpirationDate: "",
    averageUnitCost: 0.5,
    notes: "",
    isActive: true,
    ...overrides,
  };
}

function alias(overrides: Partial<IngredientAlias> = {}): IngredientAlias {
  return { id: crypto.randomUUID(), rawText: "Cocoa", normalizedText: "cocoa", ingredientId: "cocoa-id", source: "bake", ...overrides };
}

function formulaRow(overrides: Partial<BatchFormulaRow> = {}): BatchFormulaRow {
  return { brand: "", ingredient: "Cocoa Powder", previousQuantity: undefined, quantity: 25, unit: "g", change: "", step: "First mix", rowId: crypto.randomUUID(), ...overrides };
}

test("resolveBakeFormula resolves via a saved alias before exact/normalized", () => {
  const cocoa = ingredient({ id: "cocoa-id", name: "Dutch Cocoa" });
  const savedAlias = alias({ rawText: "Cocoa Powder", ingredientId: "cocoa-id" });

  const [resolved] = resolveBakeFormula([formulaRow({ ingredient: "Cocoa Powder" })], [cocoa], [savedAlias]);

  assert.equal(resolved.matchMethod, "alias");
  assert.equal(resolved.ingredientId, "cocoa-id");
});

test("resolveBakeFormula resolves via an exact ingredient-name match", () => {
  const cocoa = ingredient({ id: "cocoa-id", name: "Cocoa Powder" });

  const [resolved] = resolveBakeFormula([formulaRow({ ingredient: "Cocoa Powder" })], [cocoa], []);

  assert.equal(resolved.matchMethod, "exact");
  assert.equal(resolved.ingredientId, "cocoa-id");
});

test("resolveBakeFormula resolves via a normalized match when the formula text has package-size noise", () => {
  const cocoa = ingredient({ id: "cocoa-id", name: "Cocoa Powder" });

  const [resolved] = resolveBakeFormula([formulaRow({ ingredient: "Cocoa Powder 500g" })], [cocoa], []);

  assert.equal(resolved.matchMethod, "normalized");
  assert.equal(resolved.ingredientId, "cocoa-id");
});

test("resolveBakeFormula leaves a row unresolved (manual assignment required) when nothing matches", () => {
  const [resolved] = resolveBakeFormula([formulaRow({ ingredient: "Mystery Ingredient" })], [ingredient()], []);

  assert.equal(resolved.matchMethod, "none");
  assert.equal(resolved.ingredientId, "");
  assert.equal(resolved.convertedQuantity, null);
});

test("resolveBakeFormula marks an unsupported unit as unconverted even when the ingredient matches", () => {
  const cocoa = ingredient({ id: "cocoa-id", name: "Cocoa Powder", baseUnit: "g" });

  const [resolved] = resolveBakeFormula([formulaRow({ ingredient: "Cocoa Powder", quantity: 1, unit: "tbsp" })], [cocoa], []);

  assert.equal(resolved.ingredientId, "cocoa-id");
  assert.equal(resolved.convertedQuantity, null);
});

test("resolveBakeFormula converts g<->kg and ml<->L against the ingredient's base unit", () => {
  const flour = ingredient({ id: "flour-id", name: "Flour", baseUnit: "g" });
  const milk = ingredient({ id: "milk-id", name: "Milk", baseUnit: "ml" });

  const resolved = resolveBakeFormula(
    [formulaRow({ ingredient: "Flour", quantity: 0.5, unit: "kg" }), formulaRow({ ingredient: "Milk", quantity: 0.25, unit: "L" })],
    [flour, milk],
    [],
  );

  assert.equal(resolved[0].convertedQuantity, 500);
  assert.equal(resolved[1].convertedQuantity, 250);
});

test("resolveBakeFormula keeps the same ingredient used in two different steps as two separate rows", () => {
  const cocoa = ingredient({ id: "cocoa-id", name: "Cocoa Powder" });
  const rows = [
    formulaRow({ ingredient: "Cocoa Powder", quantity: 25, unit: "g", step: "First mix" }),
    formulaRow({ ingredient: "Cocoa Powder", quantity: 5, unit: "g", step: "Sprinkle" }),
  ];

  const resolved = resolveBakeFormula(rows, [cocoa], []);

  assert.equal(resolved.length, 2);
  assert.equal(resolved[0].step, "First mix");
  assert.equal(resolved[1].step, "Sprinkle");
});

test("resolveBakeFormula skips rows with a blank ingredient name", () => {
  const resolved = resolveBakeFormula([formulaRow({ ingredient: "  " })], [], []);

  assert.deepEqual(resolved, []);
});

test("resolveBakeFormula does not mutate the ingredients or aliases arrays passed in", () => {
  const ingredients = [ingredient({ id: "cocoa-id", name: "Cocoa Powder" })];
  const aliases: IngredientAlias[] = [];
  const snapshot = JSON.parse(JSON.stringify(ingredients));

  resolveBakeFormula([formulaRow()], ingredients, aliases);

  assert.deepEqual(ingredients, snapshot);
});

test("isBakeFormulaFullyResolved is true only when every row has an ingredient and a converted quantity", () => {
  const cocoa = ingredient({ id: "cocoa-id", name: "Cocoa Powder" });
  const resolved = resolveBakeFormula([formulaRow({ ingredient: "Cocoa Powder" })], [cocoa], []);

  assert.equal(isBakeFormulaFullyResolved(resolved), true);
});

test("isBakeFormulaFullyResolved is false when any row is unresolved", () => {
  const resolved = resolveBakeFormula([formulaRow({ ingredient: "Unknown" })], [], []);

  assert.equal(isBakeFormulaFullyResolved(resolved), false);
});

test("isBakeFormulaFullyResolved is false when any row's unit didn't convert, even if the ingredient matched", () => {
  const cocoa = ingredient({ id: "cocoa-id", name: "Cocoa Powder", baseUnit: "g" });
  const resolved = resolveBakeFormula([formulaRow({ ingredient: "Cocoa Powder", unit: "tbsp" })], [cocoa], []);

  assert.equal(isBakeFormulaFullyResolved(resolved), false);
});

test("isBakeFormulaFullyResolved is false for an empty formula (nothing to bake)", () => {
  assert.equal(isBakeFormulaFullyResolved([]), false);
});

test("groupDeductionsByIngredient sums multiple rows for the same ingredient only after each row is already converted", () => {
  const flour = ingredient({ id: "flour-id", name: "Flour", baseUnit: "g" });
  const rows = [
    formulaRow({ ingredient: "Flour", quantity: 200, unit: "g", step: "Mix" }),
    formulaRow({ ingredient: "Flour", quantity: 0.1, unit: "kg", step: "Dusting" }),
  ];
  const resolved = resolveBakeFormula(rows, [flour], []);

  const deductions = groupDeductionsByIngredient(resolved, 1);

  assert.equal(deductions.length, 1);
  assert.equal(deductions[0].ingredientId, "flour-id");
  assert.equal(deductions[0].quantity, 300); // 200g + (0.1kg -> 100g), summed post-conversion
});

test("groupDeductionsByIngredient applies the multiplier to the grouped total", () => {
  const cocoa = ingredient({ id: "cocoa-id", name: "Cocoa Powder" });
  const resolved = resolveBakeFormula([formulaRow({ ingredient: "Cocoa Powder", quantity: 25, unit: "g" })], [cocoa], []);

  const deductions = groupDeductionsByIngredient(resolved, 2.5);

  assert.equal(deductions[0].quantity, 62.5);
});

test("groupDeductionsByIngredient excludes unresolved rows from the grouped total", () => {
  const resolved = resolveBakeFormula([formulaRow({ ingredient: "Unknown" })], [], []);

  assert.deepEqual(groupDeductionsByIngredient(resolved, 1), []);
});

test("getInsufficientDeductions reports a shortfall when a deduction exceeds current stock", () => {
  const flour = ingredient({ id: "flour-id", name: "Flour", currentQuantity: 100 });

  const shortfalls = getInsufficientDeductions([{ ingredientId: "flour-id", quantity: 150 }], [flour]);

  assert.equal(shortfalls.length, 1);
  assert.equal(shortfalls[0].available, 100);
  assert.equal(shortfalls[0].needed, 150);
  assert.equal(shortfalls[0].shortfall, 50);
});

test("getInsufficientDeductions reports nothing when stock is sufficient", () => {
  const flour = ingredient({ id: "flour-id", name: "Flour", currentQuantity: 500 });

  assert.deepEqual(getInsufficientDeductions([{ ingredientId: "flour-id", quantity: 150 }], [flour]), []);
});
