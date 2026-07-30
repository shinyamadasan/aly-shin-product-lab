import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const sql = readFileSync(new URL("../supabase-add-creative-jobs.sql", import.meta.url), "utf8");
const sqlStatementsOnly = sql
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n");
const createTableStatement = sqlStatementsOnly.match(/create table if not exists creative_jobs \(([\s\S]*?)\);/i)?.[0] ?? "";
const columnBody = createTableStatement.match(/create table if not exists creative_jobs \(([\s\S]*?)\);/i)?.[1] ?? "";
const guardStatements = Array.from(sqlStatementsOnly.matchAll(/do \$\$[\s\S]*?end \$\$;/gi), (match) => match[0]);
const staleTableGuardStatement = guardStatements[0] ?? "";
const indexGuardStatement = guardStatements[1] ?? "";

test("creative_jobs creates the approved foundation table with required columns", () => {
  assert.match(sql, /create table if not exists creative_jobs \(/);
  for (const requiredColumn of [
    "id uuid primary key default gen_random_uuid()",
    "opportunity_id uuid not null references opportunities(id)",
    "status text not null default 'queued'",
    "worker_type text not null default 'mock'",
    "attempt_count integer not null default 0",
    "result jsonb not null default '{}'::jsonb",
    "created_at timestamptz not null default now()",
    "updated_at timestamptz not null default now()",
    "started_at timestamptz",
    "completed_at timestamptz",
    "failed_at timestamptz",
  ]) {
    assert.ok(sql.includes(requiredColumn), `missing column: ${requiredColumn}`);
  }
});

test("creative_jobs keeps worker identity explicit and does not use a generic worker column", () => {
  assert.match(columnBody, /\bworker_type text not null default 'mock'/i);
  assert.doesNotMatch(columnBody, /^\s*worker\s+text\b/im);
});

test("creative_jobs prevents duplicate jobs for the same Opportunity", () => {
  assert.match(sql, /create unique index if not exists creative_jobs_opportunity_id_idx\s*\n\s*on creative_jobs \(opportunity_id\);/);
});

test("creative_jobs has the status lookup index", () => {
  assert.match(sql, /create index if not exists creative_jobs_status_created_at_idx\s*\n\s*on creative_jobs \(status, created_at desc\);/);
});

test("creative_jobs fails loudly instead of silently accepting stale draft schemas and indexes", () => {
  assert.match(staleTableGuardStatement, /pg_attribute/i);
  assert.match(staleTableGuardStatement, /format_type/i);
  assert.match(staleTableGuardStatement, /attnotnull/i);
  for (const requiredColumn of [
    "id",
    "opportunity_id",
    "status",
    "worker_type",
    "attempt_count",
    "result",
    "created_at",
    "updated_at",
    "started_at",
    "completed_at",
    "failed_at",
  ]) {
    assert.match(staleTableGuardStatement, new RegExp(`'${requiredColumn}'`, "i"));
  }
  assert.match(staleTableGuardStatement, /contype = 'p'/i);
  assert.match(staleTableGuardStatement, /contype = 'f'/i);
  assert.match(staleTableGuardStatement, /raise exception/i);
  assert.match(indexGuardStatement, /creative_jobs_opportunity_id_idx/i);
  assert.match(indexGuardStatement, /creative_jobs_status_created_at_idx/i);
  assert.match(indexGuardStatement, /raise exception/i);
  assert.doesNotMatch(sqlStatementsOnly, /drop\s+column/i);
  assert.doesNotMatch(sqlStatementsOnly, /alter table creative_jobs\s+drop/i);
});

test("claim_creative_job atomically claims one queued job and increments attempt_count", () => {
  const functionMatch = sqlStatementsOnly.match(/create or replace function claim_creative_job\(p_job_id uuid\)[\s\S]*?\$\$;/i)?.[0] ?? "";
  assert.match(functionMatch, /update creative_jobs/i);
  assert.match(functionMatch, /status = 'running'/i);
  assert.match(functionMatch, /started_at = now\(\)/i);
  assert.match(functionMatch, /attempt_count = attempt_count \+ 1/i);
  assert.match(functionMatch, /where id = p_job_id\s+and status = 'queued'/i);
  assert.match(functionMatch, /returning \*/i);
  assert.doesNotMatch(functionMatch, /security definer/i);
});

test("creative_jobs follows existing RLS and authenticated grant conventions", () => {
  assert.match(sql, /alter table creative_jobs enable row level security;/);
  assert.match(sql, /grant select, insert, update, delete on table creative_jobs to authenticated;/);
  assert.match(sql, /grant execute on function claim_creative_job\(uuid\) to authenticated;/);
  assert.doesNotMatch(sql, /grant[^;]*creative_jobs[^;]*to (anon|public)/i);
  assert.match(sql, /create policy "Authenticated users can manage creative jobs"/);
  assert.match(sql, /on creative_jobs for all\s*\n\s*to authenticated\s*\n\s*using \(true\)\s*\n\s*with check \(true\);/);
});

test("creative_jobs keeps status app-validated, not DB-enforced", () => {
  assert.doesNotMatch(sqlStatementsOnly, /create type/i);
  assert.doesNotMatch(sqlStatementsOnly, /\benum\b/i);
  assert.doesNotMatch(columnBody, /check\s*\(/i);
});

test("creative_jobs does not create future pipeline tables or provider fields", () => {
  for (const excludedTable of [
    "content_packages",
    "content_assets",
    "assets",
    "approvals",
    "workers",
    "events",
    "publishing_jobs",
    "campaigns",
    "job_queue",
    "execution_queue",
  ]) {
    assert.doesNotMatch(sqlStatementsOnly, new RegExp(`create table[^;]*\\b${excludedTable}\\b`, "i"));
  }

  for (const providerColumn of ["claude", "openai", "gemini", "ollama", "remotion", "provider", "model"]) {
    assert.doesNotMatch(columnBody, new RegExp(`\\b${providerColumn}\\b`, "i"));
  }
});
