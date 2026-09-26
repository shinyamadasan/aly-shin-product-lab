import type { FinishedStockBalance, FinishedStockMovement, ProductionExecution, Product } from "./product-lab-types.ts";

// Wave 1: on_hand / reserved / available are derived from the append-only movement ledger, never
// cached. Small bakery scale -- summing a handful of rows in the browser is fine and matches how
// the app already derives raw-inventory numbers from inventory_transactions. reserved is always 0
// in Wave 1 (reservation does not exist yet), but the shape is kept so Wave 2 slots in without a
// UI redesign.
export function deriveFinishedStockBalances(
  products: Pick<Product, "id" | "name">[],
  movements: FinishedStockMovement[],
): FinishedStockBalance[] {
  const byProduct = new Map<string, { onHand: number; reserved: number }>();
  for (const movement of movements) {
    const entry = byProduct.get(movement.productId) ?? { onHand: 0, reserved: 0 };
    entry.onHand += movement.onHandDelta;
    entry.reserved += movement.reservedDelta;
    byProduct.set(movement.productId, entry);
  }
  return products
    .map((product) => {
      const entry = byProduct.get(product.id) ?? { onHand: 0, reserved: 0 };
      return {
        productId: product.id,
        productName: product.name,
        onHandPieces: entry.onHand,
        reservedPieces: entry.reserved,
        availablePieces: entry.onHand - entry.reserved,
      };
    })
    .sort((a, b) => a.productName.localeCompare(b.productName));
}

// Production history newest-first, for the minimal operator view.
export function sortProductionHistory(executions: ProductionExecution[]): ProductionExecution[] {
  return [...executions].sort((a, b) => b.completedAt.localeCompare(a.completedAt) || b.createdAt.localeCompare(a.createdAt));
}

// Finished Stock Opening Balance: the one predicate every caller should use to tell a real physical
// Bake apart from a bootstrap opening-balance lot, rather than re-deriving it from sourceType
// inline at each call site. An opening-balance lot is a real, FIFO-compatible inventory lot -- it
// must still be counted everywhere finished-stock balances/FIFO/reservations read
// production_executions -- but it must never be presented as, or counted as evidence of, an actual
// production/Bake event.
export function isRealProduction(execution: ProductionExecution): boolean {
  return execution.sourceType === "bake";
}

// Wave 3: exception history (damage/giveaway/correction), newest-first, for the minimal operator
// audit view -- section 28's "no charts, no warehouse dashboard" scope.
export function sortFinishedStockExceptionHistory(movements: FinishedStockMovement[]): FinishedStockMovement[] {
  return movements
    .filter((movement) => movement.movementType === "damage" || movement.movementType === "giveaway" || movement.movementType === "correction")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// Mobile History Density Amendment: Bake's mobile Production History / Finished-stock Exceptions
// cards show 5 records at a time rather than dumping their full slice at once. These two helpers are
// pure presentational paging over whatever array they're given -- generic over T, so they can only
// slice/cap it, never re-sort or re-derive it. The array's own order (already produced by
// sortProductionHistory/sortFinishedStockExceptionHistory upstream) is preserved exactly.
export const MOBILE_HISTORY_PAGE_SIZE = 5;

export function getMobileHistoryPage<T>(items: T[], visibleCount: number): { visible: T[]; hasMore: boolean; canCollapse: boolean } {
  return {
    visible: items.slice(0, visibleCount),
    hasMore: visibleCount < items.length,
    canCollapse: visibleCount > MOBILE_HISTORY_PAGE_SIZE,
  };
}

export function expandMobileHistoryPage(currentVisibleCount: number, total: number): number {
  return Math.min(currentVisibleCount + MOBILE_HISTORY_PAGE_SIZE, total);
}
