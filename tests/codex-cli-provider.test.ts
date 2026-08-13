import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AiTextProvider, AiTextRequest } from "../src/lib/ai/ai-text-provider.ts";
import {
  CODEX_CLI_DEFAULT_MAX_OUTPUT_BYTES,
  CODEX_CLI_DEFAULT_TIMEOUT_MS,
  CODEX_CLI_PROVIDER_ID,
  CodexCliProvider,
  buildCodexCliArgs,
  buildCodexCliPrompt,
  cleanupCodexCliInvocationFiles,
  createCodexCliInvocationFiles,
  resolveCodexCliExecutable,
  type SpawnFn,
} from "../src/lib/ai/providers/codex-cli-provider.ts";

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

function fakeSpawn(script: (child: FakeChildProcess, call: SpawnCall) => void): { spawnFn: SpawnFn; calls: SpawnCall[]; children: FakeChildProcess[] } {
  const calls: SpawnCall[] = [];
  const children: FakeChildProcess[] = [];
  const spawnFn = ((executable: string, args: string[], options: Record<string, unknown>) => {
    const call = { executable, args, options };
    calls.push(call);
    const child = new FakeChildProcess();
    children.push(child);
    queueMicrotask(() => script(child, call));
    return child;
  }) as unknown as SpawnFn;
  return { spawnFn, calls, children };
}

function argAfter(args: string[], flag: string): string {
  const index = args.indexOf(flag);
  assert.notEqual(index, -1, `${flag} missing`);
  return args[index + 1];
}

function writeLastMessage(call: SpawnCall, value: string): void {
  writeFileSync(argAfter(call.args, "--output-last-message"), value);
}

function success(value = "provider-ok", stderr = "model: gpt-5.6-sol\n"): (child: FakeChildProcess, call: SpawnCall) => void {
  return (child, call) => {
    writeLastMessage(call, value);
    child.stderr.emit("data", stderr);
    child.emit("close", 0, null);
  };
}

const TEXT_REQUEST: AiTextRequest = { systemPrompt: "You are terse.", userPrompt: "Reply provider-ok." };
const SCHEMA = {
  type: "object",
  properties: { status: { type: "string", const: "provider-ok" } },
  required: ["status"],
  additionalProperties: false,
};

const PROVIDER_SOURCE_URL = new URL("../src/lib/ai/providers/codex-cli-provider.ts", import.meta.url);

function providerCode(): string {
  const stripped = readFileSync(PROVIDER_SOURCE_URL, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
  assert.match(stripped, /export class CodexCliProvider/);
  return stripped;
}

function tempRoot(): string {
  return path.join(os.tmpdir(), `codex-provider-test-${process.pid}-${Math.random().toString(16).slice(2)}`);
}

test("A. CodexCliProvider satisfies the generic AiTextProvider contract", () => {
  const provider: AiTextProvider = new CodexCliProvider();
  assert.equal(typeof provider.providerId, "string");
  assert.equal(typeof provider.generate, "function");
});

test("B. providerId is stable and carries no model", () => {
  assert.equal(CODEX_CLI_PROVIDER_ID, "codex-cli");
  assert.equal(new CodexCliProvider().providerId, "codex-cli");
  assert.doesNotMatch(CODEX_CLI_PROVIDER_ID, /gpt|opus|sonnet/i);
});

test("C. default behavior omits --model and preserves the qualified Codex CLI default runtime", async () => {
  const { spawnFn, calls } = fakeSpawn(success());
  const result = await new CodexCliProvider({ spawnFn, tempRoot: tempRoot() }).generate({ userPrompt: "x" });

  assert.equal(result.ok, true);
  assert.equal(calls[0].args.includes("--model"), false);
  if (result.ok) assert.equal(result.metadata.model, "gpt-5.6-sol");
});

test("D. request.model is passed as an explicit Codex model override", async () => {
  const { spawnFn, calls } = fakeSpawn(success("provider-ok", ""));
  const result = await new CodexCliProvider({ spawnFn, tempRoot: tempRoot() }).generate({ userPrompt: "x", model: "codex-request-model" });

  assert.equal(result.ok, true);
  assert.equal(argAfter(calls[0].args, "--model"), "codex-request-model");
  if (result.ok) assert.equal(result.metadata.model, "codex-request-model");
});

test("D2. provider model option is explicit configuration, not inherited Opus", async () => {
  const { spawnFn, calls } = fakeSpawn(success("provider-ok", ""));
  await new CodexCliProvider({ spawnFn, model: "codex-configured-model", tempRoot: tempRoot() }).generate({ userPrompt: "x" });

  assert.equal(argAfter(calls[0].args, "--model"), "codex-configured-model");
});

test("E. argv is deterministic and uses the qualified isolation flags", () => {
  const files = { cwd: "C:/tmp/clean", outputPath: "C:/tmp/clean/last.txt", schemaPath: "C:/tmp/clean/schema.json" };
  const request: AiTextRequest = { systemPrompt: "sys", userPrompt: "user", structuredOutput: { schema: SCHEMA } };

  assert.deepEqual(buildCodexCliArgs(request, files, null), buildCodexCliArgs(request, files, null));
  assert.deepEqual(buildCodexCliArgs(request, files, null), [
    "-C",
    "C:/tmp/clean",
    "-s",
    "read-only",
    "-a",
    "never",
    "exec",
    "--skip-git-repo-check",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--output-last-message",
    "C:/tmp/clean/last.txt",
    "--output-schema",
    "C:/tmp/clean/schema.json",
    buildCodexCliPrompt(request),
  ]);
});

test("F. the child is spawned with shell false and clean cwd", async () => {
  const { spawnFn, calls } = fakeSpawn(success());
  await new CodexCliProvider({ spawnFn, tempRoot: tempRoot() }).generate(TEXT_REQUEST);

  assert.equal(calls[0].options.shell, false);
  assert.match(String(calls[0].options.cwd), /codex-cli-provider-/);
});

test("G. subscription execution does not require OPENAI_API_KEY or an SDK", async () => {
  const previous = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    const { spawnFn } = fakeSpawn(success());
    const result = await new CodexCliProvider({ spawnFn, tempRoot: tempRoot() }).generate(TEXT_REQUEST);
    assert.equal(result.ok, true);
  } finally {
    if (previous !== undefined) process.env.OPENAI_API_KEY = previous;
  }
  assert.doesNotMatch(providerCode(), /OPENAI_API_KEY|from "openai"|@openai|api\.openai\.com/i);
});

