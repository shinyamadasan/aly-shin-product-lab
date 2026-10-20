// Financial Release 1, end to end: REAL database machinery (Bake, purchase, order confirm/complete,
// the expense functions, the order_raw_cogs view) on a disposable Postgres, with the database's own
// output fed through the SAME TypeScript report the app uses. Proves the mandatory acceptance cases
// against the actual RPCs rather than against fixtures:
//   * buying ingredients does not move profit;  * baking does not move profit or COGS;
//   * fulfilment recognizes exactly the frozen cost the database computed;
//   * a refund is contra-revenue and does not give the ingredients back;
//   * expenses are idempotent, voidable, and reconcile;
//   * adding the expenses migration changes no existing financial record.
// Chain: Wave 0A/0B/1 -> orders -> Wave 2/3 -> Cost Baseline Repair -> Safe Purchase Delete -> V4 ->
// Finished Stock Opening Balance -> Financial Release 1, i.e. the production order.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { mapExpenseRow, type BusinessExpenseRow } from "../../../src/lib/finance/expenses.ts";
import { currentMonthKey, FINANCIAL_REPORTING_START_MONTH } from "../../../src/lib/finance/period.ts";
import { buildFinancialBalances, buildMonthlyFinancialReport, type FinanceInputs } from "../../../src/lib/finance/report.ts";
import { mapOrderLineRow, mapOrderRow } from "../../../src/lib/orders/mappers.ts";
import { mapFinishedStockMovementRow, mapIngredientRow, mapOrderRawCogsRow, mapProductionExecutionRow } from "../../../src/lib/supabase-mappers.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const sql = (file: string) => readFileSync(path.join(root, file), "utf8");
const OWNER = `set role authenticated;
  select set_config('request.jwt.claim.sub','55555555-5555-4555-8555-555555555555',false);
  select set_config('request.jwt.claim.app_role','owner',false);
  select set_config('request.jwt.claims','{"sub":"55555555-5555-4555-8555-555555555555","role":"authenticated","app_metadata":{"app_role":"owner"}}',false);`;

