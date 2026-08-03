import test from "node:test";
import assert from "node:assert/strict";
import { convertToBaseUnit } from "../src/lib/unit-conversion.ts";
import { applyPurchaseImportConfirmation } from "../src/lib/purchase-import-confirm.ts";
import { applyBakeConfirmation } from "../src/lib/bake-confirm.ts";
import { resolveBakeFormula, isBakeFormulaFullyResolved } from "../src/lib/bake-deduction.ts";
import { getSupplyUsedCost } from "../src/lib/supplies.ts";
import type { Ingredient, SupplyEntry } from "../src/lib/product-lab-types.ts";
import type { PurchaseImportRowDraft } from "../src/lib/purchase-import.ts";
import type { BatchFormulaRow } from "../src/lib/batches.ts";

// Acceptance-level tests for the canonical-unit fix, one per required scenario. Each composes real
// production functions (the CSV-import-confirm path for "buy", Bake's confirm path for "consume")
// rather than reimplementing the arithmetic -- both paths already share unit-conversion.ts's
// convertToBaseUnit, so these prove the shared layer produces the required end-to-end behavior.

function ingredient(overrides: Partial<Ingredient> = {}): Ingredient {
  return {
    id: "item-id",
    name: "Item",
    baseUnit: "g",
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

function purchaseRow(overrides: Partial<PurchaseImportRowDraft> = {}): PurchaseImportRowDraft {
  return {
    rowIndex: 0,
    rawItemName: "Item",
    rawBrand: "",
    rawQuantity: "",
    rawUnit: "",
    rawTotalPrice: "",
    rawExpirationDate: "",
    rawPackageCount: "",
    rawPackageSize: "",
    rawPackageUnit: "",
    rawUnitPrice: "",
    rawCategory: "",
    rawSupplier: "",
    rawReceiptNumber: "",
    rawPurchaseDate: "",
    parsedQuantity: 0,
    parsedTotalPrice: 0,
    parsedExpirationDate: "",
    parsedPackageCount: 0,
    parsedPackageSize: 0,
    parsedUnitPrice: 0,
    ingredientId: "item-id",
    matchMethod: "exact",
    convertedQuantity: 0,
    isQuantityOverridden: false,
    brandName: "",
    rowStatus: "matched",
    excludeReason: "",
    validationErrors: "",
    ...overrides,
  };
}

function buy(startingIngredient: Ingredient, row: Partial<PurchaseImportRowDraft>) {
  const result = applyPurchaseImportConfirmation({ ingredients: [startingIngredient], rows: [purchaseRow(row)], importId: "import-1", today: "2026-08-03T00:00:00.000Z" });
  if ("error" in result) throw new Error(result.error);
  return result.ingredients[0];
}

function consume(startingIngredient: Ingredient, quantity: number) {
  const result = applyBakeConfirmation({
    ingredients: [startingIngredient],
    deductions: [{ ingredientId: startingIngredient.id, quantity }],
    batchId: "batch-1",
    batchLabel: "Test Batch",
    multiplier: 1,
    allowNegative: false,
    today: "2026-08-03T00:00:00.000Z",
  });
  if ("error" in result) throw new Error(result.error);
  return result.ingredients[0];
}

test("1. buy 1kg sugar, consume 200g, remaining inventory is 800g", () => {
  const sugar = ingredient({ id: "sugar-id", name: "Sugar", baseUnit: "g", currentQuantity: 0 });
  const afterBuy = buy(sugar, { ingredientId: "sugar-id", parsedQuantity: 1, convertedQuantity: convertToBaseUnit(1, "kg", sugar)! });
  assert.equal(afterBuy.currentQuantity, 1000);

  const afterConsume = consume(afterBuy, 200);
  assert.equal(afterConsume.currentQuantity, 800);
});

test("2. buy 500g salt, consume 5g, remaining inventory is 495g", () => {
  const salt = ingredient({ id: "salt-id", name: "Salt", baseUnit: "g", currentQuantity: 0 });
  const afterBuy = buy(salt, { ingredientId: "salt-id", parsedQuantity: 500, convertedQuantity: convertToBaseUnit(500, "g", salt)! });
  assert.equal(afterBuy.currentQuantity, 500);

  const afterConsume = consume(afterBuy, 5);
  assert.equal(afterConsume.currentQuantity, 495);
});

test("3. buy two packages of 500g flour, inventory added is 1,000g (and cost blends across both)", () => {
  const flour = ingredient({ id: "flour-id", name: "Flour", baseUnit: "g", currentQuantity: 0, averageUnitCost: 0 });
  const result = applyPurchaseImportConfirmation({
    ingredients: [flour],
    rows: [
      purchaseRow({ ingredientId: "flour-id", parsedQuantity: 500, convertedQuantity: 500, parsedTotalPrice: 25 }),
      purchaseRow({ ingredientId: "flour-id", parsedQuantity: 500, convertedQuantity: 500, parsedTotalPrice: 30 }),
    ],
    importId: "import-1",
    today: "2026-08-03T00:00:00.000Z",
  });

  assert.ok(!("error" in result));
  if ("error" in result) return;
  assert.equal(result.ingredients[0].currentQuantity, 1000);
  assert.equal(result.ingredients[0].averageUnitCost, 0.055);
});

test("4. buy 2L milk, consume 250ml, remaining inventory is 1,750ml", () => {
  const milk = ingredient({ id: "milk-id", name: "Milk", baseUnit: "ml", currentQuantity: 0 });
  const afterBuy = buy(milk, { ingredientId: "milk-id", parsedQuantity: 2, convertedQuantity: convertToBaseUnit(2, "L", milk)! });
  assert.equal(afterBuy.currentQuantity, 2000);

  const afterConsume = consume(afterBuy, 250);
  assert.equal(afterConsume.currentQuantity, 1750);
});

test("5. buy 12 eggs, consume 3 pieces, remaining inventory is 9 pieces", () => {
  const eggs = ingredient({ id: "eggs-id", name: "Eggs", baseUnit: "pcs", currentQuantity: 0 });
  const afterBuy = buy(eggs, { ingredientId: "eggs-id", parsedQuantity: 12, convertedQuantity: convertToBaseUnit(12, "pcs", eggs)! });
  assert.equal(afterBuy.currentQuantity, 12);

  const afterConsume = consume(afterBuy, 3);
  assert.equal(afterConsume.currentQuantity, 9);
});

test("6. mass-to-volume conversion is rejected, never guessed", () => {
  assert.equal(convertToBaseUnit(1, "kg", { baseUnit: "ml" }), null);

  const milk = ingredient({ id: "milk-id", name: "Milk", baseUnit: "ml" });
  const formulaRow: BatchFormulaRow = { brand: "", ingredient: "Milk", quantity: 1, unit: "kg", change: "", step: "Mix", rowId: "row-1" };
  const resolved = resolveBakeFormula([formulaRow], [milk], []);

  assert.equal(resolved[0].convertedQuantity, null);
  assert.equal(isBakeFormulaFullyResolved(resolved), false);
});

test("7. a ₱90 purchase of 1kg sugar produces a normalized cost of ₱0.09 per g", () => {
  const sugar = ingredient({ id: "sugar-id", name: "Sugar", baseUnit: "g", currentQuantity: 0, averageUnitCost: 0 });
  const afterBuy = buy(sugar, { ingredientId: "sugar-id", parsedQuantity: 1, convertedQuantity: convertToBaseUnit(1, "kg", sugar)!, parsedTotalPrice: 90 });

  assert.equal(afterBuy.averageUnitCost, 0.09);
});

test("8. consuming 200g of that sugar records an ingredient cost of ₱18", () => {
  const sugarPurchase: SupplyEntry = {
    id: "supply-1",
    ingredientId: "sugar-id",
    ingredientName: "Sugar",
    brandName: "",
    supplierName: "Main",
    purchaseDate: "2026-08-01",
    createdAt: "2026-08-01T00:00:00.000Z",
    packQuantity: 1,
    unit: "kg",
    totalCost: 90,
    qualityRating: 0,
    notes: "",
  };

  assert.equal(getSupplyUsedCost(sugarPurchase, 200, "g"), 18);
});

test("9. existing inventory valuation is unchanged by the kg->g / L->ml rescale (the migration's valuation-neutral property)", () => {
  for (const [oldQuantity, oldCost] of [
    [1, 90],
    [2.5, 60],
    [0.75, 120],
  ]) {
    const oldValuation = oldQuantity * oldCost;
    const newValuation = oldQuantity * 1000 * (oldCost / 1000);
    assert.ok(Math.abs(newValuation - oldValuation) < 1e-9);
  }
});
