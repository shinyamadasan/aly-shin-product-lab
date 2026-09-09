import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  GENERATED_ASSET_ALLOWED_MIME_TYPES,
  GENERATED_ASSET_ALLOWED_VIDEO_MIME_TYPES,
  GENERATED_ASSET_MAX_FILE_SIZE_BYTES,
  GENERATED_ASSET_MAX_FILE_SIZE_BYTES_BY_KIND,
  maxGeneratedAssetFileSizeBytes,
  validateGeneratedAssetCandidates,
  type GeneratedAssetFileCandidate,
} from "../src/lib/asset-generation-validation.ts";
import { ASSET_KINDS } from "../src/lib/asset-jobs.ts";
import { PRODUCTION_IMAGE_DIMENSIONS, PRODUCTION_SHORT_VIDEO_DIMENSIONS, type ProductionSpecV1 } from "../src/lib/production-spec.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Production MVP Wave C1 -- the per-kind byte ceiling, and the mismatch it resolves.
//
// Wave A left a note in asset-generation-validation.ts saying the size branch read one global limit
// for both kinds and that reconciling it was "Wave C entry work". This is that work, and these are
// the assertions that stop it collapsing back into a single oversized global allowance.

function baseSpec(assetKind: "image" | "short_video"): ProductionSpecV1 {
  const shared = {
    schemaVersion: "production-v1" as const,
    sourceCreativePackageId: "pkg-1",
    copy: { headline: "H", caption: "C", cta: "CTA", overlayText: null },
    brandStyle: null,
    visualBrief: null,
  };
  return assetKind === "image"
    ? { ...shared, assetKind: "image", dimensions: PRODUCTION_IMAGE_DIMENSIONS }
    : { ...shared, assetKind: "short_video", dimensions: PRODUCTION_SHORT_VIDEO_DIMENSIONS, scenes: [], targetDurationSeconds: 8 };
}

function candidate(overrides: Partial<GeneratedAssetFileCandidate> = {}): GeneratedAssetFileCandidate {
  return {
    position: 0,
    mimeType: "image/png",
    width: PRODUCTION_IMAGE_DIMENSIONS.width,
    height: PRODUCTION_IMAGE_DIMENSIONS.height,
    durationMs: null,
    fileSizeBytes: 1024,
    bytes: new Uint8Array([1, 2, 3]),
    ...overrides,
  };
}

function videoCandidate(overrides: Partial<GeneratedAssetFileCandidate> = {}): GeneratedAssetFileCandidate {
  return candidate({
    mimeType: "video/mp4",
    width: PRODUCTION_SHORT_VIDEO_DIMENSIONS.width,
    height: PRODUCTION_SHORT_VIDEO_DIMENSIONS.height,
    durationMs: 8000,
    ...overrides,
  });
}

test("the image limit is UNCHANGED at 10 MB -- every asset ever produced is measured the same way", () => {
  assert.equal(GENERATED_ASSET_MAX_FILE_SIZE_BYTES, 10 * 1024 * 1024);
  assert.equal(GENERATED_ASSET_MAX_FILE_SIZE_BYTES, 10485760);
  // Referenced, not retyped: there is still exactly one 10 MB in the codebase.
  assert.equal(GENERATED_ASSET_MAX_FILE_SIZE_BYTES_BY_KIND.image, GENERATED_ASSET_MAX_FILE_SIZE_BYTES);
  assert.equal(maxGeneratedAssetFileSizeBytes("image"), 10485760);
});

test("the short_video limit is 50 MB and matches what the storage migration sets on the bucket", () => {
  assert.equal(maxGeneratedAssetFileSizeBytes("short_video"), 52428800);
  // An application limit ABOVE the bucket's would surface as an opaque storage rejection after a
  // full render; one below would refuse files storage would happily take. They must be the same
  // number, and this reads the number out of the migration rather than restating it.
  const migration = readFileSync(path.join(REPO_ROOT, "supabase-add-generated-assets-video.sql"), "utf8");
  assert.match(migration, /file_size_limit = 52428800/i);
});

test("image and video do NOT silently share one oversized global allowance", () => {
  assert.notEqual(maxGeneratedAssetFileSizeBytes("image"), maxGeneratedAssetFileSizeBytes("short_video"));
  assert.ok(maxGeneratedAssetFileSizeBytes("short_video") > maxGeneratedAssetFileSizeBytes("image"));
  // The specific failure this guards against: raising the image ceiling to the video one, which
  // would give every PNG a fivefold allowance it has no use for and stop the limit catching a
  // mis-exported or mislabelled file.
  assert.ok(maxGeneratedAssetFileSizeBytes("image") < 52428800);
});

