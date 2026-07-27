import { parseBatchIngredients } from "./batches.ts";
import { normalizeIngredientName } from "./ingredient-normalization.ts";
import type { CostingEntry, Ingredient, IngredientAlias, InventoryTransaction, ProductBatch, PurchaseImportRow, SupplyEntry } from "./product-lab-types.ts";

export type ItemReferenceSummary = {
  durable: {
    purchases: number;
    inventoryTransactions: number;
    aliases: number;
    purchaseImportRows: number;
  };
  legacyText: {
    formulaRows: number;
    costingEntries: number;
    purchases: number;
  };
};

export type ItemReferenceInput = {
  ingredient: Ingredient;
  supplies: SupplyEntry[];
  inventoryTransactions: InventoryTransaction[];
  ingredientAliases: IngredientAlias[];
  purchaseImportRows: PurchaseImportRow[];
  batches: ProductBatch[];
  costingEntries: CostingEntry[];
};

export function getItemReferenceSummary({
  ingredient,
  supplies,
  inventoryTransactions,
  ingredientAliases,
  purchaseImportRows,
  batches,
  costingEntries,
}: ItemReferenceInput): ItemReferenceSummary {
  const normalizedName = normalizeIngredientName(ingredient.name);
  return {
    durable: {
      purchases: supplies.filter((entry) => entry.ingredientId.trim() === ingredient.id).length,
      inventoryTransactions: inventoryTransactions.filter((entry) => entry.ingredientId === ingredient.id).length,
      aliases: ingredientAliases.filter((entry) => entry.ingredientId === ingredient.id).length,
      purchaseImportRows: purchaseImportRows.filter((entry) => entry.ingredientId === ingredient.id).length,
    },
    legacyText: {
      formulaRows: batches.reduce(
        (count, batch) => count + parseBatchIngredients(batch.ingredientsNotes).filter((row) => normalizeIngredientName(row.ingredient) === normalizedName).length,
        0,
      ),
      costingEntries: costingEntries.filter((entry) => normalizeIngredientName(entry.ingredientName) === normalizedName).length,
      purchases: supplies.filter((entry) => !entry.ingredientId.trim() && normalizeIngredientName(entry.ingredientName) === normalizedName).length,
    },
  };
}

export function itemReferenceCount(summary: ItemReferenceSummary) {
  return (
    summary.durable.purchases +
    summary.durable.inventoryTransactions +
    summary.durable.aliases +
    summary.durable.purchaseImportRows +
    summary.legacyText.formulaRows +
    summary.legacyText.costingEntries +
    summary.legacyText.purchases
  );
}

export function canHardDeleteItem(summary: ItemReferenceSummary) {
  return itemReferenceCount(summary) === 0;
}

export function archiveItem(ingredient: Ingredient, archivedAt: string): Ingredient {
  return { ...ingredient, archivedAt, isActive: false };
}

export function restoreItem(ingredient: Ingredient): Ingredient {
  return { ...ingredient, archivedAt: "", isActive: true };
}
