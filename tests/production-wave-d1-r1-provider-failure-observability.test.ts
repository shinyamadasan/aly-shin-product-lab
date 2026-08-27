import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

import type { AiTextProvider, AiTextRequest, AiTextResult } from "../src/lib/ai/ai-text-provider.ts";
import { ClaudeCliProvider, describeSpawnError as describeClaudeSpawnError } from "../src/lib/ai/providers/claude-cli-provider.ts";
import { CodexCliProvider, describeSpawnError as describeCodexSpawnError } from "../src/lib/ai/providers/codex-cli-provider.ts";
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
import { assembleCreativePackageV2 } from "../src/lib/creative-generation/assemble.ts";
import { validateCreativeJobResultEnvelopeV2 } from "../src/lib/creative-jobs.ts";
import { finishCreativeJobAttempt, fromCreativeJobAttemptRow, type CreativeJobAttemptRow } from "../src/lib/creative-job-attempts.ts";
import { BRAND_BIBLE } from "../src/lib/marketing-advisor-context.ts";
import type { ResolvedCreativeGrounding } from "../src/lib/creative-subject-resolution.ts";

// Production MVP Wave D1 -- R1 provider failure observability.
//
// Wave D1's live Template Reel regression died on `process_error` from BOTH configured CLI
// providers, 5ms and 3ms apart, and the triage could not say why. Not because the information was
// unavailable -- both adapters had already computed the exit code, the signal, the byte counts and
// a description of the spawn refusal -- but because the orchestrator built its trace entry without
// them and the facts were discarded at that boundary.
//
// These tests pin the repair, and they pin the constraint that makes the repair safe to ship: a
// provider failure MESSAGE is sometimes the provider talking about itself, and sometimes a
// truncation of raw stdout/stderr or a Node error echoing the prompt back out of argv. Only the
// first kind may ever reach the database.

// ------------------------------------------------------------------------------------------------
// fixtures
// ------------------------------------------------------------------------------------------------

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

// The exact shape a real adapter produces for a refused spawn, which is what Wave D1 hit.
const SAFE_SPAWN_MESSAGE = "Failed to spawn Claude CLI: ENAMETOOLONG";
const SAFE_DIAGNOSTICS = { exitCode: null, signal: null, stdoutBytes: 0, stderrBytes: 0, errorCode: "ENAMETOOLONG" };

function safeFailure(providerId: string, model: string | null): AiTextResult {
  return {
    ok: false,
    reason: "process_error",
    message: SAFE_SPAWN_MESSAGE,
    metadata: { providerId, model, durationMs: 5 },
    diagnostics: { ...SAFE_DIAGNOSTICS },
    messageSafe: true,
  };
}

// The other kind: `message` here is a truncation of the process's own stdout+stderr, which is how
// both adapters build it when the CLI ran and exited non-zero.
function unsafeFailure(providerId: string, model: string | null, messageSafe: boolean | undefined = false): AiTextResult {
  return {
    ok: false,
    reason: "process_error",
    message: "Traceback: OPENAI_API_KEY=sk-live-do-not-persist ... prompt text: make a Reel about brownies",
    metadata: { providerId, model, durationMs: 7 },
    diagnostics: { exitCode: 1, signal: null, stdoutBytes: 812, stderrBytes: 96 },
    ...(messageSafe === undefined ? {} : { messageSafe }),
  };
}

function success(providerId: string, model: string | null, structuredValue: unknown): AiTextResult {
  return { ok: true, text: JSON.stringify(structuredValue), structuredValue, metadata: { providerId, model, durationMs: 9 } };
}

function formatDecision(format: CreativeFormat = "photo") {
  return { format, formatRationale: "Best fit for a simple product moment." };
}

function bodyFor(): Record<string, unknown> {
  return {
    angle: "A quiet blondie moment",
    hook: "Blondies, simply framed.",
    headline: "Blondies for the coffee pause",
    caption: "A calm kitchen moment with Blondies.",
    cta: "Save this idea for your next coffee break.",
    platformVariants: [{ platform: "instagram", caption: "Blondies and a coffee pause.", hashtags: ["#blondies"] }],
    productionSource: "capture_new",
    visualDirection: "Overhead phone photo on parchment.",
    overlayText: null,
    framing: "overhead",
  };
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

async function runWith(claude: AiTextProvider, codex: AiTextProvider, formatHint: CreativeFormat | null = null) {
  return runCreativeGenerationWithProviders(
    { context: context(formatHint), configuredPlatforms: ["instagram"] },
    { routes: buildDefaultCreativeAiRoutes({ claude, codex }) },
  );
}

function traceEntry(outcome: "success" | "failure", extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    stage: "creative_body",
    providerId: "claude-cli",
    model: "opus",
    invocationNumber: 1,
    providerInvocationNumber: 1,
    outcome,
    durationMs: 5,
    action: outcome === "success" ? "accepted" : "stop",
    ...extra,
  };
}

