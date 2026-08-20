import type { BrandBible } from "./marketing-advisor-context.ts";
import { sha256Hex } from "./asset-digest.ts";
import { deriveBrandStyle, type AssetGenerationBrandStyle } from "./asset-generation-spec.ts";
import { isCreativePackageContentV2, type CreativeVisualBrief } from "./creative-package-content-v2.ts";
import type { CreativePackageRecord } from "./creative-packages.ts";
import type { AssetKind } from "./asset-jobs.ts";

// Production MVP Wave A -- the executor-facing production specification.
//
// WHY THIS IS A SIBLING OF AssetGenerationSpecV1 AND NOT A CHANGE TO IT
//
// AssetGenerationSpecV1 is not merely a type: its rendered brief is hashed into briefSha256 and that
// hash is persisted on every Asset ever produced. asset-generation-brief.ts states the guarantee in
// full -- the same job must always render a byte-identical brief, so that "was this asset made from
// the brief we think it was" stays a real, checkable question. Widening V1 with a dimension that can
// vary, or with a structured visualBrief, would change that rendering and silently invalidate every
// stored hash.
//
// So V1 is frozen, exactly as it is, for the external/human image path it already serves. This is
// the additive second spec that automated executors read, and it is free to carry what they need.
//
// WHAT THIS SPEC IS NOT
//
// It carries CREATIVE INTENT only. There is deliberately no fps, no durationInFrames, no codec, no
// CRF or bitrate, no composition id, no Chromium flag, no easing curve, no safe-margin pixel
// constant, no font path, and no temp or output path. Every one of those is computed inside an
// executor at render time from the intent below. None of them is a decision anyone at Aly & Pon
// would recognise as theirs, which is the test for whether a field belongs here.

// The two output shapes Production MVP targets. Dimensions live in the spec (an executor is told
// what to make, it does not decide) but are a ROUTE-level decision rather than a package-level one:
// a square feed image and a vertical Reel are different products, not different creative briefs.
export const PRODUCTION_IMAGE_DIMENSIONS = {
  width: 1080,
  height: 1080,
  aspectRatio: "1:1",
} as const;

export const PRODUCTION_SHORT_VIDEO_DIMENSIONS = {
  width: 1080,
  height: 1920,
  aspectRatio: "9:16",
} as const;

export type ProductionSpecDimensions = {
  width: number;
  height: number;
  aspectRatio: string;
};

// The copy an executor receives, and -- load-bearing -- WHICH OF IT MAY BE DRAWN ON THE IMAGE.
//
// This distinction was missing, and the first real production run is what exposed it. `caption` is
// the SOCIAL POST CAPTION: 231 characters of copy that belongs under the post, not inside the
// picture. The renderer drew it as the composition's accent line, so a real package's caption ran off
// the canvas and through the brand mark.
//
// CreativePackageContentV2 already answers this and always did. Its own contract states that
// "overlayText remains the single canonical home for text placed ON the visual, so the two cannot
// disagree about what the image says". The package that overflowed carries
// overlayText = "HELLO my name is BLONDIES" -- short, designed for the image, and exactly what its
// visualDirection describes. Nothing about the package was wrong; the SPEC simply did not carry the
// field, so the renderer had nothing to draw but the social caption.
//
// So overlayText is transported here. That is a mapping fix inside Wave B's own executor-facing
// spec: CreativePackageContentV2 is untouched, no copy field is invented, and no wording is changed.
export type ProductionSpecCopy = {
  headline: string;
  // SOCIAL POST COPY. Carried because it is legitimate creative context (the generative prompt falls
  // back to it when a package has no visualBrief) but it is NEVER drawn into the image.
  caption: string;
  cta: string;
  // THE ONLY free text that may be drawn onto the visual, besides the headline. Null means the
  // package specifies no on-image text, and the composition then shows the headline alone rather
  // than substituting something else.
  overlayText: string | null;
};

