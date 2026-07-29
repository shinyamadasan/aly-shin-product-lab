import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// M2C1 -- Content persistence foundation. This repo has no live-database or pgTAP test
// harness (same disclosure as tests/brand-profiles-schema.test.ts and
// tests/journey-content-journal-schema.test.ts): these are static/text checks against the
// migration file, not a live schema. They catch a future edit accidentally weakening RLS,
// adding a placeholder Campaign FK, reintroducing a jsonb column, or narrowing content_type/
// status into a fixed enum this milestone deliberately avoided.
const sql = readFileSync(new URL("../supabase-add-content-drafts.sql", import.meta.url), "utf8");
const types = readFileSync(new URL("../src/lib/product-lab-types.ts", import.meta.url), "utf8");

// Comments in this migration legitimately explain what it deliberately avoids (an enum, a
// campaign_id column, jsonb) -- so "does this file actually do X" checks must look at
// statements, not prose, or they false-positive on a well-documented migration explaining
// itself. Same reasoning as tests/journey-content-journal-schema.test.ts's own helper.
const sqlStatementsOnly = sql
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n");

const createTableMatch = sqlStatementsOnly.match(/create table if not exists content_drafts \(([\s\S]*?)\);/);
assert.ok(createTableMatch, "content_drafts create-table statement not found");
const columnBody = createTableMatch[1];

