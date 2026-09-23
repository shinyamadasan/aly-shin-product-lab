import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { verifySellingFormatPackagingLinesReadback, verifySellingFormatsReadback } from "../src/lib/selling-formats.ts";
import type { SellingFormat, SellingFormatPackagingLine } from "../src/lib/product-lab-types.ts";

const PRODUCT_LAB_SOURCE = readFileSync(new URL("../src/app/product-lab.tsx", import.meta.url), "utf8");

function baseSellingFormat(overrides: Partial<SellingFormat> = {}): SellingFormat {
  return {
    id: "format-1",
    costingId: "costing-1",
    name: "Single Brownie",
    piecesPerUnit: 1,
    sellingPrice: 40,
    isActive: true,
    sortOrder: 0,
    notes: "",
    ...overrides,
  };
}

function baseSellingFormatPackagingLine(overrides: Partial<SellingFormatPackagingLine> = {}): SellingFormatPackagingLine {
  return {
    id: "line-1",
    sellingFormatId: "format-1",
    ingredientId: "",
    name: "Wrapper",
    quantity: 1,
    unit: "pcs",
    unitCostSnapshot: 6,
    isManualCost: true,
    note: "",
    sortOrder: 0,
    ...overrides,
  };
}

// --- Problem 1: local-only Selling Format actions must not claim persistence ---

function sliceFunction(startMarker: string, endMarker: string): string {
  const start = PRODUCT_LAB_SOURCE.indexOf(startMarker);
  assert.notEqual(start, -1, `could not find "${startMarker}" in product-lab.tsx`);
  const end = PRODUCT_LAB_SOURCE.indexOf(endMarker, start);
  assert.notEqual(end, -1, `could not find "${endMarker}" after "${startMarker}" in product-lab.tsx`);
  return PRODUCT_LAB_SOURCE.slice(start, end);
}

test("addSellingFormat: no longer reports a green/save-success event for a draft-only row", () => {
  const fn = sliceFunction("function addSellingFormat()", "function updateSellingFormat(");

  assert.doesNotMatch(fn, /setLocalMessageTone\("good"\)/, "adding a format row must not use success/green styling -- it hasn't been saved");
  assert.doesNotMatch(fn, /setLocalMessage\("Selling format added\."\)/, "the old copy claimed persistence that never happened");
});

test("addSellingFormat: new copy explicitly says the row is only in the draft and must be saved", () => {
  const fn = sliceFunction("function addSellingFormat()", "function updateSellingFormat(");

  assert.match(fn, /setLocalMessage\("Selling format added to this draft\. Click Update costing below to save it\."\)/);
  assert.match(fn, /setLocalMessageTone\("info"\)/);
});

test("removeSellingFormat: the equivalent local-only action also avoids success styling and says the change is unsaved", () => {
  const fn = sliceFunction("function removeSellingFormat(", "function addPackagingLine(");

  assert.doesNotMatch(fn, /setLocalMessageTone\("good"\)/);
  assert.match(fn, /this draft/);
  assert.match(fn, /setLocalMessageTone\("info"\)/);
});

// --- Problem 2: the normal remote costing save path must read back before claiming success ---

function sliceSaveCosting(): string {
  return sliceFunction("async function saveCosting(formData: FormData)", "async function deleteCosting(");
}

test("saveCosting: reads selling_formats back, scoped to this costing, before reporting success", () => {
  const saveCosting = sliceSaveCosting();

  const readBackIndex = saveCosting.search(/supabase\s*\.from\("selling_formats"\)\s*\.select\("\*"\)\s*\.eq\("costing_id",\s*costingSummaryId\)/);
  assert.notEqual(readBackIndex, -1, "expected a targeted read-back of selling_formats scoped to costingSummaryId");

  const successIndex = saveCosting.indexOf('setMessage(costingId ? "Costing updated and verified." : "Costing saved and verified.")');
  assert.notEqual(successIndex, -1, "expected the success message to say 'and verified'");
  assert.ok(readBackIndex < successIndex, "the read-back must happen before the success message is shown");
});

