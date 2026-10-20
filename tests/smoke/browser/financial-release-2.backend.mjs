// Disposable test backend for browser verification. NEVER touches production:
//   Postgres (docker, test-only password) <- real PostgREST (docker) <- node shim (auth + CORS + proxy)
// Seeds through the REAL Bake / order / reservation functions. Prints a state file and stays running.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";

const REPO = path.resolve(import.meta.dirname, "../../..");
const STATE = process.argv[2];
if (!STATE) throw new Error("Pass the disposable state output path");
const sql = (f) => readFileSync(`${REPO}/${f}`, "utf8");
const tag = `finqa${Date.now()}`;
const NET = `${tag}-net`, PG = `${tag}-pg`, REST = `${tag}-rest`;
const JWT_SECRET = crypto.randomBytes(24).toString("hex"); // 48 chars
const OWNER_SUB = "55555555-5555-4555-8555-555555555555";
const PGPW = "test-only";

const docker = (...a) => execFileSync("docker", a, { encoding: "utf8", stdio: "pipe" });
const psql = (input, db = "postgres") => execFileSync("docker", ["exec", "-i", PG, "psql", "-U", "postgres", "-d", db, "-v", "ON_ERROR_STOP=1", "-tA"], { input, encoding: "utf8", stdio: "pipe" });

docker("network", "create", NET);
docker("run", "-d", "--name", PG, "--network", NET, "-p", "127.0.0.1::5432", "-e", `POSTGRES_PASSWORD=${PGPW}`, "postgres:17-alpine");
for (let i = 0; i < 90; i++) { try { if (psql("select 1").trim() === "1") break; } catch {} await new Promise((r) => setTimeout(r, 1000)); }
await new Promise((r) => setTimeout(r, 800));

// ---- base environment: roles + Supabase-like auth functions reading the PostgREST claims ----
psql(`create role authenticated; create role anon; create role service_role;
  create role authenticator login noinherit password '${PGPW}';
  grant anon, authenticated to authenticator;
  create schema auth;
  create function auth.jwt() returns jsonb language sql stable as 'select coalesce(nullif(current_setting(''request.jwt.claims'', true), ''''), ''{}'')::jsonb';
  create function auth.uid() returns uuid language sql stable as 'select nullif(auth.jwt()->>''sub'','''')::uuid';
  grant usage on schema auth to anon, authenticated;
  grant usage on schema public to anon, authenticated;
  create function public.current_app_role() returns text language sql stable as 'select auth.jwt()->''app_metadata''->>''app_role''';
  create function public.is_product_lab_owner() returns boolean language sql stable as 'select public.current_app_role() = ''owner''';
  grant execute on function public.current_app_role(), public.is_product_lab_owner() to authenticated, anon;`);

// ---- the app's real SQL, in dependency order ----
const chain = [
  "supabase-schema.sql", "supabase-add-supplies.sql", "supabase-add-inventory.sql",
];
for (const f of chain) psql(sql(f));
psql(`alter table purchase_imports add column supplier_name text, add column receipt_number text, add column purchase_date date;
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
  create policy owner_supplies on supply_entries for all to authenticated using (public.is_product_lab_owner()) with check (public.is_product_lab_owner());
  grant select, insert, update, delete on products, product_batches, batch_photos, costing_entries, costing_summaries, tasting_feedback, content_journal to authenticated;`);
for (const f of [
  "supabase-add-selling-formats.sql", "supabase-add-equipment.sql", "supabase-add-content-drafts.sql", "supabase-add-ai-reviews.sql", "supabase-add-brand-profiles.sql",
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
]) psql(sql(f));
psql(`create schema storage; create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]); create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid); alter table storage.objects enable row level security; create function storage.foldername(text) returns text[] language sql immutable as 'select string_to_array($1, ''/'')';`);
for (const f of ["supabase/migrations/20260924120000_bake_actual_correction.sql", "supabase/migrations/20260924180000_bake_actual_correction_postgrest_safe_stale.sql", "supabase/migrations/20261013090000_product_media_library_v1.sql"]) {
  if (existsSync(`${REPO}/${f}`)) { psql(sql(f)); }
}
psql(sql("supabase/migrations/20261019120000_order_refund_correction.sql"));
psql(sql("supabase/migrations/20261020120000_order_payment_incident_events.sql"));
// production order: the expenses migration is applied for the main run (a separate run omits it)
if (!process.argv.includes("--no-expenses-migration")) psql(sql("supabase/migrations/20261016120000_business_expenses.sql"));

