import type { AssetGenerationSpecV1 } from "./asset-generation-spec.ts";
import type { ProductionSpecV1 } from "./production-spec.ts";

export type GeneratedAssetFileCandidate = {
  position: number;
  mimeType: string;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  fileSizeBytes: number;
  bytes: Uint8Array;
};

export const GENERATED_ASSET_ALLOWED_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;

// Production MVP Wave A. One member, deliberately: MP4/H.264 is the Production MVP video type, and a
// list of containers nothing produces would be a promise about formats no executor emits. Wave C
// adds the probe that checks these bytes are really what they claim; this constant only decides
// which claim is admissible.
//
// NOTE the asymmetry with the storage layer: declaring video/mp4 admissible HERE does not make it
// uploadable. The generated-assets bucket still rejects it until supabase-add-generated-assets-video.sql
// is applied by the owner. Both gates must open before a video reaches storage, and Wave A opens
// only this one.
export const GENERATED_ASSET_ALLOWED_VIDEO_MIME_TYPES = ["video/mp4"] as const;
export const GENERATED_ASSET_MIN_DIMENSION_PX = 256;
export const GENERATED_ASSET_MAX_DIMENSION_PX = 4096;
export const GENERATED_ASSET_MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;

// Advisory, not a rejection reason: a candidate's declared dimensions differing from the spec's
// requested dimensions no longer fails validation -- see validateGeneratedAssetCandidates below.
// Named distinctly from asset-binary.ts's "declared-dimension-mismatch", which is an unrelated,
// still-hard rejection (a candidate's declared dimensions vs. its own actual bytes).
export const SPEC_DIMENSION_ADVISORY_REASON = "spec-dimension-advisory";

export type GeneratedAssetCandidateRejectionReason =
  | "malformed-candidates"
  | "wrong-file-count"
  | "unsupported-mime-type"
  | "duration-present-for-image"
  // Wave A -- the video mirror of duration-present-for-image. A video candidate with no duration is
  // not a video anyone can show; the two reasons stay distinct so a failure says which rule was
  // broken rather than merely that duration was wrong.
  | "duration-missing-for-video"
  | "empty-bytes"
  | "invalid-position";

export type GeneratedAssetCandidateValidation =
  | { ok: true; candidates: GeneratedAssetFileCandidate[]; warnings: string[] }
  | { ok: false; reason: GeneratedAssetCandidateRejectionReason; message: string };

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isGeneratedAssetFileCandidate(value: unknown): value is GeneratedAssetFileCandidate {
  if (!isJsonObject(value)) {
    return false;
  }

  return (
    typeof value.position === "number" &&
    Number.isInteger(value.position) &&
    typeof value.mimeType === "string" &&
    value.mimeType.trim().length > 0 &&
    (value.width === null || typeof value.width === "number") &&
    (value.height === null || typeof value.height === "number") &&
    (value.durationMs === null || typeof value.durationMs === "number") &&
    typeof value.fileSizeBytes === "number" &&
    Number.isFinite(value.fileSizeBytes) &&
    value.bytes instanceof Uint8Array
  );
}

export function validateGeneratedAssetCandidates(
  candidates: unknown,
  spec: AssetGenerationSpecV1 | ProductionSpecV1,
): GeneratedAssetCandidateValidation {
  // Wave A -- the one branch that decides every kind-conditional rule below. AssetGenerationSpecV1
  // carries the literal "image", so the legacy path resolves here exactly as it always did and every
  // image rule and message below is byte-for-byte what it was.
  const isVideo = spec.assetKind === "short_video";

  if (!Array.isArray(candidates) || !candidates.every(isGeneratedAssetFileCandidate)) {
    return { ok: false, reason: "malformed-candidates", message: "Generated asset candidates must be an array of file candidate metadata." };
  }

  if (candidates.length !== 1) {
    return {
      ok: false,
      reason: "wrong-file-count",
      message: isVideo
        ? "Short video asset generation must return exactly one file candidate."
        : "Image asset generation must return exactly one file candidate.",
    };
  }

  const [candidate] = candidates;

  if (candidate.position !== 0) {
    return {
      ok: false,
      reason: "invalid-position",
      message: isVideo ? "Short video asset generation candidate position must be 0." : "Image asset generation candidate position must be 0.",
    };
  }

  // Each kind admits its own MIME family and only its own. A PNG returned for a short_video job, or
  // an MP4 returned for an image job, is an executor that produced the wrong thing -- not a
  // near-miss to be tolerated, because everything downstream (bucket MIME allow-list, owner preview
  // element, duration handling) branches on the kind having been honoured here.
  const allowed: readonly string[] = isVideo ? GENERATED_ASSET_ALLOWED_VIDEO_MIME_TYPES : GENERATED_ASSET_ALLOWED_MIME_TYPES;
  if (!allowed.includes(candidate.mimeType)) {
    return {
      ok: false,
      reason: "unsupported-mime-type",
      message: isVideo
        ? "Short video asset generation candidate mimeType is not supported."
        : "Image asset generation candidate mimeType is not supported.",
    };
  }

  // Advisory: a real external source (a human's workspace, a camera, a future API with different
  // native sizes) will rarely land on the spec's exact requested dimensions. This records the
  // mismatch and proceeds with the candidate's actual dimensions -- it never rejects.
  const warnings: string[] = [];
  if (candidate.width !== spec.dimensions.width || candidate.height !== spec.dimensions.height) {
    warnings.push(
      `${SPEC_DIMENSION_ADVISORY_REASON}: candidate dimensions ${candidate.width}x${candidate.height} do not match the requested ${spec.dimensions.width}x${spec.dimensions.height}. Proceeding with the candidate's actual dimensions.`,
    );
  }

  // The rule inverts on kind, and both halves are hard rejections. An image with a duration and a
  // video without one are each a candidate whose own metadata contradicts what it claims to be.
  if (isVideo) {
    if (candidate.durationMs === null || !Number.isFinite(candidate.durationMs) || candidate.durationMs <= 0) {
      return {
        ok: false,
        reason: "duration-missing-for-video",
        message: "Short video asset generation candidates must include a positive durationMs.",
      };
    }
  } else if (candidate.durationMs !== null) {
    return { ok: false, reason: "duration-present-for-image", message: "Image asset generation candidates must not include durationMs." };
  }

  // Kind-aware wording only. The reason code, the bound and the accept/reject behaviour are
  // deliberately unchanged -- this branch reads the same GENERATED_ASSET_MAX_FILE_SIZE_BYTES for
  // both kinds, and reconciling that per-kind limit is Wave C entry work, not a Wave A change. The
  // image message stays byte-identical to the one this milestone shipped with.
  if (candidate.fileSizeBytes <= 0 || candidate.fileSizeBytes > GENERATED_ASSET_MAX_FILE_SIZE_BYTES) {
    return {
      ok: false,
      reason: "empty-bytes",
      message: isVideo
        ? "Short video asset generation candidate fileSizeBytes must be greater than 0 and within the maximum file size."
        : "Image asset generation candidate fileSizeBytes must be greater than 0 and within the maximum file size.",
    };
  }

  return { ok: true, candidates, warnings };
}
