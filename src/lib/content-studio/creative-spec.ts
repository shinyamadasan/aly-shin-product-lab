import { z } from "zod";

import { MEDIA_ROLES } from "./creative-plan.ts";

// Content Studio Fast Mode -- the renderer-neutral creative input (CreativeSpec v1).
//
// ONE spec feeds both the Satori carousel and the Remotion reel. It carries only facts both outputs
// need: product identity, media references, brand tokens, the owner-confirmed offer, minimal copy and
// the two output shapes. It knows nothing about Supabase rows, React form state, Asset Jobs or test
// fixtures; the spec builder (fast-mode-request.ts) is what turns trusted rows into a spec.
//
// Neither renderer may invent a product fact. Every word either output draws comes from this spec via
// creative-plan.ts, so a missing value fails here instead of becoming a blank region in a frame.

// --- authenticity ---------------------------------------------------------------------------------
//
// Customer-facing food media must be owner-uploaded AND owner-attested as real Aly & Pon media.
//
// What the software knows, and no more:
//   - "owner_media" means the file is a row in the owner's Media Library (uploaded by an owner
//     account into the private product-media bucket). It does NOT prove the picture was taken with a
//     camera, is not AI-generated, is not stock, or is not heavily edited.
//   - Product Lab does not attempt to detect AI imagery. The V1 trust boundary is the owner's explicit
//     attestation, given for each generation (`mediaAttestedByOwner` below), that the selected photos
//     and videos are real pictures of their own food.
//   - Anything that is not owner_media (internal test fixtures, generated food, synthetic product
//     shots) may be rendered for internal review but can never pass the export gate below, attested
//     or not.
// Provenance is assigned by the server from the media's source authority, never taken from a browser
// request.
export const CUSTOMER_FACING_FOOD_MEDIA_MUST_BE_OWNER_ATTESTED = true;

export const MEDIA_PROVENANCES = ["owner_media", "test_fixture", "generated_food", "synthetic_product"] as const;
export type MediaProvenance = (typeof MEDIA_PROVENANCES)[number];
export const EXPORTABLE_MEDIA_PROVENANCE: MediaProvenance = "owner_media";

// Selling unit and CTA limits. The renderers still measure the real text (copy-fit.ts) and refuse
// copy that cannot fit; these only stop absurd input before any rendering work starts.
export const OFFER_UNIT_MAX_LENGTH = 24;
export const OFFER_CTA_MAX_LENGTH = 40;
export const HEADLINE_MAX_LENGTH = 40;
export const PRODUCT_NAME_MAX_LENGTH = 60;

// True when a peso amount has at most two decimal places, exactly as entered.
//
// `Math.round(x * 100) === x * 100` is wrong for IEEE-754 doubles (149.95 * 100 is 14994.999...).
// Instead: the two-decimal rendering, read back, must be the very same double. A real two-decimal
// entry always survives that round trip; 1.234 or 149.999 never does, and nothing is rounded into
// validity -- the owner's value is either accepted as is or refused.
export function hasAtMostTwoDecimals(amount: number): boolean {
  return Number.isFinite(amount) && Number(amount.toFixed(2)) === amount;
}

const CreativeMediaSchema = z
  .object({
    id: z.string().min(1),
    role: z.enum(MEDIA_ROLES),
    mediaType: z.enum(["photo", "video"]),
    // A reference, not bytes or a URL. "product_media" is a row in the owner's Media Library;
    // "fixture" is test-only material and is never exportable.
    source: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("product_media"), mediaId: z.string().min(1) }),
      z.object({ kind: z.literal("fixture"), name: z.string().min(1) }),
    ]),
    provenance: z.enum(MEDIA_PROVENANCES),
    // Clip length for video media; null for photos. A scene never plays past the end of real footage.
    durationSeconds: z.number().positive().nullable(),
  })
  .superRefine((media, ctx) => {
    if (media.mediaType === "video" && media.durationSeconds === null) {
      ctx.addIssue({ code: "custom", path: ["durationSeconds"], message: "a video needs its clip length." });
    }
    if (media.mediaType === "photo" && media.durationSeconds !== null) {
      ctx.addIssue({ code: "custom", path: ["durationSeconds"], message: "a photo has no clip length." });
    }
    // Owner provenance is only ever true of a Media Library source. A fixture cannot claim it.
    if (media.provenance === "owner_media" && media.source.kind !== "product_media") {
      ctx.addIssue({ code: "custom", path: ["provenance"], message: "only Media Library items can be owner media." });
    }
  });

