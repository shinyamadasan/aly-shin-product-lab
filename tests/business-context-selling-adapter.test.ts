// S8: the Selling Business Context adapter.
//
// Two things are protected here. The first is that every published number means what its key says.
// The second, and the reason the file is long, is that the adapter stays a COMPOSITION layer: it
// must never grow a second revenue formula, a second window, or a second lifecycle rule, and it must
// never present a failed read as a quiet business.
//
// The generic provenance invariants in business-context-provenance-invariants.test.ts also cover
// this domain -- Selling is in its builtContexts() -- so what is asserted below is Selling-specific
// on top of those.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildSellingDomainContext,
  buildSellingDomainContextFromFailure,
  SELLING_ADAPTER_VERSION,
  type SellingRows,
} from "../src/lib/business-context/adapters/selling.ts";
import { ORDER_SOURCES, type OrderLineRow, type OrderRow } from "../src/lib/orders/types.ts";
import type { BuildEnv, DomainContext, Fact } from "../src/lib/business-context/types.ts";

// Manila is UTC+8. 2026-08-08T20:00Z is 04:00 on 2026-08-09 there, so "today" is 2026-08-09 and the
// rolling window is 2026-08-03..2026-08-09. Chosen to straddle the UTC date line on purpose.
const NOW = Date.parse("2026-08-08T20:00:00.000Z");
const ENV: BuildEnv = { now: NOW, timezone: "Asia/Manila", businessDay: "2026-08-09", budgets: {} };

// Instants named by the Manila day they land in.
const TODAY_EARLY = "2026-08-08T17:00:00.000Z"; // 2026-08-09 01:00 Manila
const TODAY_LATE = "2026-08-09T02:00:00.000Z"; // 2026-08-09 10:00 Manila
const IN_WEEK = "2026-08-05T02:00:00.000Z"; // 2026-08-05 Manila
const BEFORE_WEEK = "2026-07-20T02:00:00.000Z";
const YESTERDAY = "2026-08-07T18:00:00.000Z"; // 2026-08-08 Manila

function order(overrides: Partial<OrderRow> = {}): OrderRow {
  return {
    id: "o1", customer_id: "c1", status: "confirmed", payment_status: "unpaid",
    payment_method: null, paid_at: null, paid_amount: null, refunded_at: null,
    fulfillment_method: "pickup", fulfillment_at: null, fulfillment_address: "", fulfillment_notes: "",
    source: "instagram", source_ref: "", entry_method: "manual", notes: "", placed_at: TODAY_EARLY,
    completed_at: null, cancelled_at: null, cancel_reason: "",
    created_at: TODAY_EARLY, updated_at: TODAY_EARLY,
    ...overrides,
  };
}

function line(overrides: Partial<OrderLineRow> = {}): OrderLineRow {
  return {
    id: "l1", order_id: "o1", product_id: "brownies", selling_format_id: null,
    item_name: "Brownie box", unit_price: 480, pieces_per_unit_snapshot: 6, quantity: 1, sort_order: 0, note: "",
    ...overrides,
  };
}

const build = (rows: Partial<SellingRows> = {}) => buildSellingDomainContext({ orders: rows.orders ?? [], lines: rows.lines ?? [] }, ENV);

function value(context: DomainContext, key: string): unknown {
  const fact = context.facts[key] as Fact<unknown> | undefined;
  assert.ok(fact, `no fact published at ${key}`);
  assert.equal(fact.state, "known", `${key} should be known, was ${fact.state}`);
  return (fact as { value: unknown }).value;
}

const stateOf = (context: DomainContext, key: string) => (context.facts[key] as Fact<unknown>).state;
const sourceOf = (context: DomainContext, key: string) => (context.facts[key] as { source?: { kind: string; table?: string; column?: string; rowIds?: string[]; computedBy?: string; inputs?: string[] } }).source;

const AGGREGATE_KEYS = [
  "ordersPlacedToday", "ordersPlacedRolling7d",
  "grossPaidRevenueToday", "grossPaidRevenueRolling7d", "refundsRolling7d", "netRevenueRolling7d",
  "unpaidActiveOrderCount", "unpaidReceivableValue",
  "newAwaitingConfirmation", "confirmedNeedingScheduling", "readyForHandover",
  "remainingHandoversToday", "overdueHandovers", "orderCountBySourceRolling7d",
];

