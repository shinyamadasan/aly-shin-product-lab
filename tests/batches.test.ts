import test from "node:test";
import assert from "node:assert/strict";
import { findConflictingBatch, normalizeBatchVersion } from "../src/lib/batches.ts";
import { isDuplicateKeyError } from "../src/lib/costing.ts";
import type { ProductBatch } from "../src/lib/product-lab-types.ts";

function baseBatch(overrides: Partial<ProductBatch> = {}): ProductBatch {
  return {
    id: "batch-1",
    productId: "product-1",
    batchVersion: "V1",
    dateMade: "2026-01-01",
    ingredientsNotes: "",
    prepTimeMinutes: 0,
    bakeTimeMinutes: 0,
    coolingTimeMinutes: 0,
    usablePieces: 0,
    imperfectPieces: 0,
    stressLevel: 0,
    tasteNotes: "",
    textureNotes: "",
    wentWrong: "",
    improveNext: "",
    launchDecision: "retest",
    ...overrides,
  };
}

test("normalizeBatchVersion: trims whitespace and lowercases", () => {
  assert.equal(normalizeBatchVersion("  Brownies V1  "), "brownies v1");
});

// 1. Create Brownies V1 -- succeeds.
test("findConflictingBatch: first batch version for a product succeeds (no conflict)", () => {
  const conflict = findConflictingBatch([], { batchId: "batch-1", productId: "product-1", batchVersion: "Brownies V1" });
  assert.equal(conflict, null);
});

// 2. Create another Brownies V1 -- rejected.
test("findConflictingBatch: a second identical batch version for the same product is rejected", () => {
  const existing = baseBatch({ id: "batch-1", batchVersion: "Brownies V1" });
  const conflict = findConflictingBatch([existing], { batchId: "batch-2", productId: "product-1", batchVersion: "Brownies V1" });
  assert.equal(conflict, existing);
});

// 3. Brownies v1 -- rejected (case-insensitive).
test("findConflictingBatch: a case-only difference is rejected", () => {
  const existing = baseBatch({ id: "batch-1", batchVersion: "Brownies V1" });
  const conflict = findConflictingBatch([existing], { batchId: "batch-2", productId: "product-1", batchVersion: "Brownies v1" });
  assert.equal(conflict, existing);
});

// 4. Leading/trailing spaces -- rejected.
test("findConflictingBatch: leading/trailing whitespace is rejected", () => {
  const existing = baseBatch({ id: "batch-1", batchVersion: "Brownies V1" });
  const conflict = findConflictingBatch([existing], { batchId: "batch-2", productId: "product-1", batchVersion: "  Brownies V1  " });
  assert.equal(conflict, existing);
});

// 5. Edit existing Brownies V1 -- succeeds (excludes itself).
test("findConflictingBatch: editing a batch without changing its version succeeds", () => {
  const existing = baseBatch({ id: "batch-1", batchVersion: "Brownies V1" });
  const conflict = findConflictingBatch([existing], { batchId: "batch-1", productId: "product-1", batchVersion: "Brownies V1" });
  assert.equal(conflict, null);
});

// 6. Rename Brownies V2 -> V1 -- rejected.
test("findConflictingBatch: renaming one batch onto another batch's existing version is rejected", () => {
  const v1 = baseBatch({ id: "batch-1", batchVersion: "Brownies V1" });
  const v2 = baseBatch({ id: "batch-2", batchVersion: "Brownies V2" });
  const conflict = findConflictingBatch([v1, v2], { batchId: "batch-2", productId: "product-1", batchVersion: "Brownies V1" });
  assert.equal(conflict, v1);
});

// 7. Cookies V1 -- allowed (different product).
test("findConflictingBatch: the same version string on a different product does not conflict", () => {
  const existing = baseBatch({ id: "batch-1", productId: "product-1", batchVersion: "Brownies V1" });
  const conflict = findConflictingBatch([existing], { batchId: "batch-2", productId: "product-2", batchVersion: "Cookies V1" });
  assert.equal(conflict, null);
});

// 8. 23505 becomes a friendly UI message -- saveBatch (src/app/product-lab.tsx) branches on this
// exact check, reusing costing.ts's already-generic isDuplicateKeyError instead of duplicating it.
test("isDuplicateKeyError: Postgres 23505 is recognized as a duplicate-key error", () => {
  assert.equal(isDuplicateKeyError({ code: "23505" }), true);
});

test("isDuplicateKeyError: other error codes and missing errors are not duplicate-key errors", () => {
  assert.equal(isDuplicateKeyError({ code: "23514" }), false);
  assert.equal(isDuplicateKeyError(null), false);
  assert.equal(isDuplicateKeyError(undefined), false);
});
