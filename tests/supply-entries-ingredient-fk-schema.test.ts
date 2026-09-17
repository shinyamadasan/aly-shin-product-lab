import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const sql = readFileSync(new URL("../supabase/migrations/20260917090200_supply_entries_ingredient_fk.sql", import.meta.url), "utf8");
const sqlStatementsOnly = sql
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n");

test("adds supply_entries_ingredient_id_fkey as RESTRICT, matching inventory_transactions' existing FK", () => {
  assert.match(
    sqlStatementsOnly,
    /alter table supply_entries\s+add constraint supply_entries_ingredient_id_fkey\s+foreign key \(ingredient_id\) references ingredients\(id\) on delete restrict/i,
  );
});

test("the new constraint is added NOT VALID -- must never validate against existing rows in this migration", () => {
  assert.match(
    sqlStatementsOnly,
    /foreign key \(ingredient_id\) references ingredients\(id\) on delete restrict\s+not valid;/i,
  );
  // A bare "validate constraint" statement here would defeat the entire point of this file --
  // that step belongs only in a manual, audited follow-up after supabase-check-supply-entries-
  // ingredient-fk.sql comes back clean.
  assert.doesNotMatch(sqlStatementsOnly, /validate constraint/i);
});

test("is idempotent: looks up and drops any pre-existing same-shaped constraint before adding it back", () => {
  assert.match(sqlStatementsOnly, /tc\.table_name = 'supply_entries'/i);
  assert.match(sqlStatementsOnly, /kcu\.column_name = 'ingredient_id'/i);
  assert.match(sqlStatementsOnly, /ccu\.table_name = 'ingredients'/i);
  assert.match(sqlStatementsOnly, /execute format\('alter table supply_entries drop constraint %I', constraint_name\);/i);
});

test("the companion check script is read-only", () => {
  const checkSql = readFileSync(new URL("../supabase-check-supply-entries-ingredient-fk.sql", import.meta.url), "utf8");
  const checkSqlStatementsOnly = checkSql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
  assert.doesNotMatch(checkSqlStatementsOnly, /\b(insert|update|delete|alter|drop|create)\b/i);
  assert.match(checkSqlStatementsOnly, /left join ingredients i on i\.id = se\.ingredient_id/i);
});
