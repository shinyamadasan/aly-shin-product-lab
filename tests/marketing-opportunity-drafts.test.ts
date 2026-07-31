import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildOpportunityDraftFromSuggestion, buildOpportunityDraftsFromSuggestions } from "../src/lib/marketing-opportunity-drafts.ts";
import { validateOpportunityDraft } from "../src/lib/opportunities.ts";
import { buildMarketingBrief, type MarketingBrief } from "../src/lib/marketing-brief.ts";
import { buildMarketingAdvisorContext } from "../src/lib/marketing-advisor-context.ts";
import { validateMarketingOpportunitySuggestions } from "../src/lib/marketing-opportunity-suggestions.ts";
import type { MarketingOpportunitySuggestion, MarketingOpportunitySuggestionsResponse } from "../src/lib/marketing-opportunity-suggestions.ts";
import type { MarketingRecommendation, RecommendationPriority } from "../src/lib/marketing-recommendations.ts";

const NOW = Date.parse("2026-07-30T09:00:00.000Z");
const BUSINESS_DATE = "2026-07-30";

function neglectedProduct(id: string, priority: RecommendationPriority = 5): MarketingRecommendation {
  return {
    id,
    recommendationType: "neglected_product",
    priority,
    confidence: "high",
    title: `Feature ${id}`,
    explanation: `${id} hasn't appeared in the Journey in 42 days.`,
    suggestedNextAction: `Create new content featuring ${id}.`,
    evidence: { productId: id, productName: id, entryCount: 2, lastCapturedDate: "2026-06-18", daysSinceLastCapture: 42, thresholdDays: 30 },
  };
}

function noMarketingHistory(id: string, priority: RecommendationPriority = 4): MarketingRecommendation {
  return {
    id,
    recommendationType: "no_marketing_history",
    priority,
    confidence: "high",
    title: `Introduce ${id}`,
    explanation: `${id} has never appeared in the Journey.`,
    suggestedNextAction: `Create an introductory piece of content for ${id}.`,
    evidence: { productId: id, productName: id, entryCount: 0 },
  };
}

function seasonalOpportunity(id: string, priority: RecommendationPriority = 4): MarketingRecommendation {
  return {
    id,
    recommendationType: "seasonal_opportunity",
    priority,
    confidence: "high",
    title: `Plan content for ${id}`,
    explanation: `${id} is 10 day(s) away (2026-08-09).`,
    suggestedNextAction: `Plan and produce seasonal content for ${id}.`,
    evidence: { holidayName: id, holidayDate: "2026-08-09", daysAway: 10, thresholdDays: 21 },
  };
}

function launchCandidateFollowUp(id: string, priority: RecommendationPriority = 3): MarketingRecommendation {
  return {
    id,
    recommendationType: "launch_candidate_follow_up",
    priority,
    confidence: "low",
    title: `Follow up on ${id}`,
    explanation: `${id} looks launch-ready but has little or no recent marketing activity.`,
    suggestedNextAction: `Create content following up on ${id}'s launch readiness.`,
    evidence: {
      productId: id,
      productName: id,
      status: "launch_candidate",
      decision: "Candidate",
      matchedOn: "both",
      entryCount: 0,
      daysSinceLastCapture: null,
      thresholdDays: 14,
      basis: 'product.status/decision is used as a proxy for "recently launched".',
    },
  };
}

function expiringIngredient(id: string, nearestExpirationDate: string, priority: RecommendationPriority = 3): MarketingRecommendation {
  return {
    id,
    recommendationType: "expiring_ingredient",
    priority,
    confidence: "medium",
    title: `Feature ${id} before it expires`,
    explanation: `${id} is expiring soon (${nearestExpirationDate}).`,
    suggestedNextAction: `Create content featuring a moment with ${id} before it's gone.`,
    evidence: { ingredientId: id, ingredientName: id, nearestExpirationDate, expirationStatus: "expires-soon", basis: "not linked to any product" },
  };
}

function brief(recommendations: MarketingRecommendation[]): MarketingBrief {
  const context = buildMarketingAdvisorContext({ products: [], ingredients: [], journal: [], now: NOW });
  return buildMarketingBrief(context, recommendations);
}

function suggestion(sourceRecommendationIds: string[], overrides: Partial<MarketingOpportunitySuggestion> = {}): MarketingOpportunitySuggestion {
  return {
    title: "Feature Brownies This Weekend",
    reason: "Brownies haven't been marketed for 42 days.",
    sourceRecommendationIds,
    ...overrides,
  };
}

