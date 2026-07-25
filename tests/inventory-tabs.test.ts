import test from "node:test";
import assert from "node:assert/strict";
import { defaultInventoryTab, inventoryTabs, resolveInventoryTab } from "../src/lib/inventory-tabs.ts";

test("resolveInventoryTab defaults to Current Stock when the value is missing", () => {
  assert.equal(resolveInventoryTab(undefined), defaultInventoryTab);
  assert.equal(defaultInventoryTab, "stock");
});

test("resolveInventoryTab defaults to Current Stock for an unknown value", () => {
  assert.equal(resolveInventoryTab("supplies"), "stock");
  assert.equal(resolveInventoryTab("bogus"), "stock");
  assert.equal(resolveInventoryTab(""), "stock");
});

test("resolveInventoryTab passes through every valid tab key", () => {
  for (const tab of inventoryTabs) {
    assert.equal(resolveInventoryTab(tab.key), tab.key);
  }
});

test("resolveInventoryTab takes the first entry when Next.js hands back an array", () => {
  assert.equal(resolveInventoryTab(["purchases", "history"]), "purchases");
});

test("resolveInventoryTab falls back to default when the array's first entry is invalid", () => {
  assert.equal(resolveInventoryTab(["bogus", "history"]), "stock");
});

test("inventoryTabs has exactly one entry per tab key, in the required order", () => {
  assert.deepEqual(
    inventoryTabs.map((tab) => tab.key),
    ["stock", "purchases", "need-to-buy", "history", "ingredients"],
  );
});

test("the Ingredients tab is labeled 'Manage Items', not 'Ingredients'", () => {
  const tab = inventoryTabs.find((item) => item.key === "ingredients");
  assert.equal(tab?.label, "Manage Items");
});
