import test from "node:test";
import assert from "node:assert/strict";
import { deriveFinishedStockBalances, isRealProduction, sortProductionHistory } from "../src/lib/finished-stock.ts";
import { mapFinishedStockMovementRow, mapProductionExecutionRow } from "../src/lib/supabase-mappers.ts";
import type { FinishedStockMovement, ProductionExecution } from "../src/lib/product-lab-types.ts";

const products = [
  { id: "brownie", name: "Premium Brownie" },
  { id: "blondie", name: "Biscoff Blondie" },
];

function receipt(productId: string, pieces: number): FinishedStockMovement {
  return {
    id: crypto.randomUUID(), productId, productionExecutionId: crypto.randomUUID(),
    movementType: "production_receipt", onHandDelta: pieces, reservedDelta: 0,
    operationId: crypto.randomUUID(), note: "", createdAt: new Date().toISOString(),
  };
}

test("finished-stock balances: on_hand is the sum of on_hand_delta, reserved is 0 in Wave 1, available = on_hand - reserved", () => {
  const balances = deriveFinishedStockBalances(products, [receipt("brownie", 9), receipt("brownie", 9)]);
  const brownie = balances.find((b) => b.productId === "brownie");
  assert.equal(brownie?.onHandPieces, 18);
  assert.equal(brownie?.reservedPieces, 0);
  assert.equal(brownie?.availablePieces, 18);
});

test("finished-stock balances are per product -- baking one product never moves another", () => {
  const balances = deriveFinishedStockBalances(products, [receipt("brownie", 9)]);
  assert.equal(balances.find((b) => b.productId === "brownie")?.onHandPieces, 9);
  assert.equal(balances.find((b) => b.productId === "blondie")?.onHandPieces, 0);
});

test("finished-stock balances honour the future reserve/release/fulfill ledger shape without implementing them", () => {
  const movements: FinishedStockMovement[] = [
    receipt("brownie", 20),
    { ...receipt("brownie", 0), movementType: "reserve", onHandDelta: 0, reservedDelta: 6 },
    { ...receipt("brownie", 0), movementType: "fulfill", onHandDelta: -6, reservedDelta: -6 },
  ];
  const brownie = deriveFinishedStockBalances(products, movements).find((b) => b.productId === "brownie");
  // on_hand 20 - 6 = 14; reserved 6 - 6 = 0; available 14. (Wave 1 itself never writes these rows.)
  assert.equal(brownie?.onHandPieces, 14);
  assert.equal(brownie?.reservedPieces, 0);
  assert.equal(brownie?.availablePieces, 14);
});

test("production history sorts newest-first", () => {
  const mk = (completedAt: string): ProductionExecution => ({
    id: crypto.randomUUID(), productId: "brownie", productBatchId: crypto.randomUUID(),
    batchVersionSnapshot: "v1", operationId: crypto.randomUUID(), multiplier: 1,
    quantityProducedPieces: 9, expectedPieces: 9, frozenIngredientCostTotal: 100, frozenCostPerPiece: 100 / 9,
    sourceType: "bake", costBasisSource: "production", costBasisSnapshot: null,
    note: "", completedAt, createdAt: completedAt,
  });
  const sorted = sortProductionHistory([mk("2026-09-10T08:00:00Z"), mk("2026-09-10T10:00:00Z"), mk("2026-09-10T09:00:00Z")]);
  assert.deepEqual(sorted.map((e) => e.completedAt), ["2026-09-10T10:00:00Z", "2026-09-10T09:00:00Z", "2026-09-10T08:00:00Z"]);
});

