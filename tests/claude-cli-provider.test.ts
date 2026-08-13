import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";

import {
  CLAUDE_CLI_DEFAULT_MAX_OUTPUT_BYTES,
  CLAUDE_CLI_DEFAULT_MODEL,
  CLAUDE_CLI_DEFAULT_TIMEOUT_MS,
  CLAUDE_CLI_PROVIDER_ID,
  ClaudeCliProvider,
  buildClaudeCliArgs,
  resolveClaudeCliExecutable,
  type SpawnFn,
} from "../src/lib/ai/providers/claude-cli-provider.ts";
import type { AiTextProvider, AiTextRequest } from "../src/lib/ai/ai-text-provider.ts";

// Content MVP S3C-B. ClaudeCliProvider is the first real AiTextProvider. Nothing here spawns a
// real Claude process or touches the owner's account -- every case drives the provider through an
// injected fake spawn, so the whole failure taxonomy is deterministic and offline.

// ---- fake process plumbing ------------------------------------------------------------------

class FakeChildProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = { ended: false, end() { this.ended = true; } };
  killed = false;
  kill() {
    this.killed = true;
  }
}

type SpawnCall = { executable: string; args: string[]; options: Record<string, unknown> };

/** Records every spawn, and drives the fake child through `script` on the next microtask. */
function fakeSpawn(script: (child: FakeChildProcess) => void): { spawnFn: SpawnFn; calls: SpawnCall[]; children: FakeChildProcess[] } {
  const calls: SpawnCall[] = [];
  const children: FakeChildProcess[] = [];
  const spawnFn = ((executable: string, args: string[], options: Record<string, unknown>) => {
    calls.push({ executable, args, options });
    const child = new FakeChildProcess();
    children.push(child);
    queueMicrotask(() => script(child));
    return child;
  }) as unknown as SpawnFn;
  return { spawnFn, calls, children };
}

/** A realistic success envelope, shaped from the real CLI output observed during S3C-B preflight. */
function successEnvelope(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 4051,
    num_turns: 1,
    stop_reason: "end_turn",
    session_id: "00000000-0000-0000-0000-000000000000",
    total_cost_usd: 0.032875,
    usage: { input_tokens: 2, output_tokens: 7, cache_read_input_tokens: 0 },
    modelUsage: { "claude-opus-5": { inputTokens: 2, outputTokens: 7, canonicalModel: "claude-opus-5" } },
    result: "provider-ok",
    ...overrides,
  });
}

function respondWith(payload: string, exitCode = 0): (child: FakeChildProcess) => void {
  return (child) => {
    child.stdout.emit("data", payload);
    child.emit("close", exitCode, null);
  };
}

const TEXT_REQUEST: AiTextRequest = { systemPrompt: "You are terse.", userPrompt: "Say hello." };

const PROVIDER_SOURCE_URL = new URL("../src/lib/ai/providers/claude-cli-provider.ts", import.meta.url);

/**
 * The provider source with comments removed.
 *
 * The boundary tests below must constrain what the module DOES, not what its comments discuss.
 * This module deliberately explains, in prose, why it must never import CreativeInput, why
 * `--bare` is refused, and why a future Codex provider must not inherit "opus" -- naming those
 * things is the whole point of the comments. Grepping raw source would therefore fail on the
 * documentation that exists to protect the very invariant being tested, which is a false positive
 * that would push a future maintainer to delete the explanation instead of keeping the rule.
 */
