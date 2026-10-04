import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { previewBakeCorrection, summarizeBakeCorrections, deriveFinishedStockBalances } from "../src/lib/finished-stock.ts";
import { mapProductionExecutionCorrectionRow } from "../src/lib/supabase-mappers.ts";
import { correctBakeActualArgs } from "../src/lib/raw-inventory-authority.ts";
import type { FinishedStockMovement, ProductionExecution, ProductionExecutionCorrection } from "../src/lib/product-lab-types.ts";

const EXEC_ID = "11111111-1111-4111-8111-111111111111";

function bake(overrides: Partial<ProductionExecution> = {}): ProductionExecution {
  return {
    id: EXEC_ID, productId: "cookie", productBatchId: "b1", batchVersionSnapshot: "V2", operationId: "op",
    multiplier: 1, quantityProducedPieces: 10, expectedPieces: 12, frozenIngredientCostTotal: 120, frozenCostPerPiece: 12,
    sourceType: "bake", costBasisSource: "production", costBasisSnapshot: null, note: "", completedAt: "2026-09-24T08:00:00Z", createdAt: "2026-09-24T08:00:00Z",
    ...overrides,
  };
}

function movement(type: FinishedStockMovement["movementType"], onHand: number, reserved = 0, executionId: string | null = EXEC_ID): FinishedStockMovement {
  return { id: crypto.randomUUID(), productId: "cookie", productionExecutionId: executionId, movementType: type, onHandDelta: onHand, reservedDelta: reserved, operationId: "op", note: "", createdAt: "2026-09-24T08:00:00Z" };
}

function correction(previous: number, corrected: number, correctedAt: string): ProductionExecutionCorrection {
  return {
    id: crypto.randomUUID(), productionExecutionId: EXEC_ID, operationId: crypto.randomUUID(), previousActual: previous, correctedActual: corrected,
    delta: corrected - previous, reason: "typo", frozenIngredientCostTotal: 120, previousCostPerPiece: 120 / previous, correctedCostPerPiece: 120 / corrected, correctedAt,
  };
}

test("preview 10 -> 12: +2 pieces, raw cost total unchanged, new cost per piece = total / 12", () => {
  const preview = previewBakeCorrection(bake(), "12", [movement("production_receipt", 10)]);
  assert.ok(preview.valid);
  if (!preview.valid) return;
  assert.equal(preview.previousActual, 10);
  assert.equal(preview.correctedActual, 12);
  assert.equal(preview.delta, 2);
  assert.equal(preview.frozenCostTotal, 120);
  assert.equal(preview.previousCostPerPiece, 12);
  assert.equal(preview.correctedCostPerPiece, 10);
  assert.equal(preview.fulfilledPieces, 0);
});

test("preview reports how many already-sold pieces will be restated at the new cost per piece", () => {
  const preview = previewBakeCorrection(bake(), "12", [movement("production_receipt", 10), movement("reserve", 0, 4), movement("fulfill", -4, -4), movement("release", 0, 0)]);
  assert.ok(preview.valid);
  if (preview.valid) assert.equal(preview.fulfilledPieces, 4);
});

test("preview blocks a decrease below unreserved on-hand pieces (reserved / sold / damaged), mirroring the server rule", () => {
  // 10 produced, 4 reserved -> only 6 removable: 10 -> 4 is allowed, 10 -> 3 is not.
  const lot = [movement("production_receipt", 10), movement("reserve", 0, 4)];
  assert.equal(previewBakeCorrection(bake(), "4", lot).valid, true);
  const blocked = previewBakeCorrection(bake(), "3", lot);
  assert.equal(blocked.valid, false);
  // 10 produced, 3 damaged -> 7 removable.
  const damaged = [movement("production_receipt", 10), movement("damage", -3)];
  assert.equal(previewBakeCorrection(bake(), "3", damaged).valid, true);
  assert.equal(previewBakeCorrection(bake(), "2", damaged).valid, false);
  // Another lot's stock never counts toward this lot's headroom.
  const otherLot = [movement("production_receipt", 10), movement("reserve", 0, 10), movement("production_receipt", 50, 0, "other-lot")];
  assert.equal(previewBakeCorrection(bake(), "9", otherLot).valid, false);
});

test("preview rejects null / zero / negative / fractional / non-numeric / unchanged input", () => {
  const lot = [movement("production_receipt", 10)];
  for (const text of ["", "  ", "0", "-3", "2.5", "abc", "10"]) {
    assert.equal(previewBakeCorrection(bake(), text, lot).valid, false, `"${text}" must be rejected`);
  }
});

