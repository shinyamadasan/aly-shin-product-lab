import { isCreativeFormat, isCreativePlatform, type CreativePlatform } from "./creative-formats.ts";
import {
  isCreativeFraming,
  isCreativeMovement,
  isCreativeProductionSource,
  isCreativeShotSeconds,
  productionSourceRequiresFraming,
  type CreativeFraming,
  type CreativeMovement,
  type CreativeProductionSource,
} from "./creative-production-guidance.ts";
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
  // H1-B -- how this visual gets made. It lives in the package BODY, not in metadata, because it is
  // a creative DECISION and not provenance: metadata records where the package came from and who
  // chose what, while productionSource is part of the answer the owner receives. "Illustrate two
  // dessert characters" and "photograph the tray" are different creative work, not different
  // bookkeeping.
  //
  // OPTIONAL here and REQUIRED on the generation path, exactly as S6's fields are, and for exactly
  // the same reason: every package stored before H1-B has no such key, all of them are still
  // legitimate v2 packages, and no migration, schemaVersion bump or generatorVersion bump is needed
  // to keep reading them. Absent means "written before this question was asked", which is not the
  // same as capture_new and is deliberately not stored as one.
  productionSource?: CreativeProductionSource;
};

// S6 production guidance is OPTIONAL on every stored type below, and that is the whole
// backward-compatibility mechanism: packages generated before S6 carry none of these fields, they
// are still legitimate v2 packages, and no migration or schemaVersion bump is required to keep
// reading them. Optional means ABSENT, not null -- see validateFormatFields, where a present value
// is validated exactly as strictly as a generated one.
//
// The generation contract is the asymmetric half: creative-generation/contracts.ts REQUIRES these
// keys, so everything produced from S6 onward carries them.

// Content Creation MVP P1 §7 -- the structured zero-capture visual brief.
//
// The problem it solves is narrow and was measured, not guessed: a `photo` package carries exactly
// ONE visualDirection string, and a zero-capture brief has far more to say than a capture brief
// does. A photograph's direction is "overhead on the board, morning light"; an illustration's has to
// carry the concept, the drawing style, the composition, and the constraints that keep it buildable.
// That is four kinds of instruction in one paragraph, and the owner reads it as a wall.
//
// The alternative was renderer-side prose parsing, which this codebase refuses everywhere: splitting
// generated prose on invented delimiters fabricates a structure the generator never authored, and
// fails silently the first time the model writes a sentence differently.
//
// Deliberately four fields and no more. There is no keepItSimple, no visual-style enum, no archetype,
// no asset reference, and no text field -- overlayText remains the single canonical home for text
// placed ON the visual, so the two cannot disagree about what the image says.
export type CreativeVisualBrief = {
  // The concrete visual idea, as execution rather than as marketing. "An awkward family photo where
  // Blondie runs into frame late" -- not a second angle field.
  concept: string;
  // Freeform, on purpose. A taxonomy here would freeze a set of styles the system has no evidence
  // for and would push the generator to pick the nearest enum member instead of describing what it
  // actually means.
  style: string;
  // Ordered composition instructions. For template_only these describe layout rather than a literal
  // physical scene; that is why there is no separate `layout` field to contradict this one.
  scene: string[];
  // Short practical constraints that keep the visual executable -- "use minimal detail", "keep the
  // product obviously illustrated". Deliberately not a place to restate the generation rules: those
  // are a prompt concern, and this module stays a structural contract that knows nothing about them.
  executionNotes: string[];
};

export type CreativePhotoPackageV2 = CreativePackageBaseV2 & {
  format: "photo";
  // Still REQUIRED, and still the field every existing consumer reads. From P1 it is DERIVED from
  // visualBrief for non-capture packages rather than separately authored -- see assemble.ts. Keeping
  // it required is what makes visualBrief purely additive: nothing downstream has to learn about the
  // new field to keep working.
  visualDirection: string;
  overlayText: string | null;
  framing?: CreativeFraming;
  // OPTIONAL on the stored contract, exactly like framing and productionSource before it, and for
  // exactly the same reason: every package written before P1 has no such key, all of them remain
  // legitimate v2 packages, and no migration, schemaVersion bump or generatorVersion bump is needed
  // to keep reading them. The generation contract is the asymmetric half -- see contracts.ts, where
  // it is REQUIRED for a non-capture photo and FORBIDDEN for a capture one.
  visualBrief?: CreativeVisualBrief;
};

export type CreativeReelPackageV2 = CreativePackageBaseV2 & {
  format: "reel";
  shots: Array<{
    direction: string;
    onScreenText: string | null;
    approxSeconds?: number;
    framing?: CreativeFraming;
    // Null is a real, common answer: this shot needs no camera movement. Absent means a pre-S6
    // package that never had the field at all. The renderer shows nothing for either.
    movement?: CreativeMovement | null;
  }>;
  // Nullable because a visual-only Reel is the normal case for a bakery, not an exception.
  // Requiring speech would produce ignored filler on most Reels.
  spokenScript: string | null;
  audioDirection: string;
  // Still part of the stored package and still required: the UI shows the owner one total. From S6
  // it is DERIVED in the assembler as the sum of the shots' approxSeconds rather than authored, so
  // there is exactly one total and it cannot contradict the shot list. See assemble.ts.
  targetDurationSeconds: number;
};

