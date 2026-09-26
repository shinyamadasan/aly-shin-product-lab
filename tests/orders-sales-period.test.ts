// Orders Workspace V1: the selectable reporting period (src/lib/orders/summary.ts's additive half).
//
// Two properties this suite defends:
//   1. resolveSalesPeriodRange never throws and never returns a malformed range, for any input.
//   2. buildSalesPeriodOverview reuses the exact primitives buildSellingSummary's today/week already
//      use -- it must never disagree with them about what "paid revenue" or "most ordered" means,
//      and where it deliberately DOES differ (ordersPlaced excluding cancelled), that difference is
//      pinned by a side-by-side test, not left to drift silently.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildSalesPeriodOverview, buildSellingSummary, DEFAULT_SALES_PERIOD, isValidCustomSalesPeriod, resolveRollingWeekRange, resolveSalesPeriodRange,
  resolveTodayRange, type SalesPeriodSelection,
} from "../src/lib/orders/summary.ts";
import { grossRevenue } from "../src/lib/orders/revenue.ts";
import type { Order, OrderLine } from "../src/lib/orders/types.ts";

const MANILA = "Asia/Manila";
// 2026-08-09 14:00 Manila = 06:00Z.
const NOW = Date.parse("2026-08-09T06:00:00.000Z");

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

// --- Date-range semantics -------------------------------------------------------------------------

test("today == resolveTodayRange's own output for the same inputs", () => {
  assert.deepEqual(resolveSalesPeriodRange({ kind: "today" }, NOW, MANILA), resolveTodayRange(NOW, MANILA));
});

test("last7 is byte-for-byte identical to the existing resolveRollingWeekRange -- the refactor changed nothing observable", () => {
  assert.deepEqual(resolveSalesPeriodRange({ kind: "last7" }, NOW, MANILA), resolveRollingWeekRange(NOW, MANILA));
});

test("last7 spans exactly 7 Manila calendar days including today", () => {
  const range = resolveSalesPeriodRange({ kind: "last7" }, NOW, MANILA);
  assert.equal(range.toDay, "2026-08-09");
  assert.equal(range.fromDay, "2026-08-03");
});

test("last30 spans exactly 30 Manila calendar days including today", () => {
  const range = resolveSalesPeriodRange({ kind: "last30" }, NOW, MANILA);
  assert.equal(range.toDay, "2026-08-09");
  assert.equal(range.fromDay, "2026-07-11");
});

test("thisMonth starts on day 1 of the current Manila month and ends today", () => {
  const range = resolveSalesPeriodRange({ kind: "thisMonth" }, NOW, MANILA);
  assert.equal(range.fromDay, "2026-08-01");
  assert.equal(range.toDay, "2026-08-09");
});

test("thisMonth at a Manila month boundary starts on the new month's 1st, not the old month's", () => {
  // 2026-08-31 23:00 Manila = 2026-08-31T15:00:00.000Z (Manila is UTC+8, no DST).
  const lastDayOfAugust = Date.parse("2026-08-31T15:00:00.000Z");
  assert.equal(resolveSalesPeriodRange({ kind: "thisMonth" }, lastDayOfAugust, MANILA).fromDay, "2026-08-01");

  // One hour later in UTC is already September 1st in Manila.
  const firstDayOfSeptember = Date.parse("2026-08-31T17:00:00.000Z");
  const septemberRange = resolveSalesPeriodRange({ kind: "thisMonth" }, firstDayOfSeptember, MANILA);
  assert.equal(septemberRange.fromDay, "2026-09-01");
  assert.equal(septemberRange.toDay, "2026-09-01");
});

test("allTime ends today and starts well before any plausible order, never excluding real data", () => {
  const range = resolveSalesPeriodRange({ kind: "allTime" }, NOW, MANILA);
  assert.equal(range.toDay, "2026-08-09");
  assert.ok(range.fromDay < "2020-01-01", "the sentinel floor must predate any real order fixture");
});

test("custom with a valid start<=end pair returns exactly that range", () => {
  const range = resolveSalesPeriodRange({ kind: "custom", startDay: "2026-07-01", endDay: "2026-07-15" }, NOW, MANILA);
  assert.deepEqual(range, { fromDay: "2026-07-01", toDay: "2026-07-15", timezone: MANILA });
});

test("custom with start > end falls back to last7 rather than returning an inverted range", () => {
  const range = resolveSalesPeriodRange({ kind: "custom", startDay: "2026-07-15", endDay: "2026-07-01" }, NOW, MANILA);
  assert.deepEqual(range, resolveRollingWeekRange(NOW, MANILA));
});

