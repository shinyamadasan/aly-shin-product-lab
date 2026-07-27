import test from "node:test";
import assert from "node:assert/strict";
import { findReliableBrandForItem, findReliableSupplierForItem, getChronologicalPurchases, getPurchaseGroupSummary, getPurchaseHistoryForItem, getUnlinkedPurchases, groupPurchasesByItem } from "../src/lib/purchase-history.ts";
import type { Ingredient, SupplyEntry } from "../src/lib/product-lab-types.ts";

function ingredient(overrides: Partial<Ingredient> = {}): Ingredient {
  return {
    id: "item-1",
    name: "Dark Chocolate Compound",
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

function purchase(overrides: Partial<SupplyEntry> = {}): SupplyEntry {
  return {
    id: crypto.randomUUID(),
    ingredientId: "",
    ingredientName: "Dark Chocolate Compound",
    brandName: "Van Houten",
    supplierName: "Main",
    purchaseDate: "2026-01-01",
    createdAt: "2026-01-01T00:00:00.000Z",
    packQuantity: 1000,
    unit: "g",
    totalCost: 450,
    qualityRating: 4,
    notes: "",
    ...overrides,
  };
}

test("purchase history associates by exact ingredientId", () => {
  const item = ingredient({ id: "choc-id" });
  const linked = purchase({ id: "linked", ingredientId: "choc-id" });
  const other = purchase({ id: "other", ingredientId: "sugar-id", ingredientName: "Dark Chocolate Compound" });

  assert.deepEqual(getPurchaseHistoryForItem(item, [linked, other]).map((entry) => entry.id), ["linked"]);
});

test("ingredientId association survives a different historical ingredientName", () => {
  const item = ingredient({ id: "choc-id", name: "Dark Chocolate Compound" });
  const linked = purchase({ id: "linked", ingredientId: "choc-id", ingredientName: "Old Receipt Name" });

  assert.deepEqual(getPurchaseHistoryForItem(item, [linked]).map((entry) => entry.id), ["linked"]);
});

test("legacy null, empty, and whitespace ingredientId rows fall back to normalized ingredientName", () => {
  const item = ingredient({ id: "choc-id", name: "Dark Chocolate Compound" });
  const empty = purchase({ id: "empty", ingredientId: "", ingredientName: "Dark Chocolate Compound" });
  const whitespace = purchase({ id: "whitespace", ingredientId: "   ", ingredientName: "Dark Chocolate, Compound" });

  assert.deepEqual(getPurchaseHistoryForItem(item, [empty, whitespace]).map((entry) => entry.id), ["empty", "whitespace"]);
});

test("conflicting ingredientId and ingredientName follows the ID and ignores the name", () => {
  const chocolate = ingredient({ id: "choc-id", name: "Dark Chocolate Compound" });
  const sugar = ingredient({ id: "sugar-id", name: "Refined Sugar" });
  const conflicting = purchase({ id: "conflict", ingredientId: "sugar-id", ingredientName: "Dark Chocolate Compound" });

  assert.deepEqual(getPurchaseHistoryForItem(chocolate, [conflicting]).map((entry) => entry.id), []);
  assert.deepEqual(getPurchaseHistoryForItem(sugar, [conflicting]).map((entry) => entry.id), ["conflict"]);
});

test("unknown ingredientId refuses name fallback", () => {
  const item = ingredient({ id: "choc-id", name: "Dark Chocolate Compound" });
  const unknown = purchase({ id: "unknown", ingredientId: "deleted-item-id", ingredientName: "Dark Chocolate Compound" });

  assert.deepEqual(getPurchaseHistoryForItem(item, [unknown]).map((entry) => entry.id), []);
});

test("brand filtering happens after Item association", () => {
  const item = ingredient({ id: "choc-id" });
  const vanHouten = purchase({ id: "van-houten", ingredientId: "choc-id", brandName: "Van Houten" });
  const beryls = purchase({ id: "beryls", ingredientId: "choc-id", brandName: "Beryl's" });
  const wrongItem = purchase({ id: "wrong-item", ingredientId: "other-id", ingredientName: "Dark Chocolate Compound", brandName: "Van Houten" });

  assert.deepEqual(getPurchaseHistoryForItem(item, [vanHouten, beryls, wrongItem], { brandName: "Van Houten" }).map((entry) => entry.id), ["van-houten"]);
});

test("ID-linked purchases remain valid after an Item rename", () => {
  const renamed = ingredient({ id: "choc-id", name: "Chocolate Compound - Dark" });
  const linked = purchase({ id: "linked", ingredientId: "choc-id", ingredientName: "Dark Chocolate Compound", brandName: "Van Houten", supplierName: "Main" });

  assert.deepEqual(getPurchaseHistoryForItem(renamed, [linked]).map((entry) => entry.id), ["linked"]);
  assert.equal(findReliableBrandForItem(renamed, [linked]), "Van Houten");
  assert.equal(findReliableSupplierForItem(renamed, [linked]), "Main");
});

test("legacy rename behavior remains limited to existing normalized-name matching", () => {
  const renamed = ingredient({ id: "choc-id", name: "Chocolate Compound - Dark" });
  const legacy = purchase({ id: "legacy", ingredientId: "", ingredientName: "Dark Chocolate Compound" });

  assert.deepEqual(getPurchaseHistoryForItem(renamed, [legacy]).map((entry) => entry.id), []);
});

test("groupPurchasesByItem puts two purchases with the same ingredientId into one Item group", () => {
  const item = ingredient({ id: "choc-id" });
  const first = purchase({ id: "first", ingredientId: "choc-id", purchaseDate: "2026-01-01", packQuantity: 1000, totalCost: 450 });
  const second = purchase({ id: "second", ingredientId: "choc-id", purchaseDate: "2026-02-01", packQuantity: 500, totalCost: 250 });

  const [group] = groupPurchasesByItem([item], [first, second]);
  const summary = getPurchaseGroupSummary(group);

  assert.equal(group.ingredient.id, "choc-id");
  assert.deepEqual(group.purchases.map((entry) => entry.id), ["second", "first"]);
  assert.equal(summary.purchaseCount, 2);
  assert.equal(summary.totalPurchasedQuantity, 1500);
  assert.equal(summary.totalPurchasedUnit, "g");
});

test("same purchase name with different ingredientIds remains separate Item groups", () => {
  const chocolate = ingredient({ id: "choc-id", name: "Dark Chocolate Compound" });
  const sugar = ingredient({ id: "sugar-id", name: "Refined Sugar" });
  const chocolatePurchase = purchase({ id: "choc-purchase", ingredientId: "choc-id", ingredientName: "Shared Receipt Name" });
  const sugarPurchase = purchase({ id: "sugar-purchase", ingredientId: "sugar-id", ingredientName: "Shared Receipt Name" });

  const groups = groupPurchasesByItem([chocolate, sugar], [chocolatePurchase, sugarPurchase]);

  assert.deepEqual(groups.map((group) => [group.ingredient.id, group.purchases.map((entry) => entry.id)]), [
    ["choc-id", ["choc-purchase"]],
    ["sugar-id", ["sugar-purchase"]],
  ]);
});

test("groupPurchasesByItem stays rename-safe for ID-linked purchases", () => {
  const renamed = ingredient({ id: "choc-id", name: "Chocolate Compound - Dark" });
  const linked = purchase({ id: "linked", ingredientId: "choc-id", ingredientName: "Dark Chocolate Compound" });

  const [group] = groupPurchasesByItem([renamed], [linked]);

  assert.equal(group.ingredient.name, "Chocolate Compound - Dark");
  assert.deepEqual(group.purchases.map((entry) => entry.id), ["linked"]);
});

test("legacy blank-ID purchases group through existing normalized-name fallback", () => {
  const item = ingredient({ id: "choc-id", name: "Dark Chocolate Compound" });
  const legacy = purchase({ id: "legacy", ingredientId: " ", ingredientName: "Dark Chocolate, Compound" });

  const [group] = groupPurchasesByItem([item], [legacy]);

  assert.deepEqual(group.purchases.map((entry) => entry.id), ["legacy"]);
});

test("unknown non-empty ingredientId appears unlinked and does not group by name", () => {
  const item = ingredient({ id: "choc-id", name: "Dark Chocolate Compound" });
  const unknown = purchase({ id: "unknown", ingredientId: "missing-id", ingredientName: "Dark Chocolate Compound" });

  assert.deepEqual(groupPurchasesByItem([item], [unknown]), []);
  assert.deepEqual(getUnlinkedPurchases([item], [unknown]).map((entry) => entry.id), ["unknown"]);
});

test("chronological purchases keeps every transaction separate", () => {
  const first = purchase({ id: "first", ingredientId: "choc-id", purchaseDate: "2026-01-01" });
  const second = purchase({ id: "second", ingredientId: "choc-id", purchaseDate: "2026-02-01" });

  assert.deepEqual(getChronologicalPurchases([first, second]).map((entry) => entry.id), ["second", "first"]);
  assert.equal(getChronologicalPurchases([first, second]).length, 2);
});

test("removing one purchase from a group leaves the other purchase records intact", () => {
  const item = ingredient({ id: "choc-id" });
  const first = purchase({ id: "first", ingredientId: "choc-id" });
  const second = purchase({ id: "second", ingredientId: "choc-id" });
  const afterDelete = [first, second].filter((entry) => entry.id !== "first");

  const [group] = groupPurchasesByItem([item], afterDelete);

  assert.deepEqual(group.purchases.map((entry) => entry.id), ["second"]);
});
