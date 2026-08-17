import test from "node:test";
import assert from "node:assert/strict";

import { buildCreativeInputFromRequest } from "../src/lib/creative-input.ts";
import { CREATIVE_FORMATS, type CreativeFormat } from "../src/lib/creative-formats.ts";
import { CREATIVE_PRODUCTION_SOURCES, type CreativeProductionSource } from "../src/lib/creative-production-guidance.ts";
import { buildCreativeBodyRequest, buildFormatDecisionRequest } from "../src/lib/creative-generation/prompt.ts";
import {
  buildCreativeBodyJsonSchema,
  resolveCreativeProductionConstraint,
  validateCreativeBody,
  UNCONSTRAINED_PRODUCTION,
  type CreativeProductionConstraint,
} from "../src/lib/creative-generation/contracts.ts";
import { assembleCreativePackageV2, flattenVisualBrief } from "../src/lib/creative-generation/assemble.ts";
import { validateCreativePackageContentV2, type CreativePackageMetadataV2 } from "../src/lib/creative-package-content-v2.ts";
import { buildCreativePackageView, formatCreativePackageForClipboard } from "../src/lib/creative-package-view.ts";
import { BRAND_BIBLE } from "../src/lib/marketing-advisor-context.ts";
import type { ResolvedCreativeGrounding } from "../src/lib/creative-subject-resolution.ts";

// Content Creation MVP P1 -- the owner-test polish wave.
//
// Three real owner paths passed before this wave, and each of them left one concrete defect behind.
// Every test in this file traces to a sentence an owner actually saw:
//
//   §2  "Blondies has never once shown up on this page." / "Never made it into a photo." / "Until
//       now." / "Brownies and Cookies have been posing for us this whole time."
//         -- absence from ONE internal record, generalised into real-world history.
//   §3  "First time they've turned up here in the Journey..."
//         -- internal grounding vocabulary published as public copy.
//   §5  "Blondies / Photo", printed directly above "Make this visual".
//         -- the owner-facing label ignoring how the visual actually gets made.
//
// Pure throughout: no AI, no network, no database, no clock. Assertions are on load-bearing prompt
// fragments and on the actual rendered view, never on whole-prompt snapshots -- the same discipline
// creative-production-boundaries.test.ts already uses, and for the same reason: a snapshot fails on
// every reword and proves nothing about the rule.

// =================================================================================================
// shared fixtures
// =================================================================================================

function request(text: string) {
  return buildCreativeInputFromRequest({ text });
}

const ZERO_CAPTURE_REQUEST = "Give me something funny today. I don't have time to take photos or videos.";

// The exact grounding shape that produced the owner-test defect: a subject chosen BECAUSE it is
// absent from the Journey, with that absence supplied as the only supporting fact. This is the input
// the hardened boundary has to survive -- not a hypothetical.
function grounding(overrides: Partial<ResolvedCreativeGrounding> = {}): ResolvedCreativeGrounding {
  return {
    subject: "Blondies",
    subjectKind: "product",
    subjectSource: "assumed",
    subjectGrounding: "Marketing recommendation: Blondies has never appeared in the Journey.",
    productId: "blondies",
    productName: "Blondies",
    supportingFacts: ["Blondies has never appeared in the Journey."],
    ...overrides,
  };
}

function bodyPromptFor(format: CreativeFormat, text = ZERO_CAPTURE_REQUEST) {
  return buildCreativeBodyRequest(
    { creativeInput: request(text), grounding: grounding(), brandBible: BRAND_BIBLE },
    { format, formatRationale: "Chosen for the test." },
    ["instagram"],
  );
}

function metadata(): CreativePackageMetadataV2 {
  return {
    generatedFromOpportunity: null,
    generatorVersion: "2",
    sourceCreativeJobId: "job-p1",
    sourceWorker: "creative_ai",
    sourceJobResultSchemaVersion: "v2",
    formatChosenBy: "ai",
    formatRationale: "One static visual carries the joke.",
    subjectSource: "assumed",
    subjectGrounding: "Marketing recommendation: Blondies has never appeared in the Journey.",
  };
}

function commonBody(productionSource: CreativeProductionSource): Record<string, unknown> {
  return {
    angle: "The one everyone reaches for second",
    hook: "Two blondies, one decision.",
    headline: "Corner or centre",
    caption: "Pick your side.",
    cta: "Tell us which piece you would take.",
    platformVariants: [],
    productionSource,
  };
}

// The canonical structured brief used across the P1 §7 tests. One definition, so a renderer test and
// a contract test cannot disagree about what a well-formed brief looks like.
const VISUAL_BRIEF = {
  concept: "Two illustrated blondie characters side by side.",
  style: "Warm flat-colour hand-drawn doodle.",
  scene: ["Both characters face the reader.", "Keep the background plain."],
  executionNotes: ["Use minimal detail.", "Keep the product obviously illustrated."],
};

