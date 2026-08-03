import test from "node:test";
import assert from "node:assert/strict";
import { describeIngredientConstraintError, isBaseUnitConstraintError } from "../src/lib/inventory-errors.ts";

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
