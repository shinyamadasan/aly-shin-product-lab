import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { buildCreativeInputFromOpportunity, buildCreativeInputFromRequest } from "../src/lib/creative-input.ts";
import { wantsImmediateExecution, wantsNoFreshCapture, wantsSimpleProduction } from "../src/lib/creative-request-intent.ts";
import { resolveCreativeGrounding, type ResolveCreativeGroundingInput } from "../src/lib/creative-subject-resolution.ts";
import { CREATIVE_FORMATS, type CreativeFormat } from "../src/lib/creative-formats.ts";
import { CREATIVE_PRODUCTION_SOURCES, type CreativeProductionSource } from "../src/lib/creative-production-guidance.ts";
import {
  buildCreativeBodyJsonSchema,
  buildFormatDecisionJsonSchema,
  findImpossibleFormatRequest,
  productionSourcesForFormat,
  resolveCreativeProductionConstraint,
  validateCreativeBody,
  validateFormatDecision,
} from "../src/lib/creative-generation/contracts.ts";
import { buildCreativeBodyRequest, buildFormatDecisionRequest } from "../src/lib/creative-generation/prompt.ts";
import { assembleCreativePackageV2 } from "../src/lib/creative-generation/assemble.ts";
import { validateCreativePackageContentV2, type CreativePackageMetadataV2 } from "../src/lib/creative-package-content-v2.ts";
import { buildCreativePackageView, formatCreativePackageForClipboard } from "../src/lib/creative-package-view.ts";
import { BRAND_BIBLE } from "../src/lib/marketing-advisor-context.ts";
import type { MarketingRecommendation } from "../src/lib/marketing-recommendations.ts";
import type { ContentJournalEntry, Product } from "../src/lib/product-lab-types.ts";
import type { OpportunityRecord } from "../src/lib/opportunities.ts";
import type { ResolvedCreativeGrounding } from "../src/lib/creative-subject-resolution.ts";

// Content Creation MVP H1-B -- zero capture and the production-source contract.
//
// The owner-gate failure this slice exists for: "Give me something funny today. I don't have time to
// take photos or videos." produced an excellent plan that opened by telling the owner to photograph
// something. Every rule below is about the difference between WHAT to say and HOW to produce it.
//
// Pure throughout: no AI, no network, no database, no clock of its own.

function request(text: string) {
  return buildCreativeInputFromRequest({ text });
}

// The literal request from the H1-B brief, used wherever "a zero-capture request" is needed.
const ZERO_CAPTURE_REQUEST = "Give me something funny today. I don't have time to take photos or videos.";

// =================================================================================================
// A, B. reading the constraint out of the owner's own words
// =================================================================================================

test("A. clearly expressed refusals of ALL fresh capture are recognised", () => {
  for (const text of [
    // The R2 required-true set, verbatim.
    "I don't have time to take photos or videos.",
    ZERO_CAPTURE_REQUEST,
    "I can't take photos or videos today.",
    "Don't make me shoot anything.",
    "I don't want to capture anything today.",
    "Nothing to shoot today.",
    "Give me something I can post without taking photos or videos.",
    // Equivalent all-capture constructions: both media named in either order, or a medium-generic
    // capture verb that names neither because it covers both.
    "I can't film or take photos today.",
    "No photos or videos today.",
    "I don't want to take photos or videos.",
    "no time to shoot anything",
  ]) {
    assert.equal(wantsNoFreshCapture(request(text)), true, `"${text}" refuses ALL fresh capture`);
  }
});

test("B. silence, and ordinary requests, never imply no-fresh-capture", () => {
  for (const text of [
    "Give me something easy today.",
    "Give me something funny today.",
    "Give me a content idea.",
    "Give me a content idea for this week.",
    "something quick please",
    "keep it simple",
    "a low-effort post",
    "I need something right now",
    "Take a photo of the blondies.",
    "Can we do a video this week?",
    "I want photos of the new tray.",
    // A negation that never reaches a capture word.
    "I don't know what to post.",
  ]) {
    assert.equal(wantsNoFreshCapture(request(text)), false, `"${text}" does not refuse fresh capture`);
  }

  // An Opportunity-backed job carries no owner sentence at all, so it expresses no constraint --
  // the same answer, for the same reason, as the two H1 intent questions.
  // (continued below in the B1 precision test, which owns the sentences that constrain HOW.)
  const fromOpportunity = buildCreativeInputFromOpportunity({
    id: "opportunity-1",
    title: "Create launch-ready product content for Banana Bread",
    summary: "Banana Bread has a launch-marked proof batch.",
    reason: "Rule Engine evidence supports it.",
    evidence: { product: { id: "banana-bread", name: "Banana Bread" } },
  } as unknown as OpportunityRecord);
  assert.equal(wantsNoFreshCapture(fromOpportunity), false);
});

// H1-B-R1/B1. The correction that made this predicate high-precision rather than high-recall.
//
// Every sentence below contains a negation AND a capture word, which is exactly why the original
// generic matcher classified all of them as refusals. None of them refuses fresh capture: each one
// constrains HOW capture should happen, and two of them explicitly ASK for it.
//
// This predicate is the only one in the module that REMOVES capability, so a false positive here is
// not a cosmetic miss -- it strips capture_new, strips Reel, and can hard-reject an explicit
// formatHint before any model runs. Ambiguity must therefore leave capture allowed.
test("B1. sentences that constrain HOW capture happens are not refusals of capture", () => {
  for (const text of [
    "Don't use the same photo as last time.",
    "Don't use old photos — take a new one.",
    "Don't take too many photos.",
    "Don't just take photos; film some video too.",
    "I don't mind taking photos.",
    "No need for video, a photo is fine.",
    "I don't want a boring photo.",
    "Don't film the whole thing, just get one short clip.",
  ]) {
    assert.equal(wantsNoFreshCapture(request(text)), false, `"${text}" constrains how capture happens; it does not forbid it`);
  }
});

