import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../../..");
const sql = (file: string) => readFileSync(path.join(root, file), "utf8");

test("Finished Stock Opening Balance: bootstrap-only eligibility, on_hand-basis reconciliation, reserved-stock protection, server-verified cost basis, idempotent/atomic batch apply, staleness rejection, FIFO/reservation integration", { skip: process.env.RUN_POSTGRES_SMOKE !== "1" }, async (t) => {
  const container = `aly-fsob-${Date.now()}`;
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

  // Same base environment + Wave 0A/0B/1/2/3 dependency chain as
  // tests/smoke/postgres/selling-wave-3-exceptions-cogs.smoke.test.ts, verbatim -- Wave 0A's own
  // preflight guard requires the real ingredients/supply tables to exist first (confirmed
  // empirically: it is not tolerant of a stub environment the way the rest of this chain is).
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

  // Minimal costing_summaries -- only the columns this migration's cost-basis validation reads
  // (id, product_id, ingredient_cost), matching supabase-schema.sql's real column names/types.
  run(`create table public.costing_summaries (
      id uuid primary key default gen_random_uuid(), product_id text not null references public.products(id),
      batch_id uuid references public.product_batches(id), ingredient_cost numeric not null default 0);
    alter table public.costing_summaries enable row level security;
    grant select, insert, update, delete on public.costing_summaries to authenticated;
    create policy p_costings on public.costing_summaries for all to authenticated using (public.is_product_lab_owner()) with check (public.is_product_lab_owner());`);

  run(sql("supabase/migrations/20260923130000_finished_stock_opening_balance.sql"));

  await t.test("full assertion suite", () => {
    const result = run(sql("tests/smoke/postgres/finished-stock-opening-balance.assertions.sql"));
    assert.match(result, /finished_stock_opening_balance_assertions_passed/);
  });
});
