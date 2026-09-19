import type { CanonicalUnit, Ingredient } from "./product-lab-types.ts";
import { CANONICAL_UNITS } from "./product-lab-types.ts";
import { normalizeIngredientName } from "./ingredient-normalization.ts";
import { inferCanonicalUnit } from "./unit-conversion.ts";

// Decides what "the ingredient the operator just typed" means for a NEW manual purchase, so the
// operator never has to decide whether a catalog Item exists before recording that they bought
// something. Pure and deterministic: nothing here reads or writes anything, and nothing creates an
// Item -- creation only ever happens when the purchase itself is saved (see saveSupply).
//
// Equality is the app's own normalizeIngredientName (case, punctuation, whitespace, and a trailing
// pack-size fragment like "1kg" are ignored) -- not a second definition. Brand is never part of
// Item identity: "Egg" bought as brand A and as brand B is the same Item.
export type PurchaseItemResolution =
  | { kind: "empty" }
  | { kind: "existing"; ingredient: Ingredient }
  | { kind: "archived"; ingredient: Ingredient }
  | { kind: "ambiguous"; matches: Ingredient[] }
  | { kind: "similar"; candidates: Ingredient[] }
  | { kind: "new"; name: string };

// What qualifies as a "possible match" -- deliberately conservative, explainable, and only ever used
// to ASK the operator, never to choose for them. Both inputs are already normalizeIngredientName
// output, and identical strings are handled as exact matches before this is ever consulted. Any
// ONE of these makes two different names "possibly the same Item":
//   1. Same words in a different order ("sugar brown" / "brown sugar").
//   2. One is the other plus a trailing "s" or "es" ("egg" / "eggs", "tomato" / "tomatoes"),
//      with at least 3 letters in the shorter name.
//   3. A small typo: whole-string edit distance of 1 when the shorter name has at least 5
//      characters, or up to 2 when it has at least 12 ("brown sugr" / "brown sugar").
// Anything else -- including a shared word ("brown sugar" / "brown rice") -- is NOT flagged.
export function arePossibleNameMatch(a: string, b: string): boolean {
  if (a === b || !a || !b) {
    return false;
  }
  if (sortedTokens(a) === sortedTokens(b)) {
    return true;
  }
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  if (shorter.length >= 3 && (longer === `${shorter}s` || longer === `${shorter}es`)) {
    return true;
  }
  const maxDistance = shorter.length >= 12 ? 2 : shorter.length >= 5 ? 1 : 0;
  return maxDistance > 0 && editDistance(a, b, maxDistance) <= maxDistance;
}

function sortedTokens(normalized: string) {
  return normalized.split(" ").sort().join(" ");
}

// Plain Levenshtein distance, bailing out early (returning limit + 1) once every path is already
// over the limit -- names are short, so no library is warranted.
function editDistance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) {
    return limit + 1;
  }
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
      rowMin = Math.min(rowMin, current[j]);
    }
    if (rowMin > limit) {
      return limit + 1;
    }
    previous = current;
  }
  return previous[b.length];
}

// Decision table, in order:
//   nothing typed (after normalization)          -> empty
//   exactly 1 ACTIVE exact match                 -> existing (auto-reuse; archived twins are ignored)
//   2+ ACTIVE exact matches                      -> ambiguous (an integrity problem -- never guessed through)
//   no active exact, exactly 1 ARCHIVED exact    -> archived (never silently restored, never duplicated)
//   no active exact, 2+ ARCHIVED exact           -> ambiguous
//   no exact, 1+ possible matches (any status)   -> similar, unless createAnyway (operator insisted)
//   otherwise                                    -> new
// createAnyway only ever bypasses "similar". It can never bypass an exact or archived match.
export function resolvePurchaseItem(typedName: string, ingredients: Ingredient[], options: { createAnyway?: boolean } = {}): PurchaseItemResolution {
  const normalized = normalizeIngredientName(typedName);
  if (!normalized) {
    return { kind: "empty" };
  }

  const exact = ingredients.filter((ingredient) => normalizeIngredientName(ingredient.name) === normalized);
  const activeExact = exact.filter((ingredient) => ingredient.isActive);
  if (activeExact.length === 1) {
    return { kind: "existing", ingredient: activeExact[0] };
  }
  if (activeExact.length > 1) {
    return { kind: "ambiguous", matches: activeExact };
  }
  const archivedExact = exact.filter((ingredient) => !ingredient.isActive);
  if (archivedExact.length === 1) {
    return { kind: "archived", ingredient: archivedExact[0] };
  }
  if (archivedExact.length > 1) {
    return { kind: "ambiguous", matches: archivedExact };
  }

  const candidates = ingredients
    .filter((ingredient) => arePossibleNameMatch(normalized, normalizeIngredientName(ingredient.name)))
    .sort((a, b) => Number(b.isActive) - Number(a.isActive) || a.name.localeCompare(b.name));
  if (candidates.length > 0 && !options.createAnyway) {
    return { kind: "similar", candidates };
  }
  return { kind: "new", name: typedName.trim() };
}