const hexColor = z.string().regex(/^#[0-9A-Fa-f]{6}$/, { error: "expected a #RRGGBB colour." });
const px = z.number().positive();

const BrandTokensSchema = z.object({
  name: z.string().min(1),
  logo: z.object({ kind: z.literal("wordmark"), text: z.string().min(1) }),
  color: z.object({ background: hexColor, foreground: hexColor, accent: hexColor, muted: hexColor, surface: hexColor }),
  typography: z.object({
    // Geist is the only face embedded for both engines. Any other family would silently fall back in
    // one engine and not the other, so it is refused.
    fontFamily: z.literal("Geist", { error: 'typography.fontFamily: only "Geist" is embedded for both renderers.' }),
    weight: z.object({ regular: z.literal(400), bold: z.literal(700) }),
    heading: z.object({ xl: px, lg: px, md: px }),
    body: z.object({ lg: px, md: px, sm: px }),
    lineHeight: z.object({ tight: px, normal: px }),
    letterSpacing: z.object({ tight: z.number(), label: z.number() }),
  }),
  spacing: z.object({ xs: px, sm: px, md: px, lg: px, xl: px }),
  radius: z.object({ sm: px, md: px, lg: px }),
});

const nonBlank = (max: number) =>
  z
    .string()
    .max(max)
    .refine((value) => value.trim().length > 0 && value === value.trim(), { error: "must be filled in, without leading or trailing spaces." });

export const CreativeSpecSchema = z
  .object({
    specVersion: z.literal(1),
    product: z.object({ id: z.string().min(1), name: nonBlank(PRODUCT_NAME_MAX_LENGTH) }),
    media: z.array(CreativeMediaSchema).length(MEDIA_ROLES.length),
    // The owner's attestation, for THIS set of media, that it is real pictures of their own food --
    // not AI-generated, stock or heavily edited. Never defaulted: the spec builder copies exactly what
    // the request carried, and anything but `true` fails here.
    mediaAttestedByOwner: z.literal(true, { error: "the owner must confirm the photos and videos are real pictures of their own food." }),
    brand: BrandTokensSchema,
    // Exactly what the owner typed and confirmed. Nothing here is inferred from history.
    offer: z.object({
      price: z.object({
        // Centavos at most; a price is never rounded or reworded to fit a layout.
        amount: z
          .number()
          .positive()
          .max(1_000_000)
          .refine(hasAtMostTwoDecimals, { error: "use at most two decimal places." }),
        currency: z.literal("PHP"),
      }),
      unit: nonBlank(OFFER_UNIT_MAX_LENGTH),
      cta: nonBlank(OFFER_CTA_MAX_LENGTH),
      confirmedByOwner: z.literal(true, { error: "the owner must confirm the price, unit and message before generating." }),
    }),
    content: z.object({
      purpose: z.literal("product_offer"),
      // Restrained: null means the hero shows the product name.
      headline: nonBlank(HEADLINE_MAX_LENGTH).nullable(),
    }),
    output: z.object({
      carousel: z.object({ format: z.literal("png"), width: z.literal(1080), height: z.literal(1350), slideCount: z.literal(5) }),
      reel: z.object({
        composition: z.literal("editorial_collage"),
        codec: z.literal("h264"),
        width: z.literal(1080),
        height: z.literal(1920),
        fps: z.literal(30),
        durationSeconds: z.number().min(10).max(12),
      }),
    }),
  })
  .superRefine((spec, ctx) => {
    const ids = new Set<string>();
    for (const [index, item] of spec.media.entries()) {
      if (ids.has(item.id)) ctx.addIssue({ code: "custom", path: ["media", index, "id"], message: `duplicate media id "${item.id}".` });
      ids.add(item.id);
    }
    for (const role of MEDIA_ROLES) {
      if (spec.media.filter((item) => item.role === role).length !== 1) {
        ctx.addIssue({ code: "custom", path: ["media"], message: `needs exactly one "${role}" media item.` });
      }
    }
  });

export type CreativeSpec = z.infer<typeof CreativeSpecSchema>;
export type CreativeMedia = CreativeSpec["media"][number];
export type BrandTokens = CreativeSpec["brand"];
export type FastModeRenderFormat = "carousel" | "reel";

export const CREATIVE_OUTPUT_V1 = {
  carousel: { format: "png", width: 1080, height: 1350, slideCount: 5 },
  reel: { composition: "editorial_collage", codec: "h264", width: 1080, height: 1920, fps: 30, durationSeconds: 11 },
} as const satisfies CreativeSpec["output"];

export class InvalidCreativeSpecError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`Invalid CreativeSpec:\n${issues.map((issue) => `  - ${issue}`).join("\n")}`);
    this.name = "InvalidCreativeSpecError";
    this.issues = issues;
  }
}

