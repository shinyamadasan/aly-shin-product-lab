import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const root = path.resolve(import.meta.dirname, "../../..");
const sql = (file: string) => readFileSync(path.join(root, file), "utf8");
// Transaction-local (is_local = true): for the spawnPsqlAsync concurrency helpers, which wrap
// everything in one begin;...commit;. Matches every prior wave's smoke test.
const OWNER_JWT = `select set_config('request.jwt.claim.sub','88888888-8888-4888-8888-888888888888',true);
  select set_config('request.jwt.claim.app_role','owner',true);
  select set_config('request.jwt.claims','{"sub":"88888888-8888-4888-8888-888888888888","role":"authenticated","app_metadata":{"app_role":"owner"}}',true);`;
// Session-scoped (is_local = false): for run() calls, which execute each statement in its own
// autocommit transaction -- a transaction-local setting would not survive to the next statement.
const OWNER_SESSION = `set role authenticated;
  select set_config('request.jwt.claim.sub','88888888-8888-4888-8888-888888888888',false);
  select set_config('request.jwt.claim.app_role','owner',false);
  select set_config('request.jwt.claims','{"sub":"88888888-8888-4888-8888-888888888888","role":"authenticated","app_metadata":{"app_role":"owner"}}',false);`;

test("Cost Baseline Repair: durable cost-ready state, certification RPC, Bake guard, bounded backfill", { skip: process.env.RUN_POSTGRES_SMOKE !== "1" }, async (t) => {
  const container = `aly-cbr-${Date.now()}`;
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

  // Base environment + every prior wave, same bootstrap shape as
  // tests/smoke/postgres/selling-wave-1-production-execution.smoke.test.ts.
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
  run(sql("supabase/migrations/20260912090000_cost_baseline_repair.sql"));

  await t.test("single-shot invariants: certification RPC (happy path + every rejection), auto-backfill eligibility, Bake cost-readiness guard (A-F)", () => {
    const result = run(sql("tests/smoke/postgres/cost-baseline-repair.assertions.sql"));
    assert.match(result, /cost_baseline_repair_assertions_passed/);
  });

  function spawnPsqlAsync(input: string): Promise<{ stdout: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn("docker", ["exec", "-i", container, "psql", "-U", "postgres", "-tA"], { stdio: ["pipe", "pipe", "pipe"] });
      let out = "";
      child.stdout.on("data", (chunk) => { out += chunk; });
      child.stderr.on("data", (chunk) => { out += chunk; });
      child.on("error", reject);
      child.on("close", () => resolve({ stdout: out }));
      child.stdin.end(input);
    });
  }
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const owner = (extra = "") => `begin; set local role authenticated; ${OWNER_JWT} ${extra}`;
  const q1 = (statement: string) => run(statement).trim();

  function makeIngredient(qty: number, avgCost: number | null): string {
    const id = crypto.randomUUID();
    run(`insert into public.ingredients (id, name, base_unit, current_quantity, average_unit_cost, inventory_reconciled_at)
      values ('${id}', 'CBR Concurrency ${id.slice(0, 8)}', 'g', ${qty}, ${avgCost === null ? "null" : avgCost}, now());`);
    return id;
  }

  await t.test("two concurrent certification attempts against the same ingredient: exactly one succeeds, the stale second fails on expected-state mismatch, not silent last-write-wins", async () => {
    const ing = makeIngredient(100, 10);
    const a = spawnPsqlAsync(`${owner(`select id from public.ingredients where id = '${ing}' for update; select pg_sleep(1.0);`)} select public.certify_ingredient_cost_baseline('${ing}', 12, 'concurrent attempt A', 10, 100, null); commit;`);
    await sleep(300);
    const b = spawnPsqlAsync(`${owner()} select public.certify_ingredient_cost_baseline('${ing}', 15, 'concurrent attempt B', 10, 100, null); commit;`);
    const [ra, rb] = await Promise.all([a, b]);
    // Exactly one of the two succeeds; the other must see the row A already changed and fail its
    // own expected-value check (40001) -- never silently overwrite A's result.
    const aOk = !/ERROR/.test(ra.stdout);
    const bOk = !/ERROR/.test(rb.stdout);
    assert.notEqual(aOk, bOk, `exactly one concurrent certification should succeed (a ok=${aOk}, b ok=${bOk})`);
    const loserOutput = aOk ? rb.stdout : ra.stdout;
    assert.match(loserOutput, /Cost baseline changed/, "the losing attempt must fail on the expected-state check, not some other error");
    const finalCost = q1(`select average_unit_cost from public.ingredients where id = '${ing}'`);
    assert.equal(finalCost, aOk ? "12" : "15", "the final cost must be exactly the winner's value, not a blend of both");
    assert.equal(q1(`select count(*) from public.inventory_transactions where ingredient_id = '${ing}' and transaction_type = 'cost_certification'`), "1", "exactly one audit row, not two");
  });

  await t.test("certification racing with post_raw_purchase on the same ingredient: row locking serializes safely, no update lost", async () => {
    const ing = makeIngredient(100, 10);
    const purchase = spawnPsqlAsync(`${owner(`select id from public.ingredients where id = '${ing}' for update; select pg_sleep(1.0);`)} select public.post_raw_purchase('${crypto.randomUUID()}', '${ing}', 100, 'g', 100, 1000, 'B', 'S', current_date, 5, 'p'); commit;`);
    await sleep(300);
    const certify = spawnPsqlAsync(`${owner()} select public.certify_ingredient_cost_baseline('${ing}', 12, 'certify while a purchase is in flight', 10, 100, null); commit;`);
    const [rp, rc] = await Promise.all([purchase, certify]);
    const purchaseOk = !/ERROR/.test(rp.stdout);
    const certifyOk = !/ERROR/.test(rc.stdout);
    // Serialized by the same row lock both functions take -- whichever ran second sees the first's
    // committed result and either succeeds against it (purchase reads whatever cost certify left,
    // or certify's optimistic-concurrency check catches a cost the purchase just changed) or fails
    // cleanly on the expected-value check. Either order is safe; neither may silently clobber the
    // other's write.
    assert.ok(purchaseOk, `post_raw_purchase should not error in this race: ${rp.stdout}`);
    if (!certifyOk) {
      assert.match(rc.stdout, /Cost baseline changed/, "certify's failure (if any) must be the expected-state check, not a lock/deadlock error");
    }
    // current_quantity must reflect exactly the one purchase (100 + 100 = 200), never doubled or lost.
    assert.equal(q1(`select current_quantity from public.ingredients where id = '${ing}'`), "200");
  });

  await t.test("safe purchase after certification: the certified baseline is not required to be re-certified after a legitimate new purchase", () => {
    const ing = makeIngredient(100, 10);
    run(`${OWNER_SESSION} select public.certify_ingredient_cost_baseline('${ing}', 10, 'initial certification', 10, 100, null); reset role;`);
    const beforeReconciledAt = q1(`select cost_reconciled_at from public.ingredients where id = '${ing}'`);
    assert.notEqual(beforeReconciledAt, "", "cost_reconciled_at must be set after certification");

    run(`${OWNER_SESSION} select public.post_raw_purchase('${crypto.randomUUID()}', '${ing}', 100, 'g', 100, 2000, 'B', 'S', current_date, 5, 'p'); reset role;`);

    assert.equal(Number(q1(`select average_unit_cost from public.ingredients where id = '${ing}'`)), 15, "(100*10 + 2000) / 200 = 15");
    assert.equal(q1(`select current_quantity from public.ingredients where id = '${ing}'`), "200");
    assert.equal(q1(`select cost_reconciled_at from public.ingredients where id = '${ing}'`), beforeReconciledAt, "a legitimate purchase must not clear or change cost_reconciled_at -- certification survives it unchanged");

    // Same for the quantity side: a physical-count reconciliation must not clear cost_reconciled_at.
    const latestTxId = q1(`select id from public.inventory_transactions where ingredient_id = '${ing}' order by created_at desc, id desc limit 1`);
    run(`${OWNER_SESSION} select public.apply_raw_inventory_adjustment('${ing}', 200, 'count', null, 'recount', 200, '${latestTxId}', 'g'); reset role;`);
    assert.equal(q1(`select cost_reconciled_at from public.ingredients where id = '${ing}'`), beforeReconciledAt, "a quantity reconciliation must not clear cost_reconciled_at -- quantity truth and cost truth stay independent");
  });
});
