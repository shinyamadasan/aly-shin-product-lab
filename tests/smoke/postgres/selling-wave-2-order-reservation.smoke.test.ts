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
  // Wave 2's original fulfillment body, pinned so supabase-check-order-fulfillment-guard.sql can show
  // the live database still runs exactly this definition before the guard migration is applied.
  const wave2FulfillmentBodyMd5 = run(`select md5(prosrc) from pg_proc where oid = 'inventory_private.complete_order_with_fulfillment(uuid,uuid)'::regprocedure`).trim();
  // Every test below runs against the expected-state / lot-stock guard, so the Wave 2 cases double as
  // regression tests that the legacy two-argument entry point behaves as before.
  run(sql("supabase/migrations/20261027120000_order_fulfillment_expected_state_guard.sql"));

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

  // Product Lab MCP order_complete_apply/verify (scripts/product-lab/order-completion-service.ts) call
  // this RPC on an already-completed order: verify to read the receipt back, apply to replay a lost
  // response. That is only safe if, on a completed order, the RPC can replay its own receipt or
  // refuse -- never write -- for any operation id.
  await t.test("on a completed order, the completion RPC only replays its own receipt or refuses, and never writes", () => {
    const f = makeProduct(10);
    const customer = makeCustomer();
    const order = makeOrder(customer, f.product, 6, 1);
    run(`${OWNER_SESSION} select public.confirm_order_with_reservation('${crypto.randomUUID()}', '${order}'); reset role;`);
    const op = crypto.randomUUID();
    run(`${OWNER_SESSION} select public.complete_order_with_fulfillment('${op}', '${order}'); reset role;`);
    const movements = () => q1(`select count(*) from public.finished_stock_movements where order_id = '${order}'`);
    const before = { movements: movements(), updated: q1(`select updated_at from public.orders where id = '${order}'`) };

    const replay = run(`${OWNER_SESSION} select public.complete_order_with_fulfillment('${op}', '${order}')->>'status'; reset role;`);
    assert.match(replay, /completed/);

    const unused = crypto.randomUUID();
    // Acceptance raises (failing run() via ON_ERROR_STOP); the expected refusal returns quietly.
    const refused = run(`${OWNER_SESSION} do $$ begin
      begin
        perform public.complete_order_with_fulfillment('${unused}', '${order}');
      exception when check_violation then return; end;
      raise exception 'unused_op_unexpectedly_accepted';
    end $$; select 'refused_ok'; reset role;`);
    assert.match(refused, /refused_ok/);
    assert.equal(q1(`select count(*) from inventory_private.mutation_receipts where operation_id = '${unused}'`), "0", "a refused call leaves no receipt");
    assert.equal(movements(), before.movements, "no extra stock movement");
    assert.equal(q1(`select updated_at from public.orders where id = '${order}'`), before.updated, "the order row is not rewritten");
    assert.equal(q1(`select coalesce(sum(on_hand_delta),0) from public.finished_stock_movements where product_id = '${f.product}'`), "4");
  });

  // ------------------------------------------------------------------------------------------------
  // Order fulfillment expected-state / lot-stock guard (20261027120000).
  // ------------------------------------------------------------------------------------------------
  // The reviewed state the checked entry point compares under its lock: updated_at plus every payment
  // column, rendered as typed SQL literals (NULL where the column is NULL).
  const expectedOf = (order: string) => q1(`select concat_ws(', ',
      quote_nullable(updated_at) || '::timestamptz', quote_nullable(payment_status) || '::text',
      quote_nullable(payment_method) || '::text', quote_nullable(paid_at) || '::timestamptz',
      quote_nullable(paid_amount) || '::numeric', quote_nullable(refunded_at) || '::timestamptz')
    from public.orders where id = '${order}'`);
  const confirmed = (pieces: number, perUnit: number, quantity: number) => {
    const f = makeProduct(pieces);
    const order = makeOrder(makeCustomer(), f.product, perUnit, quantity);
    run(`${OWNER_SESSION} select public.confirm_order_with_reservation('${crypto.randomUUID()}', '${order}'); reset role;`);
    return { ...f, order, expected: expectedOf(order) };
  };
  const lotTotals = (execution: string) => q1(`select coalesce(sum(on_hand_delta),0) || '/' || coalesce(sum(reserved_delta),0) from public.finished_stock_movements where production_execution_id = '${execution}'`);
  const fulfillCount = (order: string) => q1(`select count(*) from public.finished_stock_movements where order_id = '${order}' and movement_type = 'fulfill'`);
  const receiptCount = (op: string) => q1(`select count(*) from inventory_private.mutation_receipts where operation_id = '${op}'`);
  // Out-of-band corruption of a lot: a stray partial deduction against the order's own allocation,
  // as legacy or hand-edited data could leave behind. Written as the table owner.
  const corruptLot = (f: { order: string; product: string; execution: string }, pieces: number) =>
    `insert into public.finished_stock_movements (product_id, production_execution_id, movement_type, on_hand_delta, reserved_delta, operation_id, order_id, order_stock_allocation_id, note)
      select '${f.product}', '${f.execution}', 'fulfill', -${pieces}, -${pieces}, gen_random_uuid(), '${f.order}', a.id, 'stray'
      from public.order_stock_allocations a where a.order_id = '${f.order}';`;
  const checkedCall = (op: string, order: string, expected: string) =>
    `public.complete_order_with_fulfillment_checked('${op}', '${order}', ${expected})`;
  const expectRefusal = (body: string, sqlstate: string, marker: string) =>
    `${OWNER_SESSION} do $$ begin
      begin
        perform ${body};
      exception when sqlstate '${sqlstate}' then return; end;
      raise exception '${marker}';
    end $$; select 'refused_ok'; reset role;`;

  await t.test("guard: the live-check pin matches Wave 2's fulfillment body and the legacy entry point keeps its signature and grants", () => {
    assert.equal(wave2FulfillmentBodyMd5, "f11078872e13ecc80cb6c0b571fdc11d");
    // The read-only preflight file runs cleanly (and now reports the guard as installed).
    assert.match(run(sql("supabase-check-order-fulfillment-guard.sql")), /^t\|/m);
    // Postflight: every check passes on the migrated database (after the Wave 2 cases, before any guard
    // test deliberately corrupts a lot).
    const postflight = run(sql("supabase-check-order-fulfillment-guard-postflight.sql")).trim().split("\n");
    assert.equal(postflight.length, 9, postflight.join("\n"));
    for (const row of postflight) assert.match(row, /\|t$/, row);
    assert.equal(q1(`select has_function_privilege('authenticated', 'public.complete_order_with_fulfillment(uuid,uuid)', 'execute')`), "t");
    assert.equal(q1(`select has_function_privilege('anon', 'public.complete_order_with_fulfillment_checked(uuid,uuid,timestamptz,text,text,timestamptz,numeric,timestamptz)', 'execute')`), "f");
    assert.equal(q1(`select has_function_privilege('authenticated', 'public.complete_order_with_fulfillment_checked(uuid,uuid,timestamptz,text,text,timestamptz,numeric,timestamptz)', 'execute')`), "t");
    assert.equal(q1(`select prosecdef from pg_proc where oid = 'public.complete_order_with_fulfillment_checked(uuid,uuid,timestamptz,text,text,timestamptz,numeric,timestamptz)'::regprocedure`), "f", "public wrapper stays security invoker");
  });

  await t.test("guard: a non-owner and an anonymous caller cannot use the checked entry point", () => {
    const f = confirmed(10, 6, 1);
    const asStaff = run(`set role authenticated;
      select set_config('request.jwt.claim.sub','88888888-8888-4888-8888-888888888888',false);
      select set_config('request.jwt.claim.app_role','staff',false);
      do $$ begin
        begin perform ${checkedCall(crypto.randomUUID(), f.order, f.expected)}; exception when insufficient_privilege then return; end;
        raise exception 'staff_unexpectedly_completed';
      end $$; select 'refused_ok'; reset role;`);
    assert.match(asStaff, /refused_ok/);
    assert.throws(() => run(`set role anon; select ${checkedCall(crypto.randomUUID(), f.order, f.expected)}; reset role;`), /permission denied/);
    assert.equal(fulfillCount(f.order), "0");
  });

  await t.test("guard: a missing expected version is refused rather than treated as unchecked", () => {
    const f = confirmed(10, 6, 1);
    const op = crypto.randomUUID();
    const unchecked = "null::timestamptz, null::text, null::text, null::timestamptz, null::numeric, null::timestamptz";
    assert.match(run(expectRefusal(`public.complete_order_with_fulfillment_checked('${op}', '${f.order}', ${unchecked})`, "22023", "null_expected_accepted")), /refused_ok/);
    assert.equal(fulfillCount(f.order), "0");
    assert.equal(receiptCount(op), "0");
  });

  await t.test("guard: a payment recorded after review makes the reviewed completion refuse with no write, and the re-reviewed one keeps the payment", () => {
    const f = confirmed(10, 6, 1);
    run(`${OWNER_SESSION} update public.orders set payment_status = 'paid', payment_method = 'cash', paid_at = now(), paid_amount = 100, updated_at = clock_timestamp() where id = '${f.order}'; reset role;`);
    const op = crypto.randomUUID();
    assert.match(run(expectRefusal(checkedCall(op, f.order, f.expected), "40001", "stale_review_accepted")), /refused_ok/);
    assert.equal(fulfillCount(f.order), "0");
    assert.equal(receiptCount(op), "0", "the refusal leaves the operation id unused");
    assert.equal(lotTotals(f.execution), "10/6");

    run(`${OWNER_SESSION} select ${checkedCall(crypto.randomUUID(), f.order, expectedOf(f.order))}; reset role;`);
    assert.equal(q1(`select status || '/' || payment_status || '/' || paid_amount from public.orders where id = '${f.order}'`), "completed/paid/100");
    assert.equal(lotTotals(f.execution), "4/0");
  });

  await t.test("guard: a payment written WITHOUT touching updated_at (e.g. a direct PATCH) is still a changed order", () => {
    const f = confirmed(10, 6, 1);
    const before = q1(`select updated_at from public.orders where id = '${f.order}'`);
    run(`${OWNER_SESSION} update public.orders set payment_status = 'paid', payment_method = 'gcash', paid_at = now(), paid_amount = 100 where id = '${f.order}'; reset role;`);
    assert.equal(q1(`select updated_at from public.orders where id = '${f.order}'`), before, "precondition: updated_at did not move");
    const op = crypto.randomUUID();
    assert.match(run(expectRefusal(checkedCall(op, f.order, f.expected), "40001", "unbumped_payment_accepted")), /refused_ok/);
    assert.equal(fulfillCount(f.order), "0");
    assert.equal(receiptCount(op), "0");
    // Each payment column on its own is enough to refuse. Start from a paid order (reviewed in that
    // state) so every single-column edit below is a real change that also satisfies the order checks.
    for (const column of ["payment_status = 'unpaid'", "payment_method = 'cash'", "paid_at = now() + interval '1 minute'", "paid_amount = 101", "refunded_at = now()"]) {
      const g = confirmed(10, 6, 1);
      run(`${OWNER_SESSION} update public.orders set payment_status = 'paid', payment_method = 'gcash', paid_at = now(), paid_amount = 100, updated_at = clock_timestamp() where id = '${g.order}'; reset role;`);
      g.expected = expectedOf(g.order);
      run(`${OWNER_SESSION} update public.orders set ${column} where id = '${g.order}'; reset role;`);
      assert.notEqual(expectedOf(g.order), g.expected, `precondition: ${column} changed the reviewed state`);
      assert.match(run(expectRefusal(checkedCall(crypto.randomUUID(), g.order, g.expected), "40001", `column_change_accepted_${column.split(" ")[0]}`)), /refused_ok/, column);
      assert.equal(fulfillCount(g.order), "0", column);
    }
  });

  await t.test("guard: a payment write racing the completion serializes on the order row; the completion sees the change and refuses", async () => {
    const f = confirmed(10, 6, 1);
    const payment = spawnPsqlAsync(`${owner()} update public.orders set payment_status = 'paid', paid_amount = 100, paid_at = now(), updated_at = clock_timestamp() where id = '${f.order}'; select pg_sleep(1.0); commit;`);
    await sleep(300);
    const op = crypto.randomUUID();
    const completion = spawnPsqlAsync(`${owner()} do $$ begin
      begin perform ${checkedCall(op, f.order, f.expected)}; exception when sqlstate '40001' then raise notice 'completion_refused_stale'; return; end;
      raise notice 'completion_unexpectedly_applied';
    end $$; commit;`);
    const [rp, rc] = await Promise.all([payment, completion]);
    assert.doesNotMatch(rp.stdout, /ERROR/);
    assert.match(rc.stdout, /completion_refused_stale/);
    assert.equal(q1(`select status || '/' || payment_status from public.orders where id = '${f.order}'`), "confirmed/paid");
    assert.equal(fulfillCount(f.order), "0");
    assert.equal(receiptCount(op), "0");
  });

  await t.test("guard: a lot that lost reserved pieces is refused through BOTH entry points, before any negative balance is written", () => {
    const f = confirmed(10, 6, 1);
    run(corruptLot(f, 3)); // lot now 7 on hand / 3 reserved; the order still holds a 6-piece reservation
    for (const body of [
      `public.complete_order_with_fulfillment('${crypto.randomUUID()}', '${f.order}')`,
      checkedCall(crypto.randomUUID(), f.order, f.expected),
    ]) {
      assert.match(run(expectRefusal(body, "23514", "negative_lot_accepted")), /refused_ok/);
    }
    assert.equal(lotTotals(f.execution), "7/3", "no fulfil movement was written");
    assert.equal(q1(`select status from public.orders where id = '${f.order}'`), "confirmed");
    assert.equal(q1(`select status from public.order_stock_allocations where order_id = '${f.order}'`), "active");
  });

  await t.test("guard: an out-of-band stock write racing the completion is serialized by the product lock alone, and the completion refuses instead of going negative", async () => {
    const f = makeProduct(10);
    const customer = makeCustomer();
    const target = makeOrder(customer, f.product, 6, 1);
    const other = makeOrder(customer, f.product, 4, 1);
    for (const order of [target, other]) run(`${OWNER_SESSION} select public.confirm_order_with_reservation('${crypto.randomUUID()}', '${order}'); reset role;`);
    assert.equal(lotTotals(f.execution), "10/10");
    const expected = expectedOf(target);
    // The writer holds products then lots (the order every stock writer takes) and corrupts the lot via
    // the OTHER order's allocation: 7 more pieces than that reservation, leaving 3/3 for a 6-piece need.
    // Its FK checks lock the other order's row, so only the product/lot locks can make the completion wait.
    const writer = spawnPsqlAsync(`begin; select id from public.products where id = '${f.product}' for update;
      select id from public.production_executions where product_id = '${f.product}' for update;
      ${corruptLot({ order: other, product: f.product, execution: f.execution }, 7)} select pg_sleep(1.0); commit;`);
    await sleep(300);
    const op = crypto.randomUUID();
    const completion = spawnPsqlAsync(`${owner()} do $$ begin
      begin perform ${checkedCall(op, target, expected)}; exception when check_violation then raise notice 'completion_refused_short'; return; end;
      raise notice 'completion_unexpectedly_applied';
    end $$; commit;`);
    const [rw, rc] = await Promise.all([writer, completion]);
    assert.doesNotMatch(rw.stdout, /ERROR/);
    assert.match(rc.stdout, /completion_refused_short/);
    assert.equal(lotTotals(f.execution), "3/3");
    assert.equal(fulfillCount(target), "0");
    assert.equal(receiptCount(op), "0");
  });

  await t.test("guard: two owners completing the same order with different operation ids concurrently fulfil exactly once", async () => {
    const f = confirmed(10, 6, 1);
    const opA = crypto.randomUUID(); const opB = crypto.randomUUID();
    const body = (op: string) => `${owner()} do $$ begin
      begin perform ${checkedCall(op, f.order, f.expected)}; exception when check_violation or serialization_failure then raise notice 'lost_${op.slice(0, 8)}'; return; end;
      raise notice 'won_${op.slice(0, 8)}';
    end $$; commit;`;
    const [ra, rb] = await Promise.all([spawnPsqlAsync(body(opA)), spawnPsqlAsync(body(opB))]);
    const won = [ra.stdout, rb.stdout].filter((out) => /won_/.test(out)).length;
    assert.equal(won, 1, `exactly one completion must win: ${ra.stdout} | ${rb.stdout}`);
    assert.equal(fulfillCount(f.order), "1");
    assert.equal(lotTotals(f.execution), "4/0");
    assert.equal(Number(receiptCount(opA)) + Number(receiptCount(opB)), 1, "only the winner keeps a receipt");
  });

  // The second call normally waits on the first's receipt row and then replays; in_flight is accepted
  // only as the documented 55P03 outcome. The ledger assertions are what this test proves.
  await t.test("guard: the same operation id submitted twice concurrently fulfils once; the other call replays or is told it is in flight", async () => {
    const f = confirmed(10, 6, 1);
    const op = crypto.randomUUID();
    const body = `${owner()} do $$ begin
      begin perform ${checkedCall(op, f.order, f.expected)}; exception when sqlstate '55P03' then raise notice 'in_flight'; return; end;
      raise notice 'returned_result';
    end $$; commit;`;
    const [ra, rb] = await Promise.all([spawnPsqlAsync(body), spawnPsqlAsync(body)]);
    for (const out of [ra.stdout, rb.stdout]) assert.match(out, /returned_result|in_flight/);
    assert.doesNotMatch(`${ra.stdout}${rb.stdout}`, /ERROR/);
    assert.equal(fulfillCount(f.order), "1");
    assert.equal(lotTotals(f.execution), "4/0");
  });

  await t.test("guard: retries -- exact replay with a stale version returns the receipt; a new operation id is refused; receipts are shared with the legacy entry point", () => {
    const f = confirmed(10, 6, 1);
    const op = crypto.randomUUID();
    run(`${OWNER_SESSION} select ${checkedCall(op, f.order, f.expected)}; reset role;`);
    // The order's updated_at moved with completion, so f.expected is now stale; a replay ignores it.
    assert.match(run(`${OWNER_SESSION} select ${checkedCall(op, f.order, f.expected)}->>'status'; reset role;`), /completed/);
    assert.match(run(`${OWNER_SESSION} select public.complete_order_with_fulfillment('${op}', '${f.order}')->>'status'; reset role;`), /completed/);
    const fresh = crypto.randomUUID();
    assert.match(run(expectRefusal(checkedCall(fresh, f.order, expectedOf(f.order)), "23514", "second_completion_accepted")), /refused_ok/);
    assert.equal(receiptCount(fresh), "0");
    assert.equal(fulfillCount(f.order), "1");
    assert.equal(lotTotals(f.execution), "4/0");

    // A legacy-entry receipt replays through the checked entry point too.
    const g = confirmed(10, 6, 1);
    const legacyOp = crypto.randomUUID();
    run(`${OWNER_SESSION} select public.complete_order_with_fulfillment('${legacyOp}', '${g.order}'); reset role;`);
    assert.match(run(`${OWNER_SESSION} select ${checkedCall(legacyOp, g.order, g.expected)}->>'status'; reset role;`), /completed/);
    assert.equal(fulfillCount(g.order), "1");
  });

  await t.test("guard: completing an order that shares a lot with another reservation leaves the other reservation intact", () => {
    const f = makeProduct(10);
    const customer = makeCustomer();
    const first = makeOrder(customer, f.product, 6, 1);
    const second = makeOrder(customer, f.product, 4, 1);
    for (const order of [first, second]) run(`${OWNER_SESSION} select public.confirm_order_with_reservation('${crypto.randomUUID()}', '${order}'); reset role;`);
    assert.equal(lotTotals(f.execution), "10/10");
    run(`${OWNER_SESSION} select ${checkedCall(crypto.randomUUID(), first, expectedOf(first))}; reset role;`);
    assert.equal(lotTotals(f.execution), "4/4");
    run(`${OWNER_SESSION} select public.complete_order_with_fulfillment('${crypto.randomUUID()}', '${second}'); reset role;`);
    assert.equal(lotTotals(f.execution), "0/0");
  });

  await t.test("public order submission never reserves stock: a freshly inserted 'new' order has zero allocations and zero effect on availability", () => {
    const f = makeProduct(10);
    const customer = makeCustomer();
    const order = makeOrder(customer, f.product, 6, 1); // mirrors what save_public_order_once ultimately persists: a 'new' order with lines, no RPC beyond insertion
    assert.equal(q1(`select status from public.orders where id = '${order}'`), "new");
    assert.equal(q1(`select count(*) from public.order_stock_allocations where order_id = '${order}'`), "0");
    assert.equal(available(f.product), "10", "a public/new order must not move available stock at all");
  });

  // Executes the guard migration's documented ROLLBACK exactly as written in its header, then re-applies it.
  // Runs last because it removes the guard the earlier subtests rely on.
  await t.test("guard rollback: the documented steps restore Wave 2's exact fulfillment body and grants, and the guard re-applies cleanly", () => {
    const wave2 = sql("supabase/migrations/20260910181827_selling_wave_2_order_reservation.sql");
    const start = wave2.indexOf("-- 7. complete_order_with_fulfillment");
    const end = wave2.indexOf("notify pgrst, 'reload schema';", start);
    assert.ok(start > 0 && end > start, "section 7 located");
    const section7 = wave2.slice(start, end);
    const guard = sql("supabase/migrations/20261027120000_order_fulfillment_expected_state_guard.sql");
    const dropPattern = /^--\s+(?:\d+\.\s+)?(drop function .*complete_order_with_fulfillment_checked.*)$/;
    const dropLines = guard.split("\n").map((line) => dropPattern.exec(line)?.[1]).filter((line): line is string => Boolean(line));
    assert.equal(dropLines.length, 2, "header names both drops");

    run(section7);
    run(`${dropLines.join("\n")}\nnotify pgrst, 'reload schema';`);
    assert.equal(q1(`select md5(prosrc) from pg_proc where oid = 'inventory_private.complete_order_with_fulfillment(uuid,uuid)'::regprocedure`), wave2FulfillmentBodyMd5, "exact Wave 2 body restored");
    assert.equal(q1(`select count(*) from pg_proc where proname = 'complete_order_with_fulfillment_checked'`), "0");
    assert.equal(q1(`select has_function_privilege('authenticated', 'public.complete_order_with_fulfillment(uuid,uuid)', 'execute')`), "t");
    const f = confirmed(10, 6, 1);
    assert.match(run(`${OWNER_SESSION} select public.complete_order_with_fulfillment('${crypto.randomUUID()}', '${f.order}')->>'status'; reset role;`), /completed/, "web completion works after rollback");

    run(guard);
    const g = confirmed(10, 6, 1);
    assert.match(run(`${OWNER_SESSION} select ${checkedCall(crypto.randomUUID(), g.order, g.expected)}->>'status'; reset role;`), /completed/, "re-applied guard works");
  });
});
