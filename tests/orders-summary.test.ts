// S7 PR-G1: the Selling operational readout's regression suite.
//
// Two classes of test live here, and the second is the reason the file is long.
//
// The first class proves each metric counts what its label says. The second proves the readout
// cannot quietly become a DIFFERENT report than the one that was reviewed -- that a bake list never
// contains orders nobody agreed to bake, that three distinct hand-typed items never collapse into
// one row, that "due today" never counts work already finished, and above all that no lifecycle
// filter can reach revenue. Each of those was a real defect in an earlier draft of this plan, and
// each would have shipped a number that looked authoritative and was wrong.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildSellingSummary, ORDER_STATUS_COVERAGE, resolveRollingWeekRange, resolveTodayRange, type MostOrderedItem } from "../src/lib/orders/summary.ts";
import { grossRevenue, netRevenue, refunds } from "../src/lib/orders/revenue.ts";
import { ORDER_STATUSES, type Order, type OrderLine, type OrderStatus } from "../src/lib/orders/types.ts";

const MANILA = "Asia/Manila";

// 2026-08-08 12:00 Manila = 04:00Z. Mid-day, so nothing in these tests depends on being near a
// boundary except the tests that deliberately sit on one.
const NOW = Date.parse("2026-08-08T04:00:00.000Z");
const TODAY = "2026-08-08";

// Instants chosen by the Manila day they land in, not by their UTC text.
const TODAY_NOON = "2026-08-08T04:00:00.000Z";
const YESTERDAY_NOON = "2026-08-07T04:00:00.000Z";
const TOMORROW_NOON = "2026-08-09T04:00:00.000Z";
const LAST_MONTH = "2026-07-04T04:00:00.000Z";

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
    placedAt: TODAY_NOON,
    completedAt: null,
    cancelledAt: null,
    cancelReason: "",
    createdAt: TODAY_NOON,
    updatedAt: TODAY_NOON,
    ...overrides,
  };
}

function lineWith(overrides: Partial<OrderLine> = {}): OrderLine {
  return {
    id: "line-1",
    orderId: "order-1",
    productId: "product-brownies",
    sellingFormatId: "format-box-6",
    itemName: "Biscoff Blondie",
    unitPrice: 480,
    piecesPerUnitSnapshot: 6,
    quantity: 1,
    sortOrder: 0,
    note: "",
    ...overrides,
  };
}

function summarize(orders: Order[], lines: OrderLine[] = [], nowMs = NOW) {
  const linesByOrderId = new Map<string, OrderLine[]>();
  for (const line of lines) {
    const existing = linesByOrderId.get(line.orderId);
    if (existing) {
      existing.push(line);
    } else {
      linesByOrderId.set(line.orderId, [line]);
    }
  }
  return buildSellingSummary({ orders, linesByOrderId, nowMs, timeZone: MANILA });
}

// --- Lifecycle sets -------------------------------------------------------------------------------

test("the open-for-handover set is stated by meaning and covers every status exactly once", () => {
  // Pinned against ORDER_STATUSES so adding a sixth status is a deliberate decision here rather
  // than a silent default into one group. The set is written out rather than derived from
  // getAllowedOrderTransitions: "can still move" and "still needs handing over" agree today, but a
  // correction transition out of `completed` would make the derived form start counting finished
  // work as outstanding.
  const { openForHandover, closed } = ORDER_STATUS_COVERAGE;
  assert.deepEqual([...openForHandover], ["new", "confirmed", "ready"]);
  assert.deepEqual([...closed], ["completed", "cancelled"]);

  const combined = [...openForHandover, ...closed].sort();
  assert.deepEqual(combined, [...ORDER_STATUSES].sort(), "every OrderStatus must be classified");
  assert.equal(new Set(combined).size, combined.length, "no status may be in both sets");
});

// --- Ready for handover (restored frozen requirement) ---------------------------------------------

test("a ready order appears in ready-for-handover regardless of its scheduled date", () => {
  // `ready` means made and packed, waiting for the customer. It has no date window at all: the box
  // is on the counter whether the agreed pickup was yesterday, is today, is next week, or was never
  // agreed. Adding a window here would hide the oldest staged work, which is the most urgent.
  for (const fulfillmentAt of [YESTERDAY_NOON, TODAY_NOON, TOMORROW_NOON, null]) {
    const summary = summarize([orderWith({ status: "ready", fulfillmentAt })]);
    assert.equal(summary.attention.readyForHandover, 1, `ready with fulfillmentAt=${fulfillmentAt} must count`);
  }
});

