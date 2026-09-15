import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const migration = readFileSync(
  path.join(
    import.meta.dirname,
    "..",
    "supabase/migrations/20260915203210_add_inventory_base_unit_migration_markers.sql",
  ),
  "utf8",
);
const readService = readFileSync(
  path.join(import.meta.dirname, "..", "scripts/product-lab/read-service.ts"),
  "utf8",
);
// Comment-stripped view for statement-shape assertions -- the header comment legitimately mentions
// base_unit/protect_base_unit/raw_inventory_base_unit_guard/rollback ALTER TABLE for context; only
// the executable SQL matters for "what does this migration actually do" checks.
const sqlStatementsOnly = migration
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n");

test("adds exactly the three nullable marker columns, idempotently, and nothing else", () => {
  assert.match(
    sqlStatementsOnly,
    /alter table public\.ingredients\s+add column if not exists base_unit_migrated_from text,\s+add column if not exists base_unit_migrated_at timestamptz,\s+add column if not exists base_unit_migration_flagged_reason text;/,
  );
  // Exactly one alter table statement in the executable SQL.
  const alterStatements = sqlStatementsOnly.match(/alter table/gi) ?? [];
  assert.equal(alterStatements.length, 1, "expected exactly one ALTER TABLE statement");
});

test("performs no data mutation", () => {
  assert.doesNotMatch(sqlStatementsOnly, /\bupdate\s+\w/i);
  assert.doesNotMatch(sqlStatementsOnly, /\binsert\s+into\b/i);
  assert.doesNotMatch(sqlStatementsOnly, /\bdelete\s+from\b/i);
});

test("never touches base_unit and cannot fire raw_inventory_base_unit_guard", () => {
  assert.doesNotMatch(sqlStatementsOnly, /\bset\s+base_unit\b/i);
  assert.doesNotMatch(sqlStatementsOnly, /update\s+(public\.)?ingredients/i);
  assert.doesNotMatch(sqlStatementsOnly, /protect_base_unit|raw_inventory_base_unit_guard/i);
});

test("adds no CHECK constraint and no trigger/function change", () => {
  assert.doesNotMatch(sqlStatementsOnly, /\bcheck\s*\(/i);
  assert.doesNotMatch(sqlStatementsOnly, /\badd constraint\b/i);
  assert.doesNotMatch(sqlStatementsOnly, /\bcreate\s+(or replace\s+)?trigger\b/i);
  assert.doesNotMatch(sqlStatementsOnly, /\bcreate\s+(or replace\s+)?function\b/i);
});

test("resolves the exact column loadProductLabReadState() selects on ingredients", () => {
  assert.match(
    readService,
    /client\.from\("ingredients"\)\.select\("[^"]*base_unit_migration_flagged_reason[^"]*"\)/,
    "read-service.ts's ingredients query names this column",
  );
  assert.match(migration, /base_unit_migration_flagged_reason text/);
});
