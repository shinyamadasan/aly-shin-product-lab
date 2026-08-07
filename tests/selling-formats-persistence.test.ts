import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSellingFormatPackagingLinePayload,
  buildSellingFormatPayload,
  findDuplicateCatalogPackagingLine,
  getRemovedSellingFormatIds,
  getRemovedSellingFormatPackagingLineIds,
  mapSellingFormatPackagingLineRow,
  mapSellingFormatRow,
  parseSellingFormatsFromFormData,
  replaceSellingFormatPackagingLinesForCosting,
  replaceSellingFormatsForCosting,
  validateSellingFormatsForSave,
} from "../src/lib/selling-formats.ts";
import type { SellingFormat, SellingFormatPackagingLine } from "../src/lib/product-lab-types.ts";

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

// --- Supabase row mapping ---

test("mapSellingFormatRow: maps every snake_case column to its camelCase field", () => {
  const format = mapSellingFormatRow({
    id: "format-1",
    costing_id: "costing-1",
    name: "Box of 6",
    pieces_per_unit: 6,
    selling_price: 250,
    is_active: true,
    sort_order: 2,
    notes: "Weekend special",
  });

  assert.deepEqual(format, {
    id: "format-1",
    costingId: "costing-1",
    name: "Box of 6",
    piecesPerUnit: 6,
    sellingPrice: 250,
    isActive: true,
    sortOrder: 2,
    notes: "Weekend special",
  });
});

test("mapSellingFormatRow: nullable columns fall back to the same defaults as every other entity in this app", () => {
  const format = mapSellingFormatRow({
    id: "format-1",
    costing_id: "costing-1",
    name: null,
    pieces_per_unit: null,
    selling_price: null,
    is_active: null,
    sort_order: null,
    notes: null,
  });

  assert.equal(format.name, "");
  assert.equal(format.piecesPerUnit, 0);
  assert.equal(format.sellingPrice, 0);
  assert.equal(format.isActive, true);
  assert.equal(format.sortOrder, 0);
  assert.equal(format.notes, "");
});

test("mapSellingFormatPackagingLineRow: maps every snake_case column to its camelCase field, including a null ingredient_id", () => {
  const line = mapSellingFormatPackagingLineRow({
    id: "line-1",
    selling_format_id: "format-1",
    ingredient_id: null,
    name: "Sticker",
    quantity: 2,
    unit: "pcs",
    unit_cost_snapshot: 0.275,
    is_manual_cost: false,
    note: "",
    sort_order: 0,
  });

  assert.deepEqual(line, {
    id: "line-1",
    sellingFormatId: "format-1",
    ingredientId: "",
    name: "Sticker",
    quantity: 2,
    unit: "pcs",
    unitCostSnapshot: 0.275,
    isManualCost: false,
    note: "",
    sortOrder: 0,
  });
});

test("mapSellingFormatPackagingLineRow: a real ingredient_id (catalog-linked) maps through unchanged", () => {
  const line = mapSellingFormatPackagingLineRow({
    id: "line-1",
    selling_format_id: "format-1",
    ingredient_id: "ingredient-sticker",
    name: "Sticker",
    quantity: 1,
    unit: "pcs",
    unit_cost_snapshot: 2,
    is_manual_cost: false,
    note: "",
    sort_order: 0,
  });

  assert.equal(line.ingredientId, "ingredient-sticker");
});

// --- Selling-format persistence payload construction ---

test("buildSellingFormatPayload: includes the format's stable id and every other field, snake_cased", () => {
  const format = baseSellingFormat({ id: "format-9", costingId: "costing-9", name: "Box of 3", piecesPerUnit: 3, sellingPrice: 120, isActive: false, sortOrder: 1, notes: "seasonal" });
  const payload = buildSellingFormatPayload(format);

  assert.deepEqual(payload, {
    id: "format-9",
    costing_id: "costing-9",
    name: "Box of 3",
    pieces_per_unit: 3,
    selling_price: 120,
    is_active: false,
    sort_order: 1,
    notes: "seasonal",
  });
});

