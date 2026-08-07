import test from "node:test";
import assert from "node:assert/strict";
import { areSupplyFormSnapshotsEqual, buildSupplyFormSnapshot, isSupplyFormDirty } from "../src/lib/supply-form-snapshot.ts";

// Mirrors a real PurchaseLogPage submission (src/app/product-lab.tsx) -- every field name here
// matches that form's `name=` attributes exactly, including the two hidden inputs
// SupplyIngredientField renders (ingredientId/ingredientName).
function supplyFormData(
  overrides: Partial<{
    id: string;
    ingredientId: string;
    ingredientName: string;
    brandName: string;
    supplierName: string;
    purchaseDate: string;
    packQuantity: string;
    unit: string;
    totalCost: string;
    qualityRating: string;
    notes: string;
  }> = {},
): FormData {
  const data = new FormData();
  data.append("id", overrides.id ?? "supply-1");
  data.append("brandName", overrides.brandName ?? "Beryl's");
  data.append("ingredientId", overrides.ingredientId ?? "ingredient-1");
  data.append("ingredientName", overrides.ingredientName ?? "Cocoa Powder");
  data.append("supplierName", overrides.supplierName ?? "SM Supermarket");
  data.append("purchaseDate", overrides.purchaseDate ?? "2026-08-01");
  data.append("packQuantity", overrides.packQuantity ?? "1000");
  data.append("unit", overrides.unit ?? "g");
  data.append("totalCost", overrides.totalCost ?? "450");
  data.append("qualityRating", overrides.qualityRating ?? "4");
  data.append("notes", overrides.notes ?? "Darker color, stronger aroma.");
  return data;
}

test("an identical form is clean", () => {
  const baseline = buildSupplyFormSnapshot(supplyFormData());
  const live = buildSupplyFormSnapshot(supplyFormData());
  assert.equal(isSupplyFormDirty(live, baseline), false);
});

test("a changed purchase date is dirty", () => {
  const baseline = buildSupplyFormSnapshot(supplyFormData());
  const live = buildSupplyFormSnapshot(supplyFormData({ purchaseDate: "2026-08-05" }));
  assert.equal(isSupplyFormDirty(live, baseline), true);
});

test("a changed pack quantity is dirty", () => {
  const baseline = buildSupplyFormSnapshot(supplyFormData());
  const live = buildSupplyFormSnapshot(supplyFormData({ packQuantity: "1200" }));
  assert.equal(isSupplyFormDirty(live, baseline), true);
});

test("a changed unit is dirty", () => {
  const baseline = buildSupplyFormSnapshot(supplyFormData());
  const live = buildSupplyFormSnapshot(supplyFormData({ unit: "kg" }));
  assert.equal(isSupplyFormDirty(live, baseline), true);
});

test("a changed total cost is dirty", () => {
  const baseline = buildSupplyFormSnapshot(supplyFormData());
  const live = buildSupplyFormSnapshot(supplyFormData({ totalCost: "500" }));
  assert.equal(isSupplyFormDirty(live, baseline), true);
});

test("a changed quality rating is dirty", () => {
  const baseline = buildSupplyFormSnapshot(supplyFormData());
  const live = buildSupplyFormSnapshot(supplyFormData({ qualityRating: "5" }));
  assert.equal(isSupplyFormDirty(live, baseline), true);
});

test("a changed notes field is dirty", () => {
  const baseline = buildSupplyFormSnapshot(supplyFormData());
  const live = buildSupplyFormSnapshot(supplyFormData({ notes: "Clumpy this time, delivery took 3 days." }));
  assert.equal(isSupplyFormDirty(live, baseline), true);
});

test("a changed ingredient selection is dirty", () => {
  const baseline = buildSupplyFormSnapshot(supplyFormData());
  const live = buildSupplyFormSnapshot(supplyFormData({ ingredientId: "ingredient-2", ingredientName: "Butter" }));
  assert.equal(isSupplyFormDirty(live, baseline), true);
});

test("a changed brand is dirty", () => {
  const baseline = buildSupplyFormSnapshot(supplyFormData());
  const live = buildSupplyFormSnapshot(supplyFormData({ brandName: "Callebaut" }));
  assert.equal(isSupplyFormDirty(live, baseline), true);
});

test("a changed supplier is dirty", () => {
  const baseline = buildSupplyFormSnapshot(supplyFormData());
  const live = buildSupplyFormSnapshot(supplyFormData({ supplierName: "Shopee" }));
  assert.equal(isSupplyFormDirty(live, baseline), true);
});

test("changing a field then restoring its original value returns to clean", () => {
  const baseline = buildSupplyFormSnapshot(supplyFormData());
  const changed = buildSupplyFormSnapshot(supplyFormData({ totalCost: "999" }));
  assert.equal(isSupplyFormDirty(changed, baseline), true);

  const reverted = buildSupplyFormSnapshot(supplyFormData({ totalCost: "450" }));
  assert.equal(isSupplyFormDirty(reverted, baseline), false);
});

test("id never contributes to dirty state even when it differs", () => {
  const baseline = buildSupplyFormSnapshot(supplyFormData({ id: "supply-1" }));
  const live = buildSupplyFormSnapshot(supplyFormData({ id: "supply-2" }));
  assert.equal(areSupplyFormSnapshotsEqual(live, baseline), true);
});
