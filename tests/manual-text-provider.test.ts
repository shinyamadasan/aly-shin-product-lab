import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { buildManualExportDocument, buildManualResultExecutor, parseManualProductTextResult } from "../scripts/creative-workers/manual-text-provider.ts";
import type { CreativeJobRecord } from "../src/lib/creative-jobs.ts";
import type { OpportunityRecord } from "../src/lib/opportunities.ts";
import { buildCreativeInputFromOpportunity } from "../src/lib/creative-input.ts";

function opportunity(overrides: Partial<OpportunityRecord> = {}): OpportunityRecord {
  return {
    id: "opportunity-1",
    opportunityType: "product_marketing_content",
    producer: "daily_advisor",
    sourceType: "daily_advisor",
    sourceId: "source-1",
    title: "Create launch-ready product content for Brownies",
    summary: "Brownies is ready.",
    reason: "Rule Engine evidence supports it.",
    recommendedAction: "create_content",
    evidenceVersion: "v1",
    evidence: { product: { id: "brownies", name: "Brownies" } },
    sourceRuleIds: ["RULE-001"],
    sourceFindings: [],
    detectedAt: "2026-07-29T09:00:00.000Z",
    expiresAt: "2026-08-01T09:00:00.000Z",
    deduplicationKey: "key",
    status: "accepted",
    createdAt: "2026-07-29T09:00:00.000Z",
    updatedAt: "2026-07-29T09:00:00.000Z",
    ...overrides,
  };
}

test("parseManualProductTextResult accepts a well-formed result", () => {
  const result = parseManualProductTextResult(JSON.stringify({ headline: "Fresh Brownies Today", caption: "Warm from the oven." }));
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.result.headline, "Fresh Brownies Today");
    assert.equal(result.result.caption, "Warm from the oven.");
  }
});

test("parseManualProductTextResult rejects invalid JSON", () => {
  const result = parseManualProductTextResult("not json");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.message, /not valid JSON/);
  }
});

test("parseManualProductTextResult rejects a non-object JSON value", () => {
  const result = parseManualProductTextResult(JSON.stringify(["headline", "caption"]));
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.message, /must be a JSON object/);
  }
});

test("parseManualProductTextResult rejects a missing or empty headline", () => {
  const missing = parseManualProductTextResult(JSON.stringify({ caption: "Warm from the oven." }));
  assert.equal(missing.ok, false);
  const empty = parseManualProductTextResult(JSON.stringify({ headline: "   ", caption: "Warm from the oven." }));
  assert.equal(empty.ok, false);
  if (!missing.ok) assert.match(missing.message, /headline/);
  if (!empty.ok) assert.match(empty.message, /headline/);
});

test("parseManualProductTextResult rejects a missing or empty caption", () => {
  const missing = parseManualProductTextResult(JSON.stringify({ headline: "Fresh Brownies Today" }));
  assert.equal(missing.ok, false);
  const empty = parseManualProductTextResult(JSON.stringify({ headline: "Fresh Brownies Today", caption: "" }));
  assert.equal(empty.ok, false);
  if (!missing.ok) assert.match(missing.message, /caption/);
  if (!empty.ok) assert.match(empty.message, /caption/);
});

test("buildManualExportDocument includes the prompt content and the import command hint", () => {
  const job: Pick<CreativeJobRecord, "id"> = { id: "job-1" };
  const document = buildManualExportDocument(job, opportunity());
  assert.match(document, /job job-1/);
  assert.match(document, /Create launch-ready product content for Brownies/);
  assert.match(document, /"headline"/);
  assert.match(document, /run\.ts import --job-id job-1 --result-file/);
});

test("buildManualResultExecutor returns a valid v1 envelope built from the given result", async () => {
  const executor = buildManualResultExecutor({ headline: "Fresh Brownies Today", caption: "Warm from the oven." });
  const envelope = (await executor(
    { id: "job-1" } as CreativeJobRecord,
    buildCreativeInputFromOpportunity(opportunity()),
    { signal: new AbortController().signal },
  )) as Record<string, unknown>;

  assert.deepEqual(envelope, {
    schemaVersion: "v1",
    worker: "product_text_worker",
    output: { headline: "Fresh Brownies Today", caption: "Warm from the oven." },
    metadata: { generatedFromOpportunity: "opportunity-1", generatorVersion: "1" },
    artifacts: [],
  });
});

test("manual text provider makes no network call and has no coupling to the paid path", () => {
  // "Claude Code" is the human tool this mode intentionally references (in comments and the
  // export document) -- what must never appear is a network call, an API key read, an "OpenAI"
  // or "Gemini" reference, or any import of the paid adapter file.
  const source = readFileSync(new URL("../scripts/creative-workers/manual-text-provider.ts", import.meta.url), "utf8");
  for (const forbidden of [/\bfetch\s*\(/, /OpenAI/i, /Gemini/i, /ANTHROPIC_API_KEY/, /anthropic-text-provider/i]) {
    assert.doesNotMatch(source, forbidden);
  }
});
