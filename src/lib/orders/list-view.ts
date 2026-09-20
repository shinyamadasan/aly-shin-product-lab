// What the Orders LIST shows for each order, and how the operator finds one.
//
// Presentation only. Everything here reads fields already loaded on the page (the order, its line
// snapshots, the customer's name) and returns strings or subsets of them. Nothing here decides a
// status, a payment, a total, a reservation or a stock movement -- those stay with the modules that
// own them (transitions, payment, totals, fulfillment). Pure: no client, no clock.

import { isScheduled } from "./fulfillment.ts";
import type { Order, OrderLine, PaymentStatus } from "./types.ts";

// Case-insensitive substring search over the customer's name, each line's item-name snapshot, and
// the order id. Empty (or whitespace-only) means "no search" and returns the SAME array, so the
// default view costs nothing and is exactly the list that was passed in.
//
// Item names are the line snapshots, never today's catalog: an order for a since-renamed product is
// found by what it was sold as.
export function filterOrdersBySearch(
  orders: Order[],
  { query, linesByOrderId, customerNameById }: { query: string; linesByOrderId: Map<string, OrderLine[]>; customerNameById: Map<string, string> },
): Order[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") {
    return orders;
  }

  return orders.filter((order) => {
    const fields = [order.id, customerNameById.get(order.customerId) ?? "", ...(linesByOrderId.get(order.id) ?? []).map((line) => line.itemName)];
    return fields.some((field) => field.toLowerCase().includes(needle));
  });
}

// Actual ordered items instead of "N items": "2 brownies × 1 · Single cookie × 2". Quantity is the
// line's selling-unit quantity. Past two lines the card stays compact: the first two, then "+N more".
export const ITEM_SUMMARY_LINES_SHOWN = 2;

export function formatOrderItemSummary(lines: OrderLine[]): string {
  if (lines.length === 0) {
    return "No items";
  }

  const ordered = lines.slice().sort((a, b) => a.sortOrder - b.sortOrder);
  const shown = ordered.slice(0, ITEM_SUMMARY_LINES_SHOWN).map((line) => `${line.itemName} × ${line.quantity}`);
  const hidden = ordered.length - ITEM_SUMMARY_LINES_SHOWN;

  return hidden > 0 ? [...shown, `+${hidden} more`].join(" · ") : shown.join(" · ");
}

// The quiet source note for a card, or null to omit it. An unknown source with no reference is the
// common historical case and says nothing, so it is left off rather than repeated on every card;
// a known source is shown, and a reference is kept even when the source itself is unknown.
export function getOrderCardSource(order: Pick<Order, "source" | "sourceRef">): string | null {
  const ref = order.sourceRef.trim();
  if (order.source === "unknown") {
    return ref === "" ? null : ref;
  }

  const label = order.source.replace(/_/g, " ");
  return ref === "" ? label : `${label} · ${ref}`;
}

// The two timestamps a card can show, kept apart on purpose: placedAt is when the order was taken,
// fulfillmentAt is the agreed handover. handover is null unless one is actually scheduled, so an
// unscheduled order shows no "Not scheduled" filler.
export function getOrderCardTimes(order: Pick<Order, "placedAt" | "fulfillmentAt">): { placed: string; handover: string | null } {
  return { placed: order.placedAt, handover: isScheduled(order) ? order.fulfillmentAt : null };
}

// Tone of the payment tag, read straight from the order's own paymentStatus. It is never inferred
// from the lifecycle status: a completed order can be unpaid, and a cancelled one can be refunded.
export function getPaymentTone(paymentStatus: PaymentStatus): "green" | "danger" | "warm" {
  return paymentStatus === "paid" ? "green" : paymentStatus === "refunded" ? "danger" : "warm";
}

// The list only gets a second column when there is a detail to put in it. With nothing selected the
// list takes the full width; below xl the detail stacks under the list either way.
export function getOrdersLayoutClass(hasSelection: boolean): string {
  return hasSelection ? "grid gap-5 xl:grid-cols-[minmax(0,1fr)_420px]" : "grid gap-5";
}
