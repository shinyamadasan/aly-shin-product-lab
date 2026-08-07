import { parseBatchIngredients } from "./batches.ts";
import { normalizeIngredientName } from "./ingredient-normalization.ts";
import type { CostingEntry, Ingredient, IngredientAlias, InventoryTransaction, ProductBatch, PurchaseImportRow, SellingFormatPackagingLine, SupplyEntry } from "./product-lab-types.ts";

export type ItemReferenceSummary = {
  durable: {
    purchases: number;
    inventoryTransactions: number;
    aliases: number;
    purchaseImportRows: number;
    sellingFormatPackagingLines: number;
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
  sellingFormatPackagingLines: SellingFormatPackagingLine[];
};

export function getItemReferenceSummary({
  ingredient,
  supplies,
  inventoryTransactions,
  ingredientAliases,
  purchaseImportRows,
  batches,
  costingEntries,
  sellingFormatPackagingLines,
}: ItemReferenceInput): ItemReferenceSummary {
  const normalizedName = normalizeIngredientName(ingredient.name);
  return {
    durable: {
      purchases: supplies.filter((entry) => entry.ingredientId.trim() === ingredient.id).length,
      inventoryTransactions: inventoryTransactions.filter((entry) => entry.ingredientId === ingredient.id).length,
      aliases: ingredientAliases.filter((entry) => entry.ingredientId === ingredient.id).length,
      purchaseImportRows: purchaseImportRows.filter((entry) => entry.ingredientId === ingredient.id).length,
      // Catalog-linked lines only (ingredientId === ""  is a manual line -- never a match here).
      // Deliberately not filtered by the parent Selling Format's isActive: archiving a format
      // never removes or reassigns its packaging lines, so a reference from an archived format
      // is exactly as real and exactly as blocking as one from an active format.
      sellingFormatPackagingLines: sellingFormatPackagingLines.filter((line) => line.ingredientId === ingredient.id).length,
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
    summary.durable.sellingFormatPackagingLines +
    summary.legacyText.formulaRows +
    summary.legacyText.costingEntries +
    summary.legacyText.purchases
  );
}

export function canHardDeleteItem(summary: ItemReferenceSummary) {
  return itemReferenceCount(summary) === 0;
}

// Selling Format packaging usage gets its own named clause (rather than folding into the generic
// "N references" count) because "Archive keeps history intact" isn't self-evident for this
// reference type the way it is for a purchase or inventory transaction -- an operator seeing this
// needs to know specifically that a Selling Format is what's holding the item in place. When there
// is no such reference, this reproduces the prior generic message exactly, unchanged.
export function buildHardDeleteBlockedMessage(ingredient: Ingredient, summary: ItemReferenceSummary): string {
  const formatLineCount = summary.durable.sellingFormatPackagingLines;
  if (formatLineCount > 0) {
    return `${ingredient.name} cannot be permanently deleted because it is used by ${formatLineCount} Selling Format packaging line${formatLineCount === 1 ? "" : "s"}. Archive keeps history intact.`;
  }
  const total = itemReferenceCount(summary);
  return `Permanent delete blocked. ${ingredient.name} has ${total} reference${total === 1 ? "" : "s"}. Archive keeps history intact.`;
}

export function archiveItem(ingredient: Ingredient, archivedAt: string): Ingredient {
  return { ...ingredient, archivedAt, isActive: false };
}

export function restoreItem(ingredient: Ingredient): Ingredient {
  return { ...ingredient, archivedAt: "", isActive: true };
}