// H1-B-R2. The second half of the precision rule: a refusal of ONE medium is not a refusal of all
// capture. Each sentence below is a genuine, clearly expressed restriction -- and each one leaves
// the other medium fully capturable, so none of them may strip capture_new, Reel or the H1-A
// override.
test("R2. a restriction on one medium is not a ban on all fresh capture", () => {
  for (const text of [
    // The R2 required-false set, verbatim.
    "I can't film today.",
    "No photos today.",
    "No video today.",
    "I don't have time to take photos.",
    "I don't want to record anything.",
    "Skip the photos.",
    "Give me something with no video.",
    // Same shape, other wordings.
    "no photos please",
    "don't make me take pictures",
    "I can't film anything today",
    "I have no time to take photos",
    "cannot take any pictures right now",
    "nothing to film today",
    "something I can post without taking a picture",
  ]) {
    assert.equal(wantsNoFreshCapture(request(text)), false, `"${text}" restricts one medium; the other is still capturable`);
  }
});

test("B1. genuinely ambiguous phrasings leave capture allowed, by design", () => {
  // Not oversights. Each could plausibly mean "no shoot at all" or "not that medium", and the bias
  // resolves ambiguity towards keeping capability: the owner can restate, whereas a wrongly stripped
  // Reel is a deterministic refusal they never asked for.
  for (const text of ["avoid photos", "not just photos, let's do a video too", "not only a photo"]) {
    assert.equal(wantsNoFreshCapture(request(text)), false, `"${text}" is ambiguous, so capture stays allowed`);
  }
});

test("A/B. the three intent questions stay distinct: effort, timing and production constraint", () => {
  // "I don't have time to take photos or videos" is not an effort request and not a timing request.
  const zeroCapture = request("I don't have time to take photos or videos.");
  assert.equal(wantsNoFreshCapture(zeroCapture), true);
  assert.equal(wantsSimpleProduction(zeroCapture), false, "refusing to shoot is not the same as asking for a small shoot");
  assert.equal(wantsImmediateExecution(zeroCapture), false, "refusing to shoot says nothing about when");

  // And the converse: a small, immediate shoot is still a shoot.
  const easyToday = request("Give me something easy today.");
  assert.equal(wantsSimpleProduction(easyToday), true);
  assert.equal(wantsImmediateExecution(easyToday), true);
  assert.equal(wantsNoFreshCapture(easyToday), false);
});

// =================================================================================================
// C, D. the H1-A same-day override, gated
// =================================================================================================

const TODAY = "2026-08-14";
const NOW = Date.parse("2026-08-14T01:00:00.000Z");

function product(overrides: Partial<Product> = {}): Product {
  return {
    id: "biscoff-blondies",
    name: "Biscoff Blondies",
    category: "Baked goods",
    role: "Hero candidate",
    status: "testing",
    description: "",
    image: "",
    decision: "Needs proof",
    isPublic: false,
    ...overrides,
  } as Product;
}

function todaysBake(): ContentJournalEntry {
  return {
    id: "journey-today",
    productId: "biscoff-blondies",
    entryDate: TODAY,
    whatWasMade: "Baked Biscoff Blondies this morning, cooling on the counter",
    mediaCaptured: "Nothing yet",
    lessonLearned: "The Biscoff swirl held its shape",
    postIdeas: "Close-up of the swirl",
    nextAction: "Photograph before they go",
  };
}

function bananaBreadRecommendation(): MarketingRecommendation {
  return {
    id: "no_marketing_history:banana-bread",
    recommendationType: "no_marketing_history",
    priority: 4,
    confidence: "high",
    title: "Introduce Banana Bread",
    explanation: "Banana Bread has never appeared in the Journey.",
    suggestedNextAction: "Create an introductory piece of content for Banana Bread.",
    evidence: { productId: "banana-bread", productName: "Banana Bread", entryCount: 0 },
  } as MarketingRecommendation;
}

function resolve(overrides: Partial<ResolveCreativeGroundingInput> = {}) {
  return resolveCreativeGrounding({
    creativeInput: request("Give me something easy today."),
    recommendations: [bananaBreadRecommendation()],
    journal: [todaysBake()],
    products: [product(), product({ id: "banana-bread", name: "Banana Bread" })],
    brandBible: BRAND_BIBLE,
    now: NOW,
    ...overrides,
  });
}

test("C. the H1-A same-day override still fires for an immediate request when capture is allowed", () => {
  const grounding = resolve();

  assert.equal(grounding.subject, "Biscoff Blondies");
  assert.equal(grounding.subjectKind, "product");
  assert.match(grounding.subjectGrounding ?? "", /Capturable now/);
});

test("D. the same-day override does NOT fire when the owner has ruled capture out", () => {
  // Same immediacy, same journal, same recommendation -- only the production constraint differs.
  // The override's entire argument is "this is physically on hand to photograph or film", which is
  // no argument at all for someone who has just said they will not photograph or film.
  for (const text of [
    "Give me something easy today. I don't have time to take photos or videos.",
    "Something quick today, but I can't take photos or videos.",
    ZERO_CAPTURE_REQUEST,
  ]) {
    const grounding = resolve({ creativeInput: request(text) });

    assert.equal(grounding.subject, "Banana Bread", `"${text}" must fall through to the ordinary ranking`);
    assert.match(grounding.subjectGrounding ?? "", /^Marketing recommendation:/);
    assert.doesNotMatch(grounding.subjectGrounding ?? "", /Capturable now/);
  }
});

