import test from "node:test";
import assert from "node:assert/strict";
import { computeWeightedAverageUnitCost, getInventoryValue, getTotalInventoryValue } from "../src/lib/inventory-cost.ts";
import type { Ingredient } from "../src/lib/product-lab-types.ts";

function ingredient(overrides: Partial<Ingredient> = {}): Ingredient {
  return {
    id: crypto.randomUUID(),
    name: "Fresh Milk",
    baseUnit: "ml",
    category: "",
    currentQuantity: 10,
    lowStockThreshold: 2,
    targetStockQuantity: 20,
    nearestExpirationDate: "",
    averageUnitCost: 92,
    notes: "",
    isActive: true,
    ...overrides,
  };
}

test("getInventoryValue multiplies current quantity by average unit cost", () => {
  assert.equal(getInventoryValue(ingredient({ currentQuantity: 10, averageUnitCost: 92 })), 920);
});

test("getInventoryValue is zero when no average cost has been set", () => {
  assert.equal(getInventoryValue(ingredient({ currentQuantity: 10, averageUnitCost: 0 })), 0);
});

test("getTotalInventoryValue sums every ingredient's value", () => {
  const milk = ingredient({ id: "milk", currentQuantity: 10, averageUnitCost: 92 });
  const sugar = ingredient({ id: "sugar", currentQuantity: 5, averageUnitCost: 85 });

  assert.equal(getTotalInventoryValue([milk, sugar]), 920 + 425);
});

test("getTotalInventoryValue is zero for an empty ingredient list", () => {
  assert.equal(getTotalInventoryValue([]), 0);
});

test("computeWeightedAverageUnitCost: first-ever purchase with no prior stock takes the purchase's own unit cost", () => {
  // 10 L bought for PHP 920 total -> PHP 92/L, with nothing on hand before.
  const result = computeWeightedAverageUnitCost(0, 0, 10, 920, 0);

  assert.equal(result, 92);
});

test("computeWeightedAverageUnitCost blends a priced purchase into existing stock", () => {
  // 10 L on hand at PHP 92/L (PHP 920 total), plus 10 L bought for PHP 1000 (PHP 100/L).
  // New average = (920 + 1000) / 20 = PHP 96/L.
  const result = computeWeightedAverageUnitCost(10, 92, 10, 1000, 0);

  assert.equal(result, 96);
});

test("computeWeightedAverageUnitCost values unpriced added quantity at the current average, leaving the average unchanged", () => {
  // 10 L on hand at PHP 92/L, plus 5 L bought with no price on the receipt row.
  // The unpriced 5 L is valued at the current average (92), so the average itself doesn't move.
  const result = computeWeightedAverageUnitCost(10, 92, 0, 0, 5);

  assert.equal(result, 92);
});

test("computeWeightedAverageUnitCost handles a mix of priced and unpriced quantity in the same purchase", () => {
  // 10 L on hand at PHP 92/L (PHP 920). Purchase: 5 L priced at PHP 500 (PHP 100/L) + 5 L unpriced
  // (valued at the current average, 92 -> PHP 460). New average = (920 + 500 + 460) / 20 = 94.
  const result = computeWeightedAverageUnitCost(10, 92, 5, 500, 5);

  assert.equal(result, 94);
});

test("computeWeightedAverageUnitCost returns the current average when total quantity would be zero or negative", () => {
  const result = computeWeightedAverageUnitCost(0, 50, 0, 0, 0);

  assert.equal(result, 50);
});