function bodyFor(format: CreativeFormat, productionSource: CreativeProductionSource): Record<string, unknown> {
  const base = commonBody(productionSource);
  const framing = productionSource === "capture_new" ? { framing: "close_up" } : {};

  // P1 §7 -- capture bodies author a visualDirection; non-capture bodies author a visualBrief and
  // let the assembler derive the flat string from it.
  if (format === "photo") {
    return productionSource === "capture_new"
      ? { ...base, visualDirection: "Two illustrated blondie characters side by side.", overlayText: null, ...framing }
      : { ...base, overlayText: null, visualBrief: VISUAL_BRIEF };
  }
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

function assemble(format: CreativeFormat, productionSource: CreativeProductionSource, creativeInput = request(ZERO_CAPTURE_REQUEST)) {
  return assembleCreativePackageV2({
    creativeInput,
    grounding: grounding(),
    decision: { format, formatRationale: "Fits the idea." },
    formatChosenBy: "ai",
    body: bodyFor(format, productionSource),
    sourceCreativeJobId: "job-p1",
    sourceWorker: "creative_ai",
  });
}

function viewOf(format: CreativeFormat, productionSource: CreativeProductionSource, creativeInput = request(ZERO_CAPTURE_REQUEST)) {
  const assembled = assemble(format, productionSource, creativeInput);
  assert.ok(assembled.ok, assembled.ok ? "" : assembled.message);
  const view = buildCreativePackageView(assembled.content);
  assert.ok(view.ok, view.ok ? "" : view.message);
  return view.view;
}

// =================================================================================================
// §13-A. absence from one internal record is not real-world history
// =================================================================================================

// The four sentences the zero-capture owner test actually produced. They are asserted as a group
// because they are ONE error -- if the boundary only rules out the ones about the subject, the
// contrast form ("Brownies and Cookies have been posing...") walks straight through it.
test("P1-A. the absence boundary forbids the exact generalisations the owner test produced", () => {
  for (const format of CREATIVE_FORMATS) {
    const { system } = bodyPromptFor(format);

    // The load-bearing principle, stated as a shape rather than as a phrase list. This is the
    // assertion that must survive a reword of every example below it.
    assert.match(
      system,
      /absent from an internal record[^.]*is evidence about THAT RECORD ONLY/,
      `${format}: the boundary must scope an absence to the record it came from`,
    );
    assert.match(system, /never evidence about the real world beyond it/);

    // The specific predicates the original rule did not name, and the owner test then produced.
    for (const predicate of ["never posted", "never published", "never shared", "never photographed", "never pictured", "never featured"]) {
      assert.match(system, new RegExp(predicate), `${format}: absence must not prove "${predicate}"`);
    }

    // First-appearance claims, including the "here / this page / this feed" scoping that made the
    // owner-test sentence feel narrower and therefore safer than it was.
    assert.match(system, /does not prove a first, debut, premiere, or maiden appearance anywhere/);
    assert.match(system, /including on this page, on this account, in this feed/);

    // The temporal dress-up forms.
    for (const phrasing of ["until now", "finally", "at last", "the first time", "never before"]) {
      assert.match(system, new RegExp(`'${phrasing}'`, "i"), `${format}: the boundary must name '${phrasing}'`);
    }

    // The contrast form -- the claim aimed at OTHER subjects, which no subject-scoped rule catches.
    assert.match(system, /do not imply the same claim by contrast/);
    assert.match(system, /OTHER products have been photographed, posted, featured, or shared 'all this time'/);

    // The generalisable principle underneath the whole rule.
    assert.match(system, /Unknown to you is not the same as never happened/);
  }
});

// The permission half. Without this the compliant behaviour becomes "avoid the subject", which would
// break the recommendation path that selects subjects precisely BECAUSE they are absent -- turning a
// factuality fix into a silent product regression.
test("P1-A. absence still authorises choosing, introducing and featuring the subject", () => {
  const { system } = bodyPromptFor("photo");

  assert.match(system, /What absence DOES support is unchanged and remains allowed: choosing this subject, introducing it, featuring it/);
  assert.match(system, /a decision about what to make next, not a claim about the past/);

  // Taught with the concrete allowed/forbidden pair, so the rule does not read as "say nothing".
  assert.match(system, /'Giving Blondies the spotlight today' and 'Introducing Blondies' are allowed/);
  assert.match(system, /'Blondies has never once shown up on this page'/);
  assert.match(system, /'Never made it into a photo'/);
  assert.match(system, /'First time we've shared Blondies'/);
  assert.match(system, /'Brownies and Cookies have been posing for us this whole time'/);
  assert.match(system, /are all forbidden, because none of that history was supplied/);
});

// =================================================================================================
// §13-B. the frozen S3B.1 protections are not weakened by the hardening
// =================================================================================================

// Asserted as the VERBATIM original sentences, not as paraphrases. The hardening above is additive,
// and this test is what proves it: if a future edit folds these into the new prose, this fails.
test("P1-B. S3B.1's newness and menu protections survive the hardening word for word", () => {
  for (const format of CREATIVE_FORMATS) {
    const { system } = bodyPromptFor(format);

    assert.match(
      system,
      /Absence of recorded history is not positive evidence of newness, launch status, customer unfamiliarity, first-time production, first-time availability, or first-time menu inclusion\./,
      `${format}: the original S3B.1 sentence must remain intact`,
    );
    assert.match(system, /does not prove 'brand new', 'new on the menu', 'our first time making them', or 'our first time sharing them'/);

    // And the wider S3B.1 frame the boundary sits inside is untouched.
    assert.match(system, /CLOSED SET for factual claims/);
    assert.match(system, /Creative invention is allowed; factual invention is not/);
  }

  // Stage 1 shares the same constant, so the format decision is protected identically. This is the
  // reason the hardening went into ABSENCE_OF_EVIDENCE_BOUNDARY rather than into a Stage 2-only rule.
  const { system } = buildFormatDecisionRequest({
    creativeInput: request(ZERO_CAPTURE_REQUEST),
    grounding: grounding(),
    brandBible: BRAND_BIBLE,
  });
  assert.match(system, /is evidence about THAT RECORD ONLY/);
  assert.match(system, /Absence of recorded history is not positive evidence of newness/);
});

// =================================================================================================
// §13-C. internal vocabulary must not reach public copy
// =================================================================================================

test("P1-C. the public-copy rule names the internal vocabulary and the surfaces it is banned from", () => {
  for (const format of CREATIVE_FORMATS) {
    const { system } = bodyPromptFor(format);

    // The internal terms, named individually. "Journey" is the one the owner test actually leaked.
    for (const term of [
      "Journey",
      "content journal",
      "grounding",
      "grounded facts",
      "evidence summary",
      "marketing recommendation",
      "recommendation feed",
      "subject kind",
      "stated or assumed subject",
      "resolver",
      "creative package",
      "generator",
      "Product Lab",
      "Content Engine",
    ]) {
      assert.match(system, new RegExp(term), `${format}: the rule must name "${term}" as internal vocabulary`);
    }

    assert.match(system, /Never name this system's internal machinery in that copy/);

    // The reason, not just the ban -- a rule with no reason generalises to nothing.
    assert.match(system, /A follower does not know them, and public copy must never read as an explanation of them/);

    // The alternative. Without it the compliant move is to say less, rather than to say the
    // publishable thing instead.
    assert.match(system, /Write about the bakery, the product, the moment, or the reader instead/);
    assert.match(system, /use it to decide what to make, and leave it out of the copy/);
  }
});

test("P1-C. the ban is scoped to the public fields, enumerated", () => {
  const { system } = bodyPromptFor("carousel");

  // Every public surface the brief enumerates has to be inside the scope sentence, or the rule
  // becomes "not in the caption" -- which is exactly the exemption S6-R3 already had to close once.
  for (const field of [
    "angle",
    "hook",
    "headline",
    "caption",
    "CTA",
    "overlay and on-screen text",
    "slide headings and bodies",
    "story frame text",
    "spoken script",
    "platform variants",
    "hashtags",
  ]) {
    assert.match(system, new RegExp(field), `the public-copy scope must name ${field}`);
  }
  assert.match(system, /is public content written for a small bakery's followers/);
});

// The owner-test sentence itself, used as the teaching example, because it is the one case that
// demonstrates both defects at once and therefore proves they are separate rules.
test("P1-C. the owner-test sentence is taught as failing BOTH rules, with a compliant replacement", () => {
  const { system } = bodyPromptFor("photo");

  assert.match(system, /'First time they've turned up here in the Journey' is forbidden twice over/);
  assert.match(system, /it names the Journey, and it claims a first appearance nobody supplied/);
  assert.match(system, /'Blondies, front and centre today' keeps the publishable part and makes neither mistake/);
});

// Scope discipline in the other direction. Stage 1 writes a formatRationale for the owner, not copy
// for a follower, so giving it a public-copy rule would be an instruction about output it does not
// produce -- the same reasoning that keeps the S6 production boundaries out of Stage 1.
test("P1-C. the public-copy rule is Stage 2 only", () => {
  const { system } = buildFormatDecisionRequest({
    creativeInput: request(ZERO_CAPTURE_REQUEST),
    grounding: grounding(),
    brandBible: BRAND_BIBLE,
  });

  assert.doesNotMatch(system, /Never name this system's internal machinery/);
  assert.doesNotMatch(system, /is public content written for a small bakery's followers/);
});

// =================================================================================================
// §13-D. internal grounding stays where it is legitimately useful
// =================================================================================================

// The rule bans internal vocabulary from PUBLISHED copy. It must not become a system-wide gag: the
// owner reads the grounding to judge whether the assumption was reasonable, and stripping it would
// re-open the S2 defect where an assumption is indistinguishable from a fact.
test("P1-D. the Journey grounding still reaches the prompt and the stored metadata intact", () => {
  const { user } = bodyPromptFor("photo");

  // The grounding is still supplied to the model verbatim, as quoted data.
  assert.match(user, /Blondies has never appeared in the Journey\./);
  assert.match(user, /This subject was ASSUMED by the system, on this basis: Marketing recommendation: Blondies has never appeared in the Journey\./);

  // And it still survives assembly into the stored package's metadata, unredacted.
  const assembled = assemble("photo", "generate_visual");
  assert.ok(assembled.ok, assembled.ok ? "" : assembled.message);
  assert.equal(assembled.content.metadata.subjectGrounding, "Marketing recommendation: Blondies has never appeared in the Journey.");
  assert.equal(assembled.content.metadata.subjectSource, "assumed");
});

// =================================================================================================
// §13-E. the field scope covers every generated field, not the caption only
// =================================================================================================

test("P1-E. factuality and absence rules are scoped to every field, including rationale surfaces", () => {
  for (const format of CREATIVE_FORMATS) {
    const { system } = bodyPromptFor(format);

    assert.match(system, /All factuality and absence-of-evidence rules apply to EVERY field you output/);
    // The two exemptions the brief explicitly refuses: "it's only the angle" and "it's only visual
    // direction".
    assert.match(system, /A field being strategic, explanatory, internal, or not directly published does not permit unsupported factual claims/);
    assert.match(system, /Field location does not change factuality/);

    for (const field of [
      "angle",
      "hook",
      "headline",
      "caption",
      "CTA",
      "visual and production directions",
      "spoken scripts",
      "on-screen and overlay text",
      "platform variants",
      "hashtags",
    ]) {
      assert.match(system, new RegExp(field), `${format}: the factuality scope must name ${field}`);
    }
    // Format/creative rationale, reached through the "your own creative approach" clause.
    assert.match(system, /any description of your own creative approach or rationale/);
  }
});

// =================================================================================================
// §14-A..C, I. the owner-facing label is production-aware and never technical
// =================================================================================================

test("P1-F. a captured static post is labelled as a photo capture", () => {
  const view = viewOf("photo", "capture_new", request("Give me something easy today."));

  assert.equal(view.formatLabel, "Static post");
  assert.equal(view.productionLabel, "Photo capture");
  // The execution heading is the S6/H1-B one, unchanged.
  assert.equal(view.production[0].title, "Take this photo");
});

test("P1-F. a generated static post is never merely labelled 'Photo'", () => {
  const view = viewOf("photo", "generate_visual");

  assert.notEqual(view.formatLabel, "Photo");
  assert.equal(view.formatLabel, "Static post");
  assert.equal(view.productionLabel, "Illustrated visual · No shooting required");
  assert.equal(view.production[0].title, "Make this visual");
});

test("P1-F. a template-only static post reads as a graphic", () => {
  const view = viewOf("photo", "template_only");

  assert.notEqual(view.formatLabel, "Photo");
  assert.equal(view.productionLabel, "Graphic · No shooting required");
  assert.equal(view.production[0].title, "Make this graphic");
});

// The whole point of §6: the owner should not have to infer the production route from the imperative
// verb in the section heading. The route is stated, in words, before any instruction is read.
test("P1-F. the production route is stated explicitly, and says whether shooting is needed", () => {
  assert.match(viewOf("photo", "generate_visual").productionLabel ?? "", /No shooting required/);
  assert.match(viewOf("photo", "template_only").productionLabel ?? "", /No shooting required/);
  assert.match(viewOf("carousel", "generate_visual").productionLabel ?? "", /No shooting required/);
  assert.match(viewOf("story", "template_only").productionLabel ?? "", /No shooting required/);

  // A capture package must NOT claim shooting is unnecessary -- the label is information, not
  // decoration, and getting this backwards would be worse than printing nothing.
  assert.doesNotMatch(viewOf("photo", "capture_new", request("Give me something easy today.")).productionLabel ?? "", /No shooting required/);
});

// The single most mechanical requirement in §5/§6, and the easiest to regress: no enum value may
// ever reach a surface the owner reads. Checked across every format, source and rendered string.
test("P1-G. no raw enum value reaches any owner-facing surface", () => {
  const RAW_VALUES = [...CREATIVE_PRODUCTION_SOURCES, "close_up", "push_in", "pull_back", "template_only", "generate_visual", "capture_new"];

  for (const format of CREATIVE_FORMATS) {
    for (const productionSource of CREATIVE_PRODUCTION_SOURCES) {
      // Reel is capture-only, and a zero-capture request cannot produce one.
      if (format === "reel" && productionSource !== "capture_new") continue;
      const creativeInput = productionSource === "capture_new" ? request("Give me something easy today.") : request(ZERO_CAPTURE_REQUEST);
      const view = viewOf(format, productionSource, creativeInput);

      const rendered = [
        view.formatLabel,
        view.productionLabel ?? "",
        view.durationLabel ?? "",
        formatCreativePackageForClipboard(view),
      ].join("\n");

      for (const raw of RAW_VALUES) {
        assert.doesNotMatch(rendered, new RegExp(raw), `${format}/${productionSource} must not expose the raw value "${raw}"`);
      }
    }
  }
});

// =================================================================================================
// §14-D. legacy packages render safely
// =================================================================================================

// An S6-era package: framing present, productionSource absent. It never answered the production
// question, so the view must not answer it either -- null, not a guessed "Photo capture".
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

test("P1-H. a pre-H1-B package keeps its original label and claims no production route", () => {
  assert.equal("productionSource" in legacyPhoto, false);

  const validation = validateCreativePackageContentV2(legacyPhoto);
  assert.equal(validation.ok, true, validation.ok ? "" : validation.message);

  const view = buildCreativePackageView(legacyPhoto);
  assert.ok(view.ok, view.ok ? "" : view.message);

  // The word the owner has always seen for these packages, unchanged.
  assert.equal(view.view.formatLabel, "Photo");
  // Absence stays absence. Defaulting to capture_new would be exactly the guess this codebase
  // refuses everywhere else, and it would print a route the package never chose.
  assert.equal(view.view.productionLabel, null);
  // And the S6 execution guidance is untouched.
  assert.equal(view.view.production[0].title, "Take this photo");
  assert.equal(view.view.production[0].blocks[0].title, "Close-up");

  // The clipboard contributes no empty line for the absent route.
  const clipboard = formatCreativePackageForClipboard(view.view);
  assert.equal(clipboard.split("\n")[0], "Photo");
  assert.equal(clipboard.split("\n")[1], "");
});

// =================================================================================================
// §14-F..H. nothing else about the result experience moved
// =================================================================================================

test("P1-I. the production route reaches the clipboard, so 'copy everything' does not lose it", () => {
  const view = viewOf("photo", "generate_visual");
  const clipboard = formatCreativePackageForClipboard(view);

  assert.equal(clipboard.split("\n")[0], "Static post");
  assert.equal(clipboard.split("\n")[1], "Illustrated visual · No shooting required");
});

test("P1-I. a zero-capture package still renders no capture instruction anywhere, label included", () => {
  // The H1-B guarantee, re-asserted over the surfaces P1 added. The production label is new text on
  // an owner-facing surface, so it is exactly the kind of thing that could reintroduce "capture".
  const CAPTURE_INSTRUCTIONS = [/take this photo/i, /take a photo/i, /photograph/i, /\bfilm\b/i, /\bshoot\b/i, /\brecord\b/i, /\bcapture\b/i, /on a phone/i];

  for (const format of ["photo", "carousel", "story"] as const) {
    for (const productionSource of ["generate_visual", "template_only"] as const) {
      const view = viewOf(format, productionSource);
      const rendered = [view.formatLabel, view.productionLabel ?? "", formatCreativePackageForClipboard(view)].join("\n");
      for (const forbidden of CAPTURE_INSTRUCTIONS) {
        assert.doesNotMatch(rendered, forbidden, `${format}/${productionSource} must not instruct ${forbidden}`);
      }
    }
  }
});

test("P1-I. Reel, Carousel and Story keep their format labels and their execution semantics", () => {
  const reel = viewOf("reel", "capture_new", request("Give me something easy today."));
  assert.equal(reel.formatLabel, "Reel");
  assert.equal(reel.productionLabel, "Filmed on your phone");
  assert.equal(reel.production[0].title, "Record these shots");
  assert.equal(reel.durationLabel, "About 3 seconds");

  const carousel = viewOf("carousel", "capture_new", request("Give me something easy today."));
  assert.equal(carousel.formatLabel, "Carousel");
  assert.equal(carousel.production[0].title, "Build these slides");
  assert.equal(carousel.production[0].blocks[0].title, "Slide 1 · Photo · Close-up");

  const story = viewOf("story", "generate_visual");
  assert.equal(story.formatLabel, "Story");
  assert.equal(story.production[0].title, "Post these frames");
  assert.equal(story.production[0].blocks[0].title, "Frame 1");
});

// A Reel is filmed, so "Photo capture" would be wrong on the one format where capture is not
// photography. The special case exists for exactly this and is worth a test of its own.
test("P1-I. capture_new reads as filming on a Reel and as photography everywhere else", () => {
  const easy = request("Give me something easy today.");
  assert.equal(viewOf("reel", "capture_new", easy).productionLabel, "Filmed on your phone");
  assert.equal(viewOf("photo", "capture_new", easy).productionLabel, "Photo capture");
  assert.equal(viewOf("carousel", "capture_new", easy).productionLabel, "Photo capture");
  assert.equal(viewOf("story", "capture_new", easy).productionLabel, "Photo capture");
});

// =================================================================================================
// §15/§21. no prose parsing was introduced
// =================================================================================================

// §7 landed as an additive contract, so the structure the renderer shows is the generator's own.
// This asserts the invariant that had to survive that change: every line is a WHOLE field, never a
// piece of one. A package with no brief still renders its direction verbatim and unsplit.
test("P1-J. the renderer shows whole fields, never prose split into invented pieces", () => {
  // Structured: each line is exactly one brief field or scene item, verbatim.
  const structured = viewOf("photo", "generate_visual").production[0].blocks[0].lines;
  assert.equal(structured[0].value, VISUAL_BRIEF.concept);
  assert.equal(structured[1].value, VISUAL_BRIEF.style);
  assert.equal(structured[2].value, VISUAL_BRIEF.scene[0]);
  assert.equal(structured[3].value, VISUAL_BRIEF.scene[1]);

  // Unstructured (a capture): one whole string, unlabelled, exactly as before P1.
  const captured = viewOf("photo", "capture_new", request("Give me something easy today.")).production[0].blocks[0].lines;
  assert.equal(captured.length, 1, "an authored visualDirection must render as exactly one line");
  assert.equal(captured[0].label, null);
  assert.equal(captured[0].value, "Two illustrated blondie characters side by side.");
});

// =================================================================================================
// §7 / §10. the visualBrief generation contract
// =================================================================================================

const ZERO_CAPTURE_CONSTRAINT = resolveCreativeProductionConstraint(request(ZERO_CAPTURE_REQUEST));

// Explicit, not derived from a request: no owner sentence narrows a Photo to capture_new. Silence
// leaves all three sources open, which is the "optional" case exercised separately below. This is
// the same fixture shape creative-production-guidance.test.ts already uses for the capture-only path.
const CAPTURE_ONLY: CreativeProductionConstraint = { formats: CREATIVE_FORMATS, productionSources: ["capture_new"] };

function photoBody(overrides: Record<string, unknown>): Record<string, unknown> {
  return { ...commonBody("generate_visual"), overlayText: null, visualBrief: VISUAL_BRIEF, ...overrides };
}

test("P1-K. a non-capture Photo body REQUIRES visualBrief, for both zero-capture sources", () => {
  for (const productionSource of ["generate_visual", "template_only"] as const) {
    const body = photoBody({ productionSource });

    // The well-formed body is accepted.
    assert.equal(validateCreativeBody("photo", body, ZERO_CAPTURE_CONSTRAINT).ok, true);

    // Removing the brief is rejected, rather than silently producing a package with no instruction.
    const missing = { ...body };
    delete missing.visualBrief;
    const result = validateCreativeBody("photo", missing, ZERO_CAPTURE_CONSTRAINT);
    assert.equal(result.ok, false, `${productionSource} without visualBrief must be rejected`);
    if (result.ok) throw new Error("unreachable");
    assert.match(result.message, /requires a visualBrief object/);
  }

  // And the schema asks for it, so the model is told before it is judged.
  const schema = buildCreativeBodyJsonSchema("photo", ZERO_CAPTURE_CONSTRAINT);
  assert.ok((schema.required as string[]).includes("visualBrief"));
});

test("P1-K. a capture Photo body keeps its authored visualDirection and must NOT carry a brief", () => {
  const captured = { ...commonBody("capture_new"), visualDirection: "Overhead on the board.", overlayText: null, framing: "overhead" };

  assert.equal(validateCreativeBody("photo", captured, CAPTURE_ONLY).ok, true, "the S6 capture body must still validate unchanged");

  // A brief on a capture body would be the second source of truth this contract exists to prevent.
  // Asserted under the OPEN constraint too, because that is the case the schema cannot decide alone.
  for (const constraint of [CAPTURE_ONLY, UNCONSTRAINED_PRODUCTION]) {
    const briefed = validateCreativeBody("photo", { ...captured, visualBrief: VISUAL_BRIEF }, constraint);
    assert.equal(briefed.ok, false);
    if (briefed.ok) throw new Error("unreachable");
    assert.match(briefed.message, /must omit visualBrief when productionSource is capture_new/);
  }

  // When capture is the only option left, the schema does not offer the field at all, so
  // additionalProperties:false rejects it before the validator is ever reached.
  const schema = buildCreativeBodyJsonSchema("photo", CAPTURE_ONLY);
  assert.equal("visualBrief" in (schema.properties as Record<string, unknown>), false);
  assert.ok((schema.required as string[]).includes("visualDirection"));
  assert.ok((schema.required as string[]).includes("framing"), "H1-B's framing requirement is unchanged");
});

// §3's one-source-of-truth rule, enforced structurally rather than requested politely.
test("P1-L. a non-capture Photo body must NOT author a competing visualDirection", () => {
  const both = photoBody({ visualDirection: "A separately invented description of the same image." });
  const result = validateCreativeBody("photo", both, ZERO_CAPTURE_CONSTRAINT);

  assert.equal(result.ok, false, "authoring both descriptions must be rejected");
  if (result.ok) throw new Error("unreachable");
  assert.match(result.message, /must omit visualDirection when productionSource is generate_visual/);
  assert.match(result.message, /derived from visualBrief so the two cannot disagree/);

  // The zero-capture schema drops the key entirely, so the model is never offered the chance.
  const properties = buildCreativeBodyJsonSchema("photo", ZERO_CAPTURE_CONSTRAINT).properties as Record<string, unknown>;
  assert.equal("visualDirection" in properties, false);
  assert.equal("framing" in properties, false, "H1-B's framing rule is unchanged by P1");
});

// The unconstrained request is the case the schema alone cannot decide: the model has not yet chosen
// a productionSource, so both keys are offered and the validator enforces the pairing afterwards.
test("P1-L. when the source is still open, the schema offers both and the validator decides", () => {
  const properties = buildCreativeBodyJsonSchema("photo").properties as Record<string, unknown>;
  assert.ok("visualDirection" in properties);
  assert.ok("visualBrief" in properties);

  const required = buildCreativeBodyJsonSchema("photo").required as string[];
  assert.equal(required.includes("visualDirection"), false, "neither can be schema-required while the source is open");
  assert.equal(required.includes("visualBrief"), false);

  // Both pairings validate under the open constraint; the mismatched ones do not.
  assert.equal(validateCreativeBody("photo", photoBody({}), UNCONSTRAINED_PRODUCTION).ok, true);
  assert.equal(
    validateCreativeBody("photo", { ...commonBody("capture_new"), visualDirection: "Overhead.", overlayText: null, framing: "overhead" }, UNCONSTRAINED_PRODUCTION).ok,
    true,
  );
  assert.equal(validateCreativeBody("photo", photoBody({ visualDirection: "Second description." }), UNCONSTRAINED_PRODUCTION).ok, false);
});

test("P1-M. every visualBrief field is validated, in the existing validation style", () => {
  const cases: Array<[string, Record<string, unknown>, RegExp]> = [
    ["concept missing", { ...VISUAL_BRIEF, concept: "" }, /non-empty concept/],
    ["style missing", { ...VISUAL_BRIEF, style: "   " }, /non-empty style/],
    ["scene empty", { ...VISUAL_BRIEF, scene: [] }, /scene array of at least one non-empty string/],
    ["scene item blank", { ...VISUAL_BRIEF, scene: ["Fine.", ""] }, /scene array of at least one non-empty string/],
    ["executionNotes empty", { ...VISUAL_BRIEF, executionNotes: [] }, /executionNotes array of at least one non-empty string/],
    ["unexpected field", { ...VISUAL_BRIEF, keepItSimple: "no" }, /unexpected fields: keepItSimple/],
  ];

  for (const [label, visualBrief, expected] of cases) {
    const result = validateCreativeBody("photo", photoBody({ visualBrief }), ZERO_CAPTURE_CONSTRAINT);
    assert.equal(result.ok, false, `${label} must be rejected`);
    if (result.ok) throw new Error("unreachable");
    assert.match(result.message, expected, label);
  }

  // A brief that is not an object at all.
  const notAnObject = validateCreativeBody("photo", photoBody({ visualBrief: "a paragraph" }), ZERO_CAPTURE_CONSTRAINT);
  assert.equal(notAnObject.ok, false);
});

// §10G -- overlayText stays the only home for the text on the visual.
test("P1-M. visualBrief must not restate overlayText, but may say where it sits", () => {
  const overlayText = "Nobody buys bananas for the bananas.";

  const restated = validateCreativeBody(
    "photo",
    photoBody({ overlayText, visualBrief: { ...VISUAL_BRIEF, scene: [...VISUAL_BRIEF.scene, overlayText] } }),
    ZERO_CAPTURE_CONSTRAINT,
  );
  assert.equal(restated.ok, false, "a verbatim restatement of the overlay must be rejected");
  if (restated.ok) throw new Error("unreachable");
  assert.match(restated.message, /must not restate overlayText/);

  // Placement guidance is not duplication and must stay legal -- the owner needs to know where the
  // line goes, and banning that would make the brief less executable to satisfy a lint.
  const placement = validateCreativeBody(
    "photo",
    photoBody({ overlayText, visualBrief: { ...VISUAL_BRIEF, scene: [...VISUAL_BRIEF.scene, "The overlay line runs across the top in the same handwriting."] } }),
    ZERO_CAPTURE_CONSTRAINT,
  );
  assert.equal(placement.ok, true, placement.ok ? "" : placement.message);
});

// =================================================================================================
// §7 / §10-F. visualDirection is DERIVED, not authored
// =================================================================================================

test("P1-N. the stored visualDirection is deterministically flattened from the brief", () => {
  const assembled = assemble("photo", "generate_visual");
  assert.ok(assembled.ok, assembled.ok ? "" : assembled.message);
  assert.equal(assembled.content.format, "photo");
  if (assembled.content.format !== "photo") throw new Error("unreachable");

  // Exactly the flattener's output -- one authored source, one derived representation.
  assert.equal(assembled.content.visualDirection, flattenVisualBrief(VISUAL_BRIEF));
  assert.deepEqual(assembled.content.visualBrief, VISUAL_BRIEF);

  // Every fragment is a verbatim brief field. The flattening adds its own labels and nothing else:
  // no fact, no adjective, no connective prose.
  const direction = assembled.content.visualDirection;
  assert.match(direction, /^Concept: Two illustrated blondie characters side by side\.$/m);
  assert.match(direction, /^Style: Warm flat-colour hand-drawn doodle\.$/m);
  assert.match(direction, /^Scene:$/m);
  for (const item of VISUAL_BRIEF.scene) assert.ok(direction.includes(`- ${item}`), `scene item must appear verbatim: ${item}`);
  for (const note of VISUAL_BRIEF.executionNotes) assert.ok(direction.includes(`- ${note}`), `note must appear verbatim: ${note}`);

  // Deterministic: same brief, same string, every time.
  assert.equal(flattenVisualBrief(VISUAL_BRIEF), flattenVisualBrief(VISUAL_BRIEF));

  // And the assembled package is still an ordinary, unbumped v2 package.
  assert.equal(validateCreativePackageContentV2(assembled.content).ok, true);
  assert.equal(assembled.content.schemaVersion, "v2");
  assert.equal(assembled.content.metadata.generatorVersion, "2");
});

test("P1-N. a capture package's visualDirection is still the model's own, not flattened", () => {
  const assembled = assemble("photo", "capture_new", request("Give me something easy today."));
  assert.ok(assembled.ok, assembled.ok ? "" : assembled.message);
  if (assembled.content.format !== "photo") throw new Error("unreachable");

  assert.equal(assembled.content.visualDirection, "Two illustrated blondie characters side by side.");
  assert.equal(assembled.content.visualBrief, undefined, "a capture package carries no brief");
  assert.equal(assembled.content.framing, "close_up", "S6 framing is untouched");
});

// =================================================================================================
// §7 / §11. the rendered production brief
// =================================================================================================

test("P1-O. a generated static post renders a scannable structured brief, not a wall of prose", () => {
  const view = viewOf("photo", "generate_visual");
  const section = view.production[0];

  assert.equal(section.title, "Make this visual");
  const lines = section.blocks[0].lines;

  // Labelled sections in the §7 hierarchy, with continuation items carrying a null label so they
  // read as a list under one heading rather than repeating it.
  assert.deepEqual(
    lines.map((line) => line.label),
    ["Concept", "Style", "Scene", null, "Execution notes", null],
  );
  assert.equal(lines[0].value, VISUAL_BRIEF.concept);
  assert.equal(lines[1].value, VISUAL_BRIEF.style);
  assert.deepEqual([lines[2].value, lines[3].value], VISUAL_BRIEF.scene);
  assert.deepEqual([lines[4].value, lines[5].value], VISUAL_BRIEF.executionNotes);

  // The flattened compatibility string is NOT rendered alongside the structured brief. Checked as
  // "each field appears exactly once" rather than by looking for the flattener's labels, because the
  // clipboard writes its own "Concept: " prefix for any labelled line -- so the labels are expected,
  // and DUPLICATION is the actual defect.
  const rendered = formatCreativePackageForClipboard(view);
  for (const value of [VISUAL_BRIEF.concept, VISUAL_BRIEF.style, ...VISUAL_BRIEF.scene, ...VISUAL_BRIEF.executionNotes]) {
    const occurrences = rendered.split(value).length - 1;
    assert.equal(occurrences, 1, `"${value}" must appear exactly once, not once per representation`);
  }

  // No raw JSON reached the screen.
  assert.doesNotMatch(rendered, /[{}[\]]/);
});

test("P1-O. a template_only post renders the same structure with graphic semantics", () => {
  const view = viewOf("photo", "template_only");

  assert.equal(view.production[0].title, "Make this graphic");
  assert.equal(view.productionLabel, "Graphic · No shooting required");
  assert.deepEqual(
    view.production[0].blocks[0].lines.map((line) => line.label),
    ["Concept", "Style", "Scene", null, "Execution notes", null],
  );
});

test("P1-O. overlay text stays its own labelled line, between the scene and the notes", () => {
  const assembled = assembleCreativePackageV2({
    creativeInput: request(ZERO_CAPTURE_REQUEST),
    grounding: grounding(),
    decision: { format: "photo", formatRationale: "Fits the idea." },
    formatChosenBy: "ai",
    body: { ...commonBody("generate_visual"), overlayText: "Nobody buys bananas for the bananas.", visualBrief: VISUAL_BRIEF },
    sourceCreativeJobId: "job-p1",
    sourceWorker: "creative_ai",
  });
  assert.ok(assembled.ok, assembled.ok ? "" : assembled.message);

  const view = buildCreativePackageView(assembled.content);
  assert.ok(view.ok, view.ok ? "" : view.message);

  assert.deepEqual(
    view.view.production[0].blocks[0].lines.map((line) => line.label),
    ["Concept", "Style", "Scene", null, "Add this text to the visual", "Execution notes", null],
  );
});

test("P1-O. a legacy photo package with no brief still renders its visualDirection whole", () => {
  const view = buildCreativePackageView(legacyPhoto);
  assert.ok(view.ok, view.ok ? "" : view.message);

  const lines = view.view.production[0].blocks[0].lines;
  assert.equal(lines.length, 1);
  assert.equal(lines[0].label, null);
  assert.equal(lines[0].value, "Overhead on the wooden board, morning window light.");
  assert.equal(view.view.production[0].title, "Take this photo");
});

// A stored package that carries a brief validates and renders even though nothing before P1 could
// have written one -- the additive half of the contract, proven on the read path.
test("P1-O. a stored package carrying a visualBrief validates without any version bump", () => {
  const stored = { ...legacyPhoto, productionSource: "generate_visual" as const, visualBrief: VISUAL_BRIEF };
  delete (stored as Record<string, unknown>).framing;

  const validation = validateCreativePackageContentV2(stored);
  assert.equal(validation.ok, true, validation.ok ? "" : validation.message);
  assert.ok(validation.ok);
  assert.equal(validation.content.schemaVersion, "v2");
  assert.equal(validation.content.metadata.generatorVersion, "2");

  // A malformed brief on the read path is rejected just as strictly as on the generation path.
  const malformed = validateCreativePackageContentV2({ ...stored, visualBrief: { ...VISUAL_BRIEF, scene: [] } });
  assert.equal(malformed.ok, false);
});

// =================================================================================================
// §7 / §12. the prompt teaches the brief, its meanings, and the single-source rule
// =================================================================================================

test("P1-P. the Photo prompt asks for a structured brief and explains what each field means", () => {
  const { user } = bodyPromptFor("photo");

  assert.match(user, /Write the visual as a structured visualBrief with four parts, not as one paragraph/);
  // Field meanings, each distinguishable from the others -- four labels over the same prose would be
  // the same wall with headings on it.
  assert.match(user, /concept: the concrete visual idea being executed/);
  assert.match(user, /It is not a restatement of the marketing angle/);
  assert.match(user, /style: how it is drawn or designed, in your own words/);
  assert.match(user, /There is no list to choose from/);
  assert.match(user, /scene: an ordered list of the concrete elements and how they are arranged/);
  assert.match(user, /these describe the layout and typographic composition rather than a literal physical scene/);
  assert.match(user, /executionNotes: a few short practical constraints that keep the visual buildable/);
});

test("P1-P. the prompt states the single-source rule and the overlayText boundary", () => {
  const { user } = bodyPromptFor("photo");

  assert.match(user, /Do NOT write a visualDirection\. The application builds it from your visualBrief/);
  assert.match(user, /Writing both would describe the same image twice, and the two descriptions would disagree/);
  assert.match(user, /overlayText remains the ONLY place for the text that appears on the visual/);
  assert.match(user, /never restate the text itself inside visualBrief/);

  // The capture path keeps its own instruction, so the two routes stay distinguishable in the brief.
  assert.match(user, /When productionSource is capture_new, write the single visualDirection prose string as before, and do not write a visualBrief/);
});

test("P1-P. factuality reaches inside visualBrief, and stylized invention stays permitted", () => {
  const { user } = bodyPromptFor("photo");

  assert.match(user, /Every factuality rule above applies inside visualBrief exactly as it does to the caption/);
  // The permitted half, named -- otherwise the safe move inside a brief becomes describing nothing.
  assert.match(user, /may invent composition, metaphor, fictional illustrated behavior, pose, expression and graphic treatment/);
  // And the forbidden half, which is the H1-B stylization boundary applied to the new fields.
  assert.match(user, /may NOT invent real product appearance, texture, ingredients, freshness, packaging, price, availability, menu status, customer events, or business history/);

  // The unconditional boundaries still sit in the system prompt above it, unweakened by §7.
  const { system } = bodyPromptFor("photo");
  assert.match(system, /creative devices?, not documentary evidence/i);
  assert.match(system, /All factuality and absence-of-evidence rules apply to EVERY field you output/);
});
