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

export function isExpiringStatus(status: ExpirationStatus) {
  return status === "expired" || status === "expires-today" || status === "expires-soon";
}

export function getExpiringIngredients(ingredients: Ingredient[], today: string, expiresSoonDays: number = DEFAULT_EXPIRES_SOON_DAYS) {
  return ingredients
    .filter((ingredient) => ingredient.isActive)
    .map((ingredient) => ({ ...ingredient, expirationStatus: getExpirationStatus(ingredient.nearestExpirationDate, today, expiresSoonDays) }))
    .filter((ingredient) => isExpiringStatus(ingredient.expirationStatus))
    .sort((a, b) => Date.parse(a.nearestExpirationDate) - Date.parse(b.nearestExpirationDate));
}

// Ingredients supabase-migrate-canonical-base-units.sql could not safely convert -- an
// unrecognized legacy base_unit, or a non-finite numeric field -- left exactly as they were
// rather than guessed at. Deliberately not filtered to active ingredients only: a flag is a
// data-integrity issue regardless of whether the ingredient is currently in active use, and the
// NOT VALID base_unit constraint can still block a write to an archived-but-flagged row.
export function getFlaggedIngredients(ingredients: Ingredient[]) {
  return ingredients.filter((ingredient) => Boolean(ingredient.baseUnitMigrationFlaggedReason));
}

// low_stock_threshold is configured (by convention, not a stored fact) as 2x the amount one
// production cycle requires -- halving it recovers that cycle requirement without a new stored
// column. 0 when no threshold is set, so callers never divide by zero.
export function getOneCycleRequirement(lowStockThreshold: number): number {
  return lowStockThreshold > 0 ? lowStockThreshold / 2 : 0;
}

// A finer-grained read of urgency than StockStatus's plain out/low/good, scoped to the Inventory
// Stock list: "low" collapses two very different situations (just under threshold vs. nearly
// empty) into one label. Deliberately not a replacement for StockStatus -- getStockStatus still
// drives Need to Buy, the Dashboard summary cards, and the AI advisor's business-context adapter,
// none of which this slice touches. "not_configured" is its own state, not folded into "good",
// so a threshold of 0 never falsely reads as healthy stock.
export type StockUrgencyStatus = "not_configured" | "out_of_stock" | "critical" | "reorder_soon" | "good";

export function getStockUrgencyStatus(ingredient: Pick<Ingredient, "currentQuantity" | "lowStockThreshold">): StockUrgencyStatus {
  const { currentQuantity, lowStockThreshold } = ingredient;
  if (lowStockThreshold <= 0) {
    return "not_configured";
  }
  if (currentQuantity <= 0) {
    return "out_of_stock";
  }
  if (currentQuantity <= getOneCycleRequirement(lowStockThreshold)) {
    return "critical";
  }
  if (currentQuantity <= lowStockThreshold) {
    return "reorder_soon";
  }
  return "good";
}

// null when no threshold is configured -- there is no "1 cycle" amount to measure against, so
// there is nothing honest to display (not 0, not Infinity).
export function getProductionCyclesRemaining(ingredient: Pick<Ingredient, "currentQuantity" | "lowStockThreshold">): number | null {
  const oneCycle = getOneCycleRequirement(ingredient.lowStockThreshold);
  return oneCycle > 0 ? ingredient.currentQuantity / oneCycle : null;
}

// Display only -- never changes the stored quantity or its canonical unit. "<1 cycle" reads more
// honestly than a rounded "~0.9 cycles" when there truly isn't a full cycle's worth on hand.
export function formatProductionCoverage(cyclesRemaining: number | null): string {
  if (cyclesRemaining === null) {
    return "";
  }
  if (cyclesRemaining < 1) {
    return "<1 cycle";
  }
  return `~${cyclesRemaining.toFixed(1)} cycles`;
}

// The daily Stock view's own exception filter -- "All" shows everything, "Low & Out" and
// "Expiring" narrow to exactly what used to be separate primary workflows (Need to Buy, and the
// expiration badges) before they folded into Stock as filters. Kept a pure predicate (rather than
// inline in the component) so it stays testable without rendering anything.
export type StockViewFilter = "all" | "attention" | "expiring";

export function matchesStockFilter(
  ingredient: Pick<Ingredient, "currentQuantity" | "lowStockThreshold" | "nearestExpirationDate">,
  filter: StockViewFilter,
  today: string,
  expiresSoonDays: number = DEFAULT_EXPIRES_SOON_DAYS,
): boolean {
  if (filter === "attention") {
    return getStockStatus(ingredient) !== "good";
  }
  if (filter === "expiring") {
    return isExpiringStatus(getExpirationStatus(ingredient.nearestExpirationDate, today, expiresSoonDays));
  }
  return true;
}

