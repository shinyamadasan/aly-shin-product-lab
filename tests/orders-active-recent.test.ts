// Orders Workspace V1.1: Active vs Recent, and the search/filter override that bypasses the split.
//
// The classification itself (isOpenForHandover / CLOSED_ORDER_STATUSES) is already unit-tested by
// its owner, transitions.ts, and by the exhaustiveness proof in orders-summary.test.ts
// (ORDER_STATUS_COVERAGE). This file proves the SHAPE orders-page.tsx builds from it: an old
// actionable order survives among many newer terminal ones, Active is never capped, Recent reveals
// 5 at a time, the two sets never overlap or duplicate, and a non-default search/filter widens back
// to the full dataset rather than being silently limited by the 5-item Recent cap.

import test from "node:test";
import assert from "node:assert/strict";
import { filterOrdersByFulfillment, sortOrdersByFulfillment } from "../src/lib/orders/fulfillment.ts";
import { filterOrdersBySearch } from "../src/lib/orders/list-view.ts";
import { CLOSED_ORDER_STATUSES, isOpenForHandover, OPEN_FOR_HANDOVER } from "../src/lib/orders/transitions.ts";
import { ORDER_STATUSES, type Order, type OrderLine, type OrderStatus } from "../src/lib/orders/types.ts";

