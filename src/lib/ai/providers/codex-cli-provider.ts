import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AiTextFailure, AiTextFailureReason, AiTextProvider, AiTextRequest, AiTextResult } from "../ai-text-provider.ts";

// Content MVP S3C-C. The second concrete AiTextProvider, backed by the locally installed,
// subscription-authenticated Codex CLI. This provider is intentionally standalone: no Creative
// domain imports, no Claude fallback, no retry policy, no API client, no worker integration.

export const CODEX_CLI_PROVIDER_ID = "codex-cli";
export const CODEX_CLI_DEFAULT_TIMEOUT_MS = 120_000;
export const CODEX_CLI_DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

export type SpawnFn = typeof spawn;

export type CodexCliProviderOptions = {
  /** Optional provider-configured Codex model. If absent, Codex CLI default behavior is preserved. */
  model?: string;
  executablePath?: string;
  binary?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  spawnFn?: SpawnFn;
  resolveExecutable?: (binary: string) => string | null;
  now?: () => number;
  tempRoot?: string;
};

export type CodexCliInvocationFiles = {
  cwd: string;
  outputPath: string;
  schemaPath: string | null;
};

function resolveWindowsExecutable(binary: string): string | null {
  const pathDirs = (process.env.PATH ?? process.env.Path ?? "").split(path.delimiter);
  for (const dir of pathDirs) {
    if (!dir) continue;
    const directExe = path.join(dir, `${binary}.exe`);
    if (existsSync(directExe)) return directExe;
  }
  return null;
}

export function resolveCodexCliExecutable(binary = "codex"): string | null {
  return process.platform === "win32" ? resolveWindowsExecutable(binary) : binary;
}

export function createCodexCliInvocationFiles(tempRoot = os.tmpdir()): CodexCliInvocationFiles {
  mkdirSync(tempRoot, { recursive: true });
  const cwd = mkdtempSync(path.join(tempRoot, "codex-cli-provider-"));
  return {
    cwd,
    outputPath: path.join(cwd, "last-message.txt"),
    schemaPath: path.join(cwd, "schema.json"),
  };
}

export function cleanupCodexCliInvocationFiles(files: CodexCliInvocationFiles): void {
  rmSync(files.cwd, { recursive: true, force: true });
}

export function buildCodexCliPrompt(request: AiTextRequest): string {
  return [
    "You are executing a provider-neutral AiTextRequest.",
    "Treat the two sections below as separate transport channels. Do not add explanations.",
    "Return only the final answer requested by the user section.",
    "",
    "## SYSTEM INSTRUCTIONS",
    request.systemPrompt ?? "(none supplied)",
    "",
    "## USER REQUEST",
    request.userPrompt,
  ].join("\n");
}

export function buildCodexCliArgs(request: AiTextRequest, files: CodexCliInvocationFiles, model: string | null): string[] {
  const args = [
    "-C",
    files.cwd,
    "-s",
    "read-only",
    "-a",
    "never",
    ...(model !== null ? ["--model", model] : []),
    "exec",
    "--skip-git-repo-check",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--output-last-message",
    files.outputPath,
  ];

  if (request.structuredOutput) {
    args.push("--output-schema", files.schemaPath as string);
  }
  args.push(buildCodexCliPrompt(request));
  return args;
}

