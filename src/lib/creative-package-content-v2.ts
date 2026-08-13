import { isCreativeFormat, isCreativePlatform, type CreativePlatform } from "./creative-formats.ts";
import { isCreativeJobWorkerType, type CreativeJobWorkerType } from "./creative-worker-types.ts";

// The S2 Creative Package v2 content contract and its authoritative validator, extracted verbatim
// from creative-packages.ts in S3E-A1 and re-exported from there unchanged, so every existing
// importer, every exported name and every validation message stays exactly as it was.
//
// The move exists for one reason only: a v2 Creative Job result envelope carries validated
// CreativePackageContentV2, so validateCreativeJobResultEnvelope (in creative-jobs.ts) has to run
// this validator at runtime. creative-packages.ts already imports creative-jobs.ts at runtime, so
// keeping the validator there would close an import cycle. Same reasoning, and same shape of fix,
// as the S3B extraction of ./creative-formats.ts.
//
// This module is a leaf on purpose: it imports only the two other leaves it validates against
// (formats and worker types) and nothing else.

// Carries the same provenance v1 does, plus the two decisions a generator makes that would be
// unreconstructable afterwards: which format it picked and why, and whether the subject was stated
// by the source or assumed by the system. S2 defines these structurally; S3 populates them.
export type CreativePackageMetadataV2 = {
  // Null for a request-backed job, exactly as in v1 since S1. A v2 package produced from a manual
  // Creative Job is structurally legitimate -- Opportunity is not mandatory anywhere in v2.
  generatedFromOpportunity: string | null;
  generatorVersion: "2";
  sourceCreativeJobId: string;
  sourceWorker: CreativeJobWorkerType;
  sourceJobResultSchemaVersion: "v2";
  formatChosenBy: "ai" | "user";
  formatRationale: string;
  subjectSource: "stated" | "assumed";
  // Required to be non-empty when subjectSource is "assumed": an assumption presented without its
  // grounding is indistinguishable from a fact, which is the failure this field exists to prevent.
  subjectGrounding: string | null;
};

export const CREATIVE_FORMAT_CHOSEN_BY = ["ai", "user"] as const;
export const CREATIVE_SUBJECT_SOURCES = ["stated", "assumed"] as const;

// A small adaptation of one canonical creative, never a separate creative. Caption and hashtags
// only -- a per-platform hook or CTA would be fake differentiation, since the hook IS the idea and
// does not change because the app changed. No scheduling, publishing or platform post identifiers.
export type PlatformVariantV2 = {
  platform: CreativePlatform;
  caption: string;
  hashtags: string[];
};

type CreativePackageBaseV2 = {
  schemaVersion: "v2";
  subject: string;
  angle: string;
  hook: string;
  // Retained from v1 deliberately, even though `subject` and `hook` overlap it: the asset-generation
  // path reads headline directly, and keeping it is what lets a v2 package feed the existing Asset
  // Job pipeline without inventing a second media-generation system. See asset-generation-spec.ts.
  headline: string;
  caption: string;
  cta: string;
  platformVariants: PlatformVariantV2[];
  metadata: CreativePackageMetadataV2;
};

export type CreativePhotoPackageV2 = CreativePackageBaseV2 & {
  format: "photo";
  visualDirection: string;
  overlayText: string | null;
};

export type CreativeReelPackageV2 = CreativePackageBaseV2 & {
  format: "reel";
  shots: Array<{ direction: string; onScreenText: string | null }>;
  // Nullable because a visual-only Reel is the normal case for a bakery, not an exception.
  // Requiring speech would produce ignored filler on most Reels.
  spokenScript: string | null;
  audioDirection: string;
  targetDurationSeconds: number;
};

export type CreativeCarouselPackageV2 = CreativePackageBaseV2 & {
  format: "carousel";
  slides: Array<{ heading: string; body: string; visualDirection: string }>;
};

export type CreativeStoryPackageV2 = CreativePackageBaseV2 & {
  format: "story";
  frames: Array<{ visualDirection: string; text: string }>;
  interaction: string | null;
};

export type CreativePackageContentV2 =
  | CreativePhotoPackageV2
  | CreativeReelPackageV2
  | CreativeCarouselPackageV2
  | CreativeStoryPackageV2;

