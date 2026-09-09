import test from "node:test";
import assert from "node:assert/strict";

import {
  defaultDurationToleranceSeconds,
  isMp4Container,
  parseFfprobeJson,
  parseFrameRate,
  validateProbedVideo,
  type ProbedVideo,
} from "../src/remotion/probe.ts";

// Production MVP Wave C1 -- video validation, tested WITHOUT a binary.
//
// parseFfprobeJson is pure, so every parsing rule can be asserted from a fixture string. That is the
// point of splitting it away from the process invocation: the fixtures below are the real shape
// ffprobe 7.1 printed for the first accepted warm-open render on this workstation, trimmed to the
// fields the parser reads.

// Captured from: ffprobe -v error -print_format json -show_format -show_streams warm-open-1.mp4
const REAL_WARM_OPEN_PROBE = JSON.stringify({
  streams: [
    {
      index: 0,
      codec_name: "h264",
      codec_type: "video",
      width: 1080,
      height: 1920,
      avg_frame_rate: "30/1",
      r_frame_rate: "30/1",
      duration: "8.000000",
      nb_frames: "240",
    },
    {
      index: 1,
      codec_name: "aac",
      codec_type: "audio",
      sample_rate: "48000",
      channels: 2,
      duration: "8.042667",
    },
  ],
  format: {
    format_name: "mov,mp4,m4a,3gp,3g2,mj2",
    format_long_name: "QuickTime / MOV",
    duration: "8.042667",
    size: "975993",
  },
});

test("the real ffprobe output for the first warm-open render parses into complete facts", () => {
  const result = parseFfprobeJson(REAL_WARM_OPEN_PROBE, 975993);
  assert.ok(result.ok);
  assert.deepEqual(result.probed, {
    container: "mov,mp4,m4a,3gp,3g2,mj2",
    containerLongName: "QuickTime / MOV",
    videoCodec: "h264",
    width: 1080,
    height: 1920,
    durationSeconds: 8.042667,
    frameRate: 30,
    frameCount: 240,
    streamCount: 2,
    videoStreamCount: 1,
    audioStreamCount: 1,
    fileSizeBytes: 975993,
  });
});

test("an MP4 is recognised by the demuxer FAMILY ffprobe reports, not by its extension", () => {
  // ffprobe never reports a bare "mp4" -- it reports the whole family it matched. Equality would
  // have failed on every real file, which is exactly the bug an extension check would hide.
  assert.equal(isMp4Container("mov,mp4,m4a,3gp,3g2,mj2"), true);
  assert.equal(isMp4Container("mp4"), true);
  assert.equal(isMp4Container(" mov , mp4 "), true);
  assert.equal(isMp4Container("matroska,webm"), false);
  assert.equal(isMp4Container("avi"), false);
  assert.equal(isMp4Container(""), false);
});

test("frame rates parse as exact rationals, so 29.97 is not mistaken for 30", () => {
  assert.equal(parseFrameRate("30/1"), 30);
  assert.equal(parseFrameRate("60/1"), 60);
  assert.equal(parseFrameRate("25"), 25);
  assert.ok(Math.abs((parseFrameRate("30000/1001") ?? 0) - 29.97002997) < 1e-6);
  assert.notEqual(parseFrameRate("30000/1001"), 30);
  // 0/0 is what ffprobe prints for a stream with no meaningful rate.
  assert.equal(parseFrameRate("0/0"), null);
  assert.equal(parseFrameRate("30/0"), null);
  assert.equal(parseFrameRate("not-a-rate"), null);
});

test("unparsable, malformed and video-less inputs are rejected with distinguishable reasons", () => {
  const cases: [string, string][] = [
    ["not json at all", "unparsable-output"],
    ["[1,2,3]", "unparsable-output"],
    [JSON.stringify({ format: {} }), "unparsable-output"],
    [JSON.stringify({ streams: [] }), "unparsable-output"],
    [JSON.stringify({ format: {}, streams: [{ codec_type: "audio", codec_name: "aac" }] }), "no-video-stream"],
  ];
  for (const [raw, expected] of cases) {
    const result = parseFfprobeJson(raw, 100);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false ? result.reason : null, expected, `wrong reason for: ${raw.slice(0, 40)}`);
  }
});

test("a video stream missing dimensions, duration or frame rate is rejected rather than defaulted", () => {
  const base = { codec_type: "video", codec_name: "h264", width: 1080, height: 1920, avg_frame_rate: "30/1" };
  const noDimensions = JSON.stringify({ format: { duration: "8" }, streams: [{ ...base, width: undefined, height: undefined }] });
  const noDuration = JSON.stringify({ format: {}, streams: [base] });
  const noRate = JSON.stringify({ format: { duration: "8" }, streams: [{ ...base, avg_frame_rate: "0/0" }] });

  for (const raw of [noDimensions, noDuration, noRate]) {
    const result = parseFfprobeJson(raw, 100);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false ? result.reason : null, "unparsable-output");
  }
});

