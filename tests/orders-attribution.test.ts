// S6: acquisition attribution.
//
// The thing most worth defending here is the split between two facts that look like one:
//
//   source       -- WHERE the order came from
//   entryMethod  -- HOW the record got into the app
//
// A hand-typed Instagram order is source=instagram AND entry_method=manual, both at once, and
// correcting the first must never restate the second. Collapsing them was a real defect in an
// earlier draft (source defaulted to "manual"), which silently attributed every hand-typed order to
// a non-channel -- destroying exactly the attribution the columns exist to enable.
//
// The second thing defended here is that source_ref stays opaque: not parsed, not trimmed, not
// validated, not joined to anything.
//
// The stub below HONOURS eq() predicates against the row as it stands, so a stale version has to
// earn its conflict rather than having one forced on it. See the header of
// tests/orders-fulfillment.test.ts for why that mattered.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getOrderCountsBySource } from "../src/lib/orders/attribution.ts";
import { filterOrdersByFulfillment } from "../src/lib/orders/fulfillment.ts";
import { mapOrderRow } from "../src/lib/orders/mappers.ts";
import { updateOrderAttribution, updateOrderFulfillment, updateOrderStatus, type OrdersClient } from "../src/lib/orders-repository.ts";
import { ORDER_SOURCES, type Order, type OrderRow } from "../src/lib/orders/types.ts";

const ORDER_ID = "order-1";
const NOW = "2026-08-10T06:00:00.000Z";
const V1 = "2026-08-09T06:00:00.000Z";
const V2 = "2026-08-09T09:00:00.000Z";

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

type StubClient = OrdersClient & {
  updates: { payload: Record<string, unknown>; predicates: [string, string][] }[];
  persisted(): Record<string, unknown> | null;
};

function createStubClient({ persisted }: { persisted: Record<string, unknown> | null }): StubClient {
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
            then: (resolve: (v: unknown) => unknown) => resolve({ data: current ? [current] : [], error: null }),
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

// --- Editing the channel ---------------------------------------------------------------------------

test("source is editable after creation", async () => {
  const client = createStubClient({ persisted: orderRow({ source: "unknown" }) });
  const result = await updateOrderAttribution(client, { orderId: ORDER_ID, expectedUpdatedAt: V1, source: "instagram", sourceRef: "", now: NOW });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.order.source, "instagram");
  assert.equal(client.updates[0].payload.updated_at, NOW);
});

test("changing source does not change entry_method", async () => {
  // The category error this split exists to prevent. Correcting WHERE an order came from says
  // nothing about HOW it was typed in, and a manually entered Instagram order stays both.
  const client = createStubClient({ persisted: orderRow({ source: "unknown", entry_method: "manual" }) });
  const result = await updateOrderAttribution(client, { orderId: ORDER_ID, expectedUpdatedAt: V1, source: "instagram", sourceRef: "POST-184", now: NOW });

  assert.equal(result.ok, true);
  assert.equal(Object.hasOwn(client.updates[0].payload, "entry_method"), false, "the payload has no column for it");
  if (!result.ok) return;
  assert.equal(result.order.source, "instagram");
  assert.equal(result.order.entryMethod, "manual");
});

test("an attribution update writes no payment, lifecycle or fulfilment columns", async () => {
  const client = createStubClient({ persisted: orderRow({ status: "completed", completed_at: V1, payment_status: "paid", paid_at: V1, paid_amount: 480, payment_method: "gcash", fulfillment_method: "delivery", fulfillment_address: "12 Mabini St" }) });
  const result = await updateOrderAttribution(client, { orderId: ORDER_ID, expectedUpdatedAt: V1, source: "referral", sourceRef: "Tita Baby", now: NOW });

  assert.equal(result.ok, true);
  const payload = client.updates[0].payload;
  for (const forbidden of ["payment_status", "payment_method", "paid_at", "paid_amount", "refunded_at", "status", "completed_at", "cancelled_at", "cancel_reason", "fulfillment_method", "fulfillment_at", "fulfillment_address", "entry_method", "customer_id", "placed_at"]) {
    assert.equal(Object.hasOwn(payload, forbidden), false, `an attribution update must not carry ${forbidden}`);
  }

  assert.deepEqual(Object.keys(payload).sort(), ["source", "source_ref", "updated_at"]);

  if (!result.ok) return;
  assert.equal(result.order.paidAmount, 480, "the recorded payment is untouched");
  assert.equal(result.order.paidAt, V1);
  assert.equal(result.order.status, "completed");
  assert.equal(result.order.fulfillmentAddress, "12 Mabini St");
});

