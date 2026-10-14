import type { CreativeMedia, CreativeSpec } from "./creative-spec.ts";

// Content Studio Fast Mode -- what each output says and shows, derived from the spec.
//
// PURE: no zod, no React, no Remotion, no Node APIs. It runs inside the Remotion browser bundle, in
// Node, in the browser UI and under `node --test`. Every string either renderer draws is produced
// here from spec fields, which is what lets a test prove the carousel and the reel carry identical
// facts.

// One media item per role, in the order the owner picks them: the recipe for both outputs.
export const MEDIA_ROLES = ["hero", "detail", "context", "offer", "supporting"] as const;
export type MediaRole = (typeof MEDIA_ROLES)[number];

// What the owner sees for each pick, in plain words.
export const MEDIA_ROLE_LABELS: Record<MediaRole, string> = {
  hero: "Main photo",
  detail: "Close-up",
  context: "In hand or in use",
  offer: "Price photo",
  supporting: "Closing photo",
};

export const NOT_FOR_PUBLISHING_LABEL = "TEST MEDIA ONLY · NOT FOR PUBLISHING";

// ₱1,250 / ₱99.50. Grouping and decimals only -- the amount itself is never rounded or changed.
// Hand-rolled rather than Intl so Node, Chrome and the browser print exactly the same characters.
export function formatPesoAmount(amount: number): string {
  const centavos = Math.round(amount * 100);
  const whole = Math.trunc(centavos / 100);
  const fraction = centavos % 100;
  const grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `₱${grouped}${fraction === 0 ? "" : `.${String(fraction).padStart(2, "0")}`}`;
}

// "₱160 / 2 pcs" -- the confirmed price and selling unit, never reworded.
export function formatOfferLine(offer: CreativeSpec["offer"]): string {
  return `${formatPesoAmount(offer.price.amount)} / ${offer.unit}`;
}

export function heroHeadline(spec: CreativeSpec): string {
  return spec.content.headline ?? spec.product.name;
}

export function mediaForRole(spec: CreativeSpec, role: MediaRole): CreativeMedia {
  const found = spec.media.find((item) => item.role === role);
  if (!found) throw new Error(`CreativeSpec has no media with role "${role}".`);
  return found;
}

// --- static carousel ------------------------------------------------------------------------------

export type CarouselSlidePlan =
  | { index: 1; kind: "hero"; mediaId: string; headline: string; wordmark: string }
  | { index: 2; kind: "detail"; mediaId: string }
  | { index: 3; kind: "context"; mediaId: string }
  | { index: 4; kind: "offer"; mediaId: string; productName: string; offerLine: string }
  | { index: 5; kind: "cta"; mediaId: string; wordmark: string; productName: string; offerLine: string; cta: string };

export const CAROUSEL_FILE_NAMES = ["carousel-01.png", "carousel-02.png", "carousel-03.png", "carousel-04.png", "carousel-05.png"] as const;
export const CAROUSEL_ZIP_FILE_NAME = "carousel.zip";
export const REEL_FILE_NAME = "reel.mp4";

export function planCarousel(spec: CreativeSpec): CarouselSlidePlan[] {
  const offerLine = formatOfferLine(spec.offer);
  const wordmark = spec.brand.logo.text;
  return [
    { index: 1, kind: "hero", mediaId: mediaForRole(spec, "hero").id, headline: heroHeadline(spec), wordmark },
    { index: 2, kind: "detail", mediaId: mediaForRole(spec, "detail").id },
    { index: 3, kind: "context", mediaId: mediaForRole(spec, "context").id },
    { index: 4, kind: "offer", mediaId: mediaForRole(spec, "offer").id, productName: spec.product.name, offerLine },
    { index: 5, kind: "cta", mediaId: mediaForRole(spec, "supporting").id, wordmark, productName: spec.product.name, offerLine, cta: spec.offer.cta },
  ];
}

// --- motion reel (EDITORIAL_COLLAGE) --------------------------------------------------------------
//
// Four scenes joined by hard cuts, mirroring the carousel's story: hero, then detail and context as a
// two-tile collage, then the offer, then the end card under the closing media. Boundaries are
// fractions of the total so a 10s and a 12s cut keep the same rhythm (for 11s: 0-3s, 3-6.5s, 6.5-9s,
// 9-11s).

export const EDITORIAL_COLLAGE_COMPOSITION_ID = "fast-mode-editorial-collage";

const SCENE_BOUNDARIES = [0, 3 / 11, 6.5 / 11, 9 / 11, 1] as const;

