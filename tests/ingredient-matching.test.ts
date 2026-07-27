import test from "node:test";
import assert from "node:assert/strict";
import { buildAliasRecord, findAliasMatch, findExactMatch, findNormalizedMatch, findPartialMatch, resolveIngredientReference, suggestBrandFromKnownBrands } from "../src/lib/ingredient-matching.ts";
import { normalizeBrandText, normalizeIngredientName, normalizeUnitText } from "../src/lib/ingredient-normalization.ts";
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

function alias(overrides: Partial<IngredientAlias> = {}): IngredientAlias {
  return {
    id: crypto.randomUUID(),
    rawText: "Alaska Fresh Milk",
    normalizedText: "alaska fresh milk",
    ingredientId: "ingredient-1",
    source: "purchase_import",
    ...overrides,
  };
}

function supplyEntry(overrides: Partial<SupplyEntry> = {}): SupplyEntry {
  return {
    id: crypto.randomUUID(),
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
    ...overrides,
  };
}

test("normalizeIngredientName lowercases, strips punctuation, and collapses whitespace", () => {
  assert.equal(normalizeIngredientName("  Fresh   Milk!! "), "fresh milk");
});

test("normalizeIngredientName strips a trailing package size", () => {
  assert.equal(normalizeIngredientName("Fresh Milk 1L"), "fresh milk");
  assert.equal(normalizeIngredientName("Brown Sugar 500g"), "brown sugar");
  assert.equal(normalizeIngredientName("Coffee Beans 1kg"), "coffee beans");
});

test("normalizeUnitText maps common synonyms to the canonical base-unit spelling", () => {
  assert.equal(normalizeUnitText("Grams"), "g");
  assert.equal(normalizeUnitText("KG"), "kg");
  assert.equal(normalizeUnitText("l"), "L");
  assert.equal(normalizeUnitText("Liters"), "L");
  assert.equal(normalizeUnitText("pieces"), "pcs");
});

test("normalizeUnitText leaves an unrecognized unit as-is (trimmed)", () => {
  assert.equal(normalizeUnitText(" tbsp "), "tbsp");
});

test("findAliasMatch matches a saved alias case-insensitively", () => {
  const savedAlias = alias({ rawText: "Alaska Fresh Milk", ingredientId: "milk-id" });

  assert.equal(findAliasMatch("alaska fresh milk", [savedAlias]), "milk-id");
});

test("findExactMatch requires the raw text to equal the ingredient name (case-insensitive), not just a normalized match", () => {
  const milk = ingredient({ id: "milk-id", name: "Fresh Milk" });

  assert.equal(findExactMatch("fresh milk", [milk]), "milk-id");
  assert.equal(findExactMatch("Fresh Milk 1L", [milk]), null);
});

test("findNormalizedMatch matches after stripping package size and punctuation", () => {
  const milk = ingredient({ id: "milk-id", name: "Fresh Milk" });

  assert.equal(findNormalizedMatch("Fresh Milk 1L", [milk]), "milk-id");
});

test("findExactMatch and findNormalizedMatch ignore inactive ingredients", () => {
  const milk = ingredient({ id: "milk-id", name: "Fresh Milk", isActive: false });

  assert.equal(findExactMatch("Fresh Milk", [milk]), null);
  assert.equal(findNormalizedMatch("Fresh Milk", [milk]), null);
});

test("resolveIngredientReference prefers a saved alias over an exact name match", () => {
  const milk = ingredient({ id: "exact-match-id", name: "Alaska Fresh Milk" });
  const savedAlias = alias({ rawText: "Alaska Fresh Milk", ingredientId: "alias-match-id" });

  const result = resolveIngredientReference("Alaska Fresh Milk", [milk], [savedAlias]);

  assert.equal(result.ingredientId, "alias-match-id");
  assert.equal(result.method, "alias");
});

test("resolveIngredientReference prefers an exact match over a normalized match", () => {
  const exactMilk = ingredient({ id: "exact-id", name: "Fresh Milk 1L" });
  const normalizedMilk = ingredient({ id: "normalized-id", name: "Fresh Milk" });

  const result = resolveIngredientReference("Fresh Milk 1L", [exactMilk, normalizedMilk], []);

  assert.equal(result.ingredientId, "exact-id");
  assert.equal(result.method, "exact");
});

test("resolveIngredientReference falls back to a normalized match when nothing matches exactly", () => {
  const milk = ingredient({ id: "milk-id", name: "Fresh Milk" });

  const result = resolveIngredientReference("FRESH MILK 1L!", [milk], []);

  assert.equal(result.ingredientId, "milk-id");
  assert.equal(result.method, "normalized");
});

test("findPartialMatch resolves when a receipt line's words are a subset of the ingredient name", () => {
  const chocolate = ingredient({ id: "vh-id", name: "Van Houten Dark Chocolate" });

  assert.equal(findPartialMatch("Van Houten Dark Chocolate Compound", [chocolate]), "vh-id");
});