test("H/I/J/K/L. invocation uses ephemeral isolation, clean cwd, exact schema file, and final-message output", async () => {
  let schemaPath = "";
  let outputPath = "";
  let cwd = "";
  const { spawnFn, calls } = fakeSpawn((child, call) => {
    cwd = String(call.options.cwd);
    outputPath = argAfter(call.args, "--output-last-message");
    schemaPath = argAfter(call.args, "--output-schema");
    assert.equal(path.dirname(outputPath), cwd);
    assert.equal(path.dirname(schemaPath), cwd);
    assert.deepEqual(JSON.parse(readFileSync(schemaPath, "utf8")), SCHEMA);
    writeLastMessage(call, JSON.stringify({ status: "provider-ok" }));
    child.stderr.emit("data", "model: gpt-5.6-sol\n");
    child.emit("close", 0, null);
  });

  const result = await new CodexCliProvider({ spawnFn, tempRoot: tempRoot() }).generate({ userPrompt: "x", structuredOutput: { schema: SCHEMA } });

  assert.equal(result.ok, true);
  for (const flag of ["--skip-git-repo-check", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--output-last-message", "--output-schema"]) {
    assert.ok(calls[0].args.includes(flag), `${flag} missing`);
  }
  assert.equal(argAfter(calls[0].args, "-C"), cwd);
  assert.equal(argAfter(calls[0].args, "-s"), "read-only");
  assert.equal(argAfter(calls[0].args, "-a"), "never");
  assert.equal(existsSync(cwd), false, "clean cwd is removed after success");
  assert.equal(existsSync(outputPath), false);
  assert.equal(existsSync(schemaPath), false);
});

test("M. text requests map final message without CLI log contamination", async () => {
  const { spawnFn } = fakeSpawn((child, call) => {
    child.stdout.emit("data", "progress log");
    child.stderr.emit("data", "model: gpt-5.6-sol\nmore log");
    writeLastMessage(call, "provider-ok\n");
    child.emit("close", 0, null);
  });
  const result = await new CodexCliProvider({ spawnFn, tempRoot: tempRoot() }).generate(TEXT_REQUEST);

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.text, "provider-ok");
    assert.equal(result.metadata.providerId, "codex-cli");
    assert.equal(result.metadata.model, "gpt-5.6-sol");
    assert.equal(result.metadata.usage, undefined);
  }
});

test("N. structured requests map the final JSON object", async () => {
  const { spawnFn } = fakeSpawn(success(JSON.stringify({ status: "provider-ok" })));
  const result = await new CodexCliProvider({ spawnFn, tempRoot: tempRoot() }).generate({ userPrompt: "x", structuredOutput: { schema: SCHEMA } });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.text, '{"status":"provider-ok"}');
    assert.deepEqual(result.structuredValue, { status: "provider-ok" });
  }
});