test("completed and cancelled orders never appear in ready-for-handover", () => {
  const summary = summarize([
    orderWith({ id: "a", status: "completed", fulfillmentAt: TODAY_NOON }),
    orderWith({ id: "b", status: "cancelled", fulfillmentAt: TODAY_NOON }),
    orderWith({ id: "c", status: "new" }),
    orderWith({ id: "d", status: "confirmed" }),
  ]);
  assert.equal(summary.attention.readyForHandover, 0);
});

test("ready-for-handover ignores payment state entirely", () => {
  // A ready order may be unpaid, paid, or refunded. None of that changes whether it is waiting to
  // be handed over, so none of it may filter this count.
  const summary = summarize([
    orderWith({ id: "a", status: "ready", paymentStatus: "unpaid" }),
    orderWith({ id: "b", status: "ready", paymentStatus: "paid", paidAt: TODAY_NOON, paidAmount: 480, paymentMethod: "cash" }),
    orderWith({ id: "c", status: "ready", paymentStatus: "refunded", paidAt: LAST_MONTH, paidAmount: 480, refundedAt: TODAY_NOON }),
  ]);
  assert.equal(summary.attention.readyForHandover, 3);
});

// --- Scheduling is not baking ---------------------------------------------------------------------

test("a confirmed unscheduled order needs scheduling, and is NOT on today's bake list", () => {
  // The correction this suite exists to lock down. "We committed to this order" and "bake this
  // today" are different facts, and only the first is recorded. Treating an unscheduled order as
  // due today asserts a bake decision the data does not support.
  const summary = summarize([orderWith({ status: "confirmed", fulfillmentAt: null })], [lineWith()]);

  assert.equal(summary.attention.needsScheduling, 1);
  assert.equal(summary.toPrepareToday.groups.length, 0, "an unscheduled order must not reach the bake list");
});

test("a confirmed order scheduled for today IS on today's bake list", () => {
  const summary = summarize([orderWith({ status: "confirmed", fulfillmentAt: TODAY_NOON })], [lineWith({ quantity: 3 })]);

  assert.equal(summary.attention.needsScheduling, 0, "a scheduled order does not need scheduling");
  assert.equal(summary.toPrepareToday.groups.length, 1);
  assert.equal(summary.toPrepareToday.groups[0]?.units, 3);
  assert.equal(summary.toPrepareToday.groups[0]?.pieces, 18);
});

test("orders scheduled for other days, and non-confirmed orders, stay off the bake list", () => {
  const summary = summarize(
    [
      orderWith({ id: "a", status: "confirmed", fulfillmentAt: TOMORROW_NOON }),
      orderWith({ id: "b", status: "confirmed", fulfillmentAt: YESTERDAY_NOON }),
      // Scheduled today but not yet confirmed -- no commitment to bake it exists.
      orderWith({ id: "c", status: "new", fulfillmentAt: TODAY_NOON }),
      // Already made.
      orderWith({ id: "d", status: "ready", fulfillmentAt: TODAY_NOON }),
      orderWith({ id: "e", status: "completed", fulfillmentAt: TODAY_NOON }),
      orderWith({ id: "f", status: "cancelled", fulfillmentAt: TODAY_NOON }),
    ],
    ["a", "b", "c", "d", "e", "f"].map((orderId) => lineWith({ id: `line-${orderId}`, orderId })),
  );

  assert.equal(summary.toPrepareToday.groups.length, 0);
});

// --- Remaining handovers today ---------------------------------------------------------------------

test("remaining handovers today counts open orders only, and excludes finished work", () => {
  const summary = summarize([
    orderWith({ id: "a", status: "new", fulfillmentAt: TODAY_NOON }),
    orderWith({ id: "b", status: "confirmed", fulfillmentAt: TODAY_NOON }),
    orderWith({ id: "c", status: "ready", fulfillmentAt: TODAY_NOON }),
    orderWith({ id: "d", status: "completed", fulfillmentAt: TODAY_NOON }),
    orderWith({ id: "e", status: "cancelled", fulfillmentAt: TODAY_NOON }),
  ]);

  // new + confirmed + ready. Calling a number "remaining" while counting completed work would
  // mislabel it, which is why the all-day workload variant is deliberately not built.
  assert.equal(summary.today.remainingHandovers, 3);
});

test("an order scheduled for another day is not a remaining handover today", () => {
  const summary = summarize([
    orderWith({ id: "a", status: "confirmed", fulfillmentAt: TOMORROW_NOON }),
    orderWith({ id: "b", status: "confirmed", fulfillmentAt: YESTERDAY_NOON }),
    orderWith({ id: "c", status: "confirmed", fulfillmentAt: null }),
  ]);
  assert.equal(summary.today.remainingHandovers, 0);
});