test("buildSellingFormatPackagingLinePayload: a manual line's empty ingredientId becomes null, not an empty string", () => {
  const line = baseSellingFormatPackagingLine({ ingredientId: "" });
  const payload = buildSellingFormatPackagingLinePayload(line);
  assert.equal(payload.ingredient_id, null);
});

test("buildSellingFormatPackagingLinePayload: a catalog-linked line's ingredientId passes through unchanged", () => {
  const line = baseSellingFormatPackagingLine({ ingredientId: "ingredient-sticker", isManualCost: false });
  const payload = buildSellingFormatPackagingLinePayload(line);
  assert.equal(payload.ingredient_id, "ingredient-sticker");
  assert.equal(payload.is_manual_cost, false);
});

test("buildSellingFormatPackagingLinePayload: includes the line's stable id and every other field, snake_cased", () => {
  const line = baseSellingFormatPackagingLine({ id: "line-7", sellingFormatId: "format-2", name: "Kraft box", quantity: 1, unit: "pcs", unitCostSnapshot: 15, note: "matte finish", sortOrder: 3 });
  const payload = buildSellingFormatPackagingLinePayload(line);

  assert.equal(payload.id, "line-7");
  assert.equal(payload.selling_format_id, "format-2");
  assert.equal(payload.name, "Kraft box");
  assert.equal(payload.quantity, 1);
  assert.equal(payload.unit, "pcs");
  assert.equal(payload.unit_cost_snapshot, 15);
  assert.equal(payload.note, "matte finish");
  assert.equal(payload.sort_order, 3);
});

// --- ID preservation during edits (Supabase-mode: payload id === submitted id) ---

test("editing a format preserves its id end to end: parsed row -> payload uses the same id throughout", () => {
  const loaded = mapSellingFormatRow({ id: "format-stable", costing_id: "costing-1", name: "Single Brownie", pieces_per_unit: 1, selling_price: 40, is_active: true, sort_order: 0, notes: "" });
  const edited = { ...loaded, sellingPrice: 45 };
  const payload = buildSellingFormatPayload(edited);

  assert.equal(payload.id, "format-stable");
  assert.equal(payload.id, loaded.id);
});

// --- Removed-record reconciliation (Supabase mode) ---

test("getRemovedSellingFormatIds: nothing removed when every existing format is resubmitted", () => {
  const existing = [baseSellingFormat({ id: "format-1" }), baseSellingFormat({ id: "format-2" })];
  assert.deepEqual(getRemovedSellingFormatIds(existing, ["format-1", "format-2"]), []);
});

test("getRemovedSellingFormatIds: a format missing from the submission is reported removed", () => {
  const existing = [baseSellingFormat({ id: "format-1" }), baseSellingFormat({ id: "format-2" })];
  assert.deepEqual(getRemovedSellingFormatIds(existing, ["format-1"]), ["format-2"]);
});

test("getRemovedSellingFormatIds: a brand-new submitted id (not previously existing) is never reported as removed", () => {
  const existing = [baseSellingFormat({ id: "format-1" })];
  assert.deepEqual(getRemovedSellingFormatIds(existing, ["format-1", "format-2"]), []);
});

test("getRemovedSellingFormatIds: removing every format reports every existing id", () => {
  const existing = [baseSellingFormat({ id: "format-1" }), baseSellingFormat({ id: "format-2" })];
  assert.deepEqual(getRemovedSellingFormatIds(existing, []), ["format-1", "format-2"]);
});

test("getRemovedSellingFormatPackagingLineIds: a line missing from the submission is reported removed", () => {
  const existing = [baseSellingFormatPackagingLine({ id: "line-1" }), baseSellingFormatPackagingLine({ id: "line-2" })];
  assert.deepEqual(getRemovedSellingFormatPackagingLineIds(existing, ["line-1"]), ["line-2"]);
});

