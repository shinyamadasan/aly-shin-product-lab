import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { OWNER_APP_ROLE, OWNER_APP_ROLE_CLAIM_PATH } from "../src/lib/production-auth.ts";

// Wave B -- the RLS hardening migration, held to the same standards as the application change.
//
// These tests read SQL as text. They cannot prove the migration WORKS against Postgres -- only
// applying it can, and that is a manual owner step. What they can prove is that the file says what
// we think it says: the same claim path the application uses, no owner identifier baked in, every
// table in the domain covered, and nothing outside the domain touched.

const hardening = readFileSync(new URL("../supabase-harden-creative-production-rls.sql", import.meta.url), "utf8");
const assignment = readFileSync(new URL("../supabase-assign-owner-app-role.sql", import.meta.url), "utf8");

// Statements only. These files are heavily commented, and a rule stated in prose must not be
// mistaken for a rule implemented in SQL.
function statementsOf(sql: string): string {
  return sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
}

const hardeningStatements = statementsOf(hardening);
const assignmentStatements = statementsOf(assignment);

const DOMAIN_TABLES = [
  "creative_jobs",
  "creative_job_attempts",
  "creative_packages",
  "asset_jobs",
  "asset_job_attempts",
  "assets",
  "asset_files",
];

// --- the claim is the same one the application reads --------------------------------------------------

test("the migration reads the SAME claim path the application authorizes on", () => {
  // OWNER_APP_ROLE_CLAIM_PATH is "app_metadata.app_role"; the SQL must walk exactly that.
  assert.equal(OWNER_APP_ROLE_CLAIM_PATH, "app_metadata.app_role");
  assert.match(hardeningStatements, /auth\.jwt\(\)\s*->\s*'app_metadata'\s*->>\s*'app_role'/);
  assert.match(hardeningStatements, new RegExp(`'${OWNER_APP_ROLE}'`));
});

test("user_metadata is never an authorization input in SQL either", () => {
  // user_metadata is writable by the user via supabase.auth.updateUser(). A policy reading it would
  // let any authenticated principal grant itself access from the browser.
  assert.equal(/user_metadata/.test(hardeningStatements), false);
  assert.equal(/user_metadata/.test(assignmentStatements), false);
});

test("no owner email, UUID or other identifier is baked into either SQL file", () => {
  const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  // A bare email address. The placeholders (REPLACE_WITH_...) contain no "@" and are not matched.
  const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

  for (const [name, sql] of [["hardening", hardening], ["assignment", assignment]] as const) {
    assert.equal(UUID.test(sql), false, `${name} must not contain a hardcoded UUID`);
    assert.equal(EMAIL.test(sql), false, `${name} must not contain a hardcoded email`);
  }

  // The assignment file asks the operator for the identifier instead.
  assert.match(assignment, /REPLACE_WITH_OWNER_EMAIL|REPLACE_WITH_EMAIL/);
});

test("no service-role credential is required or referenced", () => {
  for (const sql of [hardeningStatements, assignmentStatements]) {
    assert.equal(/service_role|SERVICE_ROLE|service-role key/i.test(sql), false);
  }
});

// --- coverage -----------------------------------------------------------------------------------------

test("every creative/production table loses its permissive policy and gains a claim-scoped one", () => {
  for (const table of DOMAIN_TABLES) {
    assert.match(
      hardeningStatements,
      new RegExp(`drop policy if exists "Authenticated users can manage [^"]+" on ${table};`),
      `${table} must have its permissive policy dropped`,
    );
    assert.match(
      hardeningStatements,
      new RegExp(`on ${table} for all\\s+to authenticated\\s+using \\(public\\.is_creative_domain_principal\\(\\)\\)\\s+with check \\(public\\.is_creative_domain_principal\\(\\)\\)`),
      `${table} must be scoped to the creative-domain claim on both read and write`,
    );
  }
});

test("the private generated-assets bucket is scoped to the same claim", () => {
  assert.match(hardeningStatements, /drop policy if exists "Authenticated users can manage generated asset files" on storage\.objects;/);
  assert.match(
    hardeningStatements,
    /on storage\.objects for all\s+to authenticated\s+using \(bucket_id = 'generated-assets' and public\.is_creative_domain_principal\(\)\)\s+with check \(bucket_id = 'generated-assets' and public\.is_creative_domain_principal\(\)\)/,
  );
});

