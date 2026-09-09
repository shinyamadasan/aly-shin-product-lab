import test from "node:test";
import assert from "node:assert/strict";
import { adjustmentSupersededByCount, ingredientMetadataPayload, latestInventoryMovement, rawAdjustmentArgs } from "../src/lib/raw-inventory-authority.ts";
import type { Ingredient, InventoryTransaction } from "../src/lib/product-lab-types.ts";

const ingredient: Ingredient = { id: "sugar", name: "Sugar", baseUnit: "g", category: "ingredient", currentQuantity: 4000, averageUnitCost: 0.075, lowStockThreshold: 100, targetStockQuantity: 5000, nearestExpirationDate: "", notes: "", isActive: true };
const movements: InventoryTransaction[] = [
  { id: "a", ingredientId: "sugar", transactionType: "purchase", quantityBefore: 0, quantityAfter: 3000, quantityChange: 3000, sourceType: "manual", sourceId: "purchase", note: "", createdAt: "2026-07-01T00:00:00Z" },
];

test("metadata payload cannot carry quantity, cost, history, or a reconciliation claim", () => {
  const payload = ingredientMetadataPayload({ ...ingredient, inventoryReconciledAt: "fake" });
  for (const field of ["current_quantity", "average_unit_cost", "inventory_reconciled_at", "id"]) assert.ok(!(field in payload));
  assert.equal(payload.name, "Sugar");
  assert.equal(payload.base_unit, "g");
});

test("physical count sends explicit observation and both stale-state guards, never an invented ledger", () => {
  const args = rawAdjustmentArgs(ingredient, movements, { quantity: 2700, mode: "count", reason: "stock_count_correction", note: "Weighed physically" });
  assert.equal(args.p_quantity, 2700);
  assert.equal(args.p_expected_quantity, 4000);
  assert.equal(args.p_expected_latest_id, "a");
  assert.equal(args.p_expected_unit, "g");
  assert.ok(!("quantity_after" in args));
  assert.ok(!("average_unit_cost" in args));
});

test("latest movement is deterministic without mutating history; missing history stays unknown", () => {
  const rows = [movements[0], { ...movements[0], id: "b" }];
  assert.equal(latestInventoryMovement("sugar", rows)?.id, "b");
  assert.deepEqual(rows.map((row) => row.id), ["a", "b"]);
  assert.equal(latestInventoryMovement("egg", rows), undefined);
});


test("reversal boundary hides old adjustments but retains post-count microsecond precision", () => {
  const counted = { ...ingredient, inventoryReconciledAt: "2026-09-09T12:00:00.123456+00:00" };
  const transaction = { ...movements[0], transactionType: "adjustment" as const };
  assert.equal(adjustmentSupersededByCount({ ...transaction, createdAt: "2026-09-09T12:00:00.123455Z" }, counted), true);
  assert.equal(adjustmentSupersededByCount({ ...transaction, createdAt: "2026-09-09T12:00:00.123456Z" }, counted), true);
  assert.equal(adjustmentSupersededByCount({ ...transaction, createdAt: "2026-09-09T12:00:00.123457Z" }, counted), false);
  assert.equal(adjustmentSupersededByCount({ ...transaction, createdAt: "2026-09-09T05:00:00.123455-07:00" }, counted), true);
  assert.equal(adjustmentSupersededByCount(transaction, ingredient), false);
  assert.equal(adjustmentSupersededByCount(transaction, { ...counted, id: "egg" }), false);
});
