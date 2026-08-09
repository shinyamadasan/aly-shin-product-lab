// S8: the Selling domain adapter.
//
// This adapter COMPOSES. Every number it publishes was already computed by
// src/lib/orders/summary.ts (S7), which in turn delegates to revenue.ts, pieces.ts, attribution.ts,
// fulfillment.ts, totals.ts and business-day.ts. buildSellingSummary is called exactly ONCE per
// build, and nothing here re-derives a window, a revenue figure, a lifecycle classification, or a
// source count. If a fact ever seems to need one of those formulas written out again, the boundary
// is wrong -- not the formula.
//
// That is also how the frozen plan's two statements are reconciled. §14's "reads paid_amount
// directly" names the FINANCIAL TRUTH -- amount is paid_amount, date is paid_at, and no lifecycle
// filter touches it -- not an instruction to re-implement it. revenue.ts owns that rule; this file
// satisfies it by calling the code that owns it, and cites orders.paid_amount / orders.paid_at as
// the source columns because they genuinely are.
//
// WHY THE ROWS STAY RAW.
// SellingRows carries OrderRow/OrderLineRow, not the mapped domain models, and the two basis facts
// below are projected from those raw rows. mapOrderRow is deliberately defensive for the operational
// UI: an unrecognised status becomes "new", an unrecognised payment_status becomes "unpaid", an
// unrecognised source becomes "unknown". Rendering something sensible is right for a screen. At an
// EVIDENCE boundary it is not -- publishing a normalised value as an `entered` fact would assert
// that a malformed database value was genuinely typed as "new". So the basis records what is
// actually stored, while the measurements go through the same mapping S7 uses. Evidence and
// measurement stay honest about different things.
//
// MEASUREMENTS ONLY. No ranking, no forecast, no recommendation, no whole-business verdict -- the
// design's P13 holds even now that sales data exists, and frozen §6.3 is explicit: "No topProduct,
// no bestChannel, no momentum verdict. Any ranking requires a versioned orderingId." Selling emits
// zero signals for the same reason.

import { mapOrderLineRow, mapOrderRow } from "../../orders/mappers.ts";
import { buildSellingSummary } from "../../orders/summary.ts";
import { ORDER_SOURCES, type OrderLine, type OrderLineRow, type OrderRow, type OrderSource } from "../../orders/types.ts";
import type { BuildEnv, DomainContext, Fact, Provenance, ReadOutcome } from "../types.ts";

export const SELLING_ADAPTER_VERSION = 1;

export type SellingRows = {
  orders: OrderRow[];
  lines: OrderLineRow[];
};

// --- The sanitized evidence basis ----------------------------------------------------------------
//
// Only the columns the fourteen measurements actually consume are projected. Everything else is
// deliberately absent, and the exclusions are the point rather than an oversight: customer_id,
// notes, source_ref, fulfillment_address, fulfillment_notes, item_name, product_id,
// selling_format_id, payment_method and cancel_reason never enter the envelope, and no customer row
// is read at all (see SellingRows above), so no name, phone, handle or address is even available to
// leak. A context envelope is quoted into prompts and stored; it is the last place free text and
// personal data should accumulate.
//
// Values are copied VERBATIM from the raw row, including nulls. paid_amount in particular stays
// `number | string | null` exactly as PostgREST returned it, so "no payment recorded" and "a payment
// of zero" remain different facts here just as they do in revenue.ts.

export type OrderBasisEntry = {
  id: string;
  status: string | null;
  paymentStatus: string | null;
  placedAt: string | null;
  fulfillmentAt: string | null;
  paidAt: string | null;
  paidAmount: number | string | null;
  refundedAt: string | null;
  source: string | null;
  updatedAt: string | null;
};

export type OrderLineBasisEntry = {
  id: string;
  orderId: string;
  quantity: number | string | null;
  unitPrice: number | string | null;
};

function toOrderBasis(row: OrderRow): OrderBasisEntry {
  return {
    id: row.id,
    status: row.status,
    paymentStatus: row.payment_status,
    placedAt: row.placed_at,
    fulfillmentAt: row.fulfillment_at,
    paidAt: row.paid_at,
    paidAmount: row.paid_amount,
    refundedAt: row.refunded_at,
    source: row.source,
    updatedAt: row.updated_at,
  };
}

function toOrderLineBasis(row: OrderLineRow): OrderLineBasisEntry {
  return { id: row.id, orderId: row.order_id, quantity: row.quantity, unitPrice: row.unit_price };
}

