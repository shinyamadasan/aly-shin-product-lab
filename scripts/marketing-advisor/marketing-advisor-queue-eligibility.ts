import type { OpportunityDraft } from "../../src/lib/opportunities.ts";

export const MIN_REASON_LENGTH = 20;
export const MAX_SESSION_AGE_DAYS = 7;
// Both: arbitrary-but-reasonable defaults, flagged as such -- matches this codebase's own
// "reasonable defaults, not business rules" convention (e.g. NEGLECTED_PRODUCT_STALE_DAYS).

export type QueueEligibilityExclusion = { deduplicationKey: string; title: string; rule: string; recommendationIds: string[] };
export type QueueEligibilityResult = { sessionStale: boolean; sessionAgeDays: number; eligible: OpportunityDraft[]; excluded: QueueEligibilityExclusion[] };

const PRODUCT_BEARING_RECOMMENDATION_TYPES = new Set(["neglected_product", "no_marketing_history", "launch_candidate_follow_up"]);

// Recommendation ids are always "<type>:<entityId>" (see marketing-recommendations.ts's buildId).
// Reading the type/entity back out of sourceRuleIds -- a top-level OpportunityDraft field, present
// and unchanged both before and after evidence enrichment -- is enough to know which product(s) a
// draft relates to, with no dependency on evidence.citedRecommendations at all.
function extractProductIds(sourceRuleIds: string[]): Set<string> {
  const productIds = new Set<string>();
  for (const id of sourceRuleIds) {
    const separatorIndex = id.indexOf(":");
    if (separatorIndex === -1) continue;
    const type = id.slice(0, separatorIndex);
    const entityId = id.slice(separatorIndex + 1);
    if (PRODUCT_BEARING_RECOMMENDATION_TYPES.has(type) && entityId) {
      productIds.add(entityId);
    }
  }
  return productIds;
}

function normalizedTitle(title: string): string {
  return title.trim().toLowerCase();
}

// Named for what it decides (is this draft eligible to enter the review queue), not "business
// sanity" -- keeps this milestone's own vocabulary matched to its actual scope.
export function runQueueEligibilityChecks(drafts: OpportunityDraft[], now: number, briefGeneratedAt: string): QueueEligibilityResult {
  const sessionAgeDays = (now - Date.parse(briefGeneratedAt)) / (24 * 60 * 60 * 1000);
  const sessionStale = sessionAgeDays > MAX_SESSION_AGE_DAYS;

  const eligible: OpportunityDraft[] = [];
  const excluded: QueueEligibilityExclusion[] = [];
  const seenTitles = new Set<string>();
  const seenProductIds = new Set<string>();

  for (const draft of drafts) {
    const reasons: string[] = [];

    // ---- Validity: is this draft even usable on its own terms? ----
    // (evaluated per-draft, in isolation -- no comparison against sibling drafts needed)
    if (Date.parse(draft.expiresAt) <= now) {
      reasons.push("already-expired");
    }
    if (draft.reason.trim().length < MIN_REASON_LENGTH) {
      reasons.push("reason-too-short");
    }

    // ---- Quality: is this draft worth a human's attention, given what else is in this batch? ----
    // (evaluated relative to sibling drafts already accepted into this batch)
    const title = normalizedTitle(draft.title);
    if (seenTitles.has(title)) {
      reasons.push("duplicate-title-in-batch");
    }
    const productIds = extractProductIds(draft.sourceRuleIds);
    if ([...productIds].some((id) => seenProductIds.has(id))) {
      reasons.push("duplicate-product-in-batch");
    }

    if (reasons.length > 0) {
      excluded.push({ deduplicationKey: draft.deduplicationKey, title: draft.title, rule: reasons.join(", "), recommendationIds: draft.sourceRuleIds });
      continue;
    }

    eligible.push(draft);
    seenTitles.add(title);
    for (const id of productIds) seenProductIds.add(id);
  }

  return { sessionStale, sessionAgeDays, eligible, excluded };
}
