import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { EventEmitter } from "node:events";

import { ClaudeCliProvider, type SpawnFn } from "../src/lib/ai/providers/claude-cli-provider.ts";
import { CodexCliProvider } from "../src/lib/ai/providers/codex-cli-provider.ts";
import { runCreativeJobWithExecutors } from "../src/lib/creative-jobs.ts";

// Production MVP Wave D1 -- R1.1, the repair of the independent review's findings.
//
// Two boundaries are pinned here:
//
//   §11  a spawn refusal is reported as its errno ALONE. libuv writes the resolved executable path
//        into the error's message ("spawn C:\Users\<name>\...\claude.exe EACCES"), and R1 forwarded
//        that string marked SAFE -- so a filesystem path and an OS username could be persisted.
//
//   §10  the FAILURE persistence path now runs the same execution-trace validator the success path
//        always ran. R1 gated `message` in the orchestrator but forwarded `diagnostics` unexamined,
//        and validateExecutionTraceEntry never executed on the path a provider failure takes.

const SAFE_SPAWN_MESSAGE = "Failed to spawn Claude CLI: ENAMETOOLONG";
const SAFE_DIAGNOSTICS = { exitCode: null, signal: null, stdoutBytes: 0, stderrBytes: 0, errorCode: "ENAMETOOLONG" };

// ================================================================================================
// §11 -- synthesized spawn message
// ================================================================================================

const PATHY_CLAUDE_EACCES = Object.assign(new Error("spawn C:\\Users\\Admin\\secret\\claude.exe EACCES"), { code: "EACCES" });

function throwingSpawn(err: unknown): SpawnFn {
  return ((): never => {
    throw err;
  }) as unknown as SpawnFn;
}

// The second spawn-failure shape: the child object is handed back, then the failure arrives on the
// "error" event. This is the branch that used to default to messageSafe: true.
function erroringSpawn(err: unknown): SpawnFn {
  return (() => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      stdin: { end: () => void };
      kill: () => void;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end: () => {} };
    child.kill = () => {};
    queueMicrotask(() => child.emit("error", err));
    return child;
  }) as unknown as SpawnFn;
}

function assertNoPathLeak(message: string): void {
  for (const forbidden of ["Users", "Admin", "secret", "claude.exe", "codex.exe", "C:\\", "spawn C:"]) {
    assert.ok(!message.includes(forbidden), `synthesized message must not contain ${JSON.stringify(forbidden)}: ${message}`);
  }
}

test("R1.1 §11: Claude reports a path-bearing EACCES as the errno alone (synchronous throw)", async () => {
  const provider = new ClaudeCliProvider({ spawnFn: throwingSpawn(PATHY_CLAUDE_EACCES), executablePath: "C:\\Users\\Admin\\secret\\claude.exe" });
  const result = await provider.generate({ userPrompt: "hello" });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "process_error", "classification is unchanged by R1.1");
  assert.equal(result.message, "Failed to spawn Claude CLI: EACCES");
  assert.equal(result.messageSafe, true);
  assert.equal(result.diagnostics?.errorCode, "EACCES", "machine-readable detail is kept");
  assertNoPathLeak(result.message);
});

test("R1.1 §11: Claude reports a path-bearing EACCES as the errno alone (async error event)", async () => {
  const provider = new ClaudeCliProvider({ spawnFn: erroringSpawn(PATHY_CLAUDE_EACCES), executablePath: "C:\\Users\\Admin\\secret\\claude.exe" });
  const result = await provider.generate({ userPrompt: "hello" });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "process_error");
  assert.equal(result.message, "Failed to spawn Claude CLI: EACCES");
  assert.equal(result.messageSafe, true);
  assert.equal(result.diagnostics?.errorCode, "EACCES");
  assertNoPathLeak(result.message);
});

