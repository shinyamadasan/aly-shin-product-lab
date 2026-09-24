import test from "node:test";
import assert from "node:assert/strict";
import { buildOpeningBalanceCostEstimate, buildReconciliationPreview } from "../src/lib/finished-stock-reconciliation.ts";
import type { FinishedStockMovement, ProductionExecution, CostingSummary, Product, ProductBatch } from "../src/lib/product-lab-types.ts";
import type { RuleEngineContext } from "../src/lib/rule-engine/types.ts";

const products = [
  { id: "brownie", name: "Premium Brownie" },
  { id: "blondie", name: "Biscoff Blondie" },
];

function receipt(productId: string, onHandDelta: number, reservedDelta = 0, movementType: FinishedStockMovement["movementType"] = "production_receipt", createdAt = "2026-09-20T10:00:00Z"): FinishedStockMovement {
  return {
    id: crypto.randomUUID(), productId, productionExecutionId: crypto.randomUUID(),
    movementType, onHandDelta, reservedDelta, operationId: crypto.randomUUID(), note: "", createdAt,
  };
}

function bakeExecution(productId: string): ProductionExecution {
  return {
    id: crypto.randomUUID(), productId, productBatchId: crypto.randomUUID(), batchVersionSnapshot: "v1",
    operationId: crypto.randomUUID(), multiplier: 1, quantityProducedPieces: 9, expectedPieces: 9,
    frozenIngredientCostTotal: 90, frozenCostPerPiece: 10,
    sourceType: "bake", costBasisSource: "production", costBasisSnapshot: null,
    note: "", completedAt: "2026-09-10T10:00:00Z", createdAt: "2026-09-10T10:00:00Z",
  };
}

// Scenario 1 (brief) + the required reserved-stock distinction: on_hand=10, reserved=4,
// physical=10 -> difference must be 0, not +4. Physical count reconciles against on_hand
// (including reserved, still physically present), never `available`.
test("on_hand=10, reserved=4, physical=10 -> difference is 0 (no_change), never +4 against available", () => {
  const movements = [receipt("brownie", 10), { ...receipt("brownie", 0, 4, "reserve"), onHandDelta: 0, reservedDelta: 4 }];
  const rows = buildReconciliationPreview(products, movements, [], [{ productId: "brownie", physicalCount: 10 }]);
  const row = rows.find((r) => r.productId === "brownie")!;
  assert.equal(row.onHand, 10);
  assert.equal(row.reserved, 4);
  assert.equal(row.available, 6);
  assert.equal(row.difference, 0);
  assert.equal(row.action, "no_change");
});

// Scenario 2: on_hand=10, reserved=4, physical=8 -> difference=-2 (correction), which must be
// satisfiable from the 6 unreserved pieces (this preview does not itself enforce the
// reserved-protection -- that is record_finished_stock_exception's job, unmodified -- but the
// classification and magnitude must be correct).
test("on_hand=10, reserved=4, physical=8 -> difference=-2 (correction), within the 6 unreserved pieces", () => {
  const movements = [receipt("brownie", 10), { ...receipt("brownie", 0, 4, "reserve"), onHandDelta: 0, reservedDelta: 4 }];
  const rows = buildReconciliationPreview(products, movements, [], [{ productId: "brownie", physicalCount: 8 }]);
  const row = rows.find((r) => r.productId === "brownie")!;
  assert.equal(row.difference, -2);
  assert.equal(row.action, "correction");
  assert.ok(Math.abs(row.difference) <= row.available, "the correction magnitude must be satisfiable from unreserved stock alone");
});

// Scenario 3: ledger 8, physical 8 -> no mutation.
test("on_hand=8, physical=8 -> no_change", () => {
  const rows = buildReconciliationPreview(products, [receipt("brownie", 8)], [], [{ productId: "brownie", physicalCount: 8 }]);
  assert.equal(rows[0].action, "no_change");
  assert.equal(rows[0].difference, 0);
});

// Scenario: ledger 0, physical 4, zero production history -> opening balance.
test("on_hand=0, physical=4, zero production_executions -> opening_balance", () => {
  const rows = buildReconciliationPreview(products, [], [], [{ productId: "brownie", physicalCount: 4 }]);
  assert.equal(rows[0].onHand, 0);
  assert.equal(rows[0].difference, 4);
  assert.equal(rows[0].action, "opening_balance");
});

// Bootstrap-only gate: a product with ANY existing lot (real Bake, here) and a positive difference
// must be investigate_required, never opening_balance -- this is the client-side echo of the
// server's own permanent-bootstrap-window-closure rule.
test("a product with an existing Bake lot and a positive difference -> investigate_required, never opening_balance", () => {
  const rows = buildReconciliationPreview(products, [receipt("brownie", 2)], [bakeExecution("brownie")], [{ productId: "brownie", physicalCount: 6 }]);
  const row = rows.find((r) => r.productId === "brownie")!;
  assert.equal(row.difference, 4);
  assert.equal(row.action, "investigate_required");
});