test("custom with malformed date strings never throws and falls back to last7", () => {
  for (const [startDay, endDay] of [
    ["not-a-date", "2026-07-15"],
    ["2026-07-01", "not-a-date"],
    ["2026-13-40", "2026-07-15"],
    ["", ""],
  ] as const) {
    assert.doesNotThrow(() => resolveSalesPeriodRange({ kind: "custom", startDay, endDay }, NOW, MANILA));
    assert.deepEqual(resolveSalesPeriodRange({ kind: "custom", startDay, endDay }, NOW, MANILA), resolveRollingWeekRange(NOW, MANILA));
  }
});

test("isValidCustomSalesPeriod agrees with the resolver's own fallback trigger", () => {
  assert.equal(isValidCustomSalesPeriod("2026-07-01", "2026-07-15"), true);
  assert.equal(isValidCustomSalesPeriod("2026-07-15", "2026-07-01"), false);
  assert.equal(isValidCustomSalesPeriod("not-a-date", "2026-07-15"), false);
  assert.equal(isValidCustomSalesPeriod("2026-07-01", "2026-07-01"), true, "a single-day custom range is valid (inclusive)");
});

test("every branch produces a well-formed BusinessDayRange", () => {
  const selections: SalesPeriodSelection[] = [
    { kind: "today" },
    { kind: "last7" },
    { kind: "last30" },
    { kind: "thisMonth" },
    { kind: "allTime" },
    { kind: "custom", startDay: "2026-01-01", endDay: "2026-01-31" },
  ];
  for (const selection of selections) {
    const range = resolveSalesPeriodRange(selection, NOW, MANILA);
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(range.fromDay), `${selection.kind}: fromDay must be YYYY-MM-DD`);
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(range.toDay), `${selection.kind}: toDay must be YYYY-MM-DD`);
    assert.ok(range.fromDay <= range.toDay, `${selection.kind}: fromDay must not be after toDay`);
    assert.equal(range.timezone, MANILA);
  }
});

test("DEFAULT_SALES_PERIOD is last7", () => {
  assert.deepEqual(DEFAULT_SALES_PERIOD, { kind: "last7" });
});

// --- The four overview metrics ---------------------------------------------------------------------

const AUGUST_WEEK = resolveSalesPeriodRange({ kind: "last7" }, NOW, MANILA);

test("ordersPlaced excludes cancelled orders, and legitimately differs from SellingSummaryPeriod.ordersPlaced by exactly that count", () => {
  const orders = [
    orderWith({ id: "a", status: "new", placedAt: "2026-08-08T04:00:00.000Z" }),
    orderWith({ id: "b", status: "confirmed", placedAt: "2026-08-08T04:00:00.000Z" }),
    orderWith({ id: "c", status: "cancelled", placedAt: "2026-08-08T04:00:00.000Z" }),
  ];
  const linesByOrderId = new Map<string, OrderLine[]>();

  const overview = buildSalesPeriodOverview({ orders, linesByOrderId, range: AUGUST_WEEK });
  const summary = buildSellingSummary({ orders, linesByOrderId, nowMs: NOW, timeZone: MANILA });

  assert.equal(overview.ordersPlaced, 2, "cancelled order excluded from the new metric");
  assert.equal(summary.week.ordersPlaced, 3, "the existing week.ordersPlaced still counts cancelled -- it measures intake");
  assert.equal(summary.week.ordersPlaced - overview.ordersPlaced, 1, "the two numbers disagree by exactly the cancelled count, not by accident");
});

test("ordersPlaced excludes an order placed outside the range", () => {
  const orders = [
    orderWith({ id: "in", status: "new", placedAt: "2026-08-08T04:00:00.000Z" }),
    orderWith({ id: "out", status: "new", placedAt: "2026-07-01T04:00:00.000Z" }),
  ];
  const overview = buildSalesPeriodOverview({ orders, linesByOrderId: new Map(), range: AUGUST_WEEK });
  assert.equal(overview.ordersPlaced, 1);
});

test("sellingUnits sums quantity across non-cancelled in-range orders' lines only", () => {
  const orders = [
    orderWith({ id: "a", status: "new", placedAt: "2026-08-08T04:00:00.000Z" }),
    orderWith({ id: "b", status: "cancelled", placedAt: "2026-08-08T04:00:00.000Z" }),
  ];
  const linesByOrderId = new Map<string, OrderLine[]>([
    ["a", [line({ orderId: "a", quantity: 3 })]],
    ["b", [line({ orderId: "b", quantity: 100 })]], // cancelled -- must not count
  ]);

  assert.equal(buildSalesPeriodOverview({ orders, linesByOrderId, range: AUGUST_WEEK }).sellingUnits, 3);
});

