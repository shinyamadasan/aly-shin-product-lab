// Production MVP Wave C1 -- video validation that reads the FILE, not the filename.
//
// asset-binary.ts already holds this line for images: it decodes PNG/JPEG/WebP headers itself and
// rejects a candidate whose declared MIME or dimensions disagree with its own bytes. A video cannot
// be decoded by fifty lines of header parsing, so the same guarantee is bought differently -- by
// asking a real demuxer what the container actually holds.
//
// WHY ffprobe AND NOT getVideoMetadata()
//
// @remotion/renderer exports getVideoMetadata(), which is convenient and returns fps, dimensions,
// duration and codec. It does not report the CONTAINER or the STREAM COUNT, and both are part of the
// question being asked. A file with two video streams, or an MP4 whose real container is something
// else, is exactly the kind of thing "do not trust the extension alone" is about -- so the probe is
// the one that answers all of it, from one invocation, in one JSON document.
//
// LOCAL PROOF vs RUNTIME PACKAGING -- and they are deliberately not the same decision.
//
// C1 needs a clean contract and a real probe on this workstation. Whether a deployed C2 worker ships
// an ffprobe binary, calls Remotion's, or uses getVideoMetadata() instead is a packaging decision
// that depends on where that worker runs, which C1 does not decide. What C1 fixes is the SHAPE:
// parseFfprobeJson below is pure and knows nothing about processes, so a future runtime that obtains
// the same JSON some other way reuses the parser and every test written against it.

export type ProbedVideo = {
  // ffprobe's own answer, verbatim. For an MP4 this is the comma-joined demuxer family
  // "mov,mp4,m4a,3gp,3g2,mj2" -- the probe reports what it recognised, and isMp4Container below is
  // what turns that into a yes-or-no rather than this field pretending to be tidier than it is.
  container: string;
  containerLongName: string;
  videoCodec: string;
  width: number;
  height: number;
  durationSeconds: number;
  frameRate: number;
  // ffprobe reports nb_frames for some containers and not others. Null is honest; a computed
  // duration * fps here would be a guess wearing a measurement's name.
  frameCount: number | null;
  streamCount: number;
  videoStreamCount: number;
  audioStreamCount: number;
  fileSizeBytes: number;
};

export type ProbeFailureReason = "probe-unavailable" | "probe-failed" | "unparsable-output" | "no-video-stream" | "missing-file";

export type ProbeResult = { ok: true; probed: ProbedVideo } | { ok: false; reason: ProbeFailureReason; message: string };

// The demuxer family an MP4 belongs to. ffprobe does not report "mp4" on its own -- it reports the
// whole family it matched -- so membership, not equality, is the correct test.
export function isMp4Container(container: string): boolean {
  return container
    .split(",")
    .map((entry) => entry.trim())
    .includes("mp4");
}

// ffprobe reports frame rates as an exact rational ("30/1", "30000/1001"), which is the only lossless
// way to express 29.97. Parsed as a rational and divided once, rather than parsed as a float, so a
// 30000/1001 stream is recognisably not 30 instead of rounding into it.
export function parseFrameRate(rational: string): number | null {
  const [numeratorText, denominatorText] = rational.split("/");
  const numerator = Number(numeratorText);
  const denominator = denominatorText === undefined ? 1 : Number(denominatorText);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
    return null;
  }
  const frameRate = numerator / denominator;
  return Number.isFinite(frameRate) && frameRate > 0 ? frameRate : null;
}

function readNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

