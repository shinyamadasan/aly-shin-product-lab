import test from "node:test";
import assert from "node:assert/strict";
import { previewFinishedStockLoss, previewRawStockLoss, finishedStockEffectLabel } from "../src/lib/stock-financial-preview.ts";
import { sortFinishedStockExceptionHistory } from "../src/lib/finished-stock.ts";
import type { FinishedStockMovement, Ingredient, ProductionExecution } from "../src/lib/product-lab-types.ts";

const lot = (id: string, cost: number, completedAt = "2026-10-20T00:00:00Z"): ProductionExecution => ({
  id, productId: "brownie", productBatchId: "batch", batchVersionSnapshot: "v1", operationId: "bake",
  multiplier: 1, quantityProducedPieces: 10, expectedPieces: 10, frozenIngredientCostTotal: cost * 10,
  frozenCostPerPiece: cost, sourceType: "bake", costBasisSource: "production", costBasisSnapshot: null,
  note: "", completedAt, createdAt: completedAt,
});
const move = (id: string, count: number, reserved = 0): FinishedStockMovement => ({
  id: crypto.randomUUID(), productId: "brownie", productionExecutionId: id, movementType: "production_receipt",
  onHandDelta: count, reservedDelta: reserved, operationId: "op", note: "", createdAt: "2026-10-20T00:00:00Z",
});
const ingredient = { id: "flour", name: "Flour", baseUnit: "g", currentQuantity: 1000,
  averageUnitCost: 0.08, costReconciledAt: "2026-10-01T00:00:00Z" } as Ingredient;

test("raw loss preview converts units and refuses unknown or insufficient cost evidence", () => {
  assert.equal(previewRawStockLoss(ingredient, 0.25, "kg", "decrease"), 20);
  assert.equal(previewRawStockLoss({ ...ingredient, costReconciledAt: null }, 250, "g", "decrease"), null);
  assert.equal(previewRawStockLoss(ingredient, 250, "g", "increase"), null);
  assert.equal(previewRawStockLoss(ingredient, 2, "kg", "decrease"), null);
  assert.equal(previewRawStockLoss(ingredient, 5, "unconvertible", "decrease"), null);
});

test("finished loss previews actual FIFO lots and protects reserved units", () => {
  const lots = [lot("b", 12, "2026-10-20T01:00:00Z"), lot("a", 5)];
  const movements = [move("a", 10, 8), move("b", 10)];
  assert.deepEqual(previewFinishedStockLoss("brownie", 5, lots, movements), { amount: 46, estimated: false });
  assert.equal(previewFinishedStockLoss("brownie", 13, lots, movements).amount, null);
  assert.equal(previewFinishedStockLoss("brownie", 1.5, lots, movements).amount, null);
});

test("unknown allocated lot costs withhold the whole preview; estimates remain explicit", () => {
  assert.equal(previewFinishedStockLoss("brownie", 3, [lot("a", 5), lot("b", 0)], [move("a", 1), move("b", 5)]).amount, null);
  assert.deepEqual(previewFinishedStockLoss("brownie", 2, [{ ...lot("a", 5), costBasisSource: "historical_estimate" }], [move("a", 3)]), { amount: 10, estimated: true });
});

test("a capped lot or movement source never supplies a trustworthy FIFO preview", () => {
  assert.equal(previewFinishedStockLoss("brownie", 1, Array(1000).fill(lot("a", 5)), [move("a", 3)]).amount, null);
  assert.equal(previewFinishedStockLoss("brownie", 1, [lot("a", 5)], Array(1000).fill(move("a", 3))).amount, null);
});

test("Bake correction restates the preview using effective recorded cost, without a sale-price input", () => {
  const movements = [move("a", 10)];
  assert.equal(previewFinishedStockLoss("brownie", 2, [lot("a", 10)], movements).amount, 20);
  assert.equal(previewFinishedStockLoss("brownie", 2, [{ ...lot("a", 10), frozenCostPerPiece: 5, quantityProducedPieces: 20 }], movements).amount, 10);
  assert.match(finishedStockEffectLabel("household"), /outside operating profit/);
  assert.match(finishedStockEffectLabel("correction"), /Unclassified/);
});

test("consumption and reversal history remains visible, excluding completed sales and Bake corrections", () => {
  const movements = ["household", "exception_reversal", "fulfill", "bake_correction"].map((movementType) => ({ ...move("a", -1), movementType })) as FinishedStockMovement[];
  assert.deepEqual(sortFinishedStockExceptionHistory(movements).map((row) => row.movementType), ["household", "exception_reversal"]);
});
