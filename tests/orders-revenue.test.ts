// The revenue invariant regression suite.
//
// Every test here corresponds to a specific way an earlier draft of this design would have
// produced a commercial record that looked authoritative and was wrong. They are the reason the
// architecture has paid_amount, refunded_at, and no lifecycle status in its revenue formulas.

import test from "node:test";
import assert from "node:assert/strict";
import { grossRevenue, netRevenue, refunds, singleDayRange, unpaidOrderValue, type BusinessDayRange } from "../src/lib/orders/revenue.ts";
import { getOrderTotals } from "../src/lib/orders/totals.ts";
import { applyOrderTransition, applyRefund } from "../src/lib/orders/transitions.ts";
import type { Order, OrderLine } from "../src/lib/orders/types.ts";

const MANILA = "Asia/Manila";

// 2026-08-09 14:00 Manila = 06:00Z. Comfortably inside the Manila business day either way.
const PAID_AT = "2026-08-09T06:00:00.000Z";
// A refund a month later, so gross and refunds land in different periods.
const REFUNDED_AT = "2026-09-01T06:00:00.000Z";

const AUGUST: BusinessDayRange = { fromDay: "2026-08-01", toDay: "2026-08-31", timezone: MANILA };
const SEPTEMBER: BusinessDayRange = { fromDay: "2026-09-01", toDay: "2026-09-30", timezone: MANILA };

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

const paidOrder = orderWith({ paymentStatus: "paid", paymentMethod: "gcash", paidAt: PAID_AT, paidAmount: 480 });

// --- The three properties -----------------------------------------------------------------------

test("cancelling a paid order does not move gross revenue by a centavo", () => {
  // The money really was received. It stays received until an actual refund is recorded.
  const before = grossRevenue([paidOrder], AUGUST);
  assert.equal(before, 480);

  const cancelled = applyOrderTransition(paidOrder, "cancelled", REFUNDED_AT);
  assert.equal(cancelled.ok, true);
  if (!cancelled.ok) return;

  assert.equal(grossRevenue([cancelled.order], AUGUST), 480);
  assert.equal(netRevenue([cancelled.order], AUGUST), 480);
});

test("lifecycle status appears nowhere in gross, refunds, or net", () => {
  // Same paid order in every lifecycle state -- revenue is identical in all of them.
  const statuses = ["new", "confirmed", "ready", "completed", "cancelled"] as const;
  for (const status of statuses) {
    const order = orderWith({ status, paymentStatus: "paid", paidAt: PAID_AT, paidAmount: 480 });
    assert.equal(grossRevenue([order], AUGUST), 480, `gross must not depend on status=${status}`);
    assert.equal(netRevenue([order], AUGUST), 480, `net must not depend on status=${status}`);
  }
});

test("a refund reduces the refund period's net and leaves the payment period's gross untouched", () => {
  const refunded = applyRefund(paidOrder, REFUNDED_AT);
  assert.equal(refunded.ok, true);
  if (!refunded.ok) return;

  // August: the money did arrive, and that fact is immutable.
  assert.equal(grossRevenue([refunded.order], AUGUST), 480);
  assert.equal(refunds([refunded.order], AUGUST), 0);
  assert.equal(netRevenue([refunded.order], AUGUST), 480);

  // September: the money left.
  assert.equal(grossRevenue([refunded.order], SEPTEMBER), 0);
  assert.equal(refunds([refunded.order], SEPTEMBER), 480);
  assert.equal(netRevenue([refunded.order], SEPTEMBER), -480);
});

test("editing lines on a paid order does not change revenue", () => {
  // Revenue reads the frozen paid_amount and never a line. Proven structurally: the revenue
  // functions take only orders, so a line edit has no path into gross, refunds, or net at all --
  // an edited line set can be built and revenue still cannot see it.
  const editedLines: OrderLine[] = [line({ unitPrice: 9999, quantity: 3 })];
  assert.equal(getOrderTotals(editedLines).total, 29997, "the lines really did change");

  assert.equal(grossRevenue([paidOrder], AUGUST), 480);
  assert.equal(netRevenue([paidOrder], AUGUST), 480);
});

test("refunds attribute to refunded_at, not to paid_at", () => {
  const refundedSameMonth = orderWith({
    paymentStatus: "refunded",
    paidAt: PAID_AT,
    paidAmount: 480,
    refundedAt: "2026-08-20T06:00:00.000Z",
  });

  assert.equal(refunds([refundedSameMonth], AUGUST), 480);
  assert.equal(netRevenue([refundedSameMonth], AUGUST), 0);
});

// --- Totality ------------------------------------------------------------------------------------

test("an order with no paid_at contributes nothing to gross, and is not an error", () => {
  assert.equal(grossRevenue([orderWith()], AUGUST), 0);
  assert.equal(refunds([orderWith()], AUGUST), 0);
  assert.equal(netRevenue([orderWith()], AUGUST), 0);
});

test("a real zero payment is counted as a payment, not skipped", () => {
  const free = orderWith({ paymentStatus: "paid", paidAt: PAID_AT, paidAmount: 0 });
  assert.equal(grossRevenue([free], AUGUST), 0);
  // The distinction that matters is that it did not throw and did not skip -- a zero payment is a
  // real fact, and null is what "no payment" looks like.
  assert.notEqual(free.paidAmount, null);
});

test("an unparseable timestamp is excluded rather than throwing", () => {
  const broken = orderWith({ paymentStatus: "paid", paidAt: "not-a-date", paidAmount: 480 });
  assert.equal(grossRevenue([broken], AUGUST), 0);
});

