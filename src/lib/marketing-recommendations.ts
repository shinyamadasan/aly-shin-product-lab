import type { ExpirationStatus } from "./inventory-status.ts";
import type { Product } from "./product-lab-types.ts";
import type { MarketingAdvisorContext } from "./marketing-advisor-context.ts";

export const RECOMMENDATION_TYPES = [
  "neglected_product",
  "no_marketing_history",
  "seasonal_opportunity",
  "launch_candidate_follow_up",
  "expiring_ingredient",
] as const;
export type RecommendationType = (typeof RECOMMENDATION_TYPES)[number];

export type RecommendationConfidence = "high" | "medium" | "low";
export type RecommendationPriority = 1 | 2 | 3 | 4 | 5;

// Deterministic, pre-AI-boundary artifact -- versioned the same way as MarketingAdvisorContext's
// and MarketingBrief's own `version: 1`. Bumped by hand if this engine's output shape ever
// changes; read by scripts/marketing-advisor/ to record which version produced a given session.
export const MARKETING_RECOMMENDATIONS_VERSION = 1;

export type NeglectedProductEvidence = {
  productId: string;
  productName: string;
  entryCount: number;
  lastCapturedDate: string;
  daysSinceLastCapture: number;
  thresholdDays: number;
};

export type NoMarketingHistoryEvidence = {
  productId: string;
  productName: string;
  entryCount: 0;
};

export type SeasonalOpportunityEvidence = {
  holidayName: string;
  holidayDate: string;
  daysAway: number;
  thresholdDays: number;
};

// `basis` states plainly that status/decision stands in for a real launch date, which does not
// exist anywhere in Product Lab's data -- this is why this rule's confidence is always "low".
export type LaunchCandidateFollowUpEvidence = {
  productId: string;
  productName: string;
  status: Product["status"];
  decision: Product["decision"];
  matchedOn: "status" | "decision" | "both";
  entryCount: number;
  daysSinceLastCapture: number | null;
  thresholdDays: number;
  basis: string;
};

// `basis` states plainly that no product-linking field exists for ingredients -- this
// recommendation can never honestly name a specific finished product.
export type ExpiringIngredientEvidence = {
  ingredientId: string;
  ingredientName: string;
  nearestExpirationDate: string;
  expirationStatus: ExpirationStatus;
  basis: string;
};

type RecommendationBase = {
  id: string;
  priority: RecommendationPriority;
  confidence: RecommendationConfidence;
  title: string;
  explanation: string;
  suggestedNextAction: string;
};

export type MarketingRecommendation =
  | (RecommendationBase & { recommendationType: "neglected_product"; evidence: NeglectedProductEvidence })
  | (RecommendationBase & { recommendationType: "no_marketing_history"; evidence: NoMarketingHistoryEvidence })
  | (RecommendationBase & { recommendationType: "seasonal_opportunity"; evidence: SeasonalOpportunityEvidence })
  | (RecommendationBase & { recommendationType: "launch_candidate_follow_up"; evidence: LaunchCandidateFollowUpEvidence })
  | (RecommendationBase & { recommendationType: "expiring_ingredient"; evidence: ExpiringIngredientEvidence });

// Reasonable defaults, not business rules -- no doc in this repo states a real posting cadence,
// a launch-follow-up window, or a seasonal-planning lead time for this business. Matches the
// precedent already set by src/lib/rule-engine/supply.ts's STALE_PURCHASE_DAYS.
export const NEGLECTED_PRODUCT_STALE_DAYS = 30;
export const LAUNCH_FOLLOW_UP_STALE_DAYS = 14;
export const SEASONAL_WINDOW_DAYS = 21;

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function buildId(type: RecommendationType, entityId: string): string {
  return `${type}:${entityId}`;
}

function buildProductLookup(products: Product[]): Map<string, Product> {
  return new Map(products.map((product) => [product.id, product]));
}

function neglectedProductPriority(daysSinceLastCapture: number): RecommendationPriority {
  if (daysSinceLastCapture >= 90) return 5;
  if (daysSinceLastCapture >= 60) return 4;
  return 3;
}

