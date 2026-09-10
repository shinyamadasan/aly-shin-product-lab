import test from "node:test";
import assert from "node:assert/strict";
import {
  adjustmentSupersededByCount, confirmBakeArgs, ingredientMetadataPayload, latestInventoryMovement,
  postedPurchaseInventoryFieldsChanged, postRawPurchaseArgs, rawAdjustmentArgs, updatePostedPurchaseMetadataArgs,
} from "../src/lib/raw-inventory-authority.ts";
import type { Ingredient, InventoryTransaction, SupplyEntry } from "../src/lib/product-lab-types.ts";

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

const supply: SupplyEntry = {
  id: "supply-1", ingredientId: "sugar", ingredientName: "Sugar", brandName: "Local", supplierName: "SM",
  purchaseDate: "2026-09-09", createdAt: "2026-09-09T00:00:00Z", packQuantity: 1000, unit: "g", totalCost: 75,
  qualityRating: 4, notes: "",
};

test("post_raw_purchase args carry the converted base-unit delta, never a computed ending balance", () => {
  const args = postRawPurchaseArgs(supply, 1000, "op-1");
  assert.equal(args.p_operation_id, "op-1");
  assert.equal(args.p_ingredient_id, "sugar");
  assert.equal(args.p_pack_quantity, 1000);
  assert.equal(args.p_display_unit, "g");
  assert.equal(args.p_base_quantity, 1000);
  assert.equal(args.p_total_cost, 75);
  for (const field of Object.keys(args)) assert.ok(!/quantity_after|average_unit_cost/.test(field), field);
});

test("update_posted_purchase_metadata args never carry an inventory-affecting field", () => {
  const args = updatePostedPurchaseMetadataArgs(supply);
  assert.equal(args.p_supply_id, "supply-1");
  assert.equal(args.p_supplier_name, "SM");
  for (const field of ["p_pack_quantity", "p_unit", "p_total_cost", "p_ingredient_id"]) assert.ok(!(field in args), field);
});

test("posted purchase edits are flagged unsafe exactly when quantity, unit, cost, or item changed", () => {
  assert.equal(postedPurchaseInventoryFieldsChanged(supply, { ...supply, brandName: "Callebaut", notes: "different" }), false);
  assert.equal(postedPurchaseInventoryFieldsChanged(supply, { ...supply, packQuantity: 2000 }), true);
  assert.equal(postedPurchaseInventoryFieldsChanged(supply, { ...supply, unit: "kg" }), true);
  assert.equal(postedPurchaseInventoryFieldsChanged(supply, { ...supply, totalCost: 80 }), true);
  assert.equal(postedPurchaseInventoryFieldsChanged(supply, { ...supply, ingredientId: "flour" }), true);
});

test("confirm_bake_v3 args carry the batch, product, observed pieces, a pre-resolved snake_cased deduction list, and no allow-negative escape", () => {
  const args = confirmBakeArgs("batch-1", "brownie", "Brownie v3", 2, 8, [{ ingredientId: "sugar", quantity: 500 }, { ingredientId: "egg", quantity: 4 }], "op-2");
  assert.equal(args.p_operation_id, "op-2");
  assert.equal(args.p_batch_id, "batch-1");
  assert.equal(args.p_product_id, "brownie");
  assert.equal(args.p_multiplier, 2);
  assert.equal(args.p_actual_pieces_produced, 8);
  assert.deepEqual(args.p_deductions, [{ ingredient_id: "sugar", quantity: 500 }, { ingredient_id: "egg", quantity: 4 }]);
  assert.ok(!("p_allow_negative" in args));
});
