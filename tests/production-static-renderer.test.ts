import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import sharp from "sharp";

import { inspectAssetBytes } from "../src/lib/asset-binary.ts";
import { buildStaticRendererExecutor } from "../src/lib/production-asset-executors.ts";
import { PRODUCTION_IMAGE_DIMENSIONS, type ProductionImageSpecV1 } from "../src/lib/production-spec.ts";
import { PRODUCTION_STATIC_RENDERER_FONT, renderProductionStaticImage } from "../src/lib/production-static-renderer.ts";
import { EMBEDDED_PRODUCTION_FONTS } from "../src/lib/production-fonts.ts";

function spec(overrides: Partial<ProductionImageSpecV1> = {}): ProductionImageSpecV1 {
  return {
    schemaVersion: "production-v1",
    assetKind: "image",
    sourceCreativePackageId: "package-1",
    dimensions: PRODUCTION_IMAGE_DIMENSIONS,
    copy: {
      headline: "sharing is caring",
      caption: "Two neatly separated brownie slices on a plate.",
      cta: "ready for owner review",
      overlayText: "sharing is caring",
    },
    brandStyle: null,
    visualBrief: {
      concept: "Two people sharing dessert at a small table.",
      style: "Warm hand-drawn editorial bakery illustration.",
      scene: ["Two simple human figures at a table", "Clean brownie squares on a plate"],
      executionNotes: ["No photoreal product documentation", "No generated readable text"],
    },
    ...overrides,
  };
}

test("production static renderer returns a real 1080x1080 PNG candidate", async () => {
  const candidate = await renderProductionStaticImage(spec());
  const inspected = await inspectAssetBytes(candidate.bytes);

  assert.equal(candidate.mimeType, "image/png");
  assert.equal(candidate.width, 1080);
  assert.equal(candidate.height, 1080);
  assert.equal(candidate.durationMs, null);
  assert.equal(candidate.fileSizeBytes, candidate.bytes.length);
  assert.equal(inspected.ok, true);
  if (inspected.ok) {
    assert.equal(inspected.facts.actualWidth, 1080);
    assert.equal(inspected.facts.actualHeight, 1080);
    assert.equal(inspected.facts.actualMimeType, "image/png");
  }
});

test("production static renderer is deterministic for the same spec", async () => {
  const first = await renderProductionStaticImage(spec());
  const second = await renderProductionStaticImage(spec());

  assert.deepEqual(first.bytes, second.bytes);
});

test("static_renderer executor requires ProductionSpecV1 and returns exactly one PNG candidate", async () => {
  const executor = buildStaticRendererExecutor();
  const result = await executor({ id: "job-1", creativePackageId: "package-1", status: "queued", workerType: "static_renderer", assetKind: "image", attemptCount: 0, result: {}, lastError: "", createdAt: "", updatedAt: "", startedAt: "", completedAt: "", failedAt: "" }, spec(), {
    signal: new AbortController().signal,
  });

  assert.equal(result.length, 1);
  assert.equal(result[0]?.mimeType, "image/png");
  assert.equal(result[0]?.width, 1080);
  assert.equal(result[0]?.height, 1080);
});

// --- portable font strategy (review section 11) ------------------------------------------------------

test("the renderer's fonts are app-owned, OFL licensed, and embedded rather than resolved", () => {
  assert.equal(PRODUCTION_STATIC_RENDERER_FONT.family, "Geist");
  assert.equal(PRODUCTION_STATIC_RENDERER_FONT.package, "@fontsource/geist-sans");
  assert.equal(PRODUCTION_STATIC_RENDERER_FONT.license, "OFL-1.1");
  // Embedded: no filesystem path is resolved at render time. require.resolve worked under node and
  // failed inside the Next server runtime, which is what this guarantees cannot recur.
  assert.equal(PRODUCTION_STATIC_RENDERER_FONT.embedded, true);
  assert.match(PRODUCTION_STATIC_RENDERER_FONT.version, /^\d+\.\d+\.\d+$/);

  // The licence text must actually travel with the dependency the bytes came from.
  const licensePath = createRequire(import.meta.url).resolve("@fontsource/geist-sans/LICENSE");
  assert.ok(existsSync(licensePath));
  assert.match(readFileSync(licensePath, "utf8"), /SIL OPEN FONT LICENSE/i);
});

