import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

import type {
  AiTextFailure,
  AiTextFailureReason,
  AiTextProvider,
  AiTextRequest,
  AiTextResult,
  AiTextUsageMetadata,
} from "../ai-text-provider.ts";

// Content MVP S3C-B. The first real implementation of the provider-neutral AiTextProvider from
// S3C-A, backed by the locally installed, subscription-authenticated Claude Code CLI.
//
// This module knows NOTHING about the Creative domain. It never imports CreativeInput,
// CreativePackageContentV2, Opportunities, Journey, BRAND_BIBLE or Supabase, and it never inspects
// the schema it is handed. Its entire job is: run one Claude CLI process, and translate whatever
// came back into the generic AiTextResult vocabulary.
//
// Subscription authentication only. There is no Anthropic SDK here, no API client, and
// ANTHROPIC_API_KEY is neither read nor required. `--bare` is deliberately NEVER passed: the CLI's
// own help states that under --bare "Anthropic auth is strictly ANTHROPIC_API_KEY or apiKeyHelper
// (OAuth and keychain are never read)", which is precisely the behavior this provider must avoid.

export const CLAUDE_CLI_PROVIDER_ID = "claude-cli";

// The quality gate (docs/content-mvp-quality-gate.md) froze Opus as the Content MVP model. It
// lives HERE, in provider configuration, and nowhere else -- not in S3B's prompt or contracts, not
// in CreativeInput, not in CreativePackageContentV2, and not in the generic AiTextProvider
// interface. A future CodexCliProvider must use its OWN configured default; a model string is
// provider-specific vocabulary and must never be handed across a fallback boundary. "opus" is the
// CLI's own alias for the latest Opus, so this does not pin a dated model id.
export const CLAUDE_CLI_DEFAULT_MODEL = "opus";

// Measured single-call latency during the quality gate: Stage 1 ~10s, Stage 2 ~24s, worst observed
// combined ~50s across two calls. This ceiling is per INVOCATION, so it only has to cover the
// slower single stage; 120s leaves roughly 4x headroom over the worst measured Stage 2 so ordinary
// slowness is never misreported as a timeout. Callers may override via AiTextRequest.timeoutMs.
export const CLAUDE_CLI_DEFAULT_TIMEOUT_MS = 120_000;

// Same ceiling the hardened Daily Advisor invoker settled on. A single -p turn is bounded by the
// model's own output-token limit (a few KB here), so this only ever fires on a genuinely
// misbehaving process, never on a real response.
export const CLAUDE_CLI_DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

export type SpawnFn = typeof spawn;

export type ClaudeCliProviderOptions = {
  /** Provider-configured default model. Overridden per call by AiTextRequest.model. */
  model?: string;
  /** Explicit executable path. A path that does not exist is a configuration_error, not a missing install. */
  executablePath?: string;
  /** Binary name to resolve on PATH. Defaults to "claude". */
  binary?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  /** Injection seam so unit tests never spawn a real Claude process. */
  spawnFn?: SpawnFn;
  /** Injection seam for executable resolution, independent of the spawn seam. */
  resolveExecutable?: (binary: string) => string | null;
  /** Injection seam for wall-clock duration, so tests can assert a deterministic durationMs. */
  now?: () => number;
};

// ---------------------------------------------------------------------------------------------
// Executable resolution
// ---------------------------------------------------------------------------------------------

