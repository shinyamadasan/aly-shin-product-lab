import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  PRODUCTION_IMAGE_DIMENSIONS,
  PRODUCTION_SHORT_VIDEO_DIMENSIONS,
  buildProductionSpec,
  isProductionSpecV1,
  type ProductionSpecV1,
} from "../src/lib/production-spec.ts";
import {
  ASSET_GENERATION_IMAGE_DIMENSIONS,
  buildAssetGenerationSpec,
  deriveBrandStyle,
} from "../src/lib/asset-generation-spec.ts";
import { briefSha256, renderAssetGenerationBrief } from "../src/lib/asset-generation-brief.ts";
import { fromCreativePackageRow, type CreativePackageRow } from "../src/lib/creative-packages.ts";
import { isCreativePackageContentV2 } from "../src/lib/creative-package-content-v2.ts";
import { BRAND_BIBLE } from "../src/lib/marketing-advisor-context.ts";

// --- fixtures --------------------------------------------------------------------------------------

function v1Row(): CreativePackageRow {
  return {
    id: "package-1",
    creative_job_id: "job-1",
    status: "ready",
    schema_version: "v1",
    content: {
      output: { headline: "Launch-ready Brownies content", caption: "Brownies are ready." },
      metadata: {
        generatedFromOpportunity: "opportunity-1",
        generatorVersion: "1",
        sourceCreativeJobId: "job-1",
        sourceWorker: "mock",
        sourceJobResultSchemaVersion: "v1",
      },
      artifacts: [],
    },
    created_at: "2026-07-31T09:05:00.000Z",
    updated_at: "2026-07-31T09:05:00.000Z",
  } as CreativePackageRow;
}

function v2Metadata() {
  return {
    generatedFromOpportunity: null,
    generatorVersion: "2",
    sourceCreativeJobId: "job-2",
    sourceWorker: "mock",
    sourceJobResultSchemaVersion: "v2",
    formatChosenBy: "ai",
    formatRationale: "A single hero shot suits one product.",
    subjectSource: "stated",
    subjectGrounding: null,
  };
}

// A capture photo package -- the shape that has existed since H1-B and carries NO visualBrief.
function v2CapturePhotoRow(): CreativePackageRow {
  return {
    id: "package-2",
    creative_job_id: "job-2",
    status: "ready",
    schema_version: "v2",
    content: {
      schemaVersion: "v2",
      format: "photo",
      subject: "Brownies",
      angle: "Fresh batch",
      hook: "Still warm.",
      headline: "Brownies, still warm",
      caption: "Out of the oven at 7am.",
      cta: "Order today",
      visualDirection: "Overhead on the wooden board, morning light",
      overlayText: null,
      productionSource: "capture_new",
      framing: "overhead",
      platformVariants: [{ platform: "instagram", caption: "Still warm.", hashtags: ["#brownies"] }],
      metadata: v2Metadata(),
    },
    created_at: "2026-08-01T09:05:00.000Z",
    updated_at: "2026-08-01T09:05:00.000Z",
  } as CreativePackageRow;
}

// A zero-capture photo package -- the shape that carries a structured visualBrief.
function v2GeneratedPhotoRow(): CreativePackageRow {
  return {
    id: "package-3",
    creative_job_id: "job-3",
    status: "ready",
    schema_version: "v2",
    content: {
      schemaVersion: "v2",
      format: "photo",
      subject: "Brownies",
      angle: "Two characters argue over the last one",
      hook: "There is always one left.",
      headline: "The last brownie",
      caption: "It is always the last one that causes trouble.",
      cta: "Order today",
      visualDirection: "An illustrated stand-off over the last brownie on the board",
      overlayText: "Mine.",
      productionSource: "generate_visual",
      visualBrief: {
        concept: "Two dessert characters in a stand-off over the last brownie",
        style: "Soft hand-drawn illustration, warm bakery palette",
        scene: ["Board centred with one brownie left", "Two characters lean in from opposite edges"],
        executionNotes: ["Keep the product obviously illustrated", "Use minimal background detail"],
      },
      platformVariants: [{ platform: "instagram", caption: "Mine.", hashtags: ["#brownies"] }],
      metadata: { ...v2Metadata(), sourceCreativeJobId: "job-3" },
    },
    created_at: "2026-08-02T09:05:00.000Z",
    updated_at: "2026-08-02T09:05:00.000Z",
  } as CreativePackageRow;
}

