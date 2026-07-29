import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const sql = readFileSync(new URL("../supabase-add-opportunities.sql", import.meta.url), "utf8");
const sqlStatementsOnly = sql
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n");
const createTableStatement = sqlStatementsOnly.match(/create table if not exists opportunities \([\s\S]*?\);/i)?.[0] ?? "";
const guardStatements = Array.from(sqlStatementsOnly.matchAll(/do \$\$[\s\S]*?end \$\$;/gi), (match) => match[0]);
const staleTableGuardStatement = guardStatements[0] ?? "";
const indexGuardStatement = guardStatements[1] ?? "";

test("opportunities creates the approved persistence table with required columns", () => {
  assert.match(sql, /create table if not exists opportunities \(/);
  for (const requiredColumn of [
    "id uuid primary key default gen_random_uuid()",
    "opportunity_type text not null",
    "producer text not null",
    "source_type text not null",
    "source_id text not null",
    "title text not null",
    "summary text",
    "reason text not null",
    "recommended_action text not null",
    "evidence_version text not null",
    "evidence jsonb not null default '{}'::jsonb",
    "source_rule_ids text[] not null default '{}'::text[]",
    "source_findings jsonb not null default '[]'::jsonb",
    "status text not null default 'new'",
    "detected_at timestamptz not null",
    "expires_at timestamptz not null",
    "deduplication_key text not null",
    "created_at timestamptz not null default now()",
    "updated_at timestamptz not null default now()",
  ]) {
    assert.ok(sql.includes(requiredColumn), `missing column: ${requiredColumn}`);
  }
});

test("opportunities does not add unused prioritization fields yet", () => {
  assert.doesNotMatch(createTableStatement, /\bpriority\b/i);
});

test("opportunities fails loudly instead of silently accepting a stale draft schema", () => {
  assert.match(staleTableGuardStatement, /pg_attribute/i);
  assert.match(staleTableGuardStatement, /format_type/i);
  assert.match(staleTableGuardStatement, /attnotnull/i);
  for (const requiredColumn of [
    "id",
    "opportunity_type",
    "producer",
    "source_type",
    "source_id",
    "title",
    "summary",
    "reason",
    "recommended_action",
    "evidence_version",
    "evidence",
    "source_rule_ids",
    "source_findings",
    "status",
    "detected_at",
    "expires_at",
    "deduplication_key",
    "created_at",
    "updated_at",
  ]) {
    assert.match(staleTableGuardStatement, new RegExp(`'${requiredColumn}'`, "i"));
  }
  assert.match(staleTableGuardStatement, /attname = 'priority'/i);
  assert.match(staleTableGuardStatement, /contype = 'p'/i);
  assert.match(staleTableGuardStatement, /raise exception/i);
  assert.doesNotMatch(sqlStatementsOnly, /drop\s+column/i);
  assert.doesNotMatch(sqlStatementsOnly, /alter table opportunities\s+drop/i);
});

test("opportunities has the deduplication and lookup indexes", () => {
  assert.match(sql, /create unique index if not exists opportunities_deduplication_key_idx\s*\n\s*on opportunities \(deduplication_key\);/);
  assert.match(sql, /create index if not exists opportunities_status_detected_at_idx\s*\n\s*on opportunities \(status, detected_at desc\);/);
  assert.match(sql, /create index if not exists opportunities_source_idx\s*\n\s*on opportunities \(source_type, source_id\);/);
  assert.match(sql, /create index if not exists opportunities_new_expires_at_idx\s*\n\s*on opportunities \(expires_at\)\s*\n\s*where status = 'new';/);
});

test("opportunities fails loudly instead of silently accepting stale draft indexes", () => {
  assert.match(indexGuardStatement, /pg_get_indexdef/i);
  for (const expectedIndex of [
    "opportunities_deduplication_key_idx",
    "opportunities_status_detected_at_idx",
    "opportunities_source_idx",
    "opportunities_new_expires_at_idx",
  ]) {
    assert.match(indexGuardStatement, new RegExp(expectedIndex, "i"));
  }
  assert.match(indexGuardStatement, /deduplication_key/i);
  assert.match(indexGuardStatement, /status, detected_at desc/i);
  assert.match(indexGuardStatement, /source_type, source_id/i);
  assert.match(indexGuardStatement, /expires_at/i);
  assert.match(indexGuardStatement, /raise exception/i);
});

test("opportunities follows existing RLS and authenticated grant conventions", () => {
  assert.match(sql, /alter table opportunities enable row level security;/);
  assert.match(sql, /grant select, insert, update, delete on table opportunities to authenticated;/);
  assert.doesNotMatch(sql, /grant[^;]*opportunities[^;]*to (anon|public)/i);
  assert.match(sql, /create policy "Authenticated users can manage opportunities"/);
  assert.match(sql, /on opportunities for all\s*\n\s*to authenticated\s*\n\s*using \(true\)\s*\n\s*with check \(true\);/);
});

test("opportunities does not add a DB enum or check constraint for status", () => {
  assert.doesNotMatch(sqlStatementsOnly, /create type/i);
  assert.doesNotMatch(sqlStatementsOnly, /\benum\b/i);
  assert.doesNotMatch(createTableStatement, /check\s*\(/i);
});

test("opportunities does not create later pipeline tables", () => {
  for (const excludedTable of [
    "creative_jobs",
    "content_packages",
    "content_assets",
    "approvals",
    "workers",
    "events",
    "publishing_jobs",
    "campaigns",
    "campaign_products",
  ]) {
    assert.doesNotMatch(sqlStatementsOnly, new RegExp(`create table[^;]*\\b${excludedTable}\\b`, "i"));
  }
});

test("opportunities does not add provider-specific core columns", () => {
  for (const providerColumn of ["claude", "openai", "gemini", "ollama", "remotion", "provider", "model"]) {
    assert.doesNotMatch(sqlStatementsOnly, new RegExp(`\\b${providerColumn}\\b`, "i"));
  }
});