// Windows-specific, and load-bearing: npm's global install of the Claude CLI is a `claude.cmd`
// batch shim. spawn() cannot execute a .cmd with shell: false (Windows has no way to run a batch
// file without a shell interpreter), and shell: true is not an acceptable escape hatch here --
// this repo previously proved live that cmd.exe's tokenizer corrupts multi-word prompts, producing
// a plausible-looking but silently wrong response rather than a clean failure. Prompt text is
// attacker-influenced business content, so it must never reach a shell tokenizer at all.
//
// Two shapes are handled, in order: a real `claude.exe` sitting directly on PATH (the native
// `claude install` layout), then the npm shim, resolved PAST the shim to the real .exe it forwards
// to. The nested path is derived from the PATH directory, never hardcoded to any user's home.
function resolveWindowsExecutable(binary: string): string | null {
  const pathDirs = (process.env.PATH ?? process.env.Path ?? "").split(path.delimiter);
  for (const dir of pathDirs) {
    if (!dir) {
      continue;
    }
    const directExe = path.join(dir, `${binary}.exe`);
    if (existsSync(directExe)) {
      return directExe;
    }
    if (!existsSync(path.join(dir, `${binary}.cmd`))) {
      continue;
    }
    const nestedExe = path.join(dir, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
    if (existsSync(nestedExe)) {
      return nestedExe;
    }
  }
  return null;
}

// Non-Windows platforms pass the binary name straight through: it is a real executable or a
// shebang script there, directly spawnable with shell: false already.
export function resolveClaudeCliExecutable(binary = "claude"): string | null {
  return process.platform === "win32" ? resolveWindowsExecutable(binary) : binary;
}

// ---------------------------------------------------------------------------------------------
// Argument construction
// ---------------------------------------------------------------------------------------------

// Verified against the installed CLI (2.1.222) during S3C-B preflight rather than recalled:
//
//   -p                        non-interactive, print and exit
//   --model <alias|id>        "opus" is an accepted alias for the latest Opus
//   --tools ""                structurally zero tools -- the tools do not exist in the session
//   --output-format json      one machine-readable result envelope
//   --no-session-persistence  nothing is written to disk, nothing is resumable
//   --strict-mcp-config       ignores every MCP server the user has configured elsewhere
//   --safe-mode               see the note below
//   --system-prompt <text>    a real, first-class system-prompt channel
//   --json-schema <json>      structured-output validation
//
// --safe-mode is a DELIBERATE addition beyond the flag set the Daily Advisor uses, and it was
// added on evidence, not preference. Probing the installed CLI showed that --system-prompt alone
// does NOT stop CLAUDE.md / AGENTS.md auto-discovery: a control prompt run inside this repo still
// answered YES to "do your instructions mention a bakery, Aly, Pon, or a Product Lab". That means
// ambient repository instructions were silently joining the model's context and changing the
// effective prompt -- which would quietly violate S3B's frozen canonical prompt. The same probe
// with --safe-mode answered NO. --safe-mode disables CLAUDE.md, skills, plugins, hooks, MCP
// servers and custom agents while explicitly leaving auth, model selection and permissions working
// normally, so subscription OAuth is unaffected (verified live).
//
// --bare is NEVER passed. It would force ANTHROPIC_API_KEY / apiKeyHelper auth and break the
// subscription requirement.
//
// The prompt, the system prompt and the schema are always discrete argv entries. Nothing is ever
// interpolated into a command string.
export function buildClaudeCliArgs(request: AiTextRequest, model: string): string[] {
  const args = [
    "-p",
    request.userPrompt,
    "--model",
    model,
    "--tools",
    "",
    "--output-format",
    "json",
    "--no-session-persistence",
    "--strict-mcp-config",
    "--safe-mode",
  ];

  // Mapped honestly onto the CLI's own system-prompt channel rather than concatenated into the
  // user prompt, so S3B's canonical request reaches the model with its two halves intact. When the
  // generic request supplies no system prompt the flag is omitted entirely -- this provider does
  // not invent one.
  if (request.systemPrompt !== undefined) {
    args.push("--system-prompt", request.systemPrompt);
  }

  // Exactly the caller's schema, forwarded verbatim. This provider never authors, wraps, narrows
  // or second-guesses a schema, and has no idea what a Creative Package is. The generic
  // structuredOutput.schemaName has no counterpart in the CLI's interface and is therefore not
  // mapped -- inventing a place to put it would be dishonest.
  if (request.structuredOutput) {
    args.push("--json-schema", JSON.stringify(request.structuredOutput.schema));
  }

  return args;
}

// ---------------------------------------------------------------------------------------------
// Envelope reading
// ---------------------------------------------------------------------------------------------

type ParsedEnvelope = Record<string, unknown>;

function parseEnvelope(stdout: string): ParsedEnvelope | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  return parsed as ParsedEnvelope;
}