test("Financial Release 1 against the real database machinery", { skip: process.env.RUN_POSTGRES_SMOKE !== "1" }, async (t) => {
  const container = `aly-finance-e2e-${Date.now()}`;
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
    "supabase/migrations/20261019120000_order_refund_correction.sql",
    "supabase/migrations/20261020120000_order_payment_incident_events.sql",
  ]) {
    run(sql(migration));
  }

  const asOwner = (statement: string) => run(`${OWNER} ${statement}`).trim().split("\n").filter(Boolean).at(-1) ?? "";
  const uuid = () => crypto.randomUUID();
  const today = run("select (clock_timestamp() at time zone 'Asia/Manila')::date").trim();
  const month = currentMonthKey(Date.now());
  const resultExpected = month >= FINANCIAL_REPORTING_START_MONTH;

  // ------------------------------------------------------------------------------------------------
  // Seed, BEFORE the expenses migration exists: one ingredient, one Bake, one purchase.
  // ------------------------------------------------------------------------------------------------
  const flour = uuid(), product = "e2e-brownie", batch = uuid(), customer = uuid();
  run(`insert into public.ingredients (id, name, base_unit, current_quantity, average_unit_cost, inventory_reconciled_at, cost_reconciled_at)
         values ('${flour}', 'E2E Flour', 'g', 1000, 0.05, now(), now());
       insert into public.products (id, name) values ('${product}', 'E2E Brownie');
       insert into public.product_batches (id, product_id, batch_version, status, usable_pieces) values ('${batch}', '${product}', 'v1', 'completed', 10);
       insert into public.customers (id, name) values ('${customer}', 'E2E Customer');`);

  // The ledger does not exist until its migration is applied, exactly as in production today: until
  // then the report must treat it as UNAVAILABLE rather than as an empty ledger.
  let ledgerApplied = false;

  function load(): FinanceInputs {
    // jsonb text is always one line; json_agg output spans several, which the last-line reader would split.
    const dump = JSON.parse(asOwner(`select (json_build_object(
      'orders', (select coalesce(json_agg(o), '[]'::json) from public.orders o),
      'lines', (select coalesce(json_agg(l), '[]'::json) from public.order_lines l),
      'cogs', (select coalesce(json_agg(c), '[]'::json) from public.order_raw_cogs c),
      'ingredients', (select coalesce(json_agg(i), '[]'::json) from public.ingredients i),
      'lots', (select coalesce(json_agg(p), '[]'::json) from public.production_executions p),
      'moves', (select coalesce(json_agg(m), '[]'::json) from public.finished_stock_movements m),
      'supplies', (select coalesce(json_agg(s), '[]'::json) from public.supply_entries s),
      'expenses', ${ledgerApplied ? "(select coalesce(json_agg(e), '[]'::json) from public.business_expenses e)" : "'[]'::json"}))::jsonb::text`));
    const linesByOrderId = new Map<string, ReturnType<typeof mapOrderLineRow>[]>();
    for (const row of dump.lines) {
      const line = mapOrderLineRow(row);
      linesByOrderId.set(line.orderId, [...(linesByOrderId.get(line.orderId) ?? []), line]);
    }
    return {
      orders: dump.orders.map(mapOrderRow),
      linesByOrderId,
      cogsByOrderId: new Map(dump.cogs.map((row: Parameters<typeof mapOrderRawCogsRow>[0]) => [row.order_id, mapOrderRawCogsRow(row)])),
      expenses: ledgerApplied ? dump.expenses.map((row: BusinessExpenseRow) => mapExpenseRow(row)) : null,
      supplies: dump.supplies.map((row: Record<string, unknown>) => ({ id: row.id, ingredientId: row.ingredient_id ?? "", ingredientName: row.ingredient_name, brandName: row.brand_name ?? "", supplierName: row.supplier_name, purchaseDate: row.purchase_date, createdAt: row.created_at, packQuantity: Number(row.pack_quantity), unit: row.unit ?? "", totalCost: Number(row.total_cost), qualityRating: Number(row.quality_rating), notes: row.notes ?? "" })),
      ingredients: dump.ingredients.map((row: Parameters<typeof mapIngredientRow>[0] & { cost_reconciled_at: string | null }) => ({ ...mapIngredientRow(row), costReconciledAt: row.cost_reconciled_at })),
      productionExecutions: dump.lots.map(mapProductionExecutionRow),
      finishedStockMovements: dump.moves.map(mapFinishedStockMovementRow),
      truncated: false,
      stockTruncated: false,
    } as unknown as FinanceInputs;
  }
  const report = () => buildMonthlyFinancialReport(load(), month);
  const balances = () => buildFinancialBalances(load(), Date.now());
  const profitFacts = (r: ReturnType<typeof report>) => ({ sales: r.sales, cogs: r.cogs, grossMargin: r.grossMargin, operatingResult: r.operatingResult, expenses: r.expenses });

  const empty = report();
  assert.equal(empty.sales.recognizedRevenue, 0);
  assert.equal(empty.cogs.ingredientCogs, 0);
  assert.deepEqual(empty.operatingResult, { value: null, withheld: "expenses-unavailable" }, "before the migration the ledger is unavailable, not zero");
  assert.ok(empty.warnings.some((warning) => warning.code === "expenses-unavailable"));

  await t.test("baking moves cost into finished goods and leaves profit and COGS untouched", () => {
    // 400 g of flour at 0.05 = 20.00 for 10 usable pieces => 2.00 per piece, frozen.
    asOwner(`select public.confirm_bake_v3('${uuid()}', '${batch}', '${product}', 'E2E Brownie v1', 1, 10, '[{"ingredient_id":"${flour}","quantity":400}]'::jsonb);`);
    assert.equal(run("select frozen_cost_per_piece::float8 from public.production_executions").trim(), "2");
    assert.deepEqual(profitFacts(report()), profitFacts(empty), "a Bake is not revenue, COGS or an expense");
    const stock = balances();
    assert.equal(stock.finishedGoods.pieces, 10);
    assert.equal(stock.finishedGoods.value, 20, "the 20.00 of ingredients now sits in finished goods");
    assert.equal(stock.rawInventory.trustedValue, 30, "600 g left at 0.05");
  });

  await t.test("buying ingredients does not move profit, and does not reprice the frozen Bake cost", () => {
    const before = profitFacts(report());
    asOwner(`select public.post_raw_purchase('${uuid()}', '${flour}', 1000, 'g', 1000, 500, 'Brand', 'Main', '${today}', 4, '');`);
    const after = report();
    assert.deepEqual(profitFacts(after), before, "a PHP 500 purchase must not change margin or result");
    assert.equal(after.inventoryPurchases.total, 500, "it appears only as the purchases memo");
    assert.equal(after.inventoryPurchases.count, 1);
    assert.equal(run("select frozen_cost_per_piece::float8 from public.production_executions").trim(), "2", "the average cost moved; the frozen Bake cost did not");
    assert.equal(balances().rawInventory.trustedValue, 530, "(600 g x 0.05 + 500) = 530 of verified stock");
  });

  await t.test("the expenses migration changes no existing financial record", () => {
    const snapshot = () => run(`select md5(
      coalesce((select string_agg(t::text, '|' order by t::text) from public.ingredients t), '') ||
      coalesce((select string_agg(t::text, '|' order by t::text) from public.inventory_transactions t), '') ||
      coalesce((select string_agg(t::text, '|' order by t::text) from public.supply_entries t), '') ||
      coalesce((select string_agg(t::text, '|' order by t::text) from public.production_executions t), '') ||
      coalesce((select string_agg(t::text, '|' order by t::text) from public.finished_stock_movements t), '') ||
      coalesce((select string_agg(t::text, '|' order by t::text) from public.orders t), '') ||
      coalesce((select string_agg(t::text, '|' order by t::text) from public.order_lines t), ''))`).trim();
    const before = snapshot();
    run(sql("supabase/migrations/20261016120000_business_expenses.sql"));
    ledgerApplied = true;
    assert.equal(snapshot(), before, "every ingredient, ledger row, purchase, lot, movement and order is byte-identical");
  });

  await t.test("fulfilment recognizes exactly the cost the database froze; paid revenue reconciles", () => {
    const order = uuid();
    run(`insert into public.orders (id, customer_id, status) values ('${order}', '${customer}', 'new');
         insert into public.order_lines (id, order_id, product_id, item_name, unit_price, pieces_per_unit_snapshot, quantity)
           values ('${uuid()}', '${order}', '${product}', 'E2E Brownie', 50, 1, 4);`);
    asOwner(`select public.confirm_order_with_reservation('${uuid()}', '${order}');`);
    asOwner(`select public.complete_order_with_fulfillment('${uuid()}', '${order}');`);
    run(`update public.orders set payment_status = 'paid', payment_method = 'cash', paid_at = clock_timestamp(), paid_amount = 200 where id = '${order}';`);

    const r = report();
    assert.equal(r.sales.completedOrders, 1);
    assert.equal(r.sales.recognizedRevenue, 200);
    assert.equal(r.sales.collected, 200);
    assert.equal(r.cogs.ingredientCogs, 8, "4 pieces x the frozen 2.00");
    assert.equal(r.cogs.ingredientCogs, Number(run("select sum(raw_production_cogs)::float8 from public.order_raw_cogs").trim()), "the report equals the database view");
    assert.equal(r.cogs.coverage, 1);
    assert.deepEqual(r.grossMargin, { value: 192, withheld: null });
    assert.equal(r.cash.received, 200, "cash is reported, separately from revenue");
    const stock = balances();
    assert.equal(stock.finishedGoods.pieces, 6);
    assert.equal(stock.finishedGoods.value, 12);
    assert.deepEqual(stock.customerDeposits, { count: 0, amount: 0 });
  });

  await t.test("an unfulfilled prepaid order is a deposit, not revenue, and costs nothing yet", () => {
    const open = uuid();
    run(`insert into public.orders (id, customer_id, status, payment_status, payment_method, paid_at, paid_amount) values ('${open}', '${customer}', 'new', 'paid', 'gcash', clock_timestamp(), 150);
         insert into public.order_lines (id, order_id, product_id, item_name, unit_price, pieces_per_unit_snapshot, quantity) values ('${uuid()}', '${open}', '${product}', 'E2E Brownie', 50, 1, 3);`);
    asOwner(`select public.confirm_order_with_reservation('${uuid()}', '${open}');`);
    const r = report();
    assert.equal(r.sales.recognizedRevenue, 200, "still only the completed order");
    assert.equal(r.cogs.ingredientCogs, 8);
    assert.deepEqual(balances().customerDeposits, { count: 1, amount: 150 });
    assert.equal(r.cash.received, 350, "but the cash is real");
  });

  await t.test("expenses: idempotent, reconciled, voidable, and counted exactly once", () => {
    const op = uuid();
    const record = () => JSON.parse(asOwner(`select public.record_business_expense('${op}', '${today}', 'rent', 100, 'Landlord', null, 'cash', null, false);`));
    const first = record();
    const replay = record();
    assert.equal(replay.id, first.id, "a retry returns the same row");
    assert.equal(run("select count(*) from public.business_expenses").trim(), "1");
    const r = report();
    assert.equal(r.expenses.total, 100);
    assert.equal(r.expenses.count, 1);
    if (resultExpected) assert.deepEqual(r.operatingResult, { value: 92, withheld: null }, "192 gross margin - 100 rent");
    else assert.equal(r.operatingResult.withheld, "pre-start");

    asOwner(`select public.void_business_expense('${uuid()}', '${first.id}', 'Entered by mistake');`);
    const voided = report();
    assert.equal(voided.expenses.total, 0);
    assert.equal(voided.expenses.voidedCount, 1);
    assert.equal(run("select count(*) from public.business_expenses").trim(), "1", "voided, never deleted");
    if (resultExpected) assert.deepEqual(voided.operatingResult, { value: 192, withheld: null });
  });

  await t.test("a refund is contra-revenue and does not give the ingredients back", () => {
    run("update public.orders set payment_status = 'refunded', refunded_at = clock_timestamp() where status = 'completed';");
    const r = report();
    assert.equal(r.sales.recognizedRevenue, 200);
    assert.equal(r.sales.refunds, 200);
    assert.equal(r.sales.netRevenue, 0);
    assert.equal(r.cogs.ingredientCogs, 8, "the brownies were handed over; the cost stays");
    assert.deepEqual(r.grossMargin, { value: -8, withheld: null });
  });

  await t.test("an audited correction restores revenue without changing fulfilled cost or business facts", () => {
    const before = JSON.parse(run("select row_to_json(o)::jsonb::text from public.orders o where status = 'completed'"));
    const cogsBefore = run("select row_to_json(c)::jsonb::text from public.order_raw_cogs c");
    asOwner(`select public.correct_mistaken_refund('${uuid()}', '${before.id}', 'Disposable test: no refund actually occurred', '${before.refunded_at}'::timestamptz, 200);`);
    const after = JSON.parse(run(`select row_to_json(o)::jsonb::text from public.orders o where id = '${before.id}'`));
    for (const key of Object.keys(before).filter((key) => !["payment_status", "refunded_at", "updated_at"].includes(key))) {
      assert.deepEqual(after[key], before[key], key);
    }
    assert.equal(run("select row_to_json(c)::jsonb::text from public.order_raw_cogs c"), cogsBefore);
    assert.equal(run("select count(*) from public.order_refund_corrections").trim(), "1");
    const r = report();
    assert.equal(r.sales.refunds, 0);
    assert.equal(r.sales.netRevenue, 200);
    assert.equal(r.cogs.ingredientCogs, 8);
    assert.deepEqual(r.grossMargin, { value: 192, withheld: null });
  });

  await t.test("correcting a refund made before completion clears the Finance review warning", () => {
    const order = uuid();
    run(`insert into public.orders (id, customer_id, status, payment_status, payment_method, paid_at, paid_amount, refunded_at)
      values ('${order}', '${customer}', 'new', 'refunded', 'cash', clock_timestamp() - interval '2 minutes', 100, clock_timestamp() - interval '1 minute');
      insert into public.order_lines (id, order_id, product_id, item_name, unit_price, pieces_per_unit_snapshot, quantity)
      values ('${uuid()}', '${order}', '${product}', 'E2E Brownie', 50, 1, 2);`);
    asOwner(`select public.confirm_order_with_reservation('${uuid()}', '${order}');`);
    asOwner(`select public.complete_order_with_fulfillment('${uuid()}', '${order}');`);
    const before = report();
    assert.equal(before.grossMargin.withheld, "needs-review");
    assert.ok(before.warnings.some((warning) => warning.code === "refund-before-completion"));
    const refundedAt = run(`select refunded_at::text from public.orders where id = '${order}'`).trim();
    asOwner(`select public.correct_mistaken_refund('${uuid()}', '${order}', 'Disposable test: refund was entered by mistake', '${refundedAt}'::timestamptz, 100);`);
    const after = report();
    assert.equal(after.sales.refunds, 0);
    assert.equal(after.sales.netRevenue, 300);
    assert.equal(after.cogs.ingredientCogs, before.cogs.ingredientCogs);
    assert.equal(after.cogs.ingredientCogs, 12);
    assert.deepEqual(after.grossMargin, { value: 288, withheld: null });
    assert.ok(!after.warnings.some((warning) => warning.code === "refund-before-completion"));
  });

  await t.test("an order with no recorded cost withholds the margin instead of overstating it", () => {
    const uncosted = uuid();
    run(`insert into public.orders (id, customer_id, status, payment_status, payment_method, paid_at, paid_amount)
           values ('${uncosted}', '${customer}', 'new', 'paid', 'cash', clock_timestamp(), 100);
         insert into public.order_lines (id, order_id, product_id, item_name, unit_price, pieces_per_unit_snapshot, quantity)
           values ('${uuid()}', '${uncosted}', '${product}', 'Pre-tracking sale', 50, 1, 2);`);
    // A legacy order completed before stock allocation existed: completed with NO allocation, so no COGS row.
    // The status guard allows only its own functions to complete an order; this announces itself the way they do.
    run(`begin; select set_config('inventory_private.order_transition_authorized', 'true', true);
         update public.orders set status = 'completed', completed_at = clock_timestamp() where id = '${uncosted}'; commit;`);
    const r = report();
    assert.equal(r.cogs.isComplete, false);
    assert.deepEqual(r.grossMargin, { value: null, withheld: "cost-coverage" });
    assert.ok(r.warnings.some((warning) => warning.code === "cost-coverage-incomplete" && warning.severity === "high"));
  });
});
