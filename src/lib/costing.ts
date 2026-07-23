import type { CostingSummary } from "./product-lab-types";

export function getCostingTotals(costing: CostingSummary) {
  const utilityTotal = costing.waterCost + costing.gasCost + costing.ovenElectricCost + costing.refrigerationCost + costing.coffeeEquipmentCost;
  const totalBatchCost = costing.ingredientCost + costing.packagingCost + costing.laborEstimate + utilityTotal + costing.wasteAllowance + costing.overheadCost + costing.equipmentCost;
  const costingYield = Number(costing.notes.match(/^Costing yield: ([\d.]+)/m)?.[1] ?? 0);
  const costPerPiece = costingYield > 0 ? totalBatchCost / costingYield : totalBatchCost;
  const grossProfit = costing.suggestedPrice - costPerPiece;
  const margin = costing.suggestedPrice > 0 ? (grossProfit / costing.suggestedPrice) * 100 : 0;
  const foodCostPercent = costing.suggestedPrice > 0 ? (costPerPiece / costing.suggestedPrice) * 100 : 0;

  return { costPerPiece, foodCostPercent, grossProfit, margin, totalBatchCost, utilityTotal };
}
