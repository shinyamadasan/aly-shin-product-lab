import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const sql = readFileSync(new URL("../supabase-migrate-canonical-base-units.sql", import.meta.url), "utf8");
const sqlStatementsOnly = sql
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n");

test("idempotency is anchored to ids touched in this run, not any historically-migrated ingredient", () => {
  // Each rescale captures exactly the ids its own `where base_unit = 'kg'/'L'` update just
  // touched (via `returning ... into` an array), rather than re-deriving them from base_unit
  // afterward -- on a second run that predicate matches zero rows, so the array is empty and the
  // ledger rescale below is scoped to nothing.
  assert.match(sqlStatementsOnly, /returning i\.id\s*\)\s*select coalesce\(array_agg\(id\), array\[\]::uuid\[\]\) into v_kg_ids from updated;/i);
  assert.match(sqlStatementsOnly, /returning i\.id\s*\)\s*select coalesce\(array_agg\(id\), array\[\]::uuid\[\]\) into v_l_ids from updated;/i);
  assert.match(sqlStatementsOnly, /where ingredient_id = any\(v_kg_ids\) or ingredient_id = any\(v_l_ids\)/i);
});

test("ambiguous rows are flagged, not guessed or silently converted", () => {
  assert.match(sqlStatementsOnly, /set base_unit_migration_flagged_reason = 'unrecognized_base_unit:' \|\| base_unit\s*where base_unit not in \('g', 'kg', 'ml', 'L', 'pcs'\)\s*and base_unit_migration_flagged_reason is null;/i);
  assert.match(sqlStatementsOnly, /set base_unit_migration_flagged_reason = 'non_finite_numeric_field'\s*where base_unit in \('kg', 'L'\)\s*and \(current_quantity is null or current_quantity = 'NaN'::numeric or average_unit_cost = 'NaN'::numeric\)/i);
  // Every rescale statement excludes rows this migration has flagged.
  assert.match(sqlStatementsOnly, /where base_unit = 'kg'\s*and base_unit_migration_flagged_reason is null/i);
  assert.match(sqlStatementsOnly, /where base_unit = 'L'\s*and base_unit_migration_flagged_reason is null/i);
});

test("the CHECK constraint is added NOT VALID so it can never abort the migration on pre-existing flagged rows", () => {
  assert.match(sqlStatementsOnly, /check \(base_unit in \('g', 'ml', 'pcs'\)\)\s*not valid;/i);
});

test("average_unit_cost is rescaled by a bare division, never coalesced to zero", () => {
  // A null average_unit_cost means "never priced yet" -- coalescing it to 0 would fabricate a
  // cost basis that was never there. The division must operate on the raw column value.
  assert.doesNotMatch(sqlStatementsOnly, /coalesce\(average_unit_cost,\s*0\)/i);
  assert.match(sqlStatementsOnly, /average_unit_cost = t\.average_unit_cost \/ 1000/g);
});

test("supply_entries and purchase_import_rows are never touched by this migration", () => {
  assert.doesNotMatch(sqlStatementsOnly, /update supply_entries/i);
  assert.doesNotMatch(sqlStatementsOnly, /update purchase_import_rows/i);
});

test("the whole rescale runs inside one transaction (a single do block), not sequential statements", () => {
  const doBlocks = sqlStatementsOnly.match(/do \$\$/g) ?? [];
  assert.ok(doBlocks.length >= 2, "expected at least one do block for the rescale and one for the constraint guard");
});