test("paidRevenue matches grossRevenue directly, including a cancelled-but-paid order (no lifecycle filter)", () => {
  const cancelledPaid = orderWith({ id: "a", status: "cancelled", paymentStatus: "paid", paidAt: "2026-08-08T04:00:00.000Z", paidAmount: 480, placedAt: "2026-08-08T04:00:00.000Z" });
  const overview = buildSalesPeriodOverview({ orders: [cancelledPaid], linesByOrderId: new Map(), range: AUGUST_WEEK });
  assert.equal(overview.paidRevenue, 480);
});

test("an unpaid order contributes to ordersPlaced/sellingUnits but not to paidRevenue or averagePaidOrderValue", () => {
  const unpaid = orderWith({ id: "a", status: "new", paymentStatus: "unpaid", placedAt: "2026-08-08T04:00:00.000Z" });
  const linesByOrderId = new Map<string, OrderLine[]>([["a", [line({ orderId: "a", quantity: 2 })]]]);

  const overview = buildSalesPeriodOverview({ orders: [unpaid], linesByOrderId, range: AUGUST_WEEK });
  assert.equal(overview.ordersPlaced, 1);
  assert.equal(overview.sellingUnits, 2);
  assert.equal(overview.paidRevenue, 0);
  assert.equal(overview.averagePaidOrderValue, 0);
});

test("averagePaidOrderValue is paidRevenue divided by the count of orders that actually paid in range", () => {
  const orders = [
    orderWith({ id: "a", paymentStatus: "paid", paidAt: "2026-08-05T04:00:00.000Z", paidAmount: 300, placedAt: "2026-08-05T04:00:00.000Z" }),
    orderWith({ id: "b", paymentStatus: "paid", paidAt: "2026-08-06T04:00:00.000Z", paidAmount: 100, placedAt: "2026-08-06T04:00:00.000Z" }),
  ];
  const overview = buildSalesPeriodOverview({ orders, linesByOrderId: new Map(), range: AUGUST_WEEK });
  assert.equal(overview.paidRevenue, 400);
  assert.equal(overview.averagePaidOrderValue, 200);
});

test("averagePaidOrderValue is exactly 0 (never NaN or Infinity) when nothing paid in range", () => {
  const overview = buildSalesPeriodOverview({ orders: [], linesByOrderId: new Map(), range: AUGUST_WEEK });
  assert.equal(overview.averagePaidOrderValue, 0);
  assert.equal(Number.isNaN(overview.averagePaidOrderValue), false);
  assert.equal(Number.isFinite(overview.averagePaidOrderValue), true);
});

test("mostOrdered excludes cancelled orders' lines; sources includes them -- the same opposite rule buildSellingSummary already applies", () => {
  const orders = [
    orderWith({ id: "a", status: "new", source: "instagram", placedAt: "2026-08-08T04:00:00.000Z" }),
    orderWith({ id: "b", status: "cancelled", source: "direct", placedAt: "2026-08-08T04:00:00.000Z" }),
  ];
  const linesByOrderId = new Map<string, OrderLine[]>([
    ["a", [line({ orderId: "a", productId: "", itemName: "Brownies", quantity: 5 })]],
    ["b", [line({ orderId: "b", productId: "", itemName: "Cookies", quantity: 9 })]],
  ]);

  const overview = buildSalesPeriodOverview({ orders, linesByOrderId, range: AUGUST_WEEK });
  assert.deepEqual(overview.mostOrdered.map((item) => item.label), ["Brownies"], "the cancelled order's Cookies line must not appear");
  assert.deepEqual(overview.sources.map((entry) => entry.source).sort(), ["direct", "instagram"], "cancelled order still counted as a source");
});

test("buildSalesPeriodOverview is deterministic: same inputs, same output", () => {
  const orders = [orderWith({ id: "a", status: "new", paymentStatus: "paid", paidAt: "2026-08-08T04:00:00.000Z", paidAmount: 480, placedAt: "2026-08-08T04:00:00.000Z" })];
  const linesByOrderId = new Map<string, OrderLine[]>([["a", [line({ orderId: "a" })]]]);

  const first = buildSalesPeriodOverview({ orders, linesByOrderId, range: AUGUST_WEEK });
  const second = buildSalesPeriodOverview({ orders, linesByOrderId, range: AUGUST_WEEK });
  assert.deepEqual(first, second);
});

// --- One range drives everything together ----------------------------------------------------------

