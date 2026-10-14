import { CopyDoesNotFitError } from "../production-copy-fit.ts";
import { MediaUnreadableError, prepareCampaign } from "./campaign-media.ts";
import { renderCarouselSlide } from "./carousel-renderer.ts";
import { copyDoesNotFitMessage } from "./copy-fit.ts";
import { planCarousel, type PreparedCampaign } from "./creative-plan.ts";
import { ExportBlockedError, assertExportableSpec, assertSpecSupportsFormat, type CreativeFormat, type CreativeSpec } from "./creative-spec.ts";
import { readPngDimensions } from "./export-output.ts";
import { FastModeRequestError, buildFastModeSpec, parseFastModeRequest } from "./fast-mode-request.ts";
import { loadFastModeSources, productMediaReader, type FastModeSourceClient } from "./fast-mode-sources.ts";
import type { ReelHostResult } from "./reel-host.ts";

// Content Studio Fast Mode -- what the two owner routes do, with every dependency injected so the
// whole path (request -> trusted rows -> spec -> export gate -> render -> output gate) is testable
// without HTTP. The routes only authenticate and translate the result to a Response.
//
// THE EXPORT GATE RUNS BEFORE RENDERING. Production never renders non-owner media at all: there is no
// "render now, check later" path whose output could leak.

export type FastModeFailure = { ok: false; status: number; message: string };

function failure(error: unknown): FastModeFailure {
  if (error instanceof FastModeRequestError) return { ok: false, status: error.status, message: error.message };
  if (error instanceof ExportBlockedError) return { ok: false, status: 422, message: error.message };
  if (error instanceof CopyDoesNotFitError) return { ok: false, status: 422, message: copyDoesNotFitMessage(error.field) };
  if (error instanceof MediaUnreadableError) return { ok: false, status: 422, message: "One of the picked photos or videos could not be read. Pick it again or add a new copy in Media." };
  return { ok: false, status: 500, message: "This could not be made just now. Try again." };
}

async function buildExportableSpec(client: FastModeSourceClient, body: unknown, format: CreativeFormat) {
  const request = parseFastModeRequest(body);
  if (request.format !== format) throw new FastModeRequestError(400, "That request could not be read. Reload and try again.");
  const sources = await loadFastModeSources(client, request);
  const spec: CreativeSpec = buildFastModeSpec({ request, product: sources.product, mediaRows: sources.mediaRows });
  assertSpecSupportsFormat(spec, format);
  assertExportableSpec(spec);
  return { spec, reader: productMediaReader(client, sources.mediaRows) };
}

export async function generateCarouselSlide(
  client: FastModeSourceClient,
  body: unknown,
): Promise<{ ok: true; png: Uint8Array; fileName: string } | FastModeFailure> {
  try {
    const slideIndex = (body as { slide?: unknown } | null)?.slide;
    if (typeof slideIndex !== "number" || !Number.isInteger(slideIndex) || slideIndex < 1 || slideIndex > 5) {
      throw new FastModeRequestError(400, "That request could not be read. Reload and try again.");
    }
    const { spec, reader } = await buildExportableSpec(client, body, "carousel");
    // Each slide is its own request: one photo is read, and one PNG travels back.
    const slide = planCarousel(spec)[slideIndex - 1];
    const campaign = await prepareCampaign(spec, reader, [slide.mediaId]);
    const rendered = await renderCarouselSlide(campaign, slideIndex);

    // Output gate: a real PNG at the spec's exact size, or nothing.
    const size = readPngDimensions(rendered.png);
    if (!size || size.width !== spec.output.carousel.width || size.height !== spec.output.carousel.height) {
      return { ok: false, status: 502, message: "A slide did not come out right. Try again." };
    }
    return { ok: true, png: new Uint8Array(rendered.png), fileName: rendered.fileName };
  } catch (error) {
    return failure(error);
  }
}

export async function generateReel(
  client: FastModeSourceClient,
  body: unknown,
  host: { available: () => boolean; render: (campaign: PreparedCampaign) => Promise<ReelHostResult> },
): Promise<{ ok: true; mp4: Uint8Array } | FastModeFailure> {
  try {
    if (!host.available()) {
      return { ok: false, status: 503, message: "Reels can only be made on the studio computer right now. You can make a carousel here." };
    }
    const { spec, reader } = await buildExportableSpec(client, body, "reel");
    const campaign = await prepareCampaign(spec, reader);
    const result = await host.render(campaign);
    if (!result.ok) {
      if (result.reason === "busy") return { ok: false, status: 409, message: "Another Reel is being made. Try again in a minute." };
      return { ok: false, status: 502, message: "The Reel did not come out right, so it was not kept. Try again or pick different media." };
    }
    return { ok: true, mp4: result.mp4 };
  } catch (error) {
    return failure(error);
  }
}