// --- Shape ----------------------------------------------------------------------------------------

test("the domain publishes exactly the approved fact set, in a stable order", () => {
  const context = build({ orders: [order()] });
  assert.deepEqual(Object.keys(context.facts), ["orderBasis", "orderLineBasis", ...AGGREGATE_KEYS]);
  assert.equal(context.domain, "selling");
  assert.equal(context.adapterVersion, SELLING_ADAPTER_VERSION);
});

test("the same rows and env always produce the same context", () => {
  const rows = { orders: [order(), order({ id: "o2", status: "ready" })], lines: [line()] };
  assert.deepEqual(build(rows), build(rows));
});

// --- Frozen financial semantics ----------------------------------------------------------------------

test("a cancelled paid order still counts as gross revenue", () => {
  // No lifecycle filter reaches revenue. Cancelling changes what you are OWED, never what you
  // RECEIVED -- the money stays received until an actual refund is recorded.
  const context = build({
    orders: [order({ id: "o1", status: "cancelled", cancelled_at: TODAY_LATE, payment_status: "paid", paid_at: TODAY_EARLY, paid_amount: 480 })],
  });
  assert.equal(value(context, "grossPaidRevenueToday"), 480);
  assert.equal(value(context, "grossPaidRevenueRolling7d"), 480);
  assert.equal(value(context, "unpaidReceivableValue"), 0, "but a cancelled order is not owed");
});

test("a refund lands in the refund period and never rewrites the paid period", () => {
  const paidLastMonthRefundedToday = order({ status: "completed", payment_status: "refunded", paid_at: BEFORE_WEEK, paid_amount: 900, refunded_at: TODAY_EARLY });
  const context = build({ orders: [paidLastMonthRefundedToday] });

  assert.equal(value(context, "grossPaidRevenueToday"), 0, "the payment belongs to July");
  assert.equal(value(context, "grossPaidRevenueRolling7d"), 0);
  assert.equal(value(context, "refundsRolling7d"), 900, "the refund belongs to this window");
  assert.equal(value(context, "netRevenueRolling7d"), -900);

  // Paid inside the window and refunded inside it: both sides land, and net is their difference.
  const both = build({ orders: [order({ payment_status: "refunded", paid_at: IN_WEEK, paid_amount: 900, refunded_at: TODAY_EARLY })] });
  assert.equal(value(both, "grossPaidRevenueRolling7d"), 900);
  assert.equal(value(both, "refundsRolling7d"), 900);
  assert.equal(value(both, "netRevenueRolling7d"), 0);
});

test("editing order lines cannot move paid revenue by a centavo", () => {
  // Revenue sums the frozen paid_amount and never reads a line.
  const paid = order({ status: "completed", payment_status: "paid", paid_at: TODAY_EARLY, paid_amount: 480 });
  const asPaid = build({ orders: [paid], lines: [line({ unit_price: 480, quantity: 1 })] });
  const afterEdit = build({ orders: [paid], lines: [line({ unit_price: 99_999, quantity: 7 })] });
  const noLines = build({ orders: [paid], lines: [] });

  assert.equal(value(asPaid, "grossPaidRevenueToday"), 480);
  assert.equal(value(afterEdit, "grossPaidRevenueToday"), 480);
  assert.equal(value(noLines, "grossPaidRevenueToday"), 480, "revenue survives its lines being emptied");
});

test("unpaid value is a receivable: it reads current lines and excludes cancelled orders", () => {
  const context = build({
    orders: [
      order({ id: "live", status: "confirmed", payment_status: "unpaid" }),
      order({ id: "dead", status: "cancelled", payment_status: "unpaid" }),
    ],
    lines: [
      line({ id: "l1", order_id: "live", unit_price: 300, quantity: 2 }),
      line({ id: "l2", order_id: "dead", unit_price: 900, quantity: 1 }),
    ],
  });

  assert.equal(value(context, "unpaidActiveOrderCount"), 1);
  assert.equal(value(context, "unpaidReceivableValue"), 600);
  assert.equal(value(context, "grossPaidRevenueToday"), 0, "a receivable is never revenue");
});

