import { areFormDataSnapshotsEqual, buildFormDataSnapshot, type FormDataSnapshot } from "./form-data-snapshot.ts";

// Fields present in BatchForm's FormData that aren't user-editable content, excluded so they can
// never contribute a false dirty state:
//  - "id" (the pre-generated formBatchId) and "existingId" never change within one mounted
//    instance -- pure plumbing, not something the operator edits.
//  - "batchIngredientRowIds" is a derived, comma-joined list of formula rowIds. Formula rows have
//    no reorder UI (add/remove only), so this field can never carry order-only information beyond
//    what row membership/content already captures -- excluded as bookkeeping, same as `rowId`.
// "batchProcessStepRowIds" is deliberately NOT in this list: process steps *do* support
// drag-reorder (see BatchForm's startStepDrag/dragStep), and every step's own text field is keyed
// by a stable, reorder-invariant rowId -- meaning this comma-joined, order-encoding field is the
// *only* place a pure reorder (no text change) would ever show up in a FormData-based snapshot.
// Leaving it out would silently make step reordering invisible to dirty-tracking.
const EXCLUDED_BATCH_FORM_FIELD_NAMES = ["id", "existingId", "batchIngredientRowIds"];

export type BatchFormSnapshot = {
  fields: FormDataSnapshot;
  // Staged photos (new-batch only -- an existing batch's photos upload immediately, never staged)
  // hold live File handles with no FormData representation, so they're tracked as a plain count
  // alongside the form fields rather than folded into them.
  stagedPhotoCount: number;
};

export function buildBatchFormSnapshot(formData: FormData, stagedPhotoCount: number): BatchFormSnapshot {
  return {
    fields: buildFormDataSnapshot(formData, EXCLUDED_BATCH_FORM_FIELD_NAMES),
    stagedPhotoCount,
  };
}

export function areBatchFormSnapshotsEqual(a: BatchFormSnapshot, b: BatchFormSnapshot): boolean {
  return a.stagedPhotoCount === b.stagedPhotoCount && areFormDataSnapshotsEqual(a.fields, b.fields);
}

export function isBatchFormDirty(live: BatchFormSnapshot, baseline: BatchFormSnapshot): boolean {
  return !areBatchFormSnapshotsEqual(live, baseline);
}
