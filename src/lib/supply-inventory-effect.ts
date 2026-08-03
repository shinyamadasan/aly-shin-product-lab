import type { Ingredient, InventoryTransaction, SupplyEntry } from "./product-lab-types";
import { computeWeightedAverageUnitCost } from "./inventory-cost.ts";
import { buildInventoryTransaction } from "./inventory-transaction.ts";
import { convertToBaseUnit } from "./unit-conversion.ts";
import { getPurchaseHistoryForItem, getPurchaseSortTime } from "./purchase-history.ts";

export type SupplyPurchaseEffect = { ingredient: Ingredient; transaction: InventoryTransaction };
export type SupplyPurchaseEffectResult = SupplyPurchaseEffect | { error: string };

type SupplyQuantityCost = Pick<SupplyEntry, "packQuantity" | "totalCost" | "unit">;

function unconvertibleUnitError(ingredient: Pick<Ingredient, "name" | "baseUnit">, unit: string): string {
  return `"${unit}" doesn't convert to ${ingredient.name}'s ${ingredient.baseUnit}.`;
}

// Applies one purchase's effect to an ingredient -- converts packQuantity into the ingredient's own
// canonical unit (the same convertToBaseUnit CSV import and Bake already use, so a kg purchase
// against a gram-based ingredient adds 1000, not 1), then adds it to currentQuantity and blends
// totalCost into averageUnitCost via the same weighted-average rule every other
// purchase-confirmation path already uses. Pure: the caller decides how/whether to persist the
// result. Pass `transactionId` to amend an existing ledger row in place (the "safe to recalculate"
// edit case) instead of minting a new one.
export function applySupplyPurchaseEffect(ingredient: Ingredient, supply: SupplyQuantityCost, sourceId: string, today: string, transactionId?: string): SupplyPurchaseEffectResult {
  const convertedQuantity = convertToBaseUnit(supply.packQuantity, supply.unit, ingredient);
  if (convertedQuantity === null) {
    return { error: unconvertibleUnitError(ingredient, supply.unit) };
  }

  const hasPrice = supply.totalCost > 0;
  const quantityBefore = ingredient.currentQuantity;
  const quantityAfter = quantityBefore + convertedQuantity;
  const averageUnitCost = computeWeightedAverageUnitCost(
    quantityBefore,
    ingredient.averageUnitCost,
    hasPrice ? convertedQuantity : 0,
    hasPrice ? supply.totalCost : 0,
    hasPrice ? 0 : convertedQuantity,
  );

  return {
    ingredient: { ...ingredient, currentQuantity: quantityAfter, averageUnitCost },
    transaction: buildInventoryTransaction({
      id: transactionId,
      ingredientId: ingredient.id,
      transactionType: "purchase",
      quantityChange: convertedQuantity,
      quantityBefore,
      quantityAfter,
      sourceType: "manual",
      sourceId,
      note: "",
      createdAt: today,
    }),
  };
}

// Exactly undoes applySupplyPurchaseEffect. Only ever call this when isSafeToRecalculate (below)
// says the purchase being reversed is still the most recent thing that happened to this
// ingredient's stock -- reversing out of order would attribute someone else's quantity/cost change
// to this purchase instead of their own.
export function reverseSupplyPurchaseEffect(ingredient: Ingredient, supply: SupplyQuantityCost): Ingredient | { error: string } {
  const convertedQuantity = convertToBaseUnit(supply.packQuantity, supply.unit, ingredient);
  if (convertedQuantity === null) {
    return { error: unconvertibleUnitError(ingredient, supply.unit) };
  }

  const quantityBefore = Math.max(ingredient.currentQuantity - convertedQuantity, 0);
  const hasPrice = supply.totalCost > 0;

  // An unpriced purchase never moved the average in the first place (see
  // computeWeightedAverageUnitCost: quantity added without a price dilutes nothing), so reversing
  // one only undoes the quantity.
  if (!hasPrice || quantityBefore <= 0) {
    return { ...ingredient, currentQuantity: quantityBefore, averageUnitCost: quantityBefore > 0 ? ingredient.averageUnitCost : 0 };
  }

  const totalCostBasis = ingredient.currentQuantity * ingredient.averageUnitCost - supply.totalCost;
  return { ...ingredient, currentQuantity: quantityBefore, averageUnitCost: totalCostBasis / quantityBefore };
}

