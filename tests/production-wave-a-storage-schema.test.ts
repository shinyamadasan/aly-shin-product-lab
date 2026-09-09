import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Static assertions over the two Production MVP Wave A SQL files. Mirrors the existing
// asset-storage-schema.test.ts convention exactly: read the file, strip comment lines when asserting
// about STATEMENTS, and assert on text rather than on a database. Nothing here connects to Supabase,
// and neither file has been applied.
const videoSql = readFileSync(new URL("../supabase-add-generated-assets-video.sql", import.meta.url), "utf8");
const verifySql = readFileSync(new URL("../verify-production-wave-a-storage.sql", import.meta.url), "utf8");

const videoStatements = videoSql
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n");
const verifyStatements = verifySql
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n");

// Reviewer finding P2-3. The precondition previously used `raise warning`, which is the only such
// use anywhere in this repo's SQL and lands in the SQL Editor's notices pane -- where a no-op update
// reads as success. Every other precondition guard here (supabase-add-asset-files.sql,
// supabase-add-asset-job-attempts.sql) uses `raise exception`, and so does this one now.
test("the video migration fails loudly when the generated-assets bucket is absent", () => {
  assert.match(videoStatements, /raise exception 'generated-assets bucket does not exist\./i);
  assert.doesNotMatch(videoStatements, /raise warning/i);
});

test("the missing-bucket precondition runs BEFORE the update it guards", () => {
  const preconditionIndex = videoStatements.indexOf("raise exception");
  const updateIndex = videoStatements.indexOf("update storage.buckets");

  assert.notEqual(preconditionIndex, -1);
  assert.notEqual(updateIndex, -1);
  assert.equal(preconditionIndex < updateIndex, true, "the precondition must abort before any write is attempted");
});

test("the video migration adds video/mp4 and the 50 MB limit without disturbing the image contract", () => {
  // Addition, not replacement: every Asset ever produced is a PNG/JPEG/WebP.
  assert.match(videoStatements, /allowed_mime_types = array\['image\/png', 'image\/jpeg', 'image\/webp', 'video\/mp4'\]/i);
  assert.match(videoStatements, /file_size_limit = 52428800/i);
  assert.match(videoStatements, /where id = 'generated-assets'/i);
});

test("the video migration is config-only: it never creates the bucket, touches policies, or changes visibility", () => {
  // The bucket, its visibility and its policy belong to supabase-add-generated-assets-storage.sql.
  assert.doesNotMatch(videoStatements, /insert into storage\.buckets/i);
  assert.doesNotMatch(videoStatements, /create policy|drop policy|alter policy/i);
  assert.doesNotMatch(videoStatements, /public = true|to anon|to public/i);
  assert.doesNotMatch(videoStatements, /create table|alter table|drop table|create index/i);
  assert.doesNotMatch(videoStatements, /insert into (?!storage\.buckets)|delete from|truncate/i);
});

test("the video migration remains idempotent: an absolute assignment, never an append", () => {
  // array_append/array_cat would make a second run produce a different row.
  assert.doesNotMatch(videoStatements, /array_append|array_cat|\|\|\s*array\[/i);
  assert.equal((videoStatements.match(/update storage\.buckets/gi) ?? []).length, 1);
});

test("the Wave A storage verification script is strictly read-only", () => {
  for (const forbidden of [
    /\binsert\s+into\b/i,
    /\bupdate\s+\w/i,
    /\bdelete\s+from\b/i,
    /\btruncate\b/i,
    /\bcreate\s+(table|policy|index|function|bucket)\b/i,
    /\balter\b/i,
    /\bdrop\b/i,
    /\bgrant\b/i,
    /\brevoke\b/i,
    /raise\s+(exception|warning|notice)/i,
  ]) {
    assert.doesNotMatch(verifyStatements, forbidden, `verification script must not contain ${forbidden}`);
  }
});

test("the verification script checks visibility, both MIME families, and the size limit", () => {
  assert.match(verifySql, /public\s*=\s*false/i);
  assert.match(verifySql, /'video\/mp4'/i);
  assert.match(verifySql, /'image\/png'/i);
  assert.match(verifySql, /'image\/jpeg'/i);
  assert.match(verifySql, /'image\/webp'/i);
  assert.match(verifySql, /52428800/);
});
