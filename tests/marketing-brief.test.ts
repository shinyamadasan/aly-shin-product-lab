import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildMarketingBrief } from "../src/lib/marketing-brief.ts";
import { buildMarketingAdvisorContext, type MarketingAdvisorContext } from "../src/lib/marketing-advisor-context.ts";
import type { MarketingRecommendation } from "../src/lib/marketing-recommendations.ts";

const NOW = Date.parse("2026-07-30T09:00:00.000Z");

function context(): MarketingAdvisorContext {
  return buildMarketingAdvisorContext({ products: [], ingredients: [], journal: [], now: NOW });
}

function recommendation(overrides: Partial<MarketingRecommendation> = {}): MarketingRecommendation {
  return {
    id: "neglected_product:brownies",
    recommendationType: "neglected_product",
    priority: 5,
    confidence: "high",
    title: "Feature Brownies again",
    explanation: "Brownies hasn't appeared in the Journey in 42 days.",
    suggestedNextAction: "Create new content featuring Brownies.",
    evidence: {
      productId: "brownies",
      productName: "Brownies",
      entryCount: 2,
      lastCapturedDate: "2026-06-18",
      daysSinceLastCapture: 42,
      thresholdDays: 30,
    },
    ...overrides,
  } as MarketingRecommendation;
}

test("buildMarketingBrief sets version to 1", () => {
  assert.equal(buildMarketingBrief(context(), []).version, 1);
});

test("buildMarketingBrief reuses context.generatedAt verbatim -- no new clock read", () => {
  const ctx = context();
  const brief = buildMarketingBrief(ctx, []);
  assert.equal(brief.generatedAt, ctx.generatedAt);
});

test("buildMarketingBrief embeds the full context object unfiltered", () => {
  const ctx = context();
  const brief = buildMarketingBrief(ctx, []);
  assert.deepEqual(brief.context, ctx);
});

test("buildMarketingBrief embeds the full recommendations array unfiltered", () => {
  const recommendations = [recommendation(), recommendation({ id: "expiring_ingredient:milk", recommendationType: "expiring_ingredient" })];
  const brief = buildMarketingBrief(context(), recommendations);
  assert.deepEqual(brief.recommendations, recommendations);
});

test("buildMarketingBrief is pure: identical input produces deepEqual output on a second call", () => {
  const ctx = context();
  const recommendations = [recommendation()];
  assert.deepEqual(buildMarketingBrief(ctx, recommendations), buildMarketingBrief(ctx, recommendations));
});

test("buildMarketingBrief does not mutate its inputs", () => {
  const ctx = context();
  const recommendations = [recommendation()];
  const ctxBefore = JSON.parse(JSON.stringify(ctx));
  const recommendationsBefore = JSON.parse(JSON.stringify(recommendations));

  buildMarketingBrief(ctx, recommendations);

  assert.deepEqual(ctx, ctxBefore);
  assert.deepEqual(recommendations, recommendationsBefore);
});

test("marketing-brief.ts makes no network call and has no provider coupling", () => {
  const source = readFileSync(new URL("../src/lib/marketing-brief.ts", import.meta.url), "utf8");
  for (const forbidden of [/@supabase\/supabase-js/i, /\bfetch\s*\(/, /Claude/i, /Anthropic/i, /OpenAI/i, /Gemini/i, /ANTHROPIC_API_KEY/, /OPENAI_API_KEY/]) {
    assert.doesNotMatch(source, forbidden);
  }
});
