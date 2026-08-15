import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { buildCreativeInputFromRequest } from "../src/lib/creative-input.ts";
import { CREATIVE_FORMATS, type CreativeFormat } from "../src/lib/creative-formats.ts";
import { CREATIVE_FRAMINGS, CREATIVE_MOVEMENTS } from "../src/lib/creative-production-guidance.ts";
import { buildCreativeBodyJsonSchema, validateCreativeBody, type CreativeProductionConstraint } from "../src/lib/creative-generation/contracts.ts";
import { assembleCreativePackageV2 } from "../src/lib/creative-generation/assemble.ts";
import {
  validateCreativePackageContentV2,
  type CreativeCarouselPackageV2,
  type CreativePackageMetadataV2,
  type CreativePhotoPackageV2,
  type CreativeReelPackageV2,
  type CreativeStoryPackageV2,
} from "../src/lib/creative-package-content-v2.ts";
import { buildCreativePackageView } from "../src/lib/creative-package-view.ts";
import type { ResolvedCreativeGrounding } from "../src/lib/creative-subject-resolution.ts";

// Content Creation MVP S6, structured production guidance. Pure: no AI, no network, no clock.
//
// The whole slice rests on one asymmetry, and most of what follows tests it from one side or the
// other: the GENERATION contract REQUIRES the new fields, so nothing produced from S6 onward can
// omit them, while the STORED contract treats them as optional, so every package written before S6
// stays readable without a migration or a schemaVersion bump.

// --- fixtures ------------------------------------------------------------------------------------

function grounding(): ResolvedCreativeGrounding {
  return {
    subject: "Biscoff Blondies",
    subjectKind: "product",
    subjectSource: "stated",
    subjectGrounding: null,
    productId: "blondies",
    productName: "Biscoff Blondies",
    supportingFacts: ["Biscoff Blondies are in the catalog."],
  };
}

function commonBody() {
  return {
    angle: "The corner piece everyone fights over",
    hook: "The edges are the best part.",
    headline: "Corner pieces only",
    caption: "Three batches in.",
    cta: "Tell us which piece you would take.",
    platformVariants: [],
    // H1-B -- required on every generated body. Every S6 fixture here is camera work.
    productionSource: "capture_new",
  };
}

// S6 bodies: every required production field present, and the Reel carrying NO authored total.
function bodyFor(format: CreativeFormat): Record<string, unknown> {
  const base = commonBody();
  if (format === "photo") {
    return { ...base, visualDirection: "One blondie on a plate beside the coffee.", overlayText: "Afternoon, sorted.", framing: "close_up" };
  }
  if (format === "reel") {
    return {
      ...base,
      shots: [
        { direction: "Lift one blondie from the tray.", onScreenText: "batch three", approxSeconds: 2, framing: "close_up", movement: "push_in" },
        { direction: "Show the full tray cut into squares.", onScreenText: null, approxSeconds: 3, framing: "overhead", movement: null },
      ],
      spokenScript: null,
      audioDirection: "Quiet kitchen sound, no music.",
    };
  }
  if (format === "carousel") {
    return {
      ...base,
      slides: [{ heading: "Three batches in", body: "Still adjusting.", visualDirection: "Full tray on the counter.", framing: "wide" }],
    };
  }
  return {
    ...base,
    frames: [
      { visualDirection: "One blondie on the cooling rack.", text: "batch three", framing: "close_up", approxSeconds: null },
      { visualDirection: "Cut the tray into squares.", text: "nearly there", framing: "overhead", approxSeconds: 3 },
    ],
    interaction: null,
  };
}

function assemble(format: CreativeFormat, body: unknown = bodyFor(format)) {
  return assembleCreativePackageV2({
    creativeInput: buildCreativeInputFromRequest({ text: "make something" }),
    grounding: grounding(),
    decision: { format, formatRationale: "Chosen for the test." },
    formatChosenBy: "ai",
    body,
    sourceCreativeJobId: "job-1",
    sourceWorker: "mock",
  });
}

function assembled(format: CreativeFormat) {
  const result = assemble(format);
  assert.equal(result.ok, true, result.ok ? "" : result.message);
  if (!result.ok) throw new Error("unreachable");
  return result.content;
}

// --- pre-S6 stored fixtures ----------------------------------------------------------------------
//
// Hand-written to match what the database actually holds for packages generated before this slice:
// valid v2 in every respect, and carrying not one S6 key.

