import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { buildAssetGenerationSpec } from "../src/lib/asset-generation-spec.ts";
import {
  GENERATED_ASSET_ALLOWED_MIME_TYPES,
  GENERATED_ASSET_MAX_DIMENSION_PX,
  GENERATED_ASSET_MAX_FILE_SIZE_BYTES,
  GENERATED_ASSET_MIN_DIMENSION_PX,
  SPEC_DIMENSION_ADVISORY_REASON,
  validateGeneratedAssetCandidates,
  type GeneratedAssetFileCandidate,
} from "../src/lib/asset-generation-validation.ts";
import { fromCreativePackageRow, type CreativePackageRow } from "../src/lib/creative-packages.ts";
import type { ProductionSpecV1 } from "../src/lib/production-spec.ts";

function creativePackageRow(overrides: Partial<CreativePackageRow> = {}): CreativePackageRow {
  return {
    id: "package-1",
    creative_job_id: "job-1",
    status: "ready",
    schema_version: "v1",
    content: {
      output: { headline: "Launch-ready Brownies content", caption: "Brownies are ready." },
      metadata: {
        generatedFromOpportunity: "opportunity-1",
        generatorVersion: "1",
        sourceCreativeJobId: "job-1",
        sourceWorker: "mock",
        sourceJobResultSchemaVersion: "v1",
      },
      artifacts: [],
    },
    created_at: "2026-07-31T09:05:00.000Z",
    updated_at: "2026-07-31T09:05:00.000Z",
    ...overrides,
  };
}

const spec = buildAssetGenerationSpec(fromCreativePackageRow(creativePackageRow()), { assetKind: "image" });
const validBytes = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d,
  0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x04, 0x38,
  0x00, 0x00, 0x04, 0x38,
  0x08, 0x04, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00,
]);

function candidate(overrides: Partial<GeneratedAssetFileCandidate> = {}): GeneratedAssetFileCandidate {
  return {
    position: 0,
    mimeType: "image/png",
    width: spec.dimensions.width,
    height: spec.dimensions.height,
    durationMs: null,
    fileSizeBytes: validBytes.length,
    bytes: validBytes,
    ...overrides,
  };
}

test("validateGeneratedAssetCandidates accepts one metadata-level image candidate", () => {
  const result = validateGeneratedAssetCandidates([candidate()], spec);

  assert.equal(result.ok, true);
  assert.deepEqual(GENERATED_ASSET_ALLOWED_MIME_TYPES, ["image/png", "image/jpeg", "image/webp"]);
  assert.equal(GENERATED_ASSET_MIN_DIMENSION_PX, 256);
  assert.equal(GENERATED_ASSET_MAX_DIMENSION_PX, 4096);
  if (result.ok) {
    assert.equal(result.candidates[0].width, 1080);
    assert.equal(result.candidates[0].height, 1080);
    assert.deepEqual(result.warnings, [], "an exact-dimension match must not produce a warning");
  }
});

test("validateGeneratedAssetCandidates rejects malformed candidate input", () => {
  const result = validateGeneratedAssetCandidates({ position: 0 }, spec);

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "malformed-candidates");
  }
});

test("validateGeneratedAssetCandidates rejects non-Uint8Array bytes before byte inspection", () => {
  const malformed = { ...candidate(), bytes: "not-bytes" };
  const result = validateGeneratedAssetCandidates([malformed], spec);

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "malformed-candidates");
  }
});

test("validateGeneratedAssetCandidates rejects the wrong file count", () => {
  const result = validateGeneratedAssetCandidates([candidate(), candidate({ position: 1 })], spec);

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "wrong-file-count");
  }
});

test("validateGeneratedAssetCandidates rejects invalid position", () => {
  const result = validateGeneratedAssetCandidates([candidate({ position: 1 })], spec);

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "invalid-position");
  }
});

test("validateGeneratedAssetCandidates rejects unsupported MIME types", () => {
  const result = validateGeneratedAssetCandidates([candidate({ mimeType: "image/gif" })], spec);

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "unsupported-mime-type");
  }
});

