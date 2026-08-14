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

// --- S5-A: the hierarchy is execution-first -----------------------------------------------------------
//
// The S4 view opened with six strategy labels (Subject / Angle / Hook / Headline / Caption / CTA)
// before anything actionable. These tests pin the inversion: production guidance is the first thing
// the view offers, and strategy is a separate, secondary collection.

test("S5. strategy metadata is NOT the primary hierarchy -- the view leads with what to make and what to do", () => {
  for (const content of [photo(), reel(), carousel(), story()]) {
    const view = viewOf(content);

    // The summary: what am I making, in what form. Both verbatim from the package.
    assert.equal(view.subject, content.subject);
    assert.equal(view.formatLabel, { photo: "Photo", reel: "Reel", carousel: "Carousel", story: "Story" }[content.format]);

    // Production is a populated, ordered collection -- the thing that comes next.
    assert.ok(view.production.length > 0, "every format must contribute production guidance");
    assert.ok(view.production[0].blocks.length > 0);

    // Angle / Hook / CTA are reachable ONLY through creativeDetails. There is no longer any
    // top-level field carrying them, so they cannot be rendered ahead of the instructions.
    assert.equal("essentials" in view, false, "the S4 essentials-first block must be gone");
    assert.equal("angle" in view, false);
    assert.equal("hook" in view, false);
    assert.equal("cta" in view, false);
  }
});

test("S5. Creative details still preserves Subject, Angle, Hook, Headline and CTA, in that order", () => {
  for (const content of [photo(), reel(), carousel(), story()]) {
    const view = viewOf(content);
    assert.deepEqual(
      view.creativeDetails.map((entry) => entry.label),
      ["Subject", "Angle", "Hook", "Headline", "Call to action"],
    );
    assert.deepEqual(
      view.creativeDetails.map((entry) => entry.value),
      [content.subject, content.angle, content.hook, content.headline, content.cta],
    );
    // Caption is ready-to-post copy, not strategy: it lives with the posting section and the copy
    // actions instead, so it is deliberately absent from this collection.
    assert.equal(
      view.creativeDetails.some((entry) => entry.label === "Caption"),
      false,
    );
  }
});

test("S5. Creative details is rendered as a collapsed section, after the production and posting sections", () => {
  assert.match(createNowSource, /<details[^>]*>\s*\n?\s*<summary[^>]*>Creative details<\/summary>/);
  assert.match(createNowSource, /view\.creativeDetails\.map/);

  // Order in the source is order on the screen: production, then platform copy, then details.
  const production = createNowSource.indexOf("view.production.map");
  const platforms = createNowSource.indexOf("view.platformVariants.map");
  const details = createNowSource.indexOf("view.creativeDetails.map");
  assert.ok(production > 0 && platforms > 0 && details > 0);
  assert.ok(production < platforms, "production guidance must render before platform copy");
  assert.ok(platforms < details, "platform copy must render before Creative details");
});

// --- Y/Z/AA/AB: production guidance leads, by format ------------------------------------------------

test("Y. Photo leads with its visual direction as the actionable instruction, unlabelled and unsplit", () => {
  const withoutOverlay = viewOf(photo({ overlayText: null }));
  assert.equal(withoutOverlay.formatLabel, "Photo");
  assert.deepEqual(
    withoutOverlay.production.map((section) => section.title),
    ["Take this photo"],
  );
  // One block, one unlabelled line: the direction IS the instruction.
  assert.equal(withoutOverlay.production[0].blocks.length, 1);
  assert.equal(withoutOverlay.production[0].blocks[0].title, null);
  assert.deepEqual(withoutOverlay.production[0].blocks[0].lines, [
    { label: null, value: "Overhead on the wooden board, morning window light." },
  ]);

  // v2 carries ONE visualDirection string for Photo. It is passed through whole -- never split on
  // sentences or punctuation into steps the generator did not write.
  assert.equal(withoutOverlay.production[0].blocks[0].lines[0].value, photo().visualDirection);
});