// --- Provenance ----------------------------------------------------------------------------------
//
// The graph is split deliberately, and the split is what makes it truthful:
//
//   the two basis facts   -> PHYSICAL lineage:   kind "entered", table, rowIds. No inputs, no
//                            computedBy, because nothing precedes them.
//   the fourteen aggregates -> DEPENDENCY lineage: computedBy + inputs naming the basis they were
//                            computed from. No table and no rowIds.
//
// Aggregates carry no table for a concrete reason: Provenance has ONE table field and ONE rowIds
// array, and unpaidReceivableValue depends on both orders and order_lines. It could not describe
// itself honestly with them, and duplicating ids the basis already holds would be noise everywhere
// else. Pointing at the fact that owns the rows answers "where did this come from" exactly once.

const ORDER_BASIS_PATH = "selling.facts.orderBasis";
const ORDER_LINE_BASIS_PATH = "selling.facts.orderLineBasis";

function fromOrders(kind: "derived" | "calculated", column?: string): Provenance {
  return { kind, ...(column ? { column } : {}), computedBy: "buildSellingSummary", inputs: [ORDER_BASIS_PATH] };
}

function fromOrdersAndLines(column: string): Provenance {
  return { kind: "calculated", column, computedBy: "buildSellingSummary", inputs: [ORDER_BASIS_PATH, ORDER_LINE_BASIS_PATH] };
}

// --- Source counts -------------------------------------------------------------------------------
//
// getOrderCountsBySource returns a count-SORTED array that OMITS zero-count sources. Neither
// property belongs in a context envelope: the ordering is a ranking, and this design says a ranking
// needs a versioned orderingId; and an omitted source makes "no orders from Facebook" and "Facebook
// is not a channel we track" indistinguishable.
//
// So the counts are re-keyed onto the full ORDER_SOURCES vocabulary with explicit zeroes. This is
// SERIALIZATION, not a second attribution rule -- every count comes from the summary, none is
// recounted here, and "unknown" stays a first-class key exactly as attribution.ts intends.
function toSourceRecord(counts: ReadonlyArray<{ source: OrderSource; count: number }>): Record<OrderSource, number> {
  const record = Object.fromEntries(ORDER_SOURCES.map((source) => [source, 0])) as Record<OrderSource, number>;
  for (const entry of counts) {
    record[entry.source] = entry.count;
  }
  return record;
}

// --- Degraded contexts ---------------------------------------------------------------------------

const FACT_KEYS = [
  "orderBasis",
  "orderLineBasis",
  "ordersPlacedToday",
  "ordersPlacedRolling7d",
  "grossPaidRevenueToday",
  "grossPaidRevenueRolling7d",
  "refundsRolling7d",
  "netRevenueRolling7d",
  "unpaidActiveOrderCount",
  "unpaidReceivableValue",
  "newAwaitingConfirmation",
  "confirmedNeedingScheduling",
  "readyForHandover",
  "remainingHandoversToday",
  "overdueHandovers",
  "orderCountBySourceRolling7d",
] as const;

// A failed read is never rendered as a quiet business. Every fact takes the same absence state, the
// domain is listed in coverage.absent with the real reason, and the build continues -- a snapshot
// with three healthy domains and one unavailable is far more useful than no snapshot, provided the
// gap is stated.
function degraded(because: string, outcome: ReadOutcome, state: "unavailable" | "not_configured"): DomainContext {
  const fact = { state, because } as Fact<never>;
  return {
    domain: "selling",
    adapterVersion: SELLING_ADAPTER_VERSION,
    readOutcome: outcome,
    sourceAsOf: fact,
    rowCounts: { read: 0, included: 0, omitted: 0 },
    facts: Object.fromEntries(FACT_KEYS.map((key) => [key, fact])),
    signals: [],
    notes: [because],
  };
}

export function buildSellingDomainContextFromFailure(outcome: Extract<ReadOutcome, { ok: false }>): DomainContext {
  if (outcome.reason === "missing-table") {
    return degraded("The orders and order_lines tables do not exist in this project yet.", outcome, "not_configured");
  }
  return degraded(`The Selling read failed: ${outcome.message}`, outcome, "unavailable");
}

// --- The build -----------------------------------------------------------------------------------