function providerCode(): string {
  const stripped = readFileSync(PROVIDER_SOURCE_URL, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

  // Guard against the stripper silently eating everything and making these tests vacuous.
  assert.match(stripped, /export class ClaudeCliProvider/);
  assert.match(stripped, /spawnFn\(executable, args/);
  return stripped;
}

const SCHEMA = {
  type: "object",
  properties: { status: { type: "string", const: "provider-ok" } },
  required: ["status"],
  additionalProperties: false,
};

// =============================================================================================
// §29 -- invocation
// =============================================================================================

test("A. ClaudeCliProvider satisfies the generic AiTextProvider contract", () => {
  // Assigning to the generic type is the real structural proof; a source grep would not be.
  const provider: AiTextProvider = new ClaudeCliProvider();
  assert.equal(typeof provider.providerId, "string");
  assert.equal(typeof provider.generate, "function");
});

test("B. providerId is stable, Claude-specific, and carries no model", () => {
  assert.equal(new ClaudeCliProvider().providerId, "claude-cli");
  assert.equal(CLAUDE_CLI_PROVIDER_ID, "claude-cli");
  // Switching the model must not change who ran the call.
  assert.equal(new ClaudeCliProvider({ model: "sonnet" }).providerId, "claude-cli");
  assert.doesNotMatch(CLAUDE_CLI_PROVIDER_ID, /opus|sonnet|haiku/i);
});

test("C. the default model resolves to Opus", async () => {
  assert.equal(CLAUDE_CLI_DEFAULT_MODEL, "opus");
  const { spawnFn, calls } = fakeSpawn(respondWith(successEnvelope()));
  await new ClaudeCliProvider({ spawnFn }).generate({ userPrompt: "x" });

  const modelIndex = calls[0].args.indexOf("--model");
  assert.notEqual(modelIndex, -1);
  assert.equal(calls[0].args[modelIndex + 1], "opus");
});

test("D. an explicit generic request.model overrides both the provider default and Opus", async () => {
  const { spawnFn, calls } = fakeSpawn(respondWith(successEnvelope()));
  await new ClaudeCliProvider({ spawnFn, model: "provider-configured-model" }).generate({ userPrompt: "x", model: "request-model" });

  assert.equal(calls[0].args[calls[0].args.indexOf("--model") + 1], "request-model");
});

test("D2. provider configuration overrides Opus when the request states no model", async () => {
  const { spawnFn, calls } = fakeSpawn(respondWith(successEnvelope()));
  await new ClaudeCliProvider({ spawnFn, model: "provider-configured-model" }).generate({ userPrompt: "x" });

  assert.equal(calls[0].args[calls[0].args.indexOf("--model") + 1], "provider-configured-model");
});

test("E. argv is deterministic -- the same request renders identically every time", () => {
  const request: AiTextRequest = { systemPrompt: "sys", userPrompt: "user", structuredOutput: { schema: SCHEMA, schemaName: "ignored" } };
  assert.deepEqual(buildClaudeCliArgs(request, "opus"), buildClaudeCliArgs(request, "opus"));

  assert.deepEqual(buildClaudeCliArgs(request, "opus"), [
    "-p",
    "user",
    "--model",
    "opus",
    "--tools",
    "",
    "--output-format",
    "json",
    "--no-session-persistence",
    "--strict-mcp-config",
    "--safe-mode",
    "--system-prompt",
    "sys",
    "--json-schema",
    JSON.stringify(SCHEMA),
  ]);
});

test("F. the child is spawned with shell: false", async () => {
  const { spawnFn, calls } = fakeSpawn(respondWith(successEnvelope()));
  await new ClaudeCliProvider({ spawnFn }).generate(TEXT_REQUEST);

  assert.equal(calls[0].options.shell, false);
  // Non-negotiable: the prompt must be a discrete argv entry, never part of a command string.
  assert.ok(Array.isArray(calls[0].args));
  assert.ok(calls[0].args.includes("Say hello."));
  assert.doesNotMatch(calls[0].executable, /Say hello/);
});

test("G. --bare is never passed, because it would force ANTHROPIC_API_KEY auth", () => {
  const args = buildClaudeCliArgs({ userPrompt: "x", systemPrompt: "y", structuredOutput: { schema: SCHEMA } }, "opus");
  assert.equal(args.includes("--bare"), false);
});

test("H. tools are structurally disabled", () => {
  const args = buildClaudeCliArgs({ userPrompt: "x" }, "opus");
  const toolsIndex = args.indexOf("--tools");
  assert.notEqual(toolsIndex, -1);
  assert.equal(args[toolsIndex + 1], "");
});

test("I. sessions are never persisted, MCP config is strict, and ambient project instructions are excluded", () => {
  const args = buildClaudeCliArgs({ userPrompt: "x" }, "opus");
  assert.ok(args.includes("--no-session-persistence"));
  assert.ok(args.includes("--strict-mcp-config"));
  // --safe-mode: verified live that --system-prompt ALONE does not stop CLAUDE.md/AGENTS.md
  // auto-discovery, which would silently alter S3B's frozen canonical prompt.
  assert.ok(args.includes("--safe-mode"));
  assert.ok(args.includes("-p"));
});

test("J. the caller's structured schema is forwarded verbatim, unwrapped and unmodified", () => {
  const args = buildClaudeCliArgs({ userPrompt: "x", structuredOutput: { schema: SCHEMA } }, "opus");
  const schemaIndex = args.indexOf("--json-schema");
  assert.notEqual(schemaIndex, -1);
  assert.deepEqual(JSON.parse(args[schemaIndex + 1]), SCHEMA);
});

test("K. a text-only request omits --json-schema entirely", () => {
  const args = buildClaudeCliArgs({ userPrompt: "x" }, "opus");
  assert.equal(args.includes("--json-schema"), false);
});

test("L. system and user prompts map onto their own CLI channels, never concatenated", () => {
  const args = buildClaudeCliArgs({ systemPrompt: "SYSTEM_HALF", userPrompt: "USER_HALF" }, "opus");

  assert.equal(args[args.indexOf("--system-prompt") + 1], "SYSTEM_HALF");
  assert.equal(args[args.indexOf("-p") + 1], "USER_HALF");
  // Neither half may have absorbed the other -- that would change S3B's canonical meaning.
  assert.doesNotMatch(args[args.indexOf("-p") + 1], /SYSTEM_HALF/);
  assert.doesNotMatch(args[args.indexOf("--system-prompt") + 1], /USER_HALF/);
});

test("L2. an absent system prompt omits the flag rather than inventing one", () => {
  assert.equal(buildClaudeCliArgs({ userPrompt: "x" }, "opus").includes("--system-prompt"), false);
});

test("M. stdin is closed immediately", async () => {
  const { spawnFn, children } = fakeSpawn(respondWith(successEnvelope()));
  await new ClaudeCliProvider({ spawnFn }).generate(TEXT_REQUEST);

  assert.equal(children[0].stdin.ended, true);
});

test("N. the provider requires no ANTHROPIC_API_KEY and no Anthropic SDK", async () => {
  const code = providerCode();
  // ANTHROPIC_API_KEY appears in this module only inside explanatory comments, which is why the
  // assertion runs against comment-stripped code: it is never read as configuration.
  assert.doesNotMatch(code, /ANTHROPIC_API_KEY/);
  assert.doesNotMatch(code, /@anthropic-ai\/sdk/);

  // And it genuinely runs with the variable absent from this process.
  const previous = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const { spawnFn } = fakeSpawn(respondWith(successEnvelope()));
    const result = await new ClaudeCliProvider({ spawnFn }).generate(TEXT_REQUEST);
    assert.equal(result.ok, true);
  } finally {
    if (previous !== undefined) process.env.ANTHROPIC_API_KEY = previous;
  }
});

test("N2. the provider reads no environment variable other than PATH for executable resolution", () => {
  const envReads = [...providerCode().matchAll(/process\.env\.(\w+)/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(envReads)].sort(), ["PATH", "Path"]);
});

// =============================================================================================
// §30 -- success mapping
// =============================================================================================

test("text success maps result, providerId, model, duration and honest usage", async () => {
  const { spawnFn } = fakeSpawn(respondWith(successEnvelope()));
  let clock = 1000;
  const result = await new ClaudeCliProvider({ spawnFn, now: () => (clock += 25) }).generate(TEXT_REQUEST);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.text, "provider-ok");
  assert.equal(result.metadata.providerId, "claude-cli");
  assert.equal(result.metadata.model, "claude-opus-5");
  assert.equal(typeof result.metadata.durationMs, "number");
  assert.deepEqual(result.metadata.usage, { inputTokens: 2, outputTokens: 7 });
});

