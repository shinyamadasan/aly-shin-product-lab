import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { OWNER_APP_ROLE, OWNER_APP_ROLE_CLAIM_PATH } from "../src/lib/production-auth.ts";

// SECURITY S1 -- the owner-data hardening migration, held to the same standards as the application.
//
// Companion to tests/creative-production-rls-hardening.test.ts, and to the same limits: these tests
// read SQL as TEXT and cannot prove the migration works. That proof lives in
// tests/smoke/postgres/owner-data-rls.smoke.test.ts, which executes it against a real PostgreSQL as
// four principals. What belongs HERE is everything worth checking on every `npm test` run rather
// than only when Docker is available:
//
//   * the file reads the same claim path the application authorizes on
//   * no owner identifier, email, UUID or secret is committed
//   * COVERAGE -- every table the application and the workers actually touch is accounted for.
//     That last one is the test that catches the failure mode this migration is most exposed to:
//     a table that exists, is used, and was simply forgotten, and therefore keeps its permissive
//     policy while everything around it is locked down.

const ROOT = new URL("../", import.meta.url);

const hardening = readFileSync(new URL("supabase-harden-product-lab-owner-data-rls.sql", ROOT), "utf8");
const assignment = readFileSync(new URL("supabase-assign-owner-app-role.sql", ROOT), "utf8");
const waveB = readFileSync(new URL("supabase-harden-creative-production-rls.sql", ROOT), "utf8");

// Statements only. These files are heavily commented, and a rule stated in prose must not be
// mistaken for a rule implemented in SQL.
function statementsOf(sql: string): string {
  return sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
}

const statements = statementsOf(hardening);

// The seven tables Wave B closed. S1 must not re-policy them.
const WAVE_B_TABLES = ["creative_jobs", "creative_job_attempts", "creative_packages", "asset_jobs", "asset_job_attempts", "assets", "asset_files"];

// --- the claim is the same one the application reads --------------------------------------------

test("S1 reuses Wave B's claim readers rather than restating the claim path", () => {
  assert.equal(OWNER_APP_ROLE_CLAIM_PATH, "app_metadata.app_role");

  // Wave B owns the one definition of where the claim lives. If S1 ever grew its own copy of that
  // expression, the two could drift and the database would hold two answers to one question.
  assert.match(statementsOf(waveB), /auth\.jwt\(\)\s*->\s*'app_metadata'\s*->>\s*'app_role'/);
  assert.doesNotMatch(statements, /auth\.jwt\(\)/, "S1 must delegate to public.current_app_role(), never parse the JWT itself");
  assert.match(statements, /public\.current_app_role\(\)/);

  // And it must refuse to run if Wave B is not there.
  for (const helper of ["current_app_role", "is_product_lab_owner", "is_creative_domain_principal"]) {
    assert.match(statements, new RegExp(`'${helper}'`), `the preflight must require public.${helper}()`);
  }
});

test("the role names are the ones the application and Wave B already use", () => {
  assert.match(statements, new RegExp(`'${OWNER_APP_ROLE}'`));
  assert.match(statements, /'creative_worker'/);
  assert.match(statements, /'public_order'/);

  // The assignment file is the only place a claim is written, and it must accept the new value --
  // otherwise the migration's own preflight can never be satisfied. Matched against the RAW file,
  // not its statements: every executable line in that file ships commented out on purpose, so the
  // operator has to read it before running it.
  assert.match(assignment, /'owner',\s*'creative_worker',\s*'public_order'/);
});

test("user_metadata is never an authorization input", () => {
  // user_metadata is writable by the user through supabase.auth.updateUser(). Reading it would let
  // any account promote itself from the browser.
  assert.doesNotMatch(statements, /user_metadata/);
});

// --- nothing identifying is committed -----------------------------------------------------------

test("no owner identifier, credential or secret is committed", () => {
  for (const file of [hardening, assignment]) {
    assert.doesNotMatch(file, /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, "no email address may appear");
    assert.doesNotMatch(file, /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i, "no UUID may appear");
    assert.doesNotMatch(file, /eyJ[A-Za-z0-9_-]{10,}/, "no JWT may appear");
    assert.doesNotMatch(file, /service_role/i, "the service-role key must not be referenced");
  }
});

// --- scope: Wave B is not touched ---------------------------------------------------------------

test("the creative/production domain is left exactly as Wave B left it", () => {
  const policyStatements = statements.match(/create policy[\s\S]*?;/gi) ?? [];
  for (const policy of policyStatements) {
    for (const table of WAVE_B_TABLES) {
      assert.doesNotMatch(policy, new RegExp(`\\bon\\s+(public\\.)?${table}\\b`), `S1 must not re-policy ${table} -- Wave B owns it`);
    }
  }

  // The `generated-assets` bucket likewise. S1 touches `batch-photos` and nothing else in storage.
  const storagePolicies = policyStatements.filter((policy) => /storage\.objects/.test(policy));
  assert.equal(storagePolicies.length, 1, "S1 should create exactly one storage policy");
  assert.match(storagePolicies[0], /'batch-photos'/);
  assert.doesNotMatch(storagePolicies[0], /generated-assets/);
});

