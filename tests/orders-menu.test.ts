// The sellable menu: which formats are offerable, and that the three snapshots are carried
// through without Selling ever computing a price.

import test from "node:test";
import assert from "node:assert/strict";
import { applyItemChoice, buildCatalogOrderLine, buildLinesFromDrafts, buildManualOrderLine, CUSTOM_ITEM_KEY, describeUnorderableReason, findSellableItem, getSellableItems, getSellableOptionLabel, getUnorderableProducts, describePieceCount, sanitizeQuantityInput, settleQuantity, stepQuantity, type DraftLine } from "../src/lib/orders/menu.ts";
import { validateOrderForSave } from "../src/lib/orders/validation.ts";
import { getOrderTotals } from "../src/lib/orders/totals.ts";
import { getPreparationTotals } from "../src/lib/orders/pieces.ts";
import { navItems, type LabView } from "../src/lib/lab-state.ts";
import type { Order } from "../src/lib/orders/types.ts";
import type { CostingSummary, Product, ProductBatch, SellingFormat } from "../src/lib/product-lab-types.ts";

function product(id: string, name: string): Product {
  return { id, name, category: "Bakery", role: "Hero candidate", status: "costed", description: "", image: "", decision: "Candidate", isPublic: false };
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

// --- Item picker: what is offered, and why a product is not ------------------------------------------

const BLONDIES = product("blondies", "Blondies");
const BLONDIES_BATCH = batch("batch-bl", "blondies", "V1");
const BLONDIES_COSTING = costing("costing-bl", "blondies", "batch-bl");

test("several products, each with several formats, all appear and stay distinguishable", () => {
  const groups = getSellableItems(
    [BROWNIES, BLONDIES],
    [BATCH_V2, BLONDIES_BATCH],
    [COSTING_V2, BLONDIES_COSTING],
    [
      format("fmt-1pc", "costing-v2", "1 pc", { piecesPerUnit: 1, sellingPrice: 85, sortOrder: 1 }),
      format("fmt-box", "costing-v2", "Box of 6", { piecesPerUnit: 6, sellingPrice: 480, sortOrder: 2 }),
      format("fmt-bl", "costing-bl", "1 pc", { piecesPerUnit: 1, sellingPrice: 95 }),
    ],
  );

  assert.deepEqual(groups.map((group) => group.productName), ["Blondies", "Brownies"]);
  assert.deepEqual(groups[1].items.map((item) => getSellableOptionLabel(item)), ["1 pc — ₱85.00", "Box of 6 — ₱480.00"]);
  assert.deepEqual(groups[0].items.map((item) => getSellableOptionLabel(item)), ["1 pc — ₱95.00"]);
  // Same format name under two products still resolves to the right product and price.
  assert.equal(findSellableItem(groups, "blondies::fmt-bl")?.unitPrice, 95);
  assert.equal(findSellableItem(groups, "brownies::fmt-1pc")?.unitPrice, 85);
});

test("a product with no selling format is given no price -- costing's suggested price is not a fallback", () => {
  const costed = { ...COSTING_V2, suggestedPrice: 500, ingredientCost: 200 };
  const groups = getSellableItems([BROWNIES], [BATCH_V2], [costed], []);

  assert.deepEqual(groups, []);
});

test("each way a product can be left out is named, and orderable products are not listed", () => {
  const noCosting = product("no-costing", "Cookies");
  const noFormat = product("no-format", "Scones");
  const unusable = product("unusable", "Loaf");
  const older = product("older", "Muffins");

  const batches = [batch("b-nf", "no-format", "V1"), batch("b-un", "unusable", "V1"), batch("b-old2", "older", "V2"), batch("b-old1", "older", "V1"), BATCH_V2];
  const costings = [costing("c-nf", "no-format", "b-nf"), costing("c-un", "unusable", "b-un"), costing("c-old2", "older", "b-old2"), costing("c-old1", "older", "b-old1"), COSTING_V2];
  const formats = [
    format("f-un", "c-un", "Loaf", { isActive: false }),
    format("f-old", "c-old1", "Box of 6"),
    format("f-ok", "costing-v2", "Box of 6"),
  ];

  const result = getUnorderableProducts([BROWNIES, noCosting, noFormat, unusable, older], batches, costings, formats);

  assert.deepEqual(
    result.map((entry) => [entry.productName, entry.reason]),
    [
      ["Cookies", "no-costing"],
      ["Loaf", "selling-format-unusable"],
      ["Muffins", "formats-on-older-costing"],
      ["Scones", "no-selling-format"],
    ],
  );
  assert.ok(result.every((entry) => describeUnorderableReason(entry.reason).length > 0));
});

test("getSellableItems and getUnorderableProducts partition the products -- no product is in both", () => {
  const products = [BROWNIES, BLONDIES];
  const batches = [BATCH_V2, BLONDIES_BATCH];
  const costings = [COSTING_V2, BLONDIES_COSTING];
  const formats = [format("fmt", "costing-v2", "Box of 6")];

  const offered = getSellableItems(products, batches, costings, formats).map((group) => group.productId);
  const left = getUnorderableProducts(products, batches, costings, formats).map((entry) => entry.productId);

  assert.deepEqual(offered, ["brownies"]);
  assert.deepEqual(left, ["blondies"]);
});

test("an empty catalog yields no groups and no unorderable products", () => {
  assert.deepEqual(getSellableItems([], [], [], []), []);
  assert.deepEqual(getUnorderableProducts([], [], [], []), []);
});

test("choosing a catalog item fills the name and price from the format", () => {
  const patch = applyItemChoice(draft({ itemKey: "", itemName: "", unitPrice: "" }), "brownies::fmt", MENU);

  assert.equal(patch.itemKey, "brownies::fmt");
  assert.equal(patch.itemName, "Brownies — Box of 6");
  assert.equal(patch.unitPrice, "480");
});

test("switching a catalog pick to Custom clears the catalog name and keeps the typed price", () => {
  const patch = applyItemChoice(draft({ itemKey: "brownies::fmt", itemName: "Brownies — Box of 6", unitPrice: "450" }), CUSTOM_ITEM_KEY, MENU);

  assert.equal(patch.itemKey, CUSTOM_ITEM_KEY);
  assert.equal(patch.itemName, "");
  assert.equal(patch.unitPrice, "450");
});

test("re-selecting Custom on an already-custom row keeps what the operator typed", () => {
  const patch = applyItemChoice(draft({ itemKey: CUSTOM_ITEM_KEY, itemName: "Delivery", unitPrice: "60" }), CUSTOM_ITEM_KEY, MENU);

  assert.equal(patch.itemName, "Delivery");
  assert.equal(patch.unitPrice, "60");
});

test("a picked catalog row submits through buildLinesFromDrafts with the format's snapshots", () => {
  const patch = applyItemChoice(draft({ itemKey: "", itemName: "", unitPrice: "" }), "brownies::fmt", MENU);
  const lines = buildLinesFromDrafts([draft({ ...patch, quantity: "2" }), draft({ itemKey: CUSTOM_ITEM_KEY, itemName: "Delivery", unitPrice: "60" })], MENU, "order-1");

  assert.equal(lines[0].sellingFormatId, "fmt");
  assert.equal(lines[0].unitPrice, 480);
  assert.equal(lines[0].piecesPerUnitSnapshot, 6);
  assert.equal(lines[1].productId, "");
  assert.equal(lines[1].piecesPerUnitSnapshot, null);
});

test("the New order form shows the empty-catalog message, keeps Custom item, and links to Costing", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../src/components/orders-page.tsx", import.meta.url), "utf8");

  assert.match(source, /No orderable products are set up yet\./);
  assert.match(source, /<option value=\{CUSTOM_ITEM_KEY\}>Custom item…<\/option>/);
  assert.match(source, /getSellableOptionLabel\(option\)/);
  assert.match(source, /href="\/costing"/);
});

