import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCreativeInputFromOpportunity,
  buildCreativeInputFromRequest,
  fromIntentJson,
  toIntentJson,
  validateCreativeRequest,
  type CreativeInput,
} from "../src/lib/creative-input.ts";
import { buildMockCreativeJobResult, buildOpportunityBriefCreativeJobResult, isCreativeJobResultEnvelope } from "../src/lib/creative-jobs.ts";
import type { OpportunityRecord } from "../src/lib/opportunities.ts";

// Content Creation MVP S1. CreativeInput is the convergence point for both entry paths, and it
// carries CONTEXT ONLY -- never a creative decision.

function opportunity(overrides: Partial<OpportunityRecord> = {}): OpportunityRecord {
  return {
    id: "opportunity-1",
    opportunityType: "product_marketing_content",
    producer: "daily_advisor",
    sourceType: "daily_advisor",
    sourceId: "source-1",
    title: "Create launch-ready product content for Brownies",
    summary: "Brownies has a launch-marked proof batch.",
    reason: "Rule Engine evidence supports it.",
    recommendedAction: "create_content",
    evidenceVersion: "v1",
    evidence: { product: { id: "brownies", name: "Brownies" } },
    sourceRuleIds: ["LAUNCH-001"],
    sourceFindings: [],
    detectedAt: "2026-08-12T09:00:00.000Z",
    expiresAt: "2026-08-15T09:00:00.000Z",
    deduplicationKey: "key-1",
    status: "accepted",
    createdAt: "2026-08-12T09:00:00.000Z",
    updatedAt: "2026-08-12T09:00:00.000Z",
    ...overrides,
  } as OpportunityRecord;
}

// ---- input purity: the boundary that stops outputs leaking back into inputs ----

test("CreativeInput carries no generated creative decision, from either adapter", () => {
  const forbidden = ["angle", "hook", "headline", "caption", "cta", "format", "shots", "slides", "frames", "visualDirection", "platformVariants"];
  const inputs: CreativeInput[] = [
    buildCreativeInputFromOpportunity(opportunity()),
    buildCreativeInputFromRequest({ text: "show today's fresh batch" }),
  ];

  for (const input of inputs) {
    for (const key of forbidden) {
      assert.ok(!(key in input), `CreativeInput must not carry the generated field "${key}"`);
    }
    // The exact permitted surface, so a future field addition is a deliberate, visible decision.
    assert.deepEqual(
      Object.keys(input).sort(),
      ["evidenceSummary", "origin", "productId", "productName", "reason", "requestText", "subject"],
    );
  }
});

// ---- the Opportunity adapter must not change v1 generation ----

test("the Opportunity adapter maps only what the Opportunity already states", () => {
  const input = buildCreativeInputFromOpportunity(opportunity());

  assert.equal(input.subject, "Create launch-ready product content for Brownies");
  assert.equal(input.reason, "Rule Engine evidence supports it.");
  assert.equal(input.evidenceSummary, "Brownies has a launch-marked proof batch.");
  assert.equal(input.productName, "Brownies");
  assert.equal(input.productId, "brownies");
  assert.equal(input.requestText, null);
  assert.deepEqual(input.origin, { kind: "opportunity", opportunityId: "opportunity-1" });
});

test("subject is the Opportunity TITLE, never displaced by the product name", () => {
  // Regression guard. Preferring evidence.product.name here would silently rewrite the headline of
  // every Opportunity-backed package, since the v1 generators read subject directly.
  const input = buildCreativeInputFromOpportunity(opportunity());
  assert.equal(input.subject, opportunity().title);
  assert.notEqual(input.subject, "Brownies");
});

test("v1 generation from an Opportunity is byte-identical to the pre-S1 output", () => {
  const source = opportunity();
  const input = buildCreativeInputFromOpportunity(source);

  const brief = buildOpportunityBriefCreativeJobResult(input);
  assert.equal(brief.output.headline, source.title);
  assert.equal(brief.output.caption, source.summary.trim());
  assert.equal(brief.metadata.generatedFromOpportunity, source.id);

  const mock = buildMockCreativeJobResult(input);
  assert.equal(mock.output.headline, `MOCK ONLY - ${source.title}`);
  assert.equal(mock.output.caption, `MOCK ONLY - ${source.summary || source.reason}`);
  assert.equal(mock.metadata.generatedFromOpportunity, source.id);
});

test("an Opportunity with an empty summary still falls back to its reason, exactly as before", () => {
  const source = opportunity({ summary: "" });
  const input = buildCreativeInputFromOpportunity(source);

  assert.equal(buildOpportunityBriefCreativeJobResult(input).output.caption, source.reason);
  assert.equal(buildMockCreativeJobResult(input).output.caption, `MOCK ONLY - ${source.reason}`);
});

// ---- the request adapter ----

test("the request adapter preserves the owner's words verbatim, including surrounding whitespace", () => {
  const text = "  make something about the fresh batch  ";
  const input = buildCreativeInputFromRequest({ text });

  assert.equal(input.requestText, text, "requestText must be stored exactly as typed");
  assert.equal(input.subject, null, "a subject is never extracted from free text at this boundary");
  assert.equal(input.reason, null);
  assert.equal(input.evidenceSummary, null);
  assert.deepEqual(input.origin, { kind: "user_request" });
});

test("a request-backed envelope records the absence of an Opportunity as null, and still validates", () => {
  const input = buildCreativeInputFromRequest({ text: "promote the blondies" });
  const envelope = buildMockCreativeJobResult(input);

  assert.equal(envelope.metadata.generatedFromOpportunity, null);
  assert.ok(isCreativeJobResultEnvelope(envelope), "a request-backed v1 envelope must still be valid");
});

test("an envelope whose generatedFromOpportunity is an empty or whitespace string is still rejected", () => {
  const base = buildMockCreativeJobResult(buildCreativeInputFromRequest({ text: "x" }));
  for (const bad of ["", "   ", "has space"]) {
    const envelope = { ...base, metadata: { ...base.metadata, generatedFromOpportunity: bad } };
    assert.ok(!isCreativeJobResultEnvelope(envelope), `"${bad}" must not be accepted as an opportunity id`);
  }
});

// ---- request validation and intent round-tripping ----

test("a request with no words is refused; everything else stays optional", () => {
  assert.equal(validateCreativeRequest({ text: "" }).ok, false);
  assert.equal(validateCreativeRequest({ text: "   " }).ok, false);
  assert.equal(validateCreativeRequest({}).ok, false);
  assert.equal(validateCreativeRequest(null).ok, false);
  assert.equal(validateCreativeRequest({ text: "a" }).ok, true);
});

test("intent round-trips through storage without altering the owner's text", () => {
  const request = { text: "  a Reel about Saturday orders  ", subject: "Saturday orders", productId: null, productName: null };
  const restored = fromIntentJson(toIntentJson(request));

  assert.equal(restored.ok, true);
  if (!restored.ok) return;
  assert.equal(restored.request.text, request.text);
  assert.equal(restored.request.subject, "Saturday orders");
  assert.deepEqual(buildCreativeInputFromRequest(restored.request), buildCreativeInputFromRequest(request));
});

test("two identical requests produce equal but independent inputs -- repetition is legitimate", () => {
  const first = buildCreativeInputFromRequest({ text: "promote Biscoff Blondie" });
  const second = buildCreativeInputFromRequest({ text: "promote Biscoff Blondie" });

  assert.deepEqual(first, second);
  assert.notEqual(first, second, "distinct objects -- nothing is memoized or deduplicated here");
});