// Plain substring match on name, case-insensitive. An empty/whitespace-only query matches
// everything -- the search field is a narrowing tool, not a required gate.
export function matchesStockSearch(ingredient: Pick<Ingredient, "name">, query: string): boolean {
  const trimmed = query.trim().toLowerCase();
  return !trimmed || ingredient.name.toLowerCase().includes(trimmed);
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

// Mobile Inventory + Bake Consolidation V1: Inventory Stock's mobile summary strip, one chip per
// StockUrgencyStatus bucket. A thin tally over the existing getStockUrgencyStatus -- never a second
// urgency model.
export function getStockUrgencySummaryCounts(ingredients: Ingredient[]): Record<StockUrgencyStatus, number> {
  const counts: Record<StockUrgencyStatus, number> = { not_configured: 0, out_of_stock: 0, critical: 0, reorder_soon: 0, good: 0 };
  for (const ingredient of ingredients) {
    if (!ingredient.isActive) {
      continue;
    }
    counts[getStockUrgencyStatus(ingredient)] += 1;
  }
  return counts;
}

const URGENCY_SORT_RANK: Record<StockUrgencyStatus, number> = { out_of_stock: 0, critical: 1, reorder_soon: 2, good: 3, not_configured: 4 };

// Orders by urgency (out_of_stock first, not_configured last), alphabetical within the same
// urgency -- the same tie-break convention getNeedToBuyList already uses. Deliberately does not
// consult expiration at all: that is a separate, independent model (see
// hasActionableExpirationOrFlag below), never folded into one merged rank.
export function sortIngredientsByUrgency<T extends Pick<Ingredient, "currentQuantity" | "lowStockThreshold" | "name">>(ingredients: T[]): T[] {
  return [...ingredients].sort((a, b) => {
    const rankDiff = URGENCY_SORT_RANK[getStockUrgencyStatus(a)] - URGENCY_SORT_RANK[getStockUrgencyStatus(b)];
    return rankDiff !== 0 ? rankDiff : a.name.localeCompare(b.name);
  });
}

// Mobile Inventory Attention Amendment: the union the mobile "Needs attention" grouping and summary
// strip both need -- true when the ingredient's EXISTING expiration model already says
// expired/expires-today/expires-soon, OR its EXISTING data-integrity flag is set. A boolean OR of
// two already-canonical predicates, never a new expiration model and never a combined numeric score.
export function hasActionableExpirationOrFlag(
  ingredient: Pick<Ingredient, "nearestExpirationDate" | "baseUnitMigrationFlaggedReason">,
  today: string,
  expiresSoonDays: number = DEFAULT_EXPIRES_SOON_DAYS,
): boolean {
  return isExpiringStatus(getExpirationStatus(ingredient.nearestExpirationDate, today, expiresSoonDays)) || Boolean(ingredient.baseUnitMigrationFlaggedReason);
}

// Mobile summary-strip count for the amendment's "Other attention" chip -- each qualifying
// ingredient counted once even when it is both expiring and flagged (a union, not two chips added
// together), so the strip never implies "all clear" while an expiration/flag exception exists.
export function getExpirationOrFlagAttentionCount(ingredients: Ingredient[], today: string, expiresSoonDays: number = DEFAULT_EXPIRES_SOON_DAYS): number {
  return ingredients.filter((ingredient) => ingredient.isActive).filter((ingredient) => hasActionableExpirationOrFlag(ingredient, today, expiresSoonDays)).length;
}

export interface MobileInventoryAttentionGroups<T> {
  expirationExceptions: T[];
  stockUrgent: T[];
  reorderSoon: T[];
  everythingElse: T[];
}

// Mobile Inventory Attention Amendment's exact 4-group order: (1) an existing expiration/flag
// exception, regardless of stock urgency; (2) remaining out_of_stock/critical; (3) remaining
// reorder_soon; (4) everything else. Every ingredient lands in exactly one group -- an ingredient
// that is both out_of_stock and expired appears once, in group 1, still carrying both of its
// existing badges wherever it's rendered. This is boolean set-membership across two independent
// existing models, never a merged numeric rank between them (the two models still have no shared
// score anywhere in this codebase).
//
// Within-group order reuses each model's own existing canonical order rather than inventing one:
// group 1 sorts by nearestExpirationDate ascending, the same order getExpiringIngredients already
// establishes. A flagged-only ingredient (flag set, no expiration exception) has no date to compare
// against a dated peer -- there is no existing canonical order between "flagged" and "expiring"
// anywhere in this codebase, so flagged-only ingredients sort after the dated ones, alphabetically.
// This is a reported limitation, not an invented cross-model rank. Groups 2/3/4 reuse
// sortIngredientsByUrgency's existing rank + alphabetical order.
export function groupIngredientsForMobileAttention<T extends Ingredient>(
  ingredients: T[],
  today: string,
  expiresSoonDays: number = DEFAULT_EXPIRES_SOON_DAYS,
): MobileInventoryAttentionGroups<T> {
  const active = ingredients.filter((ingredient) => ingredient.isActive);

  const expirationExceptions = active
    .filter((ingredient) => hasActionableExpirationOrFlag(ingredient, today, expiresSoonDays))
    .sort((a, b) => {
      const aExpiring = isExpiringStatus(getExpirationStatus(a.nearestExpirationDate, today, expiresSoonDays));
      const bExpiring = isExpiringStatus(getExpirationStatus(b.nearestExpirationDate, today, expiresSoonDays));
      if (aExpiring && bExpiring) {
        return Date.parse(a.nearestExpirationDate) - Date.parse(b.nearestExpirationDate);
      }
      if (aExpiring !== bExpiring) {
        return aExpiring ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });

  const expirationExceptionIds = new Set(expirationExceptions.map((ingredient) => ingredient.id));
  const remaining = active.filter((ingredient) => !expirationExceptionIds.has(ingredient.id));

  const stockUrgent = sortIngredientsByUrgency(remaining.filter((ingredient) => {
    const status = getStockUrgencyStatus(ingredient);
    return status === "out_of_stock" || status === "critical";
  }));
  const reorderSoon = sortIngredientsByUrgency(remaining.filter((ingredient) => getStockUrgencyStatus(ingredient) === "reorder_soon"));
  const everythingElse = sortIngredientsByUrgency(remaining.filter((ingredient) => {
    const status = getStockUrgencyStatus(ingredient);
    return status !== "out_of_stock" && status !== "critical" && status !== "reorder_soon";
  }));

  return { expirationExceptions, stockUrgent, reorderSoon, everythingElse };
}
