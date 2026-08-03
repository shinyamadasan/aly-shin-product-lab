import type { Ingredient, InventoryTransaction, StockAdjustmentReason } from "./product-lab-types";
import { convertToBaseUnit } from "./unit-conversion.ts";
import { buildInventoryTransaction } from "./inventory-transaction.ts";

export type StockAdjustmentInput = {
  ingredient: Ingredient;
  // Magnitude only, always > 0, expressed in `unit` -- direction is a separate field so a caller
  // never has to remember "decrease is negative."
  quantity: number;
  unit: string;
  reason: StockAdjustmentReason;
  direction: "decrease" | "increase";
  note: string;
  actor: string | null;
  allowNegative: boolean;
  // A full ISO timestamp, passed in rather than read internally -- same discipline as
  // applyBakeConfirmation's/applySupplyPurchaseEffect's own `today` param.
  today: string;
};

export type StockAdjustmentResult = { ingredient: Ingredient; transaction: InventoryTransaction } | { error: string };

// Stock moved outside baking -- household use, spoilage, a recipe test, spillage, a physical
// stock-count correction, or anything else. Deliberately parallel to Bake, not built on top of it:
// normalizes the entered quantity into the ingredient's own canonical unit (never guessed, same as
// every other inventory-mutation path), applies the same negative-stock policy
// applyBakeConfirmation already enforces (blocked unless allowNegative), and never touches
// averageUnitCost -- an adjustment changes quantity and derived value, not the per-unit cost basis
// a purchase established, exactly like Bake's consume path.
export function applyStockAdjustment({ ingredient, quantity, unit, reason, direction, note, actor, allowNegative, today }: StockAdjustmentInput): StockAdjustmentResult {
  if (!Number.isFinite(quantity) || quantity <= 0) {
    return { error: "Quantity must be a number greater than zero." };
  }

  const convertedQuantity = convertToBaseUnit(quantity, unit, ingredient);
  if (convertedQuantity === null) {
    return { error: `"${unit}" doesn't convert to ${ingredient.name}'s ${ingredient.baseUnit}.` };
  }

  const signedChange = direction === "decrease" ? -convertedQuantity : convertedQuantity;
  const quantityBefore = ingredient.currentQuantity;
  const quantityAfter = quantityBefore + signedChange;

  if (!allowNegative && quantityAfter < 0) {
    return { error: `Not enough ${ingredient.name} in stock (have ${quantityBefore} ${ingredient.baseUnit}, need ${convertedQuantity} ${ingredient.baseUnit}).` };
  }

  return {
    ingredient: { ...ingredient, currentQuantity: quantityAfter },
    transaction: buildInventoryTransaction({
      ingredientId: ingredient.id,
      transactionType: "adjustment",
      quantityChange: signedChange,
      quantityBefore,
      quantityAfter,
      sourceType: "manual",
      sourceId: "",
      note,
      reason,
      actor,
      createdAt: today,
    }),
  };
}

export type ReverseStockAdjustmentResult = { ingredient: Ingredient; transaction: InventoryTransaction } | { error: string };

// Reverses an adjustment by submitting another one -- an exact negation, never a deletion or edit
// of the original row. Reuses the existing sourceId field to point at the transaction being
// reversed (transactionType === "adjustment" && sourceId !== "" is what makes a reversal
// recognizable), so no new column is needed just to express "this undoes that."
//
// Defensive validation, not just relying on the Inventory Timeline's canReverse gate (which
// already only ever renders "Reverse" on a non-reversal adjustment row) -- this is the actual
// enforcement point, so a caller invoking this directly (bypassing the UI) can never mutate
// inventory or insert a ledger row for the wrong kind of transaction.
export function reverseStockAdjustment(ingredient: Ingredient, originalTransaction: InventoryTransaction, actor: string | null, today: string): ReverseStockAdjustmentResult {
  if (originalTransaction.transactionType !== "adjustment") {
    return { error: `Only a stock adjustment can be reversed this way -- this is a "${originalTransaction.transactionType}" transaction.` };
  }

  // A reversal transaction always names the transaction it undoes via sourceId (an original
  // adjustment's own sourceId is always ""). Reversing a reversal is deliberately not supported --
  // chaining reversals would let a "Reversal of a reversal of..." ledger note grow indefinitely
  // and makes "which direction does this net out to" harder to audit, for no operational need this
  // feature was asked to serve. This is the same rule the Timeline's canReverse check already
  // enforces by never rendering "Reverse" on a reversal row -- enforced here too, not only there.
  if (originalTransaction.sourceId) {
    return { error: "This transaction is already a reversal and cannot itself be reversed." };
  }

  const quantityBefore = ingredient.currentQuantity;
  const quantityAfter = quantityBefore - originalTransaction.quantityChange;

  return {
    ingredient: { ...ingredient, currentQuantity: quantityAfter },
    transaction: buildInventoryTransaction({
      ingredientId: ingredient.id,
      transactionType: "adjustment",
      quantityChange: -originalTransaction.quantityChange,
      quantityBefore,
      quantityAfter,
      sourceType: "manual",
      sourceId: originalTransaction.id,
      note: originalTransaction.note ? `Reversal of ${originalTransaction.id}: ${originalTransaction.note}` : `Reversal of ${originalTransaction.id}`,
      reason: originalTransaction.reason,
      actor,
      createdAt: today,
    }),
  };
}
