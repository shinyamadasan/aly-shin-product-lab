import test from "node:test";
import assert from "node:assert/strict";
import {
  formatProductionCoverage, getExpirationStatus, getExpiringIngredients, getFlaggedIngredients, getInventorySummaryCounts, getNeedToBuyList, getOneCycleRequirement,
  getProductionCyclesRemaining, getStockStatus, getStockUrgencyStatus, getSuggestedBuyQuantity, matchesStockFilter, matchesStockSearch,
} from "../src/lib/inventory-status.ts";
import type { Ingredient } from "../src/lib/product-lab-types.ts";

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

test("getStockStatus is 'out' when quantity is zero", () => {
  assert.equal(getStockStatus(ingredient({ currentQuantity: 0 })), "out");
});

test("getStockStatus is 'out' when quantity is negative", () => {
  assert.equal(getStockStatus(ingredient({ currentQuantity: -5 })), "out");
});

test("getStockStatus is 'low' when quantity equals the threshold (boundary is inclusive)", () => {
  assert.equal(getStockStatus(ingredient({ currentQuantity: 200, lowStockThreshold: 200 })), "low");
});

test("getStockStatus is 'low' when quantity is below the threshold", () => {
  assert.equal(getStockStatus(ingredient({ currentQuantity: 150, lowStockThreshold: 200 })), "low");
});

test("getStockStatus is 'good' when quantity is above the threshold", () => {
  assert.equal(getStockStatus(ingredient({ currentQuantity: 201, lowStockThreshold: 200 })), "good");
});

test("getSuggestedBuyQuantity is target minus current", () => {
  assert.equal(getSuggestedBuyQuantity(ingredient({ currentQuantity: 500, targetStockQuantity: 2000 })), 1500);
});

test("getSuggestedBuyQuantity never goes below zero when current already meets or exceeds target", () => {
  assert.equal(getSuggestedBuyQuantity(ingredient({ currentQuantity: 3000, targetStockQuantity: 2000 })), 0);
});

test("getNeedToBuyList excludes ingredients that are 'good'", () => {
  const good = ingredient({ id: "good", currentQuantity: 1000, lowStockThreshold: 200 });
  const low = ingredient({ id: "low", currentQuantity: 100, lowStockThreshold: 200 });

  const list = getNeedToBuyList([good, low]);

  assert.deepEqual(list.map((item) => item.id), ["low"]);
});

test("getNeedToBuyList lists out-of-stock ingredients before low-stock ones", () => {
  const low = ingredient({ id: "low", name: "Brown Sugar", currentQuantity: 100, lowStockThreshold: 200 });
  const out = ingredient({ id: "out", name: "Coffee Beans", currentQuantity: 0, lowStockThreshold: 200 });

  const list = getNeedToBuyList([low, out]);

  assert.deepEqual(list.map((item) => item.id), ["out", "low"]);
});

test("getNeedToBuyList excludes inactive ingredients", () => {
  const inactive = ingredient({ id: "inactive", currentQuantity: 0, isActive: false });

  assert.deepEqual(getNeedToBuyList([inactive]), []);
});

test("getNeedToBuyList attaches status and suggestedBuyQuantity to each entry", () => {
  const low = ingredient({ id: "low", currentQuantity: 100, lowStockThreshold: 200, targetStockQuantity: 1000 });

  const [entry] = getNeedToBuyList([low]);

  assert.equal(entry.status, "low");
  assert.equal(entry.suggestedBuyQuantity, 900);
});

const TODAY = "2026-07-24";

test("getExpirationStatus is 'none' when no expiration date is set", () => {
  assert.equal(getExpirationStatus("", TODAY), "none");
});

test("getExpirationStatus is 'expired' for a past date", () => {
  assert.equal(getExpirationStatus("2026-07-20", TODAY), "expired");
});

test("getExpirationStatus is 'expires-today' when the date is today", () => {
  assert.equal(getExpirationStatus("2026-07-24", TODAY), "expires-today");
});

test("getExpirationStatus is 'expires-soon' within the default 3-day window (boundary inclusive)", () => {
  assert.equal(getExpirationStatus("2026-07-27", TODAY), "expires-soon");
});

test("getExpirationStatus is 'good' just past the default 3-day window", () => {
  assert.equal(getExpirationStatus("2026-07-28", TODAY), "good");
});

test("getExpirationStatus respects a non-default expiresSoonDays window", () => {
  assert.equal(getExpirationStatus("2026-07-31", TODAY, 7), "expires-soon");
  assert.equal(getExpirationStatus("2026-07-31", TODAY, 3), "good");
});

test("getExpirationStatus treats an unparseable date as 'none', not a crash", () => {
  assert.equal(getExpirationStatus("not-a-date", TODAY), "none");
});

