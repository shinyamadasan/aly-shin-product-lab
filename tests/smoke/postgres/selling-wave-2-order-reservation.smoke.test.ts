import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const root = path.resolve(import.meta.dirname, "../../..");
const sql = (file: string) => readFileSync(path.join(root, file), "utf8");
// Transaction-local (is_local = true): for the spawnPsqlAsync concurrency helpers, which wrap
// everything in one begin;...commit;. Matches tests/smoke/postgres/selling-wave-1-production-execution.smoke.test.ts.
const OWNER_JWT = `select set_config('request.jwt.claim.sub','77777777-7777-4777-8777-777777777777',true);
  select set_config('request.jwt.claim.app_role','owner',true);
  select set_config('request.jwt.claims','{"sub":"77777777-7777-4777-8777-777777777777","role":"authenticated","app_metadata":{"app_role":"owner"}}',true);`;
// Session-scoped (is_local = false): for run() calls, which execute each statement in its own
// autocommit transaction -- a transaction-local setting would not survive to the next statement.
const OWNER_SESSION = `set role authenticated;
  select set_config('request.jwt.claim.sub','77777777-7777-4777-8777-777777777777',false);
  select set_config('request.jwt.claim.app_role','owner',false);
  select set_config('request.jwt.claims','{"sub":"77777777-7777-4777-8777-777777777777","role":"authenticated","app_metadata":{"app_role":"owner"}}',false);`;