test("D. the gate changes only step 2 -- every other resolution path is untouched", () => {
  const zeroCapture = request(ZERO_CAPTURE_REQUEST);

  // A stated subject still wins outright.
  const stated = resolve({
    creativeInput: buildCreativeInputFromRequest({ text: ZERO_CAPTURE_REQUEST, subject: "Banana Bread", productId: "banana-bread", productName: "Banana Bread" }),
  });
  assert.equal(stated.subject, "Banana Bread");
  assert.equal(stated.subjectSource, "stated");

  // Journey fallback, unchanged.
  const journeyFallback = resolve({ creativeInput: zeroCapture, recommendations: [] });
  assert.equal(journeyFallback.subjectKind, "process");

  // Brand moment, unchanged -- and this is the lane H1-B expects a timeless zero-capture idea to
  // land in when nothing else qualifies. No new subjectKind was invented for it.
  const brand = resolve({ creativeInput: zeroCapture, recommendations: [], journal: [] });
  assert.equal(brand.subjectKind, "brand");
  assert.equal(brand.productId, null);

  // H1-B adds no field to the S3A grounding contract.
  assert.deepEqual(
    Object.keys(brand).sort(),
    ["productId", "productName", "subject", "subjectGrounding", "subjectKind", "subjectSource", "supportingFacts"],
  );
});

// =================================================================================================
// E, G, H, I. the generation contract
// =================================================================================================

function commonBody(productionSource: CreativeProductionSource) {
  return {
    angle: "The saver and the finisher",
    hook: "Every pair has one of each.",
    headline: "The saver and the finisher",
    caption: "One rations it. One is already done.",
    cta: "Tell us which one you are.",
    platformVariants: [],
    productionSource,
  };
}

// Capture bodies carry framing; zero-capture bodies carry none. That asymmetry IS the contract.
function bodyFor(format: CreativeFormat, productionSource: CreativeProductionSource): Record<string, unknown> {
  const base = commonBody(productionSource);
  const capturing = productionSource === "capture_new";
  const framing = capturing ? { framing: "close_up" } : {};

  if (format === "photo") return { ...base, visualDirection: "Two illustrated blondie characters side by side.", overlayText: null, ...framing };
  if (format === "reel") {
    return {
      ...base,
      shots: [{ direction: "Hands cutting the tray.", onScreenText: null, approxSeconds: 3, framing: "close_up", movement: null }],
      spokenScript: null,
      audioDirection: "Upbeat trending audio",
    };
  }
  if (format === "carousel") {
    return { ...base, slides: [{ heading: "The saver", body: "Rations it all week.", visualDirection: "Illustrated character guarding one square.", ...framing }] };
  }
  return {
    ...base,
    frames: [{ visualDirection: "Illustrated character guarding one square.", text: "The saver", approxSeconds: null, ...framing }],
    interaction: null,
  };
}

const ZERO_CAPTURE_CONSTRAINT = resolveCreativeProductionConstraint(request(ZERO_CAPTURE_REQUEST));

test("E. the generation contract REQUIRES productionSource on every format", () => {
  for (const format of CREATIVE_FORMATS) {
    // Present in the schema's required list, for every format.
    assert.ok(
      (buildCreativeBodyJsonSchema(format).required as string[]).includes("productionSource"),
      `${format} must require productionSource`,
    );

    // And enforced by the validator, not merely requested by the schema.
    const withoutSource = bodyFor(format, "capture_new");
    delete withoutSource.productionSource;
    const missing = validateCreativeBody(format, withoutSource);
    assert.equal(missing.ok, false, `${format} body without productionSource must be rejected`);
    if (missing.ok) throw new Error("unreachable");
    assert.match(missing.message, /productionSource/);

    // A value outside the vocabulary is rejected too, rather than passed through.
    const bogus = validateCreativeBody(format, { ...bodyFor(format, "capture_new"), productionSource: "reuse_existing" });
    assert.equal(bogus.ok, false, `${format} must reject an unsupported productionSource`);
  }
});

test("E. reuse_existing is not in the vocabulary anywhere -- Asset Memory does not exist", () => {
  assert.deepEqual([...CREATIVE_PRODUCTION_SOURCES], ["capture_new", "generate_visual", "template_only"]);

  for (const source of [
    "../src/lib/creative-production-guidance.ts",
    "../src/lib/creative-generation/contracts.ts",
    "../src/lib/creative-package-content-v2.ts",
    "../src/lib/creative-package-view.ts",
  ]) {
    const code = readFileSync(new URL(source, import.meta.url), "utf8");
    // Named only where it is explicitly ruled out, never as a value the system can produce.
    assert.doesNotMatch(code, /"reuse_existing"|'reuse_existing'/, `${source} must not carry a reuse_existing value`);
  }

  // The generation prompt must not offer it as a choice either.
  const prompt = buildCreativeBodyRequest(
    { creativeInput: request(ZERO_CAPTURE_REQUEST), grounding: grounding(), brandBible: BRAND_BIBLE },
    { format: "photo", formatRationale: "One static visual carries the joke." },
    [],
  );
  assert.doesNotMatch(`${prompt.system}\n${prompt.user}`, /reuse_existing/);
});

test("G. capture_new requires the S6 framing on every format that has one", () => {
  // Photo: top level.
  const photoNoFraming = validateCreativeBody("photo", { ...bodyFor("photo", "capture_new"), framing: undefined });
  assert.equal(photoNoFraming.ok, false);
  if (photoNoFraming.ok) throw new Error("unreachable");
  assert.match(photoNoFraming.message, /framing/);

  // Carousel and Story: per item.
  const carouselNoFraming = validateCreativeBody("carousel", {
    ...commonBody("capture_new"),
    slides: [{ heading: "The saver", body: "Rations it.", visualDirection: "Corner piece." }],
  });
  assert.equal(carouselNoFraming.ok, false);

  const storyNoFraming = validateCreativeBody("story", {
    ...commonBody("capture_new"),
    frames: [{ visualDirection: "Corner piece.", text: "The saver", approxSeconds: null }],
    interaction: null,
  });
  assert.equal(storyNoFraming.ok, false);

  // And a complete capture body still passes, exactly as it did under S6.
  for (const format of CREATIVE_FORMATS) {
    assert.equal(validateCreativeBody(format, bodyFor(format, "capture_new")).ok, true, `${format} capture body must remain valid`);
  }
});