test("the claim helpers fail closed and cannot be search_path-captured", () => {
  // NULL claim -> NULL/false, never a grant.
  assert.match(hardeningStatements, /create or replace function public\.current_app_role\(\)/);
  assert.match(hardeningStatements, /create or replace function public\.is_creative_domain_principal\(\)/);
  // Every helper is stable, invoker-rights, and pins search_path.
  const helpers = hardeningStatements.match(/create or replace function public\.\w+\(\)[\s\S]*?\$\$/g) ?? [];
  assert.equal(helpers.length, 3, "expected exactly three claim helpers");
  for (const helper of helpers) {
    assert.match(helper, /security invoker/);
    assert.match(helper, /set search_path = ''/);
    assert.match(helper, /stable/);
  }
});

// --- blast radius -------------------------------------------------------------------------------------

test("public ordering is not touched", () => {
  // The brief is explicit: do not alter public-order behaviour unrelated to this boundary.
  for (const table of ["customers", "orders", "order_lines"]) {
    assert.equal(new RegExp(`on ${table}\\b`).test(hardeningStatements), false, `${table} must not be modified`);
  }
  assert.equal(/save_order|public_order/.test(hardeningStatements), false);
});

test("unrelated storage and unrelated Product Lab tables are not touched", () => {
  // batch-photos is a separate policy on the same storage.objects table and a different domain.
  assert.equal(/batch-photos/.test(hardeningStatements), false);
  for (const table of ["products", "product_batches", "costing_entries", "ingredients", "content_journal", "content_drafts", "opportunities", "brand_profiles"]) {
    assert.equal(new RegExp(`on ${table}\\b`).test(hardeningStatements), false, `${table} is pre-existing RLS debt and is out of this slice`);
  }
});

test("no table, column, index, grant or row is destroyed -- policies and functions only", () => {
  assert.equal(/drop table|drop column|alter table \w+ drop|truncate|delete from/i.test(hardeningStatements), false);
  assert.equal(/revoke/i.test(hardeningStatements), false, "grants are left in place; RLS is what enforces identity");
  // The only drops are policy drops.
  const drops = hardeningStatements.match(/drop \w+/gi) ?? [];
  for (const drop of drops) {
    assert.match(drop.toLowerCase(), /drop policy/);
  }
});

// --- operability --------------------------------------------------------------------------------------

test("the migration is idempotent and self-verifying", () => {
  assert.match(hardeningStatements, /create or replace function/);
  assert.match(hardeningStatements, /drop policy if exists/);
  // A preflight that refuses to run against an unexpected shape, and a postflight that asserts the
  // result rather than trusting it -- the convention every other migration in this repo follows.
  assert.match(hardeningStatements, /raise exception 'Table public\.% does not exist/);
  assert.match(hardeningStatements, /raise exception 'Hardening incomplete/);
});

test("both files document the rollback and the token-refresh requirement", () => {
  assert.match(hardening, /ROLLBACK/);
  assert.match(assignment, /REFRESH TOKENS\. THIS IS REQUIRED, NOT OPTIONAL\./);
  // The ordering trap: assigning claims must happen BEFORE the policies tighten, or the workers
  // stop. The file has to say so.
  assert.match(hardening, /Run supabase-assign-owner-app-role\.sql FIRST/);
});

test("the worker service claim is separate from the owner claim, and documented as such", () => {
  // One owner identity; the automation principal gets a strictly narrower, differently-named claim
  // so that it can keep writing Assets without being able to open the owner UI.
  assert.match(hardeningStatements, /'owner', 'creative_worker'/);
  assert.match(hardeningStatements, /public\.is_product_lab_owner\(\)/);
  assert.match(assignment, /Do NOT assign 'owner' to the worker account/);
  // And the assignment script refuses any other value.
  assert.match(assignmentStatements.length > 0 ? assignment : assignment, /not in \('owner', 'creative_worker'\)/);
});
