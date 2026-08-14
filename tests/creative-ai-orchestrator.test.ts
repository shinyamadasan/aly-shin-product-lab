import test from "node:test";
import assert from "node:assert/strict";

import type { AiTextProvider, AiTextRequest, AiTextResult, AiTextFailureReason } from "../src/lib/ai/ai-text-provider.ts";
import { buildCreativeInputFromRequest } from "../src/lib/creative-input.ts";
import type { CreativeFormat } from "../src/lib/creative-formats.ts";
import {
  CREATIVE_AI_CLAUDE_MODEL,
  CREATIVE_AI_CODEX_MODEL,
  buildDefaultCreativeAiRoutes,
  runCreativeGenerationWithProviders,
  type CreativeAiInvocationTraceEntry,
} from "../src/lib/creative-generation/ai-orchestrator.ts";
import type { CreativeGenerationContext } from "../src/lib/creative-generation/prompt.ts";
import { BRAND_BIBLE } from "../src/lib/marketing-advisor-context.ts";
import type { ResolvedCreativeGrounding } from "../src/lib/creative-subject-resolution.ts";

type FakeStep = AiTextResult | ((request: AiTextRequest) => AiTextResult);

class FakeProvider implements AiTextProvider {
  readonly providerId: string;
  readonly calls: AiTextRequest[] = [];
  private readonly steps: FakeStep[];

  constructor(providerId: string, steps: FakeStep[]) {
    this.providerId = providerId;
    this.steps = steps;
  }

  async generate(request: AiTextRequest): Promise<AiTextResult> {
    this.calls.push(request);
    const step = this.steps.shift();
    if (step === undefined) {
      return failure("process_error", this.providerId, request.model ?? null);
    }
    return typeof step === "function" ? step(request) : step;
  }
}

function success(providerId: string, model: string | null, structuredValue: unknown, durationMs = 5): AiTextResult {
  return { ok: true, text: JSON.stringify(structuredValue), structuredValue, metadata: { providerId, model, durationMs } };
}

function failure(reason: AiTextFailureReason, providerId: string, model: string | null, durationMs = 5): AiTextResult {
  return { ok: false, reason, message: reason, metadata: { providerId, model, durationMs } };
}

function formatDecision(format: CreativeFormat = "photo") {
  return { format, formatRationale: "Best fit for a simple product moment." };
}

function bodyFor(format: CreativeFormat = "photo"): Record<string, unknown> {
  const common = {
    angle: "A quiet blondie moment",
    hook: "Blondies, simply framed.",
    headline: "Blondies for the coffee pause",
    caption: "A calm kitchen moment with Blondies.",
    cta: "Save this idea for your next coffee break.",
    platformVariants: [{ platform: "instagram", caption: "Blondies and a coffee pause.", hashtags: ["#blondies"] }],
  };
  if (format === "photo") return { ...common, visualDirection: "Overhead phone photo on parchment.", overlayText: null, framing: "overhead" };
  if (format === "reel") {
    return {
      ...common,
      shots: [{ direction: "Pan across Blondies on parchment.", onScreenText: "coffee pause", approxSeconds: 4, framing: "medium", movement: "pan" }],
      spokenScript: null,
      audioDirection: "Soft upbeat audio.",
    };
  }
  if (format === "carousel") {
    return { ...common, slides: [{ heading: "Coffee pause", body: "A simple Blondies moment.", visualDirection: "Cover photo on parchment.", framing: "wide" }] };
  }
  return { ...common, frames: [{ visualDirection: "Blondies beside coffee.", text: "coffee pause", framing: "close_up", approxSeconds: null }], interaction: null };
}

function grounding(): ResolvedCreativeGrounding {
  return {
    subject: "Blondies",
    subjectKind: "product",
    subjectSource: "assumed",
    subjectGrounding: "Marketing recommendation: Blondies has never appeared in the Journey.",
    productId: "blondies",
    productName: "Blondies",
    supportingFacts: ["Blondies has never appeared in the Journey."],
  };
}

