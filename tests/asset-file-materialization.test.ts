import test from "node:test";
import assert from "node:assert/strict";

import { validateAssetCandidateBytes } from "../src/lib/asset-binary.ts";
import { GENERATED_ASSETS_BUCKET } from "../src/lib/asset-binary.ts";
import { materializeAssetJobFiles, type AssetJobFileMaterializationClient } from "../src/lib/asset-file-materialization.ts";
import type { AssetJobRecord } from "../src/lib/asset-jobs.ts";
import type { GeneratedAssetFileCandidate } from "../src/lib/asset-generation-validation.ts";
import type { AssetRow } from "../src/lib/assets.ts";
import type { AssetFileRow } from "../src/lib/asset-files.ts";

const fixedNow = "2026-08-03T10:00:00.000Z";
const png1080 = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d,
  0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x04, 0x38,
  0x00, 0x00, 0x04, 0x38,
  0x08, 0x04, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00,
]);
const changedPng1080 = new Uint8Array([...png1080.slice(0, -1), 1]);

const job: AssetJobRecord = {
  id: "asset-job-1",
  creativePackageId: "package-1",
  status: "running",
  workerType: "mock",
  assetKind: "image",
  attemptCount: 1,
  result: {},
  lastError: "",
  createdAt: fixedNow,
  updatedAt: fixedNow,
  startedAt: fixedNow,
  completedAt: "",
  failedAt: "",
};

function candidate(bytes = png1080): GeneratedAssetFileCandidate {
  return {
    position: 0,
    mimeType: "image/png",
    width: 1080,
    height: 1080,
    durationMs: null,
    fileSizeBytes: bytes.length,
    bytes,
  };
}

function inspected(bytes = png1080) {
  const result = validateAssetCandidateBytes(candidate(bytes));
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("Expected valid inspected candidate.");
  return result.inspected;
}

