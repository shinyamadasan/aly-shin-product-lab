import type { ContentJournalEntry, Ingredient, Product } from "./product-lab-types.ts";
import { getExpiringIngredients, getInventorySummaryCounts, getNeedToBuyList } from "./inventory-status.ts";

export type BrandBible = {
  mission: string;
  positioning: { current: string[]; future: string[] };
  targetAudience: string[];
  tone: string[];
  writingPrinciples: string[];
  prohibitedPatterns: string[];
};

export type PublishingHistoryEntry = {
  productId: string;
  productName: string;
  entryCount: number;
  lastCapturedDate: string;
  daysSinceLastCapture: number | null;
};

export type PublishingHistory = {
  basis: string;
  byProduct: PublishingHistoryEntry[];
  unassociatedEntryCount: number;
  lastUnassociatedCapturedDate: string | null;
  daysSinceLastUnassociatedCapture: number | null;
};

export type Holiday = { name: string; date: string; daysAway: number };

export type Season = {
  asOfDate: string;
  monthName: string;
  quarterLabel: string;
  nearestHolidays: Holiday[];
};

export type InventoryHighlights = {
  summary: ReturnType<typeof getInventorySummaryCounts>;
  expiringSoon: ReturnType<typeof getExpiringIngredients>;
  needToBuy: ReturnType<typeof getNeedToBuyList>;
};

export type MarketingAdvisorContextInput = {
  products: Product[];
  ingredients: Ingredient[];
  journal: ContentJournalEntry[];
  now: number; // epoch ms, mirrors RuleEngineContext.now's own convention
};

export type MarketingAdvisorContext = {
  version: 1;
  generatedAt: string;
  businessFacts: string;
  products: Product[];
  publishingHistory: PublishingHistory;
  currentGoals: { hasData: false; reason: string };
  promotions: { hasData: false; reason: string };
  season: Season;
  inventoryHighlights: InventoryHighlights;
  brandBible: BrandBible;
};

// Independent from src/services/ai/context.ts's BUSINESS_CONTEXT -- that constant is prompt text
// for the existing Copy-Prompt AI Advisor. This is business data for the Marketing Advisor's
// context contract, condensed from PRODUCT_LAB_CONTEXT.md as its own, separately maintained
// constant so the two features' wording can diverge without coordinating a shared edit.
const BUSINESS_FACTS =
  "Aly & Shin Product Lab is a private, home-based coffee and bakery business in the proving " +
  "stage -- pre-launch, not yet taking public preorders at scale. Bakery is the primary focus; " +
  "bottled coffee still needs freshness/cold-chain/margin proof before being treated as a hero " +
  "product. Recommendations must fit a single home kitchen at small-batch scale, not store or " +
  "multi-branch infrastructure.";

// Hand-condensed from docs/BRAND_BIBLE_V1.md, by section -- kept in sync by the [static] test in
// tests/marketing-advisor-context.test.ts. Not a live markdown parser: prose this unstructured
// (before/after copy examples, nested headings) is fragile to parse and the doc changes rarely.
export const BRAND_BIBLE: BrandBible = {
  mission: "To create consistently delicious coffee and baked goods that make everyday moments feel warmer, more meaningful, and worth sharing.",
  positioning: {
    current: ["Home-based", "Delivery-first", "Coffee", "Brownies", "Cookies"],
    future: ["Physical cafe", "Expanded menu", "Strong local community brand"],
  },
  targetAudience: ["Young professionals", "Remote workers", "Couples", "Families"],
  tone: ["Friendly", "Warm", "Simple", "Natural", "Never overly formal"],
  writingPrinciples: [
    "Keep language simple, warm, and natural -- never overly formal.",
    "Show real moments (a couple sharing dessert, someone on a coffee break) rather than just describing the product.",
    "Don't sell products. Sell moments.",
  ],
  prohibitedPatterns: ["Experience our handcrafted artisanal beverages", "Indulge in a luxurious dessert experience", "Buy our brownies"],
};

// Fixed-date holidays only -- deliberately excludes lunar/variable-date holidays (e.g. Chinese
// New Year, Easter) and any single-country assumption, since no doc in this repo confirms one.
const FIXED_DATE_HOLIDAYS: Array<{ name: string; month: number; day: number }> = [
  { name: "New Year's Day", month: 1, day: 1 },
  { name: "Valentine's Day", month: 2, day: 14 },
  { name: "Christmas Day", month: 12, day: 25 },
];

const QUARTER_BY_MONTH_INDEX = [1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 4];
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