// One shot's worth of intent, mapped 1:1 from a Reel shot. Deliberately the same three facts the
// package already carries and no more -- adding a transition type, a layer list or an easing name
// here would be inventing motion instructions the generator never authored.
export type ProductionScene = {
  direction: string;
  // Null is a real answer: a shot with no on-screen text. Mirrors the package's own nullable
  // onScreenText rather than collapsing absence and emptiness into one.
  text: string | null;
  // Null means the package did not state a per-shot duration (a pre-S6 package). The executor
  // distributes the remaining time; it is not this module's job to invent a number.
  approxSeconds: number | null;
};

type ProductionSpecBaseV1 = {
  // "production-v1", not "v1", and the distinction is load-bearing rather than cosmetic.
  //
  // AssetGenerationSpecV1 also carries schemaVersion "v1" and assetKind "image". Had this type
  // reused "v1", the two members of the AssetJobExecutor spec union would be structurally
  // indistinguishable at runtime for the image case -- an executor handed one could not reliably
  // tell which contract it had received, and neither could a type guard. A union whose members
  // cannot be told apart is not a union, it is an ambiguity.
  schemaVersion: "production-v1";
  sourceCreativePackageId: string;
  dimensions: ProductionSpecDimensions;
  copy: ProductionSpecCopy;
  brandStyle: AssetGenerationBrandStyle | null;
  // STRUCTURED, not flattened. The whole point of closing this gap is that visualBrief's four
  // fields survive the trip to the executor: concept, style, scene[] and executionNotes[] are four
  // different kinds of instruction, and joining them into one string here would rebuild exactly the
  // wall of prose the structured brief was introduced to replace.
  //
  // Null covers two legitimate cases that need no distinction downstream: a package written before
  // P1 (no visualBrief field at all), and a capture package (which is directed, not briefed).
  visualBrief: CreativeVisualBrief | null;
};

export type ProductionImageSpecV1 = ProductionSpecBaseV1 & {
  assetKind: "image";
};

export type ProductionShortVideoSpecV1 = ProductionSpecBaseV1 & {
  assetKind: "short_video";
  scenes: ProductionScene[];
  // Kept as the package states it rather than recomputed from scenes: the package already derives
  // this as the sum of its shots (see assemble.ts), so recomputing it here would create a second
  // total that can disagree with the one the owner was shown.
  targetDurationSeconds: number;
};

export type ProductionSpecV1 = ProductionImageSpecV1 | ProductionShortVideoSpecV1;

export type BuildProductionSpecParams = {
  assetKind: AssetKind;
  brandBible?: BrandBible;
};

export function isProductionSpecV1(value: unknown): value is ProductionSpecV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<ProductionSpecV1>;
  return candidate.schemaVersion === "production-v1";
}

// --- canonical fingerprinting --------------------------------------------------------------------
//
// JSON.stringify is NOT a canonical serializer: it emits keys in insertion order, so two specs that
// are the same fact -- one built by buildProductionSpec, one round-tripped through the database or
// assembled field-by-field in a different order -- serialize to different bytes and therefore hash
// differently. A fingerprint that changes when nothing meaningful changed cannot answer "was this
// asset made from the spec we think it was", which is the only question it exists to answer.
//
// So the value is canonicalized before it is serialized: object keys sorted, arrays left alone.
// Array order is deliberately preserved -- a Reel's scenes and a brief's executionNotes are ordered
// content, and sorting them would make two genuinely different specs collide.
//
// Deliberately narrow: this handles exactly the JSON value shapes ProductionSpecV1 can contain
// (objects, arrays, strings, numbers, booleans, null). It is not a general-purpose canonical-JSON
// implementation, and it is not applied to anything else.
function canonicalizeJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeJsonValue);
  }

  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const canonical: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      const entry = source[key];
      // Matches JSON.stringify's own behaviour rather than diverging from it: an undefined-valued
      // key is absent from the output, so a spec and its JSON round-trip canonicalize identically.
      if (entry === undefined) {
        continue;
      }
      canonical[key] = canonicalizeJsonValue(entry);
    }
    return canonical;
  }

  return value;
}