function metadata(): CreativePackageMetadataV2 {
  return {
    generatedFromOpportunity: null,
    generatorVersion: "2",
    sourceCreativeJobId: "job-legacy",
    sourceWorker: "creative_ai",
    sourceJobResultSchemaVersion: "v2",
    formatChosenBy: "ai",
    formatRationale: "A single strong image suits a first-look product post.",
    subjectSource: "stated",
    subjectGrounding: null,
  };
}

const legacyBase = {
  schemaVersion: "v2" as const,
  subject: "Biscoff Blondies",
  angle: "The corner piece everyone fights over",
  hook: "The edges are the best part.",
  headline: "Corner pieces only",
  caption: "Chewy middles and crisp edges.",
  cta: "Message us to reserve a tray.",
  platformVariants: [],
  metadata: metadata(),
};

const legacyPhoto: CreativePhotoPackageV2 = {
  ...legacyBase,
  format: "photo",
  visualDirection: "Overhead on the wooden board, morning window light.",
  overlayText: null,
};

const legacyReel: CreativeReelPackageV2 = {
  ...legacyBase,
  format: "reel",
  shots: [
    { direction: "Close on the tray coming out of the oven.", onScreenText: "Fresh out" },
    { direction: "Hands cutting the first corner piece.", onScreenText: null },
  ],
  spokenScript: null,
  audioDirection: "Quiet kitchen sound, no music.",
  targetDurationSeconds: 12,
};

const legacyCarousel: CreativeCarouselPackageV2 = {
  ...legacyBase,
  format: "carousel",
  slides: [{ heading: "Start with browned butter", body: "It is the whole flavour.", visualDirection: "Pan of browned butter, close." }],
};

const legacyStory: CreativeStoryPackageV2 = {
  ...legacyBase,
  format: "story",
  frames: [{ visualDirection: "Tray on the counter, phone held above.", text: "Baking day" }],
  interaction: null,
};

const LEGACY_PACKAGES = [legacyPhoto, legacyReel, legacyCarousel, legacyStory];

function viewOf(content: unknown) {
  const result = buildCreativePackageView(content);
  assert.equal(result.ok, true, result.ok ? "" : result.message);
  if (!result.ok) throw new Error("unreachable");
  return result.view;
}

function reelBodyWithShot(shot: Record<string, unknown>): Record<string, unknown> {
  return { ...bodyFor("reel"), shots: [shot] };
}

function baseShot() {
  return { direction: "Lift one blondie from the tray.", onScreenText: null, approxSeconds: 2, framing: "close_up", movement: null };
}

// Deletes a key entirely rather than setting it to undefined, because "the key is absent" and "the
// key is present and undefined" are different inputs and only the first models a pre-S6 package.
function without(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const copy = { ...value };
  delete copy[key];
  return copy;
}

// =================================================================================================
// A. MODEL CONTRACT -- the strict half of the asymmetry
// =================================================================================================

// H1-B narrowed this from "framing is always required" to "framing is required wherever a camera is
// certain". The capture constraint below is what S6 implicitly assumed for every request, so
// asserting against it keeps this test measuring exactly what it always measured.
const CAPTURE_ONLY: CreativeProductionConstraint = { formats: CREATIVE_FORMATS, productionSources: ["capture_new"] };

test("A. the generation schema requires the new production keys on exactly the formats that have them", () => {
  const required = (format: CreativeFormat) => buildCreativeBodyJsonSchema(format, CAPTURE_ONLY).required as string[];
  const itemsOf = (format: CreativeFormat, field: string, constraint = CAPTURE_ONLY) => {
    const properties = buildCreativeBodyJsonSchema(format, constraint).properties as Record<string, { items?: Record<string, unknown> }>;
    return properties[field].items as { required: string[]; properties: Record<string, unknown> };
  };

  // Photo's framing is a top-level field; the other three carry it per item.
  assert.ok(required("photo").includes("framing"));

  assert.deepEqual(itemsOf("reel", "shots").required, ["direction", "onScreenText", "approxSeconds", "framing", "movement"]);
  assert.deepEqual(itemsOf("carousel", "slides").required, ["heading", "body", "visualDirection", "framing"]);
  assert.deepEqual(itemsOf("story", "frames").required, ["visualDirection", "text", "approxSeconds", "framing"]);

  // A Reel is filmed whatever the request says, so its schema is capture-shaped with no constraint
  // supplied at all -- productionSourcesForFormat narrows it on the format's own account.
  assert.deepEqual(
    (buildCreativeBodyJsonSchema("reel").properties as Record<string, { items?: { required: string[] } }>).shots?.items?.required,
    ["direction", "onScreenText", "approxSeconds", "framing", "movement"],
  );

  // S6 adds nothing to Carousel beyond framing: no mediaType, no duration, no movement.
  for (const forbidden of ["mediaType", "approxSeconds", "movement", "duration"]) {
    assert.equal(forbidden in itemsOf("carousel", "slides").properties, false, `carousel slides must not carry ${forbidden}`);
  }
  // And Story gains no movement.
  assert.equal("movement" in itemsOf("story", "frames").properties, false);
});

