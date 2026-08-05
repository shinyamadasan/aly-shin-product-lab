import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  ASSET_GENERATION_IMAGE_DIMENSIONS,
  buildAssetGenerationSpec,
  deriveBrandStyle,
  type AssetGenerationSpecV1,
} from "../src/lib/asset-generation-spec.ts";
import { fromCreativePackageRow, type CreativePackageRow } from "../src/lib/creative-packages.ts";
import type { BrandBible } from "../src/lib/marketing-advisor-context.ts";
import type { AssetKind } from "../src/lib/asset-jobs.ts";

function creativePackageRow(overrides: Partial<CreativePackageRow> = {}): CreativePackageRow {
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
    ...overrides,
  };
}

const brandBible: BrandBible = {
  mission: "Make everyday moments warmer.",
  positioning: { current: ["Home-based"], future: ["Cafe"] },
  targetAudience: ["Remote workers"],
  tone: ["Friendly", "Warm"],
  writingPrinciples: ["Keep language simple."],
  prohibitedPatterns: ["Buy now"],
};

test("buildAssetGenerationSpec creates a deterministic v1 image spec with generation intent", () => {
  const creativePackage = fromCreativePackageRow(creativePackageRow());
  const spec = buildAssetGenerationSpec(creativePackage, { assetKind: "image", brandBible });

  assert.equal(spec.schemaVersion, "v1");
  assert.equal(spec.assetKind, "image");
  assert.equal(spec.sourceCreativePackageId, "package-1");
  assert.deepEqual(spec.generationIntent, {
    purpose: "marketing-social-feed",
    outcome: "single-image",
  } satisfies AssetGenerationSpecV1["generationIntent"]);
  assert.deepEqual(spec.copy, {
    headline: "Launch-ready Brownies content",
    caption: "Brownies are ready.",
  });
  assert.deepEqual(spec.dimensions, ASSET_GENERATION_IMAGE_DIMENSIONS);
  assert.deepEqual(spec.brandStyle, deriveBrandStyle(brandBible));
});

test("buildAssetGenerationSpec leaves brandStyle null when no BrandBible is supplied", () => {
  const spec = buildAssetGenerationSpec(fromCreativePackageRow(creativePackageRow()), { assetKind: "image" });

  assert.equal(spec.brandStyle, null);
});

test("buildAssetGenerationSpec rejects unsupported asset kinds and non-v1 package content", () => {
  const creativePackage = fromCreativePackageRow(creativePackageRow());
  assert.throws(
    () => buildAssetGenerationSpec(creativePackage, { assetKind: "video" as AssetKind }),
    /only supports image assets/,
  );

  const malformed = fromCreativePackageRow(creativePackageRow({ content: { output: { headline: "Missing metadata" } } }));
  assert.throws(() => buildAssetGenerationSpec(malformed, { assetKind: "image" }), /requires Creative Package content v1/);
});

test("buildAssetGenerationSpec is deterministic and does not mutate its input package", () => {
  const creativePackage = fromCreativePackageRow(creativePackageRow());
  const before = JSON.stringify(creativePackage);

  const first = buildAssetGenerationSpec(creativePackage, { assetKind: "image", brandBible });
  const second = buildAssetGenerationSpec(creativePackage, { assetKind: "image", brandBible });

  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(creativePackage), before);
});

test("asset-generation-spec stays pure and provider agnostic", () => {
  const source = readFileSync(new URL("../src/lib/asset-generation-spec.ts", import.meta.url), "utf8");

  for (const forbidden of [
    /\bawait\b/,
    /Math\.random\s*\(/,
    /Date\.now\s*\(/,
    /new Date\s*\(/,
    /\bfetch\s*\(/,
    /readFile/i,
    /writeFile/i,
    /@supabase\/supabase-js/i,
    /OpenAI/i,
    /Gemini/i,
    /Veo/i,
    /Runway/i,
    /Remotion/i,
    /storageBucket|storagePath|publicUrl/,
  ]) {
    assert.doesNotMatch(source, forbidden);
  }
});
