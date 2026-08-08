// S5: fulfilment expressed as ATTRIBUTES, never as a second state machine.
//
// orders.status remains the sole fulfilment/lifecycle state -- `ready` means made and waiting,
// `completed` means handed over. There is deliberately no fulfillment_status column, no `preparing`,
// no `out_for_delivery`, no `delivered`. A second status field can contradict the first, and the
// contradiction is invisible: two columns both claiming to say where the order is, disagreeing
// silently. The frozen plan (section 5.3) calls this the largest simplification in the design and
// the one most likely to be eroded later, so it is worth restating at the top of the file that
// exists to serve fulfilment.
//
// What lives here instead is the small amount of reading an operator needs: which orders are
// scheduled, which are not, and in what order they come due. All of it is pure and computed over
// the orders already loaded on the page -- no client, no clock. `nowMs` and `timeZone` are
// parameters, exactly as revenue.ts takes its range, so a business day is never guessed here.

import { resolveBusinessDay } from "../business-day.ts";
import type { Order } from "./types.ts";

// What the operator can ask the list for. "all" is the default and deliberately keeps unscheduled
// orders visible: an order with no agreed time is real work, and a filter that quietly hid it would
// make the busiest orders the easiest to forget.
export const FULFILLMENT_FILTERS = ["all", "today", "unscheduled"] as const;
export type FulfillmentFilter = (typeof FULFILLMENT_FILTERS)[number];

export const FULFILLMENT_SORTS = ["placed", "soonest"] as const;
export type FulfillmentSort = (typeof FULFILLMENT_SORTS)[number];

// null fulfillmentAt means "not scheduled yet" -- a legitimate state, not missing data to repair.
// An unparseable value is treated the same way rather than throwing: the column carries no format
// constraint, so a value that cannot be read is unknown, and unknown is already a state we have.
//
// Returning the instant rather than a boolean keeps the parse in one place; every consumer below
// asks this function rather than re-deriving it.
function getFulfillmentInstant(order: Pick<Order, "fulfillmentAt">): number | null {
  if (order.fulfillmentAt === null || order.fulfillmentAt === "") {
    return null;
  }
  const parsed = Date.parse(order.fulfillmentAt);
  return Number.isFinite(parsed) ? parsed : null;
}

export function isScheduled(order: Pick<Order, "fulfillmentAt">): boolean {
  return getFulfillmentInstant(order) !== null;
}

// A delivery address applies only to a delivery. Under pickup it is never active data -- the same
// rule the new-order form already applies when it writes "" for a pickup. Asking this function
// rather than reading the field directly is what keeps a stale address from ever rendering beside
// the word "Pickup", regardless of how that address came to be on the row.
export function getActiveDeliveryAddress(order: Pick<Order, "fulfillmentMethod" | "fulfillmentAddress">): string {
  return order.fulfillmentMethod === "delivery" ? order.fulfillmentAddress : "";
}

// Client-side over the orders already loaded. Returns the same array reference for "all" so the
// common case costs nothing.
//
// Only "today" asks for a scheduled subset, and it is the one filter that may exclude an
// unscheduled order -- because an order with no agreed time is genuinely not on today's list. It
// is never given an invented time to make it sortable or countable.
export function filterOrdersByFulfillment(orders: Order[], filter: FulfillmentFilter, { nowMs, timeZone }: { nowMs: number; timeZone: string }): Order[] {
  if (filter === "all") {
    return orders;
  }

  if (filter === "unscheduled") {
    return orders.filter((order) => !isScheduled(order));
  }

  const today = resolveBusinessDay(nowMs, timeZone);
  return orders.filter((order) => {
    const instant = getFulfillmentInstant(order);
    return instant !== null && resolveBusinessDay(instant, timeZone) === today;
  });
}

// Soonest handover first. Unscheduled orders sort last as a group rather than being dropped or
// dated: they still need to be seen, they simply have no position in the queue yet.
//
// Deterministic by construction -- Array.prototype.sort is stable (ES2019), so orders sharing a
// handover time, and all the unscheduled ones, keep the order they arrived in, which is the
// repository's placed_at ordering. The same input always produces the same output.
export function sortOrdersByFulfillment(orders: Order[], sort: FulfillmentSort): Order[] {
  if (sort === "placed") {
    return orders;
  }

  return [...orders].sort((a, b) => {
    const aInstant = getFulfillmentInstant(a);
    const bInstant = getFulfillmentInstant(b);

    if (aInstant === null && bInstant === null) {
      return 0;
    }
    if (aInstant === null) {
      return 1;
    }
    if (bInstant === null) {
      return -1;
    }

    return aInstant - bInstant;
  });
}
