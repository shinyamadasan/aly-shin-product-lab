// S7 PR-G1: the deterministic Selling operational readout.
//
// One question, answered from data the operator already has loaded: "what is happening with orders
// right now, and what needs my attention?"
//
// This module COMPOSES. It reproduces no formula that already exists -- revenue comes from
// revenue.ts, preparation totals from pieces.ts, source counts from attribution.ts, scheduling from
// fulfillment.ts, line totals from totals.ts, and the business day from business-day.ts. If a number
// here disagrees with one of those files, this file is wrong.
//
// Three properties hold it together, and each is asserted by a test rather than trusted:
//
//   1. PURE. No React, no Supabase client, no repository, no query, no write. `nowMs` and
//      `timeZone` are parameters, so the same inputs always produce the same output and a test can
//      pin any instant it likes. Date.now() and getToday() appear nowhere.
//
//   2. NO LIFECYCLE FILTER REACHES REVENUE. Gross is `paidAmount` selected by `paidAt`, and
//      `status` is not consulted. A cancelled paid order is still money that was received.
//
//   3. NOTHING IS INVENTED. A missing pack size is reported as unknown, never as 1. An unlinked
//      line keeps its own frozen name rather than being merged into a generic bucket.
//
// Deliberately returns finished values rather than a Fact<T> or a DomainContext. S7 has no Business
// Context vocabulary in it. S8 can later call buildSellingSummary and translate the fields it wants;
// the boundary is built for that (BuildEnv's `now`/`timezone` map straight onto nowMs/timeZone) but
// this milestone does not authorise it.

import { resolveBusinessDay } from "../business-day.ts";
import { getOrderCountsBySource, type SourceCount } from "./attribution.ts";
import { filterOrdersByFulfillment, isScheduled } from "./fulfillment.ts";
import { getPreparationByProduct, getPreparationTotals, type PreparationTotals } from "./pieces.ts";
import {
  getPaymentMethodBreakdown, grossRevenue, hasRefundedPaidOrderInRange, netRevenue, paidOrderCount, refunds, singleDayRange, unpaidOrderValue,
  type BusinessDayRange, type PaymentMethodTotal,
} from "./revenue.ts";
import { CLOSED_ORDER_STATUSES, isOpenForHandover, OPEN_FOR_HANDOVER } from "./transitions.ts";
import type { Order, OrderLine } from "./types.ts";

// --- Lifecycle sets ---------------------------------------------------------------------------
//
// OPEN_FOR_HANDOVER/CLOSED_ORDER_STATUSES/isOpenForHandover live in transitions.ts (the lifecycle
// module) and are reused here, not redefined -- see that file for why "can still move" and "still
// needs handing to a customer" are deliberately kept as distinct questions.

// Exported for the test that proves the two sets together cover every OrderStatus exactly once.
export const ORDER_STATUS_COVERAGE = { openForHandover: OPEN_FOR_HANDOVER, closed: CLOSED_ORDER_STATUSES } as const;

// --- Windows ----------------------------------------------------------------------------------

const DAY_MS = 86_400_000;

// The rolling window is 7 business days INCLUSIVE of today, so the offset is 6 days, not 7.
const ROLLING_WINDOW_DAYS = 7;

export function resolveTodayRange(nowMs: number, timeZone: string): BusinessDayRange {
  return singleDayRange(resolveBusinessDay(nowMs, timeZone), timeZone);
}

// Manila observes no DST (proven in tests/business-day.test.ts across both solstices), so stepping
// back a fixed number of milliseconds cannot land on a doubled or skipped hour and mis-date the
// far end of the window. In a DST zone this would need calendar arithmetic instead.
//
// windowDays INCLUSIVE of today, so the offset is windowDays - 1, not windowDays -- shared by every
// rolling window this file resolves (the fixed 7-day one below, and Orders Workspace's selectable
// 7/30-day options), so a fix to the arithmetic only ever has one place to land.
function resolveRollingWindowRange(windowDays: number, nowMs: number, timeZone: string): BusinessDayRange {
  return {
    fromDay: resolveBusinessDay(nowMs - (windowDays - 1) * DAY_MS, timeZone),
    toDay: resolveBusinessDay(nowMs, timeZone),
    timezone: timeZone,
  };
}