test("a null paid_amount is simply not in the paid set -- never known(0) imputed into revenue", () => {
  const context = build({ orders: [order({ payment_status: "unpaid", paid_at: null, paid_amount: null })] });
  assert.equal(value(context, "grossPaidRevenueToday"), 0);
  // And the basis keeps the null verbatim rather than flattening it to a number.
  const basis = value(context, "orderBasis") as Array<{ paidAmount: unknown }>;
  assert.equal(basis[0]?.paidAmount, null);
});

// --- Windows -------------------------------------------------------------------------------------

test("the Manila day boundary decides the day, not UTC", () => {
  // 16:30Z on the 8th is 00:30 on the 9th in Manila -- today. 15:30Z is 23:30 on the 8th -- not.
  const justAfterMidnight = build({ orders: [order({ payment_status: "paid", paid_at: "2026-08-08T16:30:00.000Z", paid_amount: 100 })] });
  assert.equal(value(justAfterMidnight, "grossPaidRevenueToday"), 100);

  const justBeforeMidnight = build({ orders: [order({ payment_status: "paid", paid_at: "2026-08-08T15:30:00.000Z", paid_amount: 100 })] });
  assert.equal(value(justBeforeMidnight, "grossPaidRevenueToday"), 0, "23:30 Manila on the 8th is not today");
  assert.equal(value(justBeforeMidnight, "grossPaidRevenueRolling7d"), 100, "but it is inside the rolling week");
});

test("the rolling window is seven business days inclusive of today", () => {
  const onFarEdge = build({ orders: [order({ placed_at: "2026-08-02T18:00:00.000Z" })] }); // 2026-08-03 Manila
  assert.equal(value(onFarEdge, "ordersPlacedRolling7d"), 1);

  const justOutside = build({ orders: [order({ placed_at: "2026-08-01T18:00:00.000Z" })] }); // 2026-08-02 Manila
  assert.equal(value(justOutside, "ordersPlacedRolling7d"), 0);
});

// --- Operational measurements ----------------------------------------------------------------------

test("each attention count measures exactly what its key says", () => {
  const context = build({
    orders: [
      order({ id: "new1", status: "new" }),
      order({ id: "sched", status: "confirmed", fulfillment_at: null }),
      order({ id: "ready1", status: "ready", fulfillment_at: TODAY_LATE }),
      order({ id: "late", status: "confirmed", fulfillment_at: YESTERDAY }),
      order({ id: "done", status: "completed", fulfillment_at: TODAY_LATE }),
      order({ id: "gone", status: "cancelled", fulfillment_at: TODAY_LATE }),
    ],
  });

  assert.equal(value(context, "newAwaitingConfirmation"), 1);
  assert.equal(value(context, "confirmedNeedingScheduling"), 1);
  assert.equal(value(context, "readyForHandover"), 1, "no date window: `ready` is `ready`");
  assert.equal(value(context, "overdueHandovers"), 1, "yesterday's agreed day, still open");
  // Scheduled today AND still open: ready1 only. completed and cancelled are closed.
  assert.equal(value(context, "remainingHandoversToday"), 1);
});

test("intake counts orders that arrived, including ones later cancelled", () => {
  const context = build({
    orders: [
      order({ id: "a", placed_at: TODAY_EARLY }),
      order({ id: "b", placed_at: TODAY_EARLY, status: "cancelled" }),
      order({ id: "c", placed_at: IN_WEEK }),
      order({ id: "d", placed_at: BEFORE_WEEK }),
    ],
  });
  assert.equal(value(context, "ordersPlacedToday"), 2);
  assert.equal(value(context, "ordersPlacedRolling7d"), 3);
});

// --- Source normalization ---------------------------------------------------------------------------

test("source counts carry every declared source, zeroes included", () => {
  const context = build({ orders: [order({ id: "a", source: "instagram" }), order({ id: "b", source: "instagram" }), order({ id: "c", source: null })] });
  const counts = value(context, "orderCountBySourceRolling7d") as Record<string, number>;

  // Every ORDER_SOURCES member present. attribution.ts drops zero-count sources and sorts by count;
  // publishing that array would make "no orders from Facebook" indistinguishable from "Facebook is
  // not a channel", and would carry a ranking into an envelope that requires an orderingId for one.
  assert.deepEqual(Object.keys(counts).sort(), [...ORDER_SOURCES].sort());
  assert.equal(counts.instagram, 2);
  assert.equal(counts.unknown, 1, "a null source is unknown, and unknown is a first-class key");
  assert.equal(counts.facebook, 0, "explicitly zero, not absent");
});