// --- Quantity control ----------------------------------------------------------------------------

test("+ increments the quantity, and lands on 1 from an empty or invalid entry", () => {
  assert.equal(stepQuantity("1", 1), "2");
  assert.equal(stepQuantity("9", 1), "10");
  assert.equal(stepQuantity("", 1), "1");
  assert.equal(stepQuantity("2.5", 1), "1");
});

test("- decrements but never goes below 1", () => {
  assert.equal(stepQuantity("3", -1), "2");
  assert.equal(stepQuantity("2", -1), "1");
  assert.equal(stepQuantity("1", -1), "1");
  assert.equal(stepQuantity("", -1), "1");
  assert.equal(stepQuantity("0", -1), "1");
});

test("typing keeps whole numbers only, and leaving the field settles an invalid entry to 1", () => {
  assert.equal(sanitizeQuantityInput("12"), "12");
  assert.equal(sanitizeQuantityInput("2.5"), "25");
  assert.equal(sanitizeQuantityInput("-3"), "3");
  assert.equal(sanitizeQuantityInput(""), "");
  assert.equal(settleQuantity("7"), "7");
  assert.equal(settleQuantity(""), "1");
  assert.equal(settleQuantity("0"), "1");
});

test("the piece helper multiplies selling units by pieces per unit, and shows nothing it cannot back", () => {
  assert.equal(describePieceCount("2", 1), "2 pcs total");
  assert.equal(describePieceCount("1", 1), "1 pc total");
  assert.equal(describePieceCount("2", 2), "2 × 2 pcs = 4 pcs");
  assert.equal(describePieceCount("3", 2), "3 × 2 pcs = 6 pcs");
  assert.equal(describePieceCount("", 2), null);
  assert.equal(describePieceCount("0", 2), null);
  assert.equal(describePieceCount("2", 0), null);
});

