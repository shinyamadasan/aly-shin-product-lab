import test from "node:test";
import assert from "node:assert/strict";

import type { AiTextFailureReason, AiTextProvider, AiTextRequest, AiTextResult } from "../src/lib/ai/ai-text-provider.ts";
import { buildCreativeInputFromRequest, type CreativeInput } from "../src/lib/creative-input.ts";
import type { CreativeFormat } from "../src/lib/creative-formats.ts";
import {
  CREATIVE_AI_CLAUDE_MODEL,
  CREATIVE_AI_CODEX_MODEL,
  buildDefaultCreativeAiRoutes,
} from "../src/lib/creative-generation/ai-orchestrator.ts";
import {
  createCreativeAiExecutor,
  summarizeCreativeAiCompatibility,
  type CreativeAiGroundingInputs,
} from "../src/lib/creative-generation/creative-ai-executor.ts";
import {
  CREATIVE_AI_EXECUTOR_TIMEOUT_MS,
  executorTimeoutMsFor,
  fromCreativeJobRow,
  isCreativeJobExecutorFailure,
  isCreativeJobResultEnvelopeV2,
  validateCreativeJobResultEnvelopeV2,
  type CreativeJobRecord,
} from "../src/lib/creative-jobs.ts";
import { validateCreativePackageContentV2 } from "../src/lib/creative-packages.ts";
import { deriveConfiguredPlatforms } from "../src/lib/creative-configured-platforms.ts";
import { BRAND_BIBLE } from "../src/lib/marketing-advisor-context.ts";
import type { MarketingRecommendation } from "../src/lib/marketing-recommendations.ts";
import type { ContentJournalEntry, Product } from "../src/lib/product-lab-types.ts";

// --- fake providers -----------------------------------------------------------------------------
//
// Same shape the S3C-D orchestrator tests already use. No real CLI is ever spawned by this file.

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
      return { ok: false, reason: "process_error", message: "no step", metadata: { providerId: this.providerId, model: request.model ?? null, durationMs: 1 } };
    }
    return typeof step === "function" ? step(request) : step;
  }
}

function aiSuccess(providerId: string, model: string | null, structuredValue: unknown, durationMs = 5): AiTextResult {
  return { ok: true, text: JSON.stringify(structuredValue), structuredValue, metadata: { providerId, model, durationMs } };
}

function aiFailure(reason: AiTextFailureReason, providerId: string, model: string | null, durationMs = 5): AiTextResult {
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
  if (format === "photo") return { ...common, visualDirection: "Overhead phone photo on parchment.", overlayText: null };
  if (format === "reel") {
    return {
      ...common,
      shots: [{ direction: "Pan across Blondies on parchment.", onScreenText: "coffee pause" }],
      spokenScript: null,
      audioDirection: "Soft upbeat audio.",
      targetDurationSeconds: 12,
    };
  }
  if (format === "carousel") {
    return { ...common, slides: [{ heading: "Coffee pause", body: "A simple Blondies moment.", visualDirection: "Cover photo on parchment." }] };
  }
  return { ...common, frames: [{ visualDirection: "Blondies beside coffee.", text: "coffee pause" }], interaction: null };
}

// --- grounding fixtures -------------------------------------------------------------------------

function product(overrides: Partial<Product> = {}): Product {
  return {
    id: "blondies",
    name: "Blondies",
    category: "Bars",
    role: "Hero candidate",
    status: "testing",
    description: "",
    image: "",
    decision: "Needs proof",
    isPublic: false,
    ...overrides,
  };
}

// A real qualifying recommendation shape -- productId + productName on the evidence is exactly what
// S3A's own qualification rule looks for.
function recommendation(): MarketingRecommendation {
  return {
    id: "no_marketing_history:blondies",
    recommendationType: "no_marketing_history",
    priority: 1,
    confidence: "high",
    title: "Introduce Blondies in content",
    explanation: "Blondies has never appeared in the Journey.",
    suggestedNextAction: "Feature Blondies in a post.",
    evidence: { productId: "blondies", productName: "Blondies", entryCount: 0 },
  };
}

