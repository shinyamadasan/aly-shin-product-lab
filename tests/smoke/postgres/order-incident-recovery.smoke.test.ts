// Guarded recovery of a SECOND mistaken refund (order 60b69833, production incident of 2026-10-20) against a disposable
// Postgres with the production migration chain. The recovery file is run UNMODIFIED against a fixture that reproduces the
// production state (production id and timestamps), and against deliberately wrong worlds that must abort the whole
// transaction without changing anything.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const root = path.resolve(import.meta.dirname, "../../..");
const sql = (file: string) => readFileSync(path.join(root, file), "utf8");
const MIGRATION = "supabase/migrations/20261019120000_order_refund_correction.sql";
const INCIDENT_MIGRATION = "supabase/migrations/20261020120000_order_payment_incident_events.sql";
const RECOVERY = "scripts/sql/recover-qa-refund-60b69833.sql";
const OWNER_SUB = "33333333-3333-4333-8333-333333333333";
const OWNER_SESSION = `set role authenticated;
  select set_config('request.jwt.claim.sub','${OWNER_SUB}',false);
  select set_config('request.jwt.claim.app_role','owner',false);
  select set_config('request.jwt.claims','{"sub":"${OWNER_SUB}","role":"authenticated","app_metadata":{"app_role":"owner"}}',false);`;

