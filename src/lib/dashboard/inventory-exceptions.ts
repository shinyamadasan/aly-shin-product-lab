// Dashboard V1: which ingredients need a look, and nothing else.
//
// Composes the three existing inventory-status helpers -- getNeedToBuyList (out / low, active
// only), getExpiringIngredients (expired / expires today / expires soon, active only) and
// getFlaggedIngredients (the canonical-unit migration could not convert this row) -- and merges
// them by ingredient, so an ingredient that is both low and expiring is ONE row with two reasons
// rather than two rows. Thresholds and dates are those helpers' own; none is restated here.
//
// Healthy ingredients never appear. The dashboard summarises exceptions; the Inventory page is
// where the full table lives.
//
// `businessDay` is a YYYY-MM-DD string resolved by the caller (business-day.ts), so this module
// reads no clock and the UTC-vs-Manila question is decided in exactly one place.
//
// Not covered, deliberately: cost certification (`costReconciledAt`). It exists only as an inline
// predicate inside the Bake page, where it gates one specific action, and no shared helper owns the
// concept. Surfacing it here would mean inventing the definition; that belongs to whoever extracts it.

import { getExpiringIngredients, getFlaggedIngredients, getNeedToBuyList, type ExpirationStatus, type StockStatus } from "../inventory-status.ts";
import type { Ingredient } from "../product-lab-types.ts";

export type InventoryExceptionReason =
  | { kind: "stock"; status: Exclude<StockStatus, "good"> }
  | { kind: "expiry"; status: Exclude<ExpirationStatus, "good" | "none">; date: string }
  | { kind: "flagged"; detail: string };

export type InventoryExceptionRow = {
  ingredientId: string;
  name: string;
  currentQuantity: number;
  baseUnit: Ingredient["baseUnit"];
  reasons: InventoryExceptionReason[];
};

// Most urgent first: nothing left, then running low, then expired, expiring, and finally a data flag.
function reasonRank(reason: InventoryExceptionReason): number {
  if (reason.kind === "stock") {
    return reason.status === "out" ? 0 : 1;
  }
  if (reason.kind === "expiry") {
    return reason.status === "expired" ? 2 : reason.status === "expires-today" ? 3 : 4;
  }
  return 5;
}

export function buildInventoryExceptions(ingredients: Ingredient[], businessDay: string): InventoryExceptionRow[] {
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

  // Both helpers already filter to the exceptional statuses; the checks below only narrow the type.
  for (const ingredient of getNeedToBuyList(ingredients)) {
    if (ingredient.status !== "good") {
      rowFor(ingredient).reasons.push({ kind: "stock", status: ingredient.status });
    }
  }
  for (const ingredient of getExpiringIngredients(ingredients, businessDay)) {
    if (ingredient.expirationStatus !== "good" && ingredient.expirationStatus !== "none") {
      rowFor(ingredient).reasons.push({ kind: "expiry", status: ingredient.expirationStatus, date: ingredient.nearestExpirationDate });
    }
  }
  for (const ingredient of getFlaggedIngredients(ingredients)) {
    rowFor(ingredient).reasons.push({ kind: "flagged", detail: ingredient.baseUnitMigrationFlaggedReason ?? "" });
  }

  return Array.from(byId.values())
    .map((row) => ({ ...row, reasons: [...row.reasons].sort((a, b) => reasonRank(a) - reasonRank(b)) }))
    .sort((a, b) => reasonRank(a.reasons[0]) - reasonRank(b.reasons[0]) || a.name.localeCompare(b.name) || a.ingredientId.localeCompare(b.ingredientId));
}