for (const productionSource of ["generate_visual", "template_only"] as const) {
  test(`H/I. ${productionSource} omits framing -- and a framing value is REJECTED, not ignored`, () => {
    for (const format of ["photo", "carousel", "story"] as const) {
      // Valid with no framing anywhere.
      const valid = validateCreativeBody(format, bodyFor(format, productionSource), ZERO_CAPTURE_CONSTRAINT);
      assert.equal(valid.ok, true, `${format}/${productionSource} must validate without framing: ${valid.ok ? "" : valid.message}`);

      // Rejected when a framing is supplied. This is the rule that stops a typography card being
      // labelled "close_up" purely to satisfy a schema.
      const body = bodyFor(format, productionSource);
      const withFraming =
        format === "photo"
          ? { ...body, framing: "close_up" }
          : format === "carousel"
            ? { ...body, slides: [{ ...(body.slides as Record<string, unknown>[])[0], framing: "close_up" }] }
            : { ...body, frames: [{ ...(body.frames as Record<string, unknown>[])[0], framing: "close_up" }] };

      const rejected = validateCreativeBody(format, withFraming, ZERO_CAPTURE_CONSTRAINT);
      assert.equal(rejected.ok, false, `${format}/${productionSource} must reject a framing`);
      if (rejected.ok) throw new Error("unreachable");
      assert.match(rejected.message, /framing/);
    }

    // The schema for a zero-capture request drops framing entirely, so additionalProperties:false
    // refuses it before the validator is even reached.
    const photoSchema = buildCreativeBodyJsonSchema("photo", ZERO_CAPTURE_CONSTRAINT);
    assert.equal("framing" in (photoSchema.properties as Record<string, unknown>), false);
    assert.equal((photoSchema.required as string[]).includes("framing"), false);
  });
}

test("H/I. a zero-capture Story is still frames only -- there is no video generation", () => {
  const video = {
    ...commonBody("generate_visual"),
    frames: [{ visualDirection: "Illustrated character.", text: "The saver", approxSeconds: 4 }],
    interaction: null,
  };
  const rejected = validateCreativeBody("story", video, ZERO_CAPTURE_CONSTRAINT);
  assert.equal(rejected.ok, false, "a generated Story frame cannot be a video");
  if (rejected.ok) throw new Error("unreachable");
  assert.match(rejected.message, /still|video/i);

  // The schema says the same thing: null is the only value it will accept.
  const frames = (buildCreativeBodyJsonSchema("story", ZERO_CAPTURE_CONSTRAINT).properties as Record<string, { items: { properties: Record<string, { type: unknown }> } }>).frames;
  assert.deepEqual(frames.items.properties.approxSeconds.type, "null");
});

// =================================================================================================
// J, K. the format decision under a production constraint
// =================================================================================================

test("J. a zero-capture request with no formatHint can never select Reel", () => {
  const zeroCapture = request(ZERO_CAPTURE_REQUEST);
  const constraint = resolveCreativeProductionConstraint(zeroCapture);

  // Not offered in the Stage 1 schema.
  const schema = buildFormatDecisionJsonSchema(constraint);
  const offered = ((schema.properties as Record<string, { enum: string[] }>).format.enum);
  assert.deepEqual(offered, ["photo", "carousel", "story"]);
  assert.equal(offered.includes("reel"), false);

  // Not offered in the Stage 1 prompt either -- a format the request rules out is not on the menu.
  const decisionRequest = buildFormatDecisionRequest({ creativeInput: zeroCapture, grounding: grounding(), brandBible: BRAND_BIBLE });
  assert.doesNotMatch(decisionRequest.user, /^- reel:/m);
  assert.match(decisionRequest.user, /^- photo:/m);

  // And rejected by the validator if a model returns it anyway.
  const rejected = validateFormatDecision({ format: "reel", formatRationale: "Video tells the story best." }, constraint);
  assert.equal(rejected.ok, false);
  if (rejected.ok) throw new Error("unreachable");
  assert.equal(rejected.reason, "unsupported-format");

  // Every other format remains selectable.
  for (const format of ["photo", "carousel", "story"] as const) {
    assert.equal(validateFormatDecision({ format, formatRationale: "Fits a zero-capture idea." }, constraint).ok, true);
  }

  // A Reel is capture-only even with no constraint at all: that is a property of the format.
  assert.deepEqual([...productionSourcesForFormat("reel")], ["capture_new"]);
  assert.deepEqual([...productionSourcesForFormat("reel", constraint)], [], "reel plus zero capture is an empty set");
});

test("K. an explicit Reel hint plus a refusal of all fresh capture is refused, not silently resolved", () => {
  // R2: the refusal has to cover ALL capture. "I can't film today" alone leaves photography
  // available and is handled by CASE C below, not here.
  const conflict = buildCreativeInputFromRequest({ text: "I can't take photos or videos today.", formatHint: "reel" });

  const impossible = findImpossibleFormatRequest(conflict);
  assert.notEqual(impossible, null, "the contradiction must be detected before any generation");
  assert.equal(impossible?.format, "reel");
  // The message names both halves, so the owner learns what to change rather than just that it failed.
  assert.match(impossible?.message ?? "", /reel/i);
  assert.match(impossible?.message ?? "", /film/i);

  // The two silent resolutions are both refused: no Reel is produced, and no other format is
  // substituted for the one the owner explicitly asked for.
  const body = validateCreativeBody("reel", bodyFor("reel", "capture_new"), resolveCreativeProductionConstraint(conflict));
  assert.equal(body.ok, false, "a Reel body cannot be validated for a request that forbids filming");

  // Every non-conflicting hint still passes straight through.
  for (const format of CREATIVE_FORMATS) {
    assert.equal(findImpossibleFormatRequest(buildCreativeInputFromRequest({ text: "Give me something today.", formatHint: format })), null);
  }
  for (const format of ["photo", "carousel", "story"] as const) {
    assert.equal(findImpossibleFormatRequest(buildCreativeInputFromRequest({ text: ZERO_CAPTURE_REQUEST, formatHint: format })), null);
  }
  // And a request with no hint is never impossible -- Stage 1 simply chooses from what is allowed.
  assert.equal(findImpossibleFormatRequest(request(ZERO_CAPTURE_REQUEST)), null);
});

