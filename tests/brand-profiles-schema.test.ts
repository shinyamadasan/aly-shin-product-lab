import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// This repo has no live-database or pgTAP test harness (confirmed: no supabase/ CLI
// folder, every other migration is verified by hand in the Supabase SQL editor). These
// are static/text checks against the migration file itself, not a live schema -- they
// catch a future edit accidentally weakening RLS, dropping the single-active-profile
// guard, or reintroducing a field this milestone deliberately excluded.
const sql = readFileSync(new URL("../supabase-add-brand-profiles.sql", import.meta.url), "utf8");

test("brand_profiles enables row level security", () => {
  assert.match(sql, /alter table brand_profiles enable row level security;/);
});

test("brand_profiles grants CRUD to authenticated only, never anon or public", () => {
  assert.match(sql, /grant select, insert, update, delete on table brand_profiles to authenticated;/);
  assert.doesNotMatch(sql, /grant[^;]*brand_profiles[^;]*to (anon|public)/i);
});

test("brand_profiles has a for-all authenticated policy matching the rest of the schema", () => {
  assert.match(sql, /create policy "Authenticated users can manage brand profiles"/);
  assert.match(sql, /on brand_profiles for all\s*\n\s*to authenticated\s*\n\s*using \(true\)\s*\n\s*with check \(true\);/);
});

test("brand_profiles does not invent a per-user/workspace ownership column", () => {
  assert.doesNotMatch(sql, /\b(user_id|owner_id|workspace_id|tenant_id|account_id)\b/);
});

test("exactly one brand profile can be active at a time (partial unique index)", () => {
  assert.match(
    sql,
    /create unique index if not exists brand_profiles_only_one_active_idx\s*\n\s*on brand_profiles \(is_active\)\s*\n\s*where is_active = true;/,
  );
});

test("no provider secret, credential, or token column exists", () => {
  assert.doesNotMatch(sql, /\b(token|secret|api_key|apikey|password|credential)\b/i);
});

test("logo is stored as a path reference only, never binary data", () => {
  assert.match(sql, /logo_storage_path text/);
  assert.doesNotMatch(sql, /bytea/i);
});

test("this migration stays scoped to brand_profiles only -- no M2+ marketing tables", () => {
  for (const laterTable of [
    "campaigns",
    "campaign_products",
    "content_drafts",
    "content_assets",
    "content_calendar_entries",
    "publishing_jobs",
    "campaign_performance",
  ]) {
    assert.doesNotMatch(sql, new RegExp(`create table[^;]*\\b${laterTable}\\b`));
  }
});

test("id is a uuid primary key, matching every other table in this schema", () => {
  assert.match(sql, /id uuid primary key default gen_random_uuid\(\),/);
});

test("created_at/updated_at follow the existing timestamptz-default-now convention", () => {
  assert.match(sql, /created_at timestamptz not null default now\(\),/);
  assert.match(sql, /updated_at timestamptz not null default now\(\)/);
});
