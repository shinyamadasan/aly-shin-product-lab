import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

// S3E-A1 -- executable PostgreSQL verification of supabase-add-creative-job-ai-execution-trace.sql.
//
// The schema tests beside this one assert on SQL TEXT. That is what let H1 ship: the text was never
// wrong, the function's declared result shape simply stopped matching the table after a column was
// added. This slice adds a column to the same table, so the same class of defect is in scope again,
// and only executing the SQL against a real PostgreSQL can rule it out.
//
// Opt-in only, matching claim-rpc.smoke.test.ts. Not part of `npm test` (that glob is
// tests/*.test.ts and does not recurse). Requires Docker and an explicit opt-in:
//
//   RUN_POSTGRES_SMOKE=1 npm run postgres:smoke
//
// It creates and destroys its own throwaway containers and touches no real database.

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");

const IMAGE = "postgres:16-alpine";

function dockerAvailable(): boolean {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const optedIn = process.env.RUN_POSTGRES_SMOKE === "1";
const skip = !optedIn
  ? "Set RUN_POSTGRES_SMOKE=1 to run the PostgreSQL AI-execution-trace smoke test."
  : !dockerAvailable()
    ? "Docker is not available; cannot run the PostgreSQL AI-execution-trace smoke test."
    : false;

function sql(file: string): string {
  return readFileSync(path.join(PROJECT_ROOT, file), "utf8");
}

function psql(container: string, database: string, statements: string): string {
  return execFileSync("docker", ["exec", "-i", container, "psql", "-U", "postgres", "-d", database, "-tA", "-v", "ON_ERROR_STOP=1", "-f", "-"], {
    input: statements,
    encoding: "utf8",
  }).trim();
}

async function startPostgres(container: string, database: string): Promise<void> {
  execFileSync("docker", ["rm", "-f", container], { stdio: "ignore" });
  execFileSync("docker", ["run", "-d", "--name", container, "-e", "POSTGRES_PASSWORD=x", "-e", `POSTGRES_DB=${database}`, IMAGE], { stdio: "ignore" });
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      execFileSync("docker", ["exec", container, "psql", "-U", "postgres", "-d", database, "-tAc", "select 1"], { stdio: "ignore" });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw new Error(`PostgreSQL container ${container} did not become ready`);
}

const SEED_OPPORTUNITY = `
insert into opportunities (id, opportunity_type, producer, source_type, source_id, title, summary, reason,
  recommended_action, evidence_version, evidence, source_rule_ids, source_findings, status, detected_at, expires_at, deduplication_key)
values ('11111111-1111-4111-8111-111111111111','product_marketing_content','daily_advisor','daily_advisor','src',
  'Title','Summary','Reason','create_content','v1','{}'::jsonb,'{}'::text[],'[]'::jsonb,'accepted', now(), now() + interval '3 days','key-1');
`;

// The exact mixed-provider history S3E-A1 must be able to preserve: Claude accepted the format
// decision, Claude then hit its usage limit on the body and fell back, and Codex produced the
// accepted body. If persistence collapsed this into "provider = codex-cli", the first two
// invocations -- including the reason the fallback happened -- would be gone.
const MIXED_PROVIDER_TRACE = JSON.stringify([
  { stage: "format_decision", providerId: "claude-cli", model: "opus", invocationNumber: 1, providerInvocationNumber: 1, outcome: "success", durationMs: 1200, action: "accepted" },
  { stage: "creative_body", providerId: "claude-cli", model: "opus", invocationNumber: 2, providerInvocationNumber: 2, outcome: "failure", failureReason: "usage_limit", durationMs: 300, action: "fallback" },
  { stage: "creative_body", providerId: "codex-cli", model: "gpt-5.6-sol", invocationNumber: 3, providerInvocationNumber: 1, outcome: "success", durationMs: 2400, action: "accepted" },
]);

test("a pre-S3E-A1 database upgrades additively, keeps existing attempts valid, and persists a supplied trace", { skip }, async (t) => {
  const container = "aly-shin-s3e-a1-migrated";
  await startPostgres(container, "migrated");
  t.after(() => execFileSync("docker", ["rm", "-f", container], { stdio: "ignore" }));
  const run = (statements: string) => psql(container, "migrated", statements);

  run("create role authenticated; create role anon;");

  // --- A. the pre-S3E-A1 (S3C-D-era) schema, taken from git rather than described from memory ----
  const preSlice = "e25199b5c3f51237a1ccf02459dc2a567d34fab7";
  const fromGit = (file: string) => execFileSync("git", ["show", `${preSlice}:${file}`], { cwd: PROJECT_ROOT, encoding: "utf8" });

  run(sql("supabase-add-opportunities.sql"));
  run(fromGit("supabase-add-creative-jobs.sql"));
  run(fromGit("supabase-add-creative-job-attempts.sql"));
  run(fromGit("supabase-add-creative-job-finish-functions.sql"));
  run(SEED_OPPORTUNITY);

  // The column genuinely does not exist yet -- otherwise this test would prove nothing.
  assert.equal(
    run("select count(*) from information_schema.columns where table_name='creative_job_attempts' and column_name='ai_execution_trace';"),
    "0",
    "the pre-S3E-A1 schema must not already have ai_execution_trace",
  );

  // A pre-existing attempt, claimed and finished the old way, before the migration runs.
  run(`insert into creative_jobs (id, opportunity_id, status, worker_type)
       values ('33333333-3333-4333-8333-333333333333','11111111-1111-4111-8111-111111111111','queued','mock');`);
  const claimedHistorical = run("select attempt_id from claim_creative_job_with_attempt('33333333-3333-4333-8333-333333333333');");
  assert.match(claimedHistorical, /^[0-9a-f-]{36}$/, "the pre-migration claim must succeed");
  assert.equal(
    run(`select status from finish_creative_job_attempt('${claimedHistorical}', 'completed', null, null);`),
    "completed",
    "the pre-migration finish RPC must succeed",
  );

  // --- B. apply S3E-A1 --------------------------------------------------------------------------
  run(sql("supabase-add-creative-job-ai-execution-trace.sql"));

  // --- C. the new column is nullable, and the historical row survived untouched -----------------
  assert.equal(
    run("select data_type || '|' || is_nullable from information_schema.columns where table_name='creative_job_attempts' and column_name='ai_execution_trace';"),
    "jsonb|YES",
    "ai_execution_trace must be nullable jsonb",
  );
  assert.equal(
    run(`select status || '|' || (ai_execution_trace is null) from creative_job_attempts where id = '${claimedHistorical}';`),
    "completed|true",
    "the historical attempt must remain valid and be left NULL, not backfilled with a fabricated empty trace",
  );
  assert.equal(run("select count(*) from creative_job_attempts;"), "1", "the migration must create and destroy no attempt rows");

  // --- D. the ORIGINAL finish RPC is still present and still callable, unchanged -----------------
  assert.equal(
    run("select count(*) from pg_proc where proname = 'finish_creative_job_attempt';"),
    "1",
    "finish_creative_job_attempt must not be dropped or renamed",
  );
  run(`insert into creative_jobs (id, opportunity_id, intent, status, worker_type)
       values ('44444444-4444-4444-8444-444444444444', null, '{"schemaVersion":"v1","text":"no ai here"}'::jsonb, 'queued','mock');`);
  const legacyAttempt = run("select attempt_id from claim_creative_job_with_attempt('44444444-4444-4444-8444-444444444444');");
  assert.equal(
    run(`select status from finish_creative_job_attempt('${legacyAttempt}', 'completed', null, null);`),
    "completed",
    "a non-AI attempt finished by the original RPC must still work",
  );
  // Asserted against the table, not the RPC's result: the original function's RETURNS TABLE is
  // deliberately NOT widened to include the new column, so it cannot report on it. That the column
  // is absent from its result is itself the proof this migration left the function alone.
  assert.equal(
    run(`select ai_execution_trace is null from creative_job_attempts where id = '${legacyAttempt}';`),
    "t",
    "the original RPC must leave the trace NULL rather than writing an empty one",
  );

  // --- E. the trace-aware RPC persists the supplied JSON trace, uncollapsed ----------------------
  run(`insert into creative_jobs (id, opportunity_id, intent, status, worker_type)
       values ('55555555-5555-4555-8555-555555555555', null, '{"schemaVersion":"v1","text":"ai run"}'::jsonb, 'queued','mock');`);
  const aiAttempt = run("select attempt_id from claim_creative_job_with_attempt('55555555-5555-4555-8555-555555555555');");
  assert.equal(
    run(`select status from finish_creative_job_attempt_with_trace('${aiAttempt}', 'completed', null, null, '${MIXED_PROVIDER_TRACE}'::jsonb);`),
    "completed",
    "the trace-aware RPC must complete the attempt",
  );

  // The full mixed-provider history survived -- three invocations, both providers, the usage_limit
  // fallback reason intact. This is the assertion that fails if persistence ever collapses a
  // multi-provider run into a single provider/model pair.
  assert.equal(run(`select jsonb_array_length(ai_execution_trace) from creative_job_attempts where id = '${aiAttempt}';`), "3");
  assert.equal(
    run(`select string_agg(entry->>'providerId' || ':' || (entry->>'model') || ':' || (entry->>'action'), ',' order by (entry->>'invocationNumber')::int)
         from creative_job_attempts, jsonb_array_elements(ai_execution_trace) as entry
         where id = '${aiAttempt}';`),
    "claude-cli:opus:accepted,claude-cli:opus:fallback,codex-cli:gpt-5.6-sol:accepted",
  );
  assert.equal(
    run(`select entry->>'failureReason' from creative_job_attempts, jsonb_array_elements(ai_execution_trace) as entry
         where id = '${aiAttempt}' and entry->>'outcome' = 'failure';`),
    "usage_limit",
  );
  // provider/model remain compatibility summary metadata only -- the trace is the authority, and
  // nothing in this migration writes provider/model behind the caller's back.
  assert.equal(
    run(`select coalesce(provider, 'null') || '|' || coalesce(model, 'null') from creative_job_attempts where id = '${aiAttempt}';`),
    "null|null",
  );

  // --- F. the trace-aware RPC persists a trace on FAILURE and TIMEOUT too ------------------------
  for (const [jobId, outcome, errorCode] of [
    ["66666666-6666-4666-8666-666666666666", "failed", "failed"],
    ["77777777-7777-4777-8777-777777777777", "timed_out", "timeout"],
  ] as const) {
    run(`insert into creative_jobs (id, opportunity_id, intent, status, worker_type)
         values ('${jobId}', null, '{"schemaVersion":"v1","text":"ai run"}'::jsonb, 'queued','mock');`);
    const attempt = run(`select attempt_id from claim_creative_job_with_attempt('${jobId}');`);
    assert.equal(
      run(`select status || '|' || error_code || '|' || jsonb_array_length(ai_execution_trace)
           from finish_creative_job_attempt_with_trace('${attempt}', '${outcome}', '${errorCode}', 'bounded message', '${MIXED_PROVIDER_TRACE}'::jsonb);`),
      `${outcome}|${errorCode}|3`,
      `a ${outcome} AI attempt must keep its execution trace`,
    );
  }

  // --- G. no physical-column-order regression ----------------------------------------------------
  // ai_execution_trace is appended (position 14) on a migrated table but declared before created_at
  // (position 13) on a fresh install -- exactly the divergence that broke claim_creative_job_with_
  // attempt in S1. Both claim and both finish RPCs must be indifferent to it.
  assert.equal(
    run("select ordinal_position from information_schema.columns where table_name='creative_job_attempts' and column_name='ai_execution_trace';"),
    "14",
    "a migrated table is expected to append the column last -- the physical order this slice must tolerate",
  );
  run(`insert into creative_jobs (id, opportunity_id, intent, status, worker_type)
       values ('88888888-8888-4888-8888-888888888888', null, '{"schemaVersion":"v1","text":"order check"}'::jsonb, 'queued','mock');`);
  assert.equal(
    run("select (intent->>'text') || '|' || attempt_number from claim_creative_job_with_attempt('88888888-8888-4888-8888-888888888888');"),
    "order check|1",
    "claim_creative_job_with_attempt must still return its declared shape after the column addition",
  );

  // --- rerun / idempotency ----------------------------------------------------------------------
  run(sql("supabase-add-creative-job-ai-execution-trace.sql"));
  // 6 attempts by now: the pre-migration historical one, the non-AI legacy one, the successful AI
  // one, the failed and timed-out AI ones, and the column-order claim.
  assert.equal(run("select count(*) from creative_job_attempts;"), "6", "re-running the migration must not touch rows");
  assert.equal(
    run(`select jsonb_array_length(ai_execution_trace) from creative_job_attempts where id = '${aiAttempt}';`),
    "3",
    "re-running the migration must not rewrite an already-persisted trace",
  );
});

test("a FRESH bootstrap install is logically compatible with the migrated schema", { skip }, async (t) => {
  const container = "aly-shin-s3e-a1-fresh";
  await startPostgres(container, "fresh");
  t.after(() => execFileSync("docker", ["rm", "-f", container], { stdio: "ignore" }));
  const run = (statements: string) => psql(container, "fresh", statements);

  run("create role authenticated; create role anon;");
  run(sql("supabase-add-opportunities.sql"));
  run(sql("supabase-add-creative-jobs.sql"));
  run(sql("supabase-add-creative-job-attempts.sql"));
  run(sql("supabase-add-creative-job-finish-functions.sql"));
  run(sql("supabase-add-creative-job-ai-execution-trace.sql"));

  // The bootstrap declares the column itself, so a fresh install has it in a DIFFERENT physical
  // position than a migrated one -- and the migration above is a harmless no-op here.
  assert.equal(
    run("select data_type || '|' || is_nullable || '|' || ordinal_position from information_schema.columns where table_name='creative_job_attempts' and column_name='ai_execution_trace';"),
    "jsonb|YES|13",
    "a fresh install is expected to declare the column before created_at -- the other half of the order divergence",
  );

  // Same logical behaviour as the migrated database, despite that different physical order.
  run(`insert into creative_jobs (id, opportunity_id, intent, status, worker_type)
       values ('99999999-9999-4999-8999-999999999999', null, '{"schemaVersion":"v1","text":"fresh ai run"}'::jsonb, 'queued','mock');`);
  const attempt = run("select attempt_id from claim_creative_job_with_attempt('99999999-9999-4999-8999-999999999999');");
  assert.equal(
    run(`select status || '|' || jsonb_array_length(ai_execution_trace)
         from finish_creative_job_attempt_with_trace('${attempt}', 'completed', null, null, '${MIXED_PROVIDER_TRACE}'::jsonb);`),
    "completed|3",
  );

  // And the original finish RPC still leaves the column NULL on a fresh install too.
  run(`insert into creative_jobs (id, opportunity_id, intent, status, worker_type)
       values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', null, '{"schemaVersion":"v1","text":"fresh non-ai"}'::jsonb, 'queued','mock');`);
  const plainAttempt = run("select attempt_id from claim_creative_job_with_attempt('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');");
  assert.equal(run(`select status from finish_creative_job_attempt('${plainAttempt}', 'completed', null, null);`), "completed");
  assert.equal(run(`select ai_execution_trace is null from creative_job_attempts where id = '${plainAttempt}';`), "t");
});
