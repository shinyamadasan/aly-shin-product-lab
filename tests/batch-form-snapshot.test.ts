import test from "node:test";
import assert from "node:assert/strict";
import { areBatchFormSnapshotsEqual, buildBatchFormSnapshot, isBatchFormDirty } from "../src/lib/batch-form-snapshot.ts";

// Mirrors a real BatchForm submission for one formula row + one process step row, matching the
// exact field-name convention buildBatchIngredientsNotes (product-lab.tsx) reads back out:
// batchQuantity-{rowId}, batchUnit-{rowId}, batchIngredientStep-{rowId}, batchBrand-{rowId},
// batchIngredient-{rowId}, batchChange-{rowId}, batchProcessStep-{rowId}, plus the two
// rowIds-list hidden inputs and the top-level scalar fields.
function batchFormData(
  overrides: Partial<{
    id: string;
    existingId: string;
    productId: string;
    batchVersion: string;
    dateMade: string;
    tasteNotes: string;
    prepTimeMinutes: string;
    bakeTimeMinutes: string;
    coolingTimeMinutes: string;
    usablePieces: string;
    imperfectPieces: string;
    stressLevel: string;
    textureNotes: string;
    wentWrong: string;
    improveNext: string;
    launchDecision: string;
    formulaRowIds: string[];
    formulaRows: Record<string, { brand: string; ingredient: string; quantity: string; unit: string; change: string; step: string }>;
    stepRowIds: string[];
    stepRows: Record<string, string>;
  }> = {},
): FormData {
  const formulaRowIds = overrides.formulaRowIds ?? ["formula-1"];
  const formulaRows = overrides.formulaRows ?? { "formula-1": { brand: "Beryl's", ingredient: "Cocoa Powder", quantity: "50", unit: "g", change: "", step: "First mix" } };
  const stepRowIds = overrides.stepRowIds ?? ["step-1"];
  const stepRows = overrides.stepRows ?? { "step-1": "Cream butter and sugar for 3 minutes" };

  const data = new FormData();
  data.append("id", overrides.id ?? "batch-form-id");
  data.append("existingId", overrides.existingId ?? "batch-1");
  data.append("productId", overrides.productId ?? "product-1");
  data.append("batchVersion", overrides.batchVersion ?? "Brownies V2");
  data.append("dateMade", overrides.dateMade ?? "2026-08-06");
  data.append("tasteNotes", overrides.tasteNotes ?? "Less dry, chocolate stronger.");
  data.append("prepTimeMinutes", overrides.prepTimeMinutes ?? "35");
  data.append("bakeTimeMinutes", overrides.bakeTimeMinutes ?? "25");
  data.append("coolingTimeMinutes", overrides.coolingTimeMinutes ?? "60");
  data.append("usablePieces", overrides.usablePieces ?? "12");
  data.append("imperfectPieces", overrides.imperfectPieces ?? "2");
  data.append("stressLevel", overrides.stressLevel ?? "3");
  data.append("textureNotes", overrides.textureNotes ?? "Still fudgy after 2 hours.");
  data.append("wentWrong", overrides.wentWrong ?? "Edges overbaked.");
  data.append("improveNext", overrides.improveNext ?? "Retest at 24 min.");
  data.append("launchDecision", overrides.launchDecision ?? "retest");

  data.append("batchIngredientRowIds", formulaRowIds.join(","));
  for (const rowId of formulaRowIds) {
    const row = formulaRows[rowId];
    data.append(`batchBrand-${rowId}`, row.brand);
    data.append(`batchIngredient-${rowId}`, row.ingredient);
    data.append(`batchQuantity-${rowId}`, row.quantity);
    data.append(`batchUnit-${rowId}`, row.unit);
    data.append(`batchChange-${rowId}`, row.change);
    data.append(`batchIngredientStep-${rowId}`, row.step);
  }

  data.append("batchProcessStepRowIds", stepRowIds.join(","));
  for (const rowId of stepRowIds) {
    data.append(`batchProcessStep-${rowId}`, stepRows[rowId]);
  }

  return data;
}

