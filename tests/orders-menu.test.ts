// The sellable menu: which formats are offerable, and that the three snapshots are carried
// through without Selling ever computing a price.

import test from "node:test";
import assert from "node:assert/strict";
import { buildCatalogOrderLine, buildLinesFromDrafts, buildManualOrderLine, CUSTOM_ITEM_KEY, findSellableItem, getSellableItems, type DraftLine } from "../src/lib/orders/menu.ts";
import { validateOrderForSave } from "../src/lib/orders/validation.ts";
import { navItems, type LabView } from "../src/lib/lab-state.ts";
import type { Order } from "../src/lib/orders/types.ts";
import type { CostingSummary, Product, ProductBatch, SellingFormat } from "../src/lib/product-lab-types.ts";

function product(id: string, name: string): Product {
  return { id, name, category: "Bakery", role: "Hero candidate", status: "costed", description: "", image: "", decision: "Candidate" };
}

// batches are stored newest-first (loadSupabaseData orders by created_at desc), which is the
// assumption getLatestBatch relies on.
function batch(id: string, productId: string, version: string): ProductBatch {
  return {
    id,
    productId,
    batchVersion: version,
    dateMade: "2026-08-01",
    ingredientsNotes: "",
    prepTimeMinutes: 0,
    bakeTimeMinutes: 0,
    coolingTimeMinutes: 0,
    usablePieces: 12,
    imperfectPieces: 0,
    stressLevel: 1,
    tasteNotes: "",
    textureNotes: "",
    wentWrong: "",
    improveNext: "",
    launchDecision: "launch",
  };
}

function costing(id: string, productId: string, batchId: string): CostingSummary {
  return {
    id,
    productId,
    batchId,
    ingredientCost: 0,
    packagingCost: 0,
    laborEstimate: 0,
    waterCost: 0,
    gasCost: 0,
    ovenElectricCost: 0,
    refrigerationCost: 0,
    coffeeEquipmentCost: 0,
    wasteAllowance: 0,
    overheadCost: 0,
    equipmentCost: 0,
    suggestedPrice: 0,
    notes: "",
  };
}

function format(id: string, costingId: string, name: string, overrides: Partial<SellingFormat> = {}): SellingFormat {
  return { id, costingId, name, piecesPerUnit: 6, sellingPrice: 480, isActive: true, sortOrder: 0, notes: "", ...overrides };
}

const BROWNIES = product("brownies", "Brownies");
const BATCH_V2 = batch("batch-v2", "brownies", "V2");
const BATCH_V1 = batch("batch-v1", "brownies", "V1");
const COSTING_V2 = costing("costing-v2", "brownies", "batch-v2");
const COSTING_V1 = costing("costing-v1", "brownies", "batch-v1");

test("the menu offers only the current costing's formats", () => {
  // Older batch versions each keep their own costing and formats. Offering those would let the
  // operator sell last month's price by accident.
  const groups = getSellableItems(
    [BROWNIES],
    [BATCH_V2, BATCH_V1],
    [COSTING_V2, COSTING_V1],
    [format("fmt-current", "costing-v2", "Box of 6"), format("fmt-old", "costing-v1", "Old Box of 6", { sellingPrice: 300 })],
  );

  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].items.map((item) => item.sellingFormatId), ["fmt-current"]);
});

test("archived formats are excluded", () => {
  const groups = getSellableItems(
    [BROWNIES],
    [BATCH_V2],
    [COSTING_V2],
    [format("fmt-active", "costing-v2", "Box of 6"), format("fmt-archived", "costing-v2", "Retired Box", { isActive: false })],
  );

  assert.deepEqual(groups[0].items.map((item) => item.sellingFormatId), ["fmt-active"]);
});

test("a format with no name or a non-positive pack size is excluded", () => {
  const groups = getSellableItems(
    [BROWNIES],
    [BATCH_V2],
    [COSTING_V2],
    [
      format("fmt-ok", "costing-v2", "Box of 6"),
      format("fmt-unnamed", "costing-v2", "   "),
      format("fmt-zero-pieces", "costing-v2", "Broken", { piecesPerUnit: 0 }),
    ],
  );

  assert.deepEqual(groups[0].items.map((item) => item.sellingFormatId), ["fmt-ok"]);
});

test("a product with no costing contributes no catalog items", () => {
  // It remains sellable as a manual line -- which is exactly why that path exists.
  const groups = getSellableItems([BROWNIES], [BATCH_V2], [], [format("fmt", "costing-v2", "Box of 6")]);
  assert.deepEqual(groups, []);
});