test("text success carries no structuredValue key at all", async () => {
  const { spawnFn } = fakeSpawn(respondWith(successEnvelope()));
  const result = await new ClaudeCliProvider({ spawnFn }).generate(TEXT_REQUEST);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  // Absent, not null and not {} -- structured output is genuinely optional.
  assert.equal("structuredValue" in result, false);
});

test("structured success maps the CLI's already-validated object plus its text form", async () => {
  const payload = successEnvelope({
    result: JSON.stringify({ status: "provider-ok" }),
    structured_output: { status: "provider-ok" },
    stop_reason: "tool_use",
  });
  const { spawnFn } = fakeSpawn(respondWith(payload));
  const result = await new ClaudeCliProvider({ spawnFn }).generate({ userPrompt: "x", structuredOutput: { schema: SCHEMA } });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.structuredValue, { status: "provider-ok" });
  assert.equal(result.text, '{"status":"provider-ok"}');
  assert.equal(result.metadata.providerId, "claude-cli");
  assert.equal(result.metadata.model, "claude-opus-5");
});

test("the reported model is chosen honestly when the CLI bills more than one model", async () => {
  // Observed live under --safe-mode: a small Haiku entry can appear alongside the requested model,
  // so "the first modelUsage key" is not a safe reading.
  const payload = successEnvelope({
    modelUsage: {
      "claude-haiku-4-5-20251001": { outputTokens: 3 },
      "claude-opus-5": { outputTokens: 7 },
    },
  });
  const { spawnFn } = fakeSpawn(respondWith(payload));
  const result = await new ClaudeCliProvider({ spawnFn }).generate({ userPrompt: "x" });

  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.metadata.model, "claude-opus-5");
});

