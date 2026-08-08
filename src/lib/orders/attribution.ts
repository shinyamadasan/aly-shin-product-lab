// S6: acquisition attribution, read over the orders already loaded.
//
// Two facts are kept apart here and everywhere downstream:
//
//   source       -- WHERE the order came from. Instagram, a referral, walking up to the door.
//   entryMethod  -- HOW the record got into the app. Typed by hand, or submitted through a website.
//
// Nothing in this file reads or writes entryMethod. An Instagram customer typed in by hand is
// source=instagram, entry_method=manual, and correcting the channel later must never restate the
// second fact. Collapsing the two was a real defect in an earlier draft of the plan: defaulting
// source to "manual" silently attributed every hand-typed order to a non-channel.
//
// source_ref is opaque. It is never parsed, never joined to Content, never validated as a campaign
// or post identifier, and never inspected here at all -- it may hold a content id, a campaign tag,
// a referrer's name, or a URL, and its only job is to still say the same thing later.

import { ORDER_SOURCES, type Order, type OrderSource } from "./types.ts";

export type SourceCount = { source: OrderSource; count: number };

// A cheap read, not a report: counts over the orders currently on screen.
//
// "unknown" is counted EXPLICITLY rather than dropped. It is the honest answer for an order whose
// channel was never recorded, and hiding it would make the named channels look more complete than
// they are -- four Instagram orders out of five reads very differently from four out of twelve.
// It sorts last because it is the absence of a channel, not a channel competing with the others.
//
// Sources with no orders are omitted entirely: a list of zeroes is noise on a header line.
export function getOrderCountsBySource(orders: Order[]): SourceCount[] {
  const counts = new Map<OrderSource, number>();
  for (const order of orders) {
    counts.set(order.source, (counts.get(order.source) ?? 0) + 1);
  }

  return ORDER_SOURCES.map((source) => ({ source, count: counts.get(source) ?? 0 }))
    .filter((entry) => entry.count > 0)
    .sort((a, b) => {
      if (a.source === "unknown") return 1;
      if (b.source === "unknown") return -1;
      // Ties keep ORDER_SOURCES order, since the sort is stable and that is the order built above.
      return b.count - a.count;
    });
}
