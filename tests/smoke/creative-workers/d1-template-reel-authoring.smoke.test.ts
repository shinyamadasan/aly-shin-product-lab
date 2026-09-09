import test from "node:test";
import assert from "node:assert/strict";

import { loadCreativeAiGrounding, type CreativeAiGroundingReadClient } from "../../../scripts/creative-workers/creative-ai-grounding.ts";
import { buildDefaultCreativeAiRoutes } from "../../../src/lib/creative-generation/ai-orchestrator.ts";
import { createCreativeAiExecutor } from "../../../src/lib/creative-generation/creative-ai-executor.ts";
import {
  findImpossibleFormatRequest,
  productionSourcesForFormat,
  resolveCreativeProductionConstraint,
} from "../../../src/lib/creative-generation/contracts.ts";
import { needsFormatDecision } from "../../../src/lib/creative-generation/prompt.ts";
import { ClaudeCliProvider } from "../../../src/lib/ai/providers/claude-cli-provider.ts";
import { CodexCliProvider } from "../../../src/lib/ai/providers/codex-cli-provider.ts";
import { buildCreativeInputFromRequest } from "../../../src/lib/creative-input.ts";
import { BUSINESS_TIMEZONE, resolveBusinessDay } from "../../../src/lib/business-day.ts";
import { validateCreativePackageContentV2, type CreativePackageContentV2 } from "../../../src/lib/creative-package-content-v2.ts";
import type { CreativeFormat } from "../../../src/lib/creative-formats.ts";
import type { CreativeJobRecord, CreativeJobResultEnvelopeV2 } from "../../../src/lib/creative-jobs.ts";
import {
  isCreativeMovement,
  isCreativeShotSeconds,
  type CreativeProductionSource,
} from "../../../src/lib/creative-production-guidance.ts";

// Wave D1 live regression. Opt-in only because it spends local subscription-backed AI usage.
//
// Run explicitly with:
//   RUN_D1_TEMPLATE_REEL_AI_SMOKE=1 node --test tests/smoke/creative-workers/d1-template-reel-authoring.smoke.test.ts

const NOW = Date.now();
const TODAY = resolveBusinessDay(NOW, BUSINESS_TIMEZONE);

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
];

const BRAND_PROFILE_ROW = {
  is_active: true,
  facebook_handle: "",
  facebook_url: "",
  instagram_handle: "alyandpon",
  instagram_url: "https://instagram.com/alyandpon",
  tiktok_handle: "",
  tiktok_url: "",
};

const CASES: Array<{
  id: string;
  text: string;
  formatHint?: CreativeFormat;
  expectFormat?: CreativeFormat;
  expectProductionSource?: CreativeProductionSource;
  expectFailure?: boolean;
}> = [
  {
    id: "explicit-zero-capture-reel",
    text: "Make this with zero filming. Keep it as a simple Reel about sharing one brownie.",
    formatHint: "reel",
    expectFormat: "reel",
    expectProductionSource: "template_only",
  },
  {
    id: "conceptual-zero-capture-comparison-reel",
    text: "Make a two-beat Reel joke about corner versus centre blondies. No filming today.",
    formatHint: "reel",
    expectFormat: "reel",
    expectProductionSource: "template_only",
  },
  {
    id: "actual-texture-proof-reel",
    text: "Make a Reel showing the actual Biscoff swirl texture in the blondies.",
    formatHint: "reel",
    expectFormat: "reel",
    expectProductionSource: "capture_new",
  },
  {
    id: "real-cut-break-process-reel",
    text: "Make a Reel of the real brownie break as we cut it.",
    formatHint: "reel",
    expectFormat: "reel",
    expectProductionSource: "capture_new",
  },
  {
    id: "ambiguous-reel-source-model-selected",
    text: "Make an easy Reel about the blondies cooling on the counter today.",
    formatHint: "reel",
    expectFormat: "reel",
  },
  {
    id: "contradictory-proof-with-no-filming",
    text: "No filming, but show the actual brownie texture.",
    formatHint: "reel",
    expectFailure: true,
  },
];

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

function assertTemplateReel(content: CreativePackageContentV2): void {
  assert.equal(content.format, "reel");
  assert.equal(content.productionSource, "template_only");
  assert.ok(content.shots.length >= 1 && content.shots.length <= 2, "Template Reel must be one or two beats");
  assert.equal(content.spokenScript, null, "Template Reel must have no generated voice");
  assert.doesNotMatch(JSON.stringify(content), /"framing":/, "Template Reel must not carry camera framing");
  for (const shot of content.shots) {
    assert.equal(typeof shot.direction, "string", "Template Reel shot must carry direction text");
    assert.ok(shot.direction.trim().length > 0, "Template Reel shot must carry direction text");
    assert.ok(isCreativeShotSeconds(shot.approxSeconds), "Template Reel shot must carry a positive executable duration");
    assert.ok(
      shot.movement === undefined || shot.movement === null || isCreativeMovement(shot.movement),
      "Template Reel movement is optional executable metadata and may be null",
    );
  }
}

