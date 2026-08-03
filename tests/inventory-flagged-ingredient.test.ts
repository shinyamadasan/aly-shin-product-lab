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
  assert.match(inventoryPageSource, /ingredient\?\.baseUnitMigrationFlaggedReason[\s\S]{0,1000}type="hidden"\s+value=\{ingredient\.baseUnit\}/);
});

// Every RPC/query call site that updates the ingredients table routes its error through
// describeIngredientConstraintError, so a flagged-row failure surfaces the actionable message
// (point 5) instead of raw Postgres text, everywhere this could occur -- not just the two new
// stock-adjustment call sites.
test("every ingredients-table mutation's error message is translated via describeIngredientConstraintError", () => {
  const expectedCallSites = [
    "save_supply_with_inventory_effect",
    "delete_supply_with_inventory_effect",
    "repair_supply_inventory_effects",
    "apply_inventory_adjustment",
  ];
  for (const rpcName of expectedCallSites) {
    const rpcCallIndex = productLabSource.indexOf(`"${rpcName}"`);
    assert.ok(rpcCallIndex !== -1, `expected an rpc call to ${rpcName}`);
    const nearbyText = productLabSource.slice(rpcCallIndex, rpcCallIndex + 1500);
    assert.match(nearbyText, /describeIngredientConstraintError/, `${rpcName}'s error handling should use describeIngredientConstraintError`);
  }

  // apply_inventory_adjustment is called from both adjustStock and reverseInventoryAdjustment --
  // confirm both call sites (not just the first occurrence) are wrapped.
  const adjustmentCallSites = [...productLabSource.matchAll(/"apply_inventory_adjustment"/g)];
  assert.equal(adjustmentCallSites.length, 2, "expected exactly two apply_inventory_adjustment call sites (adjust + reverse)");
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