test("a product with no batches falls back to any costing recorded for the product", () => {
  // getLinkedCosting's documented legacy fallback, reused rather than reimplemented.
  const legacyCosting = { ...costing("costing-legacy", "brownies", ""), batchId: "" };
  const groups = getSellableItems([BROWNIES], [], [legacyCosting], [format("fmt-legacy", "costing-legacy", "Box of 6")]);
  assert.deepEqual(groups[0].items.map((item) => item.sellingFormatId), ["fmt-legacy"]);
});

test("items carry the format's price and pack size unchanged -- Selling computes no price", () => {
  const groups = getSellableItems([BROWNIES], [BATCH_V2], [COSTING_V2], [format("fmt", "costing-v2", "Box of 6", { sellingPrice: 512.75, piecesPerUnit: 6 })]);
  const item = groups[0].items[0];

  // Straight through from selling_formats. No markup, no margin math, no second pricing rule.
  assert.equal(item.unitPrice, 512.75);
  assert.equal(item.piecesPerUnit, 6);
  assert.equal(item.itemName, "Brownies — Box of 6");
  assert.equal(item.productId, "brownies");
  assert.equal(item.sellingFormatId, "fmt");
});

test("groups are ordered by product name, and items by sortOrder then name", () => {
  const cookies = product("cookies", "Cookies");
  const cookieBatch = batch("batch-c", "cookies", "V1");
  const cookieCosting = costing("costing-c", "cookies", "batch-c");

  const groups = getSellableItems(
    [cookies, BROWNIES],
    [BATCH_V2, cookieBatch],
    [COSTING_V2, cookieCosting],
    [
      format("fmt-b2", "costing-v2", "Box of 12", { sortOrder: 2 }),
      format("fmt-b1", "costing-v2", "Box of 6", { sortOrder: 1 }),
      format("fmt-c", "costing-c", "Bag of 4"),
    ],
  );

  assert.deepEqual(groups.map((group) => group.productName), ["Brownies", "Cookies"]);
  assert.deepEqual(groups[0].items.map((item) => item.formatName), ["Box of 6", "Box of 12"]);
});

test("findSellableItem resolves a key, and returns null for an unknown one", () => {
  const groups = getSellableItems([BROWNIES], [BATCH_V2], [COSTING_V2], [format("fmt", "costing-v2", "Box of 6")]);
  assert.equal(findSellableItem(groups, "brownies::fmt")?.sellingFormatId, "fmt");
  assert.equal(findSellableItem(groups, "nope::nope"), null);
});

test("getSellableItems never mutates its inputs", () => {
  const formats = [format("fmt-b", "costing-v2", "B", { sortOrder: 2 }), format("fmt-a", "costing-v2", "A", { sortOrder: 1 })];
  const frozen = JSON.stringify(formats);
  getSellableItems([BROWNIES], [BATCH_V2], [COSTING_V2], formats);
  assert.equal(JSON.stringify(formats), frozen);
});

// --- Line construction ---------------------------------------------------------------------------

test("a catalog line snapshots name, price and pack size together", () => {
  const groups = getSellableItems([BROWNIES], [BATCH_V2], [COSTING_V2], [format("fmt", "costing-v2", "Box of 6", { sellingPrice: 480, piecesPerUnit: 6 })]);
  const line = buildCatalogOrderLine(groups[0].items[0], { id: "line-1", orderId: "order-1", quantity: 2, sortOrder: 0 });

  assert.equal(line.productId, "brownies");
  assert.equal(line.sellingFormatId, "fmt");
  assert.equal(line.itemName, "Brownies — Box of 6");
  assert.equal(line.unitPrice, 480);
  assert.equal(line.piecesPerUnitSnapshot, 6);
  assert.equal(line.quantity, 2);
  assert.equal(line.orderId, "order-1");
});

test("an edited unit price overrides the format's price on the snapshot", () => {
  // Editing is normal, not an override: the snapshot records what was actually charged.
  const groups = getSellableItems([BROWNIES], [BATCH_V2], [COSTING_V2], [format("fmt", "costing-v2", "Box of 6", { sellingPrice: 480 })]);
  const line = buildCatalogOrderLine(groups[0].items[0], { id: "line-1", orderId: "order-1", quantity: 1, sortOrder: 0, unitPrice: 450 });

  assert.equal(line.unitPrice, 450);
  // The pack size is NOT editable and stays exactly as the format defined it.
  assert.equal(line.piecesPerUnitSnapshot, 6);
});

test("a manual line has both pointers empty and a null pack size", () => {
  const line = buildManualOrderLine({ id: "line-2", orderId: "order-1", itemName: "Delivery", unitPrice: 60, quantity: 1, sortOrder: 1 });

  assert.equal(line.productId, "");
  assert.equal(line.sellingFormatId, "");
  // null means "not recorded" -- never 1, never 0.
  assert.equal(line.piecesPerUnitSnapshot, null);
  assert.equal(line.itemName, "Delivery");
  assert.equal(line.unitPrice, 60);
});

