import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { buildAssetUploadCandidate, buildAssetUploadCandidateFromBlob } from "../src/lib/asset-upload-intake.ts";
import { GENERATED_ASSET_MAX_FILE_SIZE_BYTES } from "../src/lib/asset-generation-validation.ts";

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

test("buildAssetUploadCandidate accepts valid PNG, JPEG, and WebP bytes, always declaring the actual decoded facts", async () => {
  for (const bytes of [png1080, jpeg3x2, webp3x2]) {
    const result = await buildAssetUploadCandidate(bytes);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.candidate.position, 0);
      assert.equal(result.candidate.durationMs, null);
      assert.equal(result.candidate.fileSizeBytes, bytes.length);
      assert.equal(result.candidate.bytes, bytes, "must be the same bytes, not a copy");
    }
  }
});

test("buildAssetUploadCandidate rejects empty bytes", async () => {
  const result = await buildAssetUploadCandidate(new Uint8Array());
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "empty-bytes");
  }
});

test("buildAssetUploadCandidate rejects bytes over the shared size limit, without decoding them", async () => {
  const result = await buildAssetUploadCandidate(new Uint8Array(GENERATED_ASSET_MAX_FILE_SIZE_BYTES + 1));
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "file-too-large");
    assert.match(result.message, new RegExp(String(GENERATED_ASSET_MAX_FILE_SIZE_BYTES)));
  }
});

test("buildAssetUploadCandidate rejects undecodable bytes as invalid-binary", async () => {
  const result = await buildAssetUploadCandidate(new Uint8Array([1, 2, 3]));
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "invalid-binary");
  }
});

test("buildAssetUploadCandidate rejects a GIF as unsupported-mime, distinctly from other undecodable bytes", async () => {
  const result = await buildAssetUploadCandidate(gif1x1);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "unsupported-mime");
    assert.match(result.message, /gif/i);
  }
});

test("buildAssetUploadCandidateFromBlob converts a Blob to bytes and defers entirely to buildAssetUploadCandidate -- identical candidate either way", async () => {
  const blob = new Blob([png1080], { type: "image/png" });
  const fromBlob = await buildAssetUploadCandidateFromBlob(blob);
  const fromBytes = await buildAssetUploadCandidate(png1080);

  assert.equal(fromBlob.ok, true);
  assert.equal(fromBytes.ok, true);
  if (fromBlob.ok && fromBytes.ok) {
    assert.deepEqual(
      { ...fromBlob.candidate, bytes: Array.from(fromBlob.candidate.bytes) },
      { ...fromBytes.candidate, bytes: Array.from(fromBytes.candidate.bytes) },
    );
  }
});

test("buildAssetUploadCandidateFromBlob also accepts a real File -- File extends Blob, so a browser <input> selection works unchanged", async () => {
  const file = new File([png1080], "photo.png", { type: "image/png" });
  const result = await buildAssetUploadCandidateFromBlob(file);

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.candidate.mimeType, "image/png");
    assert.equal(result.candidate.fileSizeBytes, png1080.length);
  }
});

test("buildAssetUploadCandidateFromBlob rejects the same way buildAssetUploadCandidate does -- one shared rejection path, not two", async () => {
  const blob = new Blob([gif1x1], { type: "image/gif" });
  const result = await buildAssetUploadCandidateFromBlob(blob);

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "unsupported-mime");
  }
});

test("a Blob's own declared .type is never trusted -- the candidate's mimeType always reflects the actual bytes", async () => {
  // A mislabeled Blob (real PNG bytes, but declared as image/gif) still produces a correct,
  // actual-bytes-based candidate -- proving the source's own metadata never dictates the outcome,
  // only the bytes do.
  const mislabeled = new Blob([png1080], { type: "image/gif" });
  const result = await buildAssetUploadCandidateFromBlob(mislabeled);

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.candidate.mimeType, "image/png");
  }
});

test("asset-upload-intake makes no network call and imports nothing Node-only or Supabase-specific", () => {
  // Unlike the executor/brief scope-guard tests elsewhere in this milestone, this file's own
  // comments *legitimately* name future upload sources (Telegram, a share target, camera capture)
  // as illustrative examples -- banning those words would fail against correct documentation, not
  // catch a real coupling. The invariant that actually matters here, and is worth locking in, is
  // narrower: this file must stay callable from a browser (no node: import) and must never reach
  // for a database client or the network directly -- a source-agnostic boundary has no business
  // doing either.
  const source = readFileSync(new URL("../src/lib/asset-upload-intake.ts", import.meta.url), "utf8");
  for (const forbidden of [/\bfetch\s*\(/, /node:/, /@supabase\/supabase-js/i]) {
    assert.doesNotMatch(source, forbidden);
  }
});
