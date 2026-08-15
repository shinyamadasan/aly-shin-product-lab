import { CREATIVE_FORMATS, CREATIVE_PLATFORMS, isCreativeFormat, isCreativePlatform, type CreativeFormat } from "../creative-formats.ts";
import {
  CREATIVE_FRAMINGS,
  CREATIVE_MOVEMENTS,
  CREATIVE_PRODUCTION_SOURCES,
  CREATIVE_SHOT_SECONDS_MAX,
  CREATIVE_SHOT_SECONDS_MIN,
  isCreativeFraming,
  isCreativeMovement,
  isCreativeProductionSource,
  isCreativeShotSeconds,
  productionSourceRequiresFraming,
  type CreativeFraming,
  type CreativeMovement,
  type CreativeProductionSource,
} from "../creative-production-guidance.ts";
import type { CreativeInput } from "../creative-input.ts";
import { wantsNoFreshCapture } from "../creative-request-intent.ts";
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

// --- H1-B: the production constraint the owner's own words impose -------------------------------
//
// Two enums that were independent under S6 stop being independent here. A Reel is filmed, so an
// owner who has said they will not film has not merely expressed a preference among production
// sources -- they have removed a format. Rather than let the model discover that by returning
// something impossible and failing validation, the constraint narrows the vocabulary BEFORE the
// model is asked, in both stages.
//
// Deliberately derived, never stored. No structured field was added to CreativeInput for this,
// because no UI control exists that would set one; the only evidence is the owner's sentence, and it
// is read in exactly one place (creative-request-intent.ts).

// Reel is excluded and only Reel is excluded. That is not an oversight about Story: a Story FRAME
// can be a still, so Story survives the constraint by choosing stills, whereas a Reel with no
// footage is not a smaller Reel, it is nothing. See §10/§11 of the H1-B brief.
export const ZERO_CAPTURE_FORMATS: readonly CreativeFormat[] = CREATIVE_FORMATS.filter((format) => format !== "reel");

export const ZERO_CAPTURE_PRODUCTION_SOURCES: readonly CreativeProductionSource[] = CREATIVE_PRODUCTION_SOURCES.filter(
  (source) => source !== "capture_new",
);

export type CreativeProductionConstraint = {
  formats: readonly CreativeFormat[];
  productionSources: readonly CreativeProductionSource[];
};

export const UNCONSTRAINED_PRODUCTION: CreativeProductionConstraint = {
  formats: CREATIVE_FORMATS,
  productionSources: CREATIVE_PRODUCTION_SOURCES,
};

// Default behaviour is unchanged and unchanged by design: fresh capture stays allowed unless the
// owner explicitly says otherwise, and silence is not a refusal.
export function resolveCreativeProductionConstraint(creativeInput: CreativeInput): CreativeProductionConstraint {
  return wantsNoFreshCapture(creativeInput)
    ? { formats: ZERO_CAPTURE_FORMATS, productionSources: ZERO_CAPTURE_PRODUCTION_SOURCES }
    : UNCONSTRAINED_PRODUCTION;
}

// The per-format narrowing, applied on top of the request-level constraint. Reel forces capture_new
// even with no constraint at all, because that is a property of the format rather than of the
// request: this MVP has no video generation and no template-video renderer.
//
// The intersection is EMPTY for exactly one pair -- reel plus a zero-capture request -- and that
// emptiness is the honest representation of an impossible combination rather than a special case.
export function productionSourcesForFormat(
  format: CreativeFormat,
  constraint: CreativeProductionConstraint = UNCONSTRAINED_PRODUCTION,
): readonly CreativeProductionSource[] {
  return format === "reel" ? constraint.productionSources.filter((source) => source === "capture_new") : constraint.productionSources;
}

// H1-B §19 -- an explicitly hinted format that the request's own constraint makes impossible.
//
// Returned rather than worked around. "formatHint = reel" plus "I can't film anything" is a genuine
// contradiction, and the two ways to resolve it silently are both dishonest: returning a Reel hands
// the owner a plan they just said they cannot execute, and quietly substituting a Photo ignores the
// format they explicitly asked for -- the exact failure formatHint exists to prevent. Refusing
// before any model runs costs nothing and says what happened.
export function findImpossibleFormatRequest(creativeInput: CreativeInput): { format: CreativeFormat; message: string } | null {
  const format = creativeInput.formatHint;
  if (format === null) {
    return null;
  }
  const constraint = resolveCreativeProductionConstraint(creativeInput);
  if (productionSourcesForFormat(format, constraint).length > 0) {
    return null;
  }
  return {
    format,
    message: `The request asks for ${format}, which requires filming, and also asks for no fresh photos or video. Choose a different format, or allow capture.`,
  };
}

