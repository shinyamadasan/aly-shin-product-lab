import { sha256Hex } from "./asset-digest.ts";
import {
  GENERATED_ASSET_ALLOWED_MIME_TYPES,
  GENERATED_ASSET_ALLOWED_VIDEO_MIME_TYPES,
  maxGeneratedAssetFileSizeBytes,
  type GeneratedAssetFileCandidate,
} from "./asset-generation-validation.ts";
import type { AssetKind } from "./asset-jobs.ts";

export const GENERATED_ASSETS_BUCKET = "generated-assets";

// UNCHANGED, and deliberately still the IMAGE union.
//
// production-asset-executors.ts and production-manual-composition.ts both type their own reference
// and illustration MIME fields with this, and neither of them can ever hold a video. Widening it
// here would have quietly told those two modules that an MP4 was an acceptable illustration. The
// video type is a sibling below, and the union of the two is a third, explicitly named type that
// only the media-aware code paths use.
export type SupportedGeneratedAssetMimeType = (typeof GENERATED_ASSET_ALLOWED_MIME_TYPES)[number];
export type SupportedGeneratedAssetVideoMimeType = (typeof GENERATED_ASSET_ALLOWED_VIDEO_MIME_TYPES)[number];
export type SupportedGeneratedAssetMediaMimeType = SupportedGeneratedAssetMimeType | SupportedGeneratedAssetVideoMimeType;

export type GeneratedAssetFileExtension = "png" | "jpg" | "webp" | "mp4";

export type InspectedAssetCandidate = {
  candidate: GeneratedAssetFileCandidate;
  actualMimeType: SupportedGeneratedAssetMediaMimeType;
  actualWidth: number;
  actualHeight: number;
  // Wave C2A. Null for every image, and null is the ONLY correct answer there -- an image has no
  // duration, and asset-generation-validation.ts already rejects an image candidate that declares
  // one. For a video it is read out of the container's own mvhd box, never from the candidate's
  // declaration, which is what makes the declared-vs-actual check below meaningful.
  actualDurationMs: number | null;
  extension: GeneratedAssetFileExtension;
  byteSize: number;
  sha256: string;
  bytes: Uint8Array;
};

export type AssetBinaryInspection =
  | { ok: true; facts: Omit<InspectedAssetCandidate, "candidate"> }
  | { ok: false; reason: "invalid-binary" | "unsupported-mime" | "unsupported-video-codec"; message: string };

// The NARROW result inspectAssetBytes returns, and the reason it is worth having its own type.
//
// inspectAssetBytes can only ever produce an image, and three modules rely on that in their own
// types: production-asset-executors.ts types a generative reference's MIME as the image union, and
// production-manual-composition.ts does the same for an owner's illustration. If the image inspector
// returned the widened media union, both would start believing an MP4 could be an illustration -- a
// nonsense the compiler would have no way to reject. So the widening stops at the media-aware
// entry points, and the image inspector keeps saying exactly what it has always said.
export type InspectedImageFacts = DecodedImageFacts & {
  actualDurationMs: null;
  byteSize: number;
  sha256: string;
  bytes: Uint8Array;
};

export type AssetImageBinaryInspection =
  | { ok: true; facts: InspectedImageFacts }
  | { ok: false; reason: "invalid-binary" | "unsupported-mime"; message: string };

export type AssetByteValidation =
  | { ok: true; inspected: InspectedAssetCandidate }
  | {
      ok: false;
      reason:
        | "invalid-binary"
        | "unsupported-mime"
        | "unsupported-video-codec"
        | "empty-bytes"
        | "file-too-large"
        | "mime-mismatch"
        | "declared-dimension-mismatch"
        | "declared-duration-mismatch"
        | "file-size-mismatch";
      message: string;
    };

