import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

// H1 -- executable PostgreSQL verification of claim_creative_job_with_attempt.
//
// This is the test that would have caught S1. The existing schema tests assert on SQL TEXT, which
// is why the defect shipped: the text was never wrong, the function's declared result shape simply
// stopped matching the table after a column was added. Nothing short of executing the SQL against a
// real PostgreSQL could have detected that.
//
// Opt-in only. Not part of `npm test` (that glob is tests/*.test.ts and does not recurse), and not
// part of the other smoke globs either. Requires Docker and an explicit opt-in:
//
//   RUN_POSTGRES_SMOKE=1 npm run postgres:smoke
//
// It creates and destroys its own throwaway container and touches no real database.

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
  ? "Set RUN_POSTGRES_SMOKE=1 to run the PostgreSQL claim-RPC smoke test."
  : !dockerAvailable()
    ? "Docker is not available; cannot run the PostgreSQL claim-RPC smoke test."
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

// Returns stderr instead of throwing, so a test can assert on an EXPECTED failure.
function psqlExpectingFailure(container: string, database: string, statements: string): string {
  try {
    execFileSync("docker", ["exec", "-i", container, "psql", "-U", "postgres", "-d", database, "-tA", "-v", "ON_ERROR_STOP=1", "-f", "-"], {
      input: statements,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return "";
  } catch (err) {
    const e = err as { stderr?: string | Buffer };
    return String(e.stderr ?? "");
  }
}

const SEED = `
insert into opportunities (id, opportunity_type, producer, source_type, source_id, title, summary, reason,
  recommended_action, evidence_version, evidence, source_rule_ids, source_findings, status, detected_at, expires_at, deduplication_key)
values ('11111111-1111-4111-8111-111111111111','product_marketing_content','daily_advisor','daily_advisor','src',
  'Title','Summary','Reason','create_content','v1','{}'::jsonb,'{}'::text[],'[]'::jsonb,'accepted', now(), now() + interval '3 days','key-1');
`;

// Postgres briefly accepts connections during first-boot initialisation and then shuts down to
// finish, so pg_isready can report ready too early. Waiting on a real query is the reliable signal.
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

test("claim_creative_job_with_attempt survives the S1 column addition", { skip }, async (t) => {
  const container = "aly-shin-h1-migrated";
  await startPostgres(container, "migrated");
  t.after(() => execFileSync("docker", ["rm", "-f", container], { stdio: "ignore" }));
  const run = (statements: string) => psql(container, "migrated", statements);

  run("create role authenticated; create role anon;");

  // --- A. pre-S1 schema + the original function -------------------------------------------------
  run(sql("supabase-add-opportunities.sql"));
  run(execFileSync("git", ["show", "ab8bd55:supabase-add-creative-jobs.sql"], { cwd: PROJECT_ROOT, encoding: "utf8" }));
  run(execFileSync("git", ["show", "fc53094:supabase-add-creative-job-attempts.sql"], { cwd: PROJECT_ROOT, encoding: "utf8" }));
  run(SEED);

  // --- B. apply S1 ------------------------------------------------------------------------------
  run(sql("supabase-add-creative-job-manual-origin.sql"));
  run(`insert into creative_jobs (id, opportunity_id, intent, status, worker_type)
       values ('22222222-2222-4222-8222-222222222222', null, '{"schemaVersion":"v1","text":"promote Blondies"}'::jsonb, 'queued','mock');
       insert into creative_jobs (id, opportunity_id, status, worker_type)
       values ('33333333-3333-4333-8333-333333333333','11111111-1111-4111-8111-111111111111','queued','mock');`);

  // The defect reproduces before the repair -- both origins, identical failure.
  assert.match(
    psqlExpectingFailure(container, "migrated", "select * from claim_creative_job_with_attempt('22222222-2222-4222-8222-222222222222');"),
    /return type mismatch in function declared to return record/i,
    "request-backed claim must fail before H1",
  );
  assert.match(
    psqlExpectingFailure(container, "migrated", "select * from claim_creative_job_with_attempt('33333333-3333-4333-8333-333333333333');"),
    /return type mismatch in function declared to return record/i,
    "Opportunity-backed claim must fail before H1",
  );

  // --- C. apply H1 ------------------------------------------------------------------------------
  run(sql("supabase-repair-creative-job-claim-rpc.sql"));

  // --- D + E. request-backed job claims, carrying its intent ------------------------------------
  assert.equal(
    run(`select id || '|' || (opportunity_id is null) || '|' || (intent->>'text') || '|' || attempt_number || '|' || status
         from claim_creative_job_with_attempt('22222222-2222-4222-8222-222222222222');`),
    "22222222-2222-4222-8222-222222222222|true|promote Blondies|1|running",
  );

  // --- F. Opportunity-backed job claims ---------------------------------------------------------
  assert.equal(
    run(`select id || '|' || opportunity_id || '|' || attempt_number || '|' || status
         from claim_creative_job_with_attempt('33333333-3333-4333-8333-333333333333');`),
    "33333333-3333-4333-8333-333333333333|11111111-1111-4111-8111-111111111111|1|running",
  );

  // --- G. a second claim of an already-claimed job returns zero rows ----------------------------
  assert.equal(run("select count(*) from claim_creative_job_with_attempt('22222222-2222-4222-8222-222222222222');"), "0");

  // --- H + I. one attempt row per successful claim, numbered from 1 -----------------------------
  assert.equal(
    run("select count(*) || '|' || max(attempt_number) || '|' || max(status) from creative_job_attempts where creative_job_id = '22222222-2222-4222-8222-222222222222';"),
    "1|1|running",
  );
  // The refused second claim inserted no attempt: two successful claims, two attempts, no more.
  assert.equal(run("select count(*) from creative_job_attempts;"), "2");

  // --- J. no duplicate job behaviour introduced --------------------------------------------------
  assert.equal(run("select count(*) from creative_jobs;"), "2");
  assert.equal(run("select attempt_count from creative_jobs where id = '22222222-2222-4222-8222-222222222222';"), "1");

  // --- rerun / idempotency -----------------------------------------------------------------------
  run(sql("supabase-repair-creative-job-claim-rpc.sql"));
  run(`insert into creative_jobs (id, opportunity_id, intent, status, worker_type)
       values ('44444444-4444-4444-8444-444444444444', null, '{"schemaVersion":"v1","text":"second ask"}'::jsonb, 'queued','mock');`);
  assert.equal(
    run("select intent->>'text' from claim_creative_job_with_attempt('44444444-4444-4444-8444-444444444444');"),
    "second ask",
    "the repair must remain correct after being re-run",
  );
});

test("a FRESH install is claimable, despite declaring intent in a different physical position", { skip }, async (t) => {
  // Why H1 names columns instead of using `claimed.*`: a fresh install declares `intent` third,
  // while an S1-migrated table has it appended last. One star-expansion cannot satisfy both, so a
  // fix that merely inserted `intent` at position 13 would have repaired production and broken
  // every new install.
  const container = "aly-shin-h1-fresh";
  await startPostgres(container, "fresh");
  t.after(() => execFileSync("docker", ["rm", "-f", container], { stdio: "ignore" }));
  const run = (statements: string) => psql(container, "fresh", statements);

  run("create role authenticated; create role anon;");
  run(sql("supabase-add-opportunities.sql"));
  run(sql("supabase-add-creative-jobs.sql"));
  run(sql("supabase-add-creative-job-attempts.sql"));

  assert.equal(
    run("select ordinal_position from information_schema.columns where table_name='creative_jobs' and column_name='intent';"),
    "3",
    "a fresh install is expected to declare intent third -- the physical order this fix must tolerate",
  );

  run(`insert into creative_jobs (id, opportunity_id, intent, status, worker_type)
       values ('55555555-5555-4555-8555-555555555555', null, '{"schemaVersion":"v1","text":"fresh install ask"}'::jsonb, 'queued','mock');`);
  assert.equal(
    run("select (intent->>'text') || '|' || attempt_number from claim_creative_job_with_attempt('55555555-5555-4555-8555-555555555555');"),
    "fresh install ask|1",
  );
});