// Built by the SHIPPED assembler rather than hand-written, so these tests exercise the envelope
// validator against content the system actually produces -- and cannot drift away from it.
function validV2Content(): unknown {
  const assembled = assembleCreativePackageV2({
    creativeInput: buildCreativeInputFromRequest({ text: "make content for Blondies", formatHint: "photo" }),
    grounding: grounding(),
    decision: { format: "photo", formatRationale: "Best fit for a simple product moment." },
    formatChosenBy: "ai",
    body: bodyFor() as never,
    sourceCreativeJobId: "job-1",
    sourceWorker: "creative_ai",
  });
  if (!assembled.ok) {
    throw new Error(`fixture content failed to assemble: ${assembled.message}`);
  }
  return assembled.content;
}

function envelopeWithTrace(trace: Record<string, unknown>[]): Record<string, unknown> {
  return { schemaVersion: "v2", worker: "creative_ai", content: validV2Content(), executionTrace: trace };
}

// ================================================================================================
// §6 -- orchestrator propagation
// ================================================================================================

test("R1 §6: a safe provider failure keeps its message and diagnostics on the failure trace entry", async () => {
  const claude = new FakeProvider("claude-cli", [safeFailure("claude-cli", CREATIVE_AI_CLAUDE_MODEL)]);
  const codex = new FakeProvider("codex-cli", [safeFailure("codex-cli", CREATIVE_AI_CODEX_MODEL)]);

  const result = await runWith(claude, codex, "photo");

  assert.equal(result.ok, false);
  assert.equal(result.trace.length, 2);

  const [first] = result.trace;
  assert.equal(first.outcome, "failure");
  assert.equal(first.failureReason, "process_error");
  // Retained EXACTLY -- not reworded, not re-truncated, not summarized.
  assert.equal(first.message, SAFE_SPAWN_MESSAGE);
  assert.deepEqual(first.diagnostics, SAFE_DIAGNOSTICS);
  // The single fact the whole repair exists for: the errno survives to the trace.
  assert.equal(first.diagnostics?.errorCode, "ENAMETOOLONG");
});

test("R1 §6: routing and fallback are unchanged by the added fields", async () => {
  const claude = new FakeProvider("claude-cli", [safeFailure("claude-cli", CREATIVE_AI_CLAUDE_MODEL)]);
  const codex = new FakeProvider("codex-cli", [success("codex-cli", CREATIVE_AI_CODEX_MODEL, bodyFor())]);

  const result = await runWith(claude, codex, "photo");

  assert.equal(result.ok, true);
  assert.equal(claude.calls.length, 1);
  assert.equal(codex.calls.length, 1);
  assert.deepEqual(
    result.trace.map((entry) => `${entry.providerId}:${entry.outcome}:${entry.action}`),
    ["claude-cli:failure:fallback", "codex-cli:success:accepted"],
  );
});

test("R1 §6: an UNSAFE provider message is never carried, while its diagnostics still are", async () => {
  const claude = new FakeProvider("claude-cli", [unsafeFailure("claude-cli", CREATIVE_AI_CLAUDE_MODEL)]);
  const codex = new FakeProvider("codex-cli", [unsafeFailure("codex-cli", CREATIVE_AI_CODEX_MODEL)]);

  const result = await runWith(claude, codex, "photo");

  for (const entry of result.trace) {
    assert.equal(entry.outcome, "failure");
    assert.equal("message" in entry, false, "a stream-derived message must not reach the trace");
    // The operational half is still recorded: losing the message must not cost us the exit code.
    assert.deepEqual(entry.diagnostics, { exitCode: 1, signal: null, stdoutBytes: 812, stderrBytes: 96 });
  }
  // Belt and braces: the secret in the fixture is nowhere in the serialized trace.
  assert.doesNotMatch(JSON.stringify(result.trace), /sk-live-do-not-persist/);
  assert.doesNotMatch(JSON.stringify(result.trace), /make a Reel about brownies/);
});

test("R1 §6: a provider that omits messageSafe is treated as unsafe (default deny)", async () => {
  const claude = new FakeProvider("claude-cli", [unsafeFailure("claude-cli", CREATIVE_AI_CLAUDE_MODEL, undefined)]);
  const codex = new FakeProvider("codex-cli", [unsafeFailure("codex-cli", CREATIVE_AI_CODEX_MODEL, undefined)]);

  const result = await runWith(claude, codex, "photo");

  for (const entry of result.trace) {
    assert.equal("message" in entry, false, "absent messageSafe must not be read as permission");
  }
});