// PURE. Takes the JSON ffprobe printed and the size of the file on disk, and returns facts. No
// process, no filesystem, no environment -- which is what makes every parsing rule below testable
// from a fixture string under `node --test`, with no binary present.
export function parseFfprobeJson(rawJson: string, fileSizeBytes: number): ProbeResult {
  let document: unknown;
  try {
    document = JSON.parse(rawJson);
  } catch {
    return { ok: false, reason: "unparsable-output", message: "ffprobe output was not valid JSON." };
  }

  if (!document || typeof document !== "object" || Array.isArray(document)) {
    return { ok: false, reason: "unparsable-output", message: "ffprobe output was not a JSON object." };
  }

  const { format, streams } = document as { format?: unknown; streams?: unknown };
  if (!format || typeof format !== "object" || !Array.isArray(streams)) {
    return { ok: false, reason: "unparsable-output", message: "ffprobe output is missing a format object or a streams array." };
  }

  const formatRecord = format as Record<string, unknown>;
  const streamRecords = streams.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object" && !Array.isArray(entry));

  const videoStreams = streamRecords.filter((stream) => stream.codec_type === "video");
  const audioStreams = streamRecords.filter((stream) => stream.codec_type === "audio");

  const [videoStream] = videoStreams;
  if (!videoStream) {
    return { ok: false, reason: "no-video-stream", message: "The probed file contains no video stream." };
  }

  const width = readNumber(videoStream.width);
  const height = readNumber(videoStream.height);
  if (width === null || height === null) {
    return { ok: false, reason: "unparsable-output", message: "ffprobe reported a video stream with no usable width or height." };
  }

  // Container duration first, stream duration second. The container's own duration is the one a
  // player honours, and it is the one that must match what the composition asked for.
  const durationSeconds = readNumber(formatRecord.duration) ?? readNumber(videoStream.duration);
  if (durationSeconds === null) {
    return { ok: false, reason: "unparsable-output", message: "ffprobe reported no duration for the probed file." };
  }

  const frameRateText = typeof videoStream.avg_frame_rate === "string" ? videoStream.avg_frame_rate : null;
  const frameRate = frameRateText === null ? null : parseFrameRate(frameRateText);
  if (frameRate === null) {
    return { ok: false, reason: "unparsable-output", message: `ffprobe reported an unusable frame rate: ${String(videoStream.avg_frame_rate)}.` };
  }

  return {
    ok: true,
    probed: {
      container: typeof formatRecord.format_name === "string" ? formatRecord.format_name : "",
      containerLongName: typeof formatRecord.format_long_name === "string" ? formatRecord.format_long_name : "",
      videoCodec: typeof videoStream.codec_name === "string" ? videoStream.codec_name : "",
      width,
      height,
      durationSeconds,
      frameRate,
      frameCount: readNumber(videoStream.nb_frames),
      streamCount: streamRecords.length,
      videoStreamCount: videoStreams.length,
      audioStreamCount: audioStreams.length,
      fileSizeBytes,
    },
  };
}

// --- the expectation check ----------------------------------------------------------------------------
//
// Separate from the probe on purpose. The probe reports what the file IS; this decides whether that
// is what was asked for. Keeping them apart is what lets C2 reuse the same expectation check against
// a probe obtained some other way, and lets a reviewer read the facts without a verdict attached.

export type VideoExpectation = {
  width: number;
  height: number;
  frameRate: number;
  durationSeconds: number;
  // A container's duration is the duration of its LONGEST stream, so the tolerance has to cover the
  // stream that overshoots the most -- and measurement showed that is the audio, not the video.
  //
  // The first warm-open render asked for 8s and the container reported 8.042667s. That is not drift:
  // AAC is framed at 1024 samples, which is 1024/48000 = 0.0213s at 48 kHz, and the enforced silent
  // track is padded up to a whole number of those frames past the end of the video. 0.042667s is
  // exactly two of them.
  //
  // So the default is the larger of two video frames and three AAC frames. Deriving it rather than
  // hardcoding 0.05 is what keeps it correct at a different fps: at 60fps two video frames is
  // 0.033s, which the audio padding alone would exceed, and a fixed video-only tolerance would start
  // failing correct renders.
  toleranceSeconds?: number;
  maxFileSizeBytes?: number;
  // At most ONE, and one is the normal case rather than a tolerated defect.
  //
  // The first real render of warm-open produced two streams where a composition that authors no
  // audio might be expected to produce one. That is Remotion's `enforceAudioTrack`, which defaults to
  // true and adds a SILENT AAC track: several social platforms and players handle an audio-less MP4
  // badly, so a Reel that will be uploaded wants the track even when there is nothing to hear. The
  // setting is now pinned explicitly in REMOTION_RENDER_SETTINGS rather than inherited, so it is a
  // decision on the record.
  //
  // The bound stays at one. Two audio streams would be an encoder doing something nobody asked for,
  // which is the thing this check exists to notice.
  maxAudioStreams?: number;
};

