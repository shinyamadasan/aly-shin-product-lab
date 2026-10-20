import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const root = path.resolve(import.meta.dirname, "../../..");
const sql = (file: string) => readFileSync(path.join(root, file), "utf8");
const MIGRATION = "supabase/migrations/20261016120000_business_expenses.sql";
const OWNER_JWT = `select set_config('request.jwt.claim.sub','66666666-6666-4666-8666-666666666666',true);
  select set_config('request.jwt.claim.app_role','owner',true);
  select set_config('request.jwt.claims','{"sub":"66666666-6666-4666-8666-666666666666","role":"authenticated","app_metadata":{"app_role":"owner"}}',true);`;

test("Business expense ledger: owner-only, append-only, idempotent, and the migration is additive and reversible", { skip: process.env.RUN_POSTGRES_SMOKE !== "1" }, async (t) => {
  const container = `aly-business-expenses-${Date.now()}`;
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

  // Base environment + the Wave 0A/0B objects this migration depends on (the real claim_mutation),
  // built exactly as the other Postgres smoke suites build theirs.
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

  // A planted fact in an unrelated financial table: the migration must not touch it.
  run(`insert into ingredients (id, name, base_unit, current_quantity, average_unit_cost) values ('11111111-1111-4111-8111-111111111111', 'Flour', 'g', 1000, 0.05);
    insert into supply_entries (ingredient_id, ingredient_name, supplier_name, total_cost, pack_quantity) values ('11111111-1111-4111-8111-111111111111', 'Flour', 'Main', 55, 1000);`);
  const snapshot = () => run(`select md5(coalesce((select string_agg(t::text, '|' order by t::text) from ingredients t), '') ||
    coalesce((select string_agg(t::text, '|' order by t::text) from supply_entries t), '') ||
    coalesce((select string_agg(t::text, '|' order by t::text) from inventory_transactions t), ''))`).trim();
  const objectCounts = () => run(`select (select count(*) from information_schema.tables where table_schema in ('public','inventory_private'))::text || ':' ||
    (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public','inventory_private'))::text || ':' ||
    (select count(*) from pg_policies where schemaname = 'public')::text || ':' ||
    (select count(*) from pg_trigger where not tgisinternal)::text`).trim();

  // Supabase hands anon/authenticated/service_role ALL on every new table and function by default. Mirror it,
  // so the migration's own revokes are what is actually being proven rather than an empty-grant environment.
  run("alter default privileges in schema public grant all on tables to anon, authenticated, service_role; alter default privileges in schema public grant all on functions to anon, authenticated, service_role;");

  const factsBefore = snapshot();
  const countsBefore = objectCounts();

  await t.test("the migration applies, is additive, and refuses to be applied twice", () => {
    run(sql(MIGRATION));
    assert.equal(snapshot(), factsBefore, "existing financial rows must be byte-identical after the migration");
    assert.throws(() => run(sql(MIGRATION)), /must not be re-applied over itself/);
  });

  await t.test("assertions: ledger, idempotency, duplicate warning, void/correct, owner-only, immutability", () => {
    const result = run(sql("tests/smoke/postgres/business-expenses.assertions.sql"));
    assert.match(result, /business_expenses_assertions_passed/);
    assert.equal(run("select count(*) from public.business_expenses").trim(), "0", "assertions run in a rolled-back transaction");
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
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  await t.test("two simultaneous submissions of the SAME entry store it once and return the same row", async () => {
    const op = crypto.randomUUID();
    const call = `select 'ID:' || ((public.record_business_expense('${op}', current_date, 'software', 499.00, 'Hosting', null, null, null, false)) ->> 'id');`;
    // The first session holds its transaction open so the second genuinely overlaps it.
    const first = spawnPsqlAsync(`begin; set local role authenticated; ${OWNER_JWT} ${call} select pg_sleep(1.5); commit;`);
    await sleep(500);
    const second = spawnPsqlAsync(`begin; set local role authenticated; ${OWNER_JWT} ${call} commit;`);
    const [a, b] = await Promise.all([first, second]);
    const idA = a.stdout.match(/ID:([0-9a-f-]{36})/)?.[1];
    const idB = b.stdout.match(/ID:([0-9a-f-]{36})/)?.[1];
    assert.ok(idA && idB, `both sessions must answer with a row id. A=${a.stdout} B=${b.stdout}`);
    assert.equal(idA, idB, "the overlapping retry must replay the first result, not create another");
    assert.equal(run(`select count(*) from public.business_expenses where operation_id = '${op}'`).trim(), "1");
  });

  await t.test("a void racing a correction of the same expense: exactly one wins and history stays consistent", async () => {
    const created = run(`begin; set local role authenticated; ${OWNER_JWT}
      select 'ID:' || ((public.record_business_expense('${crypto.randomUUID()}', current_date, 'marketing', 300.00, 'Ad', null, null, null, false)) ->> 'id'); commit;`);
    const id = created.match(/ID:([0-9a-f-]{36})/)?.[1];
    assert.ok(id);
    const correcting = spawnPsqlAsync(`begin; set local role authenticated; ${OWNER_JWT}
      select 'CORRECTED:' || (((public.correct_business_expense('${crypto.randomUUID()}', '${id}', current_date, 'marketing', 350.00, 'Ad', null, null, null, 'wrong amount')) ->> 'amount')::numeric); select pg_sleep(1.5); commit;`);
    await sleep(500);
    const voiding = spawnPsqlAsync(`begin; set local role authenticated; ${OWNER_JWT}
      select public.void_business_expense('${crypto.randomUUID()}', '${id}', 'duplicate'); commit;`);
    const [corrected, voided] = await Promise.all([correcting, voiding]);
    assert.match(corrected.stdout, /CORRECTED:350/);
    assert.match(voided.stdout, /already void/, "the loser must be refused, not silently applied twice");
    assert.equal(run(`select count(*) from public.business_expenses where id = '${id}' and voided_at is not null`).trim(), "1");
    assert.equal(run(`select count(*) from public.business_expenses where corrects_expense_id = '${id}' and voided_at is null`).trim(), "1", "exactly one live replacement");
  });

  await t.test("two simultaneous look-alike entries with DIFFERENT operation ids: exactly one is stored, the other is asked to confirm", async () => {
    const call = (op: string) => `select 'OK:' || ((public.record_business_expense('${op}', current_date, 'fees', 77.25, 'Race Payee', null, null, null, false)) ->> 'id');`;
    const first = spawnPsqlAsync(`begin; set local role authenticated; ${OWNER_JWT} ${call(crypto.randomUUID())} select pg_sleep(1.5); commit;`);
    await sleep(400);
    const second = spawnPsqlAsync(`begin; set local role authenticated; ${OWNER_JWT} ${call(crypto.randomUUID())} commit;`);
    const [a, b] = await Promise.all([first, second]);
    assert.match(a.stdout, /OK:/);
    assert.match(b.stdout, /POSSIBLE_DUPLICATE/, "the loser waits for the winner, then sees it and is asked to confirm");
    assert.equal(run("select count(*) from public.business_expenses where payee = 'Race Payee' and voided_at is null").trim(), "1");
  });

  await t.test("the documented rollback ABORTS while the ledger has rows, and once empty it restores the original schema and leaves no stale receipts", () => {
    const text = sql(MIGRATION).replace(/\r\n/g, "\n");
    const block = text.slice(text.indexOf("-- ROLLBACK"), text.indexOf("do $$\nbegin"));
    const rollback = block.split("\n").filter((line) => line.startsWith("--   ")).map((line) => line.slice(5)).join("\n");
    assert.match(rollback, /do \$rollback\$/);
    assert.match(rollback, /delete from inventory_private\.mutation_receipts/);

    const rows = Number(run("select count(*) from public.business_expenses").trim());
    assert.ok(rows > 0, "rows from the concurrency tests exist, so the guard is exercised for real");
    const objectsBefore = objectCounts();
    assert.throws(() => run(rollback), /not empty/);
    assert.equal(objectCounts(), objectsBefore, "an aborted rollback must drop nothing");
    assert.equal(Number(run("select count(*) from public.business_expenses").trim()), rows, "and delete nothing");

    // TEST-ONLY emptying, as a superuser with triggers disabled; a real operator exports the ledger first.
    run("set session_replication_role = replica; delete from public.business_expenses;");
    assert.ok(Number(run("select count(*) from inventory_private.mutation_receipts where operation_type like 'expense_%'").trim()) > 0, "receipts exist before rollback");
    run(rollback);
    assert.equal(objectCounts(), countsBefore, "after rollback the schema has exactly the objects it had before the migration");
    assert.equal(run("select count(*) from inventory_private.mutation_receipts where operation_type like 'expense_%'").trim(), "0", "no stale receipts survive to answer a retry with a phantom success");
    assert.equal(snapshot(), factsBefore, "rollback must leave existing financial rows untouched");
    // And the migration can be applied again afterwards, to an empty ledger.
    run(sql(MIGRATION));
    assert.equal(run("select count(*) from public.business_expenses").trim(), "0");
  });
});