// The CLI reports per-model usage keyed by canonical model id, e.g. { "claude-opus-5": {...} }.
// Observed live: a run can legitimately contain MORE than one key (a --safe-mode run also showed a
// small Haiku entry alongside Opus), so "the first key" is not a safe reading. Prefer the single
// key when there is only one, otherwise the key matching what was actually requested, otherwise
// fall back to reporting the requested model. Nothing is invented in any branch.
function resolveReportedModel(envelope: ParsedEnvelope, requestedModel: string): string {
  const modelUsage = envelope.modelUsage;
  if (typeof modelUsage === "object" && modelUsage !== null) {
    const keys = Object.keys(modelUsage as Record<string, unknown>);
    if (keys.length === 1) {
      return keys[0];
    }
    const matched = keys.find((key) => key.toLowerCase().includes(requestedModel.toLowerCase()));
    if (matched) {
      return matched;
    }
  }
  return requestedModel;
}

// Only the two token counts the generic contract defines, and only when the CLI actually reported
// them. total_cost_usd is deliberately NOT mapped: under a subscription it is an API-equivalent
// estimate, not money spent, and the generic contract has no honest place for it.
function readUsage(envelope: ParsedEnvelope): AiTextUsageMetadata | undefined {
  const usage = envelope.usage;
  if (typeof usage !== "object" || usage === null) {
    return undefined;
  }
  const record = usage as Record<string, unknown>;
  const inputTokens = typeof record.input_tokens === "number" ? record.input_tokens : undefined;
  const outputTokens = typeof record.output_tokens === "number" ? record.output_tokens : undefined;
  if (inputTokens === undefined && outputTokens === undefined) {
    return undefined;
  }
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
  };
}

// ---------------------------------------------------------------------------------------------
// Failure classification
// ---------------------------------------------------------------------------------------------

// Checked before the authentication patterns: "session limit" and "usage limit" messages are the
// quota signal and must never be mistaken for a login problem, because the two lead a future
// orchestrator to completely different decisions (wait / switch provider vs. re-authenticate).
const USAGE_LIMIT_PATTERN = /usage limit|session limit|rate limit|quota|too many requests|out of (credits|tokens)/i;
const AUTHENTICATION_PATTERN = /not logged in|please log ?in|authentication|unauthenticated|unauthorized|invalid api key|oauth|credentials?|token (has )?expired/i;

function classifyMessage(text: string): AiTextFailureReason {
  if (USAGE_LIMIT_PATTERN.test(text)) {
    return "usage_limit";
  }
  if (AUTHENTICATION_PATTERN.test(text)) {
    return "authentication";
  }
  return "process_error";
}

