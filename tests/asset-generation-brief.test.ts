import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { briefSha256, renderAssetGenerationBrief } from "../src/lib/asset-generation-brief.ts";
import { sha256Hex } from "../src/lib/asset-digest.ts";
import { buildAssetGenerationSpec } from "../src/lib/asset-generation-spec.ts";
import { fromCreativePackageRow, type CreativePackageRow } from "../src/lib/creative-packages.ts";
import type { BrandBible } from "../src/lib/marketing-advisor-context.ts";

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

function spec() {
  return buildAssetGenerationSpec(fromCreativePackageRow(creativePackageRow()), { assetKind: "image", brandBible });
}

function specWithoutBrand() {
  return buildAssetGenerationSpec(fromCreativePackageRow(creativePackageRow()), { assetKind: "image" });
}

function specWithDifferentCopy() {
  const row = creativePackageRow();
  const content = {
    ...(row.content as Record<string, unknown>),
    output: { headline: "Different headline", caption: "Different caption." },
  };
  return buildAssetGenerationSpec(fromCreativePackageRow({ ...row, content }), { assetKind: "image", brandBible });
}

test("renderAssetGenerationBrief includes the headline, caption, and exact requested dimensions", () => {
  const text = renderAssetGenerationBrief(spec());
  assert.match(text, /1080x1080/);
  assert.match(text, /Launch-ready Brownies content/);
  assert.match(text, /Brownies are ready\./);
});

test("renderAssetGenerationBrief includes brand tone, writing principles, and prohibited patterns when present", () => {
  const text = renderAssetGenerationBrief(spec());
  assert.match(text, /Friendly/);
  assert.match(text, /Warm/);
  assert.match(text, /Keep language simple\./);
  assert.match(text, /Buy now/);
});

test("renderAssetGenerationBrief always instructs against unrequested text overlays", () => {
  const text = renderAssetGenerationBrief(spec());
  assert.match(text, /Do not add text overlays to the image unless explicitly requested\./);
});

test("renderAssetGenerationBrief without brand style produces the exact expected text, including the no-overlay instruction", () => {
  const text = renderAssetGenerationBrief(specWithoutBrand());
  assert.equal(
    text,
    [
      "Create one marketing image, exactly 1080x1080 pixels (1:1).",
      "",
      "Headline: Launch-ready Brownies content",
      "Caption: Brownies are ready.",
      "",
      "Do not add text overlays to the image unless explicitly requested.",
    ].join("\n"),
  );
});

test("renderAssetGenerationBrief omits brand-style sections entirely when brandStyle is null", () => {
  const text = renderAssetGenerationBrief(specWithoutBrand());
  assert.doesNotMatch(text, /Brand tone/);
  assert.doesNotMatch(text, /Writing principles/);
  assert.doesNotMatch(text, /Avoid/);
});

test("renderAssetGenerationBrief is deterministic, and reflects a genuinely different headline/caption", () => {
  const first = renderAssetGenerationBrief(spec());
  const second = renderAssetGenerationBrief(spec());
  assert.equal(first, second);
  assert.notEqual(renderAssetGenerationBrief(specWithDifferentCopy()), first);
});

test("briefSha256 hashes exactly the text renderAssetGenerationBrief produces -- never a different representation", async () => {
  const theSpec = spec();
  const expected = await sha256Hex(new TextEncoder().encode(renderAssetGenerationBrief(theSpec)));
  assert.equal(await briefSha256(theSpec), expected);
});

test("briefSha256 is deterministic for the same spec, and differs when the brief text differs", async () => {
  const first = await briefSha256(spec());
  const second = await briefSha256(spec());
  assert.equal(first, second);
  assert.notEqual(await briefSha256(specWithoutBrand()), first);
  assert.notEqual(await briefSha256(specWithDifferentCopy()), first);
});

test("asset-generation-brief makes no network call, reads no file, and names no provider", () => {
  const source = readFileSync(new URL("../src/lib/asset-generation-brief.ts", import.meta.url), "utf8");

  for (const forbidden of [
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
    /Midjourney/i,
    /Canva/i,
  ]) {
    assert.doesNotMatch(source, forbidden);
  }
});
