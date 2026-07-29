import test from "node:test";
import assert from "node:assert/strict";

import {
  buildOpportunityDeduplicationKey,
  calculateOpportunityExpiresAt,
  fromOpportunityRow,
  isOpportunityStatus,
  toOpportunityRow,
  validateOpportunityDraft,
  type OpportunityDraft,
  type OpportunityRow,
} from "../src/lib/opportunities.ts";

const detectedAt = "2026-07-24T01:00:00.000Z";

function draft(overrides: Partial<OpportunityDraft> = {}): OpportunityDraft {
  return {
    opportunityType: "product_marketing_content",
    producer: "daily_advisor",
    sourceType: "daily_advisor",
    sourceId: "daily_advisor:2026-07-24:product_marketing_content:brownies",
    title: "Create launch-ready product content for Brownies",
    summary: "Brownies is ready for a launch-ready content prompt.",
    reason: "Rule Engine launch, financial, development, production, and quality gates passed.",
    recommendedAction: "create_content",
    evidenceVersion: "v1",
    evidence: { product: { id: "brownies" }, batch: { id: "batch-1" } },
    sourceRuleIds: ["LAUNCH-001", "FIN-001"],
    sourceFindings: [
      { id: "LAUNCH-001", category: "launch", severity: "blocker", passed: true, message: "Required data complete.", recommendation: "No action needed." },
      { id: "FIN-001", category: "financial", severity: "blocker", passed: true, message: "Margin is healthy.", recommendation: "No action needed." },
    ],
    detectedAt,
    expiresAt: "2026-07-27T01:00:00.000Z",
    deduplicationKey: "v1|producer=daily_advisor|finding_type=product_marketing_content|entity:batch=batch-1|entity:costing=costing-1|entity:product=brownies|action=create_content|business_date=2026-07-10",
    ...overrides,
  };
}

test("isOpportunityStatus accepts only the approved statuses", () => {
  for (const status of ["new", "accepted", "dismissed", "expired", "converted"]) {
    assert.equal(isOpportunityStatus(status), true);
  }
  for (const status of ["queued", "approved", "failed", "", "NEW"]) {
    assert.equal(isOpportunityStatus(status), false);
  }
});

test("validateOpportunityDraft defaults status to new and accepts a complete draft", () => {
  const result = validateOpportunityDraft(draft({ status: undefined }));
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.status, "new");
    assert.equal(result.value.title, "Create launch-ready product content for Brownies");
  }
});

test("validateOpportunityDraft rejects missing required fields and bad timestamps", () => {
  const result = validateOpportunityDraft(
    draft({
      producer: " ",
      sourceId: " ",
      title: "",
      reason: "",
      evidenceVersion: "",
      detectedAt: "not-a-date",
      expiresAt: "2026-07-23T01:00:00.000Z",
      sourceRuleIds: [],
    }),
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.errors.join("\n"), /sourceId is required/);
    assert.match(result.errors.join("\n"), /producer is required/);
    assert.match(result.errors.join("\n"), /title is required/);
    assert.match(result.errors.join("\n"), /reason is required/);
    assert.match(result.errors.join("\n"), /evidenceVersion is required/);
    assert.match(result.errors.join("\n"), /detectedAt must be a valid timestamp/);
    assert.match(result.errors.join("\n"), /sourceRuleIds must contain at least one stable rule ID/);
  }
});

test("validateOpportunityDraft requires evidence to be a non-null JSON object", () => {
  assert.equal(validateOpportunityDraft(draft({ evidence: null as unknown as Record<string, unknown> })).ok, false);
  assert.equal(validateOpportunityDraft(draft({ evidence: [] as unknown as Record<string, unknown> })).ok, false);

  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assert.equal(validateOpportunityDraft(draft({ evidence: circular })).ok, false);
});

test("buildOpportunityDeduplicationKey is stable across entity key ordering", () => {
  const first = buildOpportunityDeduplicationKey({
    producer: "daily_advisor",
    findingType: "product_marketing_content",
    entityIds: { product: "brownies", batch: "batch-1", costing: "costing-1" },
    action: "create_content",
    businessDate: "2026-07-10",
  });
  const second = buildOpportunityDeduplicationKey({
    producer: "daily_advisor",
    findingType: "product_marketing_content",
    entityIds: { costing: "costing-1", product: "brownies", batch: "batch-1" },
    action: "create_content",
    businessDate: "2026-07-10",
  });
  assert.equal(first, second);
  assert.equal(
    first,
    "v1|producer=daily_advisor|finding_type=product_marketing_content|entity:batch=batch-1|entity:costing=costing-1|entity:product=brownies|action=create_content|business_date=2026-07-10",
  );
});

test("buildOpportunityDeduplicationKey normalizes stable values", () => {
  const key = buildOpportunityDeduplicationKey({
    producer: " Daily   Advisor ",
    findingType: " Product Marketing Content ",
    entityIds: { Product: " Brownies " },
    action: "create_content",
    businessDate: "2026-07-10",
  });
  assert.equal(key, "v1|producer=daily advisor|finding_type=product marketing content|entity:product=brownies|action=create_content|business_date=2026-07-10");
});

test("buildOpportunityDeduplicationKey changes when the business fact changes", () => {
  const base = buildOpportunityDeduplicationKey({
    producer: "daily_advisor",
    findingType: "product_marketing_content",
    entityIds: { product: "brownies", batch: "batch-1", costing: "costing-1" },
    action: "create_content",
    businessDate: "2026-07-10",
  });
  const changed = buildOpportunityDeduplicationKey({
    producer: "daily_advisor",
    findingType: "product_marketing_content",
    entityIds: { product: "brownies", batch: "batch-2", costing: "costing-1" },
    action: "create_content",
    businessDate: "2026-07-10",
  });
  assert.notEqual(base, changed);
});

test("calculateOpportunityExpiresAt applies the approved defaults", () => {
  assert.equal(calculateOpportunityExpiresAt({ detectedAt, policy: "fresh_batch_same_day_availability" }), "2026-07-25T01:00:00.000Z");
  assert.equal(calculateOpportunityExpiresAt({ detectedAt, policy: "general_product_promotion" }), "2026-07-27T01:00:00.000Z");
  assert.equal(calculateOpportunityExpiresAt({ detectedAt, policy: "expiry_related", relevantExpiryDate: "2026-07-26" }), "2026-07-26T23:59:59.999Z");
});

test("toOpportunityRow and fromOpportunityRow preserve evidence and source findings", () => {
  const row = toOpportunityRow(draft());
  assert.deepEqual(row.evidence, { product: { id: "brownies" }, batch: { id: "batch-1" } });
  assert.deepEqual(row.source_rule_ids, ["LAUNCH-001", "FIN-001"]);
  assert.equal(row.producer, "daily_advisor");
  assert.equal(row.evidence_version, "v1");
  assert.equal(row.status, "new");
  assert.equal(row.summary, "Brownies is ready for a launch-ready content prompt.");

  const record = fromOpportunityRow({
    ...row,
    id: "opportunity-1",
    created_at: "2026-07-24T01:01:00.000Z",
    updated_at: "2026-07-24T01:02:00.000Z",
  } satisfies OpportunityRow);
  assert.deepEqual(record.evidence, row.evidence);
  assert.equal(record.producer, "daily_advisor");
  assert.equal(record.evidenceVersion, "v1");
  assert.deepEqual(record.sourceFindings, row.source_findings);
  assert.equal(record.createdAt, "2026-07-24T01:01:00.000Z");
});
