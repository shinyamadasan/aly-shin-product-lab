import type { Ingredient } from "./product-lab-types";
import { normalizeUnitText } from "./ingredient-normalization.ts";

// Deliberately narrow: same-unit identity, or the two fixed metric-family conversions (g<->kg,
// ml<->L). Nothing else -- no density guessing, no saved per-ingredient package conversions
// (that's a later milestone, and even then only for units explicitly saved on the ingredient).
// A unit outside this set returns null, which the caller must treat as "needs a manual fix",
// never a guess.
const METRIC_FAMILY_FACTORS: Record<string, Partial<Record<string, number>>> = {
  g: { kg: 0.001 },
  kg: { g: 1000 },
  ml: { L: 0.001 },
  L: { ml: 1000 },
};

export function convertToBaseUnit(quantity: number, fromUnit: string, ingredient: Pick<Ingredient, "baseUnit">): number | null {
  if (!Number.isFinite(quantity)) {
    return null;
  }

  const normalizedFrom = normalizeUnitText(fromUnit);
  const baseUnit = ingredient.baseUnit;

  if (normalizedFrom === baseUnit) {
    return quantity;
  }

  const factor = METRIC_FAMILY_FACTORS[normalizedFrom]?.[baseUnit];
  return factor === undefined ? null : quantity * factor;
}