// --- Stage 1: format decision -------------------------------------------------------------------

export type CreativeFormatDecision = {
  format: CreativeFormat;
  formatRationale: string;
};

export type FormatDecisionValidation =
  | { ok: true; decision: CreativeFormatDecision }
  | { ok: false; reason: "malformed" | "unsupported-format" | "unexpected-fields"; message: string };

const FORMAT_DECISION_KEYS = ["format", "formatRationale"] as const;

// The enum narrows with the constraint rather than staying wide and being corrected afterwards: a
// format the request has ruled out should not be offered as a choice in the first place.
export function buildFormatDecisionJsonSchema(constraint: CreativeProductionConstraint = UNCONSTRAINED_PRODUCTION): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: [...FORMAT_DECISION_KEYS],
    properties: {
      format: { type: "string", enum: [...constraint.formats] },
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

export function validateFormatDecision(
  value: unknown,
  constraint: CreativeProductionConstraint = UNCONSTRAINED_PRODUCTION,
): FormatDecisionValidation {
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
  // The schema already excluded it, but a narrowed enum is a request and this is the enforcement.
  // Same reason as every other check here: the contract is what the validator accepts.
  if (!constraint.formats.includes(value.format)) {
    return {
      ok: false,
      reason: "unsupported-format",
      message: `Format decision chose ${value.format}, which this request does not permit. Allowed: ${constraint.formats.join(", ")}.`,
    };
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
  // H1-B -- REQUIRED on the generation path, optional on the stored package, the same asymmetry S6
  // established. The model states it rather than the renderer inferring it: guessing "this reads
  // like an illustration" out of visualDirection prose would be the silent reinterpretation this
  // codebase refuses everywhere else, and it would guess wrong on exactly the ambiguous cases that
  // matter.
  productionSource: CreativeProductionSource;
};

// S6 -- production guidance is REQUIRED on the generation path, the strict half of the asymmetry
// described in creative-package-content-v2.ts. Anything generated from S6 onward answers how long,
// how close and whether the camera moves, because the execution-first UI can only show what the
// package contains.
//
// H1-B qualifies that for framing only, and only where framing stopped meaning anything: it is
// required when productionSource is capture_new and ABSENT otherwise. The optional marker below is
// therefore not a relaxation -- validateCreativeBody enforces both directions, so a capture_new body
// without framing and a template_only body with one are each rejected.
export type PhotoCreativeBody = CreativeBodyCommon & { visualDirection: string; overlayText: string | null; framing?: CreativeFraming };
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
  slides: Array<{ heading: string; body: string; visualDirection: string; framing?: CreativeFraming }>;
};
export type StoryCreativeBody = CreativeBodyCommon & {
  // approxSeconds carries the photo/video decision itself: null is a still frame, a positive integer
  // is a video of about that length. Required key, so the generator must actually choose. Under a
  // zero-capture productionSource the only legitimate answer is null -- see validateFormatFields.
  frames: Array<{ visualDirection: string; text: string; framing?: CreativeFraming; approxSeconds: number | null }>;
  interaction: string | null;
};

export type CreativeBody = PhotoCreativeBody | ReelCreativeBody | CarouselCreativeBody | StoryCreativeBody;

export type CreativeBodyValidation =
  | { ok: true; body: CreativeBody }
  | { ok: false; reason: "malformed" | "unexpected-fields" | "malformed-platform-variants" | "malformed-format-fields"; message: string };

const COMMON_KEYS = ["angle", "hook", "headline", "caption", "cta", "platformVariants", "productionSource"] as const;

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

// productionSource's enum is the one common property that varies per request, so it is built rather
// than frozen above: a zero-capture request must not be offered capture_new as a choice.
function productionSourceSchema(allowed: readonly CreativeProductionSource[]): Record<string, unknown> {
  return { type: "string", enum: [...allowed] };
}

const FRAMING_SCHEMA = { type: "string", enum: [...CREATIVE_FRAMINGS] } as const;
// The null member is spelled into the enum as well as the type, because a movement enum that omits
// it would make "no movement needed" unrepresentable and push the model towards inventing one.
const MOVEMENT_SCHEMA = { type: ["string", "null"], enum: [...CREATIVE_MOVEMENTS, null] } as const;
const SHOT_SECONDS_SCHEMA = { type: "integer", minimum: CREATIVE_SHOT_SECONDS_MIN, maximum: CREATIVE_SHOT_SECONDS_MAX } as const;

// H1-B -- framing's place in the schema now depends on what production sources are still on the
// table, and there are exactly three cases:
//
//   "required"  -- capture_new is the ONLY option left (every Reel, and any request already narrowed
//                  to capture). The camera is certain, so the schema demands the field.
//   "forbidden" -- capture_new has been ruled out. framing is dropped from `properties` entirely, so
//                  additionalProperties:false rejects it outright. This is what stops a model from
//                  labelling a typography card "close_up" to satisfy a schema.
//   "optional"  -- the model has not yet chosen. The schema cannot make one key's presence depend on
//                  another key's value, so it allows both and validateFormatFields decides.
type FramingMode = "required" | "forbidden" | "optional";

function framingModeFor(allowed: readonly CreativeProductionSource[]): FramingMode {
  if (!allowed.some((source) => productionSourceRequiresFraming(source))) return "forbidden";
  return allowed.length === 1 ? "required" : "optional";
}

function withFraming(properties: Record<string, unknown>, mode: FramingMode): Record<string, unknown> {
  return mode === "forbidden" ? properties : { ...properties, framing: FRAMING_SCHEMA };
}

function framingRequiredKeys(mode: FramingMode): readonly string[] {
  return mode === "required" ? ["framing"] : [];
}

function formatSchemaProperties(allowed: readonly CreativeProductionSource[]): Record<CreativeFormat, Record<string, unknown>> {
  const mode = framingModeFor(allowed);
  // A zero-capture Story is a sequence of stills, so the only value the schema will accept is null.
  const storyApproxSeconds =
    mode === "forbidden"
      ? { type: "null" }
      : { type: ["integer", "null"], minimum: CREATIVE_SHOT_SECONDS_MIN, maximum: CREATIVE_SHOT_SECONDS_MAX };

  return {
  photo: withFraming(
    {
      visualDirection: { type: "string", minLength: 1 },
      overlayText: { type: ["string", "null"] },
    },
    mode,
  ),
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
        required: ["heading", "body", "visualDirection", ...framingRequiredKeys(mode)],
        properties: withFraming(
          {
            heading: { type: "string", minLength: 1 },
            body: { type: "string", minLength: 1 },
            visualDirection: { type: "string", minLength: 1 },
          },
          mode,
        ),
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
        required: ["visualDirection", "text", "approxSeconds", ...framingRequiredKeys(mode)],
        properties: withFraming(
          {
            visualDirection: { type: "string", minLength: 1 },
            text: { type: "string", minLength: 1 },
            // minimum/maximum constrain only the integer branch; null passes them by definition.
            approxSeconds: storyApproxSeconds,
          },
          mode,
        ),
      },
    },
    interaction: { type: ["string", "null"] },
  },
  };
}

