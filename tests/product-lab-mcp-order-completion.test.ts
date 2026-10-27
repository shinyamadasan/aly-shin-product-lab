import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import worker from "../workers/product-lab-mcp/index.ts";
import { orderCompletionApprovalCode } from "../scripts/product-lab/order-completion-service.ts";

// Order completion through the production remote transport (the Worker entry), authenticated as
// either owner. The fake Supabase models public.complete_order_with_fulfillment_checked's contract
// (supabase/migrations/20261027120000_order_fulfillment_expected_state_guard.sql over Wave 2): owner
// check, claim_mutation receipt keyed by operation id with md5(order_id) payload hash, confirmed/ready
// status gate, expected updated_at + payment columns (40001), lot balance (23514), fulfil exactly the active
// allocations, status-only order write, failed calls leave no receipt. The real SQL behavior,
// including concurrency, is covered by tests/smoke/postgres/selling-wave-2-order-reservation.

const WORKER_HOSTNAME = "alyandpon-product-lab-mcp.example.workers.dev";
const SHIN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ALYSSA_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const STAFF_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const TOKENS: Record<string, { id: string; email: string; role: string }> = {
  "shin-token": { id: SHIN_ID, email: "shin@example.test", role: "owner" },
  "alyssa-token": { id: ALYSSA_ID, email: "alyssa@example.test", role: "owner" },
  "staff-token": { id: STAFF_ID, email: "staff@example.test", role: "staff" },
};

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ORDER = {
  confirmedUnpaid: id(1),
  readyPaid: id(2),
  fresh: id(3),
  cancelled: id(4),
  completed: id(5),
  shortLot: id(6),
  mismatched: id(7),
  manualOnly: id(8),
};
const LOT = { a: id(101), b: id(102), c: id(103), d: id(104) };
const CUSTOMER = id(201);

type Row = Record<string, unknown>;

function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}

function seed() {
  const ts = "2026-10-20T08:00:00.000Z";
  const order = (orderId: string, status: string, extra: Row = {}): Row => ({
    id: orderId, customer_id: CUSTOMER, status, payment_status: "unpaid", payment_method: null, paid_at: null, paid_amount: null,
    refunded_at: null, fulfillment_method: "pickup", fulfillment_at: "2026-10-28T09:00:00.000Z", fulfillment_address: null,
    fulfillment_notes: null, source: "instagram", source_ref: null, entry_method: "manual", notes: null, placed_at: ts,
    completed_at: null, cancelled_at: null, cancel_reason: null, created_at: ts, updated_at: ts, ...extra,
  });
  const line = (n: number, orderId: string, quantity: number, pieces: number | null, productId: string | null = "cookie-box"): Row => ({
    id: id(300 + n), order_id: orderId, product_id: productId, selling_format_id: null, item_name: productId ? "Cookie box" : "Custom cake",
    unit_price: 225, pieces_per_unit_snapshot: pieces, quantity, sort_order: 0, note: null,
  });
  let m = 0;
  const movement = (lot: string | null, type: string, onHand: number, reserved: number, orderId: string | null = null, allocationId: string | null = null, op = id(900)): Row => ({
    id: id(500 + ++m), product_id: "cookie-box", production_execution_id: lot, movement_type: type, on_hand_delta: onHand,
    reserved_delta: reserved, operation_id: op, order_id: orderId, order_stock_allocation_id: allocationId,
  });
  const alloc = (n: number, orderId: string, lot: string, pieces: number, status = "active"): Row => ({
    id: id(400 + n), order_id: orderId, product_id: "cookie-box", production_execution_id: lot, operation_id: id(901), reserved_pieces: pieces, status,
  });

  return {
    customers: [{ id: CUSTOMER, name: "Maria Santos" }],
    orders: [
      order(ORDER.confirmedUnpaid, "confirmed"),
      order(ORDER.readyPaid, "ready", { payment_status: "paid", payment_method: "gcash", paid_at: ts, paid_amount: 225 }),
      order(ORDER.fresh, "new"),
      order(ORDER.cancelled, "cancelled", { cancelled_at: ts }),
      order(ORDER.completed, "completed", { completed_at: ts }),
      order(ORDER.shortLot, "confirmed"),
      order(ORDER.mismatched, "confirmed"),
      order(ORDER.manualOnly, "confirmed"),
    ],
    order_lines: [
      line(1, ORDER.confirmedUnpaid, 2, 3),
      line(2, ORDER.readyPaid, 1, 4),
      line(3, ORDER.fresh, 1, 3),
      line(4, ORDER.cancelled, 1, 3),
      line(5, ORDER.completed, 1, 2),
      line(6, ORDER.shortLot, 1, 5),
      line(7, ORDER.mismatched, 2, 3),
      line(8, ORDER.manualOnly, 1, null, null),
    ],
    order_stock_allocations: [
      alloc(1, ORDER.confirmedUnpaid, LOT.a, 6),
      alloc(2, ORDER.readyPaid, LOT.b, 4),
      alloc(4, ORDER.cancelled, LOT.a, 3, "released"),
      alloc(5, ORDER.completed, LOT.b, 2, "fulfilled"),
      alloc(6, ORDER.shortLot, LOT.c, 5),
      alloc(7, ORDER.mismatched, LOT.d, 4),
    ],
    finished_stock_movements: [
      movement(LOT.a, "production_receipt", 10, 0),
      movement(LOT.a, "reserve", 0, 6, ORDER.confirmedUnpaid, id(401)),
      movement(LOT.a, "reserve", 0, 3, ORDER.cancelled, id(404)),
      movement(LOT.a, "release", 0, -3, ORDER.cancelled, id(404)),
      movement(LOT.b, "production_receipt", 8, 0),
      movement(LOT.b, "reserve", 0, 4, ORDER.readyPaid, id(402)),
      movement(LOT.b, "reserve", 0, 2, ORDER.completed, id(405)),
      movement(LOT.b, "fulfill", -2, -2, ORDER.completed, id(405)),
      movement(LOT.c, "production_receipt", 5, 0),
      movement(LOT.c, "reserve", 0, 5, ORDER.shortLot, id(406)),
      // A later stock loss on lot C leaves fewer pieces on hand than order 6 has reserved.
      movement(LOT.c, "production_receipt", -3, 0),
      movement(LOT.d, "production_receipt", 10, 0),
      movement(LOT.d, "reserve", 0, 4, ORDER.mismatched, id(407)),
    ],
  };
}