// Does a transaction exist whose source_id is exactly this purchase's own id? Matches on sourceId
// alone, not sourceType, so any future path that (like manual logging) records one transaction
// per supply_entries row is recognized correctly regardless of which sourceType it uses.
//
// This does NOT recognize a CSV-imported purchase, and that's expected, not a gap to fix here:
// CSV import's confirm step records one COMBINED transaction per ingredient per upload
// (source_id = the purchase_imports row's id, covering every CSV row for that ingredient
// together), not one per individual supply_entries row -- there is no supply id to match against.
// planSupplyEdit/planSupplyDelete correctly fall back to "not-applied" for such a purchase (safe:
// no inventory effect is guessed at for a row whose specific contribution can't be isolated). The
// backlog-catch-up problem this created for repairMissingSupplyInventoryEffects is solved there
// instead, at the ingredient level, not by trying to widen this match -- see that function's own
// comment for why per-purchase matching against CSV-imported history is fundamentally unsafe.
function findOwnTransaction(supply: Pick<SupplyEntry, "id">, transactions: InventoryTransaction[]) {
  return transactions.find((transaction) => transaction.sourceId === supply.id);
}

// Recalculating average cost by reversing-then-reapplying a purchase is only exact when nothing
// else has touched this ingredient's stock since -- another purchase, a bake, an adjustment,
// anything. Once something later exists, today's currentQuantity/averageUnitCost no longer
// cleanly isolates this purchase's own contribution. Like amending a git HEAD commit: safe while
// it's still the tip, not once something else is built on top of it.
export function isSafeToRecalculate(ownTransaction: InventoryTransaction, allTransactions: InventoryTransaction[]): boolean {
  return !allTransactions.some(
    (transaction) =>
      transaction.ingredientId === ownTransaction.ingredientId &&
      transaction.id !== ownTransaction.id &&
      Date.parse(transaction.createdAt) > Date.parse(ownTransaction.createdAt),
  );
}

export const HISTORICAL_COST_WARNING = "This purchase affects historical costing. Average cost was not automatically recalculated.";

export type SupplyEditPlan =
  | { kind: "not-applied" }
  | { kind: "recalculated"; ingredient: Ingredient; transaction: InventoryTransaction }
  | { kind: "quantity-only"; ingredient: Ingredient; warning: string }
  | { kind: "error"; message: string };

// Plans (does not persist) the inventory-side effect of editing an existing purchase's
// packQuantity/totalCost/unit. Outcomes:
// - "not-applied": this purchase never affected stock in the first place -- nothing to touch.
// - "recalculated": this is still the newest thing that happened to the ingredient, so the old
//   contribution is exactly reversed and the new one exactly reapplied (see the two functions
//   above).
// - "quantity-only": something newer already depends on this purchase's effect, so only the exact,
//   always-safe quantity delta (converted into the ingredient's own unit) is applied; average cost
//   is left as historical fact, with a warning for the caller to surface.
// - "error": either revision's unit doesn't convert to the ingredient's own canonical unit --
//   never guessed, surfaced for the caller to block the edit on.
export function planSupplyEdit(
  ingredient: Ingredient,
  previousSupply: SupplyQuantityCost & { id: string },
  nextSupply: SupplyQuantityCost,
  transactions: InventoryTransaction[],
  today: string,
): SupplyEditPlan {
  const ownTransaction = findOwnTransaction(previousSupply, transactions);
  if (!ownTransaction) {
    return { kind: "not-applied" };
  }

  if (isSafeToRecalculate(ownTransaction, transactions)) {
    const reversed = reverseSupplyPurchaseEffect(ingredient, previousSupply);
    if ("error" in reversed) {
      return { kind: "error", message: reversed.error };
    }
    const applied = applySupplyPurchaseEffect(reversed, nextSupply, previousSupply.id, today, ownTransaction.id);
    if ("error" in applied) {
      return { kind: "error", message: applied.error };
    }
    return { kind: "recalculated", ingredient: applied.ingredient, transaction: applied.transaction };
  }

  const previousQuantity = convertToBaseUnit(previousSupply.packQuantity, previousSupply.unit, ingredient);
  const nextQuantity = convertToBaseUnit(nextSupply.packQuantity, nextSupply.unit, ingredient);
  if (previousQuantity === null || nextQuantity === null) {
    return { kind: "error", message: unconvertibleUnitError(ingredient, previousQuantity === null ? previousSupply.unit : nextSupply.unit) };
  }

  return {
    kind: "quantity-only",
    ingredient: { ...ingredient, currentQuantity: ingredient.currentQuantity + (nextQuantity - previousQuantity) },
    warning: HISTORICAL_COST_WARNING,
  };
}

export type SupplyDeletePlan =
  | { kind: "not-applied" }
  | { kind: "reversed"; ingredient: Ingredient; transactionIdToRemove: string }
  | { kind: "quantity-only"; ingredient: Ingredient; warning: string }
  | { kind: "error"; message: string };

