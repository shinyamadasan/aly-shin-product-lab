import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// Cost System Simplification V4 -- database authority. Applies the full migration chain (Wave 0A ->
// 0B -> Wave 1 -> Cost Baseline Repair -> Safe Purchase Delete -> V4) to a disposable Postgres
// container and proves: a purchase establishes / preserves / withholds cost trust atomically,
// stock adjustments and purchase reversal keep trust truthful, Opening Cost Setup (the certify RPC)
// still behaves, and Bake still refuses an untrusted cost with cost-setup wording.

const root = path.resolve(import.meta.dirname, "../../..");
const sql = (file: string) => readFileSync(path.join(root, file), "utf8");
const OWNER_JWT = `select set_config('request.jwt.claim.sub','88888888-8888-4888-8888-888888888888',true);
  select set_config('request.jwt.claim.app_role','owner',true);
  select set_config('request.jwt.claims','{"sub":"88888888-8888-4888-8888-888888888888","role":"authenticated","app_metadata":{"app_role":"owner"}}',true);`;
const OWNER_SESSION = `set role authenticated;
  select set_config('request.jwt.claim.sub','88888888-8888-4888-8888-888888888888',false);
  select set_config('request.jwt.claim.app_role','owner',false);
  select set_config('request.jwt.claims','{"sub":"88888888-8888-4888-8888-888888888888","role":"authenticated","app_metadata":{"app_role":"owner"}}',false);`;

