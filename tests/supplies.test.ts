import test from "node:test";
import assert from "node:assert/strict";
import {
  findReliableBrandForIngredient,
  findReliableSupplierForIngredient,
  getAutoCostedIngredientRow,
  getAutoCostedIngredientRowForItems,
  getConversionLabel,
  getConvertedQuantityForSupply,
  getMatchingPurchaseHistoryForIngredient,
  getMatchingSupplies,
  getSupplyUsedCost,
} from "../src/lib/supplies.ts";
import type { CostingIngredientRow, Ingredient, SupplyEntry } from "../src/lib/product-lab-types.ts";

function supply(overrides: Partial<SupplyEntry> = {}): SupplyEntry {
  return {
    id: crypto.randomUUID(),
    ingredientId: "",
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
    batchId: "",
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

function ingredient(overrides: Partial<Ingredient> = {}): Ingredient {
  return {
    id: "cocoa-id",
    name: "Classic Cocoa Powder",
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

// Regression: supplies.ts used to have its own weaker unit synonym table that couldn't convert
// kg<->g or L<->ml at all -- a recipe row in grams could never auto-cost against a kg-recorded
// purchase. Now it delegates to the same shared convertUnit CSV import/Bake/manual-purchase use.
test("getSupplyUsedCost converts a kg-recorded purchase into a gram-based usage via a real conversion, not a guess", () => {
  const sugarPurchase = supply({ id: "sugar", ingredientName: "Sugar", unit: "kg", packQuantity: 1, totalCost: 90 });

  assert.equal(getSupplyUsedCost(sugarPurchase, 200, "g"), 18);
});

test("getMatchingSupplies matches a gram-recorded recipe row against a kg-recorded purchase", () => {
  const kgPurchase = supply({ id: "kg-purchase", unit: "kg" });

  const matches = getMatchingSupplies([kgPurchase], "Beryl's", "Classic Cocoa Powder", "g");

  assert.deepEqual(matches.map((match) => match.id), ["kg-purchase"]);
});

test("getConversionLabel does not mark a real kg<->g conversion as an estimate", () => {
  const sugarPurchase = supply({ id: "sugar-kg", ingredientName: "Sugar", unit: "kg" });

  assert.doesNotMatch(getConversionLabel(200, "g", sugarPurchase), / estimate$/);
});

// The density-based mass<->volume estimate is a distinct, still-needed capability for cases a real
// conversion can never resolve (there is no fixed ratio between a cup and a gram in general) --
// it must keep working as a fallback, and must still be labeled as an estimate.
test("the density-based mass<->volume estimate still works as a fallback when no real conversion exists", () => {
  const flourPurchase = supply({ id: "flour", ingredientName: "All-Purpose Flour", unit: "g", packQuantity: 1000, totalCost: 530 });

  // 1 cup of flour, density-guessed at 0.53 g/ml -> 240ml * 0.53 = 127.2g.
  const converted = getConvertedQuantityForSupply(1, "cup", flourPurchase);
  assert.ok(Math.abs(converted - 127.2) < 0.01);
  assert.match(getConversionLabel(1, "cup", flourPurchase), / estimate$/);
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

test("Item-aware auto-costing uses ingredientId despite a different historical ingredientName", () => {
  const item = ingredient({ id: "cocoa-id", name: "Renamed Cocoa Powder" });
  const linked = supply({ id: "linked", ingredientId: "cocoa-id", ingredientName: "Classic Cocoa Powder", purchaseDate: "2026-06-01", totalCost: 450, supplierName: "ID Supplier" });
  const row = ingredientRow({ ingredientName: "Renamed Cocoa Powder" });

  const result = getAutoCostedIngredientRowForItems(row, [linked], [item]);

  assert.equal(result.cost, 11.25);
  assert.match(result.supplierNote, /ID Supplier/);
});

test("Item-aware matching applies brand filtering only after Item association", () => {
  const item = ingredient({ id: "cocoa-id" });
  const matchingBrand = supply({ id: "match", ingredientId: "cocoa-id", brandName: "Beryl's" });
  const wrongBrand = supply({ id: "wrong-brand", ingredientId: "cocoa-id", brandName: "Van Houten" });
  const wrongItem = supply({ id: "wrong-item", ingredientId: "other-id", ingredientName: "Classic Cocoa Powder", brandName: "Beryl's" });

  const matches = getMatchingPurchaseHistoryForIngredient([matchingBrand, wrongBrand, wrongItem], [item], { ingredientName: "Classic Cocoa Powder" }, "Beryl's", "g");

  assert.deepEqual(matches.map((entry) => entry.id), ["match"]);
});

test("findReliableBrandForIngredient prefills when every record agrees on one brand", () => {
  const first = supply({ ingredientName: "Dark Chocolate", brandName: "Van Houten", purchaseDate: "2026-01-01" });
  const second = supply({ ingredientName: "Dark Chocolate", brandName: "Van Houten", purchaseDate: "2026-03-01" });

  assert.equal(findReliableBrandForIngredient("Dark Chocolate", [first, second]), "Van Houten");
});

test("findReliableBrandForIngredient refuses to guess when records disagree on brand", () => {
  const vanHouten = supply({ ingredientName: "Dark Chocolate", brandName: "Van Houten" });
  const beryls = supply({ ingredientName: "Dark Chocolate", brandName: "Beryl's" });

  assert.equal(findReliableBrandForIngredient("Dark Chocolate", [vanHouten, beryls]), "");
});

// Regression: real purchase logs commonly spell the same brand differently across separate manual
// entries. Comparing raw strings (the bug: entry.brandName.trim() with no normalization) counted
// "Vanhouten" and "Van Houten" as two disagreeing brands and refused to prefill -- even though
// they're clearly the same brand once normalized. This is exactly the reported symptom: matching
// succeeded, brand still came up required.
test("findReliableBrandForIngredient treats differently-spelled entries of the same brand as agreement, not disagreement", () => {
  const spelling1 = supply({ ingredientName: "Dark Chocolate Compound", brandName: "Vanhouten", purchaseDate: "2026-01-01" });
  const spelling2 = supply({ ingredientName: "Dark Chocolate Compound", brandName: "Van Houten", purchaseDate: "2026-03-01" });
  const spelling3 = supply({ ingredientName: "Dark Chocolate Compound", brandName: "VAN HOUTEN", purchaseDate: "2026-02-01" });

  const result = findReliableBrandForIngredient("Dark Chocolate Compound", [spelling1, spelling2, spelling3]);

  assert.notEqual(result, "");
  // A real spelling from the records, not a normalized/compacted key like "vanhouten".
  assert.ok(["Vanhouten", "Van Houten", "VAN HOUTEN"].includes(result));
});

test("findReliableBrandForIngredient returns the most recent entry's brand spelling when spellings vary", () => {
  const older = supply({ ingredientName: "Dark Chocolate Compound", brandName: "Vanhouten", purchaseDate: "2026-01-01" });
  const newer = supply({ ingredientName: "Dark Chocolate Compound", brandName: "Van Houten", purchaseDate: "2026-06-01" });

  assert.equal(findReliableBrandForIngredient("Dark Chocolate Compound", [older, newer]), "Van Houten");
});

test("findReliableBrandForIngredient returns empty for an ingredient with no purchase history", () => {
  const unrelated = supply({ ingredientName: "Fresh Milk", brandName: "Alaska" });

  assert.equal(findReliableBrandForIngredient("Dark Chocolate", [unrelated]), "");
});

test("findReliableBrandForIngredient ignores blank brands when checking for agreement", () => {
  const withBrand = supply({ ingredientName: "Dark Chocolate", brandName: "Van Houten" });
  const withoutBrand = supply({ ingredientName: "Dark Chocolate", brandName: "" });

  assert.equal(findReliableBrandForIngredient("Dark Chocolate", [withBrand, withoutBrand]), "Van Houten");
});

test("findReliableBrandForIngredient matches ingredient name case-insensitively", () => {
  const entry = supply({ ingredientName: "dark chocolate", brandName: "Van Houten" });

  assert.equal(findReliableBrandForIngredient("Dark Chocolate", [entry]), "Van Houten");
});

// A manually-logged SupplyEntry commonly carries the same real-world variance a receipt line
// does (package size baked in, stray punctuation) -- this must still count as the same ingredient,
// or the brand-aware suggestion tier in ingredient-matching.ts silently never fires.
test("findReliableBrandForIngredient tolerates a package-size suffix on the supply record's ingredient name", () => {
  const entry = supply({ ingredientName: "Dark Chocolate Compound 1kg", brandName: "Vanhouten" });

  assert.equal(findReliableBrandForIngredient("Dark Chocolate Compound", [entry]), "Vanhouten");
});

test("findReliableBrandForIngredient tolerates punctuation differences between the two names", () => {
  const entry = supply({ ingredientName: "Dark Chocolate, Compound", brandName: "Vanhouten" });

  assert.equal(findReliableBrandForIngredient("Dark Chocolate Compound", [entry]), "Vanhouten");
});

test("findReliableSupplierForIngredient prefills when every record agrees on one supplier", () => {
  const first = supply({ ingredientName: "Dark Chocolate", supplierName: "SM Supermarket", purchaseDate: "2026-01-01" });
  const second = supply({ ingredientName: "Dark Chocolate", supplierName: "SM Supermarket", purchaseDate: "2026-03-01" });

  assert.equal(findReliableSupplierForIngredient("Dark Chocolate", [first, second]), "SM Supermarket");
});

test("findReliableSupplierForIngredient refuses to guess when records disagree on supplier", () => {
  const smSupermarket = supply({ ingredientName: "Dark Chocolate", supplierName: "SM Supermarket" });
  const mainStreetMarket = supply({ ingredientName: "Dark Chocolate", supplierName: "Main Street Market" });

  assert.equal(findReliableSupplierForIngredient("Dark Chocolate", [smSupermarket, mainStreetMarket]), "");
});

test("findReliableSupplierForIngredient treats case/whitespace differences as agreement, not disagreement", () => {
  const spelling1 = supply({ ingredientName: "Dark Chocolate", supplierName: "SM Supermarket", purchaseDate: "2026-01-01" });
  const spelling2 = supply({ ingredientName: "Dark Chocolate", supplierName: "  sm supermarket  ", purchaseDate: "2026-03-01" });

  assert.equal(findReliableSupplierForIngredient("Dark Chocolate", [spelling1, spelling2]), "sm supermarket");
});

test("findReliableSupplierForIngredient returns the most recent entry's supplier spelling", () => {
  const older = supply({ ingredientName: "Dark Chocolate", supplierName: "SM Supermarket", purchaseDate: "2026-01-01" });
  const newer = supply({ ingredientName: "Dark Chocolate", supplierName: "sm supermarket", purchaseDate: "2026-06-01" });

  assert.equal(findReliableSupplierForIngredient("Dark Chocolate", [older, newer]), "sm supermarket");
});

test("findReliableSupplierForIngredient returns empty for an ingredient with no purchase history", () => {
  const unrelated = supply({ ingredientName: "Fresh Milk", supplierName: "Alaska Depot" });

  assert.equal(findReliableSupplierForIngredient("Dark Chocolate", [unrelated]), "");
});

test("findReliableSupplierForIngredient ignores blank suppliers when checking for agreement", () => {
  const withSupplier = supply({ ingredientName: "Dark Chocolate", supplierName: "SM Supermarket" });
  const withoutSupplier = supply({ ingredientName: "Dark Chocolate", supplierName: "" });

  assert.equal(findReliableSupplierForIngredient("Dark Chocolate", [withSupplier, withoutSupplier]), "SM Supermarket");
});

test("findReliableSupplierForIngredient tolerates a package-size suffix on the supply record's ingredient name", () => {
  const entry = supply({ ingredientName: "Dark Chocolate Compound 1kg", supplierName: "SM Supermarket" });

  assert.equal(findReliableSupplierForIngredient("Dark Chocolate Compound", [entry]), "SM Supermarket");
});
