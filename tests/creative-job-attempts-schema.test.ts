import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const sql = readFileSync(new URL("../supabase-add-creative-job-attempts.sql", import.meta.url), "utf8");
const creativeJobsSql = readFileSync(new URL("../supabase-add-creative-jobs.sql", import.meta.url), "utf8");
const sqlStatementsOnly = sql
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n");
const createTableStatement = sqlStatementsOnly.match(/create table if not exists creative_job_attempts \(([\s\S]*?)\);/i)?.[0] ?? "";
const columnBody = createTableStatement.match(/create table if not exists creative_job_attempts \(([\s\S]*?)\);/i)?.[1] ?? "";
const guardStatements = Array.from(sqlStatementsOnly.matchAll(/do \$\$[\s\S]*?end \$\$;/gi), (match) => match[0]);
const staleTableGuardStatement = guardStatements[0] ?? "";
const indexGuardStatement = guardStatements[1] ?? "";

test("creative_job_attempts creates the approved foundation table with required columns", () => {
  assert.match(sql, /create table if not exists creative_job_attempts \(/);
  for (const requiredColumn of [
    "id uuid primary key default gen_random_uuid()",
    "creative_job_id uuid not null references creative_jobs(id) on delete cascade",
    "attempt_number integer not null",
    "worker_type text not null",
    "status text not null default 'running'",
    "started_at timestamptz not null",
    "completed_at timestamptz",
    "latency_ms integer",
    "error_code text",
    "error_message text",
    "provider text",
    "model text",
    "created_at timestamptz not null default now()",
  ]) {
    assert.ok(sql.includes(requiredColumn), `missing column: ${requiredColumn}`);
  }
});

test("creative_job_attempts keeps worker identity explicit and does not use a generic worker column", () => {
  assert.match(columnBody, /\bworker_type text not null/i);
  assert.doesNotMatch(columnBody, /^\s*worker\s+text\b/im);
});

test("creative_job_attempts enforces one row per job attempt", () => {
  assert.match(sql, /create unique index if not exists creative_job_attempts_job_attempt_idx\s*\n\s*on creative_job_attempts \(creative_job_id, attempt_number\);/);
});

test("creative_job_attempts fails loudly instead of silently accepting stale draft schemas and indexes", () => {
  assert.match(staleTableGuardStatement, /pg_attribute/i);
  assert.match(staleTableGuardStatement, /format_type/i);
  assert.match(staleTableGuardStatement, /attnotnull/i);
  for (const requiredColumn of [
    "id",
    "creative_job_id",
    "attempt_number",
    "worker_type",
    "status",
    "started_at",
    "completed_at",
    "latency_ms",
    "error_code",
    "error_message",
    "provider",
    "model",
    "created_at",
  ]) {
    assert.match(staleTableGuardStatement, new RegExp(`'${requiredColumn}'`, "i"));
  }
  assert.match(staleTableGuardStatement, /contype = 'p'/i);
  assert.match(staleTableGuardStatement, /contype = 'f'/i);
  assert.match(staleTableGuardStatement, /confdeltype = 'c'/i);
  for (const disallowedColumn of [
    "token_count",
    "tokens",
    "prompt",
    "raw_response",
    "api_request_id",
    "execution_history_id",
    "retry_after",
    "max_retries",
    "provider_request_id",
    "input_tokens",
    "output_tokens",
    "estimated_cost",
    "api_key",
    "secret",
    "access_token",
    "bearer_token",
    "authorization",
    "credentials",
    "stack_trace",
  ]) {
    assert.match(staleTableGuardStatement, new RegExp(`'${disallowedColumn}'`, "i"));
  }
  assert.match(staleTableGuardStatement, /raise exception/i);
  assert.match(indexGuardStatement, /creative_job_attempts_job_attempt_idx/i);
  assert.match(indexGuardStatement, /raise exception/i);
  assert.doesNotMatch(sqlStatementsOnly, /drop\s+column/i);
  assert.doesNotMatch(sqlStatementsOnly, /alter table creative_job_attempts\s+drop/i);
});

test("claim_creative_job_with_attempt atomically claims a job and inserts its attempt in one statement", () => {
  // H1 recreates the function with DROP + CREATE rather than CREATE OR REPLACE, because PostgreSQL
  // refuses to change a declared return type in place.
  const functionMatch = sqlStatementsOnly.match(/create (or replace )?function claim_creative_job_with_attempt\(p_job_id uuid\)[\s\S]*?\$\$;/i)?.[0] ?? "";
  assert.match(functionMatch, /update creative_jobs/i);
  assert.match(functionMatch, /status = 'running'/i);
  assert.match(functionMatch, /started_at = now\(\)/i);
  assert.match(functionMatch, /attempt_count = attempt_count \+ 1/i);
  assert.match(functionMatch, /where id = p_job_id\s+and status = 'queued'/i);
  assert.match(functionMatch, /insert into creative_job_attempts/i);
  assert.match(functionMatch, /returning id as attempt_id/i);
  assert.match(functionMatch, /join inserted_attempt on inserted_attempt\.creative_job_id = claimed\.id/i);
  assert.doesNotMatch(functionMatch, /security definer/i);

  // H1 regression guards, at the text level. The executable proof lives in
  // tests/smoke/postgres/claim-rpc.smoke.test.ts; these two catch the same mistake in review.
  //
  // 1. The declared result must expose `intent`, which S1 added to creative_jobs.
  assert.match(functionMatch, /intent jsonb/i);
  // 2. The body must NOT use `claimed.*`. Pairing a hand-written RETURNS TABLE with star expansion
  //    is what coupled the declared shape to physical column order and broke every claim when S1
  //    added a column. Naming the columns is what makes this function order-independent -- and it
  //    has to be, because a fresh install declares `intent` third while a migrated table appends it.
  assert.doesNotMatch(functionMatch, /select\s+claimed\.\*/i);
  // 3. DROP must precede CREATE, or an existing database cannot receive the corrected return type.
  assert.match(sqlStatementsOnly, /drop function if exists claim_creative_job_with_attempt\(uuid\);/i);
});

test("claim_creative_job_with_attempt supersedes claim_creative_job without dropping it in this migration", () => {
  assert.match(sql, /supersedes claim_creative_job/i);
  assert.match(sql, /not dropped/i);
  assert.match(creativeJobsSql, /create or replace function claim_creative_job\(/i);
  assert.doesNotMatch(creativeJobsSql, /drop function/i);
});

test("creative_job_attempts follows existing RLS and authenticated grant conventions", () => {
  assert.match(sql, /alter table creative_job_attempts enable row level security;/);
  assert.match(sql, /grant select, insert, update, delete on table creative_job_attempts to authenticated;/);
  assert.match(sql, /grant execute on function claim_creative_job_with_attempt\(uuid\) to authenticated;/);
  assert.doesNotMatch(sql, /grant[^;]*creative_job_attempts[^;]*to (anon|public)/i);
  assert.match(sql, /create policy "Authenticated users can manage creative job attempts"/);
  assert.match(sql, /on creative_job_attempts for all\s*\n\s*to authenticated\s*\n\s*using \(true\)\s*\n\s*with check \(true\);/);
});

test("creative_job_attempts keeps status app-validated, not DB-enforced", () => {
  assert.doesNotMatch(sqlStatementsOnly, /create type/i);
  assert.doesNotMatch(sqlStatementsOnly, /\benum\b/i);
  assert.doesNotMatch(columnBody, /check\s*\(/i);
});

test("creative_job_attempts does not create future pipeline tables, repair/retry mechanisms, or provider-secret fields", () => {
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

  // provider/model are deliberately present (nullable) -- only their real-payload/secret and
  // deferred-accounting neighbors are excluded from this milestone.
  for (const excludedColumn of [
    "tokens",
    "prompt",
    "raw_response",
    "execution_history_id",
    "retry_after",
    "max_retries",
    "provider_request_id",
    "input_tokens",
    "output_tokens",
    "estimated_cost",
    "api_key",
    "stack_trace",
  ]) {
    assert.doesNotMatch(columnBody, new RegExp(`\\b${excludedColumn}\\b`, "i"));
  }

  for (const providerName of ["claude", "openai", "gemini", "ollama", "remotion"]) {
    assert.doesNotMatch(columnBody, new RegExp(`\\b${providerName}\\b`, "i"));
  }

  assert.doesNotMatch(sqlStatementsOnly, /repair_stale|stale_running|heartbeat|max_attempts|retry_count/i);
});