function context(formatHint: CreativeFormat | null = null): CreativeGenerationContext {
  return {
    creativeInput: buildCreativeInputFromRequest({ text: "make content for Blondies", formatHint }),
    grounding: grounding(),
    brandBible: BRAND_BIBLE,
  };
}

async function runWith(cl: FakeProvider, codex: FakeProvider, formatHint: CreativeFormat | null = null) {
  return runCreativeGenerationWithProviders(
    { context: context(formatHint), configuredPlatforms: ["instagram"] },
    { routes: buildDefaultCreativeAiRoutes({ claude: cl, codex }) },
  );
}

function stages(trace: CreativeAiInvocationTraceEntry[]) {
  return trace.map((entry) => `${entry.stage}:${entry.providerId}:${entry.outcome}:${entry.failureReason ?? "ok"}:${entry.action}`);
}

test("Claude success completes both stages and Codex is never called", async () => {
  const claude = new FakeProvider("claude-cli", [success("claude-cli", CREATIVE_AI_CLAUDE_MODEL, formatDecision()), success("claude-cli", CREATIVE_AI_CLAUDE_MODEL, bodyFor())]);
  const codex = new FakeProvider("codex-cli", []);

  const result = await runWith(claude, codex);

  assert.equal(result.ok, true);
  assert.equal(claude.calls.length, 2);
  assert.equal(codex.calls.length, 0);
  assert.deepEqual(stages(result.trace), ["format_decision:claude-cli:success:ok:accepted", "creative_body:claude-cli:success:ok:accepted"]);
});

test("approved Claude fallback failures move forward to Codex and preserve the failed trace", async () => {
  for (const reason of ["usage_limit", "provider_unavailable", "timeout", "authentication", "configuration_error", "output_too_large", "process_error"] as const) {
    const claude = new FakeProvider("claude-cli", [failure(reason, "claude-cli", CREATIVE_AI_CLAUDE_MODEL)]);
    const codex = new FakeProvider("codex-cli", [success("codex-cli", CREATIVE_AI_CODEX_MODEL, formatDecision()), success("codex-cli", CREATIVE_AI_CODEX_MODEL, bodyFor())]);

    const result = await runWith(claude, codex);

    assert.equal(result.ok, true, reason);
    assert.equal(claude.calls.length, 1, reason);
    assert.equal(codex.calls.length, 2, reason);
    assert.equal(result.trace[0].failureReason, reason);
    assert.equal(result.trace[0].action, "fallback");
    assert.equal(result.trace[1].providerId, "codex-cli");
  }
});

test("malformed/schema failures retry once on the same provider before fallback", async () => {
  for (const reason of ["malformed_response", "schema_invalid"] as const) {
    const claude = new FakeProvider("claude-cli", [failure(reason, "claude-cli", CREATIVE_AI_CLAUDE_MODEL), success("claude-cli", CREATIVE_AI_CLAUDE_MODEL, formatDecision()), success("claude-cli", CREATIVE_AI_CLAUDE_MODEL, bodyFor())]);
    const codex = new FakeProvider("codex-cli", []);

    const result = await runWith(claude, codex);

    assert.equal(result.ok, true, reason);
    assert.equal(claude.calls.length, 3, reason);
    assert.equal(codex.calls.length, 0, reason);
    assert.equal(result.trace[0].action, "retry_same_provider");
  }

  for (const reason of ["malformed_response", "schema_invalid"] as const) {
    const claude = new FakeProvider("claude-cli", [failure(reason, "claude-cli", CREATIVE_AI_CLAUDE_MODEL), failure(reason, "claude-cli", CREATIVE_AI_CLAUDE_MODEL)]);
    const codex = new FakeProvider("codex-cli", [success("codex-cli", CREATIVE_AI_CODEX_MODEL, formatDecision()), success("codex-cli", CREATIVE_AI_CODEX_MODEL, bodyFor())]);

    const result = await runWith(claude, codex);

    assert.equal(result.ok, true, reason);
    assert.equal(claude.calls.length, 2, reason);
    assert.equal(codex.calls.length, 2, reason);
    assert.equal(result.trace[0].action, "retry_same_provider", reason);
    assert.equal(result.trace[1].action, "fallback", reason);
  }
});