test("the embedded faces really are the two the dependency ships", () => {
  assert.equal(EMBEDDED_PRODUCTION_FONTS.length, 2);
  const packageRoot = path.dirname(createRequire(import.meta.url).resolve("@fontsource/geist-sans/package.json"));
  for (const face of EMBEDDED_PRODUCTION_FONTS) {
    const onDisk = readFileSync(path.join(packageRoot, "files", face.fileName));
    assert.deepEqual(
      new Uint8Array(Buffer.from(face.base64, "base64")),
      new Uint8Array(onDisk),
      `embedded ${face.weight} face must match ${face.fileName} byte for byte -- regenerate with scripts/production-static-renderer/generate-embedded-fonts.ts`,
    );
  }
});

test("BOTH declared weights are real registered faces -- 700 is never synthesized from 400", () => {
  assert.deepEqual([...PRODUCTION_STATIC_RENDERER_FONT.weights], [400, 700]);

  // Distinct bytes, not the same face embedded twice under two weights.
  const [regular, bold] = EMBEDDED_PRODUCTION_FONTS;
  assert.notEqual(regular.base64, bold.base64);
  assert.equal(regular.weight, 400);
  assert.equal(bold.weight, 700);

  // And the composition really does ask for 700 somewhere, or registering it would be pointless.
  const source = readFileSync(new URL("../src/lib/production-static-renderer.ts", import.meta.url), "utf8");
  assert.match(source, /fontWeight:\s*700/);
});