test("the source object is order-insensitive", () => {
  const a = build({ orders: [order({ id: "a", source: "facebook" }), order({ id: "b", source: "instagram" }), order({ id: "c", source: "instagram" })] });
  const b = build({ orders: [order({ id: "c", source: "instagram" }), order({ id: "a", source: "facebook" }), order({ id: "b", source: "instagram" })] });
  assert.deepEqual(value(a, "orderCountBySourceRolling7d"), value(b, "orderCountBySourceRolling7d"));
});

test("source counts respect the rolling window", () => {
  const context = build({ orders: [order({ id: "in", source: "facebook", placed_at: IN_WEEK }), order({ id: "out", source: "facebook", placed_at: BEFORE_WEEK })] });
  const counts = value(context, "orderCountBySourceRolling7d") as Record<string, number>;
  assert.equal(counts.facebook, 1, "the key says Rolling7d and means it");
});

// --- Provenance ---------------------------------------------------------------------------------------

test("the two basis facts carry physical lineage and depend on nothing", () => {
  const context = build({ orders: [order({ id: "o1" }), order({ id: "o2" })], lines: [line({ id: "l1" }), line({ id: "l2" })] });

  const orderSource = sourceOf(context, "orderBasis");
  assert.equal(orderSource?.kind, "entered");
  assert.equal(orderSource?.table, "orders");
  assert.deepEqual(orderSource?.rowIds, ["o1", "o2"]);
  assert.equal(orderSource?.inputs, undefined, "nothing precedes a root fact");
  assert.equal(orderSource?.computedBy, undefined, "a root projection is not computed from a fact");

  const lineSource = sourceOf(context, "orderLineBasis");
  assert.equal(lineSource?.kind, "entered");
  assert.equal(lineSource?.table, "order_lines");
  assert.deepEqual(lineSource?.rowIds, ["l1", "l2"]);
  assert.equal(lineSource?.inputs, undefined);
  assert.equal(lineSource?.computedBy, undefined);
});

test("every aggregate declares dependency lineage and no physical lineage", () => {
  const context = build({ orders: [order()], lines: [line()] });

  for (const key of AGGREGATE_KEYS) {
    const source = sourceOf(context, key);
    assert.ok(source, `${key} must carry provenance`);
    assert.ok(["derived", "calculated"].includes(source.kind), `${key} kind was ${source.kind}`);
    assert.equal(source.computedBy, "buildSellingSummary", `${key} must name its calculator`);
    assert.ok(source.inputs && source.inputs.length > 0, `${key} must declare inputs`);
    for (const input of source.inputs ?? []) {
      assert.ok(["selling.facts.orderBasis", "selling.facts.orderLineBasis"].includes(input), `${key} declared an unknown input ${input}`);
    }
    // Physical lineage belongs to the bases. Provenance has one table and one rowIds array, which
    // could not describe a fact spanning two tables anyway.
    assert.equal(source.table, undefined, `${key} must not claim a table`);
    assert.equal(source.rowIds, undefined, `${key} must not carry row ids`);
  }
});

test("unpaidReceivableValue cites both bases, and order-only facts cite one", () => {
  const context = build({ orders: [order()], lines: [line()] });

  // The case a single table/column citation cannot express: it reads order_lines totals, gated by
  // an orders-level payment and lifecycle state.
  assert.deepEqual(sourceOf(context, "unpaidReceivableValue")?.inputs, ["selling.facts.orderBasis", "selling.facts.orderLineBasis"]);

  for (const key of AGGREGATE_KEYS.filter((k) => k !== "unpaidReceivableValue")) {
    assert.deepEqual(sourceOf(context, key)?.inputs, ["selling.facts.orderBasis"], `${key} depends on orders only`);
  }
});

// --- Sanitization -------------------------------------------------------------------------------------

