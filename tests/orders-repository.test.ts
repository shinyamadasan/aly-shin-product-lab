// Repository behaviour, against a hand-built stub client -- the convention this repo already uses
// instead of a mocking library.
//
// The load-bearing assertions here are about *call discipline*: exactly one save_order RPC per
// save, no direct order/order_lines write path at all, and every submitted line carrying the saved
// order's own id.

import test from "node:test";
import assert from "node:assert/strict";
import { createMutationGuard } from "../src/lib/mutation-guard.ts";
import { listCustomers, listOrderLines, listOrders, saveCustomer, saveOrder, type OrdersClient } from "../src/lib/orders-repository.ts";
import type { Customer, Order, OrderLine } from "../src/lib/orders/types.ts";

const NOW = "2026-08-09T06:00:00.000Z";

type StubOptions = {
  orderRows?: Record<string, unknown>[];
  lineRows?: Record<string, unknown>[];
  customerRows?: Record<string, unknown>[];
  error?: { code?: string; message: string };
  rpcError?: { code?: string; message: string };
};

type StubClient = OrdersClient & {
  rpcCalls: { name: string; args: unknown }[];
  upsertCalls: { table: string; row: Record<string, unknown> }[];
  tablesRead: string[];
};

function createStubClient(options: StubOptions = {}): StubClient {
  const rpcCalls: { name: string; args: unknown }[] = [];
  const upsertCalls: { table: string; row: Record<string, unknown> }[] = [];
  const tablesRead: string[] = [];

  function builder(rows: Record<string, unknown>[]) {
    const chain = {
      eq: () => chain,
      in: () => chain,
      order: () => chain,
      limit: () => chain,
      then: (resolve: (value: { data: unknown; error: unknown }) => unknown) => resolve(options.error ? { data: null, error: options.error } : { data: rows, error: null }),
    };
    return chain;
  }

  const client = {
    from(table: string) {
      tablesRead.push(table);
      const rows = table === "orders" ? options.orderRows ?? [] : table === "order_lines" ? options.lineRows ?? [] : options.customerRows ?? [];
      return {
        select: () => builder(rows),
        upsert: (row: Record<string, unknown>) => {
          upsertCalls.push({ table, row });
          return Promise.resolve(options.error ? { data: null, error: options.error } : { data: null, error: null });
        },
      };
    },
    rpc(name: string, args: unknown) {
      rpcCalls.push({ name, args });
      return Promise.resolve(options.rpcError ? { data: null, error: options.rpcError } : { data: null, error: null });
    },
    rpcCalls,
    upsertCalls,
    tablesRead,
  };

  return client as unknown as StubClient;
}

