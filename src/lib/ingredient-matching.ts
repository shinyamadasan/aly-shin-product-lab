import type { Ingredient, IngredientAlias, MatchMethod, SupplyEntry } from "./product-lab-types";
import { normalizeBrandText, normalizeIngredientName } from "./ingredient-normalization.ts";
import { findReliableBrandForItem } from "./purchase-history.ts";

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

function isSubset(smaller: Set<string>, larger: Set<string>) {
  return smaller.size >= 2 && [...smaller].every((word) => larger.has(word));
}

// Only reachable once a brand is confirmed, never used to loosen matching in general. Tries
// increasing word-count prefixes of the receipt's tokens (capped at 4 -- no real brand is longer)
// and checks each one's *compact* form (no spaces at all) against the target brand's compact form,
// so "van" + "houten" -> "vanhouten" matches a recorded brand of "Vanhouten" or "Van Houten"
// equally. Returns the tokens with none stripped if no prefix matches.
export function stripLeadingBrandTokens(tokens: string[], brand: string): string[] {
  const targetCompact = normalizeBrandText(brand);
  if (!targetCompact) {
    return tokens;
  }
  const maxPrefixLength = Math.min(tokens.length, 4);
  for (let length = 1; length <= maxPrefixLength; length++) {
    if (tokens.slice(0, length).join("") === targetCompact) {
      return tokens.slice(length);
    }
  }
  return tokens;
}

export type PartialMatchCandidateTrace = {
  ingredientId: string;
  ingredientName: string;
  isActive: boolean;
  nameTokens: string[];
  strictSubsetMatch: boolean;
  knownBrand: string;
  normalizedKnownBrand: string;
  brandPrefixFound: boolean;
  remainderTokens: string[];
  sharedWords: string[];
  passed: boolean;
  rejectionReason: string;
};

export type PartialMatchTrace = {
  rawText: string;
  normalizedItemName: string;
  targetTokens: string[];
  candidates: PartialMatchCandidateTrace[];
  passingCandidateIds: string[];
  matchedIngredientId: string | null;
};

function evaluatePartialMatchCandidate(ingredient: Ingredient, targetTokens: string[], targetWords: Set<string>, supplies: SupplyEntry[]): PartialMatchCandidateTrace {
  const nameTokens = normalizeIngredientName(ingredient.name).split(" ").filter(Boolean);
  const base = { ingredientId: ingredient.id, ingredientName: ingredient.name, isActive: ingredient.isActive, nameTokens };

  if (!ingredient.isActive) {
    return { ...base, strictSubsetMatch: false, knownBrand: "", normalizedKnownBrand: "", brandPrefixFound: false, remainderTokens: [], sharedWords: [], passed: false, rejectionReason: "ingredient is inactive" };
  }

  const nameWords = new Set(nameTokens);
  const strictSubsetMatch = isSubset(targetWords, nameWords) || isSubset(nameWords, targetWords);
  if (strictSubsetMatch) {
    return { ...base, strictSubsetMatch: true, knownBrand: "", normalizedKnownBrand: "", brandPrefixFound: false, remainderTokens: [], sharedWords: [], passed: true, rejectionReason: "" };
  }

  const knownBrand = findReliableBrandForItem(ingredient, supplies);
  const normalizedKnownBrand = normalizeBrandText(knownBrand);
  if (!knownBrand) {
    return {
      ...base,
      strictSubsetMatch: false,
      knownBrand,
      normalizedKnownBrand,
      brandPrefixFound: false,
      remainderTokens: [],
      sharedWords: [],
      passed: false,
      rejectionReason: "no strict-subset match, and no single reliable brand on purchase history for this ingredient (findReliableBrandForIngredient returned '')",
    };
  }

  const remainder = stripLeadingBrandTokens(targetTokens, knownBrand);
  const brandPrefixFound = remainder.length !== targetTokens.length;
  if (!brandPrefixFound) {
    return {
      ...base,
      strictSubsetMatch: false,
      knownBrand,
      normalizedKnownBrand,
      brandPrefixFound: false,
      remainderTokens: targetTokens,
      sharedWords: [],
      passed: false,
      rejectionReason: `receipt text's leading words never compact-match this ingredient's known brand "${knownBrand}" (normalized "${normalizedKnownBrand}")`,
    };
  }

  const sharedWords = [...new Set(remainder.filter((word) => nameWords.has(word)))];
  const passed = sharedWords.length >= 2;
  return {
    ...base,
    strictSubsetMatch: false,
    knownBrand,
    normalizedKnownBrand,
    brandPrefixFound: true,
    remainderTokens: remainder,
    sharedWords,
    passed,
    rejectionReason: passed ? "" : `brand matched, but only ${sharedWords.length} shared word(s) after stripping it (need >=2): [${sharedWords.join(", ")}]`,
  };
}