export type VideoExpectationResult = { ok: true } | { ok: false; issues: string[] };

// One AAC frame is 1024 samples; at 48 kHz that is the granularity the enforced silent track is
// padded to. Named rather than inlined because the tolerance below is only defensible if the reason
// for its size is visible.
const AAC_FRAME_SECONDS_AT_48KHZ = 1024 / 48000;
const AUDIO_PADDING_FRAME_ALLOWANCE = 3;
const VIDEO_FRAME_ALLOWANCE = 2;

export function defaultDurationToleranceSeconds(frameRate: number): number {
  return Math.max(VIDEO_FRAME_ALLOWANCE / frameRate, AUDIO_PADDING_FRAME_ALLOWANCE * AAC_FRAME_SECONDS_AT_48KHZ);
}

export function validateProbedVideo(probed: ProbedVideo, expectation: VideoExpectation): VideoExpectationResult {
  const tolerance = expectation.toleranceSeconds ?? defaultDurationToleranceSeconds(expectation.frameRate);
  const issues: string[] = [];

  if (!isMp4Container(probed.container)) {
    issues.push(`container: expected an MP4 container, ffprobe reported "${probed.container}".`);
  }
  if (probed.videoCodec !== "h264") {
    issues.push(`codec: expected h264, ffprobe reported "${probed.videoCodec}".`);
  }
  if (probed.width !== expectation.width || probed.height !== expectation.height) {
    issues.push(`dimensions: expected ${expectation.width}x${expectation.height}, ffprobe reported ${probed.width}x${probed.height}.`);
  }
  if (Math.abs(probed.frameRate - expectation.frameRate) > 0.001) {
    issues.push(`frame rate: expected ${expectation.frameRate}, ffprobe reported ${probed.frameRate}.`);
  }
  if (Math.abs(probed.durationSeconds - expectation.durationSeconds) > tolerance) {
    issues.push(`duration: expected ${expectation.durationSeconds}s within ${tolerance.toFixed(4)}s, ffprobe reported ${probed.durationSeconds}s.`);
  }
  // Exactly one video stream. More than one is an encoder or a container doing something the
  // composition did not ask for, and it is precisely what a stream count is here to catch.
  if (probed.videoStreamCount !== 1) {
    issues.push(`streams: expected exactly 1 video stream, ffprobe reported ${probed.videoStreamCount}.`);
  }
  const maxAudioStreams = expectation.maxAudioStreams ?? 1;
  if (probed.audioStreamCount > maxAudioStreams) {
    issues.push(`streams: expected at most ${maxAudioStreams} audio stream(s), ffprobe reported ${probed.audioStreamCount}.`);
  }
  if (expectation.maxFileSizeBytes !== undefined && probed.fileSizeBytes > expectation.maxFileSizeBytes) {
    issues.push(`size: ${probed.fileSizeBytes} bytes exceeds the ${expectation.maxFileSizeBytes} byte limit for this asset kind.`);
  }

  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}

// --- invocation lives ELSEWHERE, on purpose --------------------------------------------------------
//
// Wave C2A moved binary resolution and the process spawn out of this module and into
// src/remotion/runtime/ffprobe-runtime.ts.
//
// What is left here is PURE: parseFfprobeJson, validateProbedVideo, parseFrameRate, isMp4Container
// and the tolerance derivation. No node:child_process, no node:fs, no environment read, no
// @remotion/renderer import -- so every rule above can be exercised from a fixture string with no
// binary present, and a C2B runtime that obtains the same JSON some other way (a container sidecar,
// a managed probe service, getVideoMetadata) reuses this file and every test written against it
// without change.
//
// C1 kept the two halves together and reached RenderInternals.getExecutablePath from here. That put
// an undocumented internal API and a node_modules layout assumption inside domain validation, which
// is exactly the leak C2A was asked to close. See ffprobe-runtime.ts for why no stable public API
// replaces it, and for the fallback that makes the internal accessor acceptable.
