import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

// SECURITY S1 -- EXECUTABLE verification of the owner-data authorization model.
//
// Wave B's final review found that SQL-TEXT tests are weaker than executing the SQL: the text of
// a policy is never "wrong", it just stops meaning what you thought once another policy, a grant,
// or a function signature changes around it. tests/creative-production-rls-hardening.test.ts reads
// the migration as a string. This file RUNS it, against a real PostgreSQL, as four real principals.
//
// It proves, executably:
//
//   * the owner claim admits the whole owner-business domain
//   * creative_worker gets exactly the five business tables its advisors read, READ-ONLY, and is
//     denied inventory / purchases / costing detail / equipment / photos / drafts / customers
//   * the public-order principal gets the four catalog tables and the ordering tables, and is
//     denied everything else -- including `customers`, whose PII it never reads
//   * a signed-in account with NO claim (the two unexplained accounts in this project) gets nothing
//   * anonymous is refused at the grant layer, before RLS is consulted
//   * the helper functions read app_metadata.app_role and nothing else -- not user_metadata, not a
//     top-level app_role, not a nested object
//   * public ordering still works end to end: save_public_order_once creates once and replays
//
// It also carries the proof for both halves of the `ON CONFLICT` question, which look identical
// from a distance and are not:
//
//   `customers` KEEPS SELECT and UPDATE. Both are load-bearing. PostgreSQL requires a PASSING
//   SELECT policy for `INSERT ... ON CONFLICT DO UPDATE` even when no row conflicts and there is
//   no RETURNING clause -- an earlier draft of the S1 migration withheld it and would have broken
//   public ordering on application. A test below removes the policy, proves ordering breaks, and
//   restores it, so nobody can mistake the grant for decoration.
//
//   `orders` and `order_lines` LOSE UPDATE (SECURITY S1.1). The UPDATE policies are evaluated only
//   when a row actually conflicts, and on the public path a conflict is unreachable:
//   save_public_order_once checks existence under an advisory lock and returns created:false
//   without calling save_order. So the website principal creates orders and reads them back, and
//   can change nothing that already exists.
//
// Opt-in only. Not part of `npm test` (that glob is tests/*.test.ts and does not recurse). Requires
// Docker:
//
//   RUN_POSTGRES_SMOKE=1 npm run postgres:smoke
//
// It creates and destroys its own throwaway container and touches no real database. No credential,
// no live project, no network beyond the local Docker daemon.

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
  ? "Set RUN_POSTGRES_SMOKE=1 to run the PostgreSQL owner-data RLS smoke test."
  : !dockerAvailable()
    ? "Docker is not available; cannot run the PostgreSQL owner-data RLS smoke test."
    : false;

function sql(file: string): string {
  return readFileSync(path.join(PROJECT_ROOT, file), "utf8");
}

// supabase-add-asset-files.sql cannot be applied to a FRESH database, and that is a real defect in
// that file -- pre-existing, outside SECURITY S1's scope, and reported rather than fixed here.
//
// Its self-check reads pg_get_indexdef() and matches it against the literal `(asset_id, position)`.
// `position` is a PostgreSQL keyword, so pg_get_indexdef always renders it QUOTED --
// `(asset_id, "position")` -- and the check therefore rejects the index the file itself just
// created, two statements earlier. The live project has the index because it arrived via
// supabase-recover-prop023-asset-schema.sql, whose equivalent check compares pg_attribute.attname
// and is not affected.
//
// S1 needs the creative tables only so that Wave B's hardening file will apply on top of them, so
// the harness relaxes exactly that one regex to tolerate the quoting, and asserts the substitution
// actually matched -- if the file is ever fixed or reworded, this fails loudly instead of quietly
// applying an unpatched guard.
function sqlWithAssetFilesIndexGuardRelaxed(file: string): string {
  const original = sql(file);
  const patched = original.replace(
    String.raw`'unique index.*\(asset_id, position\)'`,
    String.raw`'unique index.*\(asset_id, "?position"?\)'`,
  );
  assert.notEqual(patched, original, `${file}: the asset_files index guard this harness works around was not found -- re-check whether the workaround is still needed`);
  return patched;
}

// psql prints a command tag for every statement that is not a SELECT -- BEGIN, SET, COMMIT,
// INSERT 0 1, and so on. Every assertion here is about QUERY RESULTS, and the `as()` wrapper below
// necessarily emits three tags of its own around each batch, so the tags are stripped once, here,
// rather than being worked around at thirty call sites.
const COMMAND_TAG = /^(BEGIN|COMMIT|ROLLBACK|SET|DO|GRANT|REVOKE|COMMENT|TRUNCATE TABLE|(CREATE|DROP|ALTER).*|(INSERT|UPDATE|DELETE|SELECT|MERGE)( \d+)+)$/;

function psql(container: string, statements: string): string {
  const output = execFileSync("docker", ["exec", "-i", container, "psql", "-U", "postgres", "-d", "s1", "-tA", "-v", "ON_ERROR_STOP=1", "-f", "-"], {
    input: statements,
    encoding: "utf8",
  });
  return output
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "" && !COMMAND_TAG.test(line.trim()))
    .join("\n")
    .trim();
}

