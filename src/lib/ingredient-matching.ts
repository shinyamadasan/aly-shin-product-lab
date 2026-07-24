import type { Ingredient, IngredientAlias, MatchMethod } from "./product-lab-types";
import { normalizeIngredientName } from "./ingredient-normalization.ts";

export type IngredientMatch = { ingredientId: string | null; method: MatchMethod };

function normalizeRawText(value: string) {
  return value.trim().toLowerCase();
}

export function findAliasMatch(rawText: string, aliases: IngredientAlias[]): string | null {
  const target = normalizeRawText(rawText);
  if (!target) {
    return null;
  }
  return aliases.find((alias) => normalizeRawText(alias.rawText) === target)?.ingredientId ?? null;
}

export function findExactMatch(rawText: string, ingredients: Ingredient[]): string | null {
  const target = normalizeRawText(rawText);
  if (!target) {
    return null;
  }
  return ingredients.find((ingredient) => ingredient.isActive && normalizeRawText(ingredient.name) === target)?.id ?? null;
}

export function findNormalizedMatch(rawText: string, ingredients: Ingredient[]): string | null {
  const target = normalizeIngredientName(rawText);
  if (!target) {
    return null;
  }
  return ingredients.find((ingredient) => ingredient.isActive && normalizeIngredientName(ingredient.name) === target)?.id ?? null;
}

// The only resolution order this app uses, for both CSV import and (in a later milestone) bake
// formula rows: saved alias -> exact name match -> normalized name match -> manual assignment.
// Deliberately no fuzzy/suggested tier -- an unresolved row always requires the operator to
// assign it, never a guess above some confidence threshold.
export function resolveIngredientReference(rawText: string, ingredients: Ingredient[], aliases: IngredientAlias[]): IngredientMatch {
  const aliasMatch = findAliasMatch(rawText, aliases);
  if (aliasMatch) {
    return { ingredientId: aliasMatch, method: "alias" };
  }

  const exactMatch = findExactMatch(rawText, ingredients);
  if (exactMatch) {
    return { ingredientId: exactMatch, method: "exact" };
  }

  const normalizedMatch = findNormalizedMatch(rawText, ingredients);
  if (normalizedMatch) {
    return { ingredientId: normalizedMatch, method: "normalized" };
  }

  return { ingredientId: null, method: "none" };
}

// Pure payload builder -- an alias is "raw text -> ingredient id" regardless of whether the raw
// text came from a receipt row or (in a later milestone) a bake formula ingredient name. The
// actual save (insert-or-update against Supabase/localStorage) lives in product-lab.tsx.
export function buildAliasRecord(rawText: string, ingredientId: string, source: string) {
  return {
    rawText: rawText.trim(),
    normalizedText: normalizeIngredientName(rawText),
    ingredientId,
    source,
  };
}
