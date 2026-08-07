import test from "node:test";
import assert from "node:assert/strict";
import { getProductStats } from "../src/lib/readiness.ts";
import type { CostingSummary, Product, SellingFormat, SellingFormatPackagingLine } from "../src/lib/product-lab-types.ts";

function product(overrides: Partial<Product> = {}): Product {
  return {
    id: "brownies",
    name: "Brownies",
    category: "Baked goods",
    role: "Hero candidate",
    status: "testing",
    description: "",
    image: "",
    decision: "Needs proof",
    ...overrides,
  };
}

function costing(overrides: Partial<CostingSummary> = {}): CostingSummary {
  return {
    id: "costing-1",
    productId: "brownies",
    batchId: "",
    ingredientCost: 240,
    packagingCost: 0,
    laborEstimate: 0,
    waterCost: 0,
    gasCost: 0,
    ovenElectricCost: 0,
    refrigerationCost: 0,
    coffeeEquipmentCost: 0,
    wasteAllowance: 0,
    overheadCost: 0,
    equipmentCost: 0,
    suggestedPrice: 0,
    notes: "Costing yield: 9",
    ...overrides,
  };
}

function sellingFormat(overrides: Partial<SellingFormat> = {}): SellingFormat {
  return {
    id: "format-1",
    costingId: "costing-1",
    name: "Box of 6",
    piecesPerUnit: 6,
    sellingPrice: 250,
    isActive: true,
    sortOrder: 0,
    notes: "",
    ...overrides,
  };
}

function sellingFormatPackagingLine(overrides: Partial<SellingFormatPackagingLine> = {}): SellingFormatPackagingLine {
  return {
    id: "line-1",
    sellingFormatId: "format-1",
    ingredientId: "",
    name: "Kraft box",
    quantity: 1,
    unit: "pcs",
    unitCostSnapshot: 15,
    isManualCost: true,
    note: "",
    sortOrder: 0,
    ...overrides,
  };
}

test("getProductStats: legacy packaging cost alone marks packaging done, exactly as before Selling Formats existed", () => {
  const stats = getProductStats(product(), [], [costing({ packagingCost: 10 })], []);
  assert.equal(stats.packagingDone, true);
});

test("getProductStats: no packaging anywhere (no legacy cost, no Selling Formats) leaves packaging not done", () => {
  const stats = getProductStats(product(), [], [costing({ packagingCost: 0 })], []);
  assert.equal(stats.packagingDone, false);
});

test("getProductStats: a costing with no Selling Format data passed at all behaves exactly as it did before Slice 5 (default params)", () => {
  const stats = getProductStats(product(), [], [costing({ packagingCost: 0 })], []);
  assert.equal(stats.packagingDone, false);
  const statsWithLegacyCost = getProductStats(product(), [], [costing({ packagingCost: 5 })], []);
  assert.equal(statsWithLegacyCost.packagingDone, true);
});

test("getProductStats: an active Selling Format with a valid packaging line marks packaging done, even with legacy packagingCost at 0", () => {
  const stats = getProductStats(
    product(),
    [],
    [costing({ packagingCost: 0 })],
    [],
    [sellingFormat({ isActive: true })],
    [sellingFormatPackagingLine()],
  );
  assert.equal(stats.packagingDone, true);
});

test("getProductStats: an archived Selling Format's packaging does not count", () => {
  const stats = getProductStats(
    product(),
    [],
    [costing({ packagingCost: 0 })],
    [],
    [sellingFormat({ isActive: false })],
    [sellingFormatPackagingLine()],
  );
  assert.equal(stats.packagingDone, false);
});

test("getProductStats: an active Selling Format whose only line is invalid (zero cost) does not count", () => {
  const stats = getProductStats(
    product(),
    [],
    [costing({ packagingCost: 0 })],
    [],
    [sellingFormat({ isActive: true })],
    [sellingFormatPackagingLine({ unitCostSnapshot: 0 })],
  );
  assert.equal(stats.packagingDone, false);
});

test("getProductStats: an active Selling Format whose only line has a blank name does not count", () => {
  const stats = getProductStats(
    product(),
    [],
    [costing({ packagingCost: 0 })],
    [],
    [sellingFormat({ isActive: true })],
    [sellingFormatPackagingLine({ name: "   " })],
  );
  assert.equal(stats.packagingDone, false);
});

test("getProductStats: an active Selling Format with zero packaging lines does not count", () => {
  const stats = getProductStats(
    product(),
    [],
    [costing({ packagingCost: 0 })],
    [],
    [sellingFormat({ isActive: true })],
    [],
  );
  assert.equal(stats.packagingDone, false);
});

test("getProductStats: a Selling Format belonging to a different costing does not count", () => {
  const stats = getProductStats(
    product(),
    [],
    [costing({ id: "costing-1", packagingCost: 0 })],
    [],
    [sellingFormat({ id: "format-1", costingId: "costing-OTHER", isActive: true })],
    [sellingFormatPackagingLine({ sellingFormatId: "format-1" })],
  );
  assert.equal(stats.packagingDone, false);
});

test("getProductStats: no costing at all leaves packaging not done regardless of Selling Format data", () => {
  const stats = getProductStats(product(), [], [], [], [sellingFormat({ isActive: true })], [sellingFormatPackagingLine()]);
  assert.equal(stats.packagingDone, false);
});

test("getProductStats: costingDone is unaffected by Selling Formats -- still keyed on ingredientCost alone", () => {
  const stats = getProductStats(product(), [], [costing({ ingredientCost: 240, packagingCost: 0 })], [], [sellingFormat({ isActive: true })], [sellingFormatPackagingLine()]);
  assert.equal(stats.costingDone, true);
});