// What the three IMAGE decoders below return. Named rather than derived from
// InspectedAssetCandidate so that adding a video-only field to that type (actualDurationMs) does not
// force three image decoders to start declaring a duration they can never have.
type DecodedImageFacts = {
  actualMimeType: SupportedGeneratedAssetMimeType;
  actualWidth: number;
  actualHeight: number;
  extension: "png" | "jpg" | "webp";
};

function readUint32BigEndian(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) << 24) + ((bytes[offset + 1] ?? 0) << 16) + ((bytes[offset + 2] ?? 0) << 8) + (bytes[offset + 3] ?? 0);
}

function readUint16BigEndian(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) << 8) + (bytes[offset + 1] ?? 0);
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.slice(start, start + length));
}

function decodePng(bytes: Uint8Array): DecodedImageFacts | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || !signature.every((value, index) => bytes[index] === value) || ascii(bytes, 12, 4) !== "IHDR") {
    return null;
  }
  return { actualMimeType: "image/png", actualWidth: readUint32BigEndian(bytes, 16), actualHeight: readUint32BigEndian(bytes, 20), extension: "png" };
}

function decodeJpeg(bytes: Uint8Array): DecodedImageFacts | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return null;
  }

  let offset = 2;
  while (offset + 8 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1];
    const segmentLength = readUint16BigEndian(bytes, offset + 2);
    if (segmentLength < 2 || offset + 2 + segmentLength > bytes.length) {
      return null;
    }
    const isStartOfFrame = marker !== undefined && ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf));
    if (isStartOfFrame) {
      return {
        actualMimeType: "image/jpeg",
        actualHeight: readUint16BigEndian(bytes, offset + 5),
        actualWidth: readUint16BigEndian(bytes, offset + 7),
        extension: "jpg",
      };
    }
    offset += 2 + segmentLength;
  }

  return null;
}

function decodeWebp(bytes: Uint8Array): DecodedImageFacts | null {
  if (bytes.length < 30 || ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WEBP") {
    return null;
  }

  const chunk = ascii(bytes, 12, 4);
  if (chunk === "VP8X") {
    const actualWidth = 1 + (bytes[24] ?? 0) + ((bytes[25] ?? 0) << 8) + ((bytes[26] ?? 0) << 16);
    const actualHeight = 1 + (bytes[27] ?? 0) + ((bytes[28] ?? 0) << 8) + ((bytes[29] ?? 0) << 16);
    return { actualMimeType: "image/webp", actualWidth, actualHeight, extension: "webp" };
  }

  if (chunk === "VP8 " && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    return {
      actualMimeType: "image/webp",
      actualWidth: readUint16BigEndian(new Uint8Array([bytes[27] ?? 0, bytes[26] ?? 0]), 0) & 0x3fff,
      actualHeight: readUint16BigEndian(new Uint8Array([bytes[29] ?? 0, bytes[28] ?? 0]), 0) & 0x3fff,
      extension: "webp",
    };
  }

  return null;
}

