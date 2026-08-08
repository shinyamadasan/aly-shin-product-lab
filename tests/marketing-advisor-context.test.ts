import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildMarketingAdvisorContext, type MarketingAdvisorContextInput } from "../src/lib/marketing-advisor-context.ts";
import { getExpiringIngredients, getInventorySummaryCounts, getNeedToBuyList } from "../src/lib/inventory-status.ts";
import type { ContentJournalEntry, Ingredient, Product } from "../src/lib/product-lab-types.ts";

const NOW = Date.parse("2026-07-30T00:00:00.000Z");
// Same UTC calendar date as NOW, but with a non-midnight time-of-day -- regression coverage for
// the "date-only value vs. now-with-time-of-day" comparison bug (see startOfUtcDay's comment).
const NOW_AFTERNOON = Date.parse("2026-07-30T15:00:00.000Z");

function product(overrides: Partial<Product> = {}): Product {
  return {
    id: "brownies",
    name: "Brownies",
    category: "Baked goods",
    role: "Hero candidate",
    status: "launch_candidate",
    description: "Dense fudgy brownies.",
    image: "",
    decision: "Candidate",
    isPublic: false,
    ...overrides,
  };
}

function ingredient(overrides: Partial<Ingredient> = {}): Ingredient {
  return {
    id: crypto.randomUUID(),
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
    entryDate: "2026-07-20",
    whatWasMade: "Brownies V2 cooling test",
    mediaCaptured: "Texture close-up",
    lessonLearned: "Cooled too fast, cracked top",
    postIdeas: "behind the scenes",
    nextAction: "Reshoot with slower cooling",
    ...overrides,
  };
}

function baseInput(overrides: Partial<MarketingAdvisorContextInput> = {}): MarketingAdvisorContextInput {
  return {
    products: [product()],
    ingredients: [],
    journal: [],
    now: NOW,
    ...overrides,
  };
}

test("buildMarketingAdvisorContext sets version 1", () => {
  const context = buildMarketingAdvisorContext(baseInput());
  assert.equal(context.version, 1);
});

test("buildMarketingAdvisorContext sets generatedAt from the given clock", () => {
  const context = buildMarketingAdvisorContext(baseInput());
  assert.equal(context.generatedAt, new Date(NOW).toISOString());
});

test("buildMarketingAdvisorContext passes products through unchanged", () => {
  const products = [product({ id: "cookies", name: "Cookies" })];
  const context = buildMarketingAdvisorContext(baseInput({ products }));
  assert.deepEqual(context.products, products);
});

test("buildMarketingAdvisorContext is pure: identical input produces deepEqual output on a second call", () => {
  const input = baseInput({ products: [product(), product({ id: "cookies", name: "Cookies" })], ingredients: [ingredient()], journal: [journalEntry()] });
  const first = buildMarketingAdvisorContext(input);
  const second = buildMarketingAdvisorContext(input);
  assert.deepEqual(first, second);
});

test("buildMarketingAdvisorContext does not mutate its input arrays", () => {
  const products = [product()];
  const ingredients = [ingredient()];
  const journal = [journalEntry()];
  const productsCopy = JSON.parse(JSON.stringify(products));
  const ingredientsCopy = JSON.parse(JSON.stringify(ingredients));
  const journalCopy = JSON.parse(JSON.stringify(journal));

  buildMarketingAdvisorContext({ products, ingredients, journal, now: NOW });

  assert.deepEqual(products, productsCopy);
  assert.deepEqual(ingredients, ingredientsCopy);
  assert.deepEqual(journal, journalCopy);
});

test("publishingHistory includes a product with zero journal entries", () => {
  const context = buildMarketingAdvisorContext(baseInput({ products: [product({ id: "cookies", name: "Cookies" })], journal: [] }));
  assert.deepEqual(context.publishingHistory.byProduct, [
    { productId: "cookies", productName: "Cookies", entryCount: 0, lastCapturedDate: "", daysSinceLastCapture: null },
  ]);
});

test("publishingHistory picks the most recent entryDate when a product has multiple entries", () => {
  const context = buildMarketingAdvisorContext(
    baseInput({
      journal: [journalEntry({ id: "j1", entryDate: "2026-07-01" }), journalEntry({ id: "j2", entryDate: "2026-07-20" })],
    }),
  );
  const brownies = context.publishingHistory.byProduct.find((entry) => entry.productId === "brownies");
  assert.equal(brownies?.entryCount, 2);
  assert.equal(brownies?.lastCapturedDate, "2026-07-20");
  assert.equal(brownies?.daysSinceLastCapture, 10);
});

