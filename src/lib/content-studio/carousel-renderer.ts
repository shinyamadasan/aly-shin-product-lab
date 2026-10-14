import { Resvg } from "@resvg/resvg-js";
import { createElement, type ReactNode } from "react";
import satori from "satori";

import { EMBEDDED_PRODUCTION_FONTS } from "../production-fonts.ts";
import {
  CAROUSEL_FILE_NAMES,
  NOT_FOR_PUBLISHING_LABEL,
  planCarousel,
  resolvedMediaFor,
  type CarouselSlidePlan,
  type PreparedCampaign,
} from "./creative-plan.ts";
import { assertSpecSupportsFormat, parseCreativeSpec } from "./creative-spec.ts";
import { CAROUSEL_LAYOUT, CTA_BORDER_WIDTH, END_RULE } from "./layout.ts";

// Content Studio Fast Mode -- STATIC CAROUSEL: Satori -> SVG -> Resvg -> PNG. NODE ONLY.
//
// Five 1080x1350 slides from one CreativeSpec. Every colour and face comes from spec.brand, every
// type size from spec.brand or the shared copy fit, every word from creative-plan.ts. This file only
// decides layout.
//
// Restraint is the design: the owner's photo fills the frame, slides 2 and 3 carry no copy, and there
// are no gradients, textures, shadows or decorative shapes.

export type RenderedSlide = {
  index: number;
  kind: CarouselSlidePlan["kind"];
  fileName: string;
  png: Buffer;
  width: number;
  height: number;
};

function h(type: string, props: Record<string, unknown> | null, ...children: ReactNode[]): ReactNode {
  return createElement(type, props, ...children);
}

function photo(campaign: PreparedCampaign, id: string, width: number, height: number, radius = 0): ReactNode {
  const media = resolvedMediaFor(campaign.media, id);
  if (media.kind !== "photo") throw new Error(`Media "${id}" is a video; the carousel draws photos only.`);
  return h(
    "div",
    { style: { display: "flex", width, height, borderRadius: radius, overflow: "hidden" } },
    h("img", { src: media.dataUri, width, height, style: { width, height, objectFit: "cover", borderRadius: radius } }),
  );
}

function notForPublishingTag(campaign: PreparedCampaign): ReactNode {
  if (!campaign.notForPublishing) return null;
  const { color, typography, spacing, radius } = campaign.spec.brand;
  return h(
    "div",
    {
      style: {
        position: "absolute",
        top: spacing.sm,
        right: spacing.sm,
        display: "flex",
        padding: `${spacing.xs / 2}px ${spacing.xs}px`,
        borderRadius: radius.sm,
        backgroundColor: color.foreground,
        color: color.background,
        fontSize: typography.body.sm,
        fontWeight: typography.weight.bold,
        letterSpacing: typography.body.sm * typography.letterSpacing.label,
      },
    },
    NOT_FOR_PUBLISHING_LABEL,
  );
}