function parseFilters(url: URL): Array<{ column: string; values: string[] }> {
  const filters: Array<{ column: string; values: string[] }> = [];
  for (const [column, raw] of url.searchParams) {
    if (["select", "order", "limit", "offset"].includes(column)) continue;
    if (raw.startsWith("eq.")) filters.push({ column, values: [raw.slice(3)] });
    else if (raw.startsWith("in.(")) filters.push({ column, values: raw.slice(4, -1).split(",").map((value) => value.replace(/^"|"$/g, "")) });
    else throw new Error(`unsupported filter ${column}=${raw}`);
  }
  return filters;
}

async function startFakeSupabase() {
  let state = seed();
  const receipts = new Map<string, { hash: string; result: Row | null }>();
  const log = {
    rpcCalls: 0,
    tableReads: 0,
    legacyRpcCalls: 0,
    directWrites: 0,
    nextRpcError: null as null | { status?: number; code: string; message: string },
    // Runs inside the RPC before its checks -- models a write that lands between Apply's re-read and
    // the database's order-row lock.
    beforeRpc: null as null | (() => void),
  };

  function authFor(req: IncomingMessage) {
    const token = req.headers.authorization?.replace(/^Bearer /, "") ?? "";
    return TOKENS[token] ?? null;
  }

  type Expected = { updated_at: string; payment_status: string; payment_method: unknown; paid_at: unknown; paid_amount: unknown; refunded_at: unknown };
  function completeOrder(user: { role: string }, operationId: string, orderId: string, expected: Expected | null = null): { status: number; body: unknown } {
    const fail = (code: string, message: string) => ({ status: 400, body: { code, message } });
    if (user.role !== "owner") return fail("42501", "Only the product lab owner may complete an order");
    const hash = `md5:${orderId}`;
    const prior = receipts.get(operationId);
    if (prior) {
      if (prior.hash !== hash) return fail("23514", "This operation id was already used for a different request.");
      if (prior.result === null) return fail("55P03", "This operation is still being processed.");
      return { status: 200, body: prior.result };
    }
    // uuid comparison is case-insensitive in Postgres; the fake mirrors that.
    const order = state.orders.find((row) => String(row.id) === orderId.toLowerCase());
    if (!order) return fail("22023", "Order not found");
    if (order.status !== "confirmed" && order.status !== "ready") {
      // The raise rolls back the claim: no receipt is left behind.
      return fail("23514", `This ${order.status} order has no active reservation to fulfill.`);
    }
    if (expected !== null && (
      order.updated_at !== expected.updated_at
      || order.payment_status !== expected.payment_status
      || (order.payment_method ?? null) !== (expected.payment_method ?? null)
      || (order.paid_at ?? null) !== (expected.paid_at ?? null)
      || (order.paid_amount === null || order.paid_amount === undefined ? null : Number(order.paid_amount)) !== (expected.paid_amount === null || expected.paid_amount === undefined ? null : Number(expected.paid_amount))
      || (order.refunded_at ?? null) !== (expected.refunded_at ?? null)
    )) {
      return fail("40001", "This order changed since it was reviewed.");
    }
    orderId = String(order.id);
    const active = state.order_stock_allocations.filter((row) => row.order_id === orderId && row.status === "active");
    for (const lot of new Set(active.map((row) => row.production_execution_id))) {
      const need = active.filter((row) => row.production_execution_id === lot).reduce((sum, row) => sum + Number(row.reserved_pieces), 0);
      const moves = state.finished_stock_movements.filter((row) => row.production_execution_id === lot);
      const onHand = moves.reduce((sum, row) => sum + Number(row.on_hand_delta), 0);
      const reserved = moves.reduce((sum, row) => sum + Number(row.reserved_delta), 0);
      if (onHand < need || reserved < need) return fail("23514", "Cannot complete this order without making finished stock negative.");
    }
    const now = new Date(Date.parse(String(order.updated_at)) + 60_000).toISOString();
    for (const allocation of state.order_stock_allocations.filter((row) => row.order_id === orderId && row.status === "active")) {
      const pieces = Number(allocation.reserved_pieces);
      state.finished_stock_movements.push({
        id: `fulfill-${operationId}-${allocation.id}`, product_id: allocation.product_id, production_execution_id: allocation.production_execution_id,
        movement_type: "fulfill", on_hand_delta: -pieces, reserved_delta: -pieces, operation_id: operationId, order_id: orderId,
        order_stock_allocation_id: allocation.id,
      });
      allocation.status = "fulfilled";
    }
    Object.assign(order, { status: "completed", completed_at: now, updated_at: now });
    const result = { ...order };
    receipts.set(operationId, { hash, result });
    return { status: 200, body: result };
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/auth/v1/user") {
      const user = authFor(req);
      if (!user) return json(res, 401, { message: "invalid token" });
      return json(res, 200, { id: user.id, aud: "authenticated", role: "authenticated", email: user.email, app_metadata: { app_role: user.role }, user_metadata: {} });
    }
    const user = authFor(req);
    if (!user) return json(res, 401, { message: "JWT invalid" });
    if (url.pathname === "/rest/v1/rpc/complete_order_with_fulfillment") {
      log.legacyRpcCalls += 1;
      return json(res, 400, { code: "XX000", message: "MCP must never call the unchecked function" });
    }
    if (url.pathname === "/rest/v1/rpc/complete_order_with_fulfillment_checked") {
      log.rpcCalls += 1;
      let body = "";
      for await (const chunk of req) body += chunk;
      const args = JSON.parse(body) as {
        p_operation_id: string; p_order_id: string; p_expected_updated_at: string | null; p_expected_payment_status: string | null;
        p_expected_payment_method: unknown; p_expected_paid_at: unknown; p_expected_paid_amount: unknown; p_expected_refunded_at: unknown;
      };
      if (log.nextRpcError) {
        const error = log.nextRpcError;
        log.nextRpcError = null;
        return json(res, error.status ?? 400, { code: error.code, message: error.message });
      }
      if (args.p_expected_updated_at === null || args.p_expected_payment_status === null) return json(res, 400, { code: "22023", message: "The reviewed order version and payment state are required" });
      const hook = log.beforeRpc;
      log.beforeRpc = null;
      hook?.();
      const result = completeOrder(user, args.p_operation_id, args.p_order_id, {
        updated_at: args.p_expected_updated_at, payment_status: args.p_expected_payment_status, payment_method: args.p_expected_payment_method,
        paid_at: args.p_expected_paid_at, paid_amount: args.p_expected_paid_amount, refunded_at: args.p_expected_refunded_at,
      });
      return json(res, result.status, result.body);
    }
    const table = url.pathname.replace(/^\/rest\/v1\//, "") as keyof ReturnType<typeof seed>;
    if (!(table in state)) return json(res, 404, { message: `unexpected path ${url.pathname}` });
    if (req.method === "GET") log.tableReads += 1;
    if (req.method !== "GET") {
      log.directWrites += 1;
      return json(res, 405, { message: "direct table writes are not part of this contract" });
    }
    let rows = (state[table] as Row[]).filter((row) => parseFilters(url).every((filter) => filter.values.includes(String(row[filter.column]))));
    const limit = url.searchParams.get("limit");
    if (limit) rows = rows.slice(Number(url.searchParams.get("offset") ?? 0), Number(url.searchParams.get("offset") ?? 0) + Number(limit));
    return json(res, 200, rows.map((row) => ({ ...row })));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    url: `http://127.0.0.1:${address.port}`,
    log,
    receipts,
    get state() { return state; },
    reset() { state = seed(); receipts.clear(); log.rpcCalls = 0; log.tableReads = 0; log.directWrites = 0; log.nextRpcError = null; log.beforeRpc = null; },
    // Simulates the other owner completing the order from the web app with its own operation id.
    completeElsewhere(orderId: string) { return completeOrder({ role: "owner" }, "11111111-2222-4333-8444-555555555555", orderId); },
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

function requestFor(input: string | URL, init?: RequestInit): Request {
  const url = new URL(input);
  const headers = new Headers(init?.headers);
  if (!headers.has("host")) headers.set("host", url.host);
  return new Request(url, { ...init, headers });
}

type ToolResult = { isError?: boolean; structuredContent?: Record<string, unknown>; content: Array<{ type: string; text?: string }> };

test("Product Lab MCP order completion (inspect -> preview -> approve -> apply -> verify)", async (t) => {
  const supabase = await startFakeSupabase();
  t.after(() => supabase.close());
  const bindings = {
    PRODUCT_LAB_SUPABASE_URL: supabase.url,
    PRODUCT_LAB_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_order_test",
    PRODUCT_LAB_MCP_PUBLIC_HOSTNAME: WORKER_HOSTNAME,
  };
  const mcpUrl = `https://${WORKER_HOSTNAME}/api/mcp`;
  const call = (request: Request) => worker.fetch(request, bindings);
  const clients: Client[] = [];
  t.after(() => Promise.all(clients.map((client) => client.close())));

  async function connect(token: string) {
    const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
      authProvider: { token: async () => token },
      fetch: (input, init) => call(requestFor(input as string | URL, init)),
    });
    const client = new Client({ name: "order-test", version: "1.0.0" });
    await client.connect(transport);
    clients.push(client);
    return client;
  }
  const shin = await connect("shin-token");
  const alyssa = await connect("alyssa-token");

  const tool = async (client: Client, name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as ToolResult;
  const ok = async (client: Client, name: string, args: Record<string, unknown>) => {
    const result = await tool(client, name, args);
    assert.equal(result.isError, undefined, `${name} failed: ${result.content[0]?.text}`);
    return result.structuredContent!;
  };
  const errorCode = async (client: Client, name: string, args: Record<string, unknown>) => {
    const result = await tool(client, name, args);
    assert.equal(result.isError, true, `${name} unexpectedly succeeded`);
    return (JSON.parse(result.content[0].text!) as { error: { code: string; message: string } }).error;
  };
  const fulfills = (orderId: string) => supabase.state.finished_stock_movements.filter((row) => row.order_id === orderId && row.movement_type === "fulfill");

  await t.test("tool surface: read tools are read-only, apply takes only order/preview/code", async () => {
    const tools = (await shin.listTools()).tools;
    for (const name of ["order_inspect", "order_complete_preview", "order_complete_verify"]) {
      const item = tools.find((entry) => entry.name === name);
      assert.equal(item?.annotations?.readOnlyHint, true, name);
      assert.equal(item?.annotations?.destructiveHint, false, name);
    }
    const apply = tools.find((entry) => entry.name === "order_complete_apply");
    assert.equal(apply?.annotations?.destructiveHint, true);
    assert.equal(apply?.annotations?.idempotentHint, true);
    // Claude Code: prompt on every call in every mode; allow rules cannot skip it.
    assert.deepEqual(apply?._meta, { "anthropic/requiresUserInteraction": true });
    for (const name of ["order_inspect", "order_complete_preview", "order_complete_verify"]) {
      assert.equal(tools.find((entry) => entry.name === name)?._meta?.["anthropic/requiresUserInteraction"], undefined, name);
    }
    const properties = (apply?.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    assert.deepEqual(Object.keys(properties).sort(), ["approval_code", "order_id", "preview_id"]);
    for (const forbidden of ["status", "payment_status", "paid_amount", "operation_id", "sql", "rpc"]) {
      assert.equal(forbidden in properties, false, forbidden);
    }
  });

  await t.test("unauthenticated, invalid, expired and non-owner callers never reach a tool", async () => {
    supabase.reset();
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    const noToken = await call(requestFor(mcpUrl, { method: "POST", headers, body }));
    assert.equal(noToken.status, 401);
    assert.match(noToken.headers.get("www-authenticate") ?? "", /resource_metadata=/);
    for (const token of ["invalid-token", "expired-token", "staff-token"]) {
      const response = await call(requestFor(mcpUrl, { method: "POST", headers: { ...headers, authorization: `Bearer ${token}` }, body }));
      assert.equal(response.status, 401, token);
      await response.body?.cancel();
    }
    await assert.rejects(() => connect("staff-token"));
    assert.equal(supabase.log.rpcCalls, 0);
  });

  await t.test("order_inspect lists open orders and reports one order's lines, payment and reservation", async () => {
    supabase.reset();
    const list = await ok(shin, "order_inspect", {});
    assert.equal(list.kind, "open_orders");
    const listed = (list.orders as Array<{ order_id: string; customer_name: string; total: number }>);
    assert.deepEqual(listed.map((row) => row.order_id).sort(), [ORDER.confirmedUnpaid, ORDER.readyPaid, ORDER.fresh, ORDER.shortLot, ORDER.mismatched, ORDER.manualOnly].sort());
    assert.equal(listed.find((row) => row.order_id === ORDER.confirmedUnpaid)?.customer_name, "Maria Santos");
    assert.equal(listed.find((row) => row.order_id === ORDER.confirmedUnpaid)?.total, 450);

    const detail = await ok(alyssa, "order_inspect", { order_id: ORDER.readyPaid });
    assert.equal(detail.kind, "order");
    assert.equal(detail.reservation_status, "reserved");
    assert.deepEqual((detail.order as { payment: unknown }).payment, { payment_status: "paid", payment_method: "gcash", paid_at: "2026-10-20T08:00:00.000Z", paid_amount: 225, refunded_at: null });
    assert.equal((await ok(shin, "order_inspect", { order_id: ORDER.completed })).reservation_status, "fulfilled");
    assert.equal((await ok(shin, "order_inspect", { order_id: ORDER.manualOnly })).reservation_status, "none_required");
    assert.equal((await errorCode(shin, "order_inspect", { order_id: id(999) })).code, "order_not_found");
    assert.equal(supabase.log.rpcCalls, 0);
    assert.equal(supabase.log.directWrites, 0);
  });

  await t.test("Shin: preview never writes; a wrong code is refused; approval completes; verify confirms; payment untouched", async () => {
    supabase.reset();
    const preview = await ok(shin, "order_complete_preview", { order_id: ORDER.confirmedUnpaid });
    assert.equal(preview.can_apply, true);
    assert.deepEqual(preview.blockers, []);
    assert.match((preview.warnings as string[]).join(" "), /does not record a payment/);
    assert.deepEqual(preview.effects, { status_from: "confirmed", status_to: "completed", finished_pieces_fulfilled: 6, payment_change: "none" });
    assert.deepEqual((preview.stock as Row[])[0], {
      allocation_id: id(401), product_id: "cookie-box", production_execution_id: LOT.a, pieces_to_fulfill: 6,
      lot_on_hand_before: 10, lot_on_hand_after: 4, lot_reserved_before: 6, lot_reserved_after: 0,
    });
    assert.match(String(preview.preview_id), /^oc_[a-f0-9]{20}$/);
    assert.equal(preview.approval_code, orderCompletionApprovalCode(String(preview.preview_id)));
    assert.equal(supabase.log.rpcCalls, 0, "preview must not call the mutation RPC");
    assert.equal(supabase.state.orders.find((row) => row.id === ORDER.confirmedUnpaid)?.status, "confirmed");

    const args = { order_id: ORDER.confirmedUnpaid, preview_id: preview.preview_id };
    assert.equal((await errorCode(shin, "order_complete_apply", { ...args, approval_code: "0000-0000" })).code, "order_preview_stale_or_invalid");
    assert.equal(supabase.log.rpcCalls, 0, "a wrong approval code never reaches the RPC");

    const applied = await ok(shin, "order_complete_apply", { ...args, approval_code: String(preview.approval_code).toLowerCase() });
    assert.equal(applied.status, "applied_unverified");
    assert.equal(applied.order_status, "completed");
    assert.equal(applied.operation_id, preview.operation_id);
    assert.deepEqual(applied.payment, { payment_status: "unpaid", payment_method: null, paid_at: null, paid_amount: null, refunded_at: null });
    assert.equal(fulfills(ORDER.confirmedUnpaid).length, 1);
    assert.equal(supabase.log.directWrites, 0, "no direct table write, only the RPC");

    const verified = await ok(shin, "order_complete_verify", args);
    assert.equal(verified.status, "verified");
    assert.deepEqual(verified.failures, []);
    assert.equal(verified.mutation_receipt, "matched");
    assert.equal(verified.finished_pieces_fulfilled, 6);
    assert.equal(verified.allocations_fulfilled, 1);
    assert.deepEqual(verified.payment_now, applied.payment);
    assert.equal(fulfills(ORDER.confirmedUnpaid).length, 1, "verify never writes");
  });

  await t.test("a lost Apply response is retried with the same preview and replays without a second deduction", async () => {
    supabase.reset();
    const preview = await ok(shin, "order_complete_preview", { order_id: ORDER.confirmedUnpaid });
    const args = { order_id: ORDER.confirmedUnpaid, preview_id: preview.preview_id, approval_code: preview.approval_code };
    await ok(shin, "order_complete_apply", args);
    const retry = await ok(shin, "order_complete_apply", args);
    assert.equal(retry.order_status, "completed");
    assert.equal(fulfills(ORDER.confirmedUnpaid).length, 1);
    assert.equal((await ok(shin, "order_complete_verify", { order_id: ORDER.confirmedUnpaid, preview_id: preview.preview_id })).status, "verified");
  });

  await t.test("both owners preview the same order: one operation id, one fulfilment, both see the verified result", async () => {
    supabase.reset();
    const shinPreview = await ok(shin, "order_complete_preview", { order_id: ORDER.readyPaid });
    const alyssaPreview = await ok(alyssa, "order_complete_preview", { order_id: ORDER.readyPaid });
    assert.equal(shinPreview.preview_id, alyssaPreview.preview_id);
    assert.equal(shinPreview.operation_id, alyssaPreview.operation_id);
    const args = { order_id: ORDER.readyPaid, preview_id: shinPreview.preview_id, approval_code: shinPreview.approval_code };
    const [first, second] = await Promise.all([
      ok(shin, "order_complete_apply", args),
      ok(alyssa, "order_complete_apply", args),
    ]);
    assert.equal(first.operation_id, second.operation_id);
    assert.equal(second.order_status, "completed");
    assert.equal(fulfills(ORDER.readyPaid).length, 1, "concurrent duplicate approval fulfils once");
    for (const result of [first, second]) {
      assert.deepEqual(result.payment, { payment_status: "paid", payment_method: "gcash", paid_at: "2026-10-20T08:00:00.000Z", paid_amount: 225, refunded_at: null });
    }
    const verified = await ok(alyssa, "order_complete_verify", { order_id: ORDER.readyPaid, preview_id: alyssaPreview.preview_id });
    assert.equal(verified.status, "verified");
    assert.deepEqual(verified.payment_at_completion, verified.payment_now);
  });

  await t.test("an operation still in flight is reported as retryable, not as success", async () => {
    supabase.reset();
    const preview = await ok(shin, "order_complete_preview", { order_id: ORDER.confirmedUnpaid });
    supabase.log.nextRpcError = { code: "55P03", message: "This operation is still being processed." };
    const args = { order_id: ORDER.confirmedUnpaid, preview_id: preview.preview_id, approval_code: preview.approval_code };
    assert.equal((await errorCode(shin, "order_complete_apply", args)).code, "order_apply_in_progress");
    assert.equal(fulfills(ORDER.confirmedUnpaid).length, 0);
    assert.equal((await ok(shin, "order_complete_apply", args)).order_status, "completed");
    assert.equal(fulfills(ORDER.confirmedUnpaid).length, 1);
  });

  await t.test("a preview is refused once the order changes, including a payment recorded meanwhile", async () => {
    supabase.reset();
    const preview = await ok(shin, "order_complete_preview", { order_id: ORDER.confirmedUnpaid });
    Object.assign(supabase.state.orders.find((row) => row.id === ORDER.confirmedUnpaid)!, {
      payment_status: "paid", payment_method: "cash", paid_at: "2026-10-21T08:00:00.000Z", paid_amount: 450, updated_at: "2026-10-21T08:00:00.000Z",
    });
    const args = { order_id: ORDER.confirmedUnpaid, preview_id: preview.preview_id, approval_code: preview.approval_code };
    assert.equal((await errorCode(shin, "order_complete_apply", args)).code, "order_preview_stale_or_invalid");
    assert.equal(supabase.log.rpcCalls, 0, "a stale preview on an open order never reaches the RPC");
    // Re-previewing shows the paid state and can then be approved.
    const fresh = await ok(shin, "order_complete_preview", { order_id: ORDER.confirmedUnpaid });
    assert.notEqual(fresh.preview_id, preview.preview_id);
    const applied = await ok(shin, "order_complete_apply", { order_id: ORDER.confirmedUnpaid, preview_id: fresh.preview_id, approval_code: fresh.approval_code });
    assert.equal((applied.payment as { paid_amount: number }).paid_amount, 450, "completion keeps the recorded payment as is");
  });

  await t.test("an order completed by the other owner elsewhere is not completed again and does not verify for this preview", async () => {
    supabase.reset();
    const preview = await ok(shin, "order_complete_preview", { order_id: ORDER.confirmedUnpaid });
    supabase.completeElsewhere(ORDER.confirmedUnpaid);
    const receiptsBefore = supabase.receipts.size;
    const args = { order_id: ORDER.confirmedUnpaid, preview_id: preview.preview_id, approval_code: preview.approval_code };
    assert.equal((await errorCode(shin, "order_complete_apply", args)).code, "order_preview_stale_or_invalid");
    assert.equal(fulfills(ORDER.confirmedUnpaid).length, 1, "no second deduction");
    const verified = await ok(shin, "order_complete_verify", { order_id: ORDER.confirmedUnpaid, preview_id: preview.preview_id });
    assert.equal(verified.status, "not_verified");
    assert.equal(verified.mutation_receipt, "missing");
    assert.match((verified.failures as string[]).join(" "), /different operation/);
    assert.equal(supabase.receipts.size, receiptsBefore, "the refused replay left no receipt");
  });

  await t.test("completed, cancelled and unconfirmed orders cannot be completed", async () => {
    supabase.reset();
    for (const [orderId, pattern] of [
      [ORDER.completed, /already completed/],
      [ORDER.cancelled, /cancelled/],
      [ORDER.fresh, /not confirmed/],
    ] as const) {
      const preview = await ok(shin, "order_complete_preview", { order_id: orderId });
      assert.equal(preview.can_apply, false);
      assert.match((preview.blockers as string[]).join(" "), pattern);
      const code = (await errorCode(shin, "order_complete_apply", { order_id: orderId, preview_id: preview.preview_id, approval_code: preview.approval_code })).code;
      assert.ok(["order_not_completable", "order_preview_stale_or_invalid"].includes(code), code);
    }
    assert.equal(supabase.state.finished_stock_movements.filter((row) => row.movement_type === "fulfill").length, 1, "only the seeded fulfilment exists");
    assert.equal(supabase.state.orders.find((row) => row.id === ORDER.cancelled)?.status, "cancelled");
    assert.equal(supabase.state.orders.find((row) => row.id === ORDER.fresh)?.status, "new");
  });

  await t.test("insufficient lot stock and a reservation that does not match the order block completion", async () => {
    supabase.reset();
    const short = await ok(shin, "order_complete_preview", { order_id: ORDER.shortLot });
    assert.equal(short.can_apply, false);
    assert.match((short.blockers as string[]).join(" "), /holds 2 pieces on hand but this order would fulfil 5/);
    assert.equal((await errorCode(shin, "order_complete_apply", { order_id: ORDER.shortLot, preview_id: short.preview_id, approval_code: short.approval_code })).code, "order_not_completable");

    const mismatched = await ok(shin, "order_complete_preview", { order_id: ORDER.mismatched });
    assert.equal(mismatched.can_apply, false);
    assert.match((mismatched.blockers as string[]).join(" "), /needs 6 pieces but 4 are reserved/);
    assert.equal(supabase.log.rpcCalls, 0);
    assert.equal(supabase.state.orders.find((row) => row.id === ORDER.shortLot)?.status, "confirmed");
  });

  await t.test("an order with no stock-tracked lines completes with no stock movement and verifies by receipt", async () => {
    supabase.reset();
    const preview = await ok(shin, "order_complete_preview", { order_id: ORDER.manualOnly });
    assert.equal(preview.can_apply, true);
    assert.equal((preview.effects as { finished_pieces_fulfilled: number }).finished_pieces_fulfilled, 0);
    await ok(shin, "order_complete_apply", { order_id: ORDER.manualOnly, preview_id: preview.preview_id, approval_code: preview.approval_code });
    const verified = await ok(shin, "order_complete_verify", { order_id: ORDER.manualOnly, preview_id: preview.preview_id });
    assert.equal(verified.status, "verified");
    assert.equal(verified.mutation_receipt, "matched");
    assert.equal(fulfills(ORDER.manualOnly).length, 0);
  });

  await t.test("verify before apply does not complete the order", async () => {
    supabase.reset();
    const preview = await ok(shin, "order_complete_preview", { order_id: ORDER.confirmedUnpaid });
    const verified = await ok(shin, "order_complete_verify", { order_id: ORDER.confirmedUnpaid, preview_id: preview.preview_id });
    assert.equal(verified.status, "not_verified");
    assert.equal(verified.mutation_receipt, "not_checked");
    assert.equal(supabase.log.rpcCalls, 0);
    assert.equal(supabase.state.orders.find((row) => row.id === ORDER.confirmedUnpaid)?.status, "confirmed");
  });

  await t.test("a database owner refusal surfaces as an authentication error without backend detail", async () => {
    supabase.reset();
    const preview = await ok(shin, "order_complete_preview", { order_id: ORDER.confirmedUnpaid });
    supabase.log.nextRpcError = { code: "42501", message: "Only the product lab owner may complete an order" };
    const error = await errorCode(shin, "order_complete_apply", { order_id: ORDER.confirmedUnpaid, preview_id: preview.preview_id, approval_code: preview.approval_code });
    assert.equal(error.code, "authentication_error");
    assert.doesNotMatch(error.message, /product lab owner may/);
  });

  await t.test("a payment recorded between Apply's re-read and the database lock is refused by the database, with no fulfilment", async () => {
    supabase.reset();
    const preview = await ok(shin, "order_complete_preview", { order_id: ORDER.confirmedUnpaid });
    supabase.log.beforeRpc = () => Object.assign(supabase.state.orders.find((row) => row.id === ORDER.confirmedUnpaid)!, {
      payment_status: "paid", paid_amount: 450, paid_at: "2026-10-21T08:00:00.000Z", updated_at: "2026-10-21T08:00:00.000Z",
    });
    const error = await errorCode(shin, "order_complete_apply", { order_id: ORDER.confirmedUnpaid, preview_id: preview.preview_id, approval_code: preview.approval_code });
    assert.equal(error.code, "order_preview_stale_or_invalid");
    assert.equal(supabase.log.rpcCalls, 1, "the database, not the screen, refused it");
    assert.equal(fulfills(ORDER.confirmedUnpaid).length, 0);
    assert.equal(supabase.state.orders.find((row) => row.id === ORDER.confirmedUnpaid)?.status, "confirmed");
  });

  await t.test("a payment written WITHOUT bumping updated_at between the re-read and the lock is still refused by the database", async () => {
    supabase.reset();
    const preview = await ok(shin, "order_complete_preview", { order_id: ORDER.confirmedUnpaid });
    supabase.log.beforeRpc = () => Object.assign(supabase.state.orders.find((row) => row.id === ORDER.confirmedUnpaid)!, {
      payment_status: "paid", paid_amount: 450, paid_at: "2026-10-21T08:00:00.000Z",
    });
    const error = await errorCode(shin, "order_complete_apply", { order_id: ORDER.confirmedUnpaid, preview_id: preview.preview_id, approval_code: preview.approval_code });
    assert.equal(error.code, "order_preview_stale_or_invalid");
    assert.equal(fulfills(ORDER.confirmedUnpaid).length, 0);
  });

  await t.test("an upper-case order id completes, reports success and verifies", async () => {
    supabase.reset();
    const upper = ORDER.confirmedUnpaid.toUpperCase();
    const preview = await ok(shin, "order_complete_preview", { order_id: upper });
    assert.equal(preview.order_id, ORDER.confirmedUnpaid);
    const applied = await ok(shin, "order_complete_apply", { order_id: upper, preview_id: preview.preview_id, approval_code: preview.approval_code });
    assert.equal(applied.order_id, ORDER.confirmedUnpaid);
    const verified = await ok(shin, "order_complete_verify", { order_id: upper, preview_id: preview.preview_id });
    assert.equal(verified.status, "verified", JSON.stringify(verified.failures));
    assert.equal(fulfills(ORDER.confirmedUnpaid).length, 1);
  });

  await t.test("a lot that loses stock between Apply's re-read and the database lock is refused by the database", async () => {
    supabase.reset();
    const preview = await ok(shin, "order_complete_preview", { order_id: ORDER.confirmedUnpaid });
    supabase.log.beforeRpc = () => supabase.state.finished_stock_movements.push({
      id: "late-loss", product_id: "cookie-box", production_execution_id: LOT.a, movement_type: "fulfill", on_hand_delta: -5, reserved_delta: -5,
      operation_id: id(902), order_id: ORDER.confirmedUnpaid, order_stock_allocation_id: id(401),
    });
    const error = await errorCode(shin, "order_complete_apply", { order_id: ORDER.confirmedUnpaid, preview_id: preview.preview_id, approval_code: preview.approval_code });
    assert.equal(error.code, "order_not_completable");
    assert.equal(fulfills(ORDER.confirmedUnpaid).length, 1, "only the injected movement; no fulfilment by this operation");
  });

  await t.test("without the guard migration, Apply fails closed and never falls back to the unchecked function", async () => {
    supabase.reset();
    const preview = await ok(shin, "order_complete_preview", { order_id: ORDER.confirmedUnpaid });
    supabase.log.nextRpcError = { status: 404, code: "PGRST202", message: "Could not find the function" };
    const error = await errorCode(shin, "order_complete_apply", { order_id: ORDER.confirmedUnpaid, preview_id: preview.preview_id, approval_code: preview.approval_code });
    assert.equal(error.code, "order_apply_unavailable");
    assert.equal(supabase.log.legacyRpcCalls, 0);
    assert.equal(fulfills(ORDER.confirmedUnpaid).length, 0);
  });

  await t.test("malformed ids are rejected by the input schema before any read", async () => {
    supabase.reset();
    for (const args of [{ order_id: "1; drop table orders" }, { order_id: ORDER.confirmedUnpaid, extra: true }]) {
      const result = await tool(shin, "order_complete_preview", args);
      assert.equal(result.isError, true);
    }
    const bad = await tool(shin, "order_complete_apply", { order_id: ORDER.confirmedUnpaid, preview_id: "pc_0123456789abcdef0123", approval_code: "X" });
    assert.equal(bad.isError, true);
    assert.equal(supabase.log.tableReads, 0, "rejected before any Supabase read");
    assert.equal(supabase.log.rpcCalls, 0);
    assert.equal(supabase.log.legacyRpcCalls, 0, "MCP never called the unchecked function in this suite");
  });
});
