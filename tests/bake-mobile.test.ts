// Mobile Inventory + Bake Consolidation V1, extended by Mobile Bake Final Simplification.
// Structural, source-scanning tests only (this repo's convention -- .tsx files are never rendered
// directly). The business math (deriveFinishedStockBalances, sortProductionHistory, isRealProduction,
// sortFinishedStockExceptionHistory, resolveBakeFormula, getInsufficientDeductions, readyToConfirm's
// own guard conditions) is proven elsewhere and is not re-derived here -- this file only proves the
// WIRING: what Bake's mobile branches render, in what state (collapsed/quiet), that they receive
// already-computed data rather than recomputing it, and that desktop (>=lg) is untouched.

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

// BakePage nests two named function declarations of its own (handleAssign, handleConfirm) before
// its return JSX, so the generic "next \nfunction " scan above would truncate BakePage's slice at
// the FIRST of those instead of at its true sibling, FinishedStockPanel. Sliced explicitly instead.
function sliceBakePage(source: string): string {
  const at = source.indexOf("function BakePage(");
  const end = source.indexOf("function FinishedStockPanel(");
  assert.ok(at > -1 && end > at, "precondition: BakePage exists and precedes FinishedStockPanel");
  return source.slice(at, end);
}

// --- Preflight guard trace: blocking/override logic is untouched -----------------------------------

test("readyToConfirm's guard conditions are byte-identical to before this task -- fullyResolved, isMultiplierValid, isActualPiecesValid, the insufficient-stock/override term, the uncertified-cost term, and the voided-batch term all still gate Confirm Bake", () => {
  const bakePage = sliceBakePage(code(BAKE_TSX));
  assert.match(bakePage, /const readyToConfirm = fullyResolved && isMultiplierValid && isActualPiecesValid && deductions\.length > 0/);
  assert.match(bakePage, /&& \(\(canOverrideNegative && allowNegative\) \|\| insufficient\.length === 0\)/);
  assert.match(bakePage, /&& \(!remotePosting \|\| uncertifiedCostIngredientNames\.length === 0\)/);
  assert.match(bakePage, /&& !\(selectedBatch && isVoidedBatch\(selectedBatch\)\)/);
  assert.match(bakePage, /disabled=\{!readyToConfirm \|\| isConfirming\}/, "the Confirm Bake button's disabled attribute must still be driven by readyToConfirm");
});

test("the existing local-only override checkbox and the 'no override for a posted Bake' message are unchanged -- no new override path was created", () => {
  const bakePage = sliceBakePage(code(BAKE_TSX));
  assert.match(bakePage, /Allow negative stock and bake anyway/);
  assert.match(bakePage, /insufficient\.length > 0 && canOverrideNegative/);
  assert.match(bakePage, /Insufficient stock blocks this Bake -- there is no override for a posted Bake\./);
  assert.match(bakePage, /insufficient\.length > 0 && !canOverrideNegative/);
});