test("findPartialMatch never crosses brands, even with a shared product word", () => {
  const vanHouten = ingredient({ id: "vh-id", name: "Van Houten Dark Chocolate" });
  const beryls = ingredient({ id: "beryls-id", name: "Beryl's Dark Chocolate" });

  assert.equal(findPartialMatch("Van Houten Dark Chocolate Compound 1KG", [vanHouten, beryls]), "vh-id");
  assert.equal(findPartialMatch("Beryl's Dark Chocolate Chips", [vanHouten, beryls]), "beryls-id");
});

test("findPartialMatch requires at least 2 shared words -- a single generic word never matches alone", () => {
  const vanHouten = ingredient({ id: "vh-id", name: "Van Houten Dark Chocolate" });

  assert.equal(findPartialMatch("Chocolate", [vanHouten]), null);
});

test("findPartialMatch returns null, not a guess, when two ingredients are equally plausible", () => {
  const vanHouten = ingredient({ id: "vh-id", name: "Van Houten Dark Chocolate" });
  const beryls = ingredient({ id: "beryls-id", name: "Beryl's Dark Chocolate" });

  // "Dark Chocolate" alone is a genuine subset of both -- ambiguous, so no suggestion.
  assert.equal(findPartialMatch("Dark Chocolate", [vanHouten, beryls]), null);
});

test("findPartialMatch ignores inactive ingredients", () => {
  const inactive = ingredient({ id: "old-id", name: "Van Houten Dark Chocolate", isActive: false });

  assert.equal(findPartialMatch("Van Houten Dark Chocolate Compound", [inactive]), null);
});

test("resolveIngredientReference suggests a partial match but does not resolve it outright", () => {
  const chocolate = ingredient({ id: "vh-id", name: "Van Houten Dark Chocolate" });

  const result = resolveIngredientReference("Van Houten Dark Chocolate Compound 1KG", [chocolate], []);

  assert.equal(result.ingredientId, "vh-id");
  assert.equal(result.method, "suggested");
});

test("resolveIngredientReference prefers normalized over suggested", () => {
  const chocolate = ingredient({ id: "vh-id", name: "Van Houten Dark Chocolate" });

  // Package size is stripped by normalization, so this is a normalized match, not merely a partial one.
  const result = resolveIngredientReference("Van Houten Dark Chocolate 1kg", [chocolate], []);

  assert.equal(result.method, "normalized");
});

test("normalizeBrandText collapses spaced and compact brand spellings to the same string", () => {
  assert.equal(normalizeBrandText("Van Houten"), "vanhouten");
  assert.equal(normalizeBrandText("Vanhouten"), "vanhouten");
  assert.equal(normalizeBrandText("Beryl's"), "beryls");
  assert.equal(normalizeBrandText("Beryls"), "beryls");
});

// Regression coverage for the exact reported bug: a generic ingredient name ("Dark Chocolate
// Compound") with no brand baked into it, an established brand-purchase history ("Vanhouten"), and
// a receipt line spelling the brand differently ("Van Houten"), naming a different product word
// ("Capo" vs "Compound"), and carrying packaging noise ("1KG").
test("findPartialMatch suggests a brand-history match even when the ingredient name carries no brand and the product word differs", () => {
  const chocolate = ingredient({ id: "choc-id", name: "Dark Chocolate Compound" });
  const history = [supplyEntry({ ingredientName: "Dark Chocolate Compound", brandName: "Vanhouten" })];

  assert.equal(findPartialMatch("Van Houten Dark Chocolate Capo 1KG", [chocolate], history), "choc-id");
});

test("findPartialMatch's brand-history relaxation still requires >=2 shared words after the brand is stripped", () => {
  const chocolate = ingredient({ id: "choc-id", name: "Dark Chocolate Compound" });
  const history = [supplyEntry({ ingredientName: "Dark Chocolate Compound", brandName: "Vanhouten" })];

  // Only "capo" remains after stripping the brand -- nothing shared with "dark chocolate compound".
  assert.equal(findPartialMatch("Van Houten Capo", [chocolate], history), null);
});

test("findPartialMatch never suggests across a confirmed different brand, even via the brand-history path", () => {
  const vanHoutenChoc = ingredient({ id: "vh-choc-id", name: "Dark Chocolate Compound" });
  const berylsChoc = ingredient({ id: "beryls-choc-id", name: "Milk Chocolate Compound" });
  const history = [
    supplyEntry({ ingredientName: "Dark Chocolate Compound", brandName: "Vanhouten" }),
    supplyEntry({ ingredientName: "Milk Chocolate Compound", brandName: "Beryls" }),
  ];

  // The receipt names Van Houten -- it must never suggest the Beryl's-branded ingredient, even
  // though "Chocolate Compound" is shared with both.
  assert.equal(findPartialMatch("Van Houten Milk Chocolate Capo 1KG", [vanHoutenChoc, berylsChoc], history), null);
  assert.equal(findPartialMatch("Van Houten Dark Chocolate Capo 1KG", [vanHoutenChoc, berylsChoc], history), "vh-choc-id");
});

