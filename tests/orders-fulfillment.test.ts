// S5: fulfilment as attributes.
//
// Two things are being defended here. The first is ordinary: an operator can correct pickup vs
// delivery, the agreed time, and the address, and that correction persists without touching
// anything else on the order. The second is the one worth writing tests for at all -- that
// fulfilment never quietly becomes a second state machine, and that "not scheduled yet" stays a
// real answer rather than being filled in with an invented time to make the list tidier.
//
// THE STUB HONOURS PREDICATES. An earlier version of this file forced the conflict outcome with an
// `updateMatches: false` flag, which proved the conflict-handling branch while proving nothing about
// whether a stale version actually fails to match. That gap hid a real defect: the repository was
// re-reading the version immediately before writing, so a stale form always matched and overwrote
// the newer row while reporting success. The stub below evaluates the eq() predicates against the
// row as it actually stands, so "stale" has to earn its conflict.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { filterOrdersByFulfillment, getActiveDeliveryAddress, isScheduled, sortOrdersByFulfillment } from "../src/lib/orders/fulfillment.ts";
import { updateOrderFulfillment, updatePaymentStatus, type OrdersClient } from "../src/lib/orders-repository.ts";
import { FULFILLMENT_METHODS, ORDER_STATUSES, type Order, type OrderLine } from "../src/lib/orders/types.ts";

const ORDER_ID = "order-1";
const NOW = "2026-08-10T06:00:00.000Z";
// The version the form was rendered from.
const V1 = "2026-08-09T06:00:00.000Z";
// What a competing writer advanced the row to.
const V2 = "2026-08-09T09:00:00.000Z";
const TZ = "Asia/Manila";

function order(overrides: Partial<Order> = {}): Order {
  return {
    id: ORDER_ID,
    customerId: "customer-1",
    status: "new",
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
    placedAt: V1,
    completedAt: null,
    cancelledAt: null,
    cancelReason: "",
    createdAt: V1,
    updatedAt: V1,
    ...overrides,
  };
}

function orderRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ORDER_ID,
    customer_id: "customer-1",
    status: "new",
    payment_status: "unpaid",
    payment_method: null,
    paid_at: null,
    paid_amount: null,
    refunded_at: null,
    fulfillment_method: "pickup",
    fulfillment_at: null,
    fulfillment_address: null,
    fulfillment_notes: null,
    source: "unknown",
    source_ref: null,
    entry_method: "manual",
    notes: null,
    placed_at: V1,
    completed_at: null,
    cancelled_at: null,
    cancel_reason: null,
    created_at: V1,
    updated_at: V1,
    ...overrides,
  };
}

function line(overrides: Partial<OrderLine> = {}): OrderLine {
  return { id: "line-1", orderId: ORDER_ID, productId: "", sellingFormatId: "", itemName: "Brownies", unitPrice: 480, piecesPerUnitSnapshot: null, quantity: 1, sortOrder: 0, note: "", ...overrides };
}

type StubClient = OrdersClient & {
  updates: { payload: Record<string, unknown>; predicates: [string, string][] }[];
  persisted(): Record<string, unknown> | null;
};

