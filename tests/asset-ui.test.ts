import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { listAssetJobsForCreativePackage, type AssetJobClient, type AssetJobRow } from "../src/lib/asset-jobs.ts";
import { createSignedUrlForAssetFile, ASSET_FILE_SIGNED_URL_EXPIRES_IN_SECONDS, GENERATED_ASSETS_SIGNED_URL_BUCKET, type AssetFileUrlClient } from "../src/lib/asset-file-urls.ts";
import type { AssetFileRecord, AssetFileRow } from "../src/lib/asset-files.ts";
import { listAssetJobsForCreativePackageReadOnly, listOrderedAssetFilesForAssetReadOnly, type AssetReadClient } from "../src/lib/asset-read-model.ts";
import { createAssetUiRequestCoordinator, shouldStartAutomaticImageRetry } from "../src/lib/asset-ui-request-coordinator.ts";

function assetJobRow(overrides: Partial<AssetJobRow> = {}): AssetJobRow {
  return {
    id: "asset-job-1",
    creative_package_id: "package-1",
    status: "completed",
    worker_type: "mock",
    asset_kind: "image",
    attempt_count: 1,
    result: {},
    last_error: null,
    created_at: "2026-08-03T10:00:00.000Z",
    updated_at: "2026-08-03T10:00:00.000Z",
    started_at: "2026-08-03T10:00:01.000Z",
    completed_at: "2026-08-03T10:00:02.000Z",
    failed_at: null,
    ...overrides,
  };
}

function assetFile(overrides: Partial<AssetFileRecord> = {}): AssetFileRecord {
  return {
    id: "file-1",
    assetId: "asset-1",
    position: 0,
    storageBucket: GENERATED_ASSETS_SIGNED_URL_BUCKET,
    storagePath: "asset-jobs/job-1/attempt-1/hash.png",
    publicUrl: "",
    mimeType: "image/png",
    fileSizeBytes: 100,
    width: 1024,
    height: 1024,
    durationMs: null,
    checksumSha256: "hash",
    createdAt: "2026-08-03T10:00:03.000Z",
    ...overrides,
  };
}

test("PROP-026 lists all Asset Jobs for one Creative Package by created_at DESC then id DESC", async () => {
  const orderCalls: Array<{ column: string; ascending: boolean }> = [];
  const eqCalls: Array<{ column: string; value: string }> = [];
  const rows = [
    assetJobRow({ id: "job-c", created_at: "2026-08-03T10:02:00.000Z" }),
    assetJobRow({ id: "job-b", created_at: "2026-08-03T10:02:00.000Z" }),
    assetJobRow({ id: "job-a", created_at: "2026-08-03T10:01:00.000Z" }),
  ];
  const query = {
    eq(column: string, value: string) {
      eqCalls.push({ column, value });
      return this;
    },
    order(column: string, options: { ascending: boolean }) {
      orderCalls.push({ column, ascending: options.ascending });
      return this;
    },
    then(resolve: (value: { data: AssetJobRow[]; error: null }) => void) {
      resolve({ data: rows, error: null });
    },
  };
  const client = {
    from(table: "asset_jobs") {
      assert.equal(table, "asset_jobs");
      return {
        select(columns: string) {
          assert.equal(columns, "*");
          return query;
        },
      };
    },
  } as unknown as AssetJobClient;

  const result = await listAssetJobsForCreativePackage(client, "package-1");

  assert.deepEqual(eqCalls, [{ column: "creative_package_id", value: "package-1" }]);
  assert.deepEqual(orderCalls, [
    { column: "created_at", ascending: false },
    { column: "id", ascending: false },
  ]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.ok ? result.jobs.map((job) => job.id) : [], ["job-c", "job-b", "job-a"]);
});

test("PROP-026 signs only generated-assets files for five minutes and never persists URLs", async () => {
  const calls: Array<{ bucket: string; path: string; expiresIn: number }> = [];
  const client: AssetFileUrlClient = {
    storage: {
      from(bucket) {
        return {
          createSignedUrl(path, expiresIn) {
            calls.push({ bucket, path, expiresIn });
            return Promise.resolve({ data: { signedUrl: `signed://${path}` }, error: null });
          },
        };
      },
    },
  };
  const file = assetFile();

  const result = await createSignedUrlForAssetFile(client, file);

  assert.deepEqual(calls, [{ bucket: GENERATED_ASSETS_SIGNED_URL_BUCKET, path: file.storagePath, expiresIn: ASSET_FILE_SIGNED_URL_EXPIRES_IN_SECONDS }]);
  assert.deepEqual(result, { ok: true, signedUrl: `signed://${file.storagePath}`, expiresInSeconds: 300 });
  assert.equal(file.publicUrl, "");
});

