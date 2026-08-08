// S5: fulfilment as attributes.
//
// Two things are being defended here. The first is ordinary: an operator can correct pickup vs
// delivery, the agreed time, and the address, and that correction persists without touching
// anything else on the order. The second is the one worth writing tests for at all -- that
// fulfilment never quietly becomes a second state machine, and that "not scheduled yet" stays a
// real answer rather than being filled in with an invented time to make the list tidier.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { filterOrdersByFulfillment, getActiveDeliveryAddress, isScheduled, sortOrdersByFulfillment } from "../src/lib/orders/fulfillment.ts";
import { updateOrderFulfillment, type OrdersClient } from "../src/lib/orders-repository.ts";
import { FULFILLMENT_METHODS, ORDER_STATUSES, type Order } from "../src/lib/orders/types.ts";

const ORDER_ID = "order-1";
const NOW = "2026-08-10T06:00:00.000Z";
const UPDATED_AT = "2026-08-09T06:00:00.000Z";
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
    placedAt: UPDATED_AT,
    completedAt: null,
    cancelledAt: null,
    cancelReason: "",
    createdAt: UPDATED_AT,
    updatedAt: UPDATED_AT,
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
    placed_at: UPDATED_AT,
    completed_at: null,
    cancelled_at: null,
    cancel_reason: null,
    created_at: UPDATED_AT,
    updated_at: UPDATED_AT,
    ...overrides,
  };
}

type StubClient = OrdersClient & { updates: { payload: Record<string, unknown>; predicates: [string, string][] }[] };

// Same hand-built stub shape tests/orders-lifecycle-payment.test.ts uses. `updateMatches: false`
// simulates the conditional update matching zero rows -- the row moved between the read and the
// write -- and `afterConflict` is what the re-read then finds.
function createStubClient({ persisted, updateMatches = true, afterConflict, error }: { persisted: Record<string, unknown> | null; updateMatches?: boolean; afterConflict?: Record<string, unknown>; error?: { code?: string; message: string } }): StubClient {
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
                if (!updateMatches) {
                  if (afterConflict) current = afterConflict;
                  return Promise.resolve({ data: null, error: null });
                }
                current = { ...(current ?? {}), ...payload };
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

// --- Persisting a correction -----------------------------------------------------------------------

test("an existing order's handover time can be updated", async () => {
  const client = createStubClient({ persisted: orderRow({ fulfillment_at: "2026-08-10T02:00:00.000Z" }) });
  const result = await updateOrderFulfillment(client, { orderId: ORDER_ID, fulfillmentMethod: "pickup", fulfillmentAt: "2026-08-10T08:00:00.000Z", fulfillmentAddress: "", now: NOW });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.order.fulfillmentAt, "2026-08-10T08:00:00.000Z");
  assert.equal(client.updates[0].payload.updated_at, NOW);
});

test("a scheduled order can be put back to unscheduled", async () => {
  const client = createStubClient({ persisted: orderRow({ fulfillment_at: "2026-08-10T02:00:00.000Z" }) });
  const result = await updateOrderFulfillment(client, { orderId: ORDER_ID, fulfillmentMethod: "pickup", fulfillmentAt: null, fulfillmentAddress: "", now: NOW });

  assert.equal(result.ok, true);
  assert.equal(client.updates[0].payload.fulfillment_at, null);
});

test("switching a delivery to pickup clears the address rather than hiding it", async () => {
  const client = createStubClient({ persisted: orderRow({ fulfillment_method: "delivery", fulfillment_address: "12 Mabini St, Malate" }) });
  const result = await updateOrderFulfillment(client, { orderId: ORDER_ID, fulfillmentMethod: "pickup", fulfillmentAt: null, fulfillmentAddress: "12 Mabini St, Malate", now: NOW });

  assert.equal(result.ok, true);
  // Cleared in the payload, so it cannot resurface later claiming to be current.
  assert.equal(client.updates[0].payload.fulfillment_address, null);
  if (!result.ok) return;
  assert.equal(getActiveDeliveryAddress(result.order), "");
});