function journalEntry(overrides: Partial<ContentJournalEntry> = {}): ContentJournalEntry {
  return {
    id: "journal-1",
    entryDate: "2026-08-10",
    productId: "blondies",
    whatWasMade: "Tested a third batch with browner butter",
    mediaCaptured: "",
    lessonLearned: "",
    postIdeas: "",
    nextAction: "",
    ...overrides,
  };
}

const NOW = Date.parse("2026-08-13T10:00:00.000Z");

function grounding(overrides: Partial<CreativeAiGroundingInputs> = {}): CreativeAiGroundingInputs {
  return {
    recommendations: [recommendation()],
    journal: [journalEntry()],
    products: [product()],
    brandBible: BRAND_BIBLE,
    configuredPlatforms: ["instagram"],
    ...overrides,
  };
}

function jobRecord(overrides: Partial<CreativeJobRecord> = {}): CreativeJobRecord {
  return {
    ...fromCreativeJobRow({
      id: "job-1",
      opportunity_id: null,
      intent: { schemaVersion: "v1", text: "Give me something easy today" },
      status: "running",
      worker_type: "creative_ai",
      attempt_count: 1,
      result: {},
      last_error: null,
      created_at: "2026-08-13T09:00:00.000Z",
      updated_at: "2026-08-13T09:30:00.000Z",
      started_at: "2026-08-13T09:30:00.000Z",
    }),
    ...overrides,
  };
}

function requestInput(request: { text: string; subject?: string | null; formatHint?: CreativeFormat | null } ): CreativeInput {
  return buildCreativeInputFromRequest({ text: request.text, subject: request.subject ?? null, formatHint: request.formatHint ?? null });
}

// Builds the executor with fake providers wired through the REAL route builder, so route ordering
// and model assignment are the shipped ones, not a test-local imitation.
function makeExecutor(options: {
  claudeSteps: FakeStep[];
  codexSteps?: FakeStep[];
  groundingInputs?: CreativeAiGroundingInputs;
  loadGrounding?: (input: CreativeInput) => Promise<CreativeAiGroundingInputs>;
}) {
  const claude = new FakeProvider("claude-cli", options.claudeSteps);
  const codex = new FakeProvider("codex-cli", options.codexSteps ?? []);
  const seenInputs: CreativeInput[] = [];

  const executor = createCreativeAiExecutor({
    routes: buildDefaultCreativeAiRoutes({ claude, codex }),
    now: () => NOW,
    loadGrounding:
      options.loadGrounding ??
      (async (input) => {
        seenInputs.push(input);
        return options.groundingInputs ?? grounding();
      }),
  });

  return { executor, claude, codex, seenInputs };
}

const noSignal = { signal: new AbortController().signal };

// --- §22 executor success -----------------------------------------------------------------------