// Returns stderr instead of throwing, so a test can assert on an EXPECTED failure.
function psqlExpectingFailure(container: string, statements: string): string {
  try {
    execFileSync("docker", ["exec", "-i", container, "psql", "-U", "postgres", "-d", "s1", "-tA", "-v", "ON_ERROR_STOP=1", "-f", "-"], {
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

// Postgres briefly accepts connections during first-boot initialisation and then shuts down to
// finish, so pg_isready can report ready too early. Waiting on a real query is the reliable signal.
async function startPostgres(container: string): Promise<void> {
  execFileSync("docker", ["rm", "-f", container], { stdio: "ignore" });
  execFileSync("docker", ["run", "-d", "--name", container, "-e", "POSTGRES_PASSWORD=x", "-e", "POSTGRES_DB=s1", IMAGE], { stdio: "ignore" });
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      execFileSync("docker", ["exec", container, "psql", "-U", "postgres", "-d", "s1", "-tAc", "select 1"], { stdio: "ignore" });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw new Error(`PostgreSQL container ${container} did not become ready`);
}

// --- the Supabase surface this schema depends on, and nothing more ------------------------------
//
// Reproduced rather than mocked away, because the policies under test are written against it:
//
//   auth.jwt()      Supabase's own definition reads the request's claims out of a GUC. Postgres
//                   sets that GUC per request in production; here the test sets it per statement,
//                   which is the same mechanism and is what makes "sign in as X" expressible in SQL.
//   auth.users      the migration's preflight reads it to refuse running before the claims exist.
//   storage.*       buckets + objects, so the batch-photos policy is a real policy on a real table.
//
// `authenticated` and `anon` are the two Supabase roles the grants in this schema name.
const SUPABASE_STUBS = `
create role authenticated;
create role anon;

create schema auth;

create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text unique not null,
  raw_app_meta_data jsonb,
  last_sign_in_at timestamptz
);

-- Supabase's real definition, verbatim in behaviour: the claims of the current request, or an
-- empty object when there are none.
create or replace function auth.jwt()
returns jsonb
language sql
stable
as $fn$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$fn$;

grant usage on schema auth to authenticated, anon;
grant execute on function auth.jwt() to authenticated, anon;

create schema storage;

create table storage.buckets (
  id text primary key,
  name text not null,
  public boolean not null default false,
  file_size_limit bigint,
  allowed_mime_types text[]
);

create table storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text not null references storage.buckets(id),
  name text not null
);

alter table storage.objects enable row level security;
grant usage on schema storage to authenticated, anon;
grant select, insert, update, delete on table storage.objects to authenticated;
`;

// Applied in dependency order. Every one of these is idempotent in its own right; the order here is
// foreign keys, not idempotency.
const BASE_SCHEMA = [
  "supabase-schema.sql",
  "supabase-fix-permissions.sql",
  "supabase-update-costing-and-journal.sql",
  "supabase-add-equipment.sql",
  "supabase-add-ai-reviews.sql",
  "supabase-add-inventory.sql",
  "supabase-add-supplies.sql",
  "supabase-add-brand-profiles.sql",
  "supabase-add-content-drafts.sql",
  "supabase-add-selling-formats.sql",
  "supabase-add-opportunities.sql",
  "supabase-add-orders.sql",
  "supabase-add-public-order-once.sql",
  "supabase-add-batch-photos-storage.sql",
];

// Wave B's lineage: creative_packages -> asset_jobs -> {asset_job_attempts, assets -> asset_files}.
// Needed because supabase-harden-creative-production-rls.sql refuses to run without these tables,
// and this file's own preflight refuses to run without that file's helper functions.
const CREATIVE_SCHEMA = [
  "supabase-add-creative-jobs.sql",
  "supabase-add-creative-job-attempts.sql",
  "supabase-add-creative-packages.sql",
  "supabase-add-asset-jobs.sql",
  "supabase-add-asset-job-attempts.sql",
  "supabase-add-assets.sql",
  "supabase-add-asset-files.sql",
  "supabase-add-generated-assets-storage.sql",
  "supabase-harden-creative-production-rls.sql",
];

// Four accounts, mirroring the live project: one owner, one worker, one website principal, and one
// account with no claim -- which is exactly the shape of the two unexplained accounts this project
// turned out to have.
const SEED_ACCOUNTS = `
insert into auth.users (email, raw_app_meta_data) values
  ('owner@example.test',        '{"provider":"email","app_role":"owner"}'::jsonb),
  ('worker@example.test',       '{"provider":"email","app_role":"creative_worker"}'::jsonb),
  ('website@example.test',      '{"provider":"email","app_role":"public_order"}'::jsonb),
  ('unexplained@example.test',  '{"provider":"email"}'::jsonb);
`;

// Seeded as `postgres`, which owns these tables and is therefore not subject to their RLS. At least
// one row in every table under test, so "0 rows" in a later assertion can only mean the policy
// filtered it -- never that the table happened to be empty. That distinction is the entire
// difference between proving a boundary and assuming one, and it is the thing the live probe
// cannot establish on its own.
const SEED_DATA = `
insert into products (id, name, category, product_role) values ('p1','Blondies','bakery','hero');
insert into product_batches (id, product_id, batch_version, date_made)
  values ('11111111-1111-4111-8111-111111111111','p1','v1', current_date);
insert into costing_summaries (id, product_id, batch_id)
  values ('22222222-2222-4222-8222-222222222222','p1','11111111-1111-4111-8111-111111111111');
insert into selling_formats (id, costing_id, name, pieces_per_unit, selling_price, is_active, sort_order)
  values ('33333333-3333-4333-8333-333333333333','22222222-2222-4222-8222-222222222222','Box of 6', 6, 250, true, 0);
insert into selling_format_packaging_lines (id, selling_format_id, name)
  values ('3a333333-3333-4333-8333-333333333333','33333333-3333-4333-8333-333333333333','Box');
insert into ingredients (id, name, base_unit) values ('44444444-4444-4444-8444-444444444444','Butter','g');
insert into ingredient_aliases (id, ingredient_id, raw_text, normalized_text)
  values ('55555555-5555-4555-8555-555555555555','44444444-4444-4444-8444-444444444444','BUTTER 1KG','butter');
insert into purchase_imports (id, file_name) values ('66666666-6666-4666-8666-666666666666','receipt.csv');
insert into purchase_import_rows (id, import_id, row_index, raw_item_name, raw_quantity, raw_unit)
  values ('77777777-7777-4777-8777-777777777777','66666666-6666-4666-8666-666666666666', 0, 'BUTTER 1KG','1','kg');
insert into inventory_transactions (id, ingredient_id, transaction_type, quantity_change, quantity_before, quantity_after, source_type)
  values ('88888888-8888-4888-8888-888888888888','44444444-4444-4444-8444-444444444444','purchase', 1000, 0, 1000, 'purchase_import');
insert into costing_entries (id, product_id, ingredient_name) values ('99999999-9999-4999-8999-999999999999','p1','Butter');
insert into supply_entries (id, ingredient_name, supplier_name) values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','Flour','Local Mill');
insert into tasting_feedback (id, product_id, taster_name) values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','p1','Aly');
insert into content_journal (id) values ('cccccccc-cccc-4ccc-8ccc-cccccccccccc');
insert into content_drafts (id) values ('dddddddd-dddd-4ddd-8ddd-dddddddddddd');
insert into brand_profiles (id, business_name, is_active) values ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','Aly & Pon', true);
insert into ai_reviews (id, product_id, action, prompt) values ('ffffffff-ffff-4fff-8fff-ffffffffffff','p1','review','Review this.');
insert into batch_photos (id, batch_id, photo_url)
  values ('a0111111-1111-4111-8111-111111111111','11111111-1111-4111-8111-111111111111','https://example.test/p1/photo.jpg');
insert into customers (id, name) values ('a1111111-1111-4111-8111-111111111111','Existing Customer');
insert into orders (id, customer_id) values ('a2222222-2222-4222-8222-222222222222','a1111111-1111-4111-8111-111111111111');
insert into order_lines (id, order_id, item_name, unit_price, quantity)
  values ('a3333333-3333-4333-8333-333333333333','a2222222-2222-4222-8222-222222222222','Blondies', 250, 1);
insert into opportunities (id, opportunity_type, producer, source_type, source_id, title, summary, reason,
  recommended_action, evidence_version, evidence, source_rule_ids, source_findings, status, detected_at, expires_at, deduplication_key)
values ('a5555555-5555-4555-8555-555555555555','product_marketing_content','daily_advisor','daily_advisor','seed',
  'Seeded','Summary','Reason','create_content','v1','{}'::jsonb,'{}'::text[],'[]'::jsonb,'new', now(), now() + interval '3 days','s1-seed');
insert into storage.buckets (id, name, public) values ('batch-photos','batch-photos', true) on conflict (id) do nothing;
insert into storage.objects (id, bucket_id, name)
  values ('a4444444-4444-4444-8444-444444444444','batch-photos','p1/photo.jpg');
`;

// "Sign in" as a principal for the duration of one statement batch: become the `authenticated`
// role, and present a JWT with the given app_metadata.app_role. Wrapped in a transaction so
// `set local` reverts even if a statement raises.
function as(claim: string | null, statements: string): string {
  const claims = claim === null ? `{"role":"authenticated"}` : `{"role":"authenticated","app_metadata":{"app_role":"${claim}"}}`;
  return `begin;
set local role authenticated;
set local request.jwt.claims = '${claims}';
${statements}
commit;`;
}

// One count per line, in the order the tables are given, so a whole tier can be asserted at once.
function counts(claim: string | null, tables: string[]): string {
  return as(claim, tables.map((table) => `select '${table}=' || count(*) from ${table};`).join("\n"));
}

function expectCounts(actual: string, expected: Record<string, number>): void {
  const seen = Object.fromEntries(
    actual
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.includes("="))
      .map((line) => {
        const at = line.indexOf("=");
        return [line.slice(0, at), Number(line.slice(at + 1))];
      }),
  );
  for (const [table, count] of Object.entries(expected)) {
    assert.equal(seen[table], count, `${table}: expected ${count} visible row(s), saw ${seen[table]}`);
  }
}

const OWNER_ONLY_TABLES = [
  "ingredient_aliases",
  "purchase_imports",
  "purchase_import_rows",
  "inventory_transactions",
  "equipment",
  "costing_entries",
  "batch_photos",
  "content_drafts",
  "ai_reviews",
  "selling_format_packaging_lines",
];

const WORKER_READ_TABLES = ["ingredients", "content_journal", "supply_entries", "tasting_feedback", "brand_profiles"];

const CATALOG_TABLES = ["products", "product_batches", "costing_summaries", "selling_formats"];

test("SECURITY S1: owner-data RLS admits exactly the principals it names", { skip }, async (t) => {
  const container = "aly-shin-s1-owner-data-rls";
  await startPostgres(container);
  t.after(() => execFileSync("docker", ["rm", "-f", container], { stdio: "ignore" }));
  const run = (statements: string) => psql(container, statements);
  const runExpectingFailure = (statements: string) => psqlExpectingFailure(container, statements);

  // --- A. build the world -----------------------------------------------------------------------
  run(SUPABASE_STUBS);
  for (const file of BASE_SCHEMA) run(sql(file));
  for (const file of CREATIVE_SCHEMA) {
    run(file === "supabase-add-asset-files.sql" ? sqlWithAssetFilesIndexGuardRelaxed(file) : sql(file));
  }
  run(SEED_ACCOUNTS);
  run(SEED_DATA);

  await t.test("BEFORE hardening, every principal can read the owner's business", () => {
    // The defect, reproduced. This is what the live probe measured on 2026-08-20 and it is the
    // reason this migration exists -- asserted here so the test fails if someone ever claims the
    // pre-S1 schema was fine.
    expectCounts(run(counts("public_order", ["ingredients", "costing_entries", "purchase_import_rows", "customers"])), {
      ingredients: 1,
      costing_entries: 1,
      purchase_import_rows: 1,
      customers: 1,
    });
    expectCounts(run(counts(null, ["ingredients", "costing_entries", "purchase_import_rows", "customers"])), {
      ingredients: 1,
      costing_entries: 1,
      purchase_import_rows: 1,
      customers: 1,
    });
  });

  // --- B. the migration's own preflight ---------------------------------------------------------

  await t.test("the migration refuses to run before the public_order claim exists", () => {
    run("update auth.users set raw_app_meta_data = raw_app_meta_data - 'app_role' where email = 'website@example.test';");
    assert.match(
      runExpectingFailure(sql("supabase-harden-product-lab-owner-data-rls.sql")),
      /No account holds app_role = public_order/i,
      "applying before the claim exists must be a clean refusal, not an outage on the ordering page",
    );
    run("update auth.users set raw_app_meta_data = raw_app_meta_data || '{\"app_role\":\"public_order\"}'::jsonb where email = 'website@example.test';");
  });

  await t.test("the migration refuses to run when the owner claim is ambiguous", () => {
    run("update auth.users set raw_app_meta_data = raw_app_meta_data || '{\"app_role\":\"owner\"}'::jsonb where email = 'unexplained@example.test';");
    assert.match(
      runExpectingFailure(sql("supabase-harden-product-lab-owner-data-rls.sql")),
      /Expected exactly 1 account with app_role = owner, found 2/i,
      "two owners is a reconciliation problem, not something to harden on top of",
    );
    run("update auth.users set raw_app_meta_data = raw_app_meta_data - 'app_role' where email = 'unexplained@example.test';");
  });

  // --- C. apply, twice, to prove idempotency ----------------------------------------------------

  await t.test("the migration applies, and applies again with no change", () => {
    run(sql("supabase-harden-product-lab-owner-data-rls.sql"));
    run(sql("supabase-harden-product-lab-owner-data-rls.sql"));
    // The postflight inside the file raises on any failure, so reaching here twice is the assertion.
    // The count below just pins the shape so a silently-empty run cannot pass.
    assert.ok(
      Number(run("select count(*) from pg_policies where policyname like 'S1 %';")) >= 40,
      "the migration must leave a substantial set of S1 policies behind",
    );
  });

  // --- C2. SECURITY S1.1 ------------------------------------------------------------------------

  await t.test("S1.1 narrows on top of S1, and applies again with no change", () => {
    run(sql("supabase-narrow-s1-least-privilege.sql"));
    run(sql("supabase-narrow-s1-least-privilege.sql"));

    assert.equal(
      run(`select coalesce(string_agg(tablename || '.' || cmd, ', ' order by tablename, cmd), '(none)')
           from pg_policies
           where schemaname = 'public' and tablename in ('orders', 'order_lines')
             and policyname like '%public order%' and cmd in ('UPDATE', 'DELETE');`),
      "(none)",
      "the website principal must hold no UPDATE and no DELETE policy on the ordering tables",
    );

    // `customers` is deliberately NOT narrowed -- all three verbs stay.
    assert.equal(
      run(`select string_agg(cmd, ',' order by cmd) from pg_policies
           where schemaname = 'public' and tablename = 'customers' and policyname like '%public order%';`),
      "INSERT,SELECT,UPDATE",
    );

    assert.equal(
      run(`select coalesce(string_agg(proname, ','), '(none)') from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'is_ordering_principal';`),
      "(none)",
      "the dead helper must be gone",
    );

    // Everything from here on is asserted against S1 + S1.1, not S1 alone.
  });

  // --- D. OWNER ---------------------------------------------------------------------------------

  await t.test("OWNER: the whole owner-business domain is readable", () => {
    // Every table is seeded, so "at least one row" is the meaningful assertion here -- `equipment`
    // arrives with three rows of its own from supabase-add-equipment.sql, and pinning exact counts
    // would make this test a schema-fixture test rather than an authorization test.
    const tables = [...OWNER_ONLY_TABLES, ...WORKER_READ_TABLES, ...CATALOG_TABLES, "orders", "order_lines", "opportunities"];
    const seen = run(counts("owner", tables));
    for (const table of tables) {
      const match = new RegExp(`^${table}=(\\d+)$`, "m").exec(seen);
      assert.ok(match, `${table}: no count returned for the owner`);
      assert.ok(Number(match[1]) >= 1, `${table}: the owner must see the seeded row, saw ${match[1]}`);
    }
  });

  await t.test("OWNER: writes are permitted across the domain", () => {
    run(
      as(
        "owner",
        `insert into ingredients (id, name, base_unit) values ('b1111111-1111-4111-8111-111111111111','Sugar','g');
         update ingredients set name = 'Sugar (fine)' where id = 'b1111111-1111-4111-8111-111111111111';
         delete from ingredients where id = 'b1111111-1111-4111-8111-111111111111';
         insert into costing_entries (id, product_id, ingredient_name, quantity_used, unit, cost)
           values ('b2222222-2222-4222-8222-222222222222','p1','Sugar', 10, 'g', 3);
         delete from costing_entries where id = 'b2222222-2222-4222-8222-222222222222';
         insert into storage.objects (id, bucket_id, name) values ('b3333333-3333-4333-8333-333333333333','batch-photos','p1/new.jpg');
         delete from storage.objects where id = 'b3333333-3333-4333-8333-333333333333';`,
      ),
    );
  });

  // --- E. CREATIVE WORKER -----------------------------------------------------------------------

  await t.test("CREATIVE WORKER: denied the general owner-business domain", () => {
    expectCounts(
      run(counts("creative_worker", OWNER_ONLY_TABLES)),
      Object.fromEntries(OWNER_ONLY_TABLES.map((table) => [table, 0])),
    );
  });

  await t.test("CREATIVE WORKER: reads exactly the tables its advisors consult", () => {
    expectCounts(run(counts("creative_worker", WORKER_READ_TABLES)), {
      ingredients: 1,
      content_journal: 1,
      supply_entries: 1,
      tasting_feedback: 1,
      brand_profiles: 1,
    });
    // The catalog is seeded by the schema files as well as by this test, so it is pinned against
    // what the owner sees rather than a fixed number.
    assert.equal(run(counts("creative_worker", CATALOG_TABLES)), run(counts("owner", CATALOG_TABLES)));
  });

  await t.test("CREATIVE WORKER: read does not imply write", () => {
    assert.match(
      runExpectingFailure(as("creative_worker", `insert into ingredients (id, name, base_unit) values ('c1111111-1111-4111-8111-111111111111','Salt','g');`)),
      /row-level security/i,
      "the worker reads ingredients for grounding; it has no business writing them",
    );
    // UPDATE and DELETE are filtered rather than refused -- a policy the row fails simply makes the
    // row invisible to the statement. Zero affected rows IS the denial.
    assert.equal(run(as("creative_worker", `update ingredients set name = 'hijacked'; select 'updated=' || count(*) from ingredients where name = 'hijacked';`)).trim(), "updated=0");
    assert.equal(run(as("owner", `select 'still=' || count(*) from ingredients where name = 'Butter';`)).trim(), "still=1");
  });

  await t.test("CREATIVE WORKER: keeps the one business table it genuinely writes", () => {
    run(
      as(
        "creative_worker",
        `insert into opportunities (id, opportunity_type, producer, source_type, source_id, title, summary, reason,
           recommended_action, evidence_version, evidence, source_rule_ids, source_findings, status, detected_at, expires_at, deduplication_key)
         values ('c2222222-2222-4222-8222-222222222222','product_marketing_content','daily_advisor','daily_advisor','src',
           'Title','Summary','Reason','create_content','v1','{}'::jsonb,'{}'::text[],'[]'::jsonb,'new', now(), now() + interval '3 days','s1-key');`,
      ),
    );
    // One seeded plus the one the worker just created.
    assert.equal(run(counts("creative_worker", ["opportunities"])).trim(), "opportunities=2");
  });

  await t.test("CREATIVE WORKER: opportunities is SELECT/INSERT/UPDATE and never DELETE (S1.1)", () => {
    // S1 granted `for all`, which includes a DELETE nothing in the codebase performs.
    // scripts/daily-advisor/opportunity-persistence.ts uses exactly three verbs (:102, :110, :168).
    run(as("creative_worker", `update opportunities set status = 'accepted' where deduplication_key = 's1-key';`));
    assert.equal(
      run(as("owner", `select status from opportunities where deduplication_key = 's1-key';`)),
      "accepted",
      "the daily advisor must still be able to refresh an Opportunity it created",
    );

    const before = run(as("owner", `select 'opportunities=' || count(*) from opportunities;`));
    run(as("creative_worker", `delete from opportunities;`));
    assert.equal(
      run(as("owner", `select 'opportunities=' || count(*) from opportunities;`)),
      before,
      "the worker has no DELETE policy, so its delete must match no row",
    );
  });

  await t.test("OWNER: keeps DELETE on opportunities (S1.1)", () => {
    // Narrowing the worker must not narrow the owner. Removing an Opportunity stays a human call.
    run(
      as(
        "owner",
        `insert into opportunities (id, opportunity_type, producer, source_type, source_id, title, summary, reason,
           recommended_action, evidence_version, evidence, source_rule_ids, source_findings, status, detected_at, expires_at, deduplication_key)
         values ('c4444444-4444-4444-8444-444444444444','product_marketing_content','daily_advisor','daily_advisor','src',
           'T','S','R','create_content','v1','{}'::jsonb,'{}'::text[],'[]'::jsonb,'new', now(), now() + interval '3 days','s11-owner-delete');`,
      ),
    );
    run(as("owner", `delete from opportunities where deduplication_key = 's11-owner-delete';`));
    assert.equal(
      run(as("owner", `select 'left=' || count(*) from opportunities where deduplication_key = 's11-owner-delete';`)),
      "left=0",
    );
  });

  await t.test("CREATIVE WORKER: keeps its Wave B creative-domain access", () => {
    expectCounts(run(counts("creative_worker", ["creative_jobs", "creative_packages", "asset_jobs", "assets", "asset_files"])), {
      creative_jobs: 0,
      creative_packages: 0,
      asset_jobs: 0,
      assets: 0,
      asset_files: 0,
    });
    // Empty because nothing was seeded there; what matters is that the read is PERMITTED, which a
    // denied grant would not be. Prove permission by writing one and reading it back.
    run(
      as(
        "creative_worker",
        `insert into creative_jobs (id, status, worker_type, intent)
           values ('c3333333-3333-4333-8333-333333333333','queued','mock','{"schemaVersion":"v1","text":"probe"}'::jsonb);
         select 'jobs=' || count(*) from creative_jobs;`,
      ),
    );
    assert.equal(run(counts("creative_worker", ["creative_jobs"])).trim(), "creative_jobs=1");
    assert.equal(run(counts("public_order", ["creative_jobs"])).trim(), "creative_jobs=0", "Wave B regression: the website principal must not see creative jobs");
  });

  // --- F. PUBLIC-ORDER --------------------------------------------------------------------------

  await t.test("PUBLIC ORDER: denied the owner-business domain", () => {
    expectCounts(
      run(counts("public_order", [...OWNER_ONLY_TABLES, ...WORKER_READ_TABLES])),
      Object.fromEntries([...OWNER_ONLY_TABLES, ...WORKER_READ_TABLES].map((table) => [table, 0])),
    );
  });

  await t.test("PUBLIC ORDER: reads the catalog it builds a menu from", () => {
    // Pinned against what the OWNER sees rather than against a hardcoded number: the schema files
    // seed products of their own, and the assertion that matters is that the menu the website
    // principal can build is the same catalog the owner has -- not that it is any given size.
    const ownerCounts = run(counts("owner", CATALOG_TABLES));
    assert.equal(run(counts("public_order", CATALOG_TABLES)), ownerCounts);
    for (const table of CATALOG_TABLES) {
      const match = new RegExp(`^${table}=(\\d+)$`, "m").exec(ownerCounts);
      assert.ok(match && Number(match[1]) >= 1, `${table}: nothing seeded, so this proves nothing`);
    }
  });

  await t.test("PUBLIC ORDER: cannot edit or delete the catalog", () => {
    assert.match(
      runExpectingFailure(as("public_order", `insert into products (id, name, category, product_role) values ('p2','Injected','bakery','hero');`)),
      /row-level security/i,
    );
    const before = run(as("owner", `select 'products=' || count(*) from products;`));
    run(as("public_order", `delete from products;`));
    assert.equal(run(as("owner", `select 'products=' || count(*) from products;`)), before, "the catalog survived a delete attempt by the website principal");
  });

  await t.test("PUBLIC ORDER: the customers SELECT policy is load-bearing, not decorative", () => {
    // `customers` holds the name, phone, messaging handle and email of everyone who has ever
    // ordered -- the most valuable table in this database to anyone who reaches the website
    // principal's credentials. The migration grants it SELECT anyway, and this is the test that
    // records WHY, so that the grant can never be mistaken for carelessness or quietly widened.
    //
    // PostgreSQL requires a PASSING SELECT policy for `INSERT ... ON CONFLICT DO UPDATE`, which is
    // the form save_public_order_once uses. Remove the policy and public ordering stops working.
    assert.equal(run(counts("public_order", ["customers"])), run(counts("owner", ["customers"])), "the website principal sees the same customer table the owner does");

    const submission = (key: string) => `select 'created=' || (save_public_order_once(
      '{"id":"${key}1111-1111-4111-8111-111111111111","name":"Policy Probe"}'::jsonb,
      '{"id":"${key}2222-2222-4222-8222-222222222222","customer_id":"${key}1111-1111-4111-8111-111111111111","status":"new","payment_status":"unpaid","fulfillment_method":"pickup","source":"website","entry_method":"website"}'::jsonb,
      '[]'::jsonb) ->> 'created');`;

    run(`drop policy "S1 public order reads customers" on public.customers;`);
    assert.match(
      runExpectingFailure(as("public_order", submission("e1aa"))),
      /row-level security policy for table "customers"/i,
      "without the SELECT policy, a customer can no longer place an order -- which is why it is granted",
    );

    run(`create policy "S1 public order reads customers" on public.customers for select to authenticated using (public.is_public_order_principal());`);
    assert.equal(run(as("public_order", submission("e2bb"))), "created=true", "restoring the policy restores public ordering");
  });

  await t.test("PUBLIC ORDER: public ordering still works end to end", () => {
    const payload = `
      '{"id":"d1111111-1111-4111-8111-111111111111","name":"Test Buyer","phone":"0900","messaging_handle":null,"email":null,"notes":null,"updated_at":null}'::jsonb,
      '{"id":"d2222222-2222-4222-8222-222222222222","customer_id":"d1111111-1111-4111-8111-111111111111","status":"new","payment_status":"unpaid","fulfillment_method":"pickup","source":"website","entry_method":"website"}'::jsonb,
      '[{"id":"d3333333-3333-4333-8333-333333333333","order_id":"d2222222-2222-4222-8222-222222222222","item_name":"Blondies — Box of 6","unit_price":"250","quantity":"1","sort_order":"0"}]'::jsonb`;

    // First submission creates.
    assert.equal(
      run(as("public_order", `select 'created=' || (save_public_order_once(${payload}) ->> 'created');`)).trim(),
      "created=true",
      "the website principal must be able to place an order",
    );

    // Replay writes nothing and reports it -- the idempotency contract the public route depends on.
    assert.equal(
      run(as("public_order", `select 'created=' || (save_public_order_once(${payload}) ->> 'created');`)).trim(),
      "created=false",
      "a replayed submission must be a no-op, not a second order",
    );

    // And the owner can see what the website principal wrote -- the order, its customer and its
    // line. Looked up by id rather than by count, because earlier tests in this file place orders
    // of their own and a total would only be asserting the order they happen to run in.
    assert.equal(
      run(as("owner", `select 'order=' || count(*) from orders where id = 'd2222222-2222-4222-8222-222222222222';
                       select 'customer=' || count(*) from customers where id = 'd1111111-1111-4111-8111-111111111111';
                       select 'line=' || count(*) from order_lines where id = 'd3333333-3333-4333-8333-333333333333';`)),
      "order=1\ncustomer=1\nline=1",
    );
  });

  await t.test("PUBLIC ORDER: cannot change an order it created (S1.1)", () => {
    // The website principal creates orders and reads them back. It must not be able to move one to
    // completed, rewrite a line's quantity, or edit anyone's notes. A filtered UPDATE is silent --
    // it matches no row and reports success having changed nothing -- so this is asserted by
    // reading the row back as the owner, not by expecting an error.
    const orderBefore = run(as("owner", `select coalesce(notes, '(null)') || '|' || status from orders where id = 'd2222222-2222-4222-8222-222222222222';`));
    const lineBefore = run(as("owner", `select unit_price || '|' || quantity from order_lines where id = 'd3333333-3333-4333-8333-333333333333';`));

    run(as("public_order", `update orders set notes = 'HIJACKED', status = 'completed';`));
    run(as("public_order", `update order_lines set quantity = 99;`));

    assert.equal(
      run(as("owner", `select coalesce(notes, '(null)') || '|' || status from orders where id = 'd2222222-2222-4222-8222-222222222222';`)),
      orderBefore,
      "the website principal must not be able to alter an order",
    );
    assert.equal(
      run(as("owner", `select unit_price || '|' || quantity from order_lines where id = 'd3333333-3333-4333-8333-333333333333';`)),
      lineBefore,
      "the website principal must not be able to alter an order line",
    );
  });

  await t.test("PUBLIC ORDER: cannot delete an order or a customer", () => {
    // A filtered DELETE is silent rather than an error -- there is no DELETE policy, so it matches
    // no row and reports success having removed nothing. Counted before and after, because that is
    // the only thing that distinguishes "denied" from "deleted".
    const before = run(as("owner", `select 'orders=' || count(*) from orders; select 'order_lines=' || count(*) from order_lines; select 'customers=' || count(*) from customers;`));
    run(as("public_order", `delete from orders; delete from order_lines; delete from customers;`));
    assert.equal(
      run(as("owner", `select 'orders=' || count(*) from orders; select 'order_lines=' || count(*) from order_lines; select 'customers=' || count(*) from customers;`)),
      before,
      "orders, order lines and customers all survived a delete attempt by the website principal",
    );
  });

  await t.test("PUBLIC ORDER: cannot touch batch photos in storage", () => {
    assert.match(
      runExpectingFailure(as("public_order", `insert into storage.objects (id, bucket_id, name) values ('d4444444-4444-4444-8444-444444444444','batch-photos','p1/injected.jpg');`)),
      /row-level security/i,
    );
    assert.equal(run(as("public_order", `select 'objects=' || count(*) from storage.objects where bucket_id = 'batch-photos';`)).trim(), "objects=0");
    assert.equal(run(as("public_order", `delete from storage.objects; select 'left=' || count(*) from storage.objects;`)).trim(), "left=0");
    assert.equal(run(as("owner", `select 'objects=' || count(*) from storage.objects where bucket_id = 'batch-photos';`)).trim(), "objects=1", "the owner's photos survived");
  });

  // --- G. NO CLAIM (the unexplained accounts) ---------------------------------------------------

  await t.test("NO CLAIM: an authenticated account with no app_role sees nothing", () => {
    const everything = [...OWNER_ONLY_TABLES, ...WORKER_READ_TABLES, ...CATALOG_TABLES, "orders", "order_lines", "opportunities", "creative_jobs"];
    expectCounts(run(counts(null, everything)), Object.fromEntries(everything.map((table) => [table, 0])));
  });

  await t.test("NO CLAIM: an unrecognised app_role value is not a skeleton key", () => {
    for (const impostor of ["Owner", " owner", "owner,admin", "ownerx", "admin", "public-order"]) {
      assert.equal(
        run(counts(impostor, ["ingredients", "products", "orders"])).replace(/\s+/g, " "),
        "ingredients=0 products=0 orders=0",
        `app_role "${impostor}" must not admit anything`,
      );
    }
  });

  // --- H. ANONYMOUS -----------------------------------------------------------------------------

  await t.test("ANONYMOUS: refused at the grant layer, before RLS is consulted", () => {
    for (const table of ["ingredients", "products", "orders", "creative_jobs"]) {
      assert.match(
        runExpectingFailure(`begin; set local role anon; select count(*) from ${table}; commit;`),
        /permission denied for table/i,
        `anon must have no grant on ${table}`,
      );
    }
  });

  // --- I. the claim readers themselves ----------------------------------------------------------

  await t.test("the helpers read app_metadata.app_role and nothing else", () => {
    // is_ordering_principal() was dropped by S1.1 as dead -- no policy ever named it -- so the
    // probe reads the three helpers that actually gate something.
    const probe = "select coalesce(public.current_app_role(), '(null)') || '|' || public.is_product_lab_owner() || '|' || public.is_catalog_read_principal() || '|' || public.is_public_order_principal();";

    assert.equal(run(as("owner", probe)), "owner|true|true|false");
    assert.equal(run(as("creative_worker", probe)), "creative_worker|false|true|false");
    assert.equal(run(as("public_order", probe)), "public_order|false|true|true");

    // With no claim the helpers return NULL, not false -- `NULL = 'owner'` is NULL, and the
    // concatenation above collapses the whole row to NULL, which psql renders as an empty line.
    // That is the correct behaviour and worth pinning: RLS treats a NULL policy expression as
    // "not permitted", exactly like false, so absence fails closed either way. A future refactor
    // that "tidied" these into `coalesce(..., false)` would not change authorization, but one that
    // inverted a predicate would -- and NULL is the state where that mistake is easiest to make.
    assert.equal(run(as(null, probe)), "", "an absent claim must produce NULL, which RLS denies");
    assert.equal(run(as(null, "select coalesce(public.is_product_lab_owner()::text, 'NULL');")), "NULL");

    // user_metadata is writable by the user through supabase.auth.updateUser(). If a helper ever
    // read it, any account could promote itself to owner from the browser. This is the assertion
    // that stops that regression.
    assert.equal(
      run(`begin; set local role authenticated;
           set local request.jwt.claims = '{"role":"authenticated","user_metadata":{"app_role":"owner"}}';
           ${probe} commit;`),
      "",
      "user_metadata must never be an authorization input",
    );

    // A top-level app_role, an app_metadata that is not an object, an empty app_role, and a
    // non-string app_role are all malformed, and malformed must fail closed.
    for (const claims of [
      `{"role":"authenticated","app_role":"owner"}`,
      `{"role":"authenticated","app_metadata":"owner"}`,
      `{"role":"authenticated","app_metadata":{"app_role":""}}`,
    ]) {
      assert.equal(
        run(`begin; set local role authenticated; set local request.jwt.claims = '${claims}'; ${probe} commit;`),
        "",
        `malformed claim must fail closed (NULL, which RLS denies): ${claims}`,
      );
    }

    // A non-string app_role is the one case where SQL and the application disagree in SHAPE, and
    // the disagreement is worth pinning rather than hiding. readAppRole() in src/lib/production-auth.ts
    // returns null for anything that is not a string; PostgreSQL's `->>` stringifies the object
    // instead, so current_app_role() returns the text '{"value": "owner"}'.
    //
    // It changes no decision -- every predicate is an EXACT equality against a known role name, and
    // a stringified object matches none of them -- but a future predicate written with `like` or a
    // prefix test would turn this difference into a hole. Asserted so the difference is on record.
    assert.equal(
      run(`begin; set local role authenticated;
           set local request.jwt.claims = '{"role":"authenticated","app_metadata":{"app_role":{"value":"owner"}}}';
           ${probe} commit;`),
      `{"value": "owner"}|false|false|false`,
      "a non-string app_role must grant nothing, whatever current_app_role() renders it as",
    );
  });

  // --- J. no permissive policy survives ---------------------------------------------------------

  await t.test("no `using (true)` policy remains anywhere in the public schema", () => {
    assert.equal(
      run(`select coalesce(string_agg(tablename || '.' || policyname, ', '), '(none)')
           from pg_policies
           where schemaname = 'public' and (coalesce(qual,'') = 'true' or coalesce(with_check,'') = 'true');`).trim(),
      "(none)",
    );
  });

  await t.test("EXECUTE on the owner-domain RPCs is no longer granted to PUBLIC", () => {
    const offenders = run(`select coalesce(string_agg(p.oid::regprocedure::text, ', '), '(none)')
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.proname in ('apply_inventory_adjustment','confirm_purchase_import','confirm_bake',
                          'save_supply_with_inventory_effect','delete_supply_with_inventory_effect',
                          'repair_supply_inventory_effects','create_batch_with_costing',
                          'save_order','save_public_order_once')
        and has_function_privilege('public', p.oid, 'execute');`).trim();
    assert.equal(offenders, "(none)", `these functions are still executable by PUBLIC: ${offenders}`);
  });
});