test("an identical form is clean", () => {
  const baseline = buildBatchFormSnapshot(batchFormData(), 0);
  const live = buildBatchFormSnapshot(batchFormData(), 0);
  assert.equal(isBatchFormDirty(live, baseline), false);
});

test("a changed scalar field (e.g. taste notes) is dirty", () => {
  const baseline = buildBatchFormSnapshot(batchFormData(), 0);
  const live = buildBatchFormSnapshot(batchFormData({ tasteNotes: "Updated: too sweet now." }), 0);
  assert.equal(isBatchFormDirty(live, baseline), true);
});

test("changing a field then restoring its original value returns to clean", () => {
  const baseline = buildBatchFormSnapshot(batchFormData(), 0);
  const changed = buildBatchFormSnapshot(batchFormData({ stressLevel: "5" }), 0);
  assert.equal(isBatchFormDirty(changed, baseline), true);

  const reverted = buildBatchFormSnapshot(batchFormData({ stressLevel: "3" }), 0);
  assert.equal(isBatchFormDirty(reverted, baseline), false);
});

test("adding then removing a formula row returns to clean", () => {
  const baseline = buildBatchFormSnapshot(batchFormData(), 0);

  const withAddedRow = buildBatchFormSnapshot(
    batchFormData({
      formulaRowIds: ["formula-1", "formula-2"],
      formulaRows: {
        "formula-1": { brand: "Beryl's", ingredient: "Cocoa Powder", quantity: "50", unit: "g", change: "", step: "First mix" },
        "formula-2": { brand: "Selecta", ingredient: "Butter", quantity: "100", unit: "g", change: "", step: "First mix" },
      },
    }),
    0,
  );
  assert.equal(isBatchFormDirty(withAddedRow, baseline), true);

  const afterRemovingIt = buildBatchFormSnapshot(batchFormData(), 0);
  assert.equal(isBatchFormDirty(afterRemovingIt, baseline), false);
});

test("adding then removing a process step row returns to clean", () => {
  const baseline = buildBatchFormSnapshot(batchFormData(), 0);

  const withAddedStep = buildBatchFormSnapshot(
    batchFormData({
      stepRowIds: ["step-1", "step-2"],
      stepRows: { "step-1": "Cream butter and sugar for 3 minutes", "step-2": "Fold in cocoa powder" },
    }),
    0,
  );
  assert.equal(isBatchFormDirty(withAddedStep, baseline), true);

  const afterRemovingIt = buildBatchFormSnapshot(batchFormData(), 0);
  assert.equal(isBatchFormDirty(afterRemovingIt, baseline), false);
});

test("reordering process steps (no text change) is dirty, since drag-reorder is a real feature", () => {
  const baseline = buildBatchFormSnapshot(
    batchFormData({
      stepRowIds: ["step-1", "step-2"],
      stepRows: { "step-1": "Cream butter and sugar", "step-2": "Fold in cocoa powder" },
    }),
    0,
  );
  const reordered = buildBatchFormSnapshot(
    batchFormData({
      stepRowIds: ["step-2", "step-1"],
      stepRows: { "step-1": "Cream butter and sugar", "step-2": "Fold in cocoa powder" },
    }),
    0,
  );
  assert.equal(isBatchFormDirty(reordered, baseline), true);
});

