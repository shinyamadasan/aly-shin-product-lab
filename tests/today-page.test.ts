import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { headlineAndReason } from "../src/lib/today-recommendation-copy.ts";
import type { TodaysReadyOpportunity } from "../src/lib/todays-recommendation.ts";
import type { OpportunityListRecord } from "../src/lib/opportunity-review.ts";
import type { CreativePackageRecord } from "../src/lib/creative-packages.ts";

const source = readFileSync(new URL("../src/components/today-page.tsx", import.meta.url), "utf8");
const productLabSource = readFileSync(new URL("../src/app/product-lab.tsx", import.meta.url), "utf8");
const labStateSource = readFileSync(new URL("../src/lib/lab-state.ts", import.meta.url), "utf8");
const appShellSource = readFileSync(new URL("../src/components/app-shell.tsx", import.meta.url), "utf8");
const dashboardRouteSource = readFileSync(new URL("../src/app/dashboard/page.tsx", import.meta.url), "utf8");
const recommendationCopySource = readFileSync(new URL("../src/lib/today-recommendation-copy.ts", import.meta.url), "utf8");

// Words that describe the machinery, not the moment -- banned from anything Today renders, per
// today-product-spec.md's User Language section. Deliberately checked against today-page.tsx's own
// source only: it is the one file this slice owns end to end, and it is the file responsible for
// composing the embedded components' ritual variant, which is what keeps their own vocabulary off
// the rendered screen.
const BANNED_VOCABULARY = /\bOpportunity\b|\bCreative Job\b|\bAsset Job\b|\bqueued\b|\bworker\b|\bschema\b|storage path/i;

function opportunity(overrides: Partial<OpportunityListRecord> = {}): OpportunityListRecord {
  return {
    id: "opp-1",
    opportunityType: "product_marketing_content",
    producer: "daily_advisor",
    sourceType: "daily_advisor",
    sourceId: "daily_advisor:2026-08-06:product_marketing_content:brownies",
    title: "Create product content for Brownies",
    summary: "No brownie content in 6 days.",
    recommendedAction: "create_content",
    status: "accepted",
    detectedAt: "2026-08-06T01:00:00.000Z",
    expiresAt: "2026-08-09T01:00:00.000Z",
    createdAt: "2026-08-06T01:05:00.000Z",
    updatedAt: "2026-08-06T01:05:00.000Z",
    ...overrides,
  };
}

function creativePackage(overrides: Partial<CreativePackageRecord> = {}): CreativePackageRecord {
  return {
    id: "pkg-1",
    creativeJobId: "job-1",
    status: "ready",
    schemaVersion: "v1",
    content: {
      output: { headline: "Create product content for Brownies", caption: "No brownie content in 6 days." },
      metadata: { generatedFromOpportunity: "opp-1", generatorVersion: "1", sourceCreativeJobId: "job-1", sourceWorker: "opportunity_brief", sourceJobResultSchemaVersion: "v1" },
      artifacts: [],
    },
    createdAt: "2026-08-06T01:16:00.000Z",
    updatedAt: "2026-08-06T01:16:00.000Z",
    ...overrides,
  };
}

function candidate(overrides: { opportunity?: Partial<OpportunityListRecord>; creativePackage?: Partial<CreativePackageRecord> } = {}): TodaysReadyOpportunity {
  return { opportunity: opportunity(overrides.opportunity), creativePackage: creativePackage(overrides.creativePackage) };
}

test("headlineAndReason: reads the Opportunity's own title/summary -- the recommendation, not the prepared artifact", () => {
  const result = headlineAndReason(candidate({ opportunity: { title: "Create product content for Brownies", summary: "No brownie content in 6 days." } }));
  assert.deepEqual(result, { headline: "Create product content for Brownies", reason: "No brownie content in 6 days." });
});