test("the requested model is reported unchanged when the CLI reports no model usage", async () => {
  const { spawnFn } = fakeSpawn(respondWith(successEnvelope({ modelUsage: undefined })));
  const result = await new ClaudeCliProvider({ spawnFn }).generate({ userPrompt: "x", model: "some-model" });

  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.metadata.model, "some-model");
});

test("usage is omitted rather than faked when the CLI reports none", async () => {
  const { spawnFn } = fakeSpawn(respondWith(successEnvelope({ usage: undefined })));
  const result = await new ClaudeCliProvider({ spawnFn }).generate({ userPrompt: "x" });

  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.metadata.usage, undefined);
});

test("no dollar cost is ever surfaced, even though the CLI reports one", async () => {
  const { spawnFn } = fakeSpawn(respondWith(successEnvelope()));
  const result = await new ClaudeCliProvider({ spawnFn }).generate({ userPrompt: "x" });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  // total_cost_usd is an API-equivalent estimate, not money a subscription actually spent.
  assert.doesNotMatch(JSON.stringify(result), /cost|usd/i);
});

// =============================================================================================
// §31 -- failure classification
// =============================================================================================

test("a plain-text usage-limit failure classifies as usage_limit", async () => {
  const { spawnFn } = fakeSpawn((child) => {
    child.stderr.emit("data", "You've hit your usage limit. Try again later.");
    child.emit("close", 1, null);
  });
  const result = await new ClaudeCliProvider({ spawnFn }).generate(TEXT_REQUEST);

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "usage_limit");
});

test("an authentication failure classifies as authentication, not usage_limit", async () => {
  const { spawnFn } = fakeSpawn((child) => {
    child.stderr.emit("data", "Not logged in. Please run `claude auth`.");
    child.emit("close", 1, null);
  });
  const result = await new ClaudeCliProvider({ spawnFn }).generate(TEXT_REQUEST);

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "authentication");
});

test("a timeout kills the child and classifies as timeout", async () => {
  const { spawnFn, children } = fakeSpawn(() => {
    /* never responds */
  });
  const result = await new ClaudeCliProvider({ spawnFn }).generate({ userPrompt: "x", timeoutMs: 10 });

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "timeout");
  assert.equal(children[0].killed, true);
});

test("a missing executable classifies as provider_unavailable, not process_error", async () => {
  const { spawnFn } = fakeSpawn((child) => {
    const err = new Error("spawn claude ENOENT") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    child.emit("error", err);
  });
  const result = await new ClaudeCliProvider({ spawnFn }).generate(TEXT_REQUEST);

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "provider_unavailable");
    assert.equal(result.diagnostics?.executableResolved, false);
  }
});

test("an unresolvable Claude install classifies as provider_unavailable before anything is spawned", async () => {
  // No spawnFn injected here on purpose, so the real resolution path runs -- with resolution faked.
  const result = await new ClaudeCliProvider({ resolveExecutable: () => null }).generate(TEXT_REQUEST);

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "provider_unavailable");
});

test("a configured executablePath that does not exist classifies as configuration_error", async () => {
  const result = await new ClaudeCliProvider({ executablePath: "/definitely/not/here/claude.exe" }).generate(TEXT_REQUEST);

  assert.equal(result.ok, false);
  if (!result.ok) {
    // A local misconfiguration is a different problem from "Claude is not installed", and an
    // orchestrator would act differently on each.
    assert.equal(result.reason, "configuration_error");
  }
});

