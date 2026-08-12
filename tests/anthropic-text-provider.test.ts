import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { createAnthropicProductTextExecutor } from "../scripts/creative-workers/anthropic-text-provider.ts";
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

function fakeOkResponse(text: string): Response {
  return {
    ok: true,
    status: 200,
    async json() {
      return { content: [{ type: "text", text }] };
    },
    async text() {
      return JSON.stringify({ content: [{ type: "text", text }] });
    },
  } as unknown as Response;
}

function fakeErrorResponse(status: number, detail: string): Response {
  return {
    ok: false,
    status,
    async json() {
      throw new Error("should not be called on an error response");
    },
    async text() {
      return detail;
    },
  } as unknown as Response;
}

test("createAnthropicProductTextExecutor parses a well-formed response into a valid v1 envelope", async () => {
  let capturedUrl: unknown;
  let capturedInit: RequestInit | undefined;
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    capturedUrl = url;
    capturedInit = init;
    return fakeOkResponse(JSON.stringify({ headline: "Fresh Brownies Today", caption: "Warm from the oven." }));
  }) as typeof fetch;

  const executor = createAnthropicProductTextExecutor({ apiKey: "test-key", fetchImpl });
  const signal = new AbortController().signal;
  const envelope = (await executor({ id: "job-1" } as CreativeJobRecord, buildCreativeInputFromOpportunity(opportunity()), { signal })) as Record<string, unknown>;

  assert.deepEqual(envelope, {
    schemaVersion: "v1",
    worker: "product_text_worker",
    output: { headline: "Fresh Brownies Today", caption: "Warm from the oven." },
    metadata: { generatedFromOpportunity: "opportunity-1", generatorVersion: "1" },
    artifacts: [],
  });

  assert.equal(capturedUrl, "https://api.anthropic.com/v1/messages");
  assert.equal(capturedInit?.signal, signal);
  const headers = capturedInit?.headers as Record<string, string>;
  assert.equal(headers["x-api-key"], "test-key");
  const body = JSON.parse(capturedInit?.body as string);
  assert.equal(body.model, "claude-haiku-4-5-20251001");
  assert.match(body.messages[0].content, /Create launch-ready product content for Brownies/);
});

test("createAnthropicProductTextExecutor strips a fenced JSON code block before parsing", async () => {
  const fetchImpl = (async () => fakeOkResponse('```json\n{"headline": "Fresh Brownies Today", "caption": "Warm from the oven."}\n```')) as typeof fetch;
  const executor = createAnthropicProductTextExecutor({ apiKey: "test-key", fetchImpl });
  const envelope = (await executor({ id: "job-1" } as CreativeJobRecord, buildCreativeInputFromOpportunity(opportunity()), { signal: new AbortController().signal })) as Record<string, unknown>;
  assert.deepEqual((envelope as { output: unknown }).output, { headline: "Fresh Brownies Today", caption: "Warm from the oven." });
});

test("createAnthropicProductTextExecutor throws a clear error on a non-2xx response", async () => {
  const fetchImpl = (async () => fakeErrorResponse(429, "rate limited")) as typeof fetch;
  const executor = createAnthropicProductTextExecutor({ apiKey: "test-key", fetchImpl });
  await assert.rejects(
    async () => {
      await executor({ id: "job-1" } as CreativeJobRecord, buildCreativeInputFromOpportunity(opportunity()), { signal: new AbortController().signal });
    },
    /status 429.*rate limited/,
  );
});

test("createAnthropicProductTextExecutor throws a clear error when the response text is not JSON", async () => {
  const fetchImpl = (async () => fakeOkResponse("not json at all")) as typeof fetch;
  const executor = createAnthropicProductTextExecutor({ apiKey: "test-key", fetchImpl });
  await assert.rejects(async () => {
    await executor({ id: "job-1" } as CreativeJobRecord, buildCreativeInputFromOpportunity(opportunity()), { signal: new AbortController().signal });
  }, /was not valid JSON/);
});

test("createAnthropicProductTextExecutor does not create excluded future-domain records", () => {
  const source = readFileSync(new URL("../scripts/creative-workers/anthropic-text-provider.ts", import.meta.url), "utf8");
  for (const forbidden of [/from\("assets"\)/i, /from\("approvals"\)/i, /from\("publishing_jobs"\)/i, /from\("content_drafts"\)/i, /Remotion/i]) {
    assert.doesNotMatch(source, forbidden);
  }
});
