// Order and payment state machines. Pure: `now` is always a parameter, never read from a clock,
// so the same inputs always produce the same output and a test can pin any instant it likes.
//
// Each apply* function writes the status AND its matching timestamp together, so the two can never
// disagree -- a completed order always has a completedAt, and completedAt is never written by hand.

import { getOrderTotals } from "./totals.ts";
import type { Order, OrderLine, OrderStatus, PaymentMethod, PaymentStatus } from "./types.ts";

// --- Order lifecycle --------------------------------------------------------------------------
//
//   new ──▶ confirmed ──▶ ready ──▶ completed  (terminal)
//    │          │  └──────────────────▶│
//    └──────────┴───────────┬──────────┘
//                           ▼
//                      cancelled  (terminal)
//
// confirmed → completed is allowed directly: handing an order over on the spot is real, and
// forcing a `ready` click first would be ceremony.
//
// No backward transitions and no resurrection from a terminal state. A mis-click is repaired by
// editing the order's fields and lines -- still permitted on a terminal order, labelled in the UI
// as a correction -- not by moving it back through the machine, which would make completedAt a lie.
const ALLOWED_ORDER_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  new: ["confirmed", "cancelled"],
  confirmed: ["ready", "completed", "cancelled"],
  ready: ["completed", "cancelled"],
  completed: [],
  cancelled: [],
};

export function isValidOrderTransition(from: OrderStatus, to: OrderStatus): boolean {
  return ALLOWED_ORDER_TRANSITIONS[from].includes(to);
}

export function getAllowedOrderTransitions(from: OrderStatus): readonly OrderStatus[] {
  return ALLOWED_ORDER_TRANSITIONS[from];
}

export type OrderTransitionResult = { ok: true; order: Order } | { ok: false; message: string };

// Applies a lifecycle transition, writing the status and its timestamp in one step.
//
// Writes NOTHING to any payment field. Cancelling a paid order leaves paymentStatus, paidAt and
// paidAmount exactly as they were -- the money really was received, and it stays received until an
// actual refund is recorded. The UI prompts about a refund; it does not perform one.
export function applyOrderTransition(order: Order, to: OrderStatus, now: string, cancelReason = ""): OrderTransitionResult {
  if (order.status === to) {
    return { ok: false, message: `This order is already ${to}.` };
  }

  if (!isValidOrderTransition(order.status, to)) {
    const allowed = ALLOWED_ORDER_TRANSITIONS[order.status];
    if (allowed.length === 0) {
      return { ok: false, message: `A ${order.status} order cannot change status. Edit the order instead if it needs correcting.` };
    }
    return { ok: false, message: `An order cannot go from ${order.status} to ${to}.` };
  }

  return {
    ok: true,
    order: {
      ...order,
      status: to,
      completedAt: to === "completed" ? now : order.completedAt,
      cancelledAt: to === "cancelled" ? now : order.cancelledAt,
      cancelReason: to === "cancelled" ? cancelReason : order.cancelReason,
      updatedAt: now,
    },
  };
}

// --- Payment lifecycle ------------------------------------------------------------------------
//
//   unpaid ──▶ paid ──▶ refunded  (terminal)
//      ▲         │
//      └─────────┘   correction only: the claim "money arrived" was false
//
// Fully independent of the order lifecycle. A new order can be prepaid; a completed order can be
// unpaid; a cancelled order stays paid until a refund is actually recorded.
//
// The correction/refund distinction is what makes history trustworthy. A REFUND means the recorded
// fact was true and was later reversed: history is preserved and net revenue moves in the refund's
// own period. A CORRECTION means the recorded fact was false: history is rewritten, because it
// should never have said what it said. Only corrections rewrite the past, and only ever to remove
// something untrue.
const ALLOWED_PAYMENT_TRANSITIONS: Record<PaymentStatus, readonly PaymentStatus[]> = {
  // unpaid → refunded is prohibited: there is nothing to refund.
  unpaid: ["paid"],
  paid: ["refunded", "unpaid"],
  refunded: [],
};

export function isValidPaymentTransition(from: PaymentStatus, to: PaymentStatus): boolean {
  return ALLOWED_PAYMENT_TRANSITIONS[from].includes(to);
}

export type PaymentTransitionResult = { ok: true; order: Order } | { ok: false; message: string };

// Records that money arrived. This is the single moment revenue is created.
//
// paidAmount is frozen here from the order's total AT THIS INSTANT, and nothing afterwards
// recomputes it -- editing lines later cannot rewrite what was banked.
export function applyPaymentReceived(order: Order, lines: OrderLine[], method: PaymentMethod, now: string): PaymentTransitionResult {
  if (!isValidPaymentTransition(order.paymentStatus, "paid")) {
    if (order.paymentStatus === "paid") {
      return { ok: false, message: "This order is already marked paid." };
    }
    return { ok: false, message: `A ${order.paymentStatus} order cannot be marked paid.` };
  }

  return {
    ok: true,
    order: {
      ...order,
      paymentStatus: "paid",
      paymentMethod: method,
      paidAt: now,
      paidAmount: getOrderTotals(lines).total,
      updatedAt: now,
    },
  };
}

// Records that the money was given back.
//
// Retains paidAt and paidAmount deliberately -- both are historical facts, and paidAmount is the
// figure refunds(range) sums. The database enforces this too: orders_refund_fields_present rejects
// a refunded row that has lost either one.
export function applyRefund(order: Order, now: string): PaymentTransitionResult {
  if (!isValidPaymentTransition(order.paymentStatus, "refunded")) {
    if (order.paymentStatus === "unpaid") {
      return { ok: false, message: "This order was never paid, so there is nothing to refund." };
    }
    return { ok: false, message: "This order has already been refunded." };
  }

  return {
    ok: true,
    order: {
      ...order,
      paymentStatus: "refunded",
      refundedAt: now,
      updatedAt: now,
    },
  };
}

// Undoes a payment record that should never have existed. NOT a refund.
//
// Clears paidAt, paidAmount and paymentMethod together, because the claim they encoded was false.
// This is the only operation in the design that removes a money fact from history, and it is
// correct precisely because the fact was untrue.
export function applyPaymentCorrection(order: Order, now: string): PaymentTransitionResult {
  if (!isValidPaymentTransition(order.paymentStatus, "unpaid")) {
    if (order.paymentStatus === "unpaid") {
      return { ok: false, message: "This order is already unpaid." };
    }
    return { ok: false, message: "A refunded order cannot be marked unpaid." };
  }

  return {
    ok: true,
    order: {
      ...order,
      paymentStatus: "unpaid",
      paymentMethod: null,
      paidAt: null,
      paidAmount: null,
      updatedAt: now,
    },
  };
}