export type CreativeCarouselPackageV2 = CreativePackageBaseV2 & {
  format: "carousel";
  // No mediaType, duration or movement: S6 defines Carousel slides as still images, so the medium is
  // a property of the format and adding a field for it would only create a way to contradict it.
  slides: Array<{ heading: string; body: string; visualDirection: string; framing?: CreativeFraming }>;
};

export type CreativeStoryPackageV2 = CreativePackageBaseV2 & {
  format: "story";
  frames: Array<{
    visualDirection: string;
    text: string;
    framing?: CreativeFraming;
    // The photo/video decision itself, with no separate mediaType field: null means a still photo,
    // a positive integer means a video of about that many seconds. One field cannot contradict
    // itself the way `mediaType: "video"` alongside `duration: null` could.
    approxSeconds?: number | null;
  }>;
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

// --- S6 production guidance, validated asymmetrically --------------------------------------------
//
// ABSENT is valid, because a package stored before S6 has no such key and must stay readable
// without a migration. PRESENT is validated in full, because a wrong value is a wrong value whatever
// wrote it -- "framing": "banana" was never a legitimate v2 package, and accepting it to be lenient
// about old data would only mean the renderer meets it instead.
//
// Note the deliberate asymmetry between framing and movement: framing has no null member, so a null
// framing is malformed, whereas null movement is the ordinary "this shot needs no movement" answer.
//
// H1-B adds the third state. When the package says it is NOT a fresh capture, framing must be absent
// rather than merely optional: an illustration has no camera, so any framing on it is a decision
// nobody made, and accepting one would let a package assert a camera setup for a thing that will
// never be photographed. A package with no productionSource at all is pre-H1-B and keeps S6's rule
// exactly -- absent is fine, present is validated in full.
function validateOptionalFraming(
  value: unknown,
  where: string,
  productionSource: CreativeProductionSource | undefined,
): { ok: true } | { ok: false; message: string } {
  if (productionSource !== undefined && !productionSourceRequiresFraming(productionSource)) {
    return value === undefined
      ? { ok: true }
      : { ok: false, message: `Creative Package v2 ${where} must not carry framing when productionSource is ${productionSource}: there is no camera to frame.` };
  }
  if (value === undefined || isCreativeFraming(value)) {
    return { ok: true };
  }
  return { ok: false, message: `Creative Package v2 ${where} framing must be close_up, medium, wide or overhead when present.` };
}

// P1 §7 -- ABSENT is valid (a pre-P1 package), PRESENT is validated in full. The same asymmetry as
// framing above, and the same reason: a malformed brief was never a legitimate package, whoever
// wrote it, and accepting one to be lenient about old data would only mean the renderer meets it.
//
// Note what is NOT checked here: this validator does not forbid a visualBrief on a capture_new
// package. Framing is forbidden on a non-capture package because there is no camera to frame, which
// makes the field meaningless; a brief on a capture package is merely unnecessary, which is a
// different thing. The generation contract is where "preferably absent" is enforced, because that
// is where authoring it would create a second source of truth.
function isNonEmptyStringArray(value: unknown, min: number): value is string[] {
  return Array.isArray(value) && value.length >= min && value.every((entry) => isNonEmptyString(entry));
}

function validateOptionalVisualBrief(value: unknown): { ok: true } | { ok: false; message: string } {
  if (value === undefined) {
    return { ok: true };
  }
  if (!isJsonObject(value)) {
    return { ok: false, message: "Creative Package v2 photo visualBrief must be an object when present." };
  }
  if (!isNonEmptyString(value.concept)) {
    return { ok: false, message: "Creative Package v2 photo visualBrief requires a non-empty concept." };
  }
  if (!isNonEmptyString(value.style)) {
    return { ok: false, message: "Creative Package v2 photo visualBrief requires a non-empty style." };
  }
  // At least one of each, matching how shots, slides and frames are validated: an empty array is not
  // a decision the generator made, it is a decision it skipped, and the renderer would then have to
  // carry an omit-branch for a state nothing legitimately produces.
  if (!isNonEmptyStringArray(value.scene, 1)) {
    return { ok: false, message: "Creative Package v2 photo visualBrief requires a scene array of at least one non-empty string." };
  }
  if (!isNonEmptyStringArray(value.executionNotes, 1)) {
    return { ok: false, message: "Creative Package v2 photo visualBrief requires an executionNotes array of at least one non-empty string." };
  }
  const unexpected = Object.keys(value).filter((key) => !["concept", "style", "scene", "executionNotes"].includes(key));
  if (unexpected.length > 0) {
    return { ok: false, message: `Creative Package v2 photo visualBrief has unexpected fields: ${unexpected.join(", ")}.` };
  }
  return { ok: true };
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

function validateFormatFields(
  value: Record<string, unknown>,
  productionSource: CreativeProductionSource | undefined,
): { ok: true } | { ok: false; message: string } {
  if (value.format === "photo") {
    if (!isNonEmptyString(value.visualDirection)) {
      return { ok: false, message: "Creative Package v2 photo requires a non-empty visualDirection." };
    }
    if (!isNullableString(value.overlayText)) {
      return { ok: false, message: "Creative Package v2 photo overlayText must be a string or null." };
    }
    const brief = validateOptionalVisualBrief(value.visualBrief);
    if (!brief.ok) {
      return brief;
    }
    return validateOptionalFraming(value.framing, "photo", productionSource);
  }

  if (value.format === "reel") {
    // H1-B §10 -- the Content MVP has no video generation and no template-video renderer, so a Reel
    // is a filmed Reel. Storing one that claims otherwise would describe an asset nothing can make.
    if (productionSource !== undefined && productionSource !== "capture_new") {
      return { ok: false, message: `Creative Package v2 reel productionSource must be capture_new, not ${productionSource}: a Reel is filmed.` };
    }
    if (!Array.isArray(value.shots) || value.shots.length === 0) {
      return { ok: false, message: "Creative Package v2 reel requires at least one shot." };
    }
    for (const shot of value.shots) {
      if (!isJsonObject(shot) || !isNonEmptyString(shot.direction) || !isNullableString(shot.onScreenText)) {
        return { ok: false, message: "Creative Package v2 reel shots require a non-empty direction and a string-or-null onScreenText." };
      }
      const framing = validateOptionalFraming(shot.framing, "reel shot", productionSource);
      if (!framing.ok) {
        return framing;
      }
      if (shot.approxSeconds !== undefined && !isCreativeShotSeconds(shot.approxSeconds)) {
        return { ok: false, message: "Creative Package v2 reel shot approxSeconds must be an integer from 1 to 10 when present." };
      }
      if (shot.movement !== undefined && shot.movement !== null && !isCreativeMovement(shot.movement)) {
        return { ok: false, message: "Creative Package v2 reel shot movement must be push_in, pull_back, pan or null when present." };
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
      const framing = validateOptionalFraming(slide.framing, "carousel slide", productionSource);
      if (!framing.ok) {
        return framing;
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
    const framing = validateOptionalFraming(frame.framing, "story frame", productionSource);
    if (!framing.ok) {
      return framing;
    }
    // Null is meaningful here in a way it never is for framing: it is the frame saying "still photo".
    if (frame.approxSeconds !== undefined && frame.approxSeconds !== null && !isCreativeShotSeconds(frame.approxSeconds)) {
      return { ok: false, message: "Creative Package v2 story frame approxSeconds must be null or an integer from 1 to 10 when present." };
    }
    // H1-B §11 -- Story is the one non-Reel format whose frames can individually be video, and that
    // is exactly what makes it unsafe to leave open here. A generated or template frame has no
    // footage behind it and nothing in this MVP can render one, so a zero-capture Story is a
    // sequence of STILL frames or it is a promise the system cannot keep.
    if (productionSource !== undefined && productionSource !== "capture_new" && typeof frame.approxSeconds === "number") {
      return { ok: false, message: `Creative Package v2 story frames must be still (approxSeconds null) when productionSource is ${productionSource}: there is no video generation.` };
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

  // Absent is a pre-H1-B package and is accepted unchanged. Present is validated in full, and then
  // travels into the format fields below, where it decides whether framing is required or forbidden.
  if (value.productionSource !== undefined && !isCreativeProductionSource(value.productionSource)) {
    return {
      ok: false,
      reason: "malformed-base",
      message: `Creative Package v2 productionSource must be capture_new, generate_visual or template_only when present: ${String(value.productionSource)}.`,
    };
  }
  const productionSource = value.productionSource as CreativeProductionSource | undefined;

  const metadata = validateMetadataV2(value.metadata);
  if (!metadata.ok) {
    return { ok: false, reason: "malformed-metadata", message: metadata.message };
  }

  const variants = validatePlatformVariants(value.platformVariants);
  if (!variants.ok) {
    return { ok: false, reason: "malformed-platform-variants", message: variants.message };
  }

  const formatFields = validateFormatFields(value, productionSource);
  if (!formatFields.ok) {
    return { ok: false, reason: "malformed-format-fields", message: formatFields.message };
  }

  return { ok: true, content: value as unknown as CreativePackageContentV2 };
}

export function isCreativePackageContentV2(value: unknown): value is CreativePackageContentV2 {
  return validateCreativePackageContentV2(value).ok;
}
