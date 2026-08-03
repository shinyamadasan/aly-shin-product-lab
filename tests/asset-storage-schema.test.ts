import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const storageSql = readFileSync(new URL("../supabase-add-generated-assets-storage.sql", import.meta.url), "utf8");
const materializationSql = readFileSync(new URL("../supabase-add-asset-job-file-materialization.sql", import.meta.url), "utf8");
const storageStatements = storageSql
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n");
const materializationStatements = materializationSql
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n");

test("generated-assets storage migration creates a private image-only bucket with authenticated-only policy", () => {
  assert.match(storageSql, /insert into storage\.buckets \(id, name, public, file_size_limit, allowed_mime_types\)/i);
  assert.match(storageSql, /'generated-assets', 'generated-assets', false, 10485760/i);
  assert.match(storageSql, /array\['image\/png', 'image\/jpeg', 'image\/webp'\]/i);
  assert.match(storageSql, /public = false/i);
  assert.match(storageSql, /create policy "Authenticated users can manage generated asset files"/i);
  assert.match(storageSql, /to authenticated\s+using \(bucket_id = 'generated-assets'\)\s+with check \(bucket_id = 'generated-assets'\)/i);
  assert.doesNotMatch(storageStatements, /to anon|to public|public read|public-read/i);
});

test("asset job materialization RPC atomically completes the running job and materializes Asset plus Asset Files", () => {
  assert.match(materializationSql, /create or replace function complete_asset_job_with_files\(\s*p_asset_job_id uuid,\s*p_result jsonb,\s*p_files jsonb\s*\)/i);
  assert.match(materializationSql, /returns table \(\s*job jsonb,\s*asset jsonb,\s*files jsonb\s*\)/i);
  assert.match(materializationSql, /where id = p_asset_job_id\s+and status = 'running'\s+for update/i);
  assert.match(materializationSql, /update asset_jobs\s+set\s+status = 'completed'/i);
  assert.match(materializationSql, /insert into assets \(asset_job_id, status, asset_kind, schema_version, content, updated_at\)/i);
  assert.match(materializationSql, /on conflict \(asset_job_id\)/i);
  assert.match(materializationSql, /insert into asset_files/i);
  assert.match(materializationSql, /raise exception 'idempotency-conflict: Asset % for Asset Job % has incompatible immutable identity\.'/i);
  assert.match(materializationSql, /raise exception 'idempotency-conflict: Asset File at position % for Asset % has incompatible immutable identity\.'/i);
});

test("asset job materialization RPC explicitly revokes PUBLIC execute before granting authenticated execute", () => {
  assert.match(materializationStatements, /revoke execute on function public\.complete_asset_job_with_files\(uuid, jsonb, jsonb\) from public;/i);
  assert.match(materializationStatements, /grant execute on function public\.complete_asset_job_with_files\(uuid, jsonb, jsonb\) to authenticated;/i);
  assert.doesNotMatch(materializationStatements, /grant execute on function public\.complete_asset_job_with_files\(uuid, jsonb, jsonb\) to anon/i);
  assert.doesNotMatch(materializationStatements, /grant execute on function public\.complete_asset_job_with_files\(uuid, jsonb, jsonb\) to public/i);
  assert.match(materializationSql, /create or replace function complete_asset_job_with_files\(\s*p_asset_job_id uuid,\s*p_result jsonb,\s*p_files jsonb\s*\)/i);
});

test("asset job materialization RPC validates immutable identity before completing the Job", () => {
  const assetConflictIndex = materializationSql.indexOf("idempotency-conflict: Asset % for Asset Job");
  const fileConflictIndex = materializationSql.indexOf("idempotency-conflict: Asset File at position");
  const completeJobIndex = materializationSql.indexOf("update asset_jobs");

  assert.notEqual(assetConflictIndex, -1);
  assert.notEqual(fileConflictIndex, -1);
  assert.notEqual(completeJobIndex, -1);
  assert.equal(assetConflictIndex < completeJobIndex, true);
  assert.equal(fileConflictIndex < completeJobIndex, true);
  assert.doesNotMatch(materializationSql, /on conflict \(asset_id, position\) do update[\s\S]*where asset_files/i);
});

test("PROP-025 SQL is additive, Asset Job keyed, and has no Creative Job/provider/public-read coupling", () => {
  for (const sql of [storageStatements, materializationStatements]) {
    assert.doesNotMatch(sql, /alter table\s+(assets|asset_files|asset_jobs)\s+drop/i);
    assert.doesNotMatch(sql, /drop\s+table/i);
    assert.doesNotMatch(sql, /\bcreative_job_id\b/i);
    assert.doesNotMatch(sql, /\bprovider\b|\bmodel\b|openai|gemini|remotion/i);
  }
  assert.match(materializationStatements, /\basset_job_id\b/i);
});

test("existing shipped PROP-023/024 SQL files are not repurposed for Storage or complete_asset_job_with_files", () => {
  const shippedAssetsSql = readFileSync(new URL("../supabase-add-assets.sql", import.meta.url), "utf8");
  const shippedAssetFilesSql = readFileSync(new URL("../supabase-add-asset-files.sql", import.meta.url), "utf8");

  assert.doesNotMatch(shippedAssetsSql, /generated-assets|complete_asset_job_with_files|storage\.buckets/i);
  assert.doesNotMatch(shippedAssetFilesSql, /generated-assets|complete_asset_job_with_files|storage\.buckets/i);
});

test("PROP-025 implementation stays inside Asset Job and asset-worker boundaries", () => {
  const assetJobsSource = readFileSync(new URL("../src/lib/asset-jobs.ts", import.meta.url), "utf8");
  const materializationSource = readFileSync(new URL("../src/lib/asset-file-materialization.ts", import.meta.url), "utf8");
  const fixtureWorkerSource = readFileSync(new URL("../scripts/asset-workers/fixture-image-worker.ts", import.meta.url), "utf8");
  const creativeJobsSource = readFileSync(new URL("../src/lib/creative-jobs.ts", import.meta.url), "utf8");

  assert.doesNotMatch(assetJobsSource, /scripts\/creative-workers|fixture-image-provider|creative-workers/i);
  assert.doesNotMatch(materializationSource, /scripts\/creative-workers|fixture-image-provider|creative-workers/i);
  assert.doesNotMatch(fixtureWorkerSource, /scripts\/creative-workers|creative-jobs/i);
  assert.doesNotMatch(creativeJobsSource, /GeneratedAssetFileCandidate|complete_asset_job_with_files|generated-assets/i);
});
