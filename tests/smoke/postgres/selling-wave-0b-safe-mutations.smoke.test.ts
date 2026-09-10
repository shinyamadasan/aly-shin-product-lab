import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const root = path.resolve(import.meta.dirname, "../../..");
const sql = (file: string) => readFileSync(path.join(root, file), "utf8");
const OWNER_JWT = `select set_config('request.jwt.claim.sub','33333333-3333-4333-8333-333333333333',true);
  select set_config('request.jwt.claim.app_role','owner',true);
  select set_config('request.jwt.claims','{"sub":"33333333-3333-4333-8333-333333333333","role":"authenticated","app_metadata":{"app_role":"owner"}}',true);`;

test("Wave 0B makes purchase posting, CSV confirmation, and Bake consumption database-authoritative, idempotent, and concurrency-safe", { skip: process.env.RUN_POSTGRES_SMOKE !== "1" }, async (t) => {
  const container = `aly-wave0b-${Date.now()}`;
  execFileSync("docker", ["run", "-d", "--name", container, "-e", "POSTGRES_PASSWORD=test-only", "postgres:17-alpine"], { stdio: "pipe" });
  t.after(() => execFileSync("docker", ["rm", "-f", container], { stdio: "pipe" }));
  const run = (input: string) => execFileSync("docker", ["exec", "-i", container, "psql", "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-tA"], { input, encoding: "utf8", stdio: "pipe" });
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try { run("select 1"); ready = true; break; } catch { await new Promise((resolve) => setTimeout(resolve, 1000)); }
  }
  assert.ok(ready, "PostgreSQL must start; an unavailable database is not a passing test");

  // Same minimal base environment Wave 0A's own smoke test builds -- see that file's own comment.
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
  run(sql("supabase/migrations/20260909132327_selling_wave_0a_raw_authority.sql"));
  run(sql("supabase/migrations/20260909162224_selling_wave_0a_reversal_boundary.sql"));
  run(sql("supabase/migrations/20260910022601_selling_wave_0b_safe_mutations.sql"));

  await t.test("single-shot invariants: idempotency, reconciliation gate, all-or-nothing, authority regression", () => {
    const result = run(sql("tests/smoke/postgres/selling-wave-0b-safe-mutations.assertions.sql"));
    assert.match(result, /wave_0b_assertions_passed/);
  });

  // Real concurrency: two genuinely overlapping connections, not two sequential statements. Each
  // fixture below is created and committed on its own (autocommit), then two async psql processes
  // race against it -- one explicitly locks-and-sleeps to force real overlap, proven by the second
  // process only completing after the first's sleep elapses.
  function spawnPsqlAsync(input: string): Promise<{ stdout: string; code: number | null }> {
    return new Promise((resolve, reject) => {
      const child = spawn("docker", ["exec", "-i", container, "psql", "-U", "postgres", "-tA"], { stdio: ["pipe", "pipe", "pipe"] });
      let stdout = ""; let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("error", reject);
      child.on("close", (code) => resolve({ stdout: stdout + stderr, code }));
      child.stdin.end(input);
    });
  }
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  function ownerPreamble(extra = "") {
    return `begin; set local role authenticated; ${OWNER_JWT} ${extra}`;
  }

  await t.test("concurrent purchase vs purchase on the same Item: both apply, no lost update", async () => {
    const id = crypto.randomUUID();
    run(`insert into public.ingredients (id, name, base_unit, current_quantity, average_unit_cost, inventory_reconciled_at)
      values ('${id}', 'Concurrency Flour', 'g', 1000, 2.0, now());`);
    const opA = crypto.randomUUID(); const opB = crypto.randomUUID();
    const started = Date.now();
    const a = spawnPsqlAsync(`${ownerPreamble(`select id from public.ingredients where id = '${id}' for update; select pg_sleep(1.5);`)}
      select public.post_raw_purchase('${opA}', '${id}', 500, 'g', 500, 1000, 'Local', 'SM', current_date, 5, 'A'); commit;`);
    await sleep(400);
    const b = spawnPsqlAsync(`${ownerPreamble()}
      select public.post_raw_purchase('${opB}', '${id}', 300, 'g', 300, 300, 'Local', 'SM', current_date, 5, 'B'); commit;`);
    const [resultA, resultB] = await Promise.all([a, b]);
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 1400, `B must have waited for A's lock, not run fully in parallel (elapsed ${elapsed}ms)`);
    assert.doesNotMatch(resultA.stdout, /ERROR/);
    assert.doesNotMatch(resultB.stdout, /ERROR/);
    const final = run(`select current_quantity from public.ingredients where id = '${id}';`).trim();
    assert.equal(final, "1800", "1000 + 500 + 300, no lost update");
    const txCount = run(`select count(*) from public.inventory_transactions where ingredient_id = '${id}';`).trim();
    assert.equal(txCount, "2");
  });

  await t.test("concurrent purchase vs Bake on the same Item: coherent serialized result, no stale overwrite", async () => {
    const id = crypto.randomUUID();
    run(`insert into public.ingredients (id, name, base_unit, current_quantity, average_unit_cost, inventory_reconciled_at)
      values ('${id}', 'Concurrency Sugar', 'g', 1000, 1.0, now());`);
    const opA = crypto.randomUUID(); const opB = crypto.randomUUID();
    const purchase = spawnPsqlAsync(`${ownerPreamble(`select id from public.ingredients where id = '${id}' for update; select pg_sleep(1.5);`)}
      select public.post_raw_purchase('${opA}', '${id}', 500, 'g', 500, 500, 'Local', 'SM', current_date, 5, 'A'); commit;`);
    await sleep(400);
    const bake = spawnPsqlAsync(`${ownerPreamble()}
      select public.confirm_bake_v2('${opB}', 'batch-concurrent', 'Concurrent Brownie', 1,
        jsonb_build_array(jsonb_build_object('ingredient_id', '${id}', 'quantity', 300))); commit;`);
    const [resultPurchase, resultBake] = await Promise.all([purchase, bake]);
    assert.doesNotMatch(resultPurchase.stdout, /ERROR/);
    assert.doesNotMatch(resultBake.stdout, /ERROR/);
    const final = run(`select current_quantity from public.ingredients where id = '${id}';`).trim();
    assert.equal(final, "1200", "1000 + 500 purchase - 300 Bake, serialized coherently regardless of interleaving");
    const txCount = run(`select count(*) from public.inventory_transactions where ingredient_id = '${id}';`).trim();
    assert.equal(txCount, "2");
  });

  await t.test("two Bakes competing for limited stock: only one succeeds, the other observes the committed balance and fails cleanly", async () => {
    const id = crypto.randomUUID();
    run(`insert into public.ingredients (id, name, base_unit, current_quantity, average_unit_cost, inventory_reconciled_at)
      values ('${id}', 'Concurrency Butter', 'g', 500, 1.0, now());`);
    const opA = crypto.randomUUID(); const opB = crypto.randomUUID();
    const bakeA = spawnPsqlAsync(`${ownerPreamble(`select id from public.ingredients where id = '${id}' for update; select pg_sleep(1.5);`)}
      select public.confirm_bake_v2('${opA}', 'batch-a', 'Bake A', 1, jsonb_build_array(jsonb_build_object('ingredient_id', '${id}', 'quantity', 300))); commit;`);
    await sleep(400);
    // Bake B's insufficiency is an *expected* outcome here, not a script failure -- caught inline
    // so the second psql invocation still exits 0 and we can assert on the marker it prints.
    const bakeB = spawnPsqlAsync(`${ownerPreamble()}
      do $$ begin
        perform public.confirm_bake_v2('${opB}', 'batch-b', 'Bake B', 1, jsonb_build_array(jsonb_build_object('ingredient_id', '${id}', 'quantity', 300)));
        raise notice 'bake_b_unexpectedly_succeeded';
      exception when check_violation then raise notice 'bake_b_rejected_as_expected'; end $$;
      commit;`);
    const [resultA, resultB] = await Promise.all([bakeA, bakeB]);
    assert.doesNotMatch(resultA.stdout, /ERROR/);
    assert.match(resultB.stdout, /bake_b_rejected_as_expected/, "the second Bake must see the committed post-A balance and fail on insufficient stock, not race past it");
    assert.doesNotMatch(resultB.stdout, /bake_b_unexpectedly_succeeded/);
    const final = run(`select current_quantity from public.ingredients where id = '${id}';`).trim();
    assert.equal(final, "200", "only Bake A's 300g deduction applied -- 500 - 300, never both");
    const txCount = run(`select count(*) from public.inventory_transactions where ingredient_id = '${id}';`).trim();
    assert.equal(txCount, "1", "the rejected Bake left no ledger row at all");
  });
});
