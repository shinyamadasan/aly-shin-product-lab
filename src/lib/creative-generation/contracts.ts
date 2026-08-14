import { CREATIVE_FORMATS, CREATIVE_PLATFORMS, isCreativeFormat, isCreativePlatform, type CreativeFormat } from "../creative-formats.ts";
import {
  CREATIVE_FRAMINGS,
  CREATIVE_MOVEMENTS,
  CREATIVE_SHOT_SECONDS_MAX,
  CREATIVE_SHOT_SECONDS_MIN,
  isCreativeFraming,
  isCreativeMovement,
  isCreativeShotSeconds,
  type CreativeFraming,
  type CreativeMovement,
} from "../creative-production-guidance.ts";
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

// S6 -- production guidance is REQUIRED on the generation path, the strict half of the asymmetry
// described in creative-package-content-v2.ts. Anything generated from S6 onward answers how long,
// how close and whether the camera moves, because the execution-first UI can only show what the
// package contains.
export type PhotoCreativeBody = CreativeBodyCommon & { visualDirection: string; overlayText: string | null; framing: CreativeFraming };
export type ReelCreativeBody = CreativeBodyCommon & {
  shots: Array<{
    direction: string;
    onScreenText: string | null;
    approxSeconds: number;
    framing: CreativeFraming;
    // Required KEY, nullable VALUE. Requiring the key forces a decision per shot; allowing null lets
    // that decision be "no movement", which is the right answer most of the time.
    movement: CreativeMovement | null;
  }>;
  spokenScript: string | null;
  audioDirection: string;
  // targetDurationSeconds is deliberately ABSENT from the model body. A model asked for both
  // per-shot durations and a separate total can return two numbers that disagree, and then something
  // has to decide which one is true. There is now exactly one authored source of timing -- the
  // shots -- and the stored total is derived from it in assemble.ts.
};
export type CarouselCreativeBody = CreativeBodyCommon & {
  slides: Array<{ heading: string; body: string; visualDirection: string; framing: CreativeFraming }>;
};
export type StoryCreativeBody = CreativeBodyCommon & {
  // approxSeconds carries the photo/video decision itself: null is a still frame, a positive integer
  // is a video of about that length. Required key, so the generator must actually choose.
  frames: Array<{ visualDirection: string; text: string; framing: CreativeFraming; approxSeconds: number | null }>;
  interaction: string | null;
};

export type CreativeBody = PhotoCreativeBody | ReelCreativeBody | CarouselCreativeBody | StoryCreativeBody;

export type CreativeBodyValidation =
  | { ok: true; body: CreativeBody }
  | { ok: false; reason: "malformed" | "unexpected-fields" | "malformed-platform-variants" | "malformed-format-fields"; message: string };

const COMMON_KEYS = ["angle", "hook", "headline", "caption", "cta", "platformVariants"] as const;