function order(overrides: Partial<Order> = {}): Order {
  return {
    id: "order-1",
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
    placedAt: NOW,
    completedAt: null,
    cancelledAt: null,
    cancelReason: "",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function line(overrides: Partial<OrderLine> = {}): OrderLine {
  return {
    id: "line-1",
    orderId: "order-1",
    productId: "brownies",
    sellingFormatId: "fmt-1",
    itemName: "Brownies — Box of 6",
    unitPrice: 480,
    piecesPerUnitSnapshot: 6,
    quantity: 2,
    sortOrder: 0,
    note: "",
    ...overrides,
  };
}

// --- Call discipline -----------------------------------------------------------------------------

test("saving an order issues exactly one save_order RPC call, not a sequence", () => {
  const client = createStubClient();

  return saveOrder(client, { order: order(), lines: [line(), line({ id: "line-2", sortOrder: 1 })], removedLineIds: [], now: NOW }).then((result) => {
    assert.equal(result.ok, true);
    assert.equal(client.rpcCalls.length, 1);
    assert.equal(client.rpcCalls[0].name, "save_order");
  });
});

test("saving an order performs no direct orders or order_lines write", () => {
  const client = createStubClient();

  return saveOrder(client, { order: order(), lines: [line()], removedLineIds: [], now: NOW }).then(() => {
    // The narrow client type does not even expose a write method on these two tables, so this is
    // belt and braces on top of a compile-time guarantee.
    assert.deepEqual(client.upsertCalls, []);
    assert.ok(!client.tablesRead.includes("orders"));
    assert.ok(!client.tablesRead.includes("order_lines"));
  });
});

test("every submitted line carries the saved order's own id", () => {
  const client = createStubClient();
  // A line whose orderId was never updated after the order id was minted.
  const staleLine = line({ id: "line-2", orderId: "some-older-draft-id" });

  return saveOrder(client, { order: order({ id: "order-1" }), lines: [line(), staleLine], removedLineIds: [], now: NOW }).then((result) => {
    // Rejected at the call site, where the message can name the offending item.
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.message, /belongs to a different order/i);
    assert.equal(client.rpcCalls.length, 0, "nothing may be sent when ownership fails");
  });
});

test("line order_id is rewritten from the order being saved, never trusted from the payload", () => {
  const client = createStubClient();

  return saveOrder(client, { order: order({ id: "order-1" }), lines: [line({ orderId: "order-1" })], removedLineIds: [], now: NOW }).then(() => {
    const args = client.rpcCalls[0].args as { p_lines: { order_id: string }[] };
    assert.equal(args.p_lines.length, 1);
    assert.equal(args.p_lines[0].order_id, "order-1");
  });
});

test("removed line ids are passed through as given, scoped by the caller to this order", () => {
  const client = createStubClient();

  return saveOrder(client, { order: order(), lines: [line()], removedLineIds: ["line-9"], now: NOW }).then(() => {
    const args = client.rpcCalls[0].args as { p_removed_line_ids: string[] };
    assert.deepEqual(args.p_removed_line_ids, ["line-9"]);
  });
});

test("the RPC payload carries the three line snapshots and a null pack size for a manual line", () => {
  const client = createStubClient();
  const manual = line({ id: "line-2", productId: "", sellingFormatId: "", piecesPerUnitSnapshot: null, itemName: "Delivery", unitPrice: 60, quantity: 1, sortOrder: 1 });

  return saveOrder(client, { order: order(), lines: [line(), manual], removedLineIds: [], now: NOW }).then(() => {
    const args = client.rpcCalls[0].args as { p_lines: Record<string, unknown>[] };

    assert.equal(args.p_lines[0].item_name, "Brownies — Box of 6");
    assert.equal(args.p_lines[0].unit_price, 480);
    assert.equal(args.p_lines[0].pieces_per_unit_snapshot, 6);

    assert.equal(args.p_lines[1].product_id, null);
    assert.equal(args.p_lines[1].selling_format_id, null);
    assert.equal(args.p_lines[1].pieces_per_unit_snapshot, null);
  });
});

test("the order payload writes updated_at and defaults source/entry_method correctly", () => {
  const client = createStubClient();

  return saveOrder(client, { order: order(), lines: [line()], removedLineIds: [], now: NOW }).then(() => {
    const args = client.rpcCalls[0].args as { p_order: Record<string, unknown> };
    assert.equal(args.p_order.updated_at, NOW);
    assert.equal(args.p_order.source, "unknown");
    assert.equal(args.p_order.entry_method, "manual");
    assert.equal(args.p_order.status, "new");
    assert.equal(args.p_order.payment_status, "unpaid");
    // S2 records no payment.
    assert.equal(args.p_order.paid_amount, null);
    assert.equal(args.p_order.paid_at, null);
  });
});

// --- Failure surfacing ---------------------------------------------------------------------------

test("an RPC failure surfaces cleanly as { ok: false, reason: 'failed' }", () => {
  const client = createStubClient({ rpcError: { code: "P0001", message: "Order line does not belong to the order being saved" } });

  return saveOrder(client, { order: order(), lines: [line()], removedLineIds: [], now: NOW }).then((result) => {
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, "failed");
    assert.match(result.message, /does not belong/i);
  });
});

test("a missing table degrades to reason 'missing-table' with a setup message", () => {
  for (const code of ["PGRST205", "42P01"]) {
    const client = createStubClient({ error: { code, message: "relation does not exist" } });

    void listOrders(client).then((result) => {
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.reason, "missing-table", `code ${code} should map to missing-table`);
      assert.match(result.message, /supabase-add-orders\.sql/i);
    });
  }
});

test("a generic read error is 'failed', not 'missing-table'", () => {
  const client = createStubClient({ error: { code: "08006", message: "connection failure" } });

  return listOrders(client).then((result) => {
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, "failed");
    assert.equal(result.message, "connection failure");
  });
});

test("a missing table on the RPC path also degrades rather than looking like a business failure", () => {
  const client = createStubClient({ rpcError: { code: "42P01", message: "relation \"orders\" does not exist" } });

  return saveOrder(client, { order: order(), lines: [line()], removedLineIds: [], now: NOW }).then((result) => {
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, "missing-table");
  });
});

// --- Reads ---------------------------------------------------------------------------------------

test("listOrders maps rows and preserves nulls", () => {
  const client = createStubClient({
    orderRows: [{ id: "order-1", customer_id: "customer-1", status: "new", payment_status: "unpaid", paid_amount: null, source: "instagram", entry_method: "manual" }],
  });

  return listOrders(client).then((result) => {
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.orders[0].paidAmount, null);
    assert.equal(result.orders[0].source, "instagram");
  });
});