// --- Local-mode round trip (replace-this-costing's-slice reconciliation) ---

test("replaceSellingFormatsForCosting: submitted formats replace this costing's slice, other costings' formats are untouched", () => {
  const current = [
    baseSellingFormat({ id: "format-1", costingId: "costing-1", name: "Single" }),
    baseSellingFormat({ id: "format-2", costingId: "costing-1", name: "Box of 6" }),
    baseSellingFormat({ id: "format-3", costingId: "costing-OTHER", name: "Unrelated" }),
  ];
  const submitted = [baseSellingFormat({ id: "format-1", costingId: "costing-1", name: "Single (edited)" })];
  const result = replaceSellingFormatsForCosting(current, "costing-1", submitted);

  assert.equal(result.length, 2);
  assert.ok(result.some((format) => format.id === "format-1" && format.name === "Single (edited)"));
  assert.ok(result.some((format) => format.id === "format-3"));
  assert.ok(!result.some((format) => format.id === "format-2"), "format-2 was dropped from the submission, so it should be gone");
});

test("replaceSellingFormatsForCosting: submitting an empty array removes every format for this costing (deleteCosting's local path)", () => {
  const current = [baseSellingFormat({ id: "format-1", costingId: "costing-1" }), baseSellingFormat({ id: "format-2", costingId: "costing-OTHER" })];
  const result = replaceSellingFormatsForCosting(current, "costing-1", []);
  assert.deepEqual(result, [baseSellingFormat({ id: "format-2", costingId: "costing-OTHER" })]);
});

test("replaceSellingFormatsForCosting: a format's id survives an edit-then-reread round trip", () => {
  const current = [baseSellingFormat({ id: "format-1", costingId: "costing-1", sellingPrice: 40 })];
  const afterFirstEdit = replaceSellingFormatsForCosting(current, "costing-1", [baseSellingFormat({ id: "format-1", costingId: "costing-1", sellingPrice: 45 })]);
  const afterSecondEdit = replaceSellingFormatsForCosting(afterFirstEdit, "costing-1", [baseSellingFormat({ id: "format-1", costingId: "costing-1", sellingPrice: 50 })]);

  assert.equal(afterSecondEdit.length, 1);
  assert.equal(afterSecondEdit[0]!.id, "format-1");
  assert.equal(afterSecondEdit[0]!.sellingPrice, 50);
});

test("replaceSellingFormatPackagingLinesForCosting: lines for kept formats are replaced, lines for other formats are untouched", () => {
  const current = [
    baseSellingFormatPackagingLine({ id: "line-1", sellingFormatId: "format-1" }),
    baseSellingFormatPackagingLine({ id: "line-2", sellingFormatId: "format-OTHER" }),
  ];
  const result = replaceSellingFormatPackagingLinesForCosting(current, ["format-1"], [baseSellingFormatPackagingLine({ id: "line-3", sellingFormatId: "format-1" })]);

  assert.equal(result.length, 2);
  assert.ok(result.some((line) => line.id === "line-3"));
  assert.ok(result.some((line) => line.id === "line-2"));
  assert.ok(!result.some((line) => line.id === "line-1"));
});

test("replaceSellingFormatPackagingLinesForCosting: lines belonging to a just-removed format disappear along with it, matching the database's cascade", () => {
  // formatIdsUnderThisCosting includes format-removed because it belonged to this costing before
  // the save/delete -- that's what makes its lines vanish even though it isn't in the submission.
  const current = [baseSellingFormatPackagingLine({ id: "line-1", sellingFormatId: "format-removed" })];
  const result = replaceSellingFormatPackagingLinesForCosting(current, ["format-removed", "format-kept"], []);
  assert.deepEqual(result, []);
});

// --- Duplicate-name rejection ---

test("validateSellingFormatsForSave: an empty submission is valid", () => {
  assert.equal(validateSellingFormatsForSave([], []), null);
});

