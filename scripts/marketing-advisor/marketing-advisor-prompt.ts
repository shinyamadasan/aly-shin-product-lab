import { MAX_SUGGESTIONS_PER_RESPONSE, MAX_CITED_RECOMMENDATIONS_PER_SUGGESTION, MAX_TITLE_LENGTH, MAX_REASON_LENGTH } from "../../src/lib/marketing-opportunity-suggestions.ts";
import type { MarketingBrief } from "../../src/lib/marketing-brief.ts";

export const MARKETING_ADVISOR_MODES = ["opportunity_generation"] as const;
export type MarketingAdvisorMode = (typeof MARKETING_ADVISOR_MODES)[number];

// Bumped by hand whenever the prompt's wording/contract changes in a way worth distinguishing in
// a manifest later -- matches the string-literal "generatorVersion" convention already used for
// AI/boundary-crossing content (CreativeJobResultEnvelope, MarketingOpportunitySuggestionsResponse).
export const MARKETING_ADVISOR_PROMPT_VERSION = "1";

export type MarketingAdvisorPrompt = { system: string; user: string };

const RESPONSE_CONTRACT =
  'Respond with ONLY a JSON object of the exact shape {"schemaVersion":"v1","metadata":{"generatedFromBriefGeneratedAt":"<string>","generatorVersion":"1"},"suggestions":[{"title":"<string>","reason":"<string>","sourceRecommendationIds":["<string>"]}]} -- no markdown code fences, no extra prose, no explanation before or after the JSON.';

// The only implemented mode today. Cites real recommendations from the Brief and proposes
// grounded marketing opportunities -- nothing else. See marketing-advisor-manual-export.ts's own
// header comment for how the AI's title/reason are lifted into a real Opportunity afterward.
function buildOpportunityGenerationPrompt(brief: MarketingBrief): MarketingAdvisorPrompt {
  const bible = brief.context.brandBible;

  const system = [
    "You are the Marketing Advisor for a small home-based coffee and bakery business, running in mode: opportunity_generation.",
    `Mission: ${bible.mission}`,
    `Tone: ${bible.tone.join(", ")}.`,
    `Writing principles: ${bible.writingPrinciples.join(" ")}`,
    `Never write like this: ${bible.prohibitedPatterns.join(" | ")}`,
    "You will be given one Marketing Brief containing deterministic business context and a list of real, already-computed marketing recommendations. This is the only information you may use -- you have no access to Product Lab directly and must not invent facts, products, or recommendations that are not present in the Brief.",
    "You may only cite recommendation ids that appear in the Brief's \"recommendations\" array below; never invent one.",
    `Propose at most ${MAX_SUGGESTIONS_PER_RESPONSE} marketing opportunities. Each must cite between 1 and ${MAX_CITED_RECOMMENDATIONS_PER_SUGGESTION} real recommendation ids. Each title must be at most ${MAX_TITLE_LENGTH} characters; each reason at most ${MAX_REASON_LENGTH} characters.`,
    'An empty "suggestions" array is a legitimate answer if nothing in the Brief is worth surfacing today -- never fabricate a suggestion just to produce one.',
    `metadata.generatedFromBriefGeneratedAt must be exactly "${brief.generatedAt}" -- copy it verbatim, do not reformat it.`,
    RESPONSE_CONTRACT,
  ].join(" ");

  const user = JSON.stringify(brief, null, 2);

  return { system, user };
}

export function buildMarketingAdvisorPrompt(brief: MarketingBrief, mode: MarketingAdvisorMode = "opportunity_generation"): MarketingAdvisorPrompt {
  switch (mode) {
    case "opportunity_generation":
      return buildOpportunityGenerationPrompt(brief);
    default: {
      const exhaustiveCheck: never = mode;
      throw new Error(`Unhandled Marketing Advisor mode: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}
