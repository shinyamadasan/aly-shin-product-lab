import type { CostingSummary } from "./product-lab-types";

export type CostingMetrics = {
  costPerPiece: number | null;
  grossProfit: number | null;
  margin: number | null;
  foodCostPercent: number | null;
  markup: number | null;
  targetPrice: number | null;
  variableCostPerPiece: number | null;
  contributionMarginPerPiece: number | null;
  breakEvenUnits: number | null;
};

const unavailableMetrics: CostingMetrics = {
  costPerPiece: null,
  grossProfit: null,
  margin: null,
  foodCostPercent: null,
  markup: null,
  targetPrice: null,
  variableCostPerPiece: null,
  contributionMarginPerPiece: null,
  breakEvenUnits: null,
};

// Single source of truth for every yield-dependent costing number. Yield missing or <= 0 means
// cost per unit is unknown, not zero and not the whole batch cost -- so every dependent metric
// here must return null (never a numeric fallback) so all consumers show "Need yield" the same way.
export function getCostingMetrics({
  costingYield,
  directCost,
  indirectCost,
  suggestedPrice,
  targetFoodCost,
  totalBatchCost,
}: {
  costingYield: number;
  directCost: number;
  indirectCost: number;
  suggestedPrice: number;
  targetFoodCost: number;
  totalBatchCost: number;
}): CostingMetrics {
  if (!(costingYield > 0)) {
    return unavailableMetrics;
  }

  const costPerPiece = totalBatchCost / costingYield;
  const grossProfit = suggestedPrice - costPerPiece;
  const margin = suggestedPrice > 0 ? (grossProfit / suggestedPrice) * 100 : 0;
  const foodCostPercent = suggestedPrice > 0 ? (costPerPiece / suggestedPrice) * 100 : 0;
  const markup = costPerPiece > 0 ? ((suggestedPrice - costPerPiece) / costPerPiece) * 100 : 0;
  const targetPrice = targetFoodCost > 0 ? costPerPiece / targetFoodCost : 0;
  const variableCostPerPiece = directCost / costingYield;
  const contributionMarginPerPiece = suggestedPrice - variableCostPerPiece;
  const breakEvenUnits = contributionMarginPerPiece > 0 ? Math.ceil(indirectCost / contributionMarginPerPiece) : 0;

  return { costPerPiece, grossProfit, margin, foodCostPercent, markup, targetPrice, variableCostPerPiece, contributionMarginPerPiece, breakEvenUnits };
}

// One place that turns a possibly-null metric into display text, so Costing, Product Detail,
// print, and CSV all say the same thing ("Need yield") instead of drifting into their own wording.
export function formatCostingMetric(value: number | null, format: (value: number) => string, unavailableLabel = "Need yield") {
  return value === null ? unavailableLabel : format(value);
}

// Reads just the one field the Rule Engine and getCostingTotals need from the "Professional
// costing detail" JSON blob in costing.notes, without depending on the full structured-detail
// shape (CostingLaborDetail, CostingGasDetail, etc.) that only src/app/product-lab.tsx's form
// needs -- keeps this module free of any dependency on the page file.
function getTargetFoodCostFromNotes(notes: string): number {
  const rawJson = notes.match(/^Professional costing detail: (.+)$/m)?.[1];
  if (!rawJson) {
    return 0;
  }

  try {
    const parsed = JSON.parse(rawJson) as { targetFoodCost?: number };
    return Number(parsed.targetFoodCost ?? 0);
  } catch {
    return 0;
  }
}

export function getCostingTotals(costing: CostingSummary) {
  const utilityTotal = costing.waterCost + costing.gasCost + costing.ovenElectricCost + costing.refrigerationCost + costing.coffeeEquipmentCost;
  const directCost = costing.ingredientCost + costing.packagingCost + costing.laborEstimate + utilityTotal + costing.wasteAllowance;
  const indirectCost = costing.overheadCost + costing.equipmentCost;
  const totalBatchCost = directCost + indirectCost;
  const costingYield = Number(costing.notes.match(/^Costing yield: ([\d.]+)/m)?.[1] ?? 0);
  const targetFoodCost = getTargetFoodCostFromNotes(costing.notes);
  const metrics = getCostingMetrics({ costingYield, directCost, indirectCost, suggestedPrice: costing.suggestedPrice, targetFoodCost, totalBatchCost });

  return { ...metrics, costingYield, directCost, indirectCost, targetFoodCost, totalBatchCost, utilityTotal };
}