function createStubClient({ persisted, error }: { persisted: Record<string, unknown> | null; error?: { code?: string; message: string } }): StubClient {
  const updates: { payload: Record<string, unknown>; predicates: [string, string][] }[] = [];
  let current = persisted;

  const client = {
    from() {
      return {
        select: () => {
          const chain = {
            eq: () => chain,
            in: () => chain,
            order: () => chain,
            limit: () => chain,
            then: (resolve: (v: unknown) => unknown) => resolve(error ? { data: null, error } : { data: current ? [current] : [], error: null }),
          };
          return chain;
        },
        upsert: () => Promise.resolve({ data: null, error: null }),
        update: (payload: Record<string, unknown>) => {
          const predicates: [string, string][] = [];
          const builder = {
            eq: (column: string, value: string) => {
              predicates.push([column, value]);
              return builder;
            },
            select: () => ({
              maybeSingle: () => {
                updates.push({ payload, predicates });
                if (error) return Promise.resolve({ data: null, error });

                // The whole point: every predicate is evaluated against the row as it stands right
                // now. A predicate naming a version the row has moved past matches nothing.
                const matches = current !== null && predicates.every(([column, value]) => current?.[column] === value);
                if (!matches) {
                  return Promise.resolve({ data: null, error: null });
                }

                current = { ...current, ...payload };
                return Promise.resolve({ data: current, error: null });
              },
            }),
          };
          return builder;
        },
      };
    },
    rpc: () => Promise.resolve({ data: null, error: null }),
    updates,
    persisted: () => current,
  };

  return client as unknown as StubClient;
}

// --- Address visibility --------------------------------------------------------------------------

test("a delivery order's address is active data", () => {
  const delivery = order({ fulfillmentMethod: "delivery", fulfillmentAddress: "12 Mabini St, Malate" });
  assert.equal(getActiveDeliveryAddress(delivery), "12 Mabini St, Malate");
});

test("a pickup order never presents a delivery address as active", () => {
  // The important case is not the clean one -- it is a row that still CARRIES an address while
  // being a pickup, however it got that way. Reading the column directly would render it beside
  // the word "Pickup" as though someone were driving there.
  const pickupWithStaleAddress = order({ fulfillmentMethod: "pickup", fulfillmentAddress: "12 Mabini St, Malate" });

  assert.equal(getActiveDeliveryAddress(pickupWithStaleAddress), "");
  assert.notEqual(pickupWithStaleAddress.fulfillmentAddress, "", "the stored column is deliberately left alone; only its ACTIVE reading is empty");
});

// --- Unscheduled orders --------------------------------------------------------------------------

test("fulfillment_at may be null, and null means unscheduled rather than missing", () => {
  assert.equal(isScheduled(order({ fulfillmentAt: null })), false);
  assert.equal(isScheduled(order({ fulfillmentAt: "2026-08-10T06:00:00.000Z" })), true);
  // An unreadable value is unknown, not a crash and not a date.
  assert.equal(isScheduled(order({ fulfillmentAt: "sometime next week" })), false);
});

test("an unscheduled order is never assigned an invented time", () => {
  const orders = [order({ id: "a", fulfillmentAt: null }), order({ id: "b", fulfillmentAt: "2026-08-10T06:00:00.000Z" })];

  const sorted = sortOrdersByFulfillment(orders, "soonest");
  const filtered = filterOrdersByFulfillment(orders, "all", { nowMs: Date.parse(NOW), timeZone: TZ });
  const unscheduledOnly = filterOrdersByFulfillment(orders, "unscheduled", { nowMs: Date.parse(NOW), timeZone: TZ });

  for (const result of [sorted, filtered, unscheduledOnly]) {
    for (const entry of result) {
      if (entry.id === "a") {
        assert.equal(entry.fulfillmentAt, null, "reading the list must not fill in a time");
      }
    }
  }
});

// --- Sorting ---------------------------------------------------------------------------------------

test("sorting by handover time puts the soonest first and the unscheduled last", () => {
  const orders = [
    order({ id: "late", fulfillmentAt: "2026-08-12T02:00:00.000Z" }),
    order({ id: "unscheduled", fulfillmentAt: null }),
    order({ id: "soon", fulfillmentAt: "2026-08-10T02:00:00.000Z" }),
    order({ id: "middle", fulfillmentAt: "2026-08-11T02:00:00.000Z" }),
  ];

  assert.deepEqual(
    sortOrdersByFulfillment(orders, "soonest").map((entry) => entry.id),
    ["soon", "middle", "late", "unscheduled"],
  );
});

