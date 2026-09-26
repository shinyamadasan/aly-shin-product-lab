// Mobile Inventory + Bake Consolidation V1 -- Bake's mobile tree (Part A/C/D). Structural,
// source-scanning tests only (this repo's convention -- .tsx files are never rendered directly).
// The business math (deriveFinishedStockBalances, sortProductionHistory, isRealProduction,
// sortFinishedStockExceptionHistory, buildReconciliationPreview) is proven elsewhere and is not
// re-derived here -- this file only proves the WIRING: what Bake's mobile branches render, that
// they receive already-computed data rather than recomputing it, and that desktop (the >=lg
// branch) is untouched.

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

const BAKE_TSX = "src/components/bake-page.tsx";

function sliceFunction(source: string, name: string): string {
  const at = source.indexOf(`function ${name}(`);
  assert.ok(at > -1, `precondition: function ${name} exists`);
  const end = source.indexOf("\nfunction ", at + 10);
  return end > -1 ? source.slice(at, end) : source.slice(at);
}

// --- isMobileWidth wiring, same shared hook Dashboard/Orders' own copies already prove ------------

test("useIsMobileViewport is imported from @/components/ui, not a hand-rolled matchMedia copy", () => {
  const page = code(BAKE_TSX);
  assert.match(page, /import \{[^}]*useIsMobileViewport[^}]*\} from "@\/components\/ui"/);
  assert.equal(page.includes("window.matchMedia"), false, "bake-page.tsx must not hand-roll its own matchMedia listener -- it reuses the shared hook");
});

test("useIsMobileViewport is called in both FinishedStockPanel and FinishedStockReconciliationForm", () => {
  const page = code(BAKE_TSX);
  assert.match(sliceFunction(page, "FinishedStockPanel"), /const isMobileWidth = useIsMobileViewport\(\);/);
  assert.match(sliceFunction(page, "FinishedStockReconciliationForm"), /const isMobileWidth = useIsMobileViewport\(\);/);
});

// --- Part A2/A3/A6: table -> mobile card swap, desktop tables byte-for-byte unchanged --------------