function makeClient(
  options: {
    uploadErrorAt?: number;
    rpcError?: string;
    removeError?: boolean;
    existing?: Record<string, Uint8Array>;
    rpcFileOverride?: Partial<AssetFileRow>;
    existingAssetOverride?: Partial<AssetRow>;
    existingFileOverride?: Partial<AssetFileRow>;
  } = {},
) {
  const objects = new Map(Object.entries(options.existing ?? {}));
  const events: string[] = [];
  const removed: string[] = [];
  const assets: AssetRow[] = [];
  const files: AssetFileRow[] = [];
  let jobStatus: "running" | "completed" = "running";
  let uploadCalls = 0;

  const client: AssetJobFileMaterializationClient = {
    storage: {
      from(bucket) {
        assert.equal(bucket, GENERATED_ASSETS_BUCKET);
        return {
          async upload(path, body, uploadOptions) {
            uploadCalls += 1;
            events.push(`upload:${path}`);
            assert.equal(uploadOptions.upsert, false);
            if (options.uploadErrorAt === uploadCalls) {
              return { data: null, error: { message: "upload failed" } };
            }
            if (objects.has(path)) {
              return { data: null, error: { statusCode: "409", message: "The resource already exists" } };
            }
            objects.set(path, body);
            return { data: { path }, error: null };
          },
          async download(path) {
            events.push(`download:${path}`);
            const data = objects.get(path);
            return data ? { data, error: null } : { data: null, error: { message: "not found" } };
          },
          async remove(paths) {
            events.push(`remove:${paths.join(",")}`);
            if (options.removeError) {
              return { data: null, error: { message: "remove failed" } };
            }
            for (const path of paths) {
              objects.delete(path);
              removed.push(path);
            }
            return { data: [], error: null };
          },
        };
      },
    },
    rpc(functionName, args) {
      assert.equal(functionName, "complete_asset_job_with_files");
      return {
        async maybeSingle() {
          events.push("rpc:complete_asset_job_with_files");
          if (options.rpcError) {
            return { data: null, error: { message: options.rpcError } };
          }
          const file = args.p_files[0];
          const expectedAssetContent = { metadata: { generatedFromCreativePackage: "package-1", sourceAssetJobId: args.p_asset_job_id, generatorVersion: "1" } };
          const asset: AssetRow = {
            id: "asset-1",
            asset_job_id: args.p_asset_job_id,
            status: "generated",
            asset_kind: "image",
            schema_version: "v1",
            content: expectedAssetContent,
            created_at: fixedNow,
            updated_at: fixedNow,
            ...options.existingAssetOverride,
          };
          const existingAsset = assets[0] ?? asset;
          const existingAssetMatches =
            existingAsset.asset_job_id === args.p_asset_job_id &&
            existingAsset.status === "generated" &&
            existingAsset.asset_kind === "image" &&
            existingAsset.schema_version === "v1" &&
            JSON.stringify(existingAsset.content) === JSON.stringify(expectedAssetContent);
          if (!existingAssetMatches) {
            return { data: null, error: { message: "idempotency-conflict: incompatible Asset identity" } };
          }
          const row: AssetFileRow = {
            id: "file-1",
            asset_id: existingAsset.id ?? "asset-1",
            position: Number(file.position),
            storage_bucket: String(file.storage_bucket),
            storage_path: String(file.storage_path),
            public_url: String(file.public_url),
            mime_type: String(file.mime_type),
            file_size_bytes: Number(file.file_size_bytes),
            width: Number(file.width),
            height: Number(file.height),
            duration_ms: null,
            checksum_sha256: String(file.checksum_sha256),
            created_at: fixedNow,
            ...options.rpcFileOverride,
          };
          const existingFile = files.find((candidateFile) => candidateFile.asset_id === existingAsset.id && candidateFile.position === row.position);
          if (existingFile) {
            const fileMatches =
              existingFile.storage_bucket === row.storage_bucket &&
              existingFile.storage_path === row.storage_path &&
              existingFile.public_url === row.public_url &&
              existingFile.mime_type === row.mime_type &&
              existingFile.file_size_bytes === row.file_size_bytes &&
              existingFile.width === row.width &&
              existingFile.height === row.height &&
              existingFile.duration_ms === row.duration_ms &&
              existingFile.checksum_sha256 === row.checksum_sha256;
            if (!fileMatches) {
              return { data: null, error: { message: "idempotency-conflict: incompatible Asset File identity" } };
            }
          } else {
            files.push(row);
          }
          if (assets.length === 0) assets.push(existingAsset);
          jobStatus = "completed";
          return {
            data: {
              job: {
                id: job.id,
                creative_package_id: job.creativePackageId,
                status: jobStatus,
                worker_type: job.workerType,
                asset_kind: job.assetKind,
                attempt_count: job.attemptCount,
                result: args.p_result,
                last_error: null,
                created_at: job.createdAt,
                updated_at: fixedNow,
                started_at: job.startedAt,
                completed_at: fixedNow,
                failed_at: null,
              },
              asset: existingAsset,
              files: [...files],
            },
            error: null,
          };
        },
      };
    },
  };

  if (options.existingAssetOverride) {
    assets.push({
      id: "asset-1",
      asset_job_id: job.id,
      status: "generated",
      asset_kind: "image",
      schema_version: "v1",
      content: { metadata: { generatedFromCreativePackage: "package-1", sourceAssetJobId: job.id, generatorVersion: "1" } },
      created_at: fixedNow,
      updated_at: fixedNow,
      ...options.existingAssetOverride,
    });
  }
  if (options.existingFileOverride) {
    files.push({
      id: "file-1",
      asset_id: "asset-1",
      position: 0,
      storage_bucket: GENERATED_ASSETS_BUCKET,
      storage_path: "pending",
      public_url: "",
      mime_type: "image/png",
      file_size_bytes: png1080.length,
      width: 1080,
      height: 1080,
      duration_ms: null,
      checksum_sha256: "pending",
      created_at: fixedNow,
      ...options.existingFileOverride,
    });
  }

  return { client, events, objects, removed, assets, files, get jobStatus() { return jobStatus; } };
}

test("materializeAssetJobFiles uploads before the RPC and returns one Asset plus one Asset File", async () => {
  const store = makeClient();
  const result = await materializeAssetJobFiles(store.client, { job, inspected: [inspected()] });

  assert.equal(result.ok, true);
  assert.equal(store.events[0]?.startsWith("upload:asset-jobs/asset-job-1/attempt-1/"), true);
  assert.equal(store.events[1], "rpc:complete_asset_job_with_files");
  if (result.ok) {
    assert.equal(result.outcome, "created");
    assert.equal(result.materialized.asset.assetJobId, "asset-job-1");
    assert.equal(result.materialized.files[0].storageBucket, GENERATED_ASSETS_BUCKET);
    assert.equal(result.uploadedThisRun.length, 1);
    assert.equal(result.reusedExistingPaths.length, 0);
  }
});

test("materializeAssetJobFiles reports RPC Asset File conflicts before the fake job completes", async () => {
  const store = makeClient({
    existingAssetOverride: {},
    existingFileOverride: { storage_path: "asset-jobs/asset-job-1/attempt-1/different.png", checksum_sha256: "different" },
  });
  const result = await materializeAssetJobFiles(store.client, { job, inspected: [inspected()] });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "db-materialization-failed");
  assert.match(result.message, /idempotency-conflict/);
  assert.equal(store.jobStatus, "running");
  assert.equal(store.files.length, 1);
});

