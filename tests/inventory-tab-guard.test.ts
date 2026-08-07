import test from "node:test";
import assert from "node:assert/strict";
import { resolveTabChange } from "../src/lib/inventory-tab-guard.ts";

const INGREDIENT_MESSAGE = "You have unsaved changes in this ingredient. Leaving now will discard them. Continue?";
const SUPPLY_MESSAGE = "You have unsaved changes in this purchase. Leaving now will discard them. Continue?";

test("clicking the already-active tab never prompts and never proceeds", () => {
  let confirmCalls = 0;
  const decision = resolveTabChange("ingredients", "ingredients", { isDirty: true, message: INGREDIENT_MESSAGE }, () => {
    confirmCalls += 1;
    return true;
  });
  assert.equal(confirmCalls, 0);
  assert.deepEqual(decision, { proceed: false, shouldClearDirty: false });
});

test("switching away from a tab with no protected editor proceeds without prompting or clearing anything", () => {
  let confirmCalls = 0;
  const decision = resolveTabChange("stock", "history", null, () => {
    confirmCalls += 1;
    return true;
  });
  assert.equal(confirmCalls, 0);
  assert.deepEqual(decision, { proceed: true, shouldClearDirty: false });
});

test("clean tab switches do not alter ownership -- a clean editor's own tab proceeds without prompting or clearing", () => {
  let confirmCalls = 0;
  const decision = resolveTabChange("ingredients", "stock", { isDirty: false, message: INGREDIENT_MESSAGE }, () => {
    confirmCalls += 1;
    return true;
  });
  assert.equal(confirmCalls, 0);
  assert.deepEqual(decision, { proceed: true, shouldClearDirty: false });
});

// The core stale-owner regression: leaving a dirty Ingredient tab, once confirmed, must proceed
// AND signal that the Ingredient dirty owner should be cleared -- since no replacement Ingredient
// editor will ever mount again to report isDirty=false on its own.
test("dirty Ingredient tab, confirmed leave -- proceeds and clears the Ingredient dirty owner", () => {
  let confirmedMessage: string | null = null;
  const decision = resolveTabChange("ingredients", "stock", { isDirty: true, message: INGREDIENT_MESSAGE }, (message) => {
    confirmedMessage = message;
    return true;
  });
  assert.equal(confirmedMessage, INGREDIENT_MESSAGE);
  assert.deepEqual(decision, { proceed: true, shouldClearDirty: true });
});

test("cancelling the tab switch leaves the original owner intact -- does not proceed and does not clear", () => {
  const decision = resolveTabChange("ingredients", "stock", { isDirty: true, message: INGREDIENT_MESSAGE }, () => false);
  assert.deepEqual(decision, { proceed: false, shouldClearDirty: false });
});

// Supply uses the identical corrected behavior -- same function, same shape, just a different tab
// value and message, proving the fix isn't Ingredient-specific.
test("dirty Supply (purchases) tab, confirmed leave -- proceeds and clears the Supply dirty owner", () => {
  let confirmedMessage: string | null = null;
  const decision = resolveTabChange("purchases", "ingredients", { isDirty: true, message: SUPPLY_MESSAGE }, (message) => {
    confirmedMessage = message;
    return true;
  });
  assert.equal(confirmedMessage, SUPPLY_MESSAGE);
  assert.deepEqual(decision, { proceed: true, shouldClearDirty: true });
});

test("cancelling a dirty Supply tab switch leaves the Supply owner intact", () => {
  const decision = resolveTabChange("purchases", "history", { isDirty: true, message: SUPPLY_MESSAGE }, () => false);
  assert.deepEqual(decision, { proceed: false, shouldClearDirty: false });
});

// Proves the same pure function serves the inner "manual" | "csv" sub-tab switch (PurchaseLogPage
// vs PurchaseImportWizard) without any Inventory-tab-specific assumptions baked in.
test("generic over a different tab value set (manual/csv sub-tabs)", () => {
  const decision = resolveTabChange<"manual" | "csv">("manual", "csv", { isDirty: true, message: SUPPLY_MESSAGE }, () => true);
  assert.deepEqual(decision, { proceed: true, shouldClearDirty: true });
});
