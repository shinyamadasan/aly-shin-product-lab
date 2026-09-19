import type { Ingredient } from "./product-lab-types";

export function getInventoryValue(ingredient: Pick<Ingredient, "currentQuantity" | "averageUnitCost">) {
  return ingredient.currentQuantity * (ingredient.averageUnitCost || 0);
}

export function getTotalInventoryValue(ingredients: Ingredient[]) {
  return ingredients.reduce((total, ingredient) => total + getInventoryValue(ingredient), 0);
}

// Cost Baseline Repair: the single source of truth for "does this ingredient's cost still need a
// one-time verification", mirroring confirm_bake_v3's own server-side guard exactly (see that
// function's comment). A non-null, positive averageUnitCost is not evidence on its own --
// costReconciledAt is the only signal that distinguishes "certified" from "present but never
// verified". Was previously duplicated with small drift across the Stock table, Ingredient Master
// row, and both Bake prechecks; now every one of those reads this instead.
export function isCostBaselineUncertified(ingredient: Pick<Ingredient, "costReconciledAt" | "averageUnitCost">) {
  return !ingredient.costReconciledAt || !ingredient.averageUnitCost || ingredient.averageUnitCost <= 0;
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