// ---- Correctness proof: exercise the real, unmodified validateOpportunityDraft ----

test("buildOpportunityDraftFromSuggestion produces a draft that passes validateOpportunityDraft, one per recommendation type", () => {
  const fixtures: Array<[string, MarketingRecommendation]> = [
    ["neglected_product", neglectedProduct("neglected_product:brownies")],
    ["no_marketing_history", noMarketingHistory("no_marketing_history:cookies")],
    ["seasonal_opportunity", seasonalOpportunity("seasonal_opportunity:christmas")],
    ["launch_candidate_follow_up", launchCandidateFollowUp("launch_candidate_follow_up:muffins")],
    ["expiring_ingredient", expiringIngredient("expiring_ingredient:milk", "2026-08-15")],
  ];

  for (const [label, recommendation] of fixtures) {
    const theBrief = brief([recommendation]);
    const draft = buildOpportunityDraftFromSuggestion(suggestion([recommendation.id]), theBrief);
    const result = validateOpportunityDraft(draft);
    assert.equal(result.ok, true, `${label} draft failed validation: ${!result.ok ? result.errors.join(" ") : ""}`);
  }
});

test("buildOpportunityDraftFromSuggestion produces a draft that passes validateOpportunityDraft when citing 2+ recommendations at once", () => {
  const a = neglectedProduct("neglected_product:brownies");
  const b = seasonalOpportunity("seasonal_opportunity:christmas");
  const theBrief = brief([a, b]);
  const draft = buildOpportunityDraftFromSuggestion(suggestion([a.id, b.id]), theBrief);
  assert.equal(validateOpportunityDraft(draft).ok, true);
});

// ---- Canonicalization ----

test("sourceRuleIds equals the canonical sorted-unique recommendation-id set", () => {
  const a = neglectedProduct("b-rec");
  const b = seasonalOpportunity("a-rec");
  const theBrief = brief([a, b]);
  const draft = buildOpportunityDraftFromSuggestion(suggestion([a.id, b.id]), theBrief);
  assert.deepEqual(draft.sourceRuleIds, ["a-rec", "b-rec"]);
});

test("sourceFindings has one entry per cited recommendation, in canonical order, built from explanation/suggestedNextAction", () => {
  const a = neglectedProduct("b-rec");
  const b = seasonalOpportunity("a-rec");
  const theBrief = brief([a, b]);
  const draft = buildOpportunityDraftFromSuggestion(suggestion([a.id, b.id]), theBrief);
  assert.deepEqual(draft.sourceFindings, [
    { id: "a-rec", category: "seasonal_opportunity", severity: "high", passed: true, message: b.explanation, recommendation: b.suggestedNextAction },
    { id: "b-rec", category: "neglected_product", severity: "high", passed: true, message: a.explanation, recommendation: a.suggestedNextAction },
  ]);
});

test("the same recommendation set, cited in a different order, produces the same deduplicationKey, sourceId, and identically-ordered sourceFindings/supportingEvidence", () => {
  const a = neglectedProduct("a-rec");
  const b = seasonalOpportunity("b-rec");
  const theBrief = brief([a, b]);
  const forward = buildOpportunityDraftFromSuggestion(suggestion([a.id, b.id]), theBrief);
  const reversed = buildOpportunityDraftFromSuggestion(suggestion([b.id, a.id]), theBrief);

  assert.equal(forward.deduplicationKey, reversed.deduplicationKey);
  assert.equal(forward.sourceId, reversed.sourceId);
  assert.deepEqual(forward.sourceFindings, reversed.sourceFindings);
  assert.deepEqual((forward.evidence as Record<string, unknown>).supportingEvidence, (reversed.evidence as Record<string, unknown>).supportingEvidence);
});

// ---- expiresAt policy + the already-expired/expires-today clamp ----

test("expiresAt uses expiry_related when any cited recommendation is expiring_ingredient, else general_product_promotion", () => {
  const noIngredient = brief([neglectedProduct("neglected_product:brownies")]);
  const draftNoIngredient = buildOpportunityDraftFromSuggestion(suggestion(["neglected_product:brownies"]), noIngredient);
  assert.equal(Date.parse(draftNoIngredient.expiresAt) - Date.parse(draftNoIngredient.detectedAt), 72 * 60 * 60 * 1000);

  const withIngredient = brief([expiringIngredient("expiring_ingredient:milk", "2026-08-15")]);
  const draftWithIngredient = buildOpportunityDraftFromSuggestion(suggestion(["expiring_ingredient:milk"]), withIngredient);
  assert.equal(draftWithIngredient.expiresAt, "2026-08-15T23:59:59.999Z");
});

