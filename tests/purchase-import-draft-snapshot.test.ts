import test from "node:test";
import assert from "node:assert/strict";
import {
  CLEAN_PURCHASE_IMPORT_DRAFT_SNAPSHOT,
  arePurchaseImportDraftSnapshotsEqual,
  buildPurchaseImportDraftSnapshot,
  isPurchaseImportDraftDirty,
} from "../src/lib/purchase-import-draft-snapshot.ts";
import type { ParsedCsv } from "../src/lib/csv-parser.ts";
import type { ColumnMapping } from "../src/lib/csv-column-mapping.ts";

function sampleCsv(overrides: Partial<ParsedCsv> = {}): ParsedCsv {
  return {
    headers: overrides.headers ?? ["Item", "Brand", "Qty", "Unit", "Total"],
    rows: overrides.rows ?? [
      ["Cocoa Powder", "Beryl's", "1000", "g", "450"],
      ["Butter", "Selecta", "500", "g", "200"],
    ],
  };
}

const sampleMapping: ColumnMapping = { itemName: "Item", brand: "Brand", quantity: "Qty", unit: "Unit", totalPrice: "Total" };

test("empty initial state is clean", () => {
  const live = buildPurchaseImportDraftSnapshot(null, "", {});
  assert.equal(isPurchaseImportDraftDirty(live, CLEAN_PURCHASE_IMPORT_DRAFT_SNAPSHOT), false);
});

test("a loaded CSV is dirty, even with untouched auto-suggested mapping", () => {
  const live = buildPurchaseImportDraftSnapshot(sampleCsv(), "receipt.csv", sampleMapping);
  assert.equal(isPurchaseImportDraftDirty(live, CLEAN_PURCHASE_IMPORT_DRAFT_SNAPSHOT), true);
});

test("a changed mapping (CSV still loaded) is dirty", () => {
  const live = buildPurchaseImportDraftSnapshot(sampleCsv(), "receipt.csv", { ...sampleMapping, category: "Category" });
  assert.equal(isPurchaseImportDraftDirty(live, CLEAN_PURCHASE_IMPORT_DRAFT_SNAPSHOT), true);
});

test("reverting a hand-edited mapping back to its original value is still dirty while the CSV remains loaded", () => {
  const csv = sampleCsv();
  const afterUpload = buildPurchaseImportDraftSnapshot(csv, "receipt.csv", sampleMapping);
  const handEdited = buildPurchaseImportDraftSnapshot(csv, "receipt.csv", { ...sampleMapping, brand: undefined });
  const reverted = buildPurchaseImportDraftSnapshot(csv, "receipt.csv", sampleMapping);

  // The mapping edit itself is a real content change...
  assert.equal(arePurchaseImportDraftSnapshotsEqual(handEdited, afterUpload), false);
  // ...but reverting it doesn't matter for the wizard's own dirty rule -- it always compares
  // against the pristine empty baseline, and the CSV is still loaded either way.
  assert.equal(isPurchaseImportDraftDirty(reverted, CLEAN_PURCHASE_IMPORT_DRAFT_SNAPSHOT), true);
  assert.equal(isPurchaseImportDraftDirty(handEdited, CLEAN_PURCHASE_IMPORT_DRAFT_SNAPSHOT), true);
});

test("resetting/removing the file back to empty is clean", () => {
  const live = buildPurchaseImportDraftSnapshot(null, "", {});
  assert.equal(isPurchaseImportDraftDirty(live, CLEAN_PURCHASE_IMPORT_DRAFT_SNAPSHOT), false);
});

test("the same parsed CSV content with different object identity compares equal", () => {
  const a = buildPurchaseImportDraftSnapshot(sampleCsv(), "receipt.csv", sampleMapping);
  const b = buildPurchaseImportDraftSnapshot(sampleCsv(), "receipt.csv", { ...sampleMapping });
  assert.notEqual(a.csvRows, b.csvRows);
  assert.equal(arePurchaseImportDraftSnapshotsEqual(a, b), true);
});

test("changed parsed CSV content (a different row value) compares dirty", () => {
  const a = buildPurchaseImportDraftSnapshot(sampleCsv(), "receipt.csv", sampleMapping);
  const b = buildPurchaseImportDraftSnapshot(sampleCsv({ rows: [["Cocoa Powder", "Beryl's", "1200", "g", "450"]] }), "receipt.csv", sampleMapping);
  assert.equal(arePurchaseImportDraftSnapshotsEqual(a, b), false);
});

test("a mapping field explicitly set to undefined compares equal to an absent key", () => {
  const a: ColumnMapping = { itemName: "Item", brand: undefined };
  const b: ColumnMapping = { itemName: "Item" };
  const snapshotA = buildPurchaseImportDraftSnapshot(sampleCsv(), "receipt.csv", a);
  const snapshotB = buildPurchaseImportDraftSnapshot(sampleCsv(), "receipt.csv", b);
  assert.equal(arePurchaseImportDraftSnapshotsEqual(snapshotA, snapshotB), true);
});

test("create-draft success transition: a snapshot rebuilt back to the clean constant is clean regardless of prior content", () => {
  const wasDirty = buildPurchaseImportDraftSnapshot(sampleCsv(), "receipt.csv", sampleMapping);
  assert.equal(isPurchaseImportDraftDirty(wasDirty, CLEAN_PURCHASE_IMPORT_DRAFT_SNAPSHOT), true);
  // The wizard itself gates dirty-tracking on `!activeImportId` (see PurchaseImportWizard) rather
  // than clearing this snapshot's own state on success -- this test documents the snapshot-level
  // half of that contract: the clean constant is unaffected by whatever came before it.
  assert.equal(isPurchaseImportDraftDirty(CLEAN_PURCHASE_IMPORT_DRAFT_SNAPSHOT, CLEAN_PURCHASE_IMPORT_DRAFT_SNAPSHOT), false);
});

test("create-draft failure: an unchanged snapshot (CSV/mapping preserved) remains dirty", () => {
  const live = buildPurchaseImportDraftSnapshot(sampleCsv(), "receipt.csv", sampleMapping);
  // A failed createPurchaseImportDraft never clears parsedCsv/fileName/mapping (see
  // PurchaseImportWizard's handleMappingContinue), so the same snapshot the operator had before
  // attempting the save is exactly what gets re-diffed afterward.
  assert.equal(isPurchaseImportDraftDirty(live, CLEAN_PURCHASE_IMPORT_DRAFT_SNAPSHOT), true);
});

test("deterministic comparison: rebuilding the same inputs twice always produces an equal result", () => {
  const csv = sampleCsv();
  const first = buildPurchaseImportDraftSnapshot(csv, "receipt.csv", sampleMapping);
  const second = buildPurchaseImportDraftSnapshot(csv, "receipt.csv", sampleMapping);
  assert.equal(arePurchaseImportDraftSnapshotsEqual(first, second), true);
  assert.equal(arePurchaseImportDraftSnapshotsEqual(second, first), true);
});