test("A. targetDurationSeconds is no longer part of the MODEL reel body, in the schema or the validator", () => {
  const schema = buildCreativeBodyJsonSchema("reel");
  assert.equal((schema.required as string[]).includes("targetDurationSeconds"), false);
  assert.equal("targetDurationSeconds" in (schema.properties as Record<string, unknown>), false);

  // additionalProperties:false plus the key allowlist means a model that offers a total is rejected
  // outright rather than having it quietly ignored or, worse, stored beside a contradicting sum.
  const withTotal = validateCreativeBody("reel", { ...bodyFor("reel"), targetDurationSeconds: 9 });
  assert.equal(withTotal.ok, false);
  if (withTotal.ok) throw new Error("unreachable");
  assert.equal(withTotal.reason, "unexpected-fields");
  assert.match(withTotal.message, /targetDurationSeconds/);
});

test("A. the framing vocabulary is exactly the four frozen values, everywhere it appears", () => {
  assert.deepEqual([...CREATIVE_FRAMINGS], ["close_up", "medium", "wide", "overhead"]);

  const framingEnum = (schema: Record<string, unknown>) => (schema as { enum: string[] }).enum;
  const photoProperties = buildCreativeBodyJsonSchema("photo").properties as Record<string, Record<string, unknown>>;
  assert.deepEqual(framingEnum(photoProperties.framing), ["close_up", "medium", "wide", "overhead"]);

  // Every frozen value is accepted by the validator, and nothing outside the set is.
  for (const framing of CREATIVE_FRAMINGS) {
    assert.equal(validateCreativeBody("photo", { ...bodyFor("photo"), framing }).ok, true, `${framing} must be accepted`);
  }
  for (const rejected of ["detail", "eye_level", "macro", "low_angle", "high_angle", "banana", "CLOSE_UP", "", null, 3]) {
    assert.equal(validateCreativeBody("photo", { ...bodyFor("photo"), framing: rejected }).ok, false, `${String(rejected)} must be rejected`);
  }
});

test("A. the movement vocabulary is exactly three values plus null -- and 'static' is not one of them", () => {
  assert.deepEqual([...CREATIVE_MOVEMENTS], ["push_in", "pull_back", "pan"]);

  // null is spelled into the schema enum as well as the type, so "no movement" is representable.
  const shots = (buildCreativeBodyJsonSchema("reel").properties as Record<string, { items: { properties: Record<string, unknown> } }>).shots;
  assert.deepEqual((shots.items.properties.movement as { enum: unknown[] }).enum, ["push_in", "pull_back", "pan", null]);

  for (const movement of [...CREATIVE_MOVEMENTS, null]) {
    assert.equal(validateCreativeBody("reel", reelBodyWithShot({ ...baseShot(), movement })).ok, true, `${String(movement)} must be accepted`);
  }
  // "static" is deliberately absent: null already means it, and naming it would invite the generator
  // to author a movement instruction on every shot.
  for (const rejected of ["static", "zoom", "tilt", "follow", "handheld", "orbit", "", 0]) {
    assert.equal(validateCreativeBody("reel", reelBodyWithShot({ ...baseShot(), movement: rejected })).ok, false, `${String(rejected)} must be rejected`);
  }
});

test("A. a reel shot's movement KEY is required even though its value may be null", () => {
  const { movement, ...withoutMovement } = baseShot();
  void movement;
  assert.equal(validateCreativeBody("reel", reelBodyWithShot(withoutMovement)).ok, false, "an omitted movement key is not a decision");
  assert.equal(validateCreativeBody("reel", reelBodyWithShot({ ...withoutMovement, movement: null })).ok, true);
});

test("A. reel approxSeconds must be an integer from 1 to 10, and is required per shot", () => {
  for (const seconds of [1, 2, 5, 10]) {
    assert.equal(validateCreativeBody("reel", reelBodyWithShot({ ...baseShot(), approxSeconds: seconds })).ok, true, `${seconds} must be accepted`);
  }
  for (const rejected of [0, -1, 11, 60, 2.5, Number.NaN, Number.POSITIVE_INFINITY, "3", null]) {
    assert.equal(
      validateCreativeBody("reel", reelBodyWithShot({ ...baseShot(), approxSeconds: rejected })).ok,
      false,
      `${String(rejected)} must be rejected`,
    );
  }
  const { approxSeconds, ...withoutSeconds } = baseShot();
  void approxSeconds;
  assert.equal(validateCreativeBody("reel", reelBodyWithShot(withoutSeconds)).ok, false, "a shot with no duration is not executable guidance");
});

