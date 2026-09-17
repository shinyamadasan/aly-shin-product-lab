import test from "node:test";
import assert from "node:assert/strict";
import { describeHardDeleteError, describeIngredientConstraintError, isBaseUnitConstraintError, isHardDeleteBlockedError, isLegacyIngredientBlockedError } from "../src/lib/inventory-errors.ts";

test("recognizes the base_unit CHECK-constraint violation by code and constraint name", () => {
  const error = { code: "23514", message: 'new row for relation "ingredients" violates check constraint "ingredients_base_unit_check"' };

  assert.equal(isBaseUnitConstraintError(error), true);
});

test("does not recognize a different check_violation as the base_unit constraint", () => {
  const error = { code: "23514", message: 'new row for relation "ingredients" violates check constraint "some_other_check"' };

  assert.equal(isBaseUnitConstraintError(error), false);
});

test("does not recognize a same-text-but-different-code error", () => {
  const error = { code: "23505", message: 'duplicate key value violates unique constraint "ingredients_base_unit_check"' };

  assert.equal(isBaseUnitConstraintError(error), false);
});

test("5. describeIngredientConstraintError rewrites the base_unit constraint violation into an actionable message", () => {
  const error = { code: "23514", message: 'new row for relation "ingredients" violates check constraint "ingredients_base_unit_check"' };

  const message = describeIngredientConstraintError(error);

  assert.match(message, /flagged during the unit-normalization migration/);
  assert.match(message, /Needs manual reconciliation/);
});

test("5. describeIngredientConstraintError passes any unrelated error through unchanged, never masking it", () => {
  const error = { code: "23505", message: "duplicate key value violates unique constraint \"ingredients_name_unique_idx\"" };

  assert.equal(describeIngredientConstraintError(error), error.message);
});

test("5. describeIngredientConstraintError passes a network/RPC-not-found error through unchanged", () => {
  const error = { code: "PGRST202", message: "Could not find the function apply_inventory_adjustment" };

  assert.equal(describeIngredientConstraintError(error), error.message);
});

test("isHardDeleteBlockedError recognizes hard_delete_ingredient_if_unreferenced's own blocking exception", () => {
  const error = { code: "P0001", message: "Ingredient All Purpose Flour cannot be permanently deleted: 2 existing reference(s) found" };

  assert.equal(isHardDeleteBlockedError(error), true);
});

test("isHardDeleteBlockedError does not recognize an unrelated error", () => {
  const error = { code: "23514", message: 'new row for relation "ingredients" violates check constraint "ingredients_base_unit_check"' };

  assert.equal(isHardDeleteBlockedError(error), false);
});

test("describeHardDeleteError explains a server-side-caught race without exposing the raw exception text", () => {
  const error = { code: "P0001", message: "Ingredient All Purpose Flour cannot be permanently deleted: 1 existing reference(s) found" };

  const message = describeHardDeleteError("All Purpose Flour", error);

  assert.match(message, /became referenced before the delete completed/);
  assert.match(message, /Archive it instead/);
});

test("describeHardDeleteError falls back to describeIngredientConstraintError for any other error", () => {
  const error = { code: "23514", message: 'new row for relation "ingredients" violates check constraint "ingredients_base_unit_check"' };

  const message = describeHardDeleteError("All Purpose Flour", error);

  assert.match(message, /flagged during the unit-normalization migration/);
});

test("isLegacyIngredientBlockedError recognizes the legacy-cutoff exception from hard_delete_ingredient_if_unreferenced", () => {
  const error = {
    code: "P0001",
    message: "Ingredient All Purpose Flour was created before rename-history protection was active and cannot be permanently deleted: its usage under any earlier name cannot be verified. Archive it instead",
  };

  assert.equal(isLegacyIngredientBlockedError(error), true);
});

test("isLegacyIngredientBlockedError does not recognize the ordinary reference-count-blocked exception", () => {
  const error = { code: "P0001", message: "Ingredient All Purpose Flour cannot be permanently deleted: 2 existing reference(s) found" };

  assert.equal(isLegacyIngredientBlockedError(error), false);
});

// The legacy-cutoff exception ALSO contains "cannot be permanently deleted" (the same phrase
// isHardDeleteBlockedError matches on), so describeHardDeleteError must check the more specific
// legacy phrase first -- otherwise a legacy-blocked Item would get the misleading "became
// referenced" race-condition message instead of the real, actionable reason.
test("describeHardDeleteError distinguishes the legacy-cutoff block from the ordinary reference-blocked message, despite both containing the same generic phrase", () => {
  const legacyError = {
    code: "P0001",
    message: "Ingredient All Purpose Flour was created before rename-history protection was active and cannot be permanently deleted: its usage under any earlier name cannot be verified. Archive it instead",
  };

  const message = describeHardDeleteError("All Purpose Flour", legacyError);

  assert.match(message, /created before rename-history protection existed/);
  assert.match(message, /can only be archived, not permanently deleted/);
  assert.doesNotMatch(message, /became referenced before the delete completed/);
});
