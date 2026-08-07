// Row -> domain -> payload round trips, with null preservation as the headline case.
//
// The reason this file is dense about nulls: docs/DATA_MODEL.md documents the app's existing
// "nullable columns flatten to ''/0" convention, and the Business Context Builder design documents
// why that is dangerous here. Once a null paid_amount has become 0, "no payment" and "a payment of
// zero" are indistinguishable forever, and revenue sums the result.

import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCustomerPayload,
  buildOrderLinePayload,
  buildOrderPayload,
  getRemovedOrderLineIds,
  mapCustomerRow,
  mapOrderLineRow,
  mapOrderRow,
} from "../src/lib/orders/mappers.ts";
import type { Customer, Order, OrderLine, OrderLineRow, OrderRow } from "../src/lib/orders/types.ts";

const NOW = "2026-08-09T06:00:00.000Z";

function baseOrderRow(overrides: Partial<OrderRow> = {}): OrderRow {
  return {
    id: "order-1",
    customer_id: "customer-1",
    status: "new",
    payment_status: "unpaid",
    payment_method: null,
    paid_at: null,
    paid_amount: null,
    refunded_at: null,
    fulfillment_method: "pickup",
    fulfillment_at: null,
    fulfillment_address: null,
    fulfillment_notes: null,
    source: "instagram",
    source_ref: null,
    entry_method: "manual",
    notes: null,
    placed_at: "2026-08-09T02:00:00.000Z",
    completed_at: null,
    cancelled_at: null,
    cancel_reason: null,
    created_at: "2026-08-09T02:00:00.000Z",
    updated_at: "2026-08-09T02:00:00.000Z",
    ...overrides,
  };
}

function baseLineRow(overrides: Partial<OrderLineRow> = {}): OrderLineRow {
  return {
    id: "line-1",
    order_id: "order-1",
    product_id: "brownies",
    selling_format_id: "format-1",
    item_name: "Brownies, Box of 6",
    unit_price: 480,
    pieces_per_unit_snapshot: 6,
    quantity: 1,
    sort_order: 0,
    note: null,
    ...overrides,
  };
}

// --- Null preservation ------------------------------------------------------------------------

test("mapOrderRow: a null paid_amount stays null and never becomes 0", () => {
  const order = mapOrderRow(baseOrderRow({ paid_amount: null }));
  assert.equal(order.paidAmount, null);
  assert.notEqual(order.paidAmount, 0);
});

test("mapOrderRow: a real zero paid_amount is preserved as 0, distinct from null", () => {
  // A genuinely free order that was "paid" for zero is a real fact, and must not read as unpaid.
  const order = mapOrderRow(baseOrderRow({ payment_status: "paid", paid_at: NOW, paid_amount: 0 }));
  assert.equal(order.paidAmount, 0);
  assert.notEqual(order.paidAmount, null);
});

test("mapOrderLineRow: a null pieces_per_unit_snapshot stays null, never 1 and never 0", () => {
  const line = mapOrderLineRow(baseLineRow({ pieces_per_unit_snapshot: null }));
  assert.equal(line.piecesPerUnitSnapshot, null);
  assert.notEqual(line.piecesPerUnitSnapshot, 1);
  assert.notEqual(line.piecesPerUnitSnapshot, 0);
});

test("mapOrderRow: paid_at and refunded_at stay null rather than becoming empty strings", () => {
  const order = mapOrderRow(baseOrderRow());
  assert.equal(order.paidAt, null);
  assert.equal(order.refundedAt, null);
  assert.equal(order.completedAt, null);
  assert.equal(order.cancelledAt, null);
});

test("numeric columns arriving as strings are parsed, not stringified", () => {
  // PostgREST returns numeric as a string when precision demands it.
  const line = mapOrderLineRow(baseLineRow({ unit_price: "480.50", pieces_per_unit_snapshot: "6", quantity: "2" }));
  assert.equal(line.unitPrice, 480.5);
  assert.equal(line.piecesPerUnitSnapshot, 6);
  assert.equal(line.quantity, 2);

  const order = mapOrderRow(baseOrderRow({ payment_status: "paid", paid_at: NOW, paid_amount: "961.00" }));
  assert.equal(order.paidAmount, 961);
});