test("sorting by handover time is deterministic", () => {
  // Two orders share a time and two are unscheduled -- exactly the cases where an unstable sort
  // would reshuffle the list on every render.
  const orders = [
    order({ id: "u1", fulfillmentAt: null }),
    order({ id: "a", fulfillmentAt: "2026-08-10T02:00:00.000Z" }),
    order({ id: "u2", fulfillmentAt: null }),
    order({ id: "b", fulfillmentAt: "2026-08-10T02:00:00.000Z" }),
  ];

  const first = sortOrdersByFulfillment(orders, "soonest").map((entry) => entry.id);
  const second = sortOrdersByFulfillment(orders, "soonest").map((entry) => entry.id);

  assert.deepEqual(first, second);
  assert.deepEqual(first, ["a", "b", "u1", "u2"], "ties keep the order they arrived in");
});

test("the default sort leaves the repository's own ordering untouched", () => {
  const orders = [order({ id: "a" }), order({ id: "b" })];
  assert.equal(sortOrdersByFulfillment(orders, "placed"), orders);
});

// --- Filtering -------------------------------------------------------------------------------------

test("the default view keeps unscheduled orders visible", () => {
  const orders = [order({ id: "scheduled", fulfillmentAt: "2026-08-10T02:00:00.000Z" }), order({ id: "unscheduled", fulfillmentAt: null })];

  assert.deepEqual(
    filterOrdersByFulfillment(orders, "all", { nowMs: Date.parse(NOW), timeZone: TZ }).map((entry) => entry.id),
    ["scheduled", "unscheduled"],
  );
});

test("only a filter that explicitly asks for a scheduled subset may drop unscheduled orders", () => {
  const orders = [order({ id: "today", fulfillmentAt: "2026-08-10T02:00:00.000Z" }), order({ id: "unscheduled", fulfillmentAt: null })];
  const at = { nowMs: Date.parse(NOW), timeZone: TZ };

  // "Handover today" is the only filter that asks for a scheduled subset, and an order with no
  // agreed time genuinely is not on today's list.
  assert.deepEqual(filterOrdersByFulfillment(orders, "today", at).map((entry) => entry.id), ["today"]);
  // Everything else keeps them, or is about them.
  assert.deepEqual(filterOrdersByFulfillment(orders, "all", at).map((entry) => entry.id), ["today", "unscheduled"]);
  assert.deepEqual(filterOrdersByFulfillment(orders, "unscheduled", at).map((entry) => entry.id), ["unscheduled"]);
});

test("'today' is resolved in Manila, not UTC", () => {
  // 2026-08-09T20:00Z is 2026-08-10 04:00 in Manila. Under UTC this order is yesterday's; in
  // Manila -- where the bread is actually handed over -- it is today's.
  const orders = [order({ id: "manila-today", fulfillmentAt: "2026-08-09T20:00:00.000Z" })];
  const nowMs = Date.parse("2026-08-10T00:00:00.000Z"); // 08:00 on the 10th, Manila.

  assert.deepEqual(filterOrdersByFulfillment(orders, "today", { nowMs, timeZone: TZ }).map((entry) => entry.id), ["manila-today"]);
  assert.deepEqual(filterOrdersByFulfillment(orders, "today", { nowMs, timeZone: "UTC" }).map((entry) => entry.id), [], "the same data under UTC would file it a day early -- which is the bug business-day.ts exists to prevent");
});

test("the Manila day boundary falls at 16:00Z, not at midnight UTC", () => {
  // Manila is UTC+8, so its day rolls over at 16:00Z the previous day. These two orders are one
  // minute apart and belong to different business days.
  const orders = [
    order({ id: "before-boundary", fulfillmentAt: "2026-08-11T15:59:00.000Z" }), // Manila 2026-08-11 23:59
    order({ id: "after-boundary", fulfillmentAt: "2026-08-11T16:00:00.000Z" }), // Manila 2026-08-12 00:00
  ];

  const duringAug11Manila = Date.parse("2026-08-11T15:30:00.000Z");
  const duringAug12Manila = Date.parse("2026-08-11T16:30:00.000Z");

  assert.deepEqual(filterOrdersByFulfillment(orders, "today", { nowMs: duringAug11Manila, timeZone: TZ }).map((entry) => entry.id), ["before-boundary"]);
  assert.deepEqual(filterOrdersByFulfillment(orders, "today", { nowMs: duringAug12Manila, timeZone: TZ }).map((entry) => entry.id), ["after-boundary"]);
});

