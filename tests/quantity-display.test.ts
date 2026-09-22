import test from "node:test";
import assert from "node:assert/strict";
import { formatQuantity } from "../src/lib/quantity-display.ts";
import { formatPesos, formatPesosPerUnit, formatPurchaseDate, getLatestPurchaseFacts } from "../src/lib/inventory-display.ts";
import { formatBakeBatchOption } from "../src/lib/bake-batch-option.ts";
import { getStockValueDisplay } from "../src/lib/inventory-cost.ts";
import { resolveInventoryFocus, resolveInventoryTab } from "../src/lib/inventory-tabs.ts";
import { matchesPurchaseSearch, purchaseGroupMatchesSearch } from "../src/lib/purchase-history.ts";
import type { Ingredient, SupplyEntry } from "../src/lib/product-lab-types.ts";

// --- quantity formatter -------------------------------------------------------------------------

test("mass: small kg values read as grams, large ones as kg", () => {
  assert.equal(formatQuantity(0.0047, "kg"), "4.7 g");
  assert.equal(formatQuantity(0.8953, "kg"), "895.3 g");
  assert.equal(formatQuantity(1.2, "kg"), "1.2 kg");
  assert.equal(formatQuantity(1200, "g"), "1.2 kg");
  assert.equal(formatQuantity(3862, "g"), "3.862 kg");
});

test("mass: grams stay grams and trailing zeroes are dropped", () => {
  assert.equal(formatQuantity(70, "g"), "70 g");
  assert.equal(formatQuantity(303, "g"), "303 g");
  assert.equal(formatQuantity(4.7, "g"), "4.7 g");
  assert.equal(formatQuantity(303.0, "g"), "303 g");
  assert.equal(formatQuantity(1000, "g"), "1 kg");
});

test("volume: sub-litre values read as ml, larger as L", () => {
  assert.equal(formatQuantity(0.25, "L"), "250 ml");
  assert.equal(formatQuantity(1.5, "L"), "1.5 L");
  assert.equal(formatQuantity(1500, "ml"), "1.5 L");
  assert.equal(formatQuantity(750, "ml"), "750 ml");
  assert.equal(formatQuantity(2, "cup"), "480 ml", "recipe measures use the app's own fixed factors");
});

test("counts and unknown units are shown as given", () => {
  assert.equal(formatQuantity(6, "pcs"), "6 pcs");
  assert.equal(formatQuantity(23, "pcs"), "23 pcs");
  assert.equal(formatQuantity(2.5, "box"), "2.5 box");
});

test("a non-zero quantity is never displayed as zero because of rounding", () => {
  for (const [quantity, unit] of [[0.0047, "kg"], [0.0004, "g"], [0.0000123, "kg"], [0.004, "L"], [0.001, "pcs"], [0.049, "g"]] as Array<[number, string]>) {
    const text = formatQuantity(quantity, unit);
    assert.notEqual(Number.parseFloat(text), 0, `${quantity} ${unit} -> ${text}`);
  }
  assert.equal(formatQuantity(0.0004, "g"), "0.0004 g");
  assert.equal(formatQuantity(0, "g"), "0 g");
  assert.equal(formatQuantity(0, "pcs"), "0 pcs");
});

test("negative quantities keep their sign", () => {
  assert.equal(formatQuantity(-34, "g"), "-34 g");
  assert.equal(formatQuantity(-1500, "g"), "-1.5 kg");
});

test("floating-point noise never leaks into the text", () => {
  assert.equal(formatQuantity(0.1 + 0.2, "kg"), "300 g");
  assert.equal(formatQuantity(0.0047 * 3, "kg"), "14.1 g");
  assert.doesNotMatch(formatQuantity(1 / 3, "kg"), /\d{5,}/);
  assert.equal(formatQuantity(Number.NaN, "g"), "--");
});

test("formatting reads a value and returns text -- it never mutates its input", () => {
  const stock = { currentQuantity: 0.0047, baseUnit: "kg" };
  const snapshot = JSON.stringify(stock);
  formatQuantity(stock.currentQuantity, stock.baseUnit);
  assert.equal(JSON.stringify(stock), snapshot);
});

// --- money / dates / latest purchase --------------------------------------------------------------

test("pesos keep two decimals for totals and up to four for unit prices", () => {
  assert.equal(formatPesos(19), "PHP 19.00");
  assert.equal(formatPesos(26.6), "PHP 26.60");
  assert.equal(formatPesosPerUnit(0.38, "g"), "PHP 0.38/g");
  assert.equal(formatPesosPerUnit(0.2714, "g"), "PHP 0.2714/g");
  assert.equal(formatPesosPerUnit(95, "kg"), "PHP 95.00/kg");
  assert.equal(formatPesosPerUnit(0.27142857, "g"), "PHP 0.2714/g");
});