test("mobileBakeIssues is a reformatting of the existing resolved/insufficient/uncertifiedCostIngredientNames values -- no new validation function is called to build it", () => {
  const bakePage = sliceBakePage(code(BAKE_TSX));
  const issuesAt = bakePage.indexOf("const mobileBakeIssues");
  const issuesEnd = bakePage.indexOf("\n\n", issuesAt);
  const issuesBlock = bakePage.slice(issuesAt, issuesEnd);
  assert.match(issuesBlock, /resolved\s*\n\s*\.filter\(\(row\) => !row\.ingredientId \|\| row\.convertedQuantity === null\)/);
  assert.match(issuesBlock, /\.\.\.insufficient\.map\(/);
  assert.match(issuesBlock, /uncertifiedCostIngredientNames\.length > 0/);
  assert.equal(/getStockUrgencyStatus|resolveBakeFormula\(|getInsufficientDeductions\(/.test(issuesBlock), false, "must reuse the already-computed resolved/insufficient arrays, never re-derive them");
});

// --- Part 4A/4B: happy path is quiet, failure path stays visible, desktop unchanged -----------------

test("the full Preflight card and the happy-path 'View ingredient mapping' disclosure are both gated behind !isMobileWidth -- neither renders on mobile regardless of pass/fail state", () => {
  const bakePage = sliceBakePage(code(BAKE_TSX));
  assert.match(bakePage, /\{selectedBatch && !isMobileWidth \? \(\s*<div className="mt-5 rounded-md border border-\[#eaded2\] p-4">\s*<p className="text-xs font-semibold uppercase tracking-\[0\.16em\] text-\[#9a5b2f\]">Preflight<\/p>/);
  assert.match(bakePage, /\{selectedBatch && fullyResolved && !isMobileWidth \? \(\s*<details className="mt-3">\s*<summary className="cursor-pointer text-sm font-semibold text-\[#8f5632\]">View ingredient mapping/);
});

test("the compact mobile issues panel only renders on mobile, and only when mobileBakeIssues is non-empty -- the happy path renders nothing here", () => {
  const bakePage = sliceBakePage(code(BAKE_TSX));
  assert.match(bakePage, /\{isMobileWidth && mobileBakeIssues\.length > 0 \? \(/);
  assert.match(bakePage, /Can&apos;t confirm bake/);
  const panelAt = bakePage.indexOf("Can&apos;t confirm bake");
  const confirmButtonAt = bakePage.indexOf('type="button"\n          >\n            {isConfirming ? "Confirming..." : insufficient.length > 0 && allowNegative ? "Confirm bake (override)" : "Confirm bake"}');
  assert.ok(panelAt > -1 && confirmButtonAt > -1, "precondition: both anchors exist");
  assert.equal(panelAt < confirmButtonAt, true, "the issues panel must sit before the Confirm Bake button, per the 'immediately before Confirm Bake' requirement");
});

test("the unmapped-ingredient picker table and the ingredient-deductions disclosure remain unconditional on viewport -- they already only appear automatically when there's a real problem, so mobile needs no extra gating there", () => {
  const bakePage = sliceBakePage(code(BAKE_TSX));
  assert.match(bakePage, /\{selectedBatch && !fullyResolved \? \(\s*<div className="mt-3 divide-y divide-\[#f0e4d8\] rounded-md border border-\[#eaded2\]">/);
  assert.equal(/\{selectedBatch && !fullyResolved && !isMobileWidth/.test(bakePage), false, "the actionable mapping table must not be hidden on mobile -- it's the fix-it UI, not decoration");
  assert.match(bakePage, /\{deductions\.length > 0 \? \(\s*<details className="mt-3" open=\{insufficient\.length > 0\}>/);
});

// --- Part 1/2: Finished Stock is gone from mobile, present on desktop unchanged --------------------

test("FinishedStockPanel's mobile branch (isMobileWidth true) never renders 'Baked pieces on hand' or a Finished Stock table -- balances is still computed but not displayed as its own section", () => {
  const page = code(BAKE_TSX);
  const panel = sliceFunction(page, "FinishedStockPanel");
  const mobileBranchAt = panel.indexOf("if (isMobileWidth) {");
  const mobileBranchEnd = panel.indexOf("\n  return (", mobileBranchAt);
  assert.ok(mobileBranchAt > -1 && mobileBranchEnd > mobileBranchAt, "precondition: the mobile early-return branch exists and precedes the desktop return");
  const mobileBranch = panel.slice(mobileBranchAt, mobileBranchEnd);
  assert.equal(mobileBranch.includes("Baked pieces on hand"), false);
  assert.equal(mobileBranch.includes("Finished stock"), false);
  assert.equal(mobileBranch.includes("<table"), false, "mobile must not render any table, including a Finished Stock one");
});

test("the desktop branch (after the isMobileWidth early return) still renders 'Baked pieces on hand' and the Finished Stock <table>, unchanged", () => {
  const page = code(BAKE_TSX);
  const panel = sliceFunction(page, "FinishedStockPanel");
  const desktopBranchAt = panel.indexOf("\n  return (", panel.indexOf("if (isMobileWidth) {"));
  const desktopBranch = panel.slice(desktopBranchAt);
  assert.match(desktopBranch, /Baked pieces on hand/);
  assert.match(desktopBranch, /<th className="pb-2 pr-4">Product<\/th>\s*<th className="pb-2 pr-4 text-right">On hand<\/th>/);
  assert.match(desktopBranch, /{balances\.map\(\(balance\) =>/);
});

// --- Part 5: Production History collapsed, 3-initial paging ---------------------------------------

test("mobile Production History sits behind one <details> summary, containing the historical-cost disclosure and MobileProductionHistory -- not auto-rendered when Bake opens", () => {
  const page = code(BAKE_TSX);
  const panel = sliceFunction(page, "FinishedStockPanel");
  const mobileBranchAt = panel.indexOf("if (isMobileWidth) {");
  const mobileBranchEnd = panel.indexOf("\n  return (", mobileBranchAt);
  const mobileBranch = panel.slice(mobileBranchAt, mobileBranchEnd);
  assert.match(mobileBranch, /<details>\s*<summary className="cursor-pointer text-lg font-semibold">Production history<\/summary>/);
  assert.equal(/<details open\b/.test(mobileBranch), false, "Production history's own <details> must have no open attribute -- collapsed by default");
  assert.match(mobileBranch, /ⓘ About historical costs/);
  // TASK-072 adds Correct Bake props to this call; history/productName must still be passed as before.
  assert.match(mobileBranch, /<MobileProductionHistory history=\{history\} productName=\{productName\}[^>]*\/>/);
});

test("MobileProductionHistory's initial reveal is MOBILE_PRODUCTION_HISTORY_PAGE_SIZE (3), not the Exceptions page size (5)", () => {
  const page = code(BAKE_TSX);
  const history = sliceFunction(page, "MobileProductionHistory");
  assert.match(history, /const \[visibleCount, setVisibleCount\] = useState\(MOBILE_PRODUCTION_HISTORY_PAGE_SIZE\);/);
  assert.match(history, /getMobileHistoryPage\(history, visibleCount, MOBILE_PRODUCTION_HISTORY_PAGE_SIZE\)/);
  assert.match(history, /expandMobileHistoryPage\(count, history\.length, MOBILE_PRODUCTION_HISTORY_PAGE_SIZE\)/);
  assert.match(history, /setVisibleCount\(MOBILE_PRODUCTION_HISTORY_PAGE_SIZE\)/, "Show less must return to 3, not some other value");
  assert.equal(history.includes("sortProductionHistory("), false, "Show more/Show less must only page the already-sorted array, never re-sort it");
});

// --- Part 6/6A: one Advanced tools disclosure, exceptions nested inside, not permanent -------------

test("mobile Advanced tools is exactly one top-level <details>, containing three nested disclosures for Stock correction, Physical count / reconcile, and Finished-stock exceptions", () => {
  const page = code(BAKE_TSX);
  const panel = sliceFunction(page, "FinishedStockPanel");
  const mobileBranchAt = panel.indexOf("if (isMobileWidth) {");
  const mobileBranchEnd = panel.indexOf("\n  return (", mobileBranchAt);
  const mobileBranch = panel.slice(mobileBranchAt, mobileBranchEnd);

  const advancedAt = mobileBranch.indexOf("Advanced tools");
  assert.ok(advancedAt > -1, "precondition: Advanced tools exists");
  const advancedDetailsOpenAt = mobileBranch.lastIndexOf("<details", advancedAt);
  const advancedTag = mobileBranch.slice(advancedDetailsOpenAt, mobileBranch.indexOf(">", advancedDetailsOpenAt) + 1);
  assert.equal(/\bopen\b/.test(advancedTag), false, "Advanced tools must be collapsed by default");

  assert.match(mobileBranch, /<summary className="cursor-pointer text-sm font-semibold text-\[#8f5632\]">Stock correction<\/summary>/);
  assert.match(mobileBranch, /<summary className="cursor-pointer text-sm font-semibold text-\[#8f5632\]">Physical count \/ reconcile<\/summary>/);
  assert.match(mobileBranch, /<summary className="cursor-pointer text-sm font-semibold text-\[#8f5632\]">Finished-stock exceptions \(\{exceptionHistory\.length\}\)<\/summary>/);

  // exactly one "Advanced tools" summary -- not three separate top-level sections.
  assert.equal((mobileBranch.match(/>Advanced tools</g) ?? []).length, 1);
});

test("Finished-stock exceptions is not permanently rendered on the main mobile surface -- it only exists inside the nested Advanced tools disclosure, gated on exceptionHistory.length", () => {
  const page = code(BAKE_TSX);
  const panel = sliceFunction(page, "FinishedStockPanel");
  const mobileBranchAt = panel.indexOf("if (isMobileWidth) {");
  const mobileBranchEnd = panel.indexOf("\n  return (", mobileBranchAt);
  const mobileBranch = panel.slice(mobileBranchAt, mobileBranchEnd);

  const exceptionsSummaryAt = mobileBranch.indexOf("Finished-stock exceptions (");
  const advancedToolsAt = mobileBranch.indexOf("Advanced tools");
  assert.ok(exceptionsSummaryAt > advancedToolsAt, "the exceptions disclosure must be nested inside/after the Advanced tools summary, not a sibling top-level heading");
  assert.equal(/<h3[^>]*>Finished-stock exceptions<\/h3>/.test(mobileBranch), false, "no unconditional top-level heading for exceptions on mobile");
});

test("MobileFinishedStockExceptions keeps its original page size (5), unchanged by the Production History page-size split", () => {
  const page = code(BAKE_TSX);
  const exceptions = sliceFunction(page, "MobileFinishedStockExceptions");
  assert.match(exceptions, /const \[visibleCount, setVisibleCount\] = useState\(MOBILE_HISTORY_PAGE_SIZE\);/);
  assert.match(exceptions, /getMobileHistoryPage\(exceptionHistory, visibleCount, MOBILE_HISTORY_PAGE_SIZE\)/);
});

// --- No dead code: the now-unused MobileFinishedStockList presentational component was removed ----

test("MobileFinishedStockList no longer exists -- removing Finished Stock's mobile section made it a true orphan, so it was deleted rather than left as dead code (deriveFinishedStockBalances/balances themselves are untouched and still used by the desktop table and Stock correction)", () => {
  const page = code(BAKE_TSX);
  assert.equal(page.includes("function MobileFinishedStockList("), false);
  assert.match(page, /deriveFinishedStockBalances/, "the underlying calculation import must still be present and used");
});

// --- Responsive structural safety -------------------------------------------------------------------

test("no overflow-x-hidden anywhere in the file, and no new page-level overflow-x-auto or w-screen was introduced", () => {
  const page = code(BAKE_TSX);
  assert.equal(page.includes("overflow-x-hidden"), false);
  assert.equal(page.includes("w-screen"), false);
  // overflow-x-auto is still legitimate on desktop's own <table> wrappers -- just not inside the
  // mobile early-return branch.
  const panel = sliceFunction(page, "FinishedStockPanel");
  const mobileBranchAt = panel.indexOf("if (isMobileWidth) {");
  const mobileBranchEnd = panel.indexOf("\n  return (", mobileBranchAt);
  assert.equal(panel.slice(mobileBranchAt, mobileBranchEnd).includes("overflow-x-auto"), false);
});

test("the two long-text helper rows now wrap and shrink safely (min-w-0/flex-wrap/break-words), while restoring the original fixed-height single-line look at lg and up via lg:h-10/lg:flex-nowrap", () => {
  const bakePage = sliceBakePage(code(BAKE_TSX));
  assert.match(bakePage, /flex min-h-10 min-w-0 flex-wrap items-center break-words rounded-md border border-\[#ead9c8\] bg-white px-3 text-sm text-\[#6f5a4c\] lg:h-10 lg:flex-nowrap/);
  assert.match(bakePage, /flex min-h-10 min-w-0 flex-wrap items-center break-words rounded-md border border-\[#d8c7b7\] bg-\[#f7f2ea\] px-3 font-semibold text-\[#6f5a4c\] lg:h-10 lg:flex-nowrap/);
});

test("the new compact issues panel and its list items can wrap long ingredient names (min-w-0/break-words), and are not a fixed-width or non-wrapping container", () => {
  const bakePage = sliceBakePage(code(BAKE_TSX));
  const panelAt = bakePage.indexOf("Can&apos;t confirm bake");
  const panelDivOpenAt = bakePage.lastIndexOf("<div", panelAt);
  const panelBlock = bakePage.slice(panelDivOpenAt, bakePage.indexOf("</div>\n        ) : null}", panelDivOpenAt));
  assert.match(panelBlock, /w-full min-w-0/);
  assert.match(panelBlock, /min-w-0 break-words/);
  assert.equal(/\bw-\[\d+px\]/.test(panelBlock), false);
});