// The full diagnostic version of findPartialMatch -- same two tiers, same rules, but returns a
// per-candidate breakdown (why each ingredient did or didn't qualify) instead of just the winner.
// findPartialMatch below is a thin wrapper over this, not a separate implementation, so the trace
// can never drift from what actually runs.
//
// Two tiers, both "strong" on purpose -- neither is scored/fuzzy similarity:
//
// 1. Brand-agnostic word-subset: one name's word set must fully contain the other's, with at
//    least 2 shared words -- a single shared generic word (e.g. "chocolate") is never enough on
//    its own. This is what keeps brand distinct when the brand is baked into the ingredient's own
//    name ("Van Houten Dark Chocolate" tokens are {van, houten, dark, chocolate}; "Beryl's Dark
//    Chocolate" tokens are {beryls, dark, chocolate} -- neither is a subset of the other).
//
// 2. Brand-aware overlap: only reachable when this ingredient has exactly one reliable brand on
//    purchase record (findReliableBrandForIngredient already refuses to guess when history is
//    absent or disagrees) AND the receipt's leading words compact-normalize to that same brand
//    ("Van Houten"/"Vanhouten" -> "vanhouten"). Once the brand itself is confirmed compatible --
//    not merely ignored -- the remaining words only need >=2 in common, not full containment, which
//    is what lets "Capo" not block a match against "Compound". A receipt naming a *different*
//    known brand is rejected outright here, the same protection as tier 1, just checked explicitly
//    instead of falling out of a subset check.
//
// Either tier passing for more than one active ingredient makes the match ambiguous, not "strong"
// -- return null rather than guess between them, same as every other tier here.
export function traceFindPartialMatch(rawText: string, ingredients: Ingredient[], supplies: SupplyEntry[] = []): PartialMatchTrace {
  const normalizedItemName = normalizeIngredientName(rawText);
  const targetTokens = normalizedItemName.split(" ").filter(Boolean);
  const targetWords = new Set(targetTokens);

  if (targetWords.size < 2) {
    return { rawText, normalizedItemName, targetTokens, candidates: [], passingCandidateIds: [], matchedIngredientId: null };
  }

  const candidates = ingredients.map((ingredient) => evaluatePartialMatchCandidate(ingredient, targetTokens, targetWords, supplies));
  const passingCandidateIds = candidates.filter((candidate) => candidate.passed).map((candidate) => candidate.ingredientId);

  return {
    rawText,
    normalizedItemName,
    targetTokens,
    candidates,
    passingCandidateIds,
    matchedIngredientId: passingCandidateIds.length === 1 ? passingCandidateIds[0] : null,
  };
}

export function findPartialMatch(rawText: string, ingredients: Ingredient[], supplies: SupplyEntry[] = []): string | null {
  return traceFindPartialMatch(rawText, ingredients, supplies).matchedIngredientId;
}

// For a genuinely new ingredient with no purchase history of its own -- findReliableBrandForIngredient
// can't help (there's nothing recorded for it yet). This checks whether the receipt's leading words
// compact-match ANY brand already used for ANY existing ingredient, since a brand is a real-world
// identity that spans multiple products (the same supplier brand sells chocolate and cocoa powder
// alike), not something scoped to one ingredient. Always a suggestion, never authoritative -- the
// caller must still let the operator confirm or edit it, and two or more known brands both
// appearing to match is treated as ambiguous, not guessed between, same rule as everywhere else.
export function suggestBrandFromKnownBrands(rawText: string, supplies: SupplyEntry[]): string {
  const targetTokens = normalizeIngredientName(rawText).split(" ").filter(Boolean);
  if (targetTokens.length === 0) {
    return "";
  }

  const distinctSpellings = [...new Set(supplies.map((entry) => entry.brandName.trim()).filter(Boolean))];
  const matchingSpellings = distinctSpellings.filter((brand) => stripLeadingBrandTokens(targetTokens, brand).length !== targetTokens.length);

  // Ambiguity is judged on the normalized brand, not the raw spelling -- "Vanhouten" and "Van
  // Houten" both matching is agreement (same brand), not a conflict, the same distinction
  // findReliableBrandForIngredient makes.
  const distinctNormalizedMatches = new Set(matchingSpellings.map((brand) => normalizeBrandText(brand)));
  return distinctNormalizedMatches.size === 1 ? matchingSpellings[0] : "";
}

// The resolution order this app uses, for both CSV import and (in a later milestone) bake formula
// rows: saved alias -> exact name match -> normalized name match -> strong partial match ->
// manual assignment. Every tier through "normalized" resolves a row outright. "suggested" is
// different on purpose: it pre-fills the picker but the caller must still land the row on
// "pending", never "matched", so an unresolved row always requires the operator to confirm it --
// never a guess applied above some confidence threshold.
export function resolveIngredientReference(rawText: string, ingredients: Ingredient[], aliases: IngredientAlias[], supplies: SupplyEntry[] = []): IngredientMatch {
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

  const partialMatch = findPartialMatch(rawText, ingredients, supplies);
  if (partialMatch) {
    return { ingredientId: partialMatch, method: "suggested" };
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