test("purchase dates are read as UTC calendar dates, never shifted a day", () => {
  assert.equal(formatPurchaseDate("2026-09-17"), "Sep 17");
  assert.equal(formatPurchaseDate("2026-09-17", { year: true }), "Sep 17, 2026");
  assert.equal(formatPurchaseDate(""), "");
  assert.equal(formatPurchaseDate("not-a-date"), "");
});

function purchase(overrides: Partial<SupplyEntry> = {}): SupplyEntry {
  return {
    id: "p1", ingredientId: "i1", ingredientName: "Baking Powder", brandName: "Calumet", supplierName: "Ayala",
    purchaseDate: "2026-09-17", createdAt: "", packQuantity: 50, unit: "g", totalCost: 19, qualityRating: 0, notes: "", ...overrides,
  };
}

test("latest purchase facts carry the STORED total, with the unit price derived separately", () => {
  const facts = getLatestPurchaseFacts(purchase());
  assert.equal(facts.totalPaid, 19);
  assert.equal(facts.unitCost, 0.38);
  assert.equal(facts.packQuantity, 50);
  assert.equal(facts.brand, "Calumet");
  // The total is never re-multiplied from a rounded unit price.
  const awkward = getLatestPurchaseFacts(purchase({ packQuantity: 3, totalCost: 10 }));
  assert.equal(awkward.totalPaid, 10);
  assert.notEqual(awkward.unitCost, null);
  assert.equal(getLatestPurchaseFacts(purchase({ packQuantity: 0 })).unitCost, null);
});

// --- purchase search -----------------------------------------------------------------------------

test("purchase search matches Item name, brand, and supplier case-insensitively; empty matches all", () => {
  const p = purchase();
  assert.equal(matchesPurchaseSearch(p, "baking"), true);
  assert.equal(matchesPurchaseSearch(p, "CALUMET"), true);
  assert.equal(matchesPurchaseSearch(p, "ayala"), true);
  assert.equal(matchesPurchaseSearch(p, "flour"), false);
  assert.equal(matchesPurchaseSearch(p, "  "), true);
  assert.equal(matchesPurchaseSearch(p, "renamed", "Renamed Item"), true, "the linked Item's current name also matches");
});

test("a By Item group stays visible when its Item name, or any purchase's brand/supplier, matches", () => {
  const ingredient = { id: "i1", name: "Baking Powder" } as Ingredient;
  const group = { ingredient, purchases: [purchase(), purchase({ id: "p2", brandName: "Rumford", supplierName: "Landers" })] };
  assert.equal(purchaseGroupMatchesSearch(group, "powder"), true);
  assert.equal(purchaseGroupMatchesSearch(group, "rumford"), true);
  assert.equal(purchaseGroupMatchesSearch(group, "landers"), true);
  assert.equal(purchaseGroupMatchesSearch(group, "cocoa"), false);
  assert.equal(purchaseGroupMatchesSearch(group, ""), true);
});

// --- stock value trust rule -----------------------------------------------------------------------

test("an untrusted cost never yields a confident stock value; a trusted one does", () => {
  const untrusted = { currentQuantity: 70, averageUnitCost: 0.2714, costReconciledAt: null };
  assert.deepEqual(getStockValueDisplay(untrusted), { kind: "setup-needed" });
  assert.deepEqual(getStockValueDisplay({ currentQuantity: 70, averageUnitCost: 0, costReconciledAt: "2026-09-01" }), { kind: "setup-needed" });
  const trusted = getStockValueDisplay({ currentQuantity: 70, averageUnitCost: 0.38, costReconciledAt: "2026-09-01T00:00:00Z" });
  assert.equal(trusted.kind, "value");
  assert.equal(trusted.kind === "value" && Math.round(trusted.amount * 100) / 100, 26.6);
  assert.equal(trusted.kind === "value" && trusted.quantity, 70);
  assert.equal(trusted.kind === "value" && trusted.unitCost, 0.38);
});

// --- Bake batch option label ----------------------------------------------------------------------

test("a batch option identifies the batch on its own: product, version, pieces, date", () => {
  assert.equal(formatBakeBatchOption("Blondies", { batchVersion: "V3", usablePieces: 16, dateMade: "2026-09-10" }), "Blondies · V3 · 16 pcs · Sep 10, 2026");
  assert.equal(formatBakeBatchOption("Blondies", { batchVersion: "V3", usablePieces: 0, dateMade: "" }), "Blondies · V3");
  assert.equal(formatBakeBatchOption("Brownies", { batchVersion: "V1", usablePieces: 1, dateMade: "2026-01-02" }), "Brownies · V1 · 1 pc · Jan 2, 2026");
});

// --- cost focus query -----------------------------------------------------------------------------

test("focus=costs is recognised; anything else means no focus and never changes the tab", () => {
  assert.equal(resolveInventoryFocus("costs"), "costs");
  assert.equal(resolveInventoryFocus(["costs", "x"]), "costs");
  assert.equal(resolveInventoryFocus(undefined), undefined);
  assert.equal(resolveInventoryFocus("other"), undefined);
  assert.equal(resolveInventoryTab("ingredients"), "ingredients");
});
