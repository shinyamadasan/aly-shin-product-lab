import test from "node:test";
import assert from "node:assert/strict";

import {
  inspectAssetBytes,
  inspectMediaBytes,
  inspectVideoBytes,
  validateAssetCandidateBytes,
  buildGeneratedAssetObjectPath,
} from "../src/lib/asset-binary.ts";
import { buildAssetUploadCandidate } from "../src/lib/asset-upload-intake.ts";
import { maxGeneratedAssetFileSizeBytes, type GeneratedAssetFileCandidate } from "../src/lib/asset-generation-validation.ts";

// Production MVP Wave C2A -- the video byte path, and the HARD GATE C1 left open.
//
// C1's report named this the single blocking C2 condition: asset-binary.ts and asset-upload-intake.ts
// were image-oriented with a flat 10 MiB ceiling, so a correct MP4 was rejected as "not a decodable
// PNG, JPEG, or WebP image". These tests are what hold the fix in place -- in BOTH directions, since
// the requirement was equally that image behaviour not change.

// --- a hand-built MP4 -------------------------------------------------------------------------------
//
// Constructed rather than committed, in exactly the style tests/asset-binary.test.ts already uses for
// png1080/jpeg3x2/webp3x2: a real binary fixture in a repository with no binary-fixture policy would
// be a 1 MB blob nobody can review. This builder produces a structurally valid box tree -- ftyp, moov,
// mvhd, trak, mdia, hdlr, minf, stbl, stsd -- with no media data, which is precisely the part the
// container parser reads and none of the part it does not.
//
// The real, ffprobe-verified MP4 that the Remotion worker produces is checked separately, by the
// worker proof; this is the unit-level fixture that makes every parsing RULE assertable.

function box(type: string, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + payload.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, out.length);
  for (let i = 0; i < 4; i += 1) {
    out[4 + i] = type.charCodeAt(i);
  }
  out.set(payload, 8);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function u32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value);
  return out;
}

function fourcc(value: string): Uint8Array {
  return new Uint8Array([...value].map((character) => character.charCodeAt(0)));
}

type Mp4FixtureOptions = {
  width?: number;
  height?: number;
  timescale?: number;
  duration?: number;
  sampleFormat?: string;
  handler?: string;
  brand?: string;
};

function mp4Fixture(options: Mp4FixtureOptions = {}): Uint8Array {
  const width = options.width ?? 1080;
  const height = options.height ?? 1920;
  const timescale = options.timescale ?? 1000;
  const duration = options.duration ?? 8000;
  const sampleFormat = options.sampleFormat ?? "avc1";

  // The brand override replaces the compatible-brands list too, not just the major brand. A real
  // ftyp lists several, and the parser accepts a file if ANY of them is an MP4 brand -- so a builder
  // that always appended "isom" would have made the brand check untestable.
  const brand = options.brand ?? "isom";
  const ftyp = box("ftyp", concat(fourcc(brand), u32(512), fourcc(brand), fourcc(brand === "isom" ? "mp41" : brand)));
  // mvhd v0: version+flags(4) creation(4) modification(4) timescale(4) duration(4) then the rest.
  const mvhd = box("mvhd", concat(u32(0), u32(0), u32(0), u32(timescale), u32(duration), new Uint8Array(80)));
  // hdlr: version+flags(4) pre_defined(4) handler_type(4) then reserved/name.
  const hdlr = box("hdlr", concat(u32(0), u32(0), fourcc(options.handler ?? "vide"), new Uint8Array(12)));

  // VisualSampleEntry: 8 header + 6 reserved + 2 dri + 2 + 2 + 12 = width at +32, height at +34.
  const sampleEntry = box(sampleFormat, concat(new Uint8Array(6), u32(1).slice(2), new Uint8Array(2), new Uint8Array(2), new Uint8Array(12), u32(width).slice(2), u32(height).slice(2), new Uint8Array(50)));
  const stsd = box("stsd", concat(u32(0), u32(1), sampleEntry));
  const stbl = box("stbl", stsd);
  const minf = box("minf", stbl);
  const mdia = box("mdia", concat(hdlr, minf));
  const trak = box("trak", mdia);
  const moov = box("moov", concat(mvhd, trak));

  return concat(ftyp, moov);
}

