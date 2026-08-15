import test from "node:test";
import assert from "node:assert/strict";
import { resolveCreativeGrounding, type ResolveCreativeGroundingInput } from "../src/lib/creative-subject-resolution.ts";
import { wantsImmediateExecution, wantsSimpleProduction } from "../src/lib/creative-request-intent.ts";
import { buildCreativeInputFromOpportunity, buildCreativeInputFromRequest } from "../src/lib/creative-input.ts";
import { BRAND_BIBLE } from "../src/lib/marketing-advisor-context.ts";
import type { MarketingRecommendation } from "../src/lib/marketing-recommendations.ts";
import type { ContentJournalEntry, Product } from "../src/lib/product-lab-types.ts";
import type { OpportunityRecord } from "../src/lib/opportunities.ts";

// Content Creation MVP H1 -- execution-aware grounding priority.
//
// The owner-gate failure this covers: "Give me something easy today", with Biscoff Blondies baked
// that morning and cooling on the counter, resolved to Banana Bread because a no_marketing_history
// recommendation outranked a same-day Journey entry. The production guidance was excellent and the
// subject was not in the kitchen.
//
// Every test here is behavioural against the pure resolver. No AI, no database, no clock of its own.

// 2026-08-14 09:00 in Asia/Manila, where this business bakes. UTC and Manila agree on the calendar
// date at this instant, so the ordinary tests below are not secretly testing the timezone.
const NOW = Date.parse("2026-08-14T01:00:00.000Z");
const TODAY = "2026-08-14";
const YESTERDAY = "2026-08-13";

function product(overrides: Partial<Product> = {}): Product {
  return {
    id: "biscoff-blondies",
    name: "Biscoff Blondies",
    category: "Baked goods",
    role: "Hero candidate",
    status: "testing",
    description: "",
    image: "",
    decision: "Needs proof",
    isPublic: false,
    ...overrides,
  } as Product;
}

const BANANA_BREAD = product({ id: "banana-bread", name: "Banana Bread" });

// The same-day Journey entry from the owner gate: baked this morning, still on the counter.
function todaysBake(overrides: Partial<ContentJournalEntry> = {}): ContentJournalEntry {
  return {
    id: "journey-today",
    productId: "biscoff-blondies",
    entryDate: TODAY,
    whatWasMade: "Baked Biscoff Blondies this morning, cooling on the counter",
    mediaCaptured: "Nothing yet",
    lessonLearned: "The Biscoff swirl held its shape",
    postIdeas: "Close-up of the swirl",
    nextAction: "Photograph before they go",
    ...overrides,
  };
}

// The competing recommendation from the owner gate: a real, qualifying recommendation whose entire
// advantage is marketing opportunity.
function bananaBreadRecommendation(overrides: Partial<MarketingRecommendation> = {}): MarketingRecommendation {
  return {
    id: "no_marketing_history:banana-bread",
    recommendationType: "no_marketing_history",
    priority: 4,
    confidence: "high",
    title: "Introduce Banana Bread",
    explanation: "Banana Bread has never appeared in the Journey.",
    suggestedNextAction: "Create an introductory piece of content for Banana Bread.",
    evidence: { productId: "banana-bread", productName: "Banana Bread", entryCount: 0 },
    ...overrides,
  } as MarketingRecommendation;
}

// The full owner-gate grounding, so each test varies exactly one thing.
function resolve(overrides: Partial<ResolveCreativeGroundingInput> = {}) {
  return resolveCreativeGrounding({
    creativeInput: buildCreativeInputFromRequest({ text: "Give me something easy today." }),
    recommendations: [bananaBreadRecommendation()],
    journal: [todaysBake()],
    products: [product(), BANANA_BREAD],
    brandBible: BRAND_BIBLE,
    now: NOW,
    ...overrides,
  });
}

function request(text: string) {
  return buildCreativeInputFromRequest({ text });
}

// ---- 2. immediate / easy intent detection ------------------------------------------------------

test("immediate-execution intent is recognised across the effort and immediacy vocabulary", () => {
  for (const text of [
    "Give me something easy today.",
    "something quick please",
    "keep it simple",
    "a low-effort post",
    "a low effort post",
    "give me something I can post now",
    "what should I post today?",
    "I need something right now",
  ]) {
    assert.equal(wantsImmediateExecution(request(text)), true, `"${text}" expresses immediate intent`);
  }
});

