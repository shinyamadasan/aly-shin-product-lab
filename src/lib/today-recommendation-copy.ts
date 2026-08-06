import type { TodaysReadyOpportunity } from "./todays-recommendation.ts";

// The recommendation is the Opportunity's own case for itself -- title/summary, the rule engine's
// stated reasoning -- never the Creative Package's prepared content. The Creative Package is a
// downstream artifact produced FROM the recommendation, not a substitute for it: PROP-034's current
// deterministic worker happens to copy these same fields verbatim into the package today, but that's
// an implementation detail of that one initializer, not a contract Today should depend on. A future
// AI-generated worker could produce package content that diverges from why the Opportunity was
// actually flagged -- Today must keep answering "what should I do and why," not "what did the asset
// pipeline generate," so it reads the Opportunity directly and never touches creativePackage.content.
export function headlineAndReason(candidate: TodaysReadyOpportunity): { headline: string; reason: string } {
  return { headline: candidate.opportunity.title, reason: candidate.opportunity.summary };
}