test("one range change moves ordersPlaced, mostOrdered and sources together -- not three independently-resolved ranges", () => {
  const inRange = orderWith({ id: "in", status: "new", source: "instagram", placedAt: "2026-08-08T04:00:00.000Z" });
  const outOfRange = orderWith({ id: "out", status: "new", source: "tiktok", placedAt: "2026-06-01T04:00:00.000Z" });
  const orders = [inRange, outOfRange];
  const linesByOrderId = new Map<string, OrderLine[]>([
    ["in", [line({ orderId: "in", productId: "", itemName: "In-range item" })]],
    ["out", [line({ orderId: "out", productId: "", itemName: "Out-of-range item" })]],
  ]);

  const narrow = buildSalesPeriodOverview({ orders, linesByOrderId, range: AUGUST_WEEK });
  assert.equal(narrow.ordersPlaced, 1);
  assert.deepEqual(narrow.mostOrdered.map((item) => item.label), ["In-range item"]);
  assert.deepEqual(narrow.sources.map((entry) => entry.source), ["instagram"]);

  const wide = buildSalesPeriodOverview({ orders, linesByOrderId, range: resolveSalesPeriodRange({ kind: "allTime" }, NOW, MANILA) });
  assert.equal(wide.ordersPlaced, 2);
  assert.deepEqual(wide.mostOrdered.map((item) => item.label).sort(), ["In-range item", "Out-of-range item"]);
  assert.deepEqual(wide.sources.map((entry) => entry.source).sort(), ["instagram", "tiktok"]);
});

// --- Payments Received (paymentMethodBreakdown) ----------------------------------------------------

test("multiple paid orders using the same method aggregate; distinct methods stay separate and sort by amount descending with unknown last", () => {
  const orders = [
    orderWith({ id: "a", paymentStatus: "paid", paymentMethod: "gcash", paidAt: "2026-08-05T04:00:00.000Z", paidAmount: 300, placedAt: "2026-08-05T04:00:00.000Z" }),
    orderWith({ id: "b", paymentStatus: "paid", paymentMethod: "gcash", paidAt: "2026-08-06T04:00:00.000Z", paidAmount: 200, placedAt: "2026-08-06T04:00:00.000Z" }),
    orderWith({ id: "c", paymentStatus: "paid", paymentMethod: "cash", paidAt: "2026-08-06T04:00:00.000Z", paidAmount: 100, placedAt: "2026-08-06T04:00:00.000Z" }),
    orderWith({ id: "d", paymentStatus: "paid", paymentMethod: null, paidAt: "2026-08-07T04:00:00.000Z", paidAmount: 50, placedAt: "2026-08-07T04:00:00.000Z" }),
  ];
  const overview = buildSalesPeriodOverview({ orders, linesByOrderId: new Map(), range: AUGUST_WEEK });
  assert.deepEqual(overview.paymentMethodBreakdown, [
    { method: "gcash", amount: 500 },
    { method: "cash", amount: 100 },
    { method: "unknown", amount: 50 },
  ]);
});

test("a paymentMethod of null is bucketed as unknown, matching the honest-absence rule getOrderCountsBySource already applies to source", () => {
  const paid = orderWith({ id: "a", paymentStatus: "paid", paymentMethod: null, paidAt: "2026-08-05T04:00:00.000Z", paidAmount: 480, placedAt: "2026-08-05T04:00:00.000Z" });
  const overview = buildSalesPeriodOverview({ orders: [paid], linesByOrderId: new Map(), range: AUGUST_WEEK });
  assert.deepEqual(overview.paymentMethodBreakdown, [{ method: "unknown", amount: 480 }]);
});

test("an unpaid order contributes nothing to the breakdown", () => {
  const unpaid = orderWith({ id: "a", status: "new", paymentStatus: "unpaid", paymentMethod: "cash", placedAt: "2026-08-05T04:00:00.000Z" });
  const overview = buildSalesPeriodOverview({ orders: [unpaid], linesByOrderId: new Map(), range: AUGUST_WEEK });
  assert.deepEqual(overview.paymentMethodBreakdown, []);
});

test("a cancelled-but-paid order still counts in the breakdown, matching Paid revenue's own no-lifecycle-filter rule", () => {
  const cancelledPaid = orderWith({ id: "a", status: "cancelled", paymentStatus: "paid", paymentMethod: "bank_transfer", paidAt: "2026-08-08T04:00:00.000Z", paidAmount: 480, placedAt: "2026-08-08T04:00:00.000Z" });
  const overview = buildSalesPeriodOverview({ orders: [cancelledPaid], linesByOrderId: new Map(), range: AUGUST_WEEK });
  assert.deepEqual(overview.paymentMethodBreakdown, [{ method: "bank_transfer", amount: 480 }]);
});