test("ordinary planning requests are not immediate-execution intent", () => {
  for (const text of [
    "Give me a content idea.",
    "Give me something for this week.",
    "Give me a content idea for this week.",
    "Plan next month's posts.",
    "Something for the weekend.",
    "What should I make eventually?",
  ]) {
    assert.equal(wantsImmediateExecution(request(text)), false, `"${text}" is not immediate intent`);
  }
});

test("the S6 simple-production question keeps its own meaning and is unchanged by H1", () => {
  // "today" and "right now" say WHEN, not how hard. They must move the resolver without silently
  // changing which requests S6 nudges toward a smaller shoot.
  assert.equal(wantsSimpleProduction(request("Give me something for today.")), false);
  assert.equal(wantsImmediateExecution(request("Give me something for today.")), true);

  // Every effort phrasing still reads as simple production, exactly as it did before H1.
  for (const text of ["make it easy", "quick one", "keep it simple", "low-effort", "something I can post now"]) {
    assert.equal(wantsSimpleProduction(request(text)), true, `"${text}" still asks for a simple production`);
  }

  // An Opportunity-backed job has no owner sentence, so it expresses neither intent.
  const fromOpportunity = buildCreativeInputFromOpportunity({
    id: "opportunity-1",
    title: "Create launch-ready product content for Banana Bread",
    summary: "Banana Bread has a launch-marked proof batch.",
    reason: "Rule Engine evidence supports it.",
    evidence: { product: { id: "banana-bread", name: "Banana Bread" } },
  } as unknown as OpportunityRecord);
  assert.equal(wantsImmediateExecution(fromOpportunity), false);
  assert.equal(wantsSimpleProduction(fromOpportunity), false);
});

// ---- 1. explicit subject precedence ------------------------------------------------------------

test("an explicitly stated subject still wins outright, even against today's capturable bake", () => {
  const grounding = resolve({
    creativeInput: buildCreativeInputFromRequest({ text: "Give me something easy today about the banana bread.", subject: "Banana Bread", productId: "banana-bread", productName: "Banana Bread" }),
  });

  assert.equal(grounding.subject, "Banana Bread");
  assert.equal(grounding.subjectSource, "stated");
  assert.equal(grounding.subjectGrounding, null, "a stated subject still carries no manufactured grounding");
  assert.notEqual(grounding.subject, "Biscoff Blondies");
});

test("an Opportunity's own subject survives an immediate request", () => {
  const grounding = resolve({
    creativeInput: buildCreativeInputFromOpportunity({
      id: "opportunity-1",
      title: "Create launch-ready product content for Banana Bread",
      summary: "Banana Bread has a launch-marked proof batch.",
      reason: "Rule Engine evidence supports it.",
      evidence: { product: { id: "banana-bread", name: "Banana Bread" } },
    } as unknown as OpportunityRecord),
  });

  assert.equal(grounding.subject, "Create launch-ready product content for Banana Bread");
  assert.equal(grounding.subjectSource, "stated");
});

// ---- 3. the override itself: the owner-gate scenario -------------------------------------------

test("an immediate request picks today's capturable subject over a generic recommendation", () => {
  const grounding = resolve();

  assert.equal(grounding.subject, "Biscoff Blondies");
  assert.equal(grounding.productId, "biscoff-blondies");
  assert.equal(grounding.productName, "Biscoff Blondies");
  assert.equal(grounding.subjectKind, "product");
  assert.equal(grounding.subjectSource, "assumed");
  assert.notEqual(grounding.subject, "Banana Bread");
});

test("the override's grounding names the real entry it rested on", () => {
  const grounding = resolve();

  assert.match(grounding.subjectGrounding ?? "", /2026-08-14/);
  assert.match(grounding.subjectGrounding ?? "", /Baked Biscoff Blondies this morning, cooling on the counter/);
  assert.match(grounding.subjectGrounding ?? "", /photograph or film/);
  // Deterministic templating over real field values, never an opinion about what would be good.
  assert.doesNotMatch(grounding.subjectGrounding ?? "", /seems|probably|might be a good|feels like|perfect for/i);

  assert.ok(grounding.supportingFacts.includes("Baked Biscoff Blondies this morning, cooling on the counter"));
  assert.ok(grounding.supportingFacts.includes("The Biscoff swirl held its shape"));
});