test("Y. overlayText is explicitly identified as text to add to the photo, not a bare 'Then add'", () => {
  const withOverlay = viewOf(photo({ overlayText: "Saturdays only" }));
  const lines = withOverlay.production[0].blocks[0].lines;

  assert.deepEqual(lines, [
    { label: null, value: "Overhead on the wooden board, morning window light." },
    { label: "Add this text to the photo", value: "Saturdays only" },
  ]);

  // The label must name both the action and the surface -- an owner asked what "Then add" meant.
  assert.match(lines[1].label ?? "", /text/i);
  assert.match(lines[1].label ?? "", /photo/i);
  assert.notEqual(lines[1].label, "Then add");
});

test("Y. a null overlay produces NO overlay instruction at all -- not an empty line, not 'None'", () => {
  const lines = viewOf(photo({ overlayText: null })).production[0].blocks[0].lines;
  assert.equal(lines.length, 1);
  assert.equal(
    lines.some((line) => line.label !== null),
    false,
  );
  assert.doesNotMatch(formatCreativePackageForClipboard(viewOf(photo({ overlayText: null }))), /Add this text to the photo/);
});

test("Z. Reel leads with ordered shots, each separating what to DO from the text on screen", () => {
  const view = viewOf(reel());
  assert.equal(view.formatLabel, "Reel");
  assert.deepEqual(
    view.production.map((section) => section.title),
    ["Record these shots", null],
  );

  const shots = view.production[0].blocks;
  assert.deepEqual(
    shots.map((block) => block.title),
    ["Shot 1", "Shot 2"],
  );

  // direction verbatim under "Do"; onScreenText explicitly labelled as on-screen text.
  assert.deepEqual(shots[0].lines, [
    { label: "Do", value: "Close on the tray coming out of the oven." },
    { label: "Text on screen", value: "Fresh out" },
  ]);
  assert.equal(shots[0].lines[0].value, reel().shots[0].direction);

  // A shot with no on-screen text contributes no second line at all.
  assert.deepEqual(shots[1].lines, [{ label: "Do", value: "Hands cutting the first corner piece." }]);
});

test("Z. spoken script and sound stay separate from the shots, and the TOTAL length is the summary's", () => {
  const view = viewOf(reel());
  const finish = view.production[1].blocks;
  assert.equal(finish.length, 1);
  assert.deepEqual(finish[0].lines, [
    { label: "Say this", value: "We bake these every Saturday morning." },
    { label: "Sound", value: "Quiet kitchen sound, no music." },
  ]);

  // S6 -- the total moved out of this group and into the opening summary, beside the format, so it
  // is stated once and can never read as if it belonged to the last shot. It is still the package's
  // own targetDurationSeconds, unmodified.
  assert.equal(view.durationLabel, "About 12 seconds");
  assert.equal(
    view.production.some((section) => section.blocks.some((block) => block.lines.some((line) => line.label === "Target length"))),
    false,
    "the total must not also appear as a production line",
  );
});

test("Z. only a Reel carries a total length -- the other three formats have none to state", () => {
  assert.equal(viewOf(photo()).durationLabel, null);
  assert.equal(viewOf(carousel()).durationLabel, null);
  assert.equal(viewOf(story()).durationLabel, null);
});

test("Z. a visual-only Reel (no spoken script) drops the script line entirely -- the normal case, not an exception", () => {
  const view = viewOf(reel({ spokenScript: null }));
  assert.deepEqual(
    view.production[1].blocks[0].lines.map((line) => line.label),
    ["Sound"],
  );
  assert.equal(view.script, null);
});

test("AA. Carousel distinguishes what to SHOW from the text that belongs on the slide", () => {
  const view = viewOf(carousel());
  assert.equal(view.formatLabel, "Carousel");
  assert.deepEqual(
    view.production.map((section) => section.title),
    ["Build these slides"],
  );
  const slides = view.production[0].blocks;
  // S6 states the medium on every slide, including on this pre-S6 fixture that carries no framing:
  // "a Carousel slide is a still photo" is a format rule, not something the package has to supply.
  assert.deepEqual(
    slides.map((block) => block.title),
    ["Slide 1 · Photo", "Slide 2 · Photo"],
  );

  // "Show" comes first and carries visualDirection -- the owner asked whether the heading meant
  // they had to photograph it. heading and body are the text that goes ON the slide, verbatim.
  assert.deepEqual(slides[0].lines, [
    { label: "Show", value: "Pan of browned butter, close." },
    { label: "Text on slide", value: "Start with browned butter" },
    { label: null, value: "It is the whole flavour." },
  ]);

  const source = carousel().slides[0];
  assert.equal(slides[0].lines[0].value, source.visualDirection);
  assert.equal(slides[0].lines[1].value, source.heading);
  assert.equal(slides[0].lines[2].value, source.body);

  // The visual instruction must precede the slide text, never the other way round.
  assert.equal(slides[0].lines[0].label, "Show");
});