export type PurchaseItemPlan =
  | { status: "empty" }
  | { status: "use-existing"; ingredient: Ingredient }
  | { status: "create"; name: string; baseUnit: CanonicalUnit; baseUnitSource: "inferred" | "chosen" }
  | { status: "needs-base-unit"; name: string }
  | { status: "needs-choice"; candidates: Ingredient[] }
  | { status: "archived"; ingredient: Ingredient }
  | { status: "ambiguous"; matches: Ingredient[] };

export type PurchaseItemPlanInput = {
  typedName: string;
  ingredients: Ingredient[];
  // The Item the operator explicitly picked ("Use Brown Sugar", or the Item an existing purchase /
  // "log purchase for" draft already belongs to). Wins over typed text.
  selectedIngredientId?: string;
  // normalizeIngredientName(typed text) at the moment the operator chose "Create anyway". Only
  // counts while the typed text still normalizes to the same thing.
  createAnywayFor?: string;
  purchaseUnit: string;
  chosenBaseUnit?: string;
};

export function isCanonicalUnit(value: string): value is CanonicalUnit {
  return (Object.values(CANONICAL_UNITS) as string[]).includes(value);
}

// The single decision the purchase form renders from AND the save path re-checks: what will saving
// this purchase do about the Item. A new Item's base unit comes from the purchase unit only when
// unit-conversion can map it safely (inferCanonicalUnit); otherwise the operator must choose one --
// it is never defaulted.
export function planPurchaseItem(input: PurchaseItemPlanInput): PurchaseItemPlan {
  const selected = input.selectedIngredientId ? input.ingredients.find((ingredient) => ingredient.id === input.selectedIngredientId) : undefined;
  if (selected) {
    return { status: "use-existing", ingredient: selected };
  }

  const normalizedTyped = normalizeIngredientName(input.typedName);
  const resolution = resolvePurchaseItem(input.typedName, input.ingredients, { createAnyway: Boolean(input.createAnywayFor) && input.createAnywayFor === normalizedTyped });
  switch (resolution.kind) {
    case "empty":
      return { status: "empty" };
    case "existing":
      return { status: "use-existing", ingredient: resolution.ingredient };
    case "archived":
      return { status: "archived", ingredient: resolution.ingredient };
    case "ambiguous":
      return { status: "ambiguous", matches: resolution.matches };
    case "similar":
      return { status: "needs-choice", candidates: resolution.candidates };
    case "new": {
      const inferred = inferCanonicalUnit(input.purchaseUnit);
      if (inferred) {
        return { status: "create", name: resolution.name, baseUnit: inferred, baseUnitSource: "inferred" };
      }
      if (input.chosenBaseUnit && isCanonicalUnit(input.chosenBaseUnit)) {
        return { status: "create", name: resolution.name, baseUnit: input.chosenBaseUnit, baseUnitSource: "chosen" };
      }
      return { status: "needs-base-unit", name: resolution.name };
    }
  }
}

// Plans the operator must resolve before Save can do anything sensible -- each one is already
// explained inline next to the Ingredient field. "empty" is deliberately not blocking: saving with
// nothing chosen keeps its existing "Choose an Item" message.
export function isBlockingPurchaseItemPlan(plan: PurchaseItemPlan): boolean {
  return plan.status === "needs-base-unit" || plan.status === "needs-choice" || plan.status === "archived" || plan.status === "ambiguous";
}

// The in-memory shape of an Item created a moment ago by the purchase flow, mirroring exactly what
// saveIngredient writes for a brand-new Item (zero stock, zero cost, active, no thresholds) so the
// purchase that follows can be computed before the reloaded catalog reaches this render.
export function buildNewPurchaseItem(id: string, name: string, baseUnit: CanonicalUnit): Ingredient {
  return {
    id,
    name,
    baseUnit,
    category: "",
    currentQuantity: 0,
    lowStockThreshold: 0,
    targetStockQuantity: 0,
    nearestExpirationDate: "",
    averageUnitCost: 0,
    notes: "",
    isActive: true,
    archivedAt: "",
  };
}
