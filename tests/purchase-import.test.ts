import test from "node:test";
import assert from "node:assert/strict";
import {
  buildExcludeRowChanges,
  buildPurchaseImportRowDrafts,
  guessIngredientCategory,
  isPurchaseImportReadyToConfirm,
  resolvePackageQuantity,
  resolveRowQuantity,
  summarizePurchaseImportRows,
  validatePurchaseRow,
} from "../src/lib/purchase-import.ts";
import { parseCsvText } from "../src/lib/csv-parser.ts";
import { applyColumnMapping, suggestColumnMapping } from "../src/lib/csv-column-mapping.ts";
import type { Ingredient, IngredientAlias, SupplyEntry } from "../src/lib/product-lab-types.ts";

function ingredient(overrides: Partial<Ingredient> = {}): Ingredient {
  return {
    id: crypto.randomUUID(),
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

function mappedRow(
  overrides: Partial<{
    itemName: string;
    brand: string;
    quantity: string;
    unit: string;
    totalPrice: string;
    expirationDate: string;
    category: string;
    packageCount: string;
    packageSize: string;
    packageUnit: string;
    unitPrice: string;
    supplier: string;
    receiptNumber: string;
    purchaseDate: string;
  }> = {},
) {
  return {
    itemName: "Fresh Milk",
    brand: "",
    quantity: "6",
    unit: "L",
    totalPrice: "570",
    expirationDate: "2026-07-30",
    category: "",
    packageCount: "",
    packageSize: "",
    packageUnit: "",
    unitPrice: "",
    supplier: "",
    receiptNumber: "",
    purchaseDate: "",
    ...overrides,
  };
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

test("isPurchaseImportReadyToConfirm is true when every non-excluded row is matched", () => {
  assert.equal(isPurchaseImportReadyToConfirm([{ rowStatus: "matched", brandName: "Van Houten" }, { rowStatus: "excluded", brandName: "" }]), true);
  assert.equal(isPurchaseImportReadyToConfirm([{ rowStatus: "matched", brandName: "Van Houten" }, { rowStatus: "pending", brandName: "" }]), false);
  assert.equal(isPurchaseImportReadyToConfirm([{ rowStatus: "matched", brandName: "Van Houten" }, { rowStatus: "invalid", brandName: "" }]), false);
});

test("isPurchaseImportReadyToConfirm allows blank brand because brand is review metadata, not stock-safety data", () => {
  assert.equal(isPurchaseImportReadyToConfirm([{ rowStatus: "matched", brandName: "" }]), true);
  assert.equal(isPurchaseImportReadyToConfirm([{ rowStatus: "matched", brandName: "   " }]), true);
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

test("summarizePurchaseImportRows splits pending rows into suggested vs. genuinely unmatched", () => {
  const chocolate = ingredient({ id: "vh-id", name: "Van Houten Dark Chocolate", baseUnit: "g" });
  const drafts = buildPurchaseImportRowDrafts(
    [mappedRow({ itemName: "Van Houten Dark Chocolate Compound", packageCount: "1", packageSize: "1000", packageUnit: "g" }), mappedRow({ itemName: "Completely Unknown Item" })],
    [chocolate],
    [],
  );

  assert.equal(drafts[0].matchMethod, "suggested");
  assert.equal(drafts[1].matchMethod, "none");

  const summary = summarizePurchaseImportRows(drafts);

  assert.equal(summary.pendingCount, 2);
  assert.equal(summary.suggestedCount, 1);
  assert.equal(summary.unmatchedCount, 1);
});

test("resolvePackageQuantity multiplies package count by package size", () => {
  const result = resolvePackageQuantity({ packageCount: "2", packageSize: "1", packageUnit: "kg", unitPrice: "563" });

  assert.deepEqual(result.errors, []);
  assert.equal(result.quantity, 2);
  assert.equal(result.unit, "kg");
  assert.equal(result.totalPrice, 1126);
});

test("resolvePackageQuantity handles 3 x 500g and 4 x 250ml from the spec", () => {
  assert.equal(resolvePackageQuantity({ packageCount: "3", packageSize: "500", packageUnit: "g", unitPrice: "" }).quantity, 1500);
  assert.equal(resolvePackageQuantity({ packageCount: "4", packageSize: "250", packageUnit: "ml", unitPrice: "" }).quantity, 1000);
});

test("resolvePackageQuantity defaults package count to 1 when blank", () => {
  const result = resolvePackageQuantity({ packageCount: "", packageSize: "1", packageUnit: "kg", unitPrice: "563" });

  assert.deepEqual(result.errors, []);
  assert.equal(result.parsedPackageCount, 1);
  assert.equal(result.quantity, 1);
  assert.equal(result.totalPrice, 563);
});

test("resolvePackageQuantity requires a positive package size", () => {
  assert.ok(resolvePackageQuantity({ packageCount: "2", packageSize: "0", packageUnit: "kg", unitPrice: "" }).errors.length > 0);
  assert.ok(resolvePackageQuantity({ packageCount: "2", packageSize: "", packageUnit: "kg", unitPrice: "" }).errors.length > 0);
});

test("resolvePackageQuantity requires a package unit", () => {
  assert.ok(resolvePackageQuantity({ packageCount: "2", packageSize: "1", packageUnit: "", unitPrice: "" }).errors.length > 0);
});

test("resolvePackageQuantity rejects a negative unit price", () => {
  assert.ok(resolvePackageQuantity({ packageCount: "2", packageSize: "1", packageUnit: "kg", unitPrice: "-5" }).errors.length > 0);
});

test("resolveRowQuantity picks the package path when packageUnit is present", () => {
  const result = resolveRowQuantity({ quantity: "", unit: "", totalPrice: "", packageCount: "2", packageSize: "1", packageUnit: "kg", unitPrice: "563" });

  assert.equal(result.parsedQuantity, 2);
  assert.equal(result.effectiveUnit, "kg");
  assert.equal(result.parsedTotalPrice, 1126);
});

test("resolveRowQuantity falls back to the flat path when packageUnit is blank, unaffected by item name", () => {
  const result = resolveRowQuantity({ quantity: "6", unit: "L", totalPrice: "570", packageCount: "", packageSize: "", packageUnit: "", unitPrice: "" });

  assert.deepEqual(result.errors, []);
  assert.equal(result.parsedQuantity, 6);
  assert.equal(result.effectiveUnit, "L");
  assert.equal(result.parsedTotalPrice, 570);
});

test("resolveRowQuantity never reports an item-name error -- that's buildPurchaseImportRowDrafts's job, not this function's", () => {
  const result = resolveRowQuantity({ quantity: "", unit: "", totalPrice: "", packageCount: "", packageSize: "", packageUnit: "", unitPrice: "" });

  assert.ok(!result.errors.some((error) => error.includes("Item name")));
});

test("buildPurchaseImportRowDrafts uses package math end to end (the spec's Van Houten example)", () => {
  const chocolate = ingredient({ id: "vh-id", name: "Van Houten Dark Chocolate", baseUnit: "kg" });

  const [draft] = buildPurchaseImportRowDrafts(
    [mappedRow({ itemName: "Van Houten Dark Chocolate", category: "ingredient", packageCount: "2", packageSize: "1", packageUnit: "kg", unitPrice: "563", totalPrice: "" })],
    [chocolate],
    [],
  );

  assert.equal(draft.rowStatus, "matched");
  assert.equal(draft.parsedQuantity, 2);
  assert.equal(draft.convertedQuantity, 2);
  assert.equal(draft.parsedTotalPrice, 1126);
  assert.equal(draft.parsedPackageCount, 2);
  assert.equal(draft.parsedPackageSize, 1);
  assert.equal(draft.parsedUnitPrice, 563);
});

test("buildPurchaseImportRowDrafts leaves a flat-format (no package columns) row completely unaffected", () => {
  const milk = ingredient({ id: "milk-id", name: "Fresh Milk", baseUnit: "ml" });

  const [draft] = buildPurchaseImportRowDrafts([mappedRow({ itemName: "Fresh Milk", quantity: "6", unit: "L", totalPrice: "570" })], [milk], []);

  assert.equal(draft.rowStatus, "matched");
  assert.equal(draft.convertedQuantity, 6000);
  assert.equal(draft.parsedTotalPrice, 570);
  assert.equal(draft.parsedPackageCount, 0);
});

test("buildPurchaseImportRowDrafts marks a package row invalid, not matched, when package size is missing", () => {
  const [draft] = buildPurchaseImportRowDrafts([mappedRow({ packageCount: "2", packageUnit: "kg" })], [], []);

  assert.equal(draft.rowStatus, "invalid");
  assert.ok(draft.validationErrors.includes("Package size"));
});

test("buildPurchaseImportRowDrafts prefills brand only when every existing supply for that ingredient agrees", () => {
  const chocolate = ingredient({ id: "vh-id", name: "Van Houten Dark Chocolate", baseUnit: "kg" });
  const priorPurchase: SupplyEntry = {
    id: "s1",
    ingredientId: "",
    ingredientName: "Van Houten Dark Chocolate",
    brandName: "Van Houten",
    supplierName: "Main",
    purchaseDate: "2026-01-01",
    createdAt: "2026-01-01T00:00:00.000Z",
    packQuantity: 1,
    unit: "kg",
    totalCost: 500,
    qualityRating: 0,
    notes: "",
  };

  const [draft] = buildPurchaseImportRowDrafts(
    [mappedRow({ itemName: "Van Houten Dark Chocolate", packageCount: "2", packageSize: "1", packageUnit: "kg", unitPrice: "563" })],
    [chocolate],
    [],
    [priorPurchase],
  );

  assert.equal(draft.brandName, "Van Houten");
});

test("buildPurchaseImportRowDrafts leaves brand blank when there is no reliable history, requiring the operator to fill it in", () => {
  const chocolate = ingredient({ id: "vh-id", name: "Van Houten Dark Chocolate", baseUnit: "kg" });

  const [draft] = buildPurchaseImportRowDrafts(
    [mappedRow({ itemName: "Van Houten Dark Chocolate", packageCount: "2", packageSize: "1", packageUnit: "kg", unitPrice: "563" })],
    [chocolate],
    [],
    [],
  );

  assert.equal(draft.brandName, "");
});

test("buildPurchaseImportRowDrafts never resolves a suggested match to 'matched' -- the operator must confirm it", () => {
  const chocolate = ingredient({ id: "vh-id", name: "Van Houten Dark Chocolate", baseUnit: "g" });

  const [draft] = buildPurchaseImportRowDrafts([mappedRow({ itemName: "Van Houten Dark Chocolate Compound", packageCount: "1", packageSize: "1000", packageUnit: "g" })], [chocolate], []);

  assert.equal(draft.matchMethod, "suggested");
  assert.equal(draft.rowStatus, "pending");
  assert.equal(draft.ingredientId, "vh-id");
});

// From the spec's own alias example: a receipt spelling different enough from the ingredient name
// (no space in "VANHOUTEN") isn't a word-subset of it either, so it doesn't even reach the
// "suggested" tier -- it requires a manual match the first time, exactly as the spec describes,
// and only resolves automatically once that manual match is saved as an alias.
test("buildPurchaseImportRowDrafts requires a manual match for a receipt spelling too different to suggest", () => {
  const chocolate = ingredient({ id: "vh-id", name: "Van Houten Dark Chocolate", baseUnit: "g" });

  const [draft] = buildPurchaseImportRowDrafts([mappedRow({ itemName: "VANHOUTEN DARK CHOCOLATE COMPOUND 1KG", packageCount: "1", packageSize: "1000", packageUnit: "g" })], [chocolate], []);

  assert.equal(draft.matchMethod, "none");
  assert.equal(draft.rowStatus, "pending");
  assert.equal(draft.ingredientId, "");
});

// Integration-level, through the real row-builder end to end -- not findPartialMatch in isolation.
// Realistic data for both reported scenarios: an ingredient with no brand baked into its own name,
// a SupplyEntry recording that ingredient's actual purchase brand, and a package-format CSV row
// exactly as the real importer produces (packageCount/packageSize/packageUnit/unitPrice, not a
// hand-built MappedRow missing fields a real upload would always populate).
test("buildPurchaseImportRowDrafts suggests a brand-history match end to end for the exact reported CSV row", () => {
  const chocolate = ingredient({ id: "choc-id", name: "Dark Chocolate Compound", baseUnit: "kg" });
  const history: SupplyEntry = {
    id: "supply-1",
    ingredientId: "",
    ingredientName: "Dark Chocolate Compound",
    brandName: "Vanhouten",
    supplierName: "Main",
    purchaseDate: "2026-01-01",
    createdAt: "2026-01-01T00:00:00.000Z",
    packQuantity: 1,
    unit: "kg",
    totalCost: 563,
    qualityRating: 0,
    notes: "",
  };

  const [draft] = buildPurchaseImportRowDrafts(
    [mappedRow({ itemName: "Van Houten Dark Chocolate Capo 1KG", category: "ingredient", packageCount: "2", packageSize: "1", packageUnit: "kg", unitPrice: "563" })],
    [chocolate],
    [],
    [history],
  );

  assert.equal(draft.ingredientId, "choc-id");
  assert.equal(draft.matchMethod, "suggested");
  assert.equal(draft.rowStatus, "pending");
});

test("buildPurchaseImportRowDrafts suggests a second brand-history match for a different brand/ingredient in the same upload", () => {
  const cocoa = ingredient({ id: "cocoa-id", name: "Classic Cocoa Powder", baseUnit: "kg" });
  const history: SupplyEntry = {
    id: "supply-2",
    ingredientId: "",
    ingredientName: "Classic Cocoa Powder",
    brandName: "Beryl's",
    supplierName: "Main",
    purchaseDate: "2026-01-01",
    createdAt: "2026-01-01T00:00:00.000Z",
    packQuantity: 1,
    unit: "kg",
    totalCost: 300,
    qualityRating: 0,
    notes: "",
  };

  const [draft] = buildPurchaseImportRowDrafts(
    [mappedRow({ itemName: "Beryl's Classic Cocoa Powder 1KG", category: "ingredient", packageCount: "1", packageSize: "1", packageUnit: "kg", unitPrice: "300" })],
    [cocoa],
    [],
    [history],
  );

  assert.equal(draft.ingredientId, "cocoa-id");
  assert.equal(draft.matchMethod, "suggested");
  assert.equal(draft.rowStatus, "pending");
});

// buildExcludeRowChanges: the entire effect of clicking Remove. Regression coverage for a
// reported bug where excluding a row appeared to also change its ingredient match -- this
// function is typed to return only rowStatus/excludeReason, so a bug like that is structurally
// impossible here, not just untested. Remove has no "un-remove": once a row is excluded, the
// wizard hides it from every view for the rest of that import (see purchase-import-wizard.tsx).

test("buildExcludeRowChanges only ever returns rowStatus and excludeReason", () => {
  const changes = buildExcludeRowChanges();

  assert.deepEqual(Object.keys(changes).sort(), ["excludeReason", "rowStatus"]);
  assert.equal(changes.rowStatus, "excluded");
  assert.equal(changes.excludeReason, "Excluded by operator");
});

test("removing a row removes it from confirmable rows even though its ingredient match is untouched", () => {
  const milk = ingredient({ id: "milk-id", baseUnit: "ml" });
  const [draft] = buildPurchaseImportRowDrafts([mappedRow({ itemName: "Fresh Milk", quantity: "6", unit: "L" })], [milk], []);
  assert.equal(draft.rowStatus, "matched");

  const excluded = { ...draft, ...buildExcludeRowChanges() };

  // The match itself is exactly as it was -- exclude only ever toggles inclusion.
  assert.equal(excluded.ingredientId, draft.ingredientId);
  assert.equal(excluded.matchMethod, draft.matchMethod);
  assert.equal(excluded.convertedQuantity, draft.convertedQuantity);
  assert.equal(excluded.brandName, draft.brandName);

  // But it's no longer a blocker for -- nor counted toward -- confirmation.
  const otherRow = { ...draft, rowIndex: 1, rowStatus: "pending" as const };
  assert.equal(isPurchaseImportReadyToConfirm([excluded]), true);
  assert.equal(isPurchaseImportReadyToConfirm([excluded, otherRow]), false);

  const summary = summarizePurchaseImportRows([excluded]);
  assert.equal(summary.excludedCount, 1);
  assert.equal(summary.matchedCount, 0);
});

test("guessIngredientCategory matches a controlled value case- and whitespace-insensitively", () => {
  assert.equal(guessIngredientCategory("Ingredient"), "ingredient");
  assert.equal(guessIngredientCategory("  PACKAGING  "), "packaging");
  assert.equal(guessIngredientCategory("consumable"), "consumable");
  assert.equal(guessIngredientCategory("Other"), "other");
});

test("guessIngredientCategory matches the plural of a controlled value", () => {
  assert.equal(guessIngredientCategory("Ingredients"), "ingredient");
  assert.equal(guessIngredientCategory("Consumables"), "consumable");
});

test("guessIngredientCategory returns empty rather than guessing at an unrecognized value", () => {
  assert.equal(guessIngredientCategory("Raw Material"), "");
  assert.equal(guessIngredientCategory("Equipment"), "");
  assert.equal(guessIngredientCategory(""), "");
});

// Full pipeline, real implementations only: parseCsvText -> suggestColumnMapping ->
// applyColumnMapping -> buildPurchaseImportRowDrafts. Regression test for a bug where a CSV's own
// "brand" column was silently dropped -- ColumnField had no "brand" entry at all, so the value
// never survived past the very first mapping step, and every row showed "Brand: --" regardless of
// whether the receipt actually specified one.
test("a CSV's brand column survives the real parse -> map -> draft pipeline, matched or not", () => {
  const csvText = ["brand,item_name,package_count,package_size,package_unit,unit_price", "Goya,Chocolate Chips,1,150,g,175", "Vanhouten,Dark Chocolate Compound,1,1000,g,365", "Beryl's,Classic Cocoa Powder,1,1000,g,900"].join("\n");

  const parsed = parseCsvText(csvText);
  const mapping = suggestColumnMapping(parsed.headers);
  const mappedRows = applyColumnMapping(parsed, mapping);
  const knownIngredients = [ingredient({ id: "choc-id", name: "Dark Chocolate Compound", baseUnit: "g" }), ingredient({ id: "cocoa-id", name: "Classic Cocoa Powder", baseUnit: "g" })];

  const drafts = buildPurchaseImportRowDrafts(mappedRows, knownIngredients, [], []);

  // The brand header is recognized and every row's raw brand is preserved regardless of match
  // outcome -- this is the exact bug: brand used to be lost before any of this even ran.
  assert.deepEqual(
    drafts.map((draft) => draft.rawBrand),
    ["Goya", "Vanhouten", "Beryl's"],
  );
  assert.deepEqual(
    drafts.map((draft) => draft.brandName),
    ["Goya", "Vanhouten", "Beryl's"],
  );

  const [chocolateChips, darkChocolate, cocoaPowder] = drafts;

  // Vanhouten + Dark Chocolate Compound and Beryl's + Classic Cocoa Powder match existing items.
  assert.equal(darkChocolate.ingredientId, "choc-id");
  assert.equal(darkChocolate.rowStatus, "matched");
  assert.equal(cocoaPowder.ingredientId, "cocoa-id");
  assert.equal(cocoaPowder.rowStatus, "matched");

  // Goya + Chocolate Chips has no matching item, but the row brand must still be "Goya", not
  // blanked out just because nothing matched.
  assert.equal(chocolateChips.ingredientId, "");
  assert.notEqual(chocolateChips.rowStatus, "matched");
  assert.equal(chocolateChips.brandName, "Goya");
});

// Old-format CSVs (no brand column at all) must keep working exactly as before: brand falls back
// to whatever findReliableBrandForIngredient infers from purchase history, same as pre-fix.
test("a CSV with no brand column still resolves brand from purchase history, unaffected by the brand-column fix", () => {
  const csvText = ["item_name,package_count,package_size,package_unit,unit_price", "Dark Chocolate Compound,1,1000,g,365"].join("\n");

  const parsed = parseCsvText(csvText);
  const mapping = suggestColumnMapping(parsed.headers);
  const mappedRows = applyColumnMapping(parsed, mapping);
  const knownIngredients = [ingredient({ id: "choc-id", name: "Dark Chocolate Compound" })];
  const priorPurchase: SupplyEntry = {
    id: "prior",
    ingredientId: "",
    ingredientName: "Dark Chocolate Compound",
    brandName: "Van Houten",
    supplierName: "Main",
    purchaseDate: "2026-01-01",
    createdAt: "2026-01-01T00:00:00.000Z",
    packQuantity: 1000,
    unit: "g",
    totalCost: 350,
    qualityRating: 4,
    notes: "",
  };

  const [draft] = buildPurchaseImportRowDrafts(mappedRows, knownIngredients, [], [priorPurchase]);

  assert.equal(draft.rawBrand, "");
  assert.equal(draft.brandName, "Van Houten");
});

test("a matched CSV row resolves brand from ID-linked history after an Item rename", () => {
  const csvText = ["item_name,package_count,package_size,package_unit,unit_price", "Chocolate Compound - Dark,1,1000,g,365"].join("\n");

  const parsed = parseCsvText(csvText);
  const mapping = suggestColumnMapping(parsed.headers);
  const mappedRows = applyColumnMapping(parsed, mapping);
  const knownIngredients = [ingredient({ id: "choc-id", name: "Chocolate Compound - Dark", baseUnit: "g" })];
  const priorPurchase: SupplyEntry = {
    id: "prior",
    ingredientId: "choc-id",
    ingredientName: "Dark Chocolate Compound",
    brandName: "Van Houten",
    supplierName: "Main",
    purchaseDate: "2026-01-01",
    createdAt: "2026-01-01T00:00:00.000Z",
    packQuantity: 1000,
    unit: "g",
    totalCost: 350,
    qualityRating: 4,
    notes: "",
  };

  const [draft] = buildPurchaseImportRowDrafts(mappedRows, knownIngredients, [], [priorPurchase]);

  assert.equal(draft.ingredientId, "choc-id");
  assert.equal(draft.brandName, "Van Houten");
});
