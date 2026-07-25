import test from "node:test";
import assert from "node:assert/strict";
import { emptyState } from "../src/lib/lab-state.ts";
import { buildDeletedLabel, purgeFromState, restoreToState, softDeleteFromState } from "../src/lib/recycle-bin.ts";
import type { LabState } from "../src/lib/lab-state.ts";
import type { ProductBatch, SupplyEntry } from "../src/lib/product-lab-types.ts";

function batch(overrides: Partial<ProductBatch> = {}): ProductBatch {
  return {
    id: "batch-1",
    productId: "product-1",
    batchVersion: "V1",
    dateMade: "2026-07-01",
    ingredientsNotes: "",
    prepTimeMinutes: 0,
    bakeTimeMinutes: 0,
    coolingTimeMinutes: 0,
    usablePieces: 0,
    imperfectPieces: 0,
    stressLevel: 3,
    tasteNotes: "",
    textureNotes: "",
    wentWrong: "",
    improveNext: "",
    launchDecision: "retest",
    ...overrides,
  };
}

function supply(overrides: Partial<SupplyEntry> = {}): SupplyEntry {
  return {
    id: "supply-1",
    ingredientName: "Cocoa Powder",
    brandName: "Beryl's",
    supplierName: "SM",
    purchaseDate: "2026-07-01",
    createdAt: "2026-07-01T00:00:00.000Z",
    packQuantity: 1000,
    unit: "g",
    totalCost: 360,
    qualityRating: 4,
    notes: "",
    ...overrides,
  };
}

const productName = (id: string) => (id === "product-1" ? "Brownies" : id);

test("softDeleteFromState moves a batch out of the active list into deletedRecords", () => {
  const state: LabState = { ...emptyState, batches: [batch()] };

  const next = softDeleteFromState(state, "batch", "batch-1", "Brownies V1", "2026-07-24T00:00:00.000Z");

  assert.equal(next.batches.length, 0);
  assert.equal(next.deletedRecords.length, 1);
  assert.equal(next.deletedRecords[0].kind, "batch");
  assert.equal(next.deletedRecords[0].id, "batch-1");
  assert.equal(next.deletedRecords[0].label, "Brownies V1");
});

test("softDeleteFromState is a no-op (same reference) when the id isn't found", () => {
  const state: LabState = { ...emptyState, batches: [batch()] };

  const next = softDeleteFromState(state, "batch", "missing", "x", "2026-07-24T00:00:00.000Z");

  assert.equal(next, state);
});

test("restoreToState puts the record back into its active array and clears the tombstone", () => {
  const deleted = softDeleteFromState({ ...emptyState, supplies: [supply()] }, "supply", "supply-1", "Beryl's Cocoa Powder", "2026-07-24T00:00:00.000Z");

  const restored = restoreToState(deleted, "supply-1");

  assert.equal(restored.supplies.length, 1);
  assert.equal(restored.supplies[0].id, "supply-1");
  assert.equal(restored.deletedRecords.length, 0);
});

test("restoreToState is a no-op when the id isn't in the bin", () => {
  const state: LabState = { ...emptyState };
  assert.equal(restoreToState(state, "nope"), state);
});

test("purgeFromState removes the tombstone without touching active arrays", () => {
  const deleted = softDeleteFromState({ ...emptyState, batches: [batch()] }, "batch", "batch-1", "Brownies V1", "2026-07-24T00:00:00.000Z");

  const purged = purgeFromState(deleted, "batch-1");

  assert.equal(purged.deletedRecords.length, 0);
  assert.equal(purged.batches.length, 0);
});

test("soft delete then restore round-trips the record unchanged", () => {
  const original = supply({ notes: "keep me" });
  const deleted = softDeleteFromState({ ...emptyState, supplies: [original] }, "supply", "supply-1", "label", "2026-07-24T00:00:00.000Z");

  const restored = restoreToState(deleted, "supply-1");

  assert.deepEqual(restored.supplies[0], original);
});

test("buildDeletedLabel formats each kind readably", () => {
  assert.equal(buildDeletedLabel("batch", batch(), productName), "Brownies V1");
  assert.equal(buildDeletedLabel("supply", supply(), productName), "Beryl's Cocoa Powder");
});