// --- Persisting a correction -----------------------------------------------------------------------

test("an existing order's handover time can be updated with the version the form was rendered from", async () => {
  const client = createStubClient({ persisted: orderRow({ fulfillment_at: "2026-08-10T02:00:00.000Z" }) });
  const result = await updateOrderFulfillment(client, { orderId: ORDER_ID, expectedUpdatedAt: V1, fulfillmentMethod: "pickup", fulfillmentAt: "2026-08-10T08:00:00.000Z", fulfillmentAddress: "", now: NOW });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.order.fulfillmentAt, "2026-08-10T08:00:00.000Z");
  assert.equal(client.updates[0].payload.updated_at, NOW);
});

test("a scheduled order can be put back to unscheduled", async () => {
  const client = createStubClient({ persisted: orderRow({ fulfillment_at: "2026-08-10T02:00:00.000Z" }) });
  const result = await updateOrderFulfillment(client, { orderId: ORDER_ID, expectedUpdatedAt: V1, fulfillmentMethod: "pickup", fulfillmentAt: null, fulfillmentAddress: "", now: NOW });

  assert.equal(result.ok, true);
  assert.equal(client.updates[0].payload.fulfillment_at, null);
  assert.equal(client.persisted()?.fulfillment_at, null);
});

test("switching a delivery to pickup clears the address rather than hiding it", async () => {
  const client = createStubClient({ persisted: orderRow({ fulfillment_method: "delivery", fulfillment_address: "12 Mabini St, Malate" }) });
  const result = await updateOrderFulfillment(client, { orderId: ORDER_ID, expectedUpdatedAt: V1, fulfillmentMethod: "pickup", fulfillmentAt: null, fulfillmentAddress: "12 Mabini St, Malate", now: NOW });

  assert.equal(result.ok, true);
  // Cleared in the payload, so it cannot resurface later claiming to be current.
  assert.equal(client.updates[0].payload.fulfillment_address, null);
  if (!result.ok) return;
  assert.equal(getActiveDeliveryAddress(result.order), "");
});

test("switching to delivery persists the address", async () => {
  const client = createStubClient({ persisted: orderRow() });
  const result = await updateOrderFulfillment(client, { orderId: ORDER_ID, expectedUpdatedAt: V1, fulfillmentMethod: "delivery", fulfillmentAt: null, fulfillmentAddress: "12 Mabini St, Malate", now: NOW });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(getActiveDeliveryAddress(result.order), "12 Mabini St, Malate");
});

test("a fulfilment update writes ZERO lifecycle, payment, attribution or line columns", async () => {
  // The whole reason this operation exists instead of reusing save_order, which takes the full
  // order row including every payment field.
  const client = createStubClient({ persisted: orderRow({ status: "confirmed", payment_status: "paid", paid_at: V1, paid_amount: 480, payment_method: "gcash", source: "instagram" }) });
  const result = await updateOrderFulfillment(client, { orderId: ORDER_ID, expectedUpdatedAt: V1, fulfillmentMethod: "delivery", fulfillmentAt: NOW, fulfillmentAddress: "12 Mabini St", now: NOW });

  assert.equal(result.ok, true);
  const payload = client.updates[0].payload;
  for (const forbidden of ["status", "completed_at", "cancelled_at", "cancel_reason", "payment_status", "payment_method", "paid_at", "paid_amount", "refunded_at", "source", "source_ref", "entry_method", "customer_id", "placed_at", "notes"]) {
    assert.equal(Object.hasOwn(payload, forbidden), false, `a fulfilment update must not carry ${forbidden}`);
  }

  assert.deepEqual(Object.keys(payload).sort(), ["fulfillment_address", "fulfillment_at", "fulfillment_method", "updated_at"]);

  if (!result.ok) return;
  assert.equal(result.order.paidAmount, 480, "the recorded payment is untouched");
  assert.equal(result.order.paidAt, V1);
  assert.equal(result.order.status, "confirmed", "and so is the lifecycle");
  assert.equal(result.order.source, "instagram");
});

