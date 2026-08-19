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

test("the renderer's fonts are app-owned and OFL licensed, never a private Next internal path", () => {
  assert.equal(PRODUCTION_STATIC_RENDERER_FONT.family, "Geist");
  assert.equal(PRODUCTION_STATIC_RENDERER_FONT.package, "@fontsource/geist-sans");
  assert.equal(PRODUCTION_STATIC_RENDERER_FONT.license, "OFL-1.1");

  for (const fontPath of PRODUCTION_STATIC_RENDERER_FONT.paths) {
    assert.ok(existsSync(fontPath), `declared font face is missing on disk: ${fontPath}`);
    assert.match(fontPath.split(path.sep).join("/"), /@fontsource\/geist-sans/);
    assert.doesNotMatch(fontPath.split(path.sep).join("/"), /next\/dist/, "production rendering must not depend on a private Next build artefact");
  }

  // The licence text must actually travel with the dependency we redistribute the faces from.
  const licensePath = createRequire(import.meta.url).resolve("@fontsource/geist-sans/LICENSE");
  assert.match(readFileSync(licensePath, "utf8"), /SIL OPEN FONT LICENSE/i);
});

test("BOTH declared weights are real registered faces -- 700 is never synthesized from 400", async () => {
  assert.deepEqual([...PRODUCTION_STATIC_RENDERER_FONT.weights], [400, 700]);

  // Distinct files, not the same face registered twice under two weights.
  const [regular, bold] = PRODUCTION_STATIC_RENDERER_FONT.paths;
  assert.notEqual(regular, bold);
  assert.notDeepEqual(new Uint8Array(readFileSync(regular)), new Uint8Array(readFileSync(bold)));

  // And the composition really does ask for 700 somewhere, or registering it would be pointless.
  const source = readFileSync(new URL("../src/lib/production-static-renderer.ts", import.meta.url), "utf8");
  assert.match(source, /fontWeight:\s*700/);
});

test("[static] the renderer RESOLVES no font from a framework-private path", () => {
  const source = readFileSync(new URL("../src/lib/production-static-renderer.ts", import.meta.url), "utf8");

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
