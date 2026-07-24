import test from "node:test";
import assert from "node:assert/strict";
import { buildAliasRecord, findAliasMatch, findExactMatch, findNormalizedMatch, resolveIngredientReference } from "../src/lib/ingredient-matching.ts";
import { normalizeIngredientName, normalizeUnitText } from "../src/lib/ingredient-normalization.ts";
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
