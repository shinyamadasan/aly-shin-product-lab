import test from "node:test";
import assert from "node:assert/strict";
import { findConflictingCosting, formatCostingMetric, getCostingMetrics, getCostingTotals, isBatchProductMismatch } from "../src/lib/costing.ts";
import { isDuplicateKeyError } from "../src/lib/database-errors.ts";
import type { CostingSummary, ProductBatch } from "../src/lib/product-lab-types.ts";

function baseCosting(overrides: Partial<CostingSummary> = {}): CostingSummary {
  return {
    id: "costing-1",
    productId: "product-1",
    batchId: "",
    ingredientCost: 200,
    packagingCost: 20,
    laborEstimate: 100,
    waterCost: 5,
    gasCost: 10,
    ovenElectricCost: 8,
    refrigerationCost: 2,
    coffeeEquipmentCost: 0,
    wasteAllowance: 15,
    overheadCost: 30,
    equipmentCost: 10,
    suggestedPrice: 50,
    notes: "Costing yield: 8",
    ...overrides,
  };
}

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

test("zero yield returns no unit cost (never the whole batch cost)", () => {
  const metrics = getCostingMetrics({
    costingYield: 0,
    directCost: 300,
    indirectCost: 100,
    suggestedPrice: 50,
    targetFoodCost: 0.35,
    totalBatchCost: 400,
  });

  assert.equal(metrics.costPerPiece, null);
});

test("zero yield does not generate a misleading margin", () => {
  const metrics = getCostingMetrics({
    costingYield: 0,
    directCost: 300,
    indirectCost: 100,
    suggestedPrice: 50,
    targetFoodCost: 0.35,
    totalBatchCost: 400,
  });

  assert.equal(metrics.margin, null);
  assert.equal(metrics.grossProfit, null);
  assert.equal(metrics.foodCostPercent, null);
  assert.equal(metrics.markup, null);
  assert.equal(metrics.targetPrice, null);
  assert.equal(metrics.contributionMarginPerPiece, null);
  assert.equal(metrics.breakEvenUnits, null);
});

test("negative yield is treated the same as missing yield", () => {
  const metrics = getCostingMetrics({
    costingYield: -3,
    directCost: 300,
    indirectCost: 100,
    suggestedPrice: 50,
    targetFoodCost: 0.35,
    totalBatchCost: 400,
  });

  assert.equal(metrics.costPerPiece, null);
});

test("a real yield produces the expected unit cost and margin", () => {
  const metrics = getCostingMetrics({
    costingYield: 8,
    directCost: 320,
    indirectCost: 80,
    suggestedPrice: 50,
    targetFoodCost: 0.35,
    totalBatchCost: 400,
  });

  assert.equal(metrics.costPerPiece, 50);
  assert.equal(metrics.grossProfit, 0);
  assert.equal(metrics.margin, 0);
});

test("getCostingTotals never substitutes total batch cost for cost per piece when yield is missing", () => {
  const costing = baseCosting({ notes: "" });
  const totals = getCostingTotals(costing);

  assert.equal(totals.costingYield, 0);
  assert.notEqual(totals.costPerPiece, totals.totalBatchCost);
  assert.equal(totals.costPerPiece, null);
  assert.equal(totals.margin, null);
});

test("getCostingTotals produces a real cost per piece once yield is present", () => {
  const costing = baseCosting();
  const totals = getCostingTotals(costing);

  assert.equal(totals.costingYield, 8);
  assert.equal(totals.costPerPiece, totals.totalBatchCost / 8);
  assert.notEqual(totals.margin, null);
});

test("Product Detail's totals and Costing's live metrics agree for the same saved costing", () => {
  const costing = baseCosting();
  const totals = getCostingTotals(costing);

  const liveMetrics = getCostingMetrics({
    costingYield: totals.costingYield,
    directCost: totals.directCost,
    indirectCost: totals.indirectCost,
    suggestedPrice: costing.suggestedPrice,
    targetFoodCost: 0,
    totalBatchCost: totals.totalBatchCost,
  });

  assert.equal(totals.costPerPiece, liveMetrics.costPerPiece);
  assert.equal(totals.margin, liveMetrics.margin);
});

