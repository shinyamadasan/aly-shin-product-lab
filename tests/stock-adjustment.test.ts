import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { applyStockAdjustment, reverseStockAdjustment } from "../src/lib/stock-adjustment.ts";
import type { Ingredient, InventoryTransaction } from "../src/lib/product-lab-types.ts";

function ingredient(overrides: Partial<Ingredient> = {}): Ingredient {
  return {
    id: "eggs-id",
    name: "Eggs",
    baseUnit: "pcs",
    category: "",
    currentQuantity: 12,
    lowStockThreshold: 6,
    targetStockQuantity: 24,
    nearestExpirationDate: "",
    averageUnitCost: 8,
    notes: "",
    isActive: true,
    ...overrides,
  };
}

function transaction(overrides: Partial<InventoryTransaction> = {}): InventoryTransaction {
  return {
    id: "txn-1",
    ingredientId: "eggs-id",
    transactionType: "adjustment",
    quantityChange: -2,
    quantityBefore: 12,
    quantityAfter: 10,
    sourceType: "manual",
    sourceId: "",
    note: "",
    createdAt: "2026-08-03T00:00:00.000Z",
    ...overrides,
  };
}

const TODAY = "2026-08-03T00:00:00.000Z";

test("11. household use of 2 eggs decreases stock by 2 and creates the correct ledger entry", () => {
  const eggs = ingredient({ currentQuantity: 12 });
  const result = applyStockAdjustment({ ingredient: eggs, quantity: 2, unit: "pcs", reason: "household_use", direction: "decrease", note: "Used for weekend baking test", actor: "shin@example.com", allowNegative: false, today: TODAY });

  assert.ok(!("error" in result));
  if ("error" in result) return;
  assert.equal(result.ingredient.currentQuantity, 10);
  assert.equal(result.transaction.transactionType, "adjustment");
  assert.equal(result.transaction.reason, "household_use");
  assert.equal(result.transaction.sourceType, "manual");
  assert.equal(result.transaction.quantityChange, -2);
  assert.equal(result.transaction.quantityBefore, 12);
  assert.equal(result.transaction.quantityAfter, 10);
  assert.equal(result.transaction.actor, "shin@example.com");
});

test("12. stock adjustments never change average unit cost", () => {
  const sugar = ingredient({ id: "sugar-id", name: "Sugar", baseUnit: "g", currentQuantity: 1000, averageUnitCost: 0.09 });
  const result = applyStockAdjustment({ ingredient: sugar, quantity: 200, unit: "g", reason: "waste_or_spoilage", direction: "decrease", note: "Spilled during prep", actor: null, allowNegative: false, today: TODAY });

  assert.ok(!("error" in result));
  if ("error" in result) return;
  assert.equal(result.ingredient.averageUnitCost, 0.09);
});

