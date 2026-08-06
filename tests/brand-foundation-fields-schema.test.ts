import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Static/text checks against the migration file itself, matching this repo's existing
// schema-test convention (see tests/brand-profiles-schema.test.ts) -- no live-database
// harness exists here. These catch a future edit accidentally widening this deliberately
// small MVP (adding a table, a Storage bucket, or an ownership column it doesn't need).
const sql = readFileSync(new URL("../supabase-add-brand-foundation-fields.sql", import.meta.url), "utf8");

test("adds exactly the four MVP columns, idempotently", () => {
  for (const column of ["brand_status text", "background_color text", "accent_color text", "brand_guidelines text"]) {
    assert.match(sql, new RegExp(`alter table brand_profiles add column if not exists ${column}`));
  }
});

test("brand_status defaults to Exploring, not an invented value", () => {
  assert.match(sql, /brand_status text not null default 'Exploring';/);
});

test("no hex value is seeded for background_color or accent_color -- stays unset until chosen in the UI", () => {
  assert.doesNotMatch(sql, /background_color text[^;]*default/);
  assert.doesNotMatch(sql, /accent_color text[^;]*default/);
  assert.doesNotMatch(sql, /#[0-9a-fA-F]{6}/);
});

test("does not create any new table", () => {
  assert.doesNotMatch(sql, /create table/i);
});

test("does not touch Supabase Storage -- no bucket, no storage.objects policy", () => {
  assert.doesNotMatch(sql, /storage\.(buckets|objects)/);
});

test("does not invent a per-user/workspace ownership column", () => {
  assert.doesNotMatch(sql, /\b(user_id|owner_id|workspace_id|tenant_id|account_id)\b/);
});

test("does not add any asset-upload, typography, or brand-voice column out of MVP scope", () => {
  for (const outOfScope of ["logo_url", "profile_picture", "cover_photo", "heading_font", "body_font", "social_links", "brand_voice", "primary_cta"]) {
    assert.doesNotMatch(sql, new RegExp(outOfScope, "i"));
  }
});
