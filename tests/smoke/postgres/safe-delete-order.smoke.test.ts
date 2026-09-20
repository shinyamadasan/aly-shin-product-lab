import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const root = path.resolve(import.meta.dirname, "../../..");
const sql = (file: string) => readFileSync(path.join(root, file), "utf8");
// Transaction-local, for the spawned sessions below (each wraps everything in one begin;...commit;).
const OWNER_JWT = `select set_config('request.jwt.claim.sub','77777777-7777-4777-8777-777777777777',true);
  select set_config('request.jwt.claim.app_role','owner',true);
  select set_config('request.jwt.claims','{"sub":"77777777-7777-4777-8777-777777777777","role":"authenticated","app_metadata":{"app_role":"owner"}}',true);`;

test("Safe Delete Order removes only accidental new orders, and the database refuses every other case", { skip: process.env.RUN_POSTGRES_SMOKE !== "1" }, async (t) => {
  const container = `aly-safe-delete-order-${Date.now()}`;
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
  run(sql("supabase/migrations/20260919120000_safe_delete_order.sql"));

  const result = run(sql("tests/smoke/postgres/safe-delete-order.assertions.sql"));
  assert.match(result, /safe_delete_order_assertions_passed/);

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

  await t.test("a delete racing a confirm on the same order: the order-row lock serializes them, exactly one wins, and the loser changes nothing", async () => {
    const product = `p-${crypto.randomUUID().slice(0, 8)}`;
    const batch = crypto.randomUUID();
    const execution = crypto.randomUUID();
    const customer = crypto.randomUUID();
    const orderId = crypto.randomUUID();
    run(`insert into public.products (id, name) values ('${product}', 'Race ${product}');
      insert into public.product_batches (id, product_id, batch_version, status, usable_pieces) values ('${batch}', '${product}', 'v1', 'completed', 10);
      insert into public.production_executions (id, product_id, product_batch_id, batch_version_snapshot, operation_id, multiplier, quantity_produced_pieces, expected_pieces, frozen_ingredient_cost_total, frozen_cost_per_piece, completed_at)
        values ('${execution}', '${product}', '${batch}', 'v1', '${crypto.randomUUID()}', 1, 10, 10, 100, 10, now());
      insert into public.finished_stock_movements (product_id, production_execution_id, movement_type, on_hand_delta, reserved_delta, operation_id, note)
        values ('${product}', '${execution}', 'production_receipt', 10, 0, '${crypto.randomUUID()}', 'seed');
      insert into public.customers (id, name) values ('${customer}', 'Race Customer');
      insert into public.orders (id, customer_id, status) values ('${orderId}', '${customer}', 'new');
      insert into public.order_lines (id, order_id, product_id, item_name, unit_price, pieces_per_unit_snapshot, quantity)
        values ('${crypto.randomUUID()}', '${orderId}', '${product}', 'Race line', 100, 2, 1);`);
    const expected = run(`select updated_at from public.orders where id = '${orderId}'`).trim();

    // A confirm holds the order-row lock for ~2s; the delete starts while it is held.
    const confirming = spawnPsqlAsync(`begin; set local role authenticated; ${OWNER_JWT}
      select 'CONFIRMED:' || ((public.confirm_order_with_reservation('${crypto.randomUUID()}', '${orderId}')) ->> 'status'); select pg_sleep(2); commit;`);
    await sleep(800);
    const deleting = spawnPsqlAsync(`begin; set local role authenticated; ${OWNER_JWT}
      select public.safe_delete_order('${crypto.randomUUID()}', '${orderId}', '${expected}'); commit;`);
    const [confirmed, deleted] = await Promise.all([confirming, deleting]);

    assert.match(confirmed.stdout, /CONFIRMED:confirmed/);
    assert.match(deleted.stdout, /changed since you opened it|Only new orders can be permanently deleted/);
    assert.equal(run(`select count(*) from public.orders where id = '${orderId}' and status = 'confirmed'`).trim(), "1", "the confirmed order must survive the losing delete");
    assert.equal(run(`select count(*) from public.order_stock_allocations where order_id = '${orderId}' and status = 'active'`).trim(), "1", "the reservation must be intact");
    assert.equal(run(`select count(*) from public.order_lines where order_id = '${orderId}'`).trim(), "1", "its lines must be intact");
  });
});