test("a new order due today is both an attention item and a remaining handover", () => {
  // Deliberate. It cannot reach `completed` without being confirmed first, which makes it the most
  // urgent kind of remaining handover -- two rows answering two questions, not one double-count.
  const summary = summarize([orderWith({ status: "new", fulfillmentAt: TODAY_NOON })]);
  assert.equal(summary.attention.newAwaitingConfirmation, 1);
  assert.equal(summary.today.remainingHandovers, 1);
});

// --- Overdue ---------------------------------------------------------------------------------------

test("overdue compares business days, so an order due later today is not yet overdue", () => {
  // 2026-08-08 23:00 Manila = 15:00Z, still today, and "now" is noon. An instant comparison would
  // call this fine now and overdue at 23:01; a business-day comparison keeps it off the list all
  // day and flags it tomorrow if it is still open.
  const laterToday = summarize([orderWith({ status: "confirmed", fulfillmentAt: "2026-08-08T15:00:00.000Z" })]);
  assert.equal(laterToday.attention.overdueHandovers, 0);

  const yesterday = summarize([orderWith({ status: "confirmed", fulfillmentAt: YESTERDAY_NOON })]);
  assert.equal(yesterday.attention.overdueHandovers, 1);
});

test("a closed or unscheduled order is never overdue", () => {
  const summary = summarize([
    orderWith({ id: "a", status: "completed", fulfillmentAt: YESTERDAY_NOON }),
    orderWith({ id: "b", status: "cancelled", fulfillmentAt: YESTERDAY_NOON }),
    orderWith({ id: "c", status: "confirmed", fulfillmentAt: null }),
  ]);
  assert.equal(summary.attention.overdueHandovers, 0);
});

// --- Preparation grouping ----------------------------------------------------------------------------
//
// productId === "" does NOT mean "typed by hand". It means "no product link right now", and covers
// both a genuinely manual line and a catalog line whose product was later DELETED -- order_lines
// .product_id is `on delete set null` and the mapper turns that null into "". Both keep their frozen
// itemName, so both group by it.

test("two different unlinked item names remain two separate groups", () => {
  // The defect this replaces: grouping by productId put every unlinked line into one bucket, so
  // "Brownie Tray", "Coffee Box" and "Custom Gift Pack" all became a single row called "Custom item".
  const summary = summarize(
    [orderWith({ status: "confirmed", fulfillmentAt: TODAY_NOON })],
    [
      lineWith({ id: "l1", productId: "", sellingFormatId: "", itemName: "Brownie Tray", piecesPerUnitSnapshot: null, quantity: 1 }),
      lineWith({ id: "l2", productId: "", sellingFormatId: "", itemName: "Coffee Box", piecesPerUnitSnapshot: null, quantity: 1 }),
      lineWith({ id: "l3", productId: "", sellingFormatId: "", itemName: "Custom Gift Pack", piecesPerUnitSnapshot: null, quantity: 1 }),
    ],
  );

  const labels = summary.toPrepareToday.groups.map((group) => group.label).sort();
  assert.deepEqual(labels, ["Brownie Tray", "Coffee Box", "Custom Gift Pack"]);
  assert.equal(summary.toPrepareToday.groups.every((group) => group.kind === "manual"), true);
});

test("repeated unlinked lines sharing a frozen name aggregate into one group", () => {
  const summary = summarize(
    [orderWith({ id: "a", status: "confirmed", fulfillmentAt: TODAY_NOON }), orderWith({ id: "b", status: "confirmed", fulfillmentAt: TODAY_NOON })],
    [
      lineWith({ id: "l1", orderId: "a", productId: "", sellingFormatId: "", itemName: "Brownie Tray", piecesPerUnitSnapshot: 12, quantity: 2 }),
      lineWith({ id: "l2", orderId: "b", productId: "", sellingFormatId: "", itemName: "Brownie Tray", piecesPerUnitSnapshot: 12, quantity: 3 }),
    ],
  );

  assert.equal(summary.toPrepareToday.groups.length, 1);
  assert.equal(summary.toPrepareToday.groups[0]?.label, "Brownie Tray");
  assert.equal(summary.toPrepareToday.groups[0]?.units, 5);
  assert.equal(summary.toPrepareToday.groups[0]?.pieces, 60);
});

