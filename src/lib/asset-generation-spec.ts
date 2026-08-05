import type { BrandBible } from "./marketing-advisor-context.ts";
import { isCreativePackageContentV1, type CreativePackageRecord } from "./creative-packages.ts";
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

  if (!isCreativePackageContentV1(creativePackage.content)) {
    throw new Error("AssetGenerationSpecV1 requires Creative Package content v1.");
  }

  return {
    schemaVersion: "v1",
    assetKind: "image",
    sourceCreativePackageId: creativePackage.id,
    generationIntent: {
      purpose: "marketing-social-feed",
      outcome: "single-image",
    },
    copy: {
      headline: creativePackage.content.output.headline,
      caption: creativePackage.content.output.caption,
    },
    dimensions: ASSET_GENERATION_IMAGE_DIMENSIONS,
    brandStyle: params.brandBible ? deriveBrandStyle(params.brandBible) : null,
  };
}
