import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const root = path.resolve(import.meta.dirname, "../../..");
const sql = (file: string) => readFileSync(path.join(root, file), "utf8");
// Transaction-local: for the spawnPsqlAsync concurrency helpers (one begin;...commit; each).
const OWNER_JWT = `select set_config('request.jwt.claim.sub','99999999-9999-4999-8999-999999999999',true);
  select set_config('request.jwt.claim.app_role','owner',true);
  select set_config('request.jwt.claims','{"sub":"99999999-9999-4999-8999-999999999999","role":"authenticated","app_metadata":{"app_role":"owner"}}',true);`;
// Session-scoped: for run() calls, which execute each statement in its own autocommit transaction.
const OWNER_SESSION = `set role authenticated;
  select set_config('request.jwt.claim.sub','99999999-9999-4999-8999-999999999999',false);
  select set_config('request.jwt.claim.app_role','owner',false);
  select set_config('request.jwt.claims','{"sub":"99999999-9999-4999-8999-999999999999","role":"authenticated","app_metadata":{"app_role":"owner"}}',false);`;

test("TASK-072 Correct Bake: atomic, idempotent, lot-safe correction of a real Bake's actual count under concurrency and fault injection", { skip: process.env.RUN_POSTGRES_SMOKE !== "1" }, async (t) => {
  const container = `aly-t072-${Date.now()}`;
  execFileSync("docker", ["run", "-d", "--name", container, "-e", "POSTGRES_PASSWORD=test-only", "postgres:17-alpine"], { stdio: "pipe" });
  t.after(() => execFileSync("docker", ["rm", "-f", container], { stdio: "pipe" }));
  const run = (input: string) => execFileSync("docker", ["exec", "-i", container, "psql", "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-tA"], { input, encoding: "utf8", stdio: "pipe" });
  let ready = false;
  for (let attempt = 0; attempt < 90; attempt++) {
    try { if (run("select 1").trim() === "1") { ready = true; break; } } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  assert.ok(ready, "PostgreSQL must start; an unavailable database is not a passing test");
  await new Promise((resolve) => setTimeout(resolve, 500));

  // Same dependency chain as tests/smoke/postgres/finished-stock-opening-balance.smoke.test.ts
  // (Wave 0A/0B/1/2/3 + opening balance), then this task's migration.
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
  run(`create table public.selling_formats (id uuid primary key default gen_random_uuid());
    alter table public.selling_formats enable row level security;`);
  run(sql("supabase-add-orders.sql"));
  run(sql("supabase/migrations/20260910181827_selling_wave_2_order_reservation.sql"));
  run(sql("supabase/migrations/20260911103433_selling_wave_3_finished_stock_exceptions_and_cogs.sql"));
  run(`create table public.costing_summaries (
      id uuid primary key default gen_random_uuid(), product_id text not null references public.products(id),
      batch_id uuid references public.product_batches(id), ingredient_cost numeric not null default 0);
    alter table public.costing_summaries enable row level security;
    grant select, insert, update, delete on public.costing_summaries to authenticated;
    create policy p_costings on public.costing_summaries for all to authenticated using (public.is_product_lab_owner()) with check (public.is_product_lab_owner());`);
  run(sql("supabase/migrations/20260923130000_finished_stock_opening_balance.sql"));
  run(sql("supabase/migrations/20260924120000_bake_actual_correction.sql"));

  await t.test("single-shot invariants: up/down correction, expected historical, frozen total unchanged, cost recompute, append-only ledger + audit, per-lot decrease safety, atomic rejection, idempotent replay, changed-payload rejection, opening balance excluded, validation, authority, COGS/reservation consistency", () => {
    const result = run(sql("tests/smoke/postgres/bake-actual-correction.assertions.sql"));
    assert.match(result, /bake_actual_correction_assertions_passed/);
  });

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

  // A real Bake: expected 12, operator typed `actual`, frozen raw cost total 120.
  function makeBake(actual: number): { product: string; batch: string; execution: string } {
    const product = `p-${crypto.randomUUID().slice(0, 8)}`;
    const batch = crypto.randomUUID();
    const execution = crypto.randomUUID();
    run(`insert into public.products (id, name) values ('${product}', 'Test ${product}');
      insert into public.product_batches (id, product_id, batch_version, status, usable_pieces) values ('${batch}', '${product}', 'v1', 'completed', 12);
      insert into public.production_executions (id, product_id, product_batch_id, batch_version_snapshot, operation_id, multiplier, quantity_produced_pieces, expected_pieces, frozen_ingredient_cost_total, frozen_cost_per_piece, completed_at)
        values ('${execution}', '${product}', '${batch}', 'v1', '${crypto.randomUUID()}', 1, ${actual}, 12, 120, 120.0/${actual}, now());
      insert into public.finished_stock_movements (product_id, production_execution_id, movement_type, on_hand_delta, reserved_delta, operation_id, note)
        values ('${product}', '${execution}', 'production_receipt', ${actual}, 0, '${crypto.randomUUID()}', 'seed');`);
    return { product, batch, execution };
  }
  const onHand = (product: string) => Number(q1(`select coalesce(sum(on_hand_delta),0) from public.finished_stock_movements where product_id = '${product}'`));
  const reserved = (product: string) => Number(q1(`select coalesce(sum(reserved_delta),0) from public.finished_stock_movements where product_id = '${product}'`));
  const actualOf = (execution: string) => Number(q1(`select quantity_produced_pieces from public.production_executions where id = '${execution}'`));
  const auditCount = (execution: string) => Number(q1(`select count(*) from public.production_execution_corrections where production_execution_id = '${execution}'`));

  await t.test("two tabs correcting the same Bake from the same recorded actual: exactly one lands, the other is told to reload (stale guard)", async () => {
    const f = makeBake(10);
    const opA = crypto.randomUUID();
    const opB = crypto.randomUUID();
    const call = (op: string, corrected: number, tag: string) => spawnPsqlAsync(`${owner(`select pg_sleep(0.3);`)} do $$ begin
      perform public.correct_bake_actual_pieces('${op}', '${f.execution}', 10, ${corrected}, 'tab ${tag}');
      raise notice '${tag}_landed';
    exception when serialization_failure then raise notice '${tag}_stale'; end $$; commit;`);
    const [ra, rb] = await Promise.all([call(opA, 12, "A"), call(opB, 11, "B")]);
    assert.doesNotMatch(ra.stdout, /ERROR/);
    assert.doesNotMatch(rb.stdout, /ERROR/);
    const aWon = /A_landed/.test(ra.stdout);
    const bWon = /B_landed/.test(rb.stdout);
    assert.ok(aWon !== bWon, `exactly one tab must win, got A=${aWon} B=${bWon}`);
    assert.equal(actualOf(f.execution), aWon ? 12 : 11);
    assert.equal(onHand(f.product), aWon ? 12 : 11, "finished stock follows exactly the one winning correction");
    assert.equal(auditCount(f.execution), 1, "exactly one audit row");
  });

  await t.test("a downward correction races a concurrent order reservation on the same lot: exactly one wins and reserved never exceeds on_hand", async () => {
    // Lot of 10, nothing reserved. Lowering to 4 removes 6; the order wants 8. 6 + 8 > 10, so only one may land.
    const f = makeBake(10);
    const customer = crypto.randomUUID();
    const order = crypto.randomUUID();
    run(`insert into public.customers (id, name) values ('${customer}', 'T072 Customer');
      insert into public.orders (id, customer_id, status) values ('${order}', '${customer}', 'new');
      insert into public.order_lines (id, order_id, product_id, item_name, unit_price, pieces_per_unit_snapshot, quantity)
        values ('${crypto.randomUUID()}', '${order}', '${f.product}', 'Line', 100, 8, 1);`);
    const opFix = crypto.randomUUID();
    const opReserve = crypto.randomUUID();
    const fixCall = spawnPsqlAsync(`${owner(`select pg_sleep(0.3);`)} do $$ begin
      perform public.correct_bake_actual_pieces('${opFix}', '${f.execution}', 10, 4, 'race vs reservation');
      raise notice 'fix_landed';
    exception when check_violation then raise notice 'fix_rejected'; end $$; commit;`);
    const reserveCall = spawnPsqlAsync(`${owner(`select pg_sleep(0.3);`)} do $$ begin
      perform public.confirm_order_with_reservation('${opReserve}', '${order}');
      raise notice 'reserve_landed';
    exception when check_violation then raise notice 'reserve_rejected'; end $$; commit;`);
    const [rf, rr] = await Promise.all([fixCall, reserveCall]);
    assert.doesNotMatch(rf.stdout, /ERROR/);
    assert.doesNotMatch(rr.stdout, /ERROR/);
    const fixWon = /fix_landed/.test(rf.stdout);
    const reserveWon = /reserve_landed/.test(rr.stdout);
    assert.ok(fixWon !== reserveWon, `exactly one must win, got fix=${fixWon} reserve=${reserveWon}`);
    assert.ok(reserved(f.product) <= onHand(f.product), "reserved must never exceed on_hand");
    if (fixWon) {
      assert.equal(actualOf(f.execution), 4);
      assert.equal(onHand(f.product), 4);
      assert.equal(reserved(f.product), 0);
    } else {
      assert.equal(actualOf(f.execution), 10);
      assert.equal(onHand(f.product), 10);
      assert.equal(reserved(f.product), 8);
      assert.equal(auditCount(f.execution), 0);
    }
  });

  // Fault injection: a trigger on mutation_receipts raises when the function tries to store its
  // final result -- by then the lot update, the ledger movement and the audit row have all been
  // written in the SAME transaction. Everything must roll back together; the operation id stays retryable.
  await t.test("fault injection after every write but before the receipt is stored: full rollback, no stuck claim, clean retry", () => {
    const f = makeBake(10);
    const op = crypto.randomUUID();
    run(`create function public.t072_fault() returns trigger language plpgsql as $fn$ begin raise exception 'injected'; end $fn$;
      create trigger t072_fault_trg before update on inventory_private.mutation_receipts for each row execute function public.t072_fault();`);
    const attempt = run(`${OWNER_SESSION}
      do $$ begin
        perform public.correct_bake_actual_pieces('${op}', '${f.execution}', 10, 12, 'fault test');
      exception when others then null; end $$;
      select 'attempt_done'; reset role;`);
    assert.match(attempt, /attempt_done/);
    assert.equal(actualOf(f.execution), 10, "lot actual rolled back");
    assert.equal(Number(q1(`select frozen_cost_per_piece from public.production_executions where id = '${f.execution}'`)), 12, "cost per piece rolled back");
    assert.equal(onHand(f.product), 10, "ledger rolled back");
    assert.equal(q1(`select count(*) from public.finished_stock_movements where production_execution_id = '${f.execution}' and movement_type = 'bake_correction'`), "0");
    assert.equal(auditCount(f.execution), 0, "no audit row survives a rolled-back correction");
    assert.equal(q1(`select count(*) from inventory_private.mutation_receipts where operation_id = '${op}'`), "0", "failed attempt left no stuck claim");
    run(`drop trigger t072_fault_trg on inventory_private.mutation_receipts; drop function public.t072_fault();`);
    const retry = run(`${OWNER_SESSION} select public.correct_bake_actual_pieces('${op}', '${f.execution}', 10, 12, 'fault test'); reset role;`);
    assert.doesNotMatch(retry, /ERROR/);
    assert.equal(actualOf(f.execution), 12);
    assert.equal(onHand(f.product), 12);
    assert.equal(auditCount(f.execution), 1);
  });

  await t.test("a rejected opening-balance correction attempt never blocks or corrupts a valid concurrent correction on the same product", async () => {
    const f = makeBake(10);
    const opening = crypto.randomUUID();
    run(`insert into public.production_executions (id, product_id, product_batch_id, batch_version_snapshot, operation_id, multiplier, quantity_produced_pieces, expected_pieces, frozen_ingredient_cost_total, frozen_cost_per_piece, source_type, cost_basis_source, cost_basis_snapshot, completed_at)
        values ('${opening}', '${f.product}', null, null, '${crypto.randomUUID()}', 1, 5, 5, 50, 10, 'opening_balance', 'historical_estimate', '{"computed_cost_per_piece":10}'::jsonb, now() - interval '1 day');
      insert into public.finished_stock_movements (product_id, production_execution_id, movement_type, on_hand_delta, reserved_delta, operation_id, note)
        values ('${f.product}', '${opening}', 'production_receipt', 5, 0, '${crypto.randomUUID()}', 'opening');`);
    const rejected = spawnPsqlAsync(`${owner()} do $$ begin
      perform public.correct_bake_actual_pieces('${crypto.randomUUID()}', '${opening}', 5, 7, 'opening must be rejected');
      raise notice 'unexpectedly_accepted';
    exception when check_violation then raise notice 'rejected_as_expected'; end $$; commit;`);
    const valid = spawnPsqlAsync(`${owner()} select public.correct_bake_actual_pieces('${crypto.randomUUID()}', '${f.execution}', 10, 12, 'valid concurrent'); commit;`);
    const [rr, rv] = await Promise.all([rejected, valid]);
    assert.match(rr.stdout, /rejected_as_expected/);
    assert.doesNotMatch(rr.stdout, /unexpectedly_accepted/);
    assert.doesNotMatch(rv.stdout, /ERROR/);
    assert.equal(actualOf(f.execution), 12);
    assert.equal(actualOf(opening), 5, "opening-balance lot untouched");
    assert.equal(onHand(f.product), 17);
  });
});
