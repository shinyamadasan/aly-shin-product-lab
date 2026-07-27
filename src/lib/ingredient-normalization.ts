// Strips common package-size fragments ("1L", "500 g", "2kg") so "Fresh Milk 1L" and "Fresh
// Milk" normalize to the same text -- receipts commonly bake the pack size into the item name.
const PACKAGE_SIZE_PATTERN = /\b\d+(\.\d+)?\s*(g|grams?|kg|kilograms?|ml|milliliters?|millilitres?|l|liters?|litres?|pcs?|pieces?|packs?|bags?)\b/gi;

export function normalizeIngredientName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(PACKAGE_SIZE_PATTERN, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Compact form for brand comparison only: everything normalizeIngredientName strips, PLUS every
// remaining space, so multi-word and single-word spellings of the same brand collapse to one
// string ("Van Houten" and "Vanhouten" both -> "vanhouten"; "Beryl's" and "Beryls" both ->
// "beryls"). Never used for general product-name matching -- collapsing spaces there would let
// unrelated multi-word products collide.
export function normalizeBrandText(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Most canonical forms match IngredientBaseUnit exactly ("g" | "kg" | "ml" | "L" | "pcs") so
// unit-conversion.ts can compare normalized units directly against an ingredient's base unit.
// tbsp/tsp/cup are the exception: they're recipe-measure units, never a base unit themselves, but
// still need one consistent lowercase spelling so unit-conversion.ts's METRIC_FAMILY_FACTORS
// lookup (keyed on these exact strings) doesn't miss a match over "Tbsp" vs "tbsp" casing.
const UNIT_CANONICAL: Record<string, string> = {
  g: "g",
  gram: "g",
  grams: "g",
  kg: "kg",
  kilogram: "kg",
  kilograms: "kg",
  ml: "ml",
  milliliter: "ml",
  milliliters: "ml",
  millilitre: "ml",
  millilitres: "ml",
  l: "L",
  liter: "L",
  liters: "L",
  litre: "L",
  litres: "L",
  pcs: "pcs",
  pc: "pcs",
  piece: "pcs",
  pieces: "pcs",
  each: "pcs",
  ea: "pcs",
  tbsp: "tbsp",
  tablespoon: "tbsp",
  tablespoons: "tbsp",
  tsp: "tsp",
  teaspoon: "tsp",
  teaspoons: "tsp",
  cup: "cup",
  cups: "cup",
};

export function normalizeUnitText(raw: string): string {
  const key = raw.trim().toLowerCase();
  return UNIT_CANONICAL[key] ?? raw.trim();
}