// --- Stale-version protection (the PR #35 review finding) --------------------------------------------

test("the conditional update is guarded on the version the CALLER supplied, not a fresh reading", async () => {
  const client = createStubClient({ persisted: orderRow({ updated_at: V2 }) });
  await updateOrderAttribution(client, { orderId: ORDER_ID, expectedUpdatedAt: V1, source: "tiktok", sourceRef: "", now: NOW });

  assert.deepEqual(client.updates[0].predicates, [
    ["id", ORDER_ID],
    ["updated_at", V1],
  ]);
});

test("a stale attribution edit conflicts instead of overwriting a newer row", async () => {
  const client = createStubClient({ persisted: orderRow({ updated_at: V2, source: "facebook", source_ref: "FB-CAMPAIGN-9" }) });

  const result = await updateOrderAttribution(client, { orderId: ORDER_ID, expectedUpdatedAt: V1, source: "instagram", sourceRef: "POST-184", now: NOW });

  assert.equal(result.ok, false, "a stale edit must never report success");
  if (result.ok) return;
  assert.equal(result.reason, "conflict");

  // The conflict carries the actual persisted order...
  assert.equal(result.currentOrder?.source, "facebook");
  assert.equal(result.currentOrder?.sourceRef, "FB-CAMPAIGN-9");
  // ...and nothing of the losing mutation is treated as persisted.
  assert.equal(client.persisted()?.source, "facebook");
  assert.equal(client.persisted()?.source_ref, "FB-CAMPAIGN-9");
  assert.equal(client.persisted()?.updated_at, V2);
  assert.notEqual(result.currentOrder?.source, "instagram");
  assert.notEqual(result.currentOrder?.sourceRef, "POST-184");
});

test("a stale attribution edit after a LIFECYCLE mutation advanced the version cannot overwrite the row", async () => {
  // The version is shared across every write path, so confirming an order invalidates an attribution
  // form rendered before it. The lifecycle move runs through the real repository function.
  const client = createStubClient({ persisted: orderRow({ status: "new", source: "facebook" }) });

  const confirmed = await updateOrderStatus(client, { orderId: ORDER_ID, to: "confirmed", now: V2 });
  assert.equal(confirmed.ok, true, "the lifecycle move itself must land");
  assert.equal(client.persisted()?.updated_at, V2, "and it advances the row version");

  const stale = await updateOrderAttribution(client, { orderId: ORDER_ID, expectedUpdatedAt: V1, source: "instagram", sourceRef: "POST-184", now: NOW });

  assert.equal(stale.ok, false);
  if (stale.ok) return;
  assert.equal(stale.reason, "conflict");
  assert.equal(client.persisted()?.source, "facebook", "the source was not overwritten");
  assert.equal(stale.currentOrder?.status, "confirmed", "and the caller sees the lifecycle move that won");
});

// --- source_ref is opaque ---------------------------------------------------------------------------

test("source_ref round-trips text-for-text, unparsed", async () => {
  // Every one of these would tempt a parser: a URL with query parameters, something that looks like
  // a UTM string, punctuation, surrounding whitespace, unicode. None of it is interpreted, and none
  // of it is tidied -- the app has no standing to decide which characters matter.
  const references = [
    "POST-184",
    "https://instagram.com/p/Cxyz123/?utm_source=ig&utm_campaign=bakesale",
    "  Tita Baby (referred by her sister)  ",
    "utm_source=facebook&utm_medium=cpc",
    "kapitbahay sa kanto — 09171234567",
    "{\"campaign\":\"launch\"}",
  ];

  for (const reference of references) {
    const client = createStubClient({ persisted: orderRow() });
    const result = await updateOrderAttribution(client, { orderId: ORDER_ID, expectedUpdatedAt: V1, source: "instagram", sourceRef: reference, now: NOW });

    assert.equal(result.ok, true);
    assert.equal(client.updates[0].payload.source_ref, reference, `${reference} must reach the database unchanged`);
    if (!result.ok) return;
    assert.equal(result.order.sourceRef, reference, `${reference} must read back unchanged`);
  }
});