test("findPartialMatch's brand-history path never fires without reliable purchase history for that ingredient", () => {
  const chocolate = ingredient({ id: "choc-id", name: "Dark Chocolate Compound" });

  assert.equal(findPartialMatch("Van Houten Dark Chocolate Capo 1KG", [chocolate], []), null);
});

test("findPartialMatch's brand-history path refuses to guess when purchase history disagrees on brand", () => {
  const chocolate = ingredient({ id: "choc-id", name: "Dark Chocolate Compound" });
  const conflictingHistory = [
    supplyEntry({ ingredientName: "Dark Chocolate Compound", brandName: "Vanhouten" }),
    supplyEntry({ ingredientName: "Dark Chocolate Compound", brandName: "Beryls" }),
  ];

  assert.equal(findPartialMatch("Van Houten Dark Chocolate Capo 1KG", [chocolate], conflictingHistory), null);
});

test("resolveIngredientReference surfaces a brand-history match as 'suggested', not auto-resolved, exactly as constructed on the first pass", () => {
  const chocolate = ingredient({ id: "choc-id", name: "Dark Chocolate Compound" });
  const history = [supplyEntry({ ingredientName: "Dark Chocolate Compound", brandName: "Vanhouten" })];

  const result = resolveIngredientReference("Van Houten Dark Chocolate Capo 1KG", [chocolate], [], history);

  assert.equal(result.ingredientId, "choc-id");
  assert.equal(result.method, "suggested");
});

test("normalizeIngredientName strips counted packaging units (bags/pcs/pack), not just weight/volume", () => {
  assert.equal(normalizeIngredientName("Brown Sugar 2 bags"), "brown sugar");
  assert.equal(normalizeIngredientName("Coffee Beans 3 pcs"), "coffee beans");
  assert.equal(normalizeIngredientName("Flour 1 pack"), "flour");
});

test("resolveIngredientReference returns none, not a guess, when nothing matches", () => {
  const result = resolveIngredientReference("Completely Unknown Item", [ingredient()], []);

  assert.equal(result.ingredientId, null);
  assert.equal(result.method, "none");
});

test("buildAliasRecord trims raw text and stores its normalized form", () => {
  const record = buildAliasRecord("  Alaska Fresh Milk 1L  ", "milk-id", "purchase_import");

  assert.equal(record.rawText, "Alaska Fresh Milk 1L");
  assert.equal(record.normalizedText, "alaska fresh milk");
  assert.equal(record.ingredientId, "milk-id");
  assert.equal(record.source, "purchase_import");
});

test("suggestBrandFromKnownBrands suggests a brand already used for a different ingredient, for a genuinely new item", () => {
  const history = [supplyEntry({ ingredientName: "Cocoa Powder", brandName: "Vanhouten" })];

  assert.equal(suggestBrandFromKnownBrands("Van Houten Baking Chocolate 500G", history), "Vanhouten");
});

test("suggestBrandFromKnownBrands returns '' when no known brand appears in the receipt text", () => {
  const history = [supplyEntry({ ingredientName: "Cocoa Powder", brandName: "Vanhouten" })];

  assert.equal(suggestBrandFromKnownBrands("Fresh Milk 1L", history), "");
});

test("suggestBrandFromKnownBrands returns '' rather than guessing when two genuinely different known brands both prefix-match", () => {
  const history = [supplyEntry({ ingredientName: "Cocoa Powder", brandName: "Alaska" }), supplyEntry({ ingredientName: "Sugar", brandName: "Alaska Milk" })];

  // Both "Alaska" and "Alaska Milk" are valid leading-word prefixes of the receipt text, and they
  // are genuinely different recorded brands (different normalized forms) -- true ambiguity.
  assert.equal(suggestBrandFromKnownBrands("Alaska Milk Powder 1KG", history), "");
});

test("suggestBrandFromKnownBrands treats differently-spelled entries of the same brand as agreement, not ambiguity", () => {
  const history = [supplyEntry({ ingredientName: "Cocoa Powder", brandName: "Vanhouten" }), supplyEntry({ ingredientName: "Sugar", brandName: "Van Houten" })];

  const result = suggestBrandFromKnownBrands("Van Houten Baking Chocolate 500G", history);

  assert.notEqual(result, "");
  assert.ok(["Vanhouten", "Van Houten"].includes(result));
});

test("suggestBrandFromKnownBrands returns '' when there is no purchase history at all", () => {
  assert.equal(suggestBrandFromKnownBrands("Van Houten Dark Chocolate Capo 1KG", []), "");
});