// The one entry point both renderers call. Lists every problem by path, so a missing fact is named
// rather than discovered as a blank region in a rendered frame.
export function parseCreativeSpec(input: unknown): CreativeSpec {
  const result = CreativeSpecSchema.safeParse(input);
  if (!result.success) {
    throw new InvalidCreativeSpecError(
      result.error.issues.map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "(root)"}: ${issue.message}`),
    );
  }
  return result.data;
}

// A valid spec can still be wrong for one output: the carousel is five still photos.
export function assertSpecSupportsFormat(spec: CreativeSpec, format: FastModeRenderFormat): void {
  if (format === "carousel" && spec.media.some((item) => item.mediaType !== "photo")) {
    throw new InvalidCreativeSpecError(["media: a carousel uses five photos; videos are only used in a Reel."]);
  }
}

// True when anything in the spec is not the owner's real media. Renderers stamp a visible
// "not for publishing" label on such output; the export gate refuses it outright.
export function hasNonOwnerMedia(spec: CreativeSpec): boolean {
  return spec.media.some((item) => item.provenance !== EXPORTABLE_MEDIA_PROVENANCE || item.source.kind !== "product_media");
}

export class ExportBlockedError extends Error {
  readonly reason: "non_owner_media" | "media_not_attested";
  constructor(message: string, reason: ExportBlockedError["reason"] = "non_owner_media") {
    super(message);
    this.name = "ExportBlockedError";
    this.reason = reason;
  }
}

// THE production export gate for customer-facing food media. Every customer-facing output passes
// through it before bytes are produced for export. Two independent conditions, both fail closed:
//   1. every item is owner_media from the Media Library -- test fixtures, generated food and synthetic
//      product media are refused even when attested;
//   2. the owner attested this media set as real pictures of their own food. parseCreativeSpec already
//      requires it; it is checked again here so the gate never depends on how the spec was built.
// This gate does not, and cannot, tell a camera photo from an AI image; the attestation is the trust
// boundary. Offer completeness is enforced by parseCreativeSpec (confirmedByOwner, unit, CTA and
// price are required), so a parsed spec plus this gate is an exportable spec.
export function assertExportableSpec(spec: CreativeSpec): void {
  if (!CUSTOMER_FACING_FOOD_MEDIA_MUST_BE_OWNER_ATTESTED) return;
  const blocked = spec.media.filter((item) => item.provenance !== EXPORTABLE_MEDIA_PROVENANCE || item.source.kind !== "product_media");
  if (blocked.length > 0) {
    throw new ExportBlockedError(
      `Only your own photos and videos can be exported. Not allowed: ${blocked.map((item) => `${item.id} (${item.provenance})`).join(", ")}.`,
    );
  }
  if ((spec.mediaAttestedByOwner as unknown) !== true) {
    throw new ExportBlockedError("Confirm these photos and videos are real pictures of your own food before exporting.", "media_not_attested");
  }
}