test("a source_ref of a single space stays a single space", async () => {
  // The contract is strictly "" -> null. Whitespace is content: only the operator knows whether it
  // matters, and trimming would quietly edit their historical record.
  const client = createStubClient({ persisted: orderRow() });
  const result = await updateOrderAttribution(client, { orderId: ORDER_ID, expectedUpdatedAt: V1, source: "direct", sourceRef: " ", now: NOW });

  assert.equal(result.ok, true);
  assert.equal(client.updates[0].payload.source_ref, " ");
  if (!result.ok) return;
  assert.equal(result.order.sourceRef, " ");
});

test("an empty source_ref becomes null, and reads back as empty", async () => {
  // One representation of "nothing" in the column, matching buildOrderPayload. This is the only
  // transformation applied to the value at all.
  const client = createStubClient({ persisted: orderRow({ source_ref: "POST-184" }) });
  const result = await updateOrderAttribution(client, { orderId: ORDER_ID, expectedUpdatedAt: V1, source: "direct", sourceRef: "", now: NOW });

  assert.equal(result.ok, true);
  assert.equal(client.updates[0].payload.source_ref, null);
  if (!result.ok) return;
  assert.equal(result.order.sourceRef, "");
});

// --- Unknown values from the database ---------------------------------------------------------------

test("an unfamiliar source from the database degrades safely without crashing", () => {
  // Classification columns deliberately carry no CHECK constraint, so a future or hand-edited value
  // can appear. It must not throw, and it must NOT be silently reinterpreted as a real channel.
  const mapped = mapOrderRow(orderRow({ source: "future_channel" }) as unknown as OrderRow);

  assert.equal(mapped.source, "unknown");
  for (const channel of ORDER_SOURCES.filter((entry) => entry !== "unknown")) {
    assert.notEqual(mapped.source, channel, `an unrecognised value must never be read as ${channel}`);
  }
});

test("an unfamiliar raw source survives a fulfilment edit untouched", async () => {
  // The bounded behaviour the owner accepted is that only an EXPLICIT attribution save replaces a
  // raw unknown value. Editing the schedule must not launder it into "unknown" as a side effect.
  const client = createStubClient({ persisted: orderRow({ source: "future_channel" }) });

  const result = await updateOrderFulfillment(client, { orderId: ORDER_ID, expectedUpdatedAt: V1, fulfillmentMethod: "delivery", fulfillmentAt: NOW, fulfillmentAddress: "12 Mabini St", now: NOW });

  assert.equal(result.ok, true);
  assert.equal(Object.hasOwn(client.updates[0].payload, "source"), false, "a fulfilment edit has no source column to write");
  assert.equal(client.persisted()?.source, "future_channel", "the raw value is still in the database");
  // The UI still reads it safely as "unknown" -- degraded on read, not rewritten on disk.
  if (!result.ok) return;
  assert.equal(result.order.source, "unknown");
});

test("an unfamiliar raw source is counted, not dropped", () => {
  const orders = [order({ id: "a", source: "instagram" }), mapOrderRow(orderRow({ id: "b", source: "future_channel" }) as unknown as OrderRow)];
  const counts = getOrderCountsBySource(orders);

  assert.equal(counts.reduce((total, entry) => total + entry.count, 0), orders.length, "every order lands in exactly one bucket");
  assert.deepEqual(counts, [
    { source: "instagram", count: 1 },
    { source: "unknown", count: 1 },
  ]);
});

