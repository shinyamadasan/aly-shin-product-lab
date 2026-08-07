// The payment state machine, and the frozen-amount guarantee that makes revenue trustworthy.
//
// The correction/refund distinction is the thing this file exists to protect. A REFUND means the
// recorded fact was true and was later reversed -- history is preserved. A CORRECTION means the
// recorded fact was false -- history is rewritten, because it should never have said what it said.

import test from "node:test";
import assert from "node:assert/strict";
import { applyPaymentCorrection, applyPaymentReceived, applyRefund, isValidPaymentTransition } from "../src/lib/orders/transitions.ts";
import { getPaymentDivergence } from "../src/lib/orders/totals.ts";
import { validatePaymentFields } from "../src/lib/orders/validation.ts";
import { PAYMENT_STATUSES, type Order, type OrderLine, type PaymentStatus } from "../src/lib/orders/types.ts";

const PAID_AT = "2026-08-09T06:00:00.000Z";
const LATER = "2026-09-01T06:00:00.000Z";

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

const EXPECTED_ALLOWED: Record<PaymentStatus, PaymentStatus[]> = {
  unpaid: ["paid"],
  paid: ["refunded", "unpaid"],
  refunded: [],
};

test("the full payment transition matrix matches the approved machine", () => {
  for (const from of PAYMENT_STATUSES) {
    for (const to of PAYMENT_STATUSES) {
      const expected = EXPECTED_ALLOWED[from].includes(to);
      assert.equal(isValidPaymentTransition(from, to), expected, `${from} -> ${to} should be ${expected ? "allowed" : "prohibited"}`);
    }
  }
});

test("unpaid -> refunded is prohibited: there is nothing to refund", () => {
  assert.equal(isValidPaymentTransition("unpaid", "refunded"), false);

  const result = applyRefund(orderWith(), PAID_AT);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.message, /never paid/i);
});

test("refunded is terminal", () => {
  for (const to of PAYMENT_STATUSES) {
    assert.equal(isValidPaymentTransition("refunded", to), false);
  }
});

// --- Freezing the amount ------------------------------------------------------------------------

test("unpaid -> paid freezes paid_at, paid_amount and the method together", () => {
  const lines = [line({ unitPrice: 480, quantity: 1 }), line({ id: "line-2", unitPrice: 60, quantity: 1, itemName: "Delivery" })];

  const result = applyPaymentReceived(orderWith(), lines, "gcash", PAID_AT);
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.order.paymentStatus, "paid");
  assert.equal(result.order.paymentMethod, "gcash");
  assert.equal(result.order.paidAt, PAID_AT);
  // The order's total at this instant, frozen. This is the single moment revenue is created.
  assert.equal(result.order.paidAmount, 540);
});

test("editing lines after payment does not change paid_amount", () => {
  // The headline guarantee: a changed order total is not evidence that money moved.
  const paid = applyPaymentReceived(orderWith(), [line({ unitPrice: 480, quantity: 1 })], "gcash", PAID_AT);
  assert.equal(paid.ok, true);
  if (!paid.ok) return;

  const frozenAmount = paid.order.paidAmount;
  assert.equal(frozenAmount, 480);

  // The operator adds an item afterwards. Nothing in the payment fields may move.
  const editedLines = [line({ unitPrice: 480, quantity: 1 }), line({ id: "line-2", unitPrice: 60, itemName: "Delivery" })];
  const divergence = getPaymentDivergence(paid.order, editedLines);

  assert.equal(paid.order.paidAmount, frozenAmount, "paid_amount must not move when lines change");
  assert.equal(paid.order.paidAt, PAID_AT);
  assert.equal(divergence.state, "diverged");
  if (divergence.state !== "diverged") return;
  assert.equal(divergence.paidAmount, 480);
  assert.equal(divergence.currentTotal, 540);
  assert.equal(divergence.difference, 60);
});

test("getPaymentDivergence is read-only -- it reports, it never reconciles", () => {
  const paid = applyPaymentReceived(orderWith(), [line({ unitPrice: 480 })], "cash", PAID_AT);
  assert.equal(paid.ok, true);
  if (!paid.ok) return;

  const frozen = JSON.stringify(paid.order);
  getPaymentDivergence(paid.order, [line({ unitPrice: 999 })]);
  assert.equal(JSON.stringify(paid.order), frozen, "reporting a divergence must not mutate the order");
});

test("getPaymentDivergence distinguishes not-paid from a zero difference", () => {
  const unpaid = getPaymentDivergence(orderWith(), [line({ unitPrice: 480 })]);
  assert.equal(unpaid.state, "not-paid");

  const paid = applyPaymentReceived(orderWith(), [line({ unitPrice: 480 })], "cash", PAID_AT);
  assert.equal(paid.ok, true);
  if (!paid.ok) return;
  const matched = getPaymentDivergence(paid.order, [line({ unitPrice: 480 })]);
  assert.equal(matched.state, "matched");
});

