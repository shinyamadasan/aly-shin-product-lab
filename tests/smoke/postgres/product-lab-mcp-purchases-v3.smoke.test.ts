import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  buildPurchasePreview,
  purchaseLineRpcArgs,
  type PurchaseItemInput,
  type PurchasePreview,
} from "../../../scripts/purchase-operator/core.ts";
import type { Ingredient } from "../../../src/lib/product-lab-types.ts";

// Product Lab MCP Purchases V3 -- database boundary, against DISPOSABLE Postgres only.
//
// Two containers, because V4 cannot be un-applied:
//   PRE-V4  = the full chain up to Safe Purchase Delete   (production's V4 state is unverified)
//   POST-V4 = the same chain plus Cost System Simplification V4
// Each also gets the new product_lab_mcp_purchase_previews migration.
//
// Proves (1) the new durable preview store: shape, constraints, owner RLS, grants, and that a
// repeated save cannot erase recorded apply state; and (2) the EXISTING purchase authority has the
// semantics the occasion + row operation-id design depends on: exact replay, fail-closed collision,
// explicit supplier/date/brand persistence, and Safe Purchase Delete reversibility -- driven with
// the exact arguments scripts/purchase-operator/core.ts produces (named-argument calls, so a wrong
// argument NAME fails too). Nothing here touches any real project; run with RUN_POSTGRES_SMOKE=1.
const root = path.resolve(import.meta.dirname, "../../..");
const sql = (file: string) => readFileSync(path.join(root, file), "utf8");
const SKIP = { skip: process.env.RUN_POSTGRES_SMOKE !== "1" };

const OWNER_A = "88888888-8888-4888-8888-888888888888";
const OWNER_B = "99999999-9999-4999-8999-999999999999";
const STAFF = "77777777-7777-4777-8777-777777777777";
const PREVIEW_MIGRATION = "supabase/migrations/20261005130000_product_lab_mcp_purchase_previews.sql";
const CHAIN = [
  "20260909132327_selling_wave_0a_raw_authority.sql",
  "20260909162224_selling_wave_0a_reversal_boundary.sql",
  "20260910022601_selling_wave_0b_safe_mutations.sql",
  "20260910120146_selling_wave_1_production_execution.sql",
  "20260912090000_cost_baseline_repair.sql",
  "20260912193053_claude_inventory_operator_v1a.sql",
  "20260917175840_safe_purchase_delete.sql",
];
const V4 = "20260921120000_cost_system_simplification_v4.sql";

const session = (sub: string, appRole: "owner" | "staff") => `set role authenticated;
  select set_config('request.jwt.claim.sub','${sub}',false);
  select set_config('request.jwt.claim.app_role','${appRole}',false);
  select set_config('request.jwt.claims','{"sub":"${sub}","role":"authenticated","app_metadata":{"app_role":"${appRole}"}}',false);`;
const ANON = "set role anon;";

async function startDatabase(t: TestContext, label: string, includeV4: boolean) {
  const container = `aly-purchases-v3-${label}-${Date.now()}`;
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
    create table auth.users (id uuid primary key);
    insert into auth.users (id) values ('${OWNER_A}'), ('${OWNER_B}'), ('${STAFF}');
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
  for (const migration of [...CHAIN, ...(includeV4 ? [V4] : [])]) run(sql(`supabase/migrations/${migration}`));
  run(sql(PREVIEW_MIGRATION));

  const lastLine = (output: string) => output.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
  const q1 = (statement: string) => lastLine(run(statement));
  const asSession = (who: string, statement: string) => lastLine(run(`${who} ${statement}`));
  const asOwner = (statement: string) => asSession(session(OWNER_A, "owner"), statement);
  const n = (statement: string) => Number(q1(statement));
  // `\set VERBOSITY verbose` makes psql print the SQLSTATE (e.g. "ERROR:  23514: ...").
  function fails(who: string, statement: string, pattern: RegExp, message: string) {
    assert.throws(() => run(`\\set VERBOSITY verbose\n${who} ${statement}`), (error: unknown) => {
      const text = String((error as { stderr?: unknown }).stderr ?? error);
      assert.match(text, pattern, `${message} -- got: ${text.trim().split(/\r?\n/)[0]}`);
      return true;
    });
  }
  return { run, q1, n, asSession, asOwner, fails, lastLine };
}
type Db = Awaited<ReturnType<typeof startDatabase>>;

// ---- purchase fixtures built with the REAL domain core ----------------------------------------

let ingredientSeq = 0;
function createIngredient(db: Db, label: string, quantity: number, averageCost: number | null, options: { trusted?: boolean; unit?: string } = {}) {
  const id = crypto.randomUUID();
  const unit = options.unit ?? "g";
  const name = `Smoke ${label} ${++ingredientSeq}`;
  db.run(`insert into public.ingredients (id, name, base_unit, current_quantity, average_unit_cost, inventory_reconciled_at, cost_reconciled_at)
    values ('${id}', '${name}', '${unit}', ${quantity}, ${averageCost === null ? "null" : averageCost}, now(), ${options.trusted ? "now()" : "null"});`);
  const domain: Ingredient = {
    id, name, baseUnit: unit as Ingredient["baseUnit"], category: "ingredient", currentQuantity: quantity, lowStockThreshold: 0,
    targetStockQuantity: 0, nearestExpirationDate: "", averageUnitCost: averageCost ?? 0, notes: "", isActive: true,
    inventoryReconciledAt: "2026-09-10T00:00:00Z", costReconciledAt: options.trusted ? "2026-09-10T00:00:00Z" : null,
  };
  return domain;
}

const PURCHASE_DATE = "2026-03-02"; // deliberately not "today": proves the explicit date is stored, not current_date
function previewFor(items: PurchaseItemInput[], ingredients: Ingredient[], overrides: { occasion_id?: string; supplier?: string; purchase_date?: string; source_note?: string } = {}): PurchasePreview {
  const preview = buildPurchasePreview({
    intent: { kind: "purchase", occasion_id: `smoke-${crypto.randomUUID()}`, supplier: "Puregold", purchase_date: PURCHASE_DATE, items, ...overrides },
    ingredients, aliases: [], now: "2026-10-05T00:00:00Z",
  });
  assert.equal(preview.can_apply, true, preview.errors.join("; "));
  return preview;
}

