import type { AssetGenerationSpecV1 } from "./asset-generation-spec.ts";

export type GeneratedAssetFileCandidate = {
  position: number;
  mimeType: string;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  fileSizeBytes: number;
};

export const GENERATED_ASSET_ALLOWED_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export const GENERATED_ASSET_MIN_DIMENSION_PX = 256;
export const GENERATED_ASSET_MAX_DIMENSION_PX = 4096;
export const GENERATED_ASSET_MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;

export type GeneratedAssetCandidateRejectionReason =
  | "malformed-candidates"
  | "wrong-file-count"
  | "unsupported-mime-type"
  | "dimension-mismatch"
  | "duration-present-for-image"
  | "empty-bytes"
  | "invalid-position";

export type GeneratedAssetCandidateValidation =
  | { ok: true; candidates: GeneratedAssetFileCandidate[] }
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
    Number.isFinite(value.fileSizeBytes)
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

  if (candidate.width !== spec.dimensions.width || candidate.height !== spec.dimensions.height) {
    return { ok: false, reason: "dimension-mismatch", message: `Image asset generation candidate dimensions must be ${spec.dimensions.width}x${spec.dimensions.height}.` };
  }

  if (candidate.durationMs !== null) {
    return { ok: false, reason: "duration-present-for-image", message: "Image asset generation candidates must not include durationMs." };
  }

  if (candidate.fileSizeBytes <= 0 || candidate.fileSizeBytes > GENERATED_ASSET_MAX_FILE_SIZE_BYTES) {
    return { ok: false, reason: "empty-bytes", message: "Image asset generation candidate fileSizeBytes must be greater than 0 and within the maximum file size." };
  }

  return { ok: true, candidates };
}