test("saveCosting: packaging-line persistence is also verified, scoped to the submitted format ids", () => {
  const saveCosting = sliceSaveCosting();

  const lineReadBackIndex = saveCosting.search(/supabase\s*\.from\("selling_format_packaging_lines"\)\s*\.select\("\*"\)\s*\.in\("selling_format_id",\s*submittedFormatIds\)/);
  assert.notEqual(lineReadBackIndex, -1, "expected a targeted read-back of selling_format_packaging_lines scoped to submittedFormatIds");

  const successIndex = saveCosting.indexOf('setMessage(costingId ? "Costing updated and verified." : "Costing saved and verified.")');
  assert.ok(lineReadBackIndex < successIndex, "packaging-line read-back must also happen before the success message");
});

test("saveCosting: success copy is reported by exactly one setMessage call, and only the 'verified' ternary -- the old unverified copy is gone", () => {
  const saveCosting = sliceSaveCosting();

  const successCallCount = (saveCosting.match(/setMessage\(costingId \? "Costing updated and verified\." : "Costing saved and verified\."\)/g) ?? []).length;
  assert.equal(successCallCount, 1, "the verified success message should be set exactly once per save");

  assert.doesNotMatch(saveCosting, /setMessage\("Costing updated\."\)/);
  assert.doesNotMatch(saveCosting, /setMessage\("Costing saved\."\)/);
  assert.doesNotMatch(saveCosting, /setMessage\(costingId \? "Costing updated\." : "Costing saved\."\)/);
});

