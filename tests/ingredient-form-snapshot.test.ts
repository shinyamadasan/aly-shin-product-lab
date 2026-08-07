import test from "node:test";
import assert from "node:assert/strict";
import { areIngredientFormSnapshotsEqual, buildIngredientFormSnapshot, isIngredientFormDirty } from "../src/lib/ingredient-form-snapshot.ts";

// Mirrors a real InventoryPage submission (src/components/inventory-page.tsx) -- every field name
// here matches that form's `name=` attributes exactly.
function ingredientFormData(
  overrides: Partial<{
    id: string;
    name: string;
    baseUnit: string;
    category: string;
    currentQuantity: string;
    lowStockThreshold: string;
    targetStockQuantity: string;
    nearestExpirationDate: string;
    averageUnitCost: string;
    notes: string;
  }> = {},
): FormData {
  const data = new FormData();
  data.append("id", overrides.id ?? "ingredient-1");
  data.append("name", overrides.name ?? "Fresh Milk");
  data.append("baseUnit", overrides.baseUnit ?? "ml");
  data.append("category", overrides.category ?? "ingredient");
  data.append("currentQuantity", overrides.currentQuantity ?? "500");
  data.append("lowStockThreshold", overrides.lowStockThreshold ?? "200");
  data.append("targetStockQuantity", overrides.targetStockQuantity ?? "1000");
  data.append("nearestExpirationDate", overrides.nearestExpirationDate ?? "2026-09-01");
  data.append("averageUnitCost", overrides.averageUnitCost ?? "92");
  data.append("notes", overrides.notes ?? "Keep refrigerated.");
  return data;
}

test("an identical form is clean", () => {
  const baseline = buildIngredientFormSnapshot(ingredientFormData());
  const live = buildIngredientFormSnapshot(ingredientFormData());
  assert.equal(isIngredientFormDirty(live, baseline), false);
});

test("a changed name is dirty", () => {
  const baseline = buildIngredientFormSnapshot(ingredientFormData());
  const live = buildIngredientFormSnapshot(ingredientFormData({ name: "Fresh Milk (updated)" }));
  assert.equal(isIngredientFormDirty(live, baseline), true);
});

test("a changed base unit is dirty", () => {
  const baseline = buildIngredientFormSnapshot(ingredientFormData());
  const live = buildIngredientFormSnapshot(ingredientFormData({ baseUnit: "g" }));
  assert.equal(isIngredientFormDirty(live, baseline), true);
});

test("a changed category is dirty", () => {
  const baseline = buildIngredientFormSnapshot(ingredientFormData());
  const live = buildIngredientFormSnapshot(ingredientFormData({ category: "consumable" }));
  assert.equal(isIngredientFormDirty(live, baseline), true);
});

test("a changed low-stock threshold is dirty", () => {
  const baseline = buildIngredientFormSnapshot(ingredientFormData());
  const live = buildIngredientFormSnapshot(ingredientFormData({ lowStockThreshold: "250" }));
  assert.equal(isIngredientFormDirty(live, baseline), true);
});

test("a changed target stock quantity is dirty", () => {
  const baseline = buildIngredientFormSnapshot(ingredientFormData());
  const live = buildIngredientFormSnapshot(ingredientFormData({ targetStockQuantity: "1200" }));
  assert.equal(isIngredientFormDirty(live, baseline), true);
});

test("a changed nearest expiration date is dirty", () => {
  const baseline = buildIngredientFormSnapshot(ingredientFormData());
  const live = buildIngredientFormSnapshot(ingredientFormData({ nearestExpirationDate: "2026-10-15" }));
  assert.equal(isIngredientFormDirty(live, baseline), true);
});

test("a changed average unit cost is dirty", () => {
  const baseline = buildIngredientFormSnapshot(ingredientFormData());
  const live = buildIngredientFormSnapshot(ingredientFormData({ averageUnitCost: "98.50" }));
  assert.equal(isIngredientFormDirty(live, baseline), true);
});

test("a changed notes field is dirty", () => {
  const baseline = buildIngredientFormSnapshot(ingredientFormData());
  const live = buildIngredientFormSnapshot(ingredientFormData({ notes: "Switched supplier, keep frozen instead." }));
  assert.equal(isIngredientFormDirty(live, baseline), true);
});

test("changing a field then restoring its original value returns to clean", () => {
  const baseline = buildIngredientFormSnapshot(ingredientFormData());
  const changed = buildIngredientFormSnapshot(ingredientFormData({ averageUnitCost: "150" }));
  assert.equal(isIngredientFormDirty(changed, baseline), true);

  const reverted = buildIngredientFormSnapshot(ingredientFormData({ averageUnitCost: "92" }));
  assert.equal(isIngredientFormDirty(reverted, baseline), false);
});

test("id never contributes to dirty state even when it differs", () => {
  const baseline = buildIngredientFormSnapshot(ingredientFormData({ id: "ingredient-1" }));
  const live = buildIngredientFormSnapshot(ingredientFormData({ id: "ingredient-2" }));
  assert.equal(areIngredientFormSnapshotsEqual(live, baseline), true);
});

// currentQuantity is always a hidden, non-user-editable field on this form (see
// ingredient-form-snapshot.ts's comment) -- this asserts the snapshot never picks it up as a
// dirty signal, matching what the real form's own hidden input guarantees (its value only ever
// reflects the loaded ingredient, never something the operator typed).
test("currentQuantity never contributes to dirty state even when it differs", () => {
  const baseline = buildIngredientFormSnapshot(ingredientFormData({ currentQuantity: "500" }));
  const live = buildIngredientFormSnapshot(ingredientFormData({ currentQuantity: "480" }));
  assert.equal(areIngredientFormSnapshotsEqual(live, baseline), true);
});
