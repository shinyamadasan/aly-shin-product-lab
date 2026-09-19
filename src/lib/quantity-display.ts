import { convertUnit } from "./unit-conversion.ts";
import { normalizeUnitText } from "./ingredient-normalization.ts";

// Human-facing text for an inventory quantity. DISPLAY ONLY: it reads a number and a unit and
// returns a string; it never changes a stored quantity, a base unit, a deduction, or an RPC payload.
//
// The unit is chosen for readability, using this app's own fixed conversions (convertUnit) -- no
// separate conversion factors live here:
//   mass    (g, kg)              -> g below 1000 g, otherwise kg     0.0047 kg -> 4.7 g, 0.8953 kg -> 895.3 g, 1.2 kg -> 1.2 kg
//   volume  (ml, L, tbsp, ...)   -> ml below 1000 ml, otherwise L    0.25 L -> 250 ml, 1.5 L -> 1.5 L
//   anything else (pcs, "box")   -> shown as given
//
// Precision adapts to size and trailing zeroes are dropped. A non-zero quantity is never shown as
// zero: values under 1 keep two significant digits (0.0004 g stays "0.0004 g", not "0 g").
const LARGE_UNIT_THRESHOLD = 1000;

function trimmedNumber(value: number, decimals: number): string {
  return String(Number(value.toFixed(decimals)));
}

// Decimals to keep for a non-negative number, so the result is short but never rounds a non-zero
// value to zero. `wholeDecimals` applies to values of at least 1.
function decimalsFor(absValue: number, wholeDecimals: number): number {
  if (absValue >= 1 || absValue === 0) {
    return wholeDecimals;
  }
  // 2 significant digits: 0.0047 -> 4 decimals, 0.25 -> 2 decimals.
  return Math.min(8, wholeDecimals + Math.ceil(-Math.log10(absValue)));
}

function formatNumber(value: number, wholeDecimals: number): string {
  const abs = Math.abs(value);
  const text = trimmedNumber(abs, decimalsFor(abs, wholeDecimals));
  return value < 0 && Number(text) !== 0 ? `-${text}` : text;
}

export function formatQuantity(quantity: number, unit: string): string {
  if (!Number.isFinite(quantity)) {
    return "--";
  }
  const label = normalizeUnitText(unit);

  const grams = convertUnit(quantity, label, "g");
  if (grams !== null) {
    return Math.abs(grams) >= LARGE_UNIT_THRESHOLD ? `${formatNumber(grams / LARGE_UNIT_THRESHOLD, 3)} kg` : `${formatNumber(grams, 2)} g`;
  }
  const millilitres = convertUnit(quantity, label, "ml");
  if (millilitres !== null) {
    return Math.abs(millilitres) >= LARGE_UNIT_THRESHOLD ? `${formatNumber(millilitres / LARGE_UNIT_THRESHOLD, 3)} L` : `${formatNumber(millilitres, 2)} ml`;
  }
  return `${formatNumber(quantity, 2)}${label ? ` ${label}` : ""}`;
}
