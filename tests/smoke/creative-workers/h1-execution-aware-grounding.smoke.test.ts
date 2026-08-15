import test from "node:test";
import assert from "node:assert/strict";

import { loadCreativeAiGrounding, type CreativeAiGroundingReadClient } from "../../../scripts/creative-workers/creative-ai-grounding.ts";
import { createCreativeAiExecutor } from "../../../src/lib/creative-generation/creative-ai-executor.ts";
import { buildDefaultCreativeAiRoutes } from "../../../src/lib/creative-generation/ai-orchestrator.ts";
import { ClaudeCliProvider } from "../../../src/lib/ai/providers/claude-cli-provider.ts";
import { CodexCliProvider } from "../../../src/lib/ai/providers/codex-cli-provider.ts";
import { resolveCreativeGrounding } from "../../../src/lib/creative-subject-resolution.ts";
import { buildCreativeInputFromRequest } from "../../../src/lib/creative-input.ts";
import { BUSINESS_TIMEZONE, resolveBusinessDay } from "../../../src/lib/business-day.ts";
import type { CreativeJobRecord } from "../../../src/lib/creative-jobs.ts";
import type { CreativeJobResultEnvelopeV2 } from "../../../src/lib/creative-jobs.ts";

// Content Creation MVP H1 -- the owner-gate scenario, end to end.
//
// The deterministic resolver assertions below are free and offline: they drive the REAL grounding
// bridge (loadCreativeAiGrounding -> real mappers -> real recommendation engine -> real resolver)
// from Supabase-shaped rows, so nothing about the ranking is stubbed. Those always run.
//
// The single AI generation is opt-in via RUN_H1_AI_SMOKE=1. It spawns the locally installed,
// subscription-authenticated Claude Code CLI -- no ANTHROPIC_API_KEY is read or required -- and is
// excluded from `npm test` by path (neither tests/*.test.ts nor tests/smoke/*.test.ts recurses
// here). Run explicitly with `RUN_H1_AI_SMOKE=1 npm run creative-workers:smoke`.

const NOW = Date.now();
const TODAY = resolveBusinessDay(NOW, BUSINESS_TIMEZONE);

function isoDaysAgo(days: number): string {
  return resolveBusinessDay(NOW - days * 24 * 60 * 60 * 1000, BUSINESS_TIMEZONE);
}

// Supabase row shapes, not application types -- this exercises the real mappers.
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

// Biscoff Blondies has Journey history (so it is NOT a no_marketing_history candidate), including
// one entry written today establishing that a tray exists right now. Banana Bread has none, which
// is exactly what earns it the qualifying recommendation that used to win.
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

// The narrowest thing that satisfies CreativeAiGroundingReadClient. Read-only by construction --
// there is no insert/update/delete/rpc to call.
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

async function ownerGateGrounding() {
  const loaded = await loadCreativeAiGrounding(readClient(), { now: () => NOW });
  assert.ok(loaded.ok, loaded.ok ? "" : loaded.message);
  return loaded.grounding;
}

// ---- §13: the owner-gate scenario through the real bridge and resolver -------------------------

test("the real bridge produces the owner-gate grounding: a Banana Bread recommendation and today's Blondies bake", async () => {
  const grounding = await ownerGateGrounding();

  const bananaBread = grounding.recommendations.find(
    (entry) => entry.recommendationType === "no_marketing_history" && entry.evidence.productId === "banana-bread",
  );
  assert.ok(bananaBread, "the real engine must produce the qualifying Banana Bread recommendation this scenario depends on");

  assert.ok(
    !grounding.recommendations.some((entry) => entry.recommendationType === "no_marketing_history" && entry.evidence.productId === "biscoff-blondies"),
    "Biscoff Blondies has Journey history, so it must not also be a no_marketing_history candidate",
  );
  assert.ok(grounding.journal.some((entry) => entry.entryDate === TODAY && entry.productId === "biscoff-blondies"));
});

test('"Give me something easy today." resolves to Biscoff Blondies through the real grounding', async () => {
  const grounding = await ownerGateGrounding();

  const resolved = resolveCreativeGrounding({
    creativeInput: buildCreativeInputFromRequest({ text: "Give me something easy today." }),
    recommendations: grounding.recommendations,
    journal: grounding.journal,
    products: grounding.products,
    brandBible: grounding.brandBible,
    now: NOW,
  });

  assert.equal(resolved.subject, "Biscoff Blondies");
  assert.equal(resolved.productId, "biscoff-blondies");
  assert.equal(resolved.subjectKind, "product");
  assert.equal(resolved.subjectSource, "assumed");
  assert.match(resolved.subjectGrounding ?? "", /Capturable now/);
  assert.notEqual(resolved.subject, "Banana Bread");
});

// ---- §14: the control, with no AI call ---------------------------------------------------------

test('"Give me a content idea for this week." keeps the existing recommendation ranking', async () => {
  const grounding = await ownerGateGrounding();

  const resolved = resolveCreativeGrounding({
    creativeInput: buildCreativeInputFromRequest({ text: "Give me a content idea for this week." }),
    recommendations: grounding.recommendations,
    journal: grounding.journal,
    products: grounding.products,
    brandBible: grounding.brandBible,
    now: NOW,
  });

  assert.equal(resolved.subject, "Banana Bread", "a non-immediate request must not trigger the capturability override");
  assert.match(resolved.subjectGrounding ?? "", /^Marketing recommendation:/);
});

// ---- §13: one real AI generation, on the resolved grounding ------------------------------------

const aiSkip = process.env.RUN_H1_AI_SMOKE === "1" ? false : "Skipped: spawns the real Claude CLI. Set RUN_H1_AI_SMOKE=1 to run.";

test("one Creative AI generation on the H1-resolved subject produces an executable package", { skip: aiSkip }, async () => {
  const grounding = await ownerGateGrounding();

  const executor = createCreativeAiExecutor({
    loadGrounding: async () => grounding,
    routes: buildDefaultCreativeAiRoutes({ claude: new ClaudeCliProvider(), codex: new CodexCliProvider() }),
    now: () => NOW,
  });

  const result = (await executor(
    { id: "h1-smoke-job" } as CreativeJobRecord,
    buildCreativeInputFromRequest({ text: "Give me something easy today." }),
    { signal: new AbortController().signal },
  )) as CreativeJobResultEnvelopeV2 | { creativeJobExecutorFailure: true };

  assert.ok(!("creativeJobExecutorFailure" in result), `generation failed: ${JSON.stringify(result)}`);
  const envelope = result as CreativeJobResultEnvelopeV2;

  // The whole point of H1: the package the owner receives is about the thing on the counter.
  // The application owns every field asserted here -- none of them can come from the model.
  assert.equal(envelope.content.subject, "Biscoff Blondies");
  assert.equal(envelope.content.metadata.subjectSource, "assumed");
  assert.match(envelope.content.metadata.subjectGrounding ?? "", /Capturable now/);

  // S6 production guidance survives: contracts.ts requires framing on every generated format, so a
  // package with none would mean H1 had regressed the S6 generation contract.
  assert.match(JSON.stringify(envelope.content), /"framing":/, "S6 production guidance must survive H1");

  console.log(JSON.stringify({ trace: envelope.executionTrace, content: envelope.content }, null, 2));
});
