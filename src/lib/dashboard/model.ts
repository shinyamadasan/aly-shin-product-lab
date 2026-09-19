// Dashboard V1: the operations dashboard's view-model.
//
// The Dashboard SUMMARISES; it never edits and never becomes a second home for a formula. Every
// number here comes from an existing owner:
//
//   selling metrics   -> buildSellingSummary (orders/summary.ts), which itself delegates revenue to
//                        revenue.ts, preparation to pieces.ts and the business day to business-day.ts
//   finished stock    -> buildFinishedStockDemand (finished-stock-demand.ts; see its header for why
//                        reserved orders cannot be double-counted)
//   inventory         -> buildInventoryExceptions (inventory-exceptions.ts) over inventory-status.ts
//
// This file only ARRANGES those answers into the four zones the page renders, and decides what to
// show and what to keep quiet. Anything it would otherwise compute, it must not compute.
//
// FAILURE IS CONTAINED. Orders live outside LabState and can fail to load on their own. When they do,
// the selling zone reports that plainly and everything derived from inventory and finished stock is
// still built. The "caught up" state is only ever claimed when orders actually loaded: an unread
// order book is not an empty one.
//
// NO PROFIT. There is deliberately no profit, margin or cost figure anywhere in this model.
// order_raw_cogs is ingredient-only cost for FULFILLED orders (never packaging, labour, utilities or
// fees, by its own migration's comment), while revenue here is cash received on the day it was paid;
// dividing one by the other would present a mismatched-period, partial-cost number as profit. See
// planning/DASHBOARD_PROFIT_V1.md for what a truthful version needs.
//
// Pure. `nowMs` is a parameter, so the same inputs always produce the same output.

import { BUSINESS_TIMEZONE, resolveBusinessDay } from "../business-day.ts";
import type { LabState } from "../lab-state.ts";
import { toDisplayPrice } from "../orders/money.ts";
import { buildSellingSummary, type SellingSummary } from "../orders/summary.ts";
import type { Order, OrderLine } from "../orders/types.ts";
import { buildFinishedStockDemand, type FinishedStockDemandRow } from "./finished-stock-demand.ts";
import { buildInventoryExceptions, type InventoryExceptionRow } from "./inventory-exceptions.ts";

// "Important first few": enough to be useful, few enough to stay a glance. The rest is one click away.
export const STOCK_ROW_LIMIT = 5;
export const INVENTORY_ROW_LIMIT = 5;

export type OrdersSnapshot =
  | { status: "loading" }
  | { status: "unavailable"; reason: "missing-table" | "failed" | "not-configured"; message: string }
  | { status: "ready"; orders: Order[]; linesByOrderId: Map<string, OrderLine[]>; loadedAtMs: number };

export type PulseMetric = {
  key: "paid-today" | "paid-week" | "unpaid" | "orders-today";
  label: string;
  value: string;
  detail: string;
};

export type AttentionItem = {
  key: "overdue" | "new" | "scheduling" | "ready" | "unpaid" | "stock-shortage" | "inventory";
  count: number;
  label: string;
  // Present only for a money-bearing item (unpaid).
  value: string | null;
  href: "/orders" | "/bake" | "/inventory";
  urgent: boolean;
};

export type DashboardSelling =
  | { status: "loading" }
  | { status: "unavailable"; reason: "missing-table" | "failed" | "not-configured"; message: string }
  | { status: "ready"; hasOrders: boolean; pulse: PulseMetric[] };

export type DashboardModel = {
  businessDay: string;
  selling: DashboardSelling;
  // The canonical summary itself, exposed so nothing downstream ever needs to recompute from orders.
  summary: SellingSummary | null;
  attention: {
    items: AttentionItem[];
    // True ONLY when orders loaded and nothing needs attention. Never true while loading or failed.
    isCaughtUp: boolean;
  };
  stock: {
    rows: FinishedStockDemandRow[];
    hiddenCount: number;
    uncheckedLines: number | null;
    // False when order data is unavailable: stock is shown, demand and shortage are not.
    hasDemand: boolean;
  };
  inventory: {
    rows: InventoryExceptionRow[];
    hiddenCount: number;
    totalCount: number;
  };
};

export type DashboardInput = {
  labState: Pick<LabState, "products" | "ingredients" | "finishedStockMovements">;
  orders: OrdersSnapshot;
  nowMs: number;
};

