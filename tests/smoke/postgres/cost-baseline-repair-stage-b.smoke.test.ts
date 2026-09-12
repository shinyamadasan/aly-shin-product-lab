import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../../..");
const sql = (file: string) => readFileSync(path.join(root, file), "utf8");

// The literal ids the real Stage B script (supabase-repair-blondies-v3-execution-cost.sql) is
// hardcoded around -- kept in sync with that file deliberately, not re-derived, so a change to one
// without the other is caught by these tests failing rather than silently drifting.
const EXEC_ID = "91d84608-8f4c-405e-a87b-ec2e4a74ea32";
const PRODUCT_ID = "be801165-6d37-469d-8cd7-ba4d9f545ff6";
const BATCH_ID = "a3e62fbc-2b74-4b8f-b9ca-0c8c55b7d4ae";
const ORIGINAL_TOTAL = "1240.2434952507851";
const ORIGINAL_PER_PIECE = "77.51521845317407";
const ING1 = "11111111-0000-4000-8000-000000000001";
const ING2 = "22222222-0000-4000-8000-000000000002";
const CUSTOMER_ID = "33333333-0000-4000-8000-000000000003";
const ORDER_ID = "44444444-0000-4000-8000-000000000004";

// Read once, strip the outer `begin;` / `commit;` this file wraps itself in for real, manual
// execution -- each scenario below supplies its OWN begin;/rollback; so the same hardcoded literal
// ids can be reused across scenarios without colliding, and nothing this test does ever commits.
const stageBFull = sql("supabase-repair-blondies-v3-execution-cost.sql");
// The file opens with a long comment block before its own `begin;` line, so the strip must match
// a standalone begin;/commit; statement line anywhere, not anchor to the literal start/end of the
// file text.
const stageBBody = stageBFull
  .replace(/(^|\n)begin;[ \t]*\n/, "$1")
  .replace(/\ncommit;[ \t]*\n?$/, "\n");
if (stageBBody === stageBFull) {
  throw new Error("Could not isolate the Stage B script's do-block from its begin;/commit; wrapper -- the file's shape changed; update this test's extraction.");
}
if (/^\s*begin;/m.test(stageBBody) || /\bcommit;\s*$/m.test(stageBBody.trim())) {
  throw new Error("Stage B extraction left a stray begin;/commit; in the isolated body -- each scenario supplies its own transaction control.");
}

