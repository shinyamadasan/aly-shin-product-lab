import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import worker from "../../../workers/product-lab-mcp/index.ts";

// End-to-end: MCP client -> Worker entry -> supabase-js -> real PostgREST -> real PostgreSQL with
// Selling Wave 0A/0B/1/2 and the order fulfillment guard migration applied. The only fake is the
// Supabase Auth /auth/v1/user endpoint, which verifies the same HS256 JWT PostgREST verifies. This is
// what proves the reviewed orders.updated_at survives the PostgREST JSON round trip back into the
// guard's timestamptz parameter, and that two owners' concurrent approvals fulfil once.

const root = path.resolve(import.meta.dirname, "../../..");
const sql = (file: string) => readFileSync(path.join(root, file), "utf8");
const JWT_SECRET = "product-lab-order-smoke-secret-0123456789abcdef";
const WORKER_HOSTNAME = "alyandpon-product-lab-mcp.example.workers.dev";
const SHIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ALYSSA = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const STAFF = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function jwt(sub: string, appRole: string): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const body = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ sub, role: "authenticated", aud: "authenticated", app_metadata: { app_role: appRole }, exp: Math.floor(Date.now() / 1000) + 3600 })}`;
  return `${body}.${createHmac("sha256", JWT_SECRET).update(body).digest("base64url")}`;
}

function claimsOf(token: string): { sub: string; app_metadata: { app_role: string } } | null {
  const [header, payload, signature] = token.split(".");
  if (!signature || createHmac("sha256", JWT_SECRET).update(`${header}.${payload}`).digest("base64url") !== signature) return null;
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
}

test("MCP order completion end to end through real PostgREST and PostgreSQL", { skip: process.env.RUN_POSTGRES_SMOKE !== "1" }, async (t) => {
  const suffix = Date.now();
  const network = `aly-order-e2e-${suffix}`;
  const pg = `aly-order-e2e-pg-${suffix}`;
  const rest = `aly-order-e2e-rest-${suffix}`;
  // One ordered teardown: MCP clients, then the gateway (dropping keep-alive sockets), then the
  // containers, then the network they are attached to.
  const cleanup: Array<() => unknown> = [];
  t.after(async () => {
    for (const step of cleanup.reverse()) {
      try { await step(); } catch { /* best effort: later steps must still run */ }
    }
  });
  execFileSync("docker", ["network", "create", network], { stdio: "pipe" });
  cleanup.push(() => execFileSync("docker", ["network", "rm", network], { stdio: "pipe" }));
  execFileSync("docker", ["run", "-d", "--name", pg, "--network", network, "-e", "POSTGRES_PASSWORD=test-only", "postgres:17-alpine"], { stdio: "pipe" });
  cleanup.push(() => execFileSync("docker", ["rm", "-f", pg], { stdio: "pipe" }));
  const run = (input: string) => execFileSync("docker", ["exec", "-i", pg, "psql", "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-tA"], { input, encoding: "utf8", stdio: "pipe" });
  const q1 = (s: string) => run(s).trim();
  let ready = false;
  for (let attempt = 0; attempt < 90 && !ready; attempt++) {
    try { ready = run("select 1").trim() === "1"; } catch { await new Promise((resolve) => setTimeout(resolve, 1000)); }
  }
  assert.ok(ready, "PostgreSQL must start; an unavailable database is not a passing test");
  await new Promise((resolve) => setTimeout(resolve, 500));

  // Supabase-shaped roles and claim readers. PostgREST sets request.jwt.claims (JSON) per request.
  run(`create role authenticated nologin; create role anon nologin; create role service_role nologin;
    create role authenticator login password 'test-only' noinherit; grant authenticated, anon to authenticator;
    create schema auth; grant usage on schema auth to authenticated, anon;
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claims', true)::jsonb->>'sub', '')::uuid $$;
    create function public.is_product_lab_owner() returns boolean language sql stable as $$ select coalesce(current_setting('request.jwt.claims', true)::jsonb->'app_metadata'->>'app_role', '') = 'owner' $$;`);
  run(sql("supabase-add-inventory.sql"));
  run(sql("supabase-add-supplies.sql"));
  run(`alter table purchase_imports add column supplier_name text, add column receipt_number text, add column purchase_date date;
    alter table purchase_import_rows add column brand_name text, add column raw_supplier text default '', add column raw_receipt_number text default '', add column raw_purchase_date text default '', add column raw_package_unit text default '', add column raw_category text default '';
    alter table ingredients add column category text;
    create function save_supply_with_inventory_effect(uuid,boolean,jsonb,jsonb,jsonb) returns void language sql as 'select';
    create function repair_supply_inventory_effects(jsonb,jsonb) returns void language sql as 'select';
    create table public.products (id text primary key, name text not null);
    create table public.product_batches (
      id uuid primary key default gen_random_uuid(), product_id text not null references public.products(id),
      batch_version text not null, status text not null default 'draft',
      completed_at timestamptz, voided_at timestamptz, usable_pieces integer, updated_at timestamptz);
    alter table public.products enable row level security;
    alter table public.product_batches enable row level security;
    grant select, insert, update, delete on public.products, public.product_batches to authenticated;
    create policy p_products on public.products for all to authenticated using (public.is_product_lab_owner()) with check (public.is_product_lab_owner());
    create policy p_batches on public.product_batches for all to authenticated using (public.is_product_lab_owner()) with check (public.is_product_lab_owner());`);
  run(sql("supabase/migrations/20260909132327_selling_wave_0a_raw_authority.sql"));
  run(sql("supabase/migrations/20260909162224_selling_wave_0a_reversal_boundary.sql"));
  run(sql("supabase/migrations/20260910022601_selling_wave_0b_safe_mutations.sql"));
  run(sql("supabase/migrations/20260910120146_selling_wave_1_production_execution.sql"));
  run(`create table public.selling_formats (id uuid primary key default gen_random_uuid());
    alter table public.selling_formats enable row level security;`);
  run(sql("supabase-add-orders.sql"));
  run(sql("supabase/migrations/20260910181827_selling_wave_2_order_reservation.sql"));
  run(sql("supabase/migrations/20261027120000_order_fulfillment_expected_state_guard.sql"));

  execFileSync("docker", ["run", "-d", "--name", rest, "--network", network, "-p", "127.0.0.1::3000",
    "-e", `PGRST_DB_URI=postgres://authenticator:test-only@${pg}:5432/postgres`,
    "-e", "PGRST_DB_SCHEMAS=public", "-e", "PGRST_DB_ANON_ROLE=anon", "-e", `PGRST_JWT_SECRET=${JWT_SECRET}`,
    "-e", "PGRST_JWT_AUD=authenticated", "postgrest/postgrest@sha256:d155c6718ed9a9f990d159a2ab7c0a3f16944dbb6d0a0344557421042acfe0df"], { stdio: "pipe" });
  cleanup.push(() => execFileSync("docker", ["rm", "-f", rest], { stdio: "pipe" }));
  const restPort = execFileSync("docker", ["port", rest, "3000"], { encoding: "utf8" }).trim().split(":").pop();
  const restUrl = `http://127.0.0.1:${restPort}`;
  let restReady = false;
  for (let attempt = 0; attempt < 60 && !restReady; attempt++) {
    try { restReady = (await fetch(`${restUrl}/`)).status < 500; } catch { /* starting */ }
    if (!restReady) await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  assert.ok(restReady, "PostgREST must start");

  // Supabase-shaped gateway: Auth's /auth/v1/user from the verified JWT; /rest/v1/* proxied to PostgREST.
  const gateway = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://gateway");
    const token = req.headers.authorization?.replace(/^Bearer /, "") ?? "";
    if (url.pathname === "/auth/v1/user") {
      const claims = claimsOf(token);
      res.writeHead(claims ? 200 : 401, { "content-type": "application/json" });
      return res.end(JSON.stringify(claims ? { id: claims.sub, email: `${claims.sub}@example.test`, app_metadata: claims.app_metadata } : { message: "invalid token" }));
    }
    if (!url.pathname.startsWith("/rest/v1/")) { res.writeHead(404); return res.end(); }
    let body = "";
    for await (const chunk of req) body += chunk;
    const headers: Record<string, string> = {};
    for (const name of ["authorization", "content-type", "accept", "prefer", "range", "range-unit", "content-profile", "accept-profile"]) {
      const value = req.headers[name];
      if (typeof value === "string") headers[name] = value;
    }
    const upstream = await fetch(`${restUrl}${url.pathname.slice("/rest/v1".length)}${url.search}`, { method: req.method, headers, body: body || undefined });
    const text = await upstream.text();
    res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json", ...(upstream.headers.get("content-range") ? { "content-range": upstream.headers.get("content-range")! } : {}) });
    res.end(text);
  });
  await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve) => { gateway.close(() => resolve()); gateway.closeAllConnections(); }));
  const address = gateway.address();
  assert.ok(address && typeof address === "object");
  const bindings = {
    PRODUCT_LAB_SUPABASE_URL: `http://127.0.0.1:${address.port}`,
    PRODUCT_LAB_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_order_e2e",
    PRODUCT_LAB_MCP_PUBLIC_HOSTNAME: WORKER_HOSTNAME,
  };

  const clients: Client[] = [];
  cleanup.push(() => Promise.all(clients.map((client) => client.close())));
  async function connect(token: string) {
    const transport = new StreamableHTTPClientTransport(new URL(`https://${WORKER_HOSTNAME}/api/mcp`), {
      authProvider: { token: async () => token },
      fetch: (input, init) => {
        const url = new URL(input as string | URL);
        const headers = new Headers(init?.headers);
        headers.set("host", url.host);
        return worker.fetch(new Request(url, { ...init, headers }), bindings);
      },
    });
    const client = new Client({ name: "order-e2e", version: "1.0.0" });
    await client.connect(transport);
    clients.push(client);
    return client;
  }
  const shin = await connect(jwt(SHIN, "owner"));
  const alyssa = await connect(jwt(ALYSSA, "owner"));
  type Result = { isError?: boolean; structuredContent?: Record<string, unknown>; content: Array<{ text?: string }> };
  const call = async (client: Client, name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as Result;
  const ok = async (client: Client, name: string, args: Record<string, unknown>) => {
    const result = await call(client, name, args);
    assert.equal(result.isError, undefined, `${name}: ${result.content[0]?.text}`);
    return result.structuredContent!;
  };
  const errorCode = async (client: Client, name: string, args: Record<string, unknown>) => {
    const result = await call(client, name, args);
    assert.equal(result.isError, true, `${name} unexpectedly succeeded`);
    return (JSON.parse(result.content[0].text!) as { error: { code: string } }).error.code;
  };

  const OWNER_SQL = `set role authenticated; select set_config('request.jwt.claims', '{"sub":"${SHIN}","role":"authenticated","app_metadata":{"app_role":"owner"}}', false);`;
  function confirmedOrder(pieces: number, perUnit: number, quantity: number) {
    const product = `p-${randomUUID().slice(0, 8)}`;
    const batch = randomUUID(); const execution = randomUUID(); const customer = randomUUID(); const order = randomUUID();
    run(`insert into public.products (id, name) values ('${product}', 'Cookie ${product}');
      insert into public.product_batches (id, product_id, batch_version, status, usable_pieces) values ('${batch}', '${product}', 'v1', 'completed', ${pieces});
      insert into public.production_executions (id, product_id, product_batch_id, batch_version_snapshot, operation_id, multiplier, quantity_produced_pieces, expected_pieces, frozen_ingredient_cost_total, frozen_cost_per_piece, completed_at)
        values ('${execution}', '${product}', '${batch}', 'v1', '${randomUUID()}', 1, ${pieces}, ${pieces}, ${pieces * 10}, 10, now());
      insert into public.finished_stock_movements (product_id, production_execution_id, movement_type, on_hand_delta, reserved_delta, operation_id, note)
        values ('${product}', '${execution}', 'production_receipt', ${pieces}, 0, '${randomUUID()}', 'seed');
      insert into public.customers (id, name) values ('${customer}', 'E2E Customer');
      insert into public.orders (id, customer_id, status) values ('${order}', '${customer}', 'new');
      insert into public.order_lines (id, order_id, product_id, item_name, unit_price, pieces_per_unit_snapshot, quantity)
        values ('${randomUUID()}', '${order}', '${product}', 'Cookie box', 225, ${perUnit}, ${quantity});`);
    run(`${OWNER_SQL} select public.confirm_order_with_reservation('${randomUUID()}', '${order}'); reset role;`);
    return { order, execution };
  }
  const lot = (execution: string) => q1(`select sum(on_hand_delta) || '/' || sum(reserved_delta) from public.finished_stock_movements where production_execution_id = '${execution}'`);
  const fulfils = (order: string) => q1(`select count(*) from public.finished_stock_movements where order_id = '${order}' and movement_type = 'fulfill'`);

  await t.test("preview -> apply -> verify: the reviewed updated_at round-trips through PostgREST and the guard accepts it; payment untouched", async () => {
    const f = confirmedOrder(10, 3, 2);
    const preview = await ok(shin, "order_complete_preview", { order_id: f.order });
    assert.equal(preview.can_apply, true);
    assert.equal(fulfils(f.order), "0", "preview never writes");
    const applied = await ok(shin, "order_complete_apply", { order_id: f.order, preview_id: preview.preview_id, approval_code: preview.approval_code });
    assert.equal(applied.order_status, "completed");
    assert.equal((applied.payment as { payment_status: string }).payment_status, "unpaid");
    const verified = await ok(shin, "order_complete_verify", { order_id: f.order, preview_id: preview.preview_id });
    assert.equal(verified.status, "verified", JSON.stringify(verified.failures));
    assert.equal(verified.mutation_receipt, "matched");
    assert.equal(lot(f.execution), "4/0");
    assert.equal(q1(`select payment_status || '/' || coalesce(paid_amount::text, 'null') from public.orders where id = '${f.order}'`), "unpaid/null");
  });

  await t.test("both owners approve the same preview concurrently: one fulfilment, both succeed, both verify", async () => {
    const f = confirmedOrder(10, 3, 2);
    const preview = await ok(shin, "order_complete_preview", { order_id: f.order });
    assert.equal((await ok(alyssa, "order_complete_preview", { order_id: f.order })).preview_id, preview.preview_id);
    const args = { order_id: f.order, preview_id: preview.preview_id, approval_code: preview.approval_code };
    const outcomes = await Promise.all([call(shin, "order_complete_apply", args), call(alyssa, "order_complete_apply", args)]);
    for (const outcome of outcomes) {
      // Either the result or the replay; at worst "still processing", which is retryable and safe.
      if (outcome.isError) assert.match(outcome.content[0].text!, /order_apply_in_progress/);
    }
    assert.equal(fulfils(f.order), "1");
    assert.equal(lot(f.execution), "4/0");
    assert.equal((await ok(alyssa, "order_complete_verify", { order_id: f.order, preview_id: preview.preview_id })).status, "verified");
  });

  await t.test("a payment recorded after the preview makes Apply refuse; a fresh preview then completes and keeps the payment", async () => {
    const f = confirmedOrder(10, 3, 2);
    const preview = await ok(shin, "order_complete_preview", { order_id: f.order });
    run(`${OWNER_SQL} update public.orders set payment_status = 'paid', payment_method = 'gcash', paid_at = now(), paid_amount = 450, updated_at = clock_timestamp() where id = '${f.order}'; reset role;`);
    assert.equal(await errorCode(shin, "order_complete_apply", { order_id: f.order, preview_id: preview.preview_id, approval_code: preview.approval_code }), "order_preview_stale_or_invalid");
    assert.equal(fulfils(f.order), "0");
    const fresh = await ok(shin, "order_complete_preview", { order_id: f.order });
    const applied = await ok(shin, "order_complete_apply", { order_id: f.order, preview_id: fresh.preview_id, approval_code: fresh.approval_code });
    assert.deepEqual([(applied.payment as { payment_status: string }).payment_status, (applied.payment as { paid_amount: number }).paid_amount], ["paid", 450]);
  });

  await t.test("a lot corrupted below its reservation is blocked at preview and cannot be completed", async () => {
    const f = confirmedOrder(10, 6, 1);
    run(`insert into public.finished_stock_movements (product_id, production_execution_id, movement_type, on_hand_delta, reserved_delta, operation_id, order_id, order_stock_allocation_id, note)
      select a.product_id, a.production_execution_id, 'fulfill', -3, -3, gen_random_uuid(), a.order_id, a.id, 'stray' from public.order_stock_allocations a where a.order_id = '${f.order}';`);
    const preview = await ok(shin, "order_complete_preview", { order_id: f.order });
    assert.equal(preview.can_apply, false);
    assert.equal(await errorCode(shin, "order_complete_apply", { order_id: f.order, preview_id: preview.preview_id, approval_code: preview.approval_code }), "order_not_completable");
    assert.equal(lot(f.execution), "7/3", "nothing fulfilled, nothing negative");
  });

  await t.test("an order completed from the web app path is not completed again, and does not verify for this preview", async () => {
    const f = confirmedOrder(10, 6, 1);
    const preview = await ok(shin, "order_complete_preview", { order_id: f.order });
    run(`${OWNER_SQL} select public.complete_order_with_fulfillment('${randomUUID()}', '${f.order}'); reset role;`);
    assert.equal(await errorCode(shin, "order_complete_apply", { order_id: f.order, preview_id: preview.preview_id, approval_code: preview.approval_code }), "order_preview_stale_or_invalid");
    const verified = await ok(shin, "order_complete_verify", { order_id: f.order, preview_id: preview.preview_id });
    assert.equal(verified.status, "not_verified");
    assert.equal(verified.mutation_receipt, "missing");
    assert.equal(fulfils(f.order), "1");
    assert.equal(q1(`select count(*) from inventory_private.mutation_receipts where operation_id = '${preview.operation_id}'`), "0");
  });

  await t.test("a non-owner token never reaches PostgREST, and the database refuses a non-owner even if it did", async () => {
    await assert.rejects(() => connect(jwt(STAFF, "staff")));
    const f = confirmedOrder(10, 6, 1);
    // Full, correct arguments, so a refusal can only come from authorization, never "function not found".
    const args = JSON.stringify({
      p_operation_id: randomUUID(), p_order_id: f.order,
      ...JSON.parse(q1(`select json_build_object('p_expected_updated_at', updated_at, 'p_expected_payment_status', payment_status,
        'p_expected_payment_method', payment_method, 'p_expected_paid_at', paid_at, 'p_expected_paid_amount', paid_amount,
        'p_expected_refunded_at', refunded_at) from public.orders where id = '${f.order}'`)),
    });
    const staffCall = await fetch(`${restUrl}/rpc/complete_order_with_fulfillment_checked`, {
      method: "POST",
      headers: { authorization: `Bearer ${jwt(STAFF, "staff")}`, "content-type": "application/json" },
      body: args,
    });
    assert.equal(staffCall.status, 403);
    assert.equal(((await staffCall.json()) as { code: string }).code, "42501");
    const anonCall = await fetch(`${restUrl}/rpc/complete_order_with_fulfillment_checked`, {
      method: "POST", headers: { "content-type": "application/json" }, body: args,
    });
    assert.ok([401, 403].includes(anonCall.status), `anon must be refused by permission, got ${anonCall.status}`);
    assert.equal(((await anonCall.json()) as { code: string }).code, "42501");
    assert.equal(fulfils(f.order), "0");
  });
});
