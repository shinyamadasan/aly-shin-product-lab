import test from "node:test";
import assert from "node:assert/strict";

import {
  buildGeneratedAssetObjectPath,
  inspectAssetBytes,
  validateAssetCandidateBytes,
} from "../src/lib/asset-binary.ts";
import { sha256Hex } from "../src/lib/asset-digest.ts";
import {
  SPEC_DIMENSION_ADVISORY_REASON,
  validateGeneratedAssetCandidates,
  type GeneratedAssetFileCandidate,
} from "../src/lib/asset-generation-validation.ts";
import { ASSET_GENERATION_IMAGE_DIMENSIONS, type AssetGenerationSpecV1 } from "../src/lib/asset-generation-spec.ts";

const png1080 = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d,
  0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x04, 0x38,
  0x00, 0x00, 0x04, 0x38,
  0x08, 0x04, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00,
]);

const jpeg3x2 = new Uint8Array([
  0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x02, 0x00, 0x03, 0x03, 0x01, 0x11, 0x00, 0x02,
  0x11, 0x00, 0x03, 0x11, 0x00, 0xff, 0xd9,
]);

const webp3x2 = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x16, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x58,
  0x0a, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x01, 0x00, 0x00,
]);

const gif1x1 = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00]);

const spec: AssetGenerationSpecV1 = {
  schemaVersion: "v1",
  assetKind: "image",
  sourceCreativePackageId: "package-1",
  generationIntent: { purpose: "marketing-social-feed", outcome: "single-image" },
  copy: { headline: "Headline", caption: "Caption" },
  dimensions: ASSET_GENERATION_IMAGE_DIMENSIONS,
  brandStyle: null,
};

function candidate(bytes: Uint8Array, overrides: Partial<GeneratedAssetFileCandidate> = {}): GeneratedAssetFileCandidate {
  return {
    position: 0,
    mimeType: "image/png",
    width: 1080,
    height: 1080,
    durationMs: null,
    fileSizeBytes: bytes.length,
    bytes,
    ...overrides,
  };
}

test("inspectAssetBytes decodes PNG, JPEG, and WebP facts separately from validation", async () => {
  assert.deepEqual(await inspectAssetBytes(png1080), {
    ok: true,
    facts: { actualMimeType: "image/png", actualWidth: 1080, actualHeight: 1080, extension: "png", byteSize: png1080.length, sha256: await sha256Hex(png1080), bytes: png1080 },
  });
  assert.deepEqual(await inspectAssetBytes(jpeg3x2), {
    ok: true,
    facts: { actualMimeType: "image/jpeg", actualWidth: 3, actualHeight: 2, extension: "jpg", byteSize: jpeg3x2.length, sha256: await sha256Hex(jpeg3x2), bytes: jpeg3x2 },
  });
  assert.deepEqual(await inspectAssetBytes(webp3x2), {
    ok: true,
    facts: { actualMimeType: "image/webp", actualWidth: 3, actualHeight: 2, extension: "webp", byteSize: webp3x2.length, sha256: await sha256Hex(webp3x2), bytes: webp3x2 },
  });
});

test("validateAssetCandidateBytes accepts real matching PNG bytes and builds deterministic asset_job paths", async () => {
  const result = await validateAssetCandidateBytes(candidate(png1080));
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.inspected.sha256, await sha256Hex(png1080));
  assert.equal(
    buildGeneratedAssetObjectPath({ assetJobId: "asset-job-1", attemptNumber: 2, sha256: result.inspected.sha256, extension: result.inspected.extension }),
    `asset-jobs/asset-job-1/attempt-2/${result.inspected.sha256}.png`,
  );
});

test("validateAssetCandidateBytes rejects empty, oversized, invalid, unsupported, MIME-mismatched, dimension-mismatched, and size-mismatched bytes", async () => {
  for (const [resultPromise, reason] of [
    [validateAssetCandidateBytes(candidate(new Uint8Array())), "empty-bytes"],
    [validateAssetCandidateBytes(candidate(new Uint8Array(10 * 1024 * 1024 + 1))), "file-too-large"],
    [validateAssetCandidateBytes(candidate(new Uint8Array([1, 2, 3]))), "invalid-binary"],
    [validateAssetCandidateBytes(candidate(gif1x1)), "unsupported-mime"],
    [validateAssetCandidateBytes(candidate(png1080, { mimeType: "image/jpeg" })), "mime-mismatch"],
    [validateAssetCandidateBytes(candidate(png1080, { width: 512, height: 512 })), "declared-dimension-mismatch"],
    [validateAssetCandidateBytes(candidate(png1080, { fileSizeBytes: png1080.length + 1 })), "file-size-mismatch"],
  ] as const) {
    const result = await resultPromise;
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, reason);
    }
  }
});

test("inspectAssetBytes rejects truncated PNG, JPEG, and WebP without throwing", async () => {
  for (const bytes of [png1080.slice(0, 20), jpeg3x2.slice(0, 8), webp3x2.slice(0, 20)]) {
    const result = await inspectAssetBytes(bytes);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, "invalid-binary");
      assert.match(result.message, /not a decodable PNG, JPEG, or WebP/);
    }
  }
});

test("metadata validation rejects array-like, base64/object-shaped, Blob-like, and provider-shaped byte payloads", () => {
  const malformedBytePayloads = [
    Array.from(png1080),
    { base64: "iVBORw0KGgo=" },
    { arrayBuffer: () => Promise.resolve(png1080.buffer), type: "image/png", size: png1080.length },
    { url: "https://provider.example/generated.png", mimeType: "image/png" },
  ];

  for (const bytes of malformedBytePayloads) {
    const result = validateGeneratedAssetCandidates([{ ...candidate(png1080), bytes }], spec);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, "malformed-candidates");
    }
  }
});

test("dimension policy: a provider's size differing from the requested spec only warns; a candidate's declared size differing from its own actual bytes still hard-rejects", async () => {
  // Advisory half: this is exactly what a real ChatGPT/Midjourney image or a real phone photo looks
  // like -- a real, valid image whose size the provider chose, not the size the spec asked for.
  // validateGeneratedAssetCandidates is metadata-only (see the scope-guard test above) and never
  // touches bytes, so overriding width/height alone is sufficient to exercise it.
  const specLevelResult = validateGeneratedAssetCandidates([candidate(png1080, { width: 1024, height: 1024 })], spec);
  assert.equal(specLevelResult.ok, true, "a provider-chosen size that differs from the spec must not reject");
  if (specLevelResult.ok) {
    assert.equal(specLevelResult.candidates[0].width, 1024);
    assert.equal(specLevelResult.candidates[0].height, 1024);
    assert.equal(specLevelResult.warnings.length, 1);
    assert.match(specLevelResult.warnings[0], new RegExp(`^${SPEC_DIMENSION_ADVISORY_REASON}:`));
  }

  // Security half: this is a candidate lying about its own bytes -- the declared metadata doesn't
  // match what the bytes actually decode to. This is the anti-tamper check and must never be
  // weakened by the advisory relaxation above.
  const byteLevelResult = await validateAssetCandidateBytes(candidate(png1080, { width: 512, height: 512 }));
  assert.equal(byteLevelResult.ok, false, "a candidate's declared size disagreeing with its own actual bytes must still hard-reject");
  if (!byteLevelResult.ok) {
    assert.equal(byteLevelResult.reason, "declared-dimension-mismatch");
  }
});
