import type { FinishedStockExceptionType, FinishedStockMovement, Ingredient, ProductionExecution, StockAdjustmentReason } from "./product-lab-types.ts";
import { isCostBaselineUncertified } from "./inventory-cost.ts";
import { convertToBaseUnit } from "./unit-conversion.ts";
import { roundToCentavo } from "./finance/peso.ts";
import { POSTGREST_ROW_CAP } from "./finance/report.ts";

export function finishedStockEffectLabel(reason: FinishedStockExceptionType): string {
  return reason === "damage" ? "Operating loss" : reason === "giveaway" ? "Marketing expense"
    : reason === "household" ? "Household withdrawal (outside operating profit)" : "Unclassified — review in Finance";
}

export function rawStockEffectLabel(reason: StockAdjustmentReason, direction: "increase" | "decrease"): string {
  if (direction === "increase") return "Unclassified addition — review in Finance";
  return reason === "household_use" ? "Household withdrawal (outside operating profit)"
    : reason === "recipe_testing" ? "Business testing cost"
    : reason === "waste_or_spoilage" || reason === "spillage" ? "Operating loss" : "Unclassified — review in Finance";
}

export function previewRawStockLoss(ingredient: Ingredient, quantity: number, unit: string, direction: "increase" | "decrease"): number | null {
  const converted = convertToBaseUnit(quantity, unit, ingredient);
  if (direction !== "decrease" || !Number.isFinite(quantity) || quantity <= 0 || converted === null
      || converted > ingredient.currentQuantity || isCostBaselineUncertified(ingredient)
      || !Number.isFinite(ingredient.averageUnitCost)) return null;
  return roundToCentavo(converted * ingredient.averageUnitCost!);
}

// Advisory only. The existing database writer repeats allocation under its product/lot locks.
export function previewFinishedStockLoss(
  productId: string, quantity: number, lots: ProductionExecution[], movements: FinishedStockMovement[],
): { amount: number | null; estimated: boolean } {
  if (!Number.isInteger(quantity) || quantity < 1 || lots.length >= POSTGREST_ROW_CAP || movements.length >= POSTGREST_ROW_CAP) return { amount: null, estimated: false };
  let remaining = quantity;
  let amount = 0;
  let estimated = false;
  let complete = true;
  const balances = new Map<string, number>();
  for (const movement of movements) {
    if (movement.productId !== productId || !movement.productionExecutionId) continue;
    const id = movement.productionExecutionId;
    balances.set(id, (balances.get(id) ?? 0) + movement.onHandDelta - movement.reservedDelta);
  }
  for (const lot of lots.filter((lot) => lot.productId === productId)
    .sort((a, b) => a.completedAt.localeCompare(b.completedAt) || a.id.localeCompare(b.id))) {
    if (remaining === 0) break;
    const take = Math.min(remaining, Math.max(0, balances.get(lot.id) ?? 0));
    if (take === 0) continue;
    if (!Number.isFinite(lot.frozenCostPerPiece) || lot.frozenCostPerPiece <= 0) complete = false;
    else amount += take * lot.frozenCostPerPiece;
    estimated ||= lot.costBasisSource === "historical_estimate";
    remaining -= take;
  }
  return { amount: remaining === 0 && complete ? roundToCentavo(amount) : null, estimated };
}