test("saveCosting: the read-back is skipped when selling_formats is unavailable (legacy/local configs)", () => {
  const saveCosting = sliceSaveCosting();
  assert.match(saveCosting, /if \(!isSellingFormatsTableMissing\) \{/);
});

test("saveCosting: a read-back mismatch or error leaves the editor open and reports a bad-tone error, never a blind second write", () => {
  const saveCosting = sliceSaveCosting();

  const readBackBlockStart = saveCosting.indexOf("if (!isSellingFormatsTableMissing) {");
  assert.notEqual(readBackBlockStart, -1);
  const readBackBlockEnd = saveCosting.indexOf('setMessage(costingId ? "Costing updated and verified." : "Costing saved and verified.")');
  const readBackBlock = saveCosting.slice(readBackBlockStart, readBackBlockEnd);

  // Every failure branch inside the read-back block must report "bad" and return without ever
  // clearing the editor (setEditingCosting(null) is what makes the editor close on success).
  assert.doesNotMatch(readBackBlock, /setEditingCosting\(null\)/, "the editor must stay open on a read-back failure");

  const badToneCount = (readBackBlock.match(/setMessageTone\("bad"\)/g) ?? []).length;
  assert.ok(badToneCount >= 4, "expected a bad-tone message for: formats read error, formats mismatch, lines read error, lines mismatch");

  assert.match(readBackBlock, /The editor was left open; review/);

  // No blind retry: the read-back block itself must not contain any further .upsert(/.insert( calls --
  // only .select( reads are allowed here.
  assert.doesNotMatch(readBackBlock, /\.upsert\(/);
  assert.doesNotMatch(readBackBlock, /\.insert\(/);
});

test("saveCosting: the exact required mismatch wording is shown to the operator", () => {
  const saveCosting = sliceSaveCosting();
  assert.match(
    saveCosting,
    /Costing was written, but the selling format did not match when read back from the database\. The editor was left open; review the format and save again\./,
  );
});

// --- Pure read-back comparison functions (used by the wiring above) ---

test("verifySellingFormatsReadback: matches when persisted rows agree with what was submitted", () => {
  const submitted = [baseSellingFormat()];
  const persisted = [baseSellingFormat()];
  assert.equal(verifySellingFormatsReadback(submitted, persisted), null);
});

test("verifySellingFormatsReadback: a small floating-point round-trip through a numeric column is tolerated", () => {
  const submitted = [baseSellingFormat({ sellingPrice: 40 })];
  const persisted = [baseSellingFormat({ sellingPrice: 40.001 })];
  assert.equal(verifySellingFormatsReadback(submitted, persisted), null);
});

test("verifySellingFormatsReadback: a submitted format missing entirely from the persisted set is reported", () => {
  const submitted = [baseSellingFormat({ id: "format-1" })];
  const persisted: SellingFormat[] = [];
  const result = verifySellingFormatsReadback(submitted, persisted);
  assert.match(result ?? "", /was not found when read back/);
});

test("verifySellingFormatsReadback: a real value mismatch (price) is reported, not silently accepted", () => {
  const submitted = [baseSellingFormat({ sellingPrice: 40 })];
  const persisted = [baseSellingFormat({ sellingPrice: 55 })];
  const result = verifySellingFormatsReadback(submitted, persisted);
  assert.match(result ?? "", /did not match when read back/);
});

test("verifySellingFormatsReadback: a name mismatch is reported", () => {
  const submitted = [baseSellingFormat({ name: "Single Brownie" })];
  const persisted = [baseSellingFormat({ name: "Box of 6" })];
  assert.notEqual(verifySellingFormatsReadback(submitted, persisted), null);
});

test("verifySellingFormatsReadback: an active-state mismatch is reported", () => {
  const submitted = [baseSellingFormat({ isActive: true })];
  const persisted = [baseSellingFormat({ isActive: false })];
  assert.notEqual(verifySellingFormatsReadback(submitted, persisted), null);
});

test("verifySellingFormatsReadback: an unrelated extra persisted row (another costing) does not cause a false mismatch", () => {
  const submitted = [baseSellingFormat({ id: "format-1", costingId: "costing-1" })];
  const persisted = [baseSellingFormat({ id: "format-1", costingId: "costing-1" }), baseSellingFormat({ id: "format-9", costingId: "costing-9", name: "Unrelated" })];
  assert.equal(verifySellingFormatsReadback(submitted, persisted), null);
});

test("verifySellingFormatPackagingLinesReadback: matches when persisted lines agree with what was submitted", () => {
  const submitted = [baseSellingFormatPackagingLine()];
  const persisted = [baseSellingFormatPackagingLine()];
  assert.equal(verifySellingFormatPackagingLinesReadback(submitted, persisted), null);
});

test("verifySellingFormatPackagingLinesReadback: a submitted line missing from the persisted set is reported", () => {
  const submitted = [baseSellingFormatPackagingLine({ id: "line-1" })];
  const persisted: SellingFormatPackagingLine[] = [];
  const result = verifySellingFormatPackagingLinesReadback(submitted, persisted);
  assert.match(result ?? "", /was not found when read back/);
});

test("verifySellingFormatPackagingLinesReadback: a quantity or unit-cost mismatch is reported", () => {
  const submitted = [baseSellingFormatPackagingLine({ quantity: 2, unitCostSnapshot: 10 })];
  const persisted = [baseSellingFormatPackagingLine({ quantity: 1, unitCostSnapshot: 10 })];
  assert.notEqual(verifySellingFormatPackagingLinesReadback(submitted, persisted), null);
});

test("verifySellingFormatPackagingLinesReadback: a null vs empty-string ingredientId is not a false mismatch", () => {
  const submitted = [baseSellingFormatPackagingLine({ ingredientId: "" })];
  const persisted = [baseSellingFormatPackagingLine({ ingredientId: "" })];
  assert.equal(verifySellingFormatPackagingLinesReadback(submitted, persisted), null);
});

// --- Problem 3: dirty-state protection around Selling Format edits must remain intact ---

test("addSellingFormat still mutates formatRows (the same state the dirty-state snapshot diffs against)", () => {
  const fn = sliceFunction("function addSellingFormat()", "function updateSellingFormat(");
  assert.match(fn, /setFormatRows\(\(current\) => \[/, "adding a row must still update formatRows so the unsaved-changes guard sees it as dirty");
});

test("removeSellingFormat still mutates formatRows and packagingLineRows together", () => {
  const fn = sliceFunction("function removeSellingFormat(", "function addPackagingLine(");
  assert.match(fn, /setFormatRows\(\(current\) => current\.filter/);
  assert.match(fn, /setPackagingLineRows\(\(current\) => current\.filter/);
});