test("listOrderLines groups by order id and short-circuits on an empty id list", () => {
  const client = createStubClient({
    lineRows: [
      { id: "l1", order_id: "order-1", item_name: "A", unit_price: 10, quantity: 1, pieces_per_unit_snapshot: 6 },
      { id: "l2", order_id: "order-1", item_name: "B", unit_price: 20, quantity: 2, pieces_per_unit_snapshot: null },
      { id: "l3", order_id: "order-2", item_name: "C", unit_price: 30, quantity: 1, pieces_per_unit_snapshot: 4 },
    ],
  });

  return listOrderLines(client, ["order-1", "order-2"]).then((result) => {
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.linesByOrderId.get("order-1")?.length, 2);
    assert.equal(result.linesByOrderId.get("order-2")?.length, 1);
    assert.equal(result.linesByOrderId.get("order-1")?.[1].piecesPerUnitSnapshot, null);

    const empty = createStubClient();
    return listOrderLines(empty, []).then((emptyResult) => {
      assert.equal(emptyResult.ok, true);
      // No round trip at all when there is nothing to fetch.
      assert.equal(empty.tablesRead.length, 0);
    });
  });
});

test("listCustomers maps rows", () => {
  const client = createStubClient({ customerRows: [{ id: "c1", name: "Maria Santos", phone: null }] });

  return listCustomers(client).then((result) => {
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.customers[0].name, "Maria Santos");
    assert.equal(result.customers[0].phone, "");
  });
});

test("saveCustomer upserts by id so a double-submit reconciles instead of duplicating", () => {
  const client = createStubClient();
  const customer: Customer = { id: "c1", name: "Maria Santos", phone: "", messagingHandle: "", email: "", notes: "", createdAt: NOW, updatedAt: NOW };

  return saveCustomer(client, customer, NOW).then((result) => {
    assert.equal(result.ok, true);
    assert.equal(client.upsertCalls.length, 1);
    assert.equal(client.upsertCalls[0].table, "customers");
    assert.equal(client.upsertCalls[0].row.id, "c1");
    assert.equal(client.upsertCalls[0].row.updated_at, NOW);
  });
});

// --- Round trip ----------------------------------------------------------------------------------

test("a multi-line order round trips with identical snapshots", async () => {
  // Save through the repository, then serve the captured payload back as read rows -- proving the
  // write and read shapes agree without needing a live database.
  const writeClient = createStubClient();
  const lines = [line({ id: "l1", quantity: 2, unitPrice: 480, piecesPerUnitSnapshot: 6 }), line({ id: "l2", productId: "", sellingFormatId: "", piecesPerUnitSnapshot: null, itemName: "Delivery", unitPrice: 60, quantity: 1, sortOrder: 1 })];

  await saveOrder(writeClient, { order: order(), lines, removedLineIds: [], now: NOW });
  const args = writeClient.rpcCalls[0].args as { p_order: Record<string, unknown>; p_lines: Record<string, unknown>[] };

  const readClient = createStubClient({ orderRows: [args.p_order], lineRows: args.p_lines });
  const orderResult = await listOrders(readClient);
  const lineResult = await listOrderLines(readClient, ["order-1"]);

  assert.equal(orderResult.ok && lineResult.ok, true);
  if (!orderResult.ok || !lineResult.ok) return;

  const reloaded = lineResult.linesByOrderId.get("order-1") ?? [];
  assert.equal(reloaded.length, 2);
  assert.equal(reloaded[0].unitPrice, 480);
  assert.equal(reloaded[0].piecesPerUnitSnapshot, 6);
  assert.equal(reloaded[0].quantity, 2);
  assert.equal(reloaded[1].itemName, "Delivery");
  // The manual line's null survives the round trip rather than becoming 0.
  assert.equal(reloaded[1].piecesPerUnitSnapshot, null);
  assert.equal(orderResult.orders[0].source, "unknown");
  assert.equal(orderResult.orders[0].entryMethod, "manual");
});

// --- Double-submit guard --------------------------------------------------------------------------

test("the mutation guard collapses a synchronous double-submit into one save", async () => {
  const client = createStubClient();
  const guard = createMutationGuard<string>();
  const orderId = "order-1";

  const save = () => {
    if (guard.isActive(orderId)) return Promise.resolve(undefined);
    return guard.run(orderId, () => saveOrder(client, { order: order(), lines: [line()], removedLineIds: [], now: NOW }));
  };

  // Both dispatched in the same tick, exactly as a real double-click arrives.
  await Promise.all([save(), save()]);

  assert.equal(client.rpcCalls.length, 1, "a double-submit must produce exactly one save_order call");
});

test("the guard releases after a failure so a retry is possible", async () => {
  const client = createStubClient({ rpcError: { message: "network blip" } });
  const guard = createMutationGuard<string>();

  await guard.run("order-1", () => saveOrder(client, { order: order(), lines: [line()], removedLineIds: [], now: NOW }));
  assert.equal(guard.isActive("order-1"), false);

  await guard.run("order-1", () => saveOrder(client, { order: order(), lines: [line()], removedLineIds: [], now: NOW }));
  assert.equal(client.rpcCalls.length, 2, "a retry after failure must be allowed");
});