test("materializeAssetJobFiles reports RPC Asset identity conflicts before the fake job completes", async () => {
  const store = makeClient({ existingAssetOverride: { content: { metadata: { generatedFromCreativePackage: "package-1", sourceAssetJobId: "other-job", generatorVersion: "1" } } } });
  const result = await materializeAssetJobFiles(store.client, { job, inspected: [inspected()] });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "db-materialization-failed");
  assert.match(result.message, /idempotency-conflict/);
  assert.equal(store.jobStatus, "running");
  assert.equal(store.assets.length, 1);
  assert.equal(store.files.length, 0);
});

test("materializeAssetJobFiles lets identical RPC retries reuse existing rows without duplication", async () => {
  const first = makeClient();
  const firstResult = await materializeAssetJobFiles(first.client, { job, inspected: [inspected()] });
  assert.equal(firstResult.ok, true);
  if (!firstResult.ok) return;
  const file = firstResult.materialized.files[0];

  const retry = makeClient({
    existingAssetOverride: {},
    existingFileOverride: {
      storage_path: file.storagePath,
      checksum_sha256: file.checksumSha256,
    },
  });
  const retryResult = await materializeAssetJobFiles(retry.client, { job, inspected: [inspected()] });

  assert.equal(retryResult.ok, true);
  assert.equal(retry.jobStatus, "completed");
  assert.equal(retry.assets.length, 1);
  assert.equal(retry.files.length, 1);
});

test("materializeAssetJobFiles cleans up current-run uploads after RPC failure and reports cleanup failure honestly", async () => {
  const failed = makeClient({ rpcError: "db failed" });
  const failedResult = await materializeAssetJobFiles(failed.client, { job, inspected: [inspected()] });
  assert.equal(failedResult.ok, false);
  assert.equal(failedResult.reason, "db-materialization-failed");
  assert.equal(failed.removed.length, 1);

  const cleanupFailed = makeClient({ rpcError: "db failed", removeError: true });
  const cleanupResult = await materializeAssetJobFiles(cleanupFailed.client, { job, inspected: [inspected()] });
  assert.equal(cleanupResult.ok, false);
  assert.equal(cleanupResult.reason, "cleanup-failed");
  assert.equal(cleanupResult.cleanup?.ok, false);
});

test("materializeAssetJobFiles verifies existing deterministic paths by authenticated download before reuse and never deletes them", async () => {
  const first = makeClient();
  const firstResult = await materializeAssetJobFiles(first.client, { job, inspected: [inspected()] });
  assert.equal(firstResult.ok, true);
  if (!firstResult.ok) return;
  const existingPath = firstResult.materialized.files[0].storagePath;

  const retry = makeClient({ existing: { [existingPath]: png1080 } });
  const retryResult = await materializeAssetJobFiles(retry.client, { job, inspected: [inspected()] });
  assert.equal(retryResult.ok, true);
  assert.equal(retry.events[0], `upload:${existingPath}`);
  assert.equal(retry.events[1], `download:${existingPath}`);
  assert.equal(retry.removed.length, 0);
  if (retryResult.ok) {
    assert.equal(retryResult.outcome, "existing");
    assert.deepEqual(retryResult.uploadedThisRun, []);
    assert.deepEqual(retryResult.reusedExistingPaths, [existingPath]);
  }
});

test("materializeAssetJobFiles reports changed-byte conflict and does not delete a pre-existing object", async () => {
  const first = makeClient();
  const firstResult = await materializeAssetJobFiles(first.client, { job, inspected: [inspected()] });
  assert.equal(firstResult.ok, true);
  if (!firstResult.ok) return;
  const existingPath = firstResult.materialized.files[0].storagePath;

  const retry = makeClient({ existing: { [existingPath]: changedPng1080 } });
  const retryResult = await materializeAssetJobFiles(retry.client, { job, inspected: [inspected()] });
  assert.equal(retryResult.ok, false);
  assert.equal(retryResult.reason, "existing-object-verification-failed");
  assert.equal(retry.removed.length, 0);
  assert.equal(retry.objects.has(existingPath), true);
});

test("materializeAssetJobFiles treats mismatched RPC file rows as an idempotency conflict and cleans up only current-run uploads", async () => {
  const store = makeClient({ rpcFileOverride: { checksum_sha256: "wrong" } });
  const result = await materializeAssetJobFiles(store.client, { job, inspected: [inspected()] });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "idempotency-conflict");
  assert.equal(store.removed.length, 1);
});
