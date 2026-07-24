import test from "node:test";
import assert from "node:assert/strict";
import { applyPurchaseImportConfirmation } from "../src/lib/purchase-import-confirm.ts";
import type { PurchaseImportRowDraft } from "../src/lib/purchase-import.ts";
import type { Ingredient } from "../src/lib/product-lab-types.ts";

function ingredient(overrides: Partial<Ingredient> = {}): Ingredient {
  return {
    id: "milk-id",
    name: "Fresh Milk",
    baseUnit: "ml",
    currentQuantity: 1000,
    lowStockThreshold: 500,
    targetStockQuantity: 5000,
    nearestExpirationDate: "",
    averageUnitCost: 92,
    notes: "",
    isActive: true,
    ...overrides,
  };
}

function row(overrides: Partial<PurchaseImportRowDraft> = {}): PurchaseImportRowDraft {
  return {
    rowIndex: 0,
    rawItemName: "Fresh Milk",
    rawQuantity: "6",
    rawUnit: "L",
    rawTotalPrice: "570",
    rawExpirationDate: "",
    parsedQuantity: 6,
    parsedTotalPrice: 570,
    parsedExpirationDate: "",
    ingredientId: "milk-id",
    matchMethod: "exact",
    convertedQuantity: 6000,
    rowStatus: "matched",
    excludeReason: "",
    validationErrors: "",
    ...overrides,
  };
}

test("increases the matched ingredient's quantity by the converted amount", () => {
  const result = applyPurchaseImportConfirmation({ ingredients: [ingredient({ currentQuantity: 1000 })], rows: [row({ convertedQuantity: 6000 })], importId: "import-1", today: "2026-07-24T00:00:00.000Z" });

  assert.ok(!("error" in result));
  if ("error" in result) return;
  assert.equal(result.ingredients[0].currentQuantity, 7000);
});

test("records one inventory_transactions entry per affected ingredient, with correct before/after", () => {
  const result = applyPurchaseImportConfirmation({ ingredients: [ingredient({ currentQuantity: 1000 })], rows: [row({ convertedQuantity: 6000 })], importId: "import-1", today: "2026-07-24T00:00:00.000Z" });

  assert.ok(!("error" in result));
  if ("error" in result) return;
  assert.equal(result.transactions.length, 1);
  const [transaction] = result.transactions;
  assert.equal(transaction.transactionType, "purchase");
  assert.equal(transaction.sourceType, "purchase_import");
  assert.equal(transaction.sourceId, "import-1");
  assert.equal(transaction.ingredientId, "milk-id");
  assert.equal(transaction.quantityChange, 6000);
  assert.equal(transaction.quantityBefore, 1000);
  assert.equal(transaction.quantityAfter, 7000);
});

test("rejects confirmation when any non-excluded row is not matched", () => {
  const result = applyPurchaseImportConfirmation({ ingredients: [ingredient()], rows: [row({ rowStatus: "pending" })], importId: "import-1", today: "2026-07-24T00:00:00.000Z" });

  assert.ok("error" in result);
});

test("an excluded row is skipped even if it would otherwise be unresolved", () => {
  const result = applyPurchaseImportConfirmation({
    ingredients: [ingredient({ currentQuantity: 1000 })],
    rows: [row({ convertedQuantity: 6000 }), row({ rowIndex: 1, rowStatus: "excluded", ingredientId: "", matchMethod: "none" })],
    importId: "import-1",
    today: "2026-07-24T00:00:00.000Z",
  });

  assert.ok(!("error" in result));
  if ("error" in result) return;
  assert.equal(result.ingredients[0].currentQuantity, 7000);
});

test("rejects confirmation when every row was excluded (nothing to confirm)", () => {
  const result = applyPurchaseImportConfirmation({ ingredients: [ingredient()], rows: [row({ rowStatus: "excluded" })], importId: "import-1", today: "2026-07-24T00:00:00.000Z" });

  assert.ok("error" in result);
});

test("multiple rows for the same ingredient are grouped and summed (already converted to base unit)", () => {
  const result = applyPurchaseImportConfirmation({
    ingredients: [ingredient({ currentQuantity: 1000 })],
    rows: [row({ convertedQuantity: 6000, parsedTotalPrice: 570, rawTotalPrice: "570" }), row({ rowIndex: 1, convertedQuantity: 2000, parsedTotalPrice: 190, rawTotalPrice: "190" })],
    importId: "import-1",
    today: "2026-07-24T00:00:00.000Z",
  });

  assert.ok(!("error" in result));
  if ("error" in result) return;
  assert.equal(result.ingredients[0].currentQuantity, 9000);
  assert.equal(result.transactions.length, 1);
  assert.equal(result.transactions[0].quantityChange, 8000);
});