// targetDurationSeconds is gone from `reel` on purpose, and because rejectUnexpectedKeys drives off
// this table, a model that returns it now fails with "unexpected fields" rather than quietly
// supplying a total that competes with the shot list.
const FORMAT_KEYS: Record<CreativeFormat, readonly string[]> = {
  photo: ["visualDirection", "overlayText", "framing"],
  reel: ["shots", "spokenScript", "audioDirection"],
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

const FRAMING_SCHEMA = { type: "string", enum: [...CREATIVE_FRAMINGS] } as const;
// The null member is spelled into the enum as well as the type, because a movement enum that omits
// it would make "no movement needed" unrepresentable and push the model towards inventing one.
const MOVEMENT_SCHEMA = { type: ["string", "null"], enum: [...CREATIVE_MOVEMENTS, null] } as const;
const SHOT_SECONDS_SCHEMA = { type: "integer", minimum: CREATIVE_SHOT_SECONDS_MIN, maximum: CREATIVE_SHOT_SECONDS_MAX } as const;

const FORMAT_SCHEMA_PROPERTIES: Record<CreativeFormat, Record<string, unknown>> = {
  photo: {
    visualDirection: { type: "string", minLength: 1 },
    overlayText: { type: ["string", "null"] },
    framing: FRAMING_SCHEMA,
  },
  reel: {
    shots: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["direction", "onScreenText", "approxSeconds", "framing", "movement"],
        properties: {
          direction: { type: "string", minLength: 1 },
          onScreenText: { type: ["string", "null"] },
          approxSeconds: SHOT_SECONDS_SCHEMA,
          framing: FRAMING_SCHEMA,
          movement: MOVEMENT_SCHEMA,
        },
      },
    },
    spokenScript: { type: ["string", "null"] },
    audioDirection: { type: "string", minLength: 1 },
  },
  carousel: {
    slides: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["heading", "body", "visualDirection", "framing"],
        properties: {
          heading: { type: "string", minLength: 1 },
          body: { type: "string", minLength: 1 },
          visualDirection: { type: "string", minLength: 1 },
          framing: FRAMING_SCHEMA,
        },
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
        required: ["visualDirection", "text", "framing", "approxSeconds"],
        properties: {
          visualDirection: { type: "string", minLength: 1 },
          text: { type: "string", minLength: 1 },
          framing: FRAMING_SCHEMA,
          // minimum/maximum constrain only the integer branch; null passes them by definition.
          approxSeconds: { type: ["integer", "null"], minimum: CREATIVE_SHOT_SECONDS_MIN, maximum: CREATIVE_SHOT_SECONDS_MAX },
        },
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
    // Required and non-null on the generation path, unlike the read path where absence means a
    // pre-S6 package. A generator that skips this has not made the decision the field exists for.
    if (!isCreativeFraming(value.framing)) return "Photo body framing must be close_up, medium, wide or overhead.";
    return null;
  }
  if (format === "reel") {
    if (!Array.isArray(value.shots) || value.shots.length === 0) return "Reel body requires at least one shot.";
    for (const shot of value.shots) {
      if (!isJsonObject(shot) || !isNonEmptyString(shot.direction) || !isNullableString(shot.onScreenText)) {
        return "Reel body shots require a non-empty direction and a string-or-null onScreenText.";
      }
      if (!isCreativeShotSeconds(shot.approxSeconds)) {
        return "Reel body shots require an approxSeconds integer from 1 to 10.";
      }
      if (!isCreativeFraming(shot.framing)) {
        return "Reel body shots require a framing of close_up, medium, wide or overhead.";
      }
      // `in` rather than a truthiness check: the KEY must be present so the generator has actually
      // decided, but null is a legitimate and expected decision.
      if (!("movement" in shot) || !(shot.movement === null || isCreativeMovement(shot.movement))) {
        return "Reel body shots require a movement of push_in, pull_back, pan or null.";
      }
    }
    if (!isNullableString(value.spokenScript)) return "Reel body spokenScript must be a string or null.";
    if (!isNonEmptyString(value.audioDirection)) return "Reel body requires a non-empty audioDirection.";
    return null;
  }
  if (format === "carousel") {
    if (!Array.isArray(value.slides) || value.slides.length === 0) return "Carousel body requires at least one slide.";
    for (const slide of value.slides) {
      if (!isJsonObject(slide) || !isNonEmptyString(slide.heading) || !isNonEmptyString(slide.body) || !isNonEmptyString(slide.visualDirection)) {
        return "Carousel body slides require non-empty heading, body and visualDirection.";
      }
      if (!isCreativeFraming(slide.framing)) {
        return "Carousel body slides require a framing of close_up, medium, wide or overhead.";
      }
    }
    return null;
  }
  if (!Array.isArray(value.frames) || value.frames.length === 0) return "Story body requires at least one frame.";
  for (const frame of value.frames) {
    if (!isJsonObject(frame) || !isNonEmptyString(frame.visualDirection) || !isNonEmptyString(frame.text)) {
      return "Story body frames require non-empty visualDirection and text.";
    }
    if (!isCreativeFraming(frame.framing)) {
      return "Story body frames require a framing of close_up, medium, wide or overhead.";
    }
    // The photo/video decision. Key required so it is made deliberately; null means a still frame.
    if (!("approxSeconds" in frame) || !(frame.approxSeconds === null || isCreativeShotSeconds(frame.approxSeconds))) {
      return "Story body frames require an approxSeconds of null (photo) or an integer from 1 to 10 (video).";
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
