import { CREATIVE_FORMATS, CREATIVE_PLATFORMS, isCreativeFormat, isCreativePlatform, type CreativeFormat } from "../creative-formats.ts";
import type { PlatformVariantV2 } from "../creative-packages.ts";

// Content Creation MVP S3B -- the two model-independent generation contracts.
//
// Stage 1 (skipped when the human supplied a formatHint): choose a format.
// Stage 2: generate that format's creative body.
//
// Deliberately NOT the whole CreativePackageContentV2. The application already knows the subject,
// its source, its grounding and every provenance field; asking a model to restate them would invite
// it to contradict facts the system already holds. The bodies below contain only what a model can
// legitimately author, which is also what makes "the AI cannot override factual metadata" a
// structural property rather than a rule someone has to remember.
//
// No AI is invoked here, and no model is named. This module is pure data and pure validation.

// --- Stage 1: format decision -------------------------------------------------------------------

export type CreativeFormatDecision = {
  format: CreativeFormat;
  formatRationale: string;
};

export type FormatDecisionValidation =
  | { ok: true; decision: CreativeFormatDecision }
  | { ok: false; reason: "malformed" | "unsupported-format" | "unexpected-fields"; message: string };

const FORMAT_DECISION_KEYS = ["format", "formatRationale"] as const;

export function buildFormatDecisionJsonSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: [...FORMAT_DECISION_KEYS],
    properties: {
      format: { type: "string", enum: [...CREATIVE_FORMATS] },
      formatRationale: { type: "string", minLength: 1 },
    },
  };
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

// Rejects unexpected keys rather than ignoring them. A model that returns a `caption` alongside its
// format decision has misunderstood the request, and silently dropping the extra field would hide
// that -- the same reasoning that makes the body validators strict below.
function rejectUnexpectedKeys(value: Record<string, unknown>, allowed: readonly string[]): string | null {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  return unexpected.length > 0 ? unexpected.join(", ") : null;
}

export function validateFormatDecision(value: unknown): FormatDecisionValidation {
  if (!isJsonObject(value)) {
    return { ok: false, reason: "malformed", message: "Format decision must be an object." };
  }
  const unexpected = rejectUnexpectedKeys(value, FORMAT_DECISION_KEYS);
  if (unexpected !== null) {
    return { ok: false, reason: "unexpected-fields", message: `Format decision has unexpected fields: ${unexpected}.` };
  }
  if (!isCreativeFormat(value.format)) {
    return { ok: false, reason: "unsupported-format", message: `Format decision format is not supported: ${String(value.format)}.` };
  }
  if (!isNonEmptyString(value.formatRationale)) {
    return { ok: false, reason: "malformed", message: "Format decision requires a non-empty formatRationale." };
  }
  return { ok: true, decision: { format: value.format, formatRationale: value.formatRationale } };
}

// A human-supplied formatHint is already a decision. Restating it deterministically costs nothing
// and calling a model to justify a choice the owner already made would be absurd.
export function buildUserFormatDecision(format: CreativeFormat): CreativeFormatDecision {
  return { format, formatRationale: `User requested ${format}.` };
}

// --- Stage 2: creative bodies -------------------------------------------------------------------

export type CreativeBodyCommon = {
  angle: string;
  hook: string;
  headline: string;
  caption: string;
  cta: string;
  platformVariants: PlatformVariantV2[];
};

export type PhotoCreativeBody = CreativeBodyCommon & { visualDirection: string; overlayText: string | null };
export type ReelCreativeBody = CreativeBodyCommon & {
  shots: Array<{ direction: string; onScreenText: string | null }>;
  spokenScript: string | null;
  audioDirection: string;
  targetDurationSeconds: number;
};
export type CarouselCreativeBody = CreativeBodyCommon & { slides: Array<{ heading: string; body: string; visualDirection: string }> };
export type StoryCreativeBody = CreativeBodyCommon & { frames: Array<{ visualDirection: string; text: string }>; interaction: string | null };