test("mapProductionExecutionRow coerces numeric strings, keeps observed and expected pieces distinct, and never invents a quantity or cost", () => {
  const mapped = mapProductionExecutionRow({
    id: "e1", product_id: "brownie", product_batch_id: "b1", batch_version_snapshot: "v3",
    operation_id: "op1", multiplier: "2", quantity_produced_pieces: "16", expected_pieces: "18",
    frozen_ingredient_cost_total: "1060.50", frozen_cost_per_piece: "66.2813",
    source_type: "bake", cost_basis_source: "production", cost_basis_snapshot: null, note: null,
    completed_at: "2026-09-10T10:00:00Z", created_at: "2026-09-10T10:00:00Z",
  });
  assert.equal(mapped.multiplier, 2);
  assert.equal(mapped.quantityProducedPieces, 16);
  assert.equal(mapped.expectedPieces, 18);
  assert.equal(mapped.frozenIngredientCostTotal, 1060.5);
  assert.equal(mapped.note, "");
});

test("mapProductionExecutionRow flattens a null product_batch_id/batch_version_snapshot to '' (opening-balance rows have neither), matching this codebase's nullable-column convention", () => {
  const mapped = mapProductionExecutionRow({
    id: "e2", product_id: "brownie", product_batch_id: null, batch_version_snapshot: null,
    operation_id: "op2", multiplier: "1", quantity_produced_pieces: "4", expected_pieces: "4",
    frozen_ingredient_cost_total: "40", frozen_cost_per_piece: "10",
    source_type: "opening_balance", cost_basis_source: "historical_estimate",
    cost_basis_snapshot: { source_costing_id: "c1", ingredient_cost: 5, costing_yield: 0.5, computed_cost_per_piece: 10 },
    note: "Opening balance", completed_at: "2026-09-23T00:00:00Z", created_at: "2026-09-23T00:00:00Z",
  });
  assert.equal(mapped.productBatchId, "");
  assert.equal(mapped.batchVersionSnapshot, "");
  assert.equal(mapped.sourceType, "opening_balance");
  assert.equal(mapped.costBasisSource, "historical_estimate");
  assert.deepEqual(mapped.costBasisSnapshot, { source_costing_id: "c1", ingredient_cost: 5, costing_yield: 0.5, computed_cost_per_piece: 10 });
});

// Regression coverage (finished-stock opening balance work): an opening-balance lot is a real,
// FIFO-compatible inventory lot, but it must never be treated as evidence of an actual Bake/
// production event. isRealProduction is the one predicate every caller (e.g. the production-history
// UI) should use to tell the two apart.
test("isRealProduction: true for a real Bake, false for an opening-balance lot", () => {
  const bakeExecution: ProductionExecution = {
    id: "e1", productId: "brownie", productBatchId: "b1", batchVersionSnapshot: "v1",
    operationId: "op1", multiplier: 1, quantityProducedPieces: 9, expectedPieces: 9,
    frozenIngredientCostTotal: 90, frozenCostPerPiece: 10,
    sourceType: "bake", costBasisSource: "production", costBasisSnapshot: null,
    note: "", completedAt: "2026-09-10T10:00:00Z", createdAt: "2026-09-10T10:00:00Z",
  };
  const openingBalanceExecution: ProductionExecution = {
    ...bakeExecution, id: "e2", productBatchId: "", batchVersionSnapshot: "",
    sourceType: "opening_balance", costBasisSource: "historical_estimate",
    costBasisSnapshot: { source_costing_id: "c1", ingredient_cost: 5, costing_yield: 0.5, computed_cost_per_piece: 10 },
  };
  assert.equal(isRealProduction(bakeExecution), true);
  assert.equal(isRealProduction(openingBalanceExecution), false);
});

test("mapFinishedStockMovementRow keeps a null production_execution_id null (for future non-production movements)", () => {
  const mapped = mapFinishedStockMovementRow({
    id: "m1", product_id: "brownie", production_execution_id: null, movement_type: "production_receipt",
    on_hand_delta: "9", reserved_delta: "0", operation_id: "op1", note: null, created_at: "2026-09-10T10:00:00Z",
  });
  assert.equal(mapped.productionExecutionId, null);
  assert.equal(mapped.onHandDelta, 9);
  assert.equal(mapped.movementType, "production_receipt");
});
