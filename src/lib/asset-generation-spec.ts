import type { BrandBible } from "./marketing-advisor-context.ts";
import {
  isCreativePackageContentV1,
  isCreativePackageContentV2,
  type CreativePackageContentV2,
  type CreativePackageRecord,
} from "./creative-packages.ts";
import type { AssetKind } from "./asset-jobs.ts";

export const ASSET_GENERATION_IMAGE_DIMENSIONS = {
  width: 1080,
  height: 1080,
  aspectRatio: "1:1",
} as const;

export type AssetGenerationBrandStyle = {
  tone: string[];
  writingPrinciples: string[];
  prohibitedPatterns: string[];
};

export type AssetGenerationIntent = {
  purpose: "marketing-social-feed";
  outcome: "single-image";
};

export type AssetGenerationSpecV1 = {
  schemaVersion: "v1";
  assetKind: "image";
  sourceCreativePackageId: string;
  generationIntent: AssetGenerationIntent;
  copy: {
    headline: string;
    caption: string;
  };
  dimensions: typeof ASSET_GENERATION_IMAGE_DIMENSIONS;
  brandStyle: AssetGenerationBrandStyle | null;
  // ALWAYS null for a v1 package, so a v1 brief renders exactly as it always has and briefSha256
  // is unchanged for every asset produced before S2. Populated only from a v2 package, where the
  // creative plan genuinely carries visual direction the image generator can use.
  visualDirection: string | null;
};

export type BuildAssetGenerationSpecParams = {
  assetKind: AssetKind;
  brandBible?: BrandBible;
};

export function deriveBrandStyle(brandBible: BrandBible): AssetGenerationBrandStyle {
  return {
    tone: brandBible.tone,
    writingPrinciples: brandBible.writingPrinciples,
    prohibitedPatterns: brandBible.prohibitedPatterns,
  };
}

export function buildAssetGenerationSpec(
  creativePackage: CreativePackageRecord,
  params: BuildAssetGenerationSpecParams,
): AssetGenerationSpecV1 {
  if (params.assetKind !== "image") {
    throw new Error(`AssetGenerationSpecV1 only supports image assets. Received: ${params.assetKind}.`);
  }

  const content = creativePackage.content;
  const copy = isCreativePackageContentV1(content)
    ? { headline: content.output.headline, caption: content.output.caption }
    : isCreativePackageContentV2(content)
      ? // v2 keeps `headline` at the top level precisely so this mapping stays a field read rather
        // than a reconstruction. This is why headline was retained in the v2 base.
        { headline: content.headline, caption: content.caption }
      : null;

  if (!copy) {
    throw new Error("AssetGenerationSpecV1 requires Creative Package content v1 or v2.");
  }

  return {
    schemaVersion: "v1",
    assetKind: "image",
    sourceCreativePackageId: creativePackage.id,
    generationIntent: {
      purpose: "marketing-social-feed",
      outcome: "single-image",
    },
    copy,
    dimensions: ASSET_GENERATION_IMAGE_DIMENSIONS,
    brandStyle: params.brandBible ? deriveBrandStyle(params.brandBible) : null,
    visualDirection: isCreativePackageContentV2(content) ? deriveVisualDirection(content) : null,
  };
}

// The documented package -> asset mapping. Deterministic and total: no AI, no clock, no I/O, and
// every format resolves to exactly one string.
//
//   photo     -> visualDirection verbatim
//   reel      -> every shot direction, in order
//   carousel  -> every slide visualDirection, in order
//   story     -> every frame visualDirection, in order
//
// The asset pipeline still produces ONE image (generationIntent stays single-image). For the
// multi-part formats this is deliberately a description of the whole creative rather than an
// attempt to render each shot/slide/frame -- building that would be a new media-generation system,
// which S2 explicitly is not. Joined with "; " so the brief reads as one instruction.
export function deriveVisualDirection(content: CreativePackageContentV2): string {
  if (content.format === "photo") {
    return content.visualDirection;
  }
  if (content.format === "reel") {
    return content.shots.map((shot) => shot.direction).join("; ");
  }
  if (content.format === "carousel") {
    return content.slides.map((slide) => slide.visualDirection).join("; ");
  }
  return content.frames.map((frame) => frame.visualDirection).join("; ");
}
