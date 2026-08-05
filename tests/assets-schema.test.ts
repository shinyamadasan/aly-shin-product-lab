import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const sql = readFileSync(new URL("../supabase-add-assets.sql", import.meta.url), "utf8");
const sqlStatementsOnly = sql
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n");
const createTableStatement = sqlStatementsOnly.match(/create table if not exists assets \(([\s\S]*?)\);/i)?.[0] ?? "";
const columnBody = createTableStatement.match(/create table if not exists assets \(([\s\S]*?)\);/i)?.[1] ?? "";
const guardStatements = Array.from(sqlStatementsOnly.matchAll(/do \$\$[\s\S]*?end \$\$;/gi), (match) => match[0]);
const staleTableGuardStatement = guardStatements[0] ?? "";
const indexGuardStatement = guardStatements[1] ?? "";

test("assets creates the approved foundation table with required columns", () => {
  assert.match(sql, /create table if not exists assets \(/);
  for (const requiredColumn of [
    "id uuid primary key default gen_random_uuid()",
    "asset_job_id uuid not null references asset_jobs(id) on delete restrict",
    "status text not null default 'generated'",
    "asset_kind text not null default 'image'",
    "schema_version text not null default 'v1'",
    "content jsonb not null default '{}'::jsonb",
    "created_at timestamptz not null default now()",
    "updated_at timestamptz not null default now()",
  ]) {
    assert.ok(sql.includes(requiredColumn), `missing column: ${requiredColumn}`);
  }
});

test("assets deliberately restricts deleting a source Asset Job", () => {
  assert.match(columnBody, /asset_job_id uuid not null references asset_jobs\(id\) on delete restrict/i);
});

test("assets prevents duplicate assets for the same Asset Job", () => {
  assert.match(sql, /create unique index if not exists assets_asset_job_id_idx\s*\n\s*on assets \(asset_job_id\);/);
});

test("assets has the status lookup index", () => {
  assert.match(sql, /create index if not exists assets_status_created_at_idx\s*\n\s*on assets \(status, created_at desc\);/);
});

test("assets ships only the generated status -- approve/reject is a later, separate milestone", () => {
  assert.match(columnBody, /status text not null default 'generated'/i);
  assert.doesNotMatch(columnBody, /'approved'|'rejected'/i);
});

test("assets fails loudly instead of silently accepting stale draft schemas and indexes", () => {
  assert.match(staleTableGuardStatement, /pg_attribute/i);
  assert.match(staleTableGuardStatement, /format_type/i);
  assert.match(staleTableGuardStatement, /attnotnull/i);
  for (const requiredColumn of ["id", "asset_job_id", "status", "asset_kind", "schema_version", "content", "created_at", "updated_at"]) {
    assert.match(staleTableGuardStatement, new RegExp(`'${requiredColumn}'`, "i"));
  }
  for (const disallowedColumn of ["reviewed_by", "reviewed_at", "rejection_reason", "provider", "model", "platform", "scheduled_at", "approval_id", "publishing_job_id", "campaign_id"]) {
    assert.match(staleTableGuardStatement, new RegExp(`'${disallowedColumn}'`, "i"));
  }
  assert.match(staleTableGuardStatement, /contype = 'p'/i);
  assert.match(staleTableGuardStatement, /contype = 'f'/i);
  assert.match(staleTableGuardStatement, /confdeltype = 'r'/i);
  assert.match(staleTableGuardStatement, /raise exception/i);
  assert.match(indexGuardStatement, /assets_asset_job_id_idx/i);
  assert.match(indexGuardStatement, /assets_status_created_at_idx/i);
  assert.match(indexGuardStatement, /raise exception/i);
  assert.doesNotMatch(sqlStatementsOnly, /drop\s+column/i);
  assert.doesNotMatch(sqlStatementsOnly, /alter table assets\s+drop/i);
});

test("assets follows existing RLS and authenticated grant conventions", () => {
  assert.match(sql, /alter table assets enable row level security;/);
  assert.match(sql, /grant select, insert, update, delete on table assets to authenticated;/);
  assert.doesNotMatch(sql, /grant[^;]*assets[^;]*to (anon|public)/i);
  assert.match(sql, /create policy "Authenticated users can manage assets"/);
  assert.match(sql, /on assets for all\s*\n\s*to authenticated\s*\n\s*using \(true\)\s*\n\s*with check \(true\);/);
});

test("assets keeps status app-validated, not DB-enforced", () => {
  assert.doesNotMatch(sqlStatementsOnly, /create type/i);
  assert.doesNotMatch(sqlStatementsOnly, /\benum\b/i);
  assert.doesNotMatch(columnBody, /check\s*\(/i);
});

test("assets does not create excluded future-domain tables or fields", () => {
  for (const excludedTable of ["approvals", "workers", "events", "publishing_jobs", "campaigns", "job_queue", "execution_queue", "package_versions"]) {
    assert.doesNotMatch(sqlStatementsOnly, new RegExp(`create table[^;]*\\b${excludedTable}\\b`, "i"));
  }

  for (const excludedColumn of ["reviewed", "rejection", "approval", "provider", "model", "platform", "scheduled", "publish", "campaign"]) {
    assert.doesNotMatch(columnBody, new RegExp(`\\b${excludedColumn}\\b`, "i"));
  }
});
