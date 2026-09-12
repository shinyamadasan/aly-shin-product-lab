import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const root = path.resolve(import.meta.dirname, "../../..");
const sql = (file: string) => readFileSync(path.join(root, file), "utf8");
const OWNER_SESSION = `set role authenticated;
  select set_config('request.jwt.claim.sub','99999999-9999-4999-8999-999999999999',false);
  select set_config('request.jwt.claim.app_role','owner',false);
  select set_config('request.jwt.claims','{"sub":"99999999-9999-4999-8999-999999999999","role":"authenticated","app_metadata":{"app_role":"owner"}}',false);`;

test("Claude Inventory Operator V1A database boundary", { skip: process.env.RUN_POSTGRES_SMOKE !== "1" }, async (t) => {
  const container = `aly-inventory-operator-${Date.now()}`;
  execFileSync("docker", ["run", "-d", "--name", container, "-e", "POSTGRES_PASSWORD=test-only", "postgres:17-alpine"], { stdio: "pipe" });
  t.after(() => execFileSync("docker", ["rm", "-f", container], { stdio: "pipe" }));
  const run = (input: string) => execFileSync("docker", ["exec", "-i", container, "psql", "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-tA"], { input, encoding: "utf8", stdio: "pipe" });
  const q1 = (input: string) => run(input).trim().split(/\r?\n/).at(-1) ?? "";
  let ready = false;
  for (let attempt = 0; attempt < 90; attempt++) {
    try { if (q1("select 1") === "1") { ready = true; break; } } catch { /* container starting */ }
    await new Promise((resolve) => setTimeout(resolve, 500));
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
      batch_version text not null, status text not null default 'draft', completed_at timestamptz,
      voided_at timestamptz, usable_pieces integer, updated_at timestamptz);
    alter table public.products enable row level security;
    alter table public.product_batches enable row level security;
    grant select, insert, update, delete on public.products, public.product_batches to authenticated;
    create policy p_products on public.products for all to authenticated using (public.is_product_lab_owner()) with check (public.is_product_lab_owner());
    create policy p_batches on public.product_batches for all to authenticated using (public.is_product_lab_owner()) with check (public.is_product_lab_owner());`);
  run(sql("supabase/migrations/20260909132327_selling_wave_0a_raw_authority.sql"));
  run(sql("supabase/migrations/20260909162224_selling_wave_0a_reversal_boundary.sql"));
  run(sql("supabase/migrations/20260910022601_selling_wave_0b_safe_mutations.sql"));
  run(sql("supabase/migrations/20260910120146_selling_wave_1_production_execution.sql"));
  run(sql("supabase/migrations/20260912090000_cost_baseline_repair.sql"));
  run(sql("supabase/migrations/20260912193053_claude_inventory_operator_v1a.sql"));

  const makeIngredient = (name: string, quantity = 100, certified = true, id = crypto.randomUUID()) => {
    run(`insert into public.ingredients (id,name,base_unit,current_quantity,average_unit_cost,inventory_reconciled_at,cost_reconciled_at)
      values ('${id}','${name}','g',${quantity},1,now(),${certified ? "now()" : "null"})`);
    return id;
  };
  const hash = (value: string) => crypto.createHash("sha256").update(value).digest("hex");
  const row = (ingredientId: string, counted: number, expected = 100, latest: string | null = null) => ({
    ingredient_id: ingredientId, counted_quantity: counted, expected_quantity: expected,
    expected_latest_id: latest, expected_unit: "g", note: `test count ${ingredientId}`,
  });
  const call = (operationId: string, payloadHash: string, rows: unknown[]) =>
    `${OWNER_SESSION} select public.apply_inventory_physical_count_batch('${operationId}','${payloadHash}','${JSON.stringify(rows)}'::jsonb);`;

  await t.test("multi-item success is atomic and every ledger quantity is truthful", () => {
    const a = makeIngredient("Batch A");
    const b = makeIngredient("Batch B");
    const result = JSON.parse(q1(call(crypto.randomUUID(), hash("multi"), [row(b, 80), row(a, 120)])));
    assert.equal(result.applied_reconciliation_events, 2);
    assert.equal(q1(`select current_quantity from ingredients where id='${a}'`), "120");
    assert.equal(q1(`select current_quantity from ingredients where id='${b}'`), "80");
    assert.equal(q1(`select count(*) from inventory_transactions where id in ('${result.rows[0].transaction_id}','${result.rows[1].transaction_id}') and quantity_before + quantity_change = quantity_after`), "2");
  });

  await t.test("one stale row rolls back the entire batch and its receipt", () => {
    const a = makeIngredient("Rollback A");
    const b = makeIngredient("Rollback B");
    const operationId = crypto.randomUUID();
    assert.throws(() => run(call(operationId, hash("stale"), [row(a, 110), row(b, 90, 999)])), /Inventory changed/);
    assert.equal(q1(`select current_quantity from ingredients where id='${a}'`), "100");
    assert.equal(q1(`select count(*) from inventory_transactions where ingredient_id in ('${a}','${b}')`), "0");
    assert.equal(q1(`select count(*) from inventory_private.mutation_receipts where operation_id='${operationId}'`), "0");
  });

  await t.test("a valid-stale-valid three-row batch rolls back quantities, ledger, receipt, and certifications", () => {
    const a = makeIngredient("Three A", 100, true, "10000000-0000-4000-8000-000000000001");
    const b = makeIngredient("Three B", 100, false, "20000000-0000-4000-8000-000000000002");
    const c = makeIngredient("Three C", 100, true, "30000000-0000-4000-8000-000000000003");
    const operationId = crypto.randomUUID();
    const certificationBefore = q1(`select jsonb_agg(jsonb_build_object('id',id,'cost',cost_reconciled_at) order by id) from ingredients where id in ('${a}','${b}','${c}')`);
    assert.throws(() => run(call(operationId, hash("three-row-stale-middle"), [row(a, 110), row(b, 90, 999), row(c, 120)])), /Inventory changed/);
    assert.equal(q1(`select jsonb_agg(current_quantity order by id) from ingredients where id in ('${a}','${b}','${c}')`), "[100, 100, 100]");
    assert.equal(q1(`select count(*) from inventory_transactions where ingredient_id in ('${a}','${b}','${c}')`), "0");
    assert.equal(q1(`select count(*) from inventory_private.mutation_receipts where operation_id='${operationId}'`), "0");
    assert.equal(q1(`select jsonb_agg(jsonb_build_object('id',id,'cost',cost_reconciled_at) order by id) from ingredients where id in ('${a}','${b}','${c}')`), certificationBefore);
  });

  await t.test("same operation retry and lost-response retry replay without duplicate ledger writes", () => {
    const ingredientId = makeIngredient("Replay");
    const operationId = crypto.randomUUID();
    const statement = call(operationId, hash("replay"), [row(ingredientId, 105)]);
    const first = q1(statement);
    const retry = q1(statement);
    assert.deepEqual(JSON.parse(retry), JSON.parse(first));
    assert.equal(q1(`select count(*) from inventory_transactions where ingredient_id='${ingredientId}'`), "1");
  });

  await t.test("same source occurrence operation with changed payload is rejected", () => {
    const ingredientId = makeIngredient("Changed payload");
    const operationId = crypto.randomUUID();
    run(call(operationId, hash("original"), [row(ingredientId, 105)]));
    assert.throws(() => run(call(operationId, hash("changed"), [row(ingredientId, 106, 105)])), /different request/);
    assert.equal(q1(`select count(*) from inventory_transactions where ingredient_id='${ingredientId}'`), "1");
  });

  await t.test("positive count clears certification; shrinkage and exact recount preserve it", () => {
    const positive = makeIngredient("Positive");
    const shrinkage = makeIngredient("Shrinkage");
    const exact = makeIngredient("Exact");
    run(call(crypto.randomUUID(), hash("positive"), [row(positive, 110)]));
    run(call(crypto.randomUUID(), hash("shrinkage"), [row(shrinkage, 90)]));
    run(call(crypto.randomUUID(), hash("exact"), [row(exact, 100)]));
    assert.equal(q1(`select cost_reconciled_at is null from ingredients where id='${positive}'`), "t");
    assert.equal(q1(`select cost_reconciled_at is not null from ingredients where id='${shrinkage}'`), "t");
    assert.equal(q1(`select cost_reconciled_at is not null from ingredients where id='${exact}'`), "t");
    assert.equal(q1(`select count(*) from inventory_transactions where ingredient_id='${exact}' and quantity_change=0`), "1");
  });

  function spawnPsql(input: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn("docker", ["exec", "-i", container, "psql", "-U", "postgres", "-tA"], { stdio: ["pipe", "pipe", "pipe"] });
      let output = "";
      child.stdout.on("data", (chunk) => { output += chunk; });
      child.stderr.on("data", (chunk) => { output += chunk; });
      child.on("error", reject);
      child.on("close", () => resolve(output));
      child.stdin.end(input);
    });
  }

  const lastLine = (output: string) => output.trim().split(/\r?\n/).at(-1) ?? "";

  await t.test("a batch racing a legitimate adjustment has one valid outcome and no impossible state", async () => {
    const shared = makeIngredient("Race Shared");
    const other = makeIngredient("Race Other");
    const operationId = crypto.randomUUID();
    const batch = spawnPsql(call(operationId, hash("batch-vs-adjustment"), [row(other, 110), row(shared, 120)]));
    const adjustment = spawnPsql(`${OWNER_SESSION}
      select public.apply_raw_inventory_adjustment('${shared}', -10, 'delta', 'other', 'legitimate race adjustment', 100, null, 'g');`);
    const results = await Promise.all([batch, adjustment]);
    assert.ok(results.every((result) => !/deadlock/i.test(result)));
    assert.equal(results.filter((result) => !/ERROR/.test(result)).length, 1);
    assert.equal(results.filter((result) => /Inventory changed/.test(result)).length, 1);
    const sharedAfter = q1(`select current_quantity from ingredients where id='${shared}'`);
    const otherAfter = q1(`select current_quantity from ingredients where id='${other}'`);
    if (sharedAfter === "120") {
      assert.equal(otherAfter, "110");
      assert.equal(q1(`select count(*) from inventory_transactions where ingredient_id in ('${shared}','${other}')`), "2");
      assert.equal(q1(`select count(*) from inventory_private.mutation_receipts where operation_id='${operationId}'`), "1");
    } else {
      assert.equal(sharedAfter, "90");
      assert.equal(otherAfter, "100");
      assert.equal(q1(`select count(*) from inventory_transactions where ingredient_id in ('${shared}','${other}')`), "1");
      assert.equal(q1(`select count(*) from inventory_private.mutation_receipts where operation_id='${operationId}'`), "0");
    }
  });

  await t.test("concurrent identical retries return one result, one receipt, and no duplicate ledger events", async () => {
    const a = makeIngredient("Concurrent Retry A");
    const b = makeIngredient("Concurrent Retry B");
    const operationId = crypto.randomUUID();
    const statement = call(operationId, hash("concurrent-identical"), [row(b, 80), row(a, 120)]);
    const results = await Promise.all([spawnPsql(statement), spawnPsql(statement)]);
    assert.ok(results.every((result) => !/ERROR/.test(result)), results.join("\n"));
    assert.deepEqual(JSON.parse(lastLine(results[0])), JSON.parse(lastLine(results[1])));
    assert.equal(q1(`select count(*) from inventory_private.mutation_receipts where operation_id='${operationId}'`), "1");
    assert.equal(q1(`select count(*) from inventory_transactions where ingredient_id in ('${a}','${b}')`), "2");
  });

  await t.test("overlapping batches use deterministic lock order and never deadlock", async () => {
    const low = makeIngredient("Lock Low");
    const high = makeIngredient("Lock High");
    const a = spawnPsql(call(crypto.randomUUID(), hash("lock-a"), [row(high, 101), row(low, 101)]));
    const b = spawnPsql(call(crypto.randomUUID(), hash("lock-b"), [row(low, 102), row(high, 102)]));
    const results = await Promise.all([a, b]);
    assert.equal(results.filter((result) => !/ERROR/.test(result)).length, 1);
    assert.equal(results.filter((result) => /Inventory changed/.test(result)).length, 1);
    assert.ok(results.every((result) => !/deadlock/i.test(result)));
    assert.equal(q1(`select count(*) from inventory_transactions where ingredient_id in ('${low}','${high}')`), "2");
  });

  await t.test("owner gate rejects non-owner and missing authentication", () => {
    const ingredientId = makeIngredient("Auth gate");
    const args = `'${crypto.randomUUID()}','${hash("auth")}', '${JSON.stringify([row(ingredientId, 100)])}'::jsonb`;
    assert.throws(() => run(`set role authenticated; select set_config('request.jwt.claim.sub','88888888-8888-4888-8888-888888888888',false); select set_config('request.jwt.claim.app_role','staff',false); select public.apply_inventory_physical_count_batch(${args});`), /Only the product lab owner/);
    assert.throws(() => run(`set role authenticated; select public.apply_inventory_physical_count_batch(${args});`), /Only the product lab owner/);
    assert.equal(q1(`select count(*) from inventory_transactions where ingredient_id='${ingredientId}'`), "0");
  });
});
