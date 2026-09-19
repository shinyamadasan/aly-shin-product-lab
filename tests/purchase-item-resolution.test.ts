import test from "node:test";
import assert from "node:assert/strict";
import { arePossibleNameMatch, buildNewPurchaseItem, isBlockingPurchaseItemPlan, planPurchaseItem, resolvePurchaseItem } from "../src/lib/purchase-item-resolution.ts";
import { inferCanonicalUnit } from "../src/lib/unit-conversion.ts";
import type { Ingredient } from "../src/lib/product-lab-types.ts";

function item(overrides: Partial<Ingredient> = {}): Ingredient {
  return {
    id: crypto.randomUUID(),
    name: "All Purpose Flour",
    baseUnit: "g",
    category: "ingredient",
    currentQuantity: 0,
    lowStockThreshold: 0,
    targetStockQuantity: 0,
    nearestExpirationDate: "",
    averageUnitCost: 0,
    notes: "",
    isActive: true,
    ...overrides,
  };
}

// --- exact matches (scenario A, C) ---------------------------------------------------------------

test("an exact normalized match reuses the existing Item, ignoring case", () => {
  const flour = item({ id: "flour", name: "All Purpose Flour" });
  for (const typed of ["all purpose flour", "ALL PURPOSE FLOUR", "  All   Purpose  Flour "]) {
    const result = resolvePurchaseItem(typed, [flour]);
    assert.equal(result.kind, "existing", typed);
    assert.equal(result.kind === "existing" && result.ingredient.id, "flour");
  }
});

test("punctuation and a trailing pack size are ignored by the app's own normalization", () => {
  const flour = item({ id: "flour", name: "All-Purpose Flour" });
  assert.equal(resolvePurchaseItem("all purpose flour 1kg", [flour]).kind, "existing");
});

test("brand is never part of Item identity: the same Item resolves whatever brand the purchase carries", () => {
  const egg = item({ id: "egg", name: "Egg", baseUnit: "pcs" });
  // The resolver takes no brand at all -- two purchases of Egg (brand A, brand B) both resolve here.
  assert.equal(resolvePurchaseItem("Egg", [egg]).kind, "existing");
  assert.equal(planPurchaseItem({ typedName: "Egg", ingredients: [egg], purchaseUnit: "pcs" }).status, "use-existing");
});

test("exactly one active exact match is reused, even when unrelated archived Items exist", () => {
  const active = item({ id: "active", name: "Cake Flour" });
  const unrelatedArchived = item({ id: "old", name: "Rye Flour", isActive: false });
  const result = resolvePurchaseItem("Cake Flour", [unrelatedArchived, active]);
  assert.equal(result.kind, "existing");
  assert.equal(result.kind === "existing" && result.ingredient.id, "active");
});

// --- archived (scenario D) -----------------------------------------------------------------------

test("an exact match against only an archived Item never creates a duplicate and never restores silently", () => {
  const archived = item({ id: "archived", name: "Cake Flour", isActive: false });
  const result = resolvePurchaseItem("Cake Flour", [archived]);
  assert.equal(result.kind, "archived");
  assert.equal(planPurchaseItem({ typedName: "Cake Flour", ingredients: [archived], purchaseUnit: "kg" }).status, "archived");
  // create-anyway must not be able to bypass an exact archived match.
  assert.equal(resolvePurchaseItem("Cake Flour", [archived], { createAnyway: true }).kind, "archived");
});

// --- ambiguity (scenario I) ----------------------------------------------------------------------

test("two active Items with the same normalized name are ambiguous -- never arbitrarily chosen", () => {
  const a = item({ id: "a", name: "Brown Sugar" });
  const b = item({ id: "b", name: "brown sugar" });
  const result = resolvePurchaseItem("Brown Sugar", [a, b]);
  assert.equal(result.kind, "ambiguous");
  assert.equal(result.kind === "ambiguous" && result.matches.length, 2);
  assert.equal(planPurchaseItem({ typedName: "Brown Sugar", ingredients: [a, b], purchaseUnit: "g" }).status, "ambiguous");
  assert.equal(resolvePurchaseItem("Brown Sugar", [a, b], { createAnyway: true }).kind, "ambiguous");
});

