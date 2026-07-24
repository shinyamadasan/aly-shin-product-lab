import test from "node:test";
import assert from "node:assert/strict";
import { getAutoCostedIngredientRow, getMatchingSupplies } from "../src/lib/supplies.ts";
import type { CostingIngredientRow, SupplyEntry } from "../src/lib/product-lab-types.ts";

function supply(overrides: Partial<SupplyEntry> = {}): SupplyEntry {
  return {
    id: crypto.randomUUID(),
    ingredientName: "Classic Cocoa Powder",
    brandName: "Beryl's",
    supplierName: "SM Supermarket",
    purchaseDate: "2026-01-01",
    createdAt: "2026-01-01T00:00:00.000Z",
    packQuantity: 1000,
    unit: "g",
    totalCost: 360,
    qualityRating: 4,
    notes: "",
    ...overrides,
  };
}

function ingredientRow(overrides: Partial<CostingIngredientRow> = {}): CostingIngredientRow {
  return {
    id: "",
    productId: "product-1",
    brandName: "Beryl's",
    ingredientName: "Classic Cocoa Powder",
    quantityUsed: 25,
    unit: "g",
    cost: 0,
    supplierNote: "",
    rowId: crypto.randomUUID(),
    ...overrides,
  };
}

test("a newer, more expensive supply record is selected over an older, cheaper record", () => {
  const older = supply({ id: "older", purchaseDate: "2026-01-01", totalCost: 300 });
  const newer = supply({ id: "newer", purchaseDate: "2026-06-01", totalCost: 450 });

  const matches = getMatchingSupplies([older, newer], "Beryl's", "Classic Cocoa Powder", "g");

  assert.equal(matches[0]?.id, "newer");
});

test("undated records fall back to created_at, still preferring the most recent", () => {
  const noPurchaseDateButOlderCreated = supply({ id: "a", purchaseDate: "", createdAt: "2026-01-01T00:00:00.000Z" });
  const noPurchaseDateButNewerCreated = supply({ id: "b", purchaseDate: "", createdAt: "2026-05-01T00:00:00.000Z" });

  const matches = getMatchingSupplies([noPurchaseDateButOlderCreated, noPurchaseDateButNewerCreated], "Beryl's", "Classic Cocoa Powder", "g");

  assert.equal(matches[0]?.id, "b");
});

test("created_at never overrides a record's own purchase date, even when created_at is later", () => {
  // Purchase date says this was bought in January, even though the row was edited/created in
  // June -- the purchase date must win, not the more recent created_at timestamp.
  const purchaseDateWins = supply({ id: "has-purchase-date", purchaseDate: "2026-01-01", createdAt: "2026-06-01T00:00:00.000Z" });
  const midCreatedAtFallback = supply({ id: "created-at-fallback", purchaseDate: "", createdAt: "2026-03-01T00:00:00.000Z" });

  const matches = getMatchingSupplies([purchaseDateWins, midCreatedAtFallback], "Beryl's", "Classic Cocoa Powder", "g");

  assert.equal(matches[0]?.id, "created-at-fallback");
});

test("invalid or undated records are handled safely, not crashed or ranked above real data", () => {
  const garbageDate = supply({ id: "garbage", purchaseDate: "not-a-date", createdAt: "also-not-a-date" });
  const valid = supply({ id: "valid", purchaseDate: "2026-03-01" });

  const matches = getMatchingSupplies([garbageDate, valid], "Beryl's", "Classic Cocoa Powder", "g");

  assert.equal(matches.length, 2);
  assert.equal(matches[0]?.id, "valid");
});

test("zero-cost and zero-pack-quantity records are excluded, not just deprioritized", () => {
  const zeroCost = supply({ id: "zero-cost", totalCost: 0 });
  const zeroQuantity = supply({ id: "zero-qty", packQuantity: 0 });
  const valid = supply({ id: "valid" });

  const matches = getMatchingSupplies([zeroCost, zeroQuantity, valid], "Beryl's", "Classic Cocoa Powder", "g");

  assert.deepEqual(matches.map((match) => match.id), ["valid"]);
});

test("brand and ingredient matching rules are preserved", () => {
  const wrongBrand = supply({ id: "wrong-brand", brandName: "Magnolia" });
  const wrongIngredient = supply({ id: "wrong-ingredient", ingredientName: "Refined Sugar" });
  const correct = supply({ id: "correct" });

  const matches = getMatchingSupplies([wrongBrand, wrongIngredient, correct], "Beryl's", "Classic Cocoa Powder", "g");

  assert.deepEqual(matches.map((match) => match.id), ["correct"]);
});

test("unit compatibility is preserved: exact unit matches without conversion", () => {
  const incompatibleUnit = supply({ id: "incompatible", unit: "pcs" });
  const compatible = supply({ id: "compatible", unit: "g" });

  const matches = getMatchingSupplies([incompatibleUnit, compatible], "Beryl's", "Classic Cocoa Powder", "g");

  assert.deepEqual(matches.map((match) => match.id), ["compatible"]);
});

test("manual overrides still take precedence over auto-selection", () => {
  const newest = supply({ id: "newest", purchaseDate: "2026-06-01", totalCost: 500 });
  const row = ingredientRow({ cost: 12.34, isManualCost: true, supplierNote: "Hand-entered price" });

  const result = getAutoCostedIngredientRow(row, [newest]);

  assert.equal(result.cost, 12.34);
  assert.equal(result.supplierNote, "Hand-entered price");
});

test("auto-costing applies the most recent match and records what was selected", () => {
  const older = supply({ id: "older", purchaseDate: "2026-01-01", totalCost: 300, supplierName: "Old Supplier" });
  const newer = supply({ id: "newer", purchaseDate: "2026-06-01", totalCost: 450, supplierName: "New Supplier" });
  const row = ingredientRow();

  const result = getAutoCostedIngredientRow(row, [older, newer]);

  assert.match(result.supplierNote, /New Supplier/);
  assert.match(result.supplierNote, /2026-06-01/);
  assert.match(result.supplierNote, /PHP 0\.45\/g/);
});
