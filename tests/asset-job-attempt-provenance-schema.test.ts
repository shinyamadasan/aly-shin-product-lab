import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const sql = readFileSync(new URL("../supabase-add-asset-job-attempt-provenance.sql", import.meta.url), "utf8");
const sqlStatementsOnly = sql
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n");

const attemptsSql = readFileSync(new URL("../supabase-add-asset-job-attempts.sql", import.meta.url), "utf8");
const finishFunctionsSql = readFileSync(new URL("../supabase-add-asset-job-finish-functions.sql", import.meta.url), "utf8");

const provenanceFunction =
  sqlStatementsOnly.match(/create or replace function finish_asset_job_attempt_with_provenance\([\s\S]*?\$\$;/i)?.[0] ?? "";

test("the provenance migration adds NO column -- provider/model already exist on asset_job_attempts", () => {
  // The columns this migration writes were created by the attempts migration, and this file must not
  // duplicate, re-add or alter them.
  assert.match(attemptsSql, /^\s*provider text,$/m);
  assert.match(attemptsSql, /^\s*model text,$/m);

  assert.doesNotMatch(sqlStatementsOnly, /alter table/i);
  assert.doesNotMatch(sqlStatementsOnly, /add column/i);
  assert.doesNotMatch(sqlStatementsOnly, /create table/i);
  assert.doesNotMatch(sqlStatementsOnly, /drop\s+column/i);
});

test("the provenance migration is non-destructive: no drop, no truncate, no backfill", () => {
  assert.doesNotMatch(sqlStatementsOnly, /drop\s+function/i);
  assert.doesNotMatch(sqlStatementsOnly, /drop\s+table/i);
  assert.doesNotMatch(sqlStatementsOnly, /truncate/i);
  assert.doesNotMatch(sqlStatementsOnly, /delete\s+from/i);
  // A backfill would invent provenance for attempts that never recorded any.
  assert.doesNotMatch(sqlStatementsOnly, /update asset_job_attempts\s+set\s+provider\s*=\s*'/i);
});

test("the original finish_asset_job_attempt is left completely untouched", () => {
  // Not redefined here...
  assert.doesNotMatch(sqlStatementsOnly, /create or replace function finish_asset_job_attempt\s*\(/i);
  // ...and still defined, with its original 4-argument signature, where it always was.
  assert.match(
    finishFunctionsSql,
    /create or replace function finish_asset_job_attempt\(p_attempt_id uuid, p_outcome text, p_error_code text, p_error_message text\)/i,
  );
  assert.match(finishFunctionsSql, /grant execute on function finish_asset_job_attempt\(uuid, text, text, text\) to authenticated;/);
  // And this migration asserts that as a postcondition rather than merely hoping.
  assert.match(sqlStatementsOnly, /Postcondition failed: this migration must leave finish_asset_job_attempt/i);
});

test("finish_asset_job_attempt_with_provenance takes nullable provider/model with SQL defaults", () => {
  assert.notEqual(provenanceFunction, "");
  assert.match(provenanceFunction, /p_provider text default null/i);
  assert.match(provenanceFunction, /p_model text default null/i);
});

test("the provenance function accepts no application-supplied timestamp and uses the database clock", () => {
  assert.doesNotMatch(provenanceFunction.split("returns table")[0], /timestamptz/i);
  assert.match(provenanceFunction, /completed_at = now\(\)/i);
  assert.match(provenanceFunction, /latency_ms = \(extract\(epoch from \(now\(\) - started_at\)\) \* 1000\)::integer/i);
});

test("the provenance function keeps the original outcome and running-status guards", () => {
  assert.match(
    provenanceFunction,
    /where id = p_attempt_id\s*\n\s*and status = 'running'\s*\n\s*and p_outcome in \('completed', 'failed', 'timed_out'\)/i,
  );
  assert.doesNotMatch(sqlStatementsOnly, /create trigger/i);
});

test("provider/model are written on EVERY supported outcome, and coalesce so a null can never erase", () => {
  // No `case when p_outcome = 'completed'` wrapper on these two -- a failed or timed-out provider
  // attempt records its provenance exactly like a successful one.
  assert.match(provenanceFunction, /provider = coalesce\(p_provider, provider\)/i);
  assert.match(provenanceFunction, /model = coalesce\(p_model, model\)/i);
  assert.doesNotMatch(provenanceFunction, /provider = case when p_outcome/i);
  assert.doesNotMatch(provenanceFunction, /model = case when p_outcome/i);
});

test("the provenance function returns an explicit, non-wildcard column list including provider and model", () => {
  assert.doesNotMatch(provenanceFunction, /returning\s+\*/i);
  assert.match(
    provenanceFunction,
    /returning id, asset_job_id, attempt_number, worker_type, status, started_at,\s*\n\s*completed_at, latency_ms, error_code, error_message, provider, model, created_at;/i,
  );
});

test("the provenance function is plain SQL, not SECURITY DEFINER, and follows the authenticated-only grant convention", () => {
  assert.doesNotMatch(provenanceFunction, /security definer/i);
  assert.match(provenanceFunction, /language sql/i);
  assert.match(
    sql,
    /grant execute on function finish_asset_job_attempt_with_provenance\(uuid, text, text, text, text, text\) to authenticated;/,
  );
  assert.doesNotMatch(sql, /grant[^;]*finish_asset_job_attempt_with_provenance[^;]*to (anon|public)/i);
});

test("the single-writer contract is preserved: no new table grant, no policy, no direct-update path", () => {
  assert.doesNotMatch(sqlStatementsOnly, /grant[^;]*on table asset_job_attempts/i);
  assert.doesNotMatch(sqlStatementsOnly, /create policy/i);
  assert.doesNotMatch(sqlStatementsOnly, /alter table asset_job_attempts/i);
});

test("the migration refuses to run against a database that is not the shape it expects", () => {
  assert.match(sqlStatementsOnly, /if to_regclass\('public\.asset_job_attempts'\) is null then/i);
  assert.match(sqlStatementsOnly, /if to_regprocedure\('public\.finish_asset_job_attempt\(uuid, text, text, text\)'\) is null then/i);
  // provider/model must be exactly nullable text before the function that writes them is created.
  assert.match(sqlStatementsOnly, /must be text, found/i);
  assert.match(sqlStatementsOnly, /must be nullable/i);
  // And it verifies what it promised afterwards.
  assert.match(sqlStatementsOnly, /Postcondition failed: finish_asset_job_attempt_with_provenance/i);
});

test("the migration stores no prompt, credential, or reference payload", () => {
  for (const forbidden of [/p_prompt/i, /prompt_sha/i, /p_reference/i, /api[_-]?token/i, /authorization/i, /bearer/i]) {
    assert.doesNotMatch(sqlStatementsOnly, forbidden);
  }
});
