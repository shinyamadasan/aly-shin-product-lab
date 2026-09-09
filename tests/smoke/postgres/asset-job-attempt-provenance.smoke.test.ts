import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

// Wave B provenance closure -- executable PostgreSQL verification of
// supabase-add-asset-job-attempt-provenance.sql.
//
// The schema test beside this one (tests/asset-job-attempt-provenance-schema.test.ts) asserts on SQL
// TEXT. Text assertions cannot see the failure mode this migration is most exposed to: PostgreSQL
// resolves functions by name AND argument list, so "add two defaulted parameters to the existing
// function" silently produces a SECOND function rather than replacing the first, and every existing
// 4-argument call then dies with "function ... is not unique". That is invisible to any regex and is
// exactly why this file exists. Case E below proves it against a real server, in both directions.
//
// Opt-in only, matching claim-rpc.smoke.test.ts and ai-execution-trace.smoke.test.ts. Not part of
// `npm test` (that glob is tests/*.test.ts and does not recurse). Requires Docker and an explicit
// opt-in:
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
  ? "Set RUN_POSTGRES_SMOKE=1 to run the PostgreSQL attempt-provenance smoke test."
  : !dockerAvailable()
    ? "Docker is not available; cannot run the PostgreSQL attempt-provenance smoke test."
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

