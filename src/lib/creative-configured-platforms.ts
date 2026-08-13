import { CREATIVE_PLATFORMS, type CreativePlatform } from "./creative-formats.ts";
import type { BrandProfile } from "./product-lab-types.ts";

// Content Creation MVP S3E-A2 -- which platforms the generator may write variants for.
//
// Deliberately NOT a new configuration domain. The S3E-A audit found no configuredPlatforms
// concept, and inventing one (a settings table, a UI, a defaults list) would be a whole feature
// this slice does not need. Brand Presence already records, as real owner-entered data, which
// accounts this business actually has -- so that is the source, and the derivation is a read.
//
// THE RULE: a platform is configured when its Brand Presence entry carries a non-empty handle OR a
// non-empty URL. Either alone is enough -- the owner may record "@alyandpon" without a link, or a
// link without the handle, and both mean the account exists.
//
// Absence is never guessed in either direction. No Brand Profile at all, or one with nothing filled
// in, yields an EMPTY list, not a default set. An empty list is honest and permitted: S2 and S3B
// both accept platformVariants as a subset, including none. Fabricating "instagram" because a
// bakery probably has Instagram would put a claim in the package that no data supports.
//
// YouTube is excluded even though Brand Presence stores it, because CREATIVE_PLATFORMS excludes it
// -- no Content MVP format targets YouTube, and a variant for a platform nothing can publish to is
// a promise the contract cannot keep.
//
// Ordering follows CREATIVE_PLATFORMS' own declaration order, so the same configuration always
// produces the same list and the same prompt text.

type BrandPresenceFields = Pick<
  BrandProfile,
  "facebookHandle" | "facebookUrl" | "instagramHandle" | "instagramUrl" | "tiktokHandle" | "tiktokUrl"
>;

const PRESENCE_FIELDS_BY_PLATFORM: Record<CreativePlatform, ReadonlyArray<keyof BrandPresenceFields>> = {
  instagram: ["instagramHandle", "instagramUrl"],
  facebook: ["facebookHandle", "facebookUrl"],
  tiktok: ["tiktokHandle", "tiktokUrl"],
};

function isConfigured(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

export function deriveConfiguredPlatforms(brandProfile: BrandPresenceFields | null): CreativePlatform[] {
  if (brandProfile === null) {
    return [];
  }
  return CREATIVE_PLATFORMS.filter((platform) =>
    PRESENCE_FIELDS_BY_PLATFORM[platform].some((field) => isConfigured(brandProfile[field])),
  );
}