export function resolveRollingWeekRange(nowMs: number, timeZone: string): BusinessDayRange {
  return resolveRollingWindowRange(ROLLING_WINDOW_DAYS, nowMs, timeZone);
}

// Business-day membership for a timestamp column, matching revenue.ts's own range semantics: an
// unparseable or absent value is outside every window rather than an error. The column carries no
// format constraint, so a value that cannot be read is unknown, and unknown is not "today".
function fallsWithin(timestamp: string | null, range: BusinessDayRange): boolean {
  if (!timestamp) {
    return false;
  }
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) {
    return false;
  }
  const day = resolveBusinessDay(parsed, range.timezone);
  return day >= range.fromDay && day <= range.toDay;
}

// --- Preparation grouping ---------------------------------------------------------------------

export type PreparationGroup = PreparationTotals & {
  // "product:<productId>" for a catalog-linked group, "manual:<trimmed itemName>" otherwise.
  // Distinct prefixes are what stop a catalog group and an unlinked group from ever colliding
  // even when their labels read identically.
  key: string;
  label: string;
  kind: "catalog" | "manual";
};

// Shown for an unlinked line whose frozen name is blank. Defensive only: validateOrderForSave
// rejects a blank item name ("Every item needs a name."), so the app's own write path cannot
// produce one -- but `item_name text not null` still permits an empty string at the database level,
// and a row that arrived another way must be counted rather than silently dropped.
const UNNAMED_LABEL = "Unnamed item";

// Picks a display name for a catalog group from the lines themselves rather than from LabState.
//
// The line's itemName is the sale-time snapshot, so it stays right for an order whose product was
// renamed or deleted afterwards. Joining the live catalog would make historical rows re-label
// themselves, which is the opposite of what a snapshot is for.
function resolveCatalogLabel(lines: OrderLine[]): string {
  for (const line of lines) {
    const name = line.itemName.trim();
    if (name !== "") {
      return name;
    }
  }
  return UNNAMED_LABEL;
}

// Groups the lines that have no product link.
//
// productId === "" does NOT mean "was typed by hand". It means "has no product link RIGHT NOW",
// and two different histories land here:
//
//   - a genuinely manual line, which never had one (buildManualOrderLine writes "" for both ids);
//   - a catalog line whose product was later DELETED -- order_lines.product_id is
//     `on delete set null`, and mapOrderLineRow maps that null to "".
//
// Both still carry their frozen itemName, so both are grouped by it. Grouping them by productId
// instead would put "Brownie Tray", "Coffee Box" and a deleted product's entire order history into
// one bucket labelled "Custom item" -- three real items and a real product erased into one row.
//
// Names are trimmed but NOT case-folded. buildManualOrderLine already trims at construction, so
// trimming restates the existing convention; folding case would assert that "Brownie Tray" and
// "brownie tray" are the same item, which is the operator's judgement to make, not this file's.
function groupUnlinkedLines(lines: OrderLine[]): PreparationGroup[] {
  const byName = new Map<string, OrderLine[]>();

  for (const line of lines) {
    const name = line.itemName.trim();
    const existing = byName.get(name);
    if (existing) {
      existing.push(line);
    } else {
      byName.set(name, [line]);
    }
  }

  return Array.from(byName.entries()).map(([name, groupLines]) => ({
    key: `manual:${name}`,
    label: name === "" ? UNNAMED_LABEL : name,
    kind: "manual" as const,
    ...getPreparationTotals(groupLines),
  }));
}

// Biggest job first, then alphabetical. Stable and deterministic: the same lines always produce the
// same order, and ties never depend on Map iteration order because the label tiebreak is total.
function sortGroups(groups: PreparationGroup[]): PreparationGroup[] {
  return [...groups].sort((a, b) => (b.units - a.units) || a.label.localeCompare(b.label) || a.key.localeCompare(b.key));
}