// A product with an earlier opening-balance lot (not a Bake) is equally past its bootstrap window.
test("a product with an existing opening-balance lot and a positive difference -> investigate_required", () => {
  const openingLot: ProductionExecution = { ...bakeExecution("brownie"), productBatchId: "", batchVersionSnapshot: "", sourceType: "opening_balance", costBasisSource: "historical_estimate", costBasisSnapshot: { a: 1 } };
  const rows = buildReconciliationPreview(products, [receipt("brownie", 4)], [openingLot], [{ productId: "brownie", physicalCount: 9 }]);
  assert.equal(rows[0].action, "investigate_required");
});

// Mixed multi-product batch -> correct action per product (brief scenario 4), using the exact
// eventual acceptance scenario's numbers: Brownies 0->4, Blondies 14->6, Cookies 0->8.
test("mixed multi-product batch: correct action per product", () => {
  const threeProducts = [...products, { id: "cookie", name: "Butter Cookie" }];
  const movements = [receipt("blondie", 14)];
  const counts = [
    { productId: "brownie", physicalCount: 4 },
    { productId: "blondie", physicalCount: 6 },
    { productId: "cookie", physicalCount: 8 },
  ];
  const rows = buildReconciliationPreview(threeProducts, movements, [], counts);
  const byProduct = Object.fromEntries(rows.map((r) => [r.productId, r]));
  assert.equal(byProduct.brownie.action, "opening_balance");
  assert.equal(byProduct.brownie.difference, 4);
  assert.equal(byProduct.blondie.action, "correction");
  assert.equal(byProduct.blondie.difference, -8);
  assert.equal(byProduct.cookie.action, "opening_balance");
  assert.equal(byProduct.cookie.difference, 8);
});

// expectedLatestMovementId: tie-break must be created_at desc, id desc (matching the database's own
// "latest row" convention), not insertion order.
test("expectedLatestMovementId picks the movement with the latest created_at, tie-broken by id desc", () => {
  const older = receipt("brownie", 5, 0, "production_receipt", "2026-09-20T10:00:00Z");
  const newer = receipt("brownie", 3, 0, "production_receipt", "2026-09-21T10:00:00Z");
  const rows = buildReconciliationPreview(products, [older, newer], [], [{ productId: "brownie", physicalCount: 8 }]);
  assert.equal(rows[0].expectedLatestMovementId, newer.id);
});

test("expectedLatestMovementId is null when a product has no movements at all", () => {
  const rows = buildReconciliationPreview(products, [], [], [{ productId: "brownie", physicalCount: 4 }]);
  assert.equal(rows[0].expectedLatestMovementId, null);
});

// Cost estimate: ingredient-only, not the full product cost (packaging/labor/overhead excluded),
// per this feature's explicit design decision to stay consistent with Wave 1/3's ingredient-only
// "raw" cost.
test("buildOpeningBalanceCostEstimate uses ingredientCost / costingYield, never the full product cost", () => {
  const product: Product = { id: "brownie", name: "Premium Brownie", category: "", role: "Hero candidate", status: "testing", description: "", image: "", decision: "Needs proof", isPublic: false };
  const batch: ProductBatch = { id: "b1", productId: "brownie", batchVersion: "v1", status: "completed" } as ProductBatch;
  const costing: CostingSummary = {
    id: "c1", productId: "brownie", batchId: "b1",
    ingredientCost: 40, packagingCost: 100, laborEstimate: 100, waterCost: 0, gasCost: 0,
    ovenElectricCost: 0, refrigerationCost: 0, coffeeEquipmentCost: 0, wasteAllowance: 0,
    overheadCost: 100, equipmentCost: 100, suggestedPrice: 20,
    notes: "Costing yield: 8",
  };
  const context: RuleEngineContext = { batches: [batch], costings: [costing], tastings: [], supplies: [], now: 0 };
  const estimate = buildOpeningBalanceCostEstimate(product, context);
  assert.ok(estimate);
  assert.equal(estimate!.costPerPiece, 5); // 40 / 8, NOT (40+100+100+0+0+0+0+0+100+100)/8 = 55
  assert.equal(estimate!.sourceCostingId, "c1");
});

test("buildOpeningBalanceCostEstimate returns null when the product has no costing on record", () => {
  const product: Product = { id: "brownie", name: "Premium Brownie", category: "", role: "Hero candidate", status: "testing", description: "", image: "", decision: "Needs proof", isPublic: false };
  const context: RuleEngineContext = { batches: [], costings: [], tastings: [], supplies: [], now: 0 };
  assert.equal(buildOpeningBalanceCostEstimate(product, context), null);
});