function videoCandidate(bytes: Uint8Array, overrides: Partial<GeneratedAssetFileCandidate> = {}): GeneratedAssetFileCandidate {
  return {
    position: 0,
    mimeType: "video/mp4",
    width: 1080,
    height: 1920,
    durationMs: 8000,
    fileSizeBytes: bytes.length,
    bytes,
    ...overrides,
  };
}

const png1080 = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x04, 0x38, 0x00, 0x00, 0x04, 0x38, 0x08, 0x04,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
]);

// --- the fixture itself is trustworthy --------------------------------------------------------------

test("the hand-built MP4 fixture decodes to the facts it was built with", async () => {
  const inspection = await inspectVideoBytes(mp4Fixture());
  assert.ok(inspection.ok, inspection.ok ? "" : inspection.message);
  assert.equal(inspection.facts.actualMimeType, "video/mp4");
  assert.equal(inspection.facts.actualWidth, 1080);
  assert.equal(inspection.facts.actualHeight, 1920);
  assert.equal(inspection.facts.actualDurationMs, 8000);
  assert.equal(inspection.facts.extension, "mp4");
});

test("duration comes out of the movie header's own timescale, not a guess", async () => {
  // Same 8 seconds expressed three ways. A parser that ignored timescale would report 8000, 240 and
  // 720000 here instead of 8000 three times.
  for (const [timescale, duration] of [
    [1000, 8000],
    [30, 240],
    [90000, 720000],
  ]) {
    const inspection = await inspectVideoBytes(mp4Fixture({ timescale, duration }));
    assert.ok(inspection.ok);
    assert.equal(inspection.facts.actualDurationMs, 8000, `timescale ${timescale} misread`);
  }
});

// --- "do not decode MP4 as an image", in both directions ---------------------------------------------

test("an MP4 is NOT accepted by the image inspector", async () => {
  const result = await inspectAssetBytes(mp4Fixture());
  assert.equal(result.ok, false);
  assert.equal(result.ok === false ? result.reason : null, "invalid-binary");
});

test("a PNG is NOT accepted by the video inspector", async () => {
  const result = await inspectVideoBytes(png1080);
  assert.equal(result.ok, false);
  assert.equal(result.ok === false ? result.reason : null, "invalid-binary");
  assert.match(result.ok === false ? result.message : "", /not an MP4 container/);
});

test("inspectMediaBytes dispatches on the asset kind and never guesses", async () => {
  assert.equal((await inspectMediaBytes(mp4Fixture(), "short_video")).ok, true);
  assert.equal((await inspectMediaBytes(png1080, "image")).ok, true);
  // The cross pairings must both fail. A dispatcher that fell back to "try the other decoder" would
  // make the asset kind decorative.
  assert.equal((await inspectMediaBytes(mp4Fixture(), "image")).ok, false);
  assert.equal((await inspectMediaBytes(png1080, "short_video")).ok, false);
});

// --- the extension and the MIME are never evidence ----------------------------------------------------

test("a renamed file cannot pass as an MP4 -- only a real box tree can", async () => {
  const notMp4: Array<[string, Uint8Array]> = [
    ["a PNG", png1080],
    ["arbitrary bytes", new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])],
    ["empty", new Uint8Array()],
    // The four magic characters present, but NOT as a leading box. This is the case a signature
    // sniff would wave through and a structural parse refuses.
    ["ftyp somewhere in the middle", concat(new Uint8Array(64), fourcc("ftyp"), fourcc("isom"))],
    // A leading box whose declared size runs past the end of the buffer.
    ["a truncated ftyp", mp4Fixture().slice(0, 6)],
    // Valid ftyp, no moov at all.
    ["ftyp with no moov", box("ftyp", concat(fourcc("isom"), u32(512), fourcc("isom")))],
  ];

  for (const [label, bytes] of notMp4) {
    const result = await inspectVideoBytes(bytes);
    assert.equal(result.ok, false, `${label} must not decode as an MP4`);
  }
});

test("a brand nothing recognises is refused even with a well-formed box tree", async () => {
  const result = await inspectVideoBytes(mp4Fixture({ brand: "qt  " }));
  assert.equal(result.ok, false);
  assert.match(result.ok === false ? result.message : "", /MP4-compatible brand/);
});