test("getExpiringIngredients includes expired, expires-today, and expires-soon, excludes good and none", () => {
  const expired = ingredient({ id: "expired", nearestExpirationDate: "2026-07-20" });
  const today = ingredient({ id: "today", nearestExpirationDate: "2026-07-24" });
  const soon = ingredient({ id: "soon", nearestExpirationDate: "2026-07-26" });
  const good = ingredient({ id: "good", nearestExpirationDate: "2026-08-15" });
  const none = ingredient({ id: "none", nearestExpirationDate: "" });

  const list = getExpiringIngredients([expired, today, soon, good, none], TODAY);

  assert.deepEqual(list.map((item) => item.id), ["expired", "today", "soon"]);
});

test("getExpiringIngredients sorts soonest expiration first", () => {
  const soon = ingredient({ id: "soon", nearestExpirationDate: "2026-07-26" });
  const expired = ingredient({ id: "expired", nearestExpirationDate: "2026-07-20" });
  const today = ingredient({ id: "today", nearestExpirationDate: "2026-07-24" });

  const list = getExpiringIngredients([soon, expired, today], TODAY);

  assert.deepEqual(list.map((item) => item.id), ["expired", "today", "soon"]);
});

test("getExpiringIngredients excludes inactive ingredients", () => {
  const inactive = ingredient({ id: "inactive", nearestExpirationDate: "2026-07-20", isActive: false });

  assert.deepEqual(getExpiringIngredients([inactive], TODAY), []);
});

test("getInventorySummaryCounts counts low, out, and expiring in one pass", () => {
  const low = ingredient({ id: "low", currentQuantity: 100, lowStockThreshold: 200 });
  const out = ingredient({ id: "out", currentQuantity: 0, lowStockThreshold: 200 });
  const good = ingredient({ id: "good", currentQuantity: 1000, lowStockThreshold: 200 });
  const expiringSoon = ingredient({ id: "expiring", currentQuantity: 1000, lowStockThreshold: 200, nearestExpirationDate: "2026-07-25" });

  const counts = getInventorySummaryCounts([low, out, good, expiringSoon], TODAY);

  assert.deepEqual(counts, { lowCount: 1, outCount: 1, expiringCount: 1 });
});

test("getInventorySummaryCounts respects a non-default expiresSoonDays window", () => {
  const farOut = ingredient({ id: "far", nearestExpirationDate: "2026-07-31" });

  assert.equal(getInventorySummaryCounts([farOut], TODAY, 3).expiringCount, 0);
  assert.equal(getInventorySummaryCounts([farOut], TODAY, 7).expiringCount, 1);
});

test("getInventorySummaryCounts excludes inactive ingredients from every count", () => {
  const inactive = ingredient({ id: "inactive", currentQuantity: 0, nearestExpirationDate: "2026-07-20", isActive: false });

  assert.deepEqual(getInventorySummaryCounts([inactive], TODAY), { lowCount: 0, outCount: 0, expiringCount: 0 });
});

// B.1/B.2: flagged ingredients are visibly identified; unflagged ones are not.
test("getFlaggedIngredients returns only ingredients with a base_unit_migration_flagged_reason set", () => {
  const flagged = ingredient({ id: "flagged", baseUnitMigrationFlaggedReason: "unrecognized_base_unit:oz" });
  const clean = ingredient({ id: "clean", baseUnitMigrationFlaggedReason: null });
  const neverTouched = ingredient({ id: "never-touched" });

  assert.deepEqual(getFlaggedIngredients([flagged, clean, neverTouched]).map((item) => item.id), ["flagged"]);
});

test("getFlaggedIngredients includes an archived ingredient's flag -- the NOT VALID constraint can still block a write to it", () => {
  const flaggedArchived = ingredient({ id: "flagged-archived", baseUnitMigrationFlaggedReason: "non_finite_numeric_field", isActive: false });

  assert.deepEqual(getFlaggedIngredients([flaggedArchived]).map((item) => item.id), ["flagged-archived"]);
});

// The daily Stock view's own filter -- Need to Buy folded into this as "attention" rather than
// staying a separate top-level tab.
test("matchesStockFilter 'all' matches everything regardless of status", () => {
  const good = ingredient({ id: "good", currentQuantity: 1000, lowStockThreshold: 200 });
  assert.equal(matchesStockFilter(good, "all", TODAY), true);
});

test("matchesStockFilter 'attention' matches low and out, excludes good", () => {
  const low = ingredient({ currentQuantity: 100, lowStockThreshold: 200 });
  const out = ingredient({ currentQuantity: 0, lowStockThreshold: 200 });
  const good = ingredient({ currentQuantity: 1000, lowStockThreshold: 200 });

  assert.equal(matchesStockFilter(low, "attention", TODAY), true);
  assert.equal(matchesStockFilter(out, "attention", TODAY), true);
  assert.equal(matchesStockFilter(good, "attention", TODAY), false);
});

