// Orders list presentation: search, compact item summary, quiet source, payment tag, placed vs
// handover time, and the detail column only existing when there is a selection. All of it reads
// fields already loaded -- nothing here may decide a status, payment, total or stock movement.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { filterOrdersBySearch, formatOrderItemSummary, getOrderCardSource, getOrderCardTimes, getOrdersLayoutClass, getPaymentTone } from "../src/lib/orders/list-view.ts";
import { filterOrdersByFulfillment } from "../src/lib/orders/fulfillment.ts";
import type { Order, OrderLine } from "../src/lib/orders/types.ts";

function order(overrides: Partial<Order> = {}): Order {
  return {
    id: "order-1",
    customerId: "cust-1",
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
    ...overrides,
  };
}

function line(orderId: string, itemName: string, quantity: number, sortOrder = 0): OrderLine {
  return { id: `${orderId}-${sortOrder}`, orderId, productId: "", sellingFormatId: "", itemName, unitPrice: 100, piecesPerUnitSnapshot: null, quantity, sortOrder, note: "" };
}

const MARIA = order({ id: "aaaa1111-order", customerId: "cust-maria", placedAt: "2026-08-01T01:00:00.000Z" });
const JUAN = order({ id: "bbbb2222-order", customerId: "cust-juan", fulfillmentAt: "2026-08-20T02:00:00.000Z" });
const ORDERS = [MARIA, JUAN];
const LINES = new Map<string, OrderLine[]>([
  [MARIA.id, [line(MARIA.id, "2 brownies", 1)]],
  [JUAN.id, [line(JUAN.id, "Single cookie", 2)]],
]);
const NAMES = new Map([["cust-maria", "Maria Santos"], ["cust-juan", "Juan Dela Cruz"]]);

function search(query: string, orders: Order[] = ORDERS) {
  return filterOrdersBySearch(orders, { query, linesByOrderId: LINES, customerNameById: NAMES }).map((entry) => entry.id);
}

// --- Search ---------------------------------------------------------------------------------------

test("search finds an order by customer name", () => {
  assert.deepEqual(search("maria"), [MARIA.id]);
});

test("search finds an order by an item-name snapshot", () => {
  assert.deepEqual(search("cookie"), [JUAN.id]);
  assert.deepEqual(search("2 brownies"), [MARIA.id]);
});

test("search finds an order by order id", () => {
  assert.deepEqual(search("bbbb2222"), [JUAN.id]);
});

test("search is case-insensitive", () => {
  assert.deepEqual(search("MARIA SANTOS"), [MARIA.id]);
  assert.deepEqual(search("SINGLE COOKIE"), [JUAN.id]);
  assert.deepEqual(search("AAAA1111"), [MARIA.id]);
});

test("search composes with the fulfilment filter instead of replacing it", () => {
  // "unscheduled" keeps only MARIA (no handover time); a query that matches JUAN then finds nothing.
  const unscheduled = filterOrdersByFulfillment(ORDERS, "unscheduled", { nowMs: Date.parse("2026-08-10T00:00:00.000Z"), timeZone: "Asia/Manila" });
  assert.deepEqual(unscheduled.map((entry) => entry.id), [MARIA.id]);
  assert.deepEqual(search("cookie", unscheduled), []);
  assert.deepEqual(search("brownies", unscheduled), [MARIA.id]);
});

test("an empty or whitespace search returns the same list untouched", () => {
  assert.equal(filterOrdersBySearch(ORDERS, { query: "", linesByOrderId: LINES, customerNameById: NAMES }), ORDERS);
  assert.equal(filterOrdersBySearch(ORDERS, { query: "   ", linesByOrderId: LINES, customerNameById: NAMES }), ORDERS);
});

test("a search that matches nothing returns an empty list, and an order with no lines or customer is still searchable by id", () => {
  assert.deepEqual(search("zzz"), []);
  const orphan = order({ id: "cccc3333-order", customerId: "gone" });
  assert.deepEqual(search("cccc3333", [orphan]), ["cccc3333-order"]);
});

// --- Item summary ---------------------------------------------------------------------------------

test("item summary: one line, two lines, and 3+ lines collapse to the first two plus '+N more'", () => {
  assert.equal(formatOrderItemSummary([line("o", "2 brownies", 1)]), "2 brownies × 1");
  assert.equal(formatOrderItemSummary([line("o", "2 brownies", 1, 0), line("o", "Single cookie", 2, 1)]), "2 brownies × 1 · Single cookie × 2");
  assert.equal(
    formatOrderItemSummary([line("o", "A", 1, 0), line("o", "B", 2, 1), line("o", "C", 3, 2), line("o", "D", 4, 3)]),
    "A × 1 · B × 2 · +2 more",
  );
  assert.equal(formatOrderItemSummary([line("o", "A", 1, 0), line("o", "B", 2, 1), line("o", "C", 3, 2)]), "A × 1 · B × 2 · +1 more");
});