for (const file of ["supabase/migrations/20261020202509_raw_inventory_reversal_boundary_restore.sql", "supabase/migrations/20261020203106_financial_release_2_stock_attribution.sql"]) psql(sql(file));

// ---- seed: real Bake, real order flow; September left uncosted on purpose ----
const OWNER = `set role authenticated;
  select set_config('request.jwt.claims','{"sub":"${OWNER_SUB}","role":"authenticated","app_metadata":{"app_role":"owner"}}',false);`;
const own = (s) => psql(`${OWNER} ${s}`).trim().split("\n").filter(Boolean).at(-1) ?? "";
const u = () => crypto.randomUUID();
const flour = u(), cocoa = u(), cust = u(), batchB = u(), batchC = u();
psql(`insert into products (id, name, category, product_role, status) values ('brownie','Fudgy Brownie','Bakery','Hero candidate','testing'),('cookie','Choc Cookie','Bakery','Add-on candidate','testing');
  insert into product_batches (id, product_id, batch_version, status, date_made, usable_pieces) values ('${batchB}','brownie','v1','completed', current_date - 20, 12),('${batchC}','cookie','v1','completed', current_date - 20, 12);
  insert into ingredients (id, name, base_unit, category, current_quantity, average_unit_cost, inventory_reconciled_at, cost_reconciled_at) values
    ('${flour}','Flour','g','ingredient',5000,0.05,now(),now()),('${cocoa}','Cocoa','g','ingredient',2000,0.20,now(),now());
  insert into customers (id, name) values ('${cust}','Test Customer');`);
own(`select public.confirm_bake_v3('${u()}','${batchB}','brownie','Brownie v1',1,12,'[{"ingredient_id":"${flour}","quantity":600},{"ingredient_id":"${cocoa}","quantity":150}]'::jsonb);`);
own(`select public.confirm_bake_v3('${u()}','${batchC}','cookie','Cookie v1',1,12,'[{"ingredient_id":"${flour}","quantity":300}]'::jsonb);`);

function order({ product, qty, price, pieces = 1, flow, paid, monthOffsetDays }) {
  const id = u();
  psql(`insert into orders (id, customer_id, status) values ('${id}','${cust}','new');
    insert into order_lines (id, order_id, product_id, item_name, unit_price, pieces_per_unit_snapshot, quantity) values ('${u()}','${id}','${product}','${product}',${price},${pieces},${qty});`);
  if (flow === "complete") { own(`select public.confirm_order_with_reservation('${u()}','${id}');`); own(`select public.complete_order_with_fulfillment('${u()}','${id}');`); }
  if (flow === "confirm") own(`select public.confirm_order_with_reservation('${u()}','${id}');`);
  const when = `now() - interval '${monthOffsetDays} days'`;
  const total = qty * price;
  psql(`update orders set ${flow === "complete" ? `completed_at = ${when},` : ""} ${paid ? `payment_status='paid', payment_method='${paid}', paid_at=${when}, paid_amount=${total},` : ""} placed_at = ${when} where id='${id}';`);
  return id;
}
// OCTOBER (this month): fully costed through the real flow
order({ product: "brownie", qty: 4, price: 60, flow: "complete", paid: "gcash", monthOffsetDays: 2 });   // 240 paid
order({ product: "cookie", qty: 6, price: 40, flow: "complete", paid: "cash", monthOffsetDays: 1 });      // 240 paid
order({ product: "brownie", qty: 2, price: 60, flow: "complete", paid: null, monthOffsetDays: 1 });       // 120 receivable
order({ product: "cookie", qty: 3, price: 40, flow: "confirm", paid: "gcash", monthOffsetDays: 0 });      // deposit 120
// SEPTEMBER (previous month, uncosted): completed with NO allocation, like pre-tracking orders
for (const d of [40, 38, 35]) {
  const id = u();
  psql(`insert into orders (id, customer_id, status, payment_status, payment_method, paid_at, paid_amount, placed_at) values ('${id}','${cust}','new','paid','cash', now() - interval '${d} days', 100, now() - interval '${d} days');
    insert into order_lines (id, order_id, product_id, item_name, unit_price, pieces_per_unit_snapshot, quantity) values ('${u()}','${id}','brownie','Brownie',50,1,2);
    begin; select set_config('inventory_private.order_transition_authorized','true',true);
    update orders set status='completed', completed_at = now() - interval '${d} days' where id='${id}'; commit;`);
}