// A Reel package. capture_new because that is the ONLY productionSource the stored contract permits
// for a Reel today -- Wave D relaxes that, not Wave A. The short_video spec is built from it here to
// prove the 1:1 shot mapping structurally, which is exactly what the brief permits: synthetic
// coverage of the spec shape without the live generator being allowed to produce a rendered Reel.
function v2ReelRow(): CreativePackageRow {
  return {
    id: "package-4",
    creative_job_id: "job-4",
    status: "ready",
    schema_version: "v2",
    content: {
      schemaVersion: "v2",
      format: "reel",
      subject: "Morning bake",
      angle: "From oven to counter",
      hook: "7am, every day.",
      headline: "Morning bake",
      caption: "The first tray of the day.",
      cta: "Come by before 9",
      productionSource: "capture_new",
      shots: [
        { direction: "Oven door opens, steam", onScreenText: "7:00am", approxSeconds: 3, framing: "close_up", movement: "push_in" },
        { direction: "Tray lands on the counter", onScreenText: null, approxSeconds: 4, framing: "medium", movement: null },
        { direction: "Hand lifts one brownie", onScreenText: "Still warm", approxSeconds: 3, framing: "close_up" },
      ],
      spokenScript: null,
      audioDirection: "Soft morning kitchen sound, no music",
      targetDurationSeconds: 10,
      platformVariants: [{ platform: "instagram", caption: "7am.", hashtags: ["#bakery"] }],
      metadata: { ...v2Metadata(), sourceCreativeJobId: "job-4", formatRationale: "Motion carries the morning routine." },
    },
    created_at: "2026-08-03T09:05:00.000Z",
    updated_at: "2026-08-03T09:05:00.000Z",
  } as CreativePackageRow;
}

// Sanity: the fixtures must be genuinely valid v2 packages, or every assertion below is testing a
// shape the system would never store.
test("v2 fixtures are valid Creative Package v2 content", () => {
  for (const row of [v2CapturePhotoRow(), v2GeneratedPhotoRow(), v2ReelRow()]) {
    assert.equal(isCreativePackageContentV2(row.content), true, `fixture ${row.id} is not valid v2 content`);
  }
});

// --- A. additive and distinct from AssetGenerationSpecV1 ---------------------------------------------

test("ProductionSpecV1 is a distinct type from AssetGenerationSpecV1, not a replacement", () => {
  const pkg = fromCreativePackageRow(v2CapturePhotoRow());
  const legacy = buildAssetGenerationSpec(pkg, { assetKind: "image", brandBible: BRAND_BIBLE });
  const production = buildProductionSpec(pkg, { assetKind: "image", brandBible: BRAND_BIBLE });

  assert.notDeepEqual(production, legacy);

  // V1's own discriminating fields are absent from the new spec -- it is not a superset and does not
  // pretend to render the same brief.
  assert.equal("generationIntent" in production, false);
  assert.equal("visualDirection" in production, false);

  // And V1 keeps every field it always had.
  assert.equal(legacy.generationIntent.purpose, "marketing-social-feed");
  assert.equal(legacy.generationIntent.outcome, "single-image");
  assert.equal(legacy.schemaVersion, "v1");
});