function peso(value: number): string {
  return `₱${toDisplayPrice(value)}`;
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

function buildPulse(summary: SellingSummary): PulseMetric[] {
  const { attention, today, week } = summary;

  function receivedDetail(refunds: number, net: number): string {
    return refunds > 0 ? `${peso(refunds)} refunded · net ${peso(net)}` : "money received";
  }

  return [
    { key: "paid-today", label: "Paid today", value: peso(today.grossRevenue), detail: receivedDetail(today.refunds, today.netRevenue) },
    { key: "paid-week", label: "Paid last 7 days", value: peso(week.grossRevenue), detail: receivedDetail(week.refunds, week.netRevenue) },
    { key: "unpaid", label: "Unpaid", value: peso(attention.unpaidValue), detail: `${attention.unpaidCount} ${plural(attention.unpaidCount, "order", "orders")} owing` },
    {
      key: "orders-today",
      label: "Orders today",
      value: String(today.ordersPlaced),
      detail: today.remainingHandovers > 0 ? `${today.remainingHandovers} to hand over today` : "placed today",
    },
  ];
}

// Most urgent first, and only what is non-zero -- a column of zeroes is noise.
function buildAttentionItems(summary: SellingSummary | null, shortageProducts: number, inventoryExceptions: number): AttentionItem[] {
  const items: AttentionItem[] = [];

  if (summary) {
    const { attention } = summary;
    items.push(
      { key: "overdue", count: attention.overdueHandovers, label: `overdue ${plural(attention.overdueHandovers, "handover", "handovers")}`, value: null, href: "/orders", urgent: true },
      { key: "new", count: attention.newAwaitingConfirmation, label: `new ${plural(attention.newAwaitingConfirmation, "order", "orders")} awaiting confirmation`, value: null, href: "/orders", urgent: false },
      { key: "scheduling", count: attention.needsScheduling, label: `confirmed ${plural(attention.needsScheduling, "order needs", "orders need")} scheduling`, value: null, href: "/orders", urgent: false },
      { key: "ready", count: attention.readyForHandover, label: "ready for handover", value: null, href: "/orders", urgent: false },
      { key: "unpaid", count: attention.unpaidCount, label: "unpaid", value: `${peso(attention.unpaidValue)} outstanding`, href: "/orders", urgent: false },
    );
  }

  items.push(
    { key: "stock-shortage", count: shortageProducts, label: `${plural(shortageProducts, "product is", "products are")} short for new orders`, value: null, href: "/bake", urgent: true },
    { key: "inventory", count: inventoryExceptions, label: `${plural(inventoryExceptions, "ingredient needs", "ingredients need")} attention`, value: null, href: "/inventory", urgent: false },
  );

  return items.filter((item) => item.count > 0);
}

export function buildDashboardModel({ labState, orders, nowMs }: DashboardInput): DashboardModel {
  const businessDay = resolveBusinessDay(nowMs, BUSINESS_TIMEZONE);

  const summary =
    orders.status === "ready"
      ? buildSellingSummary({ orders: orders.orders, linesByOrderId: orders.linesByOrderId, nowMs, timeZone: BUSINESS_TIMEZONE })
      : null;

  const demand = buildFinishedStockDemand({
    products: labState.products,
    movements: labState.finishedStockMovements,
    orders: orders.status === "ready" ? orders.orders : null,
    linesByOrderId: orders.status === "ready" ? orders.linesByOrderId : new Map(),
  });
  const shortageProducts = demand.rows.filter((row) => (row.shortagePieces ?? 0) > 0).length;

  const inventoryRows = buildInventoryExceptions(labState.ingredients, businessDay);

  const selling: DashboardSelling =
    orders.status === "ready" && summary
      ? { status: "ready", hasOrders: orders.orders.length > 0, pulse: buildPulse(summary) }
      : orders.status === "unavailable"
        ? { status: "unavailable", reason: orders.reason, message: orders.message }
        : { status: "loading" };

  const attentionItems = buildAttentionItems(summary, shortageProducts, inventoryRows.length);

  return {
    businessDay,
    selling,
    summary,
    attention: { items: attentionItems, isCaughtUp: orders.status === "ready" && attentionItems.length === 0 },
    stock: {
      rows: demand.rows.slice(0, STOCK_ROW_LIMIT),
      hiddenCount: Math.max(0, demand.rows.length - STOCK_ROW_LIMIT),
      uncheckedLines: demand.uncheckedLines,
      hasDemand: orders.status === "ready",
    },
    inventory: {
      rows: inventoryRows.slice(0, INVENTORY_ROW_LIMIT),
      hiddenCount: Math.max(0, inventoryRows.length - INVENTORY_ROW_LIMIT),
      totalCount: inventoryRows.length,
    },
  };
}