// H1-B-R1/B1. The practical consequence that exposed the over-broad matcher, pinned as a regression.
//
// A Reel formatHint is where a false positive stops being a quality issue and becomes a hard
// deterministic refusal: findImpossibleFormatRequest rejects the job BEFORE any grounding is loaded
// or any model is called. These assert only the H1-B classification and the refusal decision --
// never an AI outcome.
test("B1/CASE A. a request that explicitly asks for fresh capture keeps its Reel hint", () => {
  const input = buildCreativeInputFromRequest({ text: "Don't use old photos — take a new one.", formatHint: "reel" });

  assert.equal(wantsNoFreshCapture(input), false, "this request ASKS for fresh capture");
  assert.equal(findImpossibleFormatRequest(input), null, "it must not be refused before generation");
  assert.deepEqual([...resolveCreativeProductionConstraint(input).formats], [...CREATIVE_FORMATS]);
  assert.deepEqual([...productionSourcesForFormat("reel", resolveCreativeProductionConstraint(input))], ["capture_new"]);
});

test("B1/CASE B. a request that limits how much to film keeps its Reel hint", () => {
  const input = buildCreativeInputFromRequest({ text: "Don't film the whole thing, just get one short clip.", formatHint: "reel" });

  assert.equal(wantsNoFreshCapture(input), false, "this constrains how much to film, not whether to film");
  assert.equal(findImpossibleFormatRequest(input), null, "it must not fail with unsupported_format_for_request");
});

// H1-B-R2. Single-medium restrictions must not reach the hard-refusal path either.
//
// These do NOT assert that H1-B satisfies a contradictory Reel request -- "I can't film today" plus
// formatHint reel is still a request the owner will have to resolve. They assert only that the
// ALL-CAPTURE constraint is not what rejects it: an owner who ruled out video has said nothing about
// photography, so `wantsNoFreshCapture` has no grounds to strip capture_new and Reel wholesale.
test("R2/CASE C. a single-medium restriction does not trigger the all-capture Reel refusal", () => {
  for (const text of ["I can't film today.", "No photos today.", "No video today.", "Skip the photos."]) {
    const input = buildCreativeInputFromRequest({ text, formatHint: "reel" });

    assert.equal(wantsNoFreshCapture(input), false, `"${text}" restricts one medium only`);
    assert.equal(findImpossibleFormatRequest(input), null, `"${text}" must not be rejected by the all-capture constraint`);
    assert.deepEqual([...resolveCreativeProductionConstraint(input).formats], [...CREATIVE_FORMATS]);
  }
});

test("B1+R2/CONTROL. a clear refusal of ALL capture still makes a Reel hint a deterministic refusal", () => {
  for (const text of ["I can't take photos or videos today.", "I can't film or take photos today."]) {
    const input = buildCreativeInputFromRequest({ text, formatHint: "reel" });

    assert.equal(wantsNoFreshCapture(input), true, `"${text}" refuses all capture`);
    const impossible = findImpossibleFormatRequest(input);
    assert.notEqual(impossible, null, "the genuine contradiction must still be caught before generation");
    assert.equal(impossible?.format, "reel");
  }
});

// =================================================================================================
// Q. productionSource survives assembly and package validation
// =================================================================================================

function grounding(overrides: Partial<ResolvedCreativeGrounding> = {}): ResolvedCreativeGrounding {
  return {
    subject: "An everyday Aly & Pon moment",
    subjectKind: "brand",
    subjectSource: "assumed",
    subjectGrounding: "Brand fallback: no qualifying marketing recommendation and no recent Journey entry.",
    productId: null,
    productName: null,
    supportingFacts: [BRAND_BIBLE.mission],
    ...overrides,
  };
}

function assemble(format: CreativeFormat, productionSource: CreativeProductionSource, creativeInput = request(ZERO_CAPTURE_REQUEST)) {
  return assembleCreativePackageV2({
    creativeInput,
    grounding: grounding(),
    decision: { format, formatRationale: "Fits the idea." },
    formatChosenBy: "ai",
    body: bodyFor(format, productionSource),
    sourceCreativeJobId: "job-1",
    sourceWorker: "creative_ai",
  });
}

test("Q. productionSource travels from the model body into the stored package, and validates there", () => {
  for (const format of ["photo", "carousel", "story"] as const) {
    for (const productionSource of ["generate_visual", "template_only"] as const) {
      const assembled = assemble(format, productionSource);
      assert.ok(assembled.ok, assembled.ok ? "" : assembled.message);

      assert.equal(assembled.content.productionSource, productionSource);
      // It lives in the BODY, not in metadata: it is a creative decision, not provenance.
      assert.equal("productionSource" in assembled.content.metadata, false);
      // And the stored package still validates as an ordinary v2 package, unbumped.
      assert.equal(validateCreativePackageContentV2(assembled.content).ok, true);
      assert.equal(assembled.content.schemaVersion, "v2");
      assert.equal(assembled.content.metadata.generatorVersion, "2");
    }
  }

  // Capture packages keep carrying framing through assembly exactly as they did under S6.
  const captured = assemble("photo", "capture_new", request("Give me something easy today."));
  assert.ok(captured.ok, captured.ok ? "" : captured.message);
  assert.equal(captured.content.productionSource, "capture_new");
  assert.equal(captured.content.format === "photo" ? captured.content.framing : null, "close_up");

  // A zero-capture photo carries NO framing key at all -- absent, not null.
  const generated = assemble("photo", "generate_visual");
  assert.ok(generated.ok, generated.ok ? "" : generated.message);
  assert.equal("framing" in generated.content, false);
});