const lit = (value: unknown): string => value === null ? "null" : typeof value === "number" ? String(value) : `'${String(value).replaceAll("'", "''")}'`;
// Named-argument call: a wrong argument name in purchaseLineRpcArgs fails here.
function postRawPurchaseSql(args: ReturnType<typeof purchaseLineRpcArgs>): string {
  return `select public.post_raw_purchase(
    p_operation_id => ${lit(args.p_operation_id)}::uuid, p_ingredient_id => ${lit(args.p_ingredient_id)}::uuid,
    p_pack_quantity => ${lit(args.p_pack_quantity)}::numeric, p_display_unit => ${lit(args.p_display_unit)}::text,
    p_base_quantity => ${lit(args.p_base_quantity)}::numeric, p_total_cost => ${lit(args.p_total_cost)}::numeric,
    p_brand_name => ${lit(args.p_brand_name)}::text, p_supplier_name => ${lit(args.p_supplier_name)}::text,
    p_purchase_date => ${lit(args.p_purchase_date)}::date, p_quality_rating => ${lit(args.p_quality_rating)}::numeric,
    p_notes => ${lit(args.p_notes)}::text);`;
}
type PostResult = { supply_id: string; transaction_id: string; quantity_after: number; average_unit_cost: number; cost_trusted?: boolean };
const applyLine = (db: Db, preview: PurchasePreview, row: number): PostResult => JSON.parse(db.asOwner(postRawPurchaseSql(purchaseLineRpcArgs(preview, row))));
const applyArgs = (db: Db, args: ReturnType<typeof purchaseLineRpcArgs>): PostResult => JSON.parse(db.asOwner(postRawPurchaseSql(args)));

type Footprint = { supply: number; purchaseTx: number; receipts: number; qty: number; avg: number | null; trustAt: string | null };
function footprint(db: Db, ingredientId: string, operationIds: string[] = []): Footprint {
  const ids = operationIds.length ? operationIds.map((id) => `'${id}'`).join(",") : "null";
  return JSON.parse(db.q1(`select json_build_object(
    'supply', (select count(*) from public.supply_entries where ingredient_id = '${ingredientId}'),
    'purchaseTx', (select count(*) from public.inventory_transactions where ingredient_id = '${ingredientId}' and transaction_type = 'purchase'),
    'receipts', (select count(*) from inventory_private.mutation_receipts where operation_id in (${ids})),
    'qty', (select current_quantity from public.ingredients where id = '${ingredientId}'),
    'avg', (select average_unit_cost from public.ingredients where id = '${ingredientId}'),
    'trustAt', (select cost_reconciled_at from public.ingredients where id = '${ingredientId}'))`));
}
const COLLISION = /23514[\s\S]*already used for a different request/;

// ---- the durable preview store ----------------------------------------------------------------

function previewJson(preview: PurchasePreview, patch: Record<string, unknown> = {}) {
  return JSON.stringify({ ...preview, ...patch });
}
function insertPreviewSql(preview: PurchasePreview, extra: { columns?: Record<string, string>; json?: string } = {}) {
  const cols = {
    preview_id: lit(preview.preview_id), occasion_id: `$q$${preview.occasion_id}$q$`, payload_hash: lit(preview.payload_hash),
    preview: `$j$${extra.json ?? previewJson(preview)}$j$::jsonb`, ...(extra.columns ?? {}),
  };
  return `insert into public.product_lab_mcp_purchase_previews (${Object.keys(cols).join(", ")}) values (${Object.values(cols).join(", ")});`;
}
const TABLE = "public.product_lab_mcp_purchase_previews";

