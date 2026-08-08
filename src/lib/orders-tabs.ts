// S7 PR-G2: the two views on the /orders surface.
//
// Deliberately the same shape as src/lib/inventory-tabs.ts -- union, label list, valid-set, tolerant
// resolver -- so there is one way to read a `?tab=` param in this app rather than two.
//
// `orders` is the default and stays the default: /orders opens on the order list exactly as it has
// since S2, and the readout is opt-in. A merged read layer is not a reason to move the surface
// people already work on.
//
// No new main-navigation entry accompanies this. Selling is reached through Orders, which is where
// an operator already goes to work an order.

export type OrdersTab = "orders" | "summary";

export const ordersTabs: Array<{ key: OrdersTab; label: string; href: string }> = [
  { key: "orders", label: "Orders", href: "/orders" },
  { key: "summary", label: "Summary", href: "/orders?tab=summary" },
];

const validOrdersTabs = new Set<string>(ordersTabs.map((tab) => tab.key));

export const defaultOrdersTab: OrdersTab = "orders";

// Accepts whatever a Next.js searchParams value can be (string, string[], or missing) so the server
// page can hand this the raw "tab" entry without pre-validating it itself. An unrecognised value
// degrades to the order list rather than erroring: a mistyped or stale link should still land the
// operator somewhere useful.
export function resolveOrdersTab(value: string | string[] | undefined): OrdersTab {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw && validOrdersTabs.has(raw) ? (raw as OrdersTab) : defaultOrdersTab;
}