test("1. content_drafts is created", () => {
  assert.match(sqlStatementsOnly, /create table if not exists content_drafts \(/);
});

test("2. id is a uuid primary key with the established gen_random_uuid() default", () => {
  assert.match(columnBody, /id uuid primary key default gen_random_uuid\(\)/);
});

test("3. journey_entry_id is nullable (no not null)", () => {
  const line = columnBody.match(/journey_entry_id[^,]*/)?.[0] ?? "";
  assert.ok(line, "journey_entry_id column not found");
  assert.doesNotMatch(line, /not null/);
});

test("4. journey_entry_id references content_journal(id)", () => {
  assert.match(columnBody, /journey_entry_id uuid references content_journal\(id\)/);
});

test("5. deleting a Journey entry sets the link to null (on delete set null)", () => {
  const line = columnBody.match(/journey_entry_id[^,]*/)?.[0] ?? "";
  assert.match(line, /on delete set null/);
});

test("6. source_snapshot is nullable text, not json/jsonb", () => {
  const line = columnBody.match(/source_snapshot[^,]*/)?.[0] ?? "";
  assert.ok(line, "source_snapshot column not found");
  assert.match(line, /^source_snapshot text$/);
  assert.doesNotMatch(line, /not null/);
  assert.doesNotMatch(line, /json/i);
});

test("7. title is nullable text", () => {
  const line = columnBody.match(/title[^,]*/)?.[0] ?? "";
  assert.ok(line, "title column not found");
  assert.match(line, /^title text$/);
  assert.doesNotMatch(line, /not null/);
});

test("8. content_type is required with default 'general'", () => {
  assert.match(columnBody, /content_type text not null default 'general'/);
});

test("9. status is required with default 'idea'", () => {
  assert.match(columnBody, /status text not null default 'idea'/);
});

test("10. hook, caption, and script are nullable text", () => {
  for (const field of ["hook", "caption", "script"]) {
    const line = columnBody.match(new RegExp(`${field}[^,]*`))?.[0] ?? "";
    assert.ok(line, `${field} column not found`);
    assert.match(line, new RegExp(`^${field} text$`));
    assert.doesNotMatch(line, /not null/);
  }
});

test("11. created_at/updated_at follow the existing timestamptz-default-now convention, no trigger", () => {
  assert.match(columnBody, /created_at timestamptz not null default now\(\)/);
  assert.match(columnBody, /updated_at timestamptz not null default now\(\)/);
  assert.doesNotMatch(sqlStatementsOnly, /trigger/i);
});

test("12. row level security is enabled", () => {
  assert.match(sqlStatementsOnly, /alter table content_drafts enable row level security;/);
});

test("13. the authenticated policy matches every other table's shared-operator convention", () => {
  assert.match(sqlStatementsOnly, /grant select, insert, update, delete on table content_drafts to authenticated;/);
  assert.match(sqlStatementsOnly, /create policy "Authenticated users can manage content drafts"/);
  assert.match(
    sqlStatementsOnly,
    /on content_drafts for all\s*\n\s*to authenticated\s*\n\s*using \(true\)\s*\n\s*with check \(true\);/,
  );
  assert.doesNotMatch(sqlStatementsOnly, /grant[^;]*content_drafts[^;]*to (anon|public)/i);
});

// Scoped to the table's own column list, not the whole file -- the RLS policy's `with check
// (true)` clause legitimately contains the literal text "check (" and is a different SQL
// construct entirely (policy syntax, not a column constraint); searching the whole file would
// false-positive on it.
test("14. no enum or check constraint restricts content_type to a fixed list", () => {
  assert.doesNotMatch(columnBody, /check\s*\(/i);
  assert.doesNotMatch(sqlStatementsOnly, /create type/i);
});

test("15. no enum or check constraint restricts status to a fixed list", () => {
  // Same column-body-scoped check as content_type -- this migration has exactly one
  // check-constraint-capable table, so absence of `check (` there / `create type` anywhere
  // covers both columns.
  assert.doesNotMatch(columnBody, /check\s*\(/i);
  assert.doesNotMatch(sqlStatementsOnly, /create type/i);
});

test("does not add a campaign_id column or any other placeholder foreign key to a nonexistent table", () => {
  assert.doesNotMatch(columnBody, /\bcampaign_id\b/);
  assert.doesNotMatch(columnBody, /references campaigns\(/);
});

test("does not add platform, direct product_id, or direct batch_id columns", () => {
  assert.doesNotMatch(columnBody, /\bplatform\b/);
  assert.doesNotMatch(columnBody, /\bproduct_id\b/);
  assert.doesNotMatch(columnBody, /\bbatch_id\b/);
});

test("does not invent a per-user/workspace ownership column", () => {
  assert.doesNotMatch(columnBody, /\b(user_id|owner_id|workspace_id|tenant_id|account_id)\b/);
});

test("does not use a generic polymorphic source_type/source_id pair", () => {
  assert.doesNotMatch(columnBody, /\bsource_type\b/);
  assert.doesNotMatch(columnBody, /\bsource_id\b/);
});

test("no json or jsonb column exists anywhere in the table", () => {
  assert.doesNotMatch(columnBody, /jsonb?\b/i);
});

test("no AI-generation, publishing, scheduling, analytics, review/approval, or soft-delete field exists", () => {
  for (const forbidden of [
    "generation_provider",
    "generation_model",
    "generation_prompt",
    "published_at",
    "scheduled",
    "impressions",
    "reach",
    "reviewed_by",
    "rejection_reason",
    "deleted_at",
  ]) {
    assert.doesNotMatch(columnBody, new RegExp(`\\b${forbidden}\\b`, "i"));
  }
});

test("this migration stays scoped to content_drafts only -- no other table is created or altered", () => {
  const createdTables = [...sqlStatementsOnly.matchAll(/create table[^(]*?\b(\w+)\s*\(/g)].map((m) => m[1]);
  assert.deepEqual(createdTables, ["content_drafts"]);
  assert.doesNotMatch(sqlStatementsOnly, /alter table (?!content_drafts\b)\w+/);
});

test("ContentDraft type includes all M2C1 fields, following the established nullable-as-empty-string convention", () => {
  const typeMatch = types.match(/export type ContentDraft = \{[\s\S]*?\n\};/);
  assert.ok(typeMatch, "ContentDraft type not found in product-lab-types.ts");
  const body = typeMatch[0];
  for (const field of [
    "id",
    "journeyEntryId",
    "sourceSnapshot",
    "title",
    "contentType",
    "status",
    "hook",
    "caption",
    "script",
    "createdAt",
    "updatedAt",
  ]) {
    assert.match(body, new RegExp(`\\b${field}: string;`));
  }
});

test("ContentDraft does not include campaignId, platform, productId, batchId, or an owner field", () => {
  const typeMatch = types.match(/export type ContentDraft = \{[\s\S]*?\n\};/);
  assert.ok(typeMatch, "ContentDraft type not found in product-lab-types.ts");
  const body = typeMatch[0];
  for (const forbidden of ["campaignId", "platform", "productId", "batchId", "ownerId", "userId", "workspaceId"]) {
    assert.doesNotMatch(body, new RegExp(`\\b${forbidden}\\b`));
  }
});