test("R1 §6: successful entries acquire neither message nor diagnostics", async () => {
  const claude = new FakeProvider("claude-cli", [
    success("claude-cli", CREATIVE_AI_CLAUDE_MODEL, formatDecision()),
    success("claude-cli", CREATIVE_AI_CLAUDE_MODEL, bodyFor()),
  ]);
  const codex = new FakeProvider("codex-cli", []);

  const result = await runWith(claude, codex);

  assert.equal(result.ok, true);
  assert.equal(result.trace.length, 2);
  for (const entry of result.trace) {
    assert.equal(entry.outcome, "success");
    assert.equal("message" in entry, false);
    assert.equal("diagnostics" in entry, false);
  }
});

test("R1 §6: an orchestrator-side validation failure carries no provider message", async () => {
  // The provider ANSWERED; the answer just did not validate. There is no provider failure to quote,
  // so inventing one would be a fabrication.
  //
  // Two steps each: schema_invalid is retryable, so every route is invoked twice and both the
  // first attempt and the retry must stay clean.
  const invalid = { nope: true };
  const claude = new FakeProvider("claude-cli", [
    success("claude-cli", CREATIVE_AI_CLAUDE_MODEL, invalid),
    success("claude-cli", CREATIVE_AI_CLAUDE_MODEL, invalid),
  ]);
  const codex = new FakeProvider("codex-cli", [
    success("codex-cli", CREATIVE_AI_CODEX_MODEL, invalid),
    success("codex-cli", CREATIVE_AI_CODEX_MODEL, invalid),
  ]);

  const result = await runWith(claude, codex, "photo");

  assert.equal(result.ok, false);
  assert.equal(result.trace.length, 4, "both routes, each with its one permitted retry");
  for (const entry of result.trace) {
    assert.equal(entry.outcome, "failure");
    assert.equal(entry.failureReason, "schema_invalid");
    assert.equal("message" in entry, false);
    assert.equal("diagnostics" in entry, false);
  }
});

// ================================================================================================
// §7 -- persistence and read-back
// ================================================================================================

test("R1 §7: an enriched failure trace survives finish_creative_job_attempt_with_trace and reads back", async () => {
  const trace: CreativeAiInvocationTraceEntry[] = [
    {
      stage: "creative_body",
      providerId: "claude-cli",
      model: "opus",
      invocationNumber: 1,
      providerInvocationNumber: 1,
      outcome: "failure",
      failureReason: "process_error",
      durationMs: 5,
      action: "fallback",
      message: SAFE_SPAWN_MESSAGE,
      diagnostics: { ...SAFE_DIAGNOSTICS },
    },
  ];

  const rpcCalls: string[] = [];
  let stored: CreativeJobAttemptRow | null = null;
  const client = {
    rpc(functionName: string, args: Record<string, unknown>) {
      rpcCalls.push(functionName);
      // jsonb: what comes back out of the database is the JSON round-trip of what went in, never
      // the same object reference. Serializing here is what makes the read-back assertion honest.
      stored = {
        id: "attempt-1",
        creative_job_id: "job-1",
        attempt_number: 1,
        worker_type: "creative_ai",
        status: "failed",
        started_at: "2026-08-26T16:03:54.120Z",
        completed_at: "2026-08-26T16:03:54.679Z",
        latency_ms: 559,
        error_code: String(args.p_error_code),
        error_message: String(args.p_error_message),
        ai_execution_trace: JSON.parse(JSON.stringify(args.p_ai_execution_trace)),
        created_at: "2026-08-26T16:03:54.120Z",
      };
      return { maybeSingle: async () => ({ data: stored, error: null }) };
    },
  };

  const finished = await finishCreativeJobAttempt(
    client as never,
    "attempt-1",
    "failed",
    { errorCode: "ai_process_error", errorMessage: "Creative AI generation failed at the creative_body stage: process_error.", executionTrace: trace },
  );

  assert.equal(finished.ok, true);
  assert.deepEqual(rpcCalls, ["finish_creative_job_attempt_with_trace"], "the trace-aware RPC is the one used");

  const record = fromCreativeJobAttemptRow(stored as unknown as CreativeJobAttemptRow);
  assert.equal(record.aiExecutionTrace?.length, 1);
  const [entry] = record.aiExecutionTrace ?? [];
  assert.equal(entry.message, SAFE_SPAWN_MESSAGE);
  assert.deepEqual(entry.diagnostics, SAFE_DIAGNOSTICS);
  assert.equal(entry.diagnostics?.errorCode, "ENAMETOOLONG");
});

