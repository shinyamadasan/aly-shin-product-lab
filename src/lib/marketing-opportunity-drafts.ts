import type { OpportunityDraft, OpportunitySourceFinding } from "./opportunities.ts";
import { buildOpportunityDeduplicationKey, calculateOpportunityExpiresAt } from "./opportunities.ts";
import type { MarketingBrief } from "./marketing-brief.ts";
import type { MarketingOpportunitySuggestion, MarketingOpportunitySuggestionsResponse } from "./marketing-opportunity-suggestions.ts";
import type { MarketingRecommendation, RecommendationType } from "./marketing-recommendations.ts";

export const OPPORTUNITY_TYPE = "marketing_advisor_suggestion";
const PRODUCER = "marketing_advisor";

const RECOMMENDATION_TYPE_LABELS: Record<RecommendationType, string> = {
  neglected_product: "Neglected Product",
  no_marketing_history: "No Marketing History",
  seasonal_opportunity: "Seasonal Opportunity",
  launch_candidate_follow_up: "Launch Follow-Up",
  expiring_ingredient: "Expiring Ingredient",
};

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function isExpiringIngredient(
  recommendation: MarketingRecommendation,
): recommendation is Extract<MarketingRecommendation, { recommendationType: "expiring_ingredient" }> {
  return recommendation.recommendationType === "expiring_ingredient";
}

function entityIdFor(recommendation: MarketingRecommendation): Record<string, string> {
  switch (recommendation.recommendationType) {
    case "neglected_product":
    case "no_marketing_history":
    case "launch_candidate_follow_up":
      return { product: recommendation.evidence.productId };
    case "seasonal_opportunity":
      return { holiday: slugify(recommendation.evidence.holidayName) };
    case "expiring_ingredient":
      return { ingredient: recommendation.evidence.ingredientId };
    default: {
      const exhaustiveCheck: never = recommendation;
      throw new Error(`Unhandled recommendation type: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

// entityIds is supplementary (useful for grouping/filtering) -- identity safety comes entirely
// from recommendationSet below. Values are joined rather than overwritten so citing two
// recommendations that happen to share an entity key (e.g. two different products) never
// silently drops one.
function buildEntityIds(citedRecommendations: MarketingRecommendation[], canonicalIds: string[]): Record<string, string> {
  const byKey = new Map<string, Set<string>>();
  for (const recommendation of citedRecommendations) {
    for (const [key, value] of Object.entries(entityIdFor(recommendation))) {
      if (!byKey.has(key)) {
        byKey.set(key, new Set());
      }
      byKey.get(key)!.add(value);
    }
  }

  const entityIds: Record<string, string> = { recommendationSet: canonicalIds.join("+") };
  for (const [key, values] of byKey) {
    entityIds[key] = [...values].sort().join("+");
  }
  return entityIds;
}

// calculateOpportunityExpiresAt's "expiry_related" branch (src/lib/opportunities.ts:206-230)
// performs no clamping against detectedAt -- it trusts relevantExpiryDate completely, while
// validateOpportunityDraft (opportunities.ts:141-142) strictly requires expiresAt after
// detectedAt. Clamping the earliest cited expiry date at businessDate (never earlier) guarantees
// that requirement holds even when an ingredient's nearestExpirationDate is already in the past
// relative to this Brief.
function clampedEarliestExpiryDate(citedRecommendations: MarketingRecommendation[], businessDate: string): string {
  const earliest = citedRecommendations
    .filter(isExpiringIngredient)
    .map((recommendation) => recommendation.evidence.nearestExpirationDate)
    .sort()[0];
  return earliest < businessDate ? businessDate : earliest;
}

function buildExpiresAt(citedRecommendations: MarketingRecommendation[], detectedAt: string, businessDate: string): string {
  if (!citedRecommendations.some(isExpiringIngredient)) {
    return calculateOpportunityExpiresAt({ detectedAt, policy: "general_product_promotion" });
  }
  return calculateOpportunityExpiresAt({
    detectedAt,
    policy: "expiry_related",
    relevantExpiryDate: clampedEarliestExpiryDate(citedRecommendations, businessDate),
  });
}

// Deterministic, mechanical construction -- no AI, no randomness, no clock read beyond what's
// already in `brief`. Every id-ordering-sensitive field (sourceRuleIds, sourceFindings,
// supportingEvidence, the dedup key's entityIds, sourceId) is built from the same canonicalized
// (sorted, deduplicated) id array, computed once here, so the same cited set always produces the
// same draft regardless of the AI's original citation order.
export function buildOpportunityDraftFromSuggestion(suggestion: MarketingOpportunitySuggestion, brief: MarketingBrief): OpportunityDraft {
  const canonicalIds = [...new Set(suggestion.sourceRecommendationIds)].sort();
  const recommendationsById = new Map(brief.recommendations.map((recommendation) => [recommendation.id, recommendation]));
  const citedRecommendations = canonicalIds.map((id) => recommendationsById.get(id)!);

  const businessDate = brief.context.season.asOfDate;
  const detectedAt = brief.generatedAt;

  const priority = Math.max(...citedRecommendations.map((recommendation) => recommendation.priority));
  const supportingEvidence = citedRecommendations.map(
    (recommendation) => `${RECOMMENDATION_TYPE_LABELS[recommendation.recommendationType]}: ${recommendation.explanation}`,
  );
  const sourceFindings: OpportunitySourceFinding[] = citedRecommendations.map((recommendation) => ({
    id: recommendation.id,
    category: recommendation.recommendationType,
    severity: recommendation.confidence,
    passed: true,
    message: recommendation.explanation,
    recommendation: recommendation.suggestedNextAction,
  }));

  const deduplicationKey = buildOpportunityDeduplicationKey({
    producer: PRODUCER,
    findingType: OPPORTUNITY_TYPE,
    entityIds: buildEntityIds(citedRecommendations, canonicalIds),
    action: "create_content",
    businessDate,
  });

  return {
    opportunityType: OPPORTUNITY_TYPE,
    producer: PRODUCER,
    sourceType: "marketing_advisor",
    sourceId: `marketing_advisor:${businessDate}:${canonicalIds.join("+")}`,
    title: suggestion.title,
    reason: suggestion.reason,
    recommendedAction: "create_content",
    evidenceVersion: "v1",
    evidence: {
      aiReasoning: suggestion.reason,
      priority,
      supportingEvidence,
      citedRecommendations,
    },
    sourceRuleIds: canonicalIds,
    sourceFindings,
    detectedAt,
    expiresAt: buildExpiresAt(citedRecommendations, detectedAt, businessDate),
    deduplicationKey,
  };
}

export function buildOpportunityDraftsFromSuggestions(response: MarketingOpportunitySuggestionsResponse, brief: MarketingBrief): OpportunityDraft[] {
  return response.suggestions.map((suggestion) => buildOpportunityDraftFromSuggestion(suggestion, brief));
}
