import type { Ingredient } from "./product-lab-types";

export function getInventoryValue(ingredient: Pick<Ingredient, "currentQuantity" | "averageUnitCost">) {
  return ingredient.currentQuantity * (ingredient.averageUnitCost || 0);
}

export function getTotalInventoryValue(ingredients: Ingredient[]) {
  return ingredients.reduce((total, ingredient) => total + getInventoryValue(ingredient), 0);
}

// Cost trust: the single source of truth for "is this ingredient's current cost safe to use",
// mirroring confirm_bake_v3's own server-side guard exactly (see that function's comment). A
// non-null, positive averageUnitCost is not evidence on its own -- costReconciledAt is the only
// signal that distinguishes a trusted cost from one that is merely present. Cost trust is now
// established automatically by a normal priced purchase (Cost System Simplification V4); this
// stays the one place that reads the resulting fact, so every caller (Bake's precheck, the
// Inventory list, the stock-value display) agrees with the database without duplicating its logic.
export function isCostBaselineUncertified(ingredient: Pick<Ingredient, "costReconciledAt" | "averageUnitCost">) {
  return !ingredient.costReconciledAt || !ingredient.averageUnitCost || ingredient.averageUnitCost <= 0;
}

// Opening Cost Setup is the exceptional, human-facing case: legacy stock recorded before reliable
// cost tracking. It is only ever asked for when there IS stock to account for -- a zero (or
// negative, unresolved-history) Item never nags, because the very next priced purchase can
// establish trust automatically with no owner action (see the V4 migration's rule B). Only the
// Inventory list and its "Cost setup" summary use this; the Bake guard still uses
// isCostBaselineUncertified directly, since Bake must refuse an untrusted cost regardless of why.
export function needsOpeningCostSetup(ingredient: Pick<Ingredient, "costReconciledAt" | "averageUnitCost" | "currentQuantity">) {
  return ingredient.currentQuantity > 0 && isCostBaselineUncertified(ingredient);
}

// Real weighted average, not "latest purchase wins": new_average = (current_qty * current_avg +
// added_qty * added_unit_cost) / (current_qty + added_qty). Quantity added without a known price
// (a CSV row with no total_price) is valued at the current average, so it shifts the total
// quantity without skewing the cost either direction.
export function computeWeightedAverageUnitCost(
  currentQuantity: number,
  currentAverageUnitCost: number,
  addedQuantityWithPrice: number,
  addedCostWithPrice: number,
  addedQuantityWithoutPrice: number,
) {
  const totalQuantity = currentQuantity + addedQuantityWithPrice + addedQuantityWithoutPrice;
  if (totalQuantity <= 0) {
    return currentAverageUnitCost;
  }

  const totalCost = currentQuantity * currentAverageUnitCost + addedCostWithPrice + addedQuantityWithoutPrice * currentAverageUnitCost;

  return totalCost / totalQuantity;
}

// What the Manage Items "Stock value" cell may honestly show. Value = current quantity x average
// unit cost, but that cost is only trustworthy once trusted (see isCostBaselineUncertified) -- so
// an untrusted Item never presents a derived monetary total as if it were authoritative. The
// recorded (untrusted) cost can still be shown separately, labeled as such, as "Cost basis".
export type StockValueDisplay = { kind: "setup-needed" } | { kind: "value"; amount: number; quantity: number; unitCost: number };

export function getStockValueDisplay(ingredient: Pick<Ingredient, "currentQuantity" | "averageUnitCost" | "costReconciledAt">): StockValueDisplay {
  if (isCostBaselineUncertified(ingredient)) {
    return { kind: "setup-needed" };
  }
  return { kind: "value", amount: getInventoryValue(ingredient), quantity: ingredient.currentQuantity, unitCost: ingredient.averageUnitCost };
}