// ---- PostgREST (max rows 1000, like hosted) ----
psql(`notify pgrst, 'reload schema';`);
docker("run", "-d", "--name", REST, "--network", NET, "-p", "127.0.0.1::3000",
  "-e", `PGRST_DB_URI=postgres://authenticator:${PGPW}@${PG}:5432/postgres`, "-e", "PGRST_DB_SCHEMAS=public", "-e", "PGRST_DB_ANON_ROLE=anon",
  "-e", `PGRST_JWT_SECRET=${JWT_SECRET}`, "-e", "PGRST_DB_MAX_ROWS=1000", "-e", "PGRST_OPENAPI_MODE=disabled", "postgrest/postgrest:latest");
const restPort = docker("port", REST, "3000/tcp").trim().split(":").at(-1);
for (let i = 0; i < 60; i++) { try { const r = await fetch(`http://127.0.0.1:${restPort}/products?limit=0`); if (r.status < 500) break; } catch {} await new Promise((r) => setTimeout(r, 1000)); }

// ---- auth shim + proxy ----

const user = { id: OWNER_SUB, aud: "authenticated", role: "authenticated", email: "owner@test.local", app_metadata: { app_role: "owner", provider: "email" }, user_metadata: {}, created_at: new Date().toISOString() };
async function session() {
  const now = Math.floor(Date.now() / 1000);
  const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
  const body = `${encode({alg:"HS256",typ:"JWT"})}.${encode({role:"authenticated",sub:OWNER_SUB,aud:"authenticated",app_metadata:user.app_metadata,email:user.email,iat:now,exp:now+3600})}`;
  const access = `${body}.${crypto.createHmac("sha256", JWT_SECRET).update(body).digest("base64url")}`;
  return { access_token: access, token_type: "bearer", expires_in: 3600, expires_at: now + 3600, refresh_token: "refresh-" + crypto.randomUUID(), user };
}
const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET,POST,PATCH,PUT,DELETE,OPTIONS", "access-control-expose-headers": "content-range,content-type" };
const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") { res.writeHead(204, cors); return res.end(); }
  const url = new URL(req.url, "http://x");
  const send = (code, body) => { res.writeHead(code, { ...cors, "content-type": "application/json" }); res.end(body === undefined ? "" : JSON.stringify(body)); };
  if (url.pathname === "/auth/v1/token") return send(200, await session());
  if (url.pathname === "/auth/v1/user") return send(200, user);
  if (url.pathname === "/auth/v1/logout") return send(204);
  if (url.pathname.startsWith("/rest/v1/")) {
    const target = http.request({ host: "127.0.0.1", port: restPort, path: url.pathname.slice("/rest/v1".length) + url.search, method: req.method, headers: { ...req.headers, host: `127.0.0.1:${restPort}` } }, (r) => { res.writeHead(r.statusCode, { ...r.headers, ...cors }); r.pipe(res); });
    target.on("error", () => send(502, { message: "proxy error" }));
    return req.pipe(target);
  }
  send(404, { message: "not found" });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const shimPort = server.address().port;
const pgPort = Number(docker("port", PG, "5432/tcp").trim().split(":").at(-1));
writeFileSync(STATE, JSON.stringify({ tag, NET, PG, REST, shimPort, restPort, pgPort, flour, cocoa, batchB, batchC, ownerSub: OWNER_SUB }, null, 1));
console.log("READY", shimPort);
async function cleanup() {
  await new Promise(resolve => server.close(resolve));
  docker("rm", "-f", REST, PG);
  docker("network", "rm", NET);
  process.exit(0);
}
process.once("SIGINT", cleanup);
process.once("SIGTERM", cleanup);
