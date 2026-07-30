import test from "node:test";
import assert from "node:assert/strict";

import { createAnthropicProductTextExecutor } from "../../../scripts/creative-workers/anthropic-text-provider.ts";
import type { CreativeJobRecord } from "../../../src/lib/creative-jobs.ts";
import type { OpportunityRecord } from "../../../src/lib/opportunities.ts";
import { resolvePaidAnthropicSmokeGate } from "./paid-smoke-gate.ts";

// Opt-in only, and doubly so. Not part of `npm test` (excluded from tests/*.test.ts) and not
// part of `advisor:smoke` (lives in tests/smoke/creative-workers/, a separate glob from
// tests/smoke/*.test.ts -- neither glob recurses into this subdirectory). Beyond that path
// isolation, this test makes one real, billable request, so it also requires BOTH
// ANTHROPIC_API_KEY and RUN_PAID_ANTHROPIC_SMOKE=1 to be set explicitly -- an API key being
// present in the environment is never enough on its own. Run explicitly with
// `RUN_PAID_ANTHROPIC_SMOKE=1 npm run creative-workers:smoke`.

const gate = resolvePaidAnthropicSmokeGate(process.env);
const apiKey = process.env.ANTHROPIC_API_KEY;

test("createAnthropicProductTextExecutor produces a real headline and caption from the live API", { skip: gate.ok ? false : gate.message }, async () => {
  const opportunity: OpportunityRecord = {
    id: "smoke-opportunity",
    opportunityType: "product_marketing_content",
    producer: "daily_advisor",
    sourceType: "daily_advisor",
    sourceId: "smoke-source",
    title: "Create launch-ready product content for Brownies",
    summary: "Brownies has enough proof for a marketing content Opportunity.",
    reason: "Rule Engine evidence supports creating marketing content.",
    recommendedAction: "create_content",
    evidenceVersion: "v1",
    evidence: { product: { id: "brownies", name: "Brownies" } },
    sourceRuleIds: ["RULE-001"],
    sourceFindings: [],
    detectedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    deduplicationKey: "smoke-key",
    status: "accepted",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const executor = createAnthropicProductTextExecutor({ apiKey: apiKey! });
  const envelope = (await executor({ id: "smoke-job" } as CreativeJobRecord, opportunity, { signal: new AbortController().signal })) as {
    output: { headline: string; caption: string };
  };

  assert.ok(envelope.output.headline.trim().length > 0, "expected a non-empty headline from the live API");
  assert.ok(envelope.output.caption.trim().length > 0, "expected a non-empty caption from the live API");
});