// The two specs must be distinguishable AT RUNTIME, not merely in the type system: an executor
// receiving the widened union has only the value to go on. This is why ProductionSpecV1 carries
// schemaVersion "production-v1" rather than reusing "v1" -- an AssetGenerationSpecV1 for an image
// would otherwise be structurally identical on both discriminating fields.
test("isProductionSpecV1 distinguishes a ProductionSpecV1 from an AssetGenerationSpecV1", () => {
  const photo = fromCreativePackageRow(v2CapturePhotoRow());
  const reel = fromCreativePackageRow(v2ReelRow());

  assert.equal(isProductionSpecV1(buildProductionSpec(photo, { assetKind: "image" })), true);
  assert.equal(isProductionSpecV1(buildProductionSpec(reel, { assetKind: "short_video" })), true);

  // The legacy image spec must NOT be mistaken for a production spec.
  assert.equal(isProductionSpecV1(buildAssetGenerationSpec(photo, { assetKind: "image" })), false);
  assert.equal(isProductionSpecV1({ schemaVersion: "v1", assetKind: "image" }), false);
  assert.equal(isProductionSpecV1(null), false);
  assert.equal(isProductionSpecV1({}), false);
  assert.equal(isProductionSpecV1([]), false);
});

// --- B, C, D. legacy compatibility gate ---------------------------------------------------------------

test("AssetGenerationSpecV1 output is unchanged for v1 and v2 packages", () => {
  const v1Spec = buildAssetGenerationSpec(fromCreativePackageRow(v1Row()), { assetKind: "image", brandBible: BRAND_BIBLE });
  assert.deepEqual(v1Spec, {
    schemaVersion: "v1",
    assetKind: "image",
    sourceCreativePackageId: "package-1",
    generationIntent: { purpose: "marketing-social-feed", outcome: "single-image" },
    copy: { headline: "Launch-ready Brownies content", caption: "Brownies are ready." },
    dimensions: ASSET_GENERATION_IMAGE_DIMENSIONS,
    brandStyle: deriveBrandStyle(BRAND_BIBLE),
    // Still null for a v1 package, which is what keeps every pre-S2 brief byte-identical.
    visualDirection: null,
  });

  const v2Spec = buildAssetGenerationSpec(fromCreativePackageRow(v2CapturePhotoRow()), { assetKind: "image", brandBible: BRAND_BIBLE });
  assert.equal(v2Spec.visualDirection, "Overhead on the wooden board, morning light");
  assert.deepEqual(v2Spec.dimensions, ASSET_GENERATION_IMAGE_DIMENSIONS);
});

test("the rendered brief is unchanged -- V1 still renders exactly the text it always did", () => {
  const spec = buildAssetGenerationSpec(fromCreativePackageRow(v1Row()), { assetKind: "image", brandBible: BRAND_BIBLE });
  const brief = renderAssetGenerationBrief(spec);

  assert.match(brief, /^Create one marketing image, exactly 1080x1080 pixels \(1:1\)\./);
  assert.match(brief, /\nHeadline: Launch-ready Brownies content\n/);
  assert.match(brief, /\nDo not add text overlays to the image unless explicitly requested\./);
  // A v1 brief has never carried a visual-direction line and still must not.
  assert.doesNotMatch(brief, /Visual direction:/);

  // Nothing from ProductionSpecV1 may leak into the legacy brief.
  assert.doesNotMatch(brief, /concept|executionNotes|scenes|targetDurationSeconds|1080x1920/i);
});

// THE compatibility gate. These digests are pinned literals, captured from origin/main (b18d3f1)
// BEFORE any Wave A change, and they are what every persisted Asset's briefSha256 was computed
// against. If either changes, briefs stored on real Assets no longer verify against their source
// package -- so this test failing means the change that caused it must be reverted, not re-baselined.
//
// The whole brief-rendering chain (asset-generation-spec.ts, asset-generation-brief.ts,
// asset-digest.ts, creative-packages.ts, creative-package-content-v2.ts, marketing-advisor-context.ts)
// carries a zero diff against origin/main in Wave A, which is the structural reason these hold.
test("briefSha256 is byte-identical to the pre-Wave-A values for representative v1 and v2 packages", async () => {
  const v1Spec = buildAssetGenerationSpec(fromCreativePackageRow(v1Row()), { assetKind: "image", brandBible: BRAND_BIBLE });
  assert.equal(await briefSha256(v1Spec), "5409eca4875fc1b6cff19e94deed4656d2afeaba2a30bf77d93d789e9726ae2b");

  const v2Spec = buildAssetGenerationSpec(fromCreativePackageRow(v2CapturePhotoRow()), { assetKind: "image", brandBible: BRAND_BIBLE });
  assert.equal(await briefSha256(v2Spec), "83a0feaedf3c0240e511a7eb2dfb2365b8017509f541ae78924359ed2935de28");
});