test("item summary uses the line snapshot and follows line sort order", () => {
  assert.equal(formatOrderItemSummary([line("o", "Second", 1, 1), line("o", "First", 1, 0)]), "First × 1 · Second × 1");
  assert.equal(formatOrderItemSummary([]), "No items");
});

// --- Source, payment, timestamps -------------------------------------------------------------------

test("an unknown source shows nothing on the card, with or without a reference", () => {
  assert.equal(getOrderCardSource({ source: "unknown" }), null);
  // The reference is detailed attribution, not card metadata: it is not surfaced on its own either.
  const withRef = order({ source: "unknown", sourceRef: "chatgpt-order-batch-2026-09-18-01" });
  assert.equal(getOrderCardSource(withRef), null);
});

test("a known source shows its label only, never the reference", () => {
  const withRef = order({ source: "instagram", sourceRef: "@maria" });
  assert.equal(getOrderCardSource(withRef), "Instagram");
  assert.equal(getOrderCardSource({ source: "facebook" }), "Facebook");
  assert.equal(getOrderCardSource({ source: "tiktok" }), "TikTok");
  assert.equal(getOrderCardSource({ source: "referral" }), "Referral");
  assert.equal(String(getOrderCardSource(withRef)).includes("@maria"), false);
});

test("the card never renders sourceRef, while the detail panel keeps the full attribution", () => {
  const source = readFileSync(new URL("../src/components/orders-page.tsx", import.meta.url), "utf8");
  const detailAt = source.indexOf("function OrderDetailPanel(");
  const cardStart = source.indexOf("{visibleOrders.map((order) => {");
  const card = source.slice(cardStart, source.indexOf("</button>", cardStart));
  const detail = source.slice(detailAt);

  assert.equal(cardStart > -1 && card.length > 0, true, "precondition: card block located");
  assert.equal(card.includes("sourceRef"), false, "the compact card must not touch sourceRef");
  assert.match(detail, /sourceLabel\(order\.source\)\}\{order\.sourceRef \? ` · \$\{order\.sourceRef\}` : ""\}/);
});

test("payment tone comes from paymentStatus alone, whatever the lifecycle status", () => {
  assert.equal(getPaymentTone("paid"), "green");
  assert.equal(getPaymentTone("refunded"), "danger");
  assert.equal(getPaymentTone("unpaid"), "warm");
  // The card feeds order.paymentStatus in, not order.status: a completed order can still be unpaid.
  const completedUnpaid = order({ status: "completed", paymentStatus: "unpaid" });
  assert.equal(getPaymentTone(completedUnpaid.paymentStatus), "warm");
});

test("the placed time is placedAt, and the handover time is separate and only present when scheduled", () => {
  const scheduled = order({ placedAt: "2026-08-01T01:00:00.000Z", fulfillmentAt: "2026-08-20T02:00:00.000Z" });
  assert.deepEqual(getOrderCardTimes(scheduled), { placed: "2026-08-01T01:00:00.000Z", handover: "2026-08-20T02:00:00.000Z" });

  assert.equal(getOrderCardTimes(order({ fulfillmentAt: null })).handover, null);
  assert.equal(getOrderCardTimes(order({ fulfillmentAt: "" })).handover, null);
  // placedAt is never replaced by the handover time, scheduled or not.
  assert.equal(getOrderCardTimes(order({ placedAt: "2026-08-01T01:00:00.000Z", fulfillmentAt: null })).placed, "2026-08-01T01:00:00.000Z");
});

// --- Layout and wiring -----------------------------------------------------------------------------

test("with nothing selected the list has no second column; with a selection it does", () => {
  assert.equal(getOrdersLayoutClass(false).includes("420px"), false);
  assert.equal(getOrdersLayoutClass(true).includes("xl:grid-cols-[minmax(0,1fr)_420px]"), true);
});

test("the page renders OrderDetailPanel only when an order is selected, and no permanent 420px column", () => {
  const source = readFileSync(new URL("../src/components/orders-page.tsx", import.meta.url), "utf8");

  assert.match(source, /\{selectedOrder \? \(\s*<div className="min-w-0" ref=\{detailRef\}>\s*<OrderDetailPanel/);
  assert.equal(source.includes("xl:grid-cols-[1fr_420px]"), false);
  assert.match(source, /getOrdersLayoutClass\(selectedOrder !== null\)/);
  // Click-to-select is unchanged and nothing auto-selects.
  assert.match(source, /onClick=\{\(\) => setSelectedOrderId\(order\.id\)\}/);
  assert.match(source, /useState<string \| null>\(null\)/);
});

test("the list drops the source-count line and the per-card 'Unknown source', and shows payment and placed time", () => {
  const source = readFileSync(new URL("../src/components/orders-page.tsx", import.meta.url), "utf8");

  assert.equal(source.includes("getOrderCountsBySource"), false);
  assert.equal(source.includes("sourceCounts"), false);
  assert.match(source, /getPaymentTone\(order\.paymentStatus\)/);
  assert.match(source, /Placed \{formatWhen\(times\.placed\)\}/);
  assert.match(source, /No orders match this search\./);
  assert.match(source, /type="search"/);
});
