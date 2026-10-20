import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const root = path.resolve(import.meta.dirname, "../../..");
const sql = (file: string) => readFileSync(path.join(root, file), "utf8");
test("Financial Release 2: authoritative stock financial attribution", { skip: process.env.RUN_POSTGRES_SMOKE !== "1" }, async (t) => {
  const container = `aly-stock-finance-${Date.now()}`;
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
  run(sql("supabase/migrations/20260912090000_cost_baseline_repair.sql"));
  run(sql("supabase/migrations/20260912193053_claude_inventory_operator_v1a.sql"));
  run(sql("supabase/migrations/20260917175840_safe_purchase_delete.sql"));
  run(sql("supabase/migrations/20260921120000_cost_system_simplification_v4.sql"));
  run(sql("supabase/migrations/20260923130000_finished_stock_opening_balance.sql"));
  run(sql("supabase/migrations/20260924120000_bake_actual_correction.sql"));
  run(sql("supabase/migrations/20260924180000_bake_actual_correction_postgrest_safe_stale.sql"));

  run(sql("supabase/migrations/20261016120000_business_expenses.sql"));
  run(sql("supabase/migrations/20261019120000_order_refund_correction.sql"));
  run(sql("supabase/migrations/20261020120000_order_payment_incident_events.sql"));
  run(sql("supabase/migrations/20261020202509_raw_inventory_reversal_boundary_restore.sql"));
  // Reproduce Supabase's default grants, including a service role that bypasses RLS. ACLs,
  // rather than a missing default grant or RLS alone, must prevent forged audit INSERTs.
  run(`alter role service_role bypassrls;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant all on functions to anon, authenticated, service_role;`);
  run(sql("supabase/migrations/20261020203106_financial_release_2_stock_attribution.sql"));

  await t.test("the final FR2 raw replacement retains the approved Wave 0A authority, count boundary and rollback contracts", () => {
    assert.match(run(sql("tests/smoke/postgres/raw-inventory-authority.assertions.sql")), /wave_0a_assertions_passed/);
  });
  await t.test("single-shot cost, classification, history, receipts and authorization invariants", () => {
    assert.match(run(sql("tests/smoke/postgres/stock-financial-events.assertions.sql")), /stock_financial_events_assertions_passed/);
  });
  const ownerSession = `set role authenticated;
    select set_config('request.jwt.claim.sub','99999999-9999-4999-8999-999999999999',false);
    select set_config('request.jwt.claim.app_role','owner',false);`;
  const q1 = (statement: string) => run(statement).trim();
  const asOwner = (statement: string) => run(`${ownerSession} ${statement}`).trim().split("\n").at(-1)!;
  const uuid = () => crypto.randomUUID();
  function fixture() {
    const product = `race-${uuid()}`;
    const execution = uuid(); const batch = uuid();
    run(`insert into public.products(id,name) values('${product}','race fixture');
      insert into public.product_batches(id,product_id,batch_version,status,usable_pieces) values('${batch}','${product}','v1','completed',10);
      insert into public.production_executions(id,product_id,product_batch_id,batch_version_snapshot,operation_id,multiplier,
        quantity_produced_pieces,expected_pieces,frozen_ingredient_cost_total,frozen_cost_per_piece,completed_at)
      values('${execution}','${product}','${batch}','v1','${uuid()}',1,10,10,120,12,clock_timestamp());
      insert into public.finished_stock_movements(product_id,production_execution_id,movement_type,on_hand_delta,reserved_delta,operation_id)
      values('${product}','${execution}','production_receipt',10,0,'${uuid()}');`);
    const loss = JSON.parse(asOwner(`select public.record_finished_stock_exception('${uuid()}','${product}','damage',-1,null,'race loss');`)).movements[0].finished_stock_movement_id as string;
    return { product, execution, loss };
  }
  // First request remains uncommitted after its RPC returns. Release it only after PostgreSQL
  // confirms the named competing request is waiting on a lock, rather than relying on sleeps.
  async function race(firstSql: string, secondSql: string) {
    const first = spawn("docker", ["exec","-i",container,"psql","-U","postgres","-v","ON_ERROR_STOP=1","-tA"], { stdio: ["pipe","pipe","pipe"] });
    let firstOutput = "";
    first.stdout.on("data", (chunk) => { firstOutput += chunk; });
    first.stderr.on("data", (chunk) => { firstOutput += chunk; });
    const firstDone = new Promise<{ code: number | null; output: string }>((resolve) => {
      first.on("error", (error) => resolve({ code: -1, output: String(error) }));
      first.on("close", (code) => resolve({ code, output: firstOutput }));
    });
    const timeoutMs = 15000;
    const watchdog = setTimeout(() => first.kill(), timeoutMs * 3);
    let secondDone: Promise<{ code: number | null; output: string }> | undefined;
    try {
      const ready = new Promise<void>((resolve,reject) => {
        const timer = setTimeout(() => reject(new Error(`first transaction sentinel timed out: ${firstOutput}`)),timeoutMs);
        first.stdout.on("data", () => { if (firstOutput.includes("FR2_LOCKED")) { clearTimeout(timer); resolve(); } });
        void firstDone.then((result) => { clearTimeout(timer); if (!result.output.includes("FR2_LOCKED")) reject(new Error(result.output)); });
      });
      first.stdin.write(`set idle_in_transaction_session_timeout='30s'; ${ownerSession} begin; ${firstSql}\n\\echo FR2_LOCKED\n`);
      await ready;
      const applicationName = `fr2-${uuid()}`;
      const second = spawn("docker", ["exec","-i",container,"psql","-U","postgres","-v","ON_ERROR_STOP=1","-tA"], { stdio: ["pipe","pipe","pipe"] });
      let secondOutput = "";
      second.stdout.on("data", (chunk) => { secondOutput += chunk; });
      second.stderr.on("data", (chunk) => { secondOutput += chunk; });
      secondDone = new Promise((resolve) => {
        second.on("error", (error) => resolve({ code: -1, output: String(error) }));
        second.on("close", (code) => resolve({ code, output: secondOutput }));
      });
      second.stdin.end(`set application_name='${applicationName}'; set statement_timeout='25s'; ${ownerSession} ${secondSql}`);
      let waiting = false;
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (q1(`select count(*) from pg_stat_activity where application_name='${applicationName}' and wait_event_type='Lock'`) === "1") { waiting = true; break; }
        await new Promise((resolve) => setTimeout(resolve,50));
      }
      assert.ok(waiting,"competing request must wait on held transaction");
      first.stdin.end("commit;\n");
      const [a,b] = await Promise.all([firstDone,secondDone]);
      assert.equal(a.code,0,a.output);
      return b;
    } finally {
      if (!first.stdin.destroyed && !first.stdin.writableEnded) first.stdin.end("rollback;\n");
      await firstDone;
      if (secondDone) await secondDone;
      clearTimeout(watchdog);
    }
  }

  await t.test("concurrent reversal receipt retries restore one lot and one financial credit exactly once", async () => {
    const f = fixture(); const op = uuid();
    const call = `select public.reverse_finished_stock_exception('${op}','${f.loss}','undo once');`;
    const second = await race(call,call);
    assert.equal(second.code,0,second.output);
    assert.equal(q1(`select sum(on_hand_delta) from public.finished_stock_movements where product_id='${f.product}'`),"10");
    assert.equal(q1(`select count(*) from public.finished_stock_movements where reverses_movement_id='${f.loss}'`),"1");
    assert.equal(Number(q1(`select sum(amount) from public.stock_financial_events where source_id in (select id from public.finished_stock_movements where product_id='${f.product}')`)),0);
  });
  await t.test("exact count racing reversal keeps new count and rejects the old loss reversal", async () => {
    const f = fixture(); const op = uuid();
    const items = JSON.stringify([{ product_id:f.product,physical_count:9,expected_on_hand_pieces:9,expected_reserved_pieces:0,expected_latest_movement_id:f.loss }]);
    const countSql = `select public.apply_finished_stock_reconciliation_batch('${op}',repeat('b',64),'${items}'::jsonb);`;
    const second = await race(countSql,`select public.reverse_finished_stock_exception('${uuid()}','${f.loss}','after racing count');`);
    assert.notEqual(second.code,0);
    assert.match(second.output,/superseded by a later physical count/);
    assert.equal(q1(`select sum(on_hand_delta) from public.finished_stock_movements where product_id='${f.product}'`),"9");
    assert.equal(q1(`select count(*) from public.finished_stock_count_boundaries where product_id='${f.product}'`),"1");
    assert.equal(q1(`select count(*) from public.finished_stock_movements where reverses_movement_id='${f.loss}'`),"0");
  });
  await t.test("concurrent classification reviews reject a stale expected review without altering quantity or cost", async () => {
    const f = fixture();
    const second = await race(`select public.classify_stock_financial_event('${uuid()}','finished','${f.loss}','household',null,'owner evidence A');`,
      `select public.classify_stock_financial_event('${uuid()}','finished','${f.loss}','marketing',null,'owner evidence B');`);
    assert.notEqual(second.code,0);
    assert.match(second.output,/reviewed since you opened it/);
    assert.equal(q1(`select count(*) from public.stock_financial_event_reviews where source_id='${f.loss}'`),"1");
    const event = JSON.parse(asOwner(`select row_to_json(e) from public.stock_financial_events e where source_id='${f.loss}';`));
    assert.equal(event.classification,"household");
    assert.equal(event.amount,12);
    assert.equal(event.quantity,1);
  });
});