function buildPreparationGroups(lines: OrderLine[]): PreparationGroup[] {
  const catalogLines = lines.filter((line) => line.productId !== "");
  const unlinkedLines = lines.filter((line) => line.productId === "");

  // Catalog lines keep the existing S1 grouping. pieces.ts is not modified by S7.
  const linesByProduct = new Map<string, OrderLine[]>();
  for (const line of catalogLines) {
    const existing = linesByProduct.get(line.productId);
    if (existing) {
      existing.push(line);
    } else {
      linesByProduct.set(line.productId, [line]);
    }
  }

  const catalogGroups: PreparationGroup[] = getPreparationByProduct(catalogLines).map((preparation) => ({
    key: `product:${preparation.productId}`,
    label: resolveCatalogLabel(linesByProduct.get(preparation.productId) ?? []),
    kind: "catalog" as const,
    units: preparation.units,
    pieces: preparation.pieces,
    piecesUnknownLines: preparation.piecesUnknownLines,
  }));

  return sortGroups([...catalogGroups, ...groupUnlinkedLines(unlinkedLines)]);
}

// --- Most ordered -------------------------------------------------------------------------------

// An ITEM, not a product. The ranking is built from buildPreparationGroups, which returns both
// `product:<id>` groups and `manual:<frozen itemName>` groups, so an entry here may be a catalog
// product or a hand-typed item -- and deliberately so: a Custom Gift Pack that outsold everything
// else is exactly the kind of thing an operator needs to see, and filtering it out to make the type
// name true would hide real demand. Naming this MostOrderedProduct would have quietly promised a
// catalog identity that `key` does not always carry.
export type MostOrderedItem = { key: string; label: string; units: number };

const MOST_ORDERED_LIMIT = 3;

// Ranked by SELLING UNITS -- "3 boxes", not pesos and not pieces.
//
// Units rather than revenue, because a revenue ranking would become a second money number computed
// from current lines, and this file has exactly one money rule (paidAmount at paidAt). Units rather
// than pieces, because a piece ranking would silently drop every line whose pack size is unrecorded
// and rank the remainder as though the list were complete.
//
// The caller must label it as units. "Top product" with no basis stated invites reading it as
// revenue or margin.
function buildMostOrdered(lines: OrderLine[]): MostOrderedItem[] {
  return buildPreparationGroups(lines)
    .map(({ key, label, units }) => ({ key, label, units }))
    .sort((a, b) => (b.units - a.units) || a.label.localeCompare(b.label) || a.key.localeCompare(b.key))
    .slice(0, MOST_ORDERED_LIMIT);
}

// --- The summary --------------------------------------------------------------------------------

export type SellingSummaryAttention = {
  newAwaitingConfirmation: number;
  needsScheduling: number;
  readyForHandover: number;
  unpaidCount: number;
  // A RECEIVABLE, not revenue: what is owed on live orders, read from current line totals because
  // nothing has been frozen yet. Never added to, or compared against, grossRevenue.
  unpaidValue: number;
  overdueHandovers: number;
};

export type SellingSummaryPeriod = {
  ordersPlaced: number;
  grossRevenue: number;
  refunds: number;
  netRevenue: number;
};

export type SellingSummaryToday = SellingSummaryPeriod & {
  businessDay: string;
  remainingHandovers: number;
};

export type SellingSummaryWeek = SellingSummaryPeriod & {
  range: BusinessDayRange;
};

export type SellingSummary = {
  attention: SellingSummaryAttention;
  today: SellingSummaryToday;
  week: SellingSummaryWeek;
  toPrepareToday: {
    groups: PreparationGroup[];
    // Total across groups. `pieces` is a FLOOR, not a total, whenever this is non-zero, and the
    // renderer must say so rather than presenting the piece count as complete.
    piecesUnknownLines: number;
  };
  mostOrdered: MostOrderedItem[];
  sources: SourceCount[];
};

export type SellingSummaryInput = {
  orders: Order[];
  linesByOrderId: Map<string, OrderLine[]>;
  // Injected, never read from a clock here. Same inputs, same output, always.
  nowMs: number;
  timeZone: string;
};

function collectLines(orders: Order[], linesByOrderId: Map<string, OrderLine[]>): OrderLine[] {
  return orders.flatMap((order) => linesByOrderId.get(order.id) ?? []);
}