test("A-I. a request-backed job with no Opportunity reaches S3A, S3C-D, assembly and a valid v2 envelope", async () => {
  const { executor, claude, codex, seenInputs } = makeExecutor({
    claudeSteps: [
      aiSuccess("claude-cli", CREATIVE_AI_CLAUDE_MODEL, formatDecision("photo")),
      aiSuccess("claude-cli", CREATIVE_AI_CLAUDE_MODEL, bodyFor("photo")),
    ],
  });

  const input = requestInput({ text: "Give me something easy today" });
  const result = await executor(jobRecord(), input, noSignal);

  // A. no Opportunity anywhere on the path.
  assert.equal(input.origin.kind, "user_request");
  assert.equal(seenInputs.length, 1);
  assert.equal(seenInputs[0].origin.kind, "user_request");

  // D. S3C-D was actually invoked -- two stages, on the first route.
  assert.equal(claude.calls.length, 2);
  assert.equal(codex.calls.length, 0);

  // G. the result is a v2 result envelope, and it validates as one.
  assert.ok(isCreativeJobResultEnvelopeV2(result));
  const envelope = validateCreativeJobResultEnvelopeV2(result);
  assert.equal(envelope.ok, true);
  if (!envelope.ok) return;
  assert.equal(envelope.result.worker, "creative_ai");

  // B + C. the REAL S3A resolver ran over the supplied grounding: no subject was stated, so the
  // qualifying recommendation supplied it, with the engine's own explanation as the grounding.
  assert.equal(envelope.result.content.subject, "Blondies");
  assert.equal(envelope.result.content.metadata.subjectSource, "assumed");
  assert.equal(envelope.result.content.metadata.subjectGrounding, "Marketing recommendation: Blondies has never appeared in the Journey.");

  // F. final S2 validation passes on the assembled content.
  assert.equal(validateCreativePackageContentV2(envelope.result.content).ok, true);
  assert.equal(envelope.result.content.metadata.generatedFromOpportunity, null);
  assert.equal(envelope.result.content.metadata.sourceCreativeJobId, "job-1");
  assert.equal(envelope.result.content.metadata.sourceWorker, "creative_ai");
  assert.equal(envelope.result.content.metadata.formatChosenBy, "ai");

  // H. the trace survived, with both stages.
  assert.equal(envelope.result.executionTrace.length, 2);
  assert.deepEqual(envelope.result.executionTrace.map((entry) => entry.stage), ["format_decision", "creative_body"]);

  // I. and none of it leaked into package content.
  assert.equal("executionTrace" in (envelope.result.content as Record<string, unknown>), false);
  assert.equal(JSON.stringify(envelope.result.content).includes("claude-cli"), false);
});

test("a stated subject still wins over a qualifying recommendation", async () => {
  const { executor } = makeExecutor({
    claudeSteps: [
      aiSuccess("claude-cli", CREATIVE_AI_CLAUDE_MODEL, formatDecision("photo")),
      aiSuccess("claude-cli", CREATIVE_AI_CLAUDE_MODEL, bodyFor("photo")),
    ],
  });

  // The recommendation names Blondies; the owner named something else. S3A's frozen order says the
  // stated subject wins outright, and the executor must not reinterpret that.
  const result = await executor(jobRecord(), requestInput({ text: "post about the sourdough", subject: "Sourdough loaf" }), noSignal);

  const envelope = validateCreativeJobResultEnvelopeV2(result);
  assert.equal(envelope.ok, true);
  if (!envelope.ok) return;
  assert.equal(envelope.result.content.subject, "Sourdough loaf");
  assert.equal(envelope.result.content.metadata.subjectSource, "stated");
  assert.equal(envelope.result.content.metadata.subjectGrounding, null);
});

test("an Opportunity-backed input converges on the same executor and records its Opportunity", async () => {
  const { executor } = makeExecutor({
    claudeSteps: [
      aiSuccess("claude-cli", CREATIVE_AI_CLAUDE_MODEL, formatDecision("photo")),
      aiSuccess("claude-cli", CREATIVE_AI_CLAUDE_MODEL, bodyFor("photo")),
    ],
  });

  const opportunityInput: CreativeInput = {
    subject: "Brownies",
    requestText: null,
    reason: "Rule Engine evidence supports creating marketing content.",
    evidenceSummary: "Brownies has enough proof for a marketing content Opportunity.",
    productName: "Brownies",
    productId: "brownies",
    formatHint: null,
    origin: { kind: "opportunity", opportunityId: "opportunity-1" },
  };

  const result = await executor(jobRecord(), opportunityInput, noSignal);

  const envelope = validateCreativeJobResultEnvelopeV2(result);
  assert.equal(envelope.ok, true);
  if (!envelope.ok) return;
  // Same worker, same envelope version, same assembly path -- only the recorded origin differs.
  assert.equal(envelope.result.worker, "creative_ai");
  assert.equal(envelope.result.content.subject, "Brownies");
  assert.equal(envelope.result.content.metadata.generatedFromOpportunity, "opportunity-1");
});

// --- §26 format hint ----------------------------------------------------------------------------