test("application validation rejection is schema_invalid and cannot accept wrong-format bodies", async () => {
  const badDecision = new FakeProvider("claude-cli", [
    success("claude-cli", CREATIVE_AI_CLAUDE_MODEL, { format: "poster", formatRationale: "Nope." }),
    success("claude-cli", CREATIVE_AI_CLAUDE_MODEL, formatDecision()),
    success("claude-cli", CREATIVE_AI_CLAUDE_MODEL, bodyFor()),
  ]);
  const codex = new FakeProvider("codex-cli", []);

  const decisionResult = await runWith(badDecision, codex);

  assert.equal(decisionResult.ok, true);
  assert.equal(decisionResult.trace[0].failureReason, "schema_invalid");
  assert.equal(decisionResult.trace[0].action, "retry_same_provider");

  const badBody = new FakeProvider("claude-cli", [
    success("claude-cli", CREATIVE_AI_CLAUDE_MODEL, formatDecision("photo")),
    success("claude-cli", CREATIVE_AI_CLAUDE_MODEL, bodyFor("reel")),
    success("claude-cli", CREATIVE_AI_CLAUDE_MODEL, bodyFor("photo")),
  ]);

  const bodyResult = await runWith(badBody, new FakeProvider("codex-cli", []));

  assert.equal(bodyResult.ok, true);
  assert.equal(bodyResult.trace[1].failureReason, "schema_invalid");
  assert.equal(bodyResult.trace[1].action, "retry_same_provider");
});

test("stage success is not rerun when the next stage falls back", async () => {
  const claude = new FakeProvider("claude-cli", [success("claude-cli", CREATIVE_AI_CLAUDE_MODEL, formatDecision()), failure("usage_limit", "claude-cli", CREATIVE_AI_CLAUDE_MODEL)]);
  const codex = new FakeProvider("codex-cli", [success("codex-cli", CREATIVE_AI_CODEX_MODEL, bodyFor())]);

  const result = await runWith(claude, codex);

  assert.equal(result.ok, true);
  assert.equal(claude.calls.length, 2);
  assert.equal(codex.calls.length, 1);
  assert.deepEqual(result.trace.map((entry) => entry.stage), ["format_decision", "creative_body", "creative_body"]);
});

test("fallback success makes Codex sticky for remaining stages", async () => {
  for (const claudeSteps of [
    [failure("usage_limit", "claude-cli", CREATIVE_AI_CLAUDE_MODEL)],
    [failure("malformed_response", "claude-cli", CREATIVE_AI_CLAUDE_MODEL), failure("malformed_response", "claude-cli", CREATIVE_AI_CLAUDE_MODEL)],
  ]) {
    const claude = new FakeProvider("claude-cli", claudeSteps);
    const codex = new FakeProvider("codex-cli", [success("codex-cli", CREATIVE_AI_CODEX_MODEL, formatDecision()), success("codex-cli", CREATIVE_AI_CODEX_MODEL, bodyFor())]);

    const result = await runWith(claude, codex);

    assert.equal(result.ok, true);
    assert.equal(result.trace.at(-1)?.providerId, "codex-cli");
    assert.equal(codex.calls.length, 2);
  }
});

test("formatHint skips format decision and routes only creative_body", async () => {
  const claude = new FakeProvider("claude-cli", [failure("usage_limit", "claude-cli", CREATIVE_AI_CLAUDE_MODEL)]);
  const codex = new FakeProvider("codex-cli", [success("codex-cli", CREATIVE_AI_CODEX_MODEL, bodyFor("photo"))]);

  const result = await runWith(claude, codex, "photo");

  assert.equal(result.ok, true);
  assert.equal(result.formatChosenBy, "user");
  assert.deepEqual(result.trace.map((entry) => entry.stage), ["creative_body", "creative_body"]);
});