test("publishingHistory reports daysSinceLastCapture 0 for a product-linked entry captured on the same UTC calendar date as now, even when now has a time-of-day", () => {
  const context = buildMarketingAdvisorContext(
    baseInput({
      now: NOW_AFTERNOON,
      journal: [journalEntry({ id: "j1", entryDate: "2026-07-30" })],
    }),
  );
  const brownies = context.publishingHistory.byProduct.find((entry) => entry.productId === "brownies");
  assert.equal(brownies?.daysSinceLastCapture, 0);
});

test("publishingHistory reports daysSinceLastUnassociatedCapture 0 for an unassociated entry captured on the same UTC calendar date as now", () => {
  const context = buildMarketingAdvisorContext(
    baseInput({
      now: NOW_AFTERNOON,
      journal: [journalEntry({ id: "j1", productId: "", entryDate: "2026-07-30" })],
    }),
  );
  assert.equal(context.publishingHistory.daysSinceLastUnassociatedCapture, 0);
});

test("publishingHistory excludes an unparsable entryDate from 'most recent' without throwing, but still counts the entry", () => {
  const context = buildMarketingAdvisorContext(
    baseInput({
      journal: [journalEntry({ id: "j1", entryDate: "2026-07-20" }), journalEntry({ id: "j2", entryDate: "not-a-date" })],
    }),
  );
  const brownies = context.publishingHistory.byProduct.find((entry) => entry.productId === "brownies");
  assert.equal(brownies?.entryCount, 2);
  assert.equal(brownies?.lastCapturedDate, "2026-07-20");
});

test("publishingHistory drops an entry referencing a product not in the given catalog, without counting it as unassociated", () => {
  const context = buildMarketingAdvisorContext(
    baseInput({
      journal: [journalEntry({ id: "j1", productId: "ghost-product", entryDate: "2026-07-29" })],
    }),
  );
  assert.equal(context.publishingHistory.byProduct.length, 1);
  assert.equal(context.publishingHistory.byProduct[0].entryCount, 0);
  assert.equal(context.publishingHistory.unassociatedEntryCount, 0);
});

test("publishingHistory tracks unassociated entries (no productId) separately from per-product entries", () => {
  const context = buildMarketingAdvisorContext(
    baseInput({
      journal: [journalEntry({ id: "j1", productId: "", entryDate: "2026-07-25" })],
    }),
  );
  assert.equal(context.publishingHistory.unassociatedEntryCount, 1);
  assert.equal(context.publishingHistory.lastUnassociatedCapturedDate, "2026-07-25");
  assert.equal(context.publishingHistory.daysSinceLastUnassociatedCapture, 5);
});

test("publishingHistory.basis explicitly names capture date, not publish date", () => {
  const context = buildMarketingAdvisorContext(baseInput());
  assert.match(context.publishingHistory.basis, /capture date/i);
  assert.match(context.publishingHistory.basis, /not a real publish date/i);
});

test("currentGoals ships as an explicit absence, never fabricated content", () => {
  const context = buildMarketingAdvisorContext(baseInput());
  assert.equal(context.currentGoals.hasData, false);
  assert.ok(context.currentGoals.reason.length > 0);
});

test("promotions ships as an explicit absence, never fabricated content", () => {
  const context = buildMarketingAdvisorContext(baseInput());
  assert.equal(context.promotions.hasData, false);
  assert.ok(context.promotions.reason.length > 0);
});

test("season reports the correct month and quarter for a known fixed date", () => {
  const context = buildMarketingAdvisorContext(baseInput({ now: Date.parse("2026-07-30T00:00:00.000Z") }));
  assert.equal(context.season.asOfDate, "2026-07-30");
  assert.equal(context.season.monthName, "July");
  assert.equal(context.season.quarterLabel, "Q3 2026");
});

test("season.nearestHolidays is sorted ascending by daysAway and never negative", () => {
  const context = buildMarketingAdvisorContext(baseInput());
  const daysAway = context.season.nearestHolidays.map((holiday) => holiday.daysAway);
  assert.deepEqual(
    [...daysAway].sort((a, b) => a - b),
    daysAway,
  );
  for (const value of daysAway) {
    assert.ok(value >= 0, `expected non-negative daysAway, got ${value}`);
  }
});

test("season.nearestHolidays rolls a just-passed fixed-date holiday over to next year", () => {
  const context = buildMarketingAdvisorContext(baseInput({ now: Date.parse("2026-12-26T00:00:00.000Z") }));
  const christmas = context.season.nearestHolidays.find((holiday) => holiday.name === "Christmas Day");
  assert.equal(christmas?.date, "2027-12-25");
});

test("season reports Christmas Day as today (daysAway 0, current-year date) when now is Christmas Day at a non-midnight UTC time", () => {
  const context = buildMarketingAdvisorContext(baseInput({ now: Date.parse("2026-12-25T15:00:00.000Z") }));
  const christmas = context.season.nearestHolidays.find((holiday) => holiday.name === "Christmas Day");
  assert.equal(christmas?.date, "2026-12-25");
  assert.equal(christmas?.daysAway, 0);
});