test("names are trimmed but not case-folded", () => {
  // Trimming restates what buildManualOrderLine already does at construction. Folding case would
  // assert that "Brownie Tray" and "brownie tray" are the same item -- the operator's judgement,
  // not this module's.
  const summary = summarize(
    [orderWith({ status: "confirmed", fulfillmentAt: TODAY_NOON })],
    [
      lineWith({ id: "l1", productId: "", sellingFormatId: "", itemName: "Brownie Tray", quantity: 1 }),
      lineWith({ id: "l2", productId: "", sellingFormatId: "", itemName: "  Brownie Tray  ", quantity: 1 }),
      lineWith({ id: "l3", productId: "", sellingFormatId: "", itemName: "brownie tray", quantity: 1 }),
    ],
  );

  const groups = summary.toPrepareToday.groups;
  assert.equal(groups.length, 2, "whitespace merges; case does not");
  assert.equal(groups.find((group) => group.label === "Brownie Tray")?.units, 2);
  assert.equal(groups.find((group) => group.label === "brownie tray")?.units, 1);
});

test("a catalog group and an unlinked group with the same text never collide", () => {
  const summary = summarize(
    [orderWith({ status: "confirmed", fulfillmentAt: TODAY_NOON })],
    [
      lineWith({ id: "l1", productId: "product-brownies", itemName: "Biscoff Blondie", quantity: 2 }),
      lineWith({ id: "l2", productId: "", sellingFormatId: "", itemName: "Biscoff Blondie", piecesPerUnitSnapshot: null, quantity: 1 }),
    ],
  );

  const groups = summary.toPrepareToday.groups;
  assert.equal(groups.length, 2, "same label, different records -- never merged");
  assert.deepEqual(groups.map((group) => group.kind).sort(), ["catalog", "manual"]);
  assert.equal(new Set(groups.map((group) => group.key)).size, 2, "keys must be distinct");
  assert.equal(groups.find((group) => group.kind === "catalog")?.units, 2);
  assert.equal(groups.find((group) => group.kind === "manual")?.units, 1);
});

test("a line whose product was deleted keeps its frozen name instead of becoming Custom item", () => {
  // product_id is `on delete set null`, and mapOrderLineRow maps null to "". A deleted product's
  // whole order history therefore arrives here unlinked -- and must not lose its identity.
  const summary = summarize(
    [orderWith({ status: "confirmed", fulfillmentAt: TODAY_NOON })],
    [lineWith({ productId: "", sellingFormatId: "", itemName: "Biscoff Blondie", piecesPerUnitSnapshot: 6, quantity: 2 })],
  );

  assert.equal(summary.toPrepareToday.groups[0]?.label, "Biscoff Blondie");
  assert.equal(summary.toPrepareToday.groups[0]?.pieces, 12, "the frozen pack size still applies");
});

test("a blank frozen name groups as Unnamed item without inventing product identity", () => {
  // Unreachable through the app -- validateOrderForSave rejects a blank name -- but item_name is
  // `text not null`, which still permits "". Such a row is counted, never silently dropped, and
  // never merged into a named group.
  const summary = summarize(
    [orderWith({ status: "confirmed", fulfillmentAt: TODAY_NOON })],
    [
      lineWith({ id: "l1", productId: "", sellingFormatId: "", itemName: "", piecesPerUnitSnapshot: null, quantity: 1 }),
      lineWith({ id: "l2", productId: "", sellingFormatId: "", itemName: "   ", piecesPerUnitSnapshot: null, quantity: 1 }),
      lineWith({ id: "l3", productId: "", sellingFormatId: "", itemName: "Brownie Tray", piecesPerUnitSnapshot: null, quantity: 1 }),
    ],
  );

  const unnamed = summary.toPrepareToday.groups.filter((group) => group.label === "Unnamed item");
  assert.equal(unnamed.length, 1, "all blank names collapse into exactly one group");
  assert.equal(unnamed[0]?.units, 2);
  assert.equal(unnamed[0]?.key, "manual:", "keyed by the empty name, not by a fabricated product id");
  assert.equal(summary.toPrepareToday.groups.some((group) => group.label === "Brownie Tray"), true);
});

test("a null pieces snapshot stays unknown and is never counted as 0 or 1", () => {
  const summary = summarize(
    [orderWith({ status: "confirmed", fulfillmentAt: TODAY_NOON })],
    [
      lineWith({ id: "l1", productId: "product-a", itemName: "Known", piecesPerUnitSnapshot: 6, quantity: 2 }),
      lineWith({ id: "l2", productId: "product-a", itemName: "Known", piecesPerUnitSnapshot: null, quantity: 5 }),
      lineWith({ id: "l3", productId: "", sellingFormatId: "", itemName: "Mystery Tray", piecesPerUnitSnapshot: null, quantity: 4 }),
    ],
  );

  const catalog = summary.toPrepareToday.groups.find((group) => group.kind === "catalog");
  // 2 x 6 = 12. The 5 unknown units contribute NOTHING to pieces -- had they been treated as 1
  // piece each the answer would be 17, and as 0 the line would vanish.
  assert.equal(catalog?.pieces, 12);
  assert.equal(catalog?.units, 7, "units are always exact");
  assert.equal(catalog?.piecesUnknownLines, 1);

  const manual = summary.toPrepareToday.groups.find((group) => group.kind === "manual");
  assert.equal(manual?.pieces, 0);
  assert.equal(manual?.piecesUnknownLines, 1, "the unknown rule applies in the unlinked branch too");

  assert.equal(summary.toPrepareToday.piecesUnknownLines, 2, "totalled across groups for the caller");
});

