import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const sql = readFileSync(new URL("../supabase-add-asset-files.sql", import.meta.url), "utf8");
const sqlStatementsOnly = sql
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n");
const createTableStatement = sqlStatementsOnly.match(/create table if not exists asset_files \(([\s\S]*?)\);/i)?.[0] ?? "";
const columnBody = createTableStatement.match(/create table if not exists asset_files \(([\s\S]*?)\);/i)?.[1] ?? "";
const guardStatements = Array.from(sqlStatementsOnly.matchAll(/do \$\$[\s\S]*?end \$\$;/gi), (match) => match[0]);
const staleTableGuardStatement = guardStatements[0] ?? "";
const indexGuardStatement = guardStatements[1] ?? "";

test("asset_files creates the approved foundation table with required columns", () => {
  assert.match(sql, /create table if not exists asset_files \(/);
  for (const requiredColumn of [
    "id uuid primary key default gen_random_uuid()",
    "asset_id uuid not null references assets(id) on delete cascade",
    "position integer not null default 0",
    "storage_bucket text not null",
    "storage_path text not null",
    "public_url text not null",
    "mime_type text not null",
    "file_size_bytes integer not null",
    "width integer",
    "height integer",
    "duration_ms integer",
    "checksum_sha256 text",
    "created_at timestamptz not null default now()",
  ]) {
    assert.ok(sql.includes(requiredColumn), `missing column: ${requiredColumn}`);
  }
});

test("asset_files enforces one row per position within an Asset, supporting multi-file kinds later", () => {
  assert.match(sql, /create unique index if not exists asset_files_asset_id_position_idx\s*\n\s*on asset_files \(asset_id, position\);/);
});

test("asset_files has no Supabase Storage bucket, policy, or upload code -- that is a later, separate milestone", () => {
  assert.doesNotMatch(sqlStatementsOnly, /storage\.buckets/i);
  assert.doesNotMatch(sqlStatementsOnly, /storage\.objects/i);
  assert.doesNotMatch(sqlStatementsOnly, /insert into storage/i);
});

test("asset_files has no lifecycle/status column of its own -- it is an immutable, append-only child of its Asset", () => {
  assert.doesNotMatch(columnBody, /^\s*status\s+text\b/im);
  assert.match(staleTableGuardStatement, /'status'/i);
});

test("asset_files fails loudly instead of silently accepting stale draft schemas and indexes", () => {
  assert.match(staleTableGuardStatement, /pg_attribute/i);
  assert.match(staleTableGuardStatement, /format_type/i);
  assert.match(staleTableGuardStatement, /attnotnull/i);
  for (const requiredColumn of ["id", "asset_id", "position", "storage_bucket", "storage_path", "public_url", "mime_type", "file_size_bytes", "width", "height", "duration_ms", "checksum_sha256", "created_at"]) {
    assert.match(staleTableGuardStatement, new RegExp(`'${requiredColumn}'`, "i"));
  }
  for (const disallowedColumn of ["status", "provider", "model", "approved_at", "rejected_at"]) {
    assert.match(staleTableGuardStatement, new RegExp(`'${disallowedColumn}'`, "i"));
  }
  assert.match(staleTableGuardStatement, /contype = 'p'/i);
  assert.match(staleTableGuardStatement, /contype = 'f'/i);
  assert.match(staleTableGuardStatement, /confdeltype = 'c'/i);
  assert.match(staleTableGuardStatement, /raise exception/i);
  assert.match(indexGuardStatement, /asset_files_asset_id_position_idx/i);
  assert.match(indexGuardStatement, /raise exception/i);
  assert.doesNotMatch(sqlStatementsOnly, /drop\s+column/i);
  assert.doesNotMatch(sqlStatementsOnly, /alter table asset_files\s+drop/i);
});

test("asset_files follows existing RLS and authenticated grant conventions", () => {
  assert.match(sql, /alter table asset_files enable row level security;/);
  assert.match(sql, /grant select, insert, update, delete on table asset_files to authenticated;/);
  assert.doesNotMatch(sql, /grant[^;]*asset_files[^;]*to (anon|public)/i);
  assert.match(sql, /create policy "Authenticated users can manage asset files"/);
  assert.match(sql, /on asset_files for all\s*\n\s*to authenticated\s*\n\s*using \(true\)\s*\n\s*with check \(true\);/);
});

test("asset_files keeps everything app-validated, not DB-enforced", () => {
  assert.doesNotMatch(sqlStatementsOnly, /create type/i);
  assert.doesNotMatch(sqlStatementsOnly, /\benum\b/i);
  assert.doesNotMatch(columnBody, /check\s*\(/i);
});

test("asset_files does not create excluded future-domain tables or provider fields", () => {
  for (const excludedTable of ["approvals", "workers", "events", "publishing_jobs", "campaigns"]) {
    assert.doesNotMatch(sqlStatementsOnly, new RegExp(`create table[^;]*\\b${excludedTable}\\b`, "i"));
  }

  for (const providerColumn of ["openai", "gemini", "veo", "runway", "remotion", "provider", "model"]) {
    assert.doesNotMatch(columnBody, new RegExp(`\\b${providerColumn}\\b`, "i"));
  }
});
