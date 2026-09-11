import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const root = path.resolve(import.meta.dirname, "../../..");
const sql = (file: string) => readFileSync(path.join(root, file), "utf8");
// Transaction-local (is_local = true): for the spawnPsqlAsync concurrency helpers, which wrap
// everything in one begin;...commit;. Matches tests/smoke/postgres/selling-wave-2-order-reservation.smoke.test.ts.
const OWNER_JWT = `select set_config('request.jwt.claim.sub','88888888-8888-4888-8888-888888888888',true);
  select set_config('request.jwt.claim.app_role','owner',true);
  select set_config('request.jwt.claims','{"sub":"88888888-8888-4888-8888-888888888888","role":"authenticated","app_metadata":{"app_role":"owner"}}',true);`;
// Session-scoped (is_local = false): for run() calls, which execute each statement in its own
// autocommit transaction -- a transaction-local setting would not survive to the next statement.
const OWNER_SESSION = `set role authenticated;
  select set_config('request.jwt.claim.sub','88888888-8888-4888-8888-888888888888',false);
  select set_config('request.jwt.claim.app_role','owner',false);
  select set_config('request.jwt.claims','{"sub":"88888888-8888-4888-8888-888888888888","role":"authenticated","app_metadata":{"app_role":"owner"}}',false);`;

