import test from "node:test";
import assert from "node:assert/strict";

import { buildProductTextPrompt } from "../scripts/creative-workers/product-text-prompt.ts";
import type { OpportunityRecord } from "../src/lib/opportunities.ts";

function opportunity(overrides: Partial<OpportunityRecord> = {}): OpportunityRecord {
  return {
    id: "opportunity-1",
    opportunityType: "product_marketing_content",
    producer: "daily_advisor",
    sourceType: "daily_advisor",
    sourceId: "source-1",
    title: "Create launch-ready product content for Brownies",
    summary: "Brownies has enough proof for a marketing content Opportunity.",
    reason: "Rule Engine evidence supports creating marketing content.",
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

test("buildProductTextPrompt is deterministic for the same Opportunity", () => {
  const opp = opportunity();
  assert.deepEqual(buildProductTextPrompt(opp), buildProductTextPrompt(opp));
});

test("buildProductTextPrompt includes the title, summary, reason, and product name", () => {
  const prompt = buildProductTextPrompt(opportunity());
  assert.match(prompt.user, /Create launch-ready product content for Brownies/);
  assert.match(prompt.user, /Brownies has enough proof/);
  assert.match(prompt.user, /Rule Engine evidence supports/);
  assert.match(prompt.user, /Product: Brownies/);
});

test("buildProductTextPrompt omits the product line when evidence has no product name", () => {
  const prompt = buildProductTextPrompt(opportunity({ evidence: {} }));
  assert.doesNotMatch(prompt.user, /Product:/);
});

test("buildProductTextPrompt's system message specifies the exact JSON response contract", () => {
  const prompt = buildProductTextPrompt(opportunity());
  assert.match(prompt.system, /"headline"/);
  assert.match(prompt.system, /"caption"/);
  assert.match(prompt.system, /ONLY a JSON object/);
});