test("a stated formatHint skips the format-decision AI call entirely and produces that format", async () => {
  const { executor, claude } = makeExecutor({
    // Exactly ONE step: if the executor made a format-decision call, this body step would be
    // consumed by it and the run would fail. Passing proves no decision call happened.
    claudeSteps: [aiSuccess("claude-cli", CREATIVE_AI_CLAUDE_MODEL, bodyFor("reel"))],
  });

  const result = await executor(jobRecord(), requestInput({ text: "make a reel", formatHint: "reel" }), noSignal);

  assert.equal(claude.calls.length, 1, "a hinted format must cost exactly one AI invocation");

  const envelope = validateCreativeJobResultEnvelopeV2(result);
  assert.equal(envelope.ok, true);
  if (!envelope.ok) return;
  assert.equal(envelope.result.content.format, "reel");
  assert.equal(envelope.result.content.metadata.formatChosenBy, "user");

  // The trace contains only real invocations -- no synthetic entry for the decision that never ran.
  assert.equal(envelope.result.executionTrace.length, 1);
  assert.equal(envelope.result.executionTrace[0].stage, "creative_body");
});

// --- §23 + §25 expected failure and mixed-provider trace ----------------------------------------

test("provider exhaustion returns a structured expected failure WITH its trace, without throwing", async () => {
  const { executor, claude, codex } = makeExecutor({
    claudeSteps: [aiFailure("usage_limit", "claude-cli", CREATIVE_AI_CLAUDE_MODEL)],
    codexSteps: [aiFailure("usage_limit", "codex-cli", CREATIVE_AI_CODEX_MODEL)],
  });

  // Deliberately NOT wrapped in assert.rejects: an expected AI outcome must not throw.
  const result = await executor(jobRecord(), requestInput({ text: "Give me something easy today" }), noSignal);

  assert.ok(isCreativeJobExecutorFailure(result));
  if (!isCreativeJobExecutorFailure(result)) return;
  assert.equal(result.attemptOutcome, "failed");
  assert.equal(result.code, "ai_usage_limit");
  assert.match(result.message, /format_decision/);
  assert.equal(result.executionTrace.length, 2);
  assert.deepEqual(result.executionTrace.map((entry) => entry.providerId), ["claude-cli", "codex-cli"]);
  assert.deepEqual(result.executionTrace.map((entry) => entry.failureReason), ["usage_limit", "usage_limit"]);

  // It is not mistaken for a result envelope.
  assert.equal(isCreativeJobResultEnvelopeV2(result), false);
  assert.equal(claude.calls.length, 1);
  assert.equal(codex.calls.length, 1);
});

test("a mixed-provider run succeeds and preserves all three invocations, summarizing as the accepted body's model", async () => {
  const { executor } = makeExecutor({
    claudeSteps: [
      aiSuccess("claude-cli", CREATIVE_AI_CLAUDE_MODEL, formatDecision("photo"), 1200),
      aiFailure("usage_limit", "claude-cli", CREATIVE_AI_CLAUDE_MODEL, 300),
    ],
    codexSteps: [aiSuccess("codex-cli", CREATIVE_AI_CODEX_MODEL, bodyFor("photo"), 2400)],
  });

  const result = await executor(jobRecord(), requestInput({ text: "Give me something easy today" }), noSignal);

  const envelope = validateCreativeJobResultEnvelopeV2(result);
  assert.equal(envelope.ok, true);
  if (!envelope.ok) return;

  assert.deepEqual(
    envelope.result.executionTrace.map((entry) => `${entry.stage}:${entry.providerId}:${entry.model}:${entry.action}`),
    [
      `format_decision:claude-cli:${CREATIVE_AI_CLAUDE_MODEL}:accepted`,
      `creative_body:claude-cli:${CREATIVE_AI_CLAUDE_MODEL}:fallback`,
      `creative_body:codex-cli:${CREATIVE_AI_CODEX_MODEL}:accepted`,
    ],
  );

  // §16: the compatibility summary is the model that authored the BODY, not the first provider and
  // not the last invocation regardless of stage.
  assert.deepEqual(summarizeCreativeAiCompatibility(envelope.result.executionTrace), {
    provider: "codex-cli",
    model: CREATIVE_AI_CODEX_MODEL,
  });
});