// --- Revenue ------------------------------------------------------------------------------------------

test("a cancelled paid order still counts as gross revenue", () => {
  // No lifecycle filter reaches revenue. The money really was received, and it stays received until
  // an actual refund is recorded. Cancelling changes what you are OWED, never what you RECEIVED.
  const summary = summarize([
    orderWith({ id: "a", status: "cancelled", cancelledAt: TODAY_NOON, paymentStatus: "paid", paidAt: TODAY_NOON, paidAmount: 480, paymentMethod: "gcash" }),
  ]);

  assert.equal(summary.today.grossRevenue, 480);
  assert.equal(summary.week.grossRevenue, 480);
  assert.equal(summary.attention.unpaidValue, 0, "but it is not a receivable");
});

test("a refund lands in the refund period and leaves the original gross untouched", () => {
  const summary = summarize([
    orderWith({ id: "a", status: "completed", paymentStatus: "refunded", paidAt: LAST_MONTH, paidAmount: 480, refundedAt: TODAY_NOON }),
  ]);

  // Paid in July, refunded today: today shows the refund, and today's gross is untouched by it.
  assert.equal(summary.today.grossRevenue, 0, "the payment belongs to July, not today");
  assert.equal(summary.today.refunds, 480);
  assert.equal(summary.today.netRevenue, -480);

  // July's gross is immutable: paidAt is never cleared by a refund.
  const july = summarize(
    [orderWith({ id: "a", status: "completed", paymentStatus: "refunded", paidAt: LAST_MONTH, paidAmount: 480, refundedAt: TODAY_NOON })],
    [],
    Date.parse(LAST_MONTH),
  );
  assert.equal(july.today.grossRevenue, 480, "an earlier period's gross must not be rewritten");
  assert.equal(july.today.refunds, 0);
});

test("editing line prices cannot move paid revenue by a centavo", () => {
  // Revenue sums the frozen paidAmount and never reads a line. Same order, wildly different lines.
  const order = orderWith({ status: "completed", paymentStatus: "paid", paidAt: TODAY_NOON, paidAmount: 480, paymentMethod: "cash" });

  const asPaid = summarize([order], [lineWith({ unitPrice: 480, quantity: 1 })]);
  const afterEdit = summarize([order], [lineWith({ unitPrice: 99_999, quantity: 7 })]);
  const withNoLines = summarize([order], []);

  assert.equal(asPaid.today.grossRevenue, 480);
  assert.equal(afterEdit.today.grossRevenue, 480);
  assert.equal(withNoLines.today.grossRevenue, 480, "revenue survives its lines being emptied");
});

test("net revenue comes through the canonical netRevenue helper, not local arithmetic", () => {
  // Pinned against revenue.ts directly. `gross - refunds` is the same arithmetic today, so this
  // test is not about the number -- it is about the number having ONE definition. If netRevenue's
  // contract ever changes (a rounding rule, a currency unit, an ordering of operations), the
  // summary must move with it rather than keep quietly returning the old answer.
  const orders = [
    // Paid today, still open.
    orderWith({ id: "a", paymentStatus: "paid", paidAt: TODAY_NOON, paidAmount: 480, paymentMethod: "cash" }),
    // Paid today and refunded today: both sides land in the same window.
    orderWith({ id: "b", paymentStatus: "refunded", paidAt: TODAY_NOON, paidAmount: 300, refundedAt: TODAY_NOON }),
    // Paid last month, refunded today: only the refund is in today's window.
    orderWith({ id: "c", paymentStatus: "refunded", paidAt: LAST_MONTH, paidAmount: 200, refundedAt: TODAY_NOON }),
    // Paid yesterday: inside the week, outside today.
    orderWith({ id: "d", paymentStatus: "paid", paidAt: YESTERDAY_NOON, paidAmount: 150, paymentMethod: "gcash" }),
  ];
  const summary = summarize(orders);

  const todayRange = resolveTodayRange(NOW, MANILA);
  const weekRange = resolveRollingWeekRange(NOW, MANILA);

  assert.equal(summary.today.netRevenue, netRevenue(orders, todayRange));
  assert.equal(summary.week.netRevenue, netRevenue(orders, weekRange));

  // And the three exposed values stay mutually consistent, since the readout shows gross always and
  // refunds/net only when refunds are non-zero.
  assert.equal(summary.today.grossRevenue, grossRevenue(orders, todayRange));
  assert.equal(summary.today.refunds, refunds(orders, todayRange));
  assert.equal(summary.today.netRevenue, summary.today.grossRevenue - summary.today.refunds);
  assert.equal(summary.week.netRevenue, summary.week.grossRevenue - summary.week.refunds);

  // Concrete, so a silent sign flip or a swapped range cannot pass: today gross 780, refunds 500.
  assert.equal(summary.today.grossRevenue, 780);
  assert.equal(summary.today.refunds, 500);
  assert.equal(summary.today.netRevenue, 280);
});