test("the override applies with no competing recommendation at all", () => {
  const grounding = resolve({ recommendations: [] });

  assert.equal(grounding.subject, "Biscoff Blondies");
  assert.equal(grounding.subjectKind, "product", "the subject is the thing on the counter, not the entry's prose");
});

// ---- 4. historical Journey never counts as current ---------------------------------------------

test("a Journey entry from yesterday is not currently capturable", () => {
  const grounding = resolve({ journal: [todaysBake({ id: "journey-yesterday", entryDate: YESTERDAY })] });

  assert.equal(grounding.subject, "Banana Bread", "yesterday's bake must not displace the recommendation");
  assert.equal(grounding.subjectKind, "product");
  assert.match(grounding.subjectGrounding ?? "", /Marketing recommendation:/);
});

test("a Journey entry that is merely recent is not currently capturable", () => {
  // Well inside JOURNEY_RECENT_WINDOW_DAYS, so step 4 would happily call it recent. Recent is not
  // now, and the recommendation keeps its normal precedence.
  const grounding = resolve({ journal: [todaysBake({ id: "journey-old", entryDate: "2026-08-01" })] });

  assert.equal(grounding.subject, "Banana Bread");
});

test("a historical entry still falls through to the ordinary Journey fallback when nothing outranks it", () => {
  const grounding = resolve({ recommendations: [], journal: [todaysBake({ id: "journey-old", entryDate: "2026-08-01" })] });

  assert.equal(grounding.subject, "Baked Biscoff Blondies this morning, cooling on the counter");
  assert.equal(grounding.subjectKind, "process", "step 4's behaviour is untouched");
});

test("today is the business day in Manila, not in UTC", () => {
  // 2026-08-14 07:00 in Manila -- the owner is baking -- is still 2026-08-13 in UTC. Reading the day
  // in UTC would call this morning's entry tomorrow's and reject it, which is the off-by-one
  // business-day.ts documents for the first eight hours of every working day.
  const duringTheManilaMorning = Date.parse("2026-08-13T23:00:00.000Z");

  const grounding = resolve({ now: duringTheManilaMorning });
  assert.equal(grounding.subject, "Biscoff Blondies", "this morning's Manila bake is today's bake");

  // And the converse: just past midnight in Manila, the previous calendar day is genuinely over.
  const justAfterManilaMidnight = Date.parse("2026-08-14T16:30:00.000Z");
  assert.equal(resolve({ now: justAfterManilaMidnight }).subject, "Banana Bread");
});

// ---- 5, 6. the recommendation ranking is otherwise untouched -----------------------------------

test("a non-immediate request keeps the existing recommendation ranking", () => {
  for (const text of ["Give me a content idea.", "Give me a content idea for this week.", "Give me something for this week."]) {
    const grounding = resolve({ creativeInput: request(text) });

    assert.equal(grounding.subject, "Banana Bread", `"${text}" must not trigger the capturability override`);
    assert.equal(grounding.subjectGrounding, "Marketing recommendation: Banana Bread has never appeared in the Journey.");
  }
});

test("a non-immediate request with no recommendation keeps the existing Journey fallback", () => {
  const grounding = resolve({ creativeInput: request("Give me a content idea for this week."), recommendations: [] });

  assert.equal(grounding.subject, "Baked Biscoff Blondies this morning, cooling on the counter");
  assert.equal(grounding.subjectKind, "process");
});

test("a recommendation outranking another recommendation is still decided by the engine's order", () => {
  const ordered = [
    bananaBreadRecommendation({ id: "neglected_product:cookies", recommendationType: "neglected_product", priority: 5, title: "Feature Cookies again", explanation: "Cookies hasn't appeared in the Journey in 90 days.", evidence: { productId: "cookies", productName: "Cookies", entryCount: 2, lastCapturedDate: "2026-05-01", daysSinceLastCapture: 90, thresholdDays: 30 } }),
    bananaBreadRecommendation(),
  ] as MarketingRecommendation[];

  // Non-immediate request: H1 is not involved, and the engine's own order decides.
  assert.equal(resolve({ creativeInput: request("Give me a content idea."), recommendations: ordered, journal: [] }).subject, "Cookies");
});

// ---- 7. fallback behaviour is unchanged --------------------------------------------------------

