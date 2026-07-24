// Strips common package-size fragments ("1L", "500 g", "2kg") so "Fresh Milk 1L" and "Fresh
// Milk" normalize to the same text -- receipts commonly bake the pack size into the item name.
const PACKAGE_SIZE_PATTERN = /\b\d+(\.\d+)?\s*(g|grams?|kg|kilograms?|ml|milliliters?|millilitres?|l|liters?|litres?|pcs?|pieces?|packs?)\b/gi;

export function normalizeIngredientName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(PACKAGE_SIZE_PATTERN, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Canonical forms match IngredientBaseUnit exactly ("g" | "kg" | "ml" | "L" | "pcs") so
// unit-conversion.ts can compare normalized units directly against an ingredient's base unit.
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
};

export function normalizeUnitText(raw: string): string {
  const key = raw.trim().toLowerCase();
  return UNIT_CANONICAL[key] ?? raw.trim();
}