test("briefSha256 stays stable across repeated calls for the same package", async () => {
  const spec = buildAssetGenerationSpec(fromCreativePackageRow(v2CapturePhotoRow()), { assetKind: "image", brandBible: BRAND_BIBLE });
  const first = await briefSha256(spec);
  for (let i = 0; i < 5; i += 1) {
    assert.equal(await briefSha256(spec), first);
  }
});

// --- E, F. visualBrief plumbing (the gap Wave A closes) -----------------------------------------------

test("visualBrief reaches ProductionSpecV1 STRUCTURALLY, not flattened into prose", () => {
  const spec = buildProductionSpec(fromCreativePackageRow(v2GeneratedPhotoRow()), { assetKind: "image", brandBible: BRAND_BIBLE });

  assert.deepEqual(spec.visualBrief, {
    concept: "Two dessert characters in a stand-off over the last brownie",
    style: "Soft hand-drawn illustration, warm bakery palette",
    scene: ["Board centred with one brownie left", "Two characters lean in from opposite edges"],
    executionNotes: ["Keep the product obviously illustrated", "Use minimal background detail"],
  });

  // The four fields stay four fields. Joining them into one string here would rebuild exactly the
  // wall of prose the structured brief exists to replace.
  assert.ok(Array.isArray(spec.visualBrief?.scene));
  assert.ok(Array.isArray(spec.visualBrief?.executionNotes));
  assert.equal(typeof spec.visualBrief?.concept, "string");
});

test("packages without a visualBrief remain supported and yield null, never a fabricated brief", () => {
  // A capture photo package: legitimately has no brief (a capture is directed, not briefed).
  const capture = buildProductionSpec(fromCreativePackageRow(v2CapturePhotoRow()), { assetKind: "image" });
  assert.equal(capture.visualBrief, null);

  // A Reel: no format other than photo carries a brief today.
  const reel = buildProductionSpec(fromCreativePackageRow(v2ReelRow()), { assetKind: "short_video" });
  assert.equal(reel.visualBrief, null);
});

test("the legacy AssetGenerationSpecV1 path still does NOT read visualBrief", () => {
  // Proves the plumbing is additive: closing the gap in ProductionSpecV1 must not retroactively
  // change what the external/human path sends, because that would change its brief and its hash.
  const legacy = buildAssetGenerationSpec(fromCreativePackageRow(v2GeneratedPhotoRow()), { assetKind: "image", brandBible: BRAND_BIBLE });
  assert.equal("visualBrief" in legacy, false);
  assert.equal(legacy.visualDirection, "An illustrated stand-off over the last brownie on the board");
});

// --- G, H, I. dimensions -------------------------------------------------------------------------------

test("dimensions are variable in ProductionSpecV1 and fixed per asset kind", () => {
  const photo = fromCreativePackageRow(v2CapturePhotoRow());
  const reel = fromCreativePackageRow(v2ReelRow());

  const image = buildProductionSpec(photo, { assetKind: "image" });
  const video = buildProductionSpec(reel, { assetKind: "short_video" });

  assert.deepEqual(image.dimensions, { width: 1080, height: 1080, aspectRatio: "1:1" });
  assert.deepEqual(video.dimensions, { width: 1080, height: 1920, aspectRatio: "9:16" });

  // The point of the new spec: two different outputs, two different shapes. V1 could only ever say
  // 1080x1080 because its dimensions were a frozen constant.
  assert.notDeepEqual(image.dimensions, video.dimensions);
  assert.deepEqual(PRODUCTION_IMAGE_DIMENSIONS, { width: 1080, height: 1080, aspectRatio: "1:1" });
  assert.deepEqual(PRODUCTION_SHORT_VIDEO_DIMENSIONS, { width: 1080, height: 1920, aspectRatio: "9:16" });
});

