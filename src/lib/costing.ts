import type { CostingSummary } from "./product-lab-types";

export function getCostingTotals(costing: CostingSummary) {
  const utilityTotal = costing.waterCost + costing.gasCost + costing.ovenElectricCost + costing.refrigerationCost + costing.coffeeEquipmentCost;
  const totalBatchCost = costing.ingredientCost + costing.packagingCost + costing.laborEstimate + utilityTotal + costing.wasteAllowance;
  const grossProfit = costing.suggestedPrice - totalBatchCost;
  const margin = costing.suggestedPrice > 0 ? (grossProfit / costing.suggestedPrice) * 100 : 0;

  return { grossProfit, margin, totalBatchCost, utilityTotal };
}
