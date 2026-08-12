import test from "node:test";
import assert from "node:assert/strict";
import {
  JOURNEY_RECENT_WINDOW_DAYS,
  resolveCreativeGrounding,
  type ResolveCreativeGroundingInput,
} from "../src/lib/creative-subject-resolution.ts";
import { buildCreativeInputFromOpportunity, buildCreativeInputFromRequest } from "../src/lib/creative-input.ts";
import { BRAND_BIBLE } from "../src/lib/marketing-advisor-context.ts";
import { buildMarketingRecommendations } from "../src/lib/marketing-recommendations.ts";
import type { MarketingRecommendation } from "../src/lib/marketing-recommendations.ts";
import type { ContentJournalEntry, Product } from "../src/lib/product-lab-types.ts";
import type { OpportunityRecord } from "../src/lib/opportunities.ts";

// Content Creation MVP S3A. Every test is behavioural: the resolver is pure, so a fixture in and a
// grounding out is the whole contract. No AI, no database, no clock of its own.

const NOW = Date.parse("2026-08-12T09:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

function product(overrides: Partial<Product> = {}): Product {
  return {
    id: "blondies",
    name: "Blondies",
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

function journeyEntry(overrides: Partial<ContentJournalEntry> = {}): ContentJournalEntry {
  return {
    id: "journey-1",
    productId: "blondies",
    entryDate: "2026-08-10",
    whatWasMade: "Tested a new Blondies batch with more brown butter",
    mediaCaptured: "Two photos of the tray",
    lessonLearned: "Needs five more minutes",
    postIdeas: "Show the crack shot",
    nextAction: "Re-bake Saturday",
    ...overrides,
  };
}

function recommendation(overrides: Partial<MarketingRecommendation> = {}): MarketingRecommendation {
  return {
    id: "no_marketing_history:blondies",
    recommendationType: "no_marketing_history",
    priority: 4,
    confidence: "high",
    title: "Introduce Blondies",
    explanation: "Blondies has never appeared in the Journey.",
    suggestedNextAction: "Create an introductory piece of content for Blondies.",
    evidence: { productId: "blondies", productName: "Blondies", entryCount: 0 },
    ...overrides,
  } as MarketingRecommendation;
}

function resolve(overrides: Partial<ResolveCreativeGroundingInput> = {}) {
  return resolveCreativeGrounding({
    creativeInput: buildCreativeInputFromRequest({ text: "give me something easy today" }),
    recommendations: [],
    journal: [],
    products: [product()],
    brandBible: BRAND_BIBLE,
    now: NOW,
    ...overrides,
  });
}

function opportunity(overrides: Partial<OpportunityRecord> = {}): OpportunityRecord {
  return {
    id: "opportunity-1",
    opportunityType: "product_marketing_content",
    producer: "daily_advisor",
    sourceType: "daily_advisor",
    sourceId: "src",
    title: "Create launch-ready product content for Brownies",
    summary: "Brownies has a launch-marked proof batch.",
    reason: "Rule Engine evidence supports it.",
    recommendedAction: "create_content",
    evidenceVersion: "v1",
    evidence: { product: { id: "brownies", name: "Brownies" } },
    sourceRuleIds: [],
    sourceFindings: [],
    detectedAt: "2026-08-12T08:00:00.000Z",
    expiresAt: "2026-08-15T08:00:00.000Z",
    deduplicationKey: "key",
    status: "accepted",
    createdAt: "2026-08-12T08:00:00.000Z",
    updatedAt: "2026-08-12T08:00:00.000Z",
    ...overrides,
  } as OpportunityRecord;
}

// ---- A, C, M: an explicitly stated subject wins ------------------------------------------------

test("an explicitly stated subject is used verbatim and marked stated", () => {
  const grounding = resolve({
    creativeInput: buildCreativeInputFromRequest({ text: "promote the blondies", subject: "Biscoff Blondie", productId: "blondies", productName: "Blondies" }),
  });

  assert.equal(grounding.subject, "Biscoff Blondie");
  assert.equal(grounding.subjectSource, "stated");
  assert.equal(grounding.subjectGrounding, null);
  assert.equal(grounding.subjectKind, "product");
});

test("a stated subject outranks a qualifying recommendation for a different product", () => {
  const grounding = resolve({
    creativeInput: buildCreativeInputFromRequest({ text: "about the cookies", subject: "Cookies" }),
    recommendations: [recommendation()],
  });

  assert.equal(grounding.subject, "Cookies");
  assert.equal(grounding.subjectSource, "stated");
  assert.notEqual(grounding.subject, "Blondies");
});

test("a stated subject with no resolvable product is a topic, not an implied product", () => {
  const grounding = resolve({ creativeInput: buildCreativeInputFromRequest({ text: "about Saturday orders", subject: "Saturday orders" }) });

  assert.equal(grounding.subjectKind, "topic");
  assert.equal(grounding.productId, null);
  assert.equal(grounding.productName, null);
});

// ---- B, T: Opportunity-origin compatibility ----------------------------------------------------

test("an Opportunity-backed job keeps the Opportunity's own subject and never re-selects", () => {
  const grounding = resolve({
    creativeInput: buildCreativeInputFromOpportunity(opportunity()),
    // A higher-priority recommendation for a DIFFERENT product must not displace it.
    recommendations: [recommendation({ priority: 5 })],
  });

  assert.equal(grounding.subject, "Create launch-ready product content for Brownies");
  assert.equal(grounding.subjectSource, "stated");
  assert.equal(grounding.productName, "Brownies");
  assert.notEqual(grounding.productName, "Blondies");
});

test("an Opportunity's given context survives as supporting facts rather than as invented grounding", () => {
  const grounding = resolve({ creativeInput: buildCreativeInputFromOpportunity(opportunity()) });

  assert.equal(grounding.subjectGrounding, null, "stated subjects carry no manufactured grounding");
  assert.ok(grounding.supportingFacts.includes("Rule Engine evidence supports it."));
  assert.ok(grounding.supportingFacts.includes("Brownies has a launch-marked proof batch."));
});

// ---- D, E, F: recommendation fallback ----------------------------------------------------------

test("a vague request falls back to the top-ranked qualifying recommendation", () => {
  const grounding = resolve({ recommendations: [recommendation()] });

  assert.equal(grounding.subject, "Blondies");
  assert.equal(grounding.subjectSource, "assumed");
  assert.equal(grounding.subjectKind, "product");
  assert.equal(grounding.productId, "blondies");
});

test("recommendation grounding quotes the engine's real explanation, not an opinion", () => {
  const grounding = resolve({ recommendations: [recommendation()] });

  assert.equal(grounding.subjectGrounding, "Marketing recommendation: Blondies has never appeared in the Journey.");
  // Guards against grounding drifting into unsupported opinion.
  assert.doesNotMatch(grounding.subjectGrounding ?? "", /seems|probably|might be a good|feels like/i);
});

test("resolution follows the engine's existing order and is not re-ranked here", () => {
  // Deliberately supplied in the engine's own comparator order: priority desc, then confidence.
  const ordered = [
    recommendation({ id: "neglected_product:cookies", recommendationType: "neglected_product", priority: 5, title: "Feature Cookies again", explanation: "Cookies hasn't appeared in the Journey in 90 days.", evidence: { productId: "cookies", productName: "Cookies", entryCount: 2, lastCapturedDate: "2026-05-01", daysSinceLastCapture: 90, thresholdDays: 30 } }),
    recommendation(),
  ] as MarketingRecommendation[];

  assert.equal(resolve({ recommendations: ordered }).subject, "Cookies");
  // Same input twice, same answer -- no hidden state, no randomness.
  assert.deepEqual(resolve({ recommendations: ordered }), resolve({ recommendations: ordered }));
});

test("recommendations whose evidence cannot name a product are skipped, not forced into a subject", () => {
  const seasonal = {
    id: "seasonal_opportunity:christmas",
    recommendationType: "seasonal_opportunity",
    priority: 5,
    confidence: "high",
    title: "Plan for Christmas",
    explanation: "Christmas is 14 days away.",
    suggestedNextAction: "Plan seasonal content.",
    evidence: { holidayName: "Christmas", holidayDate: "2026-12-25", daysAway: 14, thresholdDays: 21 },
  } as unknown as MarketingRecommendation;
  const expiring = {
    id: "expiring_ingredient:butter",
    recommendationType: "expiring_ingredient",
    priority: 5,
    confidence: "medium",
    title: "Use the butter",
    explanation: "Butter expires soon.",
    suggestedNextAction: "Bake with it.",
    evidence: { ingredientId: "butter", ingredientName: "Butter", nearestExpirationDate: "2026-08-14", expirationStatus: "expiring", basis: "no product-linking field exists" },
  } as unknown as MarketingRecommendation;

  // Both outrank the product recommendation on priority, yet neither can honestly name a product.
  const grounding = resolve({ recommendations: [seasonal, expiring, recommendation()] });

  assert.equal(grounding.subject, "Blondies");
  assert.match(grounding.subjectGrounding ?? "", /never appeared in the Journey/);
});

test("with no qualifying recommendation at all, resolution moves past step 2", () => {
  const seasonalOnly = [{ id: "seasonal_opportunity:x", recommendationType: "seasonal_opportunity", priority: 5, confidence: "high", title: "t", explanation: "e", suggestedNextAction: "s", evidence: { holidayName: "X", holidayDate: "2026-12-25", daysAway: 5, thresholdDays: 21 } }] as unknown as MarketingRecommendation[];

  assert.equal(resolve({ recommendations: seasonalOnly, journal: [journeyEntry()] }).subjectKind, "process");
});

// ---- G, H, I: Journey fallback -----------------------------------------------------------------

test("with no qualifying recommendation, a recent Journey entry becomes a process subject", () => {
  const grounding = resolve({ journal: [journeyEntry()] });

  assert.equal(grounding.subject, "Tested a new Blondies batch with more brown butter");
  assert.equal(grounding.subjectKind, "process");
  assert.equal(grounding.subjectSource, "assumed");
  assert.equal(grounding.productId, "blondies");
  assert.equal(grounding.productName, "Blondies", "product association is read from the entry, never inferred from prose");
});

test("Journey selection is the most recent entry, with a deterministic tie-break", () => {
  const older = journeyEntry({ id: "journey-a", entryDate: "2026-08-01", whatWasMade: "Older bake" });
  const newer = journeyEntry({ id: "journey-b", entryDate: "2026-08-10", whatWasMade: "Newer bake" });
  assert.equal(resolve({ journal: [older, newer] }).subject, "Newer bake");
  assert.equal(resolve({ journal: [newer, older] }).subject, "Newer bake", "input order must not matter");

  // Same date -> lowest id wins, so repeated runs agree.
  const tieA = journeyEntry({ id: "journey-a", entryDate: "2026-08-10", whatWasMade: "Entry A" });
  const tieB = journeyEntry({ id: "journey-b", entryDate: "2026-08-10", whatWasMade: "Entry B" });
  assert.equal(resolve({ journal: [tieB, tieA] }).subject, "Entry A");
});

test("Journey grounding names the actual entry that was selected", () => {
  const grounding = resolve({ journal: [journeyEntry()] });

  assert.equal(grounding.subjectGrounding, "Recent Journey entry (2026-08-10): Tested a new Blondies batch with more brown butter");
  assert.ok(grounding.supportingFacts.includes("Two photos of the tray"));
  assert.ok(grounding.supportingFacts.includes("Needs five more minutes"));
});

test("a Journey entry older than the window is not treated as recent", () => {
  const stale = journeyEntry({ entryDate: new Date(NOW - (JOURNEY_RECENT_WINDOW_DAYS + 1) * DAY).toISOString().slice(0, 10) });

  assert.equal(resolve({ journal: [stale] }).subjectKind, "brand", "a stale entry must fall through to the brand moment");
});

// ---- J, K: brand fallback ----------------------------------------------------------------------

test("with no recommendation and no Journey entry, a brand moment is used", () => {
  const grounding = resolve();

  assert.equal(grounding.subjectKind, "brand");
  assert.equal(grounding.subjectSource, "assumed");
  assert.ok((grounding.subjectGrounding ?? "").length > 0);
  assert.ok(grounding.supportingFacts.includes(BRAND_BIBLE.mission), "brand facts come from the existing BRAND_BIBLE");
});

test("the brand fallback claims no fresh batch, stock, demand or urgency", () => {
  const grounding = resolve();
  const text = [grounding.subject, grounding.subjectGrounding ?? "", ...grounding.supportingFacts].join(" ");

  for (const forbidden of [/fresh batch/i, /available today/i, /in stock/i, /selling fast/i, /almost sold out/i, /order now/i, /only \d+ left/i, /bestseller/i, /today only/i]) {
    assert.doesNotMatch(text, forbidden, `brand fallback must not claim: ${forbidden}`);
  }
});

// ---- L: the S2 invariant -----------------------------------------------------------------------

test("every assumed subject carries non-empty grounding, and every stated one carries none", () => {
  const assumed = [
    resolve({ recommendations: [recommendation()] }),
    resolve({ journal: [journeyEntry()] }),
    resolve(),
  ];
  for (const grounding of assumed) {
    assert.equal(grounding.subjectSource, "assumed");
    assert.ok(grounding.subjectGrounding !== null && grounding.subjectGrounding.trim().length > 0, "assumed subjects require grounding (S2 validator)");
  }

  const stated = resolve({ creativeInput: buildCreativeInputFromRequest({ text: "x", subject: "Cookies" }) });
  assert.equal(stated.subjectSource, "stated");
  assert.equal(stated.subjectGrounding, null);
});

// ---- N: the anti-heuristic guard ---------------------------------------------------------------

test("no product is selected merely because it exists in the catalog", () => {
  // A full, attractive catalog and a vague request -- but zero marketing signal and zero Journey.
  // Anything that names a product here is choosing by recency, order or readiness.
  const catalog = [
    product({ id: "brownies", name: "Brownies", decision: "Candidate", status: "testing" }),
    product({ id: "blondies", name: "Blondies", decision: "Candidate", status: "testing" }),
    product({ id: "cookies", name: "Cookies", decision: "Needs proof", status: "paused" }),
  ];

  const grounding = resolve({ products: catalog });

  assert.equal(grounding.subjectKind, "brand");
  assert.equal(grounding.productId, null);
  assert.equal(grounding.productName, null);
  for (const entry of catalog) {
    assert.notEqual(grounding.subject, entry.name, `"${entry.name}" must not be chosen without a grounded reason`);
  }
});

// ---- O: no invented selling/availability -------------------------------------------------------

test("no resolution path invents selling or availability claims", () => {
  const groundings = [
    resolve({ creativeInput: buildCreativeInputFromRequest({ text: "x", subject: "Blondies", productId: "blondies", productName: "Blondies" }) }),
    resolve({ recommendations: [recommendation()] }),
    resolve({ journal: [journeyEntry()] }),
    resolve(),
  ];

  for (const grounding of groundings) {
    const text = [grounding.subject, grounding.subjectGrounding ?? "", ...grounding.supportingFacts].join(" ");
    for (const forbidden of [/available today/i, /in stock/i, /selling fast/i, /almost sold out/i, /order now before/i, /only \d+ (box|left)/i]) {
      assert.doesNotMatch(text, forbidden);
    }
  }
});

// ---- P, Q: format is never resolved here -------------------------------------------------------

test("S3A never resolves or defaults a format", () => {
  const groundings = [resolve({ recommendations: [recommendation()] }), resolve({ journal: [journeyEntry()] }), resolve()];

  for (const grounding of groundings) {
    for (const key of ["format", "formatHint", "formatChosenBy", "formatRationale"]) {
      assert.ok(!(key in grounding), `S3A must not emit "${key}" -- format is S3B's decision`);
    }
    assert.ok(!JSON.stringify(grounding).match(/"(photo|reel|carousel|story)"/), "no format value may leak into the grounding");
  }
});

test("S3A emits no creative decision of any kind", () => {
  const grounding = resolve({ recommendations: [recommendation()] });
  for (const key of ["angle", "hook", "headline", "caption", "cta", "shots", "slides", "frames", "visualDirection", "spokenScript", "audioDirection", "platformVariants"]) {
    assert.ok(!(key in grounding), `S3A must not emit the creative field "${key}"`);
  }
  assert.deepEqual(
    Object.keys(grounding).sort(),
    ["productId", "productName", "subject", "subjectGrounding", "subjectKind", "subjectSource", "supportingFacts"],
  );
});

// ---- R: request text is untouched --------------------------------------------------------------

test("resolution never rewrites the stored request text", () => {
  const text = "  give me something easy today  ";
  const creativeInput = buildCreativeInputFromRequest({ text });
  resolve({ creativeInput, recommendations: [recommendation()] });

  assert.equal(creativeInput.requestText, text, "requestText must survive verbatim, including whitespace");
});

// ---- S: purity ---------------------------------------------------------------------------------

test("the resolver performs no I/O and mutates none of its inputs", async () => {
  const creativeInput = buildCreativeInputFromRequest({ text: "vague" });
  const recommendations = [recommendation()];
  const journal = [journeyEntry()];
  const products = [product()];
  const before = JSON.stringify({ creativeInput, recommendations, journal, products });

  // Any real network call would throw here.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => {
    throw new Error("S3A must not perform I/O");
  }) as typeof fetch;
  try {
    resolveCreativeGrounding({ creativeInput, recommendations, journal, products, brandBible: BRAND_BIBLE, now: NOW });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(JSON.stringify({ creativeInput, recommendations, journal, products }), before, "inputs must not be mutated");
});

test("the resolver composes with the real recommendation engine's output, unmodified", () => {
  // Not a fixture-shaped recommendation: this is whatever buildMarketingRecommendations actually
  // produces, proving S3A consumes the engine's real contract rather than a convenient stand-in.
  const context = {
    version: 1 as const,
    generatedAt: new Date(NOW).toISOString(),
    businessFacts: "",
    products: [product()],
    publishingHistory: { basis: "", byProduct: [], unassociatedEntryCount: 0, lastUnassociatedCapturedDate: null, daysSinceLastUnassociatedCapture: null },
    currentGoals: { hasData: false as const, reason: "" },
    promotions: { hasData: false as const, reason: "" },
    season: { asOfDate: "2026-08-12", monthName: "August", quarterLabel: "Q3", nearestHolidays: [] },
    inventoryHighlights: { summary: { lowCount: 0, outCount: 0, expiringCount: 0 }, expiringSoon: [], needToBuy: [] },
    brandBible: BRAND_BIBLE,
  };

  const real = buildMarketingRecommendations(context as unknown as Parameters<typeof buildMarketingRecommendations>[0]);
  const grounding = resolve({ recommendations: real });

  if (real.some((entry) => entry.recommendationType === "no_marketing_history")) {
    assert.equal(grounding.subjectSource, "assumed");
    assert.equal(grounding.subjectKind, "product");
  }
  assert.ok(grounding.subject.length > 0);
});