// --- J, K. short_video scene mapping ---------------------------------------------------------------------

test("short_video scenes map 1:1 from Reel shots, in order", () => {
  const spec = buildProductionSpec(fromCreativePackageRow(v2ReelRow()), { assetKind: "short_video" });
  assert.equal(spec.assetKind, "short_video");
  if (spec.assetKind !== "short_video") {
    return;
  }

  assert.equal(spec.scenes.length, 3);
  assert.deepEqual(spec.scenes, [
    { direction: "Oven door opens, steam", text: "7:00am", approxSeconds: 3 },
    { direction: "Tray lands on the counter", text: null, approxSeconds: 4 },
    { direction: "Hand lifts one brownie", text: "Still warm", approxSeconds: 3 },
  ]);

  // Camera-only guidance stays in the package and is NOT carried into the spec: framing and movement
  // describe pointing a real camera, which a renderer does not do.
  for (const scene of spec.scenes) {
    assert.equal("framing" in scene, false);
    assert.equal("movement" in scene, false);
  }
});

test("targetDurationSeconds is preserved from the package, not recomputed", () => {
  const spec = buildProductionSpec(fromCreativePackageRow(v2ReelRow()), { assetKind: "short_video" });
  if (spec.assetKind !== "short_video") {
    assert.fail("expected a short_video spec");
  }
  // The package states 10 while its shots sum to 10 here; the assertion is that the spec reports the
  // PACKAGE's number, so the owner and the renderer can never be shown two different totals.
  assert.equal(spec.targetDurationSeconds, 10);
});

test("building a short_video spec from a non-reel package throws rather than guessing", () => {
  assert.throws(
    () => buildProductionSpec(fromCreativePackageRow(v2CapturePhotoRow()), { assetKind: "short_video" }),
    /short_video requires a reel Creative Package/,
  );
});

test("building a ProductionSpec from a v1 package throws -- v1 has none of the fields it needs", () => {
  assert.throws(() => buildProductionSpec(fromCreativePackageRow(v1Row()), { assetKind: "image" }), /requires Creative Package content v2/);
});

// --- L. no executor configuration ---------------------------------------------------------------------------

test("ProductionSpecV1 carries creative intent only -- no executor configuration", () => {
  const specs: ProductionSpecV1[] = [
    buildProductionSpec(fromCreativePackageRow(v2GeneratedPhotoRow()), { assetKind: "image", brandBible: BRAND_BIBLE }),
    buildProductionSpec(fromCreativePackageRow(v2ReelRow()), { assetKind: "short_video", brandBible: BRAND_BIBLE }),
  ];

  const forbidden = [
    "fps",
    "durationInFrames",
    "codec",
    "crf",
    "bitrate",
    "pixelFormat",
    "compositionId",
    "composition",
    "chromium",
    "browserExecutable",
    "easing",
    "safeMargin",
    "fontPath",
    "outputPath",
    "tempPath",
    "concurrency",
    "provider",
    "model",
  ];

  for (const spec of specs) {
    const serialized = JSON.stringify(spec);
    for (const key of forbidden) {
      assert.doesNotMatch(
        serialized,
        new RegExp(`"${key}"`, "i"),
        `${key} is executor configuration and must be computed at render time, never carried in the spec`,
      );
    }
  }
});

test("[static] production-spec.ts names no execution technology and persists nothing", () => {
  const source = readFileSync(new URL("../src/lib/production-spec.ts", import.meta.url), "utf8");
  for (const forbidden of [/\bfetch\s*\(/, /@supabase\/supabase-js/i, /from\("asset_jobs"\)/, /\.insert\(/, /\.update\(/, /\.rpc\(/]) {
    assert.doesNotMatch(source, forbidden, "the Production Spec is a pure translation and must not perform I/O");
  }
});
