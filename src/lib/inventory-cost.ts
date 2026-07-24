import type { Ingredient } from "./product-lab-types";

export function getInventoryValue(ingredient: Pick<Ingredient, "currentQuantity" | "averageUnitCost">) {
  return ingredient.currentQuantity * (ingredient.averageUnitCost || 0);
}

export function getTotalInventoryValue(ingredients: Ingredient[]) {
  return ingredients.reduce((total, ingredient) => total + getInventoryValue(ingredient), 0);
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