test("A. story approxSeconds is null (photo) or an integer from 1 to 10 (video), and the key is required", () => {
  const frame = (approxSeconds: unknown) => ({
    ...bodyFor("story"),
    frames: [{ visualDirection: "One blondie on the rack.", text: "batch three", framing: "close_up", approxSeconds }],
  });

  assert.equal(validateCreativeBody("story", frame(null)).ok, true, "null is a still frame, not a missing value");
  for (const seconds of [1, 3, 10]) {
    assert.equal(validateCreativeBody("story", frame(seconds)).ok, true, `${seconds} must be accepted`);
  }
  for (const rejected of [0, 11, 2.5, "3", Number.NaN]) {
    assert.equal(validateCreativeBody("story", frame(rejected)).ok, false, `${String(rejected)} must be rejected`);
  }

  const withoutKey = { ...bodyFor("story"), frames: [{ visualDirection: "One blondie.", text: "batch three", framing: "close_up" }] };
  assert.equal(validateCreativeBody("story", withoutKey).ok, false, "the photo/video decision must be made explicitly");
});

test("A. every format's new production fields are required on the generation path", () => {
  // The generated counterpart of the backward-compatibility tests below: what the READ path tolerates
  // as absent, the GENERATION path refuses.
  const stripped: Array<[CreativeFormat, Record<string, unknown>]> = [
    ["photo", without(bodyFor("photo"), "framing")],
    ["carousel", { ...bodyFor("carousel"), slides: [{ heading: "h", body: "b", visualDirection: "v" }] }],
    ["story", { ...bodyFor("story"), frames: [{ visualDirection: "v", text: "t", approxSeconds: null }] }],
    ["reel", reelBodyWithShot(without(baseShot(), "framing"))],
  ];
  for (const [format, body] of stripped) {
    assert.equal(validateCreativeBody(format, body).ok, false, `${format} must reject a body missing its production guidance`);
  }
});

// =================================================================================================
// B. ASSEMBLER -- nothing generated is silently dropped
// =================================================================================================

test("B. Photo framing survives the assembler's per-format allowlist", () => {
  const content = assembled("photo");
  assert.equal(content.format, "photo");
  if (content.format !== "photo") throw new Error("unreachable");
  assert.equal(content.framing, "close_up");
  assert.equal(content.visualDirection, "One blondie on a plate beside the coffee.");
});

test("B. every reel shot keeps its approxSeconds, framing and movement, including a null movement", () => {
  const content = assembled("reel");
  if (content.format !== "reel") throw new Error("unreachable");
  assert.deepEqual(content.shots, [
    { direction: "Lift one blondie from the tray.", onScreenText: "batch three", approxSeconds: 2, framing: "close_up", movement: "push_in" },
    { direction: "Show the full tray cut into squares.", onScreenText: null, approxSeconds: 3, framing: "overhead", movement: null },
  ]);
  // A null movement must survive as null rather than being dropped to undefined, because the read
  // path distinguishes "decided: no movement" from "pre-S6 package that never decided".
  assert.equal("movement" in content.shots[1], true);
  assert.equal(content.shots[1].movement, null);
});

test("B. Carousel slide framing and Story frame framing/approxSeconds survive assembly", () => {
  const carousel = assembled("carousel");
  if (carousel.format !== "carousel") throw new Error("unreachable");
  assert.deepEqual(carousel.slides, [
    { heading: "Three batches in", body: "Still adjusting.", visualDirection: "Full tray on the counter.", framing: "wide" },
  ]);

  const story = assembled("story");
  if (story.format !== "story") throw new Error("unreachable");
  assert.deepEqual(story.frames, [
    { visualDirection: "One blondie on the cooling rack.", text: "batch three", framing: "close_up", approxSeconds: null },
    { visualDirection: "Cut the tray into squares.", text: "nearly there", framing: "overhead", approxSeconds: 3 },
  ]);
});