const aiSkip =
  process.env.RUN_D1_TEMPLATE_REEL_AI_SMOKE === "1"
    ? false
    : "Skipped: spawns five real subscription-backed AI generations plus one deterministic contradiction check. Set RUN_D1_TEMPLATE_REEL_AI_SMOKE=1 to run.";

test("D1 live: Reel source constraints respect Template Reel authoring boundaries", { skip: aiSkip }, async () => {
  const loaded = await loadCreativeAiGrounding(readClient(), { now: () => NOW });
  assert.ok(loaded.ok, loaded.ok ? "" : loaded.message);

  const executor = createCreativeAiExecutor({
    loadGrounding: async () => loaded.grounding,
    routes: buildDefaultCreativeAiRoutes({ claude: new ClaudeCliProvider(), codex: new CodexCliProvider() }),
    now: () => NOW,
  });

  const samples = [];
  for (const sample of CASES) {
    const creativeInput = buildCreativeInputFromRequest({ text: sample.text, formatHint: sample.formatHint });
    const stage1Ran = needsFormatDecision(creativeInput);
    const selectedFormatForPrecheck = sample.formatHint ?? "reel";
    const allowedProductionSources = [
      ...productionSourcesForFormat(selectedFormatForPrecheck, resolveCreativeProductionConstraint(creativeInput)),
    ];

    if (sample.expectFailure) {
      const impossible = findImpossibleFormatRequest(creativeInput);
      assert.notEqual(impossible, null, `${sample.id} must fail before body generation`);
      assert.deepEqual(allowedProductionSources, [], `${sample.id} must leave no truthful Reel source`);
      samples.push({
        id: sample.id,
        request: sample.text,
        stage1Ran,
        allowedProductionSources,
        chosenProductionSource: null,
        shotCount: null,
        spokenScript: null,
        framingPresence: null,
        outputText: null,
        factuality: "No package generated; contradiction refused before body AI.",
        packageValidation: "not_run",
        modelCalls: 0,
        error: impossible?.message,
      });
      continue;
    }

    const result = (await executor(
      { id: `d1-smoke-${sample.id}` } as CreativeJobRecord,
      creativeInput,
      { signal: new AbortController().signal },
    )) as CreativeJobResultEnvelopeV2 | { creativeJobExecutorFailure: true };

    assert.ok(!("creativeJobExecutorFailure" in result), `${sample.id} generation failed: ${JSON.stringify(result)}`);
    const envelope = result as CreativeJobResultEnvelopeV2;
    const content = envelope.content;
    const validation = validateCreativePackageContentV2(content);
    const packageValidation = validation.ok ? "ok" : validation.message;
    assert.ok(validation.ok, validation.ok ? "" : `${sample.id}: ${validation.message}`);

    if (sample.expectFormat) {
      assert.equal(content.format, sample.expectFormat, sample.id);
    }
    if (sample.expectProductionSource) {
      assert.equal(content.productionSource, sample.expectProductionSource, sample.id);
    }
    if (content.format === "reel" && content.productionSource === "template_only") {
      assertTemplateReel(content);
    }
    assert.notEqual(content.format === "reel" && content.productionSource === "generate_visual", true, "Reel must never use generate_visual");

    samples.push({
      id: sample.id,
      request: sample.text,
      stage1Ran,
      allowedProductionSources: [...productionSourcesForFormat(content.format, resolveCreativeProductionConstraint(creativeInput))],
      format: content.format,
      chosenProductionSource: content.productionSource,
      shotCount: content.format === "reel" ? content.shots.length : null,
      spokenScript: content.format === "reel" ? content.spokenScript : null,
      framingPresence: content.format === "reel" ? content.shots.map((shot) => "framing" in shot) : null,
      outputText: {
        angle: content.angle,
        hook: content.hook,
        headline: content.headline,
        caption: content.caption,
        cta: content.cta,
        platformVariants: content.platformVariants,
        shots:
          content.format === "reel"
            ? content.shots.map((shot) => ({
                direction: shot.direction,
                onScreenText: shot.onScreenText,
                approxSeconds: shot.approxSeconds,
                framing: "framing" in shot ? shot.framing : null,
                movement: shot.movement,
              }))
            : undefined,
        audioDirection: content.format === "reel" ? content.audioDirection : undefined,
      },
      factuality: "Package validated against supplied facts and D1 source constraints; manual reviewer should still inspect copy nuance.",
      packageValidation,
      modelCalls: envelope.executionTrace.length,
      trace: envelope.executionTrace,
    });
  }

  console.log(JSON.stringify({ samples }, null, 2));
});