test("Cost System Simplification V4: automatic purchase trust, truthful reversal and adjustments, Opening Cost Setup, Bake guard", { skip: process.env.RUN_POSTGRES_SMOKE !== "1" }, async (t) => {
  const container = `aly-cost-v4-${Date.now()}`;
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
    create policy p_batches on public.product_batches for all to authenticated using (public.is_product_lab_owner()) with check (public.is_product_lab_owner());`);
  for (const migration of [
    "20260909132327_selling_wave_0a_raw_authority.sql",
    "20260909162224_selling_wave_0a_reversal_boundary.sql",
    "20260910022601_selling_wave_0b_safe_mutations.sql",
    "20260910120146_selling_wave_1_production_execution.sql",
    "20260912090000_cost_baseline_repair.sql",
    "20260912193053_claude_inventory_operator_v1a.sql",
    "20260917175840_safe_purchase_delete.sql",
    "20260921120000_cost_system_simplification_v4.sql",
  ]) {
    run(sql(`supabase/migrations/${migration}`));
  }

  // ---------------------------------------------------------------------------------------------
  // Helpers. Every statement runs as the owner through the public RPC surface, exactly like the app.
  // ---------------------------------------------------------------------------------------------
  const lastLine = (output: string) => output.trim().split("\n").filter(Boolean).at(-1) ?? "";
  const asOwner = (statement: string) => lastLine(run(`${OWNER_SESSION} ${statement}`));
  const q1 = (statement: string) => run(statement).trim();
  const uuid = () => crypto.randomUUID();
  const close = (actual: number, expected: number, message?: string) => assert.ok(Math.abs(actual - expected) < 1e-9, `${message ?? "value"}: expected ${expected}, got ${actual}`);

  type State = { qty: number; avg: number | null; trusted: boolean; at: string | null };
  const state = (id: string): State => JSON.parse(q1(`select json_build_object('qty', current_quantity, 'avg', average_unit_cost, 'trusted', cost_reconciled_at is not null, 'at', cost_reconciled_at) from public.ingredients where id = '${id}'`));

  // A count-verified ingredient (post_raw_purchase requires that), optionally already cost-trusted.
  function mk(qty: number, avg: number | null, trusted = false, unit = "g"): string {
    const id = uuid();
    run(`insert into public.ingredients (id, name, base_unit, current_quantity, average_unit_cost, inventory_reconciled_at, cost_reconciled_at)
      values ('${id}', 'V4 ${id.slice(0, 8)}', '${unit}', ${qty}, ${avg === null ? "null" : avg}, now(), ${trusted ? "now()" : "null"});`);
    return id;
  }
  const latestId = (id: string) => q1(`select id from public.inventory_transactions where ingredient_id = '${id}' order by created_at desc, id desc limit 1`);
  const latestSql = (id: string) => { const l = latestId(id); return l ? `'${l}'` : "null"; };

  function buy(id: string, baseQty: number, total: number, operationId = uuid(), packQty = baseQty, unit = "g"): { supply_id: string; transaction_id: string; quantity_after: number; average_unit_cost: number; cost_trusted: boolean } {
    return JSON.parse(asOwner(`select public.post_raw_purchase('${operationId}', '${id}', ${packQty}, '${unit}', ${baseQty}, ${total}, 'Brand', 'Supplier', current_date, 5, 'v4') ;`));
  }
  const reverse = (supplyId: string) => JSON.parse(asOwner(`select public.delete_posted_purchase_if_reversible('${uuid()}', '${supplyId}');`));
  const adjust = (id: string, quantity: number, mode: "count" | "delta", reason: string | null) => asOwner(
    `select public.apply_raw_inventory_adjustment('${id}', ${quantity}, '${mode}', ${reason ? `'${reason}'` : "null"}, 'v4 note', ${state(id).qty}, ${latestSql(id)}, 'g');`);
  const setOpeningCost = (id: string, cost: number, note = "Opening cost basis: test", expectedAvg: number | null = state(id).avg) => asOwner(
    `select public.certify_ingredient_cost_baseline('${id}', ${cost}, '${note}', ${expectedAvg === null ? "null" : expectedAvg}, ${state(id).qty}, ${latestSql(id)});`);
  function fails(statement: string, pattern: RegExp, message: string) {
    assert.throws(() => run(`${OWNER_SESSION} ${statement} reset role;`), (error: unknown) => {
      const text = String((error as { stderr?: unknown }).stderr ?? error);
      assert.match(text, pattern, message);
      return true;
    });
  }

  // ---------------------------------------------------------------------------------------------
  // 1. Purchase authority
  // ---------------------------------------------------------------------------------------------
  await t.test("B: zero stock + priced purchase establishes trust atomically (500 g for PHP 250 => PHP 0.50/g)", () => {
    const id = mk(0, null);
    const result = buy(id, 500, 250);
    assert.equal(result.cost_trusted, true);
    const s = state(id);
    assert.equal(s.qty, 500);
    close(s.avg!, 0.5, "average");
    assert.equal(s.trusted, true, "the purchase itself set cost_reconciled_at");
  });

  await t.test("B: zero stock with a stale, wrong previous average is not blended in", () => {
    const id = mk(0, 9.99); // an old average left over from before stock hit zero; zero weight
    buy(id, 200, 100);
    close(state(id).avg!, 0.5, "the previous average has zero weight at zero stock");
    assert.equal(state(id).trusted, true);
  });

  await t.test("A: trusted 100 g @ 0.30 + priced 100 g @ 0.50 => 200 g @ 0.40, trust kept, timestamp untouched", () => {
    const id = mk(100, 0.3, true);
    const before = state(id);
    const result = buy(id, 100, 50);
    assert.equal(result.cost_trusted, true);
    const after = state(id);
    assert.equal(after.qty, 200);
    close(after.avg!, 0.4, "weighted average");
    assert.equal(after.trusted, true);
    assert.equal(after.at, before.at, "an already-trusted cost keeps its original trust timestamp");
  });

  await t.test("the Flour example: 1 kg @ PHP 70, then 1 kg for PHP 90 => PHP 0.08/g, trusted throughout", () => {
    const id = mk(0, null);
    buy(id, 1000, 70, uuid(), 1, "kg");
    close(state(id).avg!, 0.07, "first purchase");
    assert.equal(state(id).trusted, true);
    buy(id, 1000, 90, uuid(), 1, "kg");
    close(state(id).avg!, 0.08, "second purchase");
    assert.equal(state(id).qty, 2000);
    assert.equal(state(id).trusted, true);
  });

  await t.test("C: positive UNTRUSTED stock + priced purchase posts, but trust stays unresolved (20 g unknown + 50 g for PHP 19)", () => {
    const id = mk(20, null);
    const result = buy(id, 50, 19);
    assert.equal(result.cost_trusted, false);
    const s = state(id);
    assert.equal(s.qty, 70, "the purchase still posts");
    close(s.avg!, 19 / 70, "weighted average behaves exactly as before");
    assert.equal(s.trusted, false, "the new price does not explain the older 20 g");
  });

  await t.test("E: negative previous stock + priced purchase never becomes (or stays) trusted", () => {
    const untrusted = mk(-10, 0.2);
    assert.equal(buy(untrusted, 50, 25).cost_trusted, false);
    assert.equal(state(untrusted).trusted, false);
    const wasTrusted = mk(-10, 0.2, true);
    assert.equal(buy(wasTrusted, 50, 25).cost_trusted, false);
    assert.equal(state(wasTrusted).trusted, false, "a purchase onto negative stock withholds trust even from a previously trusted Item");
  });

  await t.test("D: unpriced purchases cannot establish trust and do not invent a cost", () => {
    const zero = mk(0, null);
    assert.equal(buy(zero, 100, 0).cost_trusted, false);
    assert.equal(state(zero).trusted, false, "zero stock + unpriced purchase stays unresolved");
    close(state(zero).avg ?? 0, 0, "no cost invented");
    const positive = mk(50, 0.5);
    buy(positive, 50, 0);
    assert.equal(state(positive).trusted, false);
    const trusted = mk(100, 0.3, true);
    const before = state(trusted);
    buy(trusted, 100, 0);
    assert.equal(state(trusted).trusted, true, "existing unpriced-purchase semantics: trust is neither gained nor lost");
    assert.equal(state(trusted).at, before.at);
    close(state(trusted).avg!, 0.3, "unpriced units are valued at the existing average");
  });

  await t.test("12: a duplicate purchase retry (same operation id) mutates nothing twice", () => {
    const id = mk(0, null);
    const operationId = uuid();
    const first = buy(id, 500, 250, operationId);
    const replay = buy(id, 500, 250, operationId);
    assert.deepEqual(replay, first, "the replay returns the original result");
    assert.equal(state(id).qty, 500, "stock counted once");
    close(state(id).avg!, 0.5);
    assert.equal(q1(`select count(*) from public.supply_entries where ingredient_id = '${id}'`), "1");
    assert.equal(q1(`select count(*) from public.inventory_transactions where ingredient_id = '${id}' and transaction_type = 'purchase'`), "1");
  });

  // ---------------------------------------------------------------------------------------------
  // 2. CSV import shares the same rule
  // ---------------------------------------------------------------------------------------------
  function importRows(rows: { ingredient: string; qty: number; total: number }[]): string {
    const importId = uuid();
    run(`insert into public.purchase_imports (id, file_name, status, supplier_name, receipt_number, purchase_date) values ('${importId}', 'v4.csv', 'draft', 'SM', 'R', current_date);`);
    rows.forEach((row, index) => run(`insert into public.purchase_import_rows (import_id, row_index, raw_item_name, raw_quantity, raw_unit, raw_total_price, parsed_quantity, parsed_total_price, ingredient_id, match_method, converted_quantity, row_status, brand_name)
      values ('${importId}', ${index}, 'row', '${row.qty}', 'g', '${row.total}', ${row.qty}, ${row.total}, '${row.ingredient}', 'exact', ${row.qty}, 'matched', 'B');`));
    asOwner(`select public.confirm_purchase_import_v2('${uuid()}', '${importId}');`);
    return importId;
  }

  await t.test("CSV import: same rules -- zero stock all-priced trusts; mixed priced/unpriced does not; trusted stays; positive untrusted stays", () => {
    const zeroPriced = mk(0, null);
    importRows([{ ingredient: zeroPriced, qty: 500, total: 250 }]);
    assert.equal(state(zeroPriced).trusted, true);
    close(state(zeroPriced).avg!, 0.5);

    const zeroMixed = mk(0, null);
    importRows([{ ingredient: zeroMixed, qty: 500, total: 250 }, { ingredient: zeroMixed, qty: 100, total: 0 }]);
    assert.equal(state(zeroMixed).trusted, false, "an unpriced row means the stock is not fully explained by priced purchases");

    const trusted = mk(100, 0.3, true);
    importRows([{ ingredient: trusted, qty: 100, total: 50 }]);
    assert.equal(state(trusted).trusted, true);
    close(state(trusted).avg!, 0.4);

    const positiveUntrusted = mk(20, null);
    importRows([{ ingredient: positiveUntrusted, qty: 50, total: 19 }]);
    assert.equal(state(positiveUntrusted).trusted, false);
  });

  // ---------------------------------------------------------------------------------------------
  // 3. Stock adjustments and counts
  // ---------------------------------------------------------------------------------------------
  await t.test("F: an upward adjustment or count (stock no priced purchase backs) clears trust; average untouched", () => {
    const viaDelta = mk(100, 0.3, true);
    adjust(viaDelta, 25, "delta", "other"); // "Increase stock"
    assert.equal(state(viaDelta).qty, 125);
    assert.equal(state(viaDelta).trusted, false, "an Increase stock adjustment adds unknown-cost stock");
    close(state(viaDelta).avg!, 0.3, "the old average is left in place, only its trust is withdrawn");

    const viaCount = mk(100, 0.3, true);
    adjust(viaCount, 130, "count", null);
    assert.equal(state(viaCount).trusted, false, "a count that finds more than the ledger explains");
  });

  await t.test("F: a downward adjustment, a lower count and an exact recount keep trust", () => {
    const decrease = mk(100, 0.3, true);
    const before = state(decrease);
    adjust(decrease, -20, "delta", "waste_or_spoilage");
    assert.equal(state(decrease).qty, 80);
    assert.equal(state(decrease).trusted, true);
    assert.equal(state(decrease).at, before.at);

    const shrink = mk(100, 0.3, true);
    adjust(shrink, 90, "count", null);
    assert.equal(state(shrink).trusted, true);

    const exact = mk(100, 0.3, true);
    adjust(exact, 100, "count", null);
    assert.equal(state(exact).trusted, true);
  });

  await t.test("F: reversing a removal keeps trust (it only puts back stock that was already part of the counted stock)", () => {
    const id = mk(100, 0.3, true);
    adjust(id, -20, "delta", "waste_or_spoilage");
    const removalId = latestId(id);
    asOwner(`select public.apply_raw_inventory_adjustment('${id}', null, 'reverse', null, 'undo', ${state(id).qty}, '${removalId}', 'g', '${removalId}');`);
    assert.equal(state(id).qty, 100);
    assert.equal(state(id).trusted, true);
  });

  // ---------------------------------------------------------------------------------------------
  // 4. Purchase reversal
  // ---------------------------------------------------------------------------------------------
  await t.test("8: reversing the purchase that established trust returns to the exact pre-purchase quantity, cost AND trust", () => {
    const id = mk(0, null);
    const purchase = buy(id, 500, 250);
    assert.equal(state(id).trusted, true);
    const reversed = reverse(purchase.supply_id);
    assert.equal(reversed.cost_trusted, false);
    const s = state(id);
    assert.equal(s.qty, 0);
    assert.equal(s.trusted, false, "no stale trust once the only purchase that explained the stock is gone");
    assert.equal(s.avg, null, "the exact prior (null) average is restored");
  });

  await t.test("8: reversing a purchase onto stale prior average at zero stock restores that average and no trust", () => {
    const id = mk(0, 9.99);
    const purchase = buy(id, 200, 100);
    reverse(purchase.supply_id);
    close(state(id).avg!, 9.99, "exact prior average");
    assert.equal(state(id).trusted, false);
  });

  await t.test("8: reversing a purchase onto trusted stock leaves the stock trusted with its original timestamp", () => {
    const id = mk(100, 0.3, true);
    const before = state(id);
    const purchase = buy(id, 100, 50);
    reverse(purchase.supply_id);
    const after = state(id);
    assert.equal(after.qty, 100);
    close(after.avg!, 0.3);
    assert.equal(after.trusted, true);
    assert.equal(after.at, before.at);
  });

  await t.test("8: reversing a purchase that was posted onto UNTRUSTED positive stock leaves that stock unresolved", () => {
    const id = mk(20, null);
    const purchase = buy(id, 50, 19);
    reverse(purchase.supply_id);
    assert.equal(state(id).qty, 20);
    assert.equal(state(id).trusted, false);
  });

  await t.test("8: a purchase onto negative stock withholds trust and cannot be reversed at all (existing rule: no reversal into a negative balance), so no trust is ever restored on top of it", () => {
    const id = mk(-10, 0.2, true);
    const purchase = buy(id, 50, 25);
    assert.equal(state(id).trusted, false);
    fails(`select public.delete_posted_purchase_if_reversible('${uuid()}', '${purchase.supply_id}');`, /Inventory changed\. Reload and try again\./, "reversal into negative stock is refused");
    assert.equal(state(id).qty, 40, "the refused reversal changed nothing");
    assert.equal(state(id).trusted, false);
  });

  await t.test("8: a purchase posted before V4 (no cost_trust_managed marker) never touched trust, so its reversal leaves trust alone", () => {
    const id = mk(100, 0.3, true);
    const purchase = buy(id, 100, 50);
    run(`update public.inventory_transactions set purchase_reversal_snapshot = purchase_reversal_snapshot - 'cost_trust_managed' where id = '${purchase.transaction_id}';`);
    const before = state(id);
    reverse(purchase.supply_id);
    assert.equal(state(id).trusted, true);
    assert.equal(state(id).at, before.at);
  });

  await t.test("8: once Opening Cost Setup (or anything) follows a purchase, that purchase can no longer be reversed", () => {
    const id = mk(20, null);
    const purchase = buy(id, 50, 19);
    setOpeningCost(id, 0.38);
    fails(`select public.delete_posted_purchase_if_reversible('${uuid()}', '${purchase.supply_id}');`, /Later inventory activity exists/, "later ledger activity blocks reversal");
    assert.equal(state(id).qty, 70);
  });

  // ---------------------------------------------------------------------------------------------
  // 5. Opening Cost Setup (certify_ingredient_cost_baseline)
  // ---------------------------------------------------------------------------------------------
  await t.test("Opening Cost Setup: sets the basis and trust; quantity and purchase history unchanged; one audit row with the evidence", () => {
    const id = mk(20, null);
    buy(id, 50, 19); // 70 g, unresolved
    const suppliesBefore = q1(`select count(*) from public.supply_entries where ingredient_id = '${id}'`);
    const evidence = "Opening cost basis: PHP 19.00 / 50 g = PHP 0.38/g";
    setOpeningCost(id, 0.38, evidence);
    const s = state(id);
    assert.equal(s.qty, 70, "stock quantity does not change");
    close(s.avg!, 0.38);
    assert.equal(s.trusted, true);
    assert.equal(q1(`select count(*) from public.supply_entries where ingredient_id = '${id}'`), suppliesBefore, "purchase history does not change");
    assert.equal(q1(`select count(*) from public.inventory_transactions where ingredient_id = '${id}' and transaction_type = 'cost_certification' and quantity_change = 0 and note = '${evidence}'`), "1", "exactly one audit row carrying the evidence");
    const snapshot = JSON.parse(q1(`select cost_certification_snapshot from public.inventory_transactions where ingredient_id = '${id}' and transaction_type = 'cost_certification'`));
    assert.equal(snapshot.previous_cost_reconciled_at, null);
  });

  await t.test("9: after Opening Cost Setup the next priced purchase keeps a trusted weighted average automatically", () => {
    const id = mk(70, 0.2, false);
    setOpeningCost(id, 0.38);
    const at = state(id).at;
    const result = buy(id, 100, 50);
    assert.equal(result.cost_trusted, true);
    close(state(id).avg!, (70 * 0.38 + 50) / 170, "(70*0.38 + 50) / 170");
    assert.equal(state(id).trusted, true);
    assert.equal(state(id).at, at, "no second setup and no re-stamping");
  });

  await t.test("Opening Cost Setup rejects a non-positive cost, a missing evidence note and a non-owner", () => {
    const id = mk(70, 0.2);
    fails(`select public.certify_ingredient_cost_baseline('${id}', 0, 'x', 0.2, 70, null);`, /Opening cost must be a positive, finite number/, "zero cost");
    fails(`select public.certify_ingredient_cost_baseline('${id}', 0.4, '   ', 0.2, 70, null);`, /note describing the evidence/, "blank evidence");
    assert.throws(() => run(`set role authenticated; select public.certify_ingredient_cost_baseline('${id}', 0.4, 'x', 0.2, 70, null); reset role;`), /Only the product lab owner may set an opening cost/);
    assert.equal(state(id).trusted, false);
  });

  await t.test("11: a stale Opening Cost Setup (quantity/cost/ledger moved on) is refused with the cost-setup wording", () => {
    const id = mk(70, 0.2);
    const staleAvg = state(id).avg;
    const staleQty = state(id).qty;
    const staleLatest = latestSql(id);
    buy(id, 50, 19); // moves quantity, average and the ledger
    fails(`select public.certify_ingredient_cost_baseline('${id}', 0.38, 'stale', ${staleAvg}, ${staleQty}, ${staleLatest});`, /Cost details changed\. Reload and set the opening cost again\./, "stale baseline");
    assert.equal(state(id).trusted, false, "the stale attempt wrote nothing");
    assert.equal(q1(`select count(*) from public.inventory_transactions where ingredient_id = '${id}' and transaction_type = 'cost_certification'`), "0");
  });

  // ---------------------------------------------------------------------------------------------
  // 6. Concurrency
  // ---------------------------------------------------------------------------------------------
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

  await t.test("11: an Opening Cost Setup racing a purchase on the same Item -- the purchase wins, the stale setup is refused, trust is never stamped over a moved baseline", async () => {
    const id = mk(20, null);
    const expectedQty = state(id).qty;
    const purchase = spawnPsqlAsync(`${owner(`select id from public.ingredients where id = '${id}' for update; select pg_sleep(1.0);`)} select public.post_raw_purchase('${uuid()}', '${id}', 50, 'g', 50, 19, 'B', 'S', current_date, 5, 'p'); commit;`);
    await sleep(300);
    const setup = spawnPsqlAsync(`${owner()} select public.certify_ingredient_cost_baseline('${id}', 0.38, 'racing setup', null, ${expectedQty}, null); commit;`);
    const [rp, rs] = await Promise.all([purchase, setup]);
    assert.ok(!/ERROR/.test(rp.stdout), `the purchase must succeed: ${rp.stdout}`);
    assert.match(rs.stdout, /Cost details changed/, "the setup built on the pre-purchase baseline must be refused");
    assert.equal(state(id).qty, 70);
    assert.equal(state(id).trusted, false, "C: the purchase alone does not explain the older 20 g");
    assert.equal(q1(`select count(*) from public.inventory_transactions where ingredient_id = '${id}' and transaction_type = 'cost_certification'`), "0");
  });

  await t.test("11: two concurrent Opening Cost Setups -- exactly one applies, one audit row", async () => {
    const id = mk(70, 0.2);
    const a = spawnPsqlAsync(`${owner(`select id from public.ingredients where id = '${id}' for update; select pg_sleep(1.0);`)} select public.certify_ingredient_cost_baseline('${id}', 0.38, 'A', 0.2, 70, null); commit;`);
    await sleep(300);
    const b = spawnPsqlAsync(`${owner()} select public.certify_ingredient_cost_baseline('${id}', 0.5, 'B', 0.2, 70, null); commit;`);
    const [ra, rb] = await Promise.all([a, b]);
    const aOk = !/ERROR/.test(ra.stdout);
    const bOk = !/ERROR/.test(rb.stdout);
    assert.notEqual(aOk, bOk, "exactly one concurrent setup succeeds");
    assert.match(aOk ? rb.stdout : ra.stdout, /Cost details changed/);
    close(state(id).avg!, aOk ? 0.38 : 0.5, "the winner's value, not a blend");
    assert.equal(q1(`select count(*) from public.inventory_transactions where ingredient_id = '${id}' and transaction_type = 'cost_certification'`), "1");
  });

  await t.test("12: two concurrent purchases of one operation id post exactly once", async () => {
    const id = mk(0, null);
    const operationId = uuid();
    const call = () => spawnPsqlAsync(`${owner()} select public.post_raw_purchase('${operationId}', '${id}', 500, 'g', 500, 250, 'B', 'S', current_date, 5, 'p'); commit;`);
    await Promise.all([call(), call()]);
    assert.equal(state(id).qty, 500, "stock counted once");
    assert.equal(q1(`select count(*) from public.supply_entries where ingredient_id = '${id}'`), "1");
    assert.equal(state(id).trusted, true);
  });

  // ---------------------------------------------------------------------------------------------
  // 7. Bake
  // ---------------------------------------------------------------------------------------------
  function bakeFixture() {
    const productId = `v4-${uuid().slice(0, 8)}`;
    const batchId = uuid();
    run(`insert into public.products (id, name) values ('${productId}', 'V4 Product');
      insert into public.product_batches (id, product_id, batch_version, status, usable_pieces) values ('${batchId}', '${productId}', 'v1', 'completed', 10);`);
    const bakeSql = (ingredientId: string, quantity: number) =>
      `select public.confirm_bake_v3('${uuid()}', '${batchId}', '${productId}', 'V4', 1, 10, '[{"ingredient_id":"${ingredientId}","quantity":${quantity}}]'::jsonb);`;
    const bake = (ingredientId: string, quantity: number) => asOwner(bakeSql(ingredientId, quantity));
    return { productId, bake, bakeSql };
  }

  await t.test("Bake refuses an Item whose cost is not trusted, in cost-setup wording, and writes nothing", () => {
    const { bake } = bakeFixture();
    const id = mk(70, 0.2);
    const name = q1(`select name from public.ingredients where id = '${id}'`);
    fails(`select public.confirm_bake_v3('${uuid()}', (select id from public.product_batches limit 1), (select product_id from public.product_batches limit 1), 'V4', 1, 10, '[{"ingredient_id":"${id}","quantity":10}]'::jsonb);`,
      new RegExp(`Opening cost setup is needed for ${name} before this Bake can be confirmed\\.`), "cost-setup wording");
    assert.equal(state(id).qty, 70, "no stock consumed");
    void bake;
  });

  await t.test("10: Opening Cost Setup never changes a historical Bake's frozen cost; a later Bake uses the new basis", () => {
    const { bake, productId } = bakeFixture();
    const id = mk(0, null);
    buy(id, 1000, 100); // trusted @ 0.10/g via the purchase itself
    bake(id, 100); // frozen 100 * 0.10 = 10
    const frozen = () => q1(`select frozen_ingredient_cost_total from public.production_executions where product_id = '${productId}' order by completed_at limit 1`);
    close(Number(frozen()), 10, "frozen at the purchase-derived cost");
    adjust(id, state(id).qty + 100, "count", null); // finds 100 g more than the ledger explains -> trust withdrawn
    assert.equal(state(id).trusted, false);
    setOpeningCost(id, 0.5); // a very different basis
    close(Number(frozen()), 10, "the historical frozen cost is untouched by the new opening basis");
    assert.equal(q1(`select count(*) from public.production_executions where product_id = '${productId}'`), "1");
    bake(id, 100); // now allowed again, at 0.50
    close(Number(q1(`select max(frozen_ingredient_cost_total) from public.production_executions where product_id = '${productId}'`)), 50, "the new Bake freezes the opening basis");
  });

  await t.test("a zero-stock Item never blocks or nags: the next priced purchase makes it Bake-ready with no setup step", () => {
    const { bake, productId } = bakeFixture();
    const id = mk(0, null);
    buy(id, 500, 250);
    bake(id, 100);
    close(Number(q1(`select frozen_ingredient_cost_total from public.production_executions where product_id = '${productId}'`)), 50);
  });

  await t.test("no automatic backfill: applying V4 marked nothing trusted", () => {
    // The V4 migration ran before any fixture above existed, so it could only have touched rows that
    // pre-dated it. Prove the mechanism too: nothing in the migration writes trust outside the rules.
    const migration = sql("supabase/migrations/20260921120000_cost_system_simplification_v4.sql");
    assert.doesNotMatch(migration, /update public\.ingredients\s+set\s+cost_reconciled_at\s*=\s*(now|clock_timestamp)/i);
    assert.doesNotMatch(migration, /backfill_clean_cost_baselines\(\)/);
  });
});
