import type { CostingIngredientRow, Ingredient, SupplyEntry } from "./product-lab-types";
import { normalizeBrandText, normalizeIngredientName, normalizeUnitText } from "./ingredient-normalization.ts";
import { convertUnit } from "./unit-conversion.ts";
import { findReliableBrandForItem, findReliableSupplierForItem, getPurchaseHistoryForIngredientReference, getPurchaseSortTime } from "./purchase-history.ts";

export function normalizeSupplyText(value: string) {
  return value.trim().toLowerCase();
}

// A supply record with no usable pack size or price can't produce a real unit cost, so it is
// excluded outright rather than sorted to the bottom -- it was never a valid costing candidate.
export function isValidSupplyForCosting(supply: SupplyEntry) {
  return supply.packQuantity > 0 && supply.totalCost > 0;
}

// Most-recent-purchase wins, not cheapest-ever: a stale cheap price is misleading once a newer,
// more expensive purchase exists. Sort by purchase date descending; created_at is only a fallback
// for the (rare) record with no purchase date, never a substitute for a record that has one.
export function getSupplySortTime(supply: SupplyEntry) {
  return getPurchaseSortTime(supply);
}

export function getMatchingSupplies(supplies: SupplyEntry[], brandName: string, ingredientName: string, unit: string) {
  return supplies
    .filter((supply) => {
      if (!isValidSupplyForCosting(supply)) {
        return false;
      }
      const brandMatches = !brandName.trim() || normalizeSupplyText(supply.brandName) === normalizeSupplyText(brandName);
      const ingredientMatches = normalizeSupplyText(supply.ingredientName) === normalizeSupplyText(ingredientName);
      const exactUnitMatch = normalizeUnitText(supply.unit) === normalizeUnitText(unit);
      const convertibleUnitMatch = Boolean(getConvertedQuantityForSupply(1, unit, supply));
      return brandMatches && ingredientMatches && (exactUnitMatch || convertibleUnitMatch);
    })
    .sort((a, b) => getSupplySortTime(b) - getSupplySortTime(a));
}

export function getMatchingPurchaseHistoryForIngredient(
  supplies: SupplyEntry[],
  ingredients: Ingredient[],
  ingredientReference: { ingredientId?: string; ingredientName: string },
  brandName: string,
  unit: string,
) {
  return getPurchaseHistoryForIngredientReference(ingredients, supplies, ingredientReference, { brandName })
    .filter((supply) => {
      if (!isValidSupplyForCosting(supply)) {
        return false;
      }
      const exactUnitMatch = normalizeUnitText(supply.unit) === normalizeUnitText(unit);
      const convertibleUnitMatch = Boolean(getConvertedQuantityForSupply(1, unit, supply));
      return exactUnitMatch || convertibleUnitMatch;
    });
}

export function getSupplyUsedCost(supply: SupplyEntry, quantityUsed: number, usedUnit = supply.unit) {
  const convertedQuantity = getConvertedQuantityForSupply(quantityUsed, usedUnit, supply);
  if (supply.packQuantity <= 0 || supply.totalCost <= 0 || convertedQuantity <= 0) {
    return 0;
  }

  return (supply.totalCost / supply.packQuantity) * convertedQuantity;
}

const volumeUnitMl: Record<string, number> = {
  cup: 240,
  cups: 240,
  tbsp: 15,
  tablespoon: 15,
  tablespoons: 15,
  tsp: 5,
  teaspoon: 5,
  teaspoons: 5,
};

const gramPerMlByIngredient: Array<{ keywords: string[]; gramPerMl: number }> = [
  { keywords: ["water", "milk", "coffee", "espresso", "cream"], gramPerMl: 1 },
  { keywords: ["oil"], gramPerMl: 0.92 },
  { keywords: ["honey", "syrup"], gramPerMl: 1.4 },
  { keywords: ["butter"], gramPerMl: 0.96 },
  { keywords: ["sugar"], gramPerMl: 0.85 },
  { keywords: ["flour"], gramPerMl: 0.53 },
  { keywords: ["cocoa", "cacao"], gramPerMl: 0.42 },
  { keywords: ["powder"], gramPerMl: 0.5 },
  { keywords: ["salt"], gramPerMl: 1.2 },
];

