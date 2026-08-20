import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  GENERATIVE_IMAGE_NEGATIVE_CONSTRAINTS,
  GENERATIVE_IMAGE_STYLE_DIRECTIVES,
  GENERATIVE_IMAGE_TEXT_OWNERSHIP_OVERRIDE,
  buildGenerativeImagePrompt,
} from "../src/lib/production-image-prompt.ts";
import { buildGenerativeImagePrompt as buildPromptViaExecutorModule } from "../src/lib/production-asset-executors.ts";
import { renderProductionPromptPackage, renderProductionPromptPackageIfImage } from "../src/lib/production-prompt-package.ts";
import {
  PRODUCTION_IMAGE_DIMENSIONS,
  PRODUCTION_SHORT_VIDEO_DIMENSIONS,
  type ProductionImageSpecV1,
  type ProductionSpecV1,
} from "../src/lib/production-spec.ts";

// Production MVP Wave B -- the manual prompt package.
//
// The load-bearing test in this file is B. Everything else describes the document; B is what stops
// the manual path and the automated path from slowly becoming two different creative systems.

function imageSpec(overrides: Partial<ProductionImageSpecV1> = {}): ProductionImageSpecV1 {
  return {
    schemaVersion: "production-v1",
    assetKind: "image",
    sourceCreativePackageId: "package-1",
    dimensions: PRODUCTION_IMAGE_DIMENSIONS,
    copy: {
      headline: "Brownies, still warm",
      caption: "Out of the oven at 7am and gone by nine. Tap the link before the tray empties.",
      cta: "Order today",
      overlayText: "HELLO my name is BLONDIES",
    },
    brandStyle: null,
    visualBrief: {
      concept: "Two dessert characters arguing over the last brownie",
      style: "Soft hand-drawn illustration, warm bakery palette",
      scene: ["Board centred on a cream counter", "Two characters lean in from either side"],
      executionNotes: ["Keep it obviously illustrated", "Minimal background"],
    },
    ...overrides,
  };
}

function shortVideoSpec(): ProductionSpecV1 {
  return {
    schemaVersion: "production-v1",
    assetKind: "short_video",
    sourceCreativePackageId: "package-1",
    dimensions: PRODUCTION_SHORT_VIDEO_DIMENSIONS,
    copy: { headline: "h", caption: "c", cta: "cta", overlayText: null },
    brandStyle: null,
    visualBrief: null,
    scenes: [{ direction: "Board centred", text: null, approxSeconds: 3 }],
    targetDurationSeconds: 3,
  };
}

// --- A: deterministic -----------------------------------------------------------------------------

test("A: the prompt package is deterministic -- the same spec always renders byte-identical text", () => {
  const spec = imageSpec();
  assert.equal(renderProductionPromptPackage(spec), renderProductionPromptPackage(spec));
  // A second, independently constructed spec of the same facts must render identically too -- the
  // renderer must not depend on object identity, a clock, or anything else outside the spec.
  assert.equal(renderProductionPromptPackage(imageSpec()), renderProductionPromptPackage(imageSpec()));
});

test("A: rendering the package has no observable side effect on the spec", () => {
  const spec = imageSpec();
  const before = JSON.stringify(spec);
  renderProductionPromptPackage(spec);
  assert.equal(JSON.stringify(spec), before);
});

// --- B: ONE prompt ---------------------------------------------------------------------------------

test("B: the prompt shown to the owner is byte-identical to the prompt sent to the image executor", () => {
  for (const spec of [imageSpec(), imageSpec({ visualBrief: null }), imageSpec({ copy: { ...imageSpec().copy, overlayText: null } })]) {
    const automated = buildGenerativeImagePrompt(spec);
    const document = renderProductionPromptPackage(spec);

    // The prompt appears in the document EXACTLY as the provider receives it -- not paraphrased, not
    // re-wrapped, not re-ordered. Substring identity is the strongest available statement of that.
    assert.ok(document.includes(automated), "the rendered package must contain the automated prompt verbatim");

    // And it is delimited, so the owner can tell where to stop copying.
    const start = document.indexOf("-- COPY EVERYTHING BETWEEN THE MARKERS INTO CHATGPT IMAGES");
    const end = document.indexOf("-- END OF PROMPT");
    assert.ok(start >= 0 && end > start);
    assert.equal(document.slice(start, end).includes(automated), true, "the prompt must sit between the copy markers");
  }
});

