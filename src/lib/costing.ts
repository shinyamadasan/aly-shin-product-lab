import type { CostingSummary, ProductBatch } from "./product-lab-types";

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

export type CostingConflictCandidate = {
  costingId: string;
  productId: string;
  batchId: string;
};

// Costings have no free-text name -- the invariant this guards is record identity: one costing
// per batch, or (for legacy costings saved before batch-scoping existed) one unlinked costing per
// product. candidate.costingId excludes the record being saved from its own conflict check, so
// editing a costing without changing its product/batch always stays valid.
export function findConflictingCosting(costings: CostingSummary[], candidate: CostingConflictCandidate): CostingSummary | null {
  return (
    costings.find((entry) => {
      if (entry.id === candidate.costingId) {
        return false;
      }
      return candidate.batchId ? entry.batchId === candidate.batchId : entry.productId === candidate.productId && !entry.batchId;
    }) ?? null
  );
}

// CostingForm's batch picker derives productId from whichever batch is selected, so a mismatch
// shouldn't occur through normal use -- but saveCosting reads both values straight off FormData
// without cross-checking them, and findConflictingCosting's unlinked-costing bucket above depends
// on batchId genuinely belonging to productId. Empty batchId is the legitimate "unlinked legacy
// costing" case, not a mismatch.
export function isBatchProductMismatch(batches: ProductBatch[], candidate: { productId: string; batchId: string }): boolean {
  if (!candidate.batchId) {
    return false;
  }
  const batch = batches.find((item) => item.id === candidate.batchId);
  return !batch || batch.productId !== candidate.productId;
}

// The one place a costing's id is decided when saving -- called once per saveCosting invocation
// and threaded through the in-memory costing object, the Supabase payload (buildCostingSummaryPayload
// below), and any Selling Formats saved alongside it, so all three can never disagree. Editing (a
// non-empty costingId) always returns that exact id, never a freshly generated one -- only a
// brand-new costing gets a new id, generated once per save.
export function resolveCostingId(costingId: string): string {
  return costingId || crypto.randomUUID();
}

// The exact snake_case shape written to costing_summaries on both insert and update. Extracted so
// it's one tested place, not two inline object literals that could quietly drift apart -- and so
// costing.id (see resolveCostingId) is never silently dropped from the row actually written to
// Supabase the way it previously was.
export function buildCostingSummaryPayload(costing: CostingSummary) {
  return {
    id: costing.id,
    product_id: costing.productId,
    batch_id: costing.batchId || null,
    ingredient_cost: costing.ingredientCost,
    packaging_cost: costing.packagingCost,
    labor_estimate: costing.laborEstimate,
    utilities_estimate: costing.waterCost + costing.gasCost + costing.ovenElectricCost + costing.refrigerationCost + costing.coffeeEquipmentCost,
    waste_allowance: costing.wasteAllowance,
    overhead_cost: costing.overheadCost,
    equipment_cost: costing.equipmentCost,
    suggested_price: costing.suggestedPrice,
    notes: costing.notes,
  };
}