function getIngredientGramPerMl(ingredientName: string) {
  const normalizedIngredient = normalizeSupplyText(ingredientName);
  return gramPerMlByIngredient.find((entry) => entry.keywords.some((keyword) => normalizedIngredient.includes(keyword)))?.gramPerMl;
}

// Tries the shared, exact metric-family conversion (unit-conversion.ts's convertUnit -- the same
// implementation Bake/CSV-import/manual-purchase use) first. Only when that returns null -- a
// genuine mass<->volume case, like a cup of flour into grams -- falls back to this module's own
// density-based estimate. Never used for inventory mutation, Costing display only.
function computeConvertedQuantity(quantity: number, fromUnit: string, toUnit: string, ingredientName: string): { quantity: number; isEstimate: boolean } {
  if (!quantity) {
    return { quantity, isEstimate: false };
  }

  const exact = convertUnit(quantity, fromUnit, toUnit);
  if (exact !== null) {
    return { quantity: exact, isEstimate: false };
  }

  const normalizedFrom = normalizeUnitText(fromUnit);
  const normalizedTo = normalizeUnitText(toUnit);
  if (normalizedTo !== "g") {
    return { quantity: 0, isEstimate: false };
  }

  const ml = volumeUnitMl[normalizedFrom] ? quantity * volumeUnitMl[normalizedFrom] : 0;
  if (!ml) {
    return { quantity: 0, isEstimate: false };
  }

  const gramPerMl = getIngredientGramPerMl(ingredientName);
  return { quantity: gramPerMl ? ml * gramPerMl : 0, isEstimate: Boolean(gramPerMl) };
}

export function getConvertedQuantity(quantity: number, fromUnit: string, toUnit: string, ingredientName: string) {
  return computeConvertedQuantity(quantity, fromUnit, toUnit, ingredientName).quantity;
}

export function getConvertedQuantityForSupply(quantity: number, usedUnit: string, supply: SupplyEntry) {
  return getConvertedQuantity(quantity, usedUnit, supply.unit, supply.ingredientName);
}

export function getConversionLabel(quantity: number, fromUnit: string, supply: SupplyEntry) {
  const { quantity: convertedQuantity, isEstimate } = computeConvertedQuantity(quantity, fromUnit, supply.unit, supply.ingredientName);
  if (!convertedQuantity || normalizeUnitText(fromUnit) === normalizeUnitText(supply.unit)) {
    return "";
  }

  return `${quantity}${fromUnit} = ${convertedQuantity.toFixed(1)}${supply.unit}${isEstimate ? " estimate" : ""}`;
}

// A prefill, not a guess: only returns a brand when every existing supply record for this
// ingredient agrees on exactly one (ignoring blanks). Two or more distinct brands on record --
// this ingredient has genuinely been bought under different brands -- returns "" rather than
// picking one, the same "don't resolve an ambiguity, ask" rule used everywhere else purchase
// matching does (see resolveIngredientReference's "suggested" tier). No record at all for this
// ingredient also returns "".
//
// Matches on normalizeIngredientName, not the weaker normalizeSupplyText -- a manually-logged
// SupplyEntry.ingredientName commonly carries the same real-world variance a receipt does
// (trailing package size, stray punctuation), and this function's whole purpose is to feed
// ingredient-matching's brand-aware suggestion tier, so it needs to tolerate the same variance
// that tier already does.
//
// "Agrees on exactly one" is judged on normalizeBrandText (compact form), not the raw string --
// the same real-world brand commonly gets typed differently across separate manual purchase-log
// entries ("Vanhouten" one time, "Van Houten" another). Comparing raw strings would count those as
// two different brands and refuse to prefill even though they're the same brand; the fix is to
// group on the same normalized form findPartialMatch already uses, then return a real spelling
// (the most recent entry's, consistent with "most recent wins" elsewhere in this file) rather than
// the compacted key.
export function findReliableBrandForIngredient(ingredientName: string, supplies: SupplyEntry[]): string {
  const target = normalizeIngredientName(ingredientName);
  if (!target) {
    return "";
  }

  const matchingEntries = supplies.filter((entry) => normalizeIngredientName(entry.ingredientName) === target && entry.brandName.trim());
  const distinctNormalizedBrands = new Set(matchingEntries.map((entry) => normalizeBrandText(entry.brandName)));

  if (distinctNormalizedBrands.size !== 1) {
    return "";
  }

  const mostRecent = [...matchingEntries].sort((a, b) => getSupplySortTime(b) - getSupplySortTime(a))[0];
  return mostRecent.brandName.trim();
}