test("reordering formula rows alone does not register, since there is no reorder UI for them (order is excluded bookkeeping)", () => {
  const baseline = buildBatchFormSnapshot(
    batchFormData({
      formulaRowIds: ["formula-1", "formula-2"],
      formulaRows: {
        "formula-1": { brand: "Beryl's", ingredient: "Cocoa Powder", quantity: "50", unit: "g", change: "", step: "First mix" },
        "formula-2": { brand: "Selecta", ingredient: "Butter", quantity: "100", unit: "g", change: "", step: "First mix" },
      },
    }),
    0,
  );
  const reordered = buildBatchFormSnapshot(
    batchFormData({
      formulaRowIds: ["formula-2", "formula-1"],
      formulaRows: {
        "formula-1": { brand: "Beryl's", ingredient: "Cocoa Powder", quantity: "50", unit: "g", change: "", step: "First mix" },
        "formula-2": { brand: "Selecta", ingredient: "Butter", quantity: "100", unit: "g", change: "", step: "First mix" },
      },
    }),
    0,
  );
  assert.equal(isBatchFormDirty(reordered, baseline), false);
});

// Note on this architecture's rowId handling, unlike costing-form-snapshot.ts's: Costing tracks
// rows as an array of objects, where `rowId` is one property among several and can be excluded
// from the comparison independently of the row's content. Here, `rowId` is embedded *in the
// FormData field name itself* (batchQuantity-{rowId}, etc.), so two rows with identical content
// but genuinely different rowIds necessarily produce different field keys -- there is no way to
// "exclude rowId" without discarding row identity entirely. This is not a gap in practice: within
// one mounted BatchForm instance a row's rowId is assigned once (at mount or at add-time) and
// never regenerates for a row that's merely edited, so baseline and live only ever disagree on a
// row's key when a row was genuinely added or removed -- exactly the case the add/remove tests
// above already cover. What this test actually verifies: an arbitrary, unpredictable
// (crypto.randomUUID()-shaped) rowId works through that same add-then-remove path just as well as
// the tidy "formula-1"/"formula-2" ids used elsewhere in this file -- the mechanism never assumes
// a particular rowId format.
test("add-then-remove returns to clean regardless of the rowId's exact shape", () => {
  const baseline = buildBatchFormSnapshot(batchFormData(), 0);
  const addedRowId = "550e8400-e29b-41d4-a716-446655440000";
  const withAddedRow = buildBatchFormSnapshot(
    batchFormData({
      formulaRowIds: ["formula-1", addedRowId],
      formulaRows: {
        "formula-1": { brand: "Beryl's", ingredient: "Cocoa Powder", quantity: "50", unit: "g", change: "", step: "First mix" },
        [addedRowId]: { brand: "Selecta", ingredient: "Butter", quantity: "100", unit: "g", change: "", step: "First mix" },
      },
    }),
    0,
  );
  assert.equal(isBatchFormDirty(withAddedRow, baseline), true);

  const afterRemovingIt = buildBatchFormSnapshot(batchFormData(), 0);
  assert.equal(isBatchFormDirty(afterRemovingIt, baseline), false);
});

test("staged photo count changes are dirty, and returning to the baseline count is clean", () => {
  const baseline = buildBatchFormSnapshot(batchFormData(), 0);

  const withStagedPhoto = buildBatchFormSnapshot(batchFormData(), 1);
  assert.equal(isBatchFormDirty(withStagedPhoto, baseline), true);

  const afterRemovingIt = buildBatchFormSnapshot(batchFormData(), 0);
  assert.equal(isBatchFormDirty(afterRemovingIt, baseline), false);
});

test("the pre-generated formBatchId (id) and existingId never contribute to dirty state even when they differ", () => {
  const baseline = buildBatchFormSnapshot(batchFormData({ id: "id-a", existingId: "existing-a" }), 0);
  const live = buildBatchFormSnapshot(batchFormData({ id: "id-b", existingId: "existing-b" }), 0);
  assert.equal(areBatchFormSnapshotsEqual(live, baseline), true);
});

test("changed product selection is dirty", () => {
  const baseline = buildBatchFormSnapshot(batchFormData({ productId: "product-1" }), 0);
  const live = buildBatchFormSnapshot(batchFormData({ productId: "product-2" }), 0);
  assert.equal(isBatchFormDirty(live, baseline), true);
});
