import test from "node:test";
import assert from "node:assert/strict";
import { buildInventoryTransaction, toInventoryTransactionRow } from "../src/lib/inventory-transaction.ts";
import type { InventoryTransaction } from "../src/lib/product-lab-types.ts";

function baseParams() {
  return {
    ingredientId: "milk-id",
    transactionType: "purchase" as const,
    quantityChange: 6000,
    quantityBefore: 0,
    quantityAfter: 6000,
    sourceType: "purchase_import" as const,
    sourceId: "import-1",
    note: "",
  };
}

test("buildInventoryTransaction preserves every field's exact value and naming", () => {
  const transaction = buildInventoryTransaction({ ...baseParams(), id: "fixed-id", createdAt: "2026-07-24T00:00:00.000Z" });

  assert.deepEqual(transaction, {
    id: "fixed-id",
    ingredientId: "milk-id",
    transactionType: "purchase",
    quantityChange: 6000,
    quantityBefore: 0,
    quantityAfter: 6000,
    sourceType: "purchase_import",
    sourceId: "import-1",
    note: "",
    createdAt: "2026-07-24T00:00:00.000Z",
  });
});

test("buildInventoryTransaction generates a real UUID for id when none is provided", () => {
  const transaction = buildInventoryTransaction({ ...baseParams(), createdAt: "2026-07-24T00:00:00.000Z" });

  assert.match(transaction.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
});

test("buildInventoryTransaction generates a real ISO timestamp for createdAt when none is provided", () => {
  const before = Date.now();
  const transaction = buildInventoryTransaction({ ...baseParams(), id: "fixed-id" });
  const after = Date.now();

  const createdAtMs = Date.parse(transaction.createdAt);
  assert.ok(createdAtMs >= before && createdAtMs <= after);
});

test("buildInventoryTransaction with explicit id/createdAt is deterministic across calls (no hidden randomness)", () => {
  const first = buildInventoryTransaction({ ...baseParams(), id: "fixed-id", createdAt: "2026-07-24T00:00:00.000Z" });
  const second = buildInventoryTransaction({ ...baseParams(), id: "fixed-id", createdAt: "2026-07-24T00:00:00.000Z" });

  assert.deepEqual(first, second);
});

test("buildInventoryTransaction supports the consume/bake shape (negative quantityChange, bake source)", () => {
  const transaction = buildInventoryTransaction({
    id: "fixed-id",
    createdAt: "2026-07-24T00:00:00.000Z",
    ingredientId: "flour-id",
    transactionType: "consume",
    quantityChange: -300,
    quantityBefore: 1000,
    quantityAfter: 700,
    sourceType: "bake",
    sourceId: "batch-1",
    note: "Bake: Brownies V3 ×1",
  });

  assert.equal(transaction.transactionType, "consume");
  assert.equal(transaction.sourceType, "bake");
  assert.equal(transaction.quantityChange, -300);
  assert.equal(transaction.note, "Bake: Brownies V3 ×1");
});

test("toInventoryTransactionRow maps every camelCase field to its exact snake_case Supabase column", () => {
  const transaction: InventoryTransaction = {
    id: "fixed-id",
    ingredientId: "milk-id",
    transactionType: "purchase",
    quantityChange: 6000,
    quantityBefore: 0,
    quantityAfter: 6000,
    sourceType: "purchase_import",
    sourceId: "import-1",
    note: "",
    createdAt: "2026-07-24T00:00:00.000Z",
  };

  assert.deepEqual(toInventoryTransactionRow(transaction), {
    id: "fixed-id",
    ingredient_id: "milk-id",
    transaction_type: "purchase",
    quantity_change: 6000,
    quantity_before: 0,
    quantity_after: 6000,
    source_type: "purchase_import",
    source_id: "import-1",
    note: "",
  });
});

test("toInventoryTransactionRow keeps id for idempotent retry paths and omits created_at", () => {
  const transaction = buildInventoryTransaction({ ...baseParams(), id: "fixed-id", createdAt: "2026-07-24T00:00:00.000Z" });

  const row = toInventoryTransactionRow(transaction);

  assert.equal(row.id, "fixed-id");
  assert.equal("created_at" in row, false);
});

test("toInventoryTransactionRow does not mutate the transaction passed in", () => {
  const transaction = buildInventoryTransaction({ ...baseParams(), id: "fixed-id", createdAt: "2026-07-24T00:00:00.000Z" });
  const snapshot = JSON.parse(JSON.stringify(transaction));

  toInventoryTransactionRow(transaction);

  assert.deepEqual(transaction, snapshot);
});