test("every asset kind has an explicit limit -- none falls through to a default", () => {
  for (const kind of ASSET_KINDS) {
    const limit = maxGeneratedAssetFileSizeBytes(kind);
    assert.equal(typeof limit, "number");
    assert.ok(limit > 0, `${kind} has no positive byte limit`);
  }
  assert.deepEqual(Object.keys(GENERATED_ASSET_MAX_FILE_SIZE_BYTES_BY_KIND).sort(), [...ASSET_KINDS].sort());
});

test("an image is rejected at 10 MB + 1 and accepted at exactly 10 MB", () => {
  const spec = baseSpec("image");
  const atLimit = validateGeneratedAssetCandidates([candidate({ fileSizeBytes: 10485760 })], spec);
  assert.equal(atLimit.ok, true);

  const overLimit = validateGeneratedAssetCandidates([candidate({ fileSizeBytes: 10485761 })], spec);
  assert.equal(overLimit.ok, false);
  assert.equal(overLimit.ok === false ? overLimit.reason : null, "empty-bytes");
});

test("a video that would have been refused under the old global limit is now accepted", () => {
  // 20 MB: comfortably over the image ceiling, comfortably under the video one. Before this change
  // the validator measured it against 10 MB and refused it, while the bucket would have taken it.
  const twentyMb = validateGeneratedAssetCandidates([videoCandidate({ fileSizeBytes: 20 * 1024 * 1024 })], baseSpec("short_video"));
  assert.equal(twentyMb.ok, true);

  // And the same bytes are still refused for an IMAGE job, which is the whole point of per-kind.
  const asImage = validateGeneratedAssetCandidates([candidate({ fileSizeBytes: 20 * 1024 * 1024 })], baseSpec("image"));
  assert.equal(asImage.ok, false);
});

test("a video is rejected at 50 MB + 1 and accepted at exactly 50 MB", () => {
  const spec = baseSpec("short_video");
  assert.equal(validateGeneratedAssetCandidates([videoCandidate({ fileSizeBytes: 52428800 })], spec).ok, true);

  const overLimit = validateGeneratedAssetCandidates([videoCandidate({ fileSizeBytes: 52428801 })], spec);
  assert.equal(overLimit.ok, false);
  assert.equal(overLimit.ok === false ? overLimit.reason : null, "empty-bytes");
  assert.match(overLimit.ok === false ? overLimit.message : "", /Short video/);
});

test("zero bytes is still rejected for both kinds", () => {
  assert.equal(validateGeneratedAssetCandidates([candidate({ fileSizeBytes: 0 })], baseSpec("image")).ok, false);
  assert.equal(validateGeneratedAssetCandidates([videoCandidate({ fileSizeBytes: 0 })], baseSpec("short_video")).ok, false);
});

// --- MIME, per kind -------------------------------------------------------------------------------

test("video/mp4 is accepted for a short_video job and refused for an image job", () => {
  assert.equal(validateGeneratedAssetCandidates([videoCandidate()], baseSpec("short_video")).ok, true);

  const mp4AsImage = validateGeneratedAssetCandidates([candidate({ mimeType: "video/mp4" })], baseSpec("image"));
  assert.equal(mp4AsImage.ok, false);
  assert.equal(mp4AsImage.ok === false ? mp4AsImage.reason : null, "unsupported-mime-type");
});

test("an image MIME is refused for a short_video job", () => {
  for (const mimeType of GENERATED_ASSET_ALLOWED_MIME_TYPES) {
    const result = validateGeneratedAssetCandidates([videoCandidate({ mimeType })], baseSpec("short_video"));
    assert.equal(result.ok, false, `${mimeType} should not be a short_video`);
    assert.equal(result.ok === false ? result.reason : null, "unsupported-mime-type");
  }
});

test("no video container beyond MP4 is admissible", () => {
  assert.deepEqual([...GENERATED_ASSET_ALLOWED_VIDEO_MIME_TYPES], ["video/mp4"]);
  for (const mimeType of ["video/webm", "video/quicktime", "video/x-matroska", "application/mp4", "video/mp4; codecs=avc1"]) {
    const result = validateGeneratedAssetCandidates([videoCandidate({ mimeType })], baseSpec("short_video"));
    assert.equal(result.ok, false, `${mimeType} must not be admissible`);
    assert.equal(result.ok === false ? result.reason : null, "unsupported-mime-type");
  }
});

test("the duration rule still inverts on kind", () => {
  const noDuration = validateGeneratedAssetCandidates([videoCandidate({ durationMs: null })], baseSpec("short_video"));
  assert.equal(noDuration.ok === false ? noDuration.reason : null, "duration-missing-for-video");

  const zeroDuration = validateGeneratedAssetCandidates([videoCandidate({ durationMs: 0 })], baseSpec("short_video"));
  assert.equal(zeroDuration.ok === false ? zeroDuration.reason : null, "duration-missing-for-video");

  const imageWithDuration = validateGeneratedAssetCandidates([candidate({ durationMs: 8000 })], baseSpec("image"));
  assert.equal(imageWithDuration.ok === false ? imageWithDuration.reason : null, "duration-present-for-image");
});
