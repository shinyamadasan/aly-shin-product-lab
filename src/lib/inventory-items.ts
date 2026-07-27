import type { Ingredient, SupplyEntry } from "./product-lab-types";
import { normalizeBrandText } from "./ingredient-normalization.ts";
import { getPurchaseHistoryForItem } from "./purchase-history.ts";
import { normalizeSupplyText } from "./supplies.ts";

// Composes one Ingredient with the SupplyEntry records that belong to it, for the unified Items
// view. ingredients and supply_entries stay separate tables (see PROP-010 in
// planning/PROPOSALS.md) -- this is purely a read-side join done by name, the same
// normalizeIngredientName matching ingredient-matching.ts already uses for CSV import.
export type InventoryItemView = {
  ingredient: Ingredient;
  // Most recent purchase first.
  purchaseHistory: SupplyEntry[];
  latestPurchase: SupplyEntry | undefined;
  latestBrand: string;
  latestSupplier: string;
  latestPackageSize: string;
  latestUnitPrice: number;
  averageQualityRating: number;
  // >1 means this ingredient has genuinely been bought under different brands/suppliers -- the
  // Items view surfaces this instead of silently picking one, same "don't resolve an ambiguity,
  // ask" rule as findReliableBrandForIngredient.
  distinctBrandCount: number;
  distinctSupplierCount: number;
};

export function buildInventoryItemView(ingredient: Ingredient, supplies: SupplyEntry[]): InventoryItemView {
  const purchaseHistory = getPurchaseHistoryForItem(ingredient, supplies);

  const latestPurchase = purchaseHistory[0];
  const latestUnitPrice = latestPurchase && latestPurchase.packQuantity > 0 ? latestPurchase.totalCost / latestPurchase.packQuantity : 0;
  const qualityRatings = purchaseHistory.map((entry) => entry.qualityRating).filter((rating) => rating > 0);
  const averageQualityRating = qualityRatings.length ? qualityRatings.reduce((total, rating) => total + rating, 0) / qualityRatings.length : 0;

  return {
    ingredient,
    purchaseHistory,
    latestPurchase,
    latestBrand: latestPurchase?.brandName.trim() ?? "",
    latestSupplier: latestPurchase?.supplierName.trim() ?? "",
    latestPackageSize: latestPurchase && latestPurchase.packQuantity > 0 ? `${latestPurchase.packQuantity}${latestPurchase.unit}` : "",
    latestUnitPrice,
    averageQualityRating,
    distinctBrandCount: new Set(purchaseHistory.filter((entry) => entry.brandName.trim()).map((entry) => normalizeBrandText(entry.brandName))).size,
    distinctSupplierCount: new Set(purchaseHistory.filter((entry) => entry.supplierName.trim()).map((entry) => normalizeSupplyText(entry.supplierName))).size,
  };
}

export function buildInventoryItemViews(ingredients: Ingredient[], supplies: SupplyEntry[]): InventoryItemView[] {
  return ingredients.map((ingredient) => buildInventoryItemView(ingredient, supplies));
}
