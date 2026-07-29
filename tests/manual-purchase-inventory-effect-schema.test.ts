import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const sql = readFileSync(new URL("../supabase-add-manual-purchase-inventory-effect.sql", import.meta.url), "utf8");
const sqlStatementsOnly = sql
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n");

function functionBody(name: string) {
  const match = sqlStatementsOnly.match(new RegExp(`create or replace function ${name}\\([\\s\\S]*?\\n\\$\\$;`, "i"));
  assert.ok(match, `missing function ${name}`);
  return match[0];
}

const saveBody = functionBody("save_supply_with_inventory_effect");
const deleteBody = functionBody("delete_supply_with_inventory_effect");
const repairBody = functionBody("repair_supply_inventory_effects");

test("manual purchase ledger identity is guarded by a duplicate preflight and partial unique index", () => {
  assert.match(sqlStatementsOnly, /from inventory_transactions\s+where source_type = 'manual'\s+and transaction_type = 'purchase'\s+and source_id is not null\s+group by source_type, source_id, transaction_type\s+having count\(\*\) > 1/i);
  assert.match(sqlStatementsOnly, /create unique index if not exists inventory_transactions_manual_purchase_source_identity_idx\s+on inventory_transactions \(source_type, source_id, transaction_type\)\s+where source_type = 'manual'\s+and transaction_type = 'purchase'\s+and source_id is not null;/i);
});

test("save_supply_with_inventory_effect validates explicit create versus update intent", () => {
  assert.match(saveBody, /if p_is_new_supply then[\s\S]*if exists \([\s\S]*from supply_entries[\s\S]*where id = p_supply_id[\s\S]*raise exception 'Supply entry % already exists'/i);
  assert.match(saveBody, /update supply_entries[\s\S]*where id = p_supply_id;[\s\S]*if not found then[\s\S]*raise exception 'Supply entry % was not found'/i);
});

test("save_supply_with_inventory_effect validates required payload values and ingredient consistency", () => {
  for (const message of [
    "Supply ingredient_id is required",
    "Supply create/update intent is required",
    "Supply ingredient_name is required",
    "Supply supplier_name is required",
    "Supply purchase_date is required",
    "Supply quality_rating is required",
    "Pack quantity must be greater than zero",
    "Total cost cannot be negative",
    "Ingredient mismatch between supply and inventory update",
    "Ingredient mismatch between supply and transaction",
    "Transaction transaction_type is required",
    "Transaction source_type is required",
    "Transaction source_id is required",
    "Manual supply transaction source_type must be manual",
    "Manual supply transaction source_id must match the supply id",
  ]) {
    assert.match(saveBody, new RegExp(message.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  }
});

test("save_supply_with_inventory_effect checks required ingredient and transaction write counts", () => {
  assert.match(saveBody, /update ingredients[\s\S]*where id = v_ingredient_update_id;[\s\S]*if not found then[\s\S]*raise exception 'Ingredient % was not found'/i);
  assert.match(saveBody, /on conflict \(id\) do update set[\s\S]*where inventory_transactions\.ingredient_id = excluded\.ingredient_id[\s\S]*inventory_transactions\.transaction_type = excluded\.transaction_type[\s\S]*inventory_transactions\.source_type = excluded\.source_type[\s\S]*inventory_transactions\.source_id = excluded\.source_id;/i);
  assert.match(saveBody, /get diagnostics v_transaction_row_count = row_count;[\s\S]*if v_transaction_row_count <> 1 then[\s\S]*raise exception 'Inventory transaction % was not inserted or updated for supply %'/i);
});

test("delete_supply_with_inventory_effect only deletes the intended manual purchase transaction", () => {
  assert.match(deleteBody, /update ingredients[\s\S]*where id = v_ingredient_update_id;[\s\S]*if not found then[\s\S]*raise exception 'Ingredient % was not found'/i);
  assert.match(deleteBody, /delete from inventory_transactions\s+where id = p_transaction_id_to_remove\s+and source_type = 'manual'\s+and source_id = p_supply_id::text;/i);
  assert.match(deleteBody, /if not found then[\s\S]*raise exception 'Inventory transaction % was not found for supply %'/i);
  assert.match(deleteBody, /delete from supply_entries where id = p_supply_id;[\s\S]*if not found then[\s\S]*raise exception 'Supply entry % was not found'/i);
});

test("repair_supply_inventory_effects uses stable transaction ids and guarded idempotent upserts", () => {
  assert.match(repairBody, /insert into inventory_transactions \(\s*id, ingredient_id, transaction_type, quantity_change, quantity_before, quantity_after,/i);
  assert.match(repairBody, /\(v_transaction->>'id'\)::uuid/);
  assert.match(repairBody, /on conflict \(source_type, source_id, transaction_type\)\s+where source_type = 'manual'\s+and transaction_type = 'purchase'\s+and source_id is not null\s+do update set/i);
  assert.match(repairBody, /where inventory_transactions\.ingredient_id = excluded\.ingredient_id;/i);
  assert.match(repairBody, /get diagnostics v_transaction_row_count = row_count;[\s\S]*if v_transaction_row_count <> 1 then[\s\S]*raise exception 'Inventory transaction % was not inserted or updated for repair source %'/i);
});

test("repair_supply_inventory_effects checks required ingredient update write counts", () => {
  assert.match(repairBody, /update ingredients[\s\S]*where id = v_update_id;[\s\S]*if not found then[\s\S]*raise exception 'Ingredient % was not found'/i);
});
