import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const PRODUCT_LAB_SOURCE = readFileSync(new URL("../src/app/product-lab.tsx", import.meta.url), "utf8");
const RECENT_ENTRIES_SOURCE = readFileSync(new URL("../src/components/recent-entries.tsx", import.meta.url), "utf8");

test("costing page opens on history, not the full editor", () => {
  assert.match(PRODUCT_LAB_SOURCE, /type CostingWorkspaceMode = "history" \| "detail" \| "editor"/);
  assert.match(PRODUCT_LAB_SOURCE, /useState<CostingWorkspaceMode>\("history"\)/);

  const costingBranch = PRODUCT_LAB_SOURCE.slice(
    PRODUCT_LAB_SOURCE.indexOf('{view === "costing" ? ('),
    PRODUCT_LAB_SOURCE.indexOf('{view === "orders" ?'),
  );

  assert.match(costingBranch, /<CostingWorkspace/);
  assert.match(costingBranch, /costingWorkspaceMode === "editor" \? \(/);
  assert.match(costingBranch, /<CostingForm/);
});

test("costing workspace makes new, view, and edit explicit actions", () => {
  assert.match(PRODUCT_LAB_SOURCE, /function newCostingWithGuard\(\)/);
  assert.match(PRODUCT_LAB_SOURCE, /function viewCostingWithGuard\(costingToView: CostingSummary\)/);
  assert.match(PRODUCT_LAB_SOURCE, /function editCostingWithGuard\(costingToEdit: CostingSummary\)/);
  assert.match(PRODUCT_LAB_SOURCE, /function duplicateCostingWithGuard\(costingToDuplicate: CostingSummary\)/);
  assert.match(PRODUCT_LAB_SOURCE, /setCostingWorkspaceMode\("editor"\)/);
  assert.match(PRODUCT_LAB_SOURCE, /setCostingWorkspaceMode\("detail"\)/);
  assert.match(PRODUCT_LAB_SOURCE, />\+ New costing<\/button>/);
  assert.match(PRODUCT_LAB_SOURCE, />Duplicate as new version<\/button>/);
  assert.match(PRODUCT_LAB_SOURCE, />Edit costing<\/button>/);
});

test("costing history is not limited to recent three entries", () => {
  const workspaceStart = PRODUCT_LAB_SOURCE.indexOf("function CostingWorkspace(");
  const workspaceEnd = PRODUCT_LAB_SOURCE.indexOf("function CostingForm(");
  const costingWorkspace = PRODUCT_LAB_SOURCE.slice(workspaceStart, workspaceEnd);

  assert.doesNotMatch(costingWorkspace, /\.slice\(0,\s*3\)/);
  assert.match(costingWorkspace, /const visibleCostings = sortOrder === "newest" \? filteredCostings : \[\.\.\.filteredCostings\]\.reverse\(\)/);
  assert.match(costingWorkspace, /visibleCostings\.map/);

  const recentCostingSection = RECENT_ENTRIES_SOURCE.slice(
    RECENT_ENTRIES_SOURCE.indexOf("{showCosting ? <RecentList"),
    RECENT_ENTRIES_SOURCE.indexOf("{showJournal ? <RecentList"),
  );
  assert.match(recentCostingSection, /labState\.costings\.slice\(0, 3\)/);
});

test("mobile costing history uses tappable compact rows, not View-only cards", () => {
  const cardStart = PRODUCT_LAB_SOURCE.indexOf("function CostingHistoryCard(");
  const cardEnd = PRODUCT_LAB_SOURCE.indexOf("function CostingDetail(");
  const mobileRow = PRODUCT_LAB_SOURCE.slice(cardStart, cardEnd);

  assert.match(mobileRow, /className="grid w-full grid-cols-\[1fr_auto\]/);
  assert.match(mobileRow, /text-base font-semibold leading-5 text-\[#231813\]/);
  assert.match(mobileRow, /mt-0\.5 truncate text-sm font-semibold leading-5 text-\[#8f5632\]/);
  assert.match(mobileRow, /title=\{linkedBatch\?\.batchVersion \|\| "Unlinked"\}/);
  assert.match(mobileRow, /className="w-\[96px\] shrink-0 text-right"/);
  assert.match(mobileRow, /Unit cost/);
  assert.doesNotMatch(mobileRow, />View<\/button>/);
  assert.doesNotMatch(mobileRow, /rounded-md border border-\[#ead9c8\] bg-\[#fffaf3\] p-3/);
});

test("mobile costing filters are compact without changing desktop grid", () => {
  const workspaceStart = PRODUCT_LAB_SOURCE.indexOf("function CostingWorkspace(");
  const workspaceEnd = PRODUCT_LAB_SOURCE.indexOf("function CostingForm(");
  const costingWorkspace = PRODUCT_LAB_SOURCE.slice(workspaceStart, workspaceEnd);

  assert.match(costingWorkspace, /mt-5 grid gap-3 md:grid-cols-\[1fr_220px_160px\]/);
  assert.match(costingWorkspace, /grid grid-cols-1 gap-3 min-\[340px\]:grid-cols-2 md:contents/);
  assert.match(costingWorkspace, /h-10 w-full min-w-0 rounded-md border border-\[#d8c7b7\]/);
});

test("mobile detail is primary instead of stacked below mobile history", () => {
  const workspaceStart = PRODUCT_LAB_SOURCE.indexOf("function CostingWorkspace(");
  const workspaceEnd = PRODUCT_LAB_SOURCE.indexOf("function CostingForm(");
  const costingWorkspace = PRODUCT_LAB_SOURCE.slice(workspaceStart, workspaceEnd);

  assert.match(costingWorkspace, /const isDetailMode = selectedCosting !== null && mode === "detail"/);
  assert.match(costingWorkspace, /<div className="md:hidden">\s*<CostingDetail/);
  assert.match(costingWorkspace, /<div className=\{isDetailMode \? "hidden md:block" : ""\}>/);
  assert.match(costingWorkspace, /<div className="hidden md:block">\s*<CostingDetail/);
  assert.match(PRODUCT_LAB_SOURCE, />← Costing History<\/SecondaryButton>/);
});

test("duplicate costing opens a new draft and clears stale duplicate provenance on exits", () => {
  assert.match(PRODUCT_LAB_SOURCE, /const draft = buildDuplicateCostingDraft\(costingToDuplicate, labState\.sellingFormats, labState\.sellingFormatPackagingLines\)/);
  assert.match(PRODUCT_LAB_SOURCE, /setEditingCosting\(draft\.costing\)/);
  assert.match(PRODUCT_LAB_SOURCE, /setDuplicatingCostingSource\(draft\.source\)/);
  assert.match(PRODUCT_LAB_SOURCE, /setViewingCostingId\(costingToDuplicate\.id\)/);

  const clearCount = PRODUCT_LAB_SOURCE.match(/setDuplicatingCostingSource\(null\)/g)?.length ?? 0;
  assert.ok(clearCount >= 7, "duplicate provenance should be cleared by save, cancel, new, edit, view, history, and delete transitions");
});

test("duplicate mode requires a new version instead of an existing destination batch", () => {
  const formStart = PRODUCT_LAB_SOURCE.indexOf("function CostingForm(");
  const formEnd = PRODUCT_LAB_SOURCE.indexOf("function SellingFormatCard(");
  const costingForm = PRODUCT_LAB_SOURCE.slice(formStart, formEnd);

  assert.match(costingForm, /name="duplicateBatchVersion"/);
  assert.match(costingForm, /label="New version"/);
  assert.match(costingForm, /No automatic V7 is created/);
  assert.match(costingForm, /Save is blocked until you enter a new version name/);
  assert.match(costingForm, /<Button disabled=\{isDuplicateSaveBlocked\}>/);
  assert.doesNotMatch(costingForm, /Choose a different batch\/version before saving this duplicate/);
  assert.match(PRODUCT_LAB_SOURCE, /findConflictingCosting\(labState\.costings, \{ costingId, productId, batchId \}\)/);
});

test("duplicate form uses new-costing identity while preserving copied editable context", () => {
  const formStart = PRODUCT_LAB_SOURCE.indexOf("function CostingForm(");
  const formEnd = PRODUCT_LAB_SOURCE.indexOf("function SellingFormatCard(");
  const costingForm = PRODUCT_LAB_SOURCE.slice(formStart, formEnd);

  assert.match(costingForm, /isDuplicateDraft\s*\?\s*buildDuplicateIngredientRows\(savedIngredients, supplies, ingredients\)\s*:\s*savedIngredients\.map\(\(entry\) => \(\{ \.\.\.entry, rowId: entry\.id \}\)\)/);
  assert.match(costingForm, /const existingSellingFormats = isDuplicateDraft \? duplicateSellingFormats/);
  assert.match(costingForm, /const existingSellingFormatPackagingLines = isDuplicateDraft \? duplicateSellingFormatPackagingLines/);
  assert.match(costingForm, /<input name="id" type="hidden" value=\{costing\?\.id \?\? ""\}/);
  assert.match(costingForm, /New version · Based on \{duplicateSourceName\}/);
});

test("duplicate refreshes ingredient costs while edit keeps saved historical ingredient costs", () => {
  assert.match(PRODUCT_LAB_SOURCE, /import \{ buildDuplicateCostingDraft, buildDuplicateIngredientRows \} from "@\/lib\/costing-duplicate"/);
  assert.match(PRODUCT_LAB_SOURCE, /buildDuplicateIngredientRows\(savedIngredients, supplies, ingredients\)/);
  assert.match(PRODUCT_LAB_SOURCE, /savedIngredients\.map\(\(entry\) => \(\{ \.\.\.entry, rowId: entry\.id \}\)\)/);
  assert.doesNotMatch(PRODUCT_LAB_SOURCE, /savedIngredients\.map\(\(entry\) => autoCostRows/);
});

test("duplicate save uses one atomic RPC and local fallback creates batch plus costing together", () => {
  assert.match(PRODUCT_LAB_SOURCE, /supabase\.rpc\("create_batch_with_costing"/);
  assert.match(PRODUCT_LAB_SOURCE, /p_batch:/);
  assert.match(PRODUCT_LAB_SOURCE, /p_costing: buildCostingSummaryPayload\(costing\)/);
  assert.match(PRODUCT_LAB_SOURCE, /p_costing_entries: ingredientRows\.map/);
  assert.match(PRODUCT_LAB_SOURCE, /p_selling_formats: sellingFormats\.map\(buildSellingFormatPayload\)/);
  assert.match(PRODUCT_LAB_SOURCE, /p_selling_format_packaging_lines: sellingFormatPackagingLines\.map\(buildSellingFormatPackagingLinePayload\)/);
  assert.match(PRODUCT_LAB_SOURCE, /\? \[duplicateBatch, \.\.\.current\.batches\]/);
  assert.match(PRODUCT_LAB_SOURCE, /current\.batches\.map\(\(batch\) => \(batch\.id === syncedLinkedBatch\.id \? syncedLinkedBatch : batch\)\)/);
});

test("duplicate as new version copies batch structure but not historical batch evidence", () => {
  assert.match(PRODUCT_LAB_SOURCE, /ingredientsNotes: syncBatchFormulaFromCostingEntries\(duplicateSourceBatch\.ingredientsNotes, ingredientRows\)/);
  assert.match(PRODUCT_LAB_SOURCE, /prepTimeMinutes: duplicateSourceBatch\.prepTimeMinutes/);
  assert.match(PRODUCT_LAB_SOURCE, /bakeTimeMinutes: duplicateSourceBatch\.bakeTimeMinutes/);
  assert.match(PRODUCT_LAB_SOURCE, /coolingTimeMinutes: duplicateSourceBatch\.coolingTimeMinutes/);
  assert.match(PRODUCT_LAB_SOURCE, /usablePieces: duplicateSourceBatch\.usablePieces/);
  assert.match(PRODUCT_LAB_SOURCE, /tasteNotes: ""/);
  assert.match(PRODUCT_LAB_SOURCE, /textureNotes: ""/);
  assert.match(PRODUCT_LAB_SOURCE, /wentWrong: ""/);
  assert.match(PRODUCT_LAB_SOURCE, /imperfectPieces: 0/);
});

test("duplicate click itself performs no persistence writes", () => {
  const duplicateStart = PRODUCT_LAB_SOURCE.indexOf("function duplicateCostingWithGuard(");
  const duplicateEnd = PRODUCT_LAB_SOURCE.indexOf("function viewCostingWithGuard(");
  const duplicateHandler = PRODUCT_LAB_SOURCE.slice(duplicateStart, duplicateEnd);

  assert.match(duplicateHandler, /buildDuplicateCostingDraft/);
  assert.doesNotMatch(duplicateHandler, /supabase\./);
  assert.doesNotMatch(duplicateHandler, /setLabState/);
  assert.doesNotMatch(duplicateHandler, /\.rpc\(/);
  assert.doesNotMatch(duplicateHandler, /\.insert\(/);
});
