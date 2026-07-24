import test from "node:test";
import assert from "node:assert/strict";
import { getExpirationStatus, getExpiringIngredients, getInventorySummaryCounts, getNeedToBuyList, getStockStatus, getSuggestedBuyQuantity } from "../src/lib/inventory-status.ts";
import type { Ingredient } from "../src/lib/product-lab-types.ts";

function ingredient(overrides: Partial<Ingredient> = {}): Ingredient {
  return {
    id: crypto.randomUUID(),
    name: "Fresh Milk",
    baseUnit: "ml",
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