// --- Union narrowing --------------------------------------------------------------------------

test("an unrecognized classification value degrades to the safest member rather than throwing", () => {
  // These columns carry no CHECK constraint, so the database cannot guarantee membership.
  const order = mapOrderRow(
    baseOrderRow({ status: "banana", payment_status: "sideways", fulfillment_method: "teleport", source: "carrier-pigeon", entry_method: "telepathy" }),
  );
  assert.equal(order.status, "new");
  assert.equal(order.paymentStatus, "unpaid");
  assert.equal(order.fulfillmentMethod, "pickup");
  assert.equal(order.source, "unknown");
  assert.equal(order.entryMethod, "manual");
});

test("an unrecognized payment_method becomes null rather than a bogus member", () => {
  const order = mapOrderRow(baseOrderRow({ payment_method: "chickens" }));
  assert.equal(order.paymentMethod, null);
});

test("a recognized source is preserved exactly", () => {
  assert.equal(mapOrderRow(baseOrderRow({ source: "instagram" })).source, "instagram");
  assert.equal(mapOrderRow(baseOrderRow({ source: "referral" })).source, "referral");
});

// --- Catalog pointers -------------------------------------------------------------------------

test("mapOrderLineRow: null catalog pointers become empty strings, matching the manual-line convention", () => {
  const line = mapOrderLineRow(baseLineRow({ product_id: null, selling_format_id: null, pieces_per_unit_snapshot: null }));
  assert.equal(line.productId, "");
  assert.equal(line.sellingFormatId, "");
  // The pieces snapshot is the one field that stays null -- "" would be a lie about a number.
  assert.equal(line.piecesPerUnitSnapshot, null);
});

test("buildOrderLinePayload: empty catalog ids become null so the foreign keys accept them", () => {
  const payload = buildOrderLinePayload({
    id: "line-1",
    orderId: "order-1",
    productId: "",
    sellingFormatId: "",
    itemName: "Delivery",
    unitPrice: 60,
    piecesPerUnitSnapshot: null,
    quantity: 1,
    sortOrder: 0,
    note: "",
  });

  assert.equal(payload.product_id, null);
  assert.equal(payload.selling_format_id, null);
  assert.equal(payload.pieces_per_unit_snapshot, null);
  assert.equal(payload.note, null);
});

// --- updated_at -------------------------------------------------------------------------------

test("buildOrderPayload writes updated_at explicitly", () => {
  // No trigger maintains updated_at anywhere in this schema (Business Context Builder M1 finding
  // F1). A payload builder that omits it leaves the column frozen at insert time.
  const order = mapOrderRow(baseOrderRow());
  const payload = buildOrderPayload(order, NOW);
  assert.equal(payload.updated_at, NOW);
});

test("buildCustomerPayload writes updated_at explicitly", () => {
  const customer = mapCustomerRow({
    id: "customer-1",
    name: "Maria Santos",
    phone: null,
    messaging_handle: null,
    email: null,
    notes: null,
    created_at: NOW,
    updated_at: NOW,
  });
  const payload = buildCustomerPayload(customer, "2026-08-10T00:00:00.000Z");
  assert.equal(payload.updated_at, "2026-08-10T00:00:00.000Z");
});

test("buildOrderPayload passes paid_amount through unchanged, including null", () => {
  const unpaid = mapOrderRow(baseOrderRow());
  assert.equal(buildOrderPayload(unpaid, NOW).paid_amount, null);

  const paid = mapOrderRow(baseOrderRow({ payment_status: "paid", paid_at: NOW, paid_amount: 480 }));
  assert.equal(buildOrderPayload(paid, NOW).paid_amount, 480);
});