async function previewStoreAssertions(db: Db, t: TestContext) {
  const A = session(OWNER_A, "owner");
  const B = session(OWNER_B, "owner");
  const S = session(STAFF, "staff");
  const flour = createIngredient(db, "Store Flour", 1000, 0.5);
  const base = previewFor([{ raw_name: flour.name, quantity: 1, unit: "kg", total_price: 95 }], [flour]);

  await t.test("structure: columns, composite key, no unique occasion_id, RLS forced, three owner policies, grants", () => {
    assert.equal(db.q1(`select string_agg(column_name || ':' || data_type || ':' || is_nullable, ',' order by ordinal_position)
      from information_schema.columns where table_schema = 'public' and table_name = 'product_lab_mcp_purchase_previews'`),
      "preview_id:text:NO,owner_id:uuid:NO,occasion_id:text:NO,payload_hash:text:NO,preview:jsonb:NO,apply_result:jsonb:YES,verified_at:timestamp with time zone:YES,created_at:timestamp with time zone:NO,expires_at:timestamp with time zone:NO");
    assert.equal(db.q1(`select string_agg(kcu.column_name, ',' order by kcu.ordinal_position)
      from information_schema.table_constraints tc join information_schema.key_column_usage kcu
        on kcu.constraint_name = tc.constraint_name and kcu.table_schema = tc.table_schema
      where tc.constraint_type = 'PRIMARY KEY' and tc.table_schema = 'public' and tc.table_name = 'product_lab_mcp_purchase_previews'`), "owner_id,preview_id");
    assert.equal(db.n(`select count(*) from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
      where i.indrelid = '${TABLE}'::regclass and i.indisunique and a.attname = 'occasion_id'`), 0, "occasion_id must not be part of any unique index");
    assert.equal(db.n(`select count(*) from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
      where i.indrelid = '${TABLE}'::regclass and not i.indisunique and a.attname = 'occasion_id'`), 1, "occasion_id is indexed (non-unique) for audit queries");
    assert.equal(db.q1(`select relrowsecurity::text || ',' || relforcerowsecurity::text from pg_class where oid = '${TABLE}'::regclass`), "true,true");
    assert.equal(db.q1(`select string_agg(cmd, ',' order by cmd) from pg_policies where schemaname = 'public' and tablename = 'product_lab_mcp_purchase_previews'`), "INSERT,SELECT,UPDATE");
    assert.equal(db.n(`select count(*) from pg_policies where tablename = 'product_lab_mcp_purchase_previews' and roles <> '{authenticated}'`), 0);
    assert.equal(db.q1(`select string_agg(grantee || ':' || privilege_type, ',' order by grantee, privilege_type) from information_schema.role_table_grants
      where table_schema = 'public' and table_name = 'product_lab_mcp_purchase_previews' and grantee in ('authenticated', 'anon', 'PUBLIC')`),
      "authenticated:INSERT,authenticated:SELECT,authenticated:UPDATE");
    assert.equal(db.n(`select count(*) from pg_trigger where tgrelid = '${TABLE}'::regclass and not tgisinternal`), 1);
    assert.equal(db.q1(`select has_function_privilege('authenticated', 'public.product_lab_mcp_purchase_previews_guard()', 'execute')::text`), "false");
  });

  await t.test("a valid pu_ artifact is accepted with database-owned owner_id and a 24h window", () => {
    db.run(`${A} ${insertPreviewSql(base)}`);
    assert.equal(db.q1(`select owner_id::text from ${TABLE} where preview_id = '${base.preview_id}'`), OWNER_A);
    assert.equal(db.q1(`select (expires_at - created_at = interval '24 hours')::text from ${TABLE} where preview_id = '${base.preview_id}'`), "true");
    const stored = JSON.parse(db.asSession(A, `select preview from ${TABLE} where preview_id = '${base.preview_id}';`));
    assert.deepEqual(stored, JSON.parse(JSON.stringify(base)), "the whole preview round-trips, so apply never needs the client to re-supply it");
    assert.equal(db.q1(`select (apply_result is null and verified_at is null)::text from ${TABLE} where preview_id = '${base.preview_id}'`), "true");
  });

  await t.test("malformed identity and artifact rows are rejected by named constraints", () => {
    const other = previewFor([{ raw_name: flour.name, quantity: 2, unit: "kg", total_price: 190 }], [flour]);
    const reject = (preview: PurchasePreview, extra: Parameters<typeof insertPreviewSql>[1], constraint: RegExp | null, message: string) =>
      db.fails(A, insertPreviewSql(preview, extra), constraint ?? /violates check constraint/, message);
    const hash20 = other.payload_hash.slice(0, 20);
    // count-prefix id that otherwise matches its hash: only the format constraint can refuse it
    reject(other, { columns: { preview_id: lit(`pc_${hash20}`) }, json: previewJson(other, { preview_id: `pc_${hash20}` }) }, /preview_id_format/, "a physical-count prefix");
    // well-formed id that does not belong to the hash
    reject(other, { columns: { preview_id: lit("pu_00000000000000000000") }, json: previewJson(other, { preview_id: "pu_00000000000000000000" }) }, /id_matches_hash/, "id not derived from hash");
    reject(other, { columns: { preview_id: lit("pu_short") }, json: previewJson(other, { preview_id: "pu_short" }) }, null, "short id");
    reject(other, { columns: { preview_id: lit(`pu_${hash20.toUpperCase()}`) }, json: previewJson(other, { preview_id: `pu_${hash20.toUpperCase()}` }) }, null, "uppercase hex id");
    reject(other, { columns: { payload_hash: lit("abc") }, json: previewJson(other, { payload_hash: "abc" }) }, null, "malformed payload hash");
    reject(other, { columns: { occasion_id: lit("   ") }, json: previewJson(other, { occasion_id: "   " }) }, /occasion_id_format/, "blank occasion");
    reject(other, { columns: { occasion_id: lit(" padded") }, json: previewJson(other, { occasion_id: " padded" }) }, /occasion_id_format/, "padded occasion");
    reject(other, { json: "[]" }, /artifact_matches_columns/, "preview must be an object");
    reject(other, { json: previewJson(other, { kind: "physical_count_preview" }) }, /artifact_matches_columns/, "wrong artifact kind");
    reject(other, { json: previewJson(other, { preview_id: "pu_00000000000000000000" }) }, /artifact_matches_columns/, "artifact describes a different preview");
    reject(other, { json: previewJson(other, { occasion_id: "another-occasion" }) }, /artifact_matches_columns/, "artifact describes a different occasion");
    reject(other, { json: JSON.stringify({ kind: "purchase_preview" }) }, /artifact_matches_columns/, "missing keys are violations, not NULL passes");
    reject(other, { columns: { apply_result: "'[]'::jsonb" } }, /apply_result_object/, "apply_result must be an object");
    assert.equal(db.n(`select count(*) from ${TABLE} where payload_hash = '${other.payload_hash}'`), 0, "nothing malformed was stored");
  });

  await t.test("the 24-hour window is enforced: exactly 24h is accepted; longer, zero and negative are refused", () => {
    const mk = (qty: number) => previewFor([{ raw_name: flour.name, quantity: qty, unit: "kg", total_price: 50 }], [flour]);
    const exact = mk(3);
    db.run(`${A} ${insertPreviewSql(exact, { columns: { created_at: "'2026-10-05T00:00:00Z'", expires_at: "'2026-10-06T00:00:00Z'" } })}`);
    const over = mk(4);
    db.fails(A, insertPreviewSql(over, { columns: { created_at: "'2026-10-05T00:00:00Z'", expires_at: "'2026-10-06T00:00:01Z'" } }), /expiry_window/, "24h + 1s");
    const equal = mk(5);
    db.fails(A, insertPreviewSql(equal, { columns: { created_at: "'2026-10-05T00:00:00Z'", expires_at: "'2026-10-05T00:00:00Z'" } }), /expiry_window/, "zero-length window");
    const backwards = mk(6);
    db.fails(A, insertPreviewSql(backwards, { columns: { created_at: "'2026-10-05T00:00:00Z'", expires_at: "'2026-10-04T00:00:00Z'" } }), /expiry_window/, "already expired");
  });

  await t.test("uniqueness: same owner + preview_id is refused, another owner may hold the same id, occasion_id is NOT unique", () => {
    db.fails(A, insertPreviewSql(base), /23505[\s\S]*duplicate key/, "same owner, same preview");
    db.run(`${B} ${insertPreviewSql(base)}`); // composite key: owner B's identical, content-derived preview_id does not collide
    assert.equal(db.n(`select count(*) from ${TABLE} where preview_id = '${base.preview_id}'`), 2);
    const sameOccasion = previewFor([{ raw_name: flour.name, quantity: 7, unit: "kg", total_price: 70 }], [flour], { occasion_id: base.occasion_id });
    assert.notEqual(sameOccasion.preview_id, base.preview_id);
    db.run(`${A} ${insertPreviewSql(sameOccasion)}`);
    db.run(`${B} ${insertPreviewSql(sameOccasion)}`);
    assert.equal(db.n(`select count(*) from ${TABLE} where occasion_id = $q$${base.occasion_id}$q$`), 4, "one occasion, several previews, two owners");
  });

  await t.test("RLS: owners are isolated; staff, anon and spoofed owner_id are refused; nothing can be deleted", () => {
    const onlyA = previewFor([{ raw_name: flour.name, quantity: 8, unit: "kg", total_price: 80 }], [flour]);
    db.run(`${A} ${insertPreviewSql(onlyA)}`);
    assert.equal(db.asSession(A, `select count(*) from ${TABLE} where preview_id = '${onlyA.preview_id}';`), "1");
    assert.equal(db.asSession(B, `select count(*) from ${TABLE} where preview_id = '${onlyA.preview_id}';`), "0", "owner B cannot see owner A's artifact");
    db.run(`${B} update ${TABLE} set verified_at = now() where preview_id = '${onlyA.preview_id}';`);
    assert.equal(db.q1(`select (verified_at is null)::text from ${TABLE} where owner_id = '${OWNER_A}' and preview_id = '${onlyA.preview_id}'`), "true", "owner B cannot mutate owner A's artifact");
    assert.equal(db.asSession(S, `select count(*) from ${TABLE};`), "0", "a non-owner reads nothing");
    db.fails(S, insertPreviewSql(onlyA), /row-level security/, "staff insert");
    db.fails(A, insertPreviewSql(previewFor([{ raw_name: flour.name, quantity: 9, unit: "kg", total_price: 90 }], [flour]), { columns: { owner_id: lit(OWNER_B) } }), /row-level security/, "spoofed owner_id");
    db.fails(ANON, `select count(*) from ${TABLE};`, /permission denied/, "anon select");
    db.fails(ANON, insertPreviewSql(onlyA), /permission denied/, "anon insert");
    db.fails(A, `delete from ${TABLE} where preview_id = '${onlyA.preview_id}';`, /permission denied/, "owner delete");
    assert.equal(db.n(`select count(*) from ${TABLE} where preview_id = '${onlyA.preview_id}'`), 1);
  });

  await t.test("apply state is preserved: progress and verification can be recorded, but never erased or rewritten", () => {
    const p = previewFor([{ raw_name: flour.name, quantity: 10, unit: "kg", total_price: 100 }], [flour]);
    db.run(`${A} ${insertPreviewSql(p)}`);
    const where = `where owner_id = '${OWNER_A}' and preview_id = '${p.preview_id}'`;
    const partial = JSON.stringify({ status: "PARTIALLY_APPLIED", lines: [{ row_number: 1, outcome: "applied" }, { row_number: 2, outcome: "failed" }] });
    const complete = JSON.stringify({ status: "APPLIED", lines: [{ row_number: 1, outcome: "replayed" }, { row_number: 2, outcome: "applied" }] });
    db.run(`${A} update ${TABLE} set apply_result = $j$${partial}$j$::jsonb ${where};`);
    db.run(`${A} update ${TABLE} set apply_result = $j$${complete}$j$::jsonb ${where};`); // progress across a retry replaces it
    assert.deepEqual(JSON.parse(db.q1(`select apply_result from ${TABLE} ${where}`)), JSON.parse(complete));
    db.run(`${A} update ${TABLE} set verified_at = now() ${where};`);

    db.fails(A, `update ${TABLE} set apply_result = null ${where};`, /23514[\s\S]*apply_result cannot be erased/, "erase apply_result");
    db.fails(A, `update ${TABLE} set verified_at = null ${where};`, /23514[\s\S]*verified_at cannot be cleared/, "clear verified_at");
    db.fails(A, `update ${TABLE} set preview = preview || '{"supplier":"Tampered"}'::jsonb ${where};`, /23514[\s\S]*applied purchase preview cannot be modified/, "rewrite an applied preview");
    db.fails(A, `update ${TABLE} set occasion_id = 'other' ${where};`, /23514[\s\S]*identity cannot be changed/, "change occasion_id");
    db.fails(A, `update ${TABLE} set payload_hash = '${"a".repeat(64)}' ${where};`, /23514[\s\S]*identity cannot be changed/, "change payload_hash");
    // the accidental-clobber shape: an upsert that re-sends the preview with no apply_result
    db.fails(A, `insert into ${TABLE} (preview_id, occasion_id, payload_hash, preview, apply_result)
      values ('${p.preview_id}', $q$${p.occasion_id}$q$, '${p.payload_hash}', $j$${previewJson(p)}$j$::jsonb, null)
      on conflict (owner_id, preview_id) do update set preview = excluded.preview, apply_result = excluded.apply_result, verified_at = excluded.verified_at;`,
      /23514[\s\S]*apply_result cannot be erased/, "naive upsert");
    const ignored = db.asSession(A, `insert into ${TABLE} (preview_id, occasion_id, payload_hash, preview)
      values ('${p.preview_id}', $q$${p.occasion_id}$q$, '${p.payload_hash}', $j$${previewJson(p)}$j$::jsonb) on conflict (owner_id, preview_id) do nothing;`);
    assert.equal(ignored, "INSERT 0 0");
    assert.deepEqual(JSON.parse(db.q1(`select apply_result from ${TABLE} ${where}`)), JSON.parse(complete), "recorded apply state survived every attempt");
    assert.equal(db.q1(`select (verified_at is not null)::text from ${TABLE} ${where}`), "true");
  });

  await t.test("a never-applied artifact may be refreshed (new evidence, new 24h window) after it expired", () => {
    const stale = previewFor([{ raw_name: flour.name, quantity: 11, unit: "kg", total_price: 110 }], [flour]);
    db.run(`${A} ${insertPreviewSql(stale, { columns: { created_at: "'2026-01-01T00:00:00Z'", expires_at: "'2026-01-02T00:00:00Z'" } })}`);
    const refreshedEvidence = previewFor([{ raw_name: flour.name, quantity: 11, unit: "kg", total_price: 110 }], [{ ...flour, currentQuantity: 5000 }], { occasion_id: stale.occasion_id });
    assert.equal(refreshedEvidence.preview_id, stale.preview_id, "same purchase, same preview_id, newer evidence");
    db.run(`${A} update ${TABLE} set preview = $j$${previewJson(refreshedEvidence)}$j$::jsonb, created_at = now(), expires_at = now() + interval '24 hours'
      where owner_id = '${OWNER_A}' and preview_id = '${stale.preview_id}';`);
    assert.equal(db.q1(`select (expires_at > now() and (preview -> 'rows' -> 0 ->> 'current_quantity')::numeric = 5000)::text from ${TABLE} where owner_id = '${OWNER_A}' and preview_id = '${stale.preview_id}'`), "true");
  });
}

