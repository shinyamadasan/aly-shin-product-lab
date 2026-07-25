import type { BatchFormulaRow } from "./batches.ts";
import type { Ingredient, IngredientAlias, MatchMethod } from "./product-lab-types.ts";
import { resolveIngredientReference } from "./ingredient-matching.ts";
import { convertToBaseUnit } from "./unit-conversion.ts";

// Picks which batch the Bake page should open with. The "Bake this" links on Proof Batches
// deep-link here as /bake?batch=<id>; honor that id ONLY when it's one of the batches actually
// offered in the dropdown (selectableBatchIds), so the shown selection and the deduction preview
// can never disagree. Anything missing or unrecognized falls back to the default (most recent).
export function resolveInitialBatchId(search: string, selectableBatchIds: string[], fallback: string): string {
  const requested = new URLSearchParams(search).get("batch");
  return requested && selectableBatchIds.includes(requested) ? requested : fallback;
}

export type ResolvedBakeRow = {
  rowId: string;
  ingredientName: string;
  brand: string;
  step: string;
  requestedQuantity: number;
  requestedUnit: string;
  ingredientId: string;
  matchMethod: MatchMethod;
  // null means the matched ingredient's base unit and this row's unit don't convert -- blocks
  // confirmation the same way an unmatched ingredient does.
  convertedQuantity: number | null;
};

// Resolves each formula row individually via the exact same alias -> exact -> normalized ->
// manual chain CSV import uses (src/lib/ingredient-matching.ts), sharing the same alias table --
// an alias saved here during a bake auto-resolves a later CSV import's matching row and vice
// versa. Rows stay one-to-one with the batch formula (never pre-grouped), so the same ingredient
// used in two different steps (e.g. cocoa powder in the mix and again as a sprinkle) is resolved
// and displayed as two independent rows, matching how Proof Day already treats them.
export function resolveBakeFormula(formula: BatchFormulaRow[], ingredients: Ingredient[], aliases: IngredientAlias[]): ResolvedBakeRow[] {
  return formula
    .filter((row) => row.ingredient.trim())
    .map((row) => {
      const match = resolveIngredientReference(row.ingredient, ingredients, aliases);
      const matchedIngredient = ingredients.find((ingredient) => ingredient.id === match.ingredientId);
      const convertedQuantity = matchedIngredient ? convertToBaseUnit(row.quantity, row.unit, matchedIngredient) : null;

      return {
        rowId: row.rowId,
        ingredientName: row.ingredient,
        brand: row.brand,
        step: row.step,
        requestedQuantity: row.quantity,
        requestedUnit: row.unit,
        ingredientId: match.ingredientId ?? "",
        matchMethod: match.method,
        convertedQuantity,
      };
    });
}

// Confirmation is blocked unless the formula has at least one row and every row resolved to a
// real ingredient AND converted to that ingredient's base unit -- an unresolved ingredient and an
// unsupported unit are both treated as "not ready", never guessed past.
export function isBakeFormulaFullyResolved(resolved: ResolvedBakeRow[]): boolean {
  return resolved.length > 0 && resolved.every((row) => Boolean(row.ingredientId) && row.convertedQuantity !== null);
}

export type BakeDeduction = { ingredientId: string; quantity: number };

// Grouping happens strictly after each row has already been converted to its ingredient's base
// unit (never before) -- summing raw, potentially-mismatched-unit quantities would be
// meaningless. The multiplier ("batches made") is applied here, once per row, not as a separate
// pass over the grouped totals.
export function groupDeductionsByIngredient(resolved: ResolvedBakeRow[], multiplier: number): BakeDeduction[] {
  const totals = new Map<string, number>();

  resolved.forEach((row) => {
    if (!row.ingredientId || row.convertedQuantity === null) {
      return;
    }
    const existing = totals.get(row.ingredientId) ?? 0;
    totals.set(row.ingredientId, existing + row.convertedQuantity * multiplier);
  });

  return Array.from(totals.entries()).map(([ingredientId, quantity]) => ({ ingredientId, quantity }));
}

export type InsufficientDeduction = { ingredientId: string; name: string; available: number; needed: number; shortfall: number };

export function getInsufficientDeductions(deductions: BakeDeduction[], ingredients: Ingredient[]): InsufficientDeduction[] {
  return deductions
    .map((deduction) => {
      const ingredient = ingredients.find((item) => item.id === deduction.ingredientId);
      if (!ingredient) {
        return null;
      }
      const shortfall = deduction.quantity - ingredient.currentQuantity;
      if (shortfall <= 0) {
        return null;
      }
      return { ingredientId: deduction.ingredientId, name: ingredient.name, available: ingredient.currentQuantity, needed: deduction.quantity, shortfall };
    })
    .filter((item): item is InsufficientDeduction => item !== null);
}
