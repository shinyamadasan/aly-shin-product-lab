import test from "node:test";
import assert from "node:assert/strict";
import {
  fromCreativePackageRow,
  isCreativePackageContentV1,
  isCreativePackageContentV2,
  validateCreativePackageContentV2,
  CREATIVE_FORMATS,
  CREATIVE_PACKAGE_SCHEMA_VERSIONS,
  CREATIVE_PLATFORMS,
  type CreativeCarouselPackageV2,
  type CreativePackageContentV1,
  type CreativePackageContentV2,
  type CreativePackageMetadataV2,
  type CreativePackageRecord,
  type CreativePhotoPackageV2,
  type CreativeReelPackageV2,
  type CreativeStoryPackageV2,
} from "../src/lib/creative-packages.ts";
import { buildAssetGenerationSpec, deriveVisualDirection } from "../src/lib/asset-generation-spec.ts";
import { renderAssetGenerationBrief } from "../src/lib/asset-generation-brief.ts";

// Content Creation MVP S2 -- the format-aware Creative Package contract. S2 defines WHAT a finished
// package is; it does not generate one. No production path emits v2 yet, so these tests are the
// guarantee that future narrowing is safe.

function metadata(overrides: Partial<CreativePackageMetadataV2> = {}): CreativePackageMetadataV2 {
  return {
    generatedFromOpportunity: "opportunity-1",
    generatorVersion: "2",
    sourceCreativeJobId: "job-1",
    sourceWorker: "mock",
    sourceJobResultSchemaVersion: "v2",
    formatChosenBy: "ai",
    formatRationale: "Strong visual product moment.",
    subjectSource: "stated",
    subjectGrounding: null,
    ...overrides,
  };
}

function base() {
  return {
    schemaVersion: "v2" as const,
    subject: "Biscoff Blondie",
    angle: "The recipe changed and here is why",
    hook: "We changed the blondie recipe.",
    headline: "New Biscoff Blondie",
    caption: "Brown butter, Biscoff swirl, baked this morning.",
    cta: "Order for Saturday pickup",
    platformVariants: [{ platform: "instagram" as const, caption: "Baked this morning.", hashtags: ["#blondies"] }],
    metadata: metadata(),
  };
}

function photo(overrides: Partial<CreativePhotoPackageV2> = {}): CreativePhotoPackageV2 {
  return { ...base(), format: "photo", visualDirection: "Overhead shot of a cut blondie on parchment.", overlayText: null, ...overrides };
}
function reel(overrides: Partial<CreativeReelPackageV2> = {}): CreativeReelPackageV2 {
  return {
    ...base(),
    format: "reel",
    shots: [
      { direction: "Batter pouring into the tin", onScreenText: "step one" },
      { direction: "Crack shot as it comes out", onScreenText: null },
    ],
    spokenScript: null,
    audioDirection: "Upbeat trending audio, no voiceover.",
    targetDurationSeconds: 15,
    ...overrides,
  };
}
function carousel(overrides: Partial<CreativeCarouselPackageV2> = {}): CreativeCarouselPackageV2 {
  return {
    ...base(),
    format: "carousel",
    slides: [
      { heading: "What changed", body: "More brown butter.", visualDirection: "Cover shot of the tray" },
      { heading: "Order", body: "Saturday pickup.", visualDirection: "Close-up of the box" },
    ],
    ...overrides,
  };
}
function story(overrides: Partial<CreativeStoryPackageV2> = {}): CreativeStoryPackageV2 {
  return {
    ...base(),
    format: "story",
    frames: [
      { visualDirection: "Tray coming out of the oven", text: "Fresh out" },
      { visualDirection: "Boxed and ready", text: "Order by 5pm" },
    ],
    interaction: "Poll: blondies or brownies?",
    ...overrides,
  };
}

function v1Content(overrides: Partial<CreativePackageContentV1> = {}): CreativePackageContentV1 {
  return {
    output: { headline: "V1 headline", caption: "V1 caption" },
    metadata: {
      generatedFromOpportunity: "opportunity-1",
      generatorVersion: "1",
      sourceCreativeJobId: "job-1",
      sourceWorker: "mock",
      sourceJobResultSchemaVersion: "v1",
    },
    artifacts: [],
    ...overrides,
  };
}

