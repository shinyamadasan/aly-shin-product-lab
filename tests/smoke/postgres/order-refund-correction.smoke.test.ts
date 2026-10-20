// Correct Mistaken Refund against a disposable Postgres with the production migration chain. Includes a
// reproduction of the real incident (order paid, refunded 2 seconds later, then completed with real stock
// fulfilled) fed through the app's own revenue figures (src/lib/orders/revenue.ts). No other pending migration is
// applied here: this change must work, and be reversible, on its own.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { mapOrderRow } from "../../../src/lib/orders/mappers.ts";
import { netRevenue, refunds, singleDayRange } from "../../../src/lib/orders/revenue.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const sql = (file: string) => readFileSync(path.join(root, file), "utf8");
const MIGRATION = "supabase/migrations/20261019120000_order_refund_correction.sql";
const OWNER_SUB = "33333333-3333-4333-8333-333333333333";
const OWNER_SESSION = `set role authenticated;
  select set_config('request.jwt.claim.sub','${OWNER_SUB}',false);
  select set_config('request.jwt.claim.app_role','owner',false);
  select set_config('request.jwt.claims','{"sub":"${OWNER_SUB}","role":"authenticated","app_metadata":{"app_role":"owner"}}',false);`;
const OWNER_TX = `select set_config('request.jwt.claim.sub','${OWNER_SUB}',true);
  select set_config('request.jwt.claim.app_role','owner',true);
  select set_config('request.jwt.claims','{"sub":"${OWNER_SUB}","role":"authenticated","app_metadata":{"app_role":"owner"}}',true);`;

