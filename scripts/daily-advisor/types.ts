import type { Product } from "../../src/lib/product-lab-types.ts";
import type { RuleEngineResult, RuleResult } from "../../src/lib/rule-engine/index.ts";

export type DataSourceMode = "supabase" | "sample";

// The portfolio's own priority order (task-specified), deliberately distinct from
// rule-engine/priority.ts's getPriorityScore -- that function ranks findings WITHIN one product
// to pick its nextBestAction (Financial > Food Safety > other Quality > Supply > Production >
// Development). This ranks findings ACROSS the whole portfolio for a morning triage, and the
// requested order genuinely disagrees (safety/quality outranks financial here). Both are correct
// for the question they answer; see DAILY_AI_ADVISOR.md section 5.
//
// "development-blocker" was added after an independent review found a release-blocking gap:
// DEV-001/DEV-002 (category "product-development", severity "blocker" -- e.g. "no proof batches
// logged yet") had no explicit tier and fell through to "improvement" (the lowest tier, meant for
// info-severity items), silently burying the Rule Engine's own highest-severity signal for any
// product with no logged batches. Placed right after financial-blocker: DEV-001/DEV-002 are the
// literal inputs LAUNCH-001/LAUNCH-002 depend on (see src/lib/rule-engine/launch.ts), so the root
// cause should never rank below the composite pointer that names it as missing.
export type PortfolioTier =
  | "safety-quality-blocker"
  | "financial-blocker"
  | "development-blocker"
  | "launch-blocker"
  | "production-repeatability"
  | "supply-failure"
  | "warning"
  | "improvement";

export const PORTFOLIO_TIER_ORDER: readonly PortfolioTier[] = [
  "safety-quality-blocker",
  "financial-blocker",
  "development-blocker",
  "launch-blocker",
  "production-repeatability",
  "supply-failure",
  "warning",
  "improvement",
];

export type PortfolioFinding = {
  tier: PortfolioTier;
  product: Product;
  result: RuleResult;
};

// Reports only what the current schema can actually support -- no due date exists anywhere
// (ProductBatch/TastingFeedback have no date-due field), so this never claims something is
// "overdue." "active" = the latest batch is marked for retest (still mid-experiment).
// "lacks-observations" = the latest batch has zero tasting feedback linked to it. Both are real,
// structural facts read directly from the data, not inferred cadences. See DAILY_AI_ADVISOR.md
// section 5 and the follow-up task logged in planning/ROADMAP.md for the structured fields
// (experimentStatus, nextObservationAt) that would let this be more specific later.
export type ExperimentSignalStatus = "active" | "lacks-observations";

export type ExperimentSignal = {
  product: Product;
  status: ExperimentSignalStatus;
  detail: string;
};

export type ProductEvaluation = {
  product: Product;
  ruleEngineOutput: RuleEngineResult;
  experimentSignal: ExperimentSignal | null;
};

export type PortfolioRanking = {
  findings: PortfolioFinding[]; // sorted: tier order, then existing getPriorityScore as same-tier tiebreak
  experimentSignals: ExperimentSignal[];
  noActionProducts: Product[];
  highestPriorityProduct: Product | null;
  topFinding: PortfolioFinding | null;
};

export type ClaudeFailureReason = "missing-binary" | "timeout" | "auth-error" | "usage-limit" | "malformed-response" | "process-error" | "output-too-large";

export type ClaudeInvocationResult = { ok: true; text: string } | { ok: false; reason: ClaudeFailureReason; detail: string };
