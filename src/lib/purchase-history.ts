import { normalizeBrandText, normalizeIngredientName } from "./ingredient-normalization.ts";
import { convertUnit } from "./unit-conversion.ts";
import type { Ingredient, SupplyEntry } from "./product-lab-types.ts";

export type PurchaseHistoryFilter = {
  brandName?: string;
};

export type PurchaseItemGroup = {
  ingredient: Ingredient;
  purchases: SupplyEntry[];
};

export type PurchaseGroupSummary = {
  averageUnitCost: number;
  lastPurchaseDate: string;
  latestBrand: string;
  latestPackage: string;
  latestSupplier: string;
  latestUnitCost: number;
  purchaseCount: number;
  totalPurchasedQuantity: number;
  totalPurchasedUnit: string;
};

function hasDurableIngredientId(purchase: SupplyEntry) {
  return purchase.ingredientId.trim().length > 0;
}

function belongsToItem(purchase: SupplyEntry, ingredient: Ingredient) {
  if (hasDurableIngredientId(purchase)) {
    return purchase.ingredientId === ingredient.id;
  }
  return normalizeIngredientName(purchase.ingredientName) === normalizeIngredientName(ingredient.name);
}

function brandMatches(purchase: SupplyEntry, brandName = "") {
  return !brandName.trim() || normalizeBrandText(purchase.brandName) === normalizeBrandText(brandName);
}

export function getPurchaseSortTime(purchase: SupplyEntry) {
  const purchaseTime = purchase.purchaseDate ? Date.parse(purchase.purchaseDate) : NaN;
  if (!Number.isNaN(purchaseTime)) {
    return purchaseTime;
  }
  const createdTime = purchase.createdAt ? Date.parse(purchase.createdAt) : NaN;
  return Number.isNaN(createdTime) ? -Infinity : createdTime;
}

export function getPurchaseHistoryForItem(ingredient: Ingredient, purchases: SupplyEntry[], filter: PurchaseHistoryFilter = {}) {
  return purchases
    .filter((purchase) => belongsToItem(purchase, ingredient))
    .filter((purchase) => brandMatches(purchase, filter.brandName))
    .sort((a, b) => getPurchaseSortTime(b) - getPurchaseSortTime(a));
}

export function groupPurchasesByItem(ingredients: Ingredient[], purchases: SupplyEntry[]): PurchaseItemGroup[] {
  return ingredients
    .map((ingredient) => ({ ingredient, purchases: getPurchaseHistoryForItem(ingredient, purchases) }))
    .filter((group) => group.purchases.length > 0);
}

export function getUnlinkedPurchases(ingredients: Ingredient[], purchases: SupplyEntry[]) {
  return purchases
    .filter((purchase) => !ingredients.some((ingredient) => belongsToItem(purchase, ingredient)))
    .sort((a, b) => getPurchaseSortTime(b) - getPurchaseSortTime(a));
}

export function getChronologicalPurchases(purchases: SupplyEntry[]) {
  return [...purchases].sort((a, b) => getPurchaseSortTime(b) - getPurchaseSortTime(a));
}