test("R1.1 §11: Codex applies the same synthesis on both spawn-failure shapes", async () => {
  const pathyCodex = Object.assign(new Error("spawn C:\\Users\\Admin\\secret\\codex.exe EACCES"), { code: "EACCES" });

  for (const spawnFn of [throwingSpawn(pathyCodex), erroringSpawn(pathyCodex)]) {
    const provider = new CodexCliProvider({ spawnFn, executablePath: "C:\\Users\\Admin\\secret\\codex.exe", tempRoot: os.tmpdir() });
    const result = await provider.generate({ userPrompt: "hello" });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, "process_error");
    assert.equal(result.message, "Failed to spawn Codex CLI: EACCES");
    assert.equal(result.messageSafe, true);
    assert.equal(result.diagnostics?.errorCode, "EACCES");
    assertNoPathLeak(result.message);
  }
});

test("R1.1 §11: ENOENT still classifies as provider_unavailable, not process_error", async () => {
  const enoent = Object.assign(new Error("spawn C:\\Users\\Admin\\secret\\claude.exe ENOENT"), { code: "ENOENT" });
  const provider = new ClaudeCliProvider({ spawnFn: erroringSpawn(enoent), executablePath: "C:\\Users\\Admin\\secret\\claude.exe" });
  const result = await provider.generate({ userPrompt: "hello" });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "provider_unavailable", "the ENOENT boundary is untouched");
  assert.equal(result.diagnostics?.executableResolved, false);
  assertNoPathLeak(result.message);
});

test("R1.1 §11: the ERR_* argv-echo family stays UNSAFE even though the message is now synthesized", async () => {
  // Synthesis alone would already make this message harmless. The gate is kept anyway: if a future
  // change ever reverts to forwarding err.message, this family is still refused persistence.
  const argvEcho = Object.assign(
    new Error("The argument 'args[2]' must be a string without null bytes. Received 'PROMPT\u0000LEAK'"),
    { code: "ERR_INVALID_ARG_VALUE" },
  );
  const provider = new ClaudeCliProvider({ spawnFn: throwingSpawn(argvEcho), executablePath: process.execPath });
  const result = await provider.generate({ userPrompt: "hello" });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "process_error");
  assert.equal(result.messageSafe, false, "ERR_* remains unsafe by policy");
  assert.equal(result.diagnostics?.errorCode, "ERR_INVALID_ARG_VALUE");
  assert.doesNotMatch(result.message, /PROMPT/, "and the argv value is absent from the message too");
});

test("R1.1 §11: a throw carrying no errno yields no errno and an unsafe message", async () => {
  const provider = new ClaudeCliProvider({ spawnFn: throwingSpawn("not an Error"), executablePath: process.execPath });
  const result = await provider.generate({ userPrompt: "hello" });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.message, "Failed to spawn Claude CLI: the spawn was rejected without an error code.");
  assert.equal(result.messageSafe, false);
  assert.equal(result.diagnostics?.errorCode, null);
});

// ================================================================================================
// §10 -- failure-path persistence validation
// ================================================================================================

// Drives the REAL runner down the executor-failure branch -- the exact path Wave D1 took, and the
// one that previously reached the RPC without the validator ever running.
function failurePathClient() {
  const job: Record<string, unknown> = {
    id: "job-1",
    opportunity_id: null,
    intent: { schemaVersion: "v1", text: "Give me something easy today" },
    status: "queued",
    worker_type: "creative_ai",
    attempt_count: 0,
    result: {},
    last_error: null,
    created_at: "2026-08-26T09:00:00.000Z",
    updated_at: "2026-08-26T09:00:00.000Z",
    started_at: null,
    completed_at: null,
    failed_at: null,
  };
  const attempt: Record<string, unknown> = {};
  const rpcCalls: string[] = [];

  const builder = {
    eq: () => builder,
    order: () => builder,
    limit: () => builder,
    maybeSingle: async () => ({ data: job, error: null }),
    select: () => ({
      maybeSingle: async () => ({ data: job, error: null }),
      single: async () => ({ data: job, error: null }),
    }),
  };

  const client = {
    from: () => ({ select: () => builder }),
    rpc(functionName: string, args: Record<string, unknown>) {
      rpcCalls.push(functionName);
      return {
        async maybeSingle() {
          if (functionName === "claim_creative_job_with_attempt") {
            job.status = "running";
            job.attempt_count = 1;
            job.started_at = "2026-08-26T09:03:54.120Z";
            return { data: { ...job, attempt_id: "attempt-1", attempt_number: 1 }, error: null };
          }
          if (functionName === "finish_creative_job") {
            job.status = args.p_outcome;
            job.last_error = args.p_last_error ?? null;
            return { data: job, error: null };
          }
          if (functionName.startsWith("finish_creative_job_attempt")) {
            Object.assign(attempt, {
              id: "attempt-1",
              creative_job_id: "job-1",
              attempt_number: 1,
              worker_type: "creative_ai",
              status: args.p_outcome,
              started_at: "2026-08-26T09:03:54.120Z",
              created_at: "2026-08-26T09:03:54.120Z",
              error_code: args.p_error_code ?? null,
              error_message: args.p_error_message ?? null,
              // jsonb round-trip, so assertions read what the database would hand back.
              ai_execution_trace:
                args.p_ai_execution_trace === undefined ? null : JSON.parse(JSON.stringify(args.p_ai_execution_trace)),
            });
            return { data: attempt, error: null };
          }
          throw new Error(`Unexpected RPC: ${functionName}`);
        },
      };
    },
  };

  return { client, attempt, rpcCalls };
}