// The keys a format's schema REQUIRES, which is no longer simply FORMAT_KEYS: Photo's framing moved
// from unconditionally required to conditional, so it is listed here only in the "required" mode.
function formatRequiredKeys(format: CreativeFormat, mode: FramingMode): readonly string[] {
  return format === "photo" ? [...FORMAT_KEYS.photo.filter((key) => key !== "framing"), ...framingRequiredKeys(mode)] : FORMAT_KEYS[format];
}

// One strict schema per format rather than a single four-way body schema. Smaller schemas constrain
// a model better, and a failure names the one format that was actually asked for.
//
// H1-B threads the constraint through, so the schema handed to the model reflects what this specific
// request actually permits. The default keeps every existing caller and test working unchanged --
// and note that it is not simply "everything", because productionSourcesForFormat still applies the
// Reel rule.
export function buildCreativeBodyJsonSchema(
  format: CreativeFormat,
  constraint: CreativeProductionConstraint = UNCONSTRAINED_PRODUCTION,
): Record<string, unknown> {
  const allowed = productionSourcesForFormat(format, constraint);
  return {
    type: "object",
    additionalProperties: false,
    required: [...COMMON_KEYS, ...formatRequiredKeys(format, framingModeFor(allowed))],
    properties: {
      ...COMMON_SCHEMA_PROPERTIES,
      productionSource: productionSourceSchema(allowed),
      ...formatSchemaProperties(allowed)[format],
    },
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

// H1-B -- the conditional framing rule, in one place so all four formats obey it identically.
//
// Both directions matter. A capture_new body with no framing has skipped the S6 decision; a
// generated or template body WITH framing has invented a camera setup for something no camera will
// ever point at. Neither is accepted, and the message says which mistake was made.
function framingError(value: unknown, productionSource: CreativeProductionSource, where: string): string | null {
  if (productionSourceRequiresFraming(productionSource)) {
    return isCreativeFraming(value) ? null : `${where} framing must be close_up, medium, wide or overhead.`;
  }
  return value === undefined ? null : `${where} must omit framing when productionSource is ${productionSource}: there is no camera to frame.`;
}

function validateFormatFields(format: CreativeFormat, value: Record<string, unknown>, productionSource: CreativeProductionSource): string | null {
  if (format === "photo") {
    if (!isNonEmptyString(value.visualDirection)) return "Photo body requires a non-empty visualDirection.";
    if (!isNullableString(value.overlayText)) return "Photo body overlayText must be a string or null.";
    // Required and non-null on the capture path, unlike the read path where absence means a pre-S6
    // package. A generator that skips it there has not made the decision the field exists for.
    return framingError(value.framing, productionSource, "Photo body");
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
      const framing = framingError(slide.framing, productionSource, "Carousel body slides");
      if (framing !== null) return framing;
    }
    return null;
  }
  if (!Array.isArray(value.frames) || value.frames.length === 0) return "Story body requires at least one frame.";
  for (const frame of value.frames) {
    if (!isJsonObject(frame) || !isNonEmptyString(frame.visualDirection) || !isNonEmptyString(frame.text)) {
      return "Story body frames require non-empty visualDirection and text.";
    }
    const framing = framingError(frame.framing, productionSource, "Story body frames");
    if (framing !== null) return framing;
    // The photo/video decision. Key required so it is made deliberately; null means a still frame.
    if (!("approxSeconds" in frame) || !(frame.approxSeconds === null || isCreativeShotSeconds(frame.approxSeconds))) {
      return "Story body frames require an approxSeconds of null (photo) or an integer from 1 to 10 (video).";
    }
    // H1-B §11 -- Story survives a zero-capture request by choosing stills. Nothing in this MVP can
    // render a generated or template VIDEO frame, so the decision is still available but its answer
    // is not: null, on every frame.
    if (!productionSourceRequiresFraming(productionSource) && typeof frame.approxSeconds === "number") {
      return `Story body frames must be still (approxSeconds null) when productionSource is ${productionSource}: there is no video generation.`;
    }
  }
  if (!isNullableString(value.interaction)) return "Story body interaction must be a string or null.";
  return null;
}

export function validateCreativeBody(
  format: CreativeFormat,
  value: unknown,
  constraint: CreativeProductionConstraint = UNCONSTRAINED_PRODUCTION,
): CreativeBodyValidation {
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

  // H1-B -- validated BEFORE the format fields, because every framing rule below depends on it. An
  // unusable productionSource is a malformed body, not a format-field problem.
  const allowed = productionSourcesForFormat(format, constraint);
  if (!isCreativeProductionSource(value.productionSource)) {
    return { ok: false, reason: "malformed", message: `Creative body requires a productionSource of ${allowed.join(", ")}.` };
  }
  if (!allowed.includes(value.productionSource)) {
    return {
      ok: false,
      reason: "malformed",
      message: `Creative body productionSource ${value.productionSource} is not permitted for ${format} on this request. Allowed: ${allowed.join(", ") || "(none -- this format cannot satisfy the request)"}.`,
    };
  }

  const variantsMessage = validatePlatformVariants(value.platformVariants);
  if (variantsMessage !== null) {
    return { ok: false, reason: "malformed-platform-variants", message: variantsMessage };
  }

  const formatMessage = validateFormatFields(format, value, value.productionSource);
  if (formatMessage !== null) {
    return { ok: false, reason: "malformed-format-fields", message: formatMessage };
  }

  return { ok: true, body: value as unknown as CreativeBody };
}
