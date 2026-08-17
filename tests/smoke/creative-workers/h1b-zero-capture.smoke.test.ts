import test from "node:test";
import assert from "node:assert/strict";

import { loadCreativeAiGrounding, type CreativeAiGroundingReadClient } from "../../../scripts/creative-workers/creative-ai-grounding.ts";
import { createCreativeAiExecutor } from "../../../src/lib/creative-generation/creative-ai-executor.ts";
import { buildDefaultCreativeAiRoutes } from "../../../src/lib/creative-generation/ai-orchestrator.ts";
import { ClaudeCliProvider } from "../../../src/lib/ai/providers/claude-cli-provider.ts";
import { CodexCliProvider } from "../../../src/lib/ai/providers/codex-cli-provider.ts";
import { resolveCreativeGrounding } from "../../../src/lib/creative-subject-resolution.ts";
import { buildCreativeInputFromRequest } from "../../../src/lib/creative-input.ts";
import { buildCreativePackageView, formatCreativePackageForClipboard } from "../../../src/lib/creative-package-view.ts";
import { flattenVisualBrief } from "../../../src/lib/creative-generation/assemble.ts";
import { BUSINESS_TIMEZONE, resolveBusinessDay } from "../../../src/lib/business-day.ts";
import type { CreativeJobRecord, CreativeJobResultEnvelopeV2 } from "../../../src/lib/creative-jobs.ts";

// Content Creation MVP H1-B -- the zero-capture owner request, end to end.
//
// Same shape as the H1 smoke beside it: the deterministic assertions drive the REAL grounding bridge
// (loadCreativeAiGrounding -> real mappers -> real recommendation engine -> real resolver) and always
// run offline; the single AI generation is opt-in via RUN_H1B_AI_SMOKE=1 and spawns the locally
// installed, subscription-authenticated Claude Code CLI. No ANTHROPIC_API_KEY is read or required.
//
// Run explicitly with `RUN_H1B_AI_SMOKE=1 npm run creative-workers:smoke`.

const NOW = Date.now();
const TODAY = resolveBusinessDay(NOW, BUSINESS_TIMEZONE);

// The literal request from the H1-B brief. No explicit product, no formatHint.
const REQUEST = "Give me something funny today. I don't have time to take photos or videos.";

function isoDaysAgo(days: number): string {
  return resolveBusinessDay(NOW - days * 24 * 60 * 60 * 1000, BUSINESS_TIMEZONE);
}

// Supabase row shapes, not application types -- this exercises the real mappers. Deliberately the
// same scenario as the H1 smoke: today's Blondies bake IS capturable, which is exactly what makes
// this a test rather than a formality. H1-A would promote it; H1-B must not, because the owner has
// said they will not be photographing anything.
const PRODUCT_ROWS = [
  {
    id: "biscoff-blondies",
    name: "Biscoff Blondies",
    category: "Baked goods",
    product_role: "Hero candidate",
    status: "testing",
    description: "Brown butter blondie with a Biscoff swirl.",
    notes: null,
    main_photo_url: null,
    decision: "Needs proof",
    is_public: false,
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:00.000Z",
  },
  {
    id: "banana-bread",
    name: "Banana Bread",
    category: "Baked goods",
    product_role: "Hero candidate",
    status: "testing",
    description: "Loaf with toasted walnuts.",
    notes: null,
    main_photo_url: null,
    decision: "Needs proof",
    is_public: false,
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:00.000Z",
  },
];

const JOURNAL_ROWS = [
  {
    id: "journey-today-blondies",
    product_id: "biscoff-blondies",
    entry_date: TODAY,
    what_was_made: "Baked a tray of Biscoff Blondies this morning. They are cooling on the counter now and ready to photograph or film.",
    media_captured: "Nothing yet",
    lesson_learned: "The Biscoff swirl held its shape at 175C",
    post_ideas: "Close-up of the swirl",
    next_action: "Shoot them before they go",
    entry_type: "bake",
  },
  {
    id: "journey-old-blondies",
    product_id: "biscoff-blondies",
    entry_date: isoDaysAgo(9),
    what_was_made: "First Biscoff Blondies test batch",
    media_captured: "Two phone photos",
    lesson_learned: "Needed five more minutes",
    post_ideas: "",
    next_action: "Re-bake",
    entry_type: "test",
  },
];

const BRAND_PROFILE_ROW = {
  is_active: true,
  facebook_handle: "alyandpon",
  facebook_url: "https://facebook.com/alyandpon",
  instagram_handle: "alyandpon",
  instagram_url: "https://instagram.com/alyandpon",
  tiktok_handle: "",
  tiktok_url: "",
};

function readClient(): CreativeAiGroundingReadClient {
  const tables: Record<string, Record<string, unknown>[]> = {
    products: PRODUCT_ROWS,
    ingredients: [],
    content_journal: JOURNAL_ROWS,
  };

  return {
    from(table: string) {
      return {
        select() {
          return {
            order: () => Promise.resolve({ data: tables[table] ?? [], error: null }),
            eq: () => ({
              limit: () => ({
                maybeSingle: () => Promise.resolve({ data: BRAND_PROFILE_ROW, error: null }),
              }),
            }),
          };
        },
      };
    },
  };
}