export function buildSellingDomainContext(rows: SellingRows, env: BuildEnv): DomainContext {
  // The one call. env.now and env.timezone are the only time inputs, so the same rows and the same
  // env always produce the same context -- no clock is read here or anywhere below it.
  const orders = rows.orders.map(mapOrderRow);
  const linesByOrderId = new Map<string, OrderLine[]>();
  for (const row of rows.lines) {
    const line = mapOrderLineRow(row);
    const existing = linesByOrderId.get(line.orderId);
    if (existing) {
      existing.push(line);
    } else {
      linesByOrderId.set(line.orderId, [line]);
    }
  }

  const summary = buildSellingSummary({ orders, linesByOrderId, nowMs: env.now, timeZone: env.timezone });

  const orderBasisSource: Provenance = { kind: "entered", table: "orders", rowIds: rows.orders.map((row) => row.id) };
  const orderLineBasisSource: Provenance = { kind: "entered", table: "order_lines", rowIds: rows.lines.map((row) => row.id) };

  // max(updated_at) across the raw order rows. Safe here, unlike costing's deliberate created_at:
  // buildOrderPayload writes updated_at explicitly on every write path, so it is trustworthy for
  // this table. Unparseable values are ignored rather than allowed to poison the maximum.
  const updatedAts = rows.orders.map((row) => row.updated_at).filter((value): value is string => typeof value === "string" && Number.isFinite(Date.parse(value)));
  const sourceAsOf: Fact<string> =
    updatedAts.length === 0
      ? { state: "empty", source: { kind: "entered", table: "orders", column: "updated_at" } }
      : {
          state: "known",
          value: updatedAts.reduce((latest, value) => (Date.parse(value) > Date.parse(latest) ? value : latest)),
          source: { kind: "entered", table: "orders", column: "updated_at" },
        };

  // A count of zero on a SUCCESSFUL read is known(0), never empty or unknown: zero orders today is a
  // real business fact, and the Fact vocabulary is explicit that "a real zero is known(0)". Only the
  // two collection facts use `empty`, which is what that state is for.
  const known = <T,>(value: T, source: Provenance): Fact<T> => ({ state: "known", value, source, confidence: "high" });

  return {
    domain: "selling",
    adapterVersion: SELLING_ADAPTER_VERSION,
    readOutcome: { ok: true },
    sourceAsOf,
    rowCounts: { read: rows.orders.length + rows.lines.length, included: rows.orders.length + rows.lines.length, omitted: 0 },
    facts: {
      // Roots first: everything below names one of these, and neither names anything.
      orderBasis:
        rows.orders.length === 0
          ? { state: "empty", source: orderBasisSource }
          : { state: "known", value: rows.orders.map(toOrderBasis), source: orderBasisSource },
      orderLineBasis:
        rows.lines.length === 0
          ? { state: "empty", source: orderLineBasisSource }
          : { state: "known", value: rows.lines.map(toOrderLineBasis), source: orderLineBasisSource },

      // Intake. Cancelled orders count: an order that arrived and was later cancelled still arrived,
      // which is why the key says "placed".
      ordersPlacedToday: known(summary.today.ordersPlaced, fromOrders("derived", "placed_at")),
      ordersPlacedRolling7d: known(summary.week.ordersPlaced, fromOrders("derived", "placed_at")),

      // Money. Gross is the frozen paid_amount selected by paid_at with NO lifecycle filter, so a
      // cancelled paid order stays revenue until an actual refund is recorded. Refunds are dated by
      // refunded_at, which is what keeps an earlier period's gross immutable.
      grossPaidRevenueToday: known(summary.today.grossRevenue, fromOrders("calculated", "paid_amount")),
      grossPaidRevenueRolling7d: known(summary.week.grossRevenue, fromOrders("calculated", "paid_amount")),
      refundsRolling7d: known(summary.week.refunds, fromOrders("calculated", "paid_amount")),
      netRevenueRolling7d: known(summary.week.netRevenue, fromOrders("calculated", "paid_amount")),

      // Receivable, NOT revenue: what is owed on live orders, read from current line totals because
      // nothing has been frozen yet. The only fact here that depends on both tables, and the reason
      // the dependency graph has two roots.
      unpaidActiveOrderCount: known(summary.attention.unpaidCount, fromOrders("derived", "payment_status")),
      unpaidReceivableValue: known(summary.attention.unpaidValue, fromOrdersAndLines("unit_price")),

      // Operational attention. Each is a count of orders in a named state; none is a judgement about
      // whether that count is good or bad.
      newAwaitingConfirmation: known(summary.attention.newAwaitingConfirmation, fromOrders("derived", "status")),
      confirmedNeedingScheduling: known(summary.attention.needsScheduling, fromOrders("derived", "fulfillment_at")),
      readyForHandover: known(summary.attention.readyForHandover, fromOrders("derived", "status")),
      remainingHandoversToday: known(summary.today.remainingHandovers, fromOrders("derived", "fulfillment_at")),
      overdueHandovers: known(summary.attention.overdueHandovers, fromOrders("derived", "fulfillment_at")),

      // Rolling 7 days, and the key says so -- an unqualified name would invite reading it as
      // all-time.
      orderCountBySourceRolling7d: known(toSourceRecord(summary.sources), fromOrders("derived", "source")),
    },
    signals: [],
    notes: [],
  };
}