// --- Stale-version protection (the PR #35 review finding) --------------------------------------------

test("the conditional update is guarded on the version the CALLER supplied, not a fresh reading", async () => {
  // The row has already moved to V2. If the repository re-read the version for itself it would use
  // V2 here and match; it must use the caller's V1 and miss.
  const client = createStubClient({ persisted: orderRow({ updated_at: V2 }) });
  await updateOrderFulfillment(client, { orderId: ORDER_ID, expectedUpdatedAt: V1, fulfillmentMethod: "pickup", fulfillmentAt: null, fulfillmentAddress: "", now: NOW });

  assert.deepEqual(client.updates[0].predicates, [
    ["id", ORDER_ID],
    ["updated_at", V1],
  ]);
});

test("a stale fulfilment edit conflicts instead of overwriting a newer row", async () => {
  // The exact race from the review: the form was rendered at V1, another caller advanced the row to
  // V2 with a later handover, and now the stale form saves the time it was rendered with.
  const COMPETING_AT = "2026-08-11T02:00:00.000Z";
  const client = createStubClient({ persisted: orderRow({ updated_at: V2, fulfillment_at: COMPETING_AT, fulfillment_method: "delivery", fulfillment_address: "12 Mabini St" }) });

  const result = await updateOrderFulfillment(client, { orderId: ORDER_ID, expectedUpdatedAt: V1, fulfillmentMethod: "pickup", fulfillmentAt: "2026-08-10T02:00:00.000Z", fulfillmentAddress: "", now: NOW });

  assert.equal(result.ok, false, "a stale edit must never report success");
  if (result.ok) return;
  assert.equal(result.reason, "conflict");
  assert.match(result.message, /changed while you were looking at it/i);

  // The conflict carries the ACTUAL persisted order.
  assert.equal(result.currentOrder?.fulfillmentAt, COMPETING_AT);
  assert.equal(result.currentOrder?.fulfillmentMethod, "delivery");

  // And none of the losing mutation's values is treated as persisted -- in the row or in the result.
  assert.equal(client.persisted()?.fulfillment_at, COMPETING_AT, "the competing handover time survived");
  assert.equal(client.persisted()?.fulfillment_method, "delivery");
  assert.equal(client.persisted()?.updated_at, V2, "and the row version was not advanced by the losing write");
  assert.notEqual(result.currentOrder?.fulfillmentAt, "2026-08-10T02:00:00.000Z");
  assert.notEqual(result.currentOrder?.fulfillmentMethod, "pickup");
});

test("a stale PICKUP edit cannot erase a newer delivery address", async () => {
  // Tab A switches to pickup from a V1 render. Tab B has since changed the address and advanced the
  // row. A pickup write clears the address column, so if this succeeded it would silently destroy
  // Tab B's newer address.
  const client = createStubClient({ persisted: orderRow({ updated_at: V2, fulfillment_method: "delivery", fulfillment_address: "77 Bagumbayan Rd" }) });

  const result = await updateOrderFulfillment(client, { orderId: ORDER_ID, expectedUpdatedAt: V1, fulfillmentMethod: "pickup", fulfillmentAt: null, fulfillmentAddress: "12 Mabini St", now: NOW });

  assert.equal(result.ok, false);
  assert.equal(client.persisted()?.fulfillment_address, "77 Bagumbayan Rd", "the newer address must survive a stale pickup");
  assert.equal(client.persisted()?.fulfillment_method, "delivery");
});