// A product that was talked about before but has gone quiet -- distinct from
// buildNoMarketingHistoryRecommendations (never talked about at all). Mutually exclusive by
// construction: buildPublishingHistory only sets daysSinceLastCapture when entryCount > 0.
export function buildNeglectedProductRecommendations(context: MarketingAdvisorContext): MarketingRecommendation[] {
  const productsById = buildProductLookup(context.products);
  const recommendations: MarketingRecommendation[] = [];

  for (const entry of context.publishingHistory.byProduct) {
    const product = productsById.get(entry.productId);
    if (!product || product.status === "paused") {
      continue;
    }
    if (entry.daysSinceLastCapture === null || entry.daysSinceLastCapture < NEGLECTED_PRODUCT_STALE_DAYS) {
      continue;
    }

    recommendations.push({
      id: buildId("neglected_product", entry.productId),
      recommendationType: "neglected_product",
      priority: neglectedProductPriority(entry.daysSinceLastCapture),
      confidence: "high",
      title: `Feature ${entry.productName} again`,
      explanation: `${entry.productName} hasn't appeared in the Journey in ${entry.daysSinceLastCapture} days.`,
      suggestedNextAction: `Create new content featuring ${entry.productName}.`,
      evidence: {
        productId: entry.productId,
        productName: entry.productName,
        entryCount: entry.entryCount,
        lastCapturedDate: entry.lastCapturedDate,
        daysSinceLastCapture: entry.daysSinceLastCapture,
        thresholdDays: NEGLECTED_PRODUCT_STALE_DAYS,
      },
    });
  }

  return recommendations;
}

export function buildNoMarketingHistoryRecommendations(context: MarketingAdvisorContext): MarketingRecommendation[] {
  const productsById = buildProductLookup(context.products);
  const recommendations: MarketingRecommendation[] = [];

  for (const entry of context.publishingHistory.byProduct) {
    const product = productsById.get(entry.productId);
    if (!product || product.status === "paused") {
      continue;
    }
    if (entry.entryCount !== 0) {
      continue;
    }

    recommendations.push({
      id: buildId("no_marketing_history", entry.productId),
      recommendationType: "no_marketing_history",
      priority: 4,
      confidence: "high",
      title: `Introduce ${entry.productName}`,
      explanation: `${entry.productName} has never appeared in the Journey.`,
      suggestedNextAction: `Create an introductory piece of content for ${entry.productName}.`,
      evidence: { productId: entry.productId, productName: entry.productName, entryCount: 0 },
    });
  }

  return recommendations;
}

function seasonalPriority(daysAway: number): RecommendationPriority {
  if (daysAway <= 7) return 5;
  if (daysAway <= 14) return 4;
  return 3;
}

// Product-agnostic by design -- no holiday-to-product-category mapping exists in scope, so this
// never claims a specific product is relevant to a given holiday.
export function buildSeasonalOpportunityRecommendations(context: MarketingAdvisorContext): MarketingRecommendation[] {
  const recommendations: MarketingRecommendation[] = [];

  for (const holiday of context.season.nearestHolidays) {
    if (holiday.daysAway > SEASONAL_WINDOW_DAYS) {
      continue;
    }

    recommendations.push({
      id: buildId("seasonal_opportunity", slugify(holiday.name)),
      recommendationType: "seasonal_opportunity",
      priority: seasonalPriority(holiday.daysAway),
      confidence: "high",
      title: `Plan content for ${holiday.name}`,
      explanation: `${holiday.name} is ${holiday.daysAway} day(s) away (${holiday.date}).`,
      suggestedNextAction: `Plan and produce seasonal content for ${holiday.name}.`,
      evidence: { holidayName: holiday.name, holidayDate: holiday.date, daysAway: holiday.daysAway, thresholdDays: SEASONAL_WINDOW_DAYS },
    });
  }

  return recommendations;
}

