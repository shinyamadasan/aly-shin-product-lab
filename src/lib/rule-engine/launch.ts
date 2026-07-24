import type { Product } from "../product-lab-types.ts";
import { evaluateDevelopment } from "./development.ts";
import { evaluateFinancial } from "./financial.ts";
import { evaluateProduction } from "./production.ts";
import { evaluateQuality } from "./quality.ts";
import type { RuleEngineContext, RuleResult } from "./types.ts";

const CATEGORY = "launch" as const;

// Launch Rules are composite gates -- they read other rules' results, they never recompute
// them. Only meaningful when a launch decision is actually being evaluated (e.g. via
// ai-review/workflows/launch-readiness-council.md), not on every routine dashboard load.

function findResult(results: RuleResult[], id: string): RuleResult | undefined {
  return results.find((result) => result.id === id);
}

// LAUNCH-001: required data complete. All four inputs must be a real Pass, not just non-Fail.
function evaluateRequiredDataComplete(financial: RuleResult[], production: RuleResult[], development: RuleResult[]): RuleResult {
  const inputs = [findResult(development, "DEV-001"), findResult(financial, "FIN-005"), findResult(production, "PROD-001")];
  const missing = inputs.filter((result) => result?.passed !== true);
  const passed = missing.length === 0;
  return {
    id: "LAUNCH-001",
    category: CATEGORY,
    severity: "blocker",
    passed,
    message: passed ? "Batches, yield, and selling price are all on file." : `Missing: ${missing.map((result) => result?.id ?? "unknown").join(", ")}.`,
    recommendation: passed ? "No action needed." : "Resolve the missing input(s) before evaluating launch readiness further.",
  };
}

// LAUNCH-002: required experiments complete. QUAL-001/QUAL-003 only count when they returned a
// real result (not insufficient-data-because-not-applicable), matching their own applicability
// rules in evaluateQuality.
function evaluateRequiredExperimentsComplete(development: RuleResult[], quality: RuleResult[]): RuleResult {
  const requiredAlways = [findResult(development, "DEV-002"), findResult(development, "DEV-005")];
  const requiredWhenApplicable = [findResult(quality, "QUAL-001"), findResult(quality, "QUAL-003")].filter((result) => result && result.passed !== null);
  const inputs = [...requiredAlways, ...requiredWhenApplicable];
  const notPassed = inputs.filter((result) => result?.passed !== true);
  const passed = notPassed.length === 0;
  return {
    id: "LAUNCH-002",
    category: CATEGORY,
    severity: "blocker",
    passed,
    message: passed ? "Tasting signal, recipe stability, and applicable quality checks are all satisfied." : `Not yet satisfied: ${notPassed.map((result) => result?.id ?? "unknown").join(", ")}.`,
    recommendation: passed ? "No action needed." : "Resolve each listed rule -- see its own recommendation for the exact next action.",
  };
}

// LAUNCH-003: no blocking financial issues. Mirrors the Restaurant Accountant specialist's VETO
// trigger exactly, so the deterministic rule and the AI specialist can't disagree.
function evaluateNoBlockingFinancialIssues(financial: RuleResult[]): RuleResult {
  const blockers = financial.filter((result) => result.severity === "blocker" && result.passed === false);
  const passed = blockers.length === 0;
  return {
    id: "LAUNCH-003",
    category: CATEGORY,
    severity: "blocker",
    passed,
    message: passed ? "No blocking financial issues." : `Blocking: ${blockers.map((result) => result.id).join(", ")}.`,
    recommendation: passed ? "No action needed." : "Resolve the listed financial rule(s) before launch.",
  };
}

// LAUNCH-004: no blocking quality issues. QUAL-005 (food safety) is always a hard gate; QUAL-001
// (shelf-life) and QUAL-002 (packaging) escalate to launch-blocking here even though their
// default severity elsewhere is Warning -- launch is the one context where "untested" isn't
// good enough.
function evaluateNoBlockingQualityIssues(quality: RuleResult[]): RuleResult {
  const foodSafety = findResult(quality, "QUAL-005");
  const escalated = [findResult(quality, "QUAL-001"), findResult(quality, "QUAL-002")].filter((result) => result && result.passed === false);
  const blocking = [foodSafety?.passed === false ? foodSafety : null, ...escalated].filter((result): result is RuleResult => Boolean(result));
  const passed = blocking.length === 0;
  return {
    id: "LAUNCH-004",
    category: CATEGORY,
    severity: "blocker",
    passed,
    message: passed ? "No blocking quality issues." : `Blocking: ${blocking.map((result) => result.id).join(", ")}.`,
    recommendation: passed ? "No action needed." : "Resolve the listed quality rule(s) before launch -- food safety and untested packaging/shelf-life claims are not launch-ready by default.",
  };
}

export function evaluateLaunch(product: Product, context: RuleEngineContext): RuleResult[] {
  const financial = evaluateFinancial(product, context);
  const production = evaluateProduction(product, context);
  const development = evaluateDevelopment(product, context);
  const quality = evaluateQuality(product, context);

  return [
    evaluateRequiredDataComplete(financial, production, development),
    evaluateRequiredExperimentsComplete(development, quality),
    evaluateNoBlockingFinancialIssues(financial),
    evaluateNoBlockingQualityIssues(quality),
  ];
}