test("an immediate request with no qualifying current evidence falls back to the recommendation", () => {
  assert.equal(resolve({ journal: [] }).subject, "Banana Bread");
});

test("an immediate request with nothing at all still reaches the brand moment", () => {
  const grounding = resolve({ recommendations: [], journal: [] });

  assert.equal(grounding.subjectKind, "brand");
  assert.equal(grounding.productId, null);
});

// ---- 9. product identity ------------------------------------------------------------------------

test("today's entry is not promoted when its product cannot be resolved", () => {
  // Recency is not identity. An entry naming a product the catalog does not have cannot honestly
  // become a product subject, so the recommendation keeps its normal precedence.
  const orphan = todaysBake({ id: "journey-orphan", productId: "deleted-product" });

  assert.equal(resolve({ journal: [orphan] }).subject, "Banana Bread");
});

test("today's entry is not promoted when it records no product at all", () => {
  assert.equal(resolve({ journal: [todaysBake({ id: "journey-noproduct", productId: "" })] }).subject, "Banana Bread");
});

test("today's entry is not promoted when it records nothing that was made", () => {
  assert.equal(resolve({ journal: [todaysBake({ id: "journey-empty", whatWasMade: "   " })] }).subject, "Banana Bread");
});

// ---- 8. no availability-for-sale inference -----------------------------------------------------

test("capturable now never becomes orderable now", () => {
  const grounding = resolve();
  const text = [grounding.subject, grounding.subjectGrounding ?? "", ...grounding.supportingFacts].join(" ");

  for (const forbidden of [
    /available today/i,
    /available to (order|buy|purchase)/i,
    /in stock/i,
    /for sale/i,
    /on the menu/i,
    /selling fast/i,
    /almost sold out/i,
    /order now/i,
    /message to order/i,
    /only \d+ (box|left)/i,
    /fresh(ly)? (baked )?and ready/i,
    /new(ly)? launched/i,
    /bestseller/i,
    /customers? (love|asked|want)/i,
  ]) {
    assert.doesNotMatch(text, forbidden, `the capturability path must not claim: ${forbidden}`);
  }

  // The grounding states its own limit rather than leaving the boundary implicit.
  assert.match(grounding.subjectGrounding ?? "", /says nothing about stock, sale status or demand/i);
});

// ---- 9 (deterministic selection), 10 (no architecture change) ----------------------------------

test("selection is deterministic and independent of journal order", () => {
  const first = todaysBake({ id: "journey-a", productId: "biscoff-blondies", whatWasMade: "Baked Biscoff Blondies this morning" });
  const second = todaysBake({ id: "journey-b", productId: "banana-bread", whatWasMade: "Baked Banana Bread this morning" });

  assert.equal(resolve({ journal: [first, second] }).subject, "Biscoff Blondies");
  assert.equal(resolve({ journal: [second, first] }).subject, "Biscoff Blondies", "input order must not matter");
  assert.deepEqual(resolve({ journal: [second, first] }), resolve({ journal: [first, second] }));
});

test("the override emits the same grounding shape as every other resolution path", () => {
  const grounding = resolve();

  assert.deepEqual(
    Object.keys(grounding).sort(),
    ["productId", "productName", "subject", "subjectGrounding", "subjectKind", "subjectSource", "supportingFacts"],
    "H1 adds no field to the S3A contract",
  );
  for (const key of ["angle", "hook", "caption", "cta", "format", "formatHint", "shots", "slides", "frames", "capturable", "availability"]) {
    assert.ok(!(key in grounding), `H1 must not emit "${key}"`);
  }
  assert.ok(grounding.subjectGrounding !== null && grounding.subjectGrounding.trim().length > 0, "assumed subjects require grounding (S2 validator)");
});

test("the override mutates none of its inputs and performs no I/O", () => {
  const creativeInput = request("Give me something easy today.");
  const recommendations = [bananaBreadRecommendation()];
  const journal = [todaysBake()];
  const products = [product(), BANANA_BREAD];
  const before = JSON.stringify({ creativeInput, recommendations, journal, products });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => {
    throw new Error("H1 must not perform I/O");
  }) as typeof fetch;
  try {
    resolveCreativeGrounding({ creativeInput, recommendations, journal, products, brandBible: BRAND_BIBLE, now: NOW });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(JSON.stringify({ creativeInput, recommendations, journal, products }), before);
});