// --- Form drafts ---------------------------------------------------------------------------------

const MENU = getSellableItems([BROWNIES], [BATCH_V2], [COSTING_V2], [format("fmt", "costing-v2", "Box of 6", { sellingPrice: 480, piecesPerUnit: 6 })]);

function draft(overrides: Partial<DraftLine> = {}): DraftLine {
  return { rowId: crypto.randomUUID(), itemKey: "brownies::fmt", itemName: "", unitPrice: "480", quantity: "1", ...overrides };
}

test("drafts become lines carrying the saved order id", () => {
  const lines = buildLinesFromDrafts([draft(), draft()], MENU, "order-42");
  assert.equal(lines.length, 2);
  assert.ok(lines.every((line) => line.orderId === "order-42"));
});

test("a row with no item chosen is skipped, not saved as a blank line", () => {
  // An empty trailing row is a normal state of a form with an "Add item" button.
  const lines = buildLinesFromDrafts([draft(), draft({ itemKey: "" })], MENU, "order-1");
  assert.equal(lines.length, 1);
});

test("a custom draft becomes a manual line with a null pack size", () => {
  const lines = buildLinesFromDrafts([draft({ itemKey: CUSTOM_ITEM_KEY, itemName: "  Delivery  ", unitPrice: "60" })], MENU, "order-1");

  assert.equal(lines[0].itemName, "Delivery");
  assert.equal(lines[0].productId, "");
  assert.equal(lines[0].sellingFormatId, "");
  assert.equal(lines[0].piecesPerUnitSnapshot, null);
  assert.equal(lines[0].unitPrice, 60);
});

test("a draft whose catalog item vanished mid-form degrades to a manual line, never disappears", () => {
  // A costing deleted while the form was open must not silently shrink the order.
  const lines = buildLinesFromDrafts([draft({ itemKey: "gone::gone", itemName: "Brownies — Box of 6", unitPrice: "480" })], MENU, "order-1");

  assert.equal(lines.length, 1);
  assert.equal(lines[0].itemName, "Brownies — Box of 6");
  assert.equal(lines[0].unitPrice, 480);
  assert.equal(lines[0].piecesPerUnitSnapshot, null);
});

test("sortOrder follows the row order the operator sees", () => {
  const lines = buildLinesFromDrafts([draft(), draft({ itemKey: CUSTOM_ITEM_KEY, itemName: "Delivery", unitPrice: "60" })], MENU, "order-1");
  assert.deepEqual(lines.map((line) => line.sortOrder), [0, 1]);
});

test("a non-integer typed quantity is rejected by validation before any round trip", () => {
  const order: Order = {
    id: "order-1",
    customerId: "customer-1",
    status: "new",
    paymentStatus: "unpaid",
    paymentMethod: null,
    paidAt: null,
    paidAmount: null,
    refundedAt: null,
    fulfillmentMethod: "pickup",
    fulfillmentAt: null,
    fulfillmentAddress: "",
    fulfillmentNotes: "",
    source: "unknown",
    sourceRef: "",
    entryMethod: "manual",
    notes: "",
    placedAt: "2026-08-09T06:00:00.000Z",
    completedAt: null,
    cancelledAt: null,
    cancelReason: "",
    createdAt: "2026-08-09T06:00:00.000Z",
    updatedAt: "2026-08-09T06:00:00.000Z",
  };

  assert.match(String(validateOrderForSave(order, buildLinesFromDrafts([draft({ quantity: "2.5" })], MENU, "order-1"))), /whole quantity/i);
  assert.match(String(validateOrderForSave(order, buildLinesFromDrafts([draft({ quantity: "0" })], MENU, "order-1"))), /whole quantity/i);
  assert.equal(validateOrderForSave(order, buildLinesFromDrafts([draft({ quantity: "3" })], MENU, "order-1")), null);
});

// --- Wiring --------------------------------------------------------------------------------------

test("Orders is registered as a nav entry at /orders, placed after Costing", () => {
  const labels = navItems.map((item) => item.label);
  const orders = navItems.find((item) => item.view === ("orders" satisfies LabView));

  assert.ok(orders, "Orders is missing from navItems");
  assert.equal(orders?.href, "/orders");
  assert.equal(orders?.label, "Orders");
  // Orders belongs with the money pages, immediately after Costing.
  assert.equal(labels.indexOf("Orders"), labels.indexOf("Costing") + 1);
});