test("quantity stays in selling units: the line, the total and the pieces snapshot are unchanged by the stepper", () => {
  const twoBrownies = getSellableItems([BROWNIES], [BATCH_V2], [COSTING_V2], [format("fmt-2", "costing-v2", "2 brownies", { piecesPerUnit: 2, sellingPrice: 170 })]);

  const lines = buildLinesFromDrafts([draft({ itemKey: "brownies::fmt-2", unitPrice: "170", quantity: "2" })], twoBrownies, "order-1");

  // One line, not two; quantity is the number of "2 brownies" units sold.
  assert.equal(lines.length, 1);
  assert.equal(lines[0].quantity, 2);
  assert.equal(lines[0].piecesPerUnitSnapshot, 2);
  // Total is quantity x unit price: 2 x PHP 170 = PHP 340.
  assert.equal(getOrderTotals(lines).total, 340);
  // Pieces to prepare are derived from the snapshot: 2 units x 2 pcs = 4 pcs.
  assert.equal(getPreparationTotals(lines).pieces, 4);
  assert.equal(getPreparationTotals(lines).units, 2);
});

test("a single-piece format totals quantity x price and prepares that many pieces", () => {
  const cookie = getSellableItems([BROWNIES], [BATCH_V2], [COSTING_V2], [format("fmt-c", "costing-v2", "Single cookie", { piecesPerUnit: 1, sellingPrice: 100 })]);
  const lines = buildLinesFromDrafts([draft({ itemKey: "brownies::fmt-c", unitPrice: "100", quantity: "2" })], cookie, "order-1");

  assert.equal(getOrderTotals(lines).total, 200);
  assert.equal(getPreparationTotals(lines).pieces, 2);
});

test("the quantity control is a stepper with buttons and a text input, not the native number spinner", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../src/components/orders-page.tsx", import.meta.url), "utf8");

  assert.match(source, /aria-label="Decrease quantity"/);
  assert.match(source, /aria-label="Increase quantity"/);
  assert.match(source, /inputMode="numeric"/);
  assert.match(source, /describePieceCount\(line\.quantity, item\.piecesPerUnit\)/);
  // The Qty input is no longer type=number.
  assert.doesNotMatch(source, /step=\{1\} type="number"/);
});

// --- Wiring --------------------------------------------------------------------------------------

test("Orders is registered as a nav entry at /orders, in Operations right after Dashboard", () => {
  const labels = navItems.map((item) => item.label);
  const orders = navItems.find((item) => item.view === ("orders" satisfies LabView));

  assert.ok(orders, "Orders is missing from navItems");
  assert.equal(orders?.href, "/orders");
  assert.equal(orders?.label, "Orders");
  // Orders is the second Operations destination. (It used to sit after Costing among the money pages;
  // the navigation calm-down slice regrouped the sidebar by daily use.)
  assert.equal(orders?.group, "operations");
  assert.equal(labels.indexOf("Orders"), labels.indexOf("Dashboard") + 1);
});