test("Q. the stored validator enforces the same coupling the generator does", () => {
  const generated = assemble("photo", "generate_visual");
  assert.ok(generated.ok, generated.ok ? "" : generated.message);

  // A framing smuggled onto a generated package is rejected by the authoritative S2 validator too,
  // not only by the generation contract.
  const tampered = validateCreativePackageContentV2({ ...generated.content, framing: "close_up" });
  assert.equal(tampered.ok, false);
  if (tampered.ok) throw new Error("unreachable");
  assert.match(tampered.message, /framing/);

  // And a Reel that claims not to be filmed is refused: nothing in this MVP can make one.
  const reel = assemble("reel", "capture_new", request("Give me something easy today."));
  assert.ok(reel.ok, reel.ok ? "" : reel.message);
  const impossibleReel = validateCreativePackageContentV2({ ...reel.content, productionSource: "generate_visual" });
  assert.equal(impossibleReel.ok, false);

  // An unsupported value never becomes a stored package.
  assert.equal(validateCreativePackageContentV2({ ...generated.content, productionSource: "reuse_existing" }).ok, false);
});

// =================================================================================================
// F, P. backward compatibility with everything written before H1-B
// =================================================================================================

function metadata(): CreativePackageMetadataV2 {
  return {
    generatedFromOpportunity: null,
    generatorVersion: "2",
    sourceCreativeJobId: "job-legacy",
    sourceWorker: "creative_ai",
    sourceJobResultSchemaVersion: "v2",
    formatChosenBy: "ai",
    formatRationale: "A photo suits it.",
    subjectSource: "assumed",
    subjectGrounding: "Marketing recommendation: Blondies has never appeared in the Journey.",
  };
}

// An S6-era package: framing present, productionSource absent, exactly as it was written.
const legacyPhoto = {
  schemaVersion: "v2" as const,
  format: "photo" as const,
  subject: "Biscoff Blondies",
  angle: "The corner piece everyone fights over",
  hook: "The edges are the best part.",
  headline: "Corner pieces only",
  caption: "Chewy middles and crisp edges.",
  cta: "Tell us which piece you would take.",
  platformVariants: [],
  metadata: metadata(),
  visualDirection: "Overhead on the wooden board, morning window light.",
  overlayText: null,
  framing: "close_up" as const,
};

// A pre-S6 package: no framing either. Still a legitimate v2 package.
const preS6Photo = {
  ...legacyPhoto,
  framing: undefined as unknown as undefined,
};
delete (preS6Photo as Record<string, unknown>).framing;

test("F. a stored pre-H1-B v2 package with no productionSource remains valid", () => {
  for (const stored of [legacyPhoto, preS6Photo]) {
    const validation = validateCreativePackageContentV2(stored);
    assert.equal(validation.ok, true, validation.ok ? "" : validation.message);
  }

  // Absent is genuinely absent, not defaulted to capture_new on read. The system does not claim a
  // decision that was never made.
  assert.equal("productionSource" in legacyPhoto, false);
  const validated = validateCreativePackageContentV2(legacyPhoto);
  assert.ok(validated.ok);
  assert.equal(validated.content.productionSource, undefined);
});

test("P. a pre-H1-B package renders exactly as it did before this slice", () => {
  const view = buildCreativePackageView(legacyPhoto);
  assert.ok(view.ok, view.ok ? "" : view.message);

  // The S6 heading and the S6 framing title, both unchanged.
  assert.equal(view.view.production[0].title, "Take this photo");
  assert.equal(view.view.production[0].blocks[0].title, "Close-up");
  assert.equal(view.view.formatLabel, "Photo");

  // A pre-S6 package still renders with no framing title and no empty row.
  const bare = buildCreativePackageView(preS6Photo);
  assert.ok(bare.ok, bare.ok ? "" : bare.message);
  assert.equal(bare.view.production[0].title, "Take this photo");
  assert.equal(bare.view.production[0].blocks[0].title, null);

  // Carousel keeps its "Photo" slide label when the package is a capture, including pre-H1-B ones.
  const legacyCarousel = {
    ...legacyPhoto,
    format: "carousel" as const,
    slides: [{ heading: "What changed", body: "More brown butter.", visualDirection: "Cover shot", framing: "wide" as const }],
  };
  delete (legacyCarousel as Record<string, unknown>).visualDirection;
  delete (legacyCarousel as Record<string, unknown>).overlayText;
  delete (legacyCarousel as Record<string, unknown>).framing;

  const carouselView = buildCreativePackageView(legacyCarousel);
  assert.ok(carouselView.ok, carouselView.ok ? "" : carouselView.message);
  assert.equal(carouselView.view.production[0].blocks[0].title, "Slide 1 · Photo · Wide");
});

// =================================================================================================
// L, M, N, O. the execution-first renderer
// =================================================================================================

function viewOf(format: CreativeFormat, productionSource: CreativeProductionSource) {
  const assembled = assemble(format, productionSource);
  assert.ok(assembled.ok, assembled.ok ? "" : assembled.message);
  const view = buildCreativePackageView(assembled.content);
  assert.ok(view.ok, view.ok ? "" : view.message);
  return view.view;
}