test("validateGeneratedAssetCandidates warns on non-exact image dimensions but still accepts the candidate", () => {
  const result = validateGeneratedAssetCandidates([candidate({ width: 512, height: 512 })], spec);

  assert.equal(result.ok, true);
  if (result.ok) {
    // The candidate's actual dimensions pass through unchanged -- never silently coerced to what
    // the spec requested.
    assert.equal(result.candidates[0].width, 512);
    assert.equal(result.candidates[0].height, 512);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], new RegExp(`^${SPEC_DIMENSION_ADVISORY_REASON}:`));
    assert.match(result.warnings[0], /512x512/);
    assert.match(result.warnings[0], /1080x1080/);
  }
});

test("validateGeneratedAssetCandidates rejects image duration metadata", () => {
  const result = validateGeneratedAssetCandidates([candidate({ durationMs: 1000 })], spec);

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "duration-present-for-image");
  }
});

test("validateGeneratedAssetCandidates rejects empty or oversized file metadata", () => {
  for (const fileSizeBytes of [0, GENERATED_ASSET_MAX_FILE_SIZE_BYTES + 1]) {
    const result = validateGeneratedAssetCandidates([candidate({ fileSizeBytes })], spec);

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, "empty-bytes");
    }
  }
});

test("asset-generation-validation stays pure, provider agnostic, and metadata-first", () => {
  const source = readFileSync(new URL("../src/lib/asset-generation-validation.ts", import.meta.url), "utf8");

  for (const forbidden of [
    /\bawait\b/,
    /Math\.random\s*\(/,
    /Date\.now\s*\(/,
    /new Date\s*\(/,
    /\bfetch\s*\(/,
    /readFile/i,
    /writeFile/i,
    /@supabase\/supabase-js/i,
    /OpenAI/i,
    /Gemini/i,
    /Veo/i,
    /Runway/i,
    /Remotion/i,
    /storageBucket|storagePath|publicUrl/,
    /decode/i,
    /sha256/i,
  ]) {
    assert.doesNotMatch(source, forbidden);
  }
});

// --- Production MVP Wave A: asset-kind-conditional validation -------------------------------------
//
// The validator now branches on spec.assetKind. Everything above this line is the image path and is
// unchanged; everything below proves the video branch exists and, just as importantly, that the two
// branches reject each other's candidates rather than quietly accepting them.
//
// The spec here is built as a literal rather than through buildProductionSpec because this file
// tests the VALIDATOR: the only two fields it reads are assetKind and dimensions, and constructing a
// whole Creative Package to supply them would couple these assertions to package validity.
const shortVideoSpec: ProductionSpecV1 = {
  schemaVersion: "production-v1",
  assetKind: "short_video",
  sourceCreativePackageId: "package-1",
  dimensions: { width: 1080, height: 1920, aspectRatio: "9:16" },
  copy: { headline: "Morning bake", caption: "The first tray of the day.", cta: "Come by before 9", overlayText: null },
  brandStyle: null,
  visualBrief: null,
  scenes: [{ direction: "Oven door opens", text: "7:00am", approxSeconds: 3 }],
  targetDurationSeconds: 10,
};

// Bytes are deliberately opaque here. Wave A validates DECLARED candidate metadata; proving the
// bytes are really an MP4 is Wave C's ffprobe step, and hand-rolling an MP4 parser to fake it now is
// explicitly out of scope.
const opaqueVideoBytes = new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32]);

function videoCandidate(overrides: Partial<GeneratedAssetFileCandidate> = {}): GeneratedAssetFileCandidate {
  return {
    position: 0,
    mimeType: "video/mp4",
    width: 1080,
    height: 1920,
    durationMs: 10000,
    fileSizeBytes: opaqueVideoBytes.length,
    bytes: opaqueVideoBytes,
    ...overrides,
  };
}

test("short_video accepts a video/mp4 candidate carrying a positive duration", () => {
  const result = validateGeneratedAssetCandidates([videoCandidate()], shortVideoSpec);
  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  assert.equal(result.candidates.length, 1);
  assert.equal(result.warnings.length, 0);
});

test("short_video REQUIRES a positive durationMs", () => {
  for (const durationMs of [null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const result = validateGeneratedAssetCandidates([videoCandidate({ durationMs })], shortVideoSpec);
    assert.equal(result.ok, false, `durationMs ${String(durationMs)} should have been rejected`);
    if (result.ok) {
      return;
    }
    assert.equal(result.reason, "duration-missing-for-video");
  }
});

test("video MIME is rejected for an image spec", () => {
  const result = validateGeneratedAssetCandidates([candidate({ mimeType: "video/mp4" })], spec);
  assert.equal(result.ok, false);
  if (result.ok) {
    return;
  }
  assert.equal(result.reason, "unsupported-mime-type");
});

test("image MIME is rejected for a short_video spec", () => {
  for (const mimeType of GENERATED_ASSET_ALLOWED_MIME_TYPES) {
    const result = validateGeneratedAssetCandidates([videoCandidate({ mimeType })], shortVideoSpec);
    assert.equal(result.ok, false, `${mimeType} should not be accepted for a short_video`);
    if (result.ok) {
      return;
    }
    assert.equal(result.reason, "unsupported-mime-type");
  }
});

test("the image branch is unchanged: duration remains forbidden and image MIME types remain accepted", () => {
  // Duration still forbidden for images -- the original rule, still a hard rejection.
  const withDuration = validateGeneratedAssetCandidates([candidate({ durationMs: 5000 })], spec);
  assert.equal(withDuration.ok, false);
  if (!withDuration.ok) {
    assert.equal(withDuration.reason, "duration-present-for-image");
  }

  // And every image MIME type the milestone shipped with is still accepted.
  for (const mimeType of GENERATED_ASSET_ALLOWED_MIME_TYPES) {
    const result = validateGeneratedAssetCandidates([candidate({ mimeType })], spec);
    assert.equal(result.ok, true, `${mimeType} must still be accepted for an image`);
  }
});

test("short_video still enforces the shared single-candidate and position rules", () => {
  const twoFiles = validateGeneratedAssetCandidates([videoCandidate(), videoCandidate({ position: 1 })], shortVideoSpec);
  assert.equal(twoFiles.ok, false);
  if (!twoFiles.ok) {
    assert.equal(twoFiles.reason, "wrong-file-count");
  }

  const wrongPosition = validateGeneratedAssetCandidates([videoCandidate({ position: 3 })], shortVideoSpec);
  assert.equal(wrongPosition.ok, false);
  if (!wrongPosition.ok) {
    assert.equal(wrongPosition.reason, "invalid-position");
  }
});

// Reviewer finding P3-1. Every other message in the validator was made kind-aware; this one still
// said "Image" for a video candidate. Wording only -- the reason code, the bound and the
// accept/reject behaviour are unchanged, and the image message is asserted byte-for-byte so this
// stays a rename rather than a semantic edit.
//
// Deliberately exercised through fileSizeBytes = 0, the permanently-invalid half of this rule. The
// upper bound is the shared 10 MB constant that Wave C must reconcile per kind; pinning a video
// ceiling here would encode today's temporary limit as a contract.
test("the empty-bytes rejection names the asset kind it was validating", () => {
  const video = validateGeneratedAssetCandidates([videoCandidate({ fileSizeBytes: 0 })], shortVideoSpec);
  assert.equal(video.ok, false);
  if (!video.ok) {
    assert.equal(video.reason, "empty-bytes");
    assert.equal(video.message, "Short video asset generation candidate fileSizeBytes must be greater than 0 and within the maximum file size.");
    assert.doesNotMatch(video.message, /Image/);
  }

  const image = validateGeneratedAssetCandidates([candidate({ fileSizeBytes: 0 })], spec);
  assert.equal(image.ok, false);
  if (!image.ok) {
    assert.equal(image.reason, "empty-bytes");
    // Byte-identical to the message this milestone shipped with.
    assert.equal(image.message, "Image asset generation candidate fileSizeBytes must be greater than 0 and within the maximum file size.");
  }
});

test("the spec-dimension advisory still warns rather than rejects, for video as well as image", () => {
  const result = validateGeneratedAssetCandidates([videoCandidate({ width: 720, height: 1280 })], shortVideoSpec);
  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], new RegExp(SPEC_DIMENSION_ADVISORY_REASON));
});
