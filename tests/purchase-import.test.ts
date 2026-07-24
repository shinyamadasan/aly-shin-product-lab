import test from "node:test";
import assert from "node:assert/strict";
import { buildPurchaseImportRowDrafts, isPurchaseImportReadyToConfirm, summarizePurchaseImportRows, validatePurchaseRow } from "../src/lib/purchase-import.ts";
import type { Ingredient, IngredientAlias } from "../src/lib/product-lab-types.ts";

function ingredient(overrides: Partial<Ingredient> = {}): Ingredient {
  return {
    id: crypto.randomUUID(),
    name: "Fresh Milk",
    baseUnit: "ml",
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

function mappedRow(overrides: Partial<{ itemName: string; quantity: string; unit: string; totalPrice: string; expirationDate: string }> = {}) {
  return { itemName: "Fresh Milk", quantity: "6", unit: "L", totalPrice: "570", expirationDate: "2026-07-30", ...overrides };
}

test("validatePurchaseRow accepts a fully valid row", () => {
  const result = validatePurchaseRow(mappedRow());

  assert.deepEqual(result.errors, []);
  assert.equal(result.parsedQuantity, 6);
  assert.equal(result.parsedTotalPrice, 570);
  assert.equal(result.parsedExpirationDate, "2026-07-30");
});

test("validatePurchaseRow requires a non-empty item name", () => {
  const result = validatePurchaseRow(mappedRow({ itemName: "" }));

  assert.ok(result.errors.some((error) => error.includes("Item name")));
});

test("validatePurchaseRow rejects a zero or negative quantity", () => {
  assert.ok(validatePurchaseRow(mappedRow({ quantity: "0" })).errors.length > 0);
  assert.ok(validatePurchaseRow(mappedRow({ quantity: "-5" })).errors.length > 0);
});

test("validatePurchaseRow rejects a non-numeric quantity", () => {
  const result = validatePurchaseRow(mappedRow({ quantity: "six" }));

  assert.ok(result.errors.some((error) => error.includes("Quantity")));
});

test("validatePurchaseRow requires a unit", () => {
  const result = validatePurchaseRow(mappedRow({ unit: "" }));

  assert.ok(result.errors.some((error) => error.includes("Unit")));
});

test("validatePurchaseRow treats a missing total price as optional, not an error", () => {
  const result = validatePurchaseRow(mappedRow({ totalPrice: "" }));

  assert.deepEqual(result.errors, []);
  assert.equal(result.parsedTotalPrice, 0);
});

test("validatePurchaseRow rejects a negative total price", () => {
  const result = validatePurchaseRow(mappedRow({ totalPrice: "-10" }));

  assert.ok(result.errors.some((error) => error.includes("Total price")));
});

test("validatePurchaseRow treats a missing expiration date as optional", () => {
  const result = validatePurchaseRow(mappedRow({ expirationDate: "" }));

  assert.deepEqual(result.errors, []);
  assert.equal(result.parsedExpirationDate, "");
});

test("validatePurchaseRow rejects an unparseable expiration date", () => {
  const result = validatePurchaseRow(mappedRow({ expirationDate: "not-a-date" }));

  assert.ok(result.errors.some((error) => error.includes("Expiration date")));
});

test("buildPurchaseImportRowDrafts marks an invalid row as 'invalid', not matched or pending", () => {
  const [draft] = buildPurchaseImportRowDrafts([mappedRow({ quantity: "-1" })], [], []);

  assert.equal(draft.rowStatus, "invalid");
  assert.ok(draft.validationErrors.length > 0);
});

test("buildPurchaseImportRowDrafts marks a row as 'matched' when the ingredient resolves and the unit converts", () => {
  const milk = ingredient({ id: "milk-id", name: "Fresh Milk", baseUnit: "ml" });

  const [draft] = buildPurchaseImportRowDrafts([mappedRow({ itemName: "Fresh Milk", quantity: "6", unit: "L" })], [milk], []);

  assert.equal(draft.rowStatus, "matched");
  assert.equal(draft.ingredientId, "milk-id");
  assert.equal(draft.matchMethod, "exact");
  assert.equal(draft.convertedQuantity, 6000);
});

test("buildPurchaseImportRowDrafts marks a row as 'pending' when no ingredient matches", () => {
  const [draft] = buildPurchaseImportRowDrafts([mappedRow({ itemName: "Completely Unknown Item" })], [], []);

  assert.equal(draft.rowStatus, "pending");
  assert.equal(draft.ingredientId, "");
  assert.equal(draft.matchMethod, "none");
});

test("buildPurchaseImportRowDrafts marks a row as 'pending' when the ingredient matches but the unit can't convert", () => {
  const beans = ingredient({ id: "beans-id", name: "Coffee Beans", baseUnit: "g" });

  const [draft] = buildPurchaseImportRowDrafts([mappedRow({ itemName: "Coffee Beans", quantity: "5", unit: "pcs" })], [beans], []);

  assert.equal(draft.rowStatus, "pending");
  assert.equal(draft.ingredientId, "beans-id");
});

test("buildPurchaseImportRowDrafts resolves via a saved alias before falling back to normalized matching", () => {
  const milk = ingredient({ id: "milk-id", name: "Fresh Milk", baseUnit: "ml" });
  const alias: IngredientAlias = { id: "alias-1", rawText: "Alaska Milk", normalizedText: "alaska milk", ingredientId: "milk-id", source: "purchase_import" };

  const [draft] = buildPurchaseImportRowDrafts([mappedRow({ itemName: "Alaska Milk", quantity: "1", unit: "L" })], [milk], [alias]);

  assert.equal(draft.matchMethod, "alias");
  assert.equal(draft.ingredientId, "milk-id");
});

test("buildPurchaseImportRowDrafts never mutates the ingredients or aliases passed in -- CSV preview cannot change inventory even in principle", () => {
  const milk = ingredient({ id: "milk-id", name: "Fresh Milk", baseUnit: "ml", currentQuantity: 100 });
  const ingredients = [milk];
  const aliases: IngredientAlias[] = [];
  const snapshotBefore = JSON.parse(JSON.stringify(ingredients));

  buildPurchaseImportRowDrafts([mappedRow({ itemName: "Fresh Milk", quantity: "6", unit: "L" })], ingredients, aliases);

  assert.deepEqual(ingredients, snapshotBefore);
  assert.equal(ingredients[0].currentQuantity, 100);
});

test("isPurchaseImportReadyToConfirm is true only when every row is matched or excluded", () => {
  assert.equal(isPurchaseImportReadyToConfirm([{ rowStatus: "matched" }, { rowStatus: "excluded" }]), true);
  assert.equal(isPurchaseImportReadyToConfirm([{ rowStatus: "matched" }, { rowStatus: "pending" }]), false);
  assert.equal(isPurchaseImportReadyToConfirm([{ rowStatus: "matched" }, { rowStatus: "invalid" }]), false);
});

test("isPurchaseImportReadyToConfirm is false for an empty row list", () => {
  assert.equal(isPurchaseImportReadyToConfirm([]), false);
});

test("summarizePurchaseImportRows counts each status and totals value excluding excluded rows", () => {
  const milk = ingredient({ id: "milk-id", baseUnit: "ml" });
  const drafts = buildPurchaseImportRowDrafts(
    [mappedRow({ itemName: "Fresh Milk", quantity: "6", unit: "L", totalPrice: "570" }), mappedRow({ itemName: "Unknown", totalPrice: "100" }), mappedRow({ quantity: "-1", totalPrice: "" })],
    [milk],
    [],
  );
  drafts[1].rowStatus = "excluded";

  const summary = summarizePurchaseImportRows(drafts);

  assert.equal(summary.matchedCount, 1);
  assert.equal(summary.excludedCount, 1);
  assert.equal(summary.invalidCount, 1);
  assert.equal(summary.totalValue, 570);
});
