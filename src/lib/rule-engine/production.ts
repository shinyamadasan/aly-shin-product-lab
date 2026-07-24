import { getCostingTotals } from "../costing.ts";
import type { Product, ProductBatch } from "../product-lab-types.ts";
import { getLatestBatch, getLinkedCosting, getProductBatches, insufficientDataResult, type RuleEngineContext, type RuleResult } from "./types.ts";

const CATEGORY = "production" as const;

// PROD-001: yield entered. The same check FIN-001 depends on, exposed as its own production
// rule too since yield is fundamentally a production fact (batch output), not a financial one.
function evaluateYieldEntered(context: RuleEngineContext, product: Product, latestBatch: ProductBatch | undefined): RuleResult {
  const costing = getLinkedCosting(context, product, latestBatch);
  if (!costing) {
    return insufficientDataResult("PROD-001", CATEGORY, "blocker", "No saved costing exists yet, so yield hasn't been entered anywhere.", "Save a costing with a yield on the Costing page.");
  }

  const costingYield = getCostingTotals(costing).costingYield;
  const passed = costingYield > 0;
  return {
    id: "PROD-001",
    category: CATEGORY,
    severity: "blocker",
    passed,
    message: passed ? `Yield is set to ${costingYield} pieces.` : "No yield set for this costing.",
    recommendation: passed ? "No action needed." : "Enter the batch yield (sellable pieces) this costing is based on.",
  };
}

// PROD-002: yield consistency across batch history. A single batch's yield is noisy; needs 3+
// logged batches with real yield before judging repeatability.
function evaluateYieldConsistency(productBatches: ProductBatch[]): RuleResult {
  const recent = productBatches.slice(0, 3);
  if (recent.length < 3) {
    return insufficientDataResult("PROD-002", CATEGORY, "warning", `Only ${recent.length} batch(es) logged -- not enough history to judge yield consistency.`, "Log more proof batches for this product.");
  }

  const yields = recent.map((batch) => batch.usablePieces).filter((value) => value > 0);
  if (yields.length < 3) {
    return insufficientDataResult("PROD-002", CATEGORY, "warning", "One or more of the last 3 batches has no yield logged.", "Log usable pieces for every batch.");
  }

  const max = Math.max(...yields);
  const min = Math.max(0, Math.min(...yields));
  const mean = yields.reduce((total, value) => total + value, 0) / yields.length;
  const variancePercent = mean > 0 ? ((max - min) / mean) * 100 : 0;
  const passed = variancePercent <= 15;
  return {
    id: "PROD-002",
    category: CATEGORY,
    severity: "warning",
    passed,
    message: `Yield ranged from ${min} to ${max} pieces across the last ${yields.length} batches (${variancePercent.toFixed(0)}% variance).`,
    recommendation: passed ? "No action needed." : "Identify what changed between the highest- and lowest-yield batches before trusting this product's costing yield as representative.",
  };
}

// PROD-003: waste tracking. Compares the costing's waste allowance against the real historical
// reject rate (imperfectPieces / total pieces) across logged batches, as a % of ingredient cost.
function evaluateWasteTracking(context: RuleEngineContext, product: Product, productBatches: ProductBatch[]): RuleResult {
  const batchesWithOutput = productBatches.filter((batch) => batch.usablePieces + batch.imperfectPieces > 0);
  if (batchesWithOutput.length === 0) {
    return insufficientDataResult("PROD-003", CATEGORY, "info", "No batch output logged yet to compare waste allowance against.", "Log usable and imperfect pieces per batch.");
  }

  const costing = getLinkedCosting(context, product, productBatches[0]);
  if (!costing || !(costing.ingredientCost > 0)) {
    return insufficientDataResult("PROD-003", CATEGORY, "info", "No saved costing with ingredient cost exists to compare against reject history.", "Save a costing first.");
  }

  const historicalRejectRate = batchesWithOutput.reduce((total, batch) => total + batch.imperfectPieces / (batch.usablePieces + batch.imperfectPieces), 0) / batchesWithOutput.length;
  const wasteAsPercentOfIngredient = costing.wasteAllowance / costing.ingredientCost;
  const delta = Math.abs(wasteAsPercentOfIngredient - historicalRejectRate);
  const passed = delta <= 0.1;
  return {
    id: "PROD-003",
    category: CATEGORY,
    severity: "info",
    passed,
    message: `Waste allowance is ${(wasteAsPercentOfIngredient * 100).toFixed(1)}% of ingredient cost; real reject rate across logged batches is ${(historicalRejectRate * 100).toFixed(1)}%.`,
    recommendation: passed ? "No action needed." : "Update the waste allowance to match real reject history, or note why it's intentionally different.",
  };
}