export function renderProductionSpecFingerprintInput(spec: ProductionSpecV1): string {
  return JSON.stringify(canonicalizeJsonValue(spec));
}

// The ProductionSpecV1 counterpart of briefSha256, and deliberately a SEPARATE function rather than
// a widening of it.
//
// briefSha256 hashes the RENDERED HUMAN BRIEF text of an AssetGenerationSpecV1 -- the exact prose a
// person is handed in an external creative workspace. This hashes the canonical serialization of the
// production spec itself, because a production spec is read by an executor and has no rendered human
// brief to hash. The two are different inputs answering the same provenance question for two
// different contracts, and blurring them would make the stored digest ambiguous about which it is.
// The persisted column they currently share is named for the older of the two -- see the
// transitional-naming note at the runAssetJobWithExecutors call site.
export async function productionSpecSha256(spec: ProductionSpecV1): Promise<string> {
  return sha256Hex(new TextEncoder().encode(renderProductionSpecFingerprintInput(spec)));
}

// Deterministic and total for the inputs it accepts: no AI, no clock, no I/O. Throws rather than
// guesses on a caller error, matching buildAssetGenerationSpec's own precedent -- a spec built from
// the wrong package shape is not a degraded spec, it is a bug.
export function buildProductionSpec(creativePackage: CreativePackageRecord, params: BuildProductionSpecParams): ProductionSpecV1 {
  const content = creativePackage.content;

  // v2 only, on purpose. Every field this spec adds beyond V1 -- visualBrief, cta, the shot list --
  // is a v2 concept. A v1 package has none of them, and the Production Route sends v1 packages down
  // the legacy external path that reads AssetGenerationSpecV1 instead, so this is unreachable in
  // normal operation rather than a limitation anyone meets.
  if (!isCreativePackageContentV2(content)) {
    throw new Error("ProductionSpecV1 requires Creative Package content v2.");
  }

  const base: ProductionSpecBaseV1 = {
    schemaVersion: "production-v1",
    sourceCreativePackageId: creativePackage.id,
    dimensions: params.assetKind === "short_video" ? PRODUCTION_SHORT_VIDEO_DIMENSIONS : PRODUCTION_IMAGE_DIMENSIONS,
    copy: {
      headline: content.headline,
      caption: content.caption,
      cta: content.cta,
      // Only a photo package has overlayText; a Reel carries its on-screen text per shot instead.
      overlayText: content.format === "photo" ? (content.overlayText ?? null) : null,
    },
    brandStyle: params.brandBible ? deriveBrandStyle(params.brandBible) : null,
    // Only a photo package carries a brief today, and only a non-capture one at that. Absent stays
    // absent -- see the null note on the field itself.
    visualBrief: content.format === "photo" ? (content.visualBrief ?? null) : null,
  };

  if (params.assetKind === "image") {
    return { ...base, assetKind: "image" };
  }

  // short_video. The only format that can describe motion is a Reel, and it already describes it
  // fully: an ordered shot list with per-shot text and seconds, plus a derived total. There is no
  // translation to invent here, only a 1:1 mapping -- which is the evidence that the existing
  // contract could already express a generated Reel without new fields.
  if (content.format !== "reel") {
    throw new Error(`ProductionSpecV1 short_video requires a reel Creative Package. Received format: ${content.format}.`);
  }

  return {
    ...base,
    assetKind: "short_video",
    scenes: content.shots.map((shot) => ({
      direction: shot.direction,
      text: shot.onScreenText,
      approxSeconds: shot.approxSeconds ?? null,
    })),
    targetDurationSeconds: content.targetDurationSeconds,
  };
}
