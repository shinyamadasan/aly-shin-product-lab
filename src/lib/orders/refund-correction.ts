// Whether "Correct mistaken refund" should be OFFERED. Presentation only: the database
// (correct_mistaken_refund, supabase/migrations/20261019120000_order_refund_correction.sql) re-checks every
// rule under a row lock and is the only thing that decides. These constants mirror its limits so the screen
// does not offer what the database will always refuse.
//
// A genuine refund (money went back to the customer) must never be reversed with this. It is therefore
// limited to a recent refund on an order that is not cancelled, once per order, and the owner must type the
// order's short code and a reason.

import type { Order } from "./types.ts";

export const REFUND_CORRECTION_WINDOW_DAYS = 7;
export const REFUND_CORRECTION_REASON_MIN = 10;
export const REFUND_CORRECTION_REASON_MAX = 300;

const DAY_MS = 24 * 60 * 60 * 1000;

export function appearsRefundCorrectable(
  order: Pick<Order, "status" | "paymentStatus" | "paidAt" | "paidAmount" | "refundedAt">,
  alreadyCorrected: boolean,
  nowMs: number,
): boolean {
  if (order.paymentStatus !== "refunded" || order.status === "cancelled" || alreadyCorrected) {
    return false;
  }
  if (order.paidAt === null || order.paidAmount === null || order.refundedAt === null) {
    return false;
  }
  const refundedMs = Date.parse(order.refundedAt);
  return Number.isFinite(refundedMs) && nowMs - refundedMs <= REFUND_CORRECTION_WINDOW_DAYS * DAY_MS;
}

// The owner types the first 8 characters of the order id: enough that it cannot be done on autopilot.
export function refundCorrectionConfirmationCode(orderId: string): string {
  return orderId.slice(0, 8).toLowerCase();
}

export function validateRefundCorrectionReason(reason: string): string | null {
  const length = reason.trim().length;
  if (length < REFUND_CORRECTION_REASON_MIN) {
    return `Explain why in at least ${REFUND_CORRECTION_REASON_MIN} characters.`;
  }
  if (length > REFUND_CORRECTION_REASON_MAX) {
    return `Keep the reason under ${REFUND_CORRECTION_REASON_MAX} characters.`;
  }
  return null;
}

// Shown before the NORMAL Refund button records a refund. A refund is terminal in the order state machine, so
// the click must be deliberate: the owner is asked to confirm that money was actually returned.
export function buildRefundConfirmation(customerName: string | null, amountLabel: string): string {
  return [
    `Record a refund of ${amountLabel}${customerName ? ` to ${customerName}` : ""}?`,
    "",
    "Only continue if this money has actually been returned to the customer.",
    "A refund cannot be undone with the normal buttons.",
    "",
    "If you pressed Refund by mistake, choose Cancel.",
  ].join("\n");
}

export function buildRefundCorrectionWarning(amountLabel: string): string {
  return `Use this only if NO money was returned to the customer. It marks the ${amountLabel} sale as Paid again and removes the refund from your reports. Your reason is saved permanently. If money really was returned, do not use this.`;
}
