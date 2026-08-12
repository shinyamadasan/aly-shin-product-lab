import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  AI_TEXT_FAILURE_REASONS,
  isAiTextFailureReason,
  type AiTextFailureReason,
  type AiTextProvider,
  type AiTextRequest,
  type AiTextResult,
} from "../src/lib/ai/ai-text-provider.ts";

class FakeAiTextProvider implements AiTextProvider {
  readonly providerId: string;
  readonly receivedRequests: AiTextRequest[] = [];
  private readonly resultFor: (request: AiTextRequest, providerId: string) => AiTextResult;

  constructor(providerId: string, resultFor: (request: AiTextRequest, providerId: string) => AiTextResult) {
    this.providerId = providerId;
    this.resultFor = resultFor;
  }

  async generate(request: AiTextRequest): Promise<AiTextResult> {
    this.receivedRequests.push(request);
    return this.resultFor(request, this.providerId);
  }
}

function successProvider(options: { providerId?: string; model?: string | null; structuredValue?: unknown } = {}): FakeAiTextProvider {
  return new FakeAiTextProvider(options.providerId ?? "fake-provider", () => ({
    ok: true,
    text: "plain text response",
    structuredValue: options.structuredValue,
    metadata: {
      providerId: options.providerId ?? "fake-provider",
      model: options.model ?? null,
      durationMs: 12,
      usage: { inputTokens: 7, outputTokens: 3 },
    },
  }));
}

function failure(reason: AiTextFailureReason): AiTextResult {
  return {
    ok: false,
    reason,
    message: `classified as ${reason}`,
    metadata: { providerId: "fake-provider", model: "fake-model", durationMs: 9 },
    diagnostics: { safeDetail: "no provider secret or raw envelope required" },
  };
}

test("a provider can receive a text-only request", async () => {
  const provider = successProvider();
  const result = await provider.generate({ systemPrompt: "You are concise.", userPrompt: "Say hello." });

  assert.equal(result.ok, true);
  assert.deepEqual(provider.receivedRequests, [{ systemPrompt: "You are concise.", userPrompt: "Say hello." }]);
});

test("a provider can receive a structured-output request without knowing the schema domain", async () => {
  const provider = successProvider({ structuredValue: { answer: "yes" } });
  const request: AiTextRequest = {
    userPrompt: "Return an answer.",
    structuredOutput: {
      schemaName: "generic_answer",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["answer"],
        properties: { answer: { type: "string" } },
      },
    },
  };

  const result = await provider.generate(request);

  assert.equal(result.ok, true);
  assert.deepEqual(provider.receivedRequests[0], request);
  if (result.ok) assert.deepEqual(result.structuredValue, { answer: "yes" });
});

test("success exposes provider-neutral text and metadata", async () => {
  const result = await successProvider({ providerId: "provider-a", model: "model-a" }).generate({ userPrompt: "x", model: "model-a", timeoutMs: 1000 });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.text, "plain text response");
  assert.deepEqual(result.metadata, {
    providerId: "provider-a",
    model: "model-a",
    durationMs: 12,
    usage: { inputTokens: 7, outputTokens: 3 },
  });
});

test("all generic failure reasons are representable without provider-specific terminology", () => {
  assert.deepEqual([...AI_TEXT_FAILURE_REASONS], [
    "usage_limit",
    "authentication",
    "timeout",
    "provider_unavailable",
    "process_error",
    "malformed_response",
    "schema_invalid",
    "output_too_large",
    "cancelled",
    "configuration_error",
  ]);

  for (const reason of AI_TEXT_FAILURE_REASONS) {
    const result = failure(reason);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, reason);
      assert.equal(isAiTextFailureReason(reason), true);
      assert.doesNotMatch(result.reason, /claude|codex|anthropic|openai/i);
    }
  }
});

test("usage limits and authentication are not collapsed into process_error", () => {
  for (const reason of ["usage_limit", "authentication"] as const) {
    const result = failure(reason);
    assert.equal(result.ok, false);
    if (!result.ok) assert.notEqual(result.reason, "process_error");
  }
});

test("malformed_response and schema_invalid remain distinct for later one-retry policy", () => {
  const malformed = failure("malformed_response");
  const schemaInvalid = failure("schema_invalid");

  assert.equal(malformed.ok, false);
  assert.equal(schemaInvalid.ok, false);
  if (!malformed.ok && !schemaInvalid.ok) {
    assert.equal(malformed.reason, "malformed_response");
    assert.equal(schemaInvalid.reason, "schema_invalid");
  }
});

test("failure classification does not encode retry or fallback behavior", () => {
  const result = failure("usage_limit");

  assert.equal(result.ok, false);
  assert.equal("retryable" in result, false);
  assert.equal("fallbackProviderId" in result, false);
  assert.equal("retryAfterMs" in result, false);
});

test("provider metadata can carry providerId and model on success or failure", async () => {
  const success = await successProvider({ providerId: "provider-a", model: "model-a" }).generate({ userPrompt: "x" });
  const failed = failure("timeout");

  assert.equal(success.ok, true);
  if (success.ok) {
    assert.equal(success.metadata.providerId, "provider-a");
    assert.equal(success.metadata.model, "model-a");
  }
  assert.equal(failed.ok, false);
  if (!failed.ok) {
    assert.equal(failed.metadata?.providerId, "fake-provider");
    assert.equal(failed.metadata?.model, "fake-model");
  }
});

test("the same fake provider can service different arbitrary generic requests", async () => {
  const provider = new FakeAiTextProvider("fake-provider", (request, providerId) => ({
    ok: true,
    text: request.userPrompt,
    metadata: { providerId, model: request.model ?? null, durationMs: null },
  }));

  const first = await provider.generate({ userPrompt: "first" });
  const second = await provider.generate({ userPrompt: "second", model: "any-model" });

  assert.equal(first.ok && first.text, "first");
  assert.equal(second.ok && second.text, "second");
  assert.deepEqual(provider.receivedRequests.map((request) => request.userPrompt), ["first", "second"]);
});

test("the provider contract has no business-domain or provider-specific dependency", () => {
  const source = readFileSync(new URL("../src/lib/ai/ai-text-provider.ts", import.meta.url), "utf8");

  for (const forbidden of [
    /CreativeInput/,
    /Opportunity/,
    /Journey/,
    /BrandBible/,
    /CreativePackageContentV2/,
    /claudeModel/,
    /openAiModel/,
    /anthropicModel/,
    /ClaudeFailureReason/,
    /Codex/,
    /Anthropic/,
    /OpenAI/,
    /Supabase/,
    /process\.env/,
    /spawn\(/,
  ]) {
    assert.doesNotMatch(source, forbidden);
  }
});

test("the generic model hint is optional and provider-neutral", async () => {
  const provider = successProvider({ model: "reported-model" });
  const result = await provider.generate({ userPrompt: "x", model: "runtime-model-hint" });

  assert.equal(result.ok, true);
  assert.deepEqual(provider.receivedRequests[0], { userPrompt: "x", model: "runtime-model-hint" });
  if (result.ok) assert.equal(result.metadata.model, "reported-model");
});