test("no table, column, index or row is mutated", () => {
  for (const forbidden of [
    /\balter\s+table\b(?![^;]*enable row level security)/i,
    /\bdrop\s+table\b/i,
    /\bcreate\s+table\b/i,
    /\btruncate\b/i,
    /\bdelete\s+from\b/i,
    /\bupdate\s+(?!auth\.users)[a-z_]+\s+set\b/i,
  ]) {
    assert.doesNotMatch(statements, forbidden, `S1 is policies and grants only; found ${forbidden}`);
  }
});

// --- COVERAGE: every table the code actually uses is accounted for -------------------------------
//
// The one failure mode this migration cannot detect in itself: a table that is real, used, and
// simply absent from the tier lists -- which would leave it on `to authenticated using (true)`
// while every table around it is closed, and nothing would say so.

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (entry === "node_modules" || entry === ".next") return [];
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

function tablesReferencedInCode(): Set<string> {
  const referenced = new Set<string>();
  for (const root of ["src", "scripts"]) {
    for (const file of walk(path.join(import.meta.dirname, "..", root))) {
      if (!/\.(ts|tsx|mjs)$/.test(file)) continue;
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/\bfrom\("([a-z_]+)"\)/g)) {
        referenced.add(match[1]);
      }
    }
  }
  return referenced;
}

// The list the migration's own preflight and postflight both use. Read from the file rather than
// re-typed here, so this test checks the migration and not a copy of it.
function hardenedTables(): string[] {
  const block = /hardened_tables constant text\[\] := array\[([\s\S]*?)\];/.exec(statements);
  assert.ok(block, "could not find the postflight's hardened_tables list -- has the migration been restructured?");
  return [...block[1].matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);
}

test("every table the application and workers touch is either hardened by S1 or owned by Wave B", () => {
  const covered = new Set([...hardenedTables(), ...WAVE_B_TABLES]);
  const uncovered = [...tablesReferencedInCode()].filter((table) => !covered.has(table)).sort();
  assert.deepEqual(uncovered, [], `these tables are used by the code but hardened by nobody: ${uncovered.join(", ")}`);
});

test("every table S1 claims to harden is one the code actually uses", () => {
  // The mirror of the test above: a name in the list that nothing references is either a typo --
  // in which case the real table is still permissive -- or a table that no longer exists.
  const referenced = tablesReferencedInCode();
  const orphaned = hardenedTables().filter((table) => !referenced.has(table)).sort();
  assert.deepEqual(orphaned, [], `these tables are in the migration but referenced nowhere in src/ or scripts/: ${orphaned.join(", ")}`);
});

test("the postflight list and the preflight list agree", () => {
  // The preflight refuses to run when a table is missing; the postflight refuses to finish when one
  // is still permissive. If the two lists ever disagree, one of those guards has a hole in it.
  const preflightBlock = /unnest\(array\[([\s\S]*?)\]\) as candidate\s*\n\s*where not exists/.exec(statements);
  assert.ok(preflightBlock, "could not find the preflight's table list");
  const preflight = [...preflightBlock[1].matchAll(/'([a-z_]+)'/g)].map((match) => match[1]).sort();
  assert.deepEqual(preflight, hardenedTables().slice().sort());
});

// --- the tiers say what the report says ---------------------------------------------------------

test("the worker's business-table access is read-only, and only the tables its advisors read", () => {
  const workerRead = /worker_read constant text\[\] := array\[([\s\S]*?)\];/.exec(statements);
  assert.ok(workerRead, "could not find the worker_read tier");
  const tables = [...workerRead[1].matchAll(/'([a-z_]+)'/g)].map((match) => match[1]).sort();

  // Exactly the tables scripts/daily-advisor, scripts/marketing-advisor and
  // scripts/creative-workers read. `opportunities` is deliberately NOT here -- it is the one
  // business table the worker writes, and it is granted separately and visibly.
  assert.deepEqual(tables, ["brand_profiles", "content_journal", "ingredients", "supply_entries", "tasting_feedback"]);
  assert.doesNotMatch(workerRead[1], /opportunities/);

  // The tier's write half must be owner-only.
  assert.match(
    statements,
    /foreach target in array worker_read \|\| catalog loop[\s\S]*?for insert to authenticated with check \(public\.is_product_lab_owner\(\)\)/,
    "the worker-read tier must give the worker SELECT and the owner the writes",
  );
});

test("the catalog tier is exactly what loadPublicCatalog reads", () => {
  const catalog = /catalog constant text\[\] := array\[([\s\S]*?)\];/.exec(statements);
  assert.ok(catalog, "could not find the catalog tier");
  const tables = [...catalog[1].matchAll(/'([a-z_]+)'/g)].map((match) => match[1]).sort();

  // src/lib/public-catalog-repository.ts is the only thing the website principal reads with, and it
  // reads these four. If that file grows a fifth table, this test fails before the menu does.
  const repository = readFileSync(new URL("src/lib/public-catalog-repository.ts", ROOT), "utf8");
  const readByWebsite = [...repository.matchAll(/client\.from\("([a-z_]+)"\)/g)].map((match) => match[1]).sort();
  assert.deepEqual(tables, readByWebsite);
});

test("the public-order principal gets no DELETE anywhere", () => {
  const publicOrderPolicies = (statements.match(/create policy "S1 public order[\s\S]*?;/gi) ?? []).join("\n");
  assert.ok(publicOrderPolicies.length > 0, "expected policies for the public-order principal");
  assert.doesNotMatch(publicOrderPolicies, /for delete/i);
  assert.doesNotMatch(publicOrderPolicies, /for all/i);
});