function toDateOnly(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

function daysBetween(fromMs: number, toMs: number): number {
  return Math.round((toMs - fromMs) / MILLISECONDS_PER_DAY);
}

// Date-only values (Journal entryDate, fixed holiday dates) are always midnight UTC once parsed.
// `now` is a real timestamp and almost never lands on exact midnight -- comparing it directly
// against a date-only value misclassifies "today" as "yesterday" or "not yet arrived" depending
// on the time of day. Normalizing `now` to UTC start-of-day once, and anchoring every date-only
// comparison/day-difference to that anchor instead of the raw timestamp, makes "today" compare
// equal to "today" regardless of what time of day this function is called.
function startOfUtcDay(timestampMs: number): number {
  const date = new Date(timestampMs);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function mostRecentValidDate(dates: string[]): string {
  const valid = dates.filter((date) => Number.isFinite(Date.parse(date)));
  return valid.length > 0 ? valid.reduce((latest, date) => (Date.parse(date) > Date.parse(latest) ? date : latest)) : "";
}

function buildPublishingHistory(products: Product[], journal: ContentJournalEntry[], todayStart: number): PublishingHistory {
  const productIds = new Set(products.map((product) => product.id));
  const associatedEntries = journal.filter((entry) => entry.productId !== "" && productIds.has(entry.productId));
  const unassociatedEntries = journal.filter((entry) => entry.productId === "");

  const byProduct: PublishingHistoryEntry[] = products.map((product) => {
    const entries = associatedEntries.filter((entry) => entry.productId === product.id);
    const lastCapturedDate = mostRecentValidDate(entries.map((entry) => entry.entryDate));

    return {
      productId: product.id,
      productName: product.name,
      entryCount: entries.length,
      lastCapturedDate,
      daysSinceLastCapture: lastCapturedDate ? daysBetween(Date.parse(lastCapturedDate), todayStart) : null,
    };
  });

  const lastUnassociatedCapturedDate = mostRecentValidDate(unassociatedEntries.map((entry) => entry.entryDate)) || null;

  return {
    basis: "Based on Journal capture date (when an entry was recorded), not a real publish date -- no publish-status field exists anywhere in this schema yet.",
    byProduct,
    unassociatedEntryCount: unassociatedEntries.length,
    lastUnassociatedCapturedDate,
    daysSinceLastUnassociatedCapture: lastUnassociatedCapturedDate ? daysBetween(Date.parse(lastUnassociatedCapturedDate), todayStart) : null,
  };
}

function buildSeason(todayStart: number): Season {
  const date = new Date(todayStart);
  const year = date.getUTCFullYear();
  const monthIndex = date.getUTCMonth(); // 0-based

  const nearestHolidays: Holiday[] = FIXED_DATE_HOLIDAYS.map((holiday) => {
    const thisYear = Date.UTC(year, holiday.month - 1, holiday.day);
    const target = thisYear >= todayStart ? thisYear : Date.UTC(year + 1, holiday.month - 1, holiday.day);
    return { name: holiday.name, date: toDateOnly(target), daysAway: daysBetween(todayStart, target) };
  }).sort((a, b) => a.daysAway - b.daysAway);

  return {
    asOfDate: toDateOnly(todayStart),
    monthName: date.toLocaleString("en-US", { month: "long", timeZone: "UTC" }),
    quarterLabel: `Q${QUARTER_BY_MONTH_INDEX[monthIndex]} ${year}`,
    nearestHolidays,
  };
}

function buildInventoryHighlights(ingredients: Ingredient[], now: number): InventoryHighlights {
  const today = toDateOnly(now);
  return {
    summary: getInventorySummaryCounts(ingredients, today),
    expiringSoon: getExpiringIngredients(ingredients, today),
    needToBuy: getNeedToBuyList(ingredients),
  };
}

// Pure: same input always produces the same output. No Supabase client, no side effects --
// mirrors src/services/ai/context.ts's buildAdvisorInput's own discipline. Read-only for this
// milestone: currentGoals/promotions have no data source anywhere in Product Lab yet, so they
// ship as an explicit, honest absence rather than fabricated content.
export function buildMarketingAdvisorContext(input: MarketingAdvisorContextInput): MarketingAdvisorContext {
  // Normalized once, used only as the anchor for date-only comparisons (publishingHistory,
  // season). generatedAt deliberately keeps the raw input.now -- it records when this context
  // was actually generated, not a normalized calendar-day placeholder.
  const todayStart = startOfUtcDay(input.now);

  return {
    version: 1,
    generatedAt: new Date(input.now).toISOString(),
    businessFacts: BUSINESS_FACTS,
    products: input.products,
    publishingHistory: buildPublishingHistory(input.products, input.journal, todayStart),
    currentGoals: { hasData: false, reason: "No business goals data source exists yet in Product Lab." },
    promotions: { hasData: false, reason: "No promotions data source exists yet in Product Lab." },
    season: buildSeason(todayStart),
    inventoryHighlights: buildInventoryHighlights(input.ingredients, input.now),
    brandBible: BRAND_BIBLE,
  };
}
