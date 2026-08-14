import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { buildCreativePackageView, formatCreativePackageForClipboard, formatHashtags } from "../src/lib/creative-package-view.ts";
import {
  validateCreativePackageContentV2,
  type CreativeCarouselPackageV2,
  type CreativePackageMetadataV2,
  type CreativePhotoPackageV2,
  type CreativeReelPackageV2,
  type CreativeStoryPackageV2,
} from "../src/lib/creative-package-content-v2.ts";

const createNowSource = readFileSync(new URL("../src/components/create-now.tsx", import.meta.url), "utf8");

// --- typed v2 fixtures ---------------------------------------------------------------------------
//
// Every fixture below is asserted to pass the authoritative S2 validator before it is used, so a
// test can never pass against content the real system would have rejected.

function metadata(overrides: Partial<CreativePackageMetadataV2> = {}): CreativePackageMetadataV2 {
  return {
    generatedFromOpportunity: null,
    generatorVersion: "2",
    sourceCreativeJobId: "job-1",
    sourceWorker: "creative_ai",
    sourceJobResultSchemaVersion: "v2",
    formatChosenBy: "ai",
    formatRationale: "A single strong image suits a first-look product post.",
    subjectSource: "stated",
    subjectGrounding: null,
    ...overrides,
  };
}

const base = {
  schemaVersion: "v2" as const,
  subject: "Biscoff Blondies",
  angle: "The corner piece everyone fights over",
  hook: "The edges are the best part.",
  headline: "Corner pieces only",
  caption: "Chewy middles, crisp edges, and a Biscoff swirl through every tray.",
  cta: "Message us to reserve a tray.",
  platformVariants: [],
  metadata: metadata(),
};

function photo(overrides: Partial<CreativePhotoPackageV2> = {}): CreativePhotoPackageV2 {
  return { ...base, format: "photo", visualDirection: "Overhead on the wooden board, morning window light.", overlayText: null, ...overrides };
}

function reel(overrides: Partial<CreativeReelPackageV2> = {}): CreativeReelPackageV2 {
  return {
    ...base,
    format: "reel",
    shots: [
      { direction: "Close on the tray coming out of the oven.", onScreenText: "Fresh out" },
      { direction: "Hands cutting the first corner piece.", onScreenText: null },
    ],
    spokenScript: "We bake these every Saturday morning.",
    audioDirection: "Quiet kitchen sound, no music.",
    targetDurationSeconds: 12,
    ...overrides,
  };
}

function carousel(overrides: Partial<CreativeCarouselPackageV2> = {}): CreativeCarouselPackageV2 {
  return {
    ...base,
    format: "carousel",
    slides: [
      { heading: "Start with browned butter", body: "It is the whole flavour.", visualDirection: "Pan of browned butter, close." },
      { heading: "Swirl the Biscoff last", body: "Fold once, no more.", visualDirection: "Spatula mid-fold." },
    ],
    ...overrides,
  };
}

function story(overrides: Partial<CreativeStoryPackageV2> = {}): CreativeStoryPackageV2 {
  return {
    ...base,
    format: "story",
    frames: [
      { visualDirection: "Tray on the counter, phone held above.", text: "Baking day" },
      { visualDirection: "Single piece on a plate.", text: "Ready at 3pm" },
    ],
    interaction: "Poll: corner piece or middle?",
    ...overrides,
  };
}

function assertValidFixture(content: unknown) {
  const validation = validateCreativePackageContentV2(content);
  assert.equal(validation.ok, true, validation.ok === false ? validation.message : "");
}

function viewOf(content: unknown) {
  assertValidFixture(content);
  const result = buildCreativePackageView(content);
  assert.equal(result.ok, true, result.ok === false ? result.message : "");
  if (!result.ok) throw new Error("unreachable");
  return result.view;
}

// --- the six fields every format carries -----------------------------------------------------------

test("every format renders Subject, Angle, Hook, Headline, Caption and CTA, in that order", () => {
  for (const content of [photo(), reel(), carousel(), story()]) {
    const view = viewOf(content);
    assert.deepEqual(
      view.essentials.map((entry) => entry.label),
      ["Subject", "Angle", "Hook", "Headline", "Caption", "Call to action"],
    );
    assert.deepEqual(
      view.essentials.map((entry) => entry.value),
      [content.subject, content.angle, content.hook, content.headline, content.caption, content.cta],
    );
  }
});

// --- Y/Z/AA/AB: production guidance, by format ------------------------------------------------------

test("Y. Photo renders its visual direction, and overlay text only when the package carries some", () => {
  const withoutOverlay = viewOf(photo({ overlayText: null }));
  assert.equal(withoutOverlay.formatLabel, "Photo");
  assert.deepEqual(
    withoutOverlay.production.map((section) => section.title),
    ["How to shoot it"],
  );
  assert.equal(withoutOverlay.production[0].blocks[0].body, "Overhead on the wooden board, morning window light.");
  assert.equal(withoutOverlay.production[0].blocks[0].note, null);

  const withOverlay = viewOf(photo({ overlayText: "Saturdays only" }));
  assert.equal(withOverlay.production[0].blocks[0].note, "Text on the photo: Saturdays only");
});

