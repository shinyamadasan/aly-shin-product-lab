import type { Ingredient } from "./product-lab-types";

export type StockStatus = "out" | "low" | "good";

export function getStockStatus(ingredient: Pick<Ingredient, "currentQuantity" | "lowStockThreshold">): StockStatus {
  if (ingredient.currentQuantity <= 0) {
    return "out";
  }
  if (ingredient.currentQuantity <= ingredient.lowStockThreshold) {
    return "low";
  }
  return "good";
}

// max(target - current, 0) -- never suggest buying a negative amount when current already
// meets or exceeds target.
export function getSuggestedBuyQuantity(ingredient: Pick<Ingredient, "currentQuantity" | "targetStockQuantity">) {
  return Math.max(ingredient.targetStockQuantity - ingredient.currentQuantity, 0);
}

export function getNeedToBuyList(ingredients: Ingredient[]) {
  return ingredients
    .filter((ingredient) => ingredient.isActive)
    .map((ingredient) => ({ ...ingredient, status: getStockStatus(ingredient), suggestedBuyQuantity: getSuggestedBuyQuantity(ingredient) }))
    .filter((ingredient) => ingredient.status !== "good")
    .sort((a, b) => (a.status === b.status ? a.name.localeCompare(b.name) : a.status === "out" ? -1 : 1));
}

export type ExpirationStatus = "expired" | "expires-today" | "expires-soon" | "good" | "none";

// No runtime settings surface exists anywhere in this app, so "configurable" means a named,
// documented constant rather than a settings-page field.
export const DEFAULT_EXPIRES_SOON_DAYS = 3;

// A separate status from StockStatus, deliberately never combined into one pill -- an ingredient
// can independently be e.g. "Low" on stock and "Expires soon", and both need to be visible at
// once, not collapsed into a single, ambiguous badge.
export function getExpirationStatus(nearestExpirationDate: string, today: string, expiresSoonDays: number = DEFAULT_EXPIRES_SOON_DAYS): ExpirationStatus {
  if (!nearestExpirationDate) {
    return "none";
  }

  const expirationMs = Date.parse(nearestExpirationDate);
  const todayMs = Date.parse(today);
  if (Number.isNaN(expirationMs) || Number.isNaN(todayMs)) {
    return "none";
  }

  const millisecondsPerDay = 24 * 60 * 60 * 1000;
  const daysUntilExpiration = Math.round((expirationMs - todayMs) / millisecondsPerDay);

  if (daysUntilExpiration < 0) {
    return "expired";
  }
  if (daysUntilExpiration === 0) {
    return "expires-today";
  }
  if (daysUntilExpiration <= expiresSoonDays) {
    return "expires-soon";
  }
  return "good";
}

function isExpiringStatus(status: ExpirationStatus) {
  return status === "expired" || status === "expires-today" || status === "expires-soon";
}

export function getExpiringIngredients(ingredients: Ingredient[], today: string, expiresSoonDays: number = DEFAULT_EXPIRES_SOON_DAYS) {
  return ingredients
    .filter((ingredient) => ingredient.isActive)
    .map((ingredient) => ({ ...ingredient, expirationStatus: getExpirationStatus(ingredient.nearestExpirationDate, today, expiresSoonDays) }))
    .filter((ingredient) => isExpiringStatus(ingredient.expirationStatus))
    .sort((a, b) => Date.parse(a.nearestExpirationDate) - Date.parse(b.nearestExpirationDate));
}

// Powers all 3 Dashboard summary cards (low stock, out of stock, expiring) in one pass.
export function getInventorySummaryCounts(ingredients: Ingredient[], today: string, expiresSoonDays: number = DEFAULT_EXPIRES_SOON_DAYS) {
  const active = ingredients.filter((ingredient) => ingredient.isActive);

  return {
    lowCount: active.filter((ingredient) => getStockStatus(ingredient) === "low").length,
    outCount: active.filter((ingredient) => getStockStatus(ingredient) === "out").length,
    expiringCount: active.filter((ingredient) => isExpiringStatus(getExpirationStatus(ingredient.nearestExpirationDate, today, expiresSoonDays))).length,
  };
}
