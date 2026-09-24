import type { FinishedStockMovement, Product, ProductionExecution } from "./product-lab-types.ts";
import type { RuleEngineContext } from "./rule-engine/types.ts";
import { getLatestBatch, getLinkedCosting } from "./rule-engine/types.ts";
import { getCostingTotals } from "./costing.ts";
import { sha256Hex } from "./asset-digest.ts";
import { stableStringify } from "./business-context/digest.ts";

// Finished Stock Opening Balance / Physical Count Reconciliation -- pure, synchronous, no network,
// same discipline as buildPurchaseImportRowDrafts/applyBakeConfirmation. No stock write happens
// anywhere in this file; it only computes what a Preview should show and what an Apply RPC call
// should send. The database (apply_finished_stock_reconciliation_batch /
// create_finished_stock_opening_balance, supabase/migrations/20260923130000_finished_stock_opening_balance.sql)
// independently re-derives every one of these numbers under lock and never trusts this module's
// output for anything beyond "what to send" -- this module exists for the operator-facing preview
// and for building the RPC payload, not as a second source of truth.

export type ReconciliationAction = "no_change" | "correction" | "opening_balance" | "investigate_required";

export type ReconciliationPreviewRow = {
  productId: string;
  productName: string;
  onHand: number;
  reserved: number;
  available: number;
  physicalCount: number;
  difference: number;
  action: ReconciliationAction;
  expectedOnHandPieces: number;
  expectedReservedPieces: number;
  expectedLatestMovementId: string | null;
};

// Latest movement for a product, using the SAME tie-break the database uses everywhere else it
// resolves "the latest row" (created_at desc, id desc -- see docs/ARCHITECTURE.md's Safe Purchase
// Delete section). Comparing canonical lowercase UUID text lexically is equivalent to comparing the
// UUID's underlying bytes (each byte maps to exactly two hex characters at a fixed position; hyphens
// sit at the same fixed positions in every UUID and never change the comparison outcome), so a plain
// string comparison here matches Postgres's native `id desc` ordering.
function latestMovement(movements: FinishedStockMovement[]): FinishedStockMovement | undefined {
  return [...movements].sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  })[0];
}

// Physical count reconciles against on_hand (pieces physically present, INCLUDING any reserved for
// a customer -- a reserved piece is still sitting in the store), never `available`. difference =
// physicalCount - onHand.
//
// A positive difference only ever classifies as `opening_balance` when this product has literally
// zero production_executions rows -- the bootstrap-only gate. Once a product has ANY lot (a real
// Bake or an earlier opening balance), a further positive difference is `investigate_required`:
// excluded from Apply by the UI, and rejected outright by the database if submitted anyway. This
// preview classification is advisory only -- the database re-derives it independently, under lock,
// from live state, and is the actual authority.
export function buildReconciliationPreview(
  products: Pick<Product, "id" | "name">[],
  movements: FinishedStockMovement[],
  executions: ProductionExecution[],
  counts: { productId: string; physicalCount: number }[],
): ReconciliationPreviewRow[] {
  const hasAnyLot = new Set(executions.map((execution) => execution.productId));

  return counts
    .map((count) => {
      const product = products.find((entry) => entry.id === count.productId);
      const productMovements = movements.filter((movement) => movement.productId === count.productId);
      const onHand = productMovements.reduce((sum, movement) => sum + movement.onHandDelta, 0);
      const reserved = productMovements.reduce((sum, movement) => sum + movement.reservedDelta, 0);
      const difference = count.physicalCount - onHand;

      let action: ReconciliationAction;
      if (difference === 0) action = "no_change";
      else if (difference < 0) action = "correction";
      else action = hasAnyLot.has(count.productId) ? "investigate_required" : "opening_balance";

      return {
        productId: count.productId,
        productName: product?.name ?? count.productId,
        onHand,
        reserved,
        available: onHand - reserved,
        physicalCount: count.physicalCount,
        difference,
        action,
        expectedOnHandPieces: onHand,
        expectedReservedPieces: reserved,
        expectedLatestMovementId: latestMovement(productMovements)?.id ?? null,
      };
    })
    .sort((a, b) => a.productName.localeCompare(b.productName));
}

export type OpeningBalanceCostEstimate = {
  costPerPiece: number;
  sourceCostingId: string;
  ingredientCost: number;
  costingYield: number;
};

// Ingredient-only estimated cost basis for an opening-balance lot -- deliberately NOT
// getCostingTotals().costPerPiece (which also folds in packaging/labor/utilities/overhead), to stay
// consistent with Wave 1's frozen_cost_per_piece and Wave 3's order_raw_cogs view, both documented
// ingredient-only ("raw") cost. Reuses the existing, tested "current costing for this product"
// selection (getLatestBatch/getLinkedCosting, src/lib/rule-engine/types.ts) rather than
// reimplementing it. Returns null when the product has no costing on record at all -- the caller
// must then block that row's opening-balance action rather than guess a cost.
export function buildOpeningBalanceCostEstimate(product: Product, context: RuleEngineContext): OpeningBalanceCostEstimate | null {
  const batch = getLatestBatch(context, product);
  const costing = getLinkedCosting(context, product, batch);
  if (!costing) return null;

  const { costingYield } = getCostingTotals(costing);
  if (!(costingYield > 0)) return null;

  return {
    costPerPiece: costing.ingredientCost / costingYield,
    sourceCostingId: costing.id,
    ingredientCost: costing.ingredientCost,
    costingYield,
  };
}

export type ReconciliationBatchItemInput = {
  row: ReconciliationPreviewRow;
  costEstimate: OpeningBalanceCostEstimate | null;
  effectiveAt: string;
  note: string;
};

// Pure arg-builder for apply_finished_stock_reconciliation_batch, mirroring
// recordFinishedStockExceptionArgs (src/lib/raw-inventory-authority.ts). Only rows the operator has
// kept included are sent -- `no_change`/`correction`/`opening_balance`, never
// `investigate_required`, which the caller must have already filtered out. The server independently
// re-derives the action from live state; this payload supplies the raw physical count plus the
// staleness guards, never a pre-computed action or delta magnitude.
export function buildReconciliationBatchPayload(items: ReconciliationBatchItemInput[], operationId: string) {
  const p_items = items.map(({ row, costEstimate, effectiveAt, note }) => ({
    product_id: row.productId,
    physical_count: row.physicalCount,
    expected_on_hand_pieces: row.expectedOnHandPieces,
    expected_reserved_pieces: row.expectedReservedPieces,
    expected_latest_movement_id: row.expectedLatestMovementId,
    effective_at: effectiveAt || null,
    estimated_cost_per_piece: costEstimate?.costPerPiece ?? null,
    cost_basis_snapshot: costEstimate
      ? {
          source_costing_id: costEstimate.sourceCostingId,
          ingredient_cost: costEstimate.ingredientCost,
          costing_yield: costEstimate.costingYield,
          computed_cost_per_piece: costEstimate.costPerPiece,
        }
      : null,
    note: note || null,
  }));

  return { p_items, operationId };
}

// SHA-256 over the deterministic item list, matching apply_inventory_physical_count_batch's hash
// contract (64-char lowercase hex, checked server-side by both RPCs). Reuses this codebase's one
// hash implementation (sha256Hex, src/lib/asset-digest.ts) and its one deterministic-stringify
// implementation (stableStringify, src/lib/business-context/digest.ts) rather than reimplementing
// either.
export function hashReconciliationPayload(p_items: ReturnType<typeof buildReconciliationBatchPayload>["p_items"]): Promise<string> {
  return sha256Hex(new TextEncoder().encode(stableStringify(p_items)));
}
