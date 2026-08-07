import { areFormDataSnapshotsEqual, buildFormDataSnapshot, type FormDataSnapshot } from "./form-data-snapshot.ts";

// "productId" and "batchId" are the only fields in the tasting checkpoint form's FormData that
// aren't user-editable content -- both are hidden inputs mirroring BatchTastingSection's own
// props, fixed for the lifetime of one open checkpoint form (this form has no "edit existing
// tasting" mode at all -- see the comment on BatchTastingSection itself -- so there's no id field
// to exclude the way BatchForm/PurchaseLogPage exclude theirs). Every other field (timeLabel,
// tasterName, rating, willingToPay, liked, improve, wouldBuy, wouldReorder, packagingReaction) is
// real, editable TastingFeedback content.
const EXCLUDED_TASTING_FORM_FIELD_NAMES = ["productId", "batchId"];

// No controlled sub-state needs tracking alongside FormData -- every field on this form is a plain
// uncontrolled Input/Textarea/Select, so a pure FormData snapshot is the whole picture.
export type TastingFormSnapshot = FormDataSnapshot;

export function buildTastingFormSnapshot(formData: FormData): TastingFormSnapshot {
  return buildFormDataSnapshot(formData, EXCLUDED_TASTING_FORM_FIELD_NAMES);
}

export function areTastingFormSnapshotsEqual(a: TastingFormSnapshot, b: TastingFormSnapshot): boolean {
  return areFormDataSnapshotsEqual(a, b);
}

export function isTastingFormDirty(live: TastingFormSnapshot, baseline: TastingFormSnapshot): boolean {
  return !areTastingFormSnapshotsEqual(live, baseline);
}
