import type { CreativeJobExecutor, CreativeJobResultEnvelope } from "../../src/lib/creative-jobs.ts";
import { buildProductTextPrompt } from "./product-text-prompt.ts";

// The one file in this milestone allowed to reference the provider by name or call fetch. Never
// imported by the manual path, and only reached by the CLI's explicit run-api subcommand.

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MODEL = "claude-haiku-4-5-20251001";
const DEFAULT_MAX_TOKENS = 300;

export type AnthropicProductTextProviderOptions = {
  apiKey: string;
  model?: string;
  maxTokens?: number;
  fetchImpl?: typeof fetch;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// Models sometimes wrap the requested JSON in a fenced code block despite instructions --
// stripped defensively before parsing rather than treated as a second output contract.
function extractJsonCandidate(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return (fenced ? fenced[1] : text).trim();
}

export function createAnthropicProductTextExecutor(options: AnthropicProductTextProviderOptions): CreativeJobExecutor {
  const fetchImpl = options.fetchImpl ?? fetch;
  const model = options.model ?? DEFAULT_MODEL;
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;

  return async (_job, opportunity, context) => {
    const prompt = buildProductTextPrompt(opportunity);

    const response = await fetchImpl(ANTHROPIC_API_URL, {
      method: "POST",
      signal: context.signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": options.apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        system: prompt.system,
        messages: [{ role: "user", content: prompt.user }],
      }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`Anthropic API request failed with status ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ""}.`);
    }

    const body = (await response.json()) as { content?: Array<{ type?: string; text?: string }> };
    const text = body.content?.find((block) => block.type === "text")?.text ?? body.content?.[0]?.text;
    if (typeof text !== "string" || text.trim().length === 0) {
      throw new Error("Anthropic API response did not include any text content.");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(extractJsonCandidate(text));
    } catch (err) {
      throw new Error(`Anthropic API response was not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (!isRecord(parsed)) {
      throw new Error("Anthropic API response JSON must be an object.");
    }

    const envelope: CreativeJobResultEnvelope = {
      schemaVersion: "v1",
      worker: "product_text_worker",
      output: {
        headline: typeof parsed.headline === "string" ? parsed.headline : "",
        caption: typeof parsed.caption === "string" ? parsed.caption : "",
      },
      metadata: {
        generatedFromOpportunity: opportunity.id,
        generatorVersion: "1",
      },
      artifacts: [],
    };

    return envelope;
  };
}
