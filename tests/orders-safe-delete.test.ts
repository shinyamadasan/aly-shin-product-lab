// Safe Delete Order, client side. The database (supabase/migrations/20260919120000_safe_delete_order.sql,
// exercised in tests/smoke/postgres/safe-delete-order.smoke.test.ts) is the authority; these tests
// pin what the browser side may and may not do: only OFFER the button for an apparently-safe order,
// send exactly the version the screen was rendered from, read the database's answer without deciding
// anything itself, and never delete a row from the client.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { appearsSafeToDelete, buildDeleteConfirmation } from "../src/lib/orders/delete-eligibility.ts";
import { safeDeleteOrder, type OrdersClient } from "../src/lib/orders-repository.ts";
import type { Order } from "../src/lib/orders/types.ts";

function order(overrides: Partial<Order> = {}): Order {
  return {
    id: "order-1",
    customerId: "cust-1",
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
    placedAt: "2026-08-09T06:00:00.000Z",
    completedAt: null,
    cancelledAt: null,
    cancelReason: "",
    createdAt: "2026-08-09T06:00:00.000Z",
    updatedAt: "2026-08-09T06:00:00.000Z",
    ...overrides,
  };
}

// --- When the button is offered ------------------------------------------------------------------

test("the button is offered only for a new, manual, unpaid order with no payment fields", () => {
  assert.equal(appearsSafeToDelete(order()), true);
});

test("the button is not offered for confirmed, ready, completed or cancelled orders", () => {
  for (const status of ["confirmed", "ready", "completed", "cancelled"] as const) {
    assert.equal(appearsSafeToDelete(order({ status })), false, status);
  }
});

test("the button is not offered for paid, refunded, or any order carrying a payment field", () => {
  assert.equal(appearsSafeToDelete(order({ paymentStatus: "paid", paymentMethod: "cash", paidAt: "2026-08-09T07:00:00.000Z", paidAmount: 100 })), false);
  assert.equal(appearsSafeToDelete(order({ paymentStatus: "refunded", paymentMethod: "cash", paidAt: "2026-08-09T07:00:00.000Z", paidAmount: 100, refundedAt: "2026-08-10T07:00:00.000Z" })), false);
  assert.equal(appearsSafeToDelete(order({ paymentMethod: "gcash" })), false);
  assert.equal(appearsSafeToDelete(order({ paidAt: "2026-08-09T07:00:00.000Z" })), false);
  assert.equal(appearsSafeToDelete(order({ paidAmount: 0 })), false);
});

test("the button is not offered for a website order", () => {
  assert.equal(appearsSafeToDelete(order({ entryMethod: "website" })), false);
});

test("the confirmation names the customer, says it cannot be undone, and points to Cancel", () => {
  const text = buildDeleteConfirmation("Nang Kim");
  assert.match(text, /Permanently delete this order for Nang Kim\?/);
  assert.match(text, /removes the order and its line items and cannot be undone/);
  assert.match(text, /Use Cancel instead if this was a real customer order/);
  assert.match(buildDeleteConfirmation(null), /Permanently delete this order\?/);
});

test("nothing in the delete UI claims the order was never paid", () => {
  const ui = [buildDeleteConfirmation("A"), readFileSync(new URL("../src/lib/orders/delete-eligibility.ts", import.meta.url), "utf8").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n")].join("\n");
  assert.equal(/never (been )?paid|was never paid/i.test(ui), false);
});

// --- Reading the database's answer ---------------------------------------------------------------

type RpcCall = { name: string; args: Record<string, unknown> };

function clientReturning(result: { data: unknown; error: { code?: string; message: string } | null }): { client: OrdersClient; calls: RpcCall[] } {
  const calls: RpcCall[] = [];
  const client = {
    rpc(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });
      return Promise.resolve(result);
    },
  } as unknown as OrdersClient;
  return { client, calls };
}

const INPUT = { orderId: "order-1", expectedUpdatedAt: "2026-08-09T06:00:00.123456+00:00", operationId: "op-1" };

test("a confirmed delete is ok, and the RPC gets exactly the loaded version and the operation id", async () => {
  const { client, calls } = clientReturning({ data: { deleted: true }, error: null });
  assert.deepEqual(await safeDeleteOrder(client, INPUT), { ok: true });
  assert.deepEqual(calls, [{ name: "safe_delete_order", args: { p_operation_id: "op-1", p_order_id: "order-1", p_expected_updated_at: "2026-08-09T06:00:00.123456+00:00" } }]);
});

test("a stale screen is reported as a conflict with the database's own message", async () => {
  const { client } = clientReturning({ data: null, error: { code: "40001", message: "This order changed since you opened it. Refresh and try again." } });
  const result = await safeDeleteOrder(client, INPUT);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "conflict");
    assert.match(result.message, /changed since you opened it/);
  }
});

