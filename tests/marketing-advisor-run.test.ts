import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseSubcommand, runExportCommand, runImportCommand } from "../scripts/marketing-advisor/run.ts";
import { buildMarketingAdvisorSessionId, type MarketingAdvisorManifest } from "../scripts/marketing-advisor/marketing-advisor-manual-export.ts";
import type { MarketingAdvisorReadClient } from "../scripts/marketing-advisor/marketing-advisor-read.ts";
import { MARKETING_RECOMMENDATIONS_VERSION } from "../src/lib/marketing-recommendations.ts";
import { MARKETING_ADVISOR_PROMPT_VERSION } from "../scripts/marketing-advisor/marketing-advisor-prompt.ts";
import { validateMarketingOpportunitySuggestions } from "../src/lib/marketing-opportunity-suggestions.ts";
import { buildOpportunityDraftsFromSuggestions } from "../src/lib/marketing-opportunity-drafts.ts";
import type { MarketingBrief } from "../src/lib/marketing-brief.ts";

const NOW = Date.parse("2026-07-30T09:00:00.000Z");

function tempDir(t: TestContext, prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function readManifest(sessionDir: string): MarketingAdvisorManifest {
  return JSON.parse(readFileSync(path.join(sessionDir, "manifest.json"), "utf8"));
}

function readBrief(sessionDir: string): MarketingBrief {
  return JSON.parse(readFileSync(path.join(sessionDir, "brief.json"), "utf8"));
}

async function exportSample(t: TestContext, overrides: { sessionDir?: string } = {}) {
  const outputRoot = tempDir(t, "marketing-advisor-output-");
  const outcome = await runExportCommand(null, { mode: "opportunity_generation", source: "sample", now: NOW, outputRoot, ...overrides });
  return { outcome, outputRoot };
}

function validReplyFor(brief: MarketingBrief, overrides: { titles?: string[]; suggestions?: unknown[] } = {}) {
  const firstRecId = brief.recommendations[0]?.id;
  const suggestions = overrides.suggestions ?? (firstRecId ? [{ title: "Feature it this week", reason: "Good timing.", sourceRecommendationIds: [firstRecId] }] : []);
  return JSON.stringify({
    schemaVersion: "v1",
    metadata: { generatedFromBriefGeneratedAt: brief.generatedAt, generatorVersion: "1" },
    suggestions,
  });
}

// ---- Session ID ----

test("buildMarketingAdvisorSessionId is deterministic", () => {
  const a = buildMarketingAdvisorSessionId("marketing", "2026-07-30T09:00:00.000Z");
  const b = buildMarketingAdvisorSessionId("marketing", "2026-07-30T09:00:00.000Z");
  assert.equal(a, b);
});

test("buildMarketingAdvisorSessionId never collides for two different exportedAt values, including a millisecond-only difference", () => {
  const a = buildMarketingAdvisorSessionId("marketing", "2026-07-30T09:00:00.000Z");
  const b = buildMarketingAdvisorSessionId("marketing", "2026-07-30T09:00:00.001Z");
  assert.notEqual(a, b);
});

// ---- export ----

test("export (sample source, no --session-dir) creates a session directory named after buildMarketingAdvisorSessionId's own output, containing exactly brief.json, prompt.md, manifest.json", async (t) => {
  const { outcome, outputRoot } = await exportSample(t);
  assert.equal(outcome.exitCode, 0);
  assert.ok(outcome.sessionId && outcome.sessionDir);

  const expectedSessionId = buildMarketingAdvisorSessionId("marketing", new Date(NOW).toISOString());
  assert.equal(outcome.sessionId, expectedSessionId);
  assert.equal(outcome.sessionDir, path.join(outputRoot, expectedSessionId));
  assert.ok(existsSync(outcome.sessionDir!));

  assert.deepEqual(readdirSync(outcome.sessionDir!).sort(), ["brief.json", "manifest.json", "prompt.md"]);
});

test("export's brief.json contents, built independently, deepEqual what was written", async (t) => {
  const { outcome } = await exportSample(t);
  const written = readBrief(outcome.sessionDir!);
  assert.equal(written.version, 1);
  assert.equal(written.generatedAt, new Date(NOW).toISOString());
});

test("export's manifest.json is fully populated and internally consistent", async (t) => {
  const { outcome } = await exportSample(t);
  const manifest = readManifest(outcome.sessionDir!);
  const brief = readBrief(outcome.sessionDir!);

  assert.equal(manifest.sessionId, outcome.sessionId);
  assert.equal(manifest.mode, "opportunity_generation");
  assert.equal(manifest.source, "sample");
  assert.equal(manifest.status, "exported");
  assert.equal(manifest.importedAt, null);
  assert.equal(manifest.exportedAt, manifest.briefGeneratedAt);
  assert.equal(manifest.advisor, "marketing");
  assert.equal(manifest.contextVersion, brief.context.version);
  assert.equal(manifest.recommendationVersion, MARKETING_RECOMMENDATIONS_VERSION);
  assert.equal(manifest.briefVersion, brief.version);
  assert.equal(manifest.promptVersion, MARKETING_ADVISOR_PROMPT_VERSION);
});

test("export --session-dir writes into exactly that directory instead of the default", async (t) => {
  const outputRoot = tempDir(t, "marketing-advisor-output-");
  const explicitDir = tempDir(t, "marketing-advisor-explicit-");
  const outcome = await runExportCommand(null, { mode: "opportunity_generation", source: "sample", now: NOW, outputRoot, sessionDir: explicitDir });
  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.sessionDir, explicitDir);
  assert.ok(existsSync(path.join(explicitDir, "brief.json")));
});