function slideBody(campaign: PreparedCampaign, slide: CarouselSlidePlan): ReactNode {
  const { spec, copy } = campaign;
  const { color, typography: t, spacing, radius } = spec.brand;
  const { width, height } = spec.output.carousel;
  const tight = (size: number) => size * t.letterSpacing.tight;
  const inner = width - spacing.lg * 2;

  switch (slide.kind) {
    case "hero":
      return h(
        "div",
        { style: { display: "flex", flexDirection: "column", width, height } },
        photo(campaign, slide.mediaId, width, height - CAROUSEL_LAYOUT.heroBandHeight),
        h(
          "div",
          { style: { display: "flex", flexGrow: 1, alignItems: "center", justifyContent: "space-between", padding: `0 ${spacing.lg}px` } },
          h(
            "div",
            {
              style: {
                display: "flex",
                width: inner - CAROUSEL_LAYOUT.heroWordmarkSlot - spacing.sm,
                fontSize: copy.headline,
                fontWeight: t.weight.bold,
                lineHeight: t.lineHeight.tight,
                letterSpacing: tight(copy.headline),
              },
            },
            slide.headline,
          ),
          h("div", { style: { display: "flex", fontSize: t.body.md, fontWeight: t.weight.bold, color: color.muted } }, slide.wordmark),
        ),
      );

    case "detail":
      return photo(campaign, slide.mediaId, width, height);

    case "context":
      return h(
        "div",
        { style: { display: "flex", width, height, padding: spacing.lg } },
        photo(campaign, slide.mediaId, inner, height - spacing.lg * 2, radius.md),
      );

    case "offer":
      return h(
        "div",
        { style: { display: "flex", flexDirection: "column", width, height, padding: spacing.lg } },
        photo(campaign, slide.mediaId, inner, CAROUSEL_LAYOUT.offerPhotoHeight, radius.md),
        h(
          "div",
          { style: { display: "flex", flexDirection: "column", marginTop: spacing.md, width: inner } },
          h(
            "div",
            { style: { display: "flex", fontSize: copy.offerProductName, fontWeight: t.weight.bold, lineHeight: t.lineHeight.tight, letterSpacing: tight(copy.offerProductName) } },
            slide.productName,
          ),
          h(
            "div",
            {
              style: {
                display: "flex",
                marginTop: spacing.xs,
                fontSize: copy.offerLine,
                fontWeight: t.weight.bold,
                lineHeight: t.lineHeight.tight,
                color: color.accent,
                letterSpacing: tight(copy.offerLine),
              },
            },
            slide.offerLine,
          ),
        ),
      );

    case "cta":
      return h(
        "div",
        { style: { display: "flex", flexDirection: "column", width, height } },
        photo(campaign, slide.mediaId, width, CAROUSEL_LAYOUT.ctaPhotoHeight),
        h(
          "div",
          {
            style: {
              display: "flex",
              flexDirection: "column",
              flexGrow: 1,
              alignItems: "center",
              justifyContent: "center",
              padding: `${spacing.md}px ${spacing.lg}px`,
              textAlign: "center",
            },
          },
          h("div", { style: { display: "flex", fontSize: t.heading.xl, fontWeight: t.weight.bold, lineHeight: t.lineHeight.tight, letterSpacing: tight(t.heading.xl) } }, slide.wordmark),
          h("div", { style: { width: END_RULE.width, height: END_RULE.height, marginTop: spacing.md, marginBottom: spacing.md, backgroundColor: color.accent } }),
          h("div", { style: { display: "flex", justifyContent: "center", width: inner, fontSize: copy.endProductName, lineHeight: t.lineHeight.normal, color: color.muted } }, slide.productName),
          h(
            "div",
            {
              style: {
                display: "flex",
                justifyContent: "center",
                width: inner,
                marginTop: spacing.xs,
                fontSize: copy.endOfferLine,
                fontWeight: t.weight.bold,
                lineHeight: t.lineHeight.tight,
                letterSpacing: tight(copy.endOfferLine),
              },
            },
            slide.offerLine,
          ),
          h(
            "div",
            {
              style: {
                display: "flex",
                justifyContent: "center",
                maxWidth: inner,
                marginTop: spacing.lg,
                padding: `${spacing.sm}px ${spacing.md}px`,
                border: `${CTA_BORDER_WIDTH}px solid ${color.accent}`,
                borderRadius: radius.lg,
                color: color.accent,
                fontSize: copy.cta,
                fontWeight: t.weight.bold,
                lineHeight: t.lineHeight.normal,
              },
            },
            slide.cta,
          ),
        ),
      );
  }
}

// Exported so tests can inspect exactly which words a slide draws without rasterizing it.
export function buildCarouselSlideElement(campaign: PreparedCampaign, slide: CarouselSlidePlan): ReactNode {
  const { spec } = campaign;
  const { width, height } = spec.output.carousel;
  return h(
    "div",
    {
      style: {
        display: "flex",
        position: "relative",
        width,
        height,
        overflow: "hidden",
        backgroundColor: spec.brand.color.background,
        color: spec.brand.color.foreground,
        fontFamily: spec.brand.typography.fontFamily,
      },
    },
    slideBody(campaign, slide),
    notForPublishingTag(campaign),
  );
}

// The production font authority (src/lib/production-fonts.ts), the same faces the reel loads.
function satoriFonts(family: string) {
  return EMBEDDED_PRODUCTION_FONTS.map((face) => {
    const buffer = Buffer.from(face.base64, "base64");
    return {
      name: family,
      data: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer,
      weight: face.weight,
      style: "normal" as const,
    };
  });
}

export async function renderCarouselSlide(campaign: PreparedCampaign, index: number): Promise<RenderedSlide> {
  const spec = parseCreativeSpec(campaign.spec);
  assertSpecSupportsFormat(spec, "carousel");
  const slide = planCarousel(spec).find((candidate) => candidate.index === index);
  if (!slide) throw new Error(`The carousel has no slide ${index}.`);

  const { width, height } = spec.output.carousel;
  const svg = await satori(buildCarouselSlideElement({ ...campaign, spec }, slide) as Parameters<typeof satori>[0], {
    width,
    height,
    fonts: satoriFonts(spec.brand.typography.fontFamily),
  });
  const png = new Resvg(svg, { fitTo: { mode: "width", value: width } }).render().asPng();
  return { index: slide.index, kind: slide.kind, fileName: CAROUSEL_FILE_NAMES[slide.index - 1], png: Buffer.from(png), width, height };
}

export async function renderCarousel(campaign: PreparedCampaign): Promise<RenderedSlide[]> {
  const slides: RenderedSlide[] = [];
  for (const slide of planCarousel(parseCreativeSpec(campaign.spec))) {
    slides.push(await renderCarouselSlide(campaign, slide.index));
  }
  return slides;
}
