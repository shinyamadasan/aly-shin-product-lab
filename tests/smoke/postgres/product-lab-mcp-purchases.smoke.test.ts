import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { deterministicUuid, operationIdForOccasion } from "../../../scripts/purchase-operator/core.ts";

// Real-Postgres boundary test for Daily Bakery Ops V2 Slice 1 (Purchases): applies the exact same
// migration chain the V1A smoke test uses, plus the new
// 20260916100000_product_lab_mcp_purchase_previews.sql migration, then exercises
// purchase-service.ts's apply bridge logic directly against the real, unmodified
// inventory_private.confirm_purchase_import_v2 -- never a mock. Confirms: the new table's RLS/owner
// isolation, that purchase_imports/purchase_import_rows accept a plain owner-authenticated insert
// under their EXISTING RLS (no new RPC required), atomic all-or-nothing batch confirmation, and
// claim_mutation replay safety, all against a disposable container -- never any real project.
const root = path.resolve(import.meta.dirname, "../../..");
const sql = (file: string) => readFileSync(path.join(root, file), "utf8");
const OWNER_ID = "99999999-9999-4999-8999-999999999999";
const OWNER_SESSION = `set role authenticated;
  select set_config('request.jwt.claim.sub','${OWNER_ID}',false);
  select set_config('request.jwt.claim.app_role','owner',false);
  select set_config('request.jwt.claims','{"sub":"${OWNER_ID}","role":"authenticated","app_metadata":{"app_role":"owner"}}',false);`;
const STAFF_SESSION = `set role authenticated;
  select set_config('request.jwt.claim.sub','88888888-8888-4888-8888-888888888888',false);
  select set_config('request.jwt.claim.app_role','staff',false);`;

