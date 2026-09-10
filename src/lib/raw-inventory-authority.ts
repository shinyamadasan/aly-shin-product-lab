import type { BakeDeduction } from "./bake-deduction.ts";
import type { Ingredient, InventoryTransaction, SupplyEntry } from "./product-lab-types.ts";

// Wave 0A's original blanket pause covered every posting path. Wave 0B restores purchase
// posting, CSV confirm, and Bake consumption through database-authoritative mutations; only
// what Wave 0B deliberately still does not restore keeps a pause message, below.

// A purchase with a ledger effect is historical fact once posted -- Wave 0B intentionally does
// not add a safe way to delete one. Correct the recorded balance with a stock adjustment instead.
export const RAW_PURCHASE_DELETE_BLOCKED = "Posted purchases can't be deleted. Use a stock adjustment to correct the recorded balance instead.";

// The one-time pre-Wave-0A backfill for purchases that predate ledger tracking entirely. Its
// contract -- browser computes an absolute ending quantity/cost and asks the database to accept
// it -- is exactly what Wave 0A/0B remove; verified physical counts are the Wave 0A/0B-era
// replacement for reconciling old gaps, so this is not restored for the remote path.
export const RAW_REPAIR_BLOCKED = "Repair is superseded by verified physical counts. Record a verified count for any Item whose history looks wrong instead.";

// Once a posted purchase has a ledger effect, only these fields may still be edited remotely --
// changing any of the others requires a stock adjustment, never a silent rewrite of history.
export function postedPurchaseInventoryFieldsChanged(previous: SupplyEntry, next: SupplyEntry): boolean {
  return previous.ingredientId !== next.ingredientId
    || previous.packQuantity !== next.packQuantity
    || previous.unit !== next.unit
    || previous.totalCost !== next.totalCost;
}

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

// Wave 0B's post_raw_purchase args. p_base_quantity is the purchase already converted into the
// ingredient's own base unit (see the migration's own comment for why that conversion happens
// client-side); everything else about the resulting quantity/cost is computed by the database
// from its own locked row, never from this payload.
export function postRawPurchaseArgs(supply: SupplyEntry, baseQuantity: number, operationId: string) {
  return {
    p_operation_id: operationId,
    p_ingredient_id: supply.ingredientId,
    p_pack_quantity: supply.packQuantity,
    p_display_unit: supply.unit,
    p_base_quantity: baseQuantity,
    p_total_cost: supply.totalCost,
    p_brand_name: supply.brandName || null,
    p_supplier_name: supply.supplierName,
    p_purchase_date: supply.purchaseDate,
    p_quality_rating: supply.qualityRating,
    p_notes: supply.notes || null,
  };
}

export function updatePostedPurchaseMetadataArgs(supply: SupplyEntry) {
  return {
    p_supply_id: supply.id,
    p_brand_name: supply.brandName || null,
    p_supplier_name: supply.supplierName,
    p_purchase_date: supply.purchaseDate,
    p_quality_rating: supply.qualityRating,
    p_notes: supply.notes || null,
  };
}

// Wave 1: confirm_bake_v3 is the complete atomic production Bake -- raw consumption + one
// production execution + finished-stock receipt + frozen cost, all in one transaction. The client
// supplies the intent (which batch, which product, the multiplier, the pre-resolved deduction
// list) plus the operator's observed usable-piece count, which is the authoritative finished
// quantity; the recipe/version yield stays server-side reference only.
export function confirmBakeArgs(batchId: string, productId: string, batchLabel: string, multiplier: number, actualPiecesProduced: number, deductions: BakeDeduction[], operationId: string) {
  return {
    p_operation_id: operationId,
    p_batch_id: batchId,
    p_product_id: productId,
    p_batch_label: batchLabel,
    p_multiplier: multiplier,
    p_actual_pieces_produced: actualPiecesProduced,
    p_deductions: deductions.map((deduction) => ({ ingredient_id: deduction.ingredientId, quantity: deduction.quantity })),
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