test("opening-balance lots can never be previewed as correctable", () => {
  const opening = bake({ sourceType: "opening_balance", costBasisSource: "historical_estimate", costBasisSnapshot: { x: 1 }, productBatchId: "", batchVersionSnapshot: "" });
  assert.equal(previewBakeCorrection(opening, "12", [movement("production_receipt", 10)]).valid, false);
});

test("the preview never touches Expected: it is read from the frozen execution, not recomputed", () => {
  const execution = bake({ expectedPieces: 12 });
  previewBakeCorrection(execution, "12", [movement("production_receipt", 10)]);
  assert.equal(execution.expectedPieces, 12);
});

test("Corrected indicator: first previous -> latest corrected, null when never corrected, scoped per Bake", () => {
  assert.equal(summarizeBakeCorrections(EXEC_ID, []), null);
  const rows = [correction(11, 12, "2026-09-24T10:00:00Z"), correction(10, 11, "2026-09-24T09:00:00Z")];
  assert.deepEqual(summarizeBakeCorrections(EXEC_ID, rows), { originalActual: 10, currentActual: 12, count: 2 });
  assert.equal(summarizeBakeCorrections("another-bake", rows), null);
});

test("a bake_correction movement adds to finished-stock on-hand like any ledger row (no second authority)", () => {
  const balances = deriveFinishedStockBalances([{ id: "cookie", name: "Cookie" }], [movement("production_receipt", 10), movement("bake_correction", 2)]);
  assert.equal(balances[0].onHandPieces, 12);
  assert.equal(balances[0].availablePieces, 12);
});

test("mapper coerces numeric strings from PostgREST and never invents a value", () => {
  const mapped = mapProductionExecutionCorrectionRow({
    id: "c1", production_execution_id: EXEC_ID, operation_id: "op", previous_actual: "10", corrected_actual: "12", delta: "2", reason: "typo",
    frozen_ingredient_cost_total: "120.00", previous_cost_per_piece: "12.0000", corrected_cost_per_piece: "10.0000", corrected_at: "2026-09-24T09:00:00Z",
  });
  assert.equal(mapped.previousActual, 10);
  assert.equal(mapped.correctedActual, 12);
  assert.equal(mapped.delta, 2);
  assert.equal(mapped.correctedCostPerPiece, 10);
});

test("RPC args carry exactly the narrow contract: execution, the count the operator saw, the corrected count, a trimmed reason, the operation id", () => {
  assert.deepEqual(correctBakeActualArgs(EXEC_ID, 10, 12, "  Entered wrong piece count ", "op-1"), {
    p_operation_id: "op-1", p_production_execution_id: EXEC_ID, p_expected_current_actual: 10, p_corrected_actual: 12, p_reason: "Entered wrong piece count",
  });
});

test("migration contract: owner-only definer behind an invoker wrapper, fixed search_path, no client DML, positive 'found more' correction untouched", () => {
  const migration = readFileSync(path.join(import.meta.dirname, "../supabase/migrations/20260924120000_bake_actual_correction.sql"), "utf8");
  const code = migration.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
  assert.match(code, /create or replace function inventory_private\.correct_bake_actual_pieces\([\s\S]*?security definer set search_path = ''/);
  assert.match(code, /create or replace function public\.correct_bake_actual_pieces\([\s\S]*?security invoker set search_path = ''/);
  assert.match(code, /public\.is_product_lab_owner\(\) is not true/);
  assert.match(code, /inventory_private\.claim_mutation\(p_operation_id, 'bake_actual_correction', v_hash\)/);
  assert.match(code, /revoke all on public\.production_execution_corrections from public, anon, authenticated;\s*grant select on public\.production_execution_corrections to authenticated;/);
  assert.match(code, /revoke all on function public\.correct_bake_actual_pieces\(uuid,uuid,integer,numeric,text\)\s*from public, anon, authenticated;/);
  assert.doesNotMatch(code, /grant\s+(insert|update|delete)[^;]*on\s+public\.(production_executions|production_execution_corrections|finished_stock_movements)/i);
  // Wave 3's exception shape and positive-correction guard are not edited by this migration.
  assert.doesNotMatch(code, /finished_stock_movements_exception_shape/);
  assert.doesNotMatch(code, /create or replace function (public|inventory_private)\.record_finished_stock_exception/);
  // Existing Bake confirmation is not touched.
  assert.doesNotMatch(code, /confirm_bake_v3/);
});