test("two archived Items with the same normalized name (and no active one) are also ambiguous", () => {
  const a = item({ id: "a", name: "Brown Sugar", isActive: false });
  const b = item({ id: "b", name: "Brown Sugar", isActive: false });
  assert.equal(resolvePurchaseItem("Brown Sugar", [a, b]).kind, "ambiguous");
});

// Archived Items still own purchase/stock/formula/import/costing history, so an active + archived
// pair with the same normalized name is an identity conflict -- the active one is NOT preferred.
test("one active and one archived Item with the same normalized name are ambiguous -- the active Item does not win", () => {
  const active = item({ id: "active", name: "Brown Sugar" });
  const archived = item({ id: "archived", name: "brown sugar", isActive: false });
  for (const catalog of [[active, archived], [archived, active]]) {
    const result = resolvePurchaseItem("Brown Sugar", catalog);
    assert.equal(result.kind, "ambiguous");
    assert.deepEqual(result.kind === "ambiguous" && result.matches.map((entry) => entry.id).sort(), ["active", "archived"]);
  }
});

test("planPurchaseItem also returns ambiguous for every 2+ exact-match combination, including active + archived", () => {
  const combos: Array<[string, Ingredient[]]> = [
    ["two active", [item({ id: "a", name: "Brown Sugar" }), item({ id: "b", name: "brown sugar" })]],
    ["two archived", [item({ id: "a", name: "Brown Sugar", isActive: false }), item({ id: "b", name: "brown sugar", isActive: false })]],
    ["active + archived", [item({ id: "a", name: "Brown Sugar" }), item({ id: "b", name: "brown sugar", isActive: false })]],
  ];
  for (const [label, catalog] of combos) {
    const plan = planPurchaseItem({ typedName: "Brown Sugar", ingredients: catalog, purchaseUnit: "g" });
    assert.equal(plan.status, "ambiguous", label);
    assert.equal(isBlockingPurchaseItemPlan(plan), true, label);
    assert.equal(plan.status === "ambiguous" && plan.matches.length, 2, label);
  }
});

test("createAnyway can never bypass a 2+ exact-match ambiguity, whatever the active/archived mix", () => {
  const combos: Ingredient[][] = [
    [item({ id: "a", name: "Brown Sugar" }), item({ id: "b", name: "brown sugar" })],
    [item({ id: "a", name: "Brown Sugar", isActive: false }), item({ id: "b", name: "brown sugar", isActive: false })],
    [item({ id: "a", name: "Brown Sugar" }), item({ id: "b", name: "brown sugar", isActive: false })],
  ];
  for (const catalog of combos) {
    assert.equal(resolvePurchaseItem("Brown Sugar", catalog, { createAnyway: true }).kind, "ambiguous");
    const plan = planPurchaseItem({ typedName: "Brown Sugar", ingredients: catalog, purchaseUnit: "g", createAnywayFor: "brown sugar" });
    assert.equal(plan.status, "ambiguous");
  }
});

// --- near matches (scenario B) -------------------------------------------------------------------

test("a small typo surfaces the existing Item instead of creating or merging", () => {
  const sugar = item({ id: "sugar", name: "Brown Sugar" });
  const result = resolvePurchaseItem("Brown Sugr", [sugar]);
  assert.equal(result.kind, "similar");
  assert.deepEqual(result.kind === "similar" && result.candidates.map((entry) => entry.id), ["sugar"]);
  assert.equal(planPurchaseItem({ typedName: "Brown Sugr", ingredients: [sugar], purchaseUnit: "g" }).status, "needs-choice");

  const compound = item({ id: "compound", name: "Dark Chocolate Compound" });
  assert.equal(resolvePurchaseItem("Dark Chocolate Compund", [compound]).kind, "similar");
});

