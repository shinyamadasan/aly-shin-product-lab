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
});