test("L. a zero-capture Photo never says 'Take this photo'", () => {
  assert.equal(viewOf("photo", "generate_visual").production[0].title, "Make this visual");
  assert.equal(viewOf("photo", "template_only").production[0].title, "Make this graphic");

  // The capture case is unchanged, so the distinction is real rather than a blanket rewording.
  const captured = assemble("photo", "capture_new", request("Give me something easy today."));
  assert.ok(captured.ok, captured.ok ? "" : captured.message);
  const capturedView = buildCreativePackageView(captured.content);
  assert.ok(capturedView.ok);
  assert.equal(capturedView.view.production[0].title, "Take this photo");
});

// The instructions this slice exists to eliminate. Deliberately imperative phrasings rather than the
// bare word "photo": `photo` remains the FORMAT's name (§8 -- one static visual post), and renaming
// the format value would be a migration of every stored package for a distinction productionSource
// already carries.
const CAPTURE_INSTRUCTIONS = [
  /take this photo/i,
  /take a photo/i,
  /photograph/i,
  /\bfilm\b/i,
  /\bfilming\b/i,
  /\bshoot\b/i,
  /\brecord\b/i,
  /\bcapture\b/i,
  /on a phone/i,
  /point the (phone|camera)/i,
  /close-up|overhead|medium shot|wide shot/i,
];

test("M. no zero-capture package renders any capture instruction, in any format or any surface", () => {
  for (const format of ["photo", "carousel", "story"] as const) {
    for (const productionSource of ["generate_visual", "template_only"] as const) {
      const view = viewOf(format, productionSource);
      // Everything the owner can read: section titles, block titles, labels, values, clipboard.
      const rendered = [
        view.formatLabel,
        view.durationLabel ?? "",
        formatCreativePackageForClipboard(view),
      ].join("\n");

      for (const forbidden of CAPTURE_INSTRUCTIONS) {
        assert.doesNotMatch(rendered, forbidden, `${format}/${productionSource} must not instruct ${forbidden}`);
      }

      // No framing label can appear, because no framing survived into the package.
      assert.equal(view.durationLabel, null, "only a Reel carries a total, and a Reel is never zero-capture");
    }
  }

  // Carousel and Story carry no format-level "Photo" word at all under zero capture.
  for (const format of ["carousel", "story"] as const) {
    const rendered = formatCreativePackageForClipboard(viewOf(format, "generate_visual"));
    assert.doesNotMatch(rendered, /\bphotos?\b/i, `${format} zero-capture output must not mention photos`);
  }
});

test("N. a zero-capture Carousel renders still-visual slides with no invented medium label", () => {
  const view = viewOf("carousel", "generate_visual");

  assert.equal(view.production[0].title, "Build these slides");
  // "Slide 1" alone: no "Photo", and no framing, because neither is true of an illustration.
  assert.equal(view.production[0].blocks[0].title, "Slide 1");
  assert.deepEqual(
    view.production[0].blocks[0].lines.map((line) => line.label),
    ["Show", "Text on slide", null],
  );
});

test("O. Carousel remains still-only: no video, motion or duration, whatever the production source", () => {
  for (const productionSource of ["capture_new", "generate_visual", "template_only"] as const) {
    const creativeInput = productionSource === "capture_new" ? request("Give me something easy today.") : request(ZERO_CAPTURE_REQUEST);
    const assembled = assemble("carousel", productionSource, creativeInput);
    assert.ok(assembled.ok, assembled.ok ? "" : assembled.message);

    // The contract carries no per-slide medium at all, so a slide cannot claim to be a video.
    const slide = assembled.content.format === "carousel" ? (assembled.content.slides[0] as Record<string, unknown>) : {};
    for (const forbidden of ["mediaType", "approxSeconds", "movement", "duration"]) {
      assert.equal(forbidden in slide, false, `carousel slides must not carry ${forbidden}`);
    }

    // And the generation schema refuses to accept one.
    const constraint = resolveCreativeProductionConstraint(creativeInput);
    const slideProperties = (buildCreativeBodyJsonSchema("carousel", constraint).properties as Record<string, { items: { properties: Record<string, unknown> } }>).slides.items.properties;
    for (const forbidden of ["mediaType", "approxSeconds", "movement", "duration"]) {
      assert.equal(forbidden in slideProperties, false, `carousel slide schema must not offer ${forbidden}`);
    }
  }
});

// =================================================================================================
// R, S. prompt guidance, and the taxonomies this slice deliberately did NOT add
// =================================================================================================

function bodyPrompt(text: string, format: CreativeFormat = "photo") {
  return buildCreativeBodyRequest(
    { creativeInput: request(text), grounding: grounding(), brandBible: BRAND_BIBLE },
    { format, formatRationale: "One static visual carries the joke." },
    ["instagram"],
  );
}