test("formatCostingMetric shows the unavailable label for null and formats real numbers", () => {
  assert.equal(formatCostingMetric(null, (value) => `PHP ${value.toFixed(2)}`), "Need yield");
  assert.equal(formatCostingMetric(null, (value) => `PHP ${value.toFixed(2)}`, "needs yield"), "needs yield");
  assert.equal(formatCostingMetric(12.5, (value) => `PHP ${value.toFixed(2)}`), "PHP 12.50");
});

test("findConflictingCosting: first costing for a batch succeeds (no conflict)", () => {
  const conflict = findConflictingCosting([], { costingId: "", productId: "product-1", batchId: "batch-1" });
  assert.equal(conflict, null);
});

test("findConflictingCosting: second costing for the same batch is rejected", () => {
  const existing = baseCosting({ id: "costing-1", batchId: "batch-1" });
  const conflict = findConflictingCosting([existing], { costingId: "", productId: "product-1", batchId: "batch-1" });
  assert.equal(conflict, existing);
});

test("findConflictingCosting: editing the existing costing succeeds (excludes itself)", () => {
  const existing = baseCosting({ id: "costing-1", batchId: "batch-1" });
  const conflict = findConflictingCosting([existing], { costingId: "costing-1", productId: "product-1", batchId: "batch-1" });
  assert.equal(conflict, null);
});

test("findConflictingCosting: moving another costing onto an occupied batch is rejected", () => {
  const occupant = baseCosting({ id: "costing-1", batchId: "batch-1" });
  const mover = baseCosting({ id: "costing-2", batchId: "batch-2" });
  const conflict = findConflictingCosting([occupant, mover], { costingId: "costing-2", productId: "product-1", batchId: "batch-1" });
  assert.equal(conflict, occupant);
});

test("findConflictingCosting: two different batches of the same product can each have a costing", () => {
  const first = baseCosting({ id: "costing-1", batchId: "batch-1" });
  const conflict = findConflictingCosting([first], { costingId: "", productId: "product-1", batchId: "batch-2" });
  assert.equal(conflict, null);
});

test("findConflictingCosting: only one unlinked costing per product is allowed", () => {
  const existing = baseCosting({ id: "costing-1", batchId: "" });
  const conflict = findConflictingCosting([existing], { costingId: "", productId: "product-1", batchId: "" });
  assert.equal(conflict, existing);
});

test("findConflictingCosting: unlinked costings for different products do not conflict", () => {
  const existing = baseCosting({ id: "costing-1", productId: "product-1", batchId: "" });
  const conflict = findConflictingCosting([existing], { costingId: "", productId: "product-2", batchId: "" });
  assert.equal(conflict, null);
});

test("isDuplicateKeyError: Postgres 23505 is recognized as a duplicate-key error", () => {
  assert.equal(isDuplicateKeyError({ code: "23505" }), true);
});

test("isDuplicateKeyError: other error codes and missing errors are not duplicate-key errors", () => {
  assert.equal(isDuplicateKeyError({ code: "23503" }), false);
  assert.equal(isDuplicateKeyError(null), false);
  assert.equal(isDuplicateKeyError(undefined), false);
});

test("isBatchProductMismatch: a batch that belongs to the submitted product is not a mismatch", () => {
  const batch = baseBatch({ id: "batch-1", productId: "product-1" });
  assert.equal(isBatchProductMismatch([batch], { productId: "product-1", batchId: "batch-1" }), false);
});

test("isBatchProductMismatch: a batch that belongs to a different product is a mismatch", () => {
  const batch = baseBatch({ id: "batch-1", productId: "product-1" });
  assert.equal(isBatchProductMismatch([batch], { productId: "product-2", batchId: "batch-1" }), true);
});

test("isBatchProductMismatch: a batch id that doesn't exist is a mismatch", () => {
  assert.equal(isBatchProductMismatch([], { productId: "product-1", batchId: "missing-batch" }), true);
});

test("isBatchProductMismatch: an empty batchId (unlinked legacy costing) is never a mismatch", () => {
  assert.equal(isBatchProductMismatch([], { productId: "product-1", batchId: "" }), false);
});