// --- Round trip -------------------------------------------------------------------------------

test("order row -> domain -> payload round trips every meaningful field", () => {
  const row = baseOrderRow({
    status: "confirmed",
    payment_status: "paid",
    payment_method: "gcash",
    paid_at: NOW,
    paid_amount: 480,
    fulfillment_method: "delivery",
    fulfillment_at: "2026-08-10T06:00:00.000Z",
    fulfillment_address: "12 Mabini St",
    source: "messenger",
    source_ref: "POST-184",
    notes: "no nuts",
  });

  const payload = buildOrderPayload(mapOrderRow(row), NOW);

  assert.equal(payload.id, "order-1");
  assert.equal(payload.customer_id, "customer-1");
  assert.equal(payload.status, "confirmed");
  assert.equal(payload.payment_status, "paid");
  assert.equal(payload.payment_method, "gcash");
  assert.equal(payload.paid_at, NOW);
  assert.equal(payload.paid_amount, 480);
  assert.equal(payload.fulfillment_method, "delivery");
  assert.equal(payload.fulfillment_address, "12 Mabini St");
  assert.equal(payload.source, "messenger");
  // Opaque and never parsed -- it must survive the round trip byte for byte.
  assert.equal(payload.source_ref, "POST-184");
  assert.equal(payload.entry_method, "manual");
  assert.equal(payload.notes, "no nuts");
});

test("line row -> domain -> payload round trips the three snapshots", () => {
  const payload = buildOrderLinePayload(mapOrderLineRow(baseLineRow({ unit_price: "480.125", quantity: 2, pieces_per_unit_snapshot: 6 })));

  assert.equal(payload.item_name, "Brownies, Box of 6");
  // Full precision, never rounded before storing.
  assert.equal(payload.unit_price, 480.125);
  assert.equal(payload.pieces_per_unit_snapshot, 6);
  assert.equal(payload.quantity, 2);
});

// --- Removed line reconciliation ---------------------------------------------------------------

test("getRemovedOrderLineIds returns exactly what disappeared", () => {
  const existing: OrderLine[] = [
    mapOrderLineRow(baseLineRow({ id: "line-1" })),
    mapOrderLineRow(baseLineRow({ id: "line-2" })),
    mapOrderLineRow(baseLineRow({ id: "line-3" })),
  ];

  assert.deepEqual(getRemovedOrderLineIds(existing, ["line-1", "line-3"]), ["line-2"]);
  assert.deepEqual(getRemovedOrderLineIds(existing, ["line-1", "line-2", "line-3"]), []);
  assert.deepEqual(getRemovedOrderLineIds(existing, []), ["line-1", "line-2", "line-3"]);
});

test("getRemovedOrderLineIds ignores submitted ids that never existed", () => {
  // A brand-new line is upserted, not "removed" -- this function only answers what disappeared.
  const existing: OrderLine[] = [mapOrderLineRow(baseLineRow({ id: "line-1" }))];
  assert.deepEqual(getRemovedOrderLineIds(existing, ["line-1", "line-brand-new"]), []);
});

test("mappers are pure: mapping the same row twice yields equal results and mutates nothing", () => {
  const row = baseOrderRow({ payment_status: "paid", paid_at: NOW, paid_amount: 480 });
  const frozen = JSON.stringify(row);

  const first: Order = mapOrderRow(row);
  const second: Order = mapOrderRow(row);

  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(row), frozen, "mapOrderRow must not mutate its input");
});

test("customer mapping keeps optional fields as empty strings, never undefined", () => {
  const customer: Customer = mapCustomerRow({
    id: "customer-1",
    name: "Ana Cruz",
    phone: null,
    messaging_handle: null,
    email: null,
    notes: null,
    created_at: null,
    updated_at: null,
  });

  assert.equal(customer.phone, "");
  assert.equal(customer.messagingHandle, "");
  assert.equal(customer.email, "");
  assert.equal(customer.notes, "");
});