test("an unserializable structured schema classifies as configuration_error before spawning", async () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  const { spawnFn, calls } = fakeSpawn(respondWith(successEnvelope()));

  const result = await new ClaudeCliProvider({ spawnFn }).generate({ userPrompt: "x", structuredOutput: { schema: circular } });

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "configuration_error");
  assert.equal(calls.length, 0, "nothing may be spawned once local configuration is known to be bad");
});

test("a non-ENOENT spawn error classifies as process_error", async () => {
  const { spawnFn } = fakeSpawn((child) => {
    const err = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
    err.code = "EACCES";
    child.emit("error", err);
  });
  const result = await new ClaudeCliProvider({ spawnFn }).generate(TEXT_REQUEST);

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "process_error");
});

test("oversized output terminates the child, classifies as output_too_large, and leaks no content", async () => {
  const sentinel = `SENTINEL_MODEL_OUTPUT_MUST_NOT_LEAK_${"x".repeat(500)}`;
  const { spawnFn, children } = fakeSpawn((child) => {
    child.stdout.emit("data", sentinel);
    // No close event -- a real overflow kills the child before it would exit naturally.
  });
  const result = await new ClaudeCliProvider({ spawnFn, maxOutputBytes: 64 }).generate(TEXT_REQUEST);

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "output_too_large");
    assert.doesNotMatch(JSON.stringify(result), /SENTINEL_MODEL_OUTPUT/);
  }
  assert.equal(children[0].killed, true);
});

test("a malformed envelope on a clean exit classifies as malformed_response", async () => {
  const { spawnFn } = fakeSpawn(respondWith("this is not json", 0));
  const result = await new ClaudeCliProvider({ spawnFn }).generate(TEXT_REQUEST);

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "malformed_response");
});

test("an empty result field on a clean exit classifies as malformed_response", async () => {
  const { spawnFn } = fakeSpawn(respondWith(successEnvelope({ result: "   " })));
  const result = await new ClaudeCliProvider({ spawnFn }).generate(TEXT_REQUEST);

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "malformed_response");
});

test("a missing structured_output for a schema request classifies as schema_invalid, distinct from malformed_response", async () => {
  const { spawnFn } = fakeSpawn(respondWith(successEnvelope({ result: "I could not comply." })));
  const result = await new ClaudeCliProvider({ spawnFn }).generate({ userPrompt: "x", structuredOutput: { schema: SCHEMA } });

  assert.equal(result.ok, false);
  if (!result.ok) {
    // S3E's single permitted retry needs "the model broke the schema" to stay separable from
    // "the envelope was garbage".
    assert.equal(result.reason, "schema_invalid");
    assert.notEqual(result.reason, "malformed_response");
  }
});

test("every failure reason stays inside the generic taxonomy and never leaks Claude vocabulary", async () => {
  const cases: Array<[string, (child: FakeChildProcess) => void]> = [
    ["usage", (c) => { c.stderr.emit("data", "usage limit reached"); c.emit("close", 1, null); }],
    ["auth", (c) => { c.stderr.emit("data", "not logged in"); c.emit("close", 1, null); }],
    ["malformed", respondWith("nope", 0)],
    ["process", (c) => { c.stderr.emit("data", "segfault"); c.emit("close", 137, null); }],
  ];

  for (const [label, script] of cases) {
    const { spawnFn } = fakeSpawn(script);
    const result = await new ClaudeCliProvider({ spawnFn }).generate(TEXT_REQUEST);
    assert.equal(result.ok, false, label);
    if (!result.ok) {
      // ClaudeFailureReason values like "missing-binary" / "usage-limit" must never cross the
      // generic boundary.
      assert.doesNotMatch(result.reason, /-/, label);
      assert.doesNotMatch(result.reason, /claude|anthropic|codex|openai/i, label);
    }
  }
});

// =============================================================================================
// §32 -- the real session-limit regression
// =============================================================================================