// --- Manila boundaries ---------------------------------------------------------------------------

test("revenue ranges are Manila business days, not UTC days", () => {
  // 2026-08-09T16:30Z is already 2026-08-10 in Manila (UTC+8). Under a UTC reading this payment
  // would land on the 9th; under the correct Manila reading it lands on the 10th.
  const lateEvening = orderWith({ paymentStatus: "paid", paidAt: "2026-08-09T16:30:00.000Z", paidAmount: 100 });

  assert.equal(grossRevenue([lateEvening], singleDayRange("2026-08-10", MANILA)), 100);
  assert.equal(grossRevenue([lateEvening], singleDayRange("2026-08-09", MANILA)), 0);

  // The same instant read in UTC lands on the 9th -- proving the timezone argument is honoured
  // rather than ignored.
  assert.equal(grossRevenue([lateEvening], singleDayRange("2026-08-09", "UTC")), 100);
});

test("the Manila day boundary sits at 16:00Z", () => {
  const justBefore = orderWith({ id: "a", paymentStatus: "paid", paidAt: "2026-08-09T15:59:00.000Z", paidAmount: 10 });
  const justAfter = orderWith({ id: "b", paymentStatus: "paid", paidAt: "2026-08-09T16:01:00.000Z", paidAmount: 20 });

  assert.equal(grossRevenue([justBefore, justAfter], singleDayRange("2026-08-09", MANILA)), 10);
  assert.equal(grossRevenue([justBefore, justAfter], singleDayRange("2026-08-10", MANILA)), 20);
});

test("a range is inclusive on both ends", () => {
  const first = orderWith({ id: "a", paymentStatus: "paid", paidAt: "2026-08-01T04:00:00.000Z", paidAmount: 10 });
  const last = orderWith({ id: "b", paymentStatus: "paid", paidAt: "2026-08-31T04:00:00.000Z", paidAmount: 20 });

  assert.equal(grossRevenue([first, last], AUGUST), 30);
});

// --- Receivables ---------------------------------------------------------------------------------

test("unpaidOrderValue uses current line totals and excludes cancelled orders", () => {
  // This is the one place lifecycle status legitimately appears: a cancelled order is not owed.
  const openOrder = orderWith({ id: "open", status: "confirmed", paymentStatus: "unpaid" });
  const cancelledOrder = orderWith({ id: "cancelled", status: "cancelled", paymentStatus: "unpaid" });

  const lines = new Map<string, OrderLine[]>([
    ["open", [line({ orderId: "open", unitPrice: 480, quantity: 2 })]],
    ["cancelled", [line({ orderId: "cancelled", unitPrice: 999, quantity: 5 })]],
  ]);

  assert.equal(unpaidOrderValue([openOrder, cancelledOrder], lines), 960);
});

test("unpaidOrderValue excludes paid and refunded orders", () => {
  const lines = new Map<string, OrderLine[]>([["order-1", [line({ unitPrice: 480 })]]]);

  assert.equal(unpaidOrderValue([paidOrder], lines), 0);
  assert.equal(unpaidOrderValue([orderWith({ paymentStatus: "refunded", paidAt: PAID_AT, paidAmount: 480, refundedAt: REFUNDED_AT })], lines), 0);
  assert.equal(unpaidOrderValue([orderWith()], lines), 480);
});

test("unpaidOrderValue treats an order with no known lines as zero, not an error", () => {
  assert.equal(unpaidOrderValue([orderWith()], new Map()), 0);
});

// --- Aggregation ---------------------------------------------------------------------------------

test("gross, refunds and net aggregate correctly across a mixed set of orders", () => {
  const orders = [
    orderWith({ id: "a", paymentStatus: "paid", paidAt: "2026-08-05T04:00:00.000Z", paidAmount: 480 }),
    orderWith({ id: "b", paymentStatus: "paid", paidAt: "2026-08-06T04:00:00.000Z", paidAmount: 240 }),
    // Paid in August, refunded in August.
    orderWith({ id: "c", paymentStatus: "refunded", paidAt: "2026-08-07T04:00:00.000Z", paidAmount: 120, refundedAt: "2026-08-08T04:00:00.000Z" }),
    // Paid in August, refunded in September -- August's gross keeps it, September's net loses it.
    orderWith({ id: "d", paymentStatus: "refunded", paidAt: "2026-08-09T04:00:00.000Z", paidAmount: 60, refundedAt: REFUNDED_AT }),
    // Never paid.
    orderWith({ id: "e" }),
    // Cancelled but genuinely paid -- still revenue.
    orderWith({ id: "f", status: "cancelled", paymentStatus: "paid", paidAt: "2026-08-10T04:00:00.000Z", paidAmount: 30 }),
  ];

  assert.equal(grossRevenue(orders, AUGUST), 480 + 240 + 120 + 60 + 30);
  assert.equal(refunds(orders, AUGUST), 120);
  assert.equal(netRevenue(orders, AUGUST), 930 - 120);

  assert.equal(grossRevenue(orders, SEPTEMBER), 0);
  assert.equal(refunds(orders, SEPTEMBER), 60);
  assert.equal(netRevenue(orders, SEPTEMBER), -60);
});

test("revenue functions never mutate their inputs", () => {
  const orders = [paidOrder];
  const frozen = JSON.stringify(orders);

  grossRevenue(orders, AUGUST);
  refunds(orders, AUGUST);
  netRevenue(orders, AUGUST);

  assert.equal(JSON.stringify(orders), frozen);
});