test("the basis projects only the columns the measurements consume", () => {
  const context = build({
    orders: [order({
      customer_id: "customer-secret", notes: "Call her mum first", source_ref: "IG-POST-9",
      fulfillment_address: "12 Real Street", fulfillment_notes: "Leave with the guard",
      payment_method: "gcash", cancel_reason: "Changed mind",
    })],
    lines: [line({ item_name: "Brownie box", product_id: "brownies", selling_format_id: "fmt-1", note: "extra fudgy" })],
  });

  assert.deepEqual(Object.keys((value(context, "orderBasis") as object[])[0] as object), [
    "id", "status", "paymentStatus", "placedAt", "fulfillmentAt", "paidAt", "paidAmount", "refundedAt", "source", "updatedAt",
  ]);
  assert.deepEqual(Object.keys((value(context, "orderLineBasis") as object[])[0] as object), ["id", "orderId", "quantity", "unitPrice"]);

  // Nothing personal or free-text reaches the envelope, anywhere in it.
  const serialized = JSON.stringify(context);
  for (const secret of ["customer-secret", "Call her mum first", "IG-POST-9", "12 Real Street", "Leave with the guard", "Changed mind", "extra fudgy", "gcash"]) {
    assert.equal(serialized.includes(secret), false, `the envelope must not contain "${secret}"`);
  }
  // And the excluded column names never appear as keys either.
  for (const column of ["customerId", "customer_id", "sourceRef", "fulfillmentAddress", "fulfillmentNotes", "itemName", "productId", "sellingFormatId", "paymentMethod", "cancelReason"]) {
    assert.equal(serialized.includes(`"${column}"`), false, `the envelope must not carry a ${column} key`);
  }
});

test("the basis records what was stored, not what the UI mapper would substitute", () => {
  // mapOrderRow turns an unrecognised status into "new" and an unrecognised source into "unknown".
  // Right for a screen; wrong for evidence. The basis must not claim the database said "new".
  const context = build({ orders: [order({ status: "definitely-not-a-status", payment_status: "??", source: "carrier-pigeon" })] });
  const basis = (value(context, "orderBasis") as Array<Record<string, unknown>>)[0];

  assert.equal(basis?.status, "definitely-not-a-status");
  assert.equal(basis?.paymentStatus, "??");
  assert.equal(basis?.source, "carrier-pigeon");

  // The measurements still classify defensively, which is correct -- they are measurements, not
  // evidence, and they must not throw on a malformed row.
  assert.equal(value(context, "newAwaitingConfirmation"), 1, "the mapper's fallback governs the count");
  assert.equal((value(context, "orderCountBySourceRolling7d") as Record<string, number>).unknown, 1);
});

// --- Empty vs failed -------------------------------------------------------------------------------------

test("a successful empty read is a real business fact, not an absence", () => {
  const context = build();

  assert.equal(context.readOutcome.ok, true);
  assert.equal(stateOf(context, "orderBasis"), "empty", "the collection exists and has no members");
  assert.equal(stateOf(context, "orderLineBasis"), "empty");
  assert.equal(context.sourceAsOf.state, "empty");

  // Zero orders means zero revenue. That is known(0) -- a real zero -- never empty or unknown.
  for (const key of AGGREGATE_KEYS.filter((k) => k !== "orderCountBySourceRolling7d")) {
    assert.equal(stateOf(context, key), "known", `${key} must be known on a successful empty read`);
    assert.equal(value(context, key), 0);
  }
  const counts = value(context, "orderCountBySourceRolling7d") as Record<string, number>;
  assert.deepEqual(Object.values(counts), ORDER_SOURCES.map(() => 0));
  assert.deepEqual(context.rowCounts, { read: 0, included: 0, omitted: 0 });
});

test("a failed read is unavailable everywhere, and never a zero business", () => {
  const context = buildSellingDomainContextFromFailure({ ok: false, reason: "failed", message: "connection reset" });

  assert.equal(context.readOutcome.ok, false);
  assert.equal(context.sourceAsOf.state, "unavailable");
  for (const key of ["orderBasis", "orderLineBasis", ...AGGREGATE_KEYS]) {
    assert.equal(stateOf(context, key), "unavailable", `${key} must be unavailable`);
  }
  assert.match(context.notes[0] ?? "", /connection reset/);
});

test("a missing table is not_configured, which is a different fact from a failure", () => {
  const context = buildSellingDomainContextFromFailure({ ok: false, reason: "missing-table", message: "relation does not exist" });
  for (const key of ["orderBasis", "orderLineBasis", ...AGGREGATE_KEYS]) {
    assert.equal(stateOf(context, key), "not_configured", `${key} must be not_configured`);
  }
  assert.equal(context.sourceAsOf.state, "not_configured");
});

