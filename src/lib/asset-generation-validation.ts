import type { AssetGenerationSpecV1 } from "./asset-generation-spec.ts";

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

export function validateGeneratedAssetCandidates(candidates: unknown, spec: AssetGenerationSpecV1): GeneratedAssetCandidateValidation {
  if (!Array.isArray(candidates) || !candidates.every(isGeneratedAssetFileCandidate)) {
    return { ok: false, reason: "malformed-candidates", message: "Generated asset candidates must be an array of file candidate metadata." };
  }

  if (candidates.length !== 1) {
    return { ok: false, reason: "wrong-file-count", message: "Image asset generation must return exactly one file candidate." };
  }

  const [candidate] = candidates;

  if (candidate.position !== 0) {
    return { ok: false, reason: "invalid-position", message: "Image asset generation candidate position must be 0." };
  }

  if (!GENERATED_ASSET_ALLOWED_MIME_TYPES.includes(candidate.mimeType as (typeof GENERATED_ASSET_ALLOWED_MIME_TYPES)[number])) {
    return { ok: false, reason: "unsupported-mime-type", message: "Image asset generation candidate mimeType is not supported." };
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

  if (candidate.durationMs !== null) {
    return { ok: false, reason: "duration-present-for-image", message: "Image asset generation candidates must not include durationMs." };
  }

  if (candidate.fileSizeBytes <= 0 || candidate.fileSizeBytes > GENERATED_ASSET_MAX_FILE_SIZE_BYTES) {
    return { ok: false, reason: "empty-bytes", message: "Image asset generation candidate fileSizeBytes must be greater than 0 and within the maximum file size." };
  }

  return { ok: true, candidates, warnings };
}