test("the near-match rule: word order, trailing s/es, and small typos qualify; a shared word or short names do not", () => {
  // 1. same words, different order
  assert.equal(arePossibleNameMatch("sugar brown", "brown sugar"), true);
  // 2. trailing s / es
  assert.equal(arePossibleNameMatch("egg", "eggs"), true);
  assert.equal(arePossibleNameMatch("tomato", "tomatoes"), true);
  assert.equal(arePossibleNameMatch("oa", "oas"), false, "shorter than 3 letters is never a plural match");
  // 3. edit distance 1 needs a shorter name of at least 5 characters
  assert.equal(arePossibleNameMatch("brown sugr", "brown sugar"), true);
  assert.equal(arePossibleNameMatch("milk", "silk"), false, "4-letter names are too short for a typo rule");
  assert.equal(arePossibleNameMatch("oat milk", "oak milk"), true);
  // edit distance 2 needs a shorter name of at least 12 characters
  assert.equal(arePossibleNameMatch("dark chocolate compound", "dark chocolate compnd"), true);
  assert.equal(arePossibleNameMatch("brown sugar", "brown sugxx"), false, "11 characters allows distance 1 only");
  // not flagged
  assert.equal(arePossibleNameMatch("brown sugar", "brown rice"), false, "a shared word alone is not a match");
  assert.equal(arePossibleNameMatch("cocoa powder", "baking powder"), false);
  assert.equal(arePossibleNameMatch("flour", "flour"), false, "identical names are exact matches, handled before this rule");
});

test("near matches include archived Items, listed after active ones", () => {
  const archived = item({ id: "arch", name: "Brown Sugar", isActive: false });
  const active = item({ id: "act", name: "Brown Sugor" });
  const result = resolvePurchaseItem("Brown Sugr", [archived, active]);
  assert.equal(result.kind, "similar");
  assert.deepEqual(result.kind === "similar" && result.candidates.map((entry) => entry.id), ["act", "arch"]);
});

test("'Create anyway' bypasses only a near-match warning, and only for the same typed text", () => {
  const sugar = item({ id: "sugar", name: "Brown Sugar" });
  const forced = resolvePurchaseItem("Brown Sugr", [sugar], { createAnyway: true });
  assert.deepEqual(forced, { kind: "new", name: "Brown Sugr" });

  const base = { ingredients: [sugar], purchaseUnit: "g" };
  const withChoice = planPurchaseItem({ ...base, typedName: "Brown Sugr", createAnywayFor: "brown sugr" });
  assert.equal(withChoice.status, "create");
  // Editing the text afterwards invalidates the earlier choice.
  const edited = planPurchaseItem({ ...base, typedName: "Brown Sugrr", createAnywayFor: "brown sugr" });
  assert.equal(edited.status, "needs-choice");
});

// --- genuinely new (scenario E, F, G) ------------------------------------------------------------

test("a genuinely new name resolves to new with the trimmed typed text", () => {
  const flour = item({ name: "All Purpose Flour" });
  assert.deepEqual(resolvePurchaseItem("  Rice Flour ", [flour]), { kind: "new", name: "Rice Flour" });
  assert.deepEqual(resolvePurchaseItem("Rice Flour", []), { kind: "new", name: "Rice Flour" });
});

test("blank or symbol-only text is empty, never a new Item", () => {
  assert.deepEqual(resolvePurchaseItem("", []), { kind: "empty" });
  assert.deepEqual(resolvePurchaseItem("   ", []), { kind: "empty" });
  assert.deepEqual(resolvePurchaseItem("--", []), { kind: "empty" });
  assert.equal(planPurchaseItem({ typedName: "", ingredients: [], purchaseUnit: "g" }).status, "empty");
});

test("a new Item's base unit is inferred from g / kg / ml / L / pcs purchase units", () => {
  const cases: Array<[string, string]> = [["g", "g"], ["kg", "g"], ["ml", "ml"], ["L", "ml"], ["l", "ml"], ["pcs", "pcs"], ["piece", "pcs"], ["cup", "ml"]];
  for (const [unit, expected] of cases) {
    const plan = planPurchaseItem({ typedName: "Rice Flour", ingredients: [], purchaseUnit: unit });
    assert.equal(plan.status, "create", unit);
    assert.equal(plan.status === "create" && plan.baseUnit, expected, unit);
    assert.equal(plan.status === "create" && plan.baseUnitSource, "inferred", unit);
  }
});

