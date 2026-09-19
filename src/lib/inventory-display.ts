import type { SupplyEntry } from "./product-lab-types.ts";

// Display-only helpers for the money and dates shown next to purchases and Item cost. Nothing here
// changes a stored value -- in particular a purchase's total is always the stored totalCost, never
// re-derived from a rounded unit price.

// "PHP 19", "PHP 19.5", "PHP 19.05": at least the digits the amount needs, at most `maxDecimals`.
function trimmedPesos(amount: number, maxDecimals: number): string {
  const rounded = Number(amount.toFixed(maxDecimals));
  const text = String(rounded);
  const decimals = text.includes(".") ? text.split(".")[1].length : 0;
  return rounded.toFixed(Math.max(2, decimals));
}

export function formatPesos(amount: number): string {
  return Number.isFinite(amount) ? `PHP ${trimmedPesos(amount, 2)}` : "PHP --";
}

// Per-unit prices need more precision than a total ("PHP 0.38/g", "PHP 0.2714/g"), but never
// noise: up to 4 decimals, trailing zeroes past the second dropped.
export function formatPesosPerUnit(unitCost: number, unit: string): string {
  return Number.isFinite(unitCost) ? `PHP ${trimmedPesos(unitCost, 4)}${unit ? `/${unit}` : ""}` : "PHP --";
}

// "Sep 17" (or "Sep 17, 2026"). Date-only ISO strings are read as UTC and shown in UTC so a purchase
// dated the 17th never displays as the 16th. Empty/unparseable input returns "" (caller decides).
export function formatPurchaseDate(isoDate: string, options: { year?: boolean } = {}): string {
  const time = isoDate ? Date.parse(isoDate) : NaN;
  if (Number.isNaN(time)) {
    return "";
  }
  return new Date(time).toLocaleDateString("en-US", { month: "short", day: "numeric", ...(options.year ? { year: "numeric" } : {}), timeZone: "UTC" });
}

export type LatestPurchaseFacts = {
  brand: string;
  supplier: string;
  date: string;
  packQuantity: number;
  unit: string;
  // The amount actually paid, exactly as stored on the purchase.
  totalPaid: number;
  // totalPaid / packQuantity when the pack size is known, otherwise null.
  unitCost: number | null;
};

export function getLatestPurchaseFacts(purchase: SupplyEntry): LatestPurchaseFacts {
  return {
    brand: purchase.brandName.trim(),
    supplier: purchase.supplierName.trim(),
    date: purchase.purchaseDate,
    packQuantity: purchase.packQuantity,
    unit: purchase.unit.trim(),
    totalPaid: purchase.totalCost,
    unitCost: purchase.packQuantity > 0 ? purchase.totalCost / purchase.packQuantity : null,
  };
}