test("validateSellingFormatsForSave: a single well-formed format with a well-formed line is valid", () => {
  const format = baseSellingFormat();
  const line = baseSellingFormatPackagingLine();
  assert.equal(validateSellingFormatsForSave([format], [line]), null);
});

test("validateSellingFormatsForSave: rejects two formats with the same name in one submission", () => {
  const formats = [baseSellingFormat({ id: "format-1", name: "Box of 6" }), baseSellingFormat({ id: "format-2", name: "Box of 6" })];
  const message = validateSellingFormatsForSave(formats, []);
  assert.match(message ?? "", /both named "Box of 6"/);
});

test("validateSellingFormatsForSave: duplicate-name detection is case- and whitespace-insensitive", () => {
  const formats = [baseSellingFormat({ id: "format-1", name: "Box of 6" }), baseSellingFormat({ id: "format-2", name: "  BOX OF 6  " })];
  assert.notEqual(validateSellingFormatsForSave(formats, []), null);
});

test("validateSellingFormatsForSave: the same name under different costings does not conflict", () => {
  const formats = [baseSellingFormat({ id: "format-1", costingId: "costing-1", name: "Box of 6" }), baseSellingFormat({ id: "format-2", costingId: "costing-2", name: "Box of 6" })];
  assert.equal(validateSellingFormatsForSave(formats, []), null);
});

// --- Blank names / non-positive pieces / negative price rejection ---

test("validateSellingFormatsForSave: rejects a blank format name", () => {
  const message = validateSellingFormatsForSave([baseSellingFormat({ name: "   " })], []);
  assert.match(message ?? "", /needs a name/);
});

test("validateSellingFormatsForSave: rejects a non-positive pieces-per-unit", () => {
  const message = validateSellingFormatsForSave([baseSellingFormat({ piecesPerUnit: 0 })], []);
  assert.match(message ?? "", /pieces-per-unit greater than zero/);
});

