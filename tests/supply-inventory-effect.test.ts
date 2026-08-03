import test from "node:test";
import assert from "node:assert/strict";
import {
  applySupplyPurchaseEffect,
  HISTORICAL_COST_WARNING,
  isSafeToRecalculate,
  planSupplyDelete,
  planSupplyEdit,
  repairMissingSupplyInventoryEffects,
  reverseSupplyPurchaseEffect,
  type SupplyPurchaseEffect,
} from "../src/lib/supply-inventory-effect.ts";
import type { Ingredient, InventoryTransaction, SupplyEntry } from "../src/lib/product-lab-types.ts";

function ingredient(overrides: Partial<Ingredient> = {}): Ingredient {
  return {
    id: "milk-id",
    name: "Fresh Milk",
    baseUnit: "ml",
    category: "",
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

function supply(overrides: Partial<SupplyEntry> = {}): SupplyEntry {
  return {
    id: "supply-1",
    ingredientId: "milk-id",
    ingredientName: "Fresh Milk",
    brandName: "Alaska",
    supplierName: "SM Supermarket",
    purchaseDate: "2026-01-01",
    createdAt: "2026-01-01T00:00:00.000Z",
    packQuantity: 1000,
    unit: "ml",
    totalCost: 92,
    qualityRating: 0,
    notes: "",
    ...overrides,
  };
}

function transaction(overrides: Partial<InventoryTransaction> = {}): InventoryTransaction {
  return {
    id: "txn-1",
    ingredientId: "milk-id",
    transactionType: "purchase",
    quantityChange: 1000,
    quantityBefore: 0,
    quantityAfter: 1000,
    sourceType: "manual",
    sourceId: "supply-1",
    note: "",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

// applySupplyPurchaseEffect/reverseSupplyPurchaseEffect return an {error} case (an unconvertible
// unit) alongside their success shape -- these two helpers unwrap the success case for the tests
// below that don't exercise that branch (see the dedicated conversion-fix tests further down).
function expectApplied(result: ReturnType<typeof applySupplyPurchaseEffect>): SupplyPurchaseEffect {
  if ("error" in result) throw new Error(result.error);
  return result;
}
function expectReversed(result: ReturnType<typeof reverseSupplyPurchaseEffect>): Ingredient {
  if ("error" in result) throw new Error(result.error);
  return result;
}

test("applySupplyPurchaseEffect adds quantity and blends a priced purchase into the weighted average", () => {
  const item = ingredient({ currentQuantity: 1000, averageUnitCost: 10 });
  const result = expectApplied(applySupplyPurchaseEffect(item, { packQuantity: 1000, totalCost: 20000, unit: "ml" }, "supply-2", "2026-02-01T00:00:00.000Z"));

  assert.equal(result.ingredient.currentQuantity, 2000);
  assert.equal(result.ingredient.averageUnitCost, 15); // (1000*10 + 20000) / 2000
  assert.equal(result.transaction.quantityChange, 1000);
  assert.equal(result.transaction.quantityBefore, 1000);
  assert.equal(result.transaction.quantityAfter, 2000);
  assert.equal(result.transaction.sourceType, "manual");
  assert.equal(result.transaction.sourceId, "supply-2");
});

test("applySupplyPurchaseEffect adds quantity without moving the average when unpriced", () => {
  const item = ingredient({ currentQuantity: 1000, averageUnitCost: 10 });
  const result = expectApplied(applySupplyPurchaseEffect(item, { packQuantity: 500, totalCost: 0, unit: "ml" }, "supply-2", "2026-02-01T00:00:00.000Z"));

  assert.equal(result.ingredient.currentQuantity, 1500);
  assert.equal(result.ingredient.averageUnitCost, 10);
});

test("applySupplyPurchaseEffect reuses a passed transactionId instead of minting a new one", () => {
  const item = ingredient();
  const result = expectApplied(applySupplyPurchaseEffect(item, { packQuantity: 100, totalCost: 500, unit: "ml" }, "supply-1", "2026-01-01T00:00:00.000Z", "txn-1"));

  assert.equal(result.transaction.id, "txn-1");
});

// Regression: this function used to add supply.packQuantity to currentQuantity directly, assuming
// the purchase's unit already matched the ingredient's own -- a 1kg purchase against a gram-based
// ingredient would have added 1, not 1000. It now converts first, the same convertToBaseUnit CSV
// import and Bake already use.
test("applySupplyPurchaseEffect converts a kg-recorded purchase into a gram-based ingredient's own unit", () => {
  const sugar = ingredient({ id: "sugar-id", name: "Sugar", baseUnit: "g", currentQuantity: 0, averageUnitCost: 0 });
  const result = expectApplied(applySupplyPurchaseEffect(sugar, { packQuantity: 1, totalCost: 90, unit: "kg" }, "supply-1", "2026-08-03T00:00:00.000Z"));

  assert.equal(result.ingredient.currentQuantity, 1000);
  assert.equal(result.ingredient.averageUnitCost, 0.09);
  assert.equal(result.transaction.quantityChange, 1000);
});

test("applySupplyPurchaseEffect converts a L-recorded purchase into a ml-based ingredient's own unit", () => {
  const milk = ingredient({ id: "milk-id", name: "Milk", baseUnit: "ml", currentQuantity: 0 });
  const result = expectApplied(applySupplyPurchaseEffect(milk, { packQuantity: 2, totalCost: 0, unit: "L" }, "supply-1", "2026-08-03T00:00:00.000Z"));

  assert.equal(result.ingredient.currentQuantity, 2000);
});

test("applySupplyPurchaseEffect returns an error, never a guess, for a mass unit purchased against a volume-based ingredient", () => {
  const milk = ingredient({ id: "milk-id", name: "Milk", baseUnit: "ml", currentQuantity: 1000 });
  const result = applySupplyPurchaseEffect(milk, { packQuantity: 1, totalCost: 90, unit: "kg" }, "supply-1", "2026-08-03T00:00:00.000Z");

  assert.ok("error" in result);
  if (!("error" in result)) return;
  assert.match(result.error, /kg/);
});

test("reverseSupplyPurchaseEffect exactly undoes a priced apply (round trip)", () => {
  const original = ingredient({ currentQuantity: 1000, averageUnitCost: 10 });
  const applied = expectApplied(applySupplyPurchaseEffect(original, { packQuantity: 1000, totalCost: 20000, unit: "ml" }, "supply-2", "2026-02-01T00:00:00.000Z"));

  const reversed = expectReversed(reverseSupplyPurchaseEffect(applied.ingredient, { packQuantity: 1000, totalCost: 20000, unit: "ml" }));

  assert.equal(reversed.currentQuantity, original.currentQuantity);
  assert.equal(reversed.averageUnitCost, original.averageUnitCost);
});

test("reverseSupplyPurchaseEffect exactly undoes an unpriced apply", () => {
  const original = ingredient({ currentQuantity: 1000, averageUnitCost: 10 });
  const applied = expectApplied(applySupplyPurchaseEffect(original, { packQuantity: 500, totalCost: 0, unit: "ml" }, "supply-2", "2026-02-01T00:00:00.000Z"));

  const reversed = expectReversed(reverseSupplyPurchaseEffect(applied.ingredient, { packQuantity: 500, totalCost: 0, unit: "ml" }));

  assert.equal(reversed.currentQuantity, 1000);
  assert.equal(reversed.averageUnitCost, 10);
});

test("reverseSupplyPurchaseEffect never goes negative and resets cost to 0 if nothing is left", () => {
  const item = ingredient({ currentQuantity: 100, averageUnitCost: 5 });
  const reversed = expectReversed(reverseSupplyPurchaseEffect(item, { packQuantity: 500, totalCost: 2500, unit: "ml" }));

  assert.equal(reversed.currentQuantity, 0);
  assert.equal(reversed.averageUnitCost, 0);
});

// Round-trip through the conversion, not just the same-unit case above -- applying then reversing
// a kg purchase against a gram-based ingredient must return to the exact starting state.
test("reverseSupplyPurchaseEffect round-trips exactly through a kg<->g conversion", () => {
  const original = ingredient({ id: "sugar-id", name: "Sugar", baseUnit: "g", currentQuantity: 500, averageUnitCost: 0.05 });
  const applied = expectApplied(applySupplyPurchaseEffect(original, { packQuantity: 1, totalCost: 90, unit: "kg" }, "supply-2", "2026-08-03T00:00:00.000Z"));

  const reversed = expectReversed(reverseSupplyPurchaseEffect(applied.ingredient, { packQuantity: 1, totalCost: 90, unit: "kg" }));

  assert.equal(reversed.currentQuantity, original.currentQuantity);
  assert.ok(Math.abs(reversed.averageUnitCost - original.averageUnitCost) < 1e-9);
});

test("isSafeToRecalculate is true when the purchase's own transaction is the only one for that ingredient", () => {
  const own = transaction();
  assert.equal(isSafeToRecalculate(own, [own]), true);
});

test("isSafeToRecalculate is false when a later transaction exists for the same ingredient", () => {
  const own = transaction({ createdAt: "2026-01-01T00:00:00.000Z" });
  const later = transaction({ id: "txn-2", sourceId: "supply-2", createdAt: "2026-02-01T00:00:00.000Z", quantityBefore: 1000, quantityAfter: 500, transactionType: "consume", sourceType: "bake" });

  assert.equal(isSafeToRecalculate(own, [own, later]), false);
});

test("isSafeToRecalculate ignores transactions for a different ingredient", () => {
  const own = transaction({ createdAt: "2026-01-01T00:00:00.000Z" });
  const otherIngredient = transaction({ id: "txn-2", ingredientId: "sugar-id", createdAt: "2026-02-01T00:00:00.000Z" });

  assert.equal(isSafeToRecalculate(own, [own, otherIngredient]), true);
});

test("planSupplyEdit returns not-applied when this purchase never affected stock", () => {
  const item = ingredient({ currentQuantity: 0, averageUnitCost: 0 });
  const plan = planSupplyEdit(item, { id: "supply-1", packQuantity: 1000, totalCost: 92, unit: "ml" }, { packQuantity: 1200, totalCost: 110, unit: "ml" }, [], "2026-02-01T00:00:00.000Z");

  assert.deepEqual(plan, { kind: "not-applied" });
});

test("planSupplyEdit recalculates exactly when this purchase is still the newest thing for the ingredient", () => {
  const item = ingredient({ currentQuantity: 1000, averageUnitCost: 0.092 });
  const own = transaction({ quantityBefore: 0, quantityAfter: 1000, sourceId: "supply-1" });
  const plan = planSupplyEdit(item, { id: "supply-1", packQuantity: 1000, totalCost: 92, unit: "ml" }, { packQuantity: 1000, totalCost: 120, unit: "ml" }, [own], "2026-02-01T00:00:00.000Z");

  assert.equal(plan.kind, "recalculated");
  if (plan.kind === "recalculated") {
    assert.equal(plan.ingredient.currentQuantity, 1000);
    assert.equal(plan.ingredient.averageUnitCost, 0.12);
    assert.equal(plan.transaction.id, own.id);
  }
});

test("planSupplyEdit only adjusts quantity exactly and preserves cost when a later transaction exists", () => {
  const item = ingredient({ currentQuantity: 700, averageUnitCost: 0.1 }); // 1000 bought, 300 consumed since
  const own = transaction({ quantityBefore: 0, quantityAfter: 1000, sourceId: "supply-1", createdAt: "2026-01-01T00:00:00.000Z" });
  const laterConsume = transaction({ id: "txn-2", transactionType: "consume", sourceType: "bake", sourceId: "bake-1", quantityBefore: 1000, quantityAfter: 700, createdAt: "2026-01-05T00:00:00.000Z" });

  const plan = planSupplyEdit(item, { id: "supply-1", packQuantity: 1000, totalCost: 100, unit: "ml" }, { packQuantity: 1200, totalCost: 130, unit: "ml" }, [own, laterConsume], "2026-02-01T00:00:00.000Z");

  assert.equal(plan.kind, "quantity-only");
  if (plan.kind === "quantity-only") {
    assert.equal(plan.ingredient.currentQuantity, 900); // 700 + (1200 - 1000)
    assert.equal(plan.ingredient.averageUnitCost, 0.1); // untouched
    assert.equal(plan.warning, HISTORICAL_COST_WARNING);
  }
});

// The "quantity-only" path converts each revision into the ingredient's own unit before taking the
// delta -- editing a purchase from "1kg" to "1500g" (same ingredient, a gram-based one) must add
// exactly 500g, not a nonsensical raw 1500-1=1499 delta.
test("planSupplyEdit's quantity-only path converts both revisions before taking the delta", () => {
  const sugar = ingredient({ id: "sugar-id", name: "Sugar", baseUnit: "g", currentQuantity: 700, averageUnitCost: 0.09 });
  const own = transaction({ ingredientId: "sugar-id", quantityBefore: 0, quantityAfter: 1000, sourceId: "supply-1", createdAt: "2026-01-01T00:00:00.000Z" });
  const laterConsume = transaction({ id: "txn-2", ingredientId: "sugar-id", transactionType: "consume", sourceType: "bake", sourceId: "bake-1", quantityBefore: 1000, quantityAfter: 700, createdAt: "2026-01-05T00:00:00.000Z" });

  const plan = planSupplyEdit(sugar, { id: "supply-1", packQuantity: 1, totalCost: 90, unit: "kg" }, { packQuantity: 1500, totalCost: 135, unit: "g" }, [own, laterConsume], "2026-02-01T00:00:00.000Z");

  assert.equal(plan.kind, "quantity-only");
  if (plan.kind === "quantity-only") {
    assert.equal(plan.ingredient.currentQuantity, 1200); // 700 + (1500 - 1000)
  }
});

// Regression: findOwnTransaction/repairMissingSupplyInventoryEffects's "already applied" check
// used to filter to sourceType "manual" only. findOwnTransaction now matches on sourceId alone,
// regardless of sourceType -- this proves that general property. Note this is NOT the realistic
// CSV-import shape (see the repairMissingSupplyInventoryEffects tests below for that): a real CSV
// import transaction's sourceId is the purchase_imports row's id, never an individual supply's id,
// so findOwnTransaction correctly never matches it -- planSupplyEdit/planSupplyDelete correctly
// fall back to "not-applied" for a CSV-imported purchase, on purpose (see their own comments).
test("planSupplyEdit recognizes a transaction whose sourceId matches this purchase, regardless of sourceType", () => {
  const item = ingredient({ currentQuantity: 1000, averageUnitCost: 0.092 });
  const nonManualTransaction = transaction({ sourceType: "purchase_import", sourceId: "supply-1", quantityBefore: 0, quantityAfter: 1000 });

  const plan = planSupplyEdit(item, { id: "supply-1", packQuantity: 1000, totalCost: 92, unit: "ml" }, { packQuantity: 1000, totalCost: 92, unit: "ml" }, [nonManualTransaction], "2026-02-01T00:00:00.000Z");

  assert.notEqual(plan.kind, "not-applied");
  assert.equal(plan.kind, "recalculated");
});

test("planSupplyEdit reports an error, never a guess, when a revision's unit doesn't convert", () => {
  const milk = ingredient({ id: "milk-id", name: "Milk", baseUnit: "ml", currentQuantity: 1000 });
  const own = transaction({ quantityBefore: 0, quantityAfter: 1000, sourceId: "supply-1" });

  const plan = planSupplyEdit(milk, { id: "supply-1", packQuantity: 1000, totalCost: 92, unit: "ml" }, { packQuantity: 1, totalCost: 92, unit: "kg" }, [own], "2026-02-01T00:00:00.000Z");

  assert.equal(plan.kind, "error");
});

// Regression: the real incident. repairMissingSupplyInventoryEffects used to try matching a CSV
// import's transaction to a specific supply_entries row by id -- but a real CSV-import transaction
// is one COMBINED row per ingredient per upload, keyed by the purchase_imports id (never any
// individual purchase's id), so that match always failed and the purchase got re-applied,
// doubling stock. The fix checks per-INGREDIENT ("has this ingredient ever had any purchase
// transaction, from any source") instead of per-purchase.
test("repairMissingSupplyInventoryEffects skips an ingredient already covered by a CSV import's combined transaction", () => {
  const item = ingredient({ id: "milk-id", currentQuantity: 1000, averageUnitCost: 0.092 });
  const alreadyImported = supply({ id: "s1", packQuantity: 1000, totalCost: 92 });
  // Realistic shape: sourceId is the purchase_imports row's id, NOT "s1" (the supply's own id).
  const csvImportTransaction = transaction({ sourceType: "purchase_import", sourceId: "import-1", quantityBefore: 0, quantityAfter: 1000 });

  const result = repairMissingSupplyInventoryEffects([item], [alreadyImported], [csvImportTransaction], "2026-03-01T00:00:00.000Z");

  assert.deepEqual(result.changedIngredients, []);
  assert.deepEqual(result.transactions, []);
});

// The accepted safety tradeoff this fix makes explicit: an ingredient with BOTH a CSV-imported
// purchase (already applied) AND a genuinely-never-applied manual purchase is skipped entirely --
// under-counting (the second purchase stays missing) rather than guessing which purchases the CSV
// transaction covers.
test("repairMissingSupplyInventoryEffects skips the whole ingredient when its history is mixed CSV + un-applied manual, rather than guessing", () => {
  const item = ingredient({ id: "milk-id", currentQuantity: 1000, averageUnitCost: 0.092 });
  const csvImported = supply({ id: "s1", purchaseDate: "2026-01-01", packQuantity: 1000, totalCost: 92 });
  const stillMissing = supply({ id: "s2", purchaseDate: "2026-02-01", packQuantity: 500, totalCost: 60 });
  const csvImportTransaction = transaction({ sourceType: "purchase_import", sourceId: "import-1", quantityBefore: 0, quantityAfter: 1000 });

  const result = repairMissingSupplyInventoryEffects([item], [csvImported, stillMissing], [csvImportTransaction], "2026-03-01T00:00:00.000Z");

  assert.deepEqual(result.changedIngredients, []);
  assert.deepEqual(result.transactions, []);
});

test("planSupplyDelete returns not-applied when this purchase never affected stock", () => {
  const item = ingredient();
  const plan = planSupplyDelete(item, { id: "supply-1", packQuantity: 1000, totalCost: 92, unit: "ml" }, []);

  assert.deepEqual(plan, { kind: "not-applied" });
});

test("planSupplyDelete reverses exactly and names the transaction to remove when safe", () => {
  const item = ingredient({ currentQuantity: 1000, averageUnitCost: 0.092 });
  const own = transaction({ quantityBefore: 0, quantityAfter: 1000, sourceId: "supply-1" });

  const plan = planSupplyDelete(item, { id: "supply-1", packQuantity: 1000, totalCost: 92, unit: "ml" }, [own]);

  assert.equal(plan.kind, "reversed");
  if (plan.kind === "reversed") {
    assert.equal(plan.ingredient.currentQuantity, 0);
    assert.equal(plan.ingredient.averageUnitCost, 0);
    assert.equal(plan.transactionIdToRemove, own.id);
  }
});

test("planSupplyDelete only subtracts quantity exactly and preserves cost when a later transaction exists", () => {
  const item = ingredient({ currentQuantity: 700, averageUnitCost: 0.1 });
  const own = transaction({ quantityBefore: 0, quantityAfter: 1000, sourceId: "supply-1", createdAt: "2026-01-01T00:00:00.000Z" });
  const laterConsume = transaction({ id: "txn-2", transactionType: "consume", sourceType: "bake", sourceId: "bake-1", quantityBefore: 1000, quantityAfter: 700, createdAt: "2026-01-05T00:00:00.000Z" });

  const plan = planSupplyDelete(item, { id: "supply-1", packQuantity: 1000, totalCost: 100, unit: "ml" }, [own, laterConsume]);

  assert.equal(plan.kind, "quantity-only");
  if (plan.kind === "quantity-only") {
    assert.equal(plan.ingredient.currentQuantity, -300); // 700 - 1000: exact, even though negative here (a synthetic edge case)
    assert.equal(plan.ingredient.averageUnitCost, 0.1);
    assert.equal(plan.warning, HISTORICAL_COST_WARNING);
  }
});

test("repairMissingSupplyInventoryEffects applies every purchase with no existing transaction, oldest first", () => {
  const item = ingredient({ id: "milk-id", currentQuantity: 0, averageUnitCost: 0 });
  const older = supply({ id: "s1", purchaseDate: "2026-01-01", packQuantity: 1000, totalCost: 92 });
  const newer = supply({ id: "s2", purchaseDate: "2026-02-01", packQuantity: 500, totalCost: 60 });

  const result = repairMissingSupplyInventoryEffects([item], [newer, older], [], "2026-03-01T00:00:00.000Z");

  assert.equal(result.changedIngredients.length, 1);
  assert.equal(result.changedIngredients[0].currentQuantity, 1500);
  assert.equal(result.changedIngredients[0].averageUnitCost, (92 + 60) / 1500);
  assert.equal(result.transactions.length, 2);
  assert.deepEqual(result.transactions.map((t) => t.sourceId), ["s1", "s2"]);
  assert.deepEqual(result.unconvertible, []);
});

// The real point of this fix: a backfilled purchase logged in a legacy unit (kg) against a
// gram-based ingredient converts correctly instead of being added raw.
test("repairMissingSupplyInventoryEffects converts each backfilled purchase's unit before summing", () => {
  const sugar = ingredient({ id: "sugar-id", name: "Sugar", baseUnit: "g", currentQuantity: 0, averageUnitCost: 0 });
  const kgPurchase = supply({ id: "s1", ingredientId: "sugar-id", ingredientName: "Sugar", purchaseDate: "2026-01-01", packQuantity: 1, unit: "kg", totalCost: 90 });

  const result = repairMissingSupplyInventoryEffects([sugar], [kgPurchase], [], "2026-03-01T00:00:00.000Z");

  assert.equal(result.changedIngredients[0].currentQuantity, 1000);
  assert.equal(result.changedIngredients[0].averageUnitCost, 0.09);
});

test("repairMissingSupplyInventoryEffects skips the whole ingredient and reports it when a purchase's unit doesn't convert", () => {
  const milk = ingredient({ id: "milk-id", name: "Milk", baseUnit: "ml", currentQuantity: 0 });
  const goodPurchase = supply({ id: "s1", ingredientId: "milk-id", ingredientName: "Milk", purchaseDate: "2026-01-01", packQuantity: 1, unit: "L", totalCost: 90 });
  const badPurchase = supply({ id: "s2", ingredientId: "milk-id", ingredientName: "Milk", purchaseDate: "2026-02-01", packQuantity: 1, unit: "kg", totalCost: 50 });

  const result = repairMissingSupplyInventoryEffects([milk], [goodPurchase, badPurchase], [], "2026-03-01T00:00:00.000Z");

  assert.deepEqual(result.changedIngredients, []);
  assert.deepEqual(result.transactions, []);
  assert.deepEqual(result.unconvertible, [{ ingredientId: "milk-id", supplyId: "s2", unit: "kg" }]);
});

test("repairMissingSupplyInventoryEffects skips purchases that already have a transaction", () => {
  const item = ingredient({ id: "milk-id", currentQuantity: 1000, averageUnitCost: 0.092 });
  const already = supply({ id: "s1", packQuantity: 1000, totalCost: 92 });
  const existingTransaction = transaction({ sourceId: "s1", quantityBefore: 0, quantityAfter: 1000 });

  const result = repairMissingSupplyInventoryEffects([item], [already], [existingTransaction], "2026-03-01T00:00:00.000Z");

  assert.deepEqual(result.changedIngredients, []);
  assert.deepEqual(result.transactions, []);
});

test("repairMissingSupplyInventoryEffects is idempotent: running it again after a run finds nothing left to do", () => {
  const item = ingredient({ id: "milk-id", currentQuantity: 0, averageUnitCost: 0 });
  const onlyPurchase = supply({ id: "s1", packQuantity: 1000, totalCost: 92 });

  const firstRun = repairMissingSupplyInventoryEffects([item], [onlyPurchase], [], "2026-03-01T00:00:00.000Z");
  const secondRun = repairMissingSupplyInventoryEffects(firstRun.changedIngredients, [onlyPurchase], firstRun.transactions, "2026-03-02T00:00:00.000Z");

  assert.deepEqual(secondRun.changedIngredients, []);
  assert.deepEqual(secondRun.transactions, []);
});

test("repairMissingSupplyInventoryEffects leaves ingredients with no missing purchases untouched", () => {
  const withHistory = ingredient({ id: "milk-id", name: "Fresh Milk" });
  const withoutHistory = ingredient({ id: "sugar-id", name: "Refined Sugar" });
  const purchase = supply({ id: "s1", ingredientId: "milk-id", packQuantity: 1000, totalCost: 92 });

  const result = repairMissingSupplyInventoryEffects([withHistory, withoutHistory], [purchase], [], "2026-03-01T00:00:00.000Z");

  assert.equal(result.changedIngredients.length, 1);
  assert.equal(result.changedIngredients[0].id, "milk-id");
});