test("Cost Baseline Repair Stage B: guarded one-time execution-cost repair script", { skip: process.env.RUN_POSTGRES_SMOKE !== "1" }, async (t) => {
  const container = `aly-cbr-stageb-${Date.now()}`;
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
  run(sql("supabase/migrations/20260909132327_selling_wave_0a_raw_authority.sql"));
  run(sql("supabase/migrations/20260909162224_selling_wave_0a_reversal_boundary.sql"));
  run(sql("supabase/migrations/20260910022601_selling_wave_0b_safe_mutations.sql"));
  run(sql("supabase/migrations/20260910120146_selling_wave_1_production_execution.sql"));
  run(`create table public.selling_formats (id uuid primary key default gen_random_uuid());
    alter table public.selling_formats enable row level security;`);
  run(sql("supabase-add-orders.sql"));
  run(sql("supabase/migrations/20260910181827_selling_wave_2_order_reservation.sql"));
  run(sql("supabase/migrations/20260911103433_selling_wave_3_finished_stock_exceptions_and_cogs.sql"));
  run(sql("supabase/migrations/20260912090000_cost_baseline_repair.sql"));

  // Common base fixture every scenario starts from, built fresh inside that scenario's own
  // begin;...; the trailing statement (either the script's own implicit rollback-on-error, or an
  // explicit rollback; this file appends after a successful run) always discards it, so the same
  // hardcoded literal ids are reusable across every scenario below.
  const baseFixture = `
    insert into public.products (id, name) values ('${PRODUCT_ID}', 'Blondies');
    insert into public.product_batches (id, product_id, batch_version, status, usable_pieces)
      values ('${BATCH_ID}', '${PRODUCT_ID}', 'V3', 'completed', 16);
    insert into public.ingredients (id, name, base_unit, current_quantity, average_unit_cost, inventory_reconciled_at, cost_reconciled_at)
      values ('${ING1}', 'Stage B Ing 1', 'g', 900, 5, now(), now()),
             ('${ING2}', 'Stage B Ing 2', 'g', 950, 3, now(), now());
    insert into public.inventory_transactions (ingredient_id, transaction_type, quantity_change, quantity_before, quantity_after, source_type, source_id, created_at)
      values ('${ING1}', 'consume', -100, 1000, 900, 'bake', '${BATCH_ID}', now()),
             ('${ING2}', 'consume', -50, 1000, 950, 'bake', '${BATCH_ID}', now());
    insert into public.production_executions (id, product_id, product_batch_id, batch_version_snapshot, operation_id, multiplier, quantity_produced_pieces, expected_pieces, frozen_ingredient_cost_total, frozen_cost_per_piece, completed_at)
      values ('${EXEC_ID}', '${PRODUCT_ID}', '${BATCH_ID}', 'V3', gen_random_uuid(), 1, 16, 16, ${ORIGINAL_TOTAL}, ${ORIGINAL_PER_PIECE}, now());
    insert into public.finished_stock_movements (product_id, production_execution_id, movement_type, on_hand_delta, reserved_delta, operation_id)
      values ('${PRODUCT_ID}', '${EXEC_ID}', 'production_receipt', 16, 0, gen_random_uuid());
  `;
  // 100g @ certified 5/g + 50g @ certified 3/g = 500 + 150 = 650 total, 650/16 = 40.625/piece --
  // a corrected value deliberately distinct from the original 1240.24/77.52 so a passing assertion
  // proves recomputation happened, not a coincidental match.
  const EXPECTED_CORRECTED_TOTAL = "650";
  const EXPECTED_CORRECTED_PER_PIECE = "40.625";

  function errorText(err: unknown): string {
    return String((err as { stderr?: string })?.stderr ?? (err as Error)?.message ?? err);
  }

  await t.test("scenario: execution untouched -> repair succeeds, only the three intended columns change, no stock ledger row changes (covers spec scenarios 1 and 7)", () => {
    // One combined row, pipe-delimited, so nothing depends on how psql separates multiple
    // statements' output -- avoids any ambiguity while still inspecting UNCOMMITTED state before
    // the trailing rollback discards it.
    const verify = `
      select
        pe.frozen_ingredient_cost_total::text || '|' ||
        pe.frozen_cost_per_piece::text || '|' ||
        coalesce(pe.note, '') || '|' ||
        pe.quantity_produced_pieces::text || '|' ||
        pe.product_id || '|' ||
        pe.product_batch_id::text || '|' ||
        (select current_quantity from public.ingredients where id = '${ING1}')::text || '|' ||
        (select current_quantity from public.ingredients where id = '${ING2}')::text || '|' ||
        (select count(*) from public.finished_stock_movements where production_execution_id = '${EXEC_ID}')::text || '|' ||
        (select count(*) from public.inventory_transactions where source_type = 'bake' and source_id = '${BATCH_ID}')::text
      from public.production_executions pe where pe.id = '${EXEC_ID}';
    `;
    // execFileSync's return value is stdout only -- the script's own `raise notice` on success
    // goes to stderr and is not asserted on here; success is proven by reaching this verify query
    // (no thrown exception) and by its recomputed values below.
    const out = run(`begin; ${baseFixture} ${stageBBody} ${verify} rollback;`);
    const resultLine = out.trim().split("\n").find((l) => l.includes("|"));
    assert.ok(resultLine, `expected a pipe-delimited result row in output: ${out}`);
    const [total, perPiece, note, pieces, productId, batchId, ing1Qty, ing2Qty, movementCount, consumeCount] = resultLine!.split("|");
    assert.equal(Number(total), Number(EXPECTED_CORRECTED_TOTAL), "frozen_ingredient_cost_total must be recomputed, not hand-typed");
    assert.equal(Number(perPiece), Number(EXPECTED_CORRECTED_PER_PIECE), "frozen_cost_per_piece must be corrected_total / 16");
    assert.match(note, new RegExp(ORIGINAL_TOTAL.replace(".", "\\.")), "note must preserve the original total for rollback");
    assert.match(note, new RegExp(ORIGINAL_PER_PIECE.replace(".", "\\.")), "note must preserve the original per-piece cost for rollback");
    assert.equal(pieces, "16", "quantity_produced_pieces must be untouched");
    assert.equal(productId, PRODUCT_ID, "product_id must be untouched");
    assert.equal(batchId, BATCH_ID, "product_batch_id must be untouched");
    assert.equal(ing1Qty, "900", "ingredient 1 current_quantity must be untouched");
    assert.equal(ing2Qty, "950", "ingredient 2 current_quantity must be untouched");
    assert.equal(movementCount, "1", "finished_stock_movements row count must be untouched (still exactly the one production_receipt)");
    assert.equal(consumeCount, "2", "inventory_transactions consume rows must be untouched");
  });

  await t.test("scenario: an active reservation exists -> abort, zero changes", () => {
    // Deliberately an order_stock_allocations row with NO matching finished_stock_movements row --
    // not how Wave 2's real confirm_order_with_reservation ever leaves things (it always writes
    // both together), but isolating them here proves guard G (order_stock_allocations) fires on
    // its own, independent of guard F (finished_stock_movements) -- scenario 4 below covers the
    // realistic case where both exist together.
    const scenario = `
      insert into public.customers (id, name) values ('${CUSTOMER_ID}', 'Stage B Test Customer');
      select set_config('inventory_private.order_transition_authorized', 'true', true); -- fixture-only: bypass Wave 2's insert-status trigger, same as any real reserve/fulfill RPC would
      insert into public.orders (id, customer_id, status) values ('${ORDER_ID}', '${CUSTOMER_ID}', 'confirmed');
      insert into public.order_stock_allocations (order_id, product_id, production_execution_id, operation_id, reserved_pieces, status)
        values ('${ORDER_ID}', '${PRODUCT_ID}', '${EXEC_ID}', gen_random_uuid(), 4, 'active');
    `;
    let threw = false;
    try {
      run(`begin; ${baseFixture} ${scenario} ${stageBBody}`);
    } catch (err) {
      threw = true;
      assert.match(errorText(err), /order_stock_allocations rows/, "must abort specifically on the allocation guard");
    }
    assert.ok(threw, "an active reservation must abort the repair, not silently proceed");
    // Fresh session, separate from the aborted (never-committed) one above -- confirms nothing
    // from that attempt persisted.
    assert.equal(run(`select count(*) from public.production_executions where id = '${EXEC_ID}'`).trim(), "0");
  });

  await t.test("scenario: a damage exception exists against this lot -> abort, zero changes", () => {
    const scenario = `
      insert into public.finished_stock_movements (product_id, production_execution_id, movement_type, on_hand_delta, reserved_delta, operation_id)
        values ('${PRODUCT_ID}', '${EXEC_ID}', 'damage', -1, 0, gen_random_uuid());
    `;
    let threw = false;
    try {
      run(`begin; ${baseFixture} ${scenario} ${stageBBody}`);
    } catch (err) {
      threw = true;
      assert.match(errorText(err), /non-production_receipt finished_stock_movements/, "must abort specifically on the movement guard");
    }
    assert.ok(threw, "an existing damage exception must abort the repair, not silently proceed");
    assert.equal(run(`select count(*) from public.production_executions where id = '${EXEC_ID}'`).trim(), "0");
  });

  await t.test("scenario: an order has already been fulfilled from this lot -> abort, zero changes", () => {
    const scenario = `
      insert into public.customers (id, name) values ('${CUSTOMER_ID}', 'Stage B Test Customer');
      select set_config('inventory_private.order_transition_authorized', 'true', true); -- fixture-only: bypass Wave 2's insert-status trigger, same as any real reserve/fulfill RPC would
      insert into public.orders (id, customer_id, status) values ('${ORDER_ID}', '${CUSTOMER_ID}', 'completed');
      insert into public.order_stock_allocations (order_id, product_id, production_execution_id, operation_id, reserved_pieces, status)
        values ('${ORDER_ID}', '${PRODUCT_ID}', '${EXEC_ID}', gen_random_uuid(), 4, 'fulfilled');
      insert into public.finished_stock_movements (product_id, production_execution_id, movement_type, on_hand_delta, reserved_delta, operation_id, order_id, order_stock_allocation_id)
        values ('${PRODUCT_ID}', '${EXEC_ID}', 'fulfill', -4, -4, gen_random_uuid(), '${ORDER_ID}',
          (select id from public.order_stock_allocations where order_id = '${ORDER_ID}' and production_execution_id = '${EXEC_ID}'));
    `;
    let threw = false;
    try {
      run(`begin; ${baseFixture} ${scenario} ${stageBBody}`);
    } catch (err) {
      threw = true;
      const text = errorText(err);
      assert.match(text, /non-production_receipt finished_stock_movements|order_stock_allocations rows/, "must abort on either the movement or allocation guard");
    }
    assert.ok(threw, "an already-fulfilled order must abort the repair, not silently proceed");
    assert.equal(run(`select count(*) from public.production_executions where id = '${EXEC_ID}'`).trim(), "0");
    // order_raw_cogs (Wave 3's view) must not have changed as a side effect of the aborted attempt.
    assert.equal(run(`select count(*) from public.order_raw_cogs where order_id = '${ORDER_ID}'`).trim(), "0");
  });

  await t.test("scenario: the original frozen values have already changed -> abort, zero changes", () => {
    const scenario = `update public.production_executions set frozen_ingredient_cost_total = 999 where id = '${EXEC_ID}';`;
    let threw = false;
    try {
      run(`begin; ${baseFixture} ${scenario} ${stageBBody}`);
    } catch (err) {
      threw = true;
      assert.match(errorText(err), /frozen values no longer match/, "must abort specifically on the original-values guard");
    }
    assert.ok(threw, "a changed frozen value must abort the repair, not overwrite blind");
    assert.equal(run(`select count(*) from public.production_executions where id = '${EXEC_ID}'`).trim(), "0");
  });

  await t.test("scenario: one of the ten ingredients is not cost-certified -> abort, zero changes", () => {
    const scenario = `update public.ingredients set cost_reconciled_at = null where id = '${ING2}';`;
    let threw = false;
    try {
      run(`begin; ${baseFixture} ${scenario} ${stageBBody}`);
    } catch (err) {
      threw = true;
      assert.match(errorText(err), /cost baseline not yet certified/, "must abort specifically on the certification guard");
    }
    assert.ok(threw, "an uncertified ingredient must abort the repair, not proceed with a partial cost");
    assert.equal(run(`select count(*) from public.production_executions where id = '${EXEC_ID}'`).trim(), "0");
  });
});