test("B. the stored reel total is the SUM of the shot durations, derived rather than authored", () => {
  const content = assembled("reel");
  if (content.format !== "reel") throw new Error("unreachable");
  assert.equal(content.targetDurationSeconds, 5);
  assert.equal(
    content.targetDurationSeconds,
    content.shots.reduce((total, shot) => total + (shot.approxSeconds ?? 0), 0),
  );

  // The relationship holds for any shot list, which is the point: there is exactly one total and it
  // is arithmetic over the shots, so the two can never disagree.
  for (const durations of [[1], [3, 4], [2, 2, 2, 2], [10, 10]]) {
    const body = {
      ...bodyFor("reel"),
      shots: durations.map((approxSeconds, index) => ({ ...baseShot(), direction: `Shot ${index + 1} action.`, approxSeconds })),
    };
    const result = assemble("reel", body);
    assert.equal(result.ok, true, result.ok ? "" : result.message);
    if (!result.ok || result.content.format !== "reel") throw new Error("unreachable");
    assert.equal(result.content.targetDurationSeconds, durations.reduce((a, b) => a + b, 0));
  }
});

test("B. an assembled S6 package still passes the authoritative S2 validator, and stays schemaVersion v2", () => {
  for (const format of CREATIVE_FORMATS) {
    const content = assembled(format);
    assert.equal(content.schemaVersion, "v2", "S6 introduces no v3");
    assert.equal(content.metadata.generatorVersion, "2", "production guidance is not a generator-version bump");
    const validation = validateCreativePackageContentV2(content);
    assert.equal(validation.ok, true, validation.ok ? "" : validation.message);
  }
});

test("B. no mediaType field is introduced anywhere -- format and approxSeconds already carry the medium", () => {
  for (const format of CREATIVE_FORMATS) {
    assert.doesNotMatch(JSON.stringify(assembled(format)), /mediaType/i, `${format} must not carry a mediaType`);
  }
  // Comments are stripped first: the contract modules explain WHY there is no mediaType, and a
  // check that forbade the word outright would forbid the explanation along with the field.
  for (const source of [
    "../src/lib/creative-production-guidance.ts",
    "../src/lib/creative-package-content-v2.ts",
    "../src/lib/creative-generation/contracts.ts",
    "../src/lib/creative-generation/assemble.ts",
  ]) {
    const code = readFileSync(new URL(source, import.meta.url), "utf8")
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    assert.doesNotMatch(code, /mediaType/, `${source} must not define a mediaType`);
  }
});

// =================================================================================================
// C. BACKWARD COMPATIBILITY -- pre-S6 packages keep working, untouched
// =================================================================================================

test("C. a pre-S6 v2 package carrying no S6 field at all still validates", () => {
  for (const content of LEGACY_PACKAGES) {
    const validation = validateCreativePackageContentV2(content);
    assert.equal(validation.ok, true, validation.ok ? "" : `${content.format}: ${validation.message}`);
  }
});

test("C. a pre-S6 v2 package still builds a full CreativePackageView", () => {
  for (const content of LEGACY_PACKAGES) {
    const view = viewOf(content);
    assert.equal(view.subject, "Biscoff Blondies");
    assert.ok(view.production.length > 0, `${content.format} must still produce guidance`);
    assert.ok(view.production[0].blocks.length > 0);
  }
});

test("C. a pre-S6 package renders NO blank S6 row -- absent guidance contributes nothing at all", () => {
  // Photo: the framing lives in the block title, so with no framing the title stays null rather than
  // becoming an empty heading, and the lines are exactly what S5 produced.
  const photoBlock = viewOf(legacyPhoto).production[0].blocks[0];
  assert.equal(photoBlock.title, null);
  assert.deepEqual(photoBlock.lines, [{ label: null, value: "Overhead on the wooden board, morning window light." }]);

  // Reel: plain shot numbers, with no trailing separator and no "Static".
  assert.deepEqual(
    viewOf(legacyReel).production[0].blocks.map((block) => block.title),
    ["Shot 1", "Shot 2"],
  );

  // Story: absence is not a photo/video claim, so the medium is simply not stated.
  assert.deepEqual(
    viewOf(legacyStory).production[0].blocks.map((block) => block.title),
    ["Frame 1"],
  );

  // Nothing anywhere renders a dangling separator, an empty label, or a raw enum value.
  for (const content of LEGACY_PACKAGES) {
    const view = viewOf(content);
    for (const block of view.production.flatMap((section) => section.blocks)) {
      assert.doesNotMatch(block.title ?? "x", /·\s*$|^\s*·|·\s*·/, "no dangling separator");
      assert.doesNotMatch(block.title ?? "", /undefined|null|Static/);
    }
    assert.doesNotMatch(JSON.stringify(view), /close_up|push_in|pull_back|undefined/);
  }
});