export function buildSellingSummary({ orders, linesByOrderId, nowMs, timeZone }: SellingSummaryInput): SellingSummary {
  const todayRange = resolveTodayRange(nowMs, timeZone);
  const weekRange = resolveRollingWeekRange(nowMs, timeZone);
  const today = todayRange.fromDay;

  // --- Attention ---
  //
  // No date window on any of these four counts. An order that has been waiting since last week is
  // more urgent than one that arrived this morning, so filtering them to today would hide exactly
  // the ones that need attention most.
  const newAwaitingConfirmation = orders.filter((order) => order.status === "new").length;
  const needsScheduling = orders.filter((order) => order.status === "confirmed" && !isScheduled(order)).length;

  // `ready` means made and packed, waiting for the customer. No date window and no payment
  // condition: a ready order may be unpaid, paid or refunded, and none of that changes whether a
  // box is sitting on the counter. `ready` is optional in the lifecycle (confirmed -> completed is
  // legal), so this counts genuinely staged work rather than a stage everything passes through.
  const readyForHandover = orders.filter((order) => order.status === "ready").length;

  const unpaidActive = orders.filter((order) => order.paymentStatus === "unpaid" && order.status !== "cancelled");

  // An agreed time that has already passed, on an order still open. Compares business DAYS, not
  // instants: an order scheduled for 5pm today is not overdue at 9am today, and does not become
  // overdue until a later Manila business day. Instant comparison would flip it mid-afternoon on
  // the very day it is due, which reads as noise rather than as a problem.
  const overdueHandovers = orders.filter((order) => {
    if (!isOpenForHandover(order) || !isScheduled(order)) {
      return false;
    }
    const parsed = Date.parse(order.fulfillmentAt ?? "");
    return Number.isFinite(parsed) && resolveBusinessDay(parsed, timeZone) < today;
  }).length;

  // --- Today and the rolling week ---
  //
  // Cancelled orders COUNT as placed. An order that arrived and was later cancelled still arrived,
  // and this measures intake. The caller labels it "orders placed", never "orders".
  const ordersPlacedToday = orders.filter((order) => fallsWithin(order.placedAt, todayRange)).length;
  const ordersPlacedWeek = orders.filter((order) => fallsWithin(order.placedAt, weekRange)).length;

  // Scheduled for today AND still open. `new` is included deliberately: it cannot reach `completed`
  // without being confirmed first, which makes an unconfirmed order due today the most urgent
  // remaining handover, not an excluded one. It is also counted in newAwaitingConfirmation -- two
  // rows answering two different questions, not one number counted twice.
  const remainingHandovers = filterOrdersByFulfillment(orders, "today", { nowMs, timeZone }).filter(isOpenForHandover).length;

  // --- To prepare today ---
  //
  // Confirmed AND scheduled for today. An unscheduled confirmed order is NOT here: "we committed to
  // this order" and "bake this today" are different facts, and only the first is recorded. Those
  // orders surface under needsScheduling instead. No lead-time rule is applied -- no bake-the-day-
  // before, no prep-hours-ahead, no freshness window. None of those rules exists in this repository,
  // and inventing one would put a fabricated policy behind a number that looks measured.
  const toPrepareOrders = orders.filter((order) => order.status === "confirmed" && isScheduled(order) && fallsWithin(order.fulfillmentAt, todayRange));
  const toPrepareGroups = buildPreparationGroups(collectLines(toPrepareOrders, linesByOrderId));

  // --- Sales mix ---
  //
  // Cancelled orders are EXCLUDED from most-ordered (a cancelled order did not sell) and INCLUDED
  // in sources (it still came from a channel). Deliberately opposite, because the two answer
  // different questions: what moved, versus where demand came from.
  const weekOrders = orders.filter((order) => fallsWithin(order.placedAt, weekRange));
  const mostOrdered = buildMostOrdered(collectLines(weekOrders.filter((order) => order.status !== "cancelled"), linesByOrderId));

  // --- Revenue ---
  //
  // Delegated wholesale to revenue.ts. Gross sums the frozen paidAmount selected by paidAt, with
  // NO lifecycle filter -- a cancelled paid order is still money that was received, and stays
  // revenue until an actual refund is recorded. Refunds are dated by refundedAt, so a refund lands
  // in the period the money left and an earlier period's gross is immutable.
  //
  // Net calls netRevenue rather than subtracting the two locally. `gross - refunds` is the same
  // arithmetic today, but writing it here would make this file a second definition of net revenue
  // that could silently disagree with the canonical one -- exactly the drift the single-source rule
  // exists to prevent. All three values are exposed because the readout shows gross, and shows
  // refunds and net only when refunds are non-zero.
  const grossToday = grossRevenue(orders, todayRange);
  const refundsToday = refunds(orders, todayRange);
  const netToday = netRevenue(orders, todayRange);
  const grossWeek = grossRevenue(orders, weekRange);
  const refundsWeek = refunds(orders, weekRange);
  const netWeek = netRevenue(orders, weekRange);

  return {
    attention: {
      newAwaitingConfirmation,
      needsScheduling,
      readyForHandover,
      unpaidCount: unpaidActive.length,
      unpaidValue: unpaidOrderValue(orders, linesByOrderId),
      overdueHandovers,
    },
    today: {
      businessDay: today,
      ordersPlaced: ordersPlacedToday,
      remainingHandovers,
      grossRevenue: grossToday,
      refunds: refundsToday,
      netRevenue: netToday,
    },
    week: {
      range: weekRange,
      ordersPlaced: ordersPlacedWeek,
      grossRevenue: grossWeek,
      refunds: refundsWeek,
      netRevenue: netWeek,
    },
    toPrepareToday: {
      groups: toPrepareGroups,
      piecesUnknownLines: toPrepareGroups.reduce((total, group) => total + group.piecesUnknownLines, 0),
    },
    mostOrdered,
    sources: getOrderCountsBySource(weekOrders),
  };
}

