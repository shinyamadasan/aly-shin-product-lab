import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// This repo has no live-database or pgTAP test harness (same disclosure as
// tests/brand-profiles-schema.test.ts). These are static/text checks against the
// migration file and the hand-written TypeScript type -- not a live schema -- covering
// the M2A Journey-readiness change: content_journal becomes the canonical Journey
// persistence table, entry_type is added as a nullable, unclassified-by-default column,
// and no journey_entries table (or any other new table) is created.
const sql = readFileSync(new URL("../supabase-add-journey-entry-type.sql", import.meta.url), "utf8");
const types = readFileSync(new URL("../src/lib/product-lab-types.ts", import.meta.url), "utf8");

// This migration's header comment explains what it deliberately avoids (an enum, a
// journey_entries table, other tables) -- which legitimately means those words appear in
// the file's prose. Checks for "does this file actually do X" must look at statements,
// not comments, or they false-positive on a well-documented migration explaining itself.
// (See how tests/brand-profiles-schema.test.ts scopes its own such check to `create
// table[^;]*` rather than the whole file, for the same reason.)
const sqlStatementsOnly = sql
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n");

test("adds entry_type to content_journal as a plain nullable text column", () => {
  assert.match(sql, /alter table content_journal add column if not exists entry_type text;/);
});

test("entry_type has no not-null constraint and no default value", () => {
  assert.doesNotMatch(sql, /entry_type text not null/);
  assert.doesNotMatch(sql, /entry_type[^;]*default/i);
});

test("no check constraint or database enum restricts entry_type to a fixed list", () => {
  assert.doesNotMatch(sqlStatementsOnly, /check\s*\(/i);
  assert.doesNotMatch(sqlStatementsOnly, /create type/i);
  assert.doesNotMatch(sqlStatementsOnly, /\benum\b/i);
});

test("the migration alters only content_journal -- no other table is altered", () => {
  const alteredTables = [...sql.matchAll(/alter table (\w+)/g)].map((m) => m[1]);
  assert.deepEqual(alteredTables, ["content_journal"]);
});

test("no table is created by this migration -- content_journal already exists", () => {
  assert.doesNotMatch(sql, /create table/i);
});

test("does not create a journey_entries table", () => {
  assert.doesNotMatch(sqlStatementsOnly, /journey_entries/);
});

test("does not touch Campaign, Content Studio, Calendar, Publishing, or other unrelated schemas", () => {
  for (const unrelatedTable of [
    "campaigns",
    "campaign_products",
    "content_drafts",
    "content_assets",
    "content_calendar_entries",
    "publishing_jobs",
    "campaign_performance",
    "brand_profiles",
    "ingredients",
    "inventory_transactions",
    "costing_entries",
    "costing_summaries",
    "product_batches",
    "products",
    "tasting_feedback",
    "equipment",
  ]) {
    assert.doesNotMatch(sqlStatementsOnly, new RegExp(`\\b${unrelatedTable}\\b`));
  }
});

test("performs no historical-data backfill -- no update/insert statement against content_journal", () => {
  assert.doesNotMatch(sql, /update content_journal/i);
  assert.doesNotMatch(sql, /insert into content_journal/i);
});

test("does not drop or rename any existing content_journal column", () => {
  assert.doesNotMatch(sql, /drop column/i);
  assert.doesNotMatch(sql, /rename column/i);
  assert.doesNotMatch(sql, /rename to/i);
});

test("ContentJournalEntry includes batchId and entryType, both optional (nullable-column convention)", () => {
  const typeMatch = types.match(/export type ContentJournalEntry = \{[\s\S]*?\n\};/);
  assert.ok(typeMatch, "ContentJournalEntry type not found in product-lab-types.ts");
  const body = typeMatch[0];
  assert.match(body, /batchId\?:\s*string;/);
  assert.match(body, /entryType\?:\s*string;/);
});

test("ContentJournalEntry's original fields are all still present, unremoved", () => {
  const typeMatch = types.match(/export type ContentJournalEntry = \{[\s\S]*?\n\};/);
  assert.ok(typeMatch, "ContentJournalEntry type not found in product-lab-types.ts");
  const body = typeMatch[0];
  for (const field of ["id", "productId", "entryDate", "whatWasMade", "mediaCaptured", "lessonLearned", "postIdeas", "nextAction"]) {
    assert.match(body, new RegExp(`\\b${field}[?]?:\\s*string;`));
  }
});