test("REGRESSION: exit 1 + empty stderr + a valid JSON session-limit envelope classifies as usage_limit", async () => {
  // Sanitized from the real behavior observed during the S3B.1 failure probe. The exact shape that
  // breaks naive classifiers: the process fails, stderr says NOTHING, and the only evidence is a
  // well-formed error envelope on stdout. Classifying from exit code or stderr alone would bury
  // the single most actionable failure the orchestrator can act on.
  const envelope = JSON.stringify({
    type: "result",
    subtype: "error",
    is_error: true,
    result: "You've hit your session limit. Your limit will reset later.",
    session_id: "00000000-0000-0000-0000-000000000000",
    usage: { input_tokens: 1, output_tokens: 0 },
  });

  const { spawnFn } = fakeSpawn((child) => {
    child.stdout.emit("data", envelope);
    // stderr deliberately silent.
    child.emit("close", 1, null);
  });

  const result = await new ClaudeCliProvider({ spawnFn }).generate(TEXT_REQUEST);

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "usage_limit");
    assert.notEqual(result.reason, "process_error");
    assert.match(result.message, /session limit/i);
    assert.equal(result.diagnostics?.exitCode, 1);
    assert.equal(result.diagnostics?.stderrBytes, 0);
    // The message must be the human sentence lifted OUT of the envelope, not the raw JSON blob
    // scanned as text. Without this, an implementation that merely grepped combined output would
    // pass the assertions above by accident, and this regression would stop being load-bearing.
    assert.doesNotMatch(result.message, /"is_error"|"session_id"|^\{/);
  }
});

test("REGRESSION: an error envelope is honoured even when the CLI exits ZERO", async () => {
  // The sharpest proof that classification reads the envelope rather than the exit code. A naive
  // implementation that only inspects stdout when `code !== 0` would treat this as a SUCCESS and
  // hand the quota-refusal sentence back to the caller as if it were generated content.
  const envelope = JSON.stringify({
    type: "result",
    is_error: true,
    result: "You've hit your session limit. Your limit will reset later.",
  });
  const { spawnFn } = fakeSpawn(respondWith(envelope, 0));

  const result = await new ClaudeCliProvider({ spawnFn }).generate(TEXT_REQUEST);

  assert.equal(result.ok, false, "an is_error envelope must never be reported as success");
  if (!result.ok) assert.equal(result.reason, "usage_limit");
});

test("REGRESSION: an authentication error envelope on a nonzero exit is also read from stdout", async () => {
  const envelope = JSON.stringify({ type: "result", is_error: true, result: "Invalid API key. Please run /login." });
  const { spawnFn } = fakeSpawn((child) => {
    child.stdout.emit("data", envelope);
    child.emit("close", 1, null);
  });
  const result = await new ClaudeCliProvider({ spawnFn }).generate(TEXT_REQUEST);

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "authentication");
});

// =============================================================================================
// §33 -- exactly one invocation, never a retry or a fallback
// =============================================================================================

test("one generate() call causes exactly one process invocation, on every outcome", async () => {
  const scripts: Array<[string, (child: FakeChildProcess) => void]> = [
    ["success", respondWith(successEnvelope())],
    ["usage_limit", (c) => { c.stdout.emit("data", JSON.stringify({ is_error: true, result: "You've hit your session limit." })); c.emit("close", 1, null); }],
    ["malformed_response", respondWith("garbage", 0)],
    ["schema_invalid", respondWith(successEnvelope({ result: "no structure for you" }))],
    ["process_error", (c) => { c.stderr.emit("data", "boom"); c.emit("close", 9, null); }],
  ];

  for (const [label, script] of scripts) {
    const { spawnFn, calls } = fakeSpawn(script);
    const request: AiTextRequest = label === "schema_invalid"
      ? { userPrompt: "x", structuredOutput: { schema: SCHEMA } }
      : { userPrompt: "x" };

    await new ClaudeCliProvider({ spawnFn }).generate(request);
    assert.equal(calls.length, 1, `${label} must invoke the CLI exactly once -- retry policy belongs to S3E`);
  }
});

test("the provider settles once and never fires a second time after a timeout", async () => {
  // A late close arriving after the timer already fired must not resolve a second result.
  const { spawnFn } = fakeSpawn((child) => {
    setTimeout(() => {
      child.stdout.emit("data", successEnvelope());
      child.emit("close", 0, null);
    }, 40);
  });

  const provider = new ClaudeCliProvider({ spawnFn });
  const result = await provider.generate({ userPrompt: "x", timeoutMs: 5 });

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "timeout");
  await new Promise((r) => setTimeout(r, 80)); // let the late events land; nothing may throw
});