// ---- tests --------------------------------------------------------------------------------------

test("Purchases V3 (PRE-V4 / Safe Purchase Delete state): preview store, per-line idempotency, persistence, reversal", SKIP, async (t) => {
  const db = await startDatabase(t, "pre-v4", false);
  assert.equal(db.n(`select count(*) from pg_proc where proname = 'resolve_purchase_cost_trust'`), 0, "this database really is pre-V4");
  assert.equal(db.n(`select count(*) from pg_proc where proname = 'delete_posted_purchase_if_reversible'`) > 0, true, "and has Safe Purchase Delete");

  await t.test("the durable purchase-preview store", async (store) => { await previewStoreAssertions(db, store); });

  const two = (label: string, flourQty = 1000, flourAvg: number | null = 0.5) => {
    const flour = createIngredient(db, `${label} Flour`, flourQty, flourAvg);
    const sugar = createIngredient(db, `${label} Sugar`, 200, 0.4);
    const items: PurchaseItemInput[] = [
      { raw_name: flour.name, quantity: 2, unit: "kg", total_price: 190, brand: "Gold Medal" },
      { raw_name: sugar.name, quantity: 500, unit: "g", total_price: 60 },
    ];
    return { flour, sugar, items, ingredients: [flour, sugar], preview: previewFor(items, [flour, sugar]) };
  };

  await t.test("first apply posts exactly one supply entry and one purchase ledger row through post_raw_purchase", () => {
    const { flour, preview } = two("First");
    const args = purchaseLineRpcArgs(preview, 1);
    const before = footprint(db, flour.id, [args.p_operation_id]);
    assert.deepEqual([before.supply, before.purchaseTx, before.receipts, before.qty], [0, 0, 0, 1000]);
    const result = applyArgs(db, args);
    assert.deepEqual(Object.keys(result).sort(), ["average_unit_cost", "quantity_after", "supply_id", "transaction_id"]);
    assert.equal(result.quantity_after, 3000);
    assert.ok(Math.abs(result.average_unit_cost - 0.23) < 1e-9, `weighted average (1000*0.5+190)/3000, got ${result.average_unit_cost}`);
    const after = footprint(db, flour.id, [args.p_operation_id]);
    assert.deepEqual([after.supply, after.purchaseTx, after.receipts, after.qty], [1, 1, 1, 3000]);
    assert.equal(db.q1(`select concat_ws('|', transaction_type, source_type, (source_id = '${result.supply_id}')::text, quantity_before, quantity_change, quantity_after)
      from public.inventory_transactions where id = '${result.transaction_id}'`), "purchase|manual|true|1000|2000|3000");
    assert.equal(db.q1(`select operation_type from inventory_private.mutation_receipts where operation_id = '${args.p_operation_id}'`), "purchase_manual");
  });

  await t.test("explicit supplier, purchase_date and brand are persisted exactly, never current_date", () => {
    const { flour, sugar, preview } = two("Persist");
    const one = applyLine(db, preview, 1);
    const twoResult = applyLine(db, preview, 2);
    const row = (supplyId: string) => JSON.parse(db.q1(`select json_build_object('supplier', supplier_name, 'date', purchase_date::text, 'brand', brand_name,
      'pack', pack_quantity, 'unit', unit, 'cost', total_cost, 'rating', quality_rating, 'notes', notes, 'ingredient', ingredient_id, 'name', ingredient_name)
      from public.supply_entries where id = '${supplyId}'`));
    const first = row(one.supply_id);
    assert.deepEqual(first, { supplier: "Puregold", date: PURCHASE_DATE, brand: "Gold Medal", pack: 2, unit: "kg", cost: 190, rating: 0,
      notes: `MCP purchase ${preview.occasion_id}`, ingredient: flour.id, name: flour.name });
    assert.notEqual(first.date, db.q1("select current_date::text"), "the stored date is the supplied one, not the database's UTC today");
    const second = row(twoResult.supply_id);
    assert.equal(second.brand, null, "no brand supplied -> no brand stored");
    assert.deepEqual([second.supplier, second.date, second.pack, second.unit, second.cost, second.ingredient], ["Puregold", PURCHASE_DATE, 500, "g", 60, sugar.id]);
    // a past-midnight-UTC style date far from "today" in either direction round-trips too
    const future = previewFor([{ raw_name: flour.name, quantity: 1, unit: "kg", total_price: 10 }], [flour], { purchase_date: "2031-12-31" });
    assert.equal(db.q1(`select purchase_date::text from public.supply_entries where id = '${applyLine(db, future, 1).supply_id}'`), "2031-12-31");
  });

  await t.test("exact replay (same operation id, identical payload) returns the original result and posts nothing twice", () => {
    const { flour, items, ingredients, preview } = two("Replay");
    const args = purchaseLineRpcArgs(preview, 1);
    const original = applyArgs(db, args);
    const afterFirst = footprint(db, flour.id, [args.p_operation_id]);
    const replay = applyArgs(db, purchaseLineRpcArgs(preview, 1));
    assert.deepEqual(replay, original, "stored result identifiers correspond to the original mutation");
    assert.deepEqual(footprint(db, flour.id, [args.p_operation_id]), afterFirst, "no second supply row, ledger row, receipt, or quantity increment");
    assert.equal(afterFirst.qty, 3000);
    // a preview rebuilt from the same intent (another process, a retry) is the same call, replayed
    const rebuilt = previewFor(items, ingredients, { occasion_id: preview.occasion_id });
    assert.equal(rebuilt.preview_id, preview.preview_id);
    assert.deepEqual(applyLine(db, rebuilt, 1), original);
    assert.deepEqual(footprint(db, flour.id, [args.p_operation_id]), afterFirst);
  });

  await t.test("changed payload under a reused occasion + row FAILS CLOSED (SQLSTATE 23514) and leaves the database untouched", () => {
    const { flour, sugar, items, ingredients, preview } = two("Collide");
    const args = purchaseLineRpcArgs(preview, 1);
    const original = applyArgs(db, args);
    const op = args.p_operation_id;
    const baseline = footprint(db, flour.id, [op]);
    const sugarBaseline = footprint(db, sugar.id);

    const corrected: Array<[string, PurchasePreview]> = [
      ["quantity", previewFor([{ ...items[0], quantity: 3 }, items[1]], ingredients, { occasion_id: preview.occasion_id })],
      ["price", previewFor([{ ...items[0], total_price: 191 }, items[1]], ingredients, { occasion_id: preview.occasion_id })],
      ["supplier", previewFor(items, ingredients, { occasion_id: preview.occasion_id, supplier: "SM Market" })],
      ["purchase_date", previewFor(items, ingredients, { occasion_id: preview.occasion_id, purchase_date: "2026-03-03" })],
      ["brand", previewFor([{ ...items[0], brand: "Other Brand" }, items[1]], ingredients, { occasion_id: preview.occasion_id })],
      ["source_note", previewFor(items, ingredients, { occasion_id: preview.occasion_id, source_note: "a corrected note" })],
      ["reordered lines", previewFor([items[1], items[0]], ingredients, { occasion_id: preview.occasion_id })],
    ];
    for (const [field, correctedPreview] of corrected) {
      const correctedArgs = purchaseLineRpcArgs(correctedPreview, 1);
      assert.equal(correctedArgs.p_operation_id, op, `${field}: the corrected preview reuses the SAME operation id`);
      assert.notEqual(correctedPreview.preview_id, preview.preview_id, `${field}: but it is a different preview`);
      db.fails(session(OWNER_A, "owner"), postRawPurchaseSql(correctedArgs), COLLISION, `${field}: claim_mutation must refuse a changed payload`);
      assert.deepEqual(footprint(db, flour.id, [op]), baseline, `${field}: no extra supply entry, ledger row or quantity change`);
      assert.deepEqual(footprint(db, sugar.id), sugarBaseline, `${field}: the other ingredient is untouched too`);
    }
    // the original is still a clean replay after every rejected attempt
    assert.deepEqual(applyLine(db, preview, 1), original);
    assert.deepEqual(footprint(db, flour.id, [op]), baseline);
  });

  await t.test("lines are independent: line 2 applies after line 1; a corrected preview whose line 2 is unchanged replays it", () => {
    const { flour, sugar, items, ingredients, preview } = two("Resume");
    const line1 = applyLine(db, preview, 1);
    // line 2 has not run yet (the "mid-batch failure" resume case): it applies now, exactly once
    const line2 = applyLine(db, preview, 2);
    assert.notEqual(line1.supply_id, line2.supply_id);
    assert.equal(footprint(db, sugar.id).qty, 700);
    const sugarState = footprint(db, sugar.id, [purchaseLineRpcArgs(preview, 2).p_operation_id]);
    // corrected preview (only line 1's price differs): line 2's payload is identical -> replay, line 1's differs -> refused
    const corrected = previewFor([{ ...items[0], total_price: 195 }, items[1]], ingredients, { occasion_id: preview.occasion_id });
    assert.deepEqual(applyLine(db, corrected, 2), line2, "an unchanged line replays its stored result");
    assert.deepEqual(footprint(db, sugar.id, [purchaseLineRpcArgs(preview, 2).p_operation_id]), sugarState);
    db.fails(session(OWNER_A, "owner"), postRawPurchaseSql(purchaseLineRpcArgs(corrected, 1)), COLLISION, "the changed line 1 is refused");
    assert.equal(footprint(db, flour.id).qty, 3000);
  });

  await t.test("a non-owner cannot post a purchase and leaves no receipt", () => {
    const { flour, preview } = two("Staff");
    const args = purchaseLineRpcArgs(preview, 1);
    db.fails(session(STAFF, "staff"), postRawPurchaseSql(args), /42501[\s\S]*Only the product lab owner/, "staff post");
    assert.deepEqual(footprint(db, flour.id, [args.p_operation_id]), { supply: 0, purchaseTx: 0, receipts: 0, qty: 1000, avg: 0.5, trustAt: null });
  });

  await t.test("PRE-V4 shape: no cost_trusted in the result, and a purchase leaves cost trust exactly as it found it", () => {
    const trusted = createIngredient(db, "Trusted", 500, 1, { trusted: true });
    const untrusted = createIngredient(db, "Untrusted", 500, 1);
    for (const ingredient of [trusted, untrusted]) {
      const preview = previewFor([{ raw_name: ingredient.name, quantity: 100, unit: "g", total_price: 50 }], [ingredient]);
      const before = footprint(db, ingredient.id);
      const result = applyLine(db, preview, 1);
      assert.equal("cost_trusted" in result, false, "the service must read a missing cost_trusted as unknown");
      assert.equal(result.quantity_after, 600);
      assert.equal(footprint(db, ingredient.id).trustAt, before.trustAt, "cost_reconciled_at is untouched in the pre-V4 database");
    }
  });

  await t.test("Safe Purchase Delete restores the EXACT prior quantity and weighted-average cost while the purchase is the latest movement", () => {
    const flour = createIngredient(db, "Reversible", 1000, 0.5);
    const preview = previewFor([{ raw_name: flour.name, quantity: 500, unit: "g", total_price: 400 }], [flour]);
    const posted = applyLine(db, preview, 1);
    assert.equal(db.q1(`select (average_unit_cost = 0.6)::text from public.ingredients where id = '${flour.id}'`), "true", "(1000*0.5 + 400) / 1500");
    const reversalOp = crypto.randomUUID();
    const reversed = JSON.parse(db.asOwner(`select public.delete_posted_purchase_if_reversible('${reversalOp}', '${posted.supply_id}');`));
    assert.equal(reversed.reversed, true);
    assert.equal(reversed.quantity_after, 1000);
    assert.equal(db.q1(`select (current_quantity = 1000 and average_unit_cost = 0.5)::text from public.ingredients where id = '${flour.id}'`), "true", "exact numeric equality, not approximately");
    assert.equal(db.n(`select count(*) from public.supply_entries where id = '${posted.supply_id}'`), 0);
    assert.equal(db.n(`select count(*) from public.inventory_transactions where id = '${posted.transaction_id}'`), 0);
    assert.equal(db.q1(`select string_agg(operation_type, ',' order by operation_type) from inventory_private.mutation_receipts where operation_id in ('${reversalOp}', '${purchaseLineRpcArgs(preview, 1).p_operation_id}')`),
      "purchase_delete,purchase_manual", "both the purchase and its reversal remain on the receipt audit trail");
    assert.deepEqual(JSON.parse(db.asOwner(`select public.delete_posted_purchase_if_reversible('${reversalOp}', '${posted.supply_id}');`)), reversed, "the reversal is itself idempotent");

    // a purchase onto ZERO stock erases the prior average arithmetically; the recorded snapshot restores it exactly
    const certified = createIngredient(db, "ZeroStock", 0, 2.5, { trusted: true });
    const onZero = previewFor([{ raw_name: certified.name, quantity: 100, unit: "g", total_price: 50 }], [certified]);
    const postedOnZero = applyLine(db, onZero, 1);
    assert.equal(db.q1(`select (average_unit_cost = 0.5)::text from public.ingredients where id = '${certified.id}'`), "true");
    db.asOwner(`select public.delete_posted_purchase_if_reversible('${crypto.randomUUID()}', '${postedOnZero.supply_id}');`);
    assert.equal(db.q1(`select (current_quantity = 0 and average_unit_cost = 2.5)::text from public.ingredients where id = '${certified.id}'`), "true", "the certified 2.5 comes back exactly");
  });

  await t.test("reversal REFUSES (rather than corrupts) once any later movement exists", () => {
    const flour = createIngredient(db, "Later", 1000, 0.5);
    const first = applyLine(db, previewFor([{ raw_name: flour.name, quantity: 500, unit: "g", total_price: 400 }], [flour]), 1);
    const second = applyLine(db, previewFor([{ raw_name: flour.name, quantity: 100, unit: "g", total_price: 100 }], [flour]), 1);
    const before = footprint(db, flour.id);
    db.fails(session(OWNER_A, "owner"), `select public.delete_posted_purchase_if_reversible('${crypto.randomUUID()}', '${first.supply_id}');`,
      /23514[\s\S]*Later inventory activity exists/, "an earlier purchase behind a later purchase");
    assert.deepEqual(footprint(db, flour.id), before, "state unchanged by the refused reversal");
    assert.equal(db.n(`select count(*) from public.supply_entries where id = '${first.supply_id}'`), 1);

    // a later non-purchase movement also blocks it
    const sugar = createIngredient(db, "LaterAdjust", 1000, 0.5);
    const posted = applyLine(db, previewFor([{ raw_name: sugar.name, quantity: 500, unit: "g", total_price: 400 }], [sugar]), 1);
    const latest = db.q1(`select id from public.inventory_transactions where ingredient_id = '${sugar.id}' order by created_at desc, id desc limit 1`);
    db.asOwner(`select public.apply_raw_inventory_adjustment('${sugar.id}', -20, 'delta', 'waste_or_spoilage', 'later waste', 1500, '${latest}', 'g');`);
    const afterAdjust = footprint(db, sugar.id);
    db.fails(session(OWNER_A, "owner"), `select public.delete_posted_purchase_if_reversible('${crypto.randomUUID()}', '${posted.supply_id}');`,
      /23514[\s\S]*Later inventory activity exists/, "a purchase behind a later adjustment");
    assert.deepEqual(footprint(db, sugar.id), afterAdjust);
    // the later purchase itself IS still the latest movement and remains reversible
    db.asOwner(`select public.delete_posted_purchase_if_reversible('${crypto.randomUUID()}', '${second.supply_id}');`);
    assert.equal(footprint(db, flour.id).qty, 1500);
  });

  await t.test("a reversed purchase cannot be re-posted under the same occasion: the retry REPLAYS a stale result (so verify must read rows, not trust results)", () => {
    const flour = createIngredient(db, "Stale", 1000, 0.5);
    const preview = previewFor([{ raw_name: flour.name, quantity: 500, unit: "g", total_price: 400 }], [flour]);
    const original = applyLine(db, preview, 1);
    db.asOwner(`select public.delete_posted_purchase_if_reversible('${crypto.randomUUID()}', '${original.supply_id}');`);
    const afterReversal = footprint(db, flour.id);
    const retry = applyLine(db, preview, 1);
    assert.deepEqual(retry, original, "the receipt replays the stored result");
    assert.equal(db.n(`select count(*) from public.supply_entries where id = '${retry.supply_id}'`), 0, "...whose supply_id no longer exists");
    assert.deepEqual(footprint(db, flour.id), afterReversal, "nothing was re-posted: a corrected purchase needs a NEW occasion_id");
  });
});

