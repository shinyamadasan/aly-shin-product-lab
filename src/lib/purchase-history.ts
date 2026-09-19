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

// Contextual brand hint for a display that has no room for full purchase history (e.g. the Stock
// list's Item cell) -- the most recent purchase that actually recorded a brand, using the exact
// same purchase-history ordering (getPurchaseHistoryForItem's own sort) every other "latest
// purchase" reading in this app already uses, so "most recent" can't quietly mean two different
// things depending on where you look. Deliberately NOT findReliableBrandForItem: that function
// answers a different question ("does every purchase on file agree on one brand"), and returns ""
// the moment two purchases disagree -- exactly the opposite of "show me whichever brand was
// bought most recently." Says nothing about which brand any specific unit currently on hand is.
export function findLatestBrandForItem(ingredient: Ingredient, purchases: SupplyEntry[]) {
  const latestWithBrand = getPurchaseHistoryForItem(ingredient, purchases).find((purchase) => purchase.brandName.trim());
  return latestWithBrand?.brandName.trim() ?? "";
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

// Client-side search over the purchase history already loaded on the page. A purchase matches on
// its Item name (the linked Item's current name when known, plus the name recorded on the
// purchase), brand, or supplier -- case-insensitive substring; an empty query matches everything.
export function matchesPurchaseSearch(purchase: Pick<SupplyEntry, "ingredientName" | "brandName" | "supplierName">, query: string, itemName: string = purchase.ingredientName): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return true;
  }
  return [itemName, purchase.ingredientName, purchase.brandName, purchase.supplierName].some((value) => value.toLowerCase().includes(needle));
}

// A By Item group stays visible when the Item's own name matches or any of its purchases matches
// on brand/supplier -- so searching a brand still leads to the Item it was bought for.
export function purchaseGroupMatchesSearch(group: PurchaseItemGroup, query: string): boolean {
  return group.purchases.some((purchase) => matchesPurchaseSearch(purchase, query, group.ingredient.name)) || matchesPurchaseSearch({ ingredientName: group.ingredient.name, brandName: "", supplierName: "" }, query);
}
