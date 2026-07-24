import test from "node:test";
import assert from "node:assert/strict";
import { applyBakeConfirmation } from "../src/lib/bake-confirm.ts";
import type { BakeDeduction } from "../src/lib/bake-deduction.ts";
import type { Ingredient } from "../src/lib/product-lab-types.ts";

function ingredient(overrides: Partial<Ingredient> = {}): Ingredient {
  return {
    id: "flour-id",
    name: "Flour",
    baseUnit: "g",
    currentQuantity: 1000,
    lowStockThreshold: 200,
    targetStockQuantity: 5000,
    nearestExpirationDate: "",
    averageUnitCost: 0.05,
    notes: "",
    isActive: true,
    ...overrides,
  };
}

function deduction(overrides: Partial<BakeDeduction> = {}): BakeDeduction {
  return { ingredientId: "flour-id", quantity: 300, ...overrides };
}

const BASE_INPUT = { batchId: "batch-1", batchLabel: "Brownies V3", multiplier: 1, allowNegative: false, today: "2026-07-24T00:00:00.000Z" };

test("deducts the ingredient's quantity by the deduction amount", () => {
  const result = applyBakeConfirmation({ ...BASE_INPUT, ingredients: [ingredient({ currentQuantity: 1000 })], deductions: [deduction({ quantity: 300 })] });

  assert.ok(!("error" in result));
  if ("error" in result) return;
  assert.equal(result.ingredients[0].currentQuantity, 700);
});

test("accepts a decimal multiplier (deduction amount already reflects it -- multiplier itself only affects the note)", () => {
  const result = applyBakeConfirmation({ ...BASE_INPUT, multiplier: 1.5, ingredients: [ingredient({ currentQuantity: 1000 })], deductions: [deduction({ quantity: 450 })] });

  assert.ok(!("error" in result));
  if ("error" in result) return;
  assert.equal(result.ingredients[0].currentQuantity, 550);
  assert.match(result.transactions[0].note, /×1\.5/);
});

test("rejects a zero multiplier", () => {
  const result = applyBakeConfirmation({ ...BASE_INPUT, multiplier: 0, ingredients: [ingredient()], deductions: [deduction()] });

  assert.ok("error" in result);
});

test("rejects a negative multiplier", () => {
  const result = applyBakeConfirmation({ ...BASE_INPUT, multiplier: -2, ingredients: [ingredient()], deductions: [deduction()] });

  assert.ok("error" in result);
});

test("rejects a non-finite multiplier", () => {
  const result = applyBakeConfirmation({ ...BASE_INPUT, multiplier: Number.NaN, ingredients: [ingredient()], deductions: [deduction()] });

  assert.ok("error" in result);
});

test("rejects when there are no deductions", () => {
  const result = applyBakeConfirmation({ ...BASE_INPUT, ingredients: [ingredient()], deductions: [] });

  assert.ok("error" in result);
});

test("blocks a normal confirmation when stock is insufficient", () => {
  const result = applyBakeConfirmation({ ...BASE_INPUT, ingredients: [ingredient({ currentQuantity: 100 })], deductions: [deduction({ quantity: 300 })] });

  assert.ok("error" in result);
});

test("an explicit override allows the deduction to proceed into negative stock", () => {
  const result = applyBakeConfirmation({ ...BASE_INPUT, allowNegative: true, ingredients: [ingredient({ currentQuantity: 100 })], deductions: [deduction({ quantity: 300 })] });

  assert.ok(!("error" in result));
  if ("error" in result) return;
  assert.equal(result.ingredients[0].currentQuantity, -200);
});

test("creates exactly one inventory_transactions record per affected ingredient", () => {
  const flour = ingredient({ id: "flour-id", currentQuantity: 1000 });
  const sugar = ingredient({ id: "sugar-id", name: "Sugar", currentQuantity: 500 });

  const result = applyBakeConfirmation({
    ...BASE_INPUT,
    ingredients: [flour, sugar],
    deductions: [deduction({ ingredientId: "flour-id", quantity: 300 }), deduction({ ingredientId: "sugar-id", quantity: 100 })],
  });

  assert.ok(!("error" in result));
  if ("error" in result) return;
  assert.equal(result.transactions.length, 2);
});

test("each transaction has transaction_type consume, source_type bake, source_id the batch id, and a useful note", () => {
  const result = applyBakeConfirmation({ ...BASE_INPUT, batchId: "batch-42", batchLabel: "Spanish Latte V2", multiplier: 1, ingredients: [ingredient({ currentQuantity: 1000 })], deductions: [deduction({ quantity: 300 })] });

  assert.ok(!("error" in result));
  if ("error" in result) return;
  const [transaction] = result.transactions;
  assert.equal(transaction.transactionType, "consume");
  assert.equal(transaction.sourceType, "bake");
  assert.equal(transaction.sourceId, "batch-42");
  assert.equal(transaction.quantityChange, -300);
  assert.equal(transaction.quantityBefore, 1000);
  assert.equal(transaction.quantityAfter, 700);
  assert.match(transaction.note, /Bake: Spanish Latte V2/);
});

test("never modifies average_unit_cost", () => {
  const result = applyBakeConfirmation({ ...BASE_INPUT, ingredients: [ingredient({ currentQuantity: 1000, averageUnitCost: 0.05 })], deductions: [deduction({ quantity: 300 })] });

  assert.ok(!("error" in result));
  if ("error" in result) return;
  assert.equal(result.ingredients[0].averageUnitCost, 0.05);
});

test("does not mutate the ingredients array passed in", () => {
  const ingredients = [ingredient({ currentQuantity: 1000 })];
  const snapshot = JSON.parse(JSON.stringify(ingredients));

  applyBakeConfirmation({ ...BASE_INPUT, ingredients, deductions: [deduction({ quantity: 300 })] });

  assert.deepEqual(ingredients, snapshot);
});

test("does not mutate the deductions array passed in", () => {
  const deductions = [deduction({ quantity: 300 })];
  const snapshot = JSON.parse(JSON.stringify(deductions));

  applyBakeConfirmation({ ...BASE_INPUT, ingredients: [ingredient({ currentQuantity: 1000 })], deductions });

  assert.deepEqual(deductions, snapshot);
});

test("applying the same confirmation a second time on its own would double the deduction -- demonstrating why the caller must guard re-entrancy (fast double-click) itself", () => {
  const firstIngredients = [ingredient({ currentQuantity: 1000 })];
  const firstResult = applyBakeConfirmation({ ...BASE_INPUT, ingredients: firstIngredients, deductions: [deduction({ quantity: 300 })] });
  assert.ok(!("error" in firstResult));
  if ("error" in firstResult) return;

  const secondResult = applyBakeConfirmation({ ...BASE_INPUT, ingredients: firstResult.ingredients, deductions: [deduction({ quantity: 300 })] });
  assert.ok(!("error" in secondResult));
  if ("error" in secondResult) return;

  assert.equal(secondResult.ingredients[0].currentQuantity, 400); // 1000 - 300 - 300, not 700
});
