import { areFormDataSnapshotsEqual, buildFormDataSnapshot, type FormDataSnapshot } from "./form-data-snapshot.ts";

// Fields present in the Ingredient form's FormData that aren't user-editable content, excluded so
// they can never contribute a false dirty state:
//  - "id" never changes within one mounted instance -- pure plumbing, not something the operator
//    edits (same reasoning as BatchForm's "id"/"existingId", see batch-form-snapshot.ts).
//  - "currentQuantity" is always a hidden input with no input control anywhere on this form --
//    per inventory-page.tsx's own comment, it's "Locked once an ingredient exists -- later
//    milestones change this through purchases and bakes, not a direct edit." It's persisted, but
//    never something dirty-tracking could catch the operator changing.
const EXCLUDED_INGREDIENT_FORM_FIELD_NAMES = ["id", "currentQuantity"];

// This form has no controlled sub-state that needs tracking alongside FormData (unlike
// BatchFormSnapshot's stagedPhotoCount) -- every editable value here (name, base unit, category,
// low-stock threshold, target stock quantity, nearest expiration date, average unit cost, notes)
// is either a plain uncontrolled input or a hidden input mirrored straight into FormData, so a
// pure FormData snapshot is the whole picture.
export type IngredientFormSnapshot = FormDataSnapshot;

export function buildIngredientFormSnapshot(formData: FormData): IngredientFormSnapshot {
  return buildFormDataSnapshot(formData, EXCLUDED_INGREDIENT_FORM_FIELD_NAMES);
}

export function areIngredientFormSnapshotsEqual(a: IngredientFormSnapshot, b: IngredientFormSnapshot): boolean {
  return areFormDataSnapshotsEqual(a, b);
}

export function isIngredientFormDirty(live: IngredientFormSnapshot, baseline: IngredientFormSnapshot): boolean {
  return !areIngredientFormSnapshotsEqual(live, baseline);
}