// PROD-004: production time. Simplified to "is prep/bake/cool time logged at all for the latest
// batch" -- comparing against the costing's own labor minutes would need labor-detail JSON that
// only lives inside costing.notes, not on CostingSummary; left for a later pass.
function evaluateProductionTime(latestBatch: ProductBatch | undefined): RuleResult {
  if (!latestBatch) {
    return insufficientDataResult("PROD-004", CATEGORY, "warning", "No batch logged yet.", "Record a proof batch on Proof Day.");
  }

  const totalMinutes = latestBatch.prepTimeMinutes + latestBatch.bakeTimeMinutes + latestBatch.coolingTimeMinutes;
  const passed = totalMinutes > 0;
  return {
    id: "PROD-004",
    category: CATEGORY,
    severity: "warning",
    passed,
    message: passed ? `${latestBatch.batchVersion} logged ${totalMinutes} total prep/bake/cool minutes.` : `${latestBatch.batchVersion} has no prep/bake/cool time logged.`,
    recommendation: passed ? "No action needed." : "Log prep, bake, and cooling minutes for this batch.",
  };
}

// PROD-005: batch repeatability. Flags when the same wentWrong issue repeats across consecutive
// batches with no formula change between them -- a real, unresolved production problem rather
// than normal iteration noise.
function evaluateBatchRepeatability(productBatches: ProductBatch[]): RuleResult {
  const recent = productBatches.slice(0, 3).filter((batch) => batch.wentWrong.trim());
  if (recent.length < 2) {
    return insufficientDataResult("PROD-005", CATEGORY, "warning", "Not enough logged issues yet to judge repeatability.", "Log a 'what went wrong' note per batch.");
  }

  const normalize = (text: string) => text.trim().toLowerCase();
  let repeatCount = 0;
  for (let index = 0; index < recent.length - 1; index += 1) {
    const current = normalize(recent[index].wentWrong);
    const next = normalize(recent[index + 1].wentWrong);
    if (current && next && (current === next || current.includes(next) || next.includes(current))) {
      repeatCount += 1;
    }
  }

  const passed = repeatCount === 0;
  return {
    id: "PROD-005",
    category: CATEGORY,
    severity: passed ? "warning" : repeatCount >= 2 ? "blocker" : "warning",
    passed,
    message: passed
      ? "No repeated issue across the most recent logged batches."
      : `"${recent[0].wentWrong.trim()}" has appeared across ${repeatCount + 1} of the last ${recent.length} logged batches.`,
    recommendation: passed ? "No action needed." : "Run one batch that specifically targets this issue as its single test variable.",
  };
}

export function evaluateProduction(product: Product, context: RuleEngineContext): RuleResult[] {
  const productBatches = getProductBatches(context, product);
  const latestBatch = getLatestBatch(context, product);

  return [
    evaluateYieldEntered(context, product, latestBatch),
    evaluateYieldConsistency(productBatches),
    evaluateWasteTracking(context, product, productBatches),
    evaluateProductionTime(latestBatch),
    evaluateBatchRepeatability(productBatches),
  ];
}