function truncate(text: string, max = 300): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}...` : trimmed;
}

const USAGE_LIMIT_PATTERN = /usage limit|rate limit|quota|too many requests|out of (credits|tokens)|limit reached/i;
const AUTHENTICATION_PATTERN = /not logged in|please log ?in|authentication|unauthenticated|unauthorized|invalid api key|oauth|credentials?|token (has )?expired|chatgpt auth/i;
const SCHEMA_PATTERN = /schema|structured output|output-schema|does not match|validation/i;

function classifyProcessText(text: string): AiTextFailureReason {
  if (USAGE_LIMIT_PATTERN.test(text)) return "usage_limit";
  if (AUTHENTICATION_PATTERN.test(text)) return "authentication";
  if (SCHEMA_PATTERN.test(text)) return "schema_invalid";
  return "process_error";
}

function extractReportedModel(stderr: string): string | null {
  const match = stderr.match(/^model:\s*(.+)$/m);
  return match ? match[1].trim() : null;
}

function parseJsonObject(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error("No JSON object found in Codex final message.");
  }
}

export class CodexCliProvider implements AiTextProvider {
  readonly providerId = CODEX_CLI_PROVIDER_ID;
  private readonly options: CodexCliProviderOptions;

  constructor(options: CodexCliProviderOptions = {}) {
    this.options = options;
  }

  generate(request: AiTextRequest): Promise<AiTextResult> {
    const startedAt = (this.options.now ?? Date.now)();
    const elapsed = (): number => (this.options.now ?? Date.now)() - startedAt;
    const requestedModel = request.model ?? this.options.model ?? null;
    const timeoutMs = request.timeoutMs ?? this.options.timeoutMs ?? CODEX_CLI_DEFAULT_TIMEOUT_MS;
    const maxOutputBytes = this.options.maxOutputBytes ?? CODEX_CLI_DEFAULT_MAX_OUTPUT_BYTES;
    const binary = this.options.binary ?? "codex";

    const fail = (reason: AiTextFailureReason, message: string, diagnostics: Record<string, unknown> = {}): AiTextFailure => ({
      ok: false,
      reason,
      message,
      metadata: { providerId: this.providerId, model: requestedModel, durationMs: elapsed() },
      diagnostics,
    });

    const usingRealSpawn = this.options.spawnFn === undefined;
    const spawnFn = this.options.spawnFn ?? spawn;

    let executable = binary;
    if (this.options.executablePath !== undefined) {
      if (usingRealSpawn && !existsSync(this.options.executablePath)) {
        return Promise.resolve(fail("configuration_error", "The configured Codex CLI executablePath does not exist.", { executableResolved: false }));
      }
      executable = this.options.executablePath;
    } else if (usingRealSpawn) {
      const resolved = (this.options.resolveExecutable ?? resolveCodexCliExecutable)(binary);
      if (!resolved) {
        return Promise.resolve(fail("provider_unavailable", `Could not resolve a directly-spawnable "${binary}" executable.`, { executableResolved: false }));
      }
      executable = resolved;
    }

    let files: CodexCliInvocationFiles | null = null;
    try {
      files = createCodexCliInvocationFiles(this.options.tempRoot);
      if (request.structuredOutput) {
        writeFileSync(files.schemaPath as string, JSON.stringify(request.structuredOutput.schema));
      }
    } catch (err) {
      if (files !== null) cleanupCodexCliInvocationFiles(files);
      return Promise.resolve(fail("configuration_error", `Could not prepare Codex CLI temporary files: ${err instanceof Error ? err.message : String(err)}`));
    }

    const args = buildCodexCliArgs(request, files, requestedModel);

    return new Promise<AiTextResult>((resolvePromise) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      let stdout = "";
      let stderr = "";
      let totalBytes = 0;
      let overLimit = false;

      const diagnostics = (code: number | null, signal: NodeJS.Signals | null): Record<string, unknown> => ({
        exitCode: code,
        signal: signal ?? null,
        stdoutBytes: Buffer.byteLength(stdout, "utf8"),
        stderrBytes: Buffer.byteLength(stderr, "utf8"),
        finalOutputBytes: existsSync(files.outputPath) ? statSync(files.outputPath).size : 0,
      });

      const settle = (result: AiTextResult): void => {
        if (settled) return;
        settled = true;
        if (timer) {
          clearTimeout(timer);
          timer = undefined;
        }
        cleanupCodexCliInvocationFiles(files);
        resolvePromise(result);
      };

      let child: ChildProcess;
      try {
        child = spawnFn(executable, args, { shell: false, cwd: files.cwd });
        child.stdin?.end();
      } catch (err) {
        settle(fail("process_error", `Failed to spawn the Codex CLI: ${err instanceof Error ? err.message : String(err)}`));
        return;
      }

      timer = setTimeout(() => {
        child.kill();
        settle(fail("timeout", `The Codex CLI did not respond within ${timeoutMs}ms.`, { timeoutMs }));
      }, timeoutMs);

      const accumulate = (target: "stdout" | "stderr", chunk: unknown): void => {
        if (overLimit) return;
        const text = String(chunk);
        totalBytes += Buffer.byteLength(text, "utf8");
        if (totalBytes > maxOutputBytes) {
          overLimit = true;
          stdout = "";
          stderr = "";
          child.kill();
          settle(fail("output_too_large", `The Codex CLI produced more than ${maxOutputBytes} bytes of process output; the process was terminated.`, { maxOutputBytes }));
          return;
        }
        if (target === "stdout") stdout += text;
        else stderr += text;
      };

      child.stdout?.on("data", (chunk) => accumulate("stdout", chunk));
      child.stderr?.on("data", (chunk) => accumulate("stderr", chunk));

      child.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "ENOENT") {
          settle(fail("provider_unavailable", "The Codex CLI was not found.", { executableResolved: false }));
          return;
        }
        settle(fail("process_error", `The Codex CLI process failed: ${err.message}`, { code: err.code ?? null }));
      });

      child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
        const safeDiagnostics = diagnostics(code, signal);
        const finalOutputBytes = safeDiagnostics.finalOutputBytes;
        if (typeof finalOutputBytes === "number" && finalOutputBytes > maxOutputBytes) {
          settle(fail("output_too_large", `The Codex CLI final message exceeded ${maxOutputBytes} bytes.`, { maxOutputBytes }));
          return;
        }
        const reportedModel = extractReportedModel(stderr) ?? requestedModel;
        const metadata = { providerId: this.providerId, model: reportedModel, durationMs: elapsed() };

        if (code !== 0) {
          const combined = `${stdout}\n${stderr}`;
          const detail = truncate(combined) || `The Codex CLI exited with code ${code} and produced no output.`;
          settle({
            ok: false,
            reason: classifyProcessText(combined),
            message: detail,
            metadata,
            diagnostics: safeDiagnostics,
          });
          return;
        }

        if (!existsSync(files.outputPath)) {
          settle({ ok: false, reason: "malformed_response", message: "The Codex CLI did not write a final message file.", metadata, diagnostics: safeDiagnostics });
          return;
        }

        const finalMessage = readFileSync(files.outputPath, "utf8");
        if (request.structuredOutput) {
          try {
            const structuredValue = parseJsonObject(finalMessage);
            settle({ ok: true, text: finalMessage.trim(), structuredValue, metadata });
          } catch (err) {
            settle({
              ok: false,
              reason: "malformed_response",
              message: `The Codex CLI final structured message was not a JSON object: ${err instanceof Error ? err.message : String(err)}`,
              metadata,
              diagnostics: safeDiagnostics,
            });
          }
          return;
        }

        const text = finalMessage.trim();
        if (text === "") {
          settle({ ok: false, reason: "malformed_response", message: "The Codex CLI final message was empty.", metadata, diagnostics: safeDiagnostics });
          return;
        }
        settle({ ok: true, text, metadata });
      });
    });
  }
}