// --- v2 validation ------------------------------------------------------------------------------
//
// Mirrors validateCreativeJobResultEnvelope's shape (ok/reason/message) rather than introducing a
// second validation style. Reasons are coarse enough to act on and specific enough to debug.
export type CreativePackageContentV2Validation =
  | { ok: true; content: CreativePackageContentV2 }
  | { ok: false; reason: "unsupported-schema-version" | "unsupported-format" | "malformed-base" | "malformed-metadata" | "malformed-platform-variants" | "malformed-format-fields"; message: string };

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function validatePlatformVariants(value: unknown): { ok: true } | { ok: false; message: string } {
  if (!Array.isArray(value)) {
    return { ok: false, message: "Creative Package v2 platformVariants must be an array." };
  }
  for (const entry of value) {
    if (!isJsonObject(entry)) {
      return { ok: false, message: "Creative Package v2 platformVariants entries must be objects." };
    }
    if (!isCreativePlatform(entry.platform)) {
      return { ok: false, message: `Creative Package v2 platformVariants has an unsupported platform: ${String(entry.platform)}.` };
    }
    if (!isNonEmptyString(entry.caption)) {
      return { ok: false, message: "Creative Package v2 platformVariants entries require a non-empty caption." };
    }
    if (!Array.isArray(entry.hashtags) || entry.hashtags.some((tag) => typeof tag !== "string")) {
      return { ok: false, message: "Creative Package v2 platformVariants hashtags must be an array of strings." };
    }
  }
  return { ok: true };
}

function validateMetadataV2(value: unknown): { ok: true } | { ok: false; message: string } {
  if (!isJsonObject(value)) {
    return { ok: false, message: "Creative Package v2 metadata must be an object." };
  }
  // Same rule as v1: a non-empty id, or explicitly null. Empty/whitespace is never an absence.
  if (!(value.generatedFromOpportunity === null || isNonEmptyString(value.generatedFromOpportunity))) {
    return { ok: false, message: "Creative Package v2 metadata generatedFromOpportunity must be a non-empty id or null." };
  }
  if (value.generatorVersion !== "2") {
    return { ok: false, message: "Creative Package v2 metadata generatorVersion must be \"2\"." };
  }
  if (!isNonEmptyString(value.sourceCreativeJobId)) {
    return { ok: false, message: "Creative Package v2 metadata requires a non-empty sourceCreativeJobId." };
  }
  if (typeof value.sourceWorker !== "string" || !isCreativeJobWorkerType(value.sourceWorker)) {
    return { ok: false, message: "Creative Package v2 metadata sourceWorker is not a supported worker type." };
  }
  if (value.sourceJobResultSchemaVersion !== "v2") {
    return { ok: false, message: "Creative Package v2 metadata sourceJobResultSchemaVersion must be v2." };
  }
  if (!(CREATIVE_FORMAT_CHOSEN_BY as readonly unknown[]).includes(value.formatChosenBy)) {
    return { ok: false, message: "Creative Package v2 metadata formatChosenBy must be \"ai\" or \"user\"." };
  }
  if (!isNonEmptyString(value.formatRationale)) {
    return { ok: false, message: "Creative Package v2 metadata requires a non-empty formatRationale." };
  }
  if (!(CREATIVE_SUBJECT_SOURCES as readonly unknown[]).includes(value.subjectSource)) {
    return { ok: false, message: "Creative Package v2 metadata subjectSource must be \"stated\" or \"assumed\"." };
  }
  if (!isNullableString(value.subjectGrounding)) {
    return { ok: false, message: "Creative Package v2 metadata subjectGrounding must be a string or null." };
  }
  // An assumption without its grounding is indistinguishable from a fact.
  if (value.subjectSource === "assumed" && !isNonEmptyString(value.subjectGrounding)) {
    return { ok: false, message: "Creative Package v2 metadata requires a non-empty subjectGrounding when subjectSource is \"assumed\"." };
  }
  return { ok: true };
}