function packageRecord(content: unknown, schemaVersion: "v1" | "v2"): CreativePackageRecord {
  return {
    id: "package-1",
    creativeJobId: "job-1",
    status: "ready",
    schemaVersion,
    content: content as CreativePackageRecord["content"],
    createdAt: "2026-08-12T09:00:00.000Z",
    updatedAt: "2026-08-12T09:00:00.000Z",
  };
}

// ---- A-D: each format accepts ----

test("a valid v2 package of each format is accepted", () => {
  for (const content of [photo(), reel(), carousel(), story()] as CreativePackageContentV2[]) {
    const result = validateCreativePackageContentV2(content);
    assert.equal(result.ok, true, `${content.format} should validate: ${result.ok ? "" : result.message}`);
    assert.ok(isCreativePackageContentV2(content));
  }
});

test("the format union and platform vocabulary are exactly the frozen sets", () => {
  assert.deepEqual([...CREATIVE_FORMATS], ["photo", "reel", "carousel", "story"]);
  assert.deepEqual([...CREATIVE_PLATFORMS], ["instagram", "facebook", "tiktok"]);
  assert.deepEqual([...CREATIVE_PACKAGE_SCHEMA_VERSIONS], ["v1", "v2"]);
  // YouTube is deliberately absent -- no v2 format targets it.
  assert.ok(!(CREATIVE_PLATFORMS as readonly string[]).includes("youtube"));
});

// ---- E-H: rejection ----

test("empty required base strings are rejected, field by field", () => {
  for (const field of ["subject", "angle", "hook", "headline", "caption", "cta"] as const) {
    const result = validateCreativePackageContentV2({ ...photo(), [field]: "   " });
    assert.equal(result.ok, false, `blank ${field} must be rejected`);
    if (!result.ok) assert.equal(result.reason, "malformed-base");
  }
});

test("an unsupported format is rejected", () => {
  for (const bad of ["video", "", "PHOTO", null, 7]) {
    const result = validateCreativePackageContentV2({ ...photo(), format: bad });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "unsupported-format");
  }
});

test("an unsupported schemaVersion is rejected -- v1 content never validates as v2", () => {
  assert.equal(validateCreativePackageContentV2(v1Content()).ok, false);
  assert.equal(validateCreativePackageContentV2({ ...photo(), schemaVersion: "v1" }).ok, false);
  assert.equal(validateCreativePackageContentV2({ ...photo(), schemaVersion: "v3" }).ok, false);
});

test("platform variants reject unsupported platforms, blank captions and malformed hashtags", () => {
  const cases: unknown[] = [
    [{ platform: "youtube", caption: "c", hashtags: [] }],
    [{ platform: "instagram", caption: "  ", hashtags: [] }],
    [{ platform: "instagram", caption: "c", hashtags: "not-an-array" }],
    [{ platform: "instagram", caption: "c", hashtags: [1, 2] }],
    "not-an-array",
  ];
  for (const platformVariants of cases) {
    const result = validateCreativePackageContentV2({ ...photo(), platformVariants });
    assert.equal(result.ok, false, `variants ${JSON.stringify(platformVariants)} must be rejected`);
    if (!result.ok) assert.equal(result.reason, "malformed-platform-variants");
  }
});

test("an empty platformVariants array is allowed -- a package for one unconfigured platform is legitimate", () => {
  assert.equal(validateCreativePackageContentV2({ ...photo(), platformVariants: [] }).ok, true);
});

test("malformed metadata is rejected, including invalid formatChosenBy and subjectSource", () => {
  const bad: Array<Partial<CreativePackageMetadataV2>> = [
    { generatorVersion: "1" as never },
    { sourceJobResultSchemaVersion: "v1" as never },
    { formatChosenBy: "robot" as never },
    { subjectSource: "guessed" as never },
    { sourceCreativeJobId: "  " },
    { formatRationale: "" },
    { sourceWorker: "not_a_worker" as never },
    { generatedFromOpportunity: "   " },
  ];
  for (const overrides of bad) {
    const result = validateCreativePackageContentV2({ ...photo(), metadata: metadata(overrides) });
    assert.equal(result.ok, false, `metadata ${JSON.stringify(overrides)} must be rejected`);
    if (!result.ok) assert.equal(result.reason, "malformed-metadata");
  }
});