test("empty and failed are observably different for every fact", () => {
  // The distinction this domain exists to keep. A screen of zeroes and a failed read look identical
  // unless the states differ, and only one of them is safe to act on.
  const empty = build();
  const failed = buildSellingDomainContextFromFailure({ ok: false, reason: "failed", message: "boom" });

  for (const key of ["orderBasis", ...AGGREGATE_KEYS]) {
    assert.notEqual(stateOf(empty, key), stateOf(failed, key), `${key} must distinguish empty from failed`);
  }
  assert.equal(empty.readOutcome.ok, true);
  assert.equal(failed.readOutcome.ok, false);
});

// --- sourceAsOf ---------------------------------------------------------------------------------------

test("sourceAsOf is the latest order updated_at, ignoring unparseable values", () => {
  const context = build({
    orders: [
      order({ id: "a", updated_at: "2026-08-05T00:00:00.000Z" }),
      order({ id: "b", updated_at: "2026-08-08T09:00:00.000Z" }),
      order({ id: "c", updated_at: "not-a-timestamp" }),
      order({ id: "d", updated_at: null }),
    ],
  });
  assert.deepEqual(context.sourceAsOf, {
    state: "known",
    value: "2026-08-08T09:00:00.000Z",
    source: { kind: "entered", table: "orders", column: "updated_at" },
  });
});

// --- Measurements only ---------------------------------------------------------------------------------

test("the domain emits no signals, no AI text, and no verdict", () => {
  const context = build({ orders: [order()], lines: [line()] });

  assert.deepEqual(context.signals, [], "S8 publishes measurements, not judgements");
  assert.equal(context.aiGenerated, undefined);

  const serialized = JSON.stringify(context);
  // P13 holds even now that sales data exists, and frozen §6.3 forbids rankings without a versioned
  // orderingId.
  for (const forbidden of ["mostOrdered", "topProduct", "bestChannel", "bottleneck", "topPriority", "businessStage", "highestValueOpportunity", "recommend", "forecast", "predicted"]) {
    assert.equal(serialized.includes(forbidden), false, `must not publish ${forbidden}`);
  }
});

// --- Structural: composition, not calculation -------------------------------------------------------------

test("the adapter composes buildSellingSummary and reimplements no Selling rule", () => {
  const source = readFileSync(new URL("../src/lib/business-context/adapters/selling.ts", import.meta.url), "utf8");
  const code = source.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");

  assert.match(code, /buildSellingSummary\(\{ orders, linesByOrderId, nowMs: env\.now, timeZone: env\.timezone \}\)/);
  assert.equal((code.match(/buildSellingSummary\(/g) ?? []).length, 1, "called exactly once per build");

  // It reaches revenue/pieces/attribution/fulfillment/totals/business-day ONLY through the summary.
  for (const forbidden of ["orders/revenue", "orders/pieces", "orders/attribution", "orders/fulfillment", "orders/totals", "business-day"]) {
    assert.equal(code.includes(forbidden), false, `the adapter must not import ${forbidden}`);
  }
  for (const forbidden of ["grossRevenue(", "netRevenue(", "refunds(", "unpaidOrderValue(", "getPreparationTotals", "getOrderCountsBySource", "isScheduled(", "filterOrdersByFulfillment", "resolveBusinessDay", "singleDayRange", "resolveTodayRange", "resolveRollingWeekRange"]) {
    assert.equal(code.includes(forbidden), false, `the adapter must not call ${forbidden}`);
  }
});

test("the adapter holds no client, no repository, no React, and no clock", () => {
  const source = readFileSync(new URL("../src/lib/business-context/adapters/selling.ts", import.meta.url), "utf8");
  const code = source.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");

  for (const forbidden of ["supabase", "orders-repository", "listOrders", "listOrderLines", "react", "@/components", "createClient", ".rpc(", "insert(", "upsert("]) {
    assert.equal(code.includes(forbidden), false, `the adapter must not reference ${forbidden}`);
  }
  assert.equal(/\.from\(\s*["'`]/.test(code), false, "the adapter must not query a table");
  assert.equal(/Date\.now\(\)/.test(code), false, "env.now is the only clock");
  assert.equal(code.includes("getToday"), false);
});
