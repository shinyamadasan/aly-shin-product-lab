import type { Product } from "../product-lab-types.ts";
import { evaluateDevelopment } from "./development.ts";
import { evaluateFinancial } from "./financial.ts";
import { evaluateLaunch } from "./launch.ts";
import { getProductHealth, getReadinessPercentage, selectNextBestAction } from "./priority.ts";
import { evaluateProduction } from "./production.ts";
import { evaluateQuality } from "./quality.ts";
import { evaluateSupply } from "./supply.ts";
import type { RuleEngineContext, RuleEngineResult, RuleResult } from "./types.ts";

export type { ProductHealth, RuleCategory, RuleEngineContext, RuleEngineResult, RuleResult, RuleSeverity } from "./types.ts";
export { evaluateDevelopment } from "./development.ts";
export { evaluateFinancial } from "./financial.ts";
export { evaluateLaunch } from "./launch.ts";
export { evaluateProduction } from "./production.ts";
export { evaluateQuality } from "./quality.ts";
export { evaluateSupply } from "./supply.ts";
export { getPriorityScore } from "./priority.ts";
// Selector helpers -- exposed so other consumers (e.g. services/ai/context.ts) reuse the exact
// same "which batch, which costing, which tastings" logic every rule category already shares,
// instead of a second, potentially-drifting implementation.
export { averageRating, getLatestBatch, getLinkedCosting, getProductBatches, getProductTastings } from "./types.ts";

// Pure, deterministic, no side effects: same product + same context always produces the same
// result. No database reads or network requests happen inside the Rule Engine -- all data is
// passed in via `context`, already loaded by the caller. See RULE_ENGINE.md.
//
// includeLaunch defaults to false: launch composite gates (LAUNCH-001..004) only run when a
// launch decision is actually being evaluated, not on every routine dashboard/product-detail
// load -- matching RULES/launch.md ("only run when a launch/preorder decision is actually being
// evaluated").
export function evaluateProduct(product: Product, context: RuleEngineContext, options: { includeLaunch?: boolean } = {}): RuleEngineResult {
  const financial = evaluateFinancial(product, context);
  const production = evaluateProduction(product, context);
  const development = evaluateDevelopment(product, context);
  const quality = evaluateQuality(product, context);
  const supply = evaluateSupply(product, context);
  const launch = options.includeLaunch ? evaluateLaunch(product, context) : [];

  const ruleResults: RuleResult[] = [...financial, ...production, ...development, ...quality, ...supply, ...launch];

  const blockers = ruleResults.filter((result) => result.passed === false && result.severity === "blocker");
  const warnings = ruleResults.filter((result) => result.passed === false && result.severity === "warning");
  const infos = ruleResults.filter((result) => result.passed === false && result.severity === "info");
  const insufficientData = ruleResults.filter((result) => result.passed === null);

  // Launch composite gates are excluded from nextBestAction candidacy -- they name which
  // underlying rule to fix (see RULES/launch.md), so the underlying rule is always the more
  // useful, more specific action to surface.
  const actionable = [...blockers, ...warnings, ...infos].filter((result) => result.category !== "launch");

  return {
    productHealth: getProductHealth(ruleResults),
    readinessPercentage: getReadinessPercentage(ruleResults),
    blockers,
    warnings,
    infos,
    insufficientData,
    nextBestAction: selectNextBestAction(actionable),
    ruleResults,
  };
}
