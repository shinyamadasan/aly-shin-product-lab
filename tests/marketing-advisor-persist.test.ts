import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { runPersistCommand } from "../scripts/marketing-advisor/marketing-advisor-persist.ts";
import { buildSessionMetadata, buildSessionStats, buildRecommendationSnapshot, enrichDraftForPersistence } from "../scripts/marketing-advisor/marketing-advisor-evidence.ts";
import { MIN_REASON_LENGTH, MAX_SESSION_AGE_DAYS } from "../scripts/marketing-advisor/marketing-advisor-queue-eligibility.ts";
import { MARKETING_ADVISOR_VERSION, type MarketingAdvisorManifest } from "../scripts/marketing-advisor/marketing-advisor-manual-export.ts";
import type { OpportunityDraft, OpportunityRow } from "../src/lib/opportunities.ts";
import type { OpportunityPersistenceClient } from "../scripts/daily-advisor/opportunity-persistence.ts";

const NOW_MS = Date.parse("2026-07-30T09:00:00.000Z");
const NOW_ISO = new Date(NOW_MS).toISOString();
const DAY_MS = 24 * 60 * 60 * 1000;

function tempDir(t: TestContext, prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function citedRecommendation(overrides: Record<string, unknown> = {}) {
  return {
    id: "neglected_product:brownies",
    priority: 1,
    confidence: "high",
    title: "Feature Brownies",
    explanation: "Brownies hasn't been marketed in 30 days.",
    suggestedNextAction: "Post about Brownies.",
    recommendationType: "neglected_product",
    evidence: {},
    ...overrides,
  };
}

function buildDraft(overrides: Partial<OpportunityDraft> = {}): OpportunityDraft {
  return {
    opportunityType: "marketing_opportunity",
    producer: "marketing_advisor",
    sourceType: "marketing_advisor",
    sourceId: "marketing-session-1:0",
    title: "Feature Brownies this week",
    summary: "",
    reason: "Brownies hasn't been marketed recently and current stock supports a push.",
    recommendedAction: "create_content",
    evidenceVersion: "v1",
    evidence: { aiReasoning: "Brownies hasn't been marketed recently.", priority: 1, supportingEvidence: [], citedRecommendations: [citedRecommendation()] },
    sourceRuleIds: ["neglected_product:brownies"],
    sourceFindings: [],
    detectedAt: new Date(NOW_MS - 2 * DAY_MS).toISOString(),
    expiresAt: new Date(NOW_MS + 3 * DAY_MS).toISOString(),
    deduplicationKey: "v1|producer=marketing_advisor|finding_type=marketing_opportunity|entity:product=brownies|action=create_content|business_date=2026-07-30",
    ...overrides,
  };
}

function writeSession(
  t: TestContext,
  options: {
    manifestStatus?: MarketingAdvisorManifest["status"];
    manifestOverrides?: Partial<MarketingAdvisorManifest>;
    briefGeneratedAt?: string;
    recommendationsCount?: number;
    suggestionsCount?: number;
    drafts?: OpportunityDraft[];
    skipBrief?: boolean;
    skipResponse?: boolean;
    skipDrafts?: boolean;
  } = {},
): string {
  const sessionDir = tempDir(t, "marketing-advisor-persist-");
  const briefGeneratedAt = options.briefGeneratedAt ?? NOW_ISO;

  const manifest: MarketingAdvisorManifest = {
    schemaVersion: "1",
    sessionId: "marketing-session-1",
    advisor: "marketing",
    advisorVersion: MARKETING_ADVISOR_VERSION,
    mode: "opportunity_generation",
    source: "sample",
    status: options.manifestStatus ?? "completed",
    exportedAt: briefGeneratedAt,
    importedAt: briefGeneratedAt,
    briefGeneratedAt,
    contextVersion: 1,
    recommendationVersion: 1,
    briefVersion: 1,
    promptVersion: "1",
    persistedAt: null,
    persistence: null,
    ...options.manifestOverrides,
  };
  writeFileSync(path.join(sessionDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

  if (!options.skipBrief) {
    const recommendations = Array.from({ length: options.recommendationsCount ?? 1 }, (_, i) => citedRecommendation({ id: `neglected_product:product-${i}` }));
    const brief = { version: 1, generatedAt: briefGeneratedAt, context: { version: manifest.contextVersion }, recommendations };
    writeFileSync(path.join(sessionDir, "brief.json"), JSON.stringify(brief, null, 2), "utf8");
  }

  if (!options.skipResponse) {
    const suggestions = Array.from({ length: options.suggestionsCount ?? 1 }, () => ({}));
    const response = { schemaVersion: "v1", metadata: { generatedFromBriefGeneratedAt: briefGeneratedAt, generatorVersion: "1" }, suggestions };
    writeFileSync(path.join(sessionDir, "response.json"), JSON.stringify(response, null, 2), "utf8");
  }

  if (!options.skipDrafts) {
    writeFileSync(path.join(sessionDir, "drafts.json"), JSON.stringify(options.drafts ?? [buildDraft()], null, 2), "utf8");
  }

  return sessionDir;
}

function readManifest(sessionDir: string): MarketingAdvisorManifest {
  return JSON.parse(readFileSync(path.join(sessionDir, "manifest.json"), "utf8"));
}

function readPersistenceResult(sessionDir: string): { ok: boolean; inserted: number; updated: number; skipped: number; failed: number; details: unknown[]; excluded: unknown[] } {
  return JSON.parse(readFileSync(path.join(sessionDir, "persistence-result.json"), "utf8"));
}

function makeClient(options: { insertErrorFor?: (row: { deduplication_key: string }) => boolean } = {}) {
  const store: OpportunityRow[] = [];
  let fromCalls = 0;

  const client: OpportunityPersistenceClient = {
    from(table) {
      fromCalls += 1;
      assert.equal(table, "opportunities");
      return {
        select() {
          return {
            eq(column: string, value: string) {
              return {
                async maybeSingle() {
                  assert.equal(column, "deduplication_key");
                  return { data: store.find((row) => row.deduplication_key === value) ?? null, error: null };
                },
              };
            },
          };
        },
        insert(row) {
          return {
            select() {
              return {
                async single() {
                  if (options.insertErrorFor?.(row)) {
                    return { data: null, error: { message: "simulated insert failure" } };
                  }
                  const inserted: OpportunityRow = { ...row, id: `opportunity-${store.length + 1}`, created_at: NOW_ISO, updated_at: NOW_ISO, status: "new" };
                  store.push(inserted);
                  return { data: inserted, error: null };
                },
              };
            },
          };
        },
        update(updateRow) {
          const filters: Array<{ column: string; value: string }> = [];
          const builder = {
            eq(column: string, value: string) {
              filters.push({ column, value });
              return builder;
            },
            select() {
              return {
                async maybeSingle() {
                  const index = store.findIndex((row) => filters.every(({ column, value }) => row[column as keyof OpportunityRow] === value));
                  if (index === -1) return { data: null, error: null };
                  store[index] = { ...store[index], ...updateRow };
                  return { data: store[index], error: null };
                },
              };
            },
          };
          return builder;
        },
      };
    },
  };

  return { client, store, get fromCalls() { return fromCalls; } };
}

function throwingClient(): OpportunityPersistenceClient {
  return {
    from() {
      throw new Error("no Supabase call should happen on this path");
    },
  };
}

// ---- Evidence enrichment ----

test("enrichDraftForPersistence removes citedRecommendations and adds exactly the documented keys", () => {
  const draft = buildDraft();
  const manifest = readManifestFixture();
  const sessionMetadata = buildSessionMetadata(manifest);
  const sessionStats = { totalRecommendationsInBrief: 3, totalSuggestionsFromAI: 1 };

  const enriched = enrichDraftForPersistence(draft, sessionMetadata, sessionStats);

  assert.ok(!("citedRecommendations" in enriched.evidence));
  assert.equal(enriched.evidence.originSessionId, manifest.sessionId);
  assert.equal(enriched.evidence.advisorVersion, MARKETING_ADVISOR_VERSION);
  assert.equal(enriched.evidence.contextVersion, manifest.contextVersion);
  assert.equal(enriched.evidence.recommendationVersion, manifest.recommendationVersion);
  assert.equal(enriched.evidence.promptVersion, manifest.promptVersion);
  assert.deepEqual(enriched.evidence.sessionStats, sessionStats);
  assert.deepEqual(enriched.evidence.aiReasoning, draft.evidence.aiReasoning);

  const snapshot = enriched.evidence.recommendationSnapshot as Array<Record<string, unknown>>;
  assert.equal(snapshot.length, 1);
  assert.deepEqual(Object.keys(snapshot[0]).sort(), ["confidence", "explanation", "id", "priority", "title"].sort());
});

test("buildRecommendationSnapshot maps only the five documented fields, dropping recommendationType/evidence/suggestedNextAction", () => {
  const snapshot = buildRecommendationSnapshot([citedRecommendation() as never]);
  assert.deepEqual(snapshot, [{ id: "neglected_product:brownies", title: "Feature Brownies", explanation: "Brownies hasn't been marketed in 30 days.", priority: 1, confidence: "high" }]);
});

test("buildSessionStats reflects brief.recommendations.length and response.suggestions.length independent of queue eligibility", () => {
  const brief = { version: 1 as const, generatedAt: NOW_ISO, context: {} as never, recommendations: [citedRecommendation(), citedRecommendation()] as never };
  const response = { schemaVersion: "v1" as const, metadata: { generatedFromBriefGeneratedAt: NOW_ISO, generatorVersion: "1" as const }, suggestions: [{ title: "a", reason: "b", sourceRecommendationIds: ["x"] }] };
  assert.deepEqual(buildSessionStats(brief, response), { totalRecommendationsInBrief: 2, totalSuggestionsFromAI: 1 });
});

function readManifestFixture(): MarketingAdvisorManifest {
  return {
    schemaVersion: "1",
    sessionId: "marketing-session-1",
    advisor: "marketing",
    advisorVersion: MARKETING_ADVISOR_VERSION,
    mode: "opportunity_generation",
    source: "sample",
    status: "completed",
    exportedAt: NOW_ISO,
    importedAt: NOW_ISO,
    briefGeneratedAt: NOW_ISO,
    contextVersion: 4,
    recommendationVersion: 2,
    briefVersion: 1,
    promptVersion: "1",
    persistedAt: null,
    persistence: null,
  };
}

// ---- Gate / integrity rejections ----

test("persist refuses a session whose manifest status isn't completed/persisted/persist_failed, leaving the manifest untouched, with zero client calls", async (t) => {
  const sessionDir = writeSession(t, { manifestStatus: "exported" });
  const before = readManifest(sessionDir);

  const outcome = await runPersistCommand(throwingClient(), { sessionDir, now: NOW_MS });
  assert.equal(outcome.exitCode, 2);
  assert.deepEqual(readManifest(sessionDir), before);
});

test("persist refuses when brief.json's generatedAt doesn't match manifest.briefGeneratedAt", async (t) => {
  const sessionDir = writeSession(t, { briefGeneratedAt: NOW_ISO });
  // Tamper with brief.json after the fact so it disagrees with the manifest.
  const briefPath = path.join(sessionDir, "brief.json");
  const brief = JSON.parse(readFileSync(briefPath, "utf8"));
  brief.generatedAt = "2020-01-01T00:00:00.000Z";
  writeFileSync(briefPath, JSON.stringify(brief), "utf8");
  const before = readManifest(sessionDir);

  const outcome = await runPersistCommand(throwingClient(), { sessionDir, now: NOW_MS });
  assert.equal(outcome.exitCode, 2);
  assert.deepEqual(readManifest(sessionDir), before);
});

test("persist refuses a session missing drafts.json, leaving the manifest untouched", async (t) => {
  const sessionDir = writeSession(t, { skipDrafts: true });
  const before = readManifest(sessionDir);

  const outcome = await runPersistCommand(throwingClient(), { sessionDir, now: NOW_MS });
  assert.equal(outcome.exitCode, 2);
  assert.deepEqual(readManifest(sessionDir), before);
});

// ---- Structural gate ----

test("structural pre-flight is all-or-nothing: one corrupted draft aborts the whole batch before any client call", async (t) => {
  const good = buildDraft();
  const corrupted = buildDraft({ title: "", deduplicationKey: "v1|producer=marketing_advisor|finding_type=x|entity:product=croissants|action=create_content|business_date=2026-07-30" });
  const sessionDir = writeSession(t, { drafts: [good, corrupted] });

  const outcome = await runPersistCommand(throwingClient(), { sessionDir, now: NOW_MS });
  assert.equal(outcome.exitCode, 1);
  assert.equal(readManifest(sessionDir).status, "persist_failed");
});

// ---- Queue eligibility: Validity ----

test("queue eligibility excludes an already-expired draft, recording rule 'already-expired'", async (t) => {
  const expired = buildDraft({ detectedAt: new Date(NOW_MS - 2 * DAY_MS).toISOString(), expiresAt: new Date(NOW_MS - 1 * DAY_MS).toISOString() });
  const sessionDir = writeSession(t, { drafts: [expired] });
  const { client, store } = makeClient();

  const outcome = await runPersistCommand(client, { sessionDir, now: NOW_MS });
  assert.equal(outcome.exitCode, 0);
  assert.equal(store.length, 0);

  const result = readPersistenceResult(sessionDir);
  assert.equal(result.excluded.length, 1);
  assert.equal((result.excluded[0] as { rule: string }).rule, "already-expired");
  assert.deepEqual(readManifest(sessionDir).persistence?.excluded, [{ title: expired.title, rule: "already-expired", recommendationIds: expired.sourceRuleIds }]);
});

test("queue eligibility excludes a draft whose reason is shorter than MIN_REASON_LENGTH, recording rule 'reason-too-short'", async (t) => {
  const shortReason = buildDraft({ reason: "Too short." });
  assert.ok(shortReason.reason.length < MIN_REASON_LENGTH);
  const sessionDir = writeSession(t, { drafts: [shortReason] });
  const { client, store } = makeClient();

  const outcome = await runPersistCommand(client, { sessionDir, now: NOW_MS });
  assert.equal(outcome.exitCode, 0);
  assert.equal(store.length, 0);
  assert.equal((readPersistenceResult(sessionDir).excluded[0] as { rule: string }).rule, "reason-too-short");
});

// ---- Queue eligibility: Quality ----

test("queue eligibility excludes the second of two drafts sharing a trimmed/lower-cased title, recording rule 'duplicate-title-in-batch'", async (t) => {
  const first = buildDraft({ title: "Feature Brownies", sourceRuleIds: ["neglected_product:brownies"], deduplicationKey: "dedup-a" });
  const second = buildDraft({ title: "  feature brownies  ", sourceRuleIds: ["neglected_product:croissants"], deduplicationKey: "dedup-b" });
  const sessionDir = writeSession(t, { drafts: [first, second] });
  const { client, store } = makeClient();

  const outcome = await runPersistCommand(client, { sessionDir, now: NOW_MS });
  assert.equal(outcome.exitCode, 0);
  assert.equal(store.length, 1);

  const result = readPersistenceResult(sessionDir);
  assert.equal(result.excluded.length, 1);
  assert.equal((result.excluded[0] as { rule: string; deduplicationKey: string }).rule, "duplicate-title-in-batch");
  assert.equal((result.excluded[0] as { deduplicationKey: string }).deduplicationKey, "dedup-b");
});

test("queue eligibility excludes the second of two drafts citing the same underlying product, recording rule 'duplicate-product-in-batch'", async (t) => {
  const first = buildDraft({ title: "Feature Brownies", sourceRuleIds: ["neglected_product:brownies"], deduplicationKey: "dedup-a" });
  const second = buildDraft({ title: "Restock alert for Brownies", sourceRuleIds: ["launch_candidate_follow_up:brownies"], deduplicationKey: "dedup-b" });
  const sessionDir = writeSession(t, { drafts: [first, second] });
  const { client, store } = makeClient();

  const outcome = await runPersistCommand(client, { sessionDir, now: NOW_MS });
  assert.equal(outcome.exitCode, 0);
  assert.equal(store.length, 1);

  const result = readPersistenceResult(sessionDir);
  assert.equal(result.excluded.length, 1);
  assert.equal((result.excluded[0] as { rule: string }).rule, "duplicate-product-in-batch");
});

// ---- Edge cases: empty batch / fully-excluded batch ----

test("an empty drafts.json succeeds trivially: a persisted session with zero queued Opportunities and zero Supabase calls", async (t) => {
  const sessionDir = writeSession(t, { drafts: [] });

  const outcome = await runPersistCommand(throwingClient(), { sessionDir, now: NOW_MS });
  assert.equal(outcome.exitCode, 0);
  assert.match(outcome.message ?? "", /^Queued 0 Opportunity\(ies\) for review \(0 new, 0 updated, 0 already reviewed, 0 excluded/);

  const manifest = readManifest(sessionDir);
  assert.equal(manifest.status, "persisted");
  assert.equal(manifest.persistedAt, NOW_ISO);
  assert.deepEqual(manifest.persistence, { attemptedAt: NOW_ISO, inserted: 0, updated: 0, skipped: 0, failed: 0, excluded: [] });
  assert.deepEqual(readPersistenceResult(sessionDir), { ok: true, inserted: 0, updated: 0, skipped: 0, failed: 0, details: [], excluded: [] });
});

test("a batch where every draft is excluded by queue eligibility still succeeds: a persisted session with zero queued Opportunities and a full exclusion list", async (t) => {
  const expired = buildDraft({
    title: "Feature Brownies",
    sourceRuleIds: ["neglected_product:brownies"],
    deduplicationKey: "dedup-a",
    detectedAt: new Date(NOW_MS - 2 * DAY_MS).toISOString(),
    expiresAt: new Date(NOW_MS - 1 * DAY_MS).toISOString(),
  });
  const shortReason = buildDraft({ title: "Feature Croissants", sourceRuleIds: ["neglected_product:croissants"], deduplicationKey: "dedup-b", reason: "Too short." });
  const sessionDir = writeSession(t, { drafts: [expired, shortReason] });

  const outcome = await runPersistCommand(throwingClient(), { sessionDir, now: NOW_MS });
  assert.equal(outcome.exitCode, 0);
  assert.match(outcome.message ?? "", /^Queued 0 Opportunity\(ies\) for review \(0 new, 0 updated, 0 already reviewed, 2 excluded/);

  const manifest = readManifest(sessionDir);
  assert.equal(manifest.status, "persisted");
  assert.equal(manifest.persistence?.inserted, 0);
  assert.equal(manifest.persistence?.failed, 0);
  assert.equal(manifest.persistence?.excluded.length, 2);
  assert.deepEqual(
    manifest.persistence?.excluded.map((e) => e.rule).sort(),
    ["already-expired", "reason-too-short"],
  );

  const result = readPersistenceResult(sessionDir);
  assert.equal(result.ok, true);
  assert.equal(result.details.length, 0);
  assert.equal(result.excluded.length, 2);
});

// ---- Session staleness ----

test("a session older than MAX_SESSION_AGE_DAYS is refused without --force, with zero client calls and the manifest untouched", async (t) => {
  const staleGeneratedAt = new Date(NOW_MS - (MAX_SESSION_AGE_DAYS + 1) * DAY_MS).toISOString();
  const sessionDir = writeSession(t, { briefGeneratedAt: staleGeneratedAt });
  const before = readManifest(sessionDir);

  const outcome = await runPersistCommand(throwingClient(), { sessionDir, now: NOW_MS });
  assert.equal(outcome.exitCode, 2);
  assert.deepEqual(readManifest(sessionDir), before);
});

test("a stale session succeeds with --force", async (t) => {
  const staleGeneratedAt = new Date(NOW_MS - (MAX_SESSION_AGE_DAYS + 1) * DAY_MS).toISOString();
  const sessionDir = writeSession(t, { briefGeneratedAt: staleGeneratedAt });
  const { client, store } = makeClient();

  const outcome = await runPersistCommand(client, { sessionDir, now: NOW_MS, force: true });
  assert.equal(outcome.exitCode, 0);
  assert.equal(store.length, 1);
  assert.equal(readManifest(sessionDir).status, "persisted");
});

test("--force bypasses queue eligibility but never structural validation: a stale session with one corrupted draft still aborts on the structural gate", async (t) => {
  const staleGeneratedAt = new Date(NOW_MS - (MAX_SESSION_AGE_DAYS + 1) * DAY_MS).toISOString();
  const corrupted = buildDraft({ title: "" });
  const sessionDir = writeSession(t, { briefGeneratedAt: staleGeneratedAt, drafts: [corrupted] });

  const outcome = await runPersistCommand(throwingClient(), { sessionDir, now: NOW_MS, force: true });
  assert.equal(outcome.exitCode, 1);
  assert.equal(readManifest(sessionDir).status, "persist_failed");
});

// ---- Rerun / terminal-status / partial-failure guarantees, through the orchestration layer ----

test("persist is safely re-runnable: a second call with unmodified drafts does not create a duplicate row", async (t) => {
  const sessionDir = writeSession(t);
  const { client, store } = makeClient();

  const first = await runPersistCommand(client, { sessionDir, now: NOW_MS });
  assert.equal(first.exitCode, 0);
  assert.equal(store.length, 1);

  const second = await runPersistCommand(client, { sessionDir, now: NOW_MS + 60_000 });
  assert.equal(second.exitCode, 0);
  assert.equal(store.length, 1);
  assert.equal(readManifest(sessionDir).status, "persisted");
});

test("a rerun preserves a terminal-status row instead of overwriting its evidence", async (t) => {
  const sessionDir = writeSession(t);
  const { client, store } = makeClient();

  const first = await runPersistCommand(client, { sessionDir, now: NOW_MS });
  assert.equal(first.exitCode, 0);
  assert.equal(store.length, 1);

  store[0].status = "accepted";
  store[0].evidence = { sentinel: true };

  const second = await runPersistCommand(client, { sessionDir, now: NOW_MS + 60_000 });
  assert.equal(second.exitCode, 0);
  assert.equal(store[0].status, "accepted");
  assert.deepEqual(store[0].evidence, { sentinel: true });

  const persistence = readManifest(sessionDir).persistence;
  assert.equal(persistence?.skipped, 1);
  assert.equal(persistence?.inserted, 0);
  assert.equal(persistence?.updated, 0);
});

test("a partial failure is honestly reported (never falsely marked persisted), and a retry after the underlying cause is fixed recovers", async (t) => {
  const draftA = buildDraft({ title: "Feature Brownies", sourceRuleIds: ["neglected_product:brownies"], deduplicationKey: "dedup-a" });
  const draftB = buildDraft({ title: "Feature Croissants", sourceRuleIds: ["neglected_product:croissants"], deduplicationKey: "dedup-b" });
  const sessionDir = writeSession(t, { drafts: [draftA, draftB] });

  let failing = true;
  const { client, store } = makeClient({ insertErrorFor: (row) => failing && row.deduplication_key === "dedup-b" });

  const first = await runPersistCommand(client, { sessionDir, now: NOW_MS });
  assert.equal(first.exitCode, 1);
  assert.equal(readManifest(sessionDir).status, "persist_failed");
  assert.equal(readManifest(sessionDir).persistence?.failed, 1);
  assert.equal(store.length, 1);

  failing = false;
  const second = await runPersistCommand(client, { sessionDir, now: NOW_MS + 60_000 });
  assert.equal(second.exitCode, 0);
  assert.equal(readManifest(sessionDir).status, "persisted");
  assert.equal(store.length, 2);
});

// ---- Output shape ----

test("persistence-result.json contains the real PersistOpportunitiesResult fields plus the full exclusion list", async (t) => {
  const eligible = buildDraft({ title: "Feature Brownies", sourceRuleIds: ["neglected_product:brownies"], deduplicationKey: "dedup-a" });
  const expired = buildDraft({
    title: "Feature Croissants",
    sourceRuleIds: ["neglected_product:croissants"],
    deduplicationKey: "dedup-b",
    detectedAt: new Date(NOW_MS - 2 * DAY_MS).toISOString(),
    expiresAt: new Date(NOW_MS - 1 * DAY_MS).toISOString(),
  });
  const sessionDir = writeSession(t, { drafts: [eligible, expired] });
  const { client } = makeClient();

  await runPersistCommand(client, { sessionDir, now: NOW_MS });
  const result = readPersistenceResult(sessionDir);
  assert.equal(result.ok, true);
  assert.equal(result.inserted, 1);
  assert.equal(result.updated, 0);
  assert.equal(result.skipped, 0);
  assert.equal(result.failed, 0);
  assert.equal(result.excluded.length, 1);
  assert.deepEqual(result.excluded[0], { deduplicationKey: "dedup-b", title: "Feature Croissants", rule: "already-expired", recommendationIds: ["neglected_product:croissants"] });
});

test("manifest.persistence.excluded matches exactly {title, rule, recommendationIds} per excluded draft", async (t) => {
  const shortReason = buildDraft({ reason: "Too short." });
  const sessionDir = writeSession(t, { drafts: [shortReason] });
  const { client } = makeClient();

  await runPersistCommand(client, { sessionDir, now: NOW_MS });
  const manifest = readManifest(sessionDir);
  assert.deepEqual(manifest.persistence?.excluded, [{ title: shortReason.title, rule: "reason-too-short", recommendationIds: shortReason.sourceRuleIds }]);
});

test("success and failure messages use 'queued'/'review' language, never the word 'persisted'", async (t) => {
  const sessionDirOk = writeSession(t);
  const { client: okClient } = makeClient();
  const okOutcome = await runPersistCommand(okClient, { sessionDir: sessionDirOk, now: NOW_MS });
  assert.match(okOutcome.message ?? "", /^Queued \d+ Opportunity\(ies\) for review/);
  assert.doesNotMatch(okOutcome.message ?? "", /persisted/i);

  const sessionDirFail = writeSession(t, { drafts: [buildDraft()] });
  const { client: failClient } = makeClient({ insertErrorFor: () => true });
  const failOutcome = await runPersistCommand(failClient, { sessionDir: sessionDirFail, now: NOW_MS });
  assert.equal(failOutcome.exitCode, 1);
  assert.doesNotMatch(failOutcome.message ?? "", /persisted/i);
});

// ---- Scope guards ----

test("marketing-advisor-persist.ts has no AI/paid-provider name or API key reference", () => {
  const source = readFileSync(new URL("../scripts/marketing-advisor/marketing-advisor-persist.ts", import.meta.url), "utf8");
  for (const forbidden of [/Anthropic/i, /OpenAI/i, /Gemini/i, /ANTHROPIC_API_KEY/, /OPENAI_API_KEY/]) {
    assert.doesNotMatch(source, forbidden);
  }
});

test("marketing-advisor-evidence.ts and marketing-advisor-queue-eligibility.ts touch neither AI nor Supabase", () => {
  for (const file of ["../scripts/marketing-advisor/marketing-advisor-evidence.ts", "../scripts/marketing-advisor/marketing-advisor-queue-eligibility.ts"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    for (const forbidden of [/@supabase\/supabase-js/i, /\bfetch\s*\(/, /Anthropic/i, /OpenAI/i, /Gemini/i, /ANTHROPIC_API_KEY/, /OPENAI_API_KEY/]) {
      assert.doesNotMatch(source, forbidden);
    }
  }
});
