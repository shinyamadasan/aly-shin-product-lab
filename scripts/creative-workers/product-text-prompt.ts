import type { OpportunityRecord } from "../../src/lib/opportunities.ts";

export type ProductTextPrompt = {
  system: string;
  user: string;
};

const RESPONSE_CONTRACT =
  'Respond with ONLY a JSON object of the exact shape {"headline": "<string>", "caption": "<string>"} -- no markdown code fences, no extra prose, no explanation before or after the JSON.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function extractProductName(evidence: unknown): string | null {
  if (!isRecord(evidence)) {
    return null;
  }
  const product = evidence.product;
  if (isRecord(product) && typeof product.name === "string" && product.name.trim().length > 0) {
    return product.name;
  }
  return null;
}

// Shared by both trusted execution adapters (manual export and the Anthropic API adapter) so
// there is exactly one prompt contract regardless of which one produces the content.
export function buildProductTextPrompt(opportunity: OpportunityRecord): ProductTextPrompt {
  const productName = extractProductName(opportunity.evidence);

  const system = [
    "You are writing short marketing copy for a small home-based coffee and bakery business.",
    "You will be given a single business opportunity and must produce exactly one headline and one caption for one piece of product marketing content.",
    "Keep the tone warm and small-business-authentic, not corporate. Do not invent facts that are not present in the input.",
    RESPONSE_CONTRACT,
  ].join(" ");

  const userLines = [
    `Opportunity title: ${opportunity.title}`,
    opportunity.summary ? `Summary: ${opportunity.summary}` : null,
    opportunity.reason ? `Business reason: ${opportunity.reason}` : null,
    productName ? `Product: ${productName}` : null,
  ].filter((line): line is string => Boolean(line));

  return { system, user: userLines.join("\n") };
}