// Regression guard for the Opportunity/Creative-Package responsibility split: the recommendation
// must never drift from what the Creative Package's content happens to contain, including once a
// future (e.g. AI-generated) initializer stops copying the Opportunity's fields verbatim. Proven
// here directly -- give the two wildly different content, assert only the Opportunity's own fields
// come back.
test("headlineAndReason: is fully independent of Creative Package content -- diverging package output never changes the recommendation shown", () => {
  const result = headlineAndReason(
    candidate({
      opportunity: { title: "Create product content for Brownies", summary: "No brownie content in 6 days." },
      creativePackage: { content: { output: { headline: "Unrelated AI-generated headline", caption: "Unrelated AI-generated caption" }, metadata: {}, artifacts: [] } },
    }),
  );
  assert.deepEqual(result, { headline: "Create product content for Brownies", reason: "No brownie content in 6 days." });
});

test("headlineAndReason: never reads creativePackage.content at all -- proven by a malformed/empty content object producing no error and no effect", () => {
  const result = headlineAndReason(candidate({ creativePackage: { content: {} }, opportunity: { title: "Fallback title", summary: "Fallback summary" } }));
  assert.deepEqual(result, { headline: "Fallback title", reason: "Fallback summary" });
});

test("[static] today-recommendation-copy.ts's code (not its explanatory comments) never references creativePackage.content -- the responsibility split is structural, not just behavioral", () => {
  const codeOnly = recommendationCopySource
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
  assert.doesNotMatch(codeOnly, /creativePackage\.content|\.output\.headline|\.output\.caption|isCreativePackageContentV1/);
  assert.match(codeOnly, /candidate\.opportunity\.title/);
  assert.match(codeOnly, /candidate\.opportunity\.summary/);
});

