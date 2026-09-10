import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const root = path.resolve(import.meta.dirname, "../../..");
const sql = (file: string) => readFileSync(path.join(root, file), "utf8");
// Transaction-local (is_local = true): for the spawnPsqlAsync concurrency helpers, which wrap
// everything in one begin;...commit;.
const OWNER_JWT = `select set_config('request.jwt.claim.sub','55555555-5555-4555-8555-555555555555',true);
  select set_config('request.jwt.claim.app_role','owner',true);
  select set_config('request.jwt.claims','{"sub":"55555555-5555-4555-8555-555555555555","role":"authenticated","app_metadata":{"app_role":"owner"}}',true);`;
// Session-scoped (is_local = false): for run() calls, which execute each statement in its own
// autocommit transaction -- a transaction-local setting would not survive to the next statement.
const OWNER_SESSION = `set role authenticated;
  select set_config('request.jwt.claim.sub','55555555-5555-4555-8555-555555555555',false);
  select set_config('request.jwt.claim.app_role','owner',false);
  select set_config('request.jwt.claims','{"sub":"55555555-5555-4555-8555-555555555555","role":"authenticated","app_metadata":{"app_role":"owner"}}',false);`;

test("Wave 1 makes a real Bake one atomic production event: raw consumed + production execution + finished-stock receipt + frozen cost", { skip: process.env.RUN_POSTGRES_SMOKE !== "1" }, async (t) => {
  const container = `aly-wave1-${Date.now()}`;
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

  // Base environment, same shape Wave 0A/0B smoke tests build.
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
  // Minimal products / product_batches -- only the columns confirm_bake_v3 reads and writes.
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

  await t.test("single-shot invariants: atomicity, observed-piece finished quantity, idempotency, gate, all-or-nothing, cost freeze, immutability, authority", () => {
    const result = run(sql("tests/smoke/postgres/selling-wave-1-production-execution.assertions.sql"));
    assert.match(result, /wave_1_assertions_passed/);
  });

  // Reusable fixture for the concurrency / fault sub-tests: a product, a v1 batch (yield 9),
  // and a set of reconciled ingredients with plenty of stock unless a test says otherwise.
  function makeFixture(opts: { flour?: number; egg?: number } = {}) {
    const product = `p-${crypto.randomUUID().slice(0, 8)}`;
    const batch = crypto.randomUUID();
    const flour = crypto.randomUUID();
    const egg = crypto.randomUUID();
    run(`insert into public.products (id, name) values ('${product}', 'Test ${product}');
      insert into public.product_batches (id, product_id, batch_version, status, usable_pieces) values ('${batch}', '${product}', 'v1', 'completed', 9);
      insert into public.ingredients (id, name, base_unit, current_quantity, average_unit_cost, inventory_reconciled_at) values
        ('${flour}', 'F ${product}', 'g', ${opts.flour ?? 5000}, 2.0, now()),
        ('${egg}', 'E ${product}', 'pcs', ${opts.egg ?? 200}, 10.0, now());`);
    return { product, batch, flour, egg };
  }
  const deductionsJson = (flour: string, egg: string, f = 500, e = 6) =>
    `jsonb_build_array(jsonb_build_object('ingredient_id','${flour}','quantity',${f}), jsonb_build_object('ingredient_id','${egg}','quantity',${e}))`;

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
  const q1 = (s: string) => run(s).trim();

  await t.test("same operation id, two real overlapping calls: exactly one production event", async () => {
    const f = makeFixture();
    const op = crypto.randomUUID();
    // No pre-lock: two calls with the same operation id fired near-simultaneously. The idempotency
    // claim (INSERT ... ON CONFLICT DO NOTHING on the mutation_receipts primary key) serializes
    // them -- whichever claims first does the work, the other blocks on the claim row then replays
    // its stored result. The UNIQUE constraint on production_executions.operation_id is the backstop.
    const callBody = `begin; set local role authenticated; ${OWNER_JWT} select public.confirm_bake_v3('${op}', '${f.batch}', '${f.product}', 'B', 1, 9, ${deductionsJson(f.flour, f.egg)}); commit;`;
    const a = spawnPsqlAsync(callBody);
    await sleep(20);
    const b = spawnPsqlAsync(callBody);
    const [ra, rb] = await Promise.all([a, b]);
    assert.doesNotMatch(ra.stdout, /ERROR/);
    assert.doesNotMatch(rb.stdout, /ERROR/);
    assert.equal(q1(`select count(*) from public.production_executions where operation_id = '${op}'`), "1");
    assert.equal(q1(`select coalesce(sum(on_hand_delta),0) from public.finished_stock_movements where product_id = '${f.product}'`), "9");
    assert.equal(q1(`select count(*) from public.inventory_transactions where source_id = '${f.batch}' and transaction_type = 'consume'`), "2");
  });

  await t.test("two independent Bakes, stock sufficient for both: two executions, combined finished stock", async () => {
    const f = makeFixture();
    const opA = crypto.randomUUID(); const opB = crypto.randomUUID();
    const a = spawnPsqlAsync(`${owner(`select id from public.product_batches where id = '${f.batch}' for update; select pg_sleep(1.0);`)} select public.confirm_bake_v3('${opA}', '${f.batch}', '${f.product}', 'A', 1, 9, ${deductionsJson(f.flour, f.egg)}); commit;`);
    await sleep(300);
    const b = spawnPsqlAsync(`${owner()} select public.confirm_bake_v3('${opB}', '${f.batch}', '${f.product}', 'B', 1, 9, ${deductionsJson(f.flour, f.egg)}); commit;`);
    const [ra, rb] = await Promise.all([a, b]);
    assert.doesNotMatch(ra.stdout, /ERROR/);
    assert.doesNotMatch(rb.stdout, /ERROR/);
    assert.equal(q1(`select count(*) from public.production_executions where product_id = '${f.product}'`), "2");
    assert.equal(q1(`select coalesce(sum(on_hand_delta),0) from public.finished_stock_movements where product_id = '${f.product}'`), "18");
  });

  await t.test("two independent Bakes, stock sufficient for only one: exactly one succeeds, loser creates nothing", async () => {
    const f = makeFixture({ flour: 600 }); // enough for one 500g Bake, not two
    const opA = crypto.randomUUID(); const opB = crypto.randomUUID();
    const a = spawnPsqlAsync(`${owner(`select id from public.product_batches where id = '${f.batch}' for update; select pg_sleep(1.2);`)} select public.confirm_bake_v3('${opA}', '${f.batch}', '${f.product}', 'A', 1, 9, ${deductionsJson(f.flour, f.egg)}); commit;`);
    await sleep(300);
    const b = spawnPsqlAsync(`${owner()} do $$ begin
      perform public.confirm_bake_v3('${opB}', '${f.batch}', '${f.product}', 'B', 1, 9, ${deductionsJson(f.flour, f.egg)});
      raise notice 'bake_b_unexpectedly_succeeded';
    exception when check_violation then raise notice 'bake_b_rejected_as_expected'; end $$; commit;`);
    const [ra, rb] = await Promise.all([a, b]);
    assert.doesNotMatch(ra.stdout, /ERROR/);
    assert.match(rb.stdout, /bake_b_rejected_as_expected/);
    assert.doesNotMatch(rb.stdout, /bake_b_unexpectedly_succeeded/);
    assert.equal(q1(`select count(*) from public.production_executions where product_id = '${f.product}'`), "1");
    assert.equal(q1(`select coalesce(sum(on_hand_delta),0) from public.finished_stock_movements where product_id = '${f.product}'`), "9");
    assert.equal(q1(`select current_quantity from public.ingredients where id = '${f.flour}'`), "100"); // 600 - 500
  });

  await t.test("purchase vs production Bake on a shared ingredient: coherent serialized result", async () => {
    const f = makeFixture({ flour: 1000 });
    const opP = crypto.randomUUID(); const opB = crypto.randomUUID();
    const p = spawnPsqlAsync(`${owner(`select id from public.ingredients where id = '${f.flour}' for update; select pg_sleep(1.2);`)} select public.post_raw_purchase('${opP}', '${f.flour}', 500, 'g', 500, 500, 'L', 'S', current_date, 5, 'p'); commit;`);
    await sleep(300);
    const b = spawnPsqlAsync(`${owner()} select public.confirm_bake_v3('${opB}', '${f.batch}', '${f.product}', 'B', 1, 9, ${deductionsJson(f.flour, f.egg)}); commit;`);
    const [rp, rb] = await Promise.all([p, b]);
    assert.doesNotMatch(rp.stdout, /ERROR/);
    assert.doesNotMatch(rb.stdout, /ERROR/);
    assert.equal(q1(`select current_quantity from public.ingredients where id = '${f.flour}'`), "1000"); // 1000 + 500 - 500
    assert.equal(q1(`select coalesce(sum(on_hand_delta),0) from public.finished_stock_movements where product_id = '${f.product}'`), "9");
  });

  await t.test("Wave 0A adjustment vs production Bake on a shared ingredient: coherent serialized result", async () => {
    const f = makeFixture({ flour: 2000 });
    const opB = crypto.randomUUID();
    const adj = spawnPsqlAsync(`${owner(`select id from public.ingredients where id = '${f.flour}' for update; select pg_sleep(1.2);`)}
      select public.apply_raw_inventory_adjustment('${f.flour}', -200, 'delta', 'waste_or_spoilage', 'spill', 2000, null, 'g'); commit;`);
    await sleep(300);
    const b = spawnPsqlAsync(`${owner()} select public.confirm_bake_v3('${opB}', '${f.batch}', '${f.product}', 'B', 1, 9, ${deductionsJson(f.flour, f.egg)}); commit;`);
    const [radj, rb] = await Promise.all([adj, b]);
    assert.doesNotMatch(radj.stdout, /ERROR/);
    assert.doesNotMatch(rb.stdout, /ERROR/);
    assert.equal(q1(`select current_quantity from public.ingredients where id = '${f.flour}'`), "1300"); // 2000 - 200 adj - 500 bake
    assert.equal(q1(`select coalesce(sum(on_hand_delta),0) from public.finished_stock_movements where product_id = '${f.product}'`), "9");
  });

  // Fault injection: a trigger raises AFTER meaningful writes have already happened in the same
  // transaction. Everything must roll back and the operation id stays retryable.
  const faultTargets: Record<string, string> = {
    A_before_execution: "public.production_executions",
    B_before_finished_stock: "public.finished_stock_movements",
    C_before_result: "inventory_private.mutation_receipts",
  };
  const faultEvent: Record<string, string> = {
    A_before_execution: "before insert",
    B_before_finished_stock: "before insert",
    C_before_result: "before update",
  };
  for (const point of ["A_before_execution", "B_before_finished_stock", "C_before_result"] as const) {
    await t.test(`fault injection at ${point}: full rollback, operation id retryable`, () => {
      const f = makeFixture();
      const op = crypto.randomUUID();
      // Persistent (not pg_temp) fault objects so they survive across separate psql sessions.
      run(`create function public.w1_fault_${point}() returns trigger language plpgsql as $fn$ begin raise exception 'injected'; end $fn$;
        create trigger w1_fault_trg ${faultEvent[point]} on ${faultTargets[point]} for each row execute function public.w1_fault_${point}();`);
      // The do-block swallows the injected exception -- proof of rollback is entirely in the
      // table state below (nothing persisted) plus the clean retry afterwards.
      const attempt = run(`${OWNER_SESSION}
        do $$ begin
          perform public.confirm_bake_v3('${op}', '${f.batch}', '${f.product}', 'B', 1, 9, ${deductionsJson(f.flour, f.egg)});
        exception when others then null; end $$;
        select 'attempt_done'; reset role;`);
      assert.match(attempt, /attempt_done/);
      // Nothing persisted.
      assert.equal(q1(`select current_quantity from public.ingredients where id = '${f.flour}'`), "5000");
      assert.equal(q1(`select count(*) from public.inventory_transactions where source_id = '${f.batch}'`), "0");
      assert.equal(q1(`select count(*) from public.production_executions where product_id = '${f.product}'`), "0");
      assert.equal(q1(`select count(*) from public.finished_stock_movements where product_id = '${f.product}'`), "0");
      assert.equal(q1(`select count(*) from inventory_private.mutation_receipts where operation_id = '${op}'`), "0", "failed attempt left no stuck claim");
      // Remove the fault, retry the SAME operation id -> one clean production.
      run(`drop trigger w1_fault_trg on ${faultTargets[point]}; drop function public.w1_fault_${point}();`);
      const retry = run(`${OWNER_SESSION}
        select public.confirm_bake_v3('${op}', '${f.batch}', '${f.product}', 'B', 1, 9, ${deductionsJson(f.flour, f.egg)}); reset role;`);
      assert.doesNotMatch(retry, /ERROR/);
      assert.equal(q1(`select count(*) from public.production_executions where operation_id = '${op}'`), "1");
      assert.equal(q1(`select coalesce(sum(on_hand_delta),0) from public.finished_stock_movements where product_id = '${f.product}'`), "9");
      assert.equal(q1(`select current_quantity from public.ingredients where id = '${f.flour}'`), "4500");
    });
  }

  await t.test("follow one brownie with OBSERVED output: actual 8 -> retry 8 -> +9 = 17 -> recipe edited, history frozen -> insufficient 3rd Bake -> still 17", () => {
    const f = makeFixture({ flour: 1200, egg: 30 }); // enough for two 500g/6pc Bakes, not three
    const op1 = crypto.randomUUID(); const op2 = crypto.randomUUID(); const op3 = crypto.randomUUID();
    // Recipe expects 9; the operator records what physically came out usable each run.
    const call = (op: string, actual: number) => `select public.confirm_bake_v3('${op}', '${f.batch}', '${f.product}', 'Brownie v1', 1, ${actual}, ${deductionsJson(f.flour, f.egg)});`;
    assert.equal(q1(`select current_quantity from public.ingredients where id = '${f.flour}'`), "1200");

    run(`${OWNER_SESSION} ${call(op1, 8)} reset role;`);
    assert.equal(q1(`select coalesce(sum(on_hand_delta),0) from public.finished_stock_movements where product_id = '${f.product}'`), "8", "Bake #1: observed 8 into finished stock, not the projected 9");
    assert.equal(q1(`select quantity_produced_pieces from public.production_executions where operation_id = '${op1}'`), "8");
    assert.equal(q1(`select expected_pieces from public.production_executions where operation_id = '${op1}'`), "9", "expected yield frozen alongside as reference");
    assert.equal(q1(`select current_quantity from public.ingredients where id = '${f.flour}'`), "700", "raw consumed once for the requested Bake");
    const frozenCost1 = q1(`select frozen_ingredient_cost_total from public.production_executions where operation_id = '${op1}'`);
    // per-piece cost divides the raw cost by the observed 8
    assert.equal(q1(`select round(frozen_cost_per_piece, 4) = round(${frozenCost1}::numeric / 8, 4) from public.production_executions where operation_id = '${op1}'`), "t");

    run(`${OWNER_SESSION} ${call(op1, 8)} reset role;`); // exact retry
    assert.equal(q1(`select coalesce(sum(on_hand_delta),0) from public.finished_stock_movements where product_id = '${f.product}'`), "8", "retry stays 8");
    assert.equal(q1(`select count(*) from public.production_executions where product_id = '${f.product}'`), "1");
    assert.equal(q1(`select current_quantity from public.ingredients where id = '${f.flour}'`), "700", "retry did not re-consume");

    run(`${OWNER_SESSION} ${call(op2, 9)} reset role;`); // second distinct Bake, this one hit the recipe number
    assert.equal(q1(`select coalesce(sum(on_hand_delta),0) from public.finished_stock_movements where product_id = '${f.product}'`), "17", "Bake #2 observed 9: finished stock 8 + 9 = 17");

    run(`update public.product_batches set usable_pieces = 4 where id = '${f.batch}';`); // recipe edit
    assert.equal(q1(`select quantity_produced_pieces from public.production_executions where operation_id = '${op1}'`), "8", "historical observed quantity frozen");
    assert.equal(q1(`select expected_pieces from public.production_executions where operation_id = '${op1}'`), "9", "historical expected yield frozen");
    assert.equal(q1(`select frozen_ingredient_cost_total from public.production_executions where operation_id = '${op1}'`), frozenCost1, "historical cost frozen");
    run(`update public.product_batches set usable_pieces = 9 where id = '${f.batch}';`);

    let thirdBakeError = "";
    try {
      run(`${OWNER_SESSION} ${call(op3, 9)} reset role;`);
    } catch (err) {
      thirdBakeError = String((err as { stderr?: string }).stderr ?? (err as Error).message);
    }
    assert.match(thirdBakeError, /Not enough stock/, "the insufficient third Bake must be rejected");
    assert.equal(q1(`select coalesce(sum(on_hand_delta),0) from public.finished_stock_movements where product_id = '${f.product}'`), "17", "insufficient 3rd Bake: still 17");
    assert.equal(q1(`select count(*) from public.production_executions where product_id = '${f.product}'`), "2");
  });

  await t.test("observed count is part of the idempotency payload: same op id + changed count is a changed-payload rejection", () => {
    const f = makeFixture();
    const op = crypto.randomUUID();
    const call = (actual: number) => `select public.confirm_bake_v3('${op}', '${f.batch}', '${f.product}', 'B', 1, ${actual}, ${deductionsJson(f.flour, f.egg)});`;
    run(`${OWNER_SESSION} ${call(8)} reset role;`);
    assert.equal(q1(`select quantity_produced_pieces from public.production_executions where operation_id = '${op}'`), "8");
    run(`${OWNER_SESSION} ${call(8)} reset role;`); // exact retry replays
    assert.equal(q1(`select count(*) from public.production_executions where operation_id = '${op}'`), "1");
    let changedError = "";
    try {
      run(`${OWNER_SESSION} ${call(9)} reset role;`);
    } catch (err) {
      changedError = String((err as { stderr?: string }).stderr ?? (err as Error).message);
    }
    assert.match(changedError, /already used for a different request/, "a corrected count must be a new operation, not a rewrite");
    assert.equal(q1(`select quantity_produced_pieces from public.production_executions where operation_id = '${op}'`), "8", "the completed execution is untouched");
  });

  await t.test("invalid observed counts are rejected before any raw consumption, execution, or finished-stock receipt", () => {
    const f = makeFixture();
    const call = (actual: string) => `select public.confirm_bake_v3('${crypto.randomUUID()}', '${f.batch}', '${f.product}', 'B', 1, ${actual}, ${deductionsJson(f.flour, f.egg)});`;
    for (const bad of ["null", "0", "-2", "4.5", "'NaN'::numeric"]) {
      let err = "";
      try { run(`${OWNER_SESSION} ${call(bad)} reset role;`); } catch (e) { err = String((e as { stderr?: string }).stderr ?? (e as Error).message); }
      assert.match(err, /Enter the actual usable pieces produced|whole number of at least 1/, `rejected: actual = ${bad}`);
    }
    assert.equal(q1(`select current_quantity from public.ingredients where id = '${f.flour}'`), "5000", "no raw consumed");
    assert.equal(q1(`select count(*) from public.production_executions where product_id = '${f.product}'`), "0");
    assert.equal(q1(`select count(*) from public.finished_stock_movements where product_id = '${f.product}'`), "0");
  });
});