test("2 kg of a new Rice Flour infers grams and needs no extra question", () => {
  const plan = planPurchaseItem({ typedName: "Rice Flour", ingredients: [], purchaseUnit: "kg" });
  assert.deepEqual(plan, { status: "create", name: "Rice Flour", baseUnit: "g", baseUnitSource: "inferred" });
  assert.equal(isBlockingPurchaseItemPlan(plan), false);
});

test("an unknown purchase unit is never guessed: the operator must choose the base unit", () => {
  for (const unit of ["box", "pack", "sack", ""]) {
    const plan = planPurchaseItem({ typedName: "Rice Flour", ingredients: [], purchaseUnit: unit });
    assert.deepEqual(plan, { status: "needs-base-unit", name: "Rice Flour" }, unit || "(blank)");
    assert.equal(isBlockingPurchaseItemPlan(plan), true);
  }
  const chosen = planPurchaseItem({ typedName: "Rice Flour", ingredients: [], purchaseUnit: "sack", chosenBaseUnit: "g" });
  assert.deepEqual(chosen, { status: "create", name: "Rice Flour", baseUnit: "g", baseUnitSource: "chosen" });
  // A value outside the canonical set is ignored rather than trusted.
  assert.equal(planPurchaseItem({ typedName: "Rice Flour", ingredients: [], purchaseUnit: "sack", chosenBaseUnit: "oz" }).status, "needs-base-unit");
});

test("inferCanonicalUnit is strict (null for the unrecognized) while guessCanonicalUnit stays the lenient prefill", () => {
  assert.equal(inferCanonicalUnit("box"), null);
  assert.equal(inferCanonicalUnit("kg"), "g");
});

// --- explicit selection, blocking, no writes ------------------------------------------------------

test("an explicitly selected Item wins over the typed text", () => {
  const sugar = item({ id: "sugar", name: "Brown Sugar" });
  const plan = planPurchaseItem({ typedName: "Brown Sugr", ingredients: [sugar], selectedIngredientId: "sugar", purchaseUnit: "g" });
  assert.equal(plan.status === "use-existing" && plan.ingredient.id, "sugar");
});

test("only plans that need the operator's attention block Save", () => {
  const sugar = item({ id: "sugar", name: "Brown Sugar" });
  assert.equal(isBlockingPurchaseItemPlan(planPurchaseItem({ typedName: "Brown Sugr", ingredients: [sugar], purchaseUnit: "g" })), true);
  assert.equal(isBlockingPurchaseItemPlan(planPurchaseItem({ typedName: "Brown Sugar", ingredients: [sugar], purchaseUnit: "g" })), false);
  assert.equal(isBlockingPurchaseItemPlan(planPurchaseItem({ typedName: "Rice Flour", ingredients: [sugar], purchaseUnit: "kg" })), false);
  assert.equal(isBlockingPurchaseItemPlan(planPurchaseItem({ typedName: "", ingredients: [sugar], purchaseUnit: "g" })), false);
});

test("planning and resolving are pure: the catalog passed in is never mutated", () => {
  const catalog = [item({ id: "sugar", name: "Brown Sugar" })];
  const snapshot = JSON.stringify(catalog);
  planPurchaseItem({ typedName: "Rice Flour", ingredients: catalog, purchaseUnit: "kg" });
  resolvePurchaseItem("Brown Sugr", catalog);
  assert.equal(JSON.stringify(catalog), snapshot);
  assert.equal(catalog.length, 1, "typing a new name creates no catalog row");
});

test("buildNewPurchaseItem mirrors a brand-new Item: zero stock, zero cost, active", () => {
  const created = buildNewPurchaseItem("id-1", "Rice Flour", "g");
  assert.equal(created.currentQuantity, 0);
  assert.equal(created.averageUnitCost, 0);
  assert.equal(created.isActive, true);
  assert.equal(created.baseUnit, "g");
  assert.equal(created.name, "Rice Flour");
});