test("switching to delivery persists the address", async () => {
  const client = createStubClient({ persisted: orderRow() });
  const result = await updateOrderFulfillment(client, { orderId: ORDER_ID, fulfillmentMethod: "delivery", fulfillmentAt: null, fulfillmentAddress: "12 Mabini St, Malate", now: NOW });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(getActiveDeliveryAddress(result.order), "12 Mabini St, Malate");
});

test("a fulfilment update writes ZERO lifecycle, payment, attribution or line columns", async () => {
  // The whole reason this operation exists instead of reusing save_order, which takes the full
  // order row including every payment field.
  const client = createStubClient({ persisted: orderRow({ status: "confirmed", payment_status: "paid", paid_at: UPDATED_AT, paid_amount: 480, payment_method: "gcash", source: "instagram" }) });
  const result = await updateOrderFulfillment(client, { orderId: ORDER_ID, fulfillmentMethod: "delivery", fulfillmentAt: NOW, fulfillmentAddress: "12 Mabini St", now: NOW });

  assert.equal(result.ok, true);
  const payload = client.updates[0].payload;
  for (const forbidden of ["status", "completed_at", "cancelled_at", "cancel_reason", "payment_status", "payment_method", "paid_at", "paid_amount", "refunded_at", "source", "source_ref", "entry_method", "customer_id", "placed_at", "notes"]) {
    assert.equal(Object.hasOwn(payload, forbidden), false, `a fulfilment update must not carry ${forbidden}`);
  }

  assert.deepEqual(Object.keys(payload).sort(), ["fulfillment_address", "fulfillment_at", "fulfillment_method", "updated_at"]);

  if (!result.ok) return;
  assert.equal(result.order.paidAmount, 480, "the recorded payment is untouched");
  assert.equal(result.order.paidAt, UPDATED_AT);
  assert.equal(result.order.status, "confirmed", "and so is the lifecycle");
  assert.equal(result.order.source, "instagram");
});

test("a fulfilment update is guarded on the row version it read", async () => {
  const client = createStubClient({ persisted: orderRow() });
  await updateOrderFulfillment(client, { orderId: ORDER_ID, fulfillmentMethod: "pickup", fulfillmentAt: null, fulfillmentAddress: "", now: NOW });

  assert.deepEqual(client.updates[0].predicates, [
    ["id", ORDER_ID],
    ["updated_at", UPDATED_AT],
  ]);
});

test("a stale fulfilment update reports a conflict and overwrites nothing", async () => {
  // Another tab moved the handover to Tuesday and, in the same write, the row's version. This
  // caller still believes it is Monday's order.
  const COMPETING_AT = "2026-08-11T02:00:00.000Z";
  const client = createStubClient({
    persisted: orderRow({ fulfillment_at: "2026-08-10T02:00:00.000Z" }),
    updateMatches: false,
    afterConflict: orderRow({ fulfillment_at: COMPETING_AT, updated_at: "2026-08-09T09:00:00.000Z" }),
  });

  const result = await updateOrderFulfillment(client, { orderId: ORDER_ID, fulfillmentMethod: "delivery", fulfillmentAt: "2026-08-10T08:00:00.000Z", fulfillmentAddress: "12 Mabini St", now: NOW });

  assert.equal(result.ok, false, "zero matched rows is never success");
  if (result.ok) return;
  assert.equal(result.reason, "conflict");
  assert.match(result.message, /changed while you were looking at it/i);

  // The caller is handed the real persisted state, and none of its own losing edit.
  assert.equal(result.currentOrder?.fulfillmentAt, COMPETING_AT);
  assert.notEqual(result.currentOrder?.fulfillmentAt, "2026-08-10T08:00:00.000Z");
  assert.equal(result.currentOrder?.fulfillmentMethod, "pickup");
  assert.equal(result.currentOrder?.fulfillmentAddress, "");
});

test("a missing order is reported as not-found rather than written blindly", async () => {
  const client = createStubClient({ persisted: null });
  const result = await updateOrderFulfillment(client, { orderId: ORDER_ID, fulfillmentMethod: "pickup", fulfillmentAt: null, fulfillmentAddress: "", now: NOW });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "not-found");
  assert.equal(client.updates.length, 0);
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