test("PROP-026 refuses to sign non generated-assets files and does not call Storage", async () => {
  const client = {
    storage: {
      from() {
        throw new Error("Storage should not be called for unsupported buckets.");
      },
    },
  } as unknown as AssetFileUrlClient;

  const result = await createSignedUrlForAssetFile(client, assetFile({ storageBucket: "mock" }));

  assert.equal(result.ok, false);
  assert.equal(result.ok ? "" : result.reason, "unsupported-bucket");
});

test("PROP-026 component keeps Asset UI focused, read-only, and driven by Asset Job -> Asset -> Asset Files", () => {
  const component = readFileSync("src/components/creative-package-assets.tsx", "utf8");
  const page = readFileSync("src/components/opportunities-page.tsx", "utf8");

  assert.match(page, /<CreativePackageAssets creativePackageId=\{selectedPackage\.id\} \/>/);
  assert.doesNotMatch(page, /listAssetJobsForCreativePackage|createSignedUrlForAssetFile|listOrderedAssetFilesForAsset|readAssetForAssetJob/);
  assert.match(component, /listAssetJobsForCreativePackageReadOnly/);
  assert.match(component, /readAssetForAssetJobReadOnly/);
  assert.match(component, /listOrderedAssetFilesForAssetReadOnly/);
  assert.match(component, /createSignedUrlForAssetFile/);
  assert.match(component, /open=\{index === 0\}/);
  assert.match(component, /Fixture\/mock output/);
  assert.match(component, /Technical details/);
  assert.match(component, /Refresh Asset Jobs/);
  assert.match(component, /Refresh signed URLs/);
  assert.match(component, /No Asset Jobs have been created for this Creative Package yet\./);
  assert.match(component, /No Asset has been materialized yet\./);
  assert.match(component, /This Asset has no Asset Files yet\./);
  assert.match(component, /Image could not be loaded after one automatic signed URL refresh\./);
  assert.match(component, /requestCoordinator\.current\.beginMetadata\(\)/);
  assert.match(component, /requestCoordinator\.current\.isCurrentMetadata\(requestVersion\)/);
  assert.match(component, /requestCoordinator\.current\.beginSignedUrl\(key\)/);
  assert.match(component, /requestCoordinator\.current\.isCurrentSignedUrl\(key, requestVersion\)/);
  assert.match(component, /requestCoordinator\.current\.unmount\(\)/);
  assert.doesNotMatch(component, /createAssetJobForReadyCreativePackage|runAssetJob|runMockAssetJob|runAssetJobWithExecutors|approve|reject|publish|asset_job_attempts|\.from\("asset_job_attempts"\)|storage\.list|\.list\(/);
  assert.doesNotMatch(component, /provider[A-Z]|\bprovider:|\bmodel[A-Z]|\bmodel:/);
});

test("PROP-026 metadata request versions ignore a slower first refresh after a newer refresh starts", () => {
  const coordinator = createAssetUiRequestCoordinator();
  const slowFirst = coordinator.beginMetadata();
  const fastSecond = coordinator.beginMetadata();

  assert.equal(coordinator.isCurrentMetadata(fastSecond), true);
  assert.equal(coordinator.isCurrentMetadata(slowFirst), false);
});

test("PROP-026 signed URL request versions are per-file and ignore stale same-file responses", () => {
  const coordinator = createAssetUiRequestCoordinator();
  const staleFileA = coordinator.beginSignedUrl("file-a");
  const currentFileB = coordinator.beginSignedUrl("file-b");
  const currentFileA = coordinator.beginSignedUrl("file-a");

  assert.equal(coordinator.isCurrentSignedUrl("file-a", staleFileA), false);
  assert.equal(coordinator.isCurrentSignedUrl("file-a", currentFileA), true);
  assert.equal(coordinator.isCurrentSignedUrl("file-b", currentFileB), true);
});

test("PROP-026 unmount invalidates in-flight metadata and signed URL requests", () => {
  const coordinator = createAssetUiRequestCoordinator();
  const metadata = coordinator.beginMetadata();
  const fileA = coordinator.beginSignedUrl("file-a");
  const fileB = coordinator.beginSignedUrl("file-b");

  coordinator.unmount();

  assert.equal(coordinator.isCurrentMetadata(metadata), false);
  assert.equal(coordinator.isCurrentSignedUrl("file-a", fileA), false);
  assert.equal(coordinator.isCurrentSignedUrl("file-b", fileB), false);
});

test("PROP-026 automatic image retry is one-shot, while manual signing can still start later", () => {
  const coordinator = createAssetUiRequestCoordinator();
  assert.equal(shouldStartAutomaticImageRetry(undefined), true);
  assert.equal(shouldStartAutomaticImageRetry({ autoRetried: false, isLoading: false }), true);
  assert.equal(shouldStartAutomaticImageRetry({ autoRetried: true, isLoading: false }), false);
  assert.equal(shouldStartAutomaticImageRetry({ autoRetried: false, isLoading: true }), false);

  const automaticRetry = coordinator.beginSignedUrl("file-a");
  assert.equal(coordinator.isCurrentSignedUrl("file-a", automaticRetry), true);
  const manualRefresh = coordinator.beginSignedUrl("file-a");
  assert.equal(coordinator.isCurrentSignedUrl("file-a", automaticRetry), false);
  assert.equal(coordinator.isCurrentSignedUrl("file-a", manualRefresh), true);
});

test("PROP-026 read model preserves sorted Job visibility and ordered Asset Files", async () => {
  const orderCalls: Array<{ table: string; column: string; ascending: boolean }> = [];
  const rows = [
    assetJobRow({ id: "newer-completed", status: "completed", created_at: "2026-08-03T10:02:00.000Z" }),
    assetJobRow({ id: "newer-failed", status: "failed", created_at: "2026-08-03T10:02:00.000Z", last_error: "Provider unavailable" }),
    assetJobRow({ id: "older-completed", status: "completed", created_at: "2026-08-03T10:01:00.000Z" }),
  ];
  const files: AssetFileRow[] = [
    {
      id: "file-0",
      asset_id: "asset-1",
      position: 0,
      storage_bucket: GENERATED_ASSETS_SIGNED_URL_BUCKET,
      storage_path: "asset-jobs/job-1/attempt-1/hash-0.png",
      public_url: "",
      mime_type: "image/png",
      file_size_bytes: 100,
      width: 1024,
      height: 1024,
      duration_ms: null,
      checksum_sha256: "hash-0",
      created_at: "2026-08-03T10:00:03.000Z",
    },
    {
      id: "file-1",
      asset_id: "asset-1",
      position: 1,
      storage_bucket: GENERATED_ASSETS_SIGNED_URL_BUCKET,
      storage_path: "asset-jobs/job-1/attempt-1/hash-1.png",
      public_url: "",
      mime_type: "image/png",
      file_size_bytes: 100,
      width: 1024,
      height: 1024,
      duration_ms: null,
      checksum_sha256: "hash-1",
      created_at: "2026-08-03T10:00:04.000Z",
    },
  ];
  const client = {
    from(table: "asset_jobs" | "asset_files") {
      if (table === "asset_jobs") {
        const query = {
          eq() {
            return this;
          },
          order(column: string, options: { ascending: boolean }) {
            orderCalls.push({ table, column, ascending: options.ascending });
            return this;
          },
          then(resolve: (value: { data: AssetJobRow[]; error: null }) => void) {
            resolve({ data: rows, error: null });
          },
        };
        return { select: () => query };
      }

      const query = {
        eq() {
          return this;
        },
        order(column: string, options: { ascending: boolean }) {
          orderCalls.push({ table, column, ascending: options.ascending });
          return this;
        },
        then(resolve: (value: { data: AssetFileRow[]; error: null }) => void) {
          resolve({ data: files, error: null });
        },
      };
      return { select: () => query };
    },
  } as unknown as AssetReadClient;

  const jobsResult = await listAssetJobsForCreativePackageReadOnly(client, "package-1");
  const filesResult = await listOrderedAssetFilesForAssetReadOnly(client, "asset-1");

  assert.equal(jobsResult.ok, true);
  assert.deepEqual(jobsResult.ok ? jobsResult.jobs.map((job) => `${job.id}:${job.status}`) : [], [
    "newer-completed:completed",
    "newer-failed:failed",
    "older-completed:completed",
  ]);
  assert.equal(filesResult.ok, true);
  assert.deepEqual(filesResult.ok ? filesResult.files.map((file) => file.position) : [], [0, 1]);
  assert.deepEqual(orderCalls, [
    { table: "asset_jobs", column: "created_at", ascending: false },
    { table: "asset_jobs", column: "id", ascending: false },
    { table: "asset_files", column: "position", ascending: true },
  ]);
});