test("B: the executor module and the pure module are literally the same function, not two copies", () => {
  assert.equal(buildPromptViaExecutorModule, buildGenerativeImagePrompt);
});

test("B: extracting the constants did not change the generated prompt", () => {
  // The reviewed Wave B prompt, pinned as a literal. If anyone edits the constants, this fails and
  // they have to decide deliberately whether the creative brief really changed.
  const expected = [
    "Create a text-free expressive illustration for a square social post.",
    "Warm hand-drawn editorial bakery style, simple human characters are allowed, cream background, charming minimal composition.",
    "Do not generate readable text, logos, captions, signatures, UI, labels, or branding.",
    "Use reference input only for broad visual language: warmth, palette, simplified linework, texture, density. Do not copy exact artwork, characters, pose, joke, text, or composition.",
    "The imagery must stay visibly illustrated or doodled, not photoreal product documentation.",
    "Desserts must read as ordinary bakery food: neat brownies, blondies, pastry slices, or clean crumb texture.",
    "Avoid flesh-like texture, skin-like tearing, grotesque food, ambiguous goo, slop, malformed pastry anatomy, severe fusion, body-horror, mutilation, or peeling layers.",
    "Concept: Two dessert characters arguing over the last brownie",
    "Style: Soft hand-drawn illustration, warm bakery palette",
    "Scene: Board centred on a cream counter Two characters lean in from either side",
    "Constraints: Keep it obviously illustrated Minimal background",
    "FINAL TEXT-OWNERSHIP OVERRIDE:",
    "Ignore any earlier brief instruction asking the image generator to render readable text, words, letters, speech-bubble contents, captions, labels, signage, typography, fonts/typefaces, logos, or branding.",
    "Preserve only the visual/layout intent of those instructions.",
    "If the brief calls for an area that will contain text, leave that area blank or visually suitable for app-rendered text.",
    "Do not render glyphs or pseudo-text.",
    "The app adds all readable copy after illustration generation.",
  ].join("\n");

  assert.equal(buildGenerativeImagePrompt(imageSpec()), expected);
  assert.deepEqual(
    [...GENERATIVE_IMAGE_STYLE_DIRECTIVES, ...GENERATIVE_IMAGE_NEGATIVE_CONSTRAINTS],
    expected.split("\n").slice(0, 7),
    "the two constants must be exactly the prompt's own first seven lines, in order",
  );
});

test("B: the anti-slop constraints are REUSED in the package, never re-typed", () => {
  const document = renderProductionPromptPackage(imageSpec());
  for (const constraint of GENERATIVE_IMAGE_NEGATIVE_CONSTRAINTS) {
    // Once inside the prompt block, once in the owner-facing "do not ask for" list.
    const occurrences = document.split(constraint).length - 1;
    assert.equal(occurrences, 2, `constraint should appear in both the prompt and the do-not list: ${constraint}`);
  }

  const source = readFileSync(new URL("../src/lib/production-prompt-package.ts", import.meta.url), "utf8");
  assert.ok(source.includes("GENERATIVE_IMAGE_NEGATIVE_CONSTRAINTS"), "the package must import the constraints");
  assert.equal(/Avoid flesh-like texture/.test(source), false, "the package must not contain its own copy of a constraint string");
});

// --- C: the caption never becomes image copy --------------------------------------------------------

test("C: the social caption stays post copy and never enters the image-generator prompt", () => {
  const spec = imageSpec();
  const document = renderProductionPromptPackage(spec);

  const promptStart = document.indexOf("-- COPY EVERYTHING BETWEEN THE MARKERS");
  const promptEnd = document.indexOf("-- END OF PROMPT");
  const promptBlock = document.slice(promptStart, promptEnd);

  assert.equal(promptBlock.includes(spec.copy.caption), false, "the caption must not be inside the copyable prompt");
  assert.equal(buildGenerativeImagePrompt(spec).includes(spec.copy.caption), false, "the caption must not reach the provider either");

  // It IS present -- clearly labelled as post copy, outside the prompt block.
  assert.ok(document.includes("CAPTION -- goes under the post, never inside the picture"));
  assert.ok(document.slice(promptEnd).includes(spec.copy.caption));
});