test("R. the canonical prompt draws the stylized-vs-documentary line, in both directions", () => {
  const prompt = bodyPrompt(ZERO_CAPTURE_REQUEST);
  const system = prompt.system;

  // Stylization is permitted as a creative device...
  assert.match(system, /creative devices?, not documentary evidence/i);
  assert.match(system, /invented personality/i);
  // ...and refused as evidence about the real business.
  assert.match(system, /may NOT invent or imply real product texture/i);
  assert.match(system, /that is capture_new, not generate_visual/i);

  // The existing S3B.1 / S6 factuality boundaries are all still there, unweakened.
  assert.match(system, /CLOSED SET for factual claims/);
  assert.match(system, /Creative invention is allowed; factual invention is not/);
  assert.match(system, /Absence of recorded history is not positive evidence/);
  assert.match(system, /do NOT invent a business record/i);

  // And the no-fabricated-asset rule, which is what makes reuse_existing's absence honest.
  assert.match(system, /Never state or imply that an image, illustration or graphic has already been produced/i);
  assert.match(system, /no library of the owner's existing photos/i);
});

test("R. the capture-specific boundaries apply exactly when capture is still possible", () => {
  const capture = bodyPrompt("Give me something easy today.").system;
  const zeroCapture = bodyPrompt(ZERO_CAPTURE_REQUEST).system;

  // S6's two capture-executability boundaries stay for a request that may still involve a camera.
  assert.match(capture, /Every production instruction must describe something the owner can actually capture/);
  assert.match(capture, /executed by ONE person, alone, holding an ordinary phone/);

  // And drop for one that cannot -- keeping them would push the model back towards the camera.
  assert.doesNotMatch(zeroCapture, /Every production instruction must describe something the owner can actually capture/);
  assert.doesNotMatch(zeroCapture, /holding an ordinary phone/);

  // The prop/artifact factuality rule is NOT capture-specific and stays in both: an illustration can
  // invent a business record just as effectively as a photograph can.
  for (const system of [capture, zeroCapture]) {
    assert.match(system, /do NOT invent a business record/i);
  }

  // The quality guidance is a standing rule, so it lives in the system prompt for every request.
  for (const system of [capture, zeroCapture]) {
    assert.match(system, /idea must come before the visual/i);
  }

  // The zero-capture BRIEF is request-specific, so it lives in the user prompt beside the chosen
  // format -- and it tells the model what to do instead of shooting, rather than only what not to do.
  const zeroCaptureUser = bodyPrompt(ZERO_CAPTURE_REQUEST).user;
  assert.match(zeroCaptureUser, /must be executable without a camera/i);
  assert.match(zeroCaptureUser, /Choose productionSource from exactly these values: generate_visual, template_only\./);
  assert.match(zeroCaptureUser, /omit the framing key entirely/i);

  // And a capture-permitted request is offered all three, with framing conditional rather than gone.
  const captureUser = bodyPrompt("Give me something easy today.").user;
  assert.match(captureUser, /Choose productionSource from exactly these values: capture_new, generate_visual, template_only\./);
  assert.doesNotMatch(captureUser, /must be executable without a camera/i);
});

test("S. no creativeArchetype and no visual-style taxonomy was added", () => {
  for (const source of [
    "../src/lib/creative-production-guidance.ts",
    "../src/lib/creative-formats.ts",
    "../src/lib/creative-generation/contracts.ts",
    "../src/lib/creative-package-content-v2.ts",
    "../src/lib/creative-package-view.ts",
    "../src/lib/creative-input.ts",
  ]) {
    const code = readFileSync(new URL(source, import.meta.url), "utf8");
    for (const forbidden of [/creativeArchetype/, /VISUAL_STYLES/, /visualStyle/, /pixel_retro/, /mini_comic/, /capturePreference/]) {
      assert.doesNotMatch(code, forbidden, `${source} must not introduce ${forbidden}`);
    }
  }

  // Visual style stays in prose, where the existing contract already puts it. The zero-capture brief
  // says so explicitly rather than leaving the model to look for a field.
  assert.match(bodyPrompt(ZERO_CAPTURE_REQUEST).user, /there is no style field to set/i);

  // And no schema anywhere offers a style or archetype key to fill in.
  for (const format of CREATIVE_FORMATS) {
    const properties = Object.keys(buildCreativeBodyJsonSchema(format).properties as Record<string, unknown>);
    for (const key of properties) {
      assert.doesNotMatch(key, /style|archetype|tag/i, `${format} schema must not offer a ${key} key`);
    }
  }

  // CreativeInput gains nothing: the constraint is derived from the owner's words, never stored.
  const input = request(ZERO_CAPTURE_REQUEST);
  assert.deepEqual(
    Object.keys(input).sort(),
    ["evidenceSummary", "formatHint", "origin", "productId", "productName", "reason", "requestText", "subject"],
  );
});

// =================================================================================================
// T. the Opportunity path is untouched
// =================================================================================================

test("T. Opportunity-backed generation is unchanged: no constraint, every format, capture allowed", () => {
  const fromOpportunity = buildCreativeInputFromOpportunity({
    id: "opportunity-1",
    title: "Create launch-ready product content for Banana Bread",
    summary: "Banana Bread has a launch-marked proof batch.",
    reason: "Rule Engine evidence supports it.",
    evidence: { product: { id: "banana-bread", name: "Banana Bread" } },
  } as unknown as OpportunityRecord);

  const constraint = resolveCreativeProductionConstraint(fromOpportunity);
  assert.deepEqual([...constraint.formats], [...CREATIVE_FORMATS]);
  assert.deepEqual([...constraint.productionSources], [...CREATIVE_PRODUCTION_SOURCES]);
  assert.equal(findImpossibleFormatRequest(fromOpportunity), null);

  // Reel remains selectable, and remains capture-only, for an Opportunity.
  assert.equal(validateFormatDecision({ format: "reel", formatRationale: "The process carries it." }, constraint).ok, true);

  // A capture Reel body still assembles into a valid package on the Opportunity path.
  const assembled = assembleCreativePackageV2({
    creativeInput: fromOpportunity,
    grounding: grounding({ subject: "Banana Bread", subjectKind: "product", productId: "banana-bread", productName: "Banana Bread" }),
    decision: { format: "reel", formatRationale: "The process carries it." },
    formatChosenBy: "ai",
    body: bodyFor("reel", "capture_new"),
    sourceCreativeJobId: "job-opportunity",
    sourceWorker: "creative_ai",
  });
  assert.ok(assembled.ok, assembled.ok ? "" : assembled.message);
  assert.equal(assembled.content.metadata.generatedFromOpportunity, "opportunity-1");
  assert.equal(assembled.content.productionSource, "capture_new");

  // And its rendered execution experience still tells the owner to film.
  const view = buildCreativePackageView(assembled.content);
  assert.ok(view.ok, view.ok ? "" : view.message);
  assert.equal(view.view.production[0].title, "Record these shots");
  assert.equal(view.view.production[0].blocks[0].title, "Shot 1 · 3 sec · Close-up");
});