test("Z. Reel renders its shots IN ORDER, plus script, audio direction and target length", () => {
  const view = viewOf(reel());
  assert.equal(view.formatLabel, "Reel");
  assert.deepEqual(
    view.production.map((section) => section.title),
    ["Shots, in order", "Sound and length"],
  );

  const shots = view.production[0].blocks;
  assert.deepEqual(
    shots.map((block) => block.title),
    ["Shot 1", "Shot 2"],
  );
  assert.equal(shots[0].body, "Close on the tray coming out of the oven.");
  assert.equal(shots[0].note, "On screen: Fresh out");
  // A shot with no on-screen text renders no note at all, rather than an empty line or "None".
  assert.equal(shots[1].note, null);

  const sound = view.production[1].blocks;
  assert.deepEqual(
    sound.map((block) => block.title),
    ["What to say", "Sound", "Length"],
  );
  assert.equal(sound[2].body, "About 12 seconds");
});

test("Z. a visual-only Reel (no spoken script) drops the script block entirely -- the normal case, not an exception", () => {
  const view = viewOf(reel({ spokenScript: null }));
  const sound = view.production[1].blocks;
  assert.deepEqual(
    sound.map((block) => block.title),
    ["Sound", "Length"],
  );
  assert.equal(view.script, null);
});

test("AA. Carousel renders ordered slides, each with its heading, body and visual direction", () => {
  const view = viewOf(carousel());
  assert.equal(view.formatLabel, "Carousel");
  assert.deepEqual(
    view.production.map((section) => section.title),
    ["Slides, in order"],
  );
  const slides = view.production[0].blocks;
  assert.deepEqual(
    slides.map((block) => block.title),
    ["Slide 1 — Start with browned butter", "Slide 2 — Swirl the Biscoff last"],
  );
  assert.equal(slides[0].body, "It is the whole flavour.");
  assert.equal(slides[0].note, "Visual: Pan of browned butter, close.");
});

test("AB. Story renders ordered frames, and its interaction only when one is present", () => {
  const view = viewOf(story());
  assert.equal(view.formatLabel, "Story");
  assert.deepEqual(
    view.production.map((section) => section.title),
    ["Frames, in order", "Ask your followers"],
  );
  const frames = view.production[0].blocks;
  assert.deepEqual(
    frames.map((block) => block.title),
    ["Frame 1", "Frame 2"],
  );
  assert.equal(frames[0].body, "Baking day");
  assert.equal(frames[0].note, "Visual: Tray on the counter, phone held above.");
  assert.equal(view.production[1].blocks[0].body, "Poll: corner piece or middle?");

  const withoutInteraction = viewOf(story({ interaction: null }));
  assert.deepEqual(
    withoutInteraction.production.map((section) => section.title),
    ["Frames, in order"],
  );
});

// --- AC: platform variants ----------------------------------------------------------------------------

test("AC. platform variants render only when the package actually carries them", () => {
  const none = viewOf(photo({ platformVariants: [] }));
  assert.deepEqual(none.platformVariants, []);

  const some = viewOf(
    photo({
      platformVariants: [
        { platform: "instagram", caption: "Corner pieces only.", hashtags: ["#blondies", "#bakery"] },
        { platform: "tiktok", caption: "The edges are the best part.", hashtags: [] },
      ],
    }),
  );
  assert.deepEqual(
    some.platformVariants.map((variant) => [variant.platform, variant.label]),
    [
      ["instagram", "Instagram"],
      ["tiktok", "TikTok"],
    ],
  );
  assert.equal(some.platformVariants[0].caption, "Corner pieces only.");
  assert.deepEqual(some.platformVariants[0].hashtags, ["#blondies", "#bakery"]);
  // Nothing is fabricated for the platform the generator did not write a variant for.
  assert.equal(some.platformVariants.some((variant) => variant.platform === "facebook"), false);
});

test("AC. a variant with no hashtags renders no hashtag line", () => {
  assert.equal(formatHashtags([]), "");
  assert.equal(formatHashtags(["#a", "#b"]), "#a #b");
  assert.match(createNowSource, /variant\.hashtags\.length > 0 \? <p[^>]*>\{formatHashtags\(variant\.hashtags\)\}<\/p> : null/);
});

// --- AD/AE: robustness and the no-raw-JSON rule ---------------------------------------------------------

test("AD. every optional field being absent renders cleanly rather than crashing", () => {
  const bare = viewOf(photo({ overlayText: null, platformVariants: [] }));
  assert.equal(bare.production[0].blocks[0].note, null);
  assert.deepEqual(bare.platformVariants, []);
  assert.equal(bare.script, null);
  assert.ok(formatCreativePackageForClipboard(bare).length > 0);

  const bareReel = viewOf(reel({ spokenScript: null, shots: [{ direction: "One shot.", onScreenText: null }], platformVariants: [] }));
  assert.equal(bareReel.script, null);
  assert.equal(bareReel.production[0].blocks[0].note, null);

  const bareStory = viewOf(story({ interaction: null, platformVariants: [] }));
  assert.equal(bareStory.production.length, 1);
});