async function persistFailureTrace(trace: unknown[]): Promise<{ attempt: Record<string, unknown>; rpcCalls: string[] }> {
  const store = failurePathClient();
  const executor = () =>
    Promise.resolve({
      creativeJobExecutorFailure: true as const,
      code: "ai_process_error",
      message: "Creative AI generation failed at the creative_body stage: process_error.",
      attemptOutcome: "failed" as const,
      executionTrace: trace as never,
    });

  const run = await runCreativeJobWithExecutors(store.client as never, "job-1", { creative_ai: executor as never });
  assert.equal(run.ok, false, "an executor failure must still fail the job");
  return { attempt: store.attempt, rpcCalls: store.rpcCalls };
}

const VALID_FAILURE_ENTRY = {
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
};

test("R1.1 §10-A: a valid enriched failure trace persists unchanged through the real failure path", async () => {
  const { attempt, rpcCalls } = await persistFailureTrace([VALID_FAILURE_ENTRY]);

  assert.ok(rpcCalls.includes("finish_creative_job_attempt_with_trace"), "the trace-aware RPC is used");
  assert.deepEqual(attempt.ai_execution_trace, [VALID_FAILURE_ENTRY], "valid entries survive byte for byte");
});

test("R1.1 §10-G: every diagnostics shape the shipped adapters emit still persists", async () => {
  const claudeExit = { ...VALID_FAILURE_ENTRY, diagnostics: { exitCode: 1, signal: null, stdoutBytes: 812, stderrBytes: 96 } };
  const codexExit = {
    ...VALID_FAILURE_ENTRY,
    providerId: "codex-cli",
    model: "gpt-5.6-sol",
    invocationNumber: 2,
    action: "stop",
    diagnostics: { exitCode: 2, signal: "SIGTERM", stdoutBytes: 0, stderrBytes: 12, finalOutputBytes: 0 },
  };
  const timedOut = { ...VALID_FAILURE_ENTRY, invocationNumber: 3, action: "stop", failureReason: "timeout", diagnostics: { timeoutMs: 120000 } };
  const unresolved = {
    ...VALID_FAILURE_ENTRY,
    invocationNumber: 4,
    action: "stop",
    failureReason: "provider_unavailable",
    diagnostics: { executableResolved: false },
  };
  const capped = {
    ...VALID_FAILURE_ENTRY,
    invocationNumber: 5,
    action: "stop",
    failureReason: "output_too_large",
    diagnostics: { maxOutputBytes: 2097152 },
  };

  const entries = [claudeExit, codexExit, timedOut, unresolved, capped];
  const { attempt } = await persistFailureTrace(entries);
  assert.deepEqual(attempt.ai_execution_trace, entries, "no currently-emitted diagnostics shape is rejected");
});