test("an ineligible order surfaces the database's reason verbatim", async () => {
  for (const message of ["Only new orders can be permanently deleted. Cancel this order instead.", "This order has a payment on record. Cancel or refund it instead.", "This order already affected finished stock. Cancel it instead."]) {
    const { client } = clientReturning({ data: null, error: { code: "23514", message } });
    const result = await safeDeleteOrder(client, INPUT);
    assert.deepEqual(result, { ok: false, reason: "not-deletable", message });
  }
});

test("a missing order, a still-running operation, an unapplied function and an empty reply are each told apart", async () => {
  const notFound = await safeDeleteOrder(clientReturning({ data: null, error: { code: "22023", message: "Order not found" } }).client, INPUT);
  assert.equal(notFound.ok === false && notFound.reason, "not-found");

  const inFlight = await safeDeleteOrder(clientReturning({ data: null, error: { code: "55P03", message: "This operation is still being processed." } }).client, INPUT);
  assert.equal(inFlight.ok === false && inFlight.reason, "failed");
  assert.match(inFlight.ok === false ? inFlight.message : "", /still being processed/);

  const unapplied = await safeDeleteOrder(clientReturning({ data: null, error: { code: "PGRST202", message: "Could not find the function" } }).client, INPUT);
  assert.equal(unapplied.ok === false && unapplied.reason, "unavailable");

  // No error but no confirmation either: never treated as success.
  const empty = await safeDeleteOrder(clientReturning({ data: null, error: null }).client, INPUT);
  assert.equal(empty.ok, false);
  const notDeleted = await safeDeleteOrder(clientReturning({ data: { deleted: false }, error: null }).client, INPUT);
  assert.equal(notDeleted.ok, false);
});

test("a retry with the same operation id sends the same request", async () => {
  const { client, calls } = clientReturning({ data: { deleted: true }, error: null });
  await safeDeleteOrder(client, INPUT);
  await safeDeleteOrder(client, INPUT);
  assert.deepEqual(calls[0], calls[1]);
});

// --- Wiring: the client never deletes a row itself --------------------------------------------------

test("no client code deletes from orders or order_lines directly", () => {
  for (const file of ["../src/lib/orders-repository.ts", "../src/components/orders-page.tsx"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.equal(/\.delete\(\)/.test(source), false, `${file} must not issue a table delete`);
  }
});

test("the page deletes only through safeDeleteOrder, confirms first, and clears the selection only on success or a vanished order", () => {
  const source = readFileSync(new URL("../src/components/orders-page.tsx", import.meta.url), "utf8");

  assert.match(source, /safeDeleteOrder\(client, \{ orderId, expectedUpdatedAt, operationId: getDeleteOperationId\(orderId\) \}\)/);
  assert.match(source, /window\.confirm\(buildDeleteConfirmation\(customer\?\.name \?\? null\)\)/);
  // The version sent is the one the panel was loaded with.
  assert.match(source, /runDeleteOrder\(selectedOrder\.id, selectedOrder\.updatedAt\)/);
  // A refusal reloads and shows the reason; it does not hide the order.
  const handler = source.slice(source.indexOf("async function runDeleteOrder"), source.indexOf("const runOrderAction = useCallback"));
  assert.match(handler, /if \(result\.ok\) \{[\s\S]*setSelectedOrderId\(null\)/);
  assert.match(handler, /result\.reason === "not-found"/);
  assert.equal((handler.match(/setSelectedOrderId\(null\)/g) ?? []).length, 2);
  assert.match(handler, /reload\(\)/);
  assert.match(source, /Delete permanently/);
  // Cancel is still there, unchanged.
  assert.match(source, /Cancel order/);
});

// --- The migration itself is additive and never touches customers ----------------------------------

test("the migration is additive, grants only to authenticated, and never deletes a customer", () => {
  const sql = readFileSync(new URL("../supabase/migrations/20260919120000_safe_delete_order.sql", import.meta.url), "utf8")
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");

  assert.equal(/delete\s+from\s+public\.customers/i.test(sql), false);
  assert.equal(/alter\s+table/i.test(sql), false, "no existing table is altered");
  assert.equal(/grant\s+execute[^;]*to\s+(anon|public)/i.test(sql), false);
  assert.match(sql, /revoke all on function public\.safe_delete_order\(uuid, uuid, timestamptz\)\s+from public, anon, authenticated/);
  assert.match(sql, /for update/i);
  assert.match(sql, /claim_mutation\(p_operation_id, 'order_safe_delete'/);
});