test("an MP4 with no VIDEO track is refused", async () => {
  const audioOnly = await inspectVideoBytes(mp4Fixture({ handler: "soun" }));
  assert.equal(audioOnly.ok, false);
  assert.match(audioOnly.ok === false ? audioOnly.message : "", /no readable video track/);
});

test("a non-H.264 codec is refused with its OWN reason, not as a generic bad file", async () => {
  for (const sampleFormat of ["hvc1", "hev1", "av01", "vp09"]) {
    const result = await inspectVideoBytes(mp4Fixture({ sampleFormat }));
    assert.equal(result.ok, false, `${sampleFormat} must be refused`);
    // Distinct from invalid-binary on purpose: "this is not a video file" and "this is a video in a
    // codec we do not produce" need different responses from whoever reads the failure.
    assert.equal(result.ok === false ? result.reason : null, "unsupported-video-codec");
  }
  // Both H.264 sample entry formats are admissible.
  for (const sampleFormat of ["avc1", "avc3"]) {
    assert.equal((await inspectVideoBytes(mp4Fixture({ sampleFormat }))).ok, true, `${sampleFormat} must be admissible`);
  }
});

test("zero-sized coded dimensions are refused", async () => {
  const result = await inspectVideoBytes(mp4Fixture({ width: 0, height: 0 }));
  assert.equal(result.ok, false);
  assert.match(result.ok === false ? result.message : "", /invalid coded dimensions/);
});

test("a container reporting no duration is refused rather than defaulted to zero", async () => {
  // duration 0 in mvhd is what a FRAGMENTED MP4 carries. Remotion does not emit one, and this engine
  // does not claim to handle one -- so it is refused explicitly rather than silently treated as a
  // zero-length video.
  const result = await inspectVideoBytes(mp4Fixture({ duration: 0 }));
  assert.equal(result.ok, false);
  assert.match(result.ok === false ? result.message : "", /no readable duration/);
});

// --- per-kind byte ceilings, enforced at the byte layer ------------------------------------------------

test("the IMAGE ceiling is unchanged at 10 MiB and still applies by default", async () => {
  const overImageLimit = await validateAssetCandidateBytes({
    position: 0,
    mimeType: "image/png",
    width: 1080,
    height: 1080,
    durationMs: null,
    fileSizeBytes: 10 * 1024 * 1024 + 1,
    bytes: new Uint8Array(10 * 1024 * 1024 + 1),
  });
  assert.equal(overImageLimit.ok, false);
  assert.equal(overImageLimit.ok === false ? overImageLimit.reason : null, "file-too-large");
  assert.match(overImageLimit.ok === false ? overImageLimit.message : "", /10485760/);
});

test("a video is measured against 50 MiB, not 10 -- the C1 blocker, closed", async () => {
  assert.equal(maxGeneratedAssetFileSizeBytes("short_video"), 52428800);

  // 20 MiB: over the image ceiling, under the video one. This is the exact size that used to be
  // rejected by a flat limit while the storage bucket would have accepted it.
  const padded = concat(mp4Fixture(), new Uint8Array(20 * 1024 * 1024));
  const result = await validateAssetCandidateBytes(videoCandidate(padded), "short_video");
  assert.equal(result.ok, true, result.ok ? "" : result.message);

  // The same bytes as an IMAGE job are still refused -- per-kind means per-kind in both directions.
  const asImage = await validateAssetCandidateBytes(videoCandidate(padded), "image");
  assert.equal(asImage.ok, false);
});

test("a video over 50 MiB is refused", async () => {
  const oversize = concat(mp4Fixture(), new Uint8Array(52428801 - mp4Fixture().length));
  const result = await validateAssetCandidateBytes(videoCandidate(oversize), "short_video");
  assert.equal(result.ok, false);
  assert.equal(result.ok === false ? result.reason : null, "file-too-large");
  assert.match(result.ok === false ? result.message : "", /52428800/);
});

// --- declared-vs-actual, for video ----------------------------------------------------------------------