type SceneTiming = { from: number; durationInFrames: number };

export type ReelScenePlan =
  | (SceneTiming & { kind: "hero"; mediaId: string; headline: string; wordmark: string })
  | (SceneTiming & { kind: "collage"; detailMediaId: string; contextMediaId: string })
  | (SceneTiming & { kind: "offer"; mediaId: string; productName: string; offerLine: string })
  | (SceneTiming & { kind: "end_card"; mediaId: string; wordmark: string; productName: string; offerLine: string; cta: string });

export type ReelPlan = {
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
  scenes: ReelScenePlan[];
};

export function reelDurationInFrames(spec: CreativeSpec): number {
  return Math.round(spec.output.reel.durationSeconds * spec.output.reel.fps);
}

export function planEditorialCollageReel(spec: CreativeSpec): ReelPlan {
  const durationInFrames = reelDurationInFrames(spec);
  const cuts = SCENE_BOUNDARIES.map((fraction) => Math.round(fraction * durationInFrames));
  const timing = (i: number): SceneTiming => ({ from: cuts[i], durationInFrames: cuts[i + 1] - cuts[i] });
  const offerLine = formatOfferLine(spec.offer);
  const wordmark = spec.brand.logo.text;

  return {
    width: spec.output.reel.width,
    height: spec.output.reel.height,
    fps: spec.output.reel.fps,
    durationInFrames,
    scenes: [
      { ...timing(0), kind: "hero", mediaId: mediaForRole(spec, "hero").id, headline: heroHeadline(spec), wordmark },
      { ...timing(1), kind: "collage", detailMediaId: mediaForRole(spec, "detail").id, contextMediaId: mediaForRole(spec, "context").id },
      { ...timing(2), kind: "offer", mediaId: mediaForRole(spec, "offer").id, productName: spec.product.name, offerLine },
      { ...timing(3), kind: "end_card", mediaId: mediaForRole(spec, "supporting").id, wordmark, productName: spec.product.name, offerLine, cta: spec.offer.cta },
    ],
  };
}

export function sceneMediaIds(scene: ReelScenePlan): string[] {
  return scene.kind === "collage" ? [scene.detailMediaId, scene.contextMediaId] : [scene.mediaId];
}

// A clip plays from its first frame for its whole scene and is never looped or slowed down. A clip
// shorter than its scene would end on a frozen or empty frame, so it is refused up front.
export function reelClipShortfalls(spec: CreativeSpec): { mediaId: string; role: MediaRole; neededSeconds: number; clipSeconds: number }[] {
  const plan = planEditorialCollageReel(spec);
  const shortfalls: { mediaId: string; role: MediaRole; neededSeconds: number; clipSeconds: number }[] = [];
  for (const scene of plan.scenes) {
    const neededSeconds = scene.durationInFrames / plan.fps;
    for (const id of sceneMediaIds(scene)) {
      const media = spec.media.find((item) => item.id === id);
      if (media?.mediaType === "video" && media.durationSeconds !== null && media.durationSeconds < neededSeconds) {
        shortfalls.push({ mediaId: id, role: media.role, neededSeconds, clipSeconds: media.durationSeconds });
      }
    }
  }
  return shortfalls;
}

// --- what the shared loaders hand to both renderers ---------------------------------------------

export type ResolvedMedia =
  // A JPEG data URI: drawable by Satori and by Chrome without any file server.
  | { id: string; kind: "photo"; dataUri: string; width: number; height: number }
  // A short-lived URL to the owner's own clip. Only the reel draws video.
  | { id: string; kind: "video"; src: string; durationSeconds: number };

export type ResolvedMediaMap = Record<string, ResolvedMedia>;

export function resolvedMediaFor(media: ResolvedMediaMap, id: string): ResolvedMedia {
  const found = media[id];
  if (!found) throw new Error(`Media "${id}" was not prepared before rendering.`);
  return found;
}

// Fitted type sizes for every line of copy, measured once (copy-fit.ts) and used by BOTH renderers.
// Both canvases are 1080 wide with the same side padding, so one measurement serves both.
export type CampaignCopySizes = {
  headline: number;
  offerProductName: number;
  offerLine: number;
  endProductName: number;
  endOfferLine: number;
  cta: number;
};

// Everything a renderer needs, prepared once. The reel receives this object as its input props.
export type PreparedCampaign = {
  spec: CreativeSpec;
  media: ResolvedMediaMap;
  copy: CampaignCopySizes;
  notForPublishing: boolean;
};