// =================================================================================================
// D. READ VALIDATION -- absent is fine, present is judged honestly
// =================================================================================================

test("D. a present-but-invalid framing is rejected on the read path, however old the package is", () => {
  for (const rejected of ["banana", "detail", "eye_level", "CLOSE_UP", "", null, 3]) {
    assert.equal(
      validateCreativePackageContentV2({ ...legacyPhoto, framing: rejected }).ok,
      false,
      `photo framing ${String(rejected)} must be rejected`,
    );
    assert.equal(
      validateCreativePackageContentV2({ ...legacyCarousel, slides: [{ ...legacyCarousel.slides[0], framing: rejected }] }).ok,
      false,
      `carousel framing ${String(rejected)} must be rejected`,
    );
    assert.equal(
      validateCreativePackageContentV2({ ...legacyStory, frames: [{ ...legacyStory.frames[0], framing: rejected }] }).ok,
      false,
      `story framing ${String(rejected)} must be rejected`,
    );
    assert.equal(
      validateCreativePackageContentV2({ ...legacyReel, shots: [{ ...legacyReel.shots[0], framing: rejected }] }).ok,
      false,
      `reel framing ${String(rejected)} must be rejected`,
    );
  }
});

test("D. a present and valid framing is accepted on every format", () => {
  for (const framing of CREATIVE_FRAMINGS) {
    assert.equal(validateCreativePackageContentV2({ ...legacyPhoto, framing }).ok, true);
    assert.equal(validateCreativePackageContentV2({ ...legacyCarousel, slides: [{ ...legacyCarousel.slides[0], framing }] }).ok, true);
    assert.equal(validateCreativePackageContentV2({ ...legacyStory, frames: [{ ...legacyStory.frames[0], framing }] }).ok, true);
    assert.equal(validateCreativePackageContentV2({ ...legacyReel, shots: [{ ...legacyReel.shots[0], framing }] }).ok, true);
  }
});

test("D. reel movement accepts absent, null and the three verbs, and nothing else", () => {
  const withMovement = (movement: unknown) => validateCreativePackageContentV2({ ...legacyReel, shots: [{ ...legacyReel.shots[0], movement }] });
  // Absent is the pre-S6 case and is already covered by test C; null is an explicit decision.
  assert.equal(withMovement(null).ok, true);
  for (const movement of CREATIVE_MOVEMENTS) {
    assert.equal(withMovement(movement).ok, true, `${movement} must be accepted`);
  }
  for (const rejected of ["static", "zoom", "handheld", "", 0]) {
    assert.equal(withMovement(rejected).ok, false, `${String(rejected)} must be rejected`);
  }
});

