import type { FinishedStockBalance, FinishedStockMovement, ProductionExecution, ProductionExecutionCorrection, Product } from "./product-lab-types.ts";

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

// TASK-072: "Corrected 10 -> 12" indicator for Production History. originalActual is what the operator
// first recorded (the earliest correction's previousActual); currentActual is what the Bake records now.
// Null when the Bake has never been corrected. Pure derivation from the append-only audit rows.
export function summarizeBakeCorrections(
  executionId: string,
  corrections: ProductionExecutionCorrection[],
): { originalActual: number; currentActual: number; count: number } | null {
  const mine = corrections
    .filter((correction) => correction.productionExecutionId === executionId)
    .sort((a, b) => a.correctedAt.localeCompare(b.correctedAt));
  if (mine.length === 0) {
    return null;
  }
  return { originalActual: mine[0].previousActual, currentActual: mine[mine.length - 1].correctedActual, count: mine.length };
}

export type BakeCorrectionPreview =
  | { valid: false; message: string }
  | {
      valid: true;
      previousActual: number;
      correctedActual: number;
      delta: number;
      // Pieces of this Bake already sold (fulfilled) -- their raw cost is restated at the new cost per piece.
      fulfilledPieces: number;
      frozenCostTotal: number;
      previousCostPerPiece: number;
      correctedCostPerPiece: number;
    };

// TASK-072: advisory client preview of a Correct Bake. The database re-derives everything under lock
// and is the only authority -- this exists so the operator sees the effect before confirming, and
// is never trusted by the server. A decrease is blocked here with the same rule the server enforces:
// the lot's own unreserved on-hand pieces must cover the reduction.
export function previewBakeCorrection(
  execution: ProductionExecution,
  correctedText: string,
  movements: FinishedStockMovement[],
): BakeCorrectionPreview {
  if (!isRealProduction(execution)) {
    return { valid: false, message: "Only a real Bake can be corrected here." };
  }
  const trimmed = correctedText.trim();
  const corrected = Number(trimmed);
  if (trimmed === "" || !Number.isInteger(corrected) || corrected < 1) {
    return { valid: false, message: "Enter a whole number of at least 1." };
  }
  if (corrected === execution.quantityProducedPieces) {
    return { valid: false, message: "This is already the recorded actual count." };
  }
  const lot = movements.filter((movement) => movement.productionExecutionId === execution.id);
  const onHand = lot.reduce((sum, movement) => sum + movement.onHandDelta, 0);
  const reservedPieces = lot.reduce((sum, movement) => sum + movement.reservedDelta, 0);
  const fulfilledPieces = lot.filter((movement) => movement.movementType === "fulfill").reduce((sum, movement) => sum - movement.onHandDelta, 0);
  const delta = corrected - execution.quantityProducedPieces;
  if (delta < 0 && onHand - reservedPieces < -delta) {
    return {
      valid: false,
      message: `Only ${Math.max(onHand - reservedPieces, 0)} of this Bake's pieces are still unreserved and on hand -- the rest are sold, reserved, damaged, or given away. It cannot be lowered to ${corrected}.`,
    };
  }
  return {
    valid: true,
    previousActual: execution.quantityProducedPieces,
    correctedActual: corrected,
    delta,
    fulfilledPieces,
    frozenCostTotal: execution.frozenIngredientCostTotal,
    previousCostPerPiece: execution.frozenCostPerPiece,
    correctedCostPerPiece: execution.frozenIngredientCostTotal / corrected,
  };
}

// Wave 3: exception history (damage/giveaway/correction), newest-first, for the minimal operator
// audit view -- section 28's "no charts, no warehouse dashboard" scope.
export function sortFinishedStockExceptionHistory(movements: FinishedStockMovement[]): FinishedStockMovement[] {
  return movements
    .filter((movement) => movement.movementType === "damage" || movement.movementType === "giveaway" || movement.movementType === "correction")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// Mobile History Density Amendment: Bake's mobile Production History / Finished-stock Exceptions
// cards show a few records at a time rather than dumping their full slice at once. These two
// helpers are pure presentational paging over whatever array they're given -- generic over T, so
// they can only slice/cap it, never re-sort or re-derive it. The array's own order (already
// produced by sortProductionHistory/sortFinishedStockExceptionHistory upstream) is preserved
// exactly. pageSize is an explicit, required argument (not a shared default) because Mobile Bake
// Final Simplification gave Production History (now behind its own collapsed disclosure) a
// smaller initial reveal than Finished-stock Exceptions (nested one level deeper, under Advanced
// tools) -- two different page sizes, same paging mechanics, never silently mismatched.
export const MOBILE_HISTORY_PAGE_SIZE = 5;
export const MOBILE_PRODUCTION_HISTORY_PAGE_SIZE = 3;

export function getMobileHistoryPage<T>(items: T[], visibleCount: number, pageSize: number): { visible: T[]; hasMore: boolean; canCollapse: boolean } {
  return {
    visible: items.slice(0, visibleCount),
    hasMore: visibleCount < items.length,
    canCollapse: visibleCount > pageSize,
  };
}

export function expandMobileHistoryPage(currentVisibleCount: number, total: number, pageSize: number): number {
  return Math.min(currentVisibleCount + pageSize, total);
}
