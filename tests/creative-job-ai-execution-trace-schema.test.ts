import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// S3E-A1 schema tests. These assert on SQL TEXT and are deliberately NOT the whole verification --
// the executable proof that the migration applies, preserves historical rows and persists a trace
// lives in tests/smoke/postgres/ai-execution-trace.smoke.test.ts. These catch the same mistakes in
// review, before anyone runs Docker.

const sql = readFileSync(new URL("../supabase-add-creative-job-ai-execution-trace.sql", import.meta.url), "utf8");
const attemptsSql = readFileSync(new URL("../supabase-add-creative-job-attempts.sql", import.meta.url), "utf8");
const finishFunctionsSql = readFileSync(new URL("../supabase-add-creative-job-finish-functions.sql", import.meta.url), "utf8");

const sqlStatementsOnly = sql
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n");

const traceFunction = sqlStatementsOnly.match(/create or replace function finish_creative_job_attempt_with_trace\([\s\S]*?\$\$;/i)?.[0] ?? "";

test("the S3E-A1 migration adds ai_execution_trace as a nullable jsonb column with no default", () => {
  assert.match(sqlStatementsOnly, /alter table creative_job_attempts\s*\n\s*add column if not exists ai_execution_trace jsonb;/i);
  // No NOT NULL and no default anywhere on this column: an attempt that ran no AI has no trace, and
  // a default would fabricate one for every historical row.
  assert.doesNotMatch(sqlStatementsOnly, /ai_execution_trace jsonb\s+not null/i);
  assert.doesNotMatch(sqlStatementsOnly, /add column if not exists ai_execution_trace jsonb\s+default/i);
});

test("the S3E-A1 migration is additive only -- no drop, no table, no historical rewrite", () => {
  assert.doesNotMatch(sqlStatementsOnly, /drop\s+column/i);
  assert.doesNotMatch(sqlStatementsOnly, /drop\s+table/i);
  assert.doesNotMatch(sqlStatementsOnly, /drop\s+function/i);
  assert.doesNotMatch(sqlStatementsOnly, /create\s+table/i);
  // No backfill of any kind. A historical attempt keeps NULL; nothing rewrites it into '[]'.
  assert.doesNotMatch(sqlStatementsOnly, /update creative_job_attempts\s+set\s+ai_execution_trace\s*=\s*'\[\]'/i);
  assert.doesNotMatch(sqlStatementsOnly, /delete from/i);
  assert.doesNotMatch(sqlStatementsOnly, /truncate/i);
  // The only UPDATE in this file is the one inside the new function, which writes a single attempt
  // row by its id.
  assert.equal((sqlStatementsOnly.match(/update creative_job_attempts/gi) ?? []).length, 1);
  assert.match(traceFunction, /where id = p_attempt_id/i);
});

test("the S3E-A1 migration adds a trace-aware finish RPC beside the original, never replacing it", () => {
  assert.match(sqlStatementsOnly, /create or replace function finish_creative_job_attempt_with_trace\(/i);
  // The original must be neither dropped nor redefined here. It still lives, untouched, in its own
  // file -- the one place it is defined.
  assert.doesNotMatch(sqlStatementsOnly, /drop function if exists finish_creative_job_attempt\(/i);
  assert.doesNotMatch(sqlStatementsOnly, /create or replace function finish_creative_job_attempt\(/i);
  assert.match(finishFunctionsSql, /create or replace function finish_creative_job_attempt\(p_attempt_id uuid, p_outcome text, p_error_code text, p_error_message text\)/i);
  // ...and the migration verifies at install time that it is still there.
  assert.match(sqlStatementsOnly, /to_regprocedure\('public\.finish_creative_job_attempt\(uuid, text, text, text\)'\) is null/i);
});

test("the trace-aware RPC keeps the original's completion semantics and database clock source", () => {
  // Same outcomes, same running-only precondition, same WHERE-clause guard style -- an invalid
  // outcome matches zero rows exactly as it does in the original.
  assert.match(traceFunction, /p_outcome in \('completed', 'failed', 'timed_out'\)/i);
  assert.match(traceFunction, /and status = 'running'/i);
  // No application-supplied timestamp: no timestamptz parameter exists to pass one through.
  assert.doesNotMatch(traceFunction, /p_\w+\s+timestamptz/i);
  assert.match(traceFunction, /completed_at = now\(\)/i);
  assert.match(traceFunction, /latency_ms = \(extract\(epoch from \(now\(\) - started_at\)\) \* 1000\)::integer/i);
  assert.doesNotMatch(traceFunction, /security definer/i);
});

test("the trace-aware RPC persists the trace on failure and timeout, not only on success", () => {
  // error_code/error_message are still nulled on success, exactly like the original -- but the
  // trace assignment is unconditional, so a failed or timed-out AI attempt keeps its history.
  assert.match(traceFunction, /error_code = case when p_outcome = 'completed' then null else p_error_code end/i);
  assert.match(traceFunction, /ai_execution_trace = p_ai_execution_trace/i);
  assert.doesNotMatch(traceFunction, /ai_execution_trace = case when p_outcome = 'completed'/i);
});

test("the trace-aware RPC names every returned column instead of coupling to physical order", () => {
  // The H1 lesson: a hand-written RETURNS TABLE paired with star expansion is what broke every
  // claim when S1 appended a column. This slice appends a column to the same table, so the new
  // function must not repeat that mistake.
  assert.doesNotMatch(traceFunction, /returning\s+\*/i);
  assert.doesNotMatch(traceFunction, /returning\s+creative_job_attempts\.\*/i);
  for (const column of [
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
    "ai_execution_trace",
    "created_at",
  ]) {
    assert.match(traceFunction, new RegExp(`\\b${column}\\b`, "i"), `missing named column: ${column}`);
  }
});

test("the S3E-A1 migration follows the existing authenticated-only grant convention", () => {
  assert.match(sql, /grant execute on function finish_creative_job_attempt_with_trace\(uuid, text, text, text, jsonb\) to authenticated;/);
  assert.doesNotMatch(sql, /grant[^;]*finish_creative_job_attempt_with_trace[^;]*to (anon|public)/i);
});

test("the S3E-A1 migration refuses to run against an unexpected schema and verifies its own result", () => {
  assert.match(sqlStatementsOnly, /to_regclass\('public\.creative_job_attempts'\) is null/i);
  assert.match(sqlStatementsOnly, /to_regclass\('public\.creative_jobs'\) is null/i);
  // A pre-existing column of the wrong type or with NOT NULL is a stale draft the operator must
  // reconcile -- this migration never silently alters it.
  assert.match(sqlStatementsOnly, /expected jsonb; reconcile the stale draft column/i);
  assert.match(sqlStatementsOnly, /already exists as NOT NULL/i);
  // And it proves the shape it promised, rather than assuming the ALTER worked.
  assert.match(sqlStatementsOnly, /was not created; investigate before relying on AI execution traces/i);
  assert.equal((sqlStatementsOnly.match(/raise exception/gi) ?? []).length >= 6, true);
});

test("the S3E-A1 migration builds no AI telemetry system and stores no secret or raw payload", () => {
  // One bounded jsonb column on the attempt -- not one row per invocation, not a provider-health
  // table, not a generalized telemetry schema.
  for (const excludedTable of ["ai_invocations", "ai_executions", "provider_health", "ai_telemetry", "execution_history", "ai_events"]) {
    assert.doesNotMatch(sqlStatementsOnly, new RegExp(`create table[^;]*\\b${excludedTable}\\b`, "i"));
  }
  // Nothing that could carry stdout, prompts, credentials or transport payloads.
  for (const excludedColumn of ["stdout", "stderr", "raw_prompt", "raw_response", "api_key", "access_token", "bearer_token", "credentials", "stack_trace", "environment"]) {
    assert.doesNotMatch(sqlStatementsOnly, new RegExp(`\\b${excludedColumn}\\b`, "i"));
  }
  // No second trace-size system: S3C-D already bounds invocation count in the application.
  assert.doesNotMatch(sqlStatementsOnly, /max_trace|trace_limit|trace_size|max_invocations/i);
  // No retry, routing, scheduling or provider selection sneaking in with the persistence.
  assert.doesNotMatch(sqlStatementsOnly, /retry_count|retry_after|max_retries|heartbeat|repair_stale|stale_running/i);
});

test("bootstrap and migration agree on the column, so both install paths converge", () => {
  // Fresh installs get the column from the bootstrap's create-table AND its idempotent add; already-
  // live databases get it from the migration. Both must declare exactly the same nullable jsonb.
  assert.match(attemptsSql, /\n\s*ai_execution_trace jsonb,/);
  assert.match(attemptsSql, /alter table creative_job_attempts\s*\n\s*add column if not exists ai_execution_trace jsonb;/i);
  assert.match(sqlStatementsOnly, /alter table creative_job_attempts\s*\n\s*add column if not exists ai_execution_trace jsonb;/i);
  // The trace-aware RPC has exactly one definition, in this migration -- not duplicated into the
  // bootstrap where the two copies could drift.
  assert.doesNotMatch(attemptsSql, /finish_creative_job_attempt_with_trace/i);
});

test("the S3E-A1 migration invokes no AI and wires up no provider", () => {
  for (const forbidden of [/claude/i, /codex/i, /openai/i, /anthropic/i, /gemini/i, /opus/i, /gpt-/i, /http/i]) {
    assert.doesNotMatch(sqlStatementsOnly, forbidden);
  }
});