test("R1 §7: the v2 envelope validator accepts an enriched failure entry alongside a success", () => {
  // The real mixed-provider shape: Claude fails, Codex succeeds, the JOB succeeds -- so this trace
  // goes through the success-envelope validator, whose closed key set previously rejected both
  // new fields outright.
  const result = validateCreativeJobResultEnvelopeV2(envelopeWithTrace([
    traceEntry("failure", { failureReason: "process_error", action: "fallback", message: SAFE_SPAWN_MESSAGE, diagnostics: { ...SAFE_DIAGNOSTICS } }),
    traceEntry("success", { providerId: "codex-cli", invocationNumber: 2 }),
  ]));

  assert.equal(result.ok, true, result.ok ? "" : result.message);
});

test("R1 §7 / §4: legacy trace entries without the new fields still validate", () => {
  const result = validateCreativeJobResultEnvelopeV2(envelopeWithTrace([
    traceEntry("failure", { failureReason: "usage_limit", action: "fallback" }),
    traceEntry("success", { providerId: "codex-cli", invocationNumber: 2 }),
  ]));

  assert.equal(result.ok, true, result.ok ? "" : result.message);
});

test("R1 §7: the validator keeps diagnostics closed -- unknown keys and non-scalars are rejected", () => {
  const unknownKey = validateCreativeJobResultEnvelopeV2(envelopeWithTrace([
    traceEntry("failure", { failureReason: "process_error", diagnostics: { exitCode: 1, stdout: "raw output that must never land" } }),
  ]));
  assert.equal(unknownKey.ok, false);
  assert.match(unknownKey.ok ? "" : unknownKey.message, /must not carry unrecognized field: stdout/);

  const nested = validateCreativeJobResultEnvelopeV2(envelopeWithTrace([
    traceEntry("failure", { failureReason: "process_error", diagnostics: { exitCode: { smuggled: "payload" } } }),
  ]));
  assert.equal(nested.ok, false);
  assert.match(nested.ok ? "" : nested.message, /must be a scalar or null/);
});

test("R1 §7: the validator refuses failure detail on a success entry and refuses an oversized message", () => {
  const onSuccess = validateCreativeJobResultEnvelopeV2(envelopeWithTrace([
    traceEntry("success", { message: SAFE_SPAWN_MESSAGE }),
  ]));
  assert.equal(onSuccess.ok, false);
  assert.match(onSuccess.ok ? "" : onSuccess.message, /success entries must not carry message or diagnostics/);

  const oversized = validateCreativeJobResultEnvelopeV2(envelopeWithTrace([
    traceEntry("failure", { failureReason: "process_error", message: "x".repeat(501) }),
  ]));
  assert.equal(oversized.ok, false);
  assert.match(oversized.ok ? "" : oversized.message, /at most 500 characters/);
});

// ================================================================================================
// §8 -- real CreateProcess coverage
// ================================================================================================

// Every other provider test in this repo injects a fake spawn, which is exactly why Wave D1's
// failure class was invisible: no test had ever asked the real operating system to refuse a real
// process. These do.
//
// The target is process.execPath, never a CLI: the assertion is about the SPAWN, and a test that
// depended on Claude or Codex being installed would be untestable in CI and would risk a real
// model call. The refusal is provoked by exceeding the Windows CreateProcess command-line limit
// (32,767 chars), which is a hard, documented, synchronous failure on that platform.
//
// Windows-gated deliberately. Linux ARG_MAX is ~2MB and is not a comparable limit, so a
// cross-platform version of this test would either not fail at all or fail for a different reason.
// A green test that proves nothing is worse than a skipped one that says so.
const WINDOWS_ONLY = process.platform === "win32"
  ? false
  : `Skipped: provokes the Windows CreateProcess ${32767}-char command-line limit, which has no equivalent on ${process.platform}.`;

const OVERSIZED_REQUEST: AiTextRequest = {
  systemPrompt: "system",
  userPrompt: "x".repeat(40_000),
  structuredOutput: { schema: { type: "object" } },
};