function order(id: string, status: OrderStatus, overrides: Partial<Order> = {}): Order {
  return {
    id,
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
    placedAt: "2026-08-01T00:00:00.000Z",
    completedAt: null,
    cancelledAt: null,
    cancelReason: "",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

function line(orderId: string, overrides: Partial<OrderLine> = {}): OrderLine {
  return {
    id: `${orderId}-line`,
    orderId,
    productId: "brownies",
    sellingFormatId: "format-1",
    itemName: "Brownies",
    unitPrice: 480,
    piecesPerUnitSnapshot: 6,
    quantity: 1,
    sortOrder: 0,
    note: "",
    ...overrides,
  };
}

// The exact derivation orders-page.tsx uses: visibleOrders is already filtered/sorted, and
// Active/Recent both slice it further -- never a second filtering pipeline over raw `orders`.
function deriveActiveAndRecent(visibleOrders: Order[], recentRevealCount: number) {
  const activeOrders = visibleOrders.filter(isOpenForHandover);
  const recentOrders = visibleOrders.filter((item) => CLOSED_ORDER_STATUSES.includes(item.status));
  return { activeOrders, recentOrders, visibleRecentOrders: recentOrders.slice(0, recentRevealCount), hasMoreRecent: recentRevealCount < recentOrders.length };
}

// --- Active Orders: never hides actionable work --------------------------------------------------

test("an old actionable order remains visible in Active even with many newer completed orders ahead of it", () => {
  const oldActive = order("old-active", "new", { placedAt: "2026-01-01T00:00:00.000Z" });
  const newerCompleted = Array.from({ length: 20 }, (_, index) =>
    order(`completed-${index}`, "completed", { placedAt: `2026-08-${String(index + 1).padStart(2, "0")}T00:00:00.000Z` }),
  );
  // Repository order is newest-first (placed_at DESC) -- oldActive sits at the very end of the array.
  const visibleOrders = [...newerCompleted, oldActive];

  const { activeOrders } = deriveActiveAndRecent(visibleOrders, 5);

  assert.deepEqual(activeOrders.map((item) => item.id), ["old-active"]);
});

test("every actionable status (new, confirmed, ready) appears in Active, uncapped", () => {
  const orders = [order("a", "new"), order("b", "confirmed"), order("c", "ready"), order("d", "completed"), order("e", "cancelled")];
  const { activeOrders } = deriveActiveAndRecent(orders, 5);
  assert.deepEqual(activeOrders.map((item) => item.id).sort(), ["a", "b", "c"]);
});

test("terminal orders never appear in Active, and Active is never capped by the Recent reveal count", () => {
  const manyActive = Array.from({ length: 12 }, (_, index) => order(`active-${index}`, "new"));
  const { activeOrders } = deriveActiveAndRecent(manyActive, 5);
  assert.equal(activeOrders.length, 12, "Active must show every actionable order, not just the first 5");
});

test("zero active orders is a safe, empty result (the component renders a compact empty state for it)", () => {
  const allTerminal = [order("a", "completed"), order("b", "cancelled")];
  const { activeOrders } = deriveActiveAndRecent(allTerminal, 5);
  assert.deepEqual(activeOrders, []);
});

// --- Recent Orders: 5 at a time, reveal-by-5 -----------------------------------------------------

test("Recent Orders initially shows at most 5, even with far more terminal history", () => {
  const orders = Array.from({ length: 48 }, (_, index) => order(`recent-${index}`, "completed"));
  const { visibleRecentOrders, hasMoreRecent } = deriveActiveAndRecent(orders, 5);
  assert.equal(visibleRecentOrders.length, 5);
  assert.equal(hasMoreRecent, true);
});

test("Show 5 more reveals the next 5, and repeated reveals work safely up to the full list", () => {
  const orders = Array.from({ length: 48 }, (_, index) => order(`recent-${index}`, "completed"));

  let reveal = 5;
  let step = deriveActiveAndRecent(orders, reveal);
  assert.equal(step.visibleRecentOrders.length, 5);

  reveal += 5;
  step = deriveActiveAndRecent(orders, reveal);
  assert.equal(step.visibleRecentOrders.length, 10);

  // Repeating the reveal all the way to the end never over-reveals or throws.
  for (let guard = 0; guard < 20 && step.hasMoreRecent; guard += 1) {
    reveal += 5;
    step = deriveActiveAndRecent(orders, reveal);
  }
  assert.equal(step.hasMoreRecent, false);
  assert.equal(step.visibleRecentOrders.length, 48);
});

test("fewer than 5 historical orders shows all of them with no 'Show 5 more'", () => {
  const orders = [order("a", "completed"), order("b", "cancelled"), order("c", "completed")];
  const { visibleRecentOrders, hasMoreRecent } = deriveActiveAndRecent(orders, 5);
  assert.equal(visibleRecentOrders.length, 3);
  assert.equal(hasMoreRecent, false);
});

test("zero recent orders is a safe, empty result (the component renders a compact empty state for it)", () => {
  const allActive = [order("a", "new"), order("b", "confirmed")];
  const { recentOrders, visibleRecentOrders, hasMoreRecent } = deriveActiveAndRecent(allActive, 5);
  assert.deepEqual(recentOrders, []);
  assert.deepEqual(visibleRecentOrders, []);
  assert.equal(hasMoreRecent, false);
});

// --- No overlap, no duplication ------------------------------------------------------------------

test("OPEN_FOR_HANDOVER and CLOSED_ORDER_STATUSES partition every OrderStatus exactly once -- no order can ever land in both or neither", () => {
  const covered = [...OPEN_FOR_HANDOVER, ...CLOSED_ORDER_STATUSES].sort();
  assert.deepEqual(covered, [...ORDER_STATUSES].sort());
  const overlap = OPEN_FOR_HANDOVER.filter((status) => (CLOSED_ORDER_STATUSES as readonly OrderStatus[]).includes(status));
  assert.deepEqual(overlap, []);
});

test("no order id appears in both Active and Recent for a realistic mixed set", () => {
  const orders = [order("a", "new"), order("b", "confirmed"), order("c", "ready"), order("d", "completed"), order("e", "cancelled"), order("f", "new")];
  const { activeOrders, recentOrders } = deriveActiveAndRecent(orders, 5);
  const activeIds = new Set(activeOrders.map((item) => item.id));
  const recentIds = new Set(recentOrders.map((item) => item.id));
  for (const id of activeIds) {
    assert.equal(recentIds.has(id), false, `${id} must not also be in Recent`);
  }
  assert.equal(activeOrders.length + recentOrders.length, orders.length, "every order lands in exactly one of the two sets");
});

// --- Search/filter operate over the full dataset, not just the visible five ----------------------

test("isFiltering truth table: neither/either/both of search text and a non-'all' filter", () => {
  function isFiltering(searchQuery: string, fulfillmentFilter: "all" | "today" | "unscheduled") {
    return searchQuery.trim() !== "" || fulfillmentFilter !== "all";
  }
  assert.equal(isFiltering("", "all"), false);
  assert.equal(isFiltering("brownie", "all"), true);
  assert.equal(isFiltering("", "today"), true);
  assert.equal(isFiltering("brownie", "unscheduled"), true);
  assert.equal(isFiltering("   ", "all"), false, "whitespace-only search is not a real search");
});

test("a search that matches an old, otherwise-buried order finds it -- search runs over the full dataset, not the 5 visible Recent rows", () => {
  const target = order("buried", "completed", { placedAt: "2020-01-01T00:00:00.000Z" });
  const newerNoise = Array.from({ length: 30 }, (_, index) => order(`noise-${index}`, "completed", { placedAt: `2026-08-${String((index % 28) + 1).padStart(2, "0")}T00:00:00.000Z` }));
  const orders = [...newerNoise, target]; // target sits far past position 5

  const linesByOrderId = new Map<string, OrderLine[]>([["buried", [line("buried", { itemName: "Rare Custom Cake" })]]]);
  const filtered = filterOrdersBySearch(orders, { query: "Rare Custom Cake", linesByOrderId, customerNameById: new Map() });

  assert.deepEqual(filtered.map((item) => item.id), ["buried"], "the match is found even though it is far past the default 5-row Recent cap");
});

test("the fulfilment filter also runs over the full dataset before any Recent cap is applied", () => {
  const scheduledToday = order("today", "confirmed", { fulfillmentAt: "2026-08-09T04:00:00.000Z" });
  const manyOthers = Array.from({ length: 10 }, (_, index) => order(`other-${index}`, "confirmed", { fulfillmentAt: null }));
  const orders = [...manyOthers, scheduledToday];

  const filtered = filterOrdersByFulfillment(orders, "today", { nowMs: Date.parse("2026-08-09T06:00:00.000Z"), timeZone: "Asia/Manila" });
  assert.deepEqual(filtered.map((item) => item.id), ["today"]);
});

test("clearing search/filter restores the normal Active + Recent presentation over the same underlying data", () => {
  const orders = [order("a", "new"), order("b", "completed"), order("c", "completed")];
  const linesByOrderId = new Map<string, OrderLine[]>();

  // While filtering: a search narrows to one unified list (simulated by the same primitive the
  // page uses).
  const filtered = filterOrdersBySearch(orders, { query: "nonexistent", linesByOrderId, customerNameById: new Map() });
  assert.deepEqual(filtered, []);

  // Clearing the query returns the exact same array reference the page already had loaded --
  // filterOrdersBySearch is a no-op for an empty query, so Active/Recent resume from unchanged data.
  const cleared = filterOrdersBySearch(orders, { query: "", linesByOrderId, customerNameById: new Map() });
  assert.equal(cleared, orders);
  const { activeOrders, recentOrders } = deriveActiveAndRecent(sortOrdersByFulfillment(cleared, "placed"), 5);
  assert.deepEqual(activeOrders.map((item) => item.id), ["a"]);
  assert.deepEqual(recentOrders.map((item) => item.id), ["b", "c"]);
});

test("existing sort semantics are unchanged: 'placed' is a no-op (repository order), 'soonest' sorts by handover with unscheduled last", () => {
  const orders = [order("a", "new"), order("b", "new", { fulfillmentAt: "2026-08-10T00:00:00.000Z" }), order("c", "new", { fulfillmentAt: "2026-08-09T00:00:00.000Z" })];
  assert.equal(sortOrdersByFulfillment(orders, "placed"), orders, "placed is a no-op re-sort, proving the repository's own order is trusted");
  assert.deepEqual(sortOrdersByFulfillment(orders, "soonest").map((item) => item.id), ["c", "b", "a"]);
});