test("expiresAt is clamped to end of businessDate when the cited expiring_ingredient's nearestExpirationDate is already before businessDate", () => {
  const rec = expiringIngredient("expiring_ingredient:milk", "2026-07-25");
  const theBrief = brief([rec]);
  const draft = buildOpportunityDraftFromSuggestion(suggestion([rec.id]), theBrief);
  assert.equal(draft.expiresAt, `${BUSINESS_DATE}T23:59:59.999Z`);
  assert.equal(validateOpportunityDraft(draft).ok, true);
});

test("expiresAt is end of businessDate when the cited expiring_ingredient's nearestExpirationDate equals businessDate", () => {
  const rec = expiringIngredient("expiring_ingredient:milk", BUSINESS_DATE);
  const theBrief = brief([rec]);
  const draft = buildOpportunityDraftFromSuggestion(suggestion([rec.id]), theBrief);
  assert.equal(draft.expiresAt, `${BUSINESS_DATE}T23:59:59.999Z`);
  assert.equal(validateOpportunityDraft(draft).ok, true);
});

test("expiresAt is end of the cited expiring_ingredient's own date when it is after businessDate", () => {
  const rec = expiringIngredient("expiring_ingredient:milk", "2026-08-15");
  const theBrief = brief([rec]);
  const draft = buildOpportunityDraftFromSuggestion(suggestion([rec.id]), theBrief);
  assert.equal(draft.expiresAt, "2026-08-15T23:59:59.999Z");
  assert.equal(validateOpportunityDraft(draft).ok, true);
});

test("expiresAt selects the earliest nearestExpirationDate among multiple cited expiring_ingredient recommendations spanning expired/today/future, then clamps once", () => {
  const expired = expiringIngredient("expiring_ingredient:expired-item", "2026-07-20");
  const today = expiringIngredient("expiring_ingredient:today-item", BUSINESS_DATE);
  const future = expiringIngredient("expiring_ingredient:future-item", "2026-08-10");
  const theBrief = brief([expired, today, future]);
  const draft = buildOpportunityDraftFromSuggestion(suggestion([expired.id, today.id, future.id]), theBrief);
  assert.equal(draft.expiresAt, `${BUSINESS_DATE}T23:59:59.999Z`);
  assert.equal(validateOpportunityDraft(draft).ok, true);
});

test("every constructed draft satisfies expiresAt strictly after detectedAt, regardless of policy", () => {
  const cases: MarketingRecommendation[][] = [
    [neglectedProduct("neglected_product:brownies")],
    [expiringIngredient("expiring_ingredient:expired", "2026-07-01")],
    [expiringIngredient("expiring_ingredient:today", BUSINESS_DATE)],
    [expiringIngredient("expiring_ingredient:future", "2026-09-01")],
    [expiringIngredient("expiring_ingredient:a", "2026-07-01"), expiringIngredient("expiring_ingredient:b", "2026-09-01")],
  ];

  for (const recommendations of cases) {
    const theBrief = brief(recommendations);
    const draft = buildOpportunityDraftFromSuggestion(
      suggestion(recommendations.map((r) => r.id)),
      theBrief,
    );
    assert.ok(Date.parse(draft.expiresAt) > Date.parse(draft.detectedAt));
  }
});

// ---- Deduplication identity ----

test("different recommendation sets for the same underlying product produce different deduplicationKeys", () => {
  const neglected = neglectedProduct("neglected_product:brownies");
  const followUp = launchCandidateFollowUp("launch_candidate_follow_up:brownies");
  const theBrief = brief([neglected, followUp]);

  const onlyNeglected = buildOpportunityDraftFromSuggestion(suggestion([neglected.id]), theBrief);
  const both = buildOpportunityDraftFromSuggestion(suggestion([neglected.id, followUp.id]), theBrief);

  assert.notEqual(onlyNeglected.deduplicationKey, both.deduplicationKey);
});

