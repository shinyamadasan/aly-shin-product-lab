// The creative format and platform vocabulary, in a leaf module that imports nothing.
//
// Extracted from creative-packages.ts in S3B for one structural reason: CreativeInput needs
// isCreativeFormat to validate a human-supplied formatHint, and importing it from
// creative-packages.ts would close a runtime import cycle --
// creative-input -> creative-packages -> creative-jobs -> creative-input. ESM would probably
// survive that through hoisting, but "probably survives" is not a foundation. A leaf module both
// sides import keeps exactly one source of truth for the vocabulary and no cycle at all.
//
// creative-packages.ts re-exports every name below, so the S2 contract and its existing importers
// are unchanged.

// One package describes exactly ONE primary creative. Repurposing a Reel into a Story is a new
// Creative Job producing a new package, never a second format bolted onto this one.
export const CREATIVE_FORMATS = ["photo", "reel", "carousel", "story"] as const;
export type CreativeFormat = (typeof CREATIVE_FORMATS)[number];

// Only the platforms Aly & Pon's own order attribution names and Brand Presence stores handles for.
// YouTube is deliberately absent: no format targets it, and a platform nothing can be published to
// is a promise the contract cannot keep.
export const CREATIVE_PLATFORMS = ["instagram", "facebook", "tiktok"] as const;
export type CreativePlatform = (typeof CREATIVE_PLATFORMS)[number];

export function isCreativeFormat(value: unknown): value is CreativeFormat {
  return typeof value === "string" && (CREATIVE_FORMATS as readonly string[]).includes(value);
}

export function isCreativePlatform(value: unknown): value is CreativePlatform {
  return typeof value === "string" && (CREATIVE_PLATFORMS as readonly string[]).includes(value);
}