test("a payment outside the selected range is excluded from the breakdown", () => {
  const outOfRange = orderWith({ id: "a", paymentStatus: "paid", paymentMethod: "cash", paidAt: "2026-06-01T04:00:00.000Z", paidAmount: 480, placedAt: "2026-06-01T04:00:00.000Z" });
  const overview = buildSalesPeriodOverview({ orders: [outOfRange], linesByOrderId: new Map(), range: AUGUST_WEEK });
  assert.deepEqual(overview.paymentMethodBreakdown, []);
});

test("a method with nothing paid in range is omitted, not shown as a zero row", () => {
  const paid = orderWith({ id: "a", paymentStatus: "paid", paymentMethod: "cash", paidAt: "2026-08-05T04:00:00.000Z", paidAmount: 100, placedAt: "2026-08-05T04:00:00.000Z" });
  const overview = buildSalesPeriodOverview({ orders: [paid], linesByOrderId: new Map(), range: AUGUST_WEEK });
  assert.deepEqual(overview.paymentMethodBreakdown.map((entry) => entry.method), ["cash"]);
});

test("the payment-method total reconciles exactly to grossRevenue for the same orders and range", () => {
  const orders = [
    orderWith({ id: "a", paymentStatus: "paid", paymentMethod: "gcash", paidAt: "2026-08-05T04:00:00.000Z", paidAmount: 300, placedAt: "2026-08-05T04:00:00.000Z" }),
    orderWith({ id: "b", status: "cancelled", paymentStatus: "paid", paymentMethod: "cash", paidAt: "2026-08-06T04:00:00.000Z", paidAmount: 150, placedAt: "2026-08-06T04:00:00.000Z" }),
    orderWith({ id: "c", paymentStatus: "paid", paymentMethod: null, paidAt: "2026-08-07T04:00:00.000Z", paidAmount: 40, placedAt: "2026-08-07T04:00:00.000Z" }),
    orderWith({ id: "d", status: "new", paymentStatus: "unpaid", placedAt: "2026-08-07T04:00:00.000Z" }),
  ];
  const overview = buildSalesPeriodOverview({ orders, linesByOrderId: new Map(), range: AUGUST_WEEK });
  const total = overview.paymentMethodBreakdown.reduce((sum, entry) => sum + entry.amount, 0);
  assert.equal(total, grossRevenue(orders, AUGUST_WEEK));
  assert.equal(total, overview.paidRevenue);
});

test("hasRefundedPaidOrders is true only when a refunded order's paidAt falls in the selected range, and changes no amount", () => {
  const refundedInRange = orderWith({ id: "a", paymentStatus: "refunded", paymentMethod: "gcash", paidAt: "2026-08-05T04:00:00.000Z", paidAmount: 300, refundedAt: "2026-08-06T04:00:00.000Z", placedAt: "2026-08-05T04:00:00.000Z" });
  const withRefund = buildSalesPeriodOverview({ orders: [refundedInRange], linesByOrderId: new Map(), range: AUGUST_WEEK });
  assert.equal(withRefund.hasRefundedPaidOrders, true);
  assert.deepEqual(withRefund.paymentMethodBreakdown, [{ method: "gcash", amount: 300 }], "the refund note changes visibility only, never the amount");

  const normalPaid = orderWith({ id: "b", paymentStatus: "paid", paymentMethod: "cash", paidAt: "2026-08-05T04:00:00.000Z", paidAmount: 100, placedAt: "2026-08-05T04:00:00.000Z" });
  const withoutRefund = buildSalesPeriodOverview({ orders: [normalPaid], linesByOrderId: new Map(), range: AUGUST_WEEK });
  assert.equal(withoutRefund.hasRefundedPaidOrders, false);
});

// --- Purity ------------------------------------------------------------------------------------------

test("summary.ts stays pure: no React, no Supabase client, no repository, no query, no write", () => {
  // Structural, mirroring the existing purity discipline this module already documents for
  // buildSellingSummary -- the additive code must hold the same line. Comments are stripped first:
  // this file's own prose explains the invariant using the very tokens ("Date.now()") that would
  // otherwise trip the check.
  const code = readFileSync(new URL("../src/lib/orders/summary.ts", import.meta.url), "utf8")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
  for (const forbidden of ["react", "@/components", "supabase", ".rpc(", "insert(", "upsert(", "Date.now("]) {
    assert.equal(code.includes(forbidden), false, `summary.ts must not reference ${forbidden}`);
  }
});