function truncate(text: string, max = 300): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}...` : trimmed;
}

// ---------------------------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------------------------

export class ClaudeCliProvider implements AiTextProvider {
  // Stable and provider-specific, and deliberately WITHOUT the model in it: "claude-cli" is the
  // adapter's identity, and switching the model must not change who ran the call.
  readonly providerId = CLAUDE_CLI_PROVIDER_ID;

  private readonly options: ClaudeCliProviderOptions;

  constructor(options: ClaudeCliProviderOptions = {}) {
    this.options = options;
  }

  // Exactly ONE process invocation per call. This provider never retries -- not on malformed
  // output, not on a schema failure, not on a usage limit, not on a timeout -- and never falls
  // back to another provider. It executes and classifies; retry and fallback policy belongs to the
  // orchestrator (S3E), and putting either here would hide a second call from the layer whose job
  // it is to decide whether a second call is wanted at all.
  generate(request: AiTextRequest): Promise<AiTextResult> {
    const startedAt = (this.options.now ?? Date.now)();
    const elapsed = (): number => (this.options.now ?? Date.now)() - startedAt;

    // Precedence: explicit per-request model, then this provider's configured default, then Opus.
    const model = request.model ?? this.options.model ?? CLAUDE_CLI_DEFAULT_MODEL;
    const timeoutMs = request.timeoutMs ?? this.options.timeoutMs ?? CLAUDE_CLI_DEFAULT_TIMEOUT_MS;
    const maxOutputBytes = this.options.maxOutputBytes ?? CLAUDE_CLI_DEFAULT_MAX_OUTPUT_BYTES;
    const binary = this.options.binary ?? "claude";

    const fail = (
      reason: AiTextFailureReason,
      message: string,
      diagnostics: Record<string, unknown> = {},
    ): AiTextFailure => ({
      ok: false,
      reason,
      message,
      metadata: { providerId: this.providerId, model, durationMs: elapsed() },
      diagnostics,
    });

    // ---- 1. local configuration, before anything is spawned --------------------------------
    let args: string[];
    try {
      args = buildClaudeCliArgs(request, model);
    } catch (err) {
      return Promise.resolve(
        fail("configuration_error", `The supplied structured-output schema could not be serialized: ${err instanceof Error ? err.message : String(err)}`),
      );
    }

    // ---- 2. executable resolution -----------------------------------------------------------
    // An injected spawnFn bypasses resolution entirely so unit tests never depend on real PATH or
    // filesystem state -- the same seam the Daily Advisor invoker proved.
    const usingRealSpawn = this.options.spawnFn === undefined;
    const spawnFn = this.options.spawnFn ?? spawn;

    let executable = binary;
    if (this.options.executablePath !== undefined) {
      // An explicitly configured path that is not there is a local misconfiguration, which is a
      // different problem from "Claude is not installed" and must not be reported as the latter.
      if (usingRealSpawn && !existsSync(this.options.executablePath)) {
        return Promise.resolve(
          fail("configuration_error", "The configured Claude CLI executablePath does not exist.", { executableResolved: false }),
        );
      }
      executable = this.options.executablePath;
    } else if (usingRealSpawn) {
      const resolve = this.options.resolveExecutable ?? resolveClaudeCliExecutable;
      const resolved = resolve(binary);
      if (!resolved) {
        return Promise.resolve(
          fail("provider_unavailable", `Could not resolve a directly-spawnable "${binary}" executable on this platform.`, { executableResolved: false }),
        );
      }
      executable = resolved;
    }

    return new Promise<AiTextResult>((resolvePromise) => {
      let settled = false;
      // Explicitly initialised: the timer can only start once the child actually exists, but
      // `settle` closes over it and may run before then (a synchronous spawn failure).
      let timer: NodeJS.Timeout | undefined = undefined;

      // Every exit path funnels through here, so the Promise settles exactly once and the timer is
      // always cleared -- no dangling handles, no double-resolve.
      const settle = (result: AiTextResult): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (timer) {
          clearTimeout(timer);
        }
        resolvePromise(result);
      };

      let child: ChildProcess;
      try {
        // shell: false, fixed argv array. Prompt and schema are discrete arguments and can never
        // be interpreted as shell syntax.
        child = spawnFn(executable, args, { shell: false });
        // Closing stdin immediately avoids an observed multi-second "waiting for stdin" probe.
        child.stdin?.end();
      } catch (err) {
        settle(fail("process_error", `Failed to spawn the Claude CLI: ${err instanceof Error ? err.message : String(err)}`));
        return;
      }

      timer = setTimeout(() => {
        child.kill();
        settle(fail("timeout", `The Claude CLI did not respond within ${timeoutMs}ms.`, { timeoutMs }));
      }, timeoutMs);

      let stdout = "";
      let stderr = "";
      let totalBytes = 0;
      let overLimit = false;

      // Bounded buffering across BOTH streams. On overflow the captured bytes are dropped, never
      // surfaced in the failure, and the child is killed rather than left to keep producing.
      const accumulate = (target: "stdout" | "stderr", chunk: unknown): void => {
        if (overLimit) {
          return;
        }
        const text = String(chunk);
        totalBytes += Buffer.byteLength(text, "utf8");
        if (totalBytes > maxOutputBytes) {
          overLimit = true;
          stdout = "";
          stderr = "";
          child.kill();
          settle(fail("output_too_large", `The Claude CLI produced more than ${maxOutputBytes} bytes of output; the process was terminated.`, { maxOutputBytes }));
          return;
        }
        if (target === "stdout") {
          stdout += text;
        } else {
          stderr += text;
        }
      };

      child.stdout?.on("data", (chunk) => accumulate("stdout", chunk));
      child.stderr?.on("data", (chunk) => accumulate("stderr", chunk));

      child.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "ENOENT") {
          settle(fail("provider_unavailable", "The Claude CLI was not found.", { executableResolved: false }));
          return;
        }
        settle(fail("process_error", `The Claude CLI process failed: ${err.message}`, { code: err.code ?? null }));
      });

      child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
        // Byte counts, never content: enough to tell "it said nothing" from "it said a lot"
        // without putting model output or environment detail into an error object.
        const diagnostics: Record<string, unknown> = {
          exitCode: code,
          signal: signal ?? null,
          stdoutBytes: Buffer.byteLength(stdout, "utf8"),
          stderrBytes: Buffer.byteLength(stderr, "utf8"),
        };

        const envelope = parseEnvelope(stdout);

        // ---- THE LOAD-BEARING CASE -------------------------------------------------------
        // Proven live during S3B.1: Claude can exit with code 1 and an EMPTY stderr while stdout
        // still holds a perfectly valid JSON error envelope saying "You've hit your session
        // limit...". Classifying on exit code or stderr alone would bury that as a generic
        // process_error and destroy the one signal an orchestrator most needs to act on. So the
        // envelope is read FIRST, regardless of exit code.
        if (envelope && envelope.is_error === true) {
          const message = typeof envelope.result === "string" && envelope.result.trim() !== ""
            ? envelope.result
            : "The Claude CLI reported an error with no message.";
          settle(fail(classifyMessage(message), truncate(message), diagnostics));
          return;
        }

        if (code !== 0) {
          // No structured error to read. Fall back to scanning whatever text there is, so a
          // plain-text quota or login failure still lands on its specific reason rather than
          // collapsing into process_error.
          const combined = `${stdout}\n${stderr}`;
          const detail = truncate(combined) || `The Claude CLI exited with code ${code} and produced no output.`;
          settle(fail(classifyMessage(combined), detail, diagnostics));
          return;
        }

        if (!envelope) {
          settle(fail("malformed_response", "The Claude CLI returned output that was not a JSON object.", diagnostics));
          return;
        }

        settle(this.readSuccessEnvelope(request, envelope, model, elapsed(), diagnostics));
      });
    });
  }

  private readSuccessEnvelope(
    request: AiTextRequest,
    envelope: ParsedEnvelope,
    requestedModel: string,
    durationMs: number,
    diagnostics: Record<string, unknown>,
  ): AiTextResult {
    const usage = readUsage(envelope);
    const metadata = {
      providerId: this.providerId,
      model: resolveReportedModel(envelope, requestedModel),
      durationMs,
      ...(usage ? { usage } : {}),
    };

    const text = typeof envelope.result === "string" ? envelope.result.trim() : "";

    if (request.structuredOutput) {
      // Verified live: with --json-schema the CLI returns the validated value under
      // `structured_output`, AND the same value as a JSON string in `result`. Both are mapped --
      // structuredValue from the object the CLI already parsed and validated, text from `result`
      // -- so nothing is stringified and reparsed.
      const structured = envelope.structured_output;
      if (typeof structured !== "object" || structured === null) {
        // Structured output was requested and the run otherwise succeeded, but no validated value
        // came back. That is a schema-conformance failure the provider can honestly identify, and
        // it is deliberately NOT merged with malformed_response: S3E's single permitted retry
        // wants to tell "the model broke the schema" apart from "the envelope was garbage".
        return {
          ok: false,
          reason: "schema_invalid",
          message: "The Claude CLI returned no structured output for a request that supplied a JSON schema.",
          metadata: { providerId: this.providerId, model: metadata.model, durationMs },
          diagnostics,
        };
      }
      return { ok: true, text, structuredValue: structured, metadata };
    }

    if (text === "") {
      return {
        ok: false,
        reason: "malformed_response",
        message: "The Claude CLI response contained no usable result text.",
        metadata: { providerId: this.providerId, model: metadata.model, durationMs },
        diagnostics,
      };
    }

    // Text-only: structuredValue is absent entirely, not null or an empty object.
    return { ok: true, text, metadata };
  }
}
