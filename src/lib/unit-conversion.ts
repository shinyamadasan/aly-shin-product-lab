import type { CanonicalUnit, Ingredient } from "./product-lab-types";
import { CANONICAL_UNITS } from "./product-lab-types.ts";
import { normalizeUnitText } from "./ingredient-normalization.ts";

// Deliberately narrow: same-unit identity, the two fixed metric-family conversions (g<->kg,
// ml<->L), and tbsp/tsp/cup -> ml/L -- all fixed, unambiguous ratios (1 tbsp = 15ml, 1 tsp = 5ml,
// 1 cup = 240ml; the same constants supplies.ts already uses for Costing's own conversions).
// Nothing else -- specifically no volume-to-mass conversion (tbsp/tsp/cup into a g/kg-based
// ingredient), since that requires guessing the ingredient's density, and no saved per-ingredient
// package conversions (that's a later milestone, and even then only for units explicitly saved on
// the ingredient). A unit outside this set returns null, which the caller must treat as "needs a
// manual fix", never a guess. Canonical unit strings are spelled out via CANONICAL_UNITS, not
// repeated as bare literals -- kg/L stay literal since they're legacy input units, not canonical.
const METRIC_FAMILY_FACTORS: Record<string, Partial<Record<string, number>>> = {
  [CANONICAL_UNITS.mass]: { kg: 0.001 },
  kg: { [CANONICAL_UNITS.mass]: 1000 },
  [CANONICAL_UNITS.volume]: { L: 0.001 },
  L: { [CANONICAL_UNITS.volume]: 1000 },
  tbsp: { [CANONICAL_UNITS.volume]: 15, L: 0.015 },
  tsp: { [CANONICAL_UNITS.volume]: 5, L: 0.005 },
  cup: { [CANONICAL_UNITS.volume]: 240, L: 0.24 },
};

// The general two-unit conversion primitive every inventory-mutation path and Costing's own
// matching share -- convertToBaseUnit below is a thin wrapper over this for the common
// "convert into an ingredient's own unit" case. Symmetric for every metric-family pair (kg<->g,
// L<->ml round-trip exactly); tbsp/tsp/cup are deliberately one-directional (they convert into
// ml/L for purchase/recipe entry, but there's no product need to convert a canonical amount back
// into "cups" for display, so no reverse factor is defined for them).
export function convertUnit(quantity: number, fromUnit: string, toUnit: string): number | null {
  if (!Number.isFinite(quantity)) {
    return null;
  }

  const normalizedFrom = normalizeUnitText(fromUnit);
  const normalizedTo = normalizeUnitText(toUnit);

  if (normalizedFrom === normalizedTo) {
    return quantity;
  }

  const factor = METRIC_FAMILY_FACTORS[normalizedFrom]?.[normalizedTo];
  return factor === undefined ? null : quantity * factor;
}

export function convertToBaseUnit(quantity: number, fromUnit: string, ingredient: Pick<Ingredient, "baseUnit">): number | null {
  return convertUnit(quantity, fromUnit, ingredient.baseUnit);
}

const MEASUREMENT_FAMILY_BY_CANONICAL_UNIT: Record<CanonicalUnit, "mass" | "volume" | "count"> = {
  [CANONICAL_UNITS.mass]: "mass",
  [CANONICAL_UNITS.volume]: "volume",
  [CANONICAL_UNITS.count]: "count",
};

// Mass, volume, or count -- the family an ingredient's canonical unit belongs to. Purely a
// derived label (never stored on the ingredient itself) since CANONICAL_UNITS already fixes a 1:1
// mapping; used to relabel the ingredient form's unit picker as "Measurement type" instead of
// exposing raw unit strings.
export function getMeasurementFamily(baseUnit: CanonicalUnit): "mass" | "volume" | "count" {
  return MEASUREMENT_FAMILY_BY_CANONICAL_UNIT[baseUnit];
}

// A sensible canonical-unit guess for a raw purchase/receipt unit that doesn't match an existing
// ingredient -- used only to prefill the "Create New Item" base-unit picker, never to silently
// apply a conversion. Falls back to CANONICAL_UNITS.mass (matching this app's existing default of
// "g" for a from-scratch ingredient) for anything unrecognized, like "box" or "pack".
export function guessCanonicalUnit(rawUnit: string): CanonicalUnit {
  const normalized = normalizeUnitText(rawUnit);
  if (normalized === "kg" || normalized === CANONICAL_UNITS.mass) {
    return CANONICAL_UNITS.mass;
  }
  if (normalized === "L" || normalized === "tbsp" || normalized === "tsp" || normalized === "cup" || normalized === CANONICAL_UNITS.volume) {
    return CANONICAL_UNITS.volume;
  }
  if (normalized === CANONICAL_UNITS.count) {
    return CANONICAL_UNITS.count;
  }
  return CANONICAL_UNITS.mass;
}