test("summarizeCreativeAiCompatibility refuses to name a model when no creative body was accepted", () => {
  // A failed run: a format decision was accepted, but no body ever was. Naming claude-cli here
  // would credit a model with authoring content it never produced.
  assert.equal(
    summarizeCreativeAiCompatibility([
      { stage: "format_decision", providerId: "claude-cli", model: "opus", invocationNumber: 1, providerInvocationNumber: 1, outcome: "success", durationMs: 10, action: "accepted" },
      { stage: "creative_body", providerId: "claude-cli", model: "opus", invocationNumber: 2, providerInvocationNumber: 2, outcome: "failure", failureReason: "usage_limit", durationMs: 10, action: "fallback" },
    ]),
    null,
  );
  assert.equal(summarizeCreativeAiCompatibility([]), null);
});

test("an AI timeout is reported as timed_out, other AI failures as failed", async () => {
  const timedOut = makeExecutor({
    claudeSteps: [aiFailure("timeout", "claude-cli", CREATIVE_AI_CLAUDE_MODEL)],
    codexSteps: [aiFailure("timeout", "codex-cli", CREATIVE_AI_CODEX_MODEL)],
  });
  const timeoutResult = await timedOut.executor(jobRecord(), requestInput({ text: "easy today" }), noSignal);
  assert.ok(isCreativeJobExecutorFailure(timeoutResult));
  assert.equal(isCreativeJobExecutorFailure(timeoutResult) && timeoutResult.attemptOutcome, "timed_out");

  const unavailable = makeExecutor({
    claudeSteps: [aiFailure("provider_unavailable", "claude-cli", CREATIVE_AI_CLAUDE_MODEL)],
    codexSteps: [aiFailure("provider_unavailable", "codex-cli", CREATIVE_AI_CODEX_MODEL)],
  });
  const unavailableResult = await unavailable.executor(jobRecord(), requestInput({ text: "easy today" }), noSignal);
  assert.equal(isCreativeJobExecutorFailure(unavailableResult) && unavailableResult.attemptOutcome, "failed");
});

test("unusable model output after retries and fallback is an expected failure carrying its full trace, not a package", async () => {
  // The reachable version of "the AI answered but the answer was no good": a body for the wrong
  // format fails schema validation, is retried on the same provider, then falls back -- and the
  // fallback fails the same way. Four real invocations, one honest failure, no package.
  //
  // (assembleCreativePackageV2's own guards are defensive rather than reachable from here: the
  // orchestrator has already run validateCreativeBody, and a hinted format is what BUILDS the
  // decision, so body-malformed and format-mismatch cannot occur downstream of it. Those branches
  // are covered by S3B's assembler tests, not faked into existence here.)
  const wrongFormatBody = bodyFor("reel");
  const { executor, claude, codex } = makeExecutor({
    claudeSteps: [aiSuccess("claude-cli", CREATIVE_AI_CLAUDE_MODEL, wrongFormatBody), aiSuccess("claude-cli", CREATIVE_AI_CLAUDE_MODEL, wrongFormatBody)],
    codexSteps: [aiSuccess("codex-cli", CREATIVE_AI_CODEX_MODEL, wrongFormatBody), aiSuccess("codex-cli", CREATIVE_AI_CODEX_MODEL, wrongFormatBody)],
  });

  const result = await executor(jobRecord(), requestInput({ text: "a photo please", formatHint: "photo" }), noSignal);

  assert.ok(isCreativeJobExecutorFailure(result));
  if (!isCreativeJobExecutorFailure(result)) return;
  assert.equal(result.code, "ai_schema_invalid");
  assert.equal(result.attemptOutcome, "failed");
  assert.equal(claude.calls.length, 2, "one retry on the first provider");
  assert.equal(codex.calls.length, 2, "then the same on the fallback");
  assert.equal(result.executionTrace.length, 4, "every real invocation is preserved, including the failed ones");
  assert.deepEqual(result.executionTrace.map((entry) => entry.action), ["retry_same_provider", "fallback", "retry_same_provider", "stop"]);
});

