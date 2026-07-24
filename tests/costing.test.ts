import test from "node:test";
import assert from "node:assert/strict";
import { formatCostingMetric, getCostingMetrics, getCostingTotals } from "../src/lib/costing.ts";
import type { CostingSummary } from "../src/lib/product-lab-types.ts";

function baseCosting(overrides: Partial<CostingSummary> = {}): CostingSummary {
  return {
    id: "costing-1",
    productId: "product-1",
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
