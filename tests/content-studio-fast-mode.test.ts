import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { isValidElement, type ReactNode } from "react";
import sharp from "sharp";

import { ALY_PON_BRAND_TOKENS } from "../src/lib/content-studio/brand-tokens.ts";
import { prepareCampaign, type MediaSourceReader } from "../src/lib/content-studio/campaign-media.ts";
import { buildCarouselSlideElement, renderCarousel, renderCarouselSlide } from "../src/lib/content-studio/carousel-renderer.ts";
import { fitCampaignCopy } from "../src/lib/content-studio/copy-fit.ts";
import {
  CAROUSEL_FILE_NAMES,
  NOT_FOR_PUBLISHING_LABEL,
  formatOfferLine,
  formatPesoAmount,
  planCarousel,
  planEditorialCollageReel,
  reelClipShortfalls,
  type PreparedCampaign,
} from "../src/lib/content-studio/creative-plan.ts";
import {
  CREATIVE_OUTPUT_V1,
  CUSTOMER_FACING_FOOD_MEDIA_MUST_BE_OWNER_ATTESTED,
  ExportBlockedError,
  InvalidCreativeSpecError,
  assertExportableSpec,
  assertSpecSupportsFormat,
  hasAtMostTwoDecimals,
  hasNonOwnerMedia,
  parseCreativeSpec,
  type CreativeMedia,
  type CreativeSpec,
} from "../src/lib/content-studio/creative-spec.ts";
import { createStoredZip, readPngDimensions, readStoredZip, validateCarouselExport } from "../src/lib/content-studio/export-output.ts";
import {
  FastModeRequestError,
  MEDIA_ATTESTATION_PROBLEM,
  buildFastModeSpec,
  offerProblems,
  parseFastModeRequest,
  type TrustedMediaRow,
} from "../src/lib/content-studio/fast-mode-request.ts";
import { EMBEDDED_PRODUCTION_FONTS } from "../src/lib/production-fonts.ts";

// Content Studio Fast Mode -- one production spec, two renderers, one brand token and font authority,
// and an export gate that only owner-uploaded, owner-attested media can pass.
//
// The images here are SYNTHETIC test patterns made in-process by sharp. They stand in for owner photos
// where a test needs pixels; none of them is food, and none is shipped.

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..");
const ROLE_COLOURS = ["#7a4a2a", "#c08850", "#5d6b3a", "#a33f2a", "#3b4f6b"];

function ownerMedia(index: number, overrides: Partial<CreativeMedia> = {}): CreativeMedia {
  const roles = ["hero", "detail", "context", "offer", "supporting"] as const;
  return {
    id: `media-${index + 1}`,
    role: roles[index],
    mediaType: "photo",
    source: { kind: "product_media", mediaId: `media-${index + 1}` },
    provenance: "owner_media",
    durationSeconds: null,
    ...overrides,
  };
}

function ownerSpec(overrides: { unit?: string; cta?: string; amount?: number; name?: string } = {}): CreativeSpec {
  return parseCreativeSpec({
    specVersion: 1,
    product: { id: "revel-bars", name: overrides.name ?? "Revel Bars" },
    media: [0, 1, 2, 3, 4].map((i) => ownerMedia(i)),
    mediaAttestedByOwner: true,
    brand: ALY_PON_BRAND_TOKENS,
    offer: { price: { amount: overrides.amount ?? 160, currency: "PHP" }, unit: overrides.unit ?? "2 pcs", cta: overrides.cta ?? "Message us to order", confirmedByOwner: true },
    content: { purpose: "product_offer", headline: null },
    output: CREATIVE_OUTPUT_V1,
  });
}

// Loosely typed copy of a spec, for tests that break it on purpose.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Mutable = Record<string, any>;

function issuesFor(input: unknown): string[] {
  try {
    parseCreativeSpec(input);
  } catch (error) {
    assert.ok(error instanceof InvalidCreativeSpecError);
    return error.issues;
  }
  assert.fail("expected the spec to be rejected");
}

