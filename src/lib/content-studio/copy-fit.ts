import { CopyDoesNotFitError, measureTextBlockHeight, measureTextBlockRightEdge, type FittableFont } from "../production-copy-fit.ts";
import { EMBEDDED_PRODUCTION_FONTS } from "../production-fonts.ts";
import { formatOfferLine, heroHeadline, type CampaignCopySizes } from "./creative-plan.ts";
import type { CreativeSpec } from "./creative-spec.ts";
import { copyBoxes, type CopyBoxes } from "./layout.ts";

// Content Studio Fast Mode -- fits every line of copy ONCE, for both renderers. NODE ONLY.
//
// Reuses the production copy-fit authority (production-copy-fit.ts): Satori lays the real string out
// with the real embedded faces and resvg reads the height back. A line that cannot fit at its smallest
// readable size is refused with CopyDoesNotFitError -- never shrunk further, never truncated.
// Width is checked as well as height: a single word longer than its box cannot wrap and would run off
// the side of the slide while still "fitting" by height.

export function brandFittableFonts(spec: CreativeSpec): FittableFont[] {
  return EMBEDDED_PRODUCTION_FONTS.map((face) => {
    const buffer = Buffer.from(face.base64, "base64");
    return {
      name: spec.brand.typography.fontFamily,
      data: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer,
      weight: face.weight,
      style: "normal" as const,
    };
  });
}

export async function fitCampaignCopy(spec: CreativeSpec, fonts: FittableFont[] = brandFittableFonts(spec)): Promise<CampaignCopySizes> {
  const boxes = copyBoxes(spec.brand, spec.output.carousel.width);
  const offerLine = formatOfferLine(spec.offer);
  const texts: Record<keyof CopyBoxes, string> = {
    headline: heroHeadline(spec),
    offerProductName: spec.product.name,
    offerLine,
    endProductName: spec.product.name,
    endOfferLine: offerLine,
    cta: spec.offer.cta,
  };

  const sizes = {} as CampaignCopySizes;
  for (const field of Object.keys(boxes) as (keyof CopyBoxes)[]) {
    const box = boxes[field];
    const measured = { text: texts[field], ...box };
    let lastHeight = 0;
    for (const fontSize of [...box.candidateSizes].sort((x, y) => y - x)) {
      lastHeight = await measureTextBlockHeight(measured, fontSize, fonts);
      if (lastHeight <= box.maxHeight && (await measureTextBlockRightEdge(measured, fontSize, fonts)) <= box.maxWidth + 0.5) {
        sizes[field] = fontSize;
        break;
      }
    }
    if (sizes[field] === undefined) {
      throw new CopyDoesNotFitError(field, Math.min(...box.candidateSizes), lastHeight, box.maxHeight);
    }
  }
  return sizes;
}

// What the owner can actually change when a line does not fit.
export function copyDoesNotFitMessage(field: string): string {
  switch (field) {
    case "headline":
    case "offerProductName":
    case "endProductName":
      return "The product name is too long to fit on the slides.";
    case "offerLine":
    case "endOfferLine":
      return "The price and selling unit are too long to fit. Shorten the selling unit.";
    case "cta":
      return "The call to action is too long to fit. Shorten it.";
    default:
      return "Some of the words are too long to fit. Shorten the offer and try again.";
  }
}
