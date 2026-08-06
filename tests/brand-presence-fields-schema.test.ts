import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Static/text checks against the migration file itself, matching this repo's existing
// schema-test convention (see tests/brand-profiles-schema.test.ts,
// tests/brand-foundation-fields-schema.test.ts). No live-database harness exists here.
const sql = readFileSync(new URL("../supabase-add-brand-presence-fields.sql", import.meta.url), "utf8");

test("adds exactly the eleven Brand Presence columns, idempotently, all plain text", () => {
  for (const column of [
    "website_url text",
    "email text",
    "preferred_handle text",
    "facebook_handle text",
    "facebook_url text",
    "instagram_handle text",
    "instagram_url text",
    "tiktok_handle text",
    "tiktok_url text",
    "youtube_handle text",
    "youtube_url text",
  ]) {
    assert.match(sql, new RegExp(`alter table brand_profiles add column if not exists ${column};`));
  }
});

test("no column has a default value -- nothing is invented, every field starts unset", () => {
  assert.doesNotMatch(sql, /default/i);
});

test("stores handle and url separately for every social platform -- never assumes a URL format", () => {
  for (const platform of ["facebook", "instagram", "tiktok", "youtube"]) {
    assert.match(sql, new RegExp(`${platform}_handle text`));
    assert.match(sql, new RegExp(`${platform}_url text`));
  }
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

test("does not add follower-count, analytics, posting, or scheduling columns -- out of scope", () => {
  for (const outOfScope of ["follower", "analytic", "post_", "schedul", "engagement"]) {
    assert.doesNotMatch(sql, new RegExp(outOfScope, "i"));
  }
});