test("AB. Story distinguishes Show from Text per frame, and states interaction as its own action", () => {
  const view = viewOf(story());
  assert.equal(view.formatLabel, "Story");
  assert.deepEqual(
    view.production.map((section) => section.title),
    ["Post these frames", null],
  );
  const frames = view.production[0].blocks;
  assert.deepEqual(
    frames.map((block) => block.title),
    ["Frame 1", "Frame 2"],
  );

  assert.deepEqual(frames[0].lines, [
    { label: "Show", value: "Tray on the counter, phone held above." },
    { label: "Text", value: "Baking day" },
  ]);
  assert.equal(frames[0].lines[0].value, story().frames[0].visualDirection);
  assert.equal(frames[0].lines[1].value, story().frames[0].text);

  // The poll is something the owner adds, not a frame to shoot -- own group, own verb.
  assert.deepEqual(view.production[1].blocks[0].lines, [{ label: "Add interaction", value: "Poll: corner piece or middle?" }]);

  const withoutInteraction = viewOf(story({ interaction: null }));
  assert.deepEqual(
    withoutInteraction.production.map((section) => section.title),
    ["Post these frames"],
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
  assert.equal(bare.production[0].blocks[0].lines.length, 1);
  assert.deepEqual(bare.platformVariants, []);
  assert.equal(bare.script, null);
  assert.ok(formatCreativePackageForClipboard(bare).length > 0);

  const bareReel = viewOf(reel({ spokenScript: null, shots: [{ direction: "One shot.", onScreenText: null }], platformVariants: [] }));
  assert.equal(bareReel.script, null);
  assert.deepEqual(bareReel.production[0].blocks[0].lines, [{ label: "Do", value: "One shot." }]);

  const bareStory = viewOf(story({ interaction: null, platformVariants: [] }));
  assert.equal(bareStory.production.length, 1);
});

test("AD. an absent optional field produces NO empty UI -- no empty line, no blank label, no stray section", () => {
  // Every line a format emits must carry real content, and every label is either a real question or
  // null. An empty string in either position would render as blank space or a floating eyebrow.
  for (const content of [
    photo({ overlayText: null, platformVariants: [] }),
    photo({ overlayText: "Saturdays only" }),
    reel({ spokenScript: null, platformVariants: [] }),
    reel({ shots: [{ direction: "One shot.", onScreenText: null }] }),
    carousel({ platformVariants: [] }),
    story({ interaction: null, platformVariants: [] }),
    story(),
  ]) {
    const view = viewOf(content);
    for (const section of view.production) {
      assert.ok(section.blocks.length > 0, "a section with no blocks would render as an empty card");
      assert.notEqual(section.title, "", "a section title is either a real heading or null, never empty");
      for (const block of section.blocks) {
        assert.ok(block.lines.length > 0, "a block with no lines would render as a title over nothing");
        assert.notEqual(block.title, "", "a block title is either a real label or null, never empty");
        for (const line of block.lines) {
          assert.ok(line.value.trim().length > 0, "every line must carry real content");
          assert.notEqual(line.label, "", "a line label is either a real question or null, never empty");
        }
      }
    }
  }
});

test("S5-R1. no synthetic per-shot timing is ever produced -- a shot's time is authored or absent", () => {
  // Dividing a whole-video total across the shots would render as precise direction while being
  // pure arithmetic. S6 gives shots real, authored durations, so the rule sharpens rather than
  // relaxes: a shot may state a time ONLY when the package stored one for that shot. This fixture
  // is pre-S6 and stores none, so no shot may show one.
  for (const seconds of [12, 15, 30, 7]) {
    const view = viewOf(reel({ targetDurationSeconds: seconds }));
    // The shot index is the ONLY thing in the title -- no seconds, and nothing derived from the
    // total. (The digit in "Shot 1" is the index, which is why this checks the whole string.)
    assert.deepEqual(
      view.production[0].blocks.map((block) => block.title),
      ["Shot 1", "Shot 2"],
    );
    for (const block of view.production[0].blocks) {
      assert.doesNotMatch(block.title ?? "", /sec|second/i, "a shot with no stored duration must not display one");
      for (const line of block.lines) {
        assert.doesNotMatch(line.value, /\d+\s*[-–—]\s*\d+\s*(s\b|sec|second)/i, "a shot must never carry a derived time range");
        assert.doesNotMatch(line.label ?? "", /time|timing|duration|seconds/i);
      }
    }
    // The only place a duration appears is the summary, stated once as the whole-video total.
    assert.equal(view.durationLabel, `About ${seconds} seconds`);
  }

  // And the arithmetic that would produce fake timings does not exist in the builder. The sum of the
  // shot durations lives in the ASSEMBLER, where it is computed once from authored values and
  // stored; the view only ever reads targetDurationSeconds back out.
  const viewSource = readFileSync(new URL("../src/lib/creative-package-view.ts", import.meta.url), "utf8");
  assert.doesNotMatch(viewSource, /targetDurationSeconds\s*[/*]|\/\s*shots\.length|Math\.round|Math\.floor|Math\.ceil|toFixed|reduce\(/);
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
  assert.match(createNowSource, /view\.creativeDetails\.map/);
  assert.match(createNowSource, /view\.production\.map/);
  assert.match(createNowSource, /view\.platformVariants\.map/);
});

test("AE. nothing internal leaks into the result: no metadata, provenance or format-choice fields are exposed", () => {
  const view = viewOf(photo({ metadata: metadata({ formatChosenBy: "user", subjectSource: "assumed", subjectGrounding: "Recent Journey entry" }) }));
  const rendered = JSON.stringify(view);
  assert.doesNotMatch(rendered, /sourceCreativeJobId|sourceWorker|generatorVersion|formatChosenBy|formatRationale|subjectSource|subjectGrounding|schemaVersion/);
});

// --- AF: copy actions ------------------------------------------------------------------------------------

test("AF. copy caption copies the SAME caption the screen rendered, and the base caption stays accessible", () => {
  const content = photo();
  const view = viewOf(content);
  assert.equal(view.caption, content.caption);
  assert.match(createNowSource, /<CopyAction label="Copy caption" value=\{view\.caption\} \/>/);
});

test("S5. with no platform variants, the base caption IS the ready-to-post copy", () => {
  const view = viewOf(photo({ platformVariants: [] }));
  assert.deepEqual(view.platformVariants, []);
  assert.equal(view.caption, photo().caption);

  // The posting section falls back to the base caption rather than rendering an empty heading.
  const posting = createNowSource.slice(createNowSource.indexOf("Then post this"));
  assert.match(posting, /view\.platformVariants\.length > 0 \?/);
  assert.match(posting, /\{view\.caption\}/);
});

test("S5. with platform variants present, platform copy is the primary ready-to-post copy", () => {
  const view = viewOf(
    photo({ platformVariants: [{ platform: "instagram", caption: "Corner pieces only.", hashtags: ["#blondies"] }] }),
  );
  assert.equal(view.platformVariants.length, 1);
  // The base caption is still carried for the quiet copy row, but it is not what the posting
  // section renders when real platform copy exists.
  assert.equal(view.caption, photo().caption);
  assert.notEqual(view.platformVariants[0].caption, view.caption);
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

  // S6 -- the summary line carries the total, because it is no longer a production line and would
  // otherwise be silently lost from "copy everything".
  assert.match(text, /^Reel · About 12 seconds/);
  assert.match(text, /Subject: Biscoff Blondies/);
  assert.match(text, /Call to action: Message us to reserve a tray\./);
  // The caption is no longer part of creativeDetails, so "copy everything" carries it explicitly --
  // losing the most-pasted line would be the obvious way this refactor could quietly regress.
  assert.match(text, /Caption: Chewy middles, crisp edges, and a Biscoff swirl through every tray\./);
  assert.match(text, /Record these shots/);
  assert.match(text, /Shot 1\nDo: Close on the tray coming out of the oven\./);
  assert.match(text, /Text on screen: Fresh out/);
  assert.match(text, /Say this: We bake these every Saturday morning\./);
  assert.match(text, /Instagram/);
  assert.match(text, /#blondies/);
  // Not a serialized object.
  assert.doesNotMatch(text, /[{}[\]]/);
});

test("AF. the clipboard carries the same labels the screen does, with no dangling colon or 'null'", () => {
  // Photo's leading line has no label. It must copy as the bare direction, never ": <value>"
  // or "null: <value>".
  const photoText = formatCreativePackageForClipboard(viewOf(photo({ overlayText: "Saturdays only" })));
  assert.match(photoText, /^Overhead on the wooden board, morning window light\.$/m);
  assert.match(photoText, /^Add this text to the photo: Saturdays only$/m);
  assert.doesNotMatch(photoText, /null/);
  assert.doesNotMatch(photoText, /^: /m);

  // Carousel copies the Show/Text-on-slide distinction, not a flattened blob.
  const carouselText = formatCreativePackageForClipboard(viewOf(carousel()));
  assert.match(carouselText, /Slide 1 · Photo\nShow: Pan of browned butter, close\.\nText on slide: Start with browned butter\nIt is the whole flavour\./);

  // Story copies Show/Text per frame and the interaction as its own action.
  const storyText = formatCreativePackageForClipboard(viewOf(story()));
  assert.match(storyText, /Frame 1\nShow: Tray on the counter, phone held above\.\nText: Baking day/);
  assert.match(storyText, /Add interaction: Poll: corner piece or middle\?/);
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
  assert.equal(view.subject, content.subject);
  assert.equal(view.creativeDetails[0].value, content.subject);
  assert.equal(view.production[0].blocks[0].lines[1].value, content.frames[0].text);
  assert.equal(view.production[0].blocks[1].lines[1].value, content.frames[1].text);
  assert.equal(view.caption, content.caption);
});

test("S5-R1. every production line value is a verbatim package field -- labels are the only UI-owned copy", () => {
  // The refinement adds labels ("Show", "Do", "Text on slide"). It must not touch the values those
  // labels point at. This walks all four formats and requires each line value to appear verbatim in
  // the source package, with the single allowed exception of the UI-owned target-length sentence.
  const cases: Array<{ content: unknown; owned: string[] }> = [
    { content: carousel(), owned: [] },
    { content: story(), owned: [] },
    { content: photo({ overlayText: "Saturdays only" }), owned: [] },
    { content: reel(), owned: ["About 12 seconds in total"] },
  ];

  for (const { content, owned } of cases) {
    const view = viewOf(content);
    const packageStrings = JSON.stringify(content);
    for (const section of view.production) {
      for (const block of section.blocks) {
        for (const line of block.lines) {
          if (owned.includes(line.value)) continue;
          assert.ok(
            packageStrings.includes(JSON.stringify(line.value).slice(1, -1)),
            `line value was not verbatim from the package: ${line.value}`,
          );
        }
      }
    }
  }
});

// --- S5-B: no new generation path -------------------------------------------------------------------
//
// S5 is presentation only. The single most damaging way to "improve" this screen would be to send
// the package back to a model to be turned into steps -- so the absence of any such path is a test,
// not a comment.

test("S5. no second AI pass, no new network call, and no prose parsing is introduced by the result view", () => {
  const viewSource = readFileSync(new URL("../src/lib/creative-package-view.ts", import.meta.url), "utf8");

  for (const source of [createNowSource, viewSource]) {
    assert.doesNotMatch(source, /anthropic|openai|\bclaude\b|\bcodex\b/i);
    assert.doesNotMatch(source, /generateCreative|runCreativeJob|creative-generation|ai-text|AiTextProvider/);
    assert.doesNotMatch(source, /productionSteps/);
  }

  // The view builder reaches nothing outside itself: no fetch, no supabase, no clock, no randomness.
  assert.doesNotMatch(viewSource, /fetch\(|supabase|Date\.|Math\.random/);

  // And it does not invent structure by splitting generated prose. A regex over visualDirection is
  // exactly the heuristic S5 refuses -- Photo's single direction is passed through whole.
  assert.doesNotMatch(viewSource, /\.split\(|\.match\(|RegExp|replace\(/);

  // The component's only data reads are still the two S4 domain entry points.
  assert.doesNotMatch(createNowSource, /fetch\(/);
});