test("routes pin provider-local models and preserve the canonical request across fallback", async () => {
  const claude = new FakeProvider("claude-cli", [
    (request) => {
      return failure("usage_limit", "claude-cli", request.model ?? null);
    },
  ]);
  const codex = new FakeProvider("codex-cli", [
    (request) => {
      return success("codex-cli", request.model ?? null, formatDecision());
    },
    success("codex-cli", CREATIVE_AI_CODEX_MODEL, bodyFor()),
  ]);

  const result = await runWith(claude, codex);

  assert.equal(result.ok, true);
  const claudeRequest = claude.calls[0];
  const codexRequest = codex.calls[0];
  assert.equal(claudeRequest?.model, CREATIVE_AI_CLAUDE_MODEL);
  assert.equal(codexRequest?.model, CREATIVE_AI_CODEX_MODEL);
  assert.notEqual(claudeRequest?.model, CREATIVE_AI_CODEX_MODEL);
  assert.notEqual(codexRequest?.model, CREATIVE_AI_CLAUDE_MODEL);
  assert.equal(claudeRequest?.systemPrompt, codexRequest?.systemPrompt);
  assert.equal(claudeRequest?.userPrompt, codexRequest?.userPrompt);
  assert.deepEqual(claudeRequest?.structuredOutput, codexRequest?.structuredOutput);
});

test("cancelled stops immediately with no fallback", async () => {
  const claude = new FakeProvider("claude-cli", [failure("cancelled", "claude-cli", CREATIVE_AI_CLAUDE_MODEL)]);
  const codex = new FakeProvider("codex-cli", [success("codex-cli", CREATIVE_AI_CODEX_MODEL, formatDecision())]);

  const result = await runWith(claude, codex);

  assert.equal(result.ok, false);
  assert.equal(result.reason, "cancelled");
  assert.equal(codex.calls.length, 0);
  assert.equal(result.trace[0].action, "stop");
});

test("invocation budgets are hard-bounded and exhausted providers return honest failure", async () => {
  const claude = new FakeProvider("claude-cli", [
    failure("malformed_response", "claude-cli", CREATIVE_AI_CLAUDE_MODEL),
    failure("malformed_response", "claude-cli", CREATIVE_AI_CLAUDE_MODEL),
  ]);
  const codex = new FakeProvider("codex-cli", [
    failure("malformed_response", "codex-cli", CREATIVE_AI_CODEX_MODEL),
    failure("malformed_response", "codex-cli", CREATIVE_AI_CODEX_MODEL),
  ]);

  const noHint = await runWith(claude, codex);

  assert.equal(noHint.ok, false);
  assert.equal(noHint.failedStage, "format_decision");
  assert.equal(noHint.trace.length, 4);
  assert.ok(noHint.trace.length <= 6);

  const hintedClaude = new FakeProvider("claude-cli", [
    failure("malformed_response", "claude-cli", CREATIVE_AI_CLAUDE_MODEL),
    failure("malformed_response", "claude-cli", CREATIVE_AI_CLAUDE_MODEL),
  ]);
  const hintedCodex = new FakeProvider("codex-cli", [
    failure("malformed_response", "codex-cli", CREATIVE_AI_CODEX_MODEL),
    failure("malformed_response", "codex-cli", CREATIVE_AI_CODEX_MODEL),
  ]);

  const hinted = await runWith(hintedClaude, hintedCodex, "photo");

  assert.equal(hinted.ok, false);
  assert.equal(hinted.failedStage, "creative_body");
  assert.equal(hinted.trace.length, 4);
  assert.ok(hinted.trace.length <= 4);
  assert.equal(Math.max(...hinted.trace.map((entry) => entry.providerInvocationNumber)), 2);
});