export function findReliableBrandForMatchedIngredient(ingredient: Ingredient, supplies: SupplyEntry[]): string {
  return findReliableBrandForItem(ingredient, supplies);
}

// Same "agrees on exactly one, else don't guess" rule as findReliableBrandForIngredient, applied to
// supplier instead of brand. Distinctness is judged on normalizeSupplyText (trim+lowercase), not
// normalizeBrandText's fully-compact form -- supplier names ("Main", "SM Supermarket") don't carry
// the multi-word compact-spelling variance brand names do, so the lighter normalization is enough.
export function findReliableSupplierForIngredient(ingredientName: string, supplies: SupplyEntry[]): string {
  const target = normalizeIngredientName(ingredientName);
  if (!target) {
    return "";
  }

  const matchingEntries = supplies.filter((entry) => normalizeIngredientName(entry.ingredientName) === target && entry.supplierName.trim());
  const distinctSuppliers = new Set(matchingEntries.map((entry) => normalizeSupplyText(entry.supplierName)));

  if (distinctSuppliers.size !== 1) {
    return "";
  }

  const mostRecent = [...matchingEntries].sort((a, b) => getSupplySortTime(b) - getSupplySortTime(a))[0];
  return mostRecent.supplierName.trim();
}

export function findReliableSupplierForMatchedIngredient(ingredient: Ingredient, supplies: SupplyEntry[]): string {
  return findReliableSupplierForItem(ingredient, supplies);
}

export function getSupplyLabel(supply: Pick<SupplyEntry, "brandName" | "ingredientName" | "unit">) {
  return `${supply.brandName ? `${supply.brandName} - ` : ""}${supply.ingredientName}${supply.unit ? ` (${supply.unit})` : ""}`;
}

// Manual overrides (isManualCost) always win -- auto-selection never touches a row the user has
// hand-edited. Otherwise, the most recent valid matching purchase (see getMatchingSupplies) is
// applied and recorded in supplierNote so it's visible which record was used.
export function getAutoCostedIngredientRow(row: CostingIngredientRow, supplies: SupplyEntry[]): CostingIngredientRow {
  return getAutoCostedIngredientRowForItems(row, supplies, []);
}

export function getAutoCostedIngredientRowForItems(row: CostingIngredientRow, supplies: SupplyEntry[], ingredients: Ingredient[]): CostingIngredientRow {
  if (row.isManualCost) {
    return row;
  }

  const supply = ingredients.length
    ? getMatchingPurchaseHistoryForIngredient(supplies, ingredients, { ingredientName: row.ingredientName }, row.brandName, row.unit)[0]
    : getMatchingSupplies(supplies, row.brandName, row.ingredientName, row.unit)[0];
  if (!supply) {
    return row;
  }

  const unitCost = supply.packQuantity > 0 ? supply.totalCost / supply.packQuantity : 0;

  return {
    ...row,
    brandName: supply.brandName,
    cost: Number(getSupplyUsedCost(supply, row.quantityUsed, row.unit).toFixed(2)),
    ingredientName: supply.ingredientName,
    supplierNote: [supply.supplierName, supply.purchaseDate, `PHP ${unitCost.toFixed(2)}/${supply.unit || "unit"}`, `quality ${supply.qualityRating || 0}/5`, getConversionLabel(row.quantityUsed, row.unit, supply)].filter(Boolean).join(" / "),
  };
}