test("weighted-average cost updates correctly for a single priced row", () => {
  // 1000 ml on hand at PHP 92/L-equivalent... using ml-based numbers directly:
  // 1000 ml @ PHP 0.092/ml (PHP 92/L) = PHP 92 total. Buying 6000 ml for PHP 570 (PHP 0.095/ml).
  // New average = (1000*0.092 + 570) / 7000 = (92 + 570) / 7000 = 0.0946 (PHP/ml).
  const result = applyPurchaseImportConfirmation({
    ingredients: [ingredient({ currentQuantity: 1000, averageUnitCost: 0.092 })],
    rows: [row({ convertedQuantity: 6000, parsedTotalPrice: 570 })],
    importId: "import-1",
    today: "2026-07-24T00:00:00.000Z",
  });

  assert.ok(!("error" in result));
  if ("error" in result) return;
  const expected = (1000 * 0.092 + 570) / 7000;
  assert.ok(Math.abs(result.ingredients[0].averageUnitCost - expected) < 1e-9);
});

test("a row with no price leaves the average unit cost unchanged", () => {
  const result = applyPurchaseImportConfirmation({
    ingredients: [ingredient({ currentQuantity: 1000, averageUnitCost: 0.092 })],
    rows: [row({ convertedQuantity: 6000, parsedTotalPrice: 0, rawTotalPrice: "" })],
    importId: "import-1",
    today: "2026-07-24T00:00:00.000Z",
  });

  assert.ok(!("error" in result));
  if ("error" in result) return;
  assert.equal(result.ingredients[0].averageUnitCost, 0.092);
});

test("expiration: the earlier of the ingredient's existing date and the import's date wins", () => {
  const result = applyPurchaseImportConfirmation({
    ingredients: [ingredient({ nearestExpirationDate: "2026-08-15" })],
    rows: [row({ parsedExpirationDate: "2026-07-30" })],
    importId: "import-1",
    today: "2026-07-24T00:00:00.000Z",
  });

  assert.ok(!("error" in result));
  if ("error" in result) return;
  assert.equal(result.ingredients[0].nearestExpirationDate, "2026-07-30");
});

test("expiration: a later date on the import never pushes out a sooner existing date", () => {
  const result = applyPurchaseImportConfirmation({
    ingredients: [ingredient({ nearestExpirationDate: "2026-07-25" })],
    rows: [row({ parsedExpirationDate: "2026-09-01" })],
    importId: "import-1",
    today: "2026-07-24T00:00:00.000Z",
  });

  assert.ok(!("error" in result));
  if ("error" in result) return;
  assert.equal(result.ingredients[0].nearestExpirationDate, "2026-07-25");
});

test("expiration: the earliest date across multiple rows for the same ingredient wins", () => {
  const result = applyPurchaseImportConfirmation({
    ingredients: [ingredient({ nearestExpirationDate: "" })],
    rows: [row({ convertedQuantity: 1000, parsedExpirationDate: "2026-09-01" }), row({ rowIndex: 1, convertedQuantity: 1000, parsedExpirationDate: "2026-08-01" })],
    importId: "import-1",
    today: "2026-07-24T00:00:00.000Z",
  });

  assert.ok(!("error" in result));
  if ("error" in result) return;
  assert.equal(result.ingredients[0].nearestExpirationDate, "2026-08-01");
});

test("applying the same confirmation a second time on its own would double the increase -- demonstrating why the caller must guard against re-applying an already-confirmed import", () => {
  const firstIngredients = [ingredient({ currentQuantity: 1000 })];
  const firstResult = applyPurchaseImportConfirmation({ ingredients: firstIngredients, rows: [row({ convertedQuantity: 6000 })], importId: "import-1", today: "2026-07-24T00:00:00.000Z" });
  assert.ok(!("error" in firstResult));
  if ("error" in firstResult) return;

  const secondResult = applyPurchaseImportConfirmation({ ingredients: firstResult.ingredients, rows: [row({ convertedQuantity: 6000 })], importId: "import-1", today: "2026-07-24T00:00:01.000Z" });
  assert.ok(!("error" in secondResult));
  if ("error" in secondResult) return;

  assert.equal(secondResult.ingredients[0].currentQuantity, 13000);
});
