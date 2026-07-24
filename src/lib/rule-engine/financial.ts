import { getCostingTotals } from "../costing.ts";
import type { CostingSummary, Product } from "../product-lab-types.ts";
import { getLatestBatch, getLinkedCosting, insufficientDataResult, type RuleEngineContext, type RuleResult } from "./types.ts";

const CATEGORY = "financial" as const;

type CostingTotals = ReturnType<typeof getCostingTotals>;

// FIN-001: negative margin. See RULES/financial.md. costPerPiece null (yield missing) is
// insufficient data, not a failure -- PROD-001 owns that root cause.
function evaluateNegativeMargin(totals: CostingTotals): RuleResult {
  if (totals.costPerPiece === null || totals.margin === null) {
    return insufficientDataResult("FIN-001", CATEGORY, "blocker", "Cost per piece is unavailable because yield is missing -- margin can't be checked yet.", "Enter the batch yield on the Costing page (see PROD-001).");
  }

  const passed = totals.margin > 0;
  return {
    id: "FIN-001",
    category: CATEGORY,
    severity: "blocker",
    passed,
    message: passed
      ? `Margin is ${totals.margin.toFixed(1)}% at the current price.`
      : `Cost per piece is PHP ${totals.costPerPiece.toFixed(2)} -- current price loses money (${totals.margin.toFixed(1)}% margin).`,
    recommendation: passed ? "No action needed." : `Raise the price to at least PHP ${totals.costPerPiece.toFixed(2)} (breakeven), or reduce a cost driver.`,
  };
}

// FIN-002: food cost %. Warning even at a wide gap -- FIN-001 already owns the "losing money"
// blocker for the same underlying number, so this rule never escalates to avoid double-counting.
function evaluateFoodCostPercent(totals: CostingTotals): RuleResult {
  if (totals.foodCostPercent === null) {
    return insufficientDataResult("FIN-002", CATEGORY, "warning", "Food cost % is unavailable because yield is missing.", "Enter the batch yield first.");
  }
  if (!(totals.targetFoodCost > 0)) {
    return insufficientDataResult("FIN-002", CATEGORY, "warning", "No target food cost % has been set for this costing.", "Set a target food cost % on the Costing page to enable this check.");
  }

  const targetPercent = totals.targetFoodCost * 100;
  const delta = totals.foodCostPercent - targetPercent;
  const passed = delta <= 0;
  return {
    id: "FIN-002",
    category: CATEGORY,
    severity: "warning",
    passed,
    message: passed
      ? `Food cost is ${totals.foodCostPercent.toFixed(1)}%, at or under the ${targetPercent.toFixed(1)}% target.`
      : `Food cost is ${totals.foodCostPercent.toFixed(1)}% against a ${targetPercent.toFixed(1)}% target -- ${delta.toFixed(1)} points over.`,
    recommendation: passed ? "No action needed." : "Reduce ingredient cost, renegotiate a supplier price, or reconsider whether the target is realistic.",
  };
}

// FIN-003: missing labor. Simplified to a presence check (laborEstimate > 0) -- the finer
// "cost entered without any logged minutes" distinction would need labor-minute detail that
// only exists inside costing.notes' structured JSON, not on CostingSummary itself; left for a
// later pass rather than adding that parsing now.
function evaluateMissingLabor(costing: CostingSummary): RuleResult {
  const passed = costing.laborEstimate > 0;
  return {
    id: "FIN-003",
    category: CATEGORY,
    severity: "warning",
    passed,
    message: passed ? `Labor cost is PHP ${costing.laborEstimate.toFixed(2)}.` : "Labor cost is PHP 0 -- either this product genuinely takes no paid time, or it hasn't been captured yet.",
    recommendation: passed ? "No action needed." : "Log prep/bake/cooling/packaging/cleaning minutes for the batch this costing is based on.",
  };
}