test('an "assumed" subject without grounding is rejected -- an assumption must state its basis', () => {
  assert.equal(validateCreativePackageContentV2({ ...photo(), metadata: metadata({ subjectSource: "assumed", subjectGrounding: null }) }).ok, false);
  assert.equal(validateCreativePackageContentV2({ ...photo(), metadata: metadata({ subjectSource: "assumed", subjectGrounding: "  " }) }).ok, false);
  assert.equal(
    validateCreativePackageContentV2({ ...photo(), metadata: metadata({ subjectSource: "assumed", subjectGrounding: "38 days since the last post." }) }).ok,
    true,
  );
});

test("format-specific fields are genuinely discriminating", () => {
  const cases: Array<[string, unknown]> = [
    ["photo without visualDirection", { ...photo(), visualDirection: "" }],
    ["photo with non-string overlayText", { ...photo(), overlayText: 5 }],
    ["reel with no shots", { ...reel(), shots: [] }],
    ["reel with malformed shot", { ...reel(), shots: [{ direction: "", onScreenText: null }] }],
    ["reel with zero duration", { ...reel(), targetDurationSeconds: 0 }],
    ["reel with NaN duration", { ...reel(), targetDurationSeconds: Number.NaN }],
    ["reel with non-numeric duration", { ...reel(), targetDurationSeconds: "15" }],
    ["reel missing audioDirection", { ...reel(), audioDirection: " " }],
    ["carousel with no slides", { ...carousel(), slides: [] }],
    ["carousel with blank slide body", { ...carousel(), slides: [{ heading: "h", body: "", visualDirection: "v" }] }],
    ["story with no frames", { ...story(), frames: [] }],
    ["story with blank frame text", { ...story(), frames: [{ visualDirection: "v", text: "" }] }],
    ["story with non-string interaction", { ...story(), interaction: 3 }],
  ];
  for (const [label, content] of cases) {
    const result = validateCreativePackageContentV2(content);
    assert.equal(result.ok, false, `${label} must be rejected`);
    if (!result.ok) assert.equal(result.reason, "malformed-format-fields", label);
  }
});

test("one format's fields cannot satisfy another's -- the discriminant genuinely selects the rules", () => {
  // A reel body relabelled as a photo has no visualDirection, so the photo rules reject it.
  const reelShaped: Record<string, unknown> = { ...reel(), format: "photo" };
  assert.equal(validateCreativePackageContentV2(reelShaped).ok, false);
  // A photo body relabelled as a reel has no shots, so the reel rules reject it.
  assert.equal(validateCreativePackageContentV2({ ...photo(), format: "reel" }).ok, false);
});

// ---- I, J, O: v1 compatibility and guard discrimination ----

test("v1 content remains valid and is never reinterpreted as v2", () => {
  assert.ok(isCreativePackageContentV1(v1Content()));
  assert.ok(!isCreativePackageContentV2(v1Content()));
});

test("v2 content is never accepted by the v1 guard", () => {
  for (const content of [photo(), reel(), carousel(), story()]) {
    assert.ok(!isCreativePackageContentV1(content), `${content.format} must not pass the v1 guard`);
  }
});

test("v1 request-backed content (generatedFromOpportunity null) is still valid -- S1 preserved", () => {
  assert.ok(isCreativePackageContentV1(v1Content({ metadata: { ...v1Content().metadata, generatedFromOpportunity: null } })));
});

// ---- M, N: v2 origin compatibility ----

test("a v2 package from a manual Creative Job (generatedFromOpportunity null) is structurally legitimate", () => {
  assert.equal(validateCreativePackageContentV2({ ...photo(), metadata: metadata({ generatedFromOpportunity: null }) }).ok, true);
});

test("a v2 package from an Opportunity-backed job remains valid", () => {
  assert.equal(validateCreativePackageContentV2({ ...photo(), metadata: metadata({ generatedFromOpportunity: "opportunity-9" }) }).ok, true);
});

// ---- K, L: asset-generation compatibility ----

test("a v1 package still produces its exact pre-S2 asset spec, with no visual direction", () => {
  const spec = buildAssetGenerationSpec(packageRecord(v1Content(), "v1"), { assetKind: "image" });

  assert.deepEqual(spec.copy, { headline: "V1 headline", caption: "V1 caption" });
  assert.equal(spec.visualDirection, null);
  assert.equal(spec.schemaVersion, "v1");
  assert.equal(spec.sourceCreativePackageId, "package-1");
});