test("a stale fulfilment edit after a PAYMENT mutation advanced the version cannot overwrite the row", async () => {
  // The version is shared across every write path, so recording a payment invalidates a fulfilment
  // form rendered before it. Marking paid is run through the real repository function here rather
  // than simulated, so the advance is genuine.
  const client = createStubClient({ persisted: orderRow({ fulfillment_at: "2026-08-10T02:00:00.000Z" }) });

  const paid = await updatePaymentStatus(client, { orderId: ORDER_ID, action: { kind: "mark-paid", method: "gcash", lines: [line()] }, now: V2 });
  assert.equal(paid.ok, true, "the payment itself must land");
  assert.equal(client.persisted()?.updated_at, V2, "and it advances the row version");

  const stale = await updateOrderFulfillment(client, { orderId: ORDER_ID, expectedUpdatedAt: V1, fulfillmentMethod: "delivery", fulfillmentAt: "2026-08-13T02:00:00.000Z", fulfillmentAddress: "12 Mabini St", now: NOW });

  assert.equal(stale.ok, false);
  if (stale.ok) return;
  assert.equal(stale.reason, "conflict");
  assert.equal(client.persisted()?.fulfillment_at, "2026-08-10T02:00:00.000Z", "the handover time was not overwritten");
  // And the payment the competing write recorded is intact and visible to the caller.
  assert.equal(stale.currentOrder?.paymentStatus, "paid");
  assert.equal(stale.currentOrder?.paidAmount, 480);
});

test("a missing order is reported as not-found rather than as a conflict", async () => {
  const client = createStubClient({ persisted: null });
  const result = await updateOrderFulfillment(client, { orderId: ORDER_ID, expectedUpdatedAt: V1, fulfillmentMethod: "pickup", fulfillmentAt: null, fulfillmentAddress: "", now: NOW });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "not-found");
});

test("a missing table degrades rather than looking like a business failure", async () => {
  const client = createStubClient({ persisted: orderRow(), error: { code: "42P01", message: "relation does not exist" } });
  const result = await updateOrderFulfillment(client, { orderId: ORDER_ID, expectedUpdatedAt: V1, fulfillmentMethod: "pickup", fulfillmentAt: null, fulfillmentAddress: "", now: NOW });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "missing-table");
});

// --- No second state machine -----------------------------------------------------------------------

test("there is no second fulfilment status anywhere in Selling", () => {
  // orders.status is the sole fulfilment state: `ready` is made and waiting, `completed` is handed
  // over. Comments are stripped first, exactly as tests/orders-schema.test.ts does, because the
  // modules below DISCUSS these names in prose while deliberately not implementing them.
  const sources = ["../src/lib/orders/fulfillment.ts", "../src/lib/orders/types.ts", "../src/lib/orders-repository.ts", "../src/components/orders-page.tsx"].map((path) =>
    readFileSync(new URL(path, import.meta.url), "utf8")
      .split("\n")
      .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*") && !line.trim().startsWith("/*"))
      .join("\n"),
  );
  const sql = readFileSync(new URL("../supabase-add-orders.sql", import.meta.url), "utf8")
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");

  for (const code of [...sources, sql]) {
    for (const forbidden of ["fulfillment_status", "fulfillmentStatus", "out_for_delivery", "preparing"]) {
      assert.equal(code.includes(forbidden), false, `${forbidden} would be a second fulfilment state`);
    }
  }

  // And the one real state machine is still exactly the five approved values.
  assert.deepEqual([...ORDER_STATUSES], ["new", "confirmed", "ready", "completed", "cancelled"]);
  assert.deepEqual([...FULFILLMENT_METHODS], ["pickup", "delivery"], "method is an attribute, not a state");
});
