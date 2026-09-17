import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const productLabSource = readFileSync(new URL("../src/app/product-lab.tsx", import.meta.url), "utf8");
const inventoryPageSource = readFileSync(new URL("../src/components/inventory-page.tsx", import.meta.url), "utf8");

test("B.4. saveIngredient never writes base_unit_migration_flagged_reason -- the app only reads the flag, never clears or reinterprets it", () => {
  assert.doesNotMatch(productLabSource, /base_unit_migration_flagged_reason\s*[:=]/);
});

test("B.1/B.4. the Inventory page reads the flag read-only via getFlaggedIngredients, and never assigns to it", () => {
  assert.match(inventoryPageSource, /getFlaggedIngredients/);
  assert.doesNotMatch(inventoryPageSource, /baseUnitMigrationFlaggedReason\s*=[^=]/);
});

test("a flagged ingredient's baseUnit is preserved via a hidden input, never resubmitted through the canonical-only <select>", () => {
  assert.match(inventoryPageSource, /ingredient\.baseUnitMigrationFlaggedReason[\s\S]{0,1800}type="hidden"\s+value=\{ingredient\.baseUnit\}/);
});

test("Wave 0A retires client calls to legacy balance writers", () => {
  for (const rpcName of [
    "save_supply_with_inventory_effect",
    "delete_supply_with_inventory_effect",
    "repair_supply_inventory_effects",
    "apply_inventory_adjustment",
    "confirm_bake",
    "confirm_purchase_import",
  ]) {
    assert.ok(!productLabSource.includes(`supabase.rpc("${rpcName}"`), `retired RPC ${rpcName} must not be called`);
  }
});

test("supported adjustment, reversal, and count errors remain actionable", () => {
  const adjustmentCallSites = [...productLabSource.matchAll(/"apply_raw_inventory_adjustment"/g)];
  assert.equal(adjustmentCallSites.length, 3);
  for (const match of adjustmentCallSites) {
    const nearbyText = productLabSource.slice(match.index ?? 0, (match.index ?? 0) + 800);
    assert.match(nearbyText, /describeIngredientConstraintError/);
  }
});

test("saveIngredient, deleteIngredient (archive), and restoreIngredient all translate ingredients-table update errors", () => {
  for (const label of ["Ingredient save failed", "Ingredient archive failed", "Ingredient restore failed"]) {
    const labelIndex = productLabSource.indexOf(label);
    assert.ok(labelIndex !== -1, `expected a message starting with "${label}"`);
    const nearbyText = productLabSource.slice(labelIndex, labelIndex + 500);
    assert.match(nearbyText, /describeIngredientConstraintError/, `${label} should route through describeIngredientConstraintError`);
  }
});

// hardDeleteIngredient's Supabase call site used to be a hard-coded "Permanent inventory deletion
// is disabled" stub (see the ingredient-permanent-delete fix). It now calls the server-side
// reference guard (hard_delete_ingredient_if_unreferenced, SECURITY DEFINER, owner-checked) and
// routes the result through describeHardDeleteError, which itself falls back to
// describeIngredientConstraintError for anything that isn't the guard's own blocking exception.
test("hardDeleteIngredient calls hard_delete_ingredient_if_unreferenced and routes its error through describeHardDeleteError, not the old disabled stub", () => {
  assert.doesNotMatch(productLabSource, /Permanent inventory deletion is disabled/);

  const rpcCallIndex = productLabSource.indexOf('"hard_delete_ingredient_if_unreferenced"');
  assert.ok(rpcCallIndex !== -1, "expected an rpc call to hard_delete_ingredient_if_unreferenced");

  const labelIndex = productLabSource.indexOf("Permanent delete failed");
  assert.ok(labelIndex !== -1, 'expected a message starting with "Permanent delete failed"');
  const nearbyText = productLabSource.slice(labelIndex, labelIndex + 500);
  assert.match(nearbyText, /describeHardDeleteError/, "Permanent delete failed should route through describeHardDeleteError");
});

// Rename-history preservation lives entirely in the ingredients_preserve_rename_history database
// trigger for the Supabase path -- saveIngredient's Supabase branch needs no rename-specific code
// at all, only its local/offline fallback (which has no database trigger behind it) does.
test("saveIngredient's Supabase branch has no rename-specific code -- the database trigger protects it; only the local/offline fallback calls saveIngredientAlias", () => {
  const saveIngredientStart = productLabSource.indexOf("async function saveIngredient");
  const supabaseBranchStart = productLabSource.indexOf("if (supabase && session) {", saveIngredientStart);
  const localBranchStart = productLabSource.indexOf("setLabState((current) => ({", saveIngredientStart);
  assert.ok(supabaseBranchStart !== -1 && localBranchStart !== -1 && supabaseBranchStart < localBranchStart);
  const supabaseBranchText = productLabSource.slice(supabaseBranchStart, localBranchStart);
  assert.doesNotMatch(supabaseBranchText, /isGenuineIngredientRename|saveIngredientAlias/);

  const localBranchText = productLabSource.slice(localBranchStart, localBranchStart + 600);
  assert.match(localBranchText, /if \(isGenuineIngredientRename\(existingIngredient, ingredient\)\) \{/);
  assert.match(localBranchText, /await saveIngredientAlias\(existingIngredient!?\.name, savedId, "rename"\);/);
});
