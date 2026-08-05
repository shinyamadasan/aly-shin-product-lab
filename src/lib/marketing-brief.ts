import type { MarketingAdvisorContext } from "./marketing-advisor-context.ts";
import type { MarketingRecommendation } from "./marketing-recommendations.ts";

export type MarketingBrief = {
  version: 1;
  generatedAt: string;
  context: MarketingAdvisorContext;
  recommendations: MarketingRecommendation[];
};

// Pure composition -- no business logic, no AI, no clock read of its own. generatedAt reuses
// context.generatedAt verbatim so this stage never introduces a second clock source.
export function buildMarketingBrief(context: MarketingAdvisorContext, recommendations: MarketingRecommendation[]): MarketingBrief {
  return { version: 1, generatedAt: context.generatedAt, context, recommendations };
}