test("R1 §8: Claude adapter -- a REAL refused spawn yields process_error with a safe message and diagnostics", { skip: WINDOWS_ONLY }, async () => {
  const provider = new ClaudeCliProvider({
    // Real spawn, harmless target. `spawnFn` is the adapter's existing test seam; passing the real
    // implementation through it is what makes this a genuine CreateProcess test.
    spawnFn: spawn,
    executablePath: process.execPath,
  });

  const result = await provider.generate(OVERSIZED_REQUEST);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "process_error", "a refused spawn is process_error, not provider_unavailable");
  assert.equal(result.messageSafe, true, "a POSIX errno message quotes no caller data and is safe to persist");
  assert.match(result.message, /^Failed to spawn Claude CLI: ENAMETOOLONG$/);
  assert.equal(result.diagnostics?.errorCode, "ENAMETOOLONG");
  // The prompt must not have travelled out inside the error.
  assert.doesNotMatch(result.message, /xxxxxxxxxx/);
});

test("R1 §8: Codex adapter -- a REAL refused spawn yields process_error with a safe message and diagnostics", { skip: WINDOWS_ONLY }, async () => {
  const provider = new CodexCliProvider({
    spawnFn: spawn,
    executablePath: process.execPath,
  });

  const result = await provider.generate(OVERSIZED_REQUEST);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "process_error");
  assert.equal(result.messageSafe, true);
  assert.match(result.message, /^Failed to spawn Codex CLI: ENAMETOOLONG$/);
  assert.equal(result.diagnostics?.errorCode, "ENAMETOOLONG");
  assert.doesNotMatch(result.message, /xxxxxxxxxx/);
});

test("R1 §8: an argv-echoing spawn rejection is classified UNSAFE by both adapters", () => {
  // Node's ERR_* argument validation quotes the offending value back. Measured on Node 24:
  //   "The argument 'args[2]' must be a string without null bytes. Received 'PROMPT\x00LEAK'"
  // That value is the prompt. Both adapters must refuse to mark such a message safe.
  const argvEcho = Object.assign(new Error("The argument 'args[2]' must be a string without null bytes."), { code: "ERR_INVALID_ARG_VALUE" });
  const errno = Object.assign(new Error("spawn ENAMETOOLONG"), { code: "ENAMETOOLONG" });

  for (const describe of [describeClaudeSpawnError, describeCodexSpawnError]) {
    assert.deepEqual(describe(argvEcho), { errorCode: "ERR_INVALID_ARG_VALUE", messageSafe: false });
    assert.deepEqual(describe(errno), { errorCode: "ENAMETOOLONG", messageSafe: true });
    // A non-Error throw has no errno to report and nothing safe to say.
    assert.deepEqual(describe("something odd"), { errorCode: null, messageSafe: false });
  }
});

test("R1 §8: the Wave D1 scenario end-to-end -- both real spawns refused, and the trace now explains why", { skip: WINDOWS_ONLY }, async () => {
  // This is the regression Wave D1 actually hit: both configured providers fail process_error in a
  // few milliseconds. Before R1 the persisted trace said only "process_error" twice. Now it names
  // the errno.
  const claude = new ClaudeCliProvider({ spawnFn: spawn, executablePath: process.execPath });
  const codex = new CodexCliProvider({ spawnFn: spawn, executablePath: process.execPath });

  const result = await runCreativeGenerationWithProviders(
    { context: { ...context("reel"), creativeInput: buildCreativeInputFromRequest({ text: "x".repeat(40_000), formatHint: "reel" }) }, configuredPlatforms: ["instagram"] },
    { routes: buildDefaultCreativeAiRoutes({ claude, codex }) },
  );

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "process_error");
  assert.deepEqual(
    result.trace.map((entry) => `${entry.providerId}:${entry.failureReason}`),
    ["claude-cli:process_error", "codex-cli:process_error"],
    "the Wave D1 shape, reproduced",
  );

  for (const entry of result.trace) {
    assert.equal(entry.diagnostics?.errorCode, "ENAMETOOLONG", "the errno Wave D1 could not recover");
    assert.match(String(entry.message), /^Failed to spawn (Claude|Codex) CLI: ENAMETOOLONG$/);
  }

  // And the prompt still did not travel: 40,000 x's are nowhere in the persisted trace.
  assert.doesNotMatch(JSON.stringify(result.trace), /xxxxxxxxxx/);
});

// ================================================================================================
// duplication note (R1 §9)
// ================================================================================================

test("R1 §9: the two adapters remain independent implementations, deliberately", () => {
  // Recorded as a test rather than a comment so the debt is visible in the suite. R1 is an
  // observability repair; collapsing claude-cli-provider and codex-cli-provider onto a shared
  // subprocess wrapper is a separate change with its own review, and doing it here would have put
  // an untested abstraction underneath the exact failure path Wave D1 just proved fragile.
  assert.notEqual(describeClaudeSpawnError, describeCodexSpawnError, "duplicated on purpose; unify in a later, dedicated change");
});