// --- Refund vs correction -----------------------------------------------------------------------

test("paid -> refunded sets refunded_at and RETAINS paid_at and paid_amount", () => {
  const paid = applyPaymentReceived(orderWith(), [line({ unitPrice: 480 })], "gcash", PAID_AT);
  assert.equal(paid.ok, true);
  if (!paid.ok) return;

  const refunded = applyRefund(paid.order, LATER);
  assert.equal(refunded.ok, true);
  if (!refunded.ok) return;

  assert.equal(refunded.order.paymentStatus, "refunded");
  assert.equal(refunded.order.refundedAt, LATER);
  // Both retained: paid_at keeps an earlier period's gross immutable, and paid_amount is the
  // figure the refund total sums. The database enforces this too.
  assert.equal(refunded.order.paidAt, PAID_AT);
  assert.equal(refunded.order.paidAmount, 480);
});

test("paid -> unpaid is a correction and clears all three payment facts together", () => {
  const paid = applyPaymentReceived(orderWith(), [line({ unitPrice: 480 })], "gcash", PAID_AT);
  assert.equal(paid.ok, true);
  if (!paid.ok) return;

  const corrected = applyPaymentCorrection(paid.order, LATER);
  assert.equal(corrected.ok, true);
  if (!corrected.ok) return;

  assert.equal(corrected.order.paymentStatus, "unpaid");
  assert.equal(corrected.order.paidAt, null);
  assert.equal(corrected.order.paidAmount, null);
  assert.equal(corrected.order.paymentMethod, null);
  // A correction is not a refund: no refund date is invented.
  assert.equal(corrected.order.refundedAt, null);
});

test("a refunded order cannot then be corrected to unpaid", () => {
  const paid = applyPaymentReceived(orderWith(), [line({ unitPrice: 480 })], "cash", PAID_AT);
  assert.equal(paid.ok, true);
  if (!paid.ok) return;
  const refunded = applyRefund(paid.order, LATER);
  assert.equal(refunded.ok, true);
  if (!refunded.ok) return;

  const result = applyPaymentCorrection(refunded.order, LATER);
  assert.equal(result.ok, false);
});

test("marking an already-paid order paid again is rejected", () => {
  const paid = applyPaymentReceived(orderWith(), [line()], "cash", PAID_AT);
  assert.equal(paid.ok, true);
  if (!paid.ok) return;

  const again = applyPaymentReceived(paid.order, [line()], "gcash", LATER);
  assert.equal(again.ok, false);
  if (again.ok) return;
  assert.match(again.message, /already marked paid/i);
});

// --- The money invariants, application side -----------------------------------------------------

test("validatePaymentFields rejects a paid order missing its date or amount", () => {
  assert.notEqual(validatePaymentFields(orderWith({ paymentStatus: "paid", paidAt: PAID_AT, paidAmount: null })), null);
  assert.notEqual(validatePaymentFields(orderWith({ paymentStatus: "paid", paidAt: null, paidAmount: 480 })), null);
  assert.equal(validatePaymentFields(orderWith({ paymentStatus: "paid", paidAt: PAID_AT, paidAmount: 480 })), null);
});

test("validatePaymentFields rejects a refunded order that lost paid_amount", () => {
  // This is the constraint that stops net revenue being overstated by exactly the refunded amount.
  const message = validatePaymentFields(orderWith({ paymentStatus: "refunded", paidAt: PAID_AT, paidAmount: null, refundedAt: LATER }));
  assert.notEqual(message, null);
  assert.match(String(message), /original payment date and amount/i);
});

test("validatePaymentFields rejects a refunded order with no refund date", () => {
  assert.notEqual(validatePaymentFields(orderWith({ paymentStatus: "refunded", paidAt: PAID_AT, paidAmount: 480, refundedAt: null })), null);
  assert.equal(validatePaymentFields(orderWith({ paymentStatus: "refunded", paidAt: PAID_AT, paidAmount: 480, refundedAt: LATER })), null);
});

test("validatePaymentFields rejects a negative paid_amount but allows null and zero", () => {
  assert.notEqual(validatePaymentFields(orderWith({ paidAmount: -1 })), null);
  // null is legitimate: an unpaid order has no amount.
  assert.equal(validatePaymentFields(orderWith({ paidAmount: null })), null);
  // A real zero payment is a real fact.
  assert.equal(validatePaymentFields(orderWith({ paymentStatus: "paid", paidAt: PAID_AT, paidAmount: 0 })), null);
});

test("payment transitions never mutate their input", () => {
  const order = orderWith();
  const frozen = JSON.stringify(order);
  applyPaymentReceived(order, [line()], "cash", PAID_AT);
  assert.equal(JSON.stringify(order), frozen);
});