test("matchesStockFilter 'expiring' matches expired/expires-today/expires-soon, excludes good and none", () => {
  const soon = ingredient({ nearestExpirationDate: "2026-07-26" });
  const none = ingredient({ nearestExpirationDate: "" });
  const farOut = ingredient({ nearestExpirationDate: "2026-08-15" });

  assert.equal(matchesStockFilter(soon, "expiring", TODAY), true);
  assert.equal(matchesStockFilter(none, "expiring", TODAY), false);
  assert.equal(matchesStockFilter(farOut, "expiring", TODAY), false);
});

test("matchesStockSearch is a case-insensitive substring match on name", () => {
  const item = ingredient({ name: "All Purpose Flour" });
  assert.equal(matchesStockSearch(item, "flour"), true);
  assert.equal(matchesStockSearch(item, "FLOUR"), true);
  assert.equal(matchesStockSearch(item, "sugar"), false);
});

test("matchesStockSearch treats an empty or whitespace-only query as matching everything", () => {
  const item = ingredient({ name: "All Purpose Flour" });
  assert.equal(matchesStockSearch(item, ""), true);
  assert.equal(matchesStockSearch(item, "   "), true);
});

// Inventory Stock Status V1: low_stock_threshold is configured as 2x one production cycle's
// requirement, so oneCycleRequirement = threshold / 2. All boundary cases below use the worked
// example from the spec: threshold 220 -> reorder at 220, critical at 110.

test("getOneCycleRequirement halves the threshold", () => {
  assert.equal(getOneCycleRequirement(220), 110);
});

test("getOneCycleRequirement is 0 when the threshold is 0 or negative", () => {
  assert.equal(getOneCycleRequirement(0), 0);
  assert.equal(getOneCycleRequirement(-5), 0);
});

test("getStockUrgencyStatus boundary conditions for threshold 220", () => {
  const at = (currentQuantity: number) => getStockUrgencyStatus(ingredient({ currentQuantity, lowStockThreshold: 220 }));
  assert.equal(at(221), "good");
  assert.equal(at(220), "reorder_soon");
  assert.equal(at(111), "reorder_soon");
  assert.equal(at(110), "critical");
  assert.equal(at(1), "critical");
  assert.equal(at(0), "out_of_stock");
});

test("getStockUrgencyStatus is 'out_of_stock' for negative quantity, same as zero", () => {
  assert.equal(getStockUrgencyStatus(ingredient({ currentQuantity: -5, lowStockThreshold: 220 })), "out_of_stock");
});

test("getStockUrgencyStatus is 'not_configured' when the threshold is 0, regardless of quantity -- never falsely 'good' or 'out_of_stock'", () => {
  assert.equal(getStockUrgencyStatus(ingredient({ currentQuantity: 0, lowStockThreshold: 0 })), "not_configured");
  assert.equal(getStockUrgencyStatus(ingredient({ currentQuantity: 500, lowStockThreshold: 0 })), "not_configured");
});

test("getStockUrgencyStatus handles decimal quantities and thresholds", () => {
  assert.equal(getStockUrgencyStatus(ingredient({ currentQuantity: 2.5, lowStockThreshold: 5 })), "critical");
  assert.equal(getStockUrgencyStatus(ingredient({ currentQuantity: 2.51, lowStockThreshold: 5 })), "reorder_soon");
  assert.equal(getStockUrgencyStatus(ingredient({ currentQuantity: 5.01, lowStockThreshold: 5 })), "good");
});

test("getProductionCyclesRemaining is current quantity divided by one cycle's requirement", () => {
  assert.equal(getProductionCyclesRemaining(ingredient({ currentQuantity: 1786, lowStockThreshold: 220 })), 1786 / 110);
  assert.equal(getProductionCyclesRemaining(ingredient({ currentQuantity: 198, lowStockThreshold: 220 })), 1.8);
});

test("getProductionCyclesRemaining is null when no threshold is configured -- never 0 or Infinity", () => {
  assert.equal(getProductionCyclesRemaining(ingredient({ currentQuantity: 500, lowStockThreshold: 0 })), null);
});

test("formatProductionCoverage renders a rounded '~N.N cycles' string", () => {
  assert.equal(formatProductionCoverage(1786 / 110), "~16.2 cycles");
  assert.equal(formatProductionCoverage(1.8), "~1.8 cycles");
});

test("formatProductionCoverage renders '<1 cycle' below one full cycle, not a rounded fraction", () => {
  assert.equal(formatProductionCoverage(0.95), "<1 cycle");
  assert.equal(formatProductionCoverage(0), "<1 cycle");
  assert.equal(formatProductionCoverage(-2), "<1 cycle");
});

test("formatProductionCoverage is '' (omit) when not configured", () => {
  assert.equal(formatProductionCoverage(null), "");
});