async function realGrounding() {
  const loaded = await loadCreativeAiGrounding(readClient(), { now: () => NOW });
  assert.ok(loaded.ok, loaded.ok ? "" : loaded.message);
  return loaded.grounding;
}

// ---- the gate change, through the real bridge and resolver -------------------------------------

test("the zero-capture request does NOT take the H1-A same-day capturable override", async () => {
  const grounding = await realGrounding();

  const resolved = resolveCreativeGrounding({
    creativeInput: buildCreativeInputFromRequest({ text: REQUEST }),
    recommendations: grounding.recommendations,
    journal: grounding.journal,
    products: grounding.products,
    brandBible: grounding.brandBible,
    now: NOW,
  });

  assert.doesNotMatch(resolved.subjectGrounding ?? "", /Capturable now/, "the capture override must not fire for a zero-capture request");

  // And the control: the same scenario with capture allowed still takes it, so this is a gate rather
  // than a regression of H1-A.
  const capture = resolveCreativeGrounding({
    creativeInput: buildCreativeInputFromRequest({ text: "Give me something easy today." }),
    recommendations: grounding.recommendations,
    journal: grounding.journal,
    products: grounding.products,
    brandBible: grounding.brandBible,
    now: NOW,
  });
  assert.equal(capture.subject, "Biscoff Blondies");
  assert.match(capture.subjectGrounding ?? "", /Capturable now/);
});

// ---- §25: exactly ONE real AI generation -------------------------------------------------------

const aiSkip = process.env.RUN_H1B_AI_SMOKE === "1" ? false : "Skipped: spawns the real Claude CLI. Set RUN_H1B_AI_SMOKE=1 to run.";

