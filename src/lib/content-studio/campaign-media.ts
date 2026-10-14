import sharp from "sharp";

import { fitCampaignCopy } from "./copy-fit.ts";
import type { PreparedCampaign, ResolvedMediaMap } from "./creative-plan.ts";
import { hasNonOwnerMedia, type CreativeMedia, type CreativeSpec } from "./creative-spec.ts";

// Content Studio Fast Mode -- the ONE media loader both renderers use. NODE ONLY.
//
// Photos are read once, turned upright from their camera orientation, capped in size and re-encoded
// as a JPEG data URI, so the carousel and the reel receive byte-identical images with identical
// framing and the reel render needs no file server. Videos are handed on as a short-lived URL to the
// owner's own clip.
//
// It only orients, downsizes and flattens. It never generates, retouches or "enhances" a pixel.

// Long-edge cap: keeps the reel's input props small without visibly softening a 1080-wide frame.
const MAX_LONG_EDGE = 1920;
const JPEG_QUALITY = 90;

// Where the bytes come from is the caller's business (the owner's Media Library in production, local
// files in tests); this module only ever receives them.
export type MediaSourceReader = {
  readPhoto(media: CreativeMedia): Promise<Uint8Array>;
  videoUrl(media: CreativeMedia): Promise<string>;
};

export class MediaUnreadableError extends Error {
  readonly mediaId: string;
  constructor(mediaId: string, message: string) {
    super(message);
    this.name = "MediaUnreadableError";
    this.mediaId = mediaId;
  }
}

export async function preparePhoto(bytes: Uint8Array, background: string): Promise<{ dataUri: string; width: number; height: number }> {
  const { data, info } = await sharp(bytes)
    // Phone photos carry their orientation as EXIF; apply it so the food is the right way up.
    .rotate()
    .resize({ width: MAX_LONG_EDGE, height: MAX_LONG_EDGE, fit: "inside", withoutEnlargement: true })
    // JPEG has no alpha; any transparent pixel lands on the brand background, not on black.
    .flatten({ background })
    .jpeg({ quality: JPEG_QUALITY })
    .toBuffer({ resolveWithObject: true });
  return { dataUri: `data:image/jpeg;base64,${data.toString("base64")}`, width: info.width, height: info.height };
}

export async function resolveCampaignMedia(spec: CreativeSpec, reader: MediaSourceReader, onlyIds?: string[]): Promise<ResolvedMediaMap> {
  const resolved: ResolvedMediaMap = {};
  for (const item of spec.media) {
    if (onlyIds && !onlyIds.includes(item.id)) continue;
    try {
      if (item.mediaType === "photo") {
        resolved[item.id] = { id: item.id, kind: "photo", ...(await preparePhoto(await reader.readPhoto(item), spec.brand.color.background)) };
      } else {
        resolved[item.id] = { id: item.id, kind: "video", src: await reader.videoUrl(item), durationSeconds: item.durationSeconds! };
      }
    } catch (error) {
      if (error instanceof MediaUnreadableError) throw error;
      throw new MediaUnreadableError(item.id, `Media "${item.id}" could not be read as a ${item.mediaType}.`);
    }
  }
  return resolved;
}

// Everything a renderer needs, prepared once: the spec, its media, the fitted copy sizes, and whether
// the output must carry the visible not-for-publishing label.
export async function prepareCampaign(spec: CreativeSpec, reader: MediaSourceReader, onlyIds?: string[]): Promise<PreparedCampaign> {
  const copy = await fitCampaignCopy(spec);
  const media = await resolveCampaignMedia(spec, reader, onlyIds);
  return { spec, media, copy, notForPublishing: hasNonOwnerMedia(spec) };
}