// --- Orders Workspace V1: the selectable reporting period --------------------------------------
//
// A second, independent readout over the same loaded state buildSellingSummary already builds
// from -- attention and toPrepareToday stay period-INDEPENDENT (they answer "what needs doing
// right now", not "how did a chosen window perform") and are untouched by anything below. This
// section exists because the operator can choose which window "how did we do" means, unlike
// today/week above which are always both computed.
//
// ALL_TIME_FLOOR_DAY is a SENTINEL, not a business fact -- no real order can predate it. It exists
// only so "all time" can be expressed as an ordinary BusinessDayRange (a plain lexical string
// comparison) rather than widening BusinessDayRange itself to carry a nullable bound, which would
// ripple into revenue.ts and Dashboard for a concept only this file's callers need.
const ALL_TIME_FLOOR_DAY = "2000-01-01";

export type SalesPeriodKey = "today" | "last7" | "last30" | "thisMonth" | "allTime" | "custom";

export type SalesPeriodSelection =
  | { kind: Exclude<SalesPeriodKey, "custom"> }
  | { kind: "custom"; startDay: string; endDay: string };

export const DEFAULT_SALES_PERIOD: SalesPeriodSelection = { kind: "last7" };

function isValidBusinessDayString(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00.000Z`));
}

// Inclusive, start <= end, both well-formed -- the same shape a caller building a custom range by
// hand must satisfy. Exposed so a presentational layer can validate an in-progress selection BEFORE
// ever constructing a SalesPeriodSelection, rather than discovering it is invalid only after
// resolveSalesPeriodRange has already silently fallen back (see that function's own comment).
export function isValidCustomSalesPeriod(startDay: string, endDay: string): boolean {
  return isValidBusinessDayString(startDay) && isValidBusinessDayString(endDay) && startDay <= endDay;
}

// Never throws and never returns a malformed range, regardless of input -- a picker mid-edit, a
// stale selection, or a caller that skipped isValidCustomSalesPeriod all resolve to *something*
// coherent. A malformed "custom" selection falls back to the same default the picker itself
// defaults to (last7) -- this is a DEFENSIVE backstop only; the intended path is that a
// presentational layer calls isValidCustomSalesPeriod before ever constructing a "custom" selection,
// so this fallback should never actually be reached through normal use.
export function resolveSalesPeriodRange(selection: SalesPeriodSelection, nowMs: number, timeZone: string): BusinessDayRange {
  const today = resolveBusinessDay(nowMs, timeZone);

  switch (selection.kind) {
    case "today":
      return resolveTodayRange(nowMs, timeZone);
    case "last7":
      return resolveRollingWindowRange(7, nowMs, timeZone);
    case "last30":
      return resolveRollingWindowRange(30, nowMs, timeZone);
    case "thisMonth":
      // The 1st of the current Manila month through today -- a plain string slice of the already
      // timezone-correct `today`, so no second timezone resolution is needed.
      return { fromDay: `${today.slice(0, 7)}-01`, toDay: today, timezone: timeZone };
    case "allTime":
      return { fromDay: ALL_TIME_FLOOR_DAY, toDay: today, timezone: timeZone };
    case "custom":
      if (!isValidCustomSalesPeriod(selection.startDay, selection.endDay)) {
        return resolveRollingWindowRange(7, nowMs, timeZone);
      }
      return { fromDay: selection.startDay, toDay: selection.endDay, timezone: timeZone };
  }
}

export type SalesPeriodOverview = {
  range: BusinessDayRange;
  ordersPlaced: number;
  sellingUnits: number;
  paidRevenue: number;
  averagePaidOrderValue: number;
  mostOrdered: MostOrderedItem[];
  sources: SourceCount[];
  paymentMethodBreakdown: PaymentMethodTotal[];
  // Whether a refunded-but-paid order falls in this range -- see revenue.ts's
  // hasRefundedPaidOrderInRange for why this changes no number, only whether a UI disclaimer shows.
  hasRefundedPaidOrders: boolean;
};

export type SalesPeriodOverviewInput = {
  orders: Order[];
  linesByOrderId: Map<string, OrderLine[]>;
  range: BusinessDayRange;
};

// The Orders Workspace "sales overview" for an arbitrary, caller-chosen range -- reuses the exact
// same primitives buildSellingSummary's today/week readouts already use, so nothing here can
// silently disagree with them about what "paid revenue" or "most ordered" means.
export function buildSalesPeriodOverview({ orders, linesByOrderId, range }: SalesPeriodOverviewInput): SalesPeriodOverview {
  const ordersInRange = orders.filter((order) => fallsWithin(order.placedAt, range));

  // Cancelled orders EXCLUDED -- deliberately different from SellingSummaryPeriod.ordersPlaced
  // (today.ordersPlaced/week.ordersPlaced), which counts cancelled too because it measures intake.
  // This is a separate, explicitly-scoped metric ("how much did we actually sell"), not a
  // redefinition of the existing one -- the two are allowed to disagree by exactly the cancelled
  // count for the same window, and both are correct answers to different questions.
  const nonCancelledInRange = ordersInRange.filter((order) => order.status !== "cancelled");

  const payingOrderCount = paidOrderCount(orders, range);
  const paidRevenue = grossRevenue(orders, range);

  return {
    range,
    ordersPlaced: nonCancelledInRange.length,
    sellingUnits: getPreparationTotals(collectLines(nonCancelledInRange, linesByOrderId)).units,
    paidRevenue,
    // Never NaN or Infinity: an empty denominator is a real "nothing paid in this range" state, not
    // an error, and reports as a plain 0 rather than an undefined-looking value.
    averagePaidOrderValue: payingOrderCount === 0 ? 0 : paidRevenue / payingOrderCount,
    mostOrdered: buildMostOrdered(collectLines(nonCancelledInRange, linesByOrderId)),
    // Cancelled orders INCLUDED here -- same opposite-of-mostOrdered rule buildSellingSummary's own
    // week.sources already applies: a cancelled order did not sell anything, but it still came from
    // a channel.
    sources: getOrderCountsBySource(ordersInRange),
    // Same `orders` array (not ordersInRange/nonCancelledInRange) paidRevenue itself reduces over, so
    // the breakdown always reconciles to paidRevenue for the same range.
    paymentMethodBreakdown: getPaymentMethodBreakdown(orders, range),
    hasRefundedPaidOrders: hasRefundedPaidOrderInRange(orders, range),
  };
}
