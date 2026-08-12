import type { CreativeInput } from "../../src/lib/creative-input.ts";

export type ProductTextPrompt = {
  system: string;
  user: string;
};

const RESPONSE_CONTRACT =
  'Respond with ONLY a JSON object of the exact shape {"headline": "<string>", "caption": "<string>"} -- no markdown code fences, no extra prose, no explanation before or after the JSON.';

// Shared by both trusted execution adapters (manual export and the Anthropic API adapter) so
// there is exactly one prompt contract regardless of which one produces the content.
// Takes a CreativeInput as of S1. For an Opportunity-backed input this produces a BYTE-IDENTICAL
// prompt to the pre-S1 version -- subject is the Opportunity title, evidenceSummary its summary,
// reason its reason, productName its evidence product name. The request-backed branch adds the
// owner's verbatim words instead; no wording, model, or response contract changed.
export function buildProductTextPrompt(input: CreativeInput): ProductTextPrompt {
  const system = [
    "You are writing short marketing copy for a small home-based coffee and bakery business.",
    "You will be given a single business opportunity and must produce exactly one headline and one caption for one piece of product marketing content.",
    "Keep the tone warm and small-business-authentic, not corporate. Do not invent facts that are not present in the input.",
    RESPONSE_CONTRACT,
  ].join(" ");

  const userLines =
    input.origin.kind === "opportunity"
      ? [
          `Opportunity title: ${input.subject ?? ""}`,
          input.evidenceSummary ? `Summary: ${input.evidenceSummary}` : null,
          input.reason ? `Business reason: ${input.reason}` : null,
          input.productName ? `Product: ${input.productName}` : null,
        ]
      : [
          `Request: ${input.requestText ?? ""}`,
          input.subject ? `Subject: ${input.subject}` : null,
          input.productName ? `Product: ${input.productName}` : null,
        ];

  return { system, user: userLines.filter((line): line is string => Boolean(line)).join("\n") };
}
