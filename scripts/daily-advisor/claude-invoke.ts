import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import path from "node:path";
import type { ClaudeInvocationResult } from "./types.ts";

// The exact verified-safe invocation shape from LOCAL_AI_BRIDGE.md: -p (non-interactive),
// --tools "" (structurally zero tools -- not a permission restriction, the tools don't exist in
// the session), --output-format json (one clean result field), --no-session-persistence,
// --strict-mcp-config (ignores the user's other configured MCP servers). Exported separately from
// invokeClaude so a test can assert on the exact argv without spawning a real process.
export function buildClaudeArgs(prompt: string): string[] {
  return ["-p", prompt, "--tools", "", "--output-format", "json", "--no-session-persistence", "--strict-mcp-config"];
}

// Windows-only problem, found and fixed during implementation, not assumed: npm's global install
// of the claude CLI on Windows is a `<binary>.cmd` shim (spawn() cannot execute .cmd files with
// shell: false at all -- Windows has no notion of running a batch file without a shell
// interpreter; confirmed live, it throws EINVAL synchronously). shell: true was tried and
// REJECTED, not just avoided on principle: a live test showed cmd.exe's tokenizer corrupting a
// multi-word prompt containing spaces and a colon into a fragment Claude then misinterpreted --
// worse than a clean failure, since it still returned an ok:true-looking response with silently
// wrong content. The shim's own content (read directly) forwards to a real, directly-spawnable
// .exe nested under node_modules -- this resolves past the shim to that real binary and spawns it
// with a genuine, unshelled argv, which was verified end to end to preserve --tools "" and the
// full prompt correctly. If resolution fails, this reports missing-binary (triggering the
// deterministic fallback) rather than falling back to the corrupting shell: true path.
function resolveWindowsExecutable(binary: string): string | null {
  const pathDirs = (process.env.PATH ?? process.env.Path ?? "").split(path.delimiter);
  for (const dir of pathDirs) {
    if (!dir) {
      continue;
    }
    const shimPath = path.join(dir, `${binary}.cmd`);
    if (!existsSync(shimPath)) {
      continue;
    }
    const exePath = path.join(dir, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
    if (existsSync(exePath)) {
      return exePath;
    }
  }
  return null;
}

// Exported for testability -- non-Windows platforms pass the binary name through unchanged (a
// real executable or shebang script there, spawnable directly with shell: false already).
export function resolveClaudeExecutable(binary: string): string | null {
  return process.platform === "win32" ? resolveWindowsExecutable(binary) : binary;
}

export type SpawnFn = typeof spawn;

export type InvokeClaudeOptions = {
  binary?: string;
  timeoutMs?: number;
  spawnFn?: SpawnFn;
  maxOutputBytes?: number;
};

// A single -p turn's JSON response is bounded by the model's own output-token limit -- a few KB
// in practice for this kind of prompt. 2 MB is a generous ceiling that only ever fires on a
// genuinely misbehaving process, not a real response, added after an independent review found no
// size guard existed at all.
const DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

// spawn() with a fixed argv array and shell: false -- the prompt is always passed as a discrete
// argument, never concatenated into a shell string, so prompt content can never be interpreted as
// shell syntax (LOCAL_AI_BRIDGE.md risk #2). spawnFn is injectable so tests never spawn a real
// `claude` process -- see tests/daily-advisor.test.ts's fake spawn implementations. Windows
// executable resolution (see resolveClaudeExecutable above) only runs when spawnFn is the real
// one -- an injected fake never depends on real filesystem/PATH state.
export function invokeClaude(prompt: string, options: InvokeClaudeOptions = {}): Promise<ClaudeInvocationResult> {
  const usingRealSpawn = options.spawnFn === undefined;
  const spawnFn = options.spawnFn ?? spawn;
  const requestedBinary = options.binary ?? "claude";
  const timeoutMs = options.timeoutMs ?? 45000;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

  return new Promise((resolve) => {
    let settled = false;
    const settle = (result: ClaudeInvocationResult) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    let resolvedBinary = requestedBinary;
    if (usingRealSpawn) {
      const resolved = resolveClaudeExecutable(requestedBinary);
      if (!resolved) {
        settle({ ok: false, reason: "missing-binary", detail: `Could not resolve a directly-spawnable "${requestedBinary}" executable on this platform.` });
        return;
      }
      resolvedBinary = resolved;
    }

    let child: ChildProcess;
    try {
      child = spawnFn(resolvedBinary, buildClaudeArgs(prompt), { shell: false });
      child.stdin?.end(); // avoids an observed ~3s "waiting for stdin" probe delay when left open
    } catch (err) {
      settle({ ok: false, reason: "missing-binary", detail: err instanceof Error ? err.message : String(err) });
      return;
    }

    const timer = setTimeout(() => {
      child.kill();
      settle({ ok: false, reason: "timeout", detail: `Claude CLI did not respond within ${timeoutMs}ms.` });
    }, timeoutMs);

    let stdout = "";
    let stderr = "";
    let totalBytes = 0;
    let overLimit = false;

    // Shared by both streams: tracks combined stdout+stderr size and terminates on overflow.
    // Bytes captured before the overflow are discarded, never surfaced in the error detail --
    // found missing entirely by an independent review (no size guard existed before this).
    function accumulate(target: "stdout" | "stderr", chunk: unknown): void {
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
        settle({ ok: false, reason: "output-too-large", detail: `Claude CLI produced more than ${maxOutputBytes} bytes of output; terminated.` });
        return;
      }
      if (target === "stdout") {
        stdout += text;
      } else {
        stderr += text;
      }
    }

    child.stdout?.on("data", (chunk) => accumulate("stdout", chunk));
    child.stderr?.on("data", (chunk) => accumulate("stderr", chunk));

    child.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        settle({ ok: false, reason: "missing-binary", detail: "claude CLI not found on PATH." });
      } else {
        settle({ ok: false, reason: "process-error", detail: err.message });
      }
    });

    child.on("close", (code) => {
      if (code !== 0) {
        settle(classifyProcessFailure(code, stdout, stderr));
        return;
      }
      settle(parseClaudeStdout(stdout));
    });
  });
}

function classifyProcessFailure(code: number | null, stdout: string, stderr: string): ClaudeInvocationResult {
  const combined = `${stdout}\n${stderr}`;
  const detail = combined.trim().slice(0, 300) || `claude exited with code ${code} and no output.`;
  if (/usage limit|rate limit|quota/i.test(combined)) {
    return { ok: false, reason: "usage-limit", detail };
  }
  if (/not logged in|log in|authentication|unauthorized/i.test(combined)) {
    return { ok: false, reason: "auth-error", detail };
  }
  return { ok: false, reason: "process-error", detail };
}

function parseClaudeStdout(stdout: string): ClaudeInvocationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { ok: false, reason: "malformed-response", detail: "Claude output was not valid JSON." };
  }

  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, reason: "malformed-response", detail: "Claude output was not a JSON object." };
  }

  const record = parsed as Record<string, unknown>;
  if (record.is_error) {
    const message = typeof record.result === "string" ? record.result : "Claude reported an error with no message.";
    return classifyProcessFailure(0, message, "");
  }

  if (typeof record.result !== "string" || record.result.trim() === "") {
    return { ok: false, reason: "malformed-response", detail: "Claude response was missing a usable result field." };
  }

  return { ok: true, text: record.result.trim() };
}