test("different AI-authored titles for the same recommendation set preserve the same identity", () => {
  const a = neglectedProduct("neglected_product:brownies");
  const theBrief = brief([a]);
  const draft1 = buildOpportunityDraftFromSuggestion(suggestion([a.id], { title: "Feature Brownies", reason: "Reason A" }), theBrief);
  const draft2 = buildOpportunityDraftFromSuggestion(suggestion([a.id], { title: "Brownies Are Back", reason: "Reason B" }), theBrief);

  assert.equal(draft1.deduplicationKey, draft2.deduplicationKey);
  assert.equal(draft1.sourceId, draft2.sourceId);
});

test("deduplicationKey differs for two suggestions citing different underlying entities, and is identical across repeated calls", () => {
  const a = neglectedProduct("neglected_product:brownies");
  const b = neglectedProduct("neglected_product:cookies");
  const briefA = brief([a]);
  const briefB = brief([b]);
  const draftA = buildOpportunityDraftFromSuggestion(suggestion([a.id]), briefA);
  const draftB = buildOpportunityDraftFromSuggestion(suggestion([b.id]), briefB);
  assert.notEqual(draftA.deduplicationKey, draftB.deduplicationKey);

  const repeat = buildOpportunityDraftFromSuggestion(suggestion([a.id]), briefA);
  assert.equal(draftA.deduplicationKey, repeat.deduplicationKey);
});

// ---- Priority derivation ----

test("evidence.priority equals the cited recommendation's own priority when exactly one is cited", () => {
  const a = neglectedProduct("neglected_product:brownies", 5);
  const theBrief = brief([a]);
  const draft = buildOpportunityDraftFromSuggestion(suggestion([a.id]), theBrief);
  assert.equal((draft.evidence as Record<string, unknown>).priority, 5);
});

test("evidence.priority equals the maximum priority across cited recommendations", () => {
  const high = neglectedProduct("neglected_product:brownies", 5);
  const low = seasonalOpportunity("seasonal_opportunity:christmas", 3);
  const theBrief = brief([high, low]);
  const draft = buildOpportunityDraftFromSuggestion(suggestion([high.id, low.id]), theBrief);
  assert.equal((draft.evidence as Record<string, unknown>).priority, 5);
});

test("evidence.priority is never lower than any individual cited recommendation's own priority", () => {
  const combos: Array<[MarketingRecommendation, MarketingRecommendation]> = [
    [neglectedProduct("combo-a-1", 5), seasonalOpportunity("combo-a-2", 3)],
    [neglectedProduct("combo-b-1", 3), launchCandidateFollowUp("combo-b-2", 3)],
    [expiringIngredient("combo-c-1", "2026-08-01", 3), noMarketingHistory("combo-c-2", 4)],
  ];
  for (const [x, y] of combos) {
    const theBrief = brief([x, y]);
    const draft = buildOpportunityDraftFromSuggestion(suggestion([x.id, y.id]), theBrief);
    const priority = (draft.evidence as Record<string, unknown>).priority as number;
    assert.ok(priority >= x.priority && priority >= y.priority);
  }
});

// ---- Supporting evidence reconstruction ----

test("evidence.supportingEvidence has exactly one bullet per cited recommendation, in canonical order, containing the recommendation's own explanation verbatim", () => {
  const a = neglectedProduct("b-rec");
  const b = seasonalOpportunity("a-rec");
  const theBrief = brief([a, b]);
  const draft = buildOpportunityDraftFromSuggestion(suggestion([a.id, b.id]), theBrief);
  const supportingEvidence = (draft.evidence as Record<string, unknown>).supportingEvidence as string[];
  assert.equal(supportingEvidence.length, 2);
  assert.ok(supportingEvidence[0].includes(b.explanation));
  assert.ok(supportingEvidence[1].includes(a.explanation));
});

test("evidence.supportingEvidence never contains a string that isn't traceable to a cited recommendation's own fields", () => {
  const a = neglectedProduct("neglected_product:brownies");
  const theBrief = brief([a]);
  const draft = buildOpportunityDraftFromSuggestion(suggestion([a.id]), theBrief);
  const supportingEvidence = (draft.evidence as Record<string, unknown>).supportingEvidence as string[];
  for (const bullet of supportingEvidence) {
    assert.ok(bullet.includes(a.explanation));
  }
});

// ---- Title/reason normalization (trimmed at the validation boundary, upstream of the lifter) ----

