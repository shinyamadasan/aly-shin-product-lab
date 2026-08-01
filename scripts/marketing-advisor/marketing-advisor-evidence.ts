import type { OpportunityDraft } from "../../src/lib/opportunities.ts";
import type { MarketingBrief } from "../../src/lib/marketing-brief.ts";
import type { MarketingOpportunitySuggestionsResponse } from "../../src/lib/marketing-opportunity-suggestions.ts";
import type { MarketingRecommendation } from "../../src/lib/marketing-recommendations.ts";
import { MARKETING_ADVISOR_VERSION, type MarketingAdvisorManifest } from "./marketing-advisor-manual-export.ts";

export type SessionMetadata = {
  originSessionId: string;
  advisorVersion: string;
  contextVersion: number;
  recommendationVersion: number;
  promptVersion: string;
};

export function buildSessionMetadata(manifest: MarketingAdvisorManifest): SessionMetadata {
  return {
    originSessionId: manifest.sessionId,
    advisorVersion: MARKETING_ADVISOR_VERSION,
    contextVersion: manifest.contextVersion,
    recommendationVersion: manifest.recommendationVersion,
    promptVersion: manifest.promptVersion,
  };
}

export type RecommendationSnapshotEntry = { id: string; title: string; explanation: string; priority: number; confidence: string };

export function buildRecommendationSnapshot(citedRecommendations: MarketingRecommendation[]): RecommendationSnapshotEntry[] {
  return citedRecommendations.map((r) => ({ id: r.id, title: r.title, explanation: r.explanation, priority: r.priority, confidence: r.confidence }));
}

export type SessionStats = { totalRecommendationsInBrief: number; totalSuggestionsFromAI: number };

export function buildSessionStats(brief: MarketingBrief, response: MarketingOpportunitySuggestionsResponse): SessionStats {
  return { totalRecommendationsInBrief: brief.recommendations.length, totalSuggestionsFromAI: response.suggestions.length };
}

// Deliberately DROPS evidence.citedRecommendations -- the full, PROP-020-lifted recommendation
// objects are useful for local inspection of drafts.json (a disposable session artifact), but
// freezing raw internal engine objects into a permanent database row is a liability: the
// recommendation engine's own evidence shape can change later, silently obsoleting every
// already-persisted row's copy of it. recommendationSnapshot (a small, cross-type-stable subset)
// replaces it as what actually reaches the database.
export function enrichDraftForPersistence(draft: OpportunityDraft, sessionMetadata: SessionMetadata, sessionStats: SessionStats): OpportunityDraft {
  const { citedRecommendations, ...restEvidence } = draft.evidence as Record<string, unknown> & { citedRecommendations?: MarketingRecommendation[] };
  return {
    ...draft,
    evidence: {
      ...restEvidence,
      ...sessionMetadata,
      recommendationSnapshot: buildRecommendationSnapshot(citedRecommendations ?? []),
      sessionStats,
    },
  };
}
