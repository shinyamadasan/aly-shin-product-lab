import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MARKETING_ADVISOR_MODES, MARKETING_ADVISOR_PROMPT_VERSION, buildMarketingAdvisorPrompt } from "../scripts/marketing-advisor/marketing-advisor-prompt.ts";
import { MAX_CITED_RECOMMENDATIONS_PER_SUGGESTION, MAX_REASON_LENGTH, MAX_SUGGESTIONS_PER_RESPONSE, MAX_TITLE_LENGTH } from "../src/lib/marketing-opportunity-suggestions.ts";
import { buildMarketingBrief, type MarketingBrief } from "../src/lib/marketing-brief.ts";
import { buildMarketingAdvisorContext } from "../src/lib/marketing-advisor-context.ts";
import { buildMarketingRecommendations } from "../src/lib/marketing-recommendations.ts";

const NOW = Date.parse("2026-07-30T09:00:00.000Z");

function brief(): MarketingBrief {
  const context = buildMarketingAdvisorContext({ products: [], ingredients: [], journal: [], now: NOW });
  return buildMarketingBrief(context, buildMarketingRecommendations(context));
}

test("MARKETING_ADVISOR_PROMPT_VERSION is the string-literal '1'", () => {
  assert.equal(MARKETING_ADVISOR_PROMPT_VERSION, "1");
});

test("mode defaults to opportunity_generation", () => {
  const theBrief = brief();
  assert.deepEqual(buildMarketingAdvisorPrompt(theBrief), buildMarketingAdvisorPrompt(theBrief, "opportunity_generation"));
});

test("rejects an unsupported mode at the type level -- MARKETING_ADVISOR_MODES has exactly one value today", () => {
  assert.deepEqual(MARKETING_ADVISOR_MODES, ["opportunity_generation"]);
});

test("system contains the real MAX_* bound values, not hand-typed duplicates", () => {
  const { system } = buildMarketingAdvisorPrompt(brief());
  assert.match(system, new RegExp(`at most ${MAX_SUGGESTIONS_PER_RESPONSE}`));
  assert.match(system, new RegExp(`1 and ${MAX_CITED_RECOMMENDATIONS_PER_SUGGESTION}`));
  assert.match(system, new RegExp(`at most ${MAX_TITLE_LENGTH} characters`));
  assert.match(system, new RegExp(`at most ${MAX_REASON_LENGTH} characters`));
});

test("system contains the real brief.generatedAt value verbatim", () => {
  const theBrief = brief();
  const { system } = buildMarketingAdvisorPrompt(theBrief);
  assert.match(system, new RegExp(theBrief.generatedAt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("system documents an empty suggestions array as a legitimate answer", () => {
  const { system } = buildMarketingAdvisorPrompt(brief());
  assert.match(system, /legitimate answer/i);
});

test("system forbids markdown code fences and extra prose", () => {
  const { system } = buildMarketingAdvisorPrompt(brief());
  assert.match(system, /no markdown code fences/i);
  assert.match(system, /ONLY a JSON object/);
});

test("user embeds the full Brief verbatim as JSON, not a condensed summary", () => {
  const theBrief = brief();
  const { user } = buildMarketingAdvisorPrompt(theBrief);
  assert.deepEqual(JSON.parse(user), theBrief);
});

test("is pure: identical input produces deepEqual output on a second call", () => {
  const theBrief = brief();
  assert.deepEqual(buildMarketingAdvisorPrompt(theBrief), buildMarketingAdvisorPrompt(theBrief));
});

test("marketing-advisor-prompt.ts and marketing-advisor-manual-export.ts make no network call and have no paid-provider coupling", () => {
  // "Claude Code" is the human tool marketing-advisor-manual-export.ts's export document
  // intentionally references (the same exception tests/manual-text-provider.test.ts already
  // establishes for the Creative Job text worker) -- what must never appear is a network call, an
  // API key read, or an OpenAI/Gemini/Anthropic-API reference.
  for (const file of ["../scripts/marketing-advisor/marketing-advisor-prompt.ts", "../scripts/marketing-advisor/marketing-advisor-manual-export.ts"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    for (const forbidden of [/@supabase\/supabase-js/i, /\bfetch\s*\(/, /Anthropic/i, /OpenAI/i, /Gemini/i, /ANTHROPIC_API_KEY/, /OPENAI_API_KEY/]) {
      assert.doesNotMatch(source, forbidden);
    }
  }
});
