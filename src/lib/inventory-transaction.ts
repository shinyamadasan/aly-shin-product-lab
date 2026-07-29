import type { InventoryTransaction, InventoryTransactionSourceType, InventoryTransactionType } from "./product-lab-types.ts";

export type BuildInventoryTransactionParams = {
  ingredientId: string;
  transactionType: InventoryTransactionType;
  quantityChange: number;
  quantityBefore: number;
  quantityAfter: number;
  sourceType: InventoryTransactionSourceType;
  sourceId: string;
  note: string;
  // Optional overrides so tests stay deterministic without mocking crypto.randomUUID() or the
  // clock. Every real confirmation function (purchase import, bake, and any future
  // waste/adjustment/return path) always passes `createdAt` explicitly today, via its own `today`
  // input -- the default here exists for callers that don't need to, not because production
  // behavior relies on it.
  id?: string;
  createdAt?: string;
};

// The single place that knows an InventoryTransaction's shape. Every confirmation function
// builds its ledger rows through this instead of a hand-written object literal, so adding a
// field later (actor, device, location, comment) means editing one function, not hunting down
// every inline construction site.
export function buildInventoryTransaction(params: BuildInventoryTransactionParams): InventoryTransaction {
  return {
    id: params.id ?? crypto.randomUUID(),
    ingredientId: params.ingredientId,
    transactionType: params.transactionType,
    quantityChange: params.quantityChange,
    quantityBefore: params.quantityBefore,
    quantityAfter: params.quantityAfter,
    sourceType: params.sourceType,
    sourceId: params.sourceId,
    note: params.note,
    createdAt: params.createdAt ?? new Date().toISOString(),
  };
}

// The Supabase insert-payload mirror of buildInventoryTransaction. `id` travels so repair/retry
// paths can be idempotent; `created_at` still uses Postgres's own now() default server-side.
export function toInventoryTransactionRow(transaction: InventoryTransaction) {
  return {
    id: transaction.id,
    ingredient_id: transaction.ingredientId,
    transaction_type: transaction.transactionType,
    quantity_change: transaction.quantityChange,
    quantity_before: transaction.quantityBefore,
    quantity_after: transaction.quantityAfter,
    source_type: transaction.sourceType,
    source_id: transaction.sourceId,
    note: transaction.note,
  };
}