test("Wave 2 connects orders to finished stock: reserve at confirm, release at cancel, fulfill at complete, no oversell", { skip: process.env.RUN_POSTGRES_SMOKE !== "1" }, async (t) => {
  const container = `aly-wave2-${Date.now()}`;
  execFileSync("docker", ["run", "-d", "--name", container, "-e", "POSTGRES_PASSWORD=test-only", "postgres:17-alpine"], { stdio: "pipe" });
  t.after(() => execFileSync("docker", ["rm", "-f", container], { stdio: "pipe" }));
  const run = (input: string) => execFileSync("docker", ["exec", "-i", container, "psql", "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-tA"], { input, encoding: "utf8", stdio: "pipe" });
  let ready = false;
  for (let attempt = 0; attempt < 90; attempt++) {
    try { if (run("select 1").trim() === "1") { ready = true; break; } } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  assert.ok(ready, "PostgreSQL must start; an unavailable database is not a passing test");
  await new Promise((resolve) => setTimeout(resolve, 500)); // small settle after first successful connect

  // Base environment + Wave 0A/0B dependencies, same shape as the Wave 1 smoke harness.
  run(`create role authenticated; create role anon; create role service_role;
    create schema auth;
    create function auth.uid() returns uuid language sql as 'select nullif(current_setting(''request.jwt.claim.sub'',true),'''')::uuid';
    grant usage on schema auth to authenticated;
    create function public.is_product_lab_owner() returns boolean language sql as 'select current_setting(''request.jwt.claim.app_role'',true) = ''owner''';`);
  run(sql("supabase-add-inventory.sql"));
  run(sql("supabase-add-supplies.sql"));
  run(`alter table purchase_imports add column supplier_name text, add column receipt_number text, add column purchase_date date;
    alter table purchase_import_rows add column brand_name text, add column raw_supplier text default '', add column raw_receipt_number text default '', add column raw_purchase_date text default '', add column raw_package_unit text default '', add column raw_category text default '';
    alter table ingredients add column category text;
    create function save_supply_with_inventory_effect(uuid,boolean,jsonb,jsonb,jsonb) returns void language sql as 'select';
    create function repair_supply_inventory_effects(jsonb,jsonb) returns void language sql as 'select';
    grant execute on function save_supply_with_inventory_effect(uuid,boolean,jsonb,jsonb,jsonb) to authenticated;
    grant execute on function repair_supply_inventory_effects(jsonb,jsonb) to authenticated;
    drop policy "Authenticated users can manage ingredients" on ingredients;
    create policy owner_inventory on ingredients for all to authenticated using (public.is_product_lab_owner()) with check (public.is_product_lab_owner());
    drop policy "Authenticated users can manage inventory transactions" on inventory_transactions;
    create policy owner_history on inventory_transactions for all to authenticated using (public.is_product_lab_owner()) with check (public.is_product_lab_owner());
    drop policy "Authenticated users can manage purchase imports" on purchase_imports;
    create policy owner_imports on purchase_imports for all to authenticated using (public.is_product_lab_owner()) with check (public.is_product_lab_owner());
    drop policy "Authenticated users can manage purchase import rows" on purchase_import_rows;
    create policy owner_import_rows on purchase_import_rows for all to authenticated using (public.is_product_lab_owner()) with check (public.is_product_lab_owner());
    drop policy "Authenticated users can manage supply entries" on supply_entries;
    create policy owner_supplies on supply_entries for all to authenticated using (public.is_product_lab_owner()) with check (public.is_product_lab_owner());`);
  // Minimal products / product_batches -- only the columns Wave 1/2 read and write.
  run(`create table public.products (id text primary key, name text not null);
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
  // orders/order_lines/customers live outside supabase/migrations/ (supabase-add-orders.sql
  // predates the migration-CLI convention). selling_formats is stubbed minimally -- only its
  // existence is needed, as an FK target order_lines.selling_format_id points at and this suite
  // never uses.
  run(`create table public.selling_formats (id uuid primary key default gen_random_uuid());
    alter table public.selling_formats enable row level security;`);
  run(sql("supabase-add-orders.sql"));
  run(sql("supabase/migrations/20260910181827_selling_wave_2_order_reservation.sql"));

  await t.test("single-shot invariants: FIFO reservation, release, fulfillment, Follow-One-Brownie, multi-product atomicity, release-then-re-reserve, idempotency, authority, constraint shapes", () => {
    const result = run(sql("tests/smoke/postgres/selling-wave-2-order-reservation.assertions.sql"));
    assert.match(result, /wave_2_assertions_passed/);
  });

  // Reusable fixtures for the concurrency / fault sub-tests below.
  function makeProduct(pieces: number, completedAtExpr = "now()"): { product: string; batch: string; execution: string } {
    const product = `p-${crypto.randomUUID().slice(0, 8)}`;
    const batch = crypto.randomUUID();
    const execution = crypto.randomUUID();
    run(`insert into public.products (id, name) values ('${product}', 'Test ${product}');
      insert into public.product_batches (id, product_id, batch_version, status, usable_pieces) values ('${batch}', '${product}', 'v1', 'completed', ${pieces});
      insert into public.production_executions (id, product_id, product_batch_id, batch_version_snapshot, operation_id, multiplier, quantity_produced_pieces, expected_pieces, frozen_ingredient_cost_total, frozen_cost_per_piece, completed_at)
        values ('${execution}', '${product}', '${batch}', 'v1', '${crypto.randomUUID()}', 1, ${pieces}, ${pieces}, ${pieces * 10}, 10, ${completedAtExpr});
      insert into public.finished_stock_movements (product_id, production_execution_id, movement_type, on_hand_delta, reserved_delta, operation_id, note)
        values ('${product}', '${execution}', 'production_receipt', ${pieces}, 0, '${crypto.randomUUID()}', 'seed');`);
    return { product, batch, execution };
  }
  function makeCustomer(): string {
    const id = crypto.randomUUID();
    run(`insert into public.customers (id, name) values ('${id}', 'Test Customer ${id.slice(0, 8)}');`);
    return id;
  }
  function makeOrder(customerId: string, productId: string, piecesPerUnit: number, quantity: number): string {
    const orderId = crypto.randomUUID();
    run(`insert into public.orders (id, customer_id, status) values ('${orderId}', '${customerId}', 'new');
      insert into public.order_lines (id, order_id, product_id, item_name, unit_price, pieces_per_unit_snapshot, quantity)
        values ('${crypto.randomUUID()}', '${orderId}', '${productId}', 'Test line', 100, ${piecesPerUnit}, ${quantity});`);
    return orderId;
  }

  function spawnPsqlAsync(input: string): Promise<{ stdout: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn("docker", ["exec", "-i", container, "psql", "-U", "postgres", "-tA"], { stdio: ["pipe", "pipe", "pipe"] });
      let out = "";
      child.stdout.on("data", (c) => { out += c; });
      child.stderr.on("data", (c) => { out += c; });
      child.on("error", reject);
      child.on("close", () => resolve({ stdout: out }));
      child.stdin.end(input);
    });
  }
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const owner = (extra = "") => `begin; set local role authenticated; ${OWNER_JWT} ${extra}`;
  // production_executions/finished_stock_movements are SELECT-only for `authenticated` (Wave 1) --
  // a raw client-issued `SELECT ... FOR UPDATE` needs UPDATE privilege too, so `authenticated`
  // cannot take that lock directly (correctly -- only the security-definer RPCs can). To simulate
  // "another session is mid-confirmation" for these tests, the pre-lock runs as the table owner
  // BEFORE switching to authenticated; Postgres row locks apply to any later locker regardless of
  // role, so this still serializes the second session's later RPC call exactly as a real second
  // confirm attempt would.
  //
  // The pre-lock MUST take the products row before the production_executions rows -- the exact
  // order confirm_order_with_reservation itself locks them (products first as the always-present
  // serialization anchor, then the execution sweep). A pre-lock that grabbed executions first
  // would deadlock against a concurrent real confirm holding products and waiting on executions.
  const preLockConfirmOrder = (product: string) =>
    `select id from public.products where id = '${product}' for update;` +
    ` select id from public.production_executions where product_id = '${product}' for update;`;
  const ownerWithPreLock = (lockSql: string) => `begin; ${lockSql} set local role authenticated; ${OWNER_JWT}`;
  const q1 = (s: string) => run(s).trim();
  // Kept as a string (like q1) rather than Number(): this file's other assertions compare q1's
  // output against string literals under node:assert/strict, whose equal() does not coerce types.
  const available = (product: string) => q1(`select coalesce(sum(on_hand_delta),0) - coalesce(sum(reserved_delta),0) from public.finished_stock_movements where product_id = '${product}'`);

  await t.test("same order, two DIFFERENT confirm operation ids racing: exactly one reserves, the loser makes zero allocations", async () => {
    const f = makeProduct(10);
    const customer = makeCustomer();
    const order = makeOrder(customer, f.product, 6, 1); // needs 6 of 10
    const opA = crypto.randomUUID(); const opB = crypto.randomUUID();
    const callBody = (op: string) => `${owner()} select public.confirm_order_with_reservation('${op}', '${order}'); commit;`;
    const a = spawnPsqlAsync(callBody(opA));
    await sleep(20);
    const b = spawnPsqlAsync(callBody(opB));
    const [ra, rb] = await Promise.all([a, b]);
    // Exactly one of the two must have actually reserved (the other either errors, since the
    // order is no longer 'new' by the time it gets the order lock, or the whole call still
    // reports success from a stale read racing the lock -- what matters is the ledger).
    assert.equal(q1(`select status from public.orders where id = '${order}'`), "confirmed");
    assert.equal(q1(`select count(*) from public.order_stock_allocations where order_id = '${order}' and status = 'active'`), "1");
    assert.equal(available(f.product), "4", "exactly one reservation of 6 against 10 must land, never two");
    assert.ok(ra.stdout.length >= 0 && rb.stdout.length >= 0); // both calls returned (no hang/deadlock)
  });

  await t.test("two different orders competing for the same short stock: exactly one succeeds, the loser sees insufficient stock and reserves nothing", async () => {
    const f = makeProduct(10); // enough for one order needing 6, not two
    const customer = makeCustomer();
    const orderA = makeOrder(customer, f.product, 6, 1);
    const orderB = makeOrder(customer, f.product, 6, 1);
    const opA = crypto.randomUUID(); const opB = crypto.randomUUID();
    const a = spawnPsqlAsync(`${ownerWithPreLock(`${preLockConfirmOrder(f.product)} select pg_sleep(1.0);`)} select public.confirm_order_with_reservation('${opA}', '${orderA}'); commit;`);
    await sleep(300);
    const b = spawnPsqlAsync(`${owner()} do $$ begin
      perform public.confirm_order_with_reservation('${opB}', '${orderB}');
      raise notice 'order_b_unexpectedly_confirmed';
    exception when check_violation then raise notice 'order_b_rejected_as_expected'; end $$; commit;`);
    const [ra, rb] = await Promise.all([a, b]);
    assert.doesNotMatch(ra.stdout, /ERROR/);
    assert.match(rb.stdout, /order_b_rejected_as_expected/);
    assert.doesNotMatch(rb.stdout, /order_b_unexpectedly_confirmed/);
    assert.equal(q1(`select status from public.orders where id = '${orderA}'`), "confirmed");
    assert.equal(q1(`select status from public.orders where id = '${orderB}'`), "new");
    assert.equal(q1(`select count(*) from public.order_stock_allocations where order_id = '${orderB}'`), "0", "the loser must make zero allocations");
    assert.equal(available(f.product), "4", "reserved must be exactly 6, never 12 -- no oversell");
  });

  await t.test("two orders, stock sufficient for both: both succeed, reserved sums correctly", async () => {
    const f = makeProduct(20);
    const customer = makeCustomer();
    const orderA = makeOrder(customer, f.product, 6, 1);
    const orderB = makeOrder(customer, f.product, 6, 1);
    const opA = crypto.randomUUID(); const opB = crypto.randomUUID();
    const a = spawnPsqlAsync(`${ownerWithPreLock(`${preLockConfirmOrder(f.product)} select pg_sleep(1.0);`)} select public.confirm_order_with_reservation('${opA}', '${orderA}'); commit;`);
    await sleep(300);
    const b = spawnPsqlAsync(`${owner()} select public.confirm_order_with_reservation('${opB}', '${orderB}'); commit;`);
    const [ra, rb] = await Promise.all([a, b]);
    assert.doesNotMatch(ra.stdout, /ERROR/);
    assert.doesNotMatch(rb.stdout, /ERROR/);
    assert.equal(q1(`select status from public.orders where id = '${orderA}'`), "confirmed");
    assert.equal(q1(`select status from public.orders where id = '${orderB}'`), "confirmed");
    assert.equal(available(f.product), "8", "20 - 6 - 6 = 8");
  });

  await t.test("cancel vs complete race on the same confirmed order: exactly one transition wins, the loser has zero stock effect", async () => {
    const f = makeProduct(10);
    const customer = makeCustomer();
    const order = makeOrder(customer, f.product, 6, 1);
    run(`${OWNER_SESSION} select public.confirm_order_with_reservation('${crypto.randomUUID()}', '${order}'); reset role;`);
    assert.equal(q1(`select status from public.orders where id = '${order}'`), "confirmed");

    const opCancel = crypto.randomUUID(); const opComplete = crypto.randomUUID();
    const cancelCall = spawnPsqlAsync(`${owner(`select id from public.orders where id = '${order}' for update; select pg_sleep(1.0);`)} select public.cancel_order_with_release('${opCancel}', '${order}', 'race test'); commit;`);
    await sleep(300);
    const completeCall = spawnPsqlAsync(`${owner()} do $$ begin
      perform public.complete_order_with_fulfillment('${opComplete}', '${order}');
      raise notice 'complete_unexpectedly_won';
    exception when check_violation then raise notice 'complete_lost_as_expected'; end $$; commit;`);
    const [rc, rf] = await Promise.all([cancelCall, completeCall]);
    assert.doesNotMatch(rc.stdout, /ERROR/);

    const finalStatus = q1(`select status from public.orders where id = '${order}'`);
    // Whichever actually holds the order-row lock first wins; both outcomes are valid winners,
    // but EXACTLY one of them must have won and the ledger must be internally coherent either way.
    assert.ok(finalStatus === "cancelled" || finalStatus === "completed", `exactly one transition must win, got ${finalStatus}`);
    if (finalStatus === "cancelled") {
      assert.match(rf.stdout, /complete_lost_as_expected/);
      assert.equal(available(f.product), "10", "a cancelled order releases back to full availability");
      assert.equal(q1(`select coalesce(sum(on_hand_delta),0) from public.finished_stock_movements where product_id = '${f.product}'`), "10", "cancelling must never touch on_hand");
    } else {
      assert.equal(available(f.product), "4", "10 - 6 fulfilled = 4 still on hand and available, none reserved");
      assert.equal(q1(`select coalesce(sum(reserved_delta),0) from public.finished_stock_movements where product_id = '${f.product}'`), "0");
    }
    assert.equal(q1(`select count(*) from public.order_stock_allocations where order_id = '${order}' and status = 'active'`), "0", "no allocation may remain active once the order reached a terminal state");
  });

  await t.test("confirming an order races a brand-new production Bake receipt on the same product: coherent result either way, never an impossible state", async () => {
    const f = makeProduct(6); // exactly enough for the order alone, before any new receipt lands
    const customer = makeCustomer();
    const order = makeOrder(customer, f.product, 6, 1);
    const op = crypto.randomUUID();
    const opBake = crypto.randomUUID();
    const confirmCall = spawnPsqlAsync(`${owner(`select pg_sleep(0.3);`)} do $$ begin
      perform public.confirm_order_with_reservation('${op}', '${order}');
      raise notice 'confirm_landed';
    exception when check_violation then raise notice 'confirm_saw_insufficient'; end $$; commit;`);
    // A brand-new production execution does not lock the SAME row confirm locks (it inserts a new
    // row), so it can legitimately land before or after -- both are coherent, neither is corrupt.
    // Inserted directly (bypassing confirm_bake_v3, which Wave 1's own suite already proves) as
    // the table owner -- a real Bake reaches these tables through a security-definer function
    // that runs with the owner's privileges, not through a client-held grant, so simulating its
    // effect the same way (rather than as `authenticated`, which has no write grant here) is the
    // faithful equivalent.
    const bakeCall = spawnPsqlAsync(`begin;
      insert into public.production_executions (id, product_id, product_batch_id, batch_version_snapshot, operation_id, multiplier, quantity_produced_pieces, expected_pieces, frozen_ingredient_cost_total, frozen_cost_per_piece, completed_at)
        values (gen_random_uuid(), '${f.product}', '${f.batch}', 'v1', '${opBake}', 1, 5, 5, 50, 10, now());
      insert into public.finished_stock_movements (product_id, production_execution_id, movement_type, on_hand_delta, reserved_delta, operation_id, note)
        select '${f.product}', id, 'production_receipt', 5, 0, '${opBake}', 'race bake' from public.production_executions where operation_id = '${opBake}';
      commit;`);
    const [rc, rb] = await Promise.all([confirmCall, bakeCall]);
    assert.match(rc.stdout, /confirm_landed|confirm_saw_insufficient/);
    assert.doesNotMatch(rb.stdout, /ERROR/);
    // Invariant that must hold regardless of interleaving: available is never negative, and
    // reserved is exactly what the order actually holds (6 if it landed, 0 if it did not).
    const onHand = Number(q1(`select coalesce(sum(on_hand_delta),0) from public.finished_stock_movements where product_id = '${f.product}'`));
    const reserved = Number(q1(`select coalesce(sum(reserved_delta),0) from public.finished_stock_movements where product_id = '${f.product}'`));
    assert.equal(onHand, 11, "6 seeded + 5 from the race Bake, regardless of interleaving");
    assert.ok(reserved === 0 || reserved === 6, `reserved must be exactly 0 or 6, never anything else, got ${reserved}`);
    assert.ok(onHand - reserved >= 0, "available must never go negative");
  });

  await t.test("two confirmations for a product that has NEVER been baked, racing its first Bake: the products-row lock still serializes them -- oversell is impossible", async () => {
    // A bare product: zero production_executions, zero finished stock. Before Wave 2's
    // products-row lock, two confirmations here would each lock nothing on the execution sweep
    // (empty set) and could both allocate the same first lot.
    const product = `p-${crypto.randomUUID().slice(0, 8)}`;
    const batch = crypto.randomUUID();
    run(`insert into public.products (id, name) values ('${product}', 'Never baked ${product}');
      insert into public.product_batches (id, product_id, batch_version, status, usable_pieces) values ('${batch}', '${product}', 'v1', 'completed', 6);`);
    const customer = makeCustomer();
    const orderA = makeOrder(customer, product, 6, 1);
    const orderB = makeOrder(customer, product, 6, 1);
    const bakeOp = crypto.randomUUID();

    // Session L holds the canonical products row so A, B and the first Bake all queue behind the
    // same anchor; when it releases, they proceed one at a time through that row's lock. Whichever
    // confirmation runs second sees either the other's committed reservation or still-zero stock.
    const holder = spawnPsqlAsync(`begin; select id from public.products where id = '${product}' for update; select pg_sleep(1.5); commit;`);
    await sleep(200);
    const confirmA = spawnPsqlAsync(`${owner()} do $$ begin
      perform public.confirm_order_with_reservation('${crypto.randomUUID()}', '${orderA}'); raise notice 'a_confirmed';
    exception when check_violation then raise notice 'a_rejected'; end $$; commit;`);
    await sleep(150);
    const confirmB = spawnPsqlAsync(`${owner()} do $$ begin
      perform public.confirm_order_with_reservation('${crypto.randomUUID()}', '${orderB}'); raise notice 'b_confirmed';
    exception when check_violation then raise notice 'b_rejected'; end $$; commit;`);
    await sleep(150);
    const bake = spawnPsqlAsync(`begin;
      insert into public.production_executions (id, product_id, product_batch_id, batch_version_snapshot, operation_id, multiplier, quantity_produced_pieces, expected_pieces, frozen_ingredient_cost_total, frozen_cost_per_piece, completed_at)
        values (gen_random_uuid(), '${product}', '${batch}', 'v1', '${bakeOp}', 1, 6, 6, 60, 10, now());
      insert into public.finished_stock_movements (product_id, production_execution_id, movement_type, on_hand_delta, reserved_delta, operation_id, note)
        select '${product}', id, 'production_receipt', 6, 0, '${bakeOp}', 'first bake' from public.production_executions where operation_id = '${bakeOp}';
      commit;`);
    const [rl, ra, rb, rk] = await Promise.all([holder, confirmA, confirmB, bake]);
    for (const r of [rl, ra, rb, rk]) assert.doesNotMatch(r.stdout, /ERROR/);

    const onHand = Number(q1(`select coalesce(sum(on_hand_delta),0) from public.finished_stock_movements where product_id = '${product}'`));
    const reserved = Number(q1(`select coalesce(sum(reserved_delta),0) from public.finished_stock_movements where product_id = '${product}'`));
    const confirmedCount = Number(q1(`select count(*) from public.orders where id in ('${orderA}','${orderB}') and status = 'confirmed'`));
    assert.equal(onHand, 6, "the first Bake always eventually lands");
    assert.ok(reserved === 0 || reserved === 6, `reserved must be 0 or 6, NEVER 12 -- got ${reserved}`);
    assert.ok(onHand - reserved >= 0, "available must never go negative");
    assert.ok(confirmedCount <= 1, `at most one of the two orders may reserve the first lot, got ${confirmedCount}`);
    assert.equal(Number(q1(`select count(*) from public.order_stock_allocations where order_id in ('${orderA}','${orderB}') and reserved_pieces > 0`)), reserved === 6 ? 1 : 0);
  });

  // Fault injection: a trigger raises AFTER meaningful writes have already happened in the same
  // transaction. Everything must roll back and the operation id stays retryable.
  await t.test("fault injection during confirm, after an allocation and its reserve movement are written but before the order flips to confirmed: full rollback, operation id retryable", () => {
    const f = makeProduct(10);
    const customer = makeCustomer();
    const order = makeOrder(customer, f.product, 6, 1);
    const op = crypto.randomUUID();
    run(`create function public.w2_fault_confirm() returns trigger language plpgsql as $fn$ begin raise exception 'injected'; end $fn$;
      create trigger w2_fault_trg before update on public.orders for each row
        when (new.status = 'confirmed') execute function public.w2_fault_confirm();`);
    const attempt = run(`${OWNER_SESSION}
      do $$ begin
        perform public.confirm_order_with_reservation('${op}', '${order}');
      exception when others then null; end $$;
      select 'attempt_done'; reset role;`);
    assert.match(attempt, /attempt_done/);
    // Nothing persisted: no allocation, no reserve movement, no status change, no stuck claim.
    assert.equal(q1(`select status from public.orders where id = '${order}'`), "new");
    assert.equal(q1(`select count(*) from public.order_stock_allocations where order_id = '${order}'`), "0");
    assert.equal(available(f.product), "10");
    assert.equal(q1(`select count(*) from inventory_private.mutation_receipts where operation_id = '${op}'`), "0", "failed attempt left no stuck claim");
    run(`drop trigger w2_fault_trg on public.orders; drop function public.w2_fault_confirm();`);
    const retry = run(`${OWNER_SESSION} select public.confirm_order_with_reservation('${op}', '${order}'); reset role;`);
    assert.doesNotMatch(retry, /ERROR/);
    assert.equal(q1(`select status from public.orders where id = '${order}'`), "confirmed");
    assert.equal(available(f.product), "4");
  });

  await t.test("fault injection during cancel, after the release movement is written but before cancelled status lands: full rollback, operation id retryable", () => {
    const f = makeProduct(10);
    const customer = makeCustomer();
    const order = makeOrder(customer, f.product, 6, 1);
    run(`${OWNER_SESSION} select public.confirm_order_with_reservation('${crypto.randomUUID()}', '${order}'); reset role;`);
    assert.equal(available(f.product), "4");
    const op = crypto.randomUUID();
    run(`create function public.w2_fault_cancel() returns trigger language plpgsql as $fn$ begin raise exception 'injected'; end $fn$;
      create trigger w2_fault_trg before update on public.orders for each row
        when (new.status = 'cancelled') execute function public.w2_fault_cancel();`);
    const attempt = run(`${OWNER_SESSION}
      do $$ begin
        perform public.cancel_order_with_release('${op}', '${order}', 'fault test');
      exception when others then null; end $$;
      select 'attempt_done'; reset role;`);
    assert.match(attempt, /attempt_done/);
    // The release movement and the allocation status flip must have rolled back together with the
    // order status -- the reservation is still fully intact, not half-released.
    assert.equal(q1(`select status from public.orders where id = '${order}'`), "confirmed");
    assert.equal(available(f.product), "4", "the reservation must still be fully intact, not half-released");
    assert.equal(q1(`select status from public.order_stock_allocations where order_id = '${order}'`), "active");
    run(`drop trigger w2_fault_trg on public.orders; drop function public.w2_fault_cancel();`);
    const retry = run(`${OWNER_SESSION} select public.cancel_order_with_release('${op}', '${order}', 'fault test'); reset role;`);
    assert.doesNotMatch(retry, /ERROR/);
    assert.equal(q1(`select status from public.orders where id = '${order}'`), "cancelled");
    assert.equal(available(f.product), "10");
  });

  await t.test("fault injection during complete, after the fulfill movement is written but before completed status lands: full rollback, operation id retryable", () => {
    const f = makeProduct(10);
    const customer = makeCustomer();
    const order = makeOrder(customer, f.product, 6, 1);
    run(`${OWNER_SESSION} select public.confirm_order_with_reservation('${crypto.randomUUID()}', '${order}'); reset role;`);
    const op = crypto.randomUUID();
    run(`create function public.w2_fault_complete() returns trigger language plpgsql as $fn$ begin raise exception 'injected'; end $fn$;
      create trigger w2_fault_trg before update on public.orders for each row
        when (new.status = 'completed') execute function public.w2_fault_complete();`);
    const attempt = run(`${OWNER_SESSION}
      do $$ begin
        perform public.complete_order_with_fulfillment('${op}', '${order}');
      exception when others then null; end $$;
      select 'attempt_done'; reset role;`);
    assert.match(attempt, /attempt_done/);
    // The fulfill movement must have rolled back too -- on_hand must NOT have dropped.
    assert.equal(q1(`select status from public.orders where id = '${order}'`), "confirmed");
    assert.equal(q1(`select coalesce(sum(on_hand_delta),0) from public.finished_stock_movements where product_id = '${f.product}'`), "10", "on_hand must be untouched by a rolled-back fulfillment");
    assert.equal(available(f.product), "4");
    assert.equal(q1(`select status from public.order_stock_allocations where order_id = '${order}'`), "active");
    run(`drop trigger w2_fault_trg on public.orders; drop function public.w2_fault_complete();`);
    const retry = run(`${OWNER_SESSION} select public.complete_order_with_fulfillment('${op}', '${order}'); reset role;`);
    assert.doesNotMatch(retry, /ERROR/);
    assert.equal(q1(`select status from public.orders where id = '${order}'`), "completed");
    assert.equal(q1(`select coalesce(sum(on_hand_delta),0) from public.finished_stock_movements where product_id = '${f.product}'`), "4");
    assert.equal(available(f.product), "4");
  });

  await t.test("public order submission never reserves stock: a freshly inserted 'new' order has zero allocations and zero effect on availability", () => {
    const f = makeProduct(10);
    const customer = makeCustomer();
    const order = makeOrder(customer, f.product, 6, 1); // mirrors what save_public_order_once ultimately persists: a 'new' order with lines, no RPC beyond insertion
    assert.equal(q1(`select status from public.orders where id = '${order}'`), "new");
    assert.equal(q1(`select count(*) from public.order_stock_allocations where order_id = '${order}'`), "0");
    assert.equal(available(f.product), "10", "a public/new order must not move available stock at all");
  });
});