test("R1.1 §10-B: diagnostics carrying an unknown key are not persisted unchecked", async () => {
  const { attempt, rpcCalls } = await persistFailureTrace([
    { ...VALID_FAILURE_ENTRY, diagnostics: { exitCode: 1, stdout: "+ claude --print ... raw output" } },
  ]);

  assert.equal(attempt.ai_execution_trace, null, "the whole trace is withheld rather than partially trusted");
  assert.ok(rpcCalls.includes("finish_creative_job_attempt"), "it falls back to the untraced RPC");
  assert.ok(!rpcCalls.includes("finish_creative_job_attempt_with_trace"));
  assert.doesNotMatch(JSON.stringify(attempt), /raw output/);
});

test("R1.1 §10-C: diagnostics carrying nested arbitrary data are not persisted unchecked", async () => {
  for (const diagnostics of [
    { exitCode: { smuggled: "sk-live-do-not-persist" } },
    { errorCode: ["ENAMETOOLONG", "and a whole prompt"] },
    { signal: { nested: { deeper: "stderr text" } } },
  ]) {
    const { attempt } = await persistFailureTrace([{ ...VALID_FAILURE_ENTRY, diagnostics }]);
    assert.equal(attempt.ai_execution_trace, null, `nested value must be refused: ${JSON.stringify(diagnostics)}`);
    assert.doesNotMatch(JSON.stringify(attempt), /sk-live-do-not-persist|whole prompt|stderr text/);
  }
});

test("R1.1 §10-D: an over-long failure message cannot bypass the existing bound on this path", async () => {
  const { attempt } = await persistFailureTrace([{ ...VALID_FAILURE_ENTRY, message: "x".repeat(501) }]);

  assert.equal(attempt.ai_execution_trace, null);
  assert.doesNotMatch(JSON.stringify(attempt), /xxxxxxxxxx/);
});

test("R1.1 §10-E: success entries still cannot carry failure detail on this path", async () => {
  const { attempt } = await persistFailureTrace([
    { stage: "creative_body", providerId: "claude-cli", model: "opus", invocationNumber: 1, providerInvocationNumber: 1, outcome: "success", durationMs: 5, action: "accepted", message: SAFE_SPAWN_MESSAGE },
  ]);

  assert.equal(attempt.ai_execution_trace, null);
});

test("R1.1 §10-F: legacy trace entries carrying neither new field remain accepted", async () => {
  const legacy = [
    { stage: "format_decision", providerId: "claude-cli", model: "opus", invocationNumber: 1, providerInvocationNumber: 1, outcome: "success", durationMs: 1200, action: "accepted" },
    { stage: "creative_body", providerId: "claude-cli", model: "opus", invocationNumber: 2, providerInvocationNumber: 2, outcome: "failure", failureReason: "usage_limit", durationMs: 300, action: "stop" },
  ];

  const { attempt } = await persistFailureTrace(legacy);
  assert.deepEqual(attempt.ai_execution_trace, legacy);
});

test("R1.1 §10: structurally invalid entries are refused -- the array-only inlet is now closed", async () => {
  // isCreativeJobExecutorFailure still only checks Array.isArray, deliberately left unchanged. The
  // persistence boundary is what rejects the contents now.
  const { attempt } = await persistFailureTrace([{ stage: "not_a_stage" }, "a bare string", 42]);
  assert.equal(attempt.ai_execution_trace, null);
});

test("R1.1 §10: a failure with no trace at all still uses the untraced RPC and leaves the column NULL", async () => {
  const store = failurePathClient();
  const executor = () =>
    Promise.resolve({
      creativeJobExecutorFailure: true as const,
      code: "unsupported_format_for_request",
      message: "Refused before any provider ran.",
      attemptOutcome: "failed" as const,
      executionTrace: [] as never,
    });

  await runCreativeJobWithExecutors(store.client as never, "job-1", { creative_ai: executor as never });

  // An empty array is a real, valid trace ("AI ran zero invocations"), so it still takes the
  // trace-aware RPC -- unchanged from before R1.1.
  assert.ok(store.rpcCalls.includes("finish_creative_job_attempt_with_trace"));
  assert.deepEqual(store.attempt.ai_execution_trace, []);
});
