import type { ColumnMapping } from "./csv-column-mapping.ts";
import type { ParsedCsv } from "./csv-parser.ts";

// The Purchase Import Wizard's pre-draft phase (uploading a CSV and fixing its column mapping,
// before createPurchaseImportDraft persists anything) has no <form> at all -- just a file input, a
// handful of <select>s, and a "Continue to preview" button wired straight to state setters -- so
// this compares React state directly rather than reading FormData, unlike every other snapshot in
// this codebase (form-data-snapshot.ts and its per-form wrappers).
//
// The baseline is always the wizard's pristine, nothing-uploaded state -- not "whatever the
// mapping looked like right after upload" -- because any loaded CSV already represents real work
// (uploading, at minimum, plus whatever auto-mapping ran) that would need to be redone if lost,
// regardless of whether the mapping itself has since been hand-edited or reverted back to its
// original auto-suggested value. A freshly uploaded, untouched CSV is already dirty; reverting a
// hand-edited mapping back to its original value does not clear dirty state while the CSV remains
// loaded. See CLEAN_PURCHASE_IMPORT_DRAFT_SNAPSHOT below -- the wizard always diffs its current
// state against this fixed constant, never against a "state as of upload" snapshot.
export type PurchaseImportDraftSnapshot = {
  csvHeaders: string[] | null;
  csvRows: string[][] | null;
  fileName: string;
  mapping: ColumnMapping;
};

export const CLEAN_PURCHASE_IMPORT_DRAFT_SNAPSHOT: PurchaseImportDraftSnapshot = {
  csvHeaders: null,
  csvRows: null,
  fileName: "",
  mapping: {},
};

export function buildPurchaseImportDraftSnapshot(parsedCsv: ParsedCsv | null, fileName: string, mapping: ColumnMapping): PurchaseImportDraftSnapshot {
  return {
    csvHeaders: parsedCsv?.headers ?? null,
    csvRows: parsedCsv?.rows ?? null,
    fileName,
    mapping,
  };
}

function areStringArraysEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

// ParsedCsv's own shape (headers: string[]; rows: string[][], see csv-parser.ts) is already an
// order-stable, unambiguous structure -- comparing it element-by-element is a stable canonical
// comparison on its own, with no need for a hash/digest (and no non-deterministic serialization
// risk like JSON.stringify's incidental key-order dependence, which doesn't even apply here since
// these are arrays, not objects with independently-ordered keys).
function areCsvRowsEqual(a: string[][] | null, b: string[][] | null): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return a.length === b.length && a.every((row, index) => areStringArraysEqual(row, b[index]));
}

// Column-mapping <select>s set an explicit `undefined` (not a deleted key) when the operator picks
// "-- not mapped --" (see PurchaseImportWizard's setMapping call), so two mappings that are
// meaningfully identical can still differ in raw key presence -- only keys with a real value count.
function isMappingEqual(a: ColumnMapping, b: ColumnMapping): boolean {
  const aKeys = (Object.keys(a) as Array<keyof ColumnMapping>).filter((key) => a[key] !== undefined);
  const bKeys = (Object.keys(b) as Array<keyof ColumnMapping>).filter((key) => b[key] !== undefined);
  if (aKeys.length !== bKeys.length) {
    return false;
  }
  return aKeys.every((key) => a[key] === b[key]);
}

export function arePurchaseImportDraftSnapshotsEqual(a: PurchaseImportDraftSnapshot, b: PurchaseImportDraftSnapshot): boolean {
  const headersEqual = a.csvHeaders === null || b.csvHeaders === null ? a.csvHeaders === b.csvHeaders : areStringArraysEqual(a.csvHeaders, b.csvHeaders);
  return a.fileName === b.fileName && headersEqual && areCsvRowsEqual(a.csvRows, b.csvRows) && isMappingEqual(a.mapping, b.mapping);
}

export function isPurchaseImportDraftDirty(live: PurchaseImportDraftSnapshot, baseline: PurchaseImportDraftSnapshot): boolean {
  return !arePurchaseImportDraftSnapshotsEqual(live, baseline);
}