test("Purchases V3 (POST-V4 state): cost_trusted is observed not assumed; replay, collision and reversal still hold", SKIP, async (t) => {
  const db = await startDatabase(t, "post-v4", true);
  assert.equal(db.n(`select count(*) from pg_proc where proname = 'resolve_purchase_cost_trust'`), 1, "this database really is post-V4");

  await t.test("the preview-store migration also applies on a post-V4 chain, and the owner can use it", () => {
    const flour = createIngredient(db, "V4Store", 1000, 0.5);
    const preview = previewFor([{ raw_name: flour.name, quantity: 1, unit: "kg", total_price: 95 }], [flour]);
    db.run(`${session(OWNER_A, "owner")} ${insertPreviewSql(preview)}`);
    assert.equal(db.asOwner(`select count(*) from ${TABLE} where preview_id = '${preview.preview_id}';`), "1");
    assert.equal(db.asSession(session(OWNER_B, "owner"), `select count(*) from ${TABLE} where preview_id = '${preview.preview_id}';`), "0");
  });

  await t.test("post_raw_purchase still posts correctly; cost_trusted is a boolean that agrees with cost_reconciled_at, whatever its value", () => {
    const observed = new Set<boolean>();
    for (const [label, qty, avg, trusted] of [["Zero", 0, null, false], ["Untrusted", 500, 1, false], ["Trusted", 500, 1, true]] as const) {
      const ingredient = createIngredient(db, `V4 ${label}`, qty, avg, { trusted });
      const preview = previewFor([{ raw_name: ingredient.name, quantity: 100, unit: "g", total_price: 50 }], [ingredient]);
      const result = applyLine(db, preview, 1);
      assert.equal(result.quantity_after, qty + 100);
      assert.equal(typeof result.cost_trusted, "boolean");
      assert.equal(result.cost_trusted, footprint(db, ingredient.id).trustAt !== null, `${label}: reported trust matches the stored marker`);
      observed.add(result.cost_trusted as boolean);
    }
    assert.ok(observed.size >= 1, "observed values are recorded, none is required");
    console.log(`[post-v4] cost_trusted values observed across the three cases: ${[...observed].join(", ")}`);
  });

  await t.test("replay returns the stored result (including cost_trusted); a changed payload fails closed with 23514; nothing is duplicated", () => {
    const flour = createIngredient(db, "V4Replay", 1000, 0.5);
    const items: PurchaseItemInput[] = [{ raw_name: flour.name, quantity: 2, unit: "kg", total_price: 190 }];
    const preview = previewFor(items, [flour]);
    const args = purchaseLineRpcArgs(preview, 1);
    const original = applyArgs(db, args);
    const baseline = footprint(db, flour.id, [args.p_operation_id]);
    assert.deepEqual(applyLine(db, preview, 1), original);
    assert.deepEqual(footprint(db, flour.id, [args.p_operation_id]), baseline);
    for (const corrected of [
      previewFor([{ ...items[0], total_price: 191 }], [flour], { occasion_id: preview.occasion_id }),
      previewFor(items, [flour], { occasion_id: preview.occasion_id, supplier: "SM Market" }),
      previewFor(items, [flour], { occasion_id: preview.occasion_id, purchase_date: "2026-03-03" }),
    ]) {
      assert.equal(purchaseLineRpcArgs(corrected, 1).p_operation_id, args.p_operation_id);
      db.fails(session(OWNER_A, "owner"), postRawPurchaseSql(purchaseLineRpcArgs(corrected, 1)), COLLISION, "post-V4 collision");
      assert.deepEqual(footprint(db, flour.id, [args.p_operation_id]), baseline);
    }
  });

  await t.test("explicit supplier, date and brand persist on post-V4 too", () => {
    const flour = createIngredient(db, "V4Persist", 1000, 0.5);
    const preview = previewFor([{ raw_name: flour.name, quantity: 2, unit: "kg", total_price: 190, brand: "Gold Medal" }], [flour], { purchase_date: "2026-03-02", supplier: "  Puregold " });
    const result = applyLine(db, preview, 1);
    assert.equal(db.q1(`select concat_ws('|', supplier_name, purchase_date::text, brand_name) from public.supply_entries where id = '${result.supply_id}'`), `Puregold|2026-03-02|Gold Medal`);
  });

  await t.test("reversal restores exact quantity, average cost AND the cost-trust marker the purchase found", () => {
    for (const [label, qty, avg, trusted] of [["RevZero", 0, 2.5, false], ["RevPositive", 1000, 0.5, false], ["RevTrusted", 1000, 0.5, true]] as const) {
      const ingredient = createIngredient(db, label, qty, avg, { trusted });
      const before = footprint(db, ingredient.id);
      const posted = applyLine(db, previewFor([{ raw_name: ingredient.name, quantity: 500, unit: "g", total_price: 400 }], [ingredient]), 1);
      db.asOwner(`select public.delete_posted_purchase_if_reversible('${crypto.randomUUID()}', '${posted.supply_id}');`);
      const after = footprint(db, ingredient.id);
      assert.equal(after.qty, before.qty, `${label}: quantity`);
      assert.equal(after.avg, before.avg, `${label}: average cost`);
      assert.equal(after.trustAt, before.trustAt, `${label}: cost-trust marker`);
    }
  });
});