// An explicitly-labeled proxy for "recently launched, needs follow-up" -- Product Lab has no real
// launch-date field anywhere, so this reads product.status/decision instead. Always confidence
// "low": both the fact (is this really a fresh launch?) and its meaning (does stale marketing
// really mean it needs follow-up?) rest on that proxy, unlike the other rules' exact facts.
export function buildLaunchCandidateFollowUpRecommendations(context: MarketingAdvisorContext): MarketingRecommendation[] {
  const historyByProductId = new Map(context.publishingHistory.byProduct.map((entry) => [entry.productId, entry]));
  const recommendations: MarketingRecommendation[] = [];

  for (const product of context.products) {
    if (product.status === "paused") {
      continue;
    }

    const matchesStatus = product.status === "launch_candidate";
    const matchesDecision = product.decision === "Candidate";
    if (!matchesStatus && !matchesDecision) {
      continue;
    }

    const entry = historyByProductId.get(product.id);
    const entryCount = entry?.entryCount ?? 0;
    const daysSinceLastCapture = entry?.daysSinceLastCapture ?? null;
    const isStale = entryCount === 0 || (daysSinceLastCapture !== null && daysSinceLastCapture >= LAUNCH_FOLLOW_UP_STALE_DAYS);
    if (!isStale) {
      continue;
    }

    const matchedOn: LaunchCandidateFollowUpEvidence["matchedOn"] = matchesStatus && matchesDecision ? "both" : matchesStatus ? "status" : "decision";

    recommendations.push({
      id: buildId("launch_candidate_follow_up", product.id),
      recommendationType: "launch_candidate_follow_up",
      priority: 3,
      confidence: "low",
      title: `Follow up on ${product.name}`,
      explanation: `${product.name} looks launch-ready but has little or no recent marketing activity.`,
      suggestedNextAction: `Create content following up on ${product.name}'s launch readiness.`,
      evidence: {
        productId: product.id,
        productName: product.name,
        status: product.status,
        decision: product.decision,
        matchedOn,
        entryCount,
        daysSinceLastCapture,
        thresholdDays: LAUNCH_FOLLOW_UP_STALE_DAYS,
        basis: "product.status/decision is used as a proxy for \"recently launched\" -- Product Lab has no real launch-date field, so this is not a measured recency signal.",
      },
    });
  }

  return recommendations;
}

function expiringIngredientPriority(status: ExpirationStatus): RecommendationPriority {
  return status === "expired" || status === "expires-today" ? 4 : 3;
}

function describeExpiration(status: ExpirationStatus): string {
  if (status === "expired") {
    return "expired";
  }
  if (status === "expires-today") {
    return "expiring today";
  }
  return "expiring soon";
}

// Reads inventoryHighlights.expiringSoon directly -- ingredients have no product-linking field,
// so this never names or implies a specific finished product.
export function buildExpiringIngredientRecommendations(context: MarketingAdvisorContext): MarketingRecommendation[] {
  return context.inventoryHighlights.expiringSoon.map((ingredient) => ({
    id: buildId("expiring_ingredient", ingredient.id),
    recommendationType: "expiring_ingredient",
    priority: expiringIngredientPriority(ingredient.expirationStatus),
    confidence: "medium",
    title: `Feature ${ingredient.name} before it expires`,
    explanation: `${ingredient.name} is ${describeExpiration(ingredient.expirationStatus)} (${ingredient.nearestExpirationDate}).`,
    suggestedNextAction: `Create content featuring a moment with ${ingredient.name} before it's gone.`,
    evidence: {
      ingredientId: ingredient.id,
      ingredientName: ingredient.name,
      nearestExpirationDate: ingredient.nearestExpirationDate,
      expirationStatus: ingredient.expirationStatus,
      basis: "This ingredient is not linked to any specific product in Product Lab's data -- no finished product is named or implied here.",
    },
  }));
}

function confidenceRank(confidence: RecommendationConfidence): number {
  if (confidence === "high") return 2;
  if (confidence === "medium") return 1;
  return 0;
}

// Explicit, never relies on incidental array order: priority descending, then confidence
// descending, then id ascending as a final deterministic tiebreak.
function compareRecommendations(a: MarketingRecommendation, b: MarketingRecommendation): number {
  if (a.priority !== b.priority) {
    return b.priority - a.priority;
  }
  const confidenceDiff = confidenceRank(b.confidence) - confidenceRank(a.confidence);
  if (confidenceDiff !== 0) {
    return confidenceDiff;
  }
  return a.id.localeCompare(b.id);
}

// Pure: same input always produces the same output. No Supabase client, no side effects, no AI --
// collects every rule's candidates and sorts once. A quiet context (nothing worth flagging)
// legitimately produces an empty array, unlike the Rule Engine's always-emit-one-result-per-rule
// convention.
//
// Rules never suppress each other. A single product can legitimately appear in more than one
// recommendation at once (e.g. neglected_product AND launch_candidate_follow_up for the same
// product) -- this is intentional, not a bug: each rule represents its own independent marketing
// signal, and conflating or merging them here would discard information a later consumer might
// need. Deciding whether to merge, dedupe, or prioritize across signals for the same product is a
// campaign-planning concern for a later milestone, not this engine's job.
export function buildMarketingRecommendations(context: MarketingAdvisorContext): MarketingRecommendation[] {
  return [
    ...buildNeglectedProductRecommendations(context),
    ...buildNoMarketingHistoryRecommendations(context),
    ...buildSeasonalOpportunityRecommendations(context),
    ...buildLaunchCandidateFollowUpRecommendations(context),
    ...buildExpiringIngredientRecommendations(context),
  ].sort(compareRecommendations);
}