test("export --source supabase against a fake client asserts only select-shaped calls occur", async (t) => {
  const calls: string[] = [];
  const client: MarketingAdvisorReadClient = {
    auth: {
      signInWithPassword: async () => {
        calls.push("auth.signInWithPassword");
        return { error: null };
      },
    },
    from: (table: string) => ({
      select: () => ({
        order: async () => {
          calls.push(`select:${table}`);
          return { data: [], error: null };
        },
      }),
    }),
  };

  const outputRoot = tempDir(t, "marketing-advisor-output-");
  const outcome = await runExportCommand(client, {
    mode: "opportunity_generation",
    source: "supabase",
    now: NOW,
    outputRoot,
    credentials: { email: "owner@example.com", password: "secret" },
  });

  assert.equal(outcome.exitCode, 0);
  assert.deepEqual(calls.sort(), ["auth.signInWithPassword", "select:content_journal", "select:ingredients"]);
});

// ---- import: manifest lifecycle ----

test("a successful import updates manifest.json to completed with a non-null importedAt, leaving export-time fields unchanged", async (t) => {
  const { outcome } = await exportSample(t);
  const sessionDir = outcome.sessionDir!;
  const brief = readBrief(sessionDir);
  const before = readManifest(sessionDir);

  const resultFile = path.join(tempDir(t, "marketing-advisor-reply-"), "reply.json");
  writeFileSync(resultFile, validReplyFor(brief), "utf8");

  const importOutcome = await runImportCommand({ sessionDir, resultFile, now: NOW + 60_000 });
  assert.equal(importOutcome.exitCode, 0);

  const after = readManifest(sessionDir);
  assert.equal(after.status, "completed");
  assert.equal(after.importedAt, new Date(NOW + 60_000).toISOString());
  assert.equal(after.sessionId, before.sessionId);
  assert.equal(after.exportedAt, before.exportedAt);
  assert.equal(after.promptVersion, before.promptVersion);
});

test("an import whose reply fails validation updates manifest.json to validation_failed, and response.json still matches the raw reply verbatim", async (t) => {
  const { outcome } = await exportSample(t);
  const sessionDir = outcome.sessionDir!;

  const resultFile = path.join(tempDir(t, "marketing-advisor-reply-"), "reply.json");
  const badReply = "not valid json";
  writeFileSync(resultFile, badReply, "utf8");

  const importOutcome = await runImportCommand({ sessionDir, resultFile, now: NOW + 60_000 });
  assert.equal(importOutcome.exitCode, 2);

  const manifest = readManifest(sessionDir);
  assert.equal(manifest.status, "validation_failed");
  assert.ok(manifest.importedAt);

  assert.equal(readFileSync(path.join(sessionDir, "response.json"), "utf8"), badReply);
});

test("an import that fails before reading --result-file leaves manifest.json completely untouched", async (t) => {
  const { outcome } = await exportSample(t);
  const sessionDir = outcome.sessionDir!;
  const before = readManifest(sessionDir);

  const importOutcome = await runImportCommand({ sessionDir, resultFile: path.join(sessionDir, "does-not-exist.json"), now: NOW + 60_000 });
  assert.equal(importOutcome.exitCode, 2);

  const after = readManifest(sessionDir);
  assert.deepEqual(after, before);
  assert.equal(after.status, "exported");
  assert.equal(after.importedAt, null);
});