test("system and user prompt mapping preserves the transport distinction deterministically", () => {
  const prompt = buildCodexCliPrompt({ systemPrompt: "SYSTEM_HALF", userPrompt: "USER_HALF" });
  assert.match(prompt, /## SYSTEM INSTRUCTIONS\nSYSTEM_HALF/);
  assert.match(prompt, /## USER REQUEST\nUSER_HALF/);
});

test("missing Codex CLI classifies as provider_unavailable", async () => {
  const { spawnFn } = fakeSpawn((child) => {
    const err = new Error("spawn codex ENOENT") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    child.emit("error", err);
  });
  const result = await new CodexCliProvider({ spawnFn, tempRoot: tempRoot() }).generate(TEXT_REQUEST);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "provider_unavailable");
});

test("unresolvable real executable classifies as provider_unavailable before spawning", async () => {
  const result = await new CodexCliProvider({ resolveExecutable: () => null, tempRoot: tempRoot() }).generate(TEXT_REQUEST);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "provider_unavailable");
});

test("bad configured executable classifies as configuration_error", async () => {
  const result = await new CodexCliProvider({ executablePath: "/definitely/not/here/codex.exe", tempRoot: tempRoot() }).generate(TEXT_REQUEST);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "configuration_error");
});

test("authentication and usage failures stay distinct", async () => {
  for (const [message, reason] of [
    ["Not logged in. Please run codex login.", "authentication"],
    ["You've hit your usage limit. Try again later.", "usage_limit"],
  ] as const) {
    const { spawnFn } = fakeSpawn((child) => {
      child.stderr.emit("data", message);
      child.emit("close", 1, null);
    });
    const result = await new CodexCliProvider({ spawnFn, tempRoot: tempRoot() }).generate(TEXT_REQUEST);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, reason);
  }
});

test("schema failure text maps to schema_invalid", async () => {
  const { spawnFn } = fakeSpawn((child) => {
    child.stderr.emit("data", "output-schema validation failed");
    child.emit("close", 1, null);
  });
  const result = await new CodexCliProvider({ spawnFn, tempRoot: tempRoot() }).generate({ userPrompt: "x", structuredOutput: { schema: SCHEMA } });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "schema_invalid");
});

test("spawn/process failure classifies as process_error", async () => {
  const { spawnFn } = fakeSpawn((child) => {
    const err = new Error("EACCES") as NodeJS.ErrnoException;
    err.code = "EACCES";
    child.emit("error", err);
  });
  const result = await new CodexCliProvider({ spawnFn, tempRoot: tempRoot() }).generate(TEXT_REQUEST);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "process_error");
});

test("malformed text and structured final messages classify as malformed_response", async () => {
  const empty = await new CodexCliProvider({ spawnFn: fakeSpawn(success("  ")).spawnFn, tempRoot: tempRoot() }).generate(TEXT_REQUEST);
  assert.equal(empty.ok, false);
  if (!empty.ok) assert.equal(empty.reason, "malformed_response");

  const badJson = await new CodexCliProvider({ spawnFn: fakeSpawn(success("not-json")).spawnFn, tempRoot: tempRoot() }).generate({ userPrompt: "x", structuredOutput: { schema: SCHEMA } });
  assert.equal(badJson.ok, false);
  if (!badJson.ok) assert.equal(badJson.reason, "malformed_response");
});

test("timeout kills the child, settles once, and cleans temp cwd", async () => {
  let cwd = "";
  const { spawnFn, children } = fakeSpawn((_child, call) => {
    cwd = String(call.options.cwd);
  });
  const result = await new CodexCliProvider({ spawnFn, tempRoot: tempRoot() }).generate({ userPrompt: "x", timeoutMs: 10 });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "timeout");
  assert.equal(children[0].killed, true);
  assert.equal(existsSync(cwd), false);
});

test("oversized process output classifies as output_too_large and leaks no content", async () => {
  const sentinel = `SENTINEL_CODEX_OUTPUT_${"x".repeat(500)}`;
  const { spawnFn, children } = fakeSpawn((child) => {
    child.stdout.emit("data", sentinel);
  });
  const result = await new CodexCliProvider({ spawnFn, maxOutputBytes: 64, tempRoot: tempRoot() }).generate(TEXT_REQUEST);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "output_too_large");
    assert.doesNotMatch(JSON.stringify(result), /SENTINEL_CODEX_OUTPUT/);
  }
  assert.equal(children[0].killed, true);
});

test("oversized final message classifies as output_too_large", async () => {
  const { spawnFn } = fakeSpawn(success("x".repeat(128)));
  const result = await new CodexCliProvider({ spawnFn, maxOutputBytes: 64, tempRoot: tempRoot() }).generate(TEXT_REQUEST);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "output_too_large");
});

