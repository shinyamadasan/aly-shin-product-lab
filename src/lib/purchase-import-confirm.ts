import type { Ingredient, InventoryTransaction } from "./product-lab-types";
import type { PurchaseImportRowDraft } from "./purchase-import";
import { computeWeightedAverageUnitCost } from "./inventory-cost.ts";
import { buildInventoryTransaction } from "./inventory-transaction.ts";

export type PurchaseImportConfirmInput = {
  ingredients: Ingredient[];
  rows: PurchaseImportRowDraft[];
  importId: string;
  // A full ISO timestamp (not the app's date-only `today` constant) -- stamped on each
  // transaction so same-day imports still order correctly on the Inventory Timeline. Passed in
  // rather than read internally so this function stays deterministic/pure and testable.
  today: string;
};

export type PurchaseImportConfirmResult = { ingredients: Ingredient[]; transactions: InventoryTransaction[] } | { error: string };

// The single implementation of "what does confirming a purchase import do" -- used for both the
// localStorage path (directly) and, in a later milestone, mirrored line-for-line by a Postgres
// RPC for the Supabase path's atomicity. Never called from the preview/draft pipeline, only from
// the operator's explicit Confirm action, so it's the only place `ingredients` quantities change
// as a result of an import.
export function applyPurchaseImportConfirmation({ ingredients, rows, importId, today }: PurchaseImportConfirmInput): PurchaseImportConfirmResult {
  const applicableRows = rows.filter((row) => row.rowStatus !== "excluded");
  const unresolvedRow = applicableRows.find((row) => row.rowStatus !== "matched");
  if (unresolvedRow) {
    return { error: `Row "${unresolvedRow.rawItemName}" still needs to be resolved (or excluded) before this import can be confirmed.` };
  }
  if (applicableRows.length === 0) {
    return { error: "No rows to confirm -- every row was excluded." };
  }

  const rowsByIngredient = new Map<string, PurchaseImportRowDraft[]>();
  applicableRows.forEach((row) => {
    const existing = rowsByIngredient.get(row.ingredientId) ?? [];
    existing.push(row);
    rowsByIngredient.set(row.ingredientId, existing);
  });

  const updatedIngredients = [...ingredients];
  const transactions: InventoryTransaction[] = [];

  rowsByIngredient.forEach((ingredientRows, ingredientId) => {
    const index = updatedIngredients.findIndex((ingredient) => ingredient.id === ingredientId);
    if (index === -1) {
      return;
    }

    const ingredient = updatedIngredients[index];
    // Multiple receipt lines for the same ingredient are grouped here, after per-row unit
    // conversion (never before) -- summing raw quantities across mismatched units would be
    // meaningless, but converted-to-base-unit quantities can always be added.
    const addedQuantity = ingredientRows.reduce((sum, row) => sum + row.convertedQuantity, 0);

    const pricedRows = ingredientRows.filter((row) => row.parsedTotalPrice > 0);
    const addedQuantityWithPrice = pricedRows.reduce((sum, row) => sum + row.convertedQuantity, 0);
    const addedCostWithPrice = pricedRows.reduce((sum, row) => sum + row.parsedTotalPrice, 0);
    const addedQuantityWithoutPrice = addedQuantity - addedQuantityWithPrice;

    const newAverageUnitCost = computeWeightedAverageUnitCost(
      ingredient.currentQuantity,
      ingredient.averageUnitCost,
      addedQuantityWithPrice,
      addedCostWithPrice,
      addedQuantityWithoutPrice,
    );

    // Earliest applicable date wins, whether it's already on the ingredient or arriving on this
    // import -- a later, further-out expiration on a fresh purchase should never push out a
    // sooner date that's already on record.
    const earliestExpiration = ingredientRows
      .map((row) => row.parsedExpirationDate)
      .concat(ingredient.nearestExpirationDate)
      .filter(Boolean)
      .sort()[0] ?? "";

    const quantityBefore = ingredient.currentQuantity;
    const quantityAfter = quantityBefore + addedQuantity;

    updatedIngredients[index] = {
      ...ingredient,
      currentQuantity: quantityAfter,
      averageUnitCost: newAverageUnitCost,
      nearestExpirationDate: earliestExpiration,
    };

    transactions.push(
      buildInventoryTransaction({
        ingredientId,
        transactionType: "purchase",
        quantityChange: addedQuantity,
        quantityBefore,
        quantityAfter,
        sourceType: "purchase_import",
        sourceId: importId,
        note: "",
        createdAt: today,
      }),
    );
  });

  return { ingredients: updatedIngredients, transactions };
}