// FIN-004: missing overhead. Simplified to a presence check -- distinguishing "deliberately
// PHP 0 with a note" from "just unfilled" would need the overhead row notes, which live inside
// costing.notes' structured JSON, not on CostingSummary; left for a later pass.
function evaluateMissingOverhead(costing: CostingSummary): RuleResult {
  const passed = costing.overheadCost > 0;
  return {
    id: "FIN-004",
    category: CATEGORY,
    severity: "warning",
    passed,
    message: passed ? `Overhead is PHP ${costing.overheadCost.toFixed(2)}.` : "Overhead is PHP 0 -- confirm this is intentional (e.g. home-based, no rent yet), not just unfilled.",
    recommendation: passed ? "No action needed." : "Add a real allocated figure once overhead applies, or confirm PHP 0 is still correct.",
  };
}

// FIN-005: missing selling price. Every other financial number depends on this one.
function evaluateMissingSellingPrice(costing: CostingSummary): RuleResult {
  const passed = costing.suggestedPrice > 0;
  return {
    id: "FIN-005",
    category: CATEGORY,
    severity: "blocker",
    passed,
    message: passed ? `Selling price is PHP ${costing.suggestedPrice.toFixed(2)}.` : "No selling price has been set.",
    recommendation: passed ? "No action needed." : "Enter a selling price on the Costing page.",
  };
}

// FIN-006: break-even units.
function evaluateBreakEven(totals: CostingTotals): RuleResult {
  if (totals.breakEvenUnits === null) {
    return insufficientDataResult("FIN-006", CATEGORY, "warning", "Break-even can't be calculated because yield is missing.", "Enter the batch yield first.");
  }
  if (totals.contributionMarginPerPiece === null || totals.contributionMarginPerPiece <= 0) {
    return {
      id: "FIN-006",
      category: CATEGORY,
      severity: "warning",
      passed: false,
      message: "Break-even can't be calculated -- the selling price doesn't cover variable cost per piece.",
      recommendation: "Resolve FIN-001 (negative margin) first.",
    };
  }

  return {
    id: "FIN-006",
    category: CATEGORY,
    severity: "warning",
    passed: true,
    message: `${totals.breakEvenUnits} pieces need to sell to cover this batch's overhead and equipment allocation.`,
    recommendation: "Compare against typical order volume for this product; revisit price or overhead allocation if it's consistently out of reach.",
  };
}

// FIN-007: target margin. This app tracks a target FOOD COST %, not a separate target margin --
// margin% and food-cost% are mathematically complementary (margin = 100% - food cost % of the
// same price/cost pair), so a distinct target-margin check would just restate FIN-002. Honest
// null rather than a fabricated second check.
function evaluateTargetMargin(): RuleResult {
  return insufficientDataResult(
    "FIN-007",
    CATEGORY,
    "warning",
    "No standalone target margin % is tracked separately from target food cost % yet.",
    "See FIN-002 (Food Cost %) -- margin and the food cost target are the same underlying check today.",
  );
}

export function evaluateFinancial(product: Product, context: RuleEngineContext): RuleResult[] {
  const latestBatch = getLatestBatch(context, product);
  const costing = getLinkedCosting(context, product, latestBatch);

  if (!costing) {
    const message = `No saved costing exists for ${product.name}.`;
    const recommendation = "Save a costing on the Costing page.";
    return [
      insufficientDataResult("FIN-001", CATEGORY, "blocker", message, recommendation),
      insufficientDataResult("FIN-002", CATEGORY, "warning", message, recommendation),
      insufficientDataResult("FIN-003", CATEGORY, "warning", message, recommendation),
      insufficientDataResult("FIN-004", CATEGORY, "warning", message, recommendation),
      insufficientDataResult("FIN-005", CATEGORY, "blocker", message, recommendation),
      insufficientDataResult("FIN-006", CATEGORY, "warning", message, recommendation),
      evaluateTargetMargin(),
    ];
  }

  const totals = getCostingTotals(costing);
  return [
    evaluateNegativeMargin(totals),
    evaluateFoodCostPercent(totals),
    evaluateMissingLabor(costing),
    evaluateMissingOverhead(costing),
    evaluateMissingSellingPrice(costing),
    evaluateBreakEven(totals),
    evaluateTargetMargin(),
  ];
}
