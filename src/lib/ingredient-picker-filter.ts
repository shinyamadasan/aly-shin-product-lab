import type { Ingredient, IngredientCategory } from "@/lib/product-lab-types";

// Pure and framework-free (no JSX) so this is unit-testable under this repo's real `node --test`
// runner, which cannot import `.tsx` files at all (Node's built-in TS type-stripping has no JSX
// support -- `ERR_UNKNOWN_FILE_EXTENSION` on `.tsx`, confirmed directly). Living in src/lib/
// mirrors bake-deduction.ts's existing pattern of a component's pure calculation logic extracted
// into its own module.
//
// excludeCategories is a hard exclusion (no escape hatch): recipe/formula contexts (Bake) use it
// so packaging-category items can never be assigned as something a batch's formula consumes.
// scopeToCategory is the softer default (Selling Formats' packaging-line picker): still filters,
// but the component pairs it with a "Use another supply" toggle that clears it, since a hard
// filter here would hide existing packaging-like ingredients that have never had a reason to be
// tagged before now. The two are independent and can combine, though no caller needs both today.
export function getEligibleIngredientsForPicker(
  ingredients: Ingredient[],
  { excludeCategories = [], scopeToCategory }: { excludeCategories?: IngredientCategory[]; scopeToCategory?: IngredientCategory } = {},
): Ingredient[] {
  const afterExclusion =
    excludeCategories.length > 0 ? ingredients.filter((ingredient) => !excludeCategories.some((category) => category === ingredient.category)) : ingredients;
  return scopeToCategory ? afterExclusion.filter((ingredient) => ingredient.category === scopeToCategory) : afterExclusion;
}
