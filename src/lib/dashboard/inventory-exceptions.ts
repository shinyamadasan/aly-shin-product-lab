// Dashboard V1: which ingredients need a look, and nothing else.
//
// Composes three inventory-status helpers -- getStockUrgencyStatus (Inventory Stock Status V1's
// not_configured / out_of_stock / critical / reorder_soon / good), getExpiringIngredients (expired
// / expires today / expires soon, active only) and getFlaggedIngredients (the canonical-unit
// migration could not convert this row) -- and merges them by ingredient, so an ingredient that is
// both low and expiring is ONE row with two reasons rather than two rows. Thresholds and dates are
// those helpers' own; none is restated here.
//
// Current Recipes Only (Dashboard Inventory Attention V1): every one of the three checks above
// runs only over ingredients a CURRENT production recipe actually uses (currentRecipeIngredientIds,
// from current-recipe-ingredients.ts). An ingredient that is out of stock but retired from every
// current recipe -- or not yet used by one -- never creates a Dashboard alert, even though it still
// exists in Inventory and can still be flagged/expiring there.
//
// Healthy ("good") and unconfigured ("not_configured") ingredients never appear -- a threshold of 0
// is a setup gap, not a stock alert, and must not be presented as either. The dashboard summarises
// exceptions; the Inventory page is where the full table (including "not configured") lives.
//
// `businessDay` is a YYYY-MM-DD string resolved by the caller (business-day.ts), so this module
// reads no clock and the UTC-vs-Manila question is decided in exactly one place.
//
// Not covered, deliberately: cost certification (`costReconciledAt`). It exists only as an inline
// predicate inside the Bake page, where it gates one specific action, and no shared helper owns the
// concept. Surfacing it here would mean inventing the definition; that belongs to whoever extracts it.

import { getExpiringIngredients, getFlaggedIngredients, getStockUrgencyStatus, type ExpirationStatus, type StockUrgencyStatus } from "../inventory-status.ts";
import type { Ingredient } from "../product-lab-types.ts";

export type InventoryExceptionReason =
  | { kind: "stock"; status: Exclude<StockUrgencyStatus, "good" | "not_configured"> }
  | { kind: "expiry"; status: Exclude<ExpirationStatus, "good" | "none">; date: string }
  | { kind: "flagged"; detail: string };

export type InventoryExceptionRow = {
  ingredientId: string;
  name: string;
  currentQuantity: number;
  baseUnit: Ingredient["baseUnit"];
  reasons: InventoryExceptionReason[];
};

// Most urgent first: nothing left, then critical, then reorder soon, then expired, expiring, and
// finally a data flag.
function reasonRank(reason: InventoryExceptionReason): number {
  if (reason.kind === "stock") {
    return reason.status === "out_of_stock" ? 0 : reason.status === "critical" ? 1 : 2;
  }
  if (reason.kind === "expiry") {
    return reason.status === "expired" ? 3 : reason.status === "expires-today" ? 4 : 5;
  }
  return 6;
}

export function buildInventoryExceptions(ingredients: Ingredient[], businessDay: string, currentRecipeIngredientIds: Set<string>): InventoryExceptionRow[] {
  // Current Recipes Only: an ingredient not used by any current production recipe is filtered out
  // before any of the three checks below run, so it cannot appear for ANY reason (stock, expiry,
  // or a data-integrity flag) -- see this file's header.
  const relevant = ingredients.filter((ingredient) => currentRecipeIngredientIds.has(ingredient.id));
  const byId = new Map<string, InventoryExceptionRow>();

  function rowFor(ingredient: Ingredient): InventoryExceptionRow {
    const existing = byId.get(ingredient.id);
    if (existing) {
      return existing;
    }
    const created: InventoryExceptionRow = {
      ingredientId: ingredient.id,
      name: ingredient.name,
      currentQuantity: ingredient.currentQuantity,
      baseUnit: ingredient.baseUnit,
      reasons: [],
    };
    byId.set(ingredient.id, created);
    return created;
  }

  // "good" and "not_configured" are both non-alerts here -- an unset threshold is a setup gap, not
  // a stock exception, so it is excluded exactly like a healthy ingredient rather than shown as
  // either extreme.
  for (const ingredient of relevant.filter((item) => item.isActive)) {
    const status = getStockUrgencyStatus(ingredient);
    if (status !== "good" && status !== "not_configured") {
      rowFor(ingredient).reasons.push({ kind: "stock", status });
    }
  }
  for (const ingredient of getExpiringIngredients(relevant, businessDay)) {
    if (ingredient.expirationStatus !== "good" && ingredient.expirationStatus !== "none") {
      rowFor(ingredient).reasons.push({ kind: "expiry", status: ingredient.expirationStatus, date: ingredient.nearestExpirationDate });
    }
  }
  for (const ingredient of getFlaggedIngredients(relevant)) {
    rowFor(ingredient).reasons.push({ kind: "flagged", detail: ingredient.baseUnitMigrationFlaggedReason ?? "" });
  }

  return Array.from(byId.values())
    .map((row) => ({ ...row, reasons: [...row.reasons].sort((a, b) => reasonRank(a) - reasonRank(b)) }))
    .sort((a, b) => reasonRank(a.reasons[0]) - reasonRank(b.reasons[0]) || a.name.localeCompare(b.name) || a.ingredientId.localeCompare(b.ingredientId));
}
