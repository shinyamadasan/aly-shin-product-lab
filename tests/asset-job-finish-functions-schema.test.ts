import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const sql = readFileSync(new URL("../supabase-add-asset-job-finish-functions.sql", import.meta.url), "utf8");
const sqlStatementsOnly = sql
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n");

const finishJobFunction = sqlStatementsOnly.match(/create or replace function finish_asset_job\(p_job_id uuid, p_outcome text, p_result jsonb, p_last_error text\)[\s\S]*?\$\$;/i)?.[0] ?? "";
const finishAttemptFunction = sqlStatementsOnly.match(/create or replace function finish_asset_job_attempt\(p_attempt_id uuid, p_outcome text, p_error_code text, p_error_message text\)[\s\S]*?\$\$;/i)?.[0] ?? "";

test("finish_asset_job and finish_asset_job_attempt are defined with no application-supplied timestamp parameter", () => {
  assert.notEqual(finishJobFunction, "");
  assert.notEqual(finishAttemptFunction, "");
  assert.doesNotMatch(finishJobFunction.split("returns table")[0], /timestamptz/i);
  assert.doesNotMatch(finishAttemptFunction.split("returns table")[0], /timestamptz/i);
});

test("finish_asset_job writes completed_at/failed_at from the database's own now(), never an application value", () => {
  assert.match(finishJobFunction, /completed_at = case when p_outcome = 'completed' then now\(\) else null end/i);
  assert.match(finishJobFunction, /failed_at = case when p_outcome = 'failed' then now\(\) else null end/i);
  assert.match(finishJobFunction, /updated_at = now\(\)/i);
});

test("finish_asset_job_attempt computes completed_at and latency_ms from the database's own now() and the row's own started_at", () => {
  assert.match(finishAttemptFunction, /completed_at = now\(\)/i);
  assert.match(finishAttemptFunction, /latency_ms = \(extract\(epoch from \(now\(\) - started_at\)\) \* 1000\)::integer/i);
});

test("finish_asset_job guards p_outcome and status in the WHERE clause instead of a trigger or CHECK constraint", () => {
  assert.match(finishJobFunction, /where id = p_job_id\s*\n\s*and status = 'running'\s*\n\s*and p_outcome in \('completed', 'failed'\)/i);
  assert.doesNotMatch(sqlStatementsOnly, /create trigger/i);
  assert.doesNotMatch(sqlStatementsOnly, /check\s*\(/i);
});

test("finish_asset_job_attempt guards p_outcome and status in the WHERE clause instead of a trigger or CHECK constraint", () => {
  assert.match(finishAttemptFunction, /where id = p_attempt_id\s*\n\s*and status = 'running'\s*\n\s*and p_outcome in \('completed', 'failed', 'timed_out'\)/i);
});

test("finish_asset_job and finish_asset_job_attempt use explicit, non-wildcard RETURNING column lists", () => {
  assert.doesNotMatch(finishJobFunction, /returning\s+\*/i);
  assert.doesNotMatch(finishAttemptFunction, /returning\s+\*/i);
  assert.match(
    finishJobFunction,
    /returning id, creative_package_id, status, worker_type, asset_kind, attempt_count, result,\s*\n\s*last_error, created_at, updated_at, started_at, completed_at, failed_at;/i,
  );
  assert.match(
    finishAttemptFunction,
    /returning id, asset_job_id, attempt_number, worker_type, status, started_at,\s*\n\s*completed_at, latency_ms, error_code, error_message, provider, model, created_at;/i,
  );
});

test("finish_asset_job and finish_asset_job_attempt are plain SQL functions, not SECURITY DEFINER, and create no table or trigger", () => {
  assert.doesNotMatch(finishJobFunction, /security definer/i);
  assert.doesNotMatch(finishAttemptFunction, /security definer/i);
  assert.match(finishJobFunction, /language sql/i);
  assert.match(finishAttemptFunction, /language sql/i);
  assert.doesNotMatch(sqlStatementsOnly, /create table/i);
  assert.doesNotMatch(sqlStatementsOnly, /create trigger/i);
});

test("finish_asset_job and finish_asset_job_attempt follow the existing authenticated-only grant convention", () => {
  assert.match(sql, /grant execute on function finish_asset_job\(uuid, text, jsonb, text\) to authenticated;/);
  assert.match(sql, /grant execute on function finish_asset_job_attempt\(uuid, text, text, text\) to authenticated;/);
  assert.doesNotMatch(sql, /grant[^;]*finish_asset_job[^;]*to (anon|public)/i);
});

test("this migration is additive only and does not modify a previously shipped SQL file", () => {
  assert.doesNotMatch(sqlStatementsOnly, /drop\s+function/i);
  assert.doesNotMatch(sqlStatementsOnly, /alter table/i);
  assert.doesNotMatch(sqlStatementsOnly, /drop\s+column/i);
});