test("nb_frames is null rather than guessed when the container does not report it", () => {
  const raw = JSON.stringify({
    format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "8.0" },
    streams: [{ codec_type: "video", codec_name: "h264", width: 1080, height: 1920, avg_frame_rate: "30/1" }],
  });
  const result = parseFfprobeJson(raw, 100);
  assert.ok(result.ok);
  // duration * fps would have produced a plausible 240 here. A guess wearing a measurement's name is
  // worse than an honest null.
  assert.equal(result.probed.frameCount, null);
});

// --- the expectation check ------------------------------------------------------------------------

function probed(overrides: Partial<ProbedVideo> = {}): ProbedVideo {
  return {
    container: "mov,mp4,m4a,3gp,3g2,mj2",
    containerLongName: "QuickTime / MOV",
    videoCodec: "h264",
    width: 1080,
    height: 1920,
    durationSeconds: 8.042667,
    frameRate: 30,
    frameCount: 240,
    streamCount: 2,
    videoStreamCount: 1,
    audioStreamCount: 1,
    fileSizeBytes: 975993,
    ...overrides,
  };
}

const WARM_OPEN_EXPECTATION = { width: 1080, height: 1920, frameRate: 30, durationSeconds: 8 };

test("the real first render passes the expectation check", () => {
  assert.deepEqual(validateProbedVideo(probed(), WARM_OPEN_EXPECTATION), { ok: true });
});

test("the default duration tolerance covers the enforced silent audio track's padding", () => {
  // The measured overshoot was 0.042667s -- exactly two AAC frames at 48 kHz. A tolerance derived
  // from fps alone would be 0.0667s at 30fps (fine) but 0.0333s at 60fps (which this real, correct
  // render would then FAIL). Deriving it from audio granularity is what makes it fps-independent.
  assert.ok(defaultDurationToleranceSeconds(30) > 0.042667);
  assert.ok(defaultDurationToleranceSeconds(60) > 0.042667);
  assert.ok(defaultDurationToleranceSeconds(120) > 0.042667);
  // Still narrow enough to mean something: never as much as a fifth of a second.
  assert.ok(defaultDurationToleranceSeconds(30) < 0.2);
});

test("a video of the WRONG LENGTH still fails -- the tolerance is not a loophole", () => {
  const halfSecondLong = validateProbedVideo(probed({ durationSeconds: 8.5 }), WARM_OPEN_EXPECTATION);
  assert.equal(halfSecondLong.ok, false);
  assert.match(halfSecondLong.ok === false ? halfSecondLong.issues.join(" ") : "", /duration/);

  const wayShort = validateProbedVideo(probed({ durationSeconds: 6 }), WARM_OPEN_EXPECTATION);
  assert.equal(wayShort.ok, false);
});

test("each wrong fact fails on its own terms", () => {
  const cases: [Partial<ProbedVideo>, RegExp][] = [
    [{ container: "matroska,webm" }, /container/],
    [{ videoCodec: "vp9" }, /codec/],
    [{ width: 1920, height: 1080 }, /dimensions/],
    [{ frameRate: 29.97002997 }, /frame rate/],
    [{ videoStreamCount: 2 }, /1 video stream/],
    [{ audioStreamCount: 2 }, /audio stream/],
  ];
  for (const [override, pattern] of cases) {
    const result = validateProbedVideo(probed(override), WARM_OPEN_EXPECTATION);
    assert.equal(result.ok, false, `expected a failure for ${JSON.stringify(override)}`);
    assert.match(result.ok === false ? result.issues.join(" ") : "", pattern);
  }
});

test("every issue is reported at once rather than one per run", () => {
  const result = validateProbedVideo(probed({ container: "matroska,webm", videoCodec: "vp9", width: 720, height: 1280 }), WARM_OPEN_EXPECTATION);
  assert.equal(result.ok, false);
  assert.equal(result.ok === false ? result.issues.length : 0, 3);
});

test("a file over its asset kind's byte ceiling fails the check", () => {
  const overLimit = validateProbedVideo(probed({ fileSizeBytes: 60 * 1024 * 1024 }), { ...WARM_OPEN_EXPECTATION, maxFileSizeBytes: 50 * 1024 * 1024 });
  assert.equal(overLimit.ok, false);
  assert.match(overLimit.ok === false ? overLimit.issues.join(" ") : "", /exceeds the 52428800 byte limit/);

  assert.deepEqual(validateProbedVideo(probed(), { ...WARM_OPEN_EXPECTATION, maxFileSizeBytes: 50 * 1024 * 1024 }), { ok: true });
});