test("season still rolls a holiday that passed yesterday to next year at a non-midnight now, and keeps nearestHolidays ordered correctly", () => {
  const context = buildMarketingAdvisorContext(baseInput({ now: Date.parse("2026-12-26T15:00:00.000Z") }));
  const christmas = context.season.nearestHolidays.find((holiday) => holiday.name === "Christmas Day");
  assert.equal(christmas?.date, "2027-12-25");
  assert.ok((christmas?.daysAway ?? -1) > 0);
  const daysAway = context.season.nearestHolidays.map((holiday) => holiday.daysAway);
  assert.deepEqual(
    [...daysAway].sort((a, b) => a - b),
    daysAway,
  );
});

test("generatedAt retains the full input timestamp, not normalized to midnight", () => {
  const context = buildMarketingAdvisorContext(baseInput({ now: NOW_AFTERNOON }));
  assert.equal(context.generatedAt, new Date(NOW_AFTERNOON).toISOString());
  assert.notEqual(context.generatedAt, "2026-07-30T00:00:00.000Z");
});

test("inventoryHighlights.summary matches getInventorySummaryCounts called directly on the same fixtures", () => {
  const ingredients = [ingredient({ currentQuantity: 0 }), ingredient({ id: crypto.randomUUID(), currentQuantity: 5000 })];
  const context = buildMarketingAdvisorContext(baseInput({ ingredients }));
  assert.deepEqual(context.inventoryHighlights.summary, getInventorySummaryCounts(ingredients, "2026-07-30"));
});

test("inventoryHighlights.expiringSoon matches getExpiringIngredients called directly on the same fixtures", () => {
  const ingredients = [ingredient({ nearestExpirationDate: "2026-07-31" })];
  const context = buildMarketingAdvisorContext(baseInput({ ingredients }));
  assert.deepEqual(context.inventoryHighlights.expiringSoon, getExpiringIngredients(ingredients, "2026-07-30"));
});

test("inventoryHighlights.needToBuy matches getNeedToBuyList called directly on the same fixtures", () => {
  const ingredients = [ingredient({ currentQuantity: 10, lowStockThreshold: 200 })];
  const context = buildMarketingAdvisorContext(baseInput({ ingredients }));
  assert.deepEqual(context.inventoryHighlights.needToBuy, getNeedToBuyList(ingredients));
});

test("brandBible carries the real mission, positioning, target audience, and tone", () => {
  const context = buildMarketingAdvisorContext(baseInput());
  assert.match(context.brandBible.mission, /consistently delicious coffee and baked goods/i);
  assert.deepEqual(context.brandBible.positioning.current, ["Home-based", "Delivery-first", "Coffee", "Brownies", "Cookies"]);
  assert.deepEqual(context.brandBible.positioning.future, ["Physical cafe", "Expanded menu", "Strong local community brand"]);
  assert.ok(context.brandBible.targetAudience.includes("Young professionals"));
  assert.ok(context.brandBible.tone.includes("Warm"));
  assert.ok(context.brandBible.tone.includes("Friendly"));
});

test("brandBible.writingPrinciples and prohibitedPatterns reflect the doc's own guidance", () => {
  const context = buildMarketingAdvisorContext(baseInput());
  assert.ok(context.brandBible.writingPrinciples.some((principle) => /sell moments/i.test(principle)));
  assert.ok(context.brandBible.prohibitedPatterns.includes("Buy our brownies"));
  assert.ok(context.brandBible.prohibitedPatterns.includes("Experience our handcrafted artisanal beverages"));
});

test("[static] brandBible's condensed content stays a real substring of docs/BRAND_BIBLE_V1.md", () => {
  const doc = readFileSync(new URL("../docs/BRAND_BIBLE_V1.md", import.meta.url), "utf8");
  const context = buildMarketingAdvisorContext(baseInput());

  assert.ok(doc.includes(context.brandBible.mission), "mission text drifted from docs/BRAND_BIBLE_V1.md");
  for (const item of [...context.brandBible.positioning.current, ...context.brandBible.positioning.future]) {
    assert.ok(doc.includes(item), `positioning item "${item}" is not in docs/BRAND_BIBLE_V1.md`);
  }
  for (const item of context.brandBible.targetAudience) {
    assert.ok(doc.includes(item), `target audience item "${item}" is not in docs/BRAND_BIBLE_V1.md`);
  }
  for (const item of context.brandBible.tone) {
    assert.ok(doc.includes(item), `tone item "${item}" is not in docs/BRAND_BIBLE_V1.md`);
  }
  for (const item of context.brandBible.prohibitedPatterns) {
    assert.ok(doc.includes(item), `prohibited pattern "${item}" is not in docs/BRAND_BIBLE_V1.md`);
  }
});
