import { z } from "zod";

import { ALY_PON_BRAND_TOKENS } from "./brand-tokens.ts";
import { MEDIA_ROLE_LABELS, MEDIA_ROLES, reelClipShortfalls } from "./creative-plan.ts";
import {
  CREATIVE_OUTPUT_V1,
  InvalidCreativeSpecError,
  OFFER_CTA_MAX_LENGTH,
  OFFER_UNIT_MAX_LENGTH,
  parseCreativeSpec,
  type CreativeSpec,
} from "./creative-spec.ts";

// Content Studio Fast Mode -- from a browser request to a CreativeSpec, trusting nothing the browser
// says about the product or the media.
//
// The browser names a product id, five media ids and the owner's typed offer. The product NAME, each
// media item's type, product, clip length and PROVENANCE come from rows the server reads under the
// owner's own RLS. A Media Library row is the owner's upload, so it -- and only it -- becomes
// "owner_media". There is no field in the request through which provenance could be claimed.

export const FastModeRequestSchema = z.object({
  format: z.enum(["carousel", "reel"]),
  productId: z.string().min(1).max(200),
  // In role order: hero, detail, context, offer, closing.
  mediaIds: z.array(z.string().min(1).max(200)).length(MEDIA_ROLES.length),
  offer: z.object({
    priceAmount: z.number(),
    unit: z.string().max(200),
    cta: z.string().max(200),
    confirmed: z.boolean(),
  }),
});

export type FastModeRequest = z.infer<typeof FastModeRequestSchema>;

// Thrown with words the owner can act on; the routes return `message` as is.
export class FastModeRequestError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "FastModeRequestError";
    this.status = status;
  }
}

export function parseFastModeRequest(body: unknown): FastModeRequest {
  const result = FastModeRequestSchema.safeParse(body);
  if (!result.success) throw new FastModeRequestError(400, "That request could not be read. Reload and try again.");
  return result.data;
}

// The owner-side checks the form also runs, so a message names the field to fix before any upload.
export function offerProblems(offer: FastModeRequest["offer"]): string[] {
  const problems: string[] = [];
  if (!Number.isFinite(offer.priceAmount) || offer.priceAmount <= 0) problems.push("Enter the price.");
  else if (Math.round(offer.priceAmount * 100) !== offer.priceAmount * 100) problems.push("Use at most two decimal places for the price.");
  if (offer.unit.trim().length === 0) problems.push("Enter the selling unit, for example 2 pcs.");
  else if (offer.unit.trim().length > OFFER_UNIT_MAX_LENGTH) problems.push(`Keep the selling unit to ${OFFER_UNIT_MAX_LENGTH} characters.`);
  if (offer.cta.trim().length === 0) problems.push("Enter the call to action, for example Message us to order.");
  else if (offer.cta.trim().length > OFFER_CTA_MAX_LENGTH) problems.push(`Keep the call to action to ${OFFER_CTA_MAX_LENGTH} characters.`);
  if (!offer.confirmed) problems.push("Confirm the price, unit and call to action are current.");
  return problems;
}

export type TrustedProduct = { id: string; name: string };

// The columns of a product_media row this step depends on.
export type TrustedMediaRow = {
  id: string;
  product_id: string | null;
  media_type: "photo" | "video";
  duration_ms: number | null;
};

export function buildFastModeSpec(args: {
  request: FastModeRequest;
  product: TrustedProduct | null;
  mediaRows: TrustedMediaRow[];
}): CreativeSpec {
  const { request, product } = args;
  const problems = offerProblems(request.offer);
  if (problems.length > 0) throw new FastModeRequestError(400, problems.join(" "));
  if (!product) throw new FastModeRequestError(404, "That product could not be found. Reload and pick it again.");

  if (new Set(request.mediaIds).size !== request.mediaIds.length) {
    throw new FastModeRequestError(400, "Pick five different photos or videos.");
  }

  const rows = new Map(args.mediaRows.map((row) => [row.id, row]));
  const media = request.mediaIds.map((id, index) => {
    const role = MEDIA_ROLES[index];
    const row = rows.get(id);
    if (!row) throw new FastModeRequestError(404, `The ${MEDIA_ROLE_LABELS[role].toLowerCase()} is no longer in Media. Pick it again.`);
    // A different product's food in this product's post would misrepresent it.
    if (row.product_id !== product.id) {
      throw new FastModeRequestError(400, `The ${MEDIA_ROLE_LABELS[role].toLowerCase()} is not assigned to ${product.name}. Assign it in Media first.`);
    }
    if (request.format === "carousel" && row.media_type !== "photo") {
      throw new FastModeRequestError(400, "A carousel uses five photos. Videos can be used in a Reel.");
    }
    if (row.media_type === "video" && (row.duration_ms === null || row.duration_ms <= 0)) {
      throw new FastModeRequestError(400, `The ${MEDIA_ROLE_LABELS[role].toLowerCase()} video has no readable length. Add a new copy in Media.`);
    }
    return {
      id: row.id,
      role,
      mediaType: row.media_type,
      source: { kind: "product_media" as const, mediaId: row.id },
      provenance: "owner_media" as const,
      durationSeconds: row.media_type === "video" ? row.duration_ms! / 1000 : null,
    };
  });

  let spec: CreativeSpec;
  try {
    spec = parseCreativeSpec({
      specVersion: 1,
      product: { id: product.id, name: product.name.trim() },
      media,
      brand: ALY_PON_BRAND_TOKENS,
      offer: {
        price: { amount: request.offer.priceAmount, currency: "PHP" },
        unit: request.offer.unit.trim(),
        cta: request.offer.cta.trim(),
        confirmedByOwner: request.offer.confirmed,
      },
      content: { purpose: "product_offer", headline: null },
      output: CREATIVE_OUTPUT_V1,
    });
  } catch (error) {
    if (error instanceof InvalidCreativeSpecError) {
      throw new FastModeRequestError(400, error.issues.some((issue) => issue.startsWith("product.name"))
        ? "This product's name is too long for a post. Shorten it in Products."
        : "Some details could not be used. Check the offer and try again.");
    }
    throw error;
  }

  if (request.format === "reel") {
    const short = reelClipShortfalls(spec)[0];
    if (short) {
      throw new FastModeRequestError(
        400,
        `The ${MEDIA_ROLE_LABELS[short.role].toLowerCase()} clip is ${short.clipSeconds.toFixed(1)}s; that part of the Reel needs ${short.neededSeconds.toFixed(1)}s. Pick a longer clip or a photo.`,
      );
    }
  }
  return spec;
}