export type CreativeBody = PhotoCreativeBody | ReelCreativeBody | CarouselCreativeBody | StoryCreativeBody;

export type CreativeBodyValidation =
  | { ok: true; body: CreativeBody }
  | { ok: false; reason: "malformed" | "unexpected-fields" | "malformed-platform-variants" | "malformed-format-fields"; message: string };

const COMMON_KEYS = ["angle", "hook", "headline", "caption", "cta", "platformVariants"] as const;

const FORMAT_KEYS: Record<CreativeFormat, readonly string[]> = {
  photo: ["visualDirection", "overlayText"],
  reel: ["shots", "spokenScript", "audioDirection", "targetDurationSeconds"],
  carousel: ["slides"],
  story: ["frames", "interaction"],
};

// The body deliberately carries NO `format` discriminant: the format is already decided, and asking
// for it again only creates a way for the two to disagree. Strictness is what keeps the formats
// distinguishable instead -- a reel body offered as a photo has no visualDirection and gains four
// unexpected keys, so it is rejected twice over.
const PLATFORM_VARIANT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["platform", "caption", "hashtags"],
  properties: {
    platform: { type: "string", enum: [...CREATIVE_PLATFORMS] },
    caption: { type: "string", minLength: 1 },
    hashtags: { type: "array", items: { type: "string" } },
  },
} as const;

const COMMON_SCHEMA_PROPERTIES = {
  angle: { type: "string", minLength: 1 },
  hook: { type: "string", minLength: 1 },
  headline: { type: "string", minLength: 1 },
  caption: { type: "string", minLength: 1 },
  cta: { type: "string", minLength: 1 },
  // An empty array is legitimate and must stay legitimate: S2 accepts any subset of platforms,
  // including none, and S3B must not silently narrow that contract.
  platformVariants: { type: "array", items: PLATFORM_VARIANT_SCHEMA },
} as const;

const FORMAT_SCHEMA_PROPERTIES: Record<CreativeFormat, Record<string, unknown>> = {
  photo: {
    visualDirection: { type: "string", minLength: 1 },
    overlayText: { type: ["string", "null"] },
  },
  reel: {
    shots: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["direction", "onScreenText"],
        properties: { direction: { type: "string", minLength: 1 }, onScreenText: { type: ["string", "null"] } },
      },
    },
    spokenScript: { type: ["string", "null"] },
    audioDirection: { type: "string", minLength: 1 },
    targetDurationSeconds: { type: "number", exclusiveMinimum: 0 },
  },
  carousel: {
    slides: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["heading", "body", "visualDirection"],
        properties: { heading: { type: "string", minLength: 1 }, body: { type: "string", minLength: 1 }, visualDirection: { type: "string", minLength: 1 } },
      },
    },
  },
  story: {
    frames: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["visualDirection", "text"],
        properties: { visualDirection: { type: "string", minLength: 1 }, text: { type: "string", minLength: 1 } },
      },
    },
    interaction: { type: ["string", "null"] },
  },
};

// One strict schema per format rather than a single four-way body schema. Smaller schemas constrain
// a model better, and a failure names the one format that was actually asked for.
export function buildCreativeBodyJsonSchema(format: CreativeFormat): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: [...COMMON_KEYS, ...FORMAT_KEYS[format]],
    properties: { ...COMMON_SCHEMA_PROPERTIES, ...FORMAT_SCHEMA_PROPERTIES[format] },
  };
}

function validatePlatformVariants(value: unknown): string | null {
  if (!Array.isArray(value)) {
    return "Creative body platformVariants must be an array.";
  }
  for (const entry of value) {
    if (!isJsonObject(entry)) {
      return "Creative body platformVariants entries must be objects.";
    }
    if (!isCreativePlatform(entry.platform)) {
      return `Creative body platformVariants has an unsupported platform: ${String(entry.platform)}.`;
    }
    if (!isNonEmptyString(entry.caption)) {
      return "Creative body platformVariants entries require a non-empty caption.";
    }
    if (!Array.isArray(entry.hashtags) || entry.hashtags.some((tag) => typeof tag !== "string")) {
      return "Creative body platformVariants hashtags must be an array of strings.";
    }
  }
  return null;
}