test("12. stock-adjustment.ts imports nothing from costing.ts, supplies.ts, or batches.ts, so it cannot touch recipe or batch costing", () => {
  const source = readFileSync(new URL("../src/lib/stock-adjustment.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /from "\.\/costing/);
  assert.doesNotMatch(source, /from "\.\/supplies/);
  assert.doesNotMatch(source, /from "\.\/batches/);
});

test("converts the entered unit before mutating stock -- a kg adjustment against a gram-based ingredient converts, never guessed raw", () => {
  const sugar = ingredient({ id: "sugar-id", name: "Sugar", baseUnit: "g", currentQuantity: 1000 });
  const result = applyStockAdjustment({ ingredient: sugar, quantity: 0.2, unit: "kg", reason: "stock_count_correction", direction: "decrease", note: "Recount", actor: null, allowNegative: false, today: TODAY });

  assert.ok(!("error" in result));
  if ("error" in result) return;
  assert.equal(result.ingredient.currentQuantity, 800);
});

test("an incompatible unit is rejected, never guessed", () => {
  const milk = ingredient({ id: "milk-id", name: "Milk", baseUnit: "ml", currentQuantity: 1000 });
  const result = applyStockAdjustment({ ingredient: milk, quantity: 1, unit: "kg", reason: "other", direction: "decrease", note: "", actor: null, allowNegative: false, today: TODAY });

  assert.ok("error" in result);
});

test("blocks a decrease that would take stock negative, unless allowNegative is set", () => {
  const eggs = ingredient({ currentQuantity: 2 });
  const blocked = applyStockAdjustment({ ingredient: eggs, quantity: 5, unit: "pcs", reason: "spillage", direction: "decrease", note: "", actor: null, allowNegative: false, today: TODAY });

  assert.ok("error" in blocked);
  if (!("error" in blocked)) return;
  assert.match(blocked.error, /Not enough Eggs in stock/);

  const allowed = applyStockAdjustment({ ingredient: eggs, quantity: 5, unit: "pcs", reason: "spillage", direction: "decrease", note: "", actor: null, allowNegative: true, today: TODAY });
  assert.ok(!("error" in allowed));
  if ("error" in allowed) return;
  assert.equal(allowed.ingredient.currentQuantity, -3);
});

test("an increase (e.g. a stock-count correction that found more than expected) is also supported", () => {
  const eggs = ingredient({ currentQuantity: 10 });
  const result = applyStockAdjustment({ ingredient: eggs, quantity: 3, unit: "pcs", reason: "stock_count_correction", direction: "increase", note: "Recount found 3 more", actor: null, allowNegative: false, today: TODAY });

  assert.ok(!("error" in result));
  if ("error" in result) return;
  assert.equal(result.ingredient.currentQuantity, 13);
  assert.equal(result.transaction.quantityChange, 3);
});

// 3. A valid stock adjustment can be reversed.
test("reverseStockAdjustment round-trips exactly, pointing sourceId at the original transaction", () => {
  const eggs = ingredient({ currentQuantity: 12 });
  const applied = applyStockAdjustment({ ingredient: eggs, quantity: 2, unit: "pcs", reason: "household_use", direction: "decrease", note: "", actor: "shin@example.com", allowNegative: false, today: TODAY });

  assert.ok(!("error" in applied));
  if ("error" in applied) return;

  const result = reverseStockAdjustment(applied.ingredient, applied.transaction, "shin@example.com", "2026-08-03T01:00:00.000Z");

  assert.ok(!("error" in result));
  if ("error" in result) return;
  assert.equal(result.ingredient.currentQuantity, 12);
  assert.equal(result.transaction.transactionType, "adjustment");
  assert.equal(result.transaction.sourceId, applied.transaction.id);
  assert.equal(result.transaction.quantityChange, 2);
});

// Defensive validation: reverseStockAdjustment must not rely solely on the Inventory Timeline's
// canReverse gate. It is the actual enforcement point, so a caller invoking it directly (e.g.
// bypassing the UI) can never mutate inventory or insert a ledger row for the wrong kind of
// transaction, or optimistically create a duplicate.

// 1. A purchase transaction cannot be reversed through this handler.
test("rejects a purchase transaction -- no inventory mutation, no ledger row", () => {
  const eggs = ingredient({ currentQuantity: 12 });
  const purchase = transaction({ transactionType: "purchase", sourceType: "purchase_import", quantityChange: 12, quantityBefore: 0, quantityAfter: 12 });

  const result = reverseStockAdjustment(eggs, purchase, null, TODAY);

  assert.ok("error" in result);
  if (!("error" in result)) return;
  assert.match(result.error, /Only a stock adjustment can be reversed/);
  // No mutation occurred: the error result carries no ingredient/transaction to persist.
  assert.equal("ingredient" in result, false);
  assert.equal("transaction" in result, false);
});

// 2. A Bake transaction cannot be reversed through this handler.
test("rejects a Bake (consume) transaction -- no inventory mutation, no ledger row", () => {
  const eggs = ingredient({ currentQuantity: 12 });
  const bakeConsume = transaction({ transactionType: "consume", sourceType: "bake", sourceId: "batch-1", quantityChange: -3, quantityBefore: 15, quantityAfter: 12 });

  const result = reverseStockAdjustment(eggs, bakeConsume, null, TODAY);

  assert.ok("error" in result);
  if (!("error" in result)) return;
  assert.match(result.error, /Only a stock adjustment can be reversed/);
});

// 4. Reversing an existing reversal is explicitly rejected, not silently allowed or ambiguous.
test("rejects reversing a transaction that is already a reversal (sourceId already points at another transaction)", () => {
  const eggs = ingredient({ currentQuantity: 10 });
  const applied = applyStockAdjustment({ ingredient: eggs, quantity: 2, unit: "pcs", reason: "household_use", direction: "decrease", note: "", actor: null, allowNegative: false, today: TODAY });
  assert.ok(!("error" in applied));
  if ("error" in applied) return;

  const firstReversal = reverseStockAdjustment(applied.ingredient, applied.transaction, null, TODAY);
  assert.ok(!("error" in firstReversal));
  if ("error" in firstReversal) return;

  // Attempting to reverse the reversal itself.
  const secondReversal = reverseStockAdjustment(firstReversal.ingredient, firstReversal.transaction, null, TODAY);

  assert.ok("error" in secondReversal);
  if (!("error" in secondReversal)) return;
  assert.match(secondReversal.error, /already a reversal/);
  assert.equal("ingredient" in secondReversal, false);
  assert.equal("transaction" in secondReversal, false);
});
