import test from "node:test";
import assert from "node:assert/strict";
import {
  buildExpiringIngredientRecommendations,
  buildLaunchCandidateFollowUpRecommendations,
  buildMarketingRecommendations,
  buildNeglectedProductRecommendations,
  buildNoMarketingHistoryRecommendations,
  buildSeasonalOpportunityRecommendations,
  LAUNCH_FOLLOW_UP_STALE_DAYS,
  NEGLECTED_PRODUCT_STALE_DAYS,
  RECOMMENDATION_TYPES,
  SEASONAL_WINDOW_DAYS,
} from "../src/lib/marketing-recommendations.ts";
import { buildMarketingAdvisorContext, type MarketingAdvisorContext, type MarketingAdvisorContextInput } from "../src/lib/marketing-advisor-context.ts";
import type { ContentJournalEntry, Ingredient, Product } from "../src/lib/product-lab-types.ts";

const NOW = Date.parse("2026-07-30T00:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

function daysAgo(days: number): string {
  return new Date(NOW - days * DAY_MS).toISOString().slice(0, 10);
}

function product(overrides: Partial<Product> = {}): Product {
  return {
    id: "brownies",
    name: "Brownies",
    category: "Baked goods",
    role: "Hero candidate",
    status: "testing",
    description: "Dense fudgy brownies.",
    image: "",
    decision: "Needs proof",
    isPublic: false,
    ...overrides,
  };
}

function ingredient(overrides: Partial<Ingredient> = {}): Ingredient {
  return {
    id: "fresh-milk",
    name: "Fresh Milk",
    baseUnit: "ml",
    category: "",
    currentQuantity: 1000,
    lowStockThreshold: 200,
    targetStockQuantity: 2000,
    nearestExpirationDate: "",
    averageUnitCost: 0,
    notes: "",
    isActive: true,
    ...overrides,
  };
}

function journalEntry(overrides: Partial<ContentJournalEntry> = {}): ContentJournalEntry {
  return {
    id: "row-1",
    productId: "brownies",
    entryDate: "2026-07-01",
    whatWasMade: "Brownies V2 cooling test",
    mediaCaptured: "Texture close-up",
    lessonLearned: "Cooled too fast, cracked top",
    postIdeas: "behind the scenes",
    nextAction: "Reshoot with slower cooling",
    ...overrides,
  };
}

function context(overrides: Partial<MarketingAdvisorContextInput> = {}): MarketingAdvisorContext {
  return buildMarketingAdvisorContext({
    products: [],
    ingredients: [],
    journal: [],
    now: NOW,
    ...overrides,
  });
}

// ---- Rule 1: neglected products ----

test("buildNeglectedProductRecommendations fires at exactly the 30-day threshold, not one day earlier", () => {
  const stale = context({ products: [product()], journal: [journalEntry({ entryDate: daysAgo(NEGLECTED_PRODUCT_STALE_DAYS) })] });
  assert.equal(buildNeglectedProductRecommendations(stale).length, 1);

  const notYetStale = context({ products: [product()], journal: [journalEntry({ entryDate: daysAgo(NEGLECTED_PRODUCT_STALE_DAYS - 1) })] });
  assert.equal(buildNeglectedProductRecommendations(notYetStale).length, 0);
});

test("buildNeglectedProductRecommendations scales priority across the 30/60/90-day bands", () => {
  const at30 = context({ products: [product()], journal: [journalEntry({ entryDate: daysAgo(30) })] });
  const at60 = context({ products: [product()], journal: [journalEntry({ entryDate: daysAgo(60) })] });
  const at90 = context({ products: [product()], journal: [journalEntry({ entryDate: daysAgo(90) })] });

  assert.equal(buildNeglectedProductRecommendations(at30)[0].priority, 3);
  assert.equal(buildNeglectedProductRecommendations(at60)[0].priority, 4);
  assert.equal(buildNeglectedProductRecommendations(at90)[0].priority, 5);
});

test("buildNeglectedProductRecommendations never fires for a product with entryCount 0", () => {
  const noHistory = context({ products: [product()], journal: [] });
  assert.equal(buildNeglectedProductRecommendations(noHistory).length, 0);
});

test("buildNeglectedProductRecommendations never fires for a paused product", () => {
  const paused = context({ products: [product({ status: "paused" })], journal: [journalEntry({ entryDate: daysAgo(90) })] });
  assert.equal(buildNeglectedProductRecommendations(paused).length, 0);
});

test("buildNeglectedProductRecommendations sets confidence high and carries the expected evidence", () => {
  const stale = context({ products: [product()], journal: [journalEntry({ entryDate: daysAgo(30) })] });
  const [recommendation] = buildNeglectedProductRecommendations(stale);
  assert.equal(recommendation.confidence, "high");
  assert.equal(recommendation.recommendationType, "neglected_product");
  if (recommendation.recommendationType === "neglected_product") {
    assert.equal(recommendation.evidence.productId, "brownies");
    assert.equal(recommendation.evidence.daysSinceLastCapture, 30);
    assert.equal(recommendation.evidence.thresholdDays, NEGLECTED_PRODUCT_STALE_DAYS);
  }
});

// ---- Rule 2: no marketing history ----

test("buildNoMarketingHistoryRecommendations fires only for entryCount 0, regardless of daysSinceLastCapture", () => {
  const never = context({ products: [product()], journal: [] });
  assert.equal(buildNoMarketingHistoryRecommendations(never).length, 1);

  const hasHistory = context({ products: [product()], journal: [journalEntry({ entryDate: daysAgo(200) })] });
  assert.equal(buildNoMarketingHistoryRecommendations(hasHistory).length, 0);
});

test("buildNoMarketingHistoryRecommendations never fires for a paused product", () => {
  const paused = context({ products: [product({ status: "paused" })], journal: [] });
  assert.equal(buildNoMarketingHistoryRecommendations(paused).length, 0);
});

test("buildNoMarketingHistoryRecommendations and buildNeglectedProductRecommendations never both fire for the same product", () => {
  for (const entryDate of [daysAgo(30), daysAgo(90), daysAgo(1)]) {
    const withHistory = context({ products: [product()], journal: [journalEntry({ entryDate })] });
    const neglected = buildNeglectedProductRecommendations(withHistory);
    const noHistory = buildNoMarketingHistoryRecommendations(withHistory);
    assert.ok(!(neglected.length > 0 && noHistory.length > 0), `both rules fired for entryDate ${entryDate}`);
  }

  const never = context({ products: [product()], journal: [] });
  assert.equal(buildNeglectedProductRecommendations(never).length, 0);
  assert.equal(buildNoMarketingHistoryRecommendations(never).length, 1);
});

// ---- Rule 3: seasonal opportunities ----

test("buildSeasonalOpportunityRecommendations fires within the 21-day window and not at 22 days", () => {
  const within = context({ now: Date.parse("2026-12-04T00:00:00.000Z") }); // Christmas Day is 21 days away
  const christmasWithin = buildSeasonalOpportunityRecommendations(within).find((rec) => rec.recommendationType === "seasonal_opportunity" && rec.evidence.holidayName === "Christmas Day");
  assert.ok(christmasWithin, "expected Christmas Day to fire at exactly 21 days away");
  assert.equal(christmasWithin?.evidence && "daysAway" in christmasWithin.evidence ? christmasWithin.evidence.daysAway : undefined, 21);

  const outside = context({ now: Date.parse("2026-12-03T00:00:00.000Z") }); // Christmas Day is 22 days away
  const christmasOutside = buildSeasonalOpportunityRecommendations(outside).find((rec) => rec.recommendationType === "seasonal_opportunity" && rec.evidence.holidayName === "Christmas Day");
  assert.equal(christmasOutside, undefined);
});

test("buildSeasonalOpportunityRecommendations produces zero recommendations when the nearest holiday is far away", () => {
  const farFromAnyHoliday = context({ now: Date.parse("2026-03-01T00:00:00.000Z") });
  assert.equal(buildSeasonalOpportunityRecommendations(farFromAnyHoliday).length, 0);
});

test("buildSeasonalOpportunityRecommendations never names a specific product in its evidence", () => {
  const within = context({ now: Date.parse("2026-12-04T00:00:00.000Z") });
  for (const recommendation of buildSeasonalOpportunityRecommendations(within)) {
    assert.doesNotMatch(JSON.stringify(recommendation.evidence), /productId|productName/i);
  }
});

test("buildSeasonalOpportunityRecommendations scales priority with days away and stays within the threshold", () => {
  const soon = context({ now: Date.parse("2026-12-18T00:00:00.000Z") }); // Christmas 7 days away
  const [christmasSoon] = buildSeasonalOpportunityRecommendations(soon).filter((rec) => rec.recommendationType === "seasonal_opportunity" && rec.evidence.holidayName === "Christmas Day");
  assert.equal(christmasSoon.priority, 5);
  assert.equal(SEASONAL_WINDOW_DAYS, 21);
});

// ---- Rule 4: launch-candidate follow-up ----

test("buildLaunchCandidateFollowUpRecommendations fires for status launch_candidate with zero marketing history", () => {
  const ctx = context({ products: [product({ status: "launch_candidate", decision: "Needs proof" })], journal: [] });
  const [recommendation] = buildLaunchCandidateFollowUpRecommendations(ctx);
  assert.ok(recommendation);
  if (recommendation.recommendationType === "launch_candidate_follow_up") {
    assert.equal(recommendation.evidence.matchedOn, "status");
  }
});

test("buildLaunchCandidateFollowUpRecommendations fires for decision Candidate even when status is not launch_candidate", () => {
  const ctx = context({ products: [product({ status: "testing", decision: "Candidate" })], journal: [] });
  const [recommendation] = buildLaunchCandidateFollowUpRecommendations(ctx);
  assert.ok(recommendation);
  if (recommendation.recommendationType === "launch_candidate_follow_up") {
    assert.equal(recommendation.evidence.matchedOn, "decision");
  }
});

test("buildLaunchCandidateFollowUpRecommendations does not fire for a launch-candidate product with recent marketing activity", () => {
  const ctx = context({
    products: [product({ status: "launch_candidate", decision: "Needs proof" })],
    journal: [journalEntry({ entryDate: daysAgo(LAUNCH_FOLLOW_UP_STALE_DAYS - 1) })],
  });
  assert.equal(buildLaunchCandidateFollowUpRecommendations(ctx).length, 0);
});

test("buildLaunchCandidateFollowUpRecommendations does not fire for a paused product even if it matches decision Candidate", () => {
  const ctx = context({ products: [product({ status: "paused", decision: "Candidate" })], journal: [] });
  assert.equal(buildLaunchCandidateFollowUpRecommendations(ctx).length, 0);
});

test("buildLaunchCandidateFollowUpRecommendations always sets confidence to low", () => {
  const ctx = context({ products: [product({ status: "launch_candidate", decision: "Candidate" })], journal: [] });
  const [recommendation] = buildLaunchCandidateFollowUpRecommendations(ctx);
  assert.equal(recommendation.confidence, "low");
});

test("buildLaunchCandidateFollowUpRecommendations's evidence.basis states plainly that status/decision is not a real recency signal", () => {
  const ctx = context({ products: [product({ status: "launch_candidate" })], journal: [] });
  const [recommendation] = buildLaunchCandidateFollowUpRecommendations(ctx);
  if (recommendation.recommendationType === "launch_candidate_follow_up") {
    assert.match(recommendation.evidence.basis, /not a measured recency signal/i);
    assert.match(recommendation.evidence.basis, /no real launch-date field/i);
  }
});

// ---- Rule 5: expiring ingredients ----

test("buildExpiringIngredientRecommendations fires one recommendation per entry in inventoryHighlights.expiringSoon", () => {
  const ctx = context({
    ingredients: [ingredient({ id: "milk", nearestExpirationDate: daysAgo(-1) }), ingredient({ id: "flour", name: "Flour", nearestExpirationDate: daysAgo(-2) })],
  });
  assert.equal(ctx.inventoryHighlights.expiringSoon.length, 2);
  assert.equal(buildExpiringIngredientRecommendations(ctx).length, 2);
});

test("buildExpiringIngredientRecommendations never includes a productId or product name anywhere in its evidence", () => {
  const ctx = context({ ingredients: [ingredient({ nearestExpirationDate: daysAgo(-1) })] });
  const [recommendation] = buildExpiringIngredientRecommendations(ctx);
  assert.deepEqual(Object.keys(recommendation.evidence).sort(), ["basis", "expirationStatus", "ingredientId", "ingredientName", "nearestExpirationDate"]);
});

test("buildExpiringIngredientRecommendations ranks an expired ingredient above one merely expiring soon", () => {
  const ctx = context({
    ingredients: [ingredient({ id: "expired-milk", nearestExpirationDate: daysAgo(1) }), ingredient({ id: "soon-flour", name: "Flour", nearestExpirationDate: daysAgo(-2) })],
  });
  const recommendations = buildExpiringIngredientRecommendations(ctx);
  const expired = recommendations.find((rec) => rec.recommendationType === "expiring_ingredient" && rec.evidence.ingredientId === "expired-milk");
  const soon = recommendations.find((rec) => rec.recommendationType === "expiring_ingredient" && rec.evidence.ingredientId === "soon-flour");
  assert.ok(expired && soon);
  assert.ok(expired!.priority > soon!.priority);
});

// ---- Composition / ranking ----

test("buildMarketingRecommendations sorts strictly by priority descending", () => {
  const ctx = context({
    products: [product({ id: "brownies" }), product({ id: "cookies", name: "Cookies", status: "launch_candidate", decision: "Needs proof" })],
    journal: [journalEntry({ productId: "brownies", entryDate: daysAgo(90) })],
  });
  const recommendations = buildMarketingRecommendations(ctx);
  const priorities = recommendations.map((rec) => rec.priority);
  assert.deepEqual(
    [...priorities].sort((a, b) => b - a),
    priorities,
  );
});

test("buildMarketingRecommendations breaks priority ties by confidence, higher first", () => {
  const ctx = context({
    products: [product({ id: "brownies", status: "testing", decision: "Needs proof" }), product({ id: "cookies", name: "Cookies", status: "launch_candidate", decision: "Needs proof" })],
    journal: [journalEntry({ productId: "brownies", entryDate: daysAgo(30) })],
  });
  const recommendations = buildMarketingRecommendations(ctx);
  const neglected = recommendations.find((rec) => rec.recommendationType === "neglected_product");
  const followUp = recommendations.find((rec) => rec.recommendationType === "launch_candidate_follow_up");
  assert.ok(neglected && followUp);
  assert.equal(neglected!.priority, 3);
  assert.equal(followUp!.priority, 3);
  assert.ok(recommendations.indexOf(neglected!) < recommendations.indexOf(followUp!), "high-confidence recommendation should sort before the same-priority low-confidence one");
});

test("buildMarketingRecommendations breaks remaining ties by id, ascending", () => {
  const ctx = context({ products: [product({ id: "zzz-product", name: "ZZZ" }), product({ id: "aaa-product", name: "AAA" })], journal: [] });
  const recommendations = buildMarketingRecommendations(ctx).filter((rec) => rec.recommendationType === "no_marketing_history");
  assert.deepEqual(
    recommendations.map((rec) => rec.id),
    ["no_marketing_history:aaa-product", "no_marketing_history:zzz-product"],
  );
});

test("buildMarketingRecommendations produces the same recommendations and order regardless of the input products array's order", () => {
  const productA = product({ id: "brownies" });
  const productB = product({ id: "cookies", name: "Cookies" });
  const forward = buildMarketingRecommendations(context({ products: [productA, productB], journal: [] }));
  const reversed = buildMarketingRecommendations(context({ products: [productB, productA], journal: [] }));
  assert.deepEqual(forward, reversed);
});

// ---- Deferred-rule guard ----

test("buildMarketingRecommendations never produces a rating/quality-based recommendation", () => {
  const ctx = context({ products: [product()], journal: [journalEntry({ entryDate: daysAgo(90) })] });
  const recommendations = buildMarketingRecommendations(ctx);
  for (const recommendation of recommendations) {
    assert.ok(RECOMMENDATION_TYPES.includes(recommendation.recommendationType));
  }
  assert.doesNotMatch(JSON.stringify(recommendations), /rating/i);
});

// ---- Purity / determinism ----

test("buildMarketingRecommendations is pure: identical input produces deepEqual output on a second call", () => {
  const ctx = context({
    products: [product()],
    ingredients: [ingredient({ nearestExpirationDate: daysAgo(-1) })],
    journal: [journalEntry({ entryDate: daysAgo(30) })],
  });
  assert.deepEqual(buildMarketingRecommendations(ctx), buildMarketingRecommendations(ctx));
});

test("buildMarketingRecommendations does not mutate its input context", () => {
  const ctx = context({
    products: [product()],
    ingredients: [ingredient({ nearestExpirationDate: daysAgo(-1) })],
    journal: [journalEntry({ entryDate: daysAgo(30) })],
  });
  const before = JSON.parse(JSON.stringify(ctx));
  buildMarketingRecommendations(ctx);
  assert.deepEqual(ctx, before);
});

test("buildMarketingRecommendations returns an empty array for a quiet context", () => {
  const quiet = context({ products: [], ingredients: [], journal: [], now: Date.parse("2026-03-01T00:00:00.000Z") });
  assert.deepEqual(buildMarketingRecommendations(quiet), []);
});
