import test from "node:test";
import assert from "node:assert/strict";
import { getOrderTotals, getPaymentDivergence } from "../src/lib/orders/totals.ts";
import type { Order, OrderLine } from "../src/lib/orders/types.ts";

function line(overrides: Partial<OrderLine> = {}): OrderLine {
  return {
    id: "line-1",
    orderId: "order-1",
    productId: "brownies",
    sellingFormatId: "format-1",
    itemName: "Brownies, Box of 6",
    unitPrice: 480,
    piecesPerUnitSnapshot: 6,
    quantity: 1,
    sortOrder: 0,
    note: "",
    ...overrides,
  };
}

function orderWith(overrides: Partial<Order> = {}): Order {
  return {
    id: "order-1",
    customerId: "customer-1",
    status: "confirmed",
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
    placedAt: "2026-08-09T02:00:00.000Z",
    completedAt: null,
    cancelledAt: null,
    cancelReason: "",
    createdAt: "2026-08-09T02:00:00.000Z",
    updatedAt: "2026-08-09T02:00:00.000Z",
    ...overrides,
  };
}

test("getOrderTotals over zero lines is a real zero, not an error", () => {
  assert.deepEqual(getOrderTotals([]), { total: 0, lineCount: 0, unitCount: 0 });
});

test("getOrderTotals multiplies unit price by quantity per line and sums", () => {
  const totals = getOrderTotals([line({ unitPrice: 480, quantity: 2 }), line({ id: "line-2", unitPrice: 60, quantity: 3 })]);

  assert.equal(totals.total, 480 * 2 + 60 * 3);
  assert.equal(totals.lineCount, 2);
  assert.equal(totals.unitCount, 5);
});

test("a zero-priced line is a real zero, not a missing value", () => {
  // A free sample recorded on an order is a legitimate fact.
  const totals = getOrderTotals([line({ unitPrice: 0, quantity: 2 })]);
  assert.equal(totals.total, 0);
  assert.equal(totals.unitCount, 2);
  assert.equal(totals.lineCount, 1);
});

test("full precision is preserved -- no rounding before the final format", () => {
  // Sub-centavo unit prices are real (the same reason unit_cost_snapshot is stored unrounded).
  const totals = getOrderTotals([line({ unitPrice: 0.275, quantity: 1000 })]);
  assert.equal(totals.total, 275);
});

test("getOrderTotals never mutates its input", () => {
  const lines = [line({ unitPrice: 480, quantity: 2 })];
  const frozen = JSON.stringify(lines);
  getOrderTotals(lines);
  assert.equal(JSON.stringify(lines), frozen);
});

test("getPaymentDivergence reports not-paid when no payment is recorded", () => {
  assert.deepEqual(getPaymentDivergence(orderWith(), [line({ unitPrice: 480 })]), { state: "not-paid" });
});

test("getPaymentDivergence reports the difference and its sign", () => {
  const paid = orderWith({ paymentStatus: "paid", paidAt: "2026-08-09T06:00:00.000Z", paidAmount: 480 });

  // Order grew after payment: positive difference, more is now owed.
  const grew = getPaymentDivergence(paid, [line({ unitPrice: 540 })]);
  assert.equal(grew.state, "diverged");
  if (grew.state !== "diverged") return;
  assert.equal(grew.difference, 60);

  // Order shrank after payment: negative difference, the customer overpaid.
  const shrank = getPaymentDivergence(paid, [line({ unitPrice: 400 })]);
  assert.equal(shrank.state, "diverged");
  if (shrank.state !== "diverged") return;
  assert.equal(shrank.difference, -80);
});

test("getPaymentDivergence reports matched when the frozen amount still equals the total", () => {
  const paid = orderWith({ paymentStatus: "paid", paidAt: "2026-08-09T06:00:00.000Z", paidAmount: 480 });
  const matched = getPaymentDivergence(paid, [line({ unitPrice: 480, quantity: 1 })]);

  assert.equal(matched.state, "matched");
  if (matched.state !== "matched") return;
  assert.equal(matched.paidAmount, 480);
  assert.equal(matched.currentTotal, 480);
});

test("a zero paid_amount is still a payment, not a not-paid state", () => {
  const free = orderWith({ paymentStatus: "paid", paidAt: "2026-08-09T06:00:00.000Z", paidAmount: 0 });
  const divergence = getPaymentDivergence(free, [line({ unitPrice: 0 })]);
  assert.equal(divergence.state, "matched");
});