test("Product Lab MCP purchases (Daily Bakery Ops V2, Slice 1) database boundary", { skip: process.env.RUN_POSTGRES_SMOKE !== "1" }, async (t) => {
  const container = `aly-purchase-operator-${Date.now()}`;
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
    create table auth.users (id uuid primary key);
    insert into auth.users (id) values ('${OWNER_ID}');
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
  run(sql("supabase/migrations/20260916100000_product_lab_mcp_purchase_previews.sql"));

  const makeIngredient = (name: string, quantity = 100, reconciled = true, id = crypto.randomUUID()) => {
    run(`insert into public.ingredients (id,name,base_unit,current_quantity,average_unit_cost,inventory_reconciled_at)
      values ('${id}','${name}','g',${quantity},1,${reconciled ? "now()" : "null"})`);
    return id;
  };

  // Mirrors PurchaseService.apply()'s exact bridge shape: deterministic ids derived from a fake
  // preview_id, a check-before-insert into purchase_imports/purchase_import_rows under owner RLS
  // (no RPC), then the real, unmodified confirm_purchase_import_v2. Check-before-insert (not
  // upsert-and-ignore) because protect_posted_import's read-only guard rejects ANY write attempt
  // against an already-confirmed import's rows, even one Postgres will end up discarding via
  // ON CONFLICT DO NOTHING -- its BEFORE INSERT trigger still fires first.
  const applyPurchase = (previewId: string, lines: Array<{ ingredientId: string; convertedQuantity: number; totalPrice: number; unit?: string }>) => {
    const importId = deterministicUuid("purchase_import", previewId);
    const operationId = operationIdForOccasion(previewId);
    const alreadyExists = q1(`${OWNER_SESSION} select count(*) from purchase_imports where id='${importId}'`) === "1";
    if (!alreadyExists) {
      run(`${OWNER_SESSION}
        insert into public.purchase_imports (id, file_name, status, row_count, total_value)
        values ('${importId}', 'mcp-purchase:${previewId}', 'draft', ${lines.length}, ${lines.reduce((sum, line) => sum + line.totalPrice, 0)});`);
      for (const [index, line] of lines.entries()) {
        const rowId = deterministicUuid("purchase_import_row", `${previewId}:${index + 1}`);
        run(`${OWNER_SESSION}
          insert into public.purchase_import_rows (id, import_id, row_index, raw_item_name, raw_quantity, raw_unit, raw_total_price, parsed_quantity, parsed_total_price, ingredient_id, match_method, converted_quantity, row_status)
          values ('${rowId}', '${importId}', ${index}, 'line ${index}', '${line.convertedQuantity}', '${line.unit ?? "g"}', '${line.totalPrice}', ${line.convertedQuantity}, ${line.totalPrice}, '${line.ingredientId}', 'exact', ${line.convertedQuantity}, 'matched');`);
      }
    }
    return { importId, operationId, resultText: q1(`${OWNER_SESSION} select public.confirm_purchase_import_v2('${operationId}', '${importId}');`) };
  };

  await t.test("purchase_imports/purchase_import_rows accept a plain owner-authenticated insert -- no new RPC is required to bridge the preview", () => {
    const eggId = makeIngredient("Smoke Eggs", 20);
    const previewId = `pu_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
    const { resultText } = applyPurchase(previewId, [{ ingredientId: eggId, convertedQuantity: 30, totalPrice: 300 }]);
    const result = JSON.parse(resultText);
    assert.equal(result.transaction_ids.length, 1);
    assert.equal(q1(`select current_quantity from ingredients where id='${eggId}'`), "50");
    assert.equal(q1(`select status from purchase_imports where id='${result.import_id}'`), "confirmed");
  });

  await t.test("multiple lines against the same ingredient are summed into one ledger transaction", () => {
    const flourId = makeIngredient("Smoke Flour", 500);
    const previewId = `pu_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
    const { resultText } = applyPurchase(previewId, [
      { ingredientId: flourId, convertedQuantity: 1000, totalPrice: 95 },
      { ingredientId: flourId, convertedQuantity: 1000, totalPrice: 95 },
    ]);
    const result = JSON.parse(resultText);
    assert.equal(result.transaction_ids.length, 1, "one ingredient touched -> one ledger transaction, even with two purchase lines");
    assert.equal(q1(`select current_quantity from ingredients where id='${flourId}'`), "2500");
    assert.equal(q1(`select quantity_change from inventory_transactions where id='${result.transaction_ids[0]}'`), "2000");
  });

  await t.test("multi-ingredient purchase is atomic: an unreconciled ingredient blocks the WHOLE batch, not just its own row", () => {
    const okId = makeIngredient("Smoke Atomic OK", 20, true);
    const badId = makeIngredient("Smoke Atomic Unverified", 500, false);
    const previewId = `pu_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
    assert.throws(() => applyPurchase(previewId, [
      { ingredientId: okId, convertedQuantity: 6, totalPrice: 60 },
      { ingredientId: badId, convertedQuantity: 1000, totalPrice: 95 },
    ]), /Verify the physical stock/);
    assert.equal(q1(`select current_quantity from ingredients where id='${okId}'`), "20", "the valid line must not have been applied either");
    assert.equal(q1(`select count(*) from inventory_transactions where ingredient_id in ('${okId}','${badId}')`), "0");
  });

  await t.test("a retried apply (same preview_id) is idempotent -- same result, no duplicate ledger row", () => {
    const eggId = makeIngredient("Smoke Replay Eggs", 20);
    const previewId = `pu_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
    const first = applyPurchase(previewId, [{ ingredientId: eggId, convertedQuantity: 12, totalPrice: 120 }]);
    const replay = applyPurchase(previewId, [{ ingredientId: eggId, convertedQuantity: 12, totalPrice: 120 }]);
    assert.deepEqual(JSON.parse(replay.resultText), JSON.parse(first.resultText));
    assert.equal(q1(`select current_quantity from ingredients where id='${eggId}'`), "32", "replay must not double-apply");
    assert.equal(q1(`select count(*) from inventory_transactions where ingredient_id='${eggId}'`), "1");
  });

  await t.test("purchase_imports/purchase_import_rows reject a non-owner and require owner RLS, exactly like every other owner_only table", () => {
    const previewId = `pu_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
    const importId = deterministicUuid("purchase_import", previewId);
    const insertImport = `${STAFF_SESSION}
      insert into public.purchase_imports (id, file_name, status, row_count, total_value)
      values ('${importId}', 'mcp-purchase:${previewId}', 'draft', 1, 100);`;
    assert.throws(() => run(insertImport), /row-level security|policy/i);
    assert.equal(q1(`select count(*) from purchase_imports where id='${importId}'`), "0");
  });

  await t.test("product_lab_mcp_purchase_previews enforces the pu_ preview id shape and owner-row isolation", () => {
    const otherOwnerId = "77777777-7777-4777-8777-777777777777";
    run(`insert into auth.users (id) values ('${otherOwnerId}') on conflict do nothing;`);
    const previewId = `pu_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
    const payloadHash = crypto.createHash("sha256").update("smoke").digest("hex");
    const operationId = crypto.randomUUID();
    assert.throws(() => run(`${OWNER_SESSION}
      insert into public.product_lab_mcp_purchase_previews (preview_id, payload_hash, operation_id, preview)
      values ('pc_notapurchase00000001', '${payloadHash}', '${operationId}', '{}'::jsonb);`), /check|constraint/i);

    run(`${OWNER_SESSION}
      insert into public.product_lab_mcp_purchase_previews (preview_id, payload_hash, operation_id, preview)
      values ('${previewId}', '${payloadHash}', '${operationId}', '{"kind":"purchase_preview"}'::jsonb);`);
    assert.equal(q1(`${OWNER_SESSION} select count(*) from product_lab_mcp_purchase_previews where preview_id='${previewId}'`), "1");

    // A second owner account previewing an identical payload (same content-derived preview_id) must
    // not spuriously collide -- the composite (owner_id, preview_id) primary key, not preview_id
    // alone, is what makes this insert succeed instead of raising a duplicate-key error.
    run(`set role authenticated;
      select set_config('request.jwt.claim.sub','${otherOwnerId}',false);
      select set_config('request.jwt.claim.app_role','owner',false);
      insert into public.product_lab_mcp_purchase_previews (preview_id, payload_hash, operation_id, preview)
      values ('${previewId}', '${payloadHash}', '${operationId}', '{"kind":"purchase_preview"}'::jsonb);`);

    assert.equal(q1(`set role authenticated;
      select set_config('request.jwt.claim.sub','${otherOwnerId}',false);
      select set_config('request.jwt.claim.app_role','owner',false);
      select count(*) from product_lab_mcp_purchase_previews where preview_id='${previewId}'`), "1", "each owner can only see their own row for the same preview_id");
  });
});
