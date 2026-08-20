import test from "node:test";
import assert from "node:assert/strict";
import { diffFormulaRows, findConflictingBatch, normalizeBatchVersion, parseBatchRecord, syncBatchFormulaFromCostingEntries } from "../src/lib/batches.ts";
import { isDuplicateKeyError } from "../src/lib/database-errors.ts";
import type { CostingEntry, ProductBatch } from "../src/lib/product-lab-types.ts";

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

test("syncBatchFormulaFromCostingEntries updates a proof formula from edited costing ingredients", () => {
  const currentNotes = JSON.stringify({
    formula: [
      { brand: "Calumet", change: "same", ingredient: "Cocoa Powder", previousQuantity: 20, quantity: 25, rowId: "formula-cocoa", step: "Batter", unit: "g" },
      { brand: "Anchor", change: "same", ingredient: "Butter", previousQuantity: 100, quantity: 100, rowId: "formula-butter", step: "Batter", unit: "g" },
    ],
    steps: ["Melt butter", "Mix batter"],
  });
  const costingEntries: CostingEntry[] = [
    {
      id: "entry-cocoa",
      productId: "product-1",
      batchId: "batch-1",
      brandName: "Calumet",
      ingredientName: "Cocoa Powder",
      quantityUsed: 40,
      unit: "g",
      cost: 12,
      supplierNote: "",
    },
    {
      id: "entry-sugar",
      productId: "product-1",
      batchId: "batch-1",
      brandName: "Maya",
      ingredientName: "Brown Sugar",
      quantityUsed: 80,
      unit: "g",
      cost: 8,
      supplierNote: "",
    },
  ];

  const synced = parseBatchRecord(syncBatchFormulaFromCostingEntries(currentNotes, costingEntries));

  assert.deepEqual(synced.steps, ["Melt butter", "Mix batter"]);
  assert.equal(synced.formula.length, 2);
  assert.equal(synced.formula[0].ingredient, "Cocoa Powder");
  assert.equal(synced.formula[0].quantity, 40);
  assert.equal(synced.formula[0].rowId, "formula-cocoa");
  assert.equal(synced.formula[0].step, "Batter");
  assert.equal(synced.formula[1].ingredient, "Brown Sugar");
  assert.equal(synced.formula[1].quantity, 80);
});

test("diffFormulaRows matches the same ingredient when one version includes purchase package size", () => {
  const previous = [
    { brand: "Palermo", change: "", ingredient: "Palermo Pink Himalayan Salt 390g", quantity: 5, rowId: "salt-old", step: "", unit: "g" },
    { brand: "McCormick", change: "", ingredient: "McCormick Vanilla Extract 475mL", quantity: 2.5, rowId: "vanilla-old", step: "", unit: "tsp" },
    { brand: "S&R", change: "", ingredient: "S&R Member's Value 100% Colombian Regular Instant Coffee 200g", quantity: 3, rowId: "coffee-old", step: "", unit: "g" },
  ];
  const current = [
    { brand: "Palermo", change: "", ingredient: "Palermo Pink Himalayan Salt", quantity: 6, rowId: "salt-new", step: "", unit: "g" },
    { brand: "McCormick", change: "", ingredient: "McCormick Vanilla Extract", quantity: 3, rowId: "vanilla-new", step: "", unit: "tsp" },
    { brand: "S&R", change: "", ingredient: "S&R Member's Value 100% Colombian Regular Instant Coffee", quantity: 3.6, rowId: "coffee-new", step: "", unit: "g" },
  ];

  const diff = diffFormulaRows(previous, current);

  assert.equal(diff.length, 3);
  assert.deepEqual(diff.map((row) => row.status), ["changed", "changed", "changed"]);
  assert.equal(diff.find((row) => row.ingredient === "Palermo Pink Himalayan Salt")?.previousQuantity, 5);
  assert.equal(diff.find((row) => row.ingredient === "McCormick Vanilla Extract")?.previousQuantity, 2.5);
  assert.equal(diff.find((row) => row.ingredient === "S&R Member's Value 100% Colombian Regular Instant Coffee")?.previousQuantity, 3);
});