function decodeGif(bytes: Uint8Array): boolean {
  return bytes.length >= 10 && (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a");
}

// --- MP4, decoded as a CONTAINER and never as an image ------------------------------------------------
//
// Wave C2A. This is the video counterpart of decodePng/decodeJpeg/decodeWebp above, and it exists for
// exactly the reason they do: the declared MIME type and the filename are both things a caller says,
// and neither is evidence. The only evidence is the bytes.
//
// It is deliberately a STRUCTURAL parse rather than a signature sniff. Checking for "ftyp" at offset 4
// would let any file with four lucky bytes through; what actually has to be true is that the file
// contains a real box tree with a movie header, a video track, and an H.264 sample entry, and that
// its own declared dimensions and duration come out of that tree. Nothing here decodes a single frame
// of video -- it reads the container's index, which is all a byte-level gate needs.
//
// WHY NOT ffprobe HERE. This module is reachable from the browser (asset-upload-intake.ts ->
// buildAssetUploadCandidateFromBlob is called from a client component), so it cannot spawn a process.
// ffprobe still runs -- in the worker runtime, before the candidate is ever built, checking the things
// a container index cannot answer (real frame rate, stream counts, codec profile). The two are
// layered on purpose and they must agree; src/remotion/probe.ts owns the deep check and this owns the
// gate that no upload path can bypass.
//
// NOT HANDLED, and stated rather than hidden: a fragmented MP4 (fMP4) carries duration 0 in mvhd and
// its real duration in the fragments. Such a file is rejected here for having no duration, which is
// correct for this engine -- Remotion emits a regular, non-fragmented MP4 -- but it is a limitation,
// not a universal truth about MP4. Rotation matrices are likewise ignored; the coded dimensions from
// the sample entry are used as-is.

const MP4_BRANDS = new Set(["isom", "iso2", "iso4", "iso5", "iso6", "mp41", "mp42", "avc1", "dash", "M4V ", "mmp4"]);
// avc1 and avc3 are the two H.264 sample entry formats. Nothing else is admissible: this engine emits
// H.264, GENERATED_ASSET_ALLOWED_VIDEO_MIME_TYPES admits exactly video/mp4, and an HEVC or AV1 track
// in an .mp4 would be a file no part of this pipeline promised to produce or play.
const H264_SAMPLE_ENTRY_FORMATS = new Set(["avc1", "avc3"]);

type Mp4Box = { type: string; contentStart: number; end: number };

// Yields the boxes between `start` and `end`, stopping at the first structurally impossible one
// rather than throwing. A truncated or hostile file simply runs out of boxes, and every caller
// already treats "not found" as a rejection.
function* mp4Boxes(bytes: Uint8Array, start: number, end: number): Generator<Mp4Box> {
  let offset = start;
  while (offset + 8 <= end) {
    const declaredSize = readUint32BigEndian(bytes, offset);
    const type = ascii(bytes, offset + 4, 4);

    let contentStart = offset + 8;
    let boxEnd: number;
    if (declaredSize === 1) {
      // 64-bit largesize. Read as two 32-bit halves because a single readUint32 pair is all this
      // module has; anything beyond Number.MAX_SAFE_INTEGER is far past any size limit we allow.
      if (offset + 16 > end) {
        return;
      }
      boxEnd = offset + readUint32BigEndian(bytes, offset + 8) * 2 ** 32 + readUint32BigEndian(bytes, offset + 12);
      contentStart = offset + 16;
    } else if (declaredSize === 0) {
      // "to end of file" -- legal only for the last box.
      boxEnd = end;
    } else {
      boxEnd = offset + declaredSize;
    }

    if (!Number.isSafeInteger(boxEnd) || boxEnd <= offset || boxEnd > end || contentStart > boxEnd) {
      return;
    }

    yield { type, contentStart, end: boxEnd };
    offset = boxEnd;
  }
}

function findMp4Box(bytes: Uint8Array, start: number, end: number, type: string): Mp4Box | null {
  for (const box of mp4Boxes(bytes, start, end)) {
    if (box.type === type) {
      return box;
    }
  }
  return null;
}

// Walks a chain of nested box types, e.g. mdia -> minf -> stbl -> stsd.
function findMp4BoxPath(bytes: Uint8Array, box: Mp4Box, path: readonly string[]): Mp4Box | null {
  let current: Mp4Box | null = box;
  for (const type of path) {
    if (!current) {
      return null;
    }
    current = findMp4Box(bytes, current.contentStart, current.end, type);
  }
  return current;
}

type Mp4MovieHeader = { durationMs: number };

function readMp4MovieHeader(bytes: Uint8Array, moov: Mp4Box): Mp4MovieHeader | null {
  const mvhd = findMp4Box(bytes, moov.contentStart, moov.end, "mvhd");
  if (!mvhd) {
    return null;
  }
  const version = bytes[mvhd.contentStart];
  // Field offsets are from the start of the box CONTENT, after the 4-byte version+flags.
  //   v0: creation(4) modification(4) timescale(4) duration(4)   -> timescale +12, duration +16
  //   v1: creation(8) modification(8) timescale(4) duration(8)   -> timescale +20, duration +24
  const timescaleOffset = version === 1 ? mvhd.contentStart + 20 : mvhd.contentStart + 12;
  const durationOffset = version === 1 ? mvhd.contentStart + 24 : mvhd.contentStart + 16;
  const requiredEnd = version === 1 ? durationOffset + 8 : durationOffset + 4;
  if (requiredEnd > mvhd.end) {
    return null;
  }

  const timescale = readUint32BigEndian(bytes, timescaleOffset);
  const duration =
    version === 1
      ? readUint32BigEndian(bytes, durationOffset) * 2 ** 32 + readUint32BigEndian(bytes, durationOffset + 4)
      : readUint32BigEndian(bytes, durationOffset);

  if (timescale <= 0 || duration <= 0 || !Number.isSafeInteger(duration)) {
    return null;
  }

  return { durationMs: Math.round((duration / timescale) * 1000) };
}

function isVideoTrack(bytes: Uint8Array, trak: Mp4Box): boolean {
  const hdlr = findMp4BoxPath(bytes, trak, ["mdia", "hdlr"]);
  // hdlr content: version+flags(4) pre_defined(4) handler_type(4) -> handler_type at +8.
  return Boolean(hdlr && hdlr.contentStart + 12 <= hdlr.end && ascii(bytes, hdlr.contentStart + 8, 4) === "vide");
}

type Mp4VideoTrack = { width: number; height: number; sampleFormat: string };

function readMp4VideoTrack(bytes: Uint8Array, moov: Mp4Box): Mp4VideoTrack | null {
  for (const trak of mp4Boxes(bytes, moov.contentStart, moov.end)) {
    if (trak.type !== "trak" || !isVideoTrack(bytes, trak)) {
      continue;
    }

    const stsd = findMp4BoxPath(bytes, trak, ["mdia", "minf", "stbl", "stsd"]);
    if (!stsd) {
      return null;
    }
    // stsd content: version+flags(4) entry_count(4), then the sample entries themselves.
    const [entry] = [...mp4Boxes(bytes, stsd.contentStart + 8, stsd.end)];
    if (!entry) {
      return null;
    }

    // VisualSampleEntry, measured from the START of the entry box (which is entry.contentStart - 8):
    //   size(4) format(4) reserved(6) data_reference_index(2)  -> 16
    //   pre_defined(2) reserved(2) pre_defined[3](12)          -> 32
    //   width(2) height(2)                                     -> 32 and 34
    const entryStart = entry.contentStart - 8;
    if (entryStart + 36 > entry.end) {
      return null;
    }

    return {
      width: readUint16BigEndian(bytes, entryStart + 32),
      height: readUint16BigEndian(bytes, entryStart + 34),
      sampleFormat: entry.type,
    };
  }

  return null;
}

type DecodedVideoFacts = {
  actualMimeType: SupportedGeneratedAssetVideoMimeType;
  actualWidth: number;
  actualHeight: number;
  actualDurationMs: number;
  extension: "mp4";
};

type Mp4DecodeFailure = { reason: "invalid-binary" | "unsupported-video-codec"; message: string };

function decodeMp4(bytes: Uint8Array): DecodedVideoFacts | Mp4DecodeFailure {
  const invalid = (message: string): Mp4DecodeFailure => ({ reason: "invalid-binary", message });

  const ftyp = findMp4Box(bytes, 0, bytes.length, "ftyp");
  // ftyp must be FIRST, not merely present: a file that only contains the four characters somewhere
  // inside it is not an MP4, and this is where a renamed PNG or an arbitrary blob is caught.
  if (!ftyp || ftyp.contentStart !== 8) {
    return invalid("Generated asset bytes are not an MP4 container (no leading ftyp box).");
  }

  // major_brand(4) minor_version(4) then the compatible_brands list.
  const brands: string[] = [ascii(bytes, ftyp.contentStart, 4)];
  for (let offset = ftyp.contentStart + 8; offset + 4 <= ftyp.end; offset += 4) {
    brands.push(ascii(bytes, offset, 4));
  }
  if (!brands.some((brand) => MP4_BRANDS.has(brand))) {
    return invalid(`Generated asset bytes declare no MP4-compatible brand (found: ${brands.join(", ")}).`);
  }

  const moov = findMp4Box(bytes, 0, bytes.length, "moov");
  if (!moov) {
    return invalid("Generated asset MP4 has no moov box.");
  }

  const movieHeader = readMp4MovieHeader(bytes, moov);
  if (!movieHeader) {
    return invalid("Generated asset MP4 has no readable duration in its movie header.");
  }

  const videoTrack = readMp4VideoTrack(bytes, moov);
  if (!videoTrack) {
    return invalid("Generated asset MP4 has no readable video track.");
  }
  if (videoTrack.width <= 0 || videoTrack.height <= 0) {
    return invalid("Generated asset MP4 has invalid coded dimensions.");
  }
  if (!H264_SAMPLE_ENTRY_FORMATS.has(videoTrack.sampleFormat)) {
    return {
      reason: "unsupported-video-codec",
      message: `Generated asset MP4 video track is "${videoTrack.sampleFormat}", not H.264 (avc1/avc3).`,
    };
  }

  return {
    actualMimeType: "video/mp4",
    actualWidth: videoTrack.width,
    actualHeight: videoTrack.height,
    actualDurationMs: movieHeader.durationMs,
    extension: "mp4",
  };
}

export async function inspectAssetBytes(bytes: Uint8Array): Promise<AssetImageBinaryInspection> {
  const decoded = decodePng(bytes) ?? decodeJpeg(bytes) ?? decodeWebp(bytes);
  if (!decoded) {
    return decodeGif(bytes)
      ? { ok: false, reason: "unsupported-mime", message: "Generated asset bytes decode as image/gif, which is not supported." }
      : { ok: false, reason: "invalid-binary", message: "Generated asset bytes are not a decodable PNG, JPEG, or WebP image." };
  }
  if (decoded.actualWidth <= 0 || decoded.actualHeight <= 0) {
    return { ok: false, reason: "invalid-binary", message: "Generated asset bytes have invalid decoded dimensions." };
  }

  return {
    ok: true,
    facts: {
      ...decoded,
      // An image has no duration, and this is the only place that fact is asserted rather than
      // assumed. asset-generation-validation.ts independently rejects an image candidate that
      // DECLARES one; together the two mean an image can neither claim nor acquire a duration.
      actualDurationMs: null,
      byteSize: bytes.length,
      sha256: await sha256Hex(bytes),
      bytes,
    },
  };
}

// The VIDEO sibling of inspectAssetBytes. Separate function, not a mode of it, because "decode this
// as an image" and "decode this as a movie container" are different questions with different failure
// vocabularies -- and because keeping them apart is what makes "do not decode MP4 as an image"
// structural rather than a rule someone has to remember.
export async function inspectVideoBytes(bytes: Uint8Array): Promise<AssetBinaryInspection> {
  const decoded = decodeMp4(bytes);
  if ("reason" in decoded) {
    return { ok: false, reason: decoded.reason, message: decoded.message };
  }

  return {
    ok: true,
    facts: {
      ...decoded,
      byteSize: bytes.length,
      sha256: await sha256Hex(bytes),
      bytes,
    },
  };
}

// The one kind-aware entry point. Every media-aware caller goes through this rather than choosing a
// decoder itself, so the kind decides the decoder exactly once and no call site can pick the wrong
// one for the job it is running.
export async function inspectMediaBytes(bytes: Uint8Array, assetKind: AssetKind): Promise<AssetBinaryInspection> {
  return assetKind === "short_video" ? inspectVideoBytes(bytes) : inspectAssetBytes(bytes);
}

// assetKind DEFAULTS to "image", and the default is a statement of history rather than a convenience:
// "image" is the only kind this function has ever handled, so every existing caller and test keeps
// byte-identical behaviour without being touched. The Asset Job runner passes the real kind, which is
// what activates the video path.
export async function validateAssetCandidateBytes(candidate: GeneratedAssetFileCandidate, assetKind: AssetKind = "image"): Promise<AssetByteValidation> {
  if (candidate.bytes.length === 0) {
    return { ok: false, reason: "empty-bytes", message: "Generated asset bytes must not be empty." };
  }
  // PER KIND, from the one canonical table in asset-generation-validation.ts. For an image this
  // resolves to the same 10 MiB it always did; a short_video is measured against the 50 MiB ceiling
  // that matches the storage bucket, so the application and storage refuse the same files.
  const maxFileSizeBytes = maxGeneratedAssetFileSizeBytes(assetKind);
  if (candidate.bytes.length > maxFileSizeBytes) {
    return { ok: false, reason: "file-too-large", message: `Generated asset bytes exceed ${maxFileSizeBytes} bytes.` };
  }

  const inspection = await inspectMediaBytes(candidate.bytes, assetKind);
  if (!inspection.ok) {
    return inspection;
  }

  if (candidate.mimeType !== inspection.facts.actualMimeType) {
    return { ok: false, reason: "mime-mismatch", message: `Generated asset declared MIME ${candidate.mimeType} does not match decoded MIME ${inspection.facts.actualMimeType}.` };
  }
  // Anti-tamper check, unaffected by the spec-dimension advisory in asset-generation-validation.ts:
  // this compares the candidate's own declared metadata against its own actual bytes and must
  // always stay a hard rejection.
  if (candidate.width !== inspection.facts.actualWidth || candidate.height !== inspection.facts.actualHeight) {
    return { ok: false, reason: "declared-dimension-mismatch", message: `Generated asset declared dimensions ${candidate.width}x${candidate.height} do not match decoded dimensions ${inspection.facts.actualWidth}x${inspection.facts.actualHeight}.` };
  }
  if (candidate.fileSizeBytes !== inspection.facts.byteSize) {
    return { ok: false, reason: "file-size-mismatch", message: `Generated asset declared fileSizeBytes ${candidate.fileSizeBytes} does not match actual byte size ${inspection.facts.byteSize}.` };
  }
  // The duration counterpart of the dimension anti-tamper check above, and it only exists for video.
  //
  // Tolerance is one whole SECOND, and that is not slack -- it is the resolution of the question.
  // mvhd states duration in movie timescale units, the encoder rounds the last sample's presentation
  // time, and the enforced silent audio track is padded to whole AAC frames. A candidate that
  // declares 8000ms for a container reporting 8043ms is the same video; one declaring 6000ms is not.
  const declaredDurationMs = candidate.durationMs;
  const actualDurationMs = inspection.facts.actualDurationMs;
  if (actualDurationMs !== null && declaredDurationMs !== null && Math.abs(declaredDurationMs - actualDurationMs) > 1000) {
    return {
      ok: false,
      reason: "declared-duration-mismatch",
      message: `Generated asset declared durationMs ${declaredDurationMs} does not match decoded duration ${actualDurationMs}.`,
    };
  }

  return { ok: true, inspected: { candidate, ...inspection.facts } };
}

export function buildGeneratedAssetObjectPath(args: { assetJobId: string; attemptNumber: number; sha256: string; extension: string }): string {
  return `asset-jobs/${args.assetJobId}/attempt-${args.attemptNumber}/${args.sha256}.${args.extension}`;
}