test("D. a present-but-invalid duration is rejected, and the reel/story nullability difference is honoured", () => {
  const reelSeconds = (approxSeconds: unknown) =>
    validateCreativePackageContentV2({ ...legacyReel, shots: [{ ...legacyReel.shots[0], approxSeconds }] });
  const storySeconds = (approxSeconds: unknown) =>
    validateCreativePackageContentV2({ ...legacyStory, frames: [{ ...legacyStory.frames[0], approxSeconds }] });

  for (const rejected of [0, -1, 11, 2.5, "3", Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(reelSeconds(rejected).ok, false, `reel ${String(rejected)} must be rejected`);
    assert.equal(storySeconds(rejected).ok, false, `story ${String(rejected)} must be rejected`);
  }
  for (const seconds of [1, 5, 10]) {
    assert.equal(reelSeconds(seconds).ok, true);
    assert.equal(storySeconds(seconds).ok, true);
  }

  // A Reel shot always happens, so a null duration is meaningless there. A Story frame's null is the
  // photo/video decision itself.
  assert.equal(reelSeconds(null).ok, false, "a reel shot cannot have a null duration");
  assert.equal(storySeconds(null).ok, true, "a null story duration means a still photo");
});

// =================================================================================================
// F. VIEW -- structured fields drive structured presentation
// =================================================================================================

test("F. Photo renders its framing when present and omits it cleanly when absent", () => {
  const block = viewOf(assembled("photo")).production[0].blocks[0];
  assert.equal(block.title, "Close-up");
  // The framing does not displace the action: visualDirection is still the unlabelled instruction.
  assert.deepEqual(block.lines, [
    { label: null, value: "One blondie on a plate beside the coffee." },
    { label: "Add this text to the photo", value: "Afternoon, sorted." },
  ]);
  assert.equal(viewOf(legacyPhoto).production[0].blocks[0].title, null);
});

test("F. a Reel shot states its duration, framing and movement -- and shows nothing when movement is null", () => {
  const view = viewOf(assembled("reel"));
  assert.deepEqual(
    view.production[0].blocks.map((block) => block.title),
    ["Shot 1 · 2 sec · Close-up · Slow push-in", "Shot 2 · 3 sec · Overhead"],
  );
  // The null-movement shot must not say "Static", and must not leave a trailing separator.
  assert.doesNotMatch(view.production[0].blocks[1].title ?? "", /Static|·\s*$/);

  // The direction itself is untouched by any of it.
  assert.deepEqual(view.production[0].blocks[0].lines, [
    { label: "Do", value: "Lift one blondie from the tray." },
    { label: "Text on screen", value: "batch three" },
  ]);
});

test("F. the Reel total is the package's derived value, shown once in the summary", () => {
  const view = viewOf(assembled("reel"));
  assert.equal(view.durationLabel, "About 5 seconds", "2 + 3, from the assembler");
  assert.equal(
    view.production.some((section) => section.blocks.some((block) => block.lines.some((line) => /second/i.test(line.value)))),
    false,
    "the total must not be repeated as a production line",
  );
});

test("F. every movement enum maps to its own fixed owner-facing phrase", () => {
  const titleFor = (movement: unknown) => {
    const body = reelBodyWithShot({ ...baseShot(), movement });
    const result = assemble("reel", body);
    assert.equal(result.ok, true, result.ok ? "" : result.message);
    if (!result.ok) throw new Error("unreachable");
    return viewOf(result.content).production[0].blocks[0].title;
  };
  assert.equal(titleFor("push_in"), "Shot 1 · 2 sec · Close-up · Slow push-in");
  assert.equal(titleFor("pull_back"), "Shot 1 · 2 sec · Close-up · Slow pull-back");
  assert.equal(titleFor("pan"), "Shot 1 · 2 sec · Close-up · Pan");
  assert.equal(titleFor(null), "Shot 1 · 2 sec · Close-up");
});

test("F. every framing enum maps to its own fixed owner-facing phrase", () => {
  const expected: Record<string, string> = { close_up: "Close-up", medium: "Medium", wide: "Wide", overhead: "Overhead" };
  for (const framing of CREATIVE_FRAMINGS) {
    const result = assemble("photo", { ...bodyFor("photo"), framing });
    assert.equal(result.ok, true, result.ok ? "" : result.message);
    if (!result.ok) throw new Error("unreachable");
    assert.equal(viewOf(result.content).production[0].blocks[0].title, expected[framing]);
  }
});

test("F. Carousel says Photo on every slide, shows framing, and offers no video affordance", () => {
  const view = viewOf(assembled("carousel"));
  assert.deepEqual(
    view.production[0].blocks.map((block) => block.title),
    ["Slide 1 · Photo · Wide"],
  );
  assert.equal(view.durationLabel, null, "a carousel has no duration to state");
  assert.doesNotMatch(JSON.stringify(view.production), /sec\b|second|Video|movement|push-in|pull-back|Pan\b/i);

  // The slide's own lines are unchanged by S6.
  assert.deepEqual(view.production[0].blocks[0].lines, [
    { label: "Show", value: "Full tray on the counter." },
    { label: "Text on slide", value: "Three batches in" },
    { label: null, value: "Still adjusting." },
  ]);
});

test("F. a Story frame renders Photo for a null duration and Video plus the length for a positive one", () => {
  const view = viewOf(assembled("story"));
  assert.deepEqual(
    view.production[0].blocks.map((block) => block.title),
    ["Frame 1 · Photo · Close-up", "Frame 2 · Video · about 3 seconds · Overhead"],
  );
  // A still frame is never given a synthetic duration.
  assert.doesNotMatch(view.production[0].blocks[0].title ?? "", /sec|second/);
  assert.equal(view.durationLabel, null, "only a Reel carries a whole-piece total");
});

// =================================================================================================
// G. NO PARSING -- S5's rule still holds
// =================================================================================================

test("G. generated prose is passed through verbatim, never parsed for the structured values", () => {
  for (const format of CREATIVE_FORMATS) {
    const content = assembled(format);
    const view = viewOf(content);
    const body = bodyFor(format);

    if (content.format === "photo") {
      assert.equal(view.production[0].blocks[0].lines[0].value, body.visualDirection);
    }
    if (content.format === "reel") {
      const shots = body.shots as Array<{ direction: string }>;
      view.production[0].blocks.forEach((block, index) => {
        assert.equal(block.lines[0].value, shots[index].direction, "direction must be verbatim");
      });
    }
    if (content.format === "carousel") {
      const slides = body.slides as Array<{ visualDirection: string }>;
      view.production[0].blocks.forEach((block, index) => {
        assert.equal(block.lines[0].value, slides[index].visualDirection, "visualDirection must be verbatim");
      });
    }
    if (content.format === "story") {
      const frames = body.frames as Array<{ visualDirection: string }>;
      view.production[0].blocks.forEach((block, index) => {
        assert.equal(block.lines[0].value, frames[index].visualDirection, "visualDirection must be verbatim");
      });
    }
  }
});

test("G. the view builder extracts nothing from prose -- no regex, no splitting, no keyword sniffing", () => {
  const viewSource = readFileSync(new URL("../src/lib/creative-package-view.ts", import.meta.url), "utf8");

  // No pattern matching or tokenising of any generated string.
  assert.doesNotMatch(viewSource, /\.match\(|\.replace\(|\.split\(|RegExp|\/[^/\n*]+\/[gimsuy]*\.test\(/);
  // No arithmetic on durations: the total is read back from the package, never recomputed.
  assert.doesNotMatch(viewSource, /reduce\(|Math\.(round|floor|ceil)|toFixed/);
  // The structured values reach the screen through fixed maps resolved by key, not by rewriting.
  assert.match(viewSource, /const FRAMING_LABELS: Record<CreativeFraming, string>/);
  assert.match(viewSource, /const MOVEMENT_LABELS: Record<CreativeMovement, string>/);
});

test("G. the display vocabulary is a fixed map, so the same enum always renders the same words", () => {
  // Two independent packages carrying the same enum must render identically -- there is no model
  // call, no randomness and no context-sensitivity anywhere in the display path.
  const first = viewOf(assembled("reel")).production[0].blocks[0].title;
  const second = viewOf(assembled("reel")).production[0].blocks[0].title;
  assert.equal(first, second);
  assert.equal(first, "Shot 1 · 2 sec · Close-up · Slow push-in");
});

// =================================================================================================
// PROMPT BOUNDARIES ARE PROMPT-ONLY -- the S6-R1/R2/R3 factuality refinements changed no structure
// =================================================================================================

test("E-A/R1. the artifact rule is PROMPT-ONLY -- it reaches no schema, validator, assembler or view", () => {
  // S6-R1 is a factuality refinement, not a contract change. If any of these modules ever needs to
  // know what a "business record" is, the rule has leaked out of the prompt and into the structure,
  // and the structured contract this slice froze has quietly moved.
  for (const source of [
    "../src/lib/creative-generation/contracts.ts",
    "../src/lib/creative-generation/assemble.ts",
    "../src/lib/creative-package-content-v2.ts",
    "../src/lib/creative-package-view.ts",
    "../src/lib/creative-production-guidance.ts",
    "../src/components/create-now.tsx",
  ]) {
    const code = readFileSync(new URL(source, import.meta.url), "utf8");
    assert.doesNotMatch(
      code,
      /business record|business fact|scene prop|notebook|batch notes|experiment log|order sheet|receipt/i,
      `${source} must be untouched by the prop rule`,
    );
    // Same check for S6-R2: an evaluation-state rule that needed a structural field would mean the
    // package had started modelling what the business knows, which is not what v2 describes.
    assert.doesNotMatch(
      code,
      /verdict|evaluation state|still deciding|conclusion has been reached|outcome/i,
      `${source} must be untouched by the outcome rule`,
    );
    // And for S6-R3: field scope is a prompt concern. If a structural module had to know which
    // fields factuality covers, the contract would have grown a notion of "internal" content.
    assert.doesNotMatch(
      code,
      /factuality|absence-of-evidence|non-published|not directly published/i,
      `${source} must be untouched by the field-scope rule`,
    );
  }

  // And the generation contract still asks for exactly the S6 fields, unchanged by R1.
  const reelShot = (buildCreativeBodyJsonSchema("reel").properties as Record<string, { items: { required: string[] } }>).shots.items.required;
  assert.deepEqual(reelShot, ["direction", "onScreenText", "approxSeconds", "framing", "movement"]);
  assert.equal((buildCreativeBodyJsonSchema("reel").required as string[]).includes("targetDurationSeconds"), false);
  // Under the capture constraint S6 always assumed, Photo's framing is required exactly as it was.
  assert.ok((buildCreativeBodyJsonSchema("photo", CAPTURE_ONLY).required as string[]).includes("framing"));
});