function validateFormatFields(format: CreativeFormat, value: Record<string, unknown>): string | null {
  if (format === "photo") {
    if (!isNonEmptyString(value.visualDirection)) return "Photo body requires a non-empty visualDirection.";
    if (!isNullableString(value.overlayText)) return "Photo body overlayText must be a string or null.";
    return null;
  }
  if (format === "reel") {
    if (!Array.isArray(value.shots) || value.shots.length === 0) return "Reel body requires at least one shot.";
    for (const shot of value.shots) {
      if (!isJsonObject(shot) || !isNonEmptyString(shot.direction) || !isNullableString(shot.onScreenText)) {
        return "Reel body shots require a non-empty direction and a string-or-null onScreenText.";
      }
    }
    if (!isNullableString(value.spokenScript)) return "Reel body spokenScript must be a string or null.";
    if (!isNonEmptyString(value.audioDirection)) return "Reel body requires a non-empty audioDirection.";
    if (typeof value.targetDurationSeconds !== "number" || !Number.isFinite(value.targetDurationSeconds) || value.targetDurationSeconds <= 0) {
      return "Reel body targetDurationSeconds must be a positive finite number.";
    }
    return null;
  }
  if (format === "carousel") {
    if (!Array.isArray(value.slides) || value.slides.length === 0) return "Carousel body requires at least one slide.";
    for (const slide of value.slides) {
      if (!isJsonObject(slide) || !isNonEmptyString(slide.heading) || !isNonEmptyString(slide.body) || !isNonEmptyString(slide.visualDirection)) {
        return "Carousel body slides require non-empty heading, body and visualDirection.";
      }
    }
    return null;
  }
  if (!Array.isArray(value.frames) || value.frames.length === 0) return "Story body requires at least one frame.";
  for (const frame of value.frames) {
    if (!isJsonObject(frame) || !isNonEmptyString(frame.visualDirection) || !isNonEmptyString(frame.text)) {
      return "Story body frames require non-empty visualDirection and text.";
    }
  }
  if (!isNullableString(value.interaction)) return "Story body interaction must be a string or null.";
  return null;
}

export function validateCreativeBody(format: CreativeFormat, value: unknown): CreativeBodyValidation {
  if (!isJsonObject(value)) {
    return { ok: false, reason: "malformed", message: "Creative body must be an object." };
  }

  // Checked first and deliberately: this is the guard that stops a model from smuggling `subject`,
  // `metadata`, `schemaVersion` or another format's fields into the package. Everything the system
  // owns is, by construction, an unexpected field here.
  const unexpected = rejectUnexpectedKeys(value, [...COMMON_KEYS, ...FORMAT_KEYS[format]]);
  if (unexpected !== null) {
    return { ok: false, reason: "unexpected-fields", message: `Creative body for ${format} has unexpected fields: ${unexpected}.` };
  }

  for (const field of ["angle", "hook", "headline", "caption", "cta"] as const) {
    if (!isNonEmptyString(value[field])) {
      return { ok: false, reason: "malformed", message: `Creative body requires a non-empty ${field}.` };
    }
  }

  const variantsMessage = validatePlatformVariants(value.platformVariants);
  if (variantsMessage !== null) {
    return { ok: false, reason: "malformed-platform-variants", message: variantsMessage };
  }

  const formatMessage = validateFormatFields(format, value);
  if (formatMessage !== null) {
    return { ok: false, reason: "malformed-format-fields", message: formatMessage };
  }

  return { ok: true, body: value as unknown as CreativeBody };
}