export function getPurchaseGroupSummary(group: PurchaseItemGroup): PurchaseGroupSummary {
  const [latestPurchase] = group.purchases;
  const latestUnitCost = latestPurchase && latestPurchase.packQuantity > 0 ? latestPurchase.totalCost / latestPurchase.packQuantity : 0;

  // Total in the most recent purchase's own unit, converting every other purchase into it first --
  // "1kg" and "500g" purchases of the same ingredient are compatible and should combine, even
  // though their recorded units differ. Only a purchase whose unit genuinely doesn't convert (e.g.
  // mass vs volume, or count vs mass) blocks the total, same all-or-nothing "Mixed units" fallback
  // as before -- it's just no longer triggered merely by kg vs g.
  const candidateUnit = group.purchases.find((purchase) => purchase.unit.trim())?.unit.trim() ?? "";
  const canTotalQuantity = candidateUnit.length > 0 && group.purchases.every((purchase) => !purchase.unit.trim() || convertUnit(1, purchase.unit, candidateUnit) !== null);
  const totalPurchasedUnit = canTotalQuantity ? candidateUnit : "";
  const totalPurchasedQuantity = canTotalQuantity
    ? group.purchases.reduce((total, purchase) => total + (convertUnit(purchase.packQuantity, purchase.unit || totalPurchasedUnit, totalPurchasedUnit) ?? 0), 0)
    : 0;
  const pricedPurchases = group.purchases.filter(
    (purchase) => purchase.packQuantity > 0 && purchase.totalCost > 0 && (!totalPurchasedUnit || !purchase.unit.trim() || convertUnit(1, purchase.unit, totalPurchasedUnit) !== null),
  );
  const totalCost = pricedPurchases.reduce((total, purchase) => total + purchase.totalCost, 0);
  const totalQuantityForCost = pricedPurchases.reduce((total, purchase) => total + (convertUnit(purchase.packQuantity, purchase.unit || totalPurchasedUnit, totalPurchasedUnit) ?? 0), 0);

  return {
    averageUnitCost: canTotalQuantity && totalQuantityForCost > 0 ? totalCost / totalQuantityForCost : 0,
    lastPurchaseDate: latestPurchase?.purchaseDate ?? "",
    latestBrand: latestPurchase?.brandName.trim() ?? "",
    latestPackage: latestPurchase && latestPurchase.packQuantity > 0 ? `${latestPurchase.packQuantity}${latestPurchase.unit ? ` ${latestPurchase.unit}` : ""}` : "",
    latestSupplier: latestPurchase?.supplierName.trim() ?? "",
    latestUnitCost,
    purchaseCount: group.purchases.length,
    totalPurchasedQuantity,
    totalPurchasedUnit,
  };
}

export function findItemByIngredientReference(ingredients: Ingredient[], ingredientReference: { ingredientId?: string; ingredientName: string }) {
  const ingredientId = ingredientReference.ingredientId?.trim() ?? "";
  if (ingredientId) {
    return ingredients.find((ingredient) => ingredient.id === ingredientId);
  }

  const target = normalizeIngredientName(ingredientReference.ingredientName);
  return ingredients.find((ingredient) => normalizeIngredientName(ingredient.name) === target);
}

export function getPurchaseHistoryForIngredientReference(
  ingredients: Ingredient[],
  purchases: SupplyEntry[],
  ingredientReference: { ingredientId?: string; ingredientName: string },
  filter: PurchaseHistoryFilter = {},
) {
  const ingredient = findItemByIngredientReference(ingredients, ingredientReference);
  if (ingredient) {
    return getPurchaseHistoryForItem(ingredient, purchases, filter);
  }

  const target = normalizeIngredientName(ingredientReference.ingredientName);
  if (!target) {
    return [];
  }

  return purchases
    .filter((purchase) => !hasDurableIngredientId(purchase))
    .filter((purchase) => normalizeIngredientName(purchase.ingredientName) === target)
    .filter((purchase) => brandMatches(purchase, filter.brandName))
    .sort((a, b) => getPurchaseSortTime(b) - getPurchaseSortTime(a));
}

export function findReliableBrandForItem(ingredient: Ingredient, purchases: SupplyEntry[]) {
  const matchingEntries = getPurchaseHistoryForItem(ingredient, purchases).filter((entry) => entry.brandName.trim());
  const distinctNormalizedBrands = new Set(matchingEntries.map((entry) => normalizeBrandText(entry.brandName)));

  if (distinctNormalizedBrands.size !== 1) {
    return "";
  }

  return matchingEntries[0]?.brandName.trim() ?? "";
}

export function findReliableSupplierForItem(ingredient: Ingredient, purchases: SupplyEntry[]) {
  const matchingEntries = getPurchaseHistoryForItem(ingredient, purchases).filter((entry) => entry.supplierName.trim());
  const distinctSuppliers = new Set(matchingEntries.map((entry) => entry.supplierName.trim().toLowerCase()));

  if (distinctSuppliers.size !== 1) {
    return "";
  }

  return matchingEntries[0]?.supplierName.trim() ?? "";
}
