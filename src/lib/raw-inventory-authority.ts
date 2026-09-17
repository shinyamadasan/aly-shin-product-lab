import type { BakeDeduction } from "./bake-deduction.ts";
import type { FinishedStockExceptionType, Ingredient, InventoryTransaction, SupplyEntry } from "./product-lab-types.ts";

// Wave 0A's original blanket pause covered every posting path. Wave 0B restores purchase
// posting, CSV confirm, and Bake consumption through database-authoritative mutations; only
// what Wave 0B deliberately still does not restore keeps a pause message, below.

// Safe Purchase Delete (delete_posted_purchase_if_reversible) closed the gap this message used to
// describe unconditionally ("Wave 0B intentionally does not add a safe way to delete one"). It is
// now only shown for a purchase getPurchaseDeleteEligibility() has already determined is NOT
// reversible -- kept as a generic fallback string; the specific eligibility reason from that
// function is always preferred when one is available.
export const RAW_PURCHASE_DELETE_BLOCKED = "This purchase can't be safely deleted. Use a stock adjustment to correct the recorded balance instead.";

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

// Safe Purchase Delete: client-side ADVISORY preview only (button enabled/disabled + which message
// to show), never the enforcement -- delete_posted_purchase_if_reversible re-derives every one of
// these checks itself against the locked, authoritative rows before ever deleting anything, the
// same trust boundary every other mutation in this file already draws. Mirrors
// planSupplyDelete/isSafeToRecalculate's local-only logic, but all-or-nothing (no "quantity-only"
// partial fallback) -- the database path either reverses exactly or refuses, never guesses a
// partial correction.
export type PurchaseDeleteEligibility =
  | { eligible: true; kind: "unmatched" | "reversible" }
  | { eligible: false; reason: string };

export function getPurchaseDeleteEligibility(
  supply: Pick<SupplyEntry, "id" | "ingredientId">,
  transactions: InventoryTransaction[],
): PurchaseDeleteEligibility {
  if (!supply.ingredientId) {
    // Never matched to an Item -- structurally impossible for this purchase to have ever produced
    // a ledger row (inventory_transactions.ingredient_id is NOT NULL) or moved any balance.
    return { eligible: true, kind: "unmatched" };
  }
  const ownTransaction = transactions.find(
    (transaction) => transaction.transactionType === "purchase" && transaction.sourceType === "manual" && transaction.sourceId === supply.id,
  );
  if (!ownTransaction) {
    // Either CSV-imported (one combined ledger row per ingredient per upload -- this purchase's own
    // contribution can't be isolated) or predates per-purchase ledger tracking entirely.
    return { eligible: false, reason: "This purchase's inventory effect can't be isolated (it may be part of a CSV import batch, or predates per-purchase ledger tracking). Use a stock adjustment to correct the balance instead." };
  }
  const latest = latestInventoryMovement(supply.ingredientId, transactions);
  if (!latest || latest.id !== ownTransaction.id) {
    return { eligible: false, reason: "Later inventory activity exists for this Item, so this purchase can no longer be safely reversed. Use a stock adjustment to correct the balance instead." };
  }
  return { eligible: true, kind: "reversible" };
}

export function deletePostedPurchaseIfReversibleArgs(supplyId: string, operationId: string) {
  return { p_operation_id: operationId, p_supply_id: supplyId };
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

// Cost Baseline Repair: certify_ingredient_cost_baseline is the cost-side mirror of
// rawAdjustmentArgs above -- same optimistic-concurrency shape, but writes only
// average_unit_cost + cost_reconciled_at, never current_quantity or inventory_reconciled_at.
//
// p_expected_current_cost is taken from expectedCurrentCost, NOT from ingredient.averageUnitCost:
// the client-side Ingredient type coerces a null DB average_unit_cost to 0 at load time (see
// product-lab.tsx's ingredient row mapping), which would make a genuinely-zero cost and a
// never-set cost indistinguishable here -- exactly the kind of silent conflation this whole
// repair exists to eliminate. Callers must pass the RAW value from a fresh read (null included),
// not the lossy display type, so a stale/wrong guess can never slip past the database's own
// optimistic-concurrency check.
export function certifyIngredientCostBaselineArgs(ingredient: Ingredient, movements: InventoryTransaction[], input: {
  certifiedUnitCost: number; evidenceNote: string; expectedCurrentCost: number | null;
}) {
  return {
    p_ingredient_id: ingredient.id,
    p_certified_unit_cost: input.certifiedUnitCost,
    p_evidence_note: input.evidenceNote,
    p_expected_current_cost: input.expectedCurrentCost,
    p_expected_quantity: ingredient.currentQuantity,
    p_expected_latest_id: latestInventoryMovement(ingredient.id, movements)?.id ?? null,
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

// Wave 3: record_finished_stock_exception is the single narrow writer for damage, giveaway, and
// correction. All three are always a negative quantityDelta -- the database FIFO-deducts from
// currently unreserved stock automatically and never lets the operator choose a lot.
//
// POST-REVIEW FIX: a positive ("found more than recorded") correction is NOT supported -- it let
// an operator attribute extra pieces to an existing production execution with no cost basis of
// its own, which could inflate that execution's fulfilled raw COGS beyond what the Bake actually
// cost. The database rejects a positive quantityDelta before writing anything; this client never
// offers the option. p_production_execution_id is always null -- the RPC signature is unchanged
// from before the fix (kept, not trimmed, since the database still validates it), but no caller
// in this codebase ever supplies one anymore.
export function recordFinishedStockExceptionArgs(
  productId: string, exceptionType: FinishedStockExceptionType, quantityDelta: number,
  note: string, operationId: string,
) {
  return {
    p_operation_id: operationId,
    p_product_id: productId,
    p_exception_type: exceptionType,
    p_quantity_delta: quantityDelta,
    p_production_execution_id: null,
    p_note: note || null,
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