test("repeat is not a source", () => {
  // Repeat-buyer status is count(orders) per customer -- derived, never entered. Offering it as a
  // channel would create a second answer that can disagree with the data.
  assert.equal((ORDER_SOURCES as readonly string[]).includes("repeat"), false);
  assert.deepEqual([...ORDER_SOURCES], ["unknown", "facebook", "instagram", "tiktok", "messenger", "website", "referral", "direct"]);
});

// --- Per-source counts --------------------------------------------------------------------------------

test("per-source counts are correct", () => {
  const orders = [
    ...Array.from({ length: 4 }, (_, index) => order({ id: `ig-${index}`, source: "instagram" })),
    ...Array.from({ length: 2 }, (_, index) => order({ id: `fb-${index}`, source: "facebook" })),
    order({ id: "direct-0", source: "direct" }),
    ...Array.from({ length: 3 }, (_, index) => order({ id: `unknown-${index}`, source: "unknown" })),
  ];

  assert.deepEqual(getOrderCountsBySource(orders), [
    { source: "instagram", count: 4 },
    { source: "facebook", count: 2 },
    { source: "direct", count: 1 },
    // Last, because it is the absence of a channel rather than a channel -- but present, because
    // three orders whose origin was never recorded is a fact worth seeing.
    { source: "unknown", count: 3 },
  ]);
});

test("unknown is counted explicitly rather than dropped", () => {
  const counts = getOrderCountsBySource([order({ id: "a", source: "unknown" })]);
  assert.deepEqual(counts, [{ source: "unknown", count: 1 }]);
});

test("sources with no orders are omitted, and no orders means no counts", () => {
  assert.deepEqual(getOrderCountsBySource([]), []);
  assert.deepEqual(getOrderCountsBySource([order({ source: "tiktok" })]), [{ source: "tiktok", count: 1 }]);
});

test("per-source counts do not change when the fulfilment filter changes", () => {
  // The header line answers "where do our orders come from", which a fulfilment filter has no
  // bearing on. It is computed over all LOADED orders, so narrowing the list must not rewrite it.
  const orders = [
    order({ id: "a", source: "instagram", fulfillmentAt: "2026-08-10T02:00:00.000Z" }),
    order({ id: "b", source: "facebook", fulfillmentAt: null }),
    order({ id: "c", source: "unknown", fulfillmentAt: null }),
  ];
  const at = { nowMs: Date.parse(NOW), timeZone: "Asia/Manila" };

  const expected = getOrderCountsBySource(orders);
  assert.deepEqual(expected, [
    { source: "facebook", count: 1 },
    { source: "instagram", count: 1 },
    { source: "unknown", count: 1 },
  ]);

  // Every filter narrows the visible list to something different...
  const views = (["all", "today", "unscheduled"] as const).map((filter) => filterOrdersByFulfillment(orders, filter, at));
  assert.deepEqual(views.map((view) => view.length), [3, 1, 2]);

  // ...and the counts, being over all loaded orders, are unaffected by any of it.
  assert.deepEqual(getOrderCountsBySource(orders), expected);
});

// --- No coupling to Content -----------------------------------------------------------------------------

test("attribution introduces no link to Content, Creative or Opportunities", () => {
  // source_ref is an opaque historical reference, deliberately NOT a foreign key. The moment it
  // becomes a join, deleting a post starts rewriting order history.
  const sources = ["../src/lib/orders/attribution.ts", "../src/lib/orders-repository.ts", "../src/lib/orders/types.ts"].map((path) => readFileSync(new URL(path, import.meta.url), "utf8"));

  for (const code of sources) {
    for (const forbidden of ["content-drafts", "creative-jobs", "creative-packages", "opportunity-review", "opportunities"]) {
      assert.equal(code.includes(`from "./${forbidden}`), false, `Selling must not import ${forbidden}`);
      assert.equal(code.includes(`from "../${forbidden}`), false, `Selling must not import ${forbidden}`);
    }
  }

  const sql = readFileSync(new URL("../supabase-add-orders.sql", import.meta.url), "utf8");
  assert.equal(/source_ref[^,]*references/i.test(sql), false, "source_ref must not be a foreign key");
  assert.equal(/source_content_id/i.test(sql), false, "no Content -> Order relationship exists yet");
});