test("Correct Mistaken Refund: audited, owner-only, reversible, and it leaves sales, stock and cost exactly as they were", { skip: process.env.RUN_POSTGRES_SMOKE !== "1" }, async (t) => {
  const container = `aly-refund-correction-${Date.now()}`;
  execFileSync("docker", ["run", "-d", "--name", container, "-e", "POSTGRES_PASSWORD=test-only", "postgres:17-alpine"], { stdio: "pipe" });
  t.after(() => execFileSync("docker", ["rm", "-f", container], { stdio: "pipe" }));
  // No ON_ERROR_STOP: how an operator pasting a script into plain psql would run it.
  const runLoose = (input: string) => execFileSync("docker", ["exec", "-i", container, "psql", "-U", "postgres", "-tA"], { input, encoding: "utf8", stdio: "pipe" });
  const run = (input: string) => execFileSync("docker", ["exec", "-i", container, "psql", "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-tA"], { input, encoding: "utf8", stdio: "pipe" });
  let ready = false;
  for (let attempt = 0; attempt < 90; attempt++) {
    try { if (run("select 1").trim() === "1") { ready = true; break; } } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  assert.ok(ready, "PostgreSQL must start; an unavailable database is not a passing test");
  await new Promise((resolve) => setTimeout(resolve, 500));

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
    create policy p_batches on public.product_batches for all to authenticated using (public.is_product_lab_owner()) with check (public.is_product_lab_owner());
    create table public.selling_formats (id uuid primary key default gen_random_uuid());
    alter table public.selling_formats enable row level security;
    create table public.costing_summaries (id uuid primary key default gen_random_uuid());`);
  // Supabase grants anon/authenticated/service_role ALL on new objects by default; mirror it so the migration's
  // own revokes are what is being proven.
  run("alter default privileges in schema public grant all on tables to anon, authenticated, service_role; alter default privileges in schema public grant all on functions to anon, authenticated, service_role;");
  for (const migration of [
    "supabase/migrations/20260909132327_selling_wave_0a_raw_authority.sql",
    "supabase/migrations/20260909162224_selling_wave_0a_reversal_boundary.sql",
    "supabase/migrations/20260910022601_selling_wave_0b_safe_mutations.sql",
    "supabase/migrations/20260910120146_selling_wave_1_production_execution.sql",
    "supabase-add-orders.sql",
    "supabase/migrations/20260910181827_selling_wave_2_order_reservation.sql",
    "supabase/migrations/20260911103433_selling_wave_3_finished_stock_exceptions_and_cogs.sql",
    "supabase/migrations/20260912090000_cost_baseline_repair.sql",
    "supabase/migrations/20260912193053_claude_inventory_operator_v1a.sql",
    "supabase/migrations/20260917175840_safe_purchase_delete.sql",
    "supabase/migrations/20260921120000_cost_system_simplification_v4.sql",
    "supabase/migrations/20260923130000_finished_stock_opening_balance.sql",
  ]) {
    run(sql(migration));
  }

  const asOwner = (statement: string) => run(`${OWNER_SESSION} ${statement}`).trim().split("\n").filter(Boolean).at(-1) ?? "";
  const uuid = () => crypto.randomUUID();
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const objectCounts = () => run(`select (select count(*) from information_schema.tables where table_schema in ('public','inventory_private'))::text || ':' ||
    (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public','inventory_private'))::text || ':' ||
    (select count(*) from pg_policies where schemaname = 'public')::text || ':' ||
    (select count(*) from pg_trigger where not tgisinternal)::text`).trim();

  // ---- Seed: stock for the incident reproduction -----------------------------------------------------------
  const flour = uuid(), batch = uuid(), customer = uuid();
  run(`insert into public.ingredients (id, name, base_unit, current_quantity, average_unit_cost, inventory_reconciled_at, cost_reconciled_at) values ('${flour}', 'QA Flour', 'g', 1000, 0.05, now(), now());
       insert into public.products (id, name) values ('cookies', 'Chocolate Walnut Cookies');
       insert into public.product_batches (id, product_id, batch_version, status, usable_pieces) values ('${batch}', 'cookies', 'v1', 'completed', 10);
       insert into public.customers (id, name) values ('${customer}', 'QA Customer');`);
  asOwner(`select public.confirm_bake_v3('${uuid()}', '${batch}', 'cookies', 'Cookies v1', 1, 10, '[{"ingredient_id":"${flour}","quantity":400}]'::jsonb);`);

  const financialFacts = () => run(`select md5(
    coalesce((select string_agg(t::text, '|' order by t::text) from public.ingredients t), '') ||
    coalesce((select string_agg(t::text, '|' order by t::text) from public.inventory_transactions t), '') ||
    coalesce((select string_agg(t::text, '|' order by t::text) from public.production_executions t), '') ||
    coalesce((select string_agg(t::text, '|' order by t::text) from public.finished_stock_movements t), '') ||
    coalesce((select string_agg(t::text, '|' order by t::text) from public.order_stock_allocations t), '') ||
    coalesce((select string_agg(t::text, '|' order by t::text) from public.order_lines t), ''))`).trim();
  const baseline = { facts: financialFacts(), objects: objectCounts() };

  await t.test("the migration applies, is additive, and refuses to be applied twice", () => {
    run(sql(MIGRATION));
    assert.equal(financialFacts(), baseline.facts, "no existing stock, ledger, cost or order-line record changed");
    assert.throws(() => run(sql(MIGRATION)), /must not be re-applied over itself/);
  });

  await t.test("assertions: legitimate refunds, accidental refunds, safeguards, duplicates, authorization, immutability", () => {
    assert.match(run(sql("tests/smoke/postgres/order-refund-correction.assertions.sql")), /order_refund_correction_assertions_passed/);
    assert.equal(run("select count(*) from public.order_refund_corrections").trim(), "0", "assertions run in a rolled-back transaction");
  });

  // ---- The incident, reproduced with the real flow ----------------------------------------------------------
  const incident = uuid();
  function loadIncidentOrder() {
    const rows = JSON.parse(asOwner(`select coalesce(json_agg(o), '[]'::json)::jsonb::text from public.orders o where id = '${incident}'`));
    return mapOrderRow(rows[0]);
  }
  const manilaDay = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila" }).format(new Date(iso));

  await t.test("the incident: paid, refunded 2 seconds later, then completed -> counted as 200 returned", async () => {
    run(`insert into public.orders (id, customer_id, status) values ('${incident}', '${customer}', 'new');
         insert into public.order_lines (id, order_id, product_id, item_name, unit_price, pieces_per_unit_snapshot, quantity) values ('${uuid()}', '${incident}', 'cookies', 'Chocolate Walnut Cookies', 100, 1, 2);`);
    asOwner(`update public.orders set payment_status = 'paid', payment_method = 'other', paid_at = clock_timestamp(), paid_amount = 200, updated_at = clock_timestamp() where id = '${incident}';`);
    await sleep(1200);
    asOwner(`update public.orders set payment_status = 'refunded', refunded_at = clock_timestamp(), updated_at = clock_timestamp() where id = '${incident}';`);
    asOwner(`select public.confirm_order_with_reservation('${uuid()}', '${incident}');`);
    asOwner(`select public.complete_order_with_fulfillment('${uuid()}', '${incident}');`);
    const order = loadIncidentOrder();
    const day = singleDayRange(manilaDay(order.paidAt as string), "Asia/Manila");
    assert.ok(Date.parse(order.refundedAt as string) < Date.parse(order.completedAt as string), "refunded BEFORE it was completed, the exact pattern of the production incident");
    assert.equal(refunds([order], day), 200);
    assert.equal(netRevenue([order], day), 0);
  });

  await t.test("correcting it restores Paid, clears the active refund, and leaves the sale, stock and cost exactly as they were", () => {
    const before = JSON.parse(run(`select row_to_json(o)::jsonb::text from public.orders o where id = '${incident}'`));
    const factsBefore = financialFacts();
    const cogsBefore = run(`select raw_production_cogs::text from public.order_raw_cogs where order_id = '${incident}'`).trim();
    const ordersBefore = run("select count(*) from public.orders").trim();
    assert.equal(before.payment_status, "refunded");

    const result = JSON.parse(asOwner(`select public.correct_mistaken_refund('${uuid()}', '${incident}', 'Refund button clicked by mistake; no money was returned', '${before.refunded_at}'::timestamptz, 200)::jsonb::text;`));
    assert.equal(result.payment_status, "paid");
    assert.equal(result.refunded_at, null);

    const after = JSON.parse(run(`select row_to_json(o)::jsonb::text from public.orders o where id = '${incident}'`));
    for (const field of ["status", "completed_at", "paid_at", "paid_amount", "payment_method", "placed_at", "customer_id", "fulfillment_method"]) {
      assert.deepEqual(after[field], before[field], `${field} must be unchanged`);
    }
    assert.equal(financialFacts(), factsBefore, "ingredients, stock ledger, lots, finished-stock movements, allocations and order lines are byte-identical");
    assert.equal(run(`select raw_production_cogs::text from public.order_raw_cogs where order_id = '${incident}'`).trim(), cogsBefore, "ingredient COGS preserved");
    assert.equal(run("select count(*) from public.orders").trim(), ordersBefore, "no second order or payment was created");
    assert.equal(run(`select count(*) from public.order_refund_corrections where order_id = '${incident}' and original_refunded_at = '${before.refunded_at}'::timestamptz and original_paid_amount = 200`).trim(), "1", "the erased refund is preserved in the audit row");

    const corrected = loadIncidentOrder();
    const day = singleDayRange(manilaDay(corrected.paidAt as string), "Asia/Manila");
    assert.equal(corrected.paymentStatus, "paid");
    assert.equal(corrected.refundedAt, null);
    assert.equal(refunds([corrected], day), 0, "no refund is active any more");
    assert.equal(netRevenue([corrected], day), 200, "the 200 sale stands");
    assert.equal(Math.round(Number(cogsBefore) * 100) / 100, 4, "the 2 cookies keep their ingredient cost (2 x 2.00)");
  });

  await t.test("two simultaneous corrections of one refund: exactly one is recorded and the loser is refused", async () => {
    const racer = uuid();
    run(`insert into public.orders (id, customer_id, status, payment_status, payment_method, paid_at, paid_amount, refunded_at) values ('${racer}', '${customer}', 'new', 'refunded', 'cash', now(), 90, now());`);
    const refundedAt = run(`select refunded_at::text from public.orders where id = '${racer}'`).trim();
    const call = (op: string) => `begin; set local role authenticated; ${OWNER_TX} select 'DONE:' || (public.correct_mistaken_refund('${op}', '${racer}', 'Refund button clicked by mistake', '${refundedAt}'::timestamptz, 90)->>'payment_status'); select pg_sleep(1.2); commit;`;
    const spawnPsql = (input: string) => new Promise<string>((resolve, reject) => {
      const child = spawn("docker", ["exec", "-i", container, "psql", "-U", "postgres", "-tA"], { stdio: ["pipe", "pipe", "pipe"] });
      let out = ""; child.stdout.on("data", (c) => { out += c; }); child.stderr.on("data", (c) => { out += c; });
      child.on("error", reject); child.on("close", () => resolve(out)); child.stdin.end(input);
    });
    const first = spawnPsql(call(uuid()));
    await sleep(300);
    const second = spawnPsql(call(uuid()));
    const [a, b] = await Promise.all([first, second]);
    assert.match(a, /DONE:paid/);
    assert.match(b, /not marked refunded|already corrected/, "the loser waits on the row lock, then sees it is no longer refunded");
    assert.equal(run(`select count(*) from public.order_refund_corrections where order_id = '${racer}'`).trim(), "1");

    const same = uuid();
    const racer2 = uuid();
    run(`insert into public.orders (id, customer_id, status, payment_status, payment_method, paid_at, paid_amount, refunded_at) values ('${racer2}', '${customer}', 'new', 'refunded', 'cash', now(), 70, now());`);
    const ra = run(`select refunded_at::text from public.orders where id = '${racer2}'`).trim();
    const sameCall = `begin; set local role authenticated; ${OWNER_TX} select 'ID:' || (public.correct_mistaken_refund('${same}', '${racer2}', 'Refund button clicked by mistake', '${ra}'::timestamptz, 70)->>'id'); select pg_sleep(1.2); commit;`;
    const [c, d] = await Promise.all([spawnPsql(sameCall), sleep(300).then(() => spawnPsql(sameCall))]);
    assert.equal(c.match(/ID:([0-9a-f-]{36})/)?.[1], d.match(/ID:([0-9a-f-]{36})/)?.[1], "an overlapping retry replays the first answer");
    assert.equal(run(`select count(*) from public.order_refund_corrections where order_id = '${racer2}'`).trim(), "1");
  });

  await t.test("the correction can itself be undone: a normal Refund puts the order back, and the audit history stays", () => {
    const row = JSON.parse(run(`select row_to_json(o)::jsonb::text from public.orders o where id = '${incident}'`));
    assert.equal(row.payment_status, "paid");
    asOwner(`update public.orders set payment_status = 'refunded', refunded_at = clock_timestamp() where id = '${incident}';`);
    assert.equal(run(`select payment_status from public.orders where id = '${incident}'`).trim(), "refunded");
    assert.equal(run(`select count(*) from public.order_refund_corrections where order_id = '${incident}'`).trim(), "1", "history is kept");
    // And the same order cannot be corrected a second time through the shortcut.
    const refundedAt = run(`select refunded_at::text from public.orders where id = '${incident}'`).trim();
    assert.throws(() => asOwner(`select public.correct_mistaken_refund('${uuid()}', '${incident}', 'Refund button clicked by mistake', '${refundedAt}'::timestamptz, 200);`), /already corrected once/);
  });

  await t.test("the documented rollback ABORTS while audit rows exist, then restores the exact original schema and clears its receipts", () => {
    const text = sql(MIGRATION).replace(/\r\n/g, "\n");
    const block = text.slice(text.indexOf("-- ROLLBACK"), text.indexOf("do $$\nbegin"));
    const rollback = block.split("\n").filter((line) => line.startsWith("--   ")).map((line) => line.slice(5)).join("\n");
    assert.match(rollback, /do \$rollback\$/);
    assert.match(rollback, /drop trigger orders_enforce_refund_reversal_authority/);
    assert.match(rollback, /delete from inventory_private\.mutation_receipts/);

    const midCounts = objectCounts();
    assert.ok(Number(run("select count(*) from public.order_refund_corrections").trim()) > 0);
    const factsBeforeRollback = financialFacts();
    assert.throws(() => run(rollback), /not empty/);
    assert.equal(objectCounts(), midCounts, "an aborted rollback drops nothing");
    const auditRows = run("select count(*) from public.order_refund_corrections").trim();
    runLoose(rollback); // the failed guard must not be followed by the drops, even without ON_ERROR_STOP
    assert.equal(objectCounts(), midCounts, "a rollback pasted into plain psql still drops nothing while audit rows exist");
    assert.equal(run("select count(*) from public.order_refund_corrections").trim(), auditRows, "the audit rows survive");

    run("set session_replication_role = replica; delete from public.order_refund_corrections;"); // TEST ONLY: a real operator exports first
    assert.ok(Number(run("select count(*) from inventory_private.mutation_receipts where operation_type = 'refund_correct'").trim()) > 0);
    run(rollback);
    assert.equal(objectCounts(), baseline.objects, "exactly the original object set");
    assert.equal(run("select count(*) from inventory_private.mutation_receipts where operation_type = 'refund_correct'").trim(), "0", "no stale receipts");
    assert.equal(financialFacts(), factsBeforeRollback, "rollback touched no financial record");
    run(sql(MIGRATION));
    assert.equal(run("select count(*) from public.order_refund_corrections").trim(), "0", "re-applies cleanly");
  });
});