test("unpaid value is a receivable: cancelled orders are excluded, current lines are read", () => {
  const summary = summarize(
    [
      orderWith({ id: "a", status: "confirmed", paymentStatus: "unpaid" }),
      orderWith({ id: "b", status: "cancelled", paymentStatus: "unpaid" }),
    ],
    [lineWith({ id: "l1", orderId: "a", unitPrice: 480, quantity: 2 }), lineWith({ id: "l2", orderId: "b", unitPrice: 900, quantity: 1 })],
  );

  assert.equal(summary.attention.unpaidCount, 1, "the cancelled order is not owed");
  assert.equal(summary.attention.unpaidValue, 960);
  assert.equal(summary.today.grossRevenue, 0, "a receivable is never revenue");
});

// --- Manila windows -------------------------------------------------------------------------------------

test("the Manila boundary decides the day, not UTC", () => {
  // 16:30Z on the 7th is 00:30 on the 8th in Manila. Under UTC this payment would be filed a day
  // early -- the exact off-by-one the business-day helper exists to prevent.
  const justAfterMidnight = summarize([orderWith({ paymentStatus: "paid", paidAt: "2026-08-07T16:30:00.000Z", paidAmount: 100, paymentMethod: "cash" })]);
  assert.equal(justAfterMidnight.today.businessDay, TODAY);
  assert.equal(justAfterMidnight.today.grossRevenue, 100, "00:30 Manila on the 8th is today");

  // 15:30Z on the 7th is 23:30 on the 7th in Manila -- still yesterday.
  const justBeforeMidnight = summarize([orderWith({ paymentStatus: "paid", paidAt: "2026-08-07T15:30:00.000Z", paidAmount: 100, paymentMethod: "cash" })]);
  assert.equal(justBeforeMidnight.today.grossRevenue, 0, "23:30 Manila on the 7th is not today");
  assert.equal(justBeforeMidnight.week.grossRevenue, 100, "but it is inside the rolling week");
});

test("the rolling window is exactly seven business days, inclusive at both ends", () => {
  const range = resolveRollingWeekRange(NOW, MANILA);
  assert.equal(range.toDay, TODAY);
  assert.equal(range.fromDay, "2026-08-02");
  assert.equal(range.timezone, MANILA);

  // Count the days inclusively: 02..08 is seven.
  const days = (Date.parse(`${range.toDay}T00:00:00Z`) - Date.parse(`${range.fromDay}T00:00:00Z`)) / 86_400_000 + 1;
  assert.equal(days, 7);

  // The far edge is included and the day before it is not.
  const onEdge = summarize([orderWith({ placedAt: "2026-08-02T04:00:00.000Z" })]);
  assert.equal(onEdge.week.ordersPlaced, 1);
  const justOutside = summarize([orderWith({ placedAt: "2026-08-01T04:00:00.000Z" })]);
  assert.equal(justOutside.week.ordersPlaced, 0);
});

test("today's range is a single Manila day", () => {
  const range = resolveTodayRange(NOW, MANILA);
  assert.equal(range.fromDay, TODAY);
  assert.equal(range.toDay, TODAY);
});

// --- Intake, mix and sources -------------------------------------------------------------------------------

test("orders placed counts intake, including orders later cancelled", () => {
  // An order that arrived and was cancelled still arrived. The caller labels this "orders placed",
  // never "orders", so the number reads as what it measures.
  const summary = summarize([
    orderWith({ id: "a", placedAt: TODAY_NOON }),
    orderWith({ id: "b", placedAt: TODAY_NOON, status: "cancelled" }),
    orderWith({ id: "c", placedAt: YESTERDAY_NOON }),
    orderWith({ id: "d", placedAt: LAST_MONTH }),
  ]);

  assert.equal(summary.today.ordersPlaced, 2);
  assert.equal(summary.week.ordersPlaced, 3, "last month is outside the rolling week");
});