test("Finished Stock: mobile branch renders MobileFinishedStockList with the exact balances array; desktop else-branch keeps the original <table> unchanged", () => {
  const panel = sliceFunction(code(BAKE_TSX), "FinishedStockPanel");
  assert.match(panel, /isMobileWidth \? \(\s*<MobileFinishedStockList balances=\{balances\} \/>/);
  assert.match(panel, /<th className="pb-2 pr-4">Product<\/th>\s*<th className="pb-2 pr-4 text-right">On hand<\/th>\s*<th className="pb-2 pr-4 text-right">Reserved<\/th>\s*<th className="pb-2 text-right">Available<\/th>/);
});

test("Production History: mobile branch renders MobileProductionHistory with the exact history/productName; desktop else-branch keeps the original 7-column <table> unchanged", () => {
  const panel = sliceFunction(code(BAKE_TSX), "FinishedStockPanel");
  assert.match(panel, /<MobileProductionHistory history=\{history\} productName=\{productName\} \/>/);
  assert.match(panel, /<th className="pb-2 pr-4">When<\/th>\s*<th className="pb-2 pr-4">Product<\/th>\s*<th className="pb-2 pr-4">Version<\/th>/);
  assert.match(panel, /isRealProduction\(execution\) \? execution\.batchVersionSnapshot : <Tag tone="warm">Opening balance \(estimated cost\)<\/Tag>/, "desktop's real-bake vs opening-balance cell is untouched");
});

test("Finished-stock exceptions: mobile branch renders MobileFinishedStockExceptions with the exact exceptionHistory/productName; desktop else-branch keeps the original 5-column <table> unchanged, and the shared intro paragraph is not duplicated per-branch", () => {
  const panel = sliceFunction(code(BAKE_TSX), "FinishedStockPanel");
  assert.match(panel, /<MobileFinishedStockExceptions exceptionHistory=\{exceptionHistory\} productName=\{productName\} \/>/);
  assert.match(panel, /<th className="pb-2 pr-4">When<\/th>\s*<th className="pb-2 pr-4">Product<\/th>\s*<th className="pb-2 pr-4">Type<\/th>/);
  assert.equal((panel.match(/Damage and giveaways always come from currently unreserved stock/g) ?? []).length, 1, "the intro sentence must render once, shared by both branches, not duplicated inside each");
});

// --- Part A5: advanced tools stay collapsed by default and in position -----------------------------

test("Advanced tools stay two native <details> with no open attribute, positioned after Production History and before Finished-stock exceptions", () => {
  const panel = sliceFunction(code(BAKE_TSX), "FinishedStockPanel");
  const historyAt = panel.indexOf("Production history");
  const stockCorrectionAt = panel.indexOf("Advanced: Stock correction");
  const reconcileAt = panel.indexOf("Advanced: Physical count / reconcile");
  const exceptionsAt = panel.indexOf("Finished-stock exceptions");
  assert.ok(historyAt > -1 && stockCorrectionAt > -1 && reconcileAt > -1 && exceptionsAt > -1, "precondition: all four sections exist");
  assert.equal(historyAt < stockCorrectionAt && stockCorrectionAt < exceptionsAt && reconcileAt < exceptionsAt, true, "hierarchy stays Bake -> Finished stock -> Production history -> Advanced tools -> Finished-stock exceptions");

  const detailsBlocks = panel.match(/<details className="mt-6">[\s\S]*?<\/details>/g) ?? [];
  assert.equal(detailsBlocks.length, 2, "precondition: exactly the two advanced-tools <details>");
  for (const block of detailsBlocks) {
    assert.equal(/<details[^>]*\bopen\b/.test(block), false, "advanced tools must stay collapsed by default");
  }
});

// --- Part A4: historical-cost notes, single source of copy, collapsed only on mobile ---------------

test("HistoricalCostNotes is a single component called bare on desktop and inside a closed-by-default <details> on mobile -- the three sentences are never duplicated as separate literal strings", () => {
  const page = code(BAKE_TSX);
  const notes = sliceFunction(page, "HistoricalCostNotes");
  assert.match(notes, /Actual<\/span> is the usable pieces the operator counted/);

  const panel = sliceFunction(page, "FinishedStockPanel");
  assert.match(panel, /<summary className="cursor-pointer text-xs font-semibold text-\[#9a5b2f\]">ⓘ About historical costs<\/summary>/);
  const mobileDetailsAt = panel.indexOf("ⓘ About historical costs");
  const detailsOpenTagAt = panel.lastIndexOf("<details", mobileDetailsAt);
  const detailsTag = panel.slice(detailsOpenTagAt, panel.indexOf(">", detailsOpenTagAt) + 1);
  assert.equal(/\bopen\b/.test(detailsTag), false, "the historical-cost disclosure must be collapsed by default on mobile");

  assert.equal((panel.match(/<HistoricalCostNotes \/>/g) ?? []).length, 2, "both the mobile (collapsed) and desktop (bare) branches call the same component, not a re-typed copy");
  assert.equal((page.match(/Raw cost was recorded from the ingredient costs used when this bake was posted/g) ?? []).length, 1, "the sentence exists exactly once in the source, inside HistoricalCostNotes only");
});

// --- Part D: mobile components receive already-computed data, never recompute it -------------------

test("MobileProductionHistory branches on the existing isRealProduction predicate, never a re-derived sourceType check", () => {
  const history = sliceFunction(code(BAKE_TSX), "MobileProductionHistory");
  assert.match(history, /isRealProduction\(execution\)/);
  assert.equal(history.includes('execution.sourceType === "bake"'), false, "must reuse isRealProduction, not re-derive it from sourceType inline");
});

test("mobile history/exception components import the shared paging helpers and never call sortProductionHistory(/sortFinishedStockExceptionHistory( themselves", () => {
  const page = code(BAKE_TSX);
  assert.match(page, /import \{[\s\S]*?expandMobileHistoryPage[\s\S]*?getMobileHistoryPage[\s\S]*?MOBILE_HISTORY_PAGE_SIZE[\s\S]*?\} from "@\/lib\/finished-stock"/);

  const history = sliceFunction(page, "MobileProductionHistory");
  const exceptions = sliceFunction(page, "MobileFinishedStockExceptions");
  for (const [name, component] of [["MobileProductionHistory", history], ["MobileFinishedStockExceptions", exceptions]] as const) {
    assert.match(component, /getMobileHistoryPage\(/, `${name} must page via the shared helper`);
    assert.equal(component.includes("sortProductionHistory("), false, `${name} must not re-sort/re-query production history`);
    assert.equal(component.includes("sortFinishedStockExceptionHistory("), false, `${name} must not re-sort/re-query exception history`);
  }
});

test("MobileReconciliationPreviewList receives previewRows as a prop, never recomputing buildReconciliationPreview itself", () => {
  const list = sliceFunction(code(BAKE_TSX), "MobileReconciliationPreviewList");
  assert.equal(list.includes("buildReconciliationPreview("), false);
  assert.equal(list.includes("buildOpeningBalanceCostEstimate("), false);
});

test("MobileFinishedStockList/MobileReconciliationCountInputs render only from their props, no getStockUrgencyStatus/cost math imported into any Mobile* component body", () => {
  const page = code(BAKE_TSX);
  for (const name of ["MobileFinishedStockList", "MobileProductionHistory", "MobileFinishedStockExceptions", "MobileReconciliationCountInputs", "MobileReconciliationPreviewList"]) {
    const component = sliceFunction(page, name);
    assert.equal(component.includes("getStockUrgencyStatus"), false, `${name} must not touch inventory-status logic`);
    assert.equal(component.includes("resolveBakeFormula"), false, `${name} must not touch bake-deduction logic`);
  }
});

// --- Part C: no new page-level horizontal overflow in the new mobile branches -----------------------

test("no new overflow-x-auto or fixed-width class was introduced inside any Mobile* component -- desktop's existing overflow-x-auto tables are untouched and out of scope for this check", () => {
  const page = code(BAKE_TSX);
  for (const name of ["MobileFinishedStockList", "MobileProductionHistory", "MobileFinishedStockExceptions", "MobileReconciliationCountInputs", "MobileReconciliationPreviewList"]) {
    const component = sliceFunction(page, name);
    assert.equal(component.includes("overflow-x-auto"), false, `${name} must not introduce a horizontal-scroll wrapper`);
    assert.equal(/\bw-\[\d+px\]/.test(component), false, `${name} must not use a fixed pixel-width container`);
    assert.equal(/min-w-\[\d{3,}px\]/.test(component), false, `${name} must not use a large fixed min-width container`);
  }
});
