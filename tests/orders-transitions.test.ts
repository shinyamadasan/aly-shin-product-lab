// The full order lifecycle matrix, exhaustively -- all 5x5 pairs, allowed and prohibited.
//
// Exhaustive rather than example-based because a state machine's defects live in the pairs nobody
// thought to write a test for, and "completed cannot be reopened" is only trustworthy if every
// route back has been checked.

import test from "node:test";
import assert from "node:assert/strict";
import { applyOrderTransition, getAllowedOrderTransitions, isValidOrderTransition } from "../src/lib/orders/transitions.ts";
import { ORDER_STATUSES, type Order, type OrderStatus } from "../src/lib/orders/types.ts";

const NOW = "2026-08-09T06:00:00.000Z";
const LATER = "2026-08-10T06:00:00.000Z";

function orderWith(status: OrderStatus, overrides: Partial<Order> = {}): Order {
  return {
    id: "order-1",
    customerId: "customer-1",
    status,
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

// The approved matrix, restated here independently of the implementation so a change to the
// implementation cannot quietly change what this test considers correct.
const EXPECTED_ALLOWED: Record<OrderStatus, OrderStatus[]> = {
  new: ["confirmed", "cancelled"],
  confirmed: ["ready", "completed", "cancelled"],
  ready: ["completed", "cancelled"],
  completed: [],
  cancelled: [],
};

test("the full 5x5 order transition matrix matches the approved machine", () => {
  for (const from of ORDER_STATUSES) {
    for (const to of ORDER_STATUSES) {
      const expected = EXPECTED_ALLOWED[from].includes(to);
      assert.equal(isValidOrderTransition(from, to), expected, `${from} -> ${to} should be ${expected ? "allowed" : "prohibited"}`);
    }
  }
});

test("completed and cancelled are terminal -- every route out is closed", () => {
  for (const terminal of ["completed", "cancelled"] as const) {
    assert.deepEqual(getAllowedOrderTransitions(terminal), []);
    for (const to of ORDER_STATUSES) {
      assert.equal(isValidOrderTransition(terminal, to), false, `${terminal} -> ${to} must be prohibited`);
    }
  }
});

test("confirmed -> completed is allowed directly, without passing through ready", () => {
  // Handing an order over on the spot is real; forcing a `ready` click first would be ceremony.
  assert.equal(isValidOrderTransition("confirmed", "completed"), true);
});

test("no backward transition exists anywhere", () => {
  const forwardOrder: OrderStatus[] = ["new", "confirmed", "ready", "completed"];
  for (let laterIndex = 0; laterIndex < forwardOrder.length; laterIndex += 1) {
    for (let earlierIndex = 0; earlierIndex < laterIndex; earlierIndex += 1) {
      assert.equal(
        isValidOrderTransition(forwardOrder[laterIndex], forwardOrder[earlierIndex]),
        false,
        `${forwardOrder[laterIndex]} -> ${forwardOrder[earlierIndex]} must be prohibited`,
      );
    }
  }
});

test("applyOrderTransition writes completed_at together with the status", () => {
  const result = applyOrderTransition(orderWith("ready"), "completed", NOW);
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.order.status, "completed");
  assert.equal(result.order.completedAt, NOW);
  assert.equal(result.order.updatedAt, NOW);
  // Only the matching timestamp is written.
  assert.equal(result.order.cancelledAt, null);
});

test("applyOrderTransition writes cancelled_at and the reason together with the status", () => {
  const result = applyOrderTransition(orderWith("confirmed"), "cancelled", NOW, "customer changed their mind");
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.order.status, "cancelled");
  assert.equal(result.order.cancelledAt, NOW);
  assert.equal(result.order.cancelReason, "customer changed their mind");
  assert.equal(result.order.completedAt, null);
});

test("cancelling writes NOTHING to any payment field", () => {
  // The money really was received, and stays received until an actual refund is recorded. The UI
  // prompts about a refund; cancelling does not perform one.
  const paid = orderWith("confirmed", {
    paymentStatus: "paid",
    paymentMethod: "gcash",
    paidAt: "2026-08-09T03:00:00.000Z",
    paidAmount: 480,
  });

  const result = applyOrderTransition(paid, "cancelled", NOW);
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.order.paymentStatus, "paid");
  assert.equal(result.order.paymentMethod, "gcash");
  assert.equal(result.order.paidAt, "2026-08-09T03:00:00.000Z");
  assert.equal(result.order.paidAmount, 480);
  assert.equal(result.order.refundedAt, null);
});

test("applyOrderTransition rejects a prohibited transition with a usable message", () => {
  const result = applyOrderTransition(orderWith("new"), "ready", NOW);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.message, /cannot go from new to ready/i);
});

test("applyOrderTransition rejects any change to a terminal order and says why", () => {
  const completed = applyOrderTransition(orderWith("completed"), "ready", NOW);
  assert.equal(completed.ok, false);
  if (completed.ok) return;
  assert.match(completed.message, /completed order cannot change status/i);
  assert.match(completed.message, /edit the order instead/i);

  const cancelled = applyOrderTransition(orderWith("cancelled"), "new", NOW);
  assert.equal(cancelled.ok, false);
});

test("applyOrderTransition rejects a no-op transition to the current status", () => {
  const result = applyOrderTransition(orderWith("confirmed"), "confirmed", NOW);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.message, /already confirmed/i);
});

test("applyOrderTransition never mutates its input", () => {
  const order = orderWith("ready");
  const frozen = JSON.stringify(order);

  applyOrderTransition(order, "completed", NOW);

  assert.equal(JSON.stringify(order), frozen);
});

test("applyOrderTransition is pure in `now` -- no clock is read internally", () => {
  const first = applyOrderTransition(orderWith("ready"), "completed", NOW);
  const second = applyOrderTransition(orderWith("ready"), "completed", LATER);

  assert.equal(first.ok && first.order.completedAt, NOW);
  assert.equal(second.ok && second.order.completedAt, LATER);
});

test("an earlier timestamp is not overwritten by a later, unrelated transition", () => {
  // Cancelling a completed order is prohibited, but the general property matters: a transition
  // writes only its own timestamp and leaves the others exactly as they were.
  const readyOrder = orderWith("ready", { completedAt: null, cancelledAt: null });
  const cancelled = applyOrderTransition(readyOrder, "cancelled", NOW);
  assert.equal(cancelled.ok, true);
  if (!cancelled.ok) return;
  assert.equal(cancelled.order.completedAt, null);
});
