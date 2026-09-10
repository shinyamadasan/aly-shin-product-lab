import test from "node:test";
import assert from "node:assert/strict";
import { deriveFinishedStockBalances, sortProductionHistory } from "../src/lib/finished-stock.ts";
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
    note: "", completedAt, createdAt: completedAt,
  });
  const sorted = sortProductionHistory([mk("2026-09-10T08:00:00Z"), mk("2026-09-10T10:00:00Z"), mk("2026-09-10T09:00:00Z")]);
  assert.deepEqual(sorted.map((e) => e.completedAt), ["2026-09-10T10:00:00Z", "2026-09-10T09:00:00Z", "2026-09-10T08:00:00Z"]);
});

test("mapProductionExecutionRow coerces numeric strings, keeps observed and expected pieces distinct, and never invents a quantity or cost", () => {
  const mapped = mapProductionExecutionRow({
    id: "e1", product_id: "brownie", product_batch_id: "b1", batch_version_snapshot: "v3",
    operation_id: "op1", multiplier: "2", quantity_produced_pieces: "16", expected_pieces: "18",
    frozen_ingredient_cost_total: "1060.50", frozen_cost_per_piece: "66.2813", note: null,
    completed_at: "2026-09-10T10:00:00Z", created_at: "2026-09-10T10:00:00Z",
  });
  assert.equal(mapped.multiplier, 2);
  assert.equal(mapped.quantityProducedPieces, 16);
  assert.equal(mapped.expectedPieces, 18);
  assert.equal(mapped.frozenIngredientCostTotal, 1060.5);
  assert.equal(mapped.note, "");
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
