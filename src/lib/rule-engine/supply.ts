import { type BatchFormulaRow, parseBatchIngredients } from "../batches.ts";
import { getMatchingSupplies, getSupplySortTime } from "../supplies.ts";
import type { Product, ProductBatch, SupplyEntry } from "../product-lab-types.ts";
import { getLatestBatch, insufficientDataResult, type RuleEngineContext, type RuleResult } from "./types.ts";

const CATEGORY = "supply" as const;

// A reasonable default staleness window for SUP-002 -- not a business rule, just this rule's
// working default until the business states an actual per-ingredient reorder cadence.
const STALE_PURCHASE_DAYS = 60;

function loadBearingIngredients(formula: BatchFormulaRow[]): BatchFormulaRow[] {
  return formula.filter((row) => row.ingredient.trim());
}

// SUP-001: missing supplier. Flags a formula ingredient with zero matching supply records --
// reuses getMatchingSupplies exactly as Costing's auto-selection does, so this rule and the
// live Costing form can never disagree about what counts as a match.
function evaluateMissingSupplier(formula: BatchFormulaRow[], supplies: SupplyEntry[]): RuleResult {
  const ingredients = loadBearingIngredients(formula);
  if (ingredients.length === 0) {
    return insufficientDataResult("SUP-001", CATEGORY, "blocker", "No formula logged yet.", "Record a proof batch with a formula first.");
  }

  const missing = ingredients.filter((row) => getMatchingSupplies(supplies, row.brand, row.ingredient, row.unit).length === 0);
  const passed = missing.length === 0;
  return {
    id: "SUP-001",
    category: CATEGORY,
    severity: "blocker",
    passed,
    message: passed ? "Every formula ingredient has a matching supply record." : `No supply record matches: ${missing.map((row) => row.ingredient).join(", ")}.`,
    recommendation: passed ? "No action needed." : "Log a real purchase in Supplies for each missing ingredient, or confirm a manual cost override is intentional.",
  };
}

// SUP-002: ingredient unavailable. Flags a load-bearing ingredient whose most recent matching
// purchase is older than a reasonable staleness window. `now` comes from the caller (see
// RuleEngineContext) -- never read from the system clock here, so this stays pure.
function evaluateIngredientUnavailable(formula: BatchFormulaRow[], supplies: SupplyEntry[], now: number): RuleResult {
  const ingredients = loadBearingIngredients(formula);
  if (ingredients.length === 0) {
    return insufficientDataResult("SUP-002", CATEGORY, "warning", "No formula logged yet.", "Record a proof batch with a formula first.");
  }

  const staleIngredients: string[] = [];
  let anyMatch = false;
  for (const row of ingredients) {
    const matches = getMatchingSupplies(supplies, row.brand, row.ingredient, row.unit);
    const mostRecent = matches[0];
    if (!mostRecent) {
      continue;
    }
    anyMatch = true;
    const ageDays = (now - getSupplySortTime(mostRecent)) / (1000 * 60 * 60 * 24);
    if (ageDays > STALE_PURCHASE_DAYS) {
      staleIngredients.push(row.ingredient);
    }
  }

  if (!anyMatch) {
    return insufficientDataResult("SUP-002", CATEGORY, "warning", "No matching supply records to check staleness against.", "See SUP-001.");
  }

  const passed = staleIngredients.length === 0;
  return {
    id: "SUP-002",
    category: CATEGORY,
    severity: "warning",
    passed,
    message: passed ? "Most recent purchases are all reasonably current." : `No purchase in the last ${STALE_PURCHASE_DAYS} days for: ${staleIngredients.join(", ")}.`,
    recommendation: passed ? "No action needed." : "Confirm these ingredients are still available, or log a fresh purchase.",
  };
}

// SUP-003: large recent price increase. Needs 2+ historical purchases for the same ingredient
// to compare -- most home-proofing ingredients won't have this yet, so insufficient data is the
// common, honest result today.
function evaluateLargePriceIncrease(formula: BatchFormulaRow[], supplies: SupplyEntry[]): RuleResult {
  const ingredients = loadBearingIngredients(formula);
  const increases: string[] = [];
  let comparablePairsFound = false;

  for (const row of ingredients) {
    const matches = getMatchingSupplies(supplies, row.brand, row.ingredient, row.unit);
    if (matches.length < 2) {
      continue;
    }
    comparablePairsFound = true;
    const [latest, previous] = matches;
    const latestUnitCost = latest.packQuantity > 0 ? latest.totalCost / latest.packQuantity : 0;
    const previousUnitCost = previous.packQuantity > 0 ? previous.totalCost / previous.packQuantity : 0;
    if (previousUnitCost > 0 && (latestUnitCost - previousUnitCost) / previousUnitCost > 0.15) {
      increases.push(row.ingredient);
    }
  }

  if (!comparablePairsFound) {
    return insufficientDataResult("SUP-003", CATEGORY, "warning", "Fewer than 2 purchases on file for any formula ingredient -- nothing to compare yet.", "Log purchases over time to enable this check.");
  }

  const passed = increases.length === 0;
  return {
    id: "SUP-003",
    category: CATEGORY,
    severity: "warning",
    passed,
    message: passed ? "No recent purchase price jump detected." : `Price rose more than 15% since the previous purchase for: ${increases.join(", ")}.`,
    recommendation: passed ? "No action needed." : "Re-run the costing for this product with the current price and re-check margin (see FIN-001/FIN-007).",
  };
}

// SUP-004: missing substitute. Informational at this stage -- a single-supplier ingredient is
// a real flag, not a launch blocker, while the business is still home-proofing.
function evaluateMissingSubstitute(formula: BatchFormulaRow[], supplies: SupplyEntry[]): RuleResult {
  const ingredients = loadBearingIngredients(formula);
  if (ingredients.length === 0) {
    return insufficientDataResult("SUP-004", CATEGORY, "info", "No formula logged yet.", "Record a proof batch with a formula first.");
  }

  const singleSupplier = ingredients.filter((row) => {
    const matches = getMatchingSupplies(supplies, row.brand, row.ingredient, row.unit);
    const suppliers = new Set(matches.map((supply) => supply.supplierName));
    return matches.length > 0 && suppliers.size === 1;
  });

  const passed = singleSupplier.length === 0;
  return {
    id: "SUP-004",
    category: CATEGORY,
    severity: "info",
    passed,
    message: passed ? "No load-bearing ingredient relies on a single supplier." : `Only one supplier on file for: ${singleSupplier.map((row) => row.ingredient).join(", ")}.`,
    recommendation: passed ? "No action needed." : "Not urgent at this scale -- worth a note if any of these become launch-critical.",
  };
}

export function evaluateSupply(product: Product, context: RuleEngineContext): RuleResult[] {
  const latestBatch: ProductBatch | undefined = getLatestBatch(context, product);
  const formula = parseBatchIngredients(latestBatch?.ingredientsNotes ?? "");

  return [
    evaluateMissingSupplier(formula, context.supplies),
    evaluateIngredientUnavailable(formula, context.supplies, context.now),
    evaluateLargePriceIncrease(formula, context.supplies),
    evaluateMissingSubstitute(formula, context.supplies),
  ];
}