// Runs statements that are EXPECTED to fail, and returns the server's error text.
function psqlExpectingFailure(container: string, database: string, statements: string): string {
  try {
    execFileSync("docker", ["exec", "-i", container, "psql", "-U", "postgres", "-d", database, "-tA", "-v", "ON_ERROR_STOP=1", "-f", "-"], {
      input: statements,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    const failure = err as { stderr?: string; stdout?: string };
    return `${failure.stderr ?? ""}${failure.stdout ?? ""}`;
  }
  throw new Error("expected these statements to fail, but they succeeded");
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

// The Asset Job chain: opportunities -> creative_jobs -> creative_packages -> asset_jobs ->
// asset_job_attempts -> the two finish functions. None of these files reference auth.* or storage.*,
// so vanilla PostgreSQL is enough.
const BOOTSTRAP_FILES = [
  "supabase-add-opportunities.sql",
  "supabase-add-creative-jobs.sql",
  "supabase-add-creative-packages.sql",
  "supabase-add-asset-jobs.sql",
  "supabase-add-asset-job-attempts.sql",
  "supabase-add-asset-job-finish-functions.sql",
];

// creative_jobs carries an origin CHECK (either an opportunity_id or a non-empty intent, never
// both), so the seed supplies an intent.
const SEED = `
insert into creative_jobs (id, intent)
  values ('11111111-1111-4111-8111-111111111111', '{"schemaVersion":"v1","text":"provenance smoke"}'::jsonb);
insert into creative_packages (id, creative_job_id)
  values ('22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111');
`;

let assetJobCounter = 0;

// Each attempt needs its own Asset Job: claim_asset_job_with_attempt only claims a queued job, and an
// attempt row exists only for a claim.
function newAssetJob(run: (statements: string) => string, workerType: string): string {
  assetJobCounter += 1;
  const id = `33333333-3333-4333-8333-${String(assetJobCounter).padStart(12, "0")}`;
  run(`insert into asset_jobs (id, creative_package_id, worker_type)
       values ('${id}', '22222222-2222-4222-8222-222222222222', '${workerType}');`);
  return run(`select attempt_id from claim_asset_job_with_attempt('${id}');`);
}

test("the provenance migration applies to a real Asset Job schema and makes provider/model durable", { skip }, async (t) => {
  const container = "aly-shin-attempt-provenance";
  await startPostgres(container, "provenance");
  t.after(() => execFileSync("docker", ["rm", "-f", container], { stdio: "ignore" }));
  const run = (statements: string) => psql(container, "provenance", statements);

  run("create role authenticated; create role anon;");

  // --- A. the baseline schema installs ----------------------------------------------------------
  for (const file of BOOTSTRAP_FILES) {
    run(sql(file));
  }
  run(SEED);

  assert.equal(
    run("select data_type || '|' || is_nullable from information_schema.columns where table_name='asset_job_attempts' and column_name='provider';"),
    "text|YES",
    "provider must already exist as nullable text BEFORE the migration -- this slice adds no column",
  );
  assert.equal(
    run("select data_type || '|' || is_nullable from information_schema.columns where table_name='asset_job_attempts' and column_name='model';"),
    "text|YES",
  );
  // The writer genuinely does not exist yet -- otherwise this test would prove nothing.
  assert.equal(
    run("select count(*) from pg_proc where proname = 'finish_asset_job_attempt_with_provenance';"),
    "0",
    "the pre-migration schema must not already have the provenance RPC",
  );

  // A pre-existing attempt, finished the old way, before the migration runs.
  const historical = newAssetJob(run, "external");
  assert.equal(run(`select status from finish_asset_job_attempt('${historical}', 'completed', null, null);`), "completed");

  const columnsBefore = run("select count(*) from information_schema.columns where table_name='asset_job_attempts';");

  // --- B. the migration applies ------------------------------------------------------------------
  run(sql("supabase-add-asset-job-attempt-provenance.sql"));

  assert.equal(
    run("select count(*) from information_schema.columns where table_name='asset_job_attempts';"),
    columnsBefore,
    "the migration must add no column",
  );
  assert.equal(run("select count(*) from asset_job_attempts;"), "1", "the migration must create and destroy no attempt rows");
  assert.equal(
    run(`select status || '|' || (provider is null) || '|' || (model is null) from asset_job_attempts where id = '${historical}';`),
    "completed|true|true",
    "the historical attempt must survive untouched and must NOT be backfilled with fabricated provenance",
  );

  // --- C + D. both functions exist, each exactly once --------------------------------------------
  assert.equal(
    run("select count(*) from pg_proc where proname = 'finish_asset_job_attempt';"),
    "1",
    "the original finish RPC must not be dropped, renamed, or overloaded",
  );
  assert.equal(run("select count(*) from pg_proc where proname = 'finish_asset_job_attempt_with_provenance';"), "1");

  // --- E. no overload ambiguity ------------------------------------------------------------------
  //
  // Two DISTINCTLY NAMED functions, so a 4-argument call can only ever resolve to one candidate.
  assert.equal(
    run(`select p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname like 'finish_asset_job_attempt%'
         order by 1;`),
    [
      "finish_asset_job_attempt(p_attempt_id uuid, p_outcome text, p_error_code text, p_error_message text)",
      "finish_asset_job_attempt_with_provenance(p_attempt_id uuid, p_outcome text, p_error_code text, p_error_message text, p_provider text, p_model text)",
    ].join("\n"),
  );

  // --- F. the ORIGINAL RPC still works, and still leaves provider/model NULL ----------------------
  const legacy = newAssetJob(run, "external");
  assert.equal(
    run(`select status || '|' || coalesce(provider, 'null') || '|' || coalesce(model, 'null')
         from finish_asset_job_attempt('${legacy}', 'completed', null, null);`),
    "completed|null|null",
    "an attempt finished by the original RPC must complete and claim no provider",
  );

  // --- G. the provenance RPC persists provider and model -----------------------------------------
  const generative = newAssetJob(run, "generative_image");
  assert.equal(
    run(`select status || '|' || provider || '|' || model
         from finish_asset_job_attempt_with_provenance('${generative}', 'completed', null, null,
           'cloudflare-workers-ai', '@cf/black-forest-labs/flux-2-klein-9b');`),
    "completed|cloudflare-workers-ai|@cf/black-forest-labs/flux-2-klein-9b",
  );
  // Asserted against the TABLE too, not only the function's returned row.
  assert.equal(
    run(`select provider || '|' || model from asset_job_attempts where id = '${generative}';`),
    "cloudflare-workers-ai|@cf/black-forest-labs/flux-2-klein-9b",
  );

  // A model OVERRIDE persists the override actually used.
  const overridden = newAssetJob(run, "generative_image");
  run(`select 1 from finish_asset_job_attempt_with_provenance('${overridden}', 'completed', null, null, 'cloudflare-workers-ai', '@cf/some/other-model');`);
  assert.equal(run(`select model from asset_job_attempts where id = '${overridden}';`), "@cf/some/other-model");

  // --- H. nullable / default semantics -----------------------------------------------------------
  //
  // Called with only four arguments, the SQL defaults apply and nothing is claimed.
  const defaulted = newAssetJob(run, "static_renderer");
  assert.equal(
    run(`select status || '|' || coalesce(provider, 'null') || '|' || coalesce(model, 'null')
         from finish_asset_job_attempt_with_provenance('${defaulted}', 'completed', null, null);`),
    "completed|null|null",
    "p_provider/p_model default to null, so a deterministic renderer records no provider",
  );

  // Explicit nulls behave the same way.
  const explicitNulls = newAssetJob(run, "static_renderer");
  assert.equal(
    run(`select coalesce(provider, 'null') from finish_asset_job_attempt_with_provenance('${explicitNulls}', 'completed', null, null, null, null);`),
    "null",
  );

  // coalesce: a null argument can never ERASE a value already on the row.
  const preRecorded = newAssetJob(run, "generative_image");
  run(`update asset_job_attempts set provider = 'cloudflare-workers-ai', model = '@cf/pre-recorded' where id = '${preRecorded}';`);
  assert.equal(
    run(`select provider || '|' || model from finish_asset_job_attempt_with_provenance('${preRecorded}', 'completed', null, null, null, null);`),
    "cloudflare-workers-ai|@cf/pre-recorded",
    "a null argument must not wipe provenance that was already recorded",
  );

  // --- I. outcome / error / timestamp behaviour is unchanged -------------------------------------
  //
  // Provenance is written on FAILURE and TIMEOUT too -- that is when "which model did we call"
  // matters most -- and the error fields keep their original semantics.
  for (const [outcome, errorCode] of [
    ["failed", "failed"],
    ["timed_out", "timeout"],
  ] as const) {
    const attempt = newAssetJob(run, "generative_image");
    assert.equal(
      run(`select status || '|' || error_code || '|' || error_message || '|' || provider || '|' || model
           from finish_asset_job_attempt_with_provenance('${attempt}', '${outcome}', '${errorCode}', 'bounded message',
             'cloudflare-workers-ai', '@cf/some/other-model');`),
      `${outcome}|${errorCode}|bounded message|cloudflare-workers-ai|@cf/some/other-model`,
      `a ${outcome} provider attempt must keep both its error detail and its provenance`,
    );
  }

  // On success the error fields are nulled, exactly as the original RPC does.
  const succeeded = newAssetJob(run, "generative_image");
  assert.equal(
    run(`select (error_code is null) || '|' || (error_message is null)
         from finish_asset_job_attempt_with_provenance('${succeeded}', 'completed', 'ignored', 'ignored', 'cloudflare-workers-ai', '@cf/m');`),
    "true|true",
    "a completed attempt must null its error fields even if the caller passed some",
  );

  // Database-sourced timestamps: completed_at at or after started_at, latency non-negative.
  assert.equal(
    run(`select bool_and(completed_at >= started_at) || '|' || bool_and(latency_ms >= 0)
         from asset_job_attempts where status <> 'running';`),
    "true|true",
  );

  // The guards are unchanged: an invalid outcome and an already-terminal attempt both match zero rows.
  const guarded = newAssetJob(run, "generative_image");
  assert.equal(
    run(`select count(*) from finish_asset_job_attempt_with_provenance('${guarded}', 'cancelled', null, null, 'cloudflare-workers-ai', '@cf/m');`),
    "0",
    "an unsupported outcome must match zero rows rather than writing",
  );
  assert.equal(
    run(`select status || '|' || coalesce(provider, 'null') from asset_job_attempts where id = '${guarded}';`),
    "running|null",
    "a rejected call must write nothing at all -- not even the provenance",
  );
  run(`select 1 from finish_asset_job_attempt_with_provenance('${guarded}', 'completed', null, null, 'cloudflare-workers-ai', '@cf/m');`);
  assert.equal(
    run(`select count(*) from finish_asset_job_attempt_with_provenance('${guarded}', 'failed', 'failed', 'too late', 'other-provider', '@cf/other');`),
    "0",
    "an already-terminal attempt must not be re-finished",
  );
  assert.equal(
    run(`select status || '|' || provider from asset_job_attempts where id = '${guarded}';`),
    "completed|cloudflare-workers-ai",
    "and its recorded provenance must not be overwritten by the rejected call",
  );

  // --- J. idempotent re-application ---------------------------------------------------------------
  const attemptsBefore = run("select count(*) from asset_job_attempts;");
  run(sql("supabase-add-asset-job-attempt-provenance.sql"));
  assert.equal(run("select count(*) from asset_job_attempts;"), attemptsBefore, "re-running the migration must not touch rows");
  assert.equal(
    run(`select provider || '|' || model from asset_job_attempts where id = '${generative}';`),
    "cloudflare-workers-ai|@cf/black-forest-labs/flux-2-klein-9b",
    "re-running the migration must not rewrite already-persisted provenance",
  );
  assert.equal(run("select count(*) from pg_proc where proname like 'finish_asset_job_attempt%';"), "2", "re-running must not create a third function");

  // --- E, the counterfactual ----------------------------------------------------------------------
  //
  // This is why the migration adds a distinctly-named sibling instead of widening the existing
  // signature. Adding the defaulted parameters to the EXISTING name creates a second function rather
  // than replacing the first, and every 4-argument call -- every external, mock and static_renderer
  // attempt in the system -- immediately stops resolving. Proven here, then removed.
  run(`create or replace function finish_asset_job_attempt(p_attempt_id uuid, p_outcome text, p_error_code text, p_error_message text,
         p_provider text default null, p_model text default null)
       returns table (id uuid) language sql as $$ select null::uuid where false; $$;`);
  assert.equal(run("select count(*) from pg_proc where proname = 'finish_asset_job_attempt';"), "2", "widening the signature ADDS a function, it does not replace one");

  const ambiguity = psqlExpectingFailure(
    container,
    "provenance",
    `select status from finish_asset_job_attempt('${legacy}'::uuid, 'completed'::text, null::text, null::text);`,
  );
  assert.match(ambiguity, /is not unique/i, "a 4-argument call against a widened signature must fail as ambiguous");

  run("drop function finish_asset_job_attempt(uuid, text, text, text, text, text);");
  assert.equal(run("select count(*) from pg_proc where proname = 'finish_asset_job_attempt';"), "1");
  // With the counterfactual removed, the original call resolves again.
  const afterCleanup = newAssetJob(run, "external");
  assert.equal(run(`select status from finish_asset_job_attempt('${afterCleanup}', 'completed', null, null);`), "completed");
});

test("the migration refuses to run against a database that does not already have what it needs", { skip }, async (t) => {
  const container = "aly-shin-attempt-provenance-preflight";
  await startPostgres(container, "preflight");
  t.after(() => execFileSync("docker", ["rm", "-f", container], { stdio: "ignore" }));
  const run = (statements: string) => psql(container, "preflight", statements);

  run("create role authenticated; create role anon;");

  // No asset_job_attempts at all.
  const withoutTable = psqlExpectingFailure(container, "preflight", sql("supabase-add-asset-job-attempt-provenance.sql"));
  assert.match(withoutTable, /asset_job_attempts does not exist/i);
  assert.match(withoutTable, /supabase-add-asset-job-attempts\.sql/);

  // Table present, but the base finish function is not.
  for (const file of BOOTSTRAP_FILES.filter((file) => file !== "supabase-add-asset-job-finish-functions.sql")) {
    run(sql(file));
  }
  const withoutBaseFunction = psqlExpectingFailure(container, "preflight", sql("supabase-add-asset-job-attempt-provenance.sql"));
  assert.match(withoutBaseFunction, /finish_asset_job_attempt\(uuid, text, text, text\) is missing/i);
  assert.match(withoutBaseFunction, /supabase-add-asset-job-finish-functions\.sql/);
  assert.equal(
    run("select count(*) from pg_proc where proname = 'finish_asset_job_attempt_with_provenance';"),
    "0",
    "an aborted preflight must leave no half-applied function behind",
  );

  // A stale draft: provider forced NOT NULL is a shape the migration must refuse rather than alter.
  run(sql("supabase-add-asset-job-finish-functions.sql"));
  run("update asset_job_attempts set provider = 'x' where provider is null; alter table asset_job_attempts alter column provider set not null;");
  const notNullProvider = psqlExpectingFailure(container, "preflight", sql("supabase-add-asset-job-attempt-provenance.sql"));
  assert.match(notNullProvider, /must be nullable/i);

  // Restored to the approved shape, the migration applies cleanly.
  run("alter table asset_job_attempts alter column provider drop not null;");
  run(sql("supabase-add-asset-job-attempt-provenance.sql"));
  assert.equal(run("select count(*) from pg_proc where proname = 'finish_asset_job_attempt_with_provenance';"), "1");
});
