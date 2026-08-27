import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { validateCreativePackageContentV2 } from "../src/lib/creative-package-content-v2.ts";
import { buildProductionSpec } from "../src/lib/production-spec.ts";
import {
  TEMPLATE_REEL_V1_CAPABILITY,
  TEMPLATE_REEL_V1_PROMPT_GUIDANCE,
  validateTemplateReelV1GeneratedBody,
  validateTemplateReelV1PackageContent,
} from "../src/lib/template-reel-v1-capability.ts";
import type { CreativePackageRecord } from "../src/lib/creative-packages.ts";
import { WARM_OPEN_DEFAULT_PROPS } from "../src/remotion/composition-catalog.ts";
import { warmOpenPropsFromProductionSpec } from "../src/remotion/production-spec-bridge.ts";

function textLedTemplateReel(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: "v2",
    format: "reel",
    productionSource: "template_only",
    subject: "brownie",
    angle: "A text-led joke about sharing one brownie.",
    hook: "One brownie. Two people.",
    headline: "The Brownie Split Test",
    caption: "Some halves are more equal than others.",
    cta: "Which half are you taking?",
    platformVariants: [{ platform: "instagram", caption: "One brownie. Two people.", hashtags: ["#brownies"] }],
    metadata: {
      generatedFromOpportunity: null,
      generatorVersion: "2",
      sourceCreativeJobId: "job-1",
      sourceWorker: "mock",
      sourceJobResultSchemaVersion: "v2",
      formatChosenBy: "user",
      formatRationale: "User requested reel.",
      subjectSource: "stated",
      subjectGrounding: null,
    },
    shots: [
      { direction: "First typography beat introduces the setup.", onScreenText: "one brownie. two people.", approxSeconds: 4, movement: null },
      { direction: "Second text beat lands as the reveal.", onScreenText: "somehow one half is always bigger.", approxSeconds: 5, movement: null },
    ],
    spokenScript: null,
    audioDirection: "Silent; no voiceover, music, or sound design.",
    targetDurationSeconds: 9,
    ...overrides,
  };
}

test("D1 Template Reel V1 boundary states the active executor's real duration and consumed fields", () => {
  assert.equal(TEMPLATE_REEL_V1_CAPABILITY.name, "Template Reel V1");
  assert.equal(TEMPLATE_REEL_V1_CAPABILITY.minDurationSeconds, 6);
  assert.equal(TEMPLATE_REEL_V1_CAPABILITY.maxDurationSeconds, 10);
  assert.deepEqual([...TEMPLATE_REEL_V1_CAPABILITY.consumedFields], [
    "headline",
    "shots[0].onScreenText",
    "shots[1].onScreenText",
    "cta",
    "targetDurationSeconds",
  ]);
  assert.match(TEMPLATE_REEL_V1_PROMPT_GUIDANCE, /text-led/);
  assert.match(TEMPLATE_REEL_V1_PROMPT_GUIDANCE, /Do not require custom diagrams/);
  assert.match(TEMPLATE_REEL_V1_PROMPT_GUIDANCE, /6-10 total seconds/);
});

test("production-generated warm-open props are neutral and do not inject the fixed food illustration", () => {
  const content = textLedTemplateReel();
  const spec = buildProductionSpec({ id: "pkg-1", content } as unknown as CreativePackageRecord, { assetKind: "short_video" });
  if (spec.assetKind !== "short_video") throw new Error("expected short_video spec");
  const bridged = warmOpenPropsFromProductionSpec(spec, { brandMark: "Aly & Pon" });

  assert.equal(bridged.props.visualTreatment, "typography_only");
  assert.equal(WARM_OPEN_DEFAULT_PROPS.visualTreatment, "hearth_illustration", "demo/default fixture can still show the old illustration");

  const warmOpen = readFileSync(new URL("../src/remotion/compositions/warm-open.tsx", import.meta.url), "utf8");
  assert.match(warmOpen, /visualTreatment === "hearth_illustration"/);
  assert.match(warmOpen, /<NeutralEditorialAccent \/>/);
});

test("a text-led package compiles through content validation, ProductionSpec, and bridge without product art", () => {
  const content = textLedTemplateReel();
  const contentValidation = validateCreativePackageContentV2(content);
  assert.ok(contentValidation.ok, contentValidation.ok ? "" : contentValidation.message);
  assert.ok(validateTemplateReelV1PackageContent(content).ok);

  const spec = buildProductionSpec({ id: "pkg-1", content } as unknown as CreativePackageRecord, { assetKind: "short_video" });
  assert.equal(spec.assetKind, "short_video");
  if (spec.assetKind !== "short_video") throw new Error("expected short_video spec");
  assert.deepEqual(spec.scenes, [
    { direction: "First typography beat introduces the setup.", text: "one brownie. two people.", approxSeconds: 4 },
    { direction: "Second text beat lands as the reveal.", text: "somehow one half is always bigger.", approxSeconds: 5 },
  ]);

  const bridged = warmOpenPropsFromProductionSpec(spec, { brandMark: "Aly & Pon" });
  assert.deepEqual(bridged.props, {
    visualTreatment: "typography_only",
    kicker: "one brownie. two people.",
    headline: "The Brownie Split Test",
    supportingLine: "somehow one half is always bigger.",
    brandMark: "Aly & Pon",
    cta: "Which half are you taking?",
    durationSeconds: 9,
  });
});

test("a valid v2 package that promises unsupported object/diagram execution is not Template Reel V1-ready", () => {
  const content = textLedTemplateReel({
    shots: [
      {
        direction: "Draw a rounded brownie and animate a dashed dividing line across it.",
        onScreenText: "one brownie. two people.",
        approxSeconds: 4,
        movement: null,
      },
      {
        direction: "Show the lopsided split diagram with yours/mine labels attached to the pieces.",
        onScreenText: "somehow one half is always bigger.",
        approxSeconds: 5,
        movement: null,
      },
    ],
  });

  assert.ok(validateCreativePackageContentV2(content).ok, "generic stored v2 validation remains future-compatible");
  const readiness = validateTemplateReelV1PackageContent(content);
  assert.equal(readiness.ok, false);
  assert.match(readiness.ok ? "" : readiness.message, /cannot execute custom product visuals/);
});

test("generated Template Reel V1 body rejects duration outside warm-open instead of relying on clamp", () => {
  const body = {
    ...textLedTemplateReel(),
    shots: [
      { direction: "First typography beat introduces the setup.", onScreenText: "one", approxSeconds: 5, movement: null },
      { direction: "Second text beat lands as the reveal.", onScreenText: "two", approxSeconds: 6, movement: null },
    ],
  };

  const readiness = validateTemplateReelV1GeneratedBody(body);
  assert.equal(readiness.ok, false);
  assert.match(readiness.ok ? "" : readiness.message, /total duration must be 6-10 seconds/);
});
