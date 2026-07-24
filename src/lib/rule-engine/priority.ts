import type { ProductHealth, RuleResult, RuleSeverity } from "./types.ts";

// Category weight (higher = more urgent), per RULE_ENGINE.md's Priority System. QUAL-005 (food
// safety) is special-cased above the rest of Quality, matching the documented ordering:
// Financial > Food Safety > Shelf-life/other Quality > Supply > Production > Product Development.
function getCategoryWeight(result: RuleResult): number {
  if (result.category === "financial") {
    return 7;
  }
  if (result.category === "quality") {
    return result.id === "QUAL-005" ? 6 : 5;
  }
  if (result.category === "supply") {
    return 4;
  }
  if (result.category === "production") {
    return 3;
  }
  if (result.category === "product-development") {
    return 2;
  }
  return 0; // launch: composite gates aren't ranked against normal rules for nextBestAction
}

const SEVERITY_RANK: Record<RuleSeverity, number> = { blocker: 3, warning: 2, info: 1 };

// A small, stable tiebreak within the same category+severity so e.g. FIN-001 (negative margin,
// the worst case) ranks above FIN-002 (a softer symptom of the same problem) -- lower-numbered
// rules in a category are, by convention in RULES/*.md, the more severe/foundational ones.
function getRuleTiebreak(result: RuleResult): number {
  const match = result.id.match(/-(\d+)$/);
  if (!match) {
    return 0;
  }
  return Math.max(0, 9 - Number(match[1]));
}

export function getPriorityScore(result: RuleResult): number {
  return SEVERITY_RANK[result.severity] * 1000 + getCategoryWeight(result) * 10 + getRuleTiebreak(result);
}

// Only Blocker/Warning/Info results that failed need action -- Pass and insufficient-data
// results are excluded (nothing to do, or nothing checkable yet).
export function selectNextBestAction(actionableResults: RuleResult[]): RuleResult | null {
  if (actionableResults.length === 0) {
    return null;
  }
  return [...actionableResults].sort((a, b) => getPriorityScore(b) - getPriorityScore(a))[0];
}

// Severity-weighted, not a flat pass count -- the direct fix for readiness.ts's original
// unweighted 6-gate score. Rules with passed === null (insufficient data) are excluded from
// both the numerator and denominator: a product isn't penalized for evidence that simply
// hasn't been collected yet.
export function getReadinessPercentage(ruleResults: RuleResult[]): number {
  const applicable = ruleResults.filter((result) => result.passed !== null);
  if (applicable.length === 0) {
    return 0;
  }

  const weight = (result: RuleResult) => SEVERITY_RANK[result.severity];
  const totalWeight = applicable.reduce((total, result) => total + weight(result), 0);
  const passedWeight = applicable.filter((result) => result.passed === true).reduce((total, result) => total + weight(result), 0);
  return totalWeight > 0 ? Math.round((passedWeight / totalWeight) * 100) : 0;
}

export function getProductHealth(ruleResults: RuleResult[]): ProductHealth {
  const activeBlockers = ruleResults.filter((result) => result.passed === false && result.severity === "blocker");
  if (activeBlockers.length > 0) {
    return "blocked";
  }

  const activeWarnings = ruleResults.filter((result) => result.passed === false && result.severity === "warning");
  if (activeWarnings.length > 0) {
    return "at-risk";
  }

  const launchResults = ruleResults.filter((result) => result.category === "launch");
  const launchEvaluatedAndClean = launchResults.length > 0 && launchResults.every((result) => result.passed === true);
  return launchEvaluatedAndClean ? "ready" : "on-track";
}