test("validateSellingFormatsForSave: rejects a negative selling price", () => {
  const message = validateSellingFormatsForSave([baseSellingFormat({ sellingPrice: -5 })], []);
  assert.match(message ?? "", /can't be negative/);
});

test("validateSellingFormatsForSave: a selling price of exactly zero is allowed (not priced yet)", () => {
  assert.equal(validateSellingFormatsForSave([baseSellingFormat({ sellingPrice: 0 })], []), null);
});

// --- Invalid packaging-line rejection ---

test("validateSellingFormatsForSave: rejects a packaging line with a blank name", () => {
  const message = validateSellingFormatsForSave([baseSellingFormat()], [baseSellingFormatPackagingLine({ name: "" })]);
  assert.match(message ?? "", /needs a name, a quantity greater than zero, and a cost greater than zero/);
});

test("validateSellingFormatsForSave: rejects a named packaging line with zero cost", () => {
  const message = validateSellingFormatsForSave([baseSellingFormat()], [baseSellingFormatPackagingLine({ name: "Sticker", unitCostSnapshot: 0 })]);
  assert.notEqual(message, null);
});

test("validateSellingFormatsForSave: rejects a packaging line with non-positive quantity", () => {
  const message = validateSellingFormatsForSave([baseSellingFormat()], [baseSellingFormatPackagingLine({ quantity: 0 })]);
  assert.notEqual(message, null);
});

// --- Duplicate catalog-linked packaging items ---

test("findDuplicateCatalogPackagingLine: two lines linked to the same catalog item in one format is a duplicate", () => {
  const lines = [
    baseSellingFormatPackagingLine({ id: "line-1", sellingFormatId: "format-1", ingredientId: "ingredient-sticker" }),
    baseSellingFormatPackagingLine({ id: "line-2", sellingFormatId: "format-1", ingredientId: "ingredient-sticker" }),
  ];
  const duplicate = findDuplicateCatalogPackagingLine(lines);
  assert.equal(duplicate?.id, "line-2");
});

test("findDuplicateCatalogPackagingLine: the same catalog item in two different formats is not a duplicate", () => {
  const lines = [
    baseSellingFormatPackagingLine({ id: "line-1", sellingFormatId: "format-1", ingredientId: "ingredient-sticker" }),
    baseSellingFormatPackagingLine({ id: "line-2", sellingFormatId: "format-2", ingredientId: "ingredient-sticker" }),
  ];
  assert.equal(findDuplicateCatalogPackagingLine(lines), null);
});

test("findDuplicateCatalogPackagingLine: repeated manual lines (no ingredientId) are never flagged as duplicates", () => {
  const lines = [
    baseSellingFormatPackagingLine({ id: "line-1", sellingFormatId: "format-1", ingredientId: "", name: "Hand-cut wrapper" }),
    baseSellingFormatPackagingLine({ id: "line-2", sellingFormatId: "format-1", ingredientId: "", name: "Hand-cut wrapper" }),
  ];
  assert.equal(findDuplicateCatalogPackagingLine(lines), null);
});

// --- FormData contract (Slice 4 UI <-> Slice 3 parser) ---
//
// Constructs a real FormData object using the exact field names CostingForm's Selling Formats UI
// emits (SellingFormatCard, product-lab.tsx), then runs it through the real Slice 3 parser
// (parseSellingFormatsFromFormData) -- not a re-implementation of it -- and confirms both formats
// and every packaging line mode (catalog-linked and manual) reconstruct correctly. This is the
// one place the UI's field-naming contract is verified against the parser that actually consumes
// it, so the two can never silently drift into two different naming conventions.
test("parseSellingFormatsFromFormData: reconstructs two formats (one catalog-linked + one manual line, one empty) from real FormData built with the UI's exact field names", () => {
  const formData = new FormData();
  formData.set("sellingFormatRowIds", "format-single,format-box");

  // Format 1: "Single Brownie" -- one catalog-linked line, one manual line.
  formData.set("sellingFormatName-format-single", "Single Brownie");
  formData.set("sellingFormatPiecesPerUnit-format-single", "1");
  formData.set("sellingFormatSellingPrice-format-single", "40");
  formData.set("sellingFormatIsActive-format-single", "true");
  formData.set("sellingFormatSortOrder-format-single", "0");
  formData.set("sellingFormatNotes-format-single", "");
  formData.set("sellingFormatPackagingLineRowIds-format-single", "line-wrapper,line-sticker");

  formData.set("sellingFormatPackagingLineIngredientId-line-wrapper", "ingredient-wrapper");
  formData.set("sellingFormatPackagingLineName-line-wrapper", "Individual wrapper");
  formData.set("sellingFormatPackagingLineQuantity-line-wrapper", "1");
  formData.set("sellingFormatPackagingLineUnit-line-wrapper", "pcs");
  formData.set("sellingFormatPackagingLineUnitCostSnapshot-line-wrapper", "0.275");
  formData.set("sellingFormatPackagingLineIsManualCost-line-wrapper", "false");
  formData.set("sellingFormatPackagingLineNote-line-wrapper", "");
  formData.set("sellingFormatPackagingLineSortOrder-line-wrapper", "0");

  formData.set("sellingFormatPackagingLineIngredientId-line-sticker", "");
  formData.set("sellingFormatPackagingLineName-line-sticker", "Hand-cut sticker");
  formData.set("sellingFormatPackagingLineQuantity-line-sticker", "1");
  formData.set("sellingFormatPackagingLineUnit-line-sticker", "pcs");
  formData.set("sellingFormatPackagingLineUnitCostSnapshot-line-sticker", "2");
  formData.set("sellingFormatPackagingLineIsManualCost-line-sticker", "true");
  formData.set("sellingFormatPackagingLineNote-line-sticker", "cut by hand");
  formData.set("sellingFormatPackagingLineSortOrder-line-sticker", "1");

  // Format 2: "Box of 6" -- archived (isActive "false"), zero packaging lines.
  formData.set("sellingFormatName-format-box", "Box of 6");
  formData.set("sellingFormatPiecesPerUnit-format-box", "6");
  formData.set("sellingFormatSellingPrice-format-box", "250");
  formData.set("sellingFormatIsActive-format-box", "false");
  formData.set("sellingFormatSortOrder-format-box", "1");
  formData.set("sellingFormatNotes-format-box", "seasonal");
  formData.set("sellingFormatPackagingLineRowIds-format-box", "");

  const { sellingFormats, sellingFormatPackagingLines } = parseSellingFormatsFromFormData(formData, "costing-42");

  assert.equal(sellingFormats.length, 2);
  assert.deepEqual(sellingFormats[0], {
    id: "format-single",
    costingId: "costing-42",
    name: "Single Brownie",
    piecesPerUnit: 1,
    sellingPrice: 40,
    isActive: true,
    sortOrder: 0,
    notes: "",
  });
  assert.deepEqual(sellingFormats[1], {
    id: "format-box",
    costingId: "costing-42",
    name: "Box of 6",
    piecesPerUnit: 6,
    sellingPrice: 250,
    isActive: false,
    sortOrder: 1,
    notes: "seasonal",
  });

  assert.equal(sellingFormatPackagingLines.length, 2);
  assert.deepEqual(sellingFormatPackagingLines[0], {
    id: "line-wrapper",
    sellingFormatId: "format-single",
    ingredientId: "ingredient-wrapper",
    name: "Individual wrapper",
    quantity: 1,
    unit: "pcs",
    unitCostSnapshot: 0.275,
    isManualCost: false,
    note: "",
    sortOrder: 0,
  });
  assert.deepEqual(sellingFormatPackagingLines[1], {
    id: "line-sticker",
    sellingFormatId: "format-single",
    ingredientId: "",
    name: "Hand-cut sticker",
    quantity: 1,
    unit: "pcs",
    unitCostSnapshot: 2,
    isManualCost: true,
    note: "cut by hand",
    sortOrder: 1,
  });

  // The reconstructed formats/lines must themselves be valid per the same Slice 3 validation gate.
  assert.equal(validateSellingFormatsForSave(sellingFormats, sellingFormatPackagingLines), null);
});

test("parseSellingFormatsFromFormData: an entirely absent contract (no UI rendered yet) parses to empty arrays, not an error", () => {
  const formData = new FormData();
  const { sellingFormats, sellingFormatPackagingLines } = parseSellingFormatsFromFormData(formData, "costing-1");
  assert.deepEqual(sellingFormats, []);
  assert.deepEqual(sellingFormatPackagingLines, []);
});

test("parseSellingFormatsFromFormData: every parsed format is stamped with the caller's resolved costingId, never read from the form itself", () => {
  const formData = new FormData();
  formData.set("sellingFormatRowIds", "format-1");
  formData.set("sellingFormatName-format-1", "Single Brownie");
  formData.set("sellingFormatPiecesPerUnit-format-1", "1");
  formData.set("sellingFormatPackagingLineRowIds-format-1", "");

  const { sellingFormats } = parseSellingFormatsFromFormData(formData, "resolved-costing-id");
  assert.equal(sellingFormats[0]?.costingId, "resolved-costing-id");
});

test("validateSellingFormatsForSave: rejects a duplicate catalog-linked packaging item within one format", () => {
  const lines = [
    baseSellingFormatPackagingLine({ id: "line-1", sellingFormatId: "format-1", ingredientId: "ingredient-sticker", isManualCost: false }),
    baseSellingFormatPackagingLine({ id: "line-2", sellingFormatId: "format-1", ingredientId: "ingredient-sticker", isManualCost: false, name: "Sticker (2)" }),
  ];
  const message = validateSellingFormatsForSave([baseSellingFormat()], lines);
  assert.match(message ?? "", /linked to the same catalog item twice/);
});