test("one real generation on a zero-capture request produces an executable, camera-free package", { skip: aiSkip }, async () => {
  const grounding = await realGrounding();

  const executor = createCreativeAiExecutor({
    loadGrounding: async () => grounding,
    routes: buildDefaultCreativeAiRoutes({ claude: new ClaudeCliProvider(), codex: new CodexCliProvider() }),
    now: () => NOW,
  });

  const result = (await executor(
    { id: "h1b-smoke-job" } as CreativeJobRecord,
    buildCreativeInputFromRequest({ text: REQUEST }),
    { signal: new AbortController().signal },
  )) as CreativeJobResultEnvelopeV2 | { creativeJobExecutorFailure: true };

  assert.ok(!("creativeJobExecutorFailure" in result), `generation failed: ${JSON.stringify(result)}`);
  const envelope = result as CreativeJobResultEnvelopeV2;
  const content = envelope.content;

  const view = buildCreativePackageView(content);
  assert.ok(view.ok, view.ok ? "" : view.message);
  const rendered = formatCreativePackageForClipboard(view.view);

  // Printed BEFORE the assertions, deliberately. This is a one-shot billable generation: the
  // evidence is the point of running it, and a failing assertion must not swallow the sample.
  console.log(
    JSON.stringify(
      {
        request: REQUEST,
        subject: content.subject,
        subjectSource: content.metadata.subjectSource,
        subjectGrounding: content.metadata.subjectGrounding,
        format: content.format,
        formatChosenBy: content.metadata.formatChosenBy,
        formatRationale: content.metadata.formatRationale,
        productionSource: content.productionSource,
        content,
        rendered,
        trace: envelope.executionTrace,
      },
      null,
      2,
    ),
  );

  // The contract H1-B adds.
  assert.ok(
    content.productionSource === "generate_visual" || content.productionSource === "template_only",
    `productionSource must be zero-capture, got ${String(content.productionSource)}`,
  );
  assert.notEqual(content.format, "reel", "a zero-capture request must never resolve to Reel");

  // No framing anywhere: there is no camera to point.
  assert.doesNotMatch(JSON.stringify(content), /"framing":/, "a zero-capture package must carry no framing");

  // The rendered execution experience the owner actually reads must contain no instruction to
  // capture anything.
  //
  // These match capture INSTRUCTIONS, not capture WORDS, and the distinction is load-bearing rather
  // than a loosening. The first live run of this smoke returned a package whose visual direction
  // ended "this is an illustration to be made in a design tool or by an illustrator; nothing here is
  // photographed" -- a sentence that contains "photographed" precisely in order to rule photography
  // out. A bare /photograph/i ban would fail the one output that states the boundary most clearly,
  // which would train the contract in exactly the wrong direction.
  for (const forbidden of [
    /take (this|a|the) photos?/i,
    /photograph (the|this|your|a|an)/i,
    /\bfilm (the|this|your|a|an)\b/i,
    /\bshoot (the|this|your|a|an)\b/i,
    /\brecord (the|this|your|a|an)\b/i,
    /point (the|your) (phone|camera)/i,
    /on (a|your) phone/i,
    /with (a|your) (phone|camera)/i,
    /\bcapture (the|this|a|an)\b/i,
  ]) {
    assert.doesNotMatch(rendered, forbidden, `rendered output must not instruct ${forbidden}`);
  }

  // The renderer's own capture headings are checked exactly, with no such nuance: these are strings
  // this application owns, so their absence is a hard property rather than a judgement about prose.
  for (const heading of ["Take this photo", "Record these shots"]) {
    assert.equal(rendered.includes(heading), false, `rendered output must not use the capture heading "${heading}"`);
  }

  // ---- P1 §16: the two owner-test defects this wave exists to fix ------------------------------
  //
  // Asserted against the PUBLIC copy fields specifically, assembled from the package rather than
  // from `rendered`: the clipboard also carries Creative details and the production route, and the
  // grounding legitimately survives in metadata. Checking the wrong string here would either miss
  // the defect or ban a sentence that is allowed to exist.
  const publicCopy = [
    content.angle,
    content.hook,
    content.headline,
    content.caption,
    content.cta,
    ...content.platformVariants.flatMap((variant) => [variant.caption, ...variant.hashtags]),
    ...(content.format === "photo" ? [content.visualDirection, content.overlayText ?? ""] : []),
    ...(content.format === "carousel" ? content.slides.flatMap((slide) => [slide.heading, slide.body, slide.visualDirection]) : []),
    ...(content.format === "story" ? content.frames.flatMap((frame) => [frame.visualDirection, frame.text]) : []),
  ].join("\n");

  // §3 -- internal vocabulary must not reach a follower. "Journey" is the term the owner test
  // actually leaked ("First time they've turned up here in the Journey...").
  for (const internalTerm of [/\bjourney\b/i, /\bgrounding\b/i, /marketing recommendation/i, /content journal/i, /product lab/i, /content engine/i]) {
    assert.doesNotMatch(publicCopy, internalTerm, `public copy must not name internal machinery: ${internalTerm}`);
  }

  // §2 -- absence from the Journey may justify INTRODUCING the subject, and may not be generalised
  // into real-world history. The subject here is selected precisely because it is absent, so this is
  // the exact condition that produced the defect rather than a hypothetical one.
  for (const absenceClaim of [
    /never (once )?(shown|showed) up/i,
    /never (been )?(posted|shared|published|featured|photographed|pictured|filmed)/i,
    /never made it into a (photo|picture|post)/i,
    /never appeared/i,
    /first time (we|they|it|I)/i,
    /for the first time/i,
    /\bfirst[- ]ever\b/i,
    /\buntil now\b/i,
    /\bnever before\b/i,
    /brand[- ]new/i,
    /new on (the|our) menu/i,
  ]) {
    assert.doesNotMatch(publicCopy, absenceClaim, `public copy must not generalise an absent Journey row into history: ${absenceClaim}`);
  }

  // The permission half, verified as a live property rather than only as a prompt fragment: the
  // subject was chosen BECAUSE it is absent, so it must still be legitimately present in the copy.
  // A wave that hardened absence into "never mention the subject" would pass every ban above and
  // still be a regression.
  assert.match(publicCopy, new RegExp(content.subject.split(" ")[0], "i"), "the chosen subject must still appear in the public copy");

  // ---- P1 §7: the structured zero-capture visual brief ------------------------------------------
  //
  // Conditional on format, because the generator still chooses it: visualBrief is a Photo contract,
  // and a Carousel or Story answer to this request remains legitimate. Asserting it unconditionally
  // would make this smoke fail on a valid package.
  if (content.format === "photo") {
    assert.ok(content.visualBrief !== undefined, "a non-capture Photo must carry a structured visualBrief");
    const brief = content.visualBrief;

    assert.ok(brief.concept.trim().length > 0, "concept must be non-empty");
    assert.ok(brief.style.trim().length > 0, "style must be non-empty");
    assert.ok(brief.scene.length >= 1, "scene must carry at least one instruction");
    assert.ok(brief.executionNotes.length >= 1, "executionNotes must carry at least one note");

    // The compatibility form is DERIVED, not authored: it must be exactly the flattener's output, so
    // the structured brief and the flat string cannot have drifted apart.
    assert.equal(content.visualDirection, flattenVisualBrief(brief), "visualDirection must be the deterministic flattening of visualBrief");

    // And the rendered brief is the structured one -- the readability outcome this wave exists for.
    const photoLines = view.view.production[0].blocks[0].lines;
    assert.deepEqual(
      photoLines.filter((line) => line.label !== null).map((line) => line.label),
      ["Concept", "Style", "Scene", ...(content.overlayText === null ? [] : ["Add this text to the visual"]), "Execution notes"],
      "the owner must read a labelled structured brief, not one paragraph",
    );

    // overlayText stays the single source for the text on the visual.
    if (content.overlayText !== null && content.overlayText.trim().length > 0) {
      const overlay = content.overlayText.trim().toLowerCase();
      for (const entry of [brief.concept, brief.style, ...brief.scene, ...brief.executionNotes]) {
        assert.notEqual(entry.trim().toLowerCase(), overlay, "visualBrief must not restate overlayText");
      }
    }
  }
});
