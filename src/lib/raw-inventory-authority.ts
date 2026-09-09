import type { Ingredient, InventoryTransaction } from "./product-lab-types.ts";

export const RAW_POSTING_PAUSED = "Purchase posting, purchase edits, repairs, and Bake consumption are temporarily unavailable while inventory protection is upgraded. Inventory reads, item details, verified counts, and stock adjustments remain available.";

export function adjustmentSupersededByCount(transaction: InventoryTransaction, ingredient?: Ingredient): boolean {
  if (!ingredient?.inventoryReconciledAt || transaction.ingredientId !== ingredient.id) return false;
  // Preserve PostgreSQL microseconds: Date alone would hide valid post-count adjustments
  // created within the same millisecond. Normalize timezone offsets before comparing.
  const instant = (value: string) => new Date(value).toISOString().slice(0, 19)
    + (value.match(/\.(\d+)/)?.[1] ?? "").padEnd(6, "0").slice(0, 6);
  return instant(transaction.createdAt) <= instant(ingredient.inventoryReconciledAt);
}

export function latestInventoryMovement(ingredientId: string, movements: InventoryTransaction[]): InventoryTransaction | undefined {
  return movements.filter((row) => row.ingredientId === ingredientId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))[0];
}

export function rawAdjustmentArgs(ingredient: Ingredient, movements: InventoryTransaction[], input: {
  quantity: number; mode: "count" | "delta" | "reverse"; reason: string; note: string; reverseId?: string;
}) {
  return {
    p_ingredient_id: ingredient.id,
    p_quantity: input.quantity,
    p_mode: input.mode,
    p_reason: input.reason,
    p_note: input.note,
    p_expected_quantity: ingredient.currentQuantity,
    p_expected_latest_id: latestInventoryMovement(ingredient.id, movements)?.id ?? null,
    p_expected_unit: ingredient.baseUnit,
    p_reverse_id: input.reverseId ?? null,
  };
}

// Deliberately enumerate metadata: neither hidden form inputs nor object spreads can add caches.
export function ingredientMetadataPayload(ingredient: Ingredient) {
  return {
    name: ingredient.name, base_unit: ingredient.baseUnit, category: ingredient.category || null,
    low_stock_threshold: ingredient.lowStockThreshold, target_stock_quantity: ingredient.targetStockQuantity,
    nearest_expiration_date: ingredient.nearestExpirationDate || null, notes: ingredient.notes,
    is_active: ingredient.isActive, archived_at: ingredient.archivedAt || null,
  };
}
