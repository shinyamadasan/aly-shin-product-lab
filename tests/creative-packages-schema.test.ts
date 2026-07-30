import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const sql = readFileSync(new URL("../supabase-add-creative-packages.sql", import.meta.url), "utf8");
const sqlStatementsOnly = sql
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n");
const createTableStatement = sqlStatementsOnly.match(/create table if not exists creative_packages \(([\s\S]*?)\);/i)?.[0] ?? "";
const columnBody = createTableStatement.match(/create table if not exists creative_packages \(([\s\S]*?)\);/i)?.[1] ?? "";
const guardStatements = Array.from(sqlStatementsOnly.matchAll(/do \$\$[\s\S]*?end \$\$;/gi), (match) => match[0]);
const staleTableGuardStatement = guardStatements[0] ?? "";
const indexGuardStatement = guardStatements[1] ?? "";

test("creative_packages creates the approved foundation table with required columns", () => {
  assert.match(sql, /create table if not exists creative_packages \(/);
  for (const requiredColumn of [
    "id uuid primary key default gen_random_uuid()",
    "creative_job_id uuid not null references creative_jobs(id) on delete restrict",
    "status text not null default 'ready'",
    "schema_version text not null default 'v1'",
    "content jsonb not null default '{}'::jsonb",
    "created_at timestamptz not null default now()",
    "updated_at timestamptz not null default now()",
  ]) {
    assert.ok(sql.includes(requiredColumn), `missing column: ${requiredColumn}`);
  }
});

test("creative_packages deliberately restricts deleting a source Creative Job", () => {
  assert.match(columnBody, /creative_job_id uuid not null references creative_jobs\(id\) on delete restrict/i);
  assert.match(sql, /delete the package first, then the job, then the Opportunity/i);
});

test("creative_packages prevents duplicate packages for the same Creative Job", () => {
  assert.match(sql, /create unique index if not exists creative_packages_creative_job_id_idx\s*\n\s*on creative_packages \(creative_job_id\);/);
});

test("creative_packages has the status lookup index", () => {
  assert.match(sql, /create index if not exists creative_packages_status_created_at_idx\s*\n\s*on creative_packages \(status, created_at desc\);/);
});

test("creative_packages fails loudly instead of silently accepting stale draft schemas and indexes", () => {
  assert.match(staleTableGuardStatement, /pg_attribute/i);
  assert.match(staleTableGuardStatement, /format_type/i);
  assert.match(staleTableGuardStatement, /attnotnull/i);
  for (const requiredColumn of ["id", "creative_job_id", "status", "schema_version", "content", "created_at", "updated_at"]) {
    assert.match(staleTableGuardStatement, new RegExp(`'${requiredColumn}'`, "i"));
  }
  for (const disallowedColumn of ["opportunity_id", "asset_id", "approval_id", "publishing_job_id", "provider", "model", "platform", "scheduled_at", "version", "package_version"]) {
    assert.match(staleTableGuardStatement, new RegExp(`'${disallowedColumn}'`, "i"));
  }
  assert.match(staleTableGuardStatement, /contype = 'p'/i);
  assert.match(staleTableGuardStatement, /contype = 'f'/i);
  assert.match(staleTableGuardStatement, /confdeltype = 'r'/i);
  assert.match(staleTableGuardStatement, /raise exception/i);
  assert.match(indexGuardStatement, /creative_packages_creative_job_id_idx/i);
  assert.match(indexGuardStatement, /creative_packages_status_created_at_idx/i);
  assert.match(indexGuardStatement, /raise exception/i);
  assert.doesNotMatch(sqlStatementsOnly, /drop\s+column/i);
  assert.doesNotMatch(sqlStatementsOnly, /alter table creative_packages\s+drop/i);
});

test("creative_packages follows existing RLS and authenticated grant conventions", () => {
  assert.match(sql, /alter table creative_packages enable row level security;/);
  assert.match(sql, /grant select, insert, update, delete on table creative_packages to authenticated;/);
  assert.doesNotMatch(sql, /grant[^;]*creative_packages[^;]*to (anon|public)/i);
  assert.match(sql, /create policy "Authenticated users can manage creative packages"/);
  assert.match(sql, /on creative_packages for all\s*\n\s*to authenticated\s*\n\s*using \(true\)\s*\n\s*with check \(true\);/);
});

test("creative_packages keeps status app-validated, not DB-enforced", () => {
  assert.doesNotMatch(sqlStatementsOnly, /create type/i);
  assert.doesNotMatch(sqlStatementsOnly, /\benum\b/i);
  assert.doesNotMatch(columnBody, /check\s*\(/i);
});

test("creative_packages does not create excluded future-domain tables or fields", () => {
  for (const excludedTable of [
    "assets",
    "content_assets",
    "approvals",
    "workers",
    "events",
    "publishing_jobs",
    "campaigns",
    "job_queue",
    "execution_queue",
    "package_versions",
    "creative_package_versions",
  ]) {
    assert.doesNotMatch(sqlStatementsOnly, new RegExp(`create table[^;]*\\b${excludedTable}\\b`, "i"));
  }

  for (const excludedColumn of ["opportunity_id", "asset", "approval", "provider", "model", "platform", "scheduled", "publish", "version integer"]) {
    assert.doesNotMatch(columnBody, new RegExp(`\\b${excludedColumn}\\b`, "i"));
  }
});
