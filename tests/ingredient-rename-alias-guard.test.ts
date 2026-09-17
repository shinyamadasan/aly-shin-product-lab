import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// saveIngredient (src/app/product-lab.tsx) is one giant client component function, not a small
// importable unit -- these tests confirm its rename-related wiring by source inspection, the same
// convention tests/inventory-flagged-ingredient.test.ts already uses for this file.
const productLabSource = readFileSync(new URL("../src/app/product-lab.tsx", import.meta.url), "utf8");

test("isGenuineIngredientRename compares normalized names, not literal ones, and requires an existing Item", () => {
  const helperMatch = productLabSource.match(/function isGenuineIngredientRename\([\s\S]*?\n  \}/);
  assert.ok(helperMatch, "expected an isGenuineIngredientRename helper");
  const helperBody = helperMatch[0];

  assert.match(helperBody, /Boolean\(existingIngredient\)/, "must require an existing Item -- a brand-new Item is never a rename");
  assert.match(
    helperBody,
    /normalizeIngredientName\(existingIngredient!?\.name\) !== normalizeIngredientName\(nextIngredient\.name\)/,
    "must compare normalized names so a pure case/whitespace/punctuation edit is not treated as a rename",
  );
});

// Rename-history preservation lives in a database trigger (ingredients_preserve_rename_history,
// see supabase/migrations/20260917175805_ingredient_rename_history.sql) that fires for every
// writer to ingredients.name, not only this call site. saveIngredient's Supabase branch is a
// single plain update with no rename-specific branching, no separate RPC call, and no separate
// error path for a failed rename (a failed rename now just fails the one update, surfacing through
// the existing "Ingredient save failed" message like any other constraint violation).
test("saveIngredient's Supabase branch issues one plain update with no rename-specific branching -- the database trigger is what protects it now", () => {
  const saveIngredientStart = productLabSource.indexOf("async function saveIngredient");
  const supabaseBranchStart = productLabSource.indexOf("if (supabase && session) {", saveIngredientStart);
  const localBranchStart = productLabSource.indexOf("setLabState((current) => ({", saveIngredientStart);
  assert.ok(supabaseBranchStart !== -1 && localBranchStart !== -1, "expected saveIngredient's Supabase and local-state branches");
  const supabaseBranchText = productLabSource.slice(supabaseBranchStart, localBranchStart);

  // No rename-specific code at all in this branch anymore.
  assert.doesNotMatch(supabaseBranchText, /isGenuineIngredientRename/);
  assert.doesNotMatch(supabaseBranchText, /saveIngredientAlias/);
  assert.doesNotMatch(supabaseBranchText, /rename_ingredient_with_history/);
  assert.doesNotMatch(supabaseBranchText, /Ingredient rename failed/);

  // Exactly one write to the ingredients table in this branch: one ternary line choosing between
  // update (existing Item) and insert (new Item), not two separate write call sites.
  const queryAssignments = [...supabaseBranchText.matchAll(/const query = ingredientId \? supabase\.from\("ingredients"\)\.update\([\s\S]*?: supabase\.from\("ingredients"\)\.insert\([\s\S]*?;/g)];
  assert.equal(queryAssignments.length, 1, "expected exactly one query-building line (update-or-insert ternary) writing to ingredients in the Supabase branch");
});

test("a genuine rename in the local/offline fallback branch still preserves the old name -- no database trigger exists in that mode", () => {
  const saveIngredientStart = productLabSource.indexOf("async function saveIngredient");
  const localBranchStart = productLabSource.indexOf("setLabState((current) => ({", saveIngredientStart);
  assert.ok(localBranchStart !== -1, "expected saveIngredient's local-state fallback branch");
  const branchText = productLabSource.slice(localBranchStart, localBranchStart + 600);

  assert.match(branchText, /if \(isGenuineIngredientRename\(existingIngredient, ingredient\)\) \{/);
  assert.match(branchText, /await saveIngredientAlias\(existingIngredient!?\.name, savedId, "rename"\);/);
});

test("exactly one remaining saveIngredientAlias call site outside its own definition -- the local/offline fallback", () => {
  const aliasFunctionMatches = [...productLabSource.matchAll(/async function saveIngredientAlias\(/g)];
  assert.equal(aliasFunctionMatches.length, 1, "expected exactly one saveIngredientAlias definition");

  const renameCallSites = [...productLabSource.matchAll(/saveIngredientAlias\([^,]+,\s*savedId,\s*"rename"\)/g)];
  assert.equal(renameCallSites.length, 1, "expected exactly one rename call site (the local/offline fallback) -- the Supabase branch relies entirely on the database trigger");
});

test("rename_ingredient_with_history is not called anywhere in the app -- it was removed as redundant, not left as dead code", () => {
  assert.doesNotMatch(productLabSource, /rename_ingredient_with_history/);
});
