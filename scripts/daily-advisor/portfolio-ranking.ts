import { getPriorityScore } from "../../src/lib/rule-engine/index.ts";
import type { RuleEngineContext, RuleResult } from "../../src/lib/rule-engine/index.ts";
import type { Product } from "../../src/lib/product-lab-types.ts";
import { PORTFOLIO_TIER_ORDER } from "./types.ts";
import type { ExperimentSignal, PortfolioFinding, PortfolioRanking, PortfolioTier, ProductEvaluation } from "./types.ts";

// First-match-wins classification. Only active failures (passed === false) are findings --
// passed === true and passed === null (insufficient data) are excluded here exactly as they are
// from evaluateProduct's own blockers/warnings/infos split, so this never re-litigates what
// "failing" means, only re-sorts it for a portfolio view.
export function classifyTier(result: RuleResult): PortfolioTier | null {
  if (result.passed !== false) {
    return null;
  }
  if (result.category === "quality" && result.severity === "blocker") {
    return "safety-quality-blocker";
  }
  if (result.category === "financial" && result.severity === "blocker") {
    return "financial-blocker";
  }
  if (result.category === "product-development" && result.severity === "blocker") {
    return "development-blocker";
  }
  if (result.category === "launch") {
    return "launch-blocker";
  }
  if (result.category === "production" && (result.severity === "blocker" || result.severity === "warning")) {
    return "production-repeatability";
  }
  if (result.category === "supply" && result.severity !== "info") {
    return "supply-failure";
  }
  if (result.severity === "warning") {
    return "warning";
  }
  // Defensive net, found necessary by an independent review: any remaining ACTIVE blocker-severity
  // result (a category/severity combination not explicitly handled above -- present or future)
  // must never fall through to "improvement", the lowest tier. That exact fallthrough is what
  // silently buried DEV-001/DEV-002 before the explicit branch above was added -- this guards
  // against the same bug reappearing for any rule category added later.
  if (result.severity === "blocker") {
    return "development-blocker";
  }
  return "improvement"; // remaining case: severity === "info"
}

// Real, structural signal only -- never a guessed due date. See types.ts's ExperimentSignal doc.
export function getExperimentSignal(product: Product, context: RuleEngineContext): ExperimentSignal | null {
  // Newest dateMade first; ties (2+ batches logged the same calendar day) preserve their
  // original relative order via 0, rather than the previous comparator's inconsistent "a always
  // before b" result for equal dates (which violated the antisymmetry a sort comparator requires).
  const batches = context.batches
    .filter((batch) => batch.productId === product.id)
    .sort((a, b) => (a.dateMade === b.dateMade ? 0 : a.dateMade < b.dateMade ? 1 : -1));
  if (batches.length === 0) {
    return null;
  }
  const latest = batches[0];
  const latestHasTasting = context.tastings.some((tasting) => tasting.batchId === latest.id);
  const isActive = latest.launchDecision === "retest";

  if (!latestHasTasting) {
    return {
      product,
      status: "lacks-observations",
      detail: `Latest batch ${latest.batchVersion} (made ${latest.dateMade}) has no tasting feedback recorded yet.`,
    };
  }
  if (isActive) {
    return {
      product,
      status: "active",
      detail: `Latest batch ${latest.batchVersion} is marked for retest -- still an active experiment.`,
    };
  }
  return null;
}

const TIER_RANK: Record<PortfolioTier, number> = Object.fromEntries(PORTFOLIO_TIER_ORDER.map((tier, index) => [tier, index])) as Record<PortfolioTier, number>;

// Pure, deterministic: same evaluations[] always produces the same ranking. Never recomputes a
// RuleResult -- only re-sorts what evaluateProduct() already returned for each product.
export function rankPortfolio(evaluations: ProductEvaluation[]): PortfolioRanking {
  const findings: PortfolioFinding[] = [];
  const noActionProducts: Product[] = [];

  for (const evaluation of evaluations) {
    const productFindings: PortfolioFinding[] = [];
    for (const result of evaluation.ruleEngineOutput.ruleResults) {
      const tier = classifyTier(result);
      if (tier) {
        productFindings.push({ tier, product: evaluation.product, result });
      }
    }
    if (productFindings.length === 0) {
      noActionProducts.push(evaluation.product);
    }
    findings.push(...productFindings);
  }

  findings.sort((a, b) => {
    const tierDiff = TIER_RANK[a.tier] - TIER_RANK[b.tier];
    if (tierDiff !== 0) {
      return tierDiff;
    }
    return getPriorityScore(b.result) - getPriorityScore(a.result); // higher score first, within the same tier
  });

  const experimentSignals = evaluations.map((evaluation) => evaluation.experimentSignal).filter((signal): signal is ExperimentSignal => signal !== null);

  const topFinding = findings.length > 0 ? findings[0] : null;

  return {
    findings,
    experimentSignals,
    noActionProducts,
    highestPriorityProduct: topFinding ? topFinding.product : null,
    topFinding,
  };
}