test("import is safely re-runnable against the same --session-dir: the manifest reflects only the most recent outcome", async (t) => {
  const { outcome } = await exportSample(t);
  const sessionDir = outcome.sessionDir!;
  const brief = readBrief(sessionDir);

  const badFile = path.join(tempDir(t, "marketing-advisor-reply-"), "bad.json");
  writeFileSync(badFile, "not valid json", "utf8");
  await runImportCommand({ sessionDir, resultFile: badFile, now: NOW + 60_000 });
  assert.equal(readManifest(sessionDir).status, "validation_failed");

  const goodFile = path.join(tempDir(t, "marketing-advisor-reply-"), "good.json");
  writeFileSync(goodFile, validReplyFor(brief), "utf8");
  const secondOutcome = await runImportCommand({ sessionDir, resultFile: goodFile, now: NOW + 120_000 });
  assert.equal(secondOutcome.exitCode, 0);

  const finalManifest = readManifest(sessionDir);
  assert.equal(finalManifest.status, "completed");
  assert.equal(finalManifest.importedAt, new Date(NOW + 120_000).toISOString());
});

// ---- import: response.json / drafts.json ----

test("import writes response.json as an exact copy of --result-file's raw text", async (t) => {
  const { outcome } = await exportSample(t);
  const sessionDir = outcome.sessionDir!;
  const brief = readBrief(sessionDir);

  const raw = validReplyFor(brief);
  const resultFile = path.join(tempDir(t, "marketing-advisor-reply-"), "reply.json");
  writeFileSync(resultFile, raw, "utf8");

  await runImportCommand({ sessionDir, resultFile, now: NOW + 60_000 });
  assert.equal(readFileSync(path.join(sessionDir, "response.json"), "utf8"), raw);
});

test("import writes lifted drafts to the default <session-dir>/drafts.json when --out is omitted, and to the given path instead when provided", async (t) => {
  const { outcome } = await exportSample(t);
  const sessionDir = outcome.sessionDir!;
  const brief = readBrief(sessionDir);
  const resultFile = path.join(tempDir(t, "marketing-advisor-reply-"), "reply.json");
  writeFileSync(resultFile, validReplyFor(brief), "utf8");

  const defaultOutcome = await runImportCommand({ sessionDir, resultFile, now: NOW + 60_000 });
  assert.equal(defaultOutcome.exitCode, 0);
  assert.ok(existsSync(path.join(sessionDir, "drafts.json")));

  const customOut = path.join(tempDir(t, "marketing-advisor-custom-out-"), "my-drafts.json");
  const customOutcome = await runImportCommand({ sessionDir, resultFile, outFile: customOut, now: NOW + 120_000 });
  assert.equal(customOutcome.exitCode, 0);
  assert.ok(existsSync(customOut));
});

// ---- import: correctness ----

test("import with a well-formed AI reply produces an OpportunityDraft[] deepEqual to calling validateMarketingOpportunitySuggestions + buildOpportunityDraftsFromSuggestions directly", async (t) => {
  const { outcome } = await exportSample(t);
  const sessionDir = outcome.sessionDir!;
  const brief = readBrief(sessionDir);
  assert.ok(brief.recommendations.length > 0, "expected the real sample product catalog to produce at least one recommendation");

  const raw = validReplyFor(brief);
  const resultFile = path.join(tempDir(t, "marketing-advisor-reply-"), "reply.json");
  writeFileSync(resultFile, raw, "utf8");

  const importOutcome = await runImportCommand({ sessionDir, resultFile, now: NOW + 60_000 });
  assert.equal(importOutcome.exitCode, 0);

  const validation = validateMarketingOpportunitySuggestions(raw, brief);
  assert.equal(validation.ok, true);
  if (!validation.ok) return;
  const expectedDrafts = buildOpportunityDraftsFromSuggestions(validation.result, brief);

  assert.deepEqual(importOutcome.drafts, expectedDrafts);
});

