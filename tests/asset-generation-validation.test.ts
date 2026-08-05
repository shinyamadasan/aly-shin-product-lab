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