test("Wave 3 finished-stock exceptions and raw COGS: damage/giveaway/correction protect reservations, FIFO stays lot-coherent under concurrency, exceptions roll back atomically", { skip: process.env.RUN_POSTGRES_SMOKE !== "1" }, async (t) => {
  const container = `aly-wave3-${Date.now()}`;
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

  // Base environment + Wave 0A/0B/1/2 dependencies, same shape as the Wave 2 smoke harness.
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
  // Minimal products / product_batches -- only the columns Wave 1/2/3 read and write.
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
  run(sql("supabase/migrations/20260911103433_selling_wave_3_finished_stock_exceptions_and_cogs.sql"));

  await t.test("single-shot invariants: damage/giveaway/correction, FIFO reservation protection, insufficient-across-lots rejection, positive correction uniformly rejected, cost conservation, idempotency, multi-lot COGS, historical immutability, authority, constraint shapes", () => {
    const result = run(sql("tests/smoke/postgres/selling-wave-3-exceptions-cogs.assertions.sql"));
    assert.match(result, /wave_3_assertions_passed/);
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
  function makeSecondLot(product: string, pieces: number, completedAtExpr = "now()"): { batch: string; execution: string } {
    const batch = crypto.randomUUID();
    const execution = crypto.randomUUID();
    run(`insert into public.product_batches (id, product_id, batch_version, status, usable_pieces) values ('${batch}', '${product}', 'v2', 'completed', ${pieces});
      insert into public.production_executions (id, product_id, product_batch_id, batch_version_snapshot, operation_id, multiplier, quantity_produced_pieces, expected_pieces, frozen_ingredient_cost_total, frozen_cost_per_piece, completed_at)
        values ('${execution}', '${product}', '${batch}', 'v2', '${crypto.randomUUID()}', 1, ${pieces}, ${pieces}, ${pieces * 10}, 10, ${completedAtExpr});
      insert into public.finished_stock_movements (product_id, production_execution_id, movement_type, on_hand_delta, reserved_delta, operation_id, note)
        values ('${product}', '${execution}', 'production_receipt', ${pieces}, 0, '${crypto.randomUUID()}', 'seed 2');`);
    return { batch, execution };
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
  const owner = (extra = "") => `begin; set local role authenticated; ${OWNER_JWT} ${extra}`;
  const q1 = (s: string) => run(s).trim();
  const onHand = (product: string) => Number(q1(`select coalesce(sum(on_hand_delta),0) from public.finished_stock_movements where product_id = '${product}'`));
  const reserved = (product: string) => Number(q1(`select coalesce(sum(reserved_delta),0) from public.finished_stock_movements where product_id = '${product}'`));

  await t.test("damage races a concurrent order reservation on the same product: exactly one wins, reserved never exceeds on_hand", async () => {
    // Spec section 13's exact numbers: available 6, reservation needs 4, damage wants 4 -- 4+4=8
    // cannot both succeed against 6.
    const f = makeProduct(6);
    const customer = makeCustomer();
    const order = makeOrder(customer, f.product, 4, 1);
    const opDamage = crypto.randomUUID(); const opReserve = crypto.randomUUID();
    const damageCall = spawnPsqlAsync(`${owner(`select pg_sleep(0.3);`)} do $$ begin
      perform public.record_finished_stock_exception('${opDamage}', '${f.product}', 'damage', -4, null, 'race test');
      raise notice 'damage_landed';
    exception when check_violation then raise notice 'damage_rejected'; end $$; commit;`);
    const reserveCall = spawnPsqlAsync(`${owner(`select pg_sleep(0.3);`)} do $$ begin
      perform public.confirm_order_with_reservation('${opReserve}', '${order}');
      raise notice 'reserve_landed';
    exception when check_violation then raise notice 'reserve_rejected'; end $$; commit;`);
    const [rd, rr] = await Promise.all([damageCall, reserveCall]);
    assert.doesNotMatch(rd.stdout, /ERROR/);
    assert.doesNotMatch(rr.stdout, /ERROR/);

    const damageWon = /damage_landed/.test(rd.stdout);
    const reserveWon = /reserve_landed/.test(rr.stdout);
    // Exactly one of the two contending 4-piece claims may land against 6 available -- both landing
    // would require 8, which is impossible; both rejecting is impossible because the first to lock
    // the product row always sees the full 6 and succeeds.
    assert.ok(damageWon !== reserveWon, `exactly one of damage/reserve must win, got damageWon=${damageWon} reserveWon=${reserveWon}`);
    assert.ok(reserved(f.product) <= onHand(f.product), "reserved must never exceed on_hand");
    if (damageWon) {
      assert.equal(onHand(f.product), 2, "damage(4) applied, reservation rejected: on_hand must be 2");
      assert.equal(reserved(f.product), 0);
    } else {
      assert.equal(onHand(f.product), 6, "reservation applied, damage rejected: on_hand untouched");
      assert.equal(reserved(f.product), 4);
    }
  });

  await t.test("two exceptions racing the same product: exactly one lands when combined demand exceeds availability", async () => {
    // Spec section 14's exact numbers: available 5, damage wants 4, giveaway wants 4.
    const f = makeProduct(5);
    const opDamage = crypto.randomUUID(); const opGiveaway = crypto.randomUUID();
    const damageCall = spawnPsqlAsync(`${owner(`select pg_sleep(0.3);`)} do $$ begin
      perform public.record_finished_stock_exception('${opDamage}', '${f.product}', 'damage', -4, null, 'race A');
      raise notice 'damage_landed';
    exception when check_violation then raise notice 'damage_rejected'; end $$; commit;`);
    const giveawayCall = spawnPsqlAsync(`${owner(`select pg_sleep(0.3);`)} do $$ begin
      perform public.record_finished_stock_exception('${opGiveaway}', '${f.product}', 'giveaway', -4, null, 'race B');
      raise notice 'giveaway_landed';
    exception when check_violation then raise notice 'giveaway_rejected'; end $$; commit;`);
    const [rd, rg] = await Promise.all([damageCall, giveawayCall]);
    assert.doesNotMatch(rd.stdout, /ERROR/);
    assert.doesNotMatch(rg.stdout, /ERROR/);
    const damageWon = /damage_landed/.test(rd.stdout);
    const giveawayWon = /giveaway_landed/.test(rg.stdout);
    assert.ok(damageWon !== giveawayWon, `exactly one of damage/giveaway must win, got damageWon=${damageWon} giveawayWon=${giveawayWon}`);
    assert.equal(onHand(f.product), 1, "5 - 4 = 1, regardless of which exception won");
    assert.ok(onHand(f.product) >= 0, "on_hand must never go negative");
  });

  await t.test("damage races a brand-new production Bake receipt on the same product: coherent result either way, never negative", async () => {
    const f = makeProduct(2); // exactly enough for the damage alone, before any new receipt lands
    const opDamage = crypto.randomUUID();
    const opBake = crypto.randomUUID();
    const damageCall = spawnPsqlAsync(`${owner(`select pg_sleep(0.3);`)} do $$ begin
      perform public.record_finished_stock_exception('${opDamage}', '${f.product}', 'damage', -5, null, 'race vs bake');
      raise notice 'damage_landed';
    exception when check_violation then raise notice 'damage_rejected_insufficient'; end $$; commit;`);
    // POST-REVIEW CORRECTION: this does NOT run lock-free against the exception. Inserting a new
    // production_executions row (product_id references products(id)) makes Postgres's own FK
    // enforcement acquire a FOR KEY SHARE lock on that SAME products row the exception holds FOR
    // UPDATE -- and FOR UPDATE conflicts with FOR KEY SHARE. The two genuinely serialize on the
    // products row; whichever call's lock request is granted first commits first, and the other
    // proceeds against that committed state. Both resulting interleavings are still coherent
    // (asserted below) -- serialization decides ORDER, not which one is allowed to succeed.
    // Inserted directly as the table owner (bypassing confirm_bake_v3, proven elsewhere), the
    // faithful equivalent of a security-definer function running with owner privileges.
    const bakeCall = spawnPsqlAsync(`begin;
      insert into public.production_executions (id, product_id, product_batch_id, batch_version_snapshot, operation_id, multiplier, quantity_produced_pieces, expected_pieces, frozen_ingredient_cost_total, frozen_cost_per_piece, completed_at)
        values (gen_random_uuid(), '${f.product}', '${f.batch}', 'v1', '${opBake}', 1, 8, 8, 80, 10, now());
      insert into public.finished_stock_movements (product_id, production_execution_id, movement_type, on_hand_delta, reserved_delta, operation_id, note)
        select '${f.product}', id, 'production_receipt', 8, 0, '${opBake}', 'race bake' from public.production_executions where operation_id = '${opBake}';
      commit;`);
    const [rd, rb] = await Promise.all([damageCall, bakeCall]);
    assert.match(rd.stdout, /damage_landed|damage_rejected_insufficient/);
    assert.doesNotMatch(rb.stdout, /ERROR/);
    const damageLanded = /damage_landed/.test(rd.stdout);
    const expected = 2 + 8 - (damageLanded ? 5 : 0); // either 10 (damage rejected first) or 5 (bake landed first, damage then succeeded)
    assert.ok(expected === 5 || expected === 10, `internal test error computing expectation: ${expected}`);
    assert.equal(onHand(f.product), expected, `on_hand must be exactly ${expected} for this interleaving`);
    assert.ok(onHand(f.product) >= 0, "on_hand must never go negative");
  });

  // Fault injection: a trigger on inventory_private.mutation_receipts raises when the RPC tries
  // to store its final result -- by then every finished_stock_movements row the exception was
  // going to write (potentially several, for a multi-lot draw) has already been inserted in the
  // SAME transaction. Everything must roll back together, and the operation id stays retryable.
  await t.test("fault injection during a multi-lot damage, after both lot movements are written but before the receipt is stored: full rollback, operation id retryable", () => {
    const f = makeProduct(2, "now() - interval '1 day'"); // older lot, 2 unreserved
    const second = makeSecondLot(f.product, 5, "now()"); // newer lot, 5 unreserved
    const op = crypto.randomUUID();
    run(`create function public.w3_fault_exception() returns trigger language plpgsql as $fn$ begin raise exception 'injected'; end $fn$;
      create trigger w3_fault_trg before update on inventory_private.mutation_receipts for each row execute function public.w3_fault_exception();`);
    const attempt = run(`${OWNER_SESSION}
      do $$ begin
        perform public.record_finished_stock_exception('${op}', '${f.product}', 'damage', -4, null, 'fault test');
      exception when others then null; end $$;
      select 'attempt_done'; reset role;`);
    assert.match(attempt, /attempt_done/);
    // Nothing persisted: neither lot's movement, no stuck claim.
    assert.equal(q1(`select count(*) from public.finished_stock_movements where product_id = '${f.product}' and movement_type = 'damage'`), "0", "neither of the two lot movements may survive a rolled-back multi-lot exception");
    assert.equal(onHand(f.product), 7, "2 + 5 = 7, fully unchanged");
    assert.equal(q1(`select count(*) from inventory_private.mutation_receipts where operation_id = '${op}'`), "0", "failed attempt left no stuck claim");
    run(`drop trigger w3_fault_trg on inventory_private.mutation_receipts; drop function public.w3_fault_exception();`);
    const retry = run(`${OWNER_SESSION} select public.record_finished_stock_exception('${op}', '${f.product}', 'damage', -4, null, 'fault test'); reset role;`);
    assert.doesNotMatch(retry, /ERROR/);
    assert.equal(onHand(f.product), 3, "7 - 4 = 3 after the clean retry");
    // FIFO must still have drawn oldest-first on the retry: 2 from the older lot, 2 from the newer.
    assert.equal(q1(`select coalesce(sum(-on_hand_delta),0) from public.finished_stock_movements where production_execution_id = '${f.execution}' and movement_type = 'damage'`), "2");
    assert.equal(q1(`select coalesce(sum(-on_hand_delta),0) from public.finished_stock_movements where production_execution_id = '${second.execution}' and movement_type = 'damage'`), "2");
  });

  // POST-REVIEW FIX: positive correction has no write path left to fault-inject (it is rejected
  // before any lock or claim, let alone a write) -- the single-shot suite already proves the
  // rejection itself, the retry-safety of its operation id, and (via direct CHECK-constraint
  // insertion) that even a future writer bypassing the RPC could not persist one. What real
  // concurrency CAN still prove here is that a rejected positive attempt holds no lock and leaves
  // no residue that could interfere with a genuinely valid, concurrent operation on the same
  // product -- proven directly below rather than asserted from reading the function body.
  await t.test("a rejected positive correction attempt never blocks or corrupts a concurrent, valid damage on the same product", async () => {
    const f = makeProduct(5);
    const opRejected = crypto.randomUUID();
    const opDamage = crypto.randomUUID();
    const rejectedCall = spawnPsqlAsync(`${owner()} do $$ begin
      perform public.record_finished_stock_exception('${opRejected}', '${f.product}', 'correction', 3, '${f.execution}', 'found more -- must be rejected');
      raise notice 'unexpectedly_accepted';
    exception when others then raise notice 'rejected_as_expected'; end $$; commit;`);
    const damageCall = spawnPsqlAsync(`${owner()} select public.record_finished_stock_exception('${opDamage}', '${f.product}', 'damage', -3, null, 'a real, valid, concurrent damage'); commit;`);
    const [rr, rd] = await Promise.all([rejectedCall, damageCall]);
    assert.match(rr.stdout, /rejected_as_expected/);
    assert.doesNotMatch(rr.stdout, /unexpectedly_accepted/);
    assert.doesNotMatch(rd.stdout, /ERROR/);
    assert.equal(onHand(f.product), 2, "5 - 3 = 2: the valid concurrent damage must land untouched by the rejected positive attempt racing it");
    assert.equal(q1(`select count(*) from public.finished_stock_movements where product_id = '${f.product}' and movement_type = 'correction'`), "0", "the rejected positive correction must have written nothing");
  });
});