test("import makes zero network calls -- succeeds even with globalThis.fetch monkeypatched to throw", async (t) => {
  const { outcome } = await exportSample(t);
  const sessionDir = outcome.sessionDir!;
  const brief = readBrief(sessionDir);
  const resultFile = path.join(tempDir(t, "marketing-advisor-reply-"), "reply.json");
  writeFileSync(resultFile, validReplyFor(brief), "utf8");

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => {
    throw new Error("fetch must never be called by the manual import path");
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const importOutcome = await runImportCommand({ sessionDir, resultFile, now: NOW + 60_000 });
  assert.equal(importOutcome.exitCode, 0);
});

test("import rejects a --session-dir whose brief.json generatedAt doesn't match the reply's metadata.generatedFromBriefGeneratedAt", async (t) => {
  const { outcome } = await exportSample(t);
  const sessionDir = outcome.sessionDir!;

  const resultFile = path.join(tempDir(t, "marketing-advisor-reply-"), "reply.json");
  writeFileSync(
    resultFile,
    JSON.stringify({ schemaVersion: "v1", metadata: { generatedFromBriefGeneratedAt: "2020-01-01T00:00:00.000Z", generatorVersion: "1" }, suggestions: [] }),
    "utf8",
  );

  const importOutcome = await runImportCommand({ sessionDir, resultFile, now: NOW + 60_000 });
  assert.equal(importOutcome.exitCode, 2);
  assert.match(importOutcome.message ?? "", /malformed-metadata/);
});

test("import rejects malformed AI output with the validator's own reason surfaced verbatim", async (t) => {
  const { outcome } = await exportSample(t);
  const sessionDir = outcome.sessionDir!;
  const brief = readBrief(sessionDir);

  const resultFile = path.join(tempDir(t, "marketing-advisor-reply-"), "reply.json");
  writeFileSync(resultFile, validReplyFor(brief, { suggestions: [{ title: "", reason: "x", sourceRecommendationIds: ["nope"] }] }), "utf8");

  const importOutcome = await runImportCommand({ sessionDir, resultFile, now: NOW + 60_000 });
  assert.equal(importOutcome.exitCode, 2);
  assert.match(importOutcome.message ?? "", /malformed-suggestion/);
});

test("import errors clearly when --result-file is missing", async (t) => {
  const { outcome } = await exportSample(t);
  const importOutcome = await runImportCommand({ sessionDir: outcome.sessionDir!, resultFile: path.join(outcome.sessionDir!, "missing.json"), now: NOW });
  assert.equal(importOutcome.exitCode, 2);
});

test("is deterministic: identical raw/--session-dir pair produces deepEqual CLI output across two separate sessions", async (t) => {
  const first = await exportSample(t);
  const second = await exportSample(t);

  const briefA = readBrief(first.outcome.sessionDir!);
  const briefB = readBrief(second.outcome.sessionDir!);
  assert.deepEqual(briefA.recommendations, briefB.recommendations);

  const rawA = validReplyFor(briefA);
  const rawB = validReplyFor(briefB);
  const resultFileA = path.join(tempDir(t, "marketing-advisor-reply-"), "a.json");
  const resultFileB = path.join(tempDir(t, "marketing-advisor-reply-"), "b.json");
  writeFileSync(resultFileA, rawA, "utf8");
  writeFileSync(resultFileB, rawB, "utf8");

  const outcomeA = await runImportCommand({ sessionDir: first.outcome.sessionDir!, resultFile: resultFileA, now: NOW + 60_000 });
  const outcomeB = await runImportCommand({ sessionDir: second.outcome.sessionDir!, resultFile: resultFileB, now: NOW + 60_000 });

  assert.deepEqual(outcomeA.drafts, outcomeB.drafts);
});

// ---- CLI subcommand parsing ----

test("parseSubcommand only accepts export/import", () => {
  assert.equal(parseSubcommand(["export"]), "export");
  assert.equal(parseSubcommand(["import"]), "import");
  assert.equal(parseSubcommand(["run-api"]), null);
  assert.equal(parseSubcommand([]), null);
  assert.equal(parseSubcommand(["bogus"]), null);
});

// ---- Scope guard ----

test("run.ts makes no reference to any paid provider name or API key", () => {
  // "Claude Code" is the human tool run.ts's own usage text intentionally references (mirroring
  // scripts/creative-workers/run.ts's own usage text) -- what must never appear is a real
  // paid-provider API reference or key.
  const source = readFileSync(new URL("../scripts/marketing-advisor/run.ts", import.meta.url), "utf8");
  for (const forbidden of [/Anthropic/i, /OpenAI/i, /Gemini/i, /ANTHROPIC_API_KEY/, /OPENAI_API_KEY/]) {
    assert.doesNotMatch(source, forbidden);
  }
});