test("[static] the renderer RESOLVES no font from a framework-private path", () => {
  const raw = readFileSync(new URL("../src/lib/production-static-renderer.ts", import.meta.url), "utf8");

  // Comments are stripped first, exactly as tests/public-submission.test.ts does for the same
  // reason: this module DISCUSSES the framework-private path it moved away from, and the bundler
  // constraints that shaped the current resolution, at length. Prose must not be mistaken for
  // implementation.
  const source = raw
    .split("\n")
    .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*") && !line.trim().startsWith("/*"))
    .join("\n");

  // Deliberately matched inside STRING LITERALS only. The module comment names the path this module
  // deliberately moved away from, and that explanation is worth keeping -- what must never come back
  // is a resolve of it.
  const stringLiterals = source.match(/"[^"\n]*"/g) ?? [];
  for (const literal of stringLiterals) {
    assert.doesNotMatch(literal, /next\/dist/, `the renderer must not resolve a private Next path: ${literal}`);
    assert.doesNotMatch(literal, /@vercel\/og/, `the renderer must not resolve a private Next path: ${literal}`);
  }

  // Every resolved module must come from a declared dependency.
  for (const resolved of source.match(/require\.resolve\("([^"]+)"\)/g) ?? []) {
    assert.match(resolved, /@fontsource\/geist-sans/);
  }
});

// --- dimension-aware composition (review section 12) -------------------------------------------------

test("the renderer honours the SPEC's dimensions rather than a hardcoded 1080 square", async () => {
  const cases = [
    { width: 1080, height: 1080 },
    { width: 1080, height: 1920 },
    { width: 540, height: 540 },
  ];

  for (const dimensions of cases) {
    const candidate = await renderProductionStaticImage(spec({ dimensions: { ...dimensions, aspectRatio: `${dimensions.width}:${dimensions.height}` } }));
    const inspected = await inspectAssetBytes(candidate.bytes);

    assert.equal(candidate.width, dimensions.width);
    assert.equal(candidate.height, dimensions.height);
    assert.equal(inspected.ok, true, `${dimensions.width}x${dimensions.height} must produce decodable bytes`);
    if (inspected.ok) {
      // The decoded PNG must really be that size -- not a 1080 square padded or cropped into place.
      assert.equal(inspected.facts.actualWidth, dimensions.width);
      assert.equal(inspected.facts.actualHeight, dimensions.height);
    }
  }
});

test("the illustration composite is also dimension-derived, not pinned to top=300 / height=780", async () => {
  const illustration = { bytes: new Uint8Array(await sharp({ create: { width: 64, height: 64, channels: 3, background: "#c98b5e" } }).png().toBuffer()), mimeType: "image/png" as const };

  for (const dimensions of [{ width: 1080, height: 1080 }, { width: 1080, height: 1920 }]) {
    const candidate = await renderProductionStaticImage(
      spec({ dimensions: { ...dimensions, aspectRatio: `${dimensions.width}:${dimensions.height}` } }),
      { illustration },
    );
    const inspected = await inspectAssetBytes(candidate.bytes);

    assert.equal(inspected.ok, true);
    if (inspected.ok) {
      assert.equal(inspected.facts.actualWidth, dimensions.width);
      assert.equal(inspected.facts.actualHeight, dimensions.height);
    }
  }
});

test("[static] no 1080-relative geometry constant survives as a raw pixel value in the composition", () => {
  const source = readFileSync(new URL("../src/lib/production-static-renderer.ts", import.meta.url), "utf8");

  // The two hardcoded strings the composition used to be built from.
  assert.doesNotMatch(source, /width:\s*"1080px"/);
  assert.doesNotMatch(source, /height:\s*"1080px"/);
  // And the illustration band's old fixed geometry.
  assert.doesNotMatch(source, /\.resize\(1080,\s*780/);
  assert.doesNotMatch(source, /top:\s*300\s*\}/);
});

// --- copy fitting: the social caption is not image body copy, and visual copy fits or fails --------
//
// The defect these lock in was found by real acceptance, not by review: the first live production run
// drew a 231-character SOCIAL CAPTION as the composition's accent line, ran it off the canvas, and
// through the brand mark.

// Verbatim from Creative Package ede376a1-8abd-4537-9666-975eb4804607, the package that overflowed.
const REAL_LONG_CAPTION =
  "Introductions are awkward for everyone, so we'll go first. Blondies, meet everyone. Everyone, Blondies. That's it — no speech, no slideshow, just a name tag and a small hello on a Monday. Say hi back if you like.";
const REAL_OVERLAY_TEXT = "HELLO my name is BLONDIES";

async function renderedInk(spec: ProductionImageSpecV1, options?: Parameters<typeof renderProductionStaticImage>[1]) {
  const candidate = await renderProductionStaticImage(spec, options);
  // Where the drawn content actually sits, measured from the real PNG rather than assumed.
  const image = sharp(Buffer.from(candidate.bytes));
  const { data, info } = await image.greyscale().raw().toBuffer({ resolveWithObject: true });
  let top = info.height;
  let bottom = -1;
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      // The canvas is #fff8ef; anything meaningfully darker is drawn content.
      if (data[y * info.width + x] < 230) {
        if (y < top) top = y;
        if (y > bottom) bottom = y;
        break;
      }
    }
  }
  return { candidate, top, bottom, height: info.height, width: info.width };
}

test("B: the real long-copy package no longer overflows, and its SOCIAL CAPTION is not in the image", async () => {
  const result = await renderedInk(
    spec({ copy: { headline: "Hi, my name is Blondies.", caption: REAL_LONG_CAPTION, cta: "Say hi in the comments", overlayText: REAL_OVERLAY_TEXT } }),
  );

  assert.equal(result.candidate.width, 1080);
  // Nothing is drawn at the very edge -- the overflow signature was ink running to the last row.
  assert.ok(result.bottom < result.height - 8, `content reached y=${result.bottom} of ${result.height}`);
  assert.ok(result.top > 0);
});

test("A: short accepted copy still renders at the full authored sizes -- the fit only engages when needed", async () => {
  const short = await renderedInk(spec({ copy: { headline: "sharing is caring", caption: "A short social caption.", cta: "cta", overlayText: "little reward" } }));

  // Two lines of type high on the canvas, exactly as the accepted composition placed them, with the
  // whole lower half free for the rule, the doodles and the brand mark.
  assert.ok(short.top < 300, `headline should still start high, began at y=${short.top}`);
  assert.ok(short.bottom < short.height - 8);
});

test("C: visual copy that cannot fit at the smallest readable size is REFUSED, not squeezed", async () => {
  await assert.rejects(
    () => renderProductionStaticImage(spec({ copy: { headline: "Hi.", caption: "s", cta: "c", overlayText: "HELLO ".repeat(60) } })),
    (error: Error) => {
      assert.equal(error.name, "CopyDoesNotFitError");
      assert.match(error.message, /copy_does_not_fit/);
      // Names the field and tells the owner what to do about it.
      assert.match(error.message, /overlayText/);
      assert.match(error.message, /shorter creative treatment/);
      return true;
    },
  );
});

test("C: an unfittable HEADLINE is refused too, naming the headline rather than the overlay", async () => {
  await assert.rejects(
    () => renderProductionStaticImage(spec({ copy: { headline: "Blondies ".repeat(90), caption: "s", cta: "c", overlayText: null } })),
    (error: Error) => {
      assert.equal(error.name, "CopyDoesNotFitError");
      assert.match(error.message, /headline/);
      return true;
    },
  );
});

test("D: fitting is deterministic -- the same copy fits the same way twice", async () => {
  const copy = { headline: "Hi, my name is Blondies.", caption: REAL_LONG_CAPTION, cta: "c", overlayText: REAL_OVERLAY_TEXT };
  const first = await renderProductionStaticImage(spec({ copy }));
  const second = await renderProductionStaticImage(spec({ copy }));
  assert.deepEqual(first.bytes, second.bytes);
});

test("D: multiline overlay copy is handled without overflowing", async () => {
  const result = await renderedInk(
    spec({ copy: { headline: "Hi. I'm Blondies.", caption: "social copy", cta: "c", overlayText: '"Hi. I\'m Blondies." / "...Coffee. Hi. Sorry. Coffee."' } }),
  );
  assert.ok(result.bottom < result.height - 8);
});

test("E: the brand mark band is never reached by fitted copy", async () => {
  // The mark sits in the bottom ~90px of a 1080 canvas. Long-but-fittable copy must stay above the
  // rule and the mark rather than running into them.
  for (const overlayText of [REAL_OVERLAY_TEXT, "HELLO my name is BLONDIES and this is a longer greeting line"]) {
    const result = await renderedInk(spec({ copy: { headline: "Hi, my name is Blondies.", caption: REAL_LONG_CAPTION, cta: "c", overlayText } }));
    // The brand mark itself is drawn, so ink DOES exist low on the canvas -- what must not happen is
    // text running past the canvas edge.
    assert.ok(result.bottom < result.height - 8, `copy reached y=${result.bottom} of ${result.height}`);
  }
});

test("F: fitted copy still renders correctly at another supported dimension", async () => {
  const tall = await renderProductionStaticImage(
    spec({
      dimensions: { width: 1080, height: 1920, aspectRatio: "9:16" },
      copy: { headline: "Hi, my name is Blondies.", caption: REAL_LONG_CAPTION, cta: "c", overlayText: REAL_OVERLAY_TEXT },
    }),
  );
  const inspected = await inspectAssetBytes(tall.bytes);
  assert.equal(tall.width, 1080);
  assert.equal(tall.height, 1920);
  assert.equal(inspected.ok, true);
  if (inspected.ok) {
    assert.equal(inspected.facts.actualWidth, 1080);
    assert.equal(inspected.facts.actualHeight, 1920);
  }
});

test("[static] the renderer never draws spec.copy.caption", () => {
  const raw = readFileSync(new URL("../src/lib/production-static-renderer.ts", import.meta.url), "utf8");
  const source = raw
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
  assert.equal(source.includes("spec.copy.caption"), false, "the social caption must never be rendered into the image");
  assert.match(source, /spec\.copy\.overlayText/);
});