test("a v1 brief renders byte-identically to the pre-S2 text", () => {
  const spec = buildAssetGenerationSpec(packageRecord(v1Content(), "v1"), { assetKind: "image" });
  const expected = [
    "Create one marketing image, exactly 1080x1080 pixels (1:1).",
    "",
    "Headline: V1 headline",
    "Caption: V1 caption",
    "",
    "Do not add text overlays to the image unless explicitly requested.",
  ].join("\n");

  assert.equal(renderAssetGenerationBrief(spec), expected);
});

test("every v2 format produces a usable asset spec through the existing pipeline", () => {
  for (const content of [photo(), reel(), carousel(), story()] as CreativePackageContentV2[]) {
    const spec = buildAssetGenerationSpec(packageRecord(content, "v2"), { assetKind: "image" });
    assert.equal(spec.copy.headline, content.headline, `${content.format} headline`);
    assert.equal(spec.copy.caption, content.caption, `${content.format} caption`);
    assert.ok(spec.visualDirection && spec.visualDirection.length > 0, `${content.format} visual direction`);
    // Still one image: S2 does not introduce reel/carousel media production.
    assert.deepEqual(spec.generationIntent, { purpose: "marketing-social-feed", outcome: "single-image" });
  }
});

test("the package -> visual direction mapping is deterministic and matches the documented rule", () => {
  assert.equal(deriveVisualDirection(photo()), "Overhead shot of a cut blondie on parchment.");
  assert.equal(deriveVisualDirection(reel()), "Batter pouring into the tin; Crack shot as it comes out");
  assert.equal(deriveVisualDirection(carousel()), "Cover shot of the tray; Close-up of the box");
  assert.equal(deriveVisualDirection(story()), "Tray coming out of the oven; Boxed and ready");
  // Same input, same output -- no clock, no randomness, no AI.
  assert.equal(deriveVisualDirection(reel()), deriveVisualDirection(reel()));
});

test("a v2 brief includes the visual direction, and a v1 brief does not", () => {
  const v2Spec = buildAssetGenerationSpec(packageRecord(photo(), "v2"), { assetKind: "image" });
  const v1Spec = buildAssetGenerationSpec(packageRecord(v1Content(), "v1"), { assetKind: "image" });

  assert.match(renderAssetGenerationBrief(v2Spec), /Visual direction: Overhead shot of a cut blondie on parchment\./);
  assert.doesNotMatch(renderAssetGenerationBrief(v1Spec), /Visual direction/);
});

test("content that is neither v1 nor v2 is still refused by the asset boundary", () => {
  assert.throws(
    () => buildAssetGenerationSpec(packageRecord({ nonsense: true }, "v1"), { assetKind: "image" }),
    /requires Creative Package content v1 or v2/,
  );
});

test("a non-image asset kind is still refused before any content check", () => {
  assert.throws(() => buildAssetGenerationSpec(packageRecord(photo(), "v2"), { assetKind: "video" as never }), /only supports image assets/);
});

// ---- P: persistence round-trip ----

test("a stored v2 schema_version survives the row mapping instead of collapsing to v1", () => {
  // Regression guard. parseCreativePackageSchemaVersion previously returned "v1" for every input
  // (`value === "v1" ? "v1" : "v1"`), so a persisted v2 package would have been read back as v1 --
  // silently reinterpreting one contract as the other, which is exactly what §11 forbids.
  const row = {
    id: "package-1",
    creative_job_id: "job-1",
    status: "ready" as const,
    schema_version: "v2" as const,
    content: photo() as unknown as Record<string, unknown>,
    created_at: "2026-08-12T09:00:00.000Z",
    updated_at: "2026-08-12T09:00:00.000Z",
  };

  const record = fromCreativePackageRow(row);
  assert.equal(record.schemaVersion, "v2");
  assert.ok(isCreativePackageContentV2(record.content));

  // v1 rows are unaffected, including rows written before the column carried meaning.
  assert.equal(fromCreativePackageRow({ ...row, schema_version: "v1" as const, content: v1Content() as unknown as Record<string, unknown> }).schemaVersion, "v1");
  assert.equal(fromCreativePackageRow({ ...row, schema_version: "nonsense" as never }).schemaVersion, "v1");
});
