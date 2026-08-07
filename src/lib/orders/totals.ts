// The live quote, and the divergence between it and what was actually paid.
//
// Two clearly separated numbers with two clearly separated jobs:
//
//   getOrderTotals(lines)  -- what this customer should pay, computed from the current lines.
//                             Changes legitimately whenever the lines change.
//   order.paidAmount       -- what was actually received, frozen at paidAt. Never computed here.
//
// Nothing in this file writes a payment field, and revenue.ts never calls into it for gross or
// refund figures. That separation is what stops an order edit from silently rewriting history.

import type { Order, OrderLine } from "./types.ts";

export type OrderTotals = {
  total: number;
  lineCount: number;
  // Total units across all lines. Not pieces -- see pieces.ts, which needs a per-line pack size
  // that this function deliberately does not know about.
  unitCount: number;
};

// Deliberately no stored line_total or order_total anywhere in the schema. A derived total with no
// distinguished moment is a second source of truth that will eventually disagree with the lines,
// and the disagreement is invisible. Price-at-time-of-sale history is preserved by each line's own
// frozen unitPrice, not by a stored sum.
export function getOrderTotals(lines: OrderLine[]): OrderTotals {
  let total = 0;
  let unitCount = 0;

  for (const line of lines) {
    total += line.unitPrice * line.quantity;
    unitCount += line.quantity;
  }

  return { total, lineCount: lines.length, unitCount };
}

export type PaymentDivergence =
  // No payment is recorded, so there is nothing to diverge from. Distinct from a zero difference.
  | { state: "not-paid" }
  // A payment is recorded and matches the current total.
  | { state: "matched"; paidAmount: number; currentTotal: number }
  // A payment is recorded and the current total has since moved. `difference` is
  // currentTotal - paidAmount: positive means the order is now worth more than was received.
  | { state: "diverged"; paidAmount: number; currentTotal: number; difference: number };

// Reports the gap between the frozen payment and the current quote. Pure and read-only by
// construction -- it returns a description, never a correction.
//
// The UI surfaces this as information with exactly one action ("Correct payment record"), which
// asserts the recorded payment was wrong and is pre-filled from the RECORDED payment, never from
// the current total. Auto-reconciling to the current total would encode "the lines changed,
// therefore money moved", which is false: a changed order total is not evidence of a payment.
// Genuinely receiving more money later is a second payment, which this milestone does not model.
export function getPaymentDivergence(order: Order, lines: OrderLine[]): PaymentDivergence {
  if (order.paidAmount === null) {
    return { state: "not-paid" };
  }

  const currentTotal = getOrderTotals(lines).total;
  const difference = currentTotal - order.paidAmount;

  if (difference === 0) {
    return { state: "matched", paidAmount: order.paidAmount, currentTotal };
  }

  return { state: "diverged", paidAmount: order.paidAmount, currentTotal, difference };
}
