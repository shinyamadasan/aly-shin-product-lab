import type { MarketingBrief } from "./marketing-brief.ts";

export const MAX_SUGGESTIONS_PER_RESPONSE = 10;
export const MAX_CITED_RECOMMENDATIONS_PER_SUGGESTION = 5;
export const MAX_TITLE_LENGTH = 120;
export const MAX_REASON_LENGTH = 600;

export type MarketingOpportunitySuggestion = {
  title: string;
  reason: string;
  sourceRecommendationIds: string[];
};

export type MarketingOpportunitySuggestionsResponse = {
  schemaVersion: "v1";
  metadata: {
    generatedFromBriefGeneratedAt: string;
    generatorVersion: "1";
  };
  suggestions: MarketingOpportunitySuggestion[];
};

export type MarketingOpportunitySuggestionsValidationResult =
  | { ok: true; result: MarketingOpportunitySuggestionsResponse }
  | {
      ok: false;
      reason:
        | "invalid-json"
        | "unsupported-schema-version"
        | "malformed-metadata"
        | "malformed-suggestion"
        | "unknown-recommendation-reference"
        | "duplicate-suggestion-identity";
      message: string;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function canonicalIdsOf(sourceRecommendationIds: string[]): string[] {
  return [...new Set(sourceRecommendationIds)].sort();
}

// Validates the AI's raw suggestion text BEFORE anything downstream (the lifter, §4) ever runs.
// Takes the raw string (not pre-parsed JSON) and the exact Brief being answered, mirroring
// parseManualProductTextResult's "text in, validated result out" shape. The anti-hallucination
// check (every cited id must exist in brief.recommendations) is the single most important rule
// here -- everything above it can be satisfied by a suggestion that is entirely invented.
export function validateMarketingOpportunitySuggestions(raw: string, brief: MarketingBrief): MarketingOpportunitySuggestionsValidationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      reason: "invalid-json",
      message: `Marketing Opportunity Suggestions response is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!isRecord(parsed)) {
    return { ok: false, reason: "unsupported-schema-version", message: "Marketing Opportunity Suggestions response must be a JSON object." };
  }
  if (parsed.schemaVersion !== "v1") {
    return { ok: false, reason: "unsupported-schema-version", message: "Marketing Opportunity Suggestions response schemaVersion must be v1." };
  }

  const metadata = parsed.metadata;
  if (
    !isRecord(metadata) ||
    metadata.generatorVersion !== "1" ||
    typeof metadata.generatedFromBriefGeneratedAt !== "string" ||
    metadata.generatedFromBriefGeneratedAt !== brief.generatedAt
  ) {
    return {
      ok: false,
      reason: "malformed-metadata",
      message: "Marketing Opportunity Suggestions response metadata must include generatorVersion 1 and a generatedFromBriefGeneratedAt matching the given Brief's generatedAt.",
    };
  }

  const suggestions = parsed.suggestions;
  if (!Array.isArray(suggestions)) {
    return { ok: false, reason: "malformed-suggestion", message: "Marketing Opportunity Suggestions response suggestions must be an array." };
  }
  if (suggestions.length > MAX_SUGGESTIONS_PER_RESPONSE) {
    return {
      ok: false,
      reason: "malformed-suggestion",
      message: `Marketing Opportunity Suggestions response must not contain more than ${MAX_SUGGESTIONS_PER_RESPONSE} suggestions.`,
    };
  }

  for (const suggestion of suggestions) {
    if (!isRecord(suggestion)) {
      return { ok: false, reason: "malformed-suggestion", message: "Every suggestion must be a JSON object." };
    }
    if (!isNonEmptyString(suggestion.title) || suggestion.title.length > MAX_TITLE_LENGTH) {
      return {
        ok: false,
        reason: "malformed-suggestion",
        message: `Every suggestion must include a non-empty title of at most ${MAX_TITLE_LENGTH} characters.`,
      };
    }
    if (!isNonEmptyString(suggestion.reason) || suggestion.reason.length > MAX_REASON_LENGTH) {
      return {
        ok: false,
        reason: "malformed-suggestion",
        message: `Every suggestion must include a non-empty reason of at most ${MAX_REASON_LENGTH} characters.`,
      };
    }

    const ids = suggestion.sourceRecommendationIds;
    if (!Array.isArray(ids) || ids.length === 0 || ids.some((id) => !isNonEmptyString(id))) {
      return {
        ok: false,
        reason: "malformed-suggestion",
        message: "Every suggestion must include a non-empty sourceRecommendationIds array of non-empty strings.",
      };
    }
    if (ids.length > MAX_CITED_RECOMMENDATIONS_PER_SUGGESTION) {
      return {
        ok: false,
        reason: "malformed-suggestion",
        message: `Every suggestion must cite at most ${MAX_CITED_RECOMMENDATIONS_PER_SUGGESTION} recommendations.`,
      };
    }
    if (ids.length !== new Set(ids).size) {
      return { ok: false, reason: "malformed-suggestion", message: "sourceRecommendationIds must not contain a duplicate value." };
    }
  }

  const typedSuggestions = suggestions as MarketingOpportunitySuggestion[];
  const recommendationIds = new Set(brief.recommendations.map((recommendation) => recommendation.id));

  for (const suggestion of typedSuggestions) {
    for (const id of suggestion.sourceRecommendationIds) {
      if (!recommendationIds.has(id)) {
        return {
          ok: false,
          reason: "unknown-recommendation-reference",
          message: `sourceRecommendationIds references an id not present in this Brief's recommendations: ${id}`,
        };
      }
    }
  }

  const seenIdentities = new Set<string>();
  for (const suggestion of typedSuggestions) {
    const identity = canonicalIdsOf(suggestion.sourceRecommendationIds).join("+");
    if (seenIdentities.has(identity)) {
      return {
        ok: false,
        reason: "duplicate-suggestion-identity",
        message: "Two or more suggestions in this response cite the identical set of recommendations.",
      };
    }
    seenIdentities.add(identity);
  }

  // Normalized once, here, so every downstream consumer (the lifter included) receives canonical
  // title/reason values -- never relies on validateOpportunityDraft to clean them up later.
  const canonicalResponse = parsed as unknown as MarketingOpportunitySuggestionsResponse;
  return {
    ok: true,
    result: {
      ...canonicalResponse,
      suggestions: typedSuggestions.map((suggestion) => ({ ...suggestion, title: suggestion.title.trim(), reason: suggestion.reason.trim() })),
    },
  };
}
