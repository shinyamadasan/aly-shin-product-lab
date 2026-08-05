import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildAssetStorageSmokeReport,
  confirmSmokeObjectPathAbsent,
  stringifyAssetStorageSmokeReport,
  type AssetStorageSmokeSummary,
} from "./smoke/asset-workers/storage-smoke-report.ts";

const summary: AssetStorageSmokeSummary = {
  assetJobId: "asset-job-1",
  attemptId: "attempt-1",
  assetId: "asset-1",
  assetFileId: "file-1",
  storageBucket: "generated-assets",
  storagePath: "asset-jobs/asset-job-1/attempt-1/hash.png",
  objectDisposition: "uploaded-this-run",
  rowDisposition: "created",
};

test("buildAssetStorageSmokeReport includes exact smoke IDs and path without credentials", () => {
  const text = stringifyAssetStorageSmokeReport(buildAssetStorageSmokeReport(summary));

  for (const expected of ["asset-job-1", "attempt-1", "asset-1", "file-1", "generated-assets", "asset-jobs/asset-job-1/attempt-1/hash.png"]) {
    assert.match(text, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.doesNotMatch(text, /password|anonKey|service_role|jwt|token|supabase\.co/i);
});

test("buildAssetStorageSmokeReport lists current-run uploaded objects for manual cleanup", () => {
  const report = buildAssetStorageSmokeReport(summary);

  assert.deepEqual(report.cleanup.removeStorageObject, {
    bucket: "generated-assets",
    path: "asset-jobs/asset-job-1/attempt-1/hash.png",
  });
  assert.equal(report.cleanup.deleteAssetFileId, "file-1");
  assert.equal(report.cleanup.deleteAssetId, "asset-1");
  assert.equal(report.cleanup.resetOrDeleteDedicatedAssetJobId, "asset-job-1");
});

test("buildAssetStorageSmokeReport marks reused objects and never lists them for deletion", () => {
  const report = buildAssetStorageSmokeReport({
    ...summary,
    objectDisposition: "reused-existing",
    rowDisposition: "reused",
  });

  assert.equal(report.summary.objectDisposition, "reused-existing");
  assert.equal(report.summary.rowDisposition, "reused");
  assert.equal(report.cleanup.removeStorageObject, null);
  assert.match(report.cleanup.notes.join("\n"), /Never remove a reused pre-existing Storage object/);
});

test("buildAssetStorageSmokeReport handles missing optional IDs honestly", () => {
  const report = buildAssetStorageSmokeReport({
    ...summary,
    attemptId: null,
    assetId: null,
    assetFileId: null,
    storageBucket: null,
    storagePath: null,
    objectDisposition: "unknown",
    rowDisposition: "unknown",
  });

  assert.equal(report.summary.attemptId, null);
  assert.equal(report.cleanup.deleteAssetFileId, null);
  assert.equal(report.cleanup.deleteAssetId, null);
  assert.equal(report.cleanup.removeStorageObject, null);
  assert.equal(report.cleanup.manualOnly, true);
});

test("live Storage smoke uses object operations instead of storage.buckets metadata access", () => {
  const source = readFileSync(new URL("./smoke/asset-workers/storage.smoke.test.ts", import.meta.url), "utf8");

  assert.doesNotMatch(source, /\.getBucket\(/);
  assert.match(source, /confirmSmokeObjectPathAbsent/);
  assert.match(source, /Bucket metadata is verified separately through privileged SQL/);
});

test("confirmSmokeObjectPathAbsent accepts only authenticated object 404 as an absent path", async () => {
  const client = {
    storage: {
      from(bucket: string) {
        assert.equal(bucket, "generated-assets");
        return {
          async download(storagePath: string) {
            assert.equal(storagePath, "asset-jobs/job-1/attempt-1/hash.png");
            return { data: null, error: { message: "Object not found", statusCode: "404" } };
          },
        };
      },
    },
  };

  const result = await confirmSmokeObjectPathAbsent(client, "generated-assets", "asset-jobs/job-1/attempt-1/hash.png");

  assert.deepEqual(result, { ok: true, disposition: "absent" });
});

test("confirmSmokeObjectPathAbsent fails safely when object operations are unavailable before runner execution", async () => {
  let runnerInvoked = false;
  const client = {
    storage: {
      from() {
        return {
          async download() {
            return { data: null, error: { message: "storage policy unavailable", statusCode: "403" } };
          },
        };
      },
    },
  };

  const preflight = await confirmSmokeObjectPathAbsent(client, "generated-assets", "asset-jobs/job-1/attempt-1/hash.png");
  if (preflight.ok) {
    runnerInvoked = true;
  }

  assert.equal(preflight.ok, false);
  assert.equal(preflight.ok ? null : preflight.reason, "object-operation-unavailable");
  assert.equal(runnerInvoked, false);
});

test("confirmSmokeObjectPathAbsent fails safely when the deterministic object path already exists", async () => {
  const client = {
    storage: {
      from() {
        return {
          async download() {
            return { data: new Blob(["already here"]), error: null };
          },
        };
      },
    },
  };

  const preflight = await confirmSmokeObjectPathAbsent(client, "generated-assets", "asset-jobs/job-1/attempt-1/hash.png");

  assert.equal(preflight.ok, false);
  assert.equal(preflight.ok ? null : preflight.reason, "object-exists");
});