test("[static] Today is declarative: it imports resolveTodayScreenState and switches on state.kind, never calling readiness/database logic itself", () => {
  assert.match(source, /import \{ resolveTodayScreenState/);
  assert.match(source, /switch \(state\.kind\)/);
  // Today never imports the functions that decide readiness/ordering -- those live entirely inside
  // resolveTodayScreenState (Slice 2) and listReadyOpportunities/selectTodaysReadyOpportunity (Slice 1).
  assert.doesNotMatch(source, /listReadyOpportunities|selectTodaysReadyOpportunity|selectPreparationCandidate|getCreativeJobForOpportunity|getCreativePackageForJob|listAssetJobsForCreativePackage\b/);
});

test("[static] Today never mutates or dismisses the underlying Opportunity -- no status-update or job/package-creation function is imported", () => {
  assert.doesNotMatch(source, /updateOpportunityStatus|createCreativeJobForAcceptedOpportunity|createAssetJobForReadyCreativePackage|createCreativePackageFromCompletedJob/);
});

test("[static] all six approved states have distinct, present copy in the switch", () => {
  assert.match(source, /case "fresh":/);
  assert.match(source, /Today&apos;s recommendation/);

  assert.match(source, /case "continue":/);
  assert.match(source, /in progress/);
  assert.match(source, /Waiting for your photo/);

  assert.match(source, /case "completed-today":/);
  assert.match(source, /Nice work — today's content is ready\./);

  assert.match(source, /case "prep-not-ready":/);
  assert.match(source, /isn&apos;t ready yet/);

  assert.match(source, /case "empty":/);
  assert.match(source, /Nothing stands out today\./);

  assert.match(source, /case "exhausted":/);
  assert.match(source, /No other recommendations today\./);
});

test("[static] completed-today never renders the creation flow -- only the ritual display component, not the ritual create component", () => {
  const match = source.match(/case "completed-today": \{[\s\S]*?\n {4}\}\r?\n/);
  assert.ok(match, "test fixture is stale -- could not locate the completed-today case block");
  const block = match[0];
  assert.doesNotMatch(block, /CreativePackageAssetCreate/);
  assert.match(block, /CreativePackageAssets creativePackageId/);
});

test("[static] continue and fresh both render the create component, and continue's copy never reuses fresh's eyebrow text verbatim", () => {
  const freshMatch = source.match(/case "fresh": \{[\s\S]*?\n {4}\}\r?\n/);
  const continueMatch = source.match(/case "continue": \{[\s\S]*?\n {4}\}\r?\n/);
  assert.ok(freshMatch && continueMatch, "test fixture is stale -- could not locate fresh/continue case blocks");
  assert.match(freshMatch[0], /CreativePackageAssetCreate creativePackageId/);
  assert.match(continueMatch[0], /CreativePackageAssetCreate creativePackageId/);
  // "continue" must not render the bare "Today's recommendation" eyebrow fresh uses -- that's the
  // one piece of copy that would make a same-day return look like a brand-new pick.
  assert.doesNotMatch(continueMatch[0], /Today&apos;s recommendation/);
});

test("[static] Not today excludes the current candidate and never fires until tapped -- no persistence, no server call", () => {
  assert.match(source, /function notToday\(opportunityId: string\)/);
  assert.match(source, /setExcludeOpportunityIds/);
  assert.doesNotMatch(source, /localStorage|sessionStorage|document\.cookie/);
});

test("[static] both embedded components are always called with variant=\"ritual\", never \"full\", from Today", () => {
  const createCalls = source.match(/<CreativePackageAssetCreate[\s\S]*?\/>/g) ?? [];
  const displayCalls = source.match(/<CreativePackageAssets[\s\S]*?\/>/g) ?? [];
  assert.ok(createCalls.length > 0 && displayCalls.length > 0, "test fixture is stale -- no embedded component calls found");
  for (const call of [...createCalls, ...displayCalls]) {
    assert.match(call, /variant="ritual"/);
  }
});

test("[static] no banned internal vocabulary appears in any of Today's user-facing strings or JSX text", () => {
  // Scoped to what the owner could actually see: quoted string literals (JSX attribute values,
  // MessageBox messages) and JSX text nodes (text directly between tags). Deliberately excludes
  // bare code -- property accesses like state.candidate.opportunity.id are legitimate internal
  // references the owner never sees, not copy, and checking raw source would false-positive on them.
  const userFacingPieces = source.match(/"(?:[^"\\]|\\.)*"|>[^<>{}\n]+</g) ?? [];
  assert.ok(userFacingPieces.length > 0, "test fixture is stale -- no quoted strings or JSX text found");
  for (const piece of userFacingPieces) {
    assert.doesNotMatch(piece, BANNED_VOCABULARY, `banned vocabulary found in user-facing piece: ${piece}`);
  }
});

test("[static] product-lab.tsx: Today is the default view, and the today branch is wired before dashboard's", () => {
  assert.match(productLabSource, /view = "today"/);
  assert.match(productLabSource, /view === "today" \? <TodayPage \/> : null/);
  // DashboardPage's own render branch and props are untouched -- same call as before this slice.
  assert.match(productLabSource, /view === "dashboard" \? <DashboardPage metrics=\{metrics\} labState=\{labState\} message=\{message\} messageTone=\{messageTone\} session=\{session\} signOut=\{signOut\} \/> : null/);
});

test("[static] lab-state.ts: today owns \"/\", dashboard moved to its own explicit route+nav entry", () => {
  assert.match(labStateSource, /\| "today"/);
  assert.match(labStateSource, /\{ label: "Today", href: "\/", view: "today" \}/);
  assert.match(labStateSource, /\{ label: "Dashboard", href: "\/dashboard", view: "dashboard" \}/);
});

test("[static] app-shell.tsx: today has a titles entry so AppHeader's titles[view] lookup type-checks", () => {
  assert.match(appShellSource, /today: "",/);
});

test("[static] dashboard route exists, reachable at its own URL, rendering Dashboard unchanged", () => {
  assert.match(dashboardRouteSource, /import ProductLab from "\.\.\/product-lab";/);
  assert.match(dashboardRouteSource, /<ProductLab view="dashboard" \/>/);
});