test("most ordered ranks by selling units and excludes cancelled orders", () => {
  const summary = summarize(
    [
      orderWith({ id: "a", placedAt: TODAY_NOON }),
      orderWith({ id: "b", placedAt: YESTERDAY_NOON }),
      orderWith({ id: "c", placedAt: TODAY_NOON, status: "cancelled" }),
    ],
    [
      lineWith({ id: "l1", orderId: "a", productId: "product-brownies", itemName: "Biscoff Blondie", quantity: 5 }),
      lineWith({ id: "l2", orderId: "b", productId: "product-brownies", itemName: "Biscoff Blondie", quantity: 4 }),
      lineWith({ id: "l3", orderId: "a", productId: "product-cookies", itemName: "Cookies", quantity: 2 }),
      // A cancelled order did not sell.
      lineWith({ id: "l4", orderId: "c", productId: "product-cookies", itemName: "Cookies", quantity: 99 }),
    ],
  );

  assert.equal(summary.mostOrdered.length, 2);
  assert.deepEqual(summary.mostOrdered[0], { key: "product:product-brownies", label: "Biscoff Blondie", units: 9 });
  assert.equal(summary.mostOrdered[1]?.units, 2, "the cancelled order's 99 units are excluded");
});

test("sources count demand, so a cancelled order still counts toward its channel", () => {
  // Deliberately the opposite of most-ordered: a cancelled order did not sell, but it did still
  // come from Instagram. The two rows answer different questions.
  const summary = summarize([
    orderWith({ id: "a", source: "instagram", placedAt: TODAY_NOON }),
    orderWith({ id: "b", source: "instagram", placedAt: TODAY_NOON, status: "cancelled" }),
    orderWith({ id: "c", source: "facebook", placedAt: YESTERDAY_NOON }),
    orderWith({ id: "d", source: "unknown", placedAt: TODAY_NOON }),
    orderWith({ id: "e", source: "instagram", placedAt: LAST_MONTH }),
  ]);

  assert.deepEqual(summary.sources, [
    { source: "instagram", count: 2 },
    { source: "facebook", count: 1 },
    // "unknown" is counted explicitly and sorts last: hiding it would make the named channels look
    // more complete than they are.
    { source: "unknown", count: 1 },
  ]);
});

// --- Empty and degenerate data --------------------------------------------------------------------------

test("an empty order set produces a well-formed summary of zeroes", () => {
  const summary = summarize([]);

  assert.equal(summary.attention.newAwaitingConfirmation, 0);
  assert.equal(summary.attention.needsScheduling, 0);
  assert.equal(summary.attention.readyForHandover, 0);
  assert.equal(summary.attention.unpaidCount, 0);
  assert.equal(summary.attention.unpaidValue, 0);
  assert.equal(summary.attention.overdueHandovers, 0);
  assert.equal(summary.today.businessDay, TODAY);
  assert.equal(summary.today.remainingHandovers, 0);
  assert.equal(summary.today.netRevenue, 0);
  assert.equal(summary.week.netRevenue, 0);
  assert.deepEqual(summary.toPrepareToday.groups, []);
  assert.equal(summary.toPrepareToday.piecesUnknownLines, 0);
  assert.deepEqual(summary.mostOrdered, []);
  assert.deepEqual(summary.sources, []);
});

test("no metric is ever NaN or Infinity, including on malformed timestamps", () => {
  const summary = summarize(
    [
      orderWith({ id: "a", placedAt: "not-a-date", fulfillmentAt: "also-not-a-date", paymentStatus: "paid", paidAt: "nonsense", paidAmount: 480 }),
      orderWith({ id: "b", status: "confirmed", fulfillmentAt: "", paymentStatus: "unpaid" }),
    ],
    [lineWith({ id: "l1", orderId: "b", unitPrice: 480, quantity: 2 })],
  );

  const numbers = [
    summary.attention.newAwaitingConfirmation,
    summary.attention.needsScheduling,
    summary.attention.readyForHandover,
    summary.attention.unpaidCount,
    summary.attention.unpaidValue,
    summary.attention.overdueHandovers,
    summary.today.ordersPlaced,
    summary.today.remainingHandovers,
    summary.today.grossRevenue,
    summary.today.refunds,
    summary.today.netRevenue,
    summary.week.ordersPlaced,
    summary.week.grossRevenue,
    summary.week.refunds,
    summary.week.netRevenue,
    summary.toPrepareToday.piecesUnknownLines,
  ];

  for (const value of numbers) {
    assert.equal(Number.isFinite(value), true, `expected a finite number, got ${value}`);
  }
  // An unparseable timestamp is outside every window rather than an error, matching revenue.ts.
  assert.equal(summary.today.grossRevenue, 0);
  assert.equal(summary.attention.overdueHandovers, 0);
});