test("the lifted draft uses trimmed title/reason, and evidence.aiReasoning is trimmed, when built from a validated suggestion", () => {
  const a = neglectedProduct("neglected_product:brownies");
  const theBrief = brief([a]);
  const raw = JSON.stringify({
    schemaVersion: "v1",
    metadata: { generatedFromBriefGeneratedAt: theBrief.generatedAt, generatorVersion: "1" },
    suggestions: [
      {
        title: "  Feature Brownies This Weekend  ",
        reason: "  Brownies haven't been marketed for 42 days.  ",
        sourceRecommendationIds: [a.id],
      },
    ],
  });

  const validation = validateMarketingOpportunitySuggestions(raw, theBrief);
  assert.equal(validation.ok, true);
  if (!validation.ok) return;

  const draft = buildOpportunityDraftFromSuggestion(validation.result.suggestions[0], theBrief);
  assert.equal(draft.title, "Feature Brownies This Weekend");
  assert.equal(draft.reason, "Brownies haven't been marketed for 42 days.");
  assert.equal((draft.evidence as Record<string, unknown>).aiReasoning, "Brownies haven't been marketed for 42 days.");
});

// ---- Remaining field mechanics ----

test("detectedAt equals brief.generatedAt, never a fresh clock read", () => {
  const a = neglectedProduct("neglected_product:brownies");
  const theBrief = brief([a]);
  const draft = buildOpportunityDraftFromSuggestion(suggestion([a.id]), theBrief);
  assert.equal(draft.detectedAt, theBrief.generatedAt);
});

test("evidence contains the full cited recommendation objects and an explicit aiReasoning field restating suggestion.reason", () => {
  const a = neglectedProduct("neglected_product:brownies");
  const theBrief = brief([a]);
  const theSuggestion = suggestion([a.id], { reason: "Brownies haven't been marketed in a while." });
  const draft = buildOpportunityDraftFromSuggestion(theSuggestion, theBrief);
  const evidence = draft.evidence as Record<string, unknown>;
  assert.equal(evidence.aiReasoning, theSuggestion.reason);
  assert.deepEqual(evidence.citedRecommendations, [a]);
});

test("buildOpportunityDraftsFromSuggestions produces one draft per suggestion, preserving order, including the empty-array case", () => {
  const a = neglectedProduct("neglected_product:brownies");
  const b = seasonalOpportunity("seasonal_opportunity:christmas");
  const theBrief = brief([a, b]);
  const response: MarketingOpportunitySuggestionsResponse = {
    schemaVersion: "v1",
    metadata: { generatedFromBriefGeneratedAt: theBrief.generatedAt, generatorVersion: "1" },
    suggestions: [suggestion([a.id], { title: "First" }), suggestion([b.id], { title: "Second" })],
  };
  const drafts = buildOpportunityDraftsFromSuggestions(response, theBrief);
  assert.equal(drafts.length, 2);
  assert.equal(drafts[0].title, "First");
  assert.equal(drafts[1].title, "Second");

  const emptyResponse: MarketingOpportunitySuggestionsResponse = { ...response, suggestions: [] };
  assert.deepEqual(buildOpportunityDraftsFromSuggestions(emptyResponse, theBrief), []);
});

// ---- Purity ----

test("buildOpportunityDraftFromSuggestion is pure and does not mutate its inputs", () => {
  const a = neglectedProduct("neglected_product:brownies");
  const theBrief = brief([a]);
  const theSuggestion = suggestion([a.id]);
  const suggestionBefore = JSON.parse(JSON.stringify(theSuggestion));
  const briefBefore = JSON.parse(JSON.stringify(theBrief));

  const first = buildOpportunityDraftFromSuggestion(theSuggestion, theBrief);
  const second = buildOpportunityDraftFromSuggestion(theSuggestion, theBrief);

  assert.deepEqual(first, second);
  assert.deepEqual(theSuggestion, suggestionBefore);
  assert.deepEqual(theBrief, briefBefore);
});

// ---- Scope guard ----

test("marketing-opportunity-drafts.ts makes no network call and has no provider coupling", () => {
  const source = readFileSync(new URL("../src/lib/marketing-opportunity-drafts.ts", import.meta.url), "utf8");
  for (const forbidden of [/@supabase\/supabase-js/i, /\bfetch\s*\(/, /Claude/i, /Anthropic/i, /OpenAI/i, /Gemini/i, /ANTHROPIC_API_KEY/, /OPENAI_API_KEY/]) {
    assert.doesNotMatch(source, forbidden);
  }
});