// Same split as planSupplyEdit, for deleting a purchase outright. "reversed" also names the ledger
// row to delete along with it -- undoing at the tip removes the event entirely rather than
// leaving an orphaned entry for something that no longer exists.
export function planSupplyDelete(ingredient: Ingredient, supply: SupplyQuantityCost & { id: string }, transactions: InventoryTransaction[]): SupplyDeletePlan {
  const ownTransaction = findOwnTransaction(supply, transactions);
  if (!ownTransaction) {
    return { kind: "not-applied" };
  }

  if (isSafeToRecalculate(ownTransaction, transactions)) {
    const reversed = reverseSupplyPurchaseEffect(ingredient, supply);
    if ("error" in reversed) {
      return { kind: "error", message: reversed.error };
    }
    return { kind: "reversed", ingredient: reversed, transactionIdToRemove: ownTransaction.id };
  }

  const convertedQuantity = convertToBaseUnit(supply.packQuantity, supply.unit, ingredient);
  if (convertedQuantity === null) {
    return { kind: "error", message: unconvertibleUnitError(ingredient, supply.unit) };
  }

  return {
    kind: "quantity-only",
    ingredient: { ...ingredient, currentQuantity: ingredient.currentQuantity - convertedQuantity },
    warning: HISTORICAL_COST_WARNING,
  };
}

export type SupplyRepairResult = {
  changedIngredients: Ingredient[];
  transactions: InventoryTransaction[];
  // Ingredients skipped because one of their missing purchases didn't convert to the ingredient's
  // own canonical unit -- reported so an operator can reconcile the data by hand, never guessed.
  unconvertible: Array<{ ingredientId: string; supplyId: string; unit: string }>;
};

// One-time, idempotent catch-up: for every ingredient that has NO purchase transaction at all yet
// (never touched by a manual log, an edit, or a CSV import confirm), apply its full purchase
// history in one pass -- and nothing else.
//
// Ingredient-level, not purchase-level, on purpose -- this is the fix for a real incident.
// CSV import's confirm step records ONE combined transaction per ingredient per upload
// (source_id = the purchase_imports row's own id, covering every CSV row for that ingredient in
// that upload together), not one per individual supply_entries row. There is no reliable way to
// tell, from the ledger alone, which of an ingredient's individual purchases a CSV-import
// transaction already covers -- the first version of this function tried to match by supply id
// anyway, silently found no match for any CSV-imported purchase, and re-applied it, doubling
// stock from a single purchase. Skipping any ingredient that already has ANY purchase transaction
// -- from manual logging, an edit, or CSV import -- trades completeness for safety: a genuinely
// still-missing purchase on an ingredient with mixed history stays missing (visible, safe) rather
// than guessed at (invisible, wrong). Safe to run repeatedly: once an ingredient has been touched
// (by this function or anything else), a later run leaves it alone.
export function repairMissingSupplyInventoryEffects(ingredients: Ingredient[], supplies: SupplyEntry[], transactions: InventoryTransaction[], today: string): SupplyRepairResult {
  const ingredientIdsWithAnyPurchaseTransaction = new Set(
    transactions.filter((transaction) => transaction.transactionType === "purchase").map((transaction) => transaction.ingredientId),
  );
  const changedIngredients: Ingredient[] = [];
  const newTransactions: InventoryTransaction[] = [];
  const unconvertible: Array<{ ingredientId: string; supplyId: string; unit: string }> = [];

  ingredients.forEach((ingredient) => {
    if (ingredientIdsWithAnyPurchaseTransaction.has(ingredient.id)) {
      return;
    }

    const missingPurchases = getPurchaseHistoryForItem(ingredient, supplies).sort((a, b) => getPurchaseSortTime(a) - getPurchaseSortTime(b));
    if (missingPurchases.length === 0) {
      return;
    }

    let currentIngredient = ingredient;
    const pendingTransactions: InventoryTransaction[] = [];
    for (const supply of missingPurchases) {
      const effect = applySupplyPurchaseEffect(currentIngredient, supply, supply.id, today);
      if ("error" in effect) {
        // Same "skip entirely rather than guess" tradeoff this function already makes for mixed
        // CSV+manual history -- a partial backfill would leave the running
        // quantityBefore/quantityAfter chain wrong for every purchase after this one.
        unconvertible.push({ ingredientId: ingredient.id, supplyId: supply.id, unit: supply.unit });
        return;
      }
      currentIngredient = effect.ingredient;
      pendingTransactions.push(effect.transaction);
    }
    changedIngredients.push(currentIngredient);
    newTransactions.push(...pendingTransactions);
  });

  return { changedIngredients, transactions: newTransactions, unconvertible };
}