test("C: a package with no visualBrief still keeps the caption out of the image body copy", () => {
  // The one legitimate case where the caption reaches the prompt: a pre-P1 package with no brief, so
  // the caption is the only scene description that exists. It is still a SCENE instruction, and the
  // prompt's own first line forbids drawing text -- so the compositor must still never receive it.
  const spec = imageSpec({ visualBrief: null });
  const prompt = buildGenerativeImagePrompt(spec);
  assert.ok(prompt.includes(`Scene: ${spec.copy.caption}`), "with no brief, the caption is the scene description");
  assert.ok(prompt.includes("Do not generate readable text, logos, captions, signatures, UI, labels, or branding."));

  // Comments stripped first: the renderer DISCUSSES spec.copy.caption at length, precisely to record
  // that it is never drawn. What must not exist is an executable read of it.
  const renderer = readFileSync(new URL("../src/lib/production-static-renderer.ts", import.meta.url), "utf8");
  const statements = renderer
    .split("\n")
    .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*") && !line.trim().startsWith("/*"))
    .join("\n");
  assert.equal(/spec\.copy\.caption/.test(statements), false, "the compositor must never read the caption");
});

// --- D: overlay text is marked as app-rendered -------------------------------------------------------

test("D: overlayText is presented as drawn by the app, and is kept out of the prompt", () => {
  const spec = imageSpec();
  const document = renderProductionPromptPackage(spec);

  assert.ok(document.includes("OVERLAY TEXT -- drawn by this app, do NOT put it in the image"));
  assert.ok(document.includes(spec.copy.overlayText as string));
  assert.equal(buildGenerativeImagePrompt(spec).includes(spec.copy.overlayText as string), false);

  // The ownership split is stated once, unmissably, at the top.
  assert.ok(document.includes("WHO MAKES WHAT"));
  assert.ok(document.includes("IMAGE GENERATOR   a text-free illustration, and nothing else"));
  assert.ok(document.includes("THIS APP          headline, overlay text, typography, branding, framing, final PNG"));
  assert.ok(document.includes("SOCIAL PLATFORM   the caption, pasted under the post when you publish"));
});

test("D: a package with no overlay text says so rather than substituting other copy", () => {
  const spec = imageSpec({ copy: { ...imageSpec().copy, overlayText: null } });
  const document = renderProductionPromptPackage(spec);
  assert.ok(document.includes("(none -- this post shows the headline alone)"));
  assert.equal(document.includes("HELLO my name is BLONDIES"), false);
});

test("the package carries every field the owner needs for one post", () => {
  const document = renderProductionPromptPackage(imageSpec());
  for (const heading of [
    "CONCEPT",
    "VISUAL DIRECTION",
    "DO NOT ASK THE IMAGE GENERATOR FOR",
    "OVERLAY TEXT",
    "CAPTION",
    "CALL TO ACTION",
    "COMPOSITION",
    "BEFORE YOU UPLOAD, CHECK",
    "NEXT",
  ]) {
    assert.ok(document.includes(heading), `missing section: ${heading}`);
  }
  // The checklist is checkable-by-eye items, rendered as real checkboxes.
  assert.ok(document.includes("[ ] square, at least 1080x1080"));
  assert.ok(document.includes("[ ] no readable text, letters, numbers, logos, watermarks or signatures anywhere in the illustration"));
  // Composition guidance quotes the spec's own dimensions rather than a hardcoded constant.
  assert.ok(document.includes("Final post is 1080x1080 (1:1)"));
  // The package's own execution notes survive into the document verbatim.
  assert.ok(document.includes("Keep it obviously illustrated"));
});

// --- M: short_video stays blocked ---------------------------------------------------------------------

test("M: a short_video spec gets no manual prompt package", () => {
  assert.throws(
    () => renderProductionPromptPackage(shortVideoSpec() as unknown as ProductionImageSpecV1),
    /production-v1 image spec/,
  );
  assert.equal(renderProductionPromptPackageIfImage(shortVideoSpec()), null);
});

test("M: a non-production spec is refused rather than rendered", () => {
  assert.throws(() => renderProductionPromptPackage({ schemaVersion: "v1" } as unknown as ProductionImageSpecV1), /production-v1 image spec/);
});

// --- purity ---------------------------------------------------------------------------------------------

test("the prompt and package modules stay client-safe -- no native module, no I/O", () => {
  for (const file of ["../src/lib/production-image-prompt.ts", "../src/lib/production-prompt-package.ts"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    for (const forbidden of ["node:fs", "node:path", "satori", "resvg", "sharp", "server-only"]) {
      assert.equal(source.includes(`"${forbidden}`), false, `${file} must not import ${forbidden}`);
    }
  }
});

// --- P1: text-ownership precedence over a contradictory stored brief ---------------------------------
//
// Modelled on a REAL package. Creative Package eecc4f85-cf4f-490a-a9b5-53b692328572 stores a brief
// that asks for speech bubbles carrying the overlay text and a hand-lettered typeface -- instructions
// that contradict the static no-text rule and, being dynamic, land AFTER it. These tests pin the
// precedence that resolves that, for both the Cloudflare path and the manual package.

function contradictorySpec(): ProductionImageSpecV1 {
  return imageSpec({
    visualBrief: {
      concept: "A flat cartoon blondie waves hello, with a speech bubble for its opening line.",
      style: "Warm flat-colour hand-drawn doodle with wobbly ink outlines.",
      scene: [
        "Upper right of the character: a rounded speech bubble carrying the first line of the overlay text.",
        "Below it a smaller trailing bubble, in lighter type, carrying the second line of the overlay text.",
      ],
      executionNotes: [
        "Hand-lettered or soft rounded typeface for the bubbles, small enough to stay readable.",
        "Add a small label under the mug.",
      ],
    },
  });
}

test("P1-1: a brief demanding a speech bubble carrying overlay text still ends with the ownership override", () => {
  const prompt = buildGenerativeImagePrompt(contradictorySpec());

  // The brief's own words survive -- nothing is deleted or rewritten.
  assert.ok(prompt.includes("a rounded speech bubble carrying the first line of the overlay text"));

  // But they are not the last word.
  const overrideBlock = GENERATIVE_IMAGE_TEXT_OWNERSHIP_OVERRIDE.join("\n");
  assert.ok(prompt.endsWith(overrideBlock), "the override must be the final instruction");
  assert.ok(prompt.includes("speech-bubble contents"), "the override must name the exact thing the brief asked for");
});

test("P1-2: a brief demanding a hand-lettered typeface cannot make typography the generator's job", () => {
  const prompt = buildGenerativeImagePrompt(contradictorySpec());

  assert.ok(prompt.includes("Hand-lettered or soft rounded typeface for the bubbles"), "the brief text is preserved");
  const typefaceAt = prompt.indexOf("Hand-lettered or soft rounded typeface");
  const overrideAt = prompt.indexOf("FINAL TEXT-OWNERSHIP OVERRIDE:");
  assert.ok(overrideAt > typefaceAt, "the override must come after the typeface instruction");

  for (const owned of ["typography", "fonts/typefaces", "labels", "logos", "branding"]) {
    assert.ok(prompt.includes(owned), `the override must reclaim ${owned}`);
  }
  // Layout intent is kept rather than thrown away -- the bubble's SPACE is still wanted, empty.
  assert.ok(prompt.includes("Preserve only the visual/layout intent of those instructions."));
  assert.ok(prompt.includes("leave that area blank or visually suitable for app-rendered text"));
  assert.ok(prompt.includes("Do not render glyphs or pseudo-text."));
});

test("P1-3: the override is positioned after Concept, Style, Scene and Constraints, always", () => {
  for (const spec of [contradictorySpec(), imageSpec(), imageSpec({ visualBrief: null })]) {
    const prompt = buildGenerativeImagePrompt(spec);
    const overrideAt = prompt.indexOf("FINAL TEXT-OWNERSHIP OVERRIDE:");
    assert.ok(overrideAt > 0, "the override is always present");

    for (const label of ["Concept:", "Style:", "Scene:"]) {
      const at = prompt.indexOf(label);
      assert.ok(at >= 0 && at < overrideAt, `${label} must precede the override`);
    }
    // A spec with no executionNotes drops the Constraints line entirely; when present it must also
    // precede the override, which is the case the filter(Boolean) could otherwise have disturbed.
    const constraintsAt = prompt.indexOf("Constraints:");
    if (constraintsAt >= 0) {
      assert.ok(constraintsAt < overrideAt, "Constraints must precede the override");
    }
    assert.ok(prompt.endsWith(GENERATIVE_IMAGE_TEXT_OWNERSHIP_OVERRIDE.join("\n")));
  }
});

test("P1-4: the overlayText value itself never reaches the provider prompt", () => {
  const spec = contradictorySpec();
  const prompt = buildGenerativeImagePrompt(spec);
  assert.ok(spec.copy.overlayText, "fixture must carry overlay text");
  assert.equal(prompt.includes(spec.copy.overlayText as string), false);
  // The brief may TALK about "the overlay text"; the words themselves are still never supplied.
  assert.ok(prompt.includes("carrying the first line of the overlay text"));
});

test("P1-5: the social caption never reaches the provider prompt when a brief exists", () => {
  const spec = contradictorySpec();
  assert.equal(buildGenerativeImagePrompt(spec).includes(spec.copy.caption), false);
});

test("P1-6: Cloudflare and the manual package share the hardened prompt, byte for byte", () => {
  const spec = contradictorySpec();
  const automated = buildGenerativeImagePrompt(spec);
  const document = renderProductionPromptPackage(spec);

  assert.ok(document.includes(automated), "the manual package embeds the hardened prompt verbatim");

  const start = document.indexOf("-- COPY EVERYTHING BETWEEN THE MARKERS INTO CHATGPT IMAGES");
  const end = document.indexOf("-- END OF PROMPT");
  const block = document.slice(start, end);
  assert.ok(block.includes("FINAL TEXT-OWNERSHIP OVERRIDE:"), "the override is inside what the owner copies");
  assert.ok(block.trimEnd().endsWith("The app adds all readable copy after illustration generation."), "and it is the last line of it");
});

test("P1-7: hardening kept the prompt deterministic", () => {
  const spec = contradictorySpec();
  assert.equal(buildGenerativeImagePrompt(spec), buildGenerativeImagePrompt(spec));
  assert.equal(buildGenerativeImagePrompt(contradictorySpec()), buildGenerativeImagePrompt(contradictorySpec()));
  assert.equal(renderProductionPromptPackage(contradictorySpec()), renderProductionPromptPackage(contradictorySpec()));
});

// --- clipboard payload vs owner documentation -------------------------------------------------------
//
// The Production panel shows the WHOLE package and copies ONLY the canonical prompt. That split is
// load-bearing and was briefly wrong: the copy button wrote the full document, which would have put
// the caption, the overlay text, and the brief's raw executionNotes -- "Hand-lettered or soft rounded
// typeface for the bubbles" among them -- into ChatGPT AFTER the text-ownership override, making a
// typography instruction the model's closing directive and undoing the P1 fix entirely.
//
// These tests pin the payload by value, and pin the component to the state variable that holds it.

// The exact expression the component copies, resolved here from the same pure function the component
// calls, so "what the clipboard receives" is a value this suite can assert on rather than a DOM event.
function clipboardPayload(spec: ProductionImageSpecV1): string {
  return buildGenerativeImagePrompt(spec);
}

test("CLIP-1: the clipboard payload is byte-for-byte buildGenerativeImagePrompt(spec)", () => {
  for (const spec of [imageSpec(), contradictorySpec(), imageSpec({ visualBrief: null })]) {
    assert.equal(clipboardPayload(spec), buildGenerativeImagePrompt(spec));
  }

  // And the component copies THAT, not the document. imagePrompt is set from
  // buildGenerativeImagePrompt; promptPackage is the rendered document; only the former is written.
  const component = readFileSync(new URL("../src/components/creative-package-production.tsx", import.meta.url), "utf8");
  assert.match(component, /setImagePrompt\(buildGenerativeImagePrompt\(spec\)\)/);
  assert.match(component, /navigator\.clipboard\.writeText\(imagePrompt\)/);
  assert.equal(/writeText\(promptPackage\)/.test(component), false, "the owner documentation must never reach the clipboard");
});

test("CLIP-2: the clipboard payload contains no social caption", () => {
  for (const spec of [imageSpec(), contradictorySpec()]) {
    assert.equal(clipboardPayload(spec).includes(spec.copy.caption), false);
  }
});

test("CLIP-3: the clipboard payload contains no overlayText", () => {
  for (const spec of [imageSpec(), contradictorySpec()]) {
    const overlayText = spec.copy.overlayText;
    assert.ok(overlayText, "fixture must carry overlay text");
    assert.equal(clipboardPayload(spec).includes(overlayText), false);
  }
});

test("CLIP-4: the clipboard payload excludes owner-only sections that follow the prompt", () => {
  const spec = contradictorySpec();
  const payload = clipboardPayload(spec);
  const document = renderProductionPromptPackage(spec);

  // Every heading the document adds around the prompt is owner-only.
  for (const ownerOnly of [
    "WHO MAKES WHAT",
    "DO NOT ASK THE IMAGE GENERATOR FOR",
    "OVERLAY TEXT -- drawn by this app",
    "CAPTION -- goes under the post",
    "CALL TO ACTION",
    "COMPOSITION",
    "BEFORE YOU UPLOAD, CHECK",
    "NEXT",
    "-- COPY EVERYTHING BETWEEN THE MARKERS",
    "-- END OF PROMPT",
  ]) {
    assert.ok(document.includes(ownerOnly), `the document should still show ${ownerOnly}`);
    assert.equal(payload.includes(ownerOnly), false, `${ownerOnly} must not reach the image model`);
  }

  // THE REGRESSION THAT MATTERS. The brief's typeface note appears twice in the document: once inside
  // the prompt (before the override, where the override neutralises it) and once under COMPOSITION
  // (after it). The payload must contain only the first.
  const typeface = "Hand-lettered or soft rounded typeface for the bubbles";
  assert.equal(document.split(typeface).length - 1, 2, "the document shows it in the prompt and in COMPOSITION");
  assert.equal(payload.split(typeface).length - 1, 1, "the payload carries it once, before the override");
  assert.ok(payload.indexOf(typeface) < payload.indexOf("FINAL TEXT-OWNERSHIP OVERRIDE:"));
});

test("CLIP-5: the clipboard payload ends with the text-ownership override", () => {
  for (const spec of [imageSpec(), contradictorySpec(), imageSpec({ visualBrief: null })]) {
    assert.ok(clipboardPayload(spec).endsWith(GENERATIVE_IMAGE_TEXT_OWNERSHIP_OVERRIDE.join("\n")));
    assert.ok(clipboardPayload(spec).trimEnd().endsWith("The app adds all readable copy after illustration generation."));
  }
});

test("CLIP-6: Cloudflare and the clipboard receive identical bytes", async () => {
  const spec = contradictorySpec();

  // What Cloudflare actually receives, read off the FormData the executor builds -- not re-derived.
  const { buildCloudflareGenerativeImageExecutor } = await import("../src/lib/production-asset-executors.ts");
  const sharp = (await import("sharp")).default;
  const png = new Uint8Array(await sharp({ create: { width: 8, height: 8, channels: 4, background: { r: 1, g: 1, b: 1, alpha: 1 } } }).png().toBuffer());

  let sentToProvider = "";
  const executor = buildCloudflareGenerativeImageExecutor({
    accountId: "account",
    apiToken: "token",
    fetchImpl: async (_input, init) => {
      sentToProvider = String((init?.body as FormData).get("prompt"));
      return new Response(Buffer.from(png), { status: 200, headers: { "content-type": "image/png" } });
    },
  });
  await executor(
    { id: "asset-job-1", creativePackageId: "package-1", status: "running", workerType: "generative_image", assetKind: "image", attemptCount: 1 } as never,
    spec,
    { signal: new AbortController().signal, recordProvenance: () => {} },
  );

  assert.equal(sentToProvider, clipboardPayload(spec), "the provider prompt and the clipboard payload must be the same bytes");
});