test("the provider carries no fallback or retry vocabulary", () => {
  const code = providerCode();
  for (const forbidden of [/CodexCliProvider/, /fallbackProvider/, /retryCount/, /maxRetries/, /attemptNumber/, /setTimeout\(\s*\(\)\s*=>\s*this\.generate/]) {
    assert.doesNotMatch(code, forbidden);
  }
});

// =============================================================================================
// §34 -- domain and provider boundaries
// =============================================================================================

test("the Claude provider has no Creative-domain dependency", () => {
  const code = providerCode();

  for (const forbidden of [
    /CreativeInput/,
    /CreativePackage/,
    /ResolvedCreativeGrounding/,
    /Opportunity/,
    /Journey/,
    /BRAND_BIBLE/,
    /BrandBible/,
    /Supabase/,
    /creative-jobs/,
    /creative-generation/,
    /photo|reel|carousel|story/i,
  ]) {
    assert.doesNotMatch(code, forbidden);
  }
});

test("the Claude provider imports nothing but the generic contract and Node built-ins", () => {
  const imports = [...providerCode().matchAll(/from "([^"]+)"/g)].map((match) => match[1]);

  assert.deepEqual([...new Set(imports)].sort(), ["../ai-text-provider.ts", "node:child_process", "node:fs", "node:path"]);
});

test("no Codex, OpenAI API or Anthropic SDK dependency exists", () => {
  const code = providerCode();
  for (const forbidden of [/@anthropic-ai\/sdk/, /openai/i, /api\.anthropic\.com/, /codex/i]) {
    assert.doesNotMatch(code, forbidden);
  }
});

// =============================================================================================
// diagnostics safety (§16) and defaults (§17, §18)
// =============================================================================================

test("diagnostics carry only safe, non-credential facts", async () => {
  const { spawnFn } = fakeSpawn((child) => {
    child.stderr.emit("data", "generic failure");
    child.emit("close", 3, null);
  });
  const result = await new ClaudeCliProvider({ spawnFn }).generate(TEXT_REQUEST);

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.deepEqual(Object.keys(result.diagnostics ?? {}).sort(), ["exitCode", "signal", "stderrBytes", "stdoutBytes"]);
    const serialized = JSON.stringify(result);
    for (const forbidden of [/sk-ant/, /oauth/i, /token/i, /cookie/i, /session_id/i, /Bearer /]) {
      assert.doesNotMatch(serialized, forbidden);
    }
  }
});

test("a successful envelope's session id is never surfaced", async () => {
  const { spawnFn } = fakeSpawn(respondWith(successEnvelope({ session_id: "SECRET-SESSION-ID-abc123" })));
  const result = await new ClaudeCliProvider({ spawnFn }).generate(TEXT_REQUEST);

  assert.equal(result.ok, true);
  assert.doesNotMatch(JSON.stringify(result), /SECRET-SESSION-ID/);
});

test("the provider default timeout leaves real room for a single Stage 2 generation", () => {
  // Quality gate: Stage 2 measured ~24s median, worst single-stage observed well under 60s.
  assert.equal(CLAUDE_CLI_DEFAULT_TIMEOUT_MS, 120_000);
  assert.ok(CLAUDE_CLI_DEFAULT_TIMEOUT_MS >= 60_000, "a single Stage 2 call must not be cut off by the default");
});

test("the output ceiling is bounded and matches the proven hardened limit", () => {
  assert.equal(CLAUDE_CLI_DEFAULT_MAX_OUTPUT_BYTES, 2 * 1024 * 1024);
});

test("an explicit request timeout overrides the provider default", async () => {
  const { spawnFn, children } = fakeSpawn(() => {
    /* never responds */
  });
  const started = Date.now();
  const result = await new ClaudeCliProvider({ spawnFn }).generate({ userPrompt: "x", timeoutMs: 15 });

  assert.equal(result.ok, false);
  assert.ok(Date.now() - started < 5_000, "the request timeout, not the 120s default, must apply");
  assert.equal(children[0].killed, true);
});

test("executable resolution reports a real path or null, and never throws", () => {
  const resolved = resolveClaudeCliExecutable("claude");
  // Absence is a legitimate provider_unavailable condition on a machine without the CLI, not a
  // test failure, so this only constrains the shape when something was found.
  if (resolved !== null && process.platform === "win32") {
    assert.match(resolved, /claude\.exe$/i);
  }
  assert.equal(resolveClaudeCliExecutable("definitely-not-a-real-binary-name-xyz"), process.platform === "win32" ? null : "definitely-not-a-real-binary-name-xyz");
});
