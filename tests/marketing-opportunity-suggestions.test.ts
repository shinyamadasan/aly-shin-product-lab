import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  MAX_CITED_RECOMMENDATIONS_PER_SUGGESTION,
  MAX_REASON_LENGTH,
  MAX_SUGGESTIONS_PER_RESPONSE,
  MAX_TITLE_LENGTH,
  validateMarketingOpportunitySuggestions,
} from "../src/lib/marketing-opportunity-suggestions.ts";
import { buildMarketingBrief, type MarketingBrief } from "../src/lib/marketing-brief.ts";
import { buildMarketingAdvisorContext } from "../src/lib/marketing-advisor-context.ts";
import type { MarketingRecommendation } from "../src/lib/marketing-recommendations.ts";

const NOW = Date.parse("2026-07-30T09:00:00.000Z");
const RECOMMENDATION_IDS = ["a", "b", "c", "d", "e", "f"] as const;

function recommendation(id: string): MarketingRecommendation {
  return {
    id,
    recommendationType: "neglected_product",
    priority: 3,
    confidence: "high",
    title: `Feature ${id}`,
    explanation: `${id} hasn't appeared recently.`,
    suggestedNextAction: `Create content for ${id}.`,
    evidence: { productId: id, productName: id, entryCount: 1, lastCapturedDate: "2026-06-01", daysSinceLastCapture: 42, thresholdDays: 30 },
  };
}

function brief(): MarketingBrief {
  const context = buildMarketingAdvisorContext({ products: [], ingredients: [], journal: [], now: NOW });
  return buildMarketingBrief(context, RECOMMENDATION_IDS.map(recommendation));
}

function suggestion(overrides: Partial<{ title: string; reason: string; sourceRecommendationIds: string[] }> = {}) {
  return {
    title: "Feature Brownies This Weekend",
    reason: "Brownies haven't been marketed for 42 days.",
    sourceRecommendationIds: ["a"],
    ...overrides,
  };
}

function response(theBrief: MarketingBrief, suggestions: unknown[] = [suggestion()], overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    schemaVersion: "v1",
    metadata: { generatedFromBriefGeneratedAt: theBrief.generatedAt, generatorVersion: "1" },
    suggestions,
    ...overrides,
  });
}

test("accepts a well-formed v1 response whose sourceRecommendationIds all exist in the given brief", () => {
  const theBrief = brief();
  const result = validateMarketingOpportunitySuggestions(response(theBrief), theBrief);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.result.suggestions.length, 1);
  }
});

test("rejects invalid JSON", () => {
  const theBrief = brief();
  const result = validateMarketingOpportunitySuggestions("not json", theBrief);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "invalid-json");
});

test("rejects a non-object JSON value", () => {
  const theBrief = brief();
  const result = validateMarketingOpportunitySuggestions(JSON.stringify(["a", "b"]), theBrief);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "unsupported-schema-version");
});

test("rejects schemaVersion !== v1", () => {
  const theBrief = brief();
  const result = validateMarketingOpportunitySuggestions(response(theBrief, [suggestion()], { schemaVersion: "v2" }), theBrief);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "unsupported-schema-version");
});

test("rejects a mismatched generatedFromBriefGeneratedAt", () => {
  const theBrief = brief();
  const raw = JSON.stringify({
    schemaVersion: "v1",
    metadata: { generatedFromBriefGeneratedAt: "2020-01-01T00:00:00.000Z", generatorVersion: "1" },
    suggestions: [suggestion()],
  });
  const result = validateMarketingOpportunitySuggestions(raw, theBrief);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "malformed-metadata");
});

test("rejects generatorVersion !== 1", () => {
  const theBrief = brief();
  const raw = JSON.stringify({
    schemaVersion: "v1",
    metadata: { generatedFromBriefGeneratedAt: theBrief.generatedAt, generatorVersion: "2" },
    suggestions: [suggestion()],
  });
  const result = validateMarketingOpportunitySuggestions(raw, theBrief);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "malformed-metadata");
});

test("rejects a missing or empty title", () => {
  const theBrief = brief();
  const missing = validateMarketingOpportunitySuggestions(response(theBrief, [{ reason: "x", sourceRecommendationIds: ["a"] }]), theBrief);
  const empty = validateMarketingOpportunitySuggestions(response(theBrief, [suggestion({ title: "   " })]), theBrief);
  assert.equal(missing.ok, false);
  assert.equal(empty.ok, false);
  if (!missing.ok) assert.equal(missing.reason, "malformed-suggestion");
  if (!empty.ok) assert.equal(empty.reason, "malformed-suggestion");
});

test("rejects a missing or empty reason", () => {
  const theBrief = brief();
  const missing = validateMarketingOpportunitySuggestions(response(theBrief, [{ title: "x", sourceRecommendationIds: ["a"] }]), theBrief);
  const empty = validateMarketingOpportunitySuggestions(response(theBrief, [suggestion({ reason: "" })]), theBrief);
  assert.equal(missing.ok, false);
  assert.equal(empty.ok, false);
  if (!missing.ok) assert.equal(missing.reason, "malformed-suggestion");
  if (!empty.ok) assert.equal(empty.reason, "malformed-suggestion");
});