// A synthetic, non-food test pattern per media id (distinct colour + a diagonal so cropping is visible).
const patternCache = new Map<string, Promise<Uint8Array>>();
function pattern(id: string, width = 1200, height = 1500): Promise<Uint8Array> {
  const key = `${id}:${width}x${height}`;
  if (!patternCache.has(key)) {
    const colour = ROLE_COLOURS[(Number(id.replace(/\D/g, "")) - 1) % ROLE_COLOURS.length] ?? "#777777";
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="${colour}"/><path d="M0 0 L${width} ${height}" stroke="#ffffff" stroke-width="40"/></svg>`;
    patternCache.set(key, sharp(Buffer.from(svg)).jpeg().toBuffer().then((buffer) => new Uint8Array(buffer)));
  }
  return patternCache.get(key)!;
}

const syntheticReader: MediaSourceReader = {
  readPhoto: (media) => pattern(media.id),
  videoUrl: async (media) => `https://example.test/${media.id}.mp4`,
};

function textOf(node: ReactNode): string[] {
  if (typeof node === "string" || typeof node === "number") return [String(node)];
  if (Array.isArray(node)) return node.flatMap(textOf);
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return [];
}

const campaignPromise = prepareCampaign(ownerSpec(), syntheticReader);

// --- shared spec -------------------------------------------------------------------------------------

test("an owner spec parses, and the offer line is the confirmed price and unit verbatim", () => {
  const spec = ownerSpec();
  assert.deepEqual(spec.offer, { price: { amount: 160, currency: "PHP" }, unit: "2 pcs", cta: "Message us to order", confirmedByOwner: true });
  assert.equal(formatOfferLine(spec.offer), "₱160 / 2 pcs");
  assert.equal(formatPesoAmount(1250), "₱1,250");
  assert.equal(formatPesoAmount(99.5), "₱99.50");
  assert.equal(formatPesoAmount(1234567.05), "₱1,234,567.05");
});

test("invalid or incomplete specs fail clearly, naming the field", () => {
  const base = () => structuredClone(ownerSpec()) as unknown as Mutable;

  const unconfirmed = base();
  unconfirmed.offer.confirmedByOwner = false;
  assert.ok(issuesFor(unconfirmed).some((issue) => issue.startsWith("offer.confirmedByOwner:")));

  const noCta = base();
  delete noCta.offer.cta;
  assert.ok(issuesFor(noCta).some((issue) => issue.startsWith("offer.cta:")));

  const blankUnit = base();
  blankUnit.offer.unit = "   ";
  assert.ok(issuesFor(blankUnit).some((issue) => issue.startsWith("offer.unit:")));

  const zeroPrice = base();
  zeroPrice.offer.price.amount = 0;
  assert.ok(issuesFor(zeroPrice).some((issue) => issue.startsWith("offer.price.amount:")));

  const fractionalCentavo = base();
  fractionalCentavo.offer.price.amount = 160.005;
  assert.ok(issuesFor(fractionalCentavo).some((issue) => issue.startsWith("offer.price.amount:")));

  const fourMedia = base();
  fourMedia.media = fourMedia.media.slice(0, 4);
  assert.ok(issuesFor(fourMedia).some((issue) => issue.startsWith("media:")));

  const twoHeroes = base();
  twoHeroes.media[1].role = "hero";
  assert.ok(issuesFor(twoHeroes).some((issue) => issue.includes('exactly one "detail"')));

  const otherFont = base();
  otherFont.brand.typography.fontFamily = "Inter";
  assert.ok(issuesFor(otherFont).some((issue) => issue.includes('only "Geist" is embedded')));

  const videoWithoutLength = base();
  videoWithoutLength.media[0].mediaType = "video";
  assert.ok(issuesFor(videoWithoutLength).some((issue) => issue.startsWith("media.0.durationSeconds:")));

  const shortReel = base();
  shortReel.output.reel.durationSeconds = 8;
  assert.ok(issuesFor(shortReel).some((issue) => issue.startsWith("output.reel.durationSeconds:")));
});

test("both engines consume the same spec: the reel plan carries the carousel's media, offer and CTA", () => {
  const spec = ownerSpec();
  const slides = planCarousel(spec);
  const reel = planEditorialCollageReel(spec);
  const slide = (kind: string) => slides.find((s) => s.kind === kind) as Record<string, unknown>;
  const scene = (kind: string) => reel.scenes.find((s) => s.kind === kind) as Record<string, unknown>;

  assert.equal(scene("hero").mediaId, slide("hero").mediaId);
  assert.equal(scene("collage").detailMediaId, slide("detail").mediaId);
  assert.equal(scene("collage").contextMediaId, slide("context").mediaId);
  assert.equal(scene("offer").mediaId, slide("offer").mediaId);
  assert.equal(scene("end_card").mediaId, slide("cta").mediaId);
  for (const key of ["productName", "offerLine"]) assert.equal(scene("offer")[key], slide("offer")[key]);
  for (const key of ["wordmark", "productName", "offerLine", "cta"]) assert.equal(scene("end_card")[key], slide("cta")[key]);
  assert.equal(scene("end_card").offerLine, "₱160 / 2 pcs");
  assert.equal(scene("end_card").cta, "Message us to order");

  // 11s at 30fps, scenes tile the timeline with no gap or overlap.
  assert.deepEqual([reel.width, reel.height, reel.fps, reel.durationInFrames], [1080, 1920, 30, 330]);
  let cursor = 0;
  for (const s of reel.scenes) {
    assert.equal(s.from, cursor);
    cursor += s.durationInFrames;
  }
  assert.equal(cursor, reel.durationInFrames);
});

test("the carousel refuses video media; the reel refuses a clip shorter than its scene", () => {
  const spec = structuredClone(ownerSpec());
  spec.media[0] = { ...spec.media[0], mediaType: "video", durationSeconds: 2 };
  const parsed = parseCreativeSpec(spec);
  assert.throws(() => assertSpecSupportsFormat(parsed, "carousel"), /five photos/);
  assert.doesNotThrow(() => assertSpecSupportsFormat(parsed, "reel"));
  assert.deepEqual(reelClipShortfalls(parsed), [{ mediaId: "media-1", role: "hero", neededSeconds: 3, clipSeconds: 2 }]);

  parsed.media[0].durationSeconds = 4;
  assert.deepEqual(reelClipShortfalls(parsed), []);
});

// --- authenticity ------------------------------------------------------------------------------------

test("CUSTOMER_FACING_FOOD_MEDIA_MUST_BE_OWNER_ATTESTED: attested owner media exports; fixtures, generated and synthetic media cannot, even attested", () => {
  assert.equal(CUSTOMER_FACING_FOOD_MEDIA_MUST_BE_OWNER_ATTESTED, true);
  const owner = ownerSpec();
  assert.equal(owner.mediaAttestedByOwner, true);
  assert.equal(hasNonOwnerMedia(owner), false);
  assert.doesNotThrow(() => assertExportableSpec(owner));

  for (const provenance of ["test_fixture", "generated_food", "synthetic_product"] as const) {
    const spec = structuredClone(owner);
    spec.media[2] = { ...spec.media[2], source: { kind: "fixture", name: "pattern" }, provenance };
    const parsed = parseCreativeSpec(spec);
    // Attested, and still refused: an attestation never turns a fixture or generated image into owner media.
    assert.equal(parsed.mediaAttestedByOwner, true);
    assert.equal(hasNonOwnerMedia(parsed), true);
    assert.throws(() => assertExportableSpec(parsed), (error: unknown) => error instanceof ExportBlockedError && error.message.includes(provenance));
  }

  // A fixture cannot be relabelled as owner media.
  const relabelled = structuredClone(owner) as unknown as Mutable;
  relabelled.media[0].source = { kind: "fixture", name: "pattern" };
  assert.ok(issuesFor(relabelled).some((issue) => issue.startsWith("media.0.provenance:")));
});

test("the spec requires the owner's media attestation as literal true, and the export gate re-checks it", () => {
  for (const value of [false, undefined, "true", 1, null]) {
    const spec = structuredClone(ownerSpec()) as unknown as Mutable;
    if (value === undefined) delete spec.mediaAttestedByOwner;
    else spec.mediaAttestedByOwner = value;
    assert.ok(issuesFor(spec).some((issue) => issue.startsWith("mediaAttestedByOwner:")), `mediaAttestedByOwner=${String(value)} must be refused`);
  }
  // A spec that skipped parsing still cannot pass the gate unattested.
  const unparsed = { ...ownerSpec(), mediaAttestedByOwner: false } as unknown as CreativeSpec;
  assert.throws(() => assertExportableSpec(unparsed), (error: unknown) => error instanceof ExportBlockedError && error.reason === "media_not_attested");
});

test("the request must carry mediaAttested: missing or false is refused before anything is read; the server never defaults it", () => {
  const base = {
    format: "carousel",
    productId: "revel-bars",
    mediaIds: ["m1", "m2", "m3", "m4", "m5"],
    offer: { priceAmount: 160, unit: "2 pcs", cta: "Message us to order", confirmed: true },
  };
  const rows: TrustedMediaRow[] = base.mediaIds.map((id) => ({ id, product_id: "revel-bars", media_type: "photo", duration_ms: null }));
  const product = { id: "revel-bars", name: "Revel Bars" };

  // Missing, or not a boolean: the request does not parse.
  for (const crafted of [base, { ...base, mediaAttested: "true" }, { ...base, mediaAttested: 1 }, { ...base, mediaAttested: null }]) {
    assert.throws(() => parseFastModeRequest(crafted), (error: unknown) => error instanceof FastModeRequestError && error.status === 400);
  }
  // False: refused with the owner-facing words, before any spec exists.
  assert.throws(
    () => buildFastModeSpec({ request: parseFastModeRequest({ ...base, mediaAttested: false }), product, mediaRows: rows }),
    (error: unknown) => error instanceof FastModeRequestError && error.status === 400 && error.message.includes(MEDIA_ATTESTATION_PROBLEM),
  );
  // A browser cannot attest through the spec's own field name instead.
  assert.throws(() => parseFastModeRequest({ ...base, mediaAttestedByOwner: true }), FastModeRequestError);
  // True, with everything else in order: accepted, copied into the spec, exportable.
  const spec = buildFastModeSpec({ request: parseFastModeRequest({ ...base, mediaAttested: true }), product, mediaRows: rows });
  assert.equal(spec.mediaAttestedByOwner, true);
  assert.doesNotThrow(() => assertExportableSpec(spec));
});

test("centavo prices: request and spec accept the same two-decimal amounts and refuse the same others, without rounding", () => {
  const specWith = (amount: number) => {
    const spec = structuredClone(ownerSpec()) as unknown as Mutable;
    spec.offer.price.amount = amount;
    return spec;
  };
  const requestProblems = (amount: number) => offerProblems({ priceAmount: amount, unit: "2 pcs", cta: "Message us", confirmed: true });

  for (const amount of [149.95, 160.55, 4.35, 1.1, 160, 170, 0.07, 999.99]) {
    assert.equal(hasAtMostTwoDecimals(amount), true, `${amount}`);
    assert.deepEqual(requestProblems(amount), [], `request must accept ${amount}`);
    assert.equal(parseCreativeSpec(specWith(amount)).offer.price.amount, amount, `spec must accept ${amount} unchanged`);
  }
  for (const amount of [1.234, 149.999, 160.001]) {
    assert.equal(hasAtMostTwoDecimals(amount), false, `${amount}`);
    assert.deepEqual(requestProblems(amount), ["Use at most two decimal places for the price."], `request must refuse ${amount}`);
    assert.ok(issuesFor(specWith(amount)).some((issue) => issue.startsWith("offer.price.amount:")), `spec must refuse ${amount}`);
  }
  for (const amount of [0, -5, -149.95, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.deepEqual(requestProblems(amount), ["Enter the price."], `request must refuse ${amount}`);
    assert.ok(issuesFor(specWith(amount)).some((issue) => issue.startsWith("offer.price.amount:")), `spec must refuse ${amount}`);
  }
});

test("the server builds the spec from trusted rows: provenance, product and media type never come from the browser", () => {
  const request = parseFastModeRequest({
    format: "carousel",
    productId: "revel-bars",
    mediaIds: ["m1", "m2", "m3", "m4", "m5"],
    offer: { priceAmount: 160, unit: " 2 pcs ", cta: "Message us to order", confirmed: true },
    mediaAttested: true,
  });
  const rows: TrustedMediaRow[] = ["m1", "m2", "m3", "m4", "m5"].map((id) => ({ id, product_id: "revel-bars", media_type: "photo", duration_ms: null }));
  const spec = buildFastModeSpec({ request, product: { id: "revel-bars", name: "Revel Bars" }, mediaRows: rows });
  assert.ok(spec.media.every((item) => item.provenance === "owner_media" && item.source.kind === "product_media"));
  assert.equal(spec.offer.unit, "2 pcs");
  assert.doesNotThrow(() => assertExportableSpec(spec));

  // A smuggled provenance field is simply not part of the request contract.
  const smuggled = parseFastModeRequest({ ...request, provenance: "owner_media", media: [{ provenance: "owner_media" }] });
  assert.equal("provenance" in smuggled, false);

  const fails = (patch: Partial<Parameters<typeof buildFastModeSpec>[0]>, pattern: RegExp) =>
    assert.throws(
      () => buildFastModeSpec({ request, product: { id: "revel-bars", name: "Revel Bars" }, mediaRows: rows, ...patch }),
      (error: unknown) => error instanceof FastModeRequestError && pattern.test(error.message),
    );

  fails({ product: null }, /could not be found/);
  fails({ mediaRows: rows.slice(0, 4) }, /closing photo is no longer in Media/);
  fails({ mediaRows: rows.map((row, i) => (i === 1 ? { ...row, product_id: "brownies" } : row)) }, /close-up is not assigned to Revel Bars/);
  fails({ mediaRows: rows.map((row, i) => (i === 2 ? { ...row, product_id: null } : row)) }, /not assigned to Revel Bars/);
  fails({ mediaRows: rows.map((row, i) => (i === 0 ? { ...row, media_type: "video", duration_ms: 5000 } : row)) }, /carousel uses five photos/);
  fails({ request: { ...request, offer: { ...request.offer, confirmed: false } } }, /Confirm the price/);
  fails({ request: { ...request, offer: { ...request.offer, priceAmount: 0 } } }, /Enter the price/);
  fails({ request: { ...request, offer: { ...request.offer, unit: "" } } }, /selling unit/);
  fails({ request: { ...request, offer: { ...request.offer, cta: "" } } }, /call to action/);
  fails({ request: { ...request, mediaIds: ["m1", "m1", "m3", "m4", "m5"] } }, /five different/);

  // A Reel accepts real video, but not a clip shorter than its scene.
  const reelRequest = { ...request, format: "reel" as const };
  const videoRows = rows.map((row, i) => (i === 0 ? { ...row, media_type: "video" as const, duration_ms: 5000 } : row));
  assert.equal(buildFastModeSpec({ request: reelRequest, product: { id: "revel-bars", name: "Revel Bars" }, mediaRows: videoRows }).media[0].mediaType, "video");
  assert.throws(
    () => buildFastModeSpec({ request: reelRequest, product: { id: "revel-bars", name: "Revel Bars" }, mediaRows: rows.map((row, i) => (i === 0 ? { ...row, media_type: "video", duration_ms: 1500 } : row)) }),
    /main photo clip is 1.5s; that part of the Reel needs 3.0s/,
  );
});

// --- brand tokens and fonts --------------------------------------------------------------------------

test("one brand token source: the spec, the Remotion palette and both renderers share it", () => {
  assert.deepEqual(ownerSpec().brand, ALY_PON_BRAND_TOKENS);
  // The Remotion palette (warm-open and every primitive) derives from the same tokens; no hex of its own.
  const primitives = readFileSync(path.join(PROJECT_ROOT, "src/remotion/primitives.tsx"), "utf8");
  const palette = primitives.slice(primitives.indexOf("export const WARM_PALETTE"), primitives.indexOf("} as const;", primitives.indexOf("export const WARM_PALETTE")));
  for (const [key, token] of [["ground", "background"], ["ink", "foreground"], ["muted", "muted"], ["accent", "accent"], ["frame", "surface"]]) {
    assert.match(palette, new RegExp(`${key}: ALY_PON_BRAND_TOKENS\.color\.${token},`));
  }
  assert.doesNotMatch(palette, /#[0-9a-fA-F]{6}/);

  for (const file of ["src/lib/content-studio/carousel-renderer.ts", "src/remotion/fast-mode/editorial-collage.tsx"]) {
    const source = readFileSync(path.join(PROJECT_ROOT, file), "utf8");
    assert.doesNotMatch(source, /#[0-9a-fA-F]{3,8}\b/, `${file} contains a hex colour literal`);
    assert.doesNotMatch(source, /rgba?\(/, `${file} contains an rgb colour literal`);
    assert.doesNotMatch(source, /fontFamily:\s*["'`]/, `${file} hard-codes a font family`);
    assert.doesNotMatch(source, /fontSize:\s*\d/, `${file} hard-codes a font size`);
  }
});

test("one font authority: both renderers draw the embedded full Geist faces, which include the peso sign", () => {
  const carousel = readFileSync(path.join(PROJECT_ROOT, "src/lib/content-studio/carousel-renderer.ts"), "utf8");
  const reel = readFileSync(path.join(PROJECT_ROOT, "src/remotion/fast-mode/editorial-collage.tsx"), "utf8");
  assert.match(carousel, /from "\.\.\/production-fonts\.ts"/);
  assert.match(reel, /from "\.\.\/fonts\.ts"/);
  assert.match(readFileSync(path.join(PROJECT_ROOT, "src/remotion/fonts.ts"), "utf8"), /EMBEDDED_PRODUCTION_FONTS/);

  assert.deepEqual(EMBEDDED_PRODUCTION_FONTS.map((face) => face.weight), [400, 700]);
  for (const face of EMBEDDED_PRODUCTION_FONTS) {
    const bytes = Buffer.from(face.base64, "base64");
    assert.equal(bytes.readUInt32BE(0), 0x00010000, "a TrueType face, not the latin-subset woff");
    assert.ok(cmapHasCodePoint(bytes, 0x20b1), `${face.fileName} must map U+20B1 PESO SIGN`);
  }
});

// Minimal TrueType cmap lookup (format 4, BMP) -- enough to prove a glyph exists for a code point.
function cmapHasCodePoint(font: Buffer, codePoint: number): boolean {
  const numTables = font.readUInt16BE(4);
  let cmapOffset = -1;
  for (let i = 0; i < numTables; i += 1) {
    const record = 12 + i * 16;
    if (font.toString("latin1", record, record + 4) === "cmap") cmapOffset = font.readUInt32BE(record + 8);
  }
  assert.ok(cmapOffset >= 0, "font has a cmap table");
  const subtables = font.readUInt16BE(cmapOffset + 2);
  for (let i = 0; i < subtables; i += 1) {
    const offset = cmapOffset + font.readUInt32BE(cmapOffset + 4 + i * 8 + 4);
    if (font.readUInt16BE(offset) !== 4) continue;
    const segX2 = font.readUInt16BE(offset + 6);
    const ends = offset + 14;
    const starts = ends + segX2 + 2;
    for (let s = 0; s < segX2 / 2; s += 1) {
      const end = font.readUInt16BE(ends + s * 2);
      const start = font.readUInt16BE(starts + s * 2);
      if (codePoint >= start && codePoint <= end) return true;
    }
  }
  return false;
}

// --- carousel ----------------------------------------------------------------------------------------

test("the carousel renders exactly five 1080x1350 PNGs named carousel-01..05.png", async () => {
  const slides = await renderCarousel(await campaignPromise);
  assert.deepEqual(slides.map((slide) => slide.fileName), [...CAROUSEL_FILE_NAMES]);
  for (const slide of slides) {
    const meta = await sharp(slide.png).metadata();
    assert.equal(meta.format, "png");
    assert.deepEqual([meta.width, meta.height], [1080, 1350]);
    assert.deepEqual(readPngDimensions(slide.png), { width: 1080, height: 1350 });
  }
  assert.deepEqual(validateCarouselExport(slides.map((slide) => ({ name: slide.fileName, bytes: slide.png }))), []);
});

test("offer and CTA are drawn exactly as confirmed; owner output carries no test label", async () => {
  const campaign = await campaignPromise;
  const [hero, detail, context, offer, cta] = planCarousel(campaign.spec);
  assert.equal(campaign.notForPublishing, false);
  assert.deepEqual(textOf(buildCarouselSlideElement(campaign, offer)), ["Revel Bars", "₱160 / 2 pcs"]);
  assert.deepEqual(textOf(buildCarouselSlideElement(campaign, cta)), ["aly & pon", "Revel Bars", "₱160 / 2 pcs", "Message us to order"]);
  assert.deepEqual(textOf(buildCarouselSlideElement(campaign, detail)), []);
  assert.deepEqual(textOf(buildCarouselSlideElement(campaign, context)), []);
  assert.deepEqual(textOf(buildCarouselSlideElement(campaign, hero)), ["Revel Bars", "aly & pon"]);
});

test("non-owner media renders only with the visible not-for-publishing label", async () => {
  const spec = structuredClone(ownerSpec());
  spec.media[0] = { ...spec.media[0], source: { kind: "fixture", name: "pattern" }, provenance: "test_fixture" };
  const campaign = await prepareCampaign(parseCreativeSpec(spec), syntheticReader, ["media-1"]);
  assert.equal(campaign.notForPublishing, true);
  assert.ok(textOf(buildCarouselSlideElement(campaign, planCarousel(campaign.spec)[0])).includes(NOT_FOR_PUBLISHING_LABEL));
});

test("the peso sign is drawn with a real glyph, not a missing-glyph box", async () => {
  // Draw "₱" and U+FFFF (which no font maps: exactly what a latin-only face did to ₱) with the same
  // embedded faces the carousel uses. A real ₱ draws ink and differs from the missing-glyph render.
  const satori = (await import("satori")).default;
  const { Resvg } = await import("@resvg/resvg-js");
  const fonts = EMBEDDED_PRODUCTION_FONTS.map((face) => {
    const b = Buffer.from(face.base64, "base64");
    return { name: "Geist", data: b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer, weight: face.weight, style: "normal" as const };
  });
  const draw = async (text: string) => {
    const svg = await satori({ type: "div", props: { style: { display: "flex", fontFamily: "Geist", fontSize: 96, fontWeight: 700, color: "#000", background: "#fff", width: 160, height: 160 }, children: text } } as never, { width: 160, height: 160, fonts });
    return sharp(Buffer.from(new Resvg(svg).render().asPng())).greyscale().raw().toBuffer();
  };
  const peso = await draw("₱");
  const missing = await draw("￿");
  assert.ok([...peso].filter((v) => v < 128).length > 300, "₱ must draw ink");
  assert.notDeepEqual(peso, missing, "₱ must not render like a missing glyph");

  // And the real offer slide draws the price line in the accent colour where the ₱ sits.
  const offer = await renderCarouselSlide(await campaignPromise, 4);
  const { data } = await sharp(offer.png).extract({ left: 80, top: 80 + 800 + 48 + 60, width: 80, height: 90 }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const accent = [1, 3, 5].map((i) => parseInt(ALY_PON_BRAND_TOKENS.color.accent.slice(i, i + 2), 16));
  let accentPixels = 0;
  for (let i = 0; i < data.length; i += 3) if (Math.abs(data[i] - accent[0]) < 30 && Math.abs(data[i + 1] - accent[1]) < 30 && Math.abs(data[i + 2] - accent[2]) < 30) accentPixels += 1;
  assert.ok(accentPixels > 300, `the offer slide's ₱ must be drawn (found ${accentPixels} accent pixels)`);
});

test("no clipping: maximum-length offer copy stays inside the slide margins", async () => {
  const long = ownerSpec({ name: "Dark Chocolate Sea Salt Revel Bars", unit: "box of 12 assorted bars", cta: "Message us on Facebook or Instagram", amount: 1250.5 });
  const campaign = await prepareCampaign(long, syntheticReader);
  const background = ALY_PON_BRAND_TOKENS.color.background;
  const bg = [1, 3, 5].map((i) => parseInt(background.slice(i, i + 2), 16));

  // Rows that must be pure background: the bottom margin of the offer and CTA slides, and the strip
  // directly under the CTA photo. Text that overflowed its box would land in one of them.
  const isBackgroundBand = async (png: Buffer, top: number, height: number) => {
    const { data, info } = await sharp(png).extract({ left: 0, top, width: 1080, height }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    for (let i = 0; i < info.width * info.height * 3; i += 3) {
      if (Math.abs(data[i] - bg[0]) > 6 || Math.abs(data[i + 1] - bg[1]) > 6 || Math.abs(data[i + 2] - bg[2]) > 6) return false;
    }
    return true;
  };

  const offer = await renderCarouselSlide(campaign, 4);
  const cta = await renderCarouselSlide(campaign, 5);
  const hero = await renderCarouselSlide(campaign, 1);
  assert.ok(await isBackgroundBand(offer.png, 1350 - 40, 40), "offer slide: copy reached the bottom margin");
  assert.ok(await isBackgroundBand(cta.png, 1350 - 24, 24), "CTA slide: copy reached the bottom margin");
  assert.ok(await isBackgroundBand(cta.png, 560, 16), "CTA slide: copy pushed up into the photo");
  assert.ok(await isBackgroundBand(hero.png, 1350 - 12, 12), "hero slide: headline reached the bottom edge");

  // Copy that cannot fit at the smallest readable size is refused, never shrunk further or cut.
  const impossible = ownerSpec({ unit: "W".repeat(24), cta: "W".repeat(40), name: "W".repeat(60) });
  await assert.rejects(() => fitCampaignCopy(impossible), /copy_does_not_fit/);
});

test("carousel.zip holds exactly the five previewed PNGs, byte for byte", async () => {
  const slides = await renderCarousel(await campaignPromise);
  const files = slides.map((slide) => ({ name: slide.fileName, bytes: new Uint8Array(slide.png) }));
  const zip = createStoredZip(files);
  const back = readStoredZip(zip);
  assert.deepEqual(back.map((file) => file.name), [...CAROUSEL_FILE_NAMES]);
  back.forEach((file, i) => assert.deepEqual(file.bytes, files[i].bytes));
  // Deterministic: the same slides always produce the same archive.
  assert.deepEqual(createStoredZip(files), zip);

  // The export gate refuses anything that is not exactly the five slides.
  assert.match(validateCarouselExport(files.slice(0, 4)).join(" "), /expected 5 slides/);
  assert.match(validateCarouselExport([...files.slice(0, 4), { name: "carousel-05.png", bytes: new Uint8Array([1, 2, 3]) }]).join(" "), /not a PNG/);
  const wrongSize = new Uint8Array(await sharp({ create: { width: 1080, height: 1080, channels: 3, background: "#ffffff" } }).png().toBuffer());
  assert.match(validateCarouselExport([...files.slice(0, 4), { name: "carousel-05.png", bytes: wrongSize }]).join(" "), /1080x1080/);
});

test("prepared campaigns are what both renderers receive", async () => {
  const campaign: PreparedCampaign = await campaignPromise;
  assert.deepEqual(Object.keys(campaign).sort(), ["copy", "media", "notForPublishing", "spec"]);
  assert.ok(Object.values(campaign.media).every((media) => media.kind === "photo" && media.dataUri.startsWith("data:image/jpeg;base64,")));
});

// --- reel continuity ---------------------------------------------------------------------------------

test("every reel scene cut lands on a fully visible picture -- no empty frame before, at or after any boundary", async () => {
  // Regression from the dual-renderer proof: both collage tiles once faded in from opacity 0, so the
  // cut out of the hero showed only the cream background.
  const { scenePhotoCoverage } = await import("../src/remotion/fast-mode/scene-motion.ts");
  const reel = planEditorialCollageReel(ownerSpec());
  const coverageAt = (frame: number) => {
    const scene = reel.scenes.find((s) => frame >= s.from && frame < s.from + s.durationInFrames);
    assert.ok(scene, `frame ${frame} belongs to no scene`);
    return { kind: scene.kind, coverage: scenePhotoCoverage(scene.kind, frame - scene.from) };
  };
  for (const scene of reel.scenes) {
    for (const frame of [scene.from - 1, scene.from, scene.from + 1]) {
      if (frame < 0) continue;
      const { kind, coverage } = coverageAt(frame);
      assert.equal(coverage, 1, `frame ${frame} (${kind}) has no fully visible picture (max opacity ${coverage})`);
    }
  }
  for (let frame = 0; frame < reel.durationInFrames; frame += 1) assert.equal(coverageAt(frame).coverage, 1, `frame ${frame} has no fully visible picture`);
});

test("the reel output gate flags blank and near-black decoded frames", async () => {
  const { blankFrames, frameStatsFromRaw, assertReelInputsReady } = await import("../src/remotion/fast-mode/render-reel.ts");
  const background = ALY_PON_BRAND_TOKENS.color.background;
  const solid = (hex: string) => {
    const rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    const data = new Uint8Array(10 * 10 * 3);
    for (let i = 0; i < data.length; i += 3) data.set(rgb, i);
    return frameStatsFromRaw(data, 10, 10, background);
  };
  // Frame 0: bare brand background (the proof's bug). Frame 1: a real picture. Frame 2: black.
  assert.deepEqual(blankFrames([solid(background), solid("#7a4a2a"), solid("#000000")]), [0, 2]);

  // Inputs must match the spec before Chrome is even started.
  const campaign = await campaignPromise;
  assert.doesNotThrow(() => assertReelInputsReady(campaign));
  const missing = { ...campaign, media: { ...campaign.media } };
  delete missing.media["media-4"];
  assert.throws(() => assertReelInputsReady(missing), /Media "media-4" was not prepared/);
  const wrongKind = { ...campaign, media: { ...campaign.media, "media-1": { id: "media-1", kind: "video" as const, src: "https://example.test/a.mp4", durationSeconds: 5 } } };
  assert.throws(() => assertReelInputsReady(wrongKind), /prepared as a video but the spec says photo/);
});
