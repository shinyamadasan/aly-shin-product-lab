import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const sql = readFileSync(new URL("../supabase-add-asset-jobs.sql", import.meta.url), "utf8");
const sqlStatementsOnly = sql
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n");
const createTableStatement = sqlStatementsOnly.match(/create table if not exists asset_jobs \(([\s\S]*?)\);/i)?.[0] ?? "";
const columnBody = createTableStatement.match(/create table if not exists asset_jobs \(([\s\S]*?)\);/i)?.[1] ?? "";
const guardStatements = Array.from(sqlStatementsOnly.matchAll(/do \$\$[\s\S]*?end \$\$;/gi), (match) => match[0]);
const staleTableGuardStatement = guardStatements[0] ?? "";
const indexGuardStatement = guardStatements[1] ?? "";

test("asset_jobs creates the approved foundation table with required columns", () => {
  assert.match(sql, /create table if not exists asset_jobs \(/);
  for (const requiredColumn of [
    "id uuid primary key default gen_random_uuid()",
    "creative_package_id uuid not null references creative_packages(id)",
    "status text not null default 'queued'",
    "worker_type text not null default 'mock'",
    "asset_kind text not null default 'image'",
    "attempt_count integer not null default 0",
    "result jsonb not null default '{}'::jsonb",
    "last_error text",
    "created_at timestamptz not null default now()",
    "updated_at timestamptz not null default now()",
    "started_at timestamptz",
    "completed_at timestamptz",
    "failed_at timestamptz",
  ]) {
    assert.ok(sql.includes(requiredColumn), `missing column: ${requiredColumn}`);
  }
});

test("asset_jobs keeps worker identity and asset kind explicit, not generic columns", () => {
  assert.match(columnBody, /\bworker_type text not null default 'mock'/i);
  assert.match(columnBody, /\basset_kind text not null default 'image'/i);
  assert.doesNotMatch(columnBody, /^\s*worker\s+text\b/im);
  assert.doesNotMatch(columnBody, /^\s*kind\s+text\b/im);
});

test("asset_jobs allows many Asset Jobs per Creative Package, unlike creative_jobs' unique opportunity_id", () => {
  assert.match(sql, /create index if not exists asset_jobs_creative_package_id_idx\s*\n\s*on asset_jobs \(creative_package_id\);/);
  assert.doesNotMatch(sql, /create unique index[^;]*asset_jobs_creative_package_id_idx/i);
});

test("asset_jobs has the status lookup index", () => {
  assert.match(sql, /create index if not exists asset_jobs_status_created_at_idx\s*\n\s*on asset_jobs \(status, created_at desc\);/);
});

test("asset_jobs defines no claim function of its own -- claim_asset_job_with_attempt lives in supabase-add-asset-job-attempts.sql", () => {
  assert.doesNotMatch(sqlStatementsOnly, /create (or replace )?function claim_asset_job/i);
  assert.match(sql, /claim_asset_job_with_attempt is defined directly in/i);
});

test("asset_jobs fails loudly instead of silently accepting stale draft schemas and indexes", () => {
  assert.match(staleTableGuardStatement, /pg_attribute/i);
  assert.match(staleTableGuardStatement, /format_type/i);
  assert.match(staleTableGuardStatement, /attnotnull/i);
  for (const requiredColumn of [
    "id",
    "creative_package_id",
    "status",
    "worker_type",
    "asset_kind",
    "attempt_count",
    "result",
    "last_error",
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
  for (const disallowedColumn of ["provider", "model", "token_count", "tokens", "prompt", "raw_response", "api_request_id", "execution_history_id", "retry_after", "max_retries", "cost", "estimated_cost"]) {
    assert.match(staleTableGuardStatement, new RegExp(`'${disallowedColumn}'`, "i"));
  }
  assert.match(staleTableGuardStatement, /raise exception/i);
  assert.match(staleTableGuardStatement, /indisunique/i);
  assert.match(indexGuardStatement, /asset_jobs_creative_package_id_idx/i);
  assert.match(indexGuardStatement, /asset_jobs_status_created_at_idx/i);
  assert.match(indexGuardStatement, /raise exception/i);
  assert.doesNotMatch(sqlStatementsOnly, /drop\s+column/i);
  assert.doesNotMatch(sqlStatementsOnly, /alter table asset_jobs\s+drop/i);
});

test("asset_jobs follows existing RLS and authenticated grant conventions", () => {
  assert.match(sql, /alter table asset_jobs enable row level security;/);
  assert.match(sql, /grant select, insert, update, delete on table asset_jobs to authenticated;/);
  assert.doesNotMatch(sql, /grant[^;]*asset_jobs[^;]*to (anon|public)/i);
  assert.match(sql, /create policy "Authenticated users can manage asset jobs"/);
  assert.match(sql, /on asset_jobs for all\s*\n\s*to authenticated\s*\n\s*using \(true\)\s*\n\s*with check \(true\);/);
});

test("asset_jobs keeps status and asset_kind app-validated, not DB-enforced", () => {
  assert.doesNotMatch(sqlStatementsOnly, /create type/i);
  assert.doesNotMatch(sqlStatementsOnly, /\benum\b/i);
  assert.doesNotMatch(columnBody, /check\s*\(/i);
});

test("asset_jobs does not create Storage, review, or future pipeline tables and fields", () => {
  for (const excludedTable of [
    "asset_files",
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

  for (const providerColumn of ["openai", "gemini", "veo", "runway", "remotion", "provider", "model", "tokens", "prompt", "raw_response", "execution_history_id", "retry_after", "max_retries"]) {
    assert.doesNotMatch(columnBody, new RegExp(`\\b${providerColumn}\\b`, "i"));
  }

  assert.doesNotMatch(sqlStatementsOnly, /storage\.buckets|storage\.objects/i);
});