test("a video candidate that lies about its own dimensions or duration is refused", async () => {
  const bytes = mp4Fixture();

  const wrongDimensions = await validateAssetCandidateBytes(videoCandidate(bytes, { width: 720, height: 1280 }), "short_video");
  assert.equal(wrongDimensions.ok === false ? wrongDimensions.reason : null, "declared-dimension-mismatch");

  const wrongDuration = await validateAssetCandidateBytes(videoCandidate(bytes, { durationMs: 30000 }), "short_video");
  assert.equal(wrongDuration.ok === false ? wrongDuration.reason : null, "declared-duration-mismatch");

  const wrongMime = await validateAssetCandidateBytes(videoCandidate(bytes, { mimeType: "image/png" }), "short_video");
  assert.equal(wrongMime.ok === false ? wrongMime.reason : null, "mime-mismatch");

  const wrongSize = await validateAssetCandidateBytes(videoCandidate(bytes, { fileSizeBytes: bytes.length + 1 }), "short_video");
  assert.equal(wrongSize.ok === false ? wrongSize.reason : null, "file-size-mismatch");
});

test("the duration tolerance admits encoder rounding but not a different video", async () => {
  const bytes = mp4Fixture({ timescale: 1000, duration: 8043 });
  // 8000 declared vs 8043 actual: the same video, off by the AAC padding the enforced silent track
  // adds. Must pass.
  assert.equal((await validateAssetCandidateBytes(videoCandidate(bytes, { durationMs: 8000 }), "short_video")).ok, true);
  // 6000 vs 8043 is not rounding.
  assert.equal((await validateAssetCandidateBytes(videoCandidate(bytes, { durationMs: 6000 }), "short_video")).ok, false);
});

test("a validated video candidate carries its decoded duration forward", async () => {
  const result = await validateAssetCandidateBytes(videoCandidate(mp4Fixture()), "short_video");
  assert.ok(result.ok);
  assert.equal(result.inspected.actualDurationMs, 8000);
  assert.equal(result.inspected.extension, "mp4");
  // The storage path uses the real extension, so an MP4 is never stored as a .png.
  const path = buildGeneratedAssetObjectPath({ assetJobId: "job-1", attemptNumber: 1, sha256: result.inspected.sha256, extension: result.inspected.extension });
  assert.match(path, /\.mp4$/);
});

test("an IMAGE candidate always decodes to a null duration", async () => {
  const result = await validateAssetCandidateBytes({
    position: 0,
    mimeType: "image/png",
    width: 1080,
    height: 1080,
    durationMs: null,
    fileSizeBytes: png1080.length,
    bytes: png1080,
  });
  assert.ok(result.ok);
  assert.equal(result.inspected.actualDurationMs, null);
});

// --- upload intake ---------------------------------------------------------------------------------------

test("buildAssetUploadCandidate defaults to image and is byte-identical to its old behaviour", async () => {
  const result = await buildAssetUploadCandidate(png1080);
  assert.ok(result.ok);
  assert.deepEqual(
    { ...result.candidate, bytes: undefined },
    { position: 0, mimeType: "image/png", width: 1080, height: 1080, durationMs: null, fileSizeBytes: png1080.length, bytes: undefined },
  );

  // And an MP4 offered to the default (image) intake is still refused, which is what stops a video
  // reaching the illustration/upload surfaces that were never designed for one.
  const video = await buildAssetUploadCandidate(mp4Fixture());
  assert.equal(video.ok, false);
});

test("buildAssetUploadCandidate accepts an MP4 when the kind says short_video", async () => {
  const result = await buildAssetUploadCandidate(mp4Fixture(), "short_video");
  assert.ok(result.ok);
  assert.equal(result.candidate.mimeType, "video/mp4");
  assert.equal(result.candidate.width, 1080);
  assert.equal(result.candidate.height, 1920);
  assert.equal(result.candidate.durationMs, 8000);
});

test("upload intake applies the per-kind ceiling too", async () => {
  const twentyMib = concat(mp4Fixture(), new Uint8Array(20 * 1024 * 1024));
  assert.equal((await buildAssetUploadCandidate(twentyMib, "short_video")).ok, true);

  const asImage = await buildAssetUploadCandidate(twentyMib, "image");
  assert.equal(asImage.ok, false);
  assert.equal(asImage.ok === false ? asImage.reason : null, "file-too-large");
});