test("one generate call causes exactly one process invocation for success and representative failures", async () => {
  const scripts: Array<[string, (child: FakeChildProcess, call: SpawnCall) => void]> = [
    ["success", success()],
    ["auth", (c) => { c.stderr.emit("data", "not logged in"); c.emit("close", 1, null); }],
    ["malformed", success(" ")],
    ["process", (c) => { c.stderr.emit("data", "boom"); c.emit("close", 9, null); }],
  ];
  for (const [label, script] of scripts) {
    const { spawnFn, calls } = fakeSpawn(script);
    await new CodexCliProvider({ spawnFn, tempRoot: tempRoot() }).generate({ userPrompt: label });
    assert.equal(calls.length, 1, label);
  }
});

test("temp resources are cleaned after process failure and malformed output", async () => {
  for (const script of [
    (child: FakeChildProcess, call: SpawnCall) => {
      writeLastMessage(call, " ");
      child.emit("close", 0, null);
    },
    (child: FakeChildProcess) => {
      child.stderr.emit("data", "boom");
      child.emit("close", 2, null);
    },
  ]) {
    let cwd = "";
    const { spawnFn } = fakeSpawn((child, call) => {
      cwd = String(call.options.cwd);
      script(child, call);
    });
    await new CodexCliProvider({ spawnFn, tempRoot: tempRoot() }).generate(TEXT_REQUEST);
    assert.equal(existsSync(cwd), false);
  }
});

test("temp resources are cleaned when structured schema serialization fails", async () => {
  const root = tempRoot();
  mkdirSync(root, { recursive: true });
  const circular: Record<string, unknown> = {};
  circular.self = circular;

  const result = await new CodexCliProvider({ spawnFn: fakeSpawn(success()).spawnFn, tempRoot: root }).generate({
    userPrompt: "x",
    structuredOutput: { schema: circular },
  });

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "configuration_error");
  assert.deepEqual(readdirSync(root), []);
});

test("manual invocation file helpers create an isolated cwd and remove it", () => {
  const root = tempRoot();
  mkdirSync(root, { recursive: true });
  const files = createCodexCliInvocationFiles(root);
  assert.notEqual(files.cwd, process.cwd());
  assert.equal(path.dirname(files.outputPath), files.cwd);
  assert.equal(path.dirname(files.schemaPath as string), files.cwd);
  cleanupCodexCliInvocationFiles(files);
  assert.equal(existsSync(files.cwd), false);
});

test("diagnostics are safe and bounded to process facts", async () => {
  const { spawnFn } = fakeSpawn((child) => {
    child.stderr.emit("data", "generic failure");
    child.emit("close", 3, null);
  });
  const result = await new CodexCliProvider({ spawnFn, tempRoot: tempRoot() }).generate(TEXT_REQUEST);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.deepEqual(Object.keys(result.diagnostics ?? {}).sort(), ["exitCode", "finalOutputBytes", "signal", "stderrBytes", "stdoutBytes"]);
    assert.doesNotMatch(JSON.stringify(result), /auth\.json|Bearer|cookie|session_id|refresh_token|access_token/i);
  }
});

test("provider source has no Creative-domain, Claude, API, retry, or routing dependency", () => {
  const code = providerCode();
  for (const forbidden of [
    /CreativeInput/,
    /CreativePackage/,
    /ResolvedCreativeGrounding/,
    /Opportunity/,
    /Journey/,
    /BRAND_BIBLE/,
    /Supabase/,
    /ClaudeCliProvider/,
    /fallbackProvider/,
    /maxRetries|retryCount|attemptNumber/,
    /from "openai"|@openai|api\.openai\.com/i,
    /photo|reel|carousel|story/i,
  ]) {
    assert.doesNotMatch(code, forbidden);
  }
});

test("provider imports only generic contract and Node built-ins", () => {
  const imports = [...providerCode().matchAll(/from "([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(imports)].sort(), ["../ai-text-provider.ts", "node:child_process", "node:fs", "node:os", "node:path"]);
});

test("defaults are bounded and request timeout overrides the provider default", async () => {
  assert.equal(CODEX_CLI_DEFAULT_TIMEOUT_MS, 120_000);
  assert.equal(CODEX_CLI_DEFAULT_MAX_OUTPUT_BYTES, 2 * 1024 * 1024);

  const { spawnFn } = fakeSpawn(() => {});
  const started = Date.now();
  const result = await new CodexCliProvider({ spawnFn, tempRoot: tempRoot() }).generate({ userPrompt: "x", timeoutMs: 15 });
  assert.equal(result.ok, false);
  assert.ok(Date.now() - started < 5_000);
});

test("executable resolution reports a real path or null without throwing", () => {
  const resolved = resolveCodexCliExecutable("codex");
  if (resolved !== null && process.platform === "win32") assert.match(resolved, /codex\.exe$/i);
  assert.equal(resolveCodexCliExecutable("definitely-not-a-real-binary-name-xyz"), process.platform === "win32" ? null : "definitely-not-a-real-binary-name-xyz");
});
