import type { BrandTokens } from "./creative-spec.ts";

// Content Studio Fast Mode -- layout geometry shared by the carousel, the reel and the copy fit.
//
// PURE. Layout, not brand: these are the boxes the words must fit in. Both canvases are 1080 wide
// with the same side padding (spacing.lg), so a line that fits its carousel box also fits the reel's,
// whose boxes are the same width and at least as tall. copy-fit.ts measures against exactly these.

export const CAROUSEL_LAYOUT = {
  heroBandHeight: 220,
  // Room the wordmark keeps at the right of the hero band.
  heroWordmarkSlot: 220,
  offerPhotoHeight: 800,
  ctaPhotoHeight: 560,
} as const;

export const REEL_LAYOUT = {
  // Keeps the hero copy clear of the bottom platform UI.
  heroBandHeight: 420,
  offerTop: 220,
  offerPhotoHeight: 1100,
  endCardPhotoHeight: 820,
  collage: {
    detail: { width: 640, height: 800, top: 220 },
    context: { width: 560, height: 700, top: 860 },
  },
} as const;

export type CopyBox = {
  maxWidth: number;
  maxHeight: number;
  lineHeight: number;
  fontWeight: 400 | 700;
  // Largest first. The first size is the brand token; the rest are the readable steps down.
  candidateSizes: number[];
};

export type CopyBoxes = {
  headline: CopyBox;
  offerProductName: CopyBox;
  offerLine: CopyBox;
  endProductName: CopyBox;
  endOfferLine: CopyBox;
  cta: CopyBox;
};

// The content width inside the side padding; the same on both canvases.
export function contentWidth(brand: BrandTokens, canvasWidth: number): number {
  return canvasWidth - brand.spacing.lg * 2;
}

export function ctaTextMaxWidth(brand: BrandTokens, canvasWidth: number): number {
  return contentWidth(brand, canvasWidth) - brand.spacing.md * 2 - CTA_BORDER_WIDTH * 2;
}

export const CTA_BORDER_WIDTH = 3;
export const END_RULE = { width: 120, height: 4 } as const;

export function copyBoxes(brand: BrandTokens, canvasWidth: number): CopyBoxes {
  const t = brand.typography;
  const width = contentWidth(brand, canvasWidth);
  return {
    headline: {
      maxWidth: width - CAROUSEL_LAYOUT.heroWordmarkSlot - brand.spacing.sm,
      maxHeight: CAROUSEL_LAYOUT.heroBandHeight - brand.spacing.sm * 1.5,
      lineHeight: t.lineHeight.tight,
      fontWeight: t.weight.bold,
      candidateSizes: [t.heading.lg, 72, t.heading.md, 52, 44],
    },
    offerProductName: {
      maxWidth: width,
      maxHeight: 120,
      lineHeight: t.lineHeight.tight,
      fontWeight: t.weight.bold,
      candidateSizes: [t.heading.md, 52, 44, t.body.lg],
    },
    offerLine: {
      maxWidth: width,
      maxHeight: 200,
      lineHeight: t.lineHeight.tight,
      fontWeight: t.weight.bold,
      candidateSizes: [t.heading.lg, 72, t.heading.md, 52],
    },
    endProductName: {
      maxWidth: width,
      maxHeight: 104,
      lineHeight: t.lineHeight.normal,
      fontWeight: t.weight.regular,
      candidateSizes: [t.body.lg, 36, t.body.md],
    },
    endOfferLine: {
      maxWidth: width,
      maxHeight: 130,
      lineHeight: t.lineHeight.tight,
      fontWeight: t.weight.bold,
      candidateSizes: [t.heading.md, 52, 44, t.body.lg],
    },
    cta: {
      maxWidth: ctaTextMaxWidth(brand, canvasWidth),
      maxHeight: 104,
      lineHeight: t.lineHeight.normal,
      fontWeight: t.weight.bold,
      candidateSizes: [t.body.lg, 36, t.body.md, 28],
    },
  };
}
