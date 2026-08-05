import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

import { buildGeneratedAssetObjectPath, GENERATED_ASSETS_BUCKET, inspectAssetBytes } from "../../../src/lib/asset-binary.ts";
import { runAssetJobWithExecutors, type AssetJobExecutionClient } from "../../../src/lib/asset-jobs.ts";
import { fixtureImageAssetExecutor } from "../../../scripts/asset-workers/fixture-image-worker.ts";
import { loadEnvFile, readSupabaseCredentials } from "../../../scripts/daily-advisor/env.ts";
import {
  buildAssetStorageSmokeReport,
  confirmSmokeObjectPathAbsent,
  stringifyAssetStorageSmokeReport,
  type AssetStorageSmokeSummary,
} from "./storage-smoke-report.ts";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");

/*
PROP-025 live Storage smoke prerequisites:
- RUN_LIVE_ASSET_STORAGE_SMOKE=1.
- Supabase URL plus authenticated test-user credentials in the usual local advisor env file.
- LIVE_ASSET_JOB_ID pointing at a dedicated queued Asset Job for a ready Creative Package.
- Apply SQL first, in order:
  1. supabase-add-generated-assets-storage.sql
  2. supabase-add-asset-job-file-materialization.sql
- This smoke uses deterministic fixture bytes only. It does not call paid providers.

Bucket metadata is verified separately through privileged SQL. The authenticated application client
is intentionally exercised through runtime object operations instead of storage.buckets metadata
access: getBucket requires separate bucket SELECT permission that asset generation does not
otherwise need.

Cleanup is intentionally manual. The test prints a structured report with exact IDs and path.
Use only those exact values when cleaning up:
1. Delete the reported Asset File row, if direct cleanup is allowed by the live schema/RPC contract.
2. Delete the reported Asset row.
3. Delete/reset the reported dedicated Asset Job and attempt test records only if created for smoke.
4. Remove the exact reported generated-assets object path only when it was uploaded by this run.
5. Verify no matching rows or object remain.
*/

test("live Supabase Storage completes a fixture-byte Asset Job into a private generated asset", { skip: process.env.RUN_LIVE_ASSET_STORAGE_SMOKE !== "1" }, async () => {
  const summary: AssetStorageSmokeSummary = {
    assetJobId: process.env.LIVE_ASSET_JOB_ID ?? "",
    attemptId: null,
    assetId: null,
    assetFileId: null,
    storageBucket: null,
    storagePath: null,
    objectDisposition: "unknown",
    rowDisposition: "unknown",
  };

  function reportSmokeState(label: string) {
    console.info(`${label}\n${stringifyAssetStorageSmokeReport(buildAssetStorageSmokeReport(summary))}`);
  }

  loadEnvFile(path.join(PROJECT_ROOT, ".env.advisor.local"));
  const creds = readSupabaseCredentials();
  assert.equal(creds.ok, true);
  if (!creds.ok) return;

  const assetJobId = process.env.LIVE_ASSET_JOB_ID;
  assert.ok(assetJobId, "LIVE_ASSET_JOB_ID must point at a queued Asset Job for a ready Creative Package.");
  summary.assetJobId = assetJobId;

  const client = createClient(creds.credentials.url, creds.credentials.anonKey);
  const signIn = await client.auth.signInWithPassword({ email: creds.credentials.email, password: creds.credentials.password });
  assert.equal(signIn.error, null);

  try {
    const jobBeforeRun = await client.from("asset_jobs").select("attempt_count").eq("id", assetJobId).maybeSingle();
    assert.equal(jobBeforeRun.error, null);
    assert.ok(jobBeforeRun.data, "LIVE_ASSET_JOB_ID must still point at an Asset Job.");
    const [fixtureCandidate] = await fixtureImageAssetExecutor({} as never, { dimensions: { width: 1080, height: 1080 } } as never, { signal: new AbortController().signal });
    const fixtureInspection = inspectAssetBytes(fixtureCandidate.bytes);
    assert.equal(fixtureInspection.ok, true);
    if (!fixtureInspection.ok) return;
    const expectedStoragePath = buildGeneratedAssetObjectPath({
      assetJobId,
      attemptNumber: Number(jobBeforeRun.data.attempt_count) + 1,
      sha256: fixtureInspection.facts.sha256,
      extension: fixtureInspection.facts.extension,
    });
    const preflight = await confirmSmokeObjectPathAbsent(client, GENERATED_ASSETS_BUCKET, expectedStoragePath);
    assert.equal(preflight.ok, true, preflight.ok ? undefined : preflight.message);

    const result = await runAssetJobWithExecutors(client as unknown as AssetJobExecutionClient, assetJobId, { mock: fixtureImageAssetExecutor });
    if (result.attempt?.ok) summary.attemptId = result.attempt.attemptId;
    assert.equal(result.ok, true);
    if (!result.ok || !result.materialization?.ok) return;

    const materialization = result.materialization;
    summary.assetId = materialization.materialized.asset.id;
    summary.rowDisposition = materialization.outcome === "created" ? "created" : "reused";
    assert.equal(materialization.materialized.asset.assetJobId, assetJobId);
    assert.equal(materialization.materialized.files.length, 1);
    const file = materialization.materialized.files[0];
    summary.assetFileId = file.id;
    summary.storageBucket = file.storageBucket;
    summary.storagePath = file.storagePath;
    summary.objectDisposition = materialization.uploadedThisRun.includes(file.storagePath) ? "uploaded-this-run" : materialization.reusedExistingPaths.includes(file.storagePath) ? "reused-existing" : "unknown";
    assert.equal(file.storageBucket, GENERATED_ASSETS_BUCKET);
    assert.equal(file.mimeType, "image/png");

    const downloaded = await client.storage.from(GENERATED_ASSETS_BUCKET).download(file.storagePath);
    assert.equal(downloaded.error, null);
    assert.ok(downloaded.data);
    const downloadedBytes = new Uint8Array(await downloaded.data.arrayBuffer());
    const downloadedInspection = inspectAssetBytes(downloadedBytes);
    assert.equal(downloadedInspection.ok, true);
    if (!downloadedInspection.ok) return;
    assert.equal(downloadedInspection.facts.actualMimeType, file.mimeType);
    assert.equal(downloadedInspection.facts.actualWidth, file.width);
    assert.equal(downloadedInspection.facts.actualHeight, file.height);
    assert.equal(downloadedInspection.facts.byteSize, file.fileSizeBytes);
    assert.equal(downloadedInspection.facts.sha256, file.checksumSha256);

    const publicUrl = client.storage.from(GENERATED_ASSETS_BUCKET).getPublicUrl(file.storagePath);
    const anonymousFetch = await fetch(publicUrl.data.publicUrl);
    assert.notEqual(anonymousFetch.status, 200);
    reportSmokeState("PROP-025 live Storage smoke summary and manual cleanup checklist:");
  } catch (err) {
    reportSmokeState("PROP-025 live Storage smoke failed. Known IDs/paths and manual cleanup checklist:");
    throw err;
  }
});