test("Recovery of a second mistaken refund: guarded, atomic, audited, and it leaves everything else untouched", { skip: process.env.RUN_POSTGRES_SMOKE !== "1" }, async (t) => {
  const container = `aly-refund-correction-${Date.now()}`;
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

  // ---- Seed: stock for the incident reproduction -----------------------------------------------------------
  const flour = uuid(), batch = uuid(), customer = uuid();
  run(`insert into public.ingredients (id, name, base_unit, current_quantity, average_unit_cost, inventory_reconciled_at, cost_reconciled_at) values ('${flour}', 'QA Flour', 'g', 1000, 0.05, now(), now());
       insert into public.products (id, name) values ('cookies', 'Chocolate Walnut Cookies');
       insert into public.product_batches (id, product_id, batch_version, status, usable_pieces) values ('${batch}', 'cookies', 'v1', 'completed', 10);
       insert into public.customers (id, name) values ('${customer}', 'QA Customer');`);
  asOwner(`select public.confirm_bake_v3('${uuid()}', '${batch}', 'cookies', 'Cookies v1', 1, 10, '[{"ingredient_id":"${flour}","quantity":400}]'::jsonb);`);

  const ORDER = "60b69833-5b47-4b86-b970-1477d7f1a1eb";
  const PAID_AT = "2026-10-19 15:49:46.017+00";
  const FIRST_REFUND = "2026-10-19 15:49:48.394+00";
  const COMPLETED = "2026-10-19 15:50:12.953756+00";
  const SECOND_REFUND = "2026-10-20 00:12:02.314+00";

  // Everything is applied to the template database once; every scenario then gets its own cheap clone of it.
  run(sql(MIGRATION));
  run(sql(INCIDENT_MIGRATION));
  const recovery = sql(RECOVERY);

  const inDb = (db: string, input: string) => execFileSync("docker", ["exec", "-i", container, "psql", "-U", "postgres", "-d", db, "-v", "ON_ERROR_STOP=1", "-tA"], { input, encoding: "utf8", stdio: "pipe" });
  const ownerIn = (db: string, statement: string) => inDb(db, `${OWNER_SESSION} ${statement}`).trim().split("\n").filter(Boolean).at(-1) ?? "";
  let scenario = 0;
  function newDb(): string {
    scenario += 1;
    const db = `scn_${scenario}`;
    run(`create database ${db} template postgres;`);
    return db;
  }

  // Reproduce production: paid, first refund, completed with real stock, first refund CORRECTED through the audited
  // function, then the SECOND (QA) refund written the way the old app wrote it. Production ids and timestamps.
  function buildIncident(db: string, opts: { secondRefundAt?: string; paidAmount?: number; firstCorrection?: boolean } = {}) {
    inDb(db, `insert into public.orders (id, customer_id, status) values ('${ORDER}', '${customer}', 'new');
      insert into public.order_lines (id, order_id, product_id, item_name, unit_price, pieces_per_unit_snapshot, quantity) values ('${uuid()}', '${ORDER}', 'cookies', 'Chocolate Walnut Cookies — 1 Cookie', 100, 1, 2);`);
    ownerIn(db, `update public.orders set payment_status = 'paid', payment_method = 'other', paid_at = clock_timestamp(), paid_amount = 200, updated_at = clock_timestamp() where id = '${ORDER}';`);
    ownerIn(db, `update public.orders set payment_status = 'refunded', refunded_at = clock_timestamp(), updated_at = clock_timestamp() where id = '${ORDER}';`);
    ownerIn(db, `select public.confirm_order_with_reservation('${uuid()}', '${ORDER}');`);
    ownerIn(db, `select public.complete_order_with_fulfillment('${uuid()}', '${ORDER}');`);
    if (opts.firstCorrection !== false) {
      // The first correction goes through the real correct_mistaken_refund, so its audit row has exactly the
      // shape that function writes. That function only corrects a refund recorded in the last 7 days (a business
      // rule, unchanged), and production's first refund dates from 2026-10-19, so it is corrected here while
      // still recent and the row's timestamps are then rebased to production's. The rebase is a maintenance
      // write in this disposable database only; replica mode skips the append-only trigger for that statement.
      const recentRefund = inDb(db, `select refunded_at from public.orders where id = '${ORDER}';`).trim();
      ownerIn(db, `select public.correct_mistaken_refund('${uuid()}', '${ORDER}', 'Refund button clicked by mistake; no money was returned. Legitimate sale.', '${recentRefund}'::timestamptz, 200);`);
      inDb(db, `set session_replication_role = replica;
        update public.order_refund_corrections set original_paid_at = '${PAID_AT}', original_refunded_at = '${FIRST_REFUND}', original_order_updated_at = '${COMPLETED}' where order_id = '${ORDER}';
        set session_replication_role = origin;`);
      // production timestamps (a maintenance session has no JWT, so this ordinary write is allowed)
      inDb(db, `update public.orders set paid_at = '${PAID_AT}', completed_at = '${COMPLETED}' where id = '${ORDER}';`);
    } else {
      inDb(db, `update public.orders set paid_at = '${PAID_AT}', refunded_at = '${FIRST_REFUND}', completed_at = '${COMPLETED}', updated_at = '${COMPLETED}' where id = '${ORDER}';`);
      inDb(db, `update public.orders set payment_status = 'paid', refunded_at = null where id = '${ORDER}';`);
    }
    const at = opts.secondRefundAt ?? SECOND_REFUND;
    inDb(db, `update public.orders set payment_status = 'refunded', refunded_at = '${at}', updated_at = '${at}'${opts.paidAmount ? `, paid_amount = ${opts.paidAmount}` : ""} where id = '${ORDER}';`);
  }
  const fingerprint = (db: string) => inDb(db, `select md5(
      coalesce((select string_agg(t::text, '|' order by t.id) from public.orders t), '') ||
      coalesce((select string_agg(t::text, '|' order by t::text) from public.order_lines t), '') ||
      coalesce((select string_agg(t::text, '|' order by t::text) from public.order_stock_allocations t), '') ||
      coalesce((select string_agg(t::text, '|' order by t::text) from public.finished_stock_movements t), '') ||
      coalesce((select string_agg(t::text, '|' order by t::text) from public.inventory_transactions t), '') ||
      coalesce((select string_agg(t::text, '|' order by t::text) from public.ingredients t), '') ||
      coalesce((select string_agg(t::text, '|' order by t::text) from public.order_refund_corrections t), '') ||
      coalesce((select string_agg(t::text, '|' order by t::text) from public.order_payment_incident_events t), ''))`).trim();
  const orderRow = (db: string) => JSON.parse(inDb(db, `select row_to_json(o)::jsonb::text from public.orders o where id = '${ORDER}'`));

  await t.test("the incident-events migration is additive, applies once, and has no client write path", () => {
    assert.throws(() => run(sql(INCIDENT_MIGRATION)), /must not be re-applied over itself/);
    assert.equal(run("select relrowsecurity::text from pg_class where oid = 'public.order_payment_incident_events'::regclass").trim(), "true");
    assert.equal(run("select (has_table_privilege('authenticated','public.order_payment_incident_events','insert') or has_table_privilege('authenticated','public.order_payment_incident_events','update') or has_table_privilege('authenticated','public.order_payment_incident_events','delete') or has_table_privilege('service_role','public.order_payment_incident_events','insert') or has_table_privilege('service_role','public.order_payment_incident_events','update') or has_table_privilege('service_role','public.order_payment_incident_events','delete') or has_table_privilege('anon','public.order_payment_incident_events','select'))::text").trim(), "false");
    assert.equal(run("select has_table_privilege('authenticated','public.order_payment_incident_events','select')::text").trim(), "true");
  });

  const happy = newDb();
  await t.test("the real recovery file restores Paid, records the incident immutably, and changes exactly one row in exactly three columns", () => {
    buildIncident(happy);
    const before = orderRow(happy);
    assert.equal(before.payment_status, "refunded");
    assert.equal(before.refunded_at, "2026-10-20T00:12:02.314+00:00");
    assert.equal(inDb(happy, "select count(*) from public.order_refund_corrections").trim(), "1", "the first correction exists, as in production");
    const cogs = inDb(happy, `select raw_production_cogs::text from public.order_raw_cogs where order_id = '${ORDER}'`).trim();
    const others = inDb(happy, `select md5(coalesce(string_agg(t::text, '|' order by t.id), '')) from public.orders t where t.id <> '${ORDER}'`).trim();
    const sideBefore = inDb(happy, `select md5(coalesce((select string_agg(t::text, '|' order by t::text) from public.order_lines t), '') || coalesce((select string_agg(t::text, '|' order by t::text) from public.order_stock_allocations t), '') || coalesce((select string_agg(t::text, '|' order by t::text) from public.finished_stock_movements t), '') || coalesce((select string_agg(t::text, '|' order by t::text) from public.order_refund_corrections t), ''))`).trim();

    inDb(happy, recovery);

    const after = orderRow(happy);
    assert.equal(after.payment_status, "paid");
    assert.equal(after.refunded_at, null);
    assert.ok(Date.parse(after.updated_at) > Date.parse(before.updated_at), "updated_at is new, not restored or invented");
    const changed = Object.keys(before).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k])).sort();
    assert.deepEqual(changed, ["payment_status", "refunded_at", "updated_at"]);
    assert.equal(after.paid_amount, 200);
    assert.equal(after.status, "completed");
    assert.equal(inDb(happy, `select md5(coalesce(string_agg(t::text, '|' order by t.id), '')) from public.orders t where t.id <> '${ORDER}'`).trim(), others, "no other order changed");
    assert.equal(inDb(happy, `select md5(coalesce((select string_agg(t::text, '|' order by t::text) from public.order_lines t), '') || coalesce((select string_agg(t::text, '|' order by t::text) from public.order_stock_allocations t), '') || coalesce((select string_agg(t::text, '|' order by t::text) from public.finished_stock_movements t), '') || coalesce((select string_agg(t::text, '|' order by t::text) from public.order_refund_corrections t), ''))`).trim(), sideBefore, "lines, allocations, movements and the first audit row are byte-identical");
    assert.equal(inDb(happy, `select raw_production_cogs::text from public.order_raw_cogs where order_id = '${ORDER}'`).trim(), cogs, "ingredient COGS unchanged");

    const events = JSON.parse(inDb(happy, "select coalesce(json_agg(e), '[]'::json)::text from public.order_payment_incident_events e"));
    assert.equal(events.length, 1);
    assert.equal(events[0].event_type, "second_refund_reversed");
    assert.equal(Date.parse(events[0].incident_refunded_at), Date.parse("2026-10-20T00:12:02.314Z"), "the erroneous refund's original timestamp is preserved");
    assert.equal(events[0].payment_status_before, "refunded");
    assert.equal(Number(events[0].paid_amount_before), 200);
    assert.match(events[0].reason, /QA testing/);
    assert.match(events[0].recorded_by, /Claude Code/);
    assert.match(events[0].authorized_by, /owner/);
    assert.ok(events[0].prior_correction_id, "linked to the first correction");
    assert.equal(inDb(happy, "select original_refunded_at::text from public.order_refund_corrections").trim(), FIRST_REFUND, "the first-correction audit row is intact");
  });

  await t.test("running it again aborts (the order is already Paid) and records nothing more", () => {
    const fp = fingerprint(happy);
    assert.throws(() => inDb(happy, recovery), /RECOVERY ABORTED: order is "paid"/);
    assert.equal(fingerprint(happy), fp);
  });

  await t.test("the incident history is immutable, and the owner can read it but not write it", () => {
    assert.throws(() => inDb(happy, "update public.order_payment_incident_events set reason = 'tampered tampered'"), /append-only/);
    assert.throws(() => inDb(happy, "delete from public.order_payment_incident_events"), /append-only/);
    assert.throws(() => inDb(happy, "truncate public.order_payment_incident_events"), /append-only/);
    assert.throws(() => ownerIn(happy, "insert into public.order_payment_incident_events (order_id, event_type, recorded_by, authorized_by, reason, incident_refunded_at, order_status, payment_status_before, paid_at_before, paid_amount_before, order_updated_at_before) select id, 'second_refund_reversed', 'xxxxxxxxxx', 'yyyyyyyyyy', 'zzzzzzzzzz', now(), 'completed', 'refunded', now(), 1, now() from public.orders limit 1"), /permission denied/);
    assert.equal(ownerIn(happy, "select count(*) from public.order_payment_incident_events"), "1");
    // a duplicate record of the same incident is refused by the table itself
    assert.throws(() => inDb(happy, "insert into public.order_payment_incident_events (order_id, event_type, recorded_by, authorized_by, reason, incident_refunded_at, order_status, payment_status_before, paid_at_before, paid_amount_before, order_updated_at_before) select order_id, event_type, recorded_by, authorized_by, reason, incident_refunded_at, order_status, payment_status_before, paid_at_before, paid_amount_before, order_updated_at_before from public.order_payment_incident_events"), /order_payment_incident_events_once/);
  });

  // Each wrong world must abort the WHOLE transaction: nothing written, not even the audit event.
  const wrongWorlds: Array<{ name: string; build: (db: string) => void; expect: RegExp }> = [
    { name: "a different refund timestamp", build: (db) => buildIncident(db, { secondRefundAt: "2026-10-20 00:12:09.999+00" }), expect: /refund timestamp differs/ },
    { name: "a different paid amount", build: (db) => buildIncident(db, { paidAmount: 250 }), expect: /payment facts differ/ },
    { name: "no first-correction audit row", build: (db) => buildIncident(db, { firstCorrection: false }), expect: /first-correction audit row is missing/ },
    { name: "the order already Paid (nothing to recover)", build: (db) => { buildIncident(db); inDb(db, `update public.orders set payment_status = 'paid', refunded_at = null where id = '${ORDER}'`); }, expect: /not refunded|is "paid"/ },
    { name: "the order cancelled instead of completed", build: (db) => { buildIncident(db); inDb(db, `select set_config('inventory_private.order_transition_authorized','true',false); update public.orders set status = 'cancelled', cancelled_at = now() where id = '${ORDER}'`); }, expect: /not the expected completed order/ },
    { name: "an unexpected updated_at (the order was touched after the refund)", build: (db) => { buildIncident(db); inDb(db, `update public.orders set updated_at = updated_at + interval '1 second' where id = '${ORDER}'`); }, expect: /refund timestamp differs/ },
    { name: "no such order", build: () => undefined, expect: /order not found/ },
    { name: "a different completion time", build: (db) => { buildIncident(db); inDb(db, `update public.orders set completed_at = completed_at + interval '1 second' where id = '${ORDER}'`); }, expect: /not the expected completed order/ },
    { name: "different order lines", build: (db) => { buildIncident(db); inDb(db, `alter table public.order_lines disable trigger user; update public.order_lines set quantity = 3 where order_id = '${ORDER}'; alter table public.order_lines enable trigger user;`); }, expect: /order lines are not 2 x Chocolate Walnut Cookies at 100/ },
    { name: "a first-correction audit row that describes another refund", build: (db) => { buildIncident(db); inDb(db, `alter table public.order_refund_corrections disable trigger user; update public.order_refund_corrections set original_paid_amount = 999 where order_id = '${ORDER}'; alter table public.order_refund_corrections enable trigger user;`); }, expect: /does not describe the first refund/ },
    { name: "the incident is already recorded", build: (db) => { buildIncident(db); inDb(db, `insert into public.order_payment_incident_events (order_id, event_type, recorded_by, authorized_by, reason, incident_refunded_at, order_status, payment_status_before, paid_at_before, paid_amount_before, order_updated_at_before) values ('${ORDER}', 'second_refund_reversed', 'qa fixture actor', 'qa fixture authorizer', 'qa fixture reason', '${SECOND_REFUND}', 'completed', 'refunded', '${PAID_AT}', 200, '${SECOND_REFUND}')`); }, expect: /already recorded/ },
  ];
  for (const world of wrongWorlds) {
    await t.test(`guard: ${world.name} -> aborts, rolls everything back`, () => {
      const db = newDb();
      world.build(db);
      const before = fingerprint(db);
      const eventsBefore = inDb(db, "select count(*) from public.order_payment_incident_events").trim();
      assert.throws(() => inDb(db, recovery), world.expect);
      assert.equal(fingerprint(db), before, "nothing changed, including the audit event table");
      assert.equal(inDb(db, "select count(*) from public.order_payment_incident_events").trim(), eventsBefore, "no incident event was added");
    });
  }

  await t.test("late guard: a trigger that changes ANOTHER COLUMN of the order is caught and everything rolls back", () => {
    const db = newDb();
    buildIncident(db);
    inDb(db, `create function public.qa_column_effect() returns trigger language plpgsql as $f$ begin new.notes := 'qa column effect'; return new; end $f$;
      create trigger qa_column_effect before update of payment_status on public.orders for each row execute function public.qa_column_effect();`);
    const before = fingerprint(db);
    assert.throws(() => inDb(db, recovery), /a column other than payment_status, refunded_at, updated_at changed/);
    assert.equal(fingerprint(db), before);
    assert.equal(orderRow(db).payment_status, "refunded");
  });

  await t.test("late guard: a trigger that changes ANOTHER ORDER is caught and everything rolls back", () => {
    const db = newDb();
    buildIncident(db);
    inDb(db, `insert into public.orders (id, customer_id, status) values ('${uuid()}', '${customer}', 'new');
      create function public.qa_other_order() returns trigger language plpgsql as $f$ begin update public.orders set notes = 'qa other order' where id <> new.id; return new; end $f$;
      create trigger qa_other_order after update of payment_status on public.orders for each row execute function public.qa_other_order();`);
    const before = fingerprint(db);
    assert.throws(() => inDb(db, recovery), /RECOVERY ABORTED: another order changed/);
    assert.equal(fingerprint(db), before);
    assert.equal(orderRow(db).payment_status, "refunded");
  });

  await t.test("a failure AFTER the event insert and the update still rolls both back (late guard)", () => {
    const db = newDb();
    buildIncident(db);
    // Sabotage: a trigger that mutates an unrelated table during the order update, so a late 'side tables changed' guard must fire.
    inDb(db, `create function public.qa_side_effect() returns trigger language plpgsql as $f$ begin update public.ingredients set notes = 'qa side effect'; return new; end $f$;
      create trigger qa_side_effect after update of payment_status on public.orders for each row execute function public.qa_side_effect();`);
    const before = fingerprint(db);
    assert.throws(() => inDb(db, recovery), /RECOVERY ABORTED: lines, stock, ledger, ingredients or the first-correction audit changed/);
    assert.equal(fingerprint(db), before, "the order is still refunded and no event was recorded");
    assert.equal(orderRow(db).payment_status, "refunded");
    assert.equal(inDb(db, "select count(*) from public.order_payment_incident_events").trim(), "0");
  });
});
