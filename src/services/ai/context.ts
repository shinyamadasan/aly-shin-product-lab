import { diffFormulaRows, parseBatchIngredients } from "../../lib/batches.ts";
import { getCostingTotals } from "../../lib/costing.ts";
import type { Product } from "../../lib/product-lab-types.ts";
import { averageRating, evaluateProduct, getLatestBatch, getLinkedCosting, getProductBatches, getProductTastings } from "../../lib/rule-engine/index.ts";
import type { RuleEngineContext } from "../../lib/rule-engine/index.ts";
import type { AiAction, AiAdvisorInput, CostingSummaryForAi, RecentExperimentSummary, TastingSummaryForAi } from "./types.ts";

// Static business framing an AI reader needs but the Rule Engine has no reason to encode --
// condensed from PRODUCT_LAB_CONTEXT.md's "Current Business Context" and "Product Lab
// Principles". Kept short and qualitative on purpose; every number in the prompt still comes
// from ruleEngineOutput/costingSummary/tastingSummary, never restated here.
const BUSINESS_CONTEXT =
  "Aly & Shin Product Lab is a private, home-based coffee and bakery business in the proving " +
  "stage -- pre-launch, not yet taking public preorders at scale. Bakery is the primary focus; " +
  "bottled coffee still needs freshness/cold-chain/margin proof before being treated as a hero " +
  "product. Product proof must come before launch decisions, and only one major formula/process " +
  "variable should change per test. Labor is owner wage, not profit -- profit is what remains " +
  "after ingredients, packaging, labor, utilities, waste, overhead, and equipment allocation. " +
  "Recommendations must fit a single home kitchen at small-batch scale, not store or " +
  "multi-branch infrastructure.";

function buildProductContext(product: Product): string {
  const description = product.description.trim() || "No description recorded.";
  return `${BUSINESS_CONTEXT}\n\nProduct under review: ${product.name} (category: ${product.category}, role: ${product.role}, status: ${product.status}). ${description} Current recorded decision: ${product.decision}.`;
}

function buildCostingSummary(context: RuleEngineContext, product: Product, latestBatch: ReturnType<typeof getLatestBatch>): CostingSummaryForAi {
  const costing = getLinkedCosting(context, product, latestBatch);
  if (!costing) {
    return { batchVersion: latestBatch?.batchVersion ?? "", costPerPiece: null, foodCostPercent: null, hasCosting: false, margin: null, sellingPrice: 0 };
  }

  const totals = getCostingTotals(costing);
  return {
    batchVersion: latestBatch?.batchVersion ?? "",
    costPerPiece: totals.costPerPiece,
    foodCostPercent: totals.foodCostPercent,
    hasCosting: true,
    margin: totals.margin,
    sellingPrice: costing.suggestedPrice,
  };
}

function buildTastingSummary(context: RuleEngineContext, product: Product): TastingSummaryForAi {
  const tastings = getProductTastings(context, product);
  return {
    averageRating: averageRating(tastings),
    count: tastings.length,
    recentComments: tastings.slice(0, 3).map((tasting) => tasting.liked || tasting.improve).filter((comment) => comment.trim().length > 0),
  };
}

// "Experiments" have no dedicated schema entity yet -- Rule Engine DEV-004
// (RULES/product-development.md) is honest about this same gap. This reads the same free-text
// batch fields DEV-004 points at, formatted for a human/AI reader rather than a pass/fail check.
// formulaChanged reuses batches.ts's diffFormulaRows -- the same diff Batches page already shows
// -- instead of a second formula-comparison implementation.
function buildRecentExperiments(productBatches: ReturnType<typeof getProductBatches>): RecentExperimentSummary[] {
  return productBatches.slice(0, 3).map((batch, index) => {
    const previous = productBatches[index + 1];
    const formulaChanged = previous
      ? diffFormulaRows(parseBatchIngredients(previous.ingredientsNotes), parseBatchIngredients(batch.ingredientsNotes)).some((row) => row.status !== "same")
      : false;
    return {
      batchVersion: batch.batchVersion,
      dateMade: batch.dateMade,
      formulaChanged,
      improveNext: batch.improveNext,
      launchDecision: batch.launchDecision,
      wentWrong: batch.wentWrong,
    };
  });
}

// Assembles the one object every AI Advisor prompt is built from. Pure: same product + same
// context + same action always produces the same AiAdvisorInput. ruleEngineOutput is the only
// place any deterministic check runs -- evaluateProduct itself, reused as-is, never
// reimplemented here. includeLaunch only turns on for the Launch Review action, matching the
// Rule Engine's own documented default (see rule-engine/index.ts).
export function buildAdvisorInput(product: Product, context: RuleEngineContext, action: AiAction): AiAdvisorInput {
  const latestBatch = getLatestBatch(context, product);
  const productBatches = getProductBatches(context, product);

  return {
    costingSummary: buildCostingSummary(context, product, latestBatch),
    product,
    productContext: buildProductContext(product),
    recentExperiments: buildRecentExperiments(productBatches),
    ruleEngineOutput: evaluateProduct(product, context, { includeLaunch: action === "launch-review" }),
    tastingSummary: buildTastingSummary(context, product),
  };
}