test("rejects an empty sourceRecommendationIds array", () => {
  const theBrief = brief();
  const result = validateMarketingOpportunitySuggestions(response(theBrief, [suggestion({ sourceRecommendationIds: [] })]), theBrief);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "malformed-suggestion");
});

test("rejects sourceRecommendationIds containing a duplicate value", () => {
  const theBrief = brief();
  const result = validateMarketingOpportunitySuggestions(response(theBrief, [suggestion({ sourceRecommendationIds: ["a", "a"] })]), theBrief);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "malformed-suggestion");
});

test("rejects a sourceRecommendationIds entry absent from brief.recommendations", () => {
  const theBrief = brief();
  const result = validateMarketingOpportunitySuggestions(response(theBrief, [suggestion({ sourceRecommendationIds: ["not-a-real-id"] })]), theBrief);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "unknown-recommendation-reference");
});

test("rejects a response with more than MAX_SUGGESTIONS_PER_RESPONSE suggestions", () => {
  const theBrief = brief();
  const suggestions = Array.from({ length: MAX_SUGGESTIONS_PER_RESPONSE + 1 }, () => suggestion());
  const result = validateMarketingOpportunitySuggestions(response(theBrief, suggestions), theBrief);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "malformed-suggestion");
});

test("rejects a suggestion citing more than MAX_CITED_RECOMMENDATIONS_PER_SUGGESTION recommendation ids", () => {
  const theBrief = brief();
  const tooMany = suggestion({ sourceRecommendationIds: RECOMMENDATION_IDS.slice(0, MAX_CITED_RECOMMENDATIONS_PER_SUGGESTION + 1) });
  const result = validateMarketingOpportunitySuggestions(response(theBrief, [tooMany]), theBrief);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "malformed-suggestion");
});

test("rejects a title longer than MAX_TITLE_LENGTH", () => {
  const theBrief = brief();
  const result = validateMarketingOpportunitySuggestions(response(theBrief, [suggestion({ title: "x".repeat(MAX_TITLE_LENGTH + 1) })]), theBrief);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "malformed-suggestion");
});

test("rejects a reason longer than MAX_REASON_LENGTH", () => {
  const theBrief = brief();
  const result = validateMarketingOpportunitySuggestions(response(theBrief, [suggestion({ reason: "x".repeat(MAX_REASON_LENGTH + 1) })]), theBrief);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "malformed-suggestion");
});

test("rejects two suggestions in the same response whose sorted-unique sourceRecommendationIds sets are identical", () => {
  const theBrief = brief();
  const first = suggestion({ sourceRecommendationIds: ["a", "b"] });
  const second = suggestion({ title: "A different title", sourceRecommendationIds: ["a", "b"] });
  const result = validateMarketingOpportunitySuggestions(response(theBrief, [first, second]), theBrief);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "duplicate-suggestion-identity");
});

test("rejects two suggestions citing the same set in a different order -- comparison is order-insensitive", () => {
  const theBrief = brief();
  const first = suggestion({ sourceRecommendationIds: ["a", "b"] });
  const second = suggestion({ sourceRecommendationIds: ["b", "a"] });
  const result = validateMarketingOpportunitySuggestions(response(theBrief, [first, second]), theBrief);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "duplicate-suggestion-identity");
});

test("accepts a padded title/reason and returns them trimmed in the validated result", () => {
  const theBrief = brief();
  const raw = response(theBrief, [
    suggestion({ title: "  Feature Brownies This Weekend  ", reason: "  Brownies haven't been marketed for 42 days.  " }),
  ]);
  const result = validateMarketingOpportunitySuggestions(raw, theBrief);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.result.suggestions[0].title, "Feature Brownies This Weekend");
    assert.equal(result.result.suggestions[0].reason, "Brownies haven't been marketed for 42 days.");
  }
});

test("accepts two suggestions in the same response whose sourceRecommendationIds sets genuinely differ", () => {
  const theBrief = brief();
  const first = suggestion({ sourceRecommendationIds: ["a", "b"] });
  const second = suggestion({ sourceRecommendationIds: ["a", "b", "c"] });
  const result = validateMarketingOpportunitySuggestions(response(theBrief, [first, second]), theBrief);
  assert.equal(result.ok, true);
});

test("accepts an empty suggestions array as valid", () => {
  const theBrief = brief();
  const result = validateMarketingOpportunitySuggestions(response(theBrief, []), theBrief);
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.result.suggestions, []);
});

test("is deterministic given the same raw/brief pair", () => {
  const theBrief = brief();
  const raw = response(theBrief);
  assert.deepEqual(validateMarketingOpportunitySuggestions(raw, theBrief), validateMarketingOpportunitySuggestions(raw, theBrief));
});

test("marketing-opportunity-suggestions.ts makes no network call and has no provider coupling", () => {
  const source = readFileSync(new URL("../src/lib/marketing-opportunity-suggestions.ts", import.meta.url), "utf8");
  for (const forbidden of [/@supabase\/supabase-js/i, /\bfetch\s*\(/, /Claude/i, /Anthropic/i, /OpenAI/i, /Gemini/i, /ANTHROPIC_API_KEY/, /OPENAI_API_KEY/]) {
    assert.doesNotMatch(source, forbidden);
  }
});