test("AD. an unreadable package is reported as unreadable, never rendered as if it were valid", () => {
  for (const bad of [null, {}, "not a package", { schemaVersion: "v1" }, { ...photo(), format: "video" }, { ...photo(), caption: "  " }]) {
    const result = buildCreativePackageView(bad);
    assert.equal(result.ok, false, `expected ${JSON.stringify(bad)} to be refused`);
    assert.ok(result.ok === false && result.message.length > 0);
  }
});

test("AD. the view is built through the authoritative S2 validator, not a second opinion written here", () => {
  const viewSource = readFileSync(new URL("../src/lib/creative-package-view.ts", import.meta.url), "utf8");
  assert.match(viewSource, /import \{ validateCreativePackageContentV2/);
  assert.match(viewSource, /const validation = validateCreativePackageContentV2\(content\);/);
});

test("AE. the result experience is rendered content, not raw JSON -- no stringify and no <pre> dump", () => {
  assert.doesNotMatch(createNowSource, /JSON\.stringify|formatOpportunityRawJson|<pre/);
  // The rendered pieces come from the view model, field by field.
  assert.match(createNowSource, /view\.essentials\.map/);
  assert.match(createNowSource, /view\.production\.map/);
  assert.match(createNowSource, /view\.platformVariants\.map/);
});

test("AE. nothing internal leaks into the result: no metadata, provenance or format-choice fields are exposed", () => {
  const view = viewOf(photo({ metadata: metadata({ formatChosenBy: "user", subjectSource: "assumed", subjectGrounding: "Recent Journey entry" }) }));
  const rendered = JSON.stringify(view);
  assert.doesNotMatch(rendered, /sourceCreativeJobId|sourceWorker|generatorVersion|formatChosenBy|formatRationale|subjectSource|subjectGrounding|schemaVersion/);
});

// --- AF: copy actions ------------------------------------------------------------------------------------

test("AF. copy caption copies the SAME caption the screen rendered", () => {
  const content = photo();
  const view = viewOf(content);
  assert.equal(view.caption, content.caption);
  // The rendered caption and the copied caption are the same value, not two reads of the package.
  const renderedCaption = view.essentials.find((entry) => entry.label === "Caption");
  assert.equal(renderedCaption?.value, view.caption);
  assert.match(createNowSource, /<CopyAction label="Copy caption" value=\{view\.caption\} \/>/);
});

test("AF. copy headline and copy script copy their own rendered values, and script is offered only when there is one", () => {
  const withScript = viewOf(reel({ spokenScript: "We bake these every Saturday morning." }));
  assert.equal(withScript.script, "We bake these every Saturday morning.");
  assert.equal(withScript.headline, "Corner pieces only");

  const withoutScript = viewOf(reel({ spokenScript: null }));
  assert.equal(withoutScript.script, null);
  assert.match(createNowSource, /\{view\.script \? <CopyAction label="Copy script" value=\{view\.script\} \/> : null\}/);
  assert.match(createNowSource, /<CopyAction label="Copy headline" value=\{view\.headline\} \/>/);
});

test("AF. copy everything is readable prose containing the whole package, not JSON", () => {
  const content = reel({
    platformVariants: [{ platform: "instagram", caption: "Corner pieces only.", hashtags: ["#blondies"] }],
  });
  const text = formatCreativePackageForClipboard(viewOf(content));

  assert.match(text, /^Reel/);
  assert.match(text, /Subject: Biscoff Blondies/);
  assert.match(text, /Call to action: Message us to reserve a tray\./);
  assert.match(text, /Shots, in order/);
  assert.match(text, /- Shot 1: Close on the tray coming out of the oven\./);
  assert.match(text, /On screen: Fresh out/);
  assert.match(text, /Instagram/);
  assert.match(text, /#blondies/);
  // Not a serialized object.
  assert.doesNotMatch(text, /[{}[\]]/);
});

test("AF. a per-platform caption has its own copy action, so the right text goes to the right app", () => {
  assert.match(createNowSource, /<CopyAction label=\{`Copy \$\{variant\.label\} caption`\} value=\{variant\.caption\} \/>/);
});

// --- purity --------------------------------------------------------------------------------------------

test("the view builder is pure: same package in, identical view out, with no clock, I/O or randomness", () => {
  const content = carousel();
  assert.deepEqual(viewOf(content), viewOf(content));
  const viewSource = readFileSync(new URL("../src/lib/creative-package-view.ts", import.meta.url), "utf8");
  assert.doesNotMatch(viewSource, /Date\.|Math\.random|fetch\(|supabase/);
});

test("the view rewrites nothing: every rendered value is a verbatim package field", () => {
  const content = story();
  const view = viewOf(content);
  assert.equal(view.essentials[0].value, content.subject);
  assert.equal(view.production[0].blocks[0].body, content.frames[0].text);
  assert.equal(view.production[0].blocks[1].body, content.frames[1].text);
  assert.equal(view.caption, content.caption);
});