function validateFormatFields(value: Record<string, unknown>): { ok: true } | { ok: false; message: string } {
  if (value.format === "photo") {
    if (!isNonEmptyString(value.visualDirection)) {
      return { ok: false, message: "Creative Package v2 photo requires a non-empty visualDirection." };
    }
    if (!isNullableString(value.overlayText)) {
      return { ok: false, message: "Creative Package v2 photo overlayText must be a string or null." };
    }
    return { ok: true };
  }

  if (value.format === "reel") {
    if (!Array.isArray(value.shots) || value.shots.length === 0) {
      return { ok: false, message: "Creative Package v2 reel requires at least one shot." };
    }
    for (const shot of value.shots) {
      if (!isJsonObject(shot) || !isNonEmptyString(shot.direction) || !isNullableString(shot.onScreenText)) {
        return { ok: false, message: "Creative Package v2 reel shots require a non-empty direction and a string-or-null onScreenText." };
      }
    }
    if (!isNullableString(value.spokenScript)) {
      return { ok: false, message: "Creative Package v2 reel spokenScript must be a string or null." };
    }
    if (!isNonEmptyString(value.audioDirection)) {
      return { ok: false, message: "Creative Package v2 reel requires a non-empty audioDirection." };
    }
    if (typeof value.targetDurationSeconds !== "number" || !Number.isFinite(value.targetDurationSeconds) || value.targetDurationSeconds <= 0) {
      return { ok: false, message: "Creative Package v2 reel targetDurationSeconds must be a positive finite number." };
    }
    return { ok: true };
  }

  if (value.format === "carousel") {
    if (!Array.isArray(value.slides) || value.slides.length === 0) {
      return { ok: false, message: "Creative Package v2 carousel requires at least one slide." };
    }
    for (const slide of value.slides) {
      if (!isJsonObject(slide) || !isNonEmptyString(slide.heading) || !isNonEmptyString(slide.body) || !isNonEmptyString(slide.visualDirection)) {
        return { ok: false, message: "Creative Package v2 carousel slides require non-empty heading, body and visualDirection." };
      }
    }
    return { ok: true };
  }

  // story -- the only remaining member, already narrowed by the format check in the caller.
  if (!Array.isArray(value.frames) || value.frames.length === 0) {
    return { ok: false, message: "Creative Package v2 story requires at least one frame." };
  }
  for (const frame of value.frames) {
    if (!isJsonObject(frame) || !isNonEmptyString(frame.visualDirection) || !isNonEmptyString(frame.text)) {
      return { ok: false, message: "Creative Package v2 story frames require non-empty visualDirection and text." };
    }
  }
  if (!isNullableString(value.interaction)) {
    return { ok: false, message: "Creative Package v2 story interaction must be a string or null." };
  }
  return { ok: true };
}

export function validateCreativePackageContentV2(value: unknown): CreativePackageContentV2Validation {
  if (!isJsonObject(value)) {
    return { ok: false, reason: "unsupported-schema-version", message: "Creative Package v2 content must be an object." };
  }
  if (value.schemaVersion !== "v2") {
    return { ok: false, reason: "unsupported-schema-version", message: "Creative Package content schemaVersion must be v2." };
  }
  if (!isCreativeFormat(value.format)) {
    return { ok: false, reason: "unsupported-format", message: `Creative Package v2 format is not supported: ${String(value.format)}.` };
  }

  for (const field of ["subject", "angle", "hook", "headline", "caption", "cta"] as const) {
    if (!isNonEmptyString(value[field])) {
      return { ok: false, reason: "malformed-base", message: `Creative Package v2 requires a non-empty ${field}.` };
    }
  }

  const metadata = validateMetadataV2(value.metadata);
  if (!metadata.ok) {
    return { ok: false, reason: "malformed-metadata", message: metadata.message };
  }

  const variants = validatePlatformVariants(value.platformVariants);
  if (!variants.ok) {
    return { ok: false, reason: "malformed-platform-variants", message: variants.message };
  }

  const formatFields = validateFormatFields(value);
  if (!formatFields.ok) {
    return { ok: false, reason: "malformed-format-fields", message: formatFields.message };
  }

  return { ok: true, content: value as unknown as CreativePackageContentV2 };
}

export function isCreativePackageContentV2(value: unknown): value is CreativePackageContentV2 {
  return validateCreativePackageContentV2(value).ok;
}
