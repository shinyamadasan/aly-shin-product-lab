import type { Ingredient, InventoryTransaction } from "./product-lab-types.ts";
import type { BakeDeduction } from "./bake-deduction.ts";
import { buildInventoryTransaction } from "./inventory-transaction.ts";

export type BakeConfirmInput = {
  ingredients: Ingredient[];
  deductions: BakeDeduction[];
  batchId: string;
  batchLabel: string;
  multiplier: number;
  allowNegative: boolean;
  // A full ISO timestamp, passed in rather than read internally so this stays pure/testable --
  // same discipline as applyPurchaseImportConfirmation's `today` param.
  today: string;
};

export type BakeConfirmResult = { ingredients: Ingredient[]; transactions: InventoryTransaction[] } | { error: string };

// The single implementation of "what does confirming a bake do" -- used identically by the
// localStorage path and (via sequential writes this milestone) the Supabase path. Never touches
// average_unit_cost: deducting stock changes quantity and derived value, not the per-unit cost
// basis a purchase established. Called from exactly one place (confirmBake in product-lab.tsx),
// which is itself guarded against re-entrant double-clicks in the UI layer -- this function has
// no independent "already applied" state of its own, matching Bake's simpler-than-import
// lifecycle (no persisted draft to guard against reapplying on refresh; a refresh just loses the
// in-progress selection, nothing to reapply).
export function applyBakeConfirmation({ ingredients, deductions, batchId, batchLabel, multiplier, allowNegative, today }: BakeConfirmInput): BakeConfirmResult {
  if (!Number.isFinite(multiplier) || multiplier <= 0) {
    return { error: "Batches made must be a number greater than zero." };
  }
  if (deductions.length === 0) {
    return { error: "No ingredients to deduct." };
  }

  const missingDeduction = deductions.find((deduction) => !ingredients.some((ingredient) => ingredient.id === deduction.ingredientId));
  if (missingDeduction) {
    return { error: "One of the resolved ingredients could not be found." };
  }

  if (!allowNegative) {
    const insufficientDeduction = deductions.find((deduction) => {
      const ingredient = ingredients.find((item) => item.id === deduction.ingredientId);
      return Boolean(ingredient) && deduction.quantity > ingredient!.currentQuantity;
    });
    if (insufficientDeduction) {
      const ingredient = ingredients.find((item) => item.id === insufficientDeduction.ingredientId)!;
      return {
        error: `Not enough ${ingredient.name} in stock (have ${ingredient.currentQuantity} ${ingredient.baseUnit}, need ${insufficientDeduction.quantity} ${ingredient.baseUnit}).`,
      };
    }
  }

  const updatedIngredients = [...ingredients];
  const transactions: InventoryTransaction[] = [];
  const note = `Bake: ${batchLabel} ×${multiplier}`;

  deductions.forEach((deduction) => {
    const index = updatedIngredients.findIndex((ingredient) => ingredient.id === deduction.ingredientId);
    if (index === -1) {
      return;
    }

    const ingredient = updatedIngredients[index];
    const quantityBefore = ingredient.currentQuantity;
    const quantityAfter = quantityBefore - deduction.quantity;

    updatedIngredients[index] = { ...ingredient, currentQuantity: quantityAfter };

    transactions.push(
      buildInventoryTransaction({
        ingredientId: deduction.ingredientId,
        transactionType: "consume",
        quantityChange: -deduction.quantity,
        quantityBefore,
        quantityAfter,
        sourceType: "bake",
        sourceId: batchId,
        note,
        createdAt: today,
      }),
    );
  });

  return { ingredients: updatedIngredients, transactions };
}
