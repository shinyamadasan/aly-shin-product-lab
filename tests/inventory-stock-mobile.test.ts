// Mobile Inventory + Bake Consolidation V1 -- Inventory Stock's mobile tree (Part B/C/D), including
// the Inventory Attention Amendment's union-based "Needs attention" grouping. Structural,
// source-scanning tests only (this repo's convention -- .tsx files are never rendered directly).
// The business math (getStockUrgencyStatus, getExpirationStatus, matchesStockFilter,
// groupIngredientsForMobileAttention itself) is proven in inventory-status.test.ts and is not
// re-derived here -- this file only proves the WIRING.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const code = (path: string) =>
  read(path)
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*") && !line.trim().startsWith("/*"))
    .join("\n");

const STOCK_TSX = "src/components/inventory-stock-page.tsx";

function sliceFunction(source: string, name: string): string {
  const at = source.indexOf(`function ${name}(`);
  assert.ok(at > -1, `precondition: function ${name} exists`);
  const end = source.indexOf("\nfunction ", at + 10);
  return end > -1 ? source.slice(at, end) : source.slice(at);
}

// --- isMobileWidth wiring, same shared hook bake-page.tsx also reuses ------------------------------

test("useIsMobileViewport is imported from @/components/ui and wired in InventoryStockPage, not a hand-rolled matchMedia copy", () => {
  const page = code(STOCK_TSX);
  assert.match(page, /import \{[^}]*useIsMobileViewport[^}]*\} from "@\/components\/ui"/);
  assert.match(sliceFunction(page, "InventoryStockPage"), /const isMobileWidth = useIsMobileViewport\(\);/);
  assert.equal(page.includes("window.matchMedia"), false);
});

// --- Part B1: hierarchy -- summary before the row sections ------------------------------------------

test("MobileInventoryStockView renders MobileInventoryStockSummary before the Needs attention and Everything else sections", () => {
  const view = sliceFunction(code(STOCK_TSX), "MobileInventoryStockView");
  const summaryAt = view.indexOf("<MobileInventoryStockSummary");
  const needsAttentionAt = view.indexOf("Needs attention");
  const everythingElseAt = view.indexOf("Everything else");
  assert.ok(summaryAt > -1 && needsAttentionAt > -1 && everythingElseAt > -1, "precondition: all three anchors exist");
  assert.equal(summaryAt < needsAttentionAt && needsAttentionAt < everythingElseAt, true, "summary must render first, then Needs attention, then Everything else");
});

test("the header, action buttons, and search/filter block are shared -- rendered once, not duplicated per branch", () => {
  const page = code(STOCK_TSX);
  for (const text of ["Record purchase", "Count / correct stock", "Search items..."]) {
    assert.equal((page.match(new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) ?? []).length, 1, `"${text}" must appear exactly once -- shared by both the mobile and desktop branches, not forked`);
  }
});

// --- Part B4: no duplicated per-row markup between desktop and mobile -------------------------------

test("InventoryStockPage branches only the row-list area on isMobileWidth; the desktop else-branch still renders the original 3-column header row unchanged", () => {
  const page = code(STOCK_TSX);
  const component = sliceFunction(page, "InventoryStockPage");
  assert.match(component, /isMobileWidth \? \(\s*<MobileInventoryStockView/);
  assert.match(component, /<div className="hidden border-b border-\[#eaded2\] bg-\[#fffaf3\] px-5 py-3 text-xs font-semibold uppercase tracking-\[0\.12em\] text-\[#9a5b2f\] sm:grid sm:grid-cols-\[minmax\(200px,1fr\)_140px_180px\] sm:gap-4">/, "desktop's column-header row must stay exactly as it was");
});

test("both the desktop and mobile row lists call the same IngredientStockRow component -- no forked per-row JSX", () => {
  const page = code(STOCK_TSX);
  const desktopCallSites = (sliceFunction(page, "InventoryStockPage").match(/<IngredientStockRow item=\{item\} key=\{item\.id\} labState=\{labState\} today=\{today\} \/>/g) ?? []).length;
  const mobileCallSites = (sliceFunction(page, "MobileInventoryStockView").match(/<IngredientStockRow item=\{item\} key=\{item\.id\} labState=\{labState\} today=\{today\} \/>/g) ?? []).length;
  assert.equal(desktopCallSites, 1);
  assert.equal(mobileCallSites, 2, "MobileInventoryStockView renders IngredientStockRow once for Needs attention and once for Everything else");

  const row = sliceFunction(page, "IngredientStockRow");
  assert.match(row, /sm:grid-cols-\[minmax\(200px,1fr\)_140px_180px\]/, "the row keeps its existing responsive grid, defined exactly once");
  assert.equal((page.match(/sm:grid-cols-\[minmax\(200px,1fr\)_140px_180px\] sm:items-center sm:gap-4/g) ?? []).length, 1, "the article's own grid classes exist exactly once in the file -- not duplicated between a desktop copy and a mobile copy");
});

// --- Inventory Attention Amendment: summary uses only the canonical union helpers -------------------

test("MobileInventoryStockSummary derives its counts only from getExpirationOrFlagAttentionCount/getStockUrgencySummaryCounts -- it never calls getExpirationStatus or Date.parse itself", () => {
  const summary = sliceFunction(code(STOCK_TSX), "MobileInventoryStockSummary");
  assert.match(summary, /getExpirationOrFlagAttentionCount\(allIngredients, today\)/);
  assert.match(summary, /getStockUrgencySummaryCounts\(allIngredients\)/);
  assert.equal(summary.includes("getExpirationStatus("), false, "the summary must not reimplement expiration checking -- it delegates to the union helper");
  assert.equal(summary.includes("Date.parse("), false);
});

test("the summary shows 'Other attention' first, using the danger tone, before the three urgency chips; Reorder Soon uses the warm tone, not danger", () => {
  const summary = sliceFunction(code(STOCK_TSX), "MobileInventoryStockSummary");
  const otherAt = summary.indexOf("Other attention");
  const outAt = summary.indexOf("Out of Stock");
  const criticalAt = summary.indexOf("Critical");
  const reorderAt = summary.indexOf("Reorder Soon");
  assert.ok(otherAt > -1 && outAt > -1 && criticalAt > -1 && reorderAt > -1, "precondition: all four chips exist");
  assert.equal(otherAt < outAt && outAt < criticalAt && criticalAt < reorderAt, true, "'Other attention' must render first so the strip never implies 'all clear' while an expiration/flag exception exists");
  assert.match(summary, /<Tag tone="danger">Other attention \{otherAttentionCount\}<\/Tag>/);
  assert.match(summary, /<Tag tone="warm">Reorder Soon \{urgencyCounts\.reorder_soon\}<\/Tag>/, "Reorder Soon keeps the warm (non-emergency) tone, unchanged from the row's own existing tone map");
});

// --- Inventory Attention Amendment: grouping delegates to the canonical helper, not a local sort ----

test("MobileInventoryStockView builds both sections from groupIngredientsForMobileAttention, never a new inline .sort/.filter reimplementing the grouping", () => {
  const page = code(STOCK_TSX);
  assert.match(page, /import \{[\s\S]*?groupIngredientsForMobileAttention[\s\S]*?\} from "@\/lib\/inventory-status"/);
  const view = sliceFunction(page, "MobileInventoryStockView");
  assert.match(view, /const groups = groupIngredientsForMobileAttention\(ingredients, today\);/);
  assert.match(view, /const needsAttention = \[\.\.\.groups\.expirationExceptions, \.\.\.groups\.stockUrgent, \.\.\.groups\.reorderSoon\];/);
  assert.equal(view.includes(".sort("), false, "must not introduce a second, competing sort implementation");
  assert.equal(view.includes("getStockUrgencyStatus("), false, "grouping/severity logic belongs in inventory-status.ts, not re-derived here");
});

// --- Part B3: filters are reused unchanged, not silently redefined ---------------------------------

test("the three existing filter-pill keys and labels are unchanged -- no new 'needs attention'/'good' pill was added", () => {
  const page = code(STOCK_TSX);
  assert.match(page, /\{ key: "all", label: "All" \}/);
  assert.match(page, /\{ key: "attention", label: "Low \/ Out" \}/);
  assert.match(page, /\{ key: "expiring", label: "Expiring" \}/);
  const filterArrayAt = page.indexOf("const stockViewFilters");
  const filterArrayEnd = page.indexOf("];", filterArrayAt) + 2;
  const filterArray = page.slice(filterArrayAt, filterArrayEnd);
  assert.equal((filterArray.match(/key: "/g) ?? []).length, 3, "exactly the three existing filter pills -- none added, none removed (the array's own type annotation's 'key: StockViewFilter' is excluded by requiring a quote after the colon)");
});

// --- Part C: no new page-level horizontal overflow in the new mobile branches -----------------------

test("no overflow-x-auto or fixed-width class was introduced inside MobileInventoryStockSummary/MobileInventoryStockView", () => {
  const page = code(STOCK_TSX);
  for (const name of ["MobileInventoryStockSummary", "MobileInventoryStockView"]) {
    const component = sliceFunction(page, name);
    assert.equal(component.includes("overflow-x-auto"), false, `${name} must not introduce a horizontal-scroll wrapper`);
    assert.equal(/\bw-\[\d+px\]/.test(component), false, `${name} must not use a fixed pixel-width container`);
  }
});