test("the same inputs always produce the same output", () => {
  const orders = [
    orderWith({ id: "a", status: "ready", fulfillmentAt: TODAY_NOON }),
    orderWith({ id: "b", status: "confirmed", fulfillmentAt: TODAY_NOON }),
  ];
  const lines = [
    lineWith({ id: "l1", orderId: "b", productId: "p1", itemName: "A", quantity: 2 }),
    lineWith({ id: "l2", orderId: "b", productId: "", sellingFormatId: "", itemName: "B", quantity: 2 }),
  ];
  assert.deepEqual(summarize(orders, lines), summarize(orders, lines));
});

// --- Structural: purity is a property, not an intention -------------------------------------------------

test("summary.ts holds no client, no repository, no React, and no clock", () => {
  const source = readFileSync(new URL("../src/lib/orders/summary.ts", import.meta.url), "utf8");
  // Comments explain these very prohibitions, so assertions run against code only. This is the
  // same convention orders-schema.test.ts established after prose repeatedly tripped the greps.
  const code = source
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");

  for (const forbidden of ["react", "supabase", "orders-repository", "@/components", "bake-", "stock-adjustment", "inventory-"]) {
    assert.equal(code.includes(forbidden), false, `summary.ts must not reference ${forbidden}`);
  }

  // The clock is injected. Reading one here would make the same inputs produce different outputs.
  assert.equal(/Date\.now\(\)/.test(code), false, "nowMs is a parameter");
  assert.equal(code.includes("getToday"), false, "getToday() is UTC and forbidden in Selling code");
  // No write path, no query.
  for (const forbidden of ["saveOrder", "submitNewOrder", "updateOrderStatus", "updatePaymentStatus", ".rpc(", "insert(", "upsert("]) {
    assert.equal(code.includes(forbidden), false, `summary.ts must not reference ${forbidden}`);
  }
  // A PostgREST query is always `.from("<table>")`. Matched with the opening quote so the check
  // targets a table read rather than Array.from(...), which is ordinary iteration and legitimate.
  assert.equal(/\.from\(\s*["'`]/.test(code), false, "summary.ts must not query a table");
});

test("summary.ts composes the existing helpers rather than reimplementing them", () => {
  const source = readFileSync(new URL("../src/lib/orders/summary.ts", import.meta.url), "utf8");
  // Delegation is the point: if a number here disagrees with revenue.ts, this file is wrong.
  for (const helper of ["grossRevenue", "refunds", "netRevenue", "unpaidOrderValue", "singleDayRange", "getPreparationTotals", "getPreparationByProduct", "getOrderCountsBySource", "isScheduled", "filterOrdersByFulfillment", "resolveBusinessDay"]) {
    assert.equal(source.includes(helper), true, `summary.ts must reuse ${helper}`);
  }

  // All three revenue figures must be imported, not re-derived. Subtracting locally would make this
  // file a second definition of net revenue that could drift from the canonical one.
  assert.match(source, /import \{[^}]*\bnetRevenue\b[^}]*\} from "\.\/revenue\.ts"/);
  const code = source.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
  assert.equal(/gross\w*\s*-\s*refunds\w*/.test(code), false, "net must come from netRevenue(), not local subtraction");
});

test("most-ordered entries are items, and a hand-typed item can outrank a catalog product", () => {
  // The ranking is built from preparation groups, which include manual/unlinked items. That is
  // deliberate: an unlinked item that outsold everything is real demand an operator needs to see.
  // The contract is named MostOrderedItem rather than MostOrderedProduct because `key` is not
  // always a catalog identity.
  const summary = summarize(
    [orderWith({ id: "a", placedAt: TODAY_NOON })],
    [
      lineWith({ id: "l1", orderId: "a", productId: "product-brownies", itemName: "Biscoff Blondie", quantity: 3 }),
      lineWith({ id: "l2", orderId: "a", productId: "", sellingFormatId: "", itemName: "Custom Gift Pack", piecesPerUnitSnapshot: null, quantity: 8 }),
    ],
  );

  const top: MostOrderedItem | undefined = summary.mostOrdered[0];
  assert.equal(top?.label, "Custom Gift Pack");
  assert.equal(top?.units, 8);
  assert.equal(top?.key, "manual:Custom Gift Pack", "keyed as an item, not a product id");
  assert.equal(summary.mostOrdered[1]?.key, "product:product-brownies");
});

test("every OrderStatus is exercised by this suite's fixtures", () => {
  // Guards against a status quietly gaining behaviour nobody wrote a case for.
  const exercised = new Set<OrderStatus>(["new", "confirmed", "ready", "completed", "cancelled"]);
  for (const status of ORDER_STATUSES) {
    assert.equal(exercised.has(status), true, `no test covers status "${status}"`);
  }
});
