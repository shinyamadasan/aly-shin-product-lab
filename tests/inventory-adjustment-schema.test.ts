import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const sql = readFileSync(new URL("../supabase-add-inventory-adjustment.sql", import.meta.url), "utf8");
const sqlStatementsOnly = sql
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n");

function functionBody(name: string) {
  const match = sqlStatementsOnly.match(new RegExp(`create or replace function ${name}\\([\\s\\S]*?\\n\\$\\$;`, "i"));
  assert.ok(match, `missing function ${name}`);
  return match[0];
}

const body = functionBody("apply_inventory_adjustment");

test("14. apply_inventory_adjustment is security invoker and one plpgsql body (one implicit transaction)", () => {
  assert.match(sqlStatementsOnly, /language plpgsql\s*\nsecurity invoker/i);
  // Exactly one function body, not two separate statements split across a client-side round trip.
  assert.equal((sqlStatementsOnly.match(/\$\$;/g) ?? []).length, 1);
});

test("required-field validation and ingredient/transaction id cross-check are present", () => {
  assert.match(body, /raise exception 'Ingredient update id is required'/);
  assert.match(body, /raise exception 'Ingredient update current_quantity is required'/);
  assert.match(body, /raise exception 'Transaction id is required'/);
  assert.match(body, /raise exception 'Ingredient mismatch between ingredient update and transaction'/);
  assert.match(body, /transaction_type' <> 'adjustment'/);
  assert.match(body, /source_type' <> 'manual'/);
});

test("a plain insert, never an upsert -- an adjustment is never amended in place", () => {
  assert.doesNotMatch(body, /on conflict/i);
});

test("reason/actor columns are additive, nullable, and not CHECK-constrained (matching this schema's free-text classification convention)", () => {
  assert.match(sqlStatementsOnly, /add column if not exists reason text/);
  assert.match(sqlStatementsOnly, /add column if not exists actor text/);
  assert.doesNotMatch(sqlStatementsOnly, /check\s*\(\s*reason/i);
});