// --- §24 unexpected failure ---------------------------------------------------------------------

test("a genuine infrastructure exception still throws instead of being disguised as an AI failure", async () => {
  const { executor } = makeExecutor({
    claudeSteps: [],
    loadGrounding: async () => {
      throw new Error("Creative AI grounding read failed: connection refused");
    },
  });

  // Nothing was attempted and there is no trace -- turning this into an "expected AI failure" would
  // misreport a broken database as routine provider exhaustion.
  await assert.rejects(() => Promise.resolve(executor(jobRecord(), requestInput({ text: "easy today" }), noSignal)), /connection refused/);
});

// --- §27 platform derivation --------------------------------------------------------------------

test("configuredPlatforms is derived only from real Brand Presence configuration", () => {
  const empty = { facebookHandle: "", facebookUrl: "", instagramHandle: "", instagramUrl: "", tiktokHandle: "", tiktokUrl: "" };

  // No brand profile at all, and a profile with nothing configured, both mean "nothing known".
  assert.deepEqual(deriveConfiguredPlatforms(null), []);
  assert.deepEqual(deriveConfiguredPlatforms(empty), []);
  // Whitespace is not configuration.
  assert.deepEqual(deriveConfiguredPlatforms({ ...empty, instagramHandle: "   " }), []);

  assert.deepEqual(deriveConfiguredPlatforms({ ...empty, facebookHandle: "Aly & Pon" }), ["facebook"]);
  // A URL alone is enough -- the account exists even if the handle was never typed in.
  assert.deepEqual(deriveConfiguredPlatforms({ ...empty, facebookUrl: "https://facebook.com/alyandpon" }), ["facebook"]);

  // Declaration order, not input order, so the same configuration always renders identically.
  assert.deepEqual(deriveConfiguredPlatforms({ ...empty, tiktokHandle: "@alyandpon", instagramHandle: "@alyandpon" }), ["instagram", "tiktok"]);
  assert.deepEqual(
    deriveConfiguredPlatforms({ ...empty, instagramHandle: "@a", facebookHandle: "@b", tiktokHandle: "@c" }),
    ["instagram", "facebook", "tiktok"],
  );
});

test("an empty configuredPlatforms list produces a valid package rather than a fabricated platform", async () => {
  const { executor } = makeExecutor({
    claudeSteps: [
      aiSuccess("claude-cli", CREATIVE_AI_CLAUDE_MODEL, formatDecision("photo")),
      aiSuccess("claude-cli", CREATIVE_AI_CLAUDE_MODEL, { ...bodyFor("photo"), platformVariants: [] }),
    ],
    groundingInputs: grounding({ configuredPlatforms: [] }),
  });

  const result = await executor(jobRecord(), requestInput({ text: "easy today" }), noSignal);
  const envelope = validateCreativeJobResultEnvelopeV2(result);
  assert.equal(envelope.ok, true);
  if (!envelope.ok) return;
  assert.deepEqual(envelope.result.content.platformVariants, []);
  assert.equal(validateCreativePackageContentV2(envelope.result.content).ok, true);
});

// --- §28 timeout --------------------------------------------------------------------------------

test("creative_ai gets its own outer ceiling; every other worker keeps the generic 30s", () => {
  assert.equal(executorTimeoutMsFor("creative_ai"), CREATIVE_AI_EXECUTOR_TIMEOUT_MS);
  assert.equal(CREATIVE_AI_EXECUTOR_TIMEOUT_MS, 15 * 60 * 1000);
  assert.ok(CREATIVE_AI_EXECUTOR_TIMEOUT_MS > 30000, "the AI ceiling must exceed the generic one");

  for (const worker of ["mock", "product_text_worker", "opportunity_brief"] as const) {
    assert.equal(executorTimeoutMsFor(worker), 30000, `${worker} must keep its existing timeout`);
  }
});
