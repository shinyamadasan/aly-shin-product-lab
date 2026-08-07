// A generic FormData-to-comparable-object reducer, for forms whose fields are majority
// uncontrolled (native `defaultValue`, no mirroring React state) -- CostingForm's own
// costing-form-snapshot.ts works by diffing typed state directly, which only works because every
// field there already is controlled state. Most other forms in this app aren't: reading a form's
// own FormData at baseline-capture time and again at comparison time lets those forms get the same
// dirty-detection without converting a dozen-plus fields to controlled state just to enable it.
//
// This is the one genuinely shared primitive across the new forms adopting this pattern -- the
// mechanism, not a universal snapshot *type*. Each form still defines its own meaningful field set
// (via `excludeNames`) and its own additional non-FormData state to compare alongside this, exactly
// as costing-form-snapshot.ts already does for Selling Formats.
export type FormDataSnapshot = Record<string, string[]>;

// File entries are represented by name+size+lastModified rather than stringified (which would
// collapse every File to the unhelpful, always-equal "[object File]") -- still comparable, without
// pretending file *content* can be diffed.
function formDataValueToString(value: FormDataEntryValue): string {
  return typeof value === "string" ? value : `${value.name}:${value.size}:${value.lastModified}`;
}

export function buildFormDataSnapshot(formData: FormData, excludeNames: string[] = []): FormDataSnapshot {
  const excluded = new Set(excludeNames);
  const snapshot: FormDataSnapshot = {};
  for (const key of new Set(formData.keys())) {
    if (excluded.has(key)) {
      continue;
    }
    snapshot[key] = formData.getAll(key).map(formDataValueToString);
  }
  return snapshot;
}

// Explicit key-by-key, value-by-value comparison -- deliberately not JSON.stringify(a) ===
// JSON.stringify(b), for the same reason costing-form-snapshot.ts avoids it: immune to incidental
// key-insertion order, which a plain object built from FormData.keys() iteration order isn't
// guaranteed to avoid across two independently-built snapshots.
export function areFormDataSnapshotsEqual(a: FormDataSnapshot, b: FormDataSnapshot): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) {
    return false;
  }
  return aKeys.every((key) => {
    const aValues = a[key];
    const bValues = b[key];
    return bValues !== undefined && aValues.length === bValues.length && aValues.every((value, index) => value === bValues[index]);
  });
}
