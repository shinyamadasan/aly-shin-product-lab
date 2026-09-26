// Dashboard V1: which ingredients a CURRENT production recipe actually uses.
//
// "Current" is not a new concept -- it reuses Bake's own definition (buildBakeBatchChoices) rather
// than inventing a second one, and never hardcodes a version string. That definition is: the
// newest non-voided batch per product (buildBakeBatchChoices.current); a product whose every batch
// is voided contributes no ingredients at all (its `noCurrent` case).
//
// An ingredient counts as "used" only if a formula row resolves to a real ingredient AND that
// row's unit converts to the ingredient's base unit -- the exact bar groupDeductionsByIngredient
// already applies before Bake would deduct anything. A row Bake itself could not act on does not
// count as "using" the ingredient here either.

import { buildBakeBatchChoices } from "../bake-batch-option.ts";
import { groupDeductionsByIngredient, resolveBakeFormula } from "../bake-deduction.ts";
import { parseBatchIngredients } from "../batches.ts";
import type { Ingredient, IngredientAlias, Product, ProductBatch } from "../product-lab-types.ts";

export function getCurrentRecipeIngredientIds(products: Product[], batches: ProductBatch[], ingredients: Ingredient[], aliases: IngredientAlias[]): Set<string> {
  const { current } = buildBakeBatchChoices(products, batches);
  const ingredientIds = new Set<string>();

  for (const { batch } of current) {
    const formula = parseBatchIngredients(batch.ingredientsNotes);
    const resolved = resolveBakeFormula(formula, ingredients, aliases);
    for (const deduction of groupDeductionsByIngredient(resolved, 1)) {
      ingredientIds.add(deduction.ingredientId);
    }
  }

  return ingredientIds;
}
