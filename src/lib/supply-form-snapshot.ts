import { areFormDataSnapshotsEqual, buildFormDataSnapshot, type FormDataSnapshot } from "./form-data-snapshot.ts";

// "id" is the only field in the Supply purchase form's FormData that isn't user-editable content
// -- pure plumbing, same reasoning as every other form-specific snapshot in this codebase (see
// batch-form-snapshot.ts, ingredient-form-snapshot.ts). Every other field
// (ingredientId/ingredientName from SupplyIngredientField, brandName/supplierName/unit from
// SupplyValuePicker, purchaseDate/packQuantity/totalCost/qualityRating/notes) is a real, editable,
// persisted value on SupplyEntry -- see PurchaseLogPage in product-lab.tsx.
const EXCLUDED_SUPPLY_FORM_FIELD_NAMES = ["id"];

// No controlled sub-state needs tracking alongside FormData here (unlike BatchFormSnapshot's
// stagedPhotoCount) -- every editable value on this form is mirrored into a real or hidden
// FormData field, so a pure FormData snapshot is the whole picture.
export type SupplyFormSnapshot = FormDataSnapshot;

export function buildSupplyFormSnapshot(formData: FormData): SupplyFormSnapshot {
  return buildFormDataSnapshot(formData, EXCLUDED_SUPPLY_FORM_FIELD_NAMES);
}

export function areSupplyFormSnapshotsEqual(a: SupplyFormSnapshot, b: SupplyFormSnapshot): boolean {
  return areFormDataSnapshotsEqual(a, b);
}

export function isSupplyFormDirty(live: SupplyFormSnapshot, baseline: SupplyFormSnapshot): boolean {
  return !areSupplyFormSnapshotsEqual(live, baseline);
}
