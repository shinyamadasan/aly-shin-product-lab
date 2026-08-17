import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  CREATE_NOW_AI_FORMAT_CHOICE,
  CREATE_NOW_EMPTY_TEXT_MESSAGE,
  CREATE_NOW_FORMAT_OPTIONS,
  CREATE_NOW_NO_PRODUCT_CHOICE,
  CREATE_NOW_PACKAGE_GRACE_LOOKS,
  CREATE_NOW_PACKAGE_PENDING_HEADLINE,
  CREATE_NOW_PACKAGE_PENDING_MESSAGE,
  CREATE_NOW_POLL_INTERVAL_MS,
  CREATE_NOW_WAITING_DETAIL,
  buildCreateNowRequest,
  describeCreateNowProgress,
  describeCreateNowScreenProgress,
  findSelectableCreateNowProduct,
  hasCreateNowPackageGraceExpired,
  resolveCreateNowJobId,
  selectableCreateNowProducts,
  shouldPollCreativeJobStatus,
  shouldRefreshCreateNowJob,
  toCreativeFormatHint,
  CREATE_NOW_QUEUED_SLOW_DETAIL,
  CREATE_NOW_QUEUED_SLOW_HEADLINE,
  CREATE_NOW_QUEUED_SLOW_MS,
  CREATE_NOW_RUNNING_SLOW_DETAIL,
  CREATE_NOW_RUNNING_SLOW_HEADLINE,
  CREATE_NOW_RUNNING_SLOW_MS,
  createNowElapsedMs,
  formatCreateNowElapsed,
  type CreateNowFormatChoice,
  type CreateNowJobTiming,
} from "../src/lib/create-now.ts";
import { CREATIVE_FORMATS, type CreativeFormat } from "../src/lib/creative-formats.ts";
import { validateCreativeRequest, buildCreativeInputFromRequest, toIntentJson, fromIntentJson } from "../src/lib/creative-input.ts";
import { resolveCreativeGrounding } from "../src/lib/creative-subject-resolution.ts";
import { BRAND_BIBLE } from "../src/lib/marketing-advisor-context.ts";
import type { MarketingRecommendation } from "../src/lib/marketing-recommendations.ts";
import {
  CREATIVE_JOB_STATUSES,
  createCreativeJobForAcceptedOpportunity,
  createCreativeJobFromRequest,
  type CreativeJobClient,
  type CreativeJobRow,
} from "../src/lib/creative-jobs.ts";
import { toOpportunityRow, type OpportunityDraft, type OpportunityRow } from "../src/lib/opportunities.ts";
import type { Product } from "../src/lib/product-lab-types.ts";

const createNowSource = readFileSync(new URL("../src/components/create-now.tsx", import.meta.url), "utf8");
const todayPageSource = readFileSync(new URL("../src/components/today-page.tsx", import.meta.url), "utf8");
const homeRouteSource = readFileSync(new URL("../src/app/page.tsx", import.meta.url), "utf8");

// "This file must NOT contain X" is a claim about the code, not about the prose explaining it --
// comments legitimately name the very things the code is forbidden to do, which is what makes them
// worth writing. Same technique the existing today-page tests use on today-recommendation-copy.ts.
function codeOnly(source: string): string {
  return source
    .split("\n")
    .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*") && !line.trim().startsWith("/*"))
    .join("\n");
}

const createNowCode = codeOnly(createNowSource);

// --- fixtures ------------------------------------------------------------------------------------

function product(overrides: Partial<Product> = {}): Product {
  return {
    id: "blondies",
    name: "Biscoff Blondies",
    category: "Bakery",
    role: "Hero candidate",
    status: "launch_candidate",
    description: "",
    image: "",
    decision: "Candidate",
    isPublic: false,
    ...overrides,
  };
}

function opportunityRow(): OpportunityRow {
  const draft: OpportunityDraft = {
    opportunityType: "product_marketing_content",
    producer: "daily_advisor",
    sourceType: "daily_advisor",
    sourceId: "daily_advisor:2026-08-13:product_marketing_content:blondies",
    title: "Create product content for Biscoff Blondies",
    summary: "No Blondies content in 6 days.",
    reason: "Rule Engine evidence supports creating marketing content.",
    recommendedAction: "create_content",
    evidenceVersion: "v1",
    evidence: { product: { id: "blondies", name: "Biscoff Blondies" } },
    sourceRuleIds: ["RULE-001"],
    sourceFindings: [],
    detectedAt: "2026-08-13T01:00:00.000Z",
    expiresAt: "2026-08-16T01:00:00.000Z",
    deduplicationKey: "v1|producer=daily_advisor|entity:product=blondies",
    status: "accepted",
  };
  return { ...toOpportunityRow(draft), id: "opportunity-1", created_at: "2026-08-13T01:00:00.000Z", updated_at: "2026-08-13T01:00:00.000Z" };
}

// A deliberately small stand-in for Supabase: it records every insert so the tests can assert on the
// row that would actually be written, rather than on the function's return value alone.
function makeJobClient() {
  const inserted: Array<Partial<CreativeJobRow>> = [];
  const jobs: CreativeJobRow[] = [];
  const opportunities = [opportunityRow()];
  let nextId = 1;

  function queryBuilder<T>(rows: T[]) {
    const filters: Array<{ column: string; value: string }> = [];
    const builder = {
      eq(column: string, value: string) {
        filters.push({ column, value });
        return builder;
      },
      limit() {
        return builder;
      },
      order() {
        return builder;
      },
      async maybeSingle() {
        const found = rows.find((row) => filters.every(({ column, value }) => (row as Record<string, unknown>)[column] === value));
        return { data: found ?? null, error: null };
      },
      select() {
        return { maybeSingle: builder.maybeSingle, single: builder.maybeSingle };
      },
      then(resolve: (value: { data: T[] | null; error: null }) => unknown) {
        return Promise.resolve({ data: rows, error: null }).then(resolve);
      },
    };
    return builder;
  }

  const client = {
    from(table: string) {
      if (table === "opportunities") {
        return { select: () => queryBuilder(opportunities) };
      }
      return {
        select: () => queryBuilder(jobs),
        insert(row: Partial<CreativeJobRow>) {
          inserted.push(row);
          return {
            select() {
              return {
                async single() {
                  const created: CreativeJobRow = {
                    id: `job-${nextId++}`,
                    opportunity_id: row.opportunity_id ?? null,
                    intent: row.intent ?? {},
                    status: row.status ?? "queued",
                    worker_type: row.worker_type ?? "mock",
                    attempt_count: row.attempt_count ?? 0,
                    result: row.result ?? {},
                    last_error: row.last_error ?? null,
                    created_at: "2026-08-13T02:00:00.000Z",
                    updated_at: "2026-08-13T02:00:00.000Z",
                  };
                  jobs.push(created);
                  return { data: created, error: null };
                },
              };
            },
          };
        },
        update: () => queryBuilder(jobs),
      };
    },
  };

  return { client: client as unknown as CreativeJobClient, inserted, jobs };
}

function values(overrides: Partial<{ text: string; product: Product | null; formatChoice: CreateNowFormatChoice }> = {}) {
  return { text: "Give me something easy today", product: null, formatChoice: CREATE_NOW_AI_FORMAT_CHOICE as CreateNowFormatChoice, ...overrides };
}

// --- A/B/C: the one required field ---------------------------------------------------------------

test("A. a blank request cannot be submitted", () => {
  const result = buildCreateNowRequest(values({ text: "" }));
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.message, CREATE_NOW_EMPTY_TEXT_MESSAGE);
});

test("A. a whitespace-only request cannot be submitted either -- blank means no words, not no characters", () => {
  for (const blank of ["   ", "\n", "\t", " \n\t "]) {
    const result = buildCreateNowRequest(values({ text: blank }));
    assert.equal(result.ok, false, `expected ${JSON.stringify(blank)} to be rejected`);
  }
});

test("B. any request with a word in it can be submitted, in whatever shape the owner typed it", () => {
  const requests = [
    "Give me something easy today",
    "Make a Reel about our Blondies",
    "I want something cozy for this afternoon",
    "Show some behind-the-scenes content",
    "Make something for Instagram about our brownies",
    "blondies",
  ];
  for (const text of requests) {
    const result = buildCreateNowRequest(values({ text }));
    assert.equal(result.ok, true, `expected ${JSON.stringify(text)} to be accepted`);
    assert.equal(result.ok === true && result.request.text, text);
  }
});

test("C. whitespace is trimmed for the emptiness check ONLY -- the owner's words are submitted verbatim", () => {
  const padded = "  Make a Reel about our Blondies  ";
  const result = buildCreateNowRequest(values({ text: padded }));
  assert.equal(result.ok, true);
  // Not "Make a Reel about our Blondies" -- CreativeInput.requestText is contractually the original
  // words, and silently stripping the owner's spaces is still rewriting what they typed.
  assert.equal(result.ok === true && result.request.text, padded);
});

test("C. the built request survives the domain's own validator unchanged -- no second contract", () => {
  const built = buildCreateNowRequest(values({ text: "  cozy afternoon  " }));
  assert.equal(built.ok, true);
  if (!built.ok) return;
  const validated = validateCreativeRequest(built.request);
  assert.equal(validated.ok, true);
  assert.equal(validated.ok === true && validated.request.text, "  cozy afternoon  ");
});

// --- D: product is optional ---------------------------------------------------------------------

test("D. product is optional: with none chosen, no product identity reaches the request at all", () => {
  const result = buildCreateNowRequest(values({ product: null }));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.request.productId, undefined);
  assert.equal(result.request.productName, undefined);
  assert.equal(result.request.subject, undefined);
  // Which is what lets S3A ground naturally from recommendation -> Journey -> Brand.
  assert.equal(buildCreativeInputFromRequest(result.request).productId, null);
  assert.equal(buildCreativeInputFromRequest(result.request).subject, null);
});

test("D. a chosen product passes its REAL catalog id and name, and nothing invented alongside them", () => {
  const chosen = product({ id: "blondies", name: "Biscoff Blondies" });
  const result = buildCreateNowRequest(values({ product: chosen }));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.request.productId, "blondies");
  assert.equal(result.request.productName, "Biscoff Blondies");
  // subject is the catalog product's own name -- picking it from the list IS the owner stating what
  // the content is about. It is also what makes the choice reach the generator: S3A only honours an
  // explicitly stated subject, so productId alone would be silently ignored.
  assert.equal(result.request.subject, "Biscoff Blondies");
  const input = buildCreativeInputFromRequest(result.request);
  assert.equal(input.subject, "Biscoff Blondies");
  assert.equal(input.productId, "blondies");
});

test("D. no product is ever auto-selected -- the first catalog entry is not the default", () => {
  const catalog = [product({ id: "brownies", name: "Brownies" }), product({ id: "blondies", name: "Biscoff Blondies" })];
  assert.equal(findSelectableCreateNowProduct(catalog, CREATE_NOW_NO_PRODUCT_CHOICE), null);
  const result = buildCreateNowRequest(values({ product: findSelectableCreateNowProduct(catalog, CREATE_NOW_NO_PRODUCT_CHOICE) }));
  assert.equal(result.ok === true && result.request.productId, undefined);
});

test("D. paused products are not offered, matching the lifecycle the recommendation engine already enforces", () => {
  const catalog = [product({ id: "brownies", name: "Brownies", status: "paused" }), product({ id: "blondies", name: "Biscoff Blondies" })];
  assert.deepEqual(
    selectableCreateNowProducts(catalog).map((entry) => entry.id),
    ["blondies"],
  );
  // And a paused product cannot be resurrected by id, so a stale selection cannot smuggle one in.
  assert.equal(findSelectableCreateNowProduct(catalog, "brownies"), null);
});

test("D. catalog order is preserved exactly as loaded -- no second sort is applied here", () => {
  const catalog = [product({ id: "c", name: "Cookies" }), product({ id: "a", name: "Alfajores" }), product({ id: "b", name: "Brownies" })];
  assert.deepEqual(
    selectableCreateNowProducts(catalog).map((entry) => entry.id),
    ["c", "a", "b"],
  );
});

// --- E/F/G/H/I/J: format is optional -------------------------------------------------------------

test("E. format is optional: the default choice produces no formatHint at all", () => {
  const result = buildCreateNowRequest(values({ formatChoice: CREATE_NOW_AI_FORMAT_CHOICE }));
  assert.equal(result.ok, true);
  assert.equal(result.ok === true && result.request.formatHint, null);
  assert.equal(result.ok === true && buildCreativeInputFromRequest(result.request).formatHint, null);
});

test("F. \"Let AI choose\" means ABSENT, never \"photo\" -- the app must not make a creative decision and report it as the owner's", () => {
  assert.equal(toCreativeFormatHint(CREATE_NOW_AI_FORMAT_CHOICE), null);
  const result = buildCreateNowRequest(values({ formatChoice: CREATE_NOW_AI_FORMAT_CHOICE }));
  assert.notEqual(result.ok === true && result.request.formatHint, "photo");
  assert.equal(result.ok === true && result.request.formatHint, null);
});

for (const format of CREATIVE_FORMATS) {
  const letter = { photo: "G", reel: "H", carousel: "I", story: "J" }[format];
  test(`${letter}. explicit ${format} maps to formatHint "${format}" and survives the intent round-trip`, () => {
    const result = buildCreateNowRequest(values({ formatChoice: format }));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.request.formatHint, format);
    assert.equal(buildCreativeInputFromRequest(result.request).formatHint, format);
    // Persisted and read back by the worker exactly as chosen -- an explicit format cannot be lost
    // between the browser and the generator.
    const restored = fromIntentJson(toIntentJson(result.request));
    assert.equal(restored.ok === true && restored.request.formatHint, format);
  });
}

test("E/F. exactly the five approved choices are offered -- the Content MVP format vocabulary is frozen", () => {
  assert.deepEqual(
    CREATE_NOW_FORMAT_OPTIONS.map((option) => option.value),
    [CREATE_NOW_AI_FORMAT_CHOICE, ...CREATIVE_FORMATS],
  );
  assert.deepEqual(
    CREATE_NOW_FORMAT_OPTIONS.map((option) => option.label),
    ["Let AI choose", "Photo", "Reel", "Carousel", "Story"],
  );
  // No YouTube, blog, email, ad, thread or long-form video sneaking in.
  const offered = CREATE_NOW_FORMAT_OPTIONS.map((option) => option.value).filter((value) => value !== CREATE_NOW_AI_FORMAT_CHOICE);
  for (const value of offered) {
    assert.ok(CREATIVE_FORMATS.includes(value as CreativeFormat), `${value} is not a supported creative format`);
  }
});

// --- K/L/M/N/O: job creation ---------------------------------------------------------------------

test("K. Create Now calls the EXISTING request-backed domain entry point, and builds no insert of its own", () => {
  assert.match(createNowSource, /createCreativeJobFromRequest\(jobClient, built\.request, \{ workerType: "creative_ai" \}\)/);
  // No hand-rolled persistence: no table insert, no intent construction, no status/attempt fields.
  assert.doesNotMatch(createNowSource, /\.from\(["']creative_jobs["']\)/);
  assert.doesNotMatch(createNowSource, /toIntentJson|attempt_count|worker_type|opportunity_id/);
});

test("L/M/N/O. a Create Now submission writes a user_request-backed creative_ai job with a null opportunity_id", async () => {
  const { client, inserted, jobs } = makeJobClient();
  const built = buildCreateNowRequest(values({ text: "Give me something easy today" }));
  assert.equal(built.ok, true);
  if (!built.ok) return;

  const created = await createCreativeJobFromRequest(client, built.request, { workerType: "creative_ai" });
  assert.equal(created.ok, true);
  if (!created.ok) return;

  assert.equal(inserted.length, 1);
  // N: the origin column says "no Opportunity", explicitly.
  assert.equal(inserted[0].opportunity_id, null);
  // L: the request itself is what backs the job.
  assert.deepEqual(inserted[0].intent, toIntentJson(built.request));
  // O: the worker that actually generates content, not the mock default.
  assert.equal(inserted[0].worker_type, "creative_ai");
  assert.equal(created.job.opportunityId, null);
  assert.equal(created.job.workerType, "creative_ai");
  assert.equal(created.job.status, "queued");
  assert.equal(jobs.length, 1);
});

test("M. no Opportunity is fabricated: nothing is written to the opportunities table, and no recommendation is invented", async () => {
  const { client, inserted } = makeJobClient();
  const built = buildCreateNowRequest(values({ text: "something cozy" }));
  assert.equal(built.ok, true);
  if (!built.ok) return;

  await createCreativeJobFromRequest(client, built.request, { workerType: "creative_ai" });

  // The written row carries the owner's words and nothing resembling an Opportunity's fields.
  const intent = inserted[0].intent as Record<string, unknown>;
  assert.equal(intent.text, "something cozy");
  assert.ok(!("reason" in intent), "a request must not carry an Opportunity's reason");
  assert.ok(!("evidence" in intent), "a request must not carry an Opportunity's evidence");
  assert.ok(!("opportunityId" in intent));
  // And the component never even reaches for the Opportunity domain.
  assert.doesNotMatch(createNowCode, /createCreativeJobForAcceptedOpportunity|opportunit/i);
});

test("M. the resulting CreativeInput states user_request as its origin -- the two entry paths stay distinguishable", () => {
  const built = buildCreateNowRequest(values({ text: "make something" }));
  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.deepEqual(buildCreativeInputFromRequest(built.request).origin, { kind: "user_request" });
});

test("P. a second submit while the first is still in flight is refused at the UI boundary, and nothing deeper is deduplicated", () => {
  // The guard is the first thing submit does, before the request is even built.
  assert.match(createNowSource, /if \(isSubmitting\) \{\s*\n\s*return;/);
  assert.match(createNowSource, /setIsSubmitting\(true\)/);
  assert.match(createNowSource, /<Button disabled=\{isSubmitting\}/);
  // Two DELIBERATE asks for the same thing are two genuine jobs: no id, key or fingerprint is sent
  // to the database to collapse them.
  assert.doesNotMatch(createNowCode, /idempot|deduplicat|dedupe|requestKey|fingerprint/i);
});

// --- Q/R/S/T/U/V/W/X: asynchronous behaviour -----------------------------------------------------

test("Q. the browser never runs, imports or waits on AI -- it only writes a row and reads it back", () => {
  assert.doesNotMatch(createNowCode, /creative-ai-executor|ai-orchestrator|runCreativeJobWithExecutors|runMockCreativeJob|claimQueuedCreativeJob|background-worker/);
  assert.doesNotMatch(createNowCode, /anthropic|claude|codex|openai|\bCLI\b/i);
  // The waiting state is entered from the row the insert returned, with no second read and no wait.
  // AH1 adds the clock read between these two, so the waiting state starts counting from the moment
  // the row exists. The shape asserted is still the same one: straight into waiting, no second read.
  assert.match(createNowSource, /setJob\(created\.job\);\s*\n\s*setNowMs\(Date\.now\(\)\);\s*\n\s*setActiveJob\(created\.job\.id\);/);
  assert.match(createNowSource, /setIsSubmitting\(false\);\s*\n\s*\n\s*if \(!created\.ok\)/);
});

// AH1 -- the timing every pre-existing progress test is now read against. Pinned a few seconds in,
// which is comfortably inside both thresholds, so these tests keep asserting exactly what they always
// asserted: the copy for each status on a healthy run. The slow paths are owned by the AH1 timing
// tests further down, where the elapsed time is the subject rather than a fixture detail.
const AH1_REQUESTED_AT = "2026-08-13T09:00:00.000Z";

function freshTiming(elapsedMs = 5_000): CreateNowJobTiming {
  return { createdAt: AH1_REQUESTED_AT, startedAt: AH1_REQUESTED_AT, nowMs: Date.parse(AH1_REQUESTED_AT) + elapsedMs };
}

test("R/S/T/U. every persisted job status has owner-facing copy, and only the terminal two are settled", () => {
  const queued = describeCreateNowProgress("queued", freshTiming());
  const running = describeCreateNowProgress("running", freshTiming());
  const completed = describeCreateNowProgress("completed", freshTiming());
  const failed = describeCreateNowProgress("failed", freshTiming());

  assert.equal(queued.isSettled, false);
  assert.equal(running.isSettled, false);
  assert.equal(completed.isSettled, true);
  assert.equal(failed.isSettled, true);

  assert.equal(completed.headline, "Your content is ready.");
  assert.equal(failed.headline, "We couldn't create this one.");
  assert.equal(failed.tone, "bad");
  assert.equal(completed.tone, "good");

  // Every one of the four is covered -- adding a fifth status must not silently fall through.
  for (const status of CREATIVE_JOB_STATUSES) {
    assert.ok(describeCreateNowProgress(status, freshTiming()).headline.length > 0, `${status} has no copy`);
  }
});

test("R/S. the waiting copy is honest about timing and never promises a number of seconds", () => {
  for (const status of ["queued", "running"] as const) {
    const detail = describeCreateNowProgress(status, freshTiming()).detail;
    assert.match(detail, /a minute or two/);
    assert.match(detail, /You can leave this page/);
    assert.doesNotMatch(detail, /\b\d+\s*(seconds|minutes)\b/);
    assert.doesNotMatch(detail, /instant/i);
  }
});

test("R/S/T/U. no internal implementation vocabulary appears in any owner-facing status string", () => {
  const banned = /creative_ai|creative_job|S3[A-E]|Claude|Codex|schema_invalid|attempt trace|\bRPC\b|worker|queue|\bjob\b/i;
  // AH1 adds two more strings to this surface, and they are the ones most tempted to name the
  // machinery -- "the Creative Worker may be unavailable" is the obvious way to write the slow-queued
  // case and is exactly what today-product-spec.md §10 forbids. Both timings are checked so the new
  // copy is held to the same rule as the copy it sits beside.
  for (const status of CREATIVE_JOB_STATUSES) {
    for (const timing of [freshTiming(), freshTiming(20 * 60 * 1000)]) {
      const progress = describeCreateNowProgress(status, timing);
      assert.doesNotMatch(progress.headline, banned);
      assert.doesNotMatch(progress.detail, banned);
    }
  }
});

// --- AH1 §14-17: the owner can tell waiting from generating, and slow from stuck -----------------
//
// The incident: a job sat queued for roughly fifteen minutes while the local worker was wedged, and
// this screen said the same calm sentence for every one of those minutes. Nothing it said was FALSE
// -- the job really was queued -- but it was silent about the only thing that mattered, which was
// that nothing had picked the job up and nothing was going to. The owner waited because the screen
// gave them no reason to stop.
//
// Every test below injects its clock. Nothing here waits in real time.

function timingAt(elapsedMs: number, overrides: Partial<CreateNowJobTiming> = {}): CreateNowJobTiming {
  return { createdAt: AH1_REQUESTED_AT, startedAt: AH1_REQUESTED_AT, nowMs: Date.parse(AH1_REQUESTED_AT) + elapsedMs, ...overrides };
}

test("AH1-D. queued is NEVER labelled as generating -- the precise lie owner testing caught", () => {
  // A queued job has started_at = null: no worker has claimed it and nothing is being made. Saying
  // "Creating your content" over that state is the failure this whole section exists to prevent,
  // and it must hold at every elapsed time, including long past the slow threshold.
  for (const elapsed of [0, 30_000, CREATE_NOW_QUEUED_SLOW_MS, 15 * 60 * 1000]) {
    const queued = describeCreateNowProgress("queued", { createdAt: AH1_REQUESTED_AT, startedAt: "", nowMs: Date.parse(AH1_REQUESTED_AT) + elapsed });
    assert.doesNotMatch(queued.headline, /creating|generating/i, `queued at ${elapsed}ms claims work is happening`);
    assert.equal(queued.isSettled, false);
  }

  // And the two states are genuinely different sentences, not one string reused.
  assert.notEqual(describeCreateNowProgress("queued", timingAt(0)).headline, describeCreateNowProgress("running", timingAt(0)).headline);
});

test("AH1-D. a fresh queued job waits calmly; past the threshold it says so", () => {
  const fresh = describeCreateNowProgress("queued", timingAt(CREATE_NOW_QUEUED_SLOW_MS - 1));
  assert.equal(fresh.headline, "We've got your request. Starting shortly.");
  assert.equal(fresh.detail, CREATE_NOW_WAITING_DETAIL);

  // The boundary is inclusive, and it is crossed exactly once.
  const slow = describeCreateNowProgress("queued", timingAt(CREATE_NOW_QUEUED_SLOW_MS));
  assert.equal(slow.headline, CREATE_NOW_QUEUED_SLOW_HEADLINE);
  assert.equal(slow.detail, CREATE_NOW_QUEUED_SLOW_DETAIL);

  // Visibility only (§17): crossing a threshold changes what is SAID and nothing else. The job is
  // not failed, not cancelled, and still not settled -- this module never writes to job state.
  assert.equal(slow.tone, "info", "a slow queue is not an error");
  assert.equal(slow.isSettled, false, "a slow queue must not look finished");

  // P1-1. The only evidence behind this state is elapsed time, so the copy may report elapsed time
  // and must diagnose nothing else. A queued job waits legitimately while another job generates --
  // the worker takes one job per run and holds the lock throughout -- so inferring a dead worker,
  // an unavailable scheduler, or a machine that "can't make content" from queue age would call a
  // perfectly healthy second request broken.
  assert.doesNotMatch(slow.detail, /computer|machine|offline|unavailable|not running|asleep|can't be made|cannot be made|check/i);
  // And it still tells the owner the two things that ARE true and useful.
  assert.match(slow.detail, /taking longer than usual/i);
  assert.match(slow.detail, /Nothing is lost/i);
});

test("AH1-D. a fresh running job generates calmly; past its own, longer threshold it says so", () => {
  const fresh = describeCreateNowProgress("running", timingAt(CREATE_NOW_RUNNING_SLOW_MS - 1));
  assert.equal(fresh.headline, "Creating your content...");
  assert.equal(fresh.detail, CREATE_NOW_WAITING_DETAIL);

  const slow = describeCreateNowProgress("running", timingAt(CREATE_NOW_RUNNING_SLOW_MS));
  assert.equal(slow.headline, CREATE_NOW_RUNNING_SLOW_HEADLINE);
  assert.equal(slow.detail, CREATE_NOW_RUNNING_SLOW_DETAIL);
  assert.equal(slow.tone, "info", "a long generation is not a failure");
  assert.equal(slow.isSettled, false);

  // A running job is still running: the slow copy must not imply the owner has to do something.
  assert.doesNotMatch(slow.detail, /try again|refresh|start over/i);
});

test("AH1-D. the two thresholds are different, and each is measured from its own timestamp", () => {
  // Queued time runs from when the owner ASKED; running time from when the work STARTED. Measuring
  // both from created_at would report a fast generation that merely waited in the queue as slow.
  assert.notEqual(CREATE_NOW_QUEUED_SLOW_MS, CREATE_NOW_RUNNING_SLOW_MS);
  assert.ok(CREATE_NOW_RUNNING_SLOW_MS > CREATE_NOW_QUEUED_SLOW_MS, "generation is allowed to take longer than pickup");

  const askedAt = "2026-08-13T09:00:00.000Z";
  const startedAt = "2026-08-13T09:09:00.000Z"; // claimed nine minutes later
  const nowMs = Date.parse(startedAt) + 10_000; // ten seconds into generation

  // Ten seconds in, this is a healthy fast generation -- even though the row is nine minutes old.
  const running = describeCreateNowProgress("running", { createdAt: askedAt, startedAt, nowMs });
  assert.equal(running.headline, "Creating your content...");
  assert.equal(running.elapsedLabel, "0:10");
  assert.equal(createNowElapsedMs("running", { createdAt: askedAt, startedAt, nowMs }), 10_000);

  // The same row read while still queued is measured from created_at instead.
  assert.equal(createNowElapsedMs("queued", { createdAt: askedAt, startedAt: "", nowMs: Date.parse(askedAt) + 42_000 }), 42_000);
});

test("AH1-D. elapsed time is derived from the persisted timestamps and formatted as m:ss", () => {
  assert.equal(formatCreateNowElapsed(0), "0:00");
  assert.equal(formatCreateNowElapsed(9_000), "0:09");
  assert.equal(formatCreateNowElapsed(42_000), "0:42");
  assert.equal(formatCreateNowElapsed(78_000), "1:18");
  assert.equal(formatCreateNowElapsed(600_000), "10:00");
  // Seconds are floored, never rounded up past the value the timestamps actually support.
  assert.equal(formatCreateNowElapsed(41_999), "0:41");

  assert.equal(describeCreateNowProgress("queued", timingAt(42_000)).elapsedLabel, "0:42");
  assert.equal(describeCreateNowProgress("running", timingAt(78_000)).elapsedLabel, "1:18");
});

test("AH1-D. no timer is shown rather than a wrong one", () => {
  // A settled job has nothing left to count.
  assert.equal(describeCreateNowProgress("completed", timingAt(60_000)).elapsedLabel, null);
  assert.equal(describeCreateNowProgress("failed", timingAt(60_000)).elapsedLabel, null);

  // A running job with no started_at is a contradiction the database should never produce. It is
  // reported as "no elapsed time" rather than silently measured from created_at instead.
  assert.equal(describeCreateNowProgress("running", { createdAt: AH1_REQUESTED_AT, startedAt: "", nowMs: Date.parse(AH1_REQUESTED_AT) + 60_000 }).elapsedLabel, null);
  assert.equal(createNowElapsedMs("running", { createdAt: AH1_REQUESTED_AT, startedAt: "", nowMs: Date.now() }), null);

  // A browser clock behind the database clock produces a negative duration. It must render as
  // nothing at all -- never "-0:03", and never a wrapped-around reassuring number.
  assert.equal(createNowElapsedMs("queued", timingAt(-5_000)), null);
  assert.equal(describeCreateNowProgress("queued", timingAt(-5_000)).elapsedLabel, null);
  assert.equal(formatCreateNowElapsed(-1), null);
  assert.equal(formatCreateNowElapsed(Number.NaN), null);

  // An unparseable timestamp is not a reason to guess.
  assert.equal(createNowElapsedMs("queued", { createdAt: "not-a-date", startedAt: "", nowMs: Date.now() }), null);

  // A negative clock skew must not silently trip a threshold either -- it stays the calm state.
  assert.equal(describeCreateNowProgress("queued", timingAt(-60 * 60 * 1000)).headline, "We've got your request. Starting shortly.");
});

test("AH1-D. completed and failed keep their existing terminal states, unaffected by any elapsed time", () => {
  for (const elapsed of [0, CREATE_NOW_QUEUED_SLOW_MS, CREATE_NOW_RUNNING_SLOW_MS, 60 * 60 * 1000]) {
    const completed = describeCreateNowProgress("completed", timingAt(elapsed));
    assert.equal(completed.headline, "Your content is ready.");
    assert.equal(completed.tone, "good");
    assert.equal(completed.isSettled, true);

    // §19: a failed job shows a real failure state rather than an infinite spinner, and it says so
    // without a stack trace, a provider name, or raw CLI output.
    const failed = describeCreateNowProgress("failed", timingAt(elapsed));
    assert.equal(failed.headline, "We couldn't create this one.");
    assert.equal(failed.tone, "bad");
    assert.equal(failed.isSettled, true);
    assert.doesNotMatch(failed.detail, /stack|at \w+\(|Error:|token|key|stderr/i);
  }
});

test("AH1-D. the clock is read where the job is read, never during render", () => {
  // React purity: Date.now() in a render body is an impure call that produces unstable output on an
  // incidental re-render, and this repo's lint enforces the rule. The clock is therefore read in the
  // same callbacks that already set the job, which also means the elapsed value and the status it
  // labels always come from the same moment rather than drifting apart.
  assert.doesNotMatch(createNowSource, /nowMs: Date\.now\(\)/, "the clock must not be read during render");
  assert.match(createNowSource, /setJob\(jobResult\.job\);\s*\n\s*setNowMs\(Date\.now\(\)\);/, "a refreshed job must refresh the clock");
  // No second timer was introduced to drive the elapsed value -- the existing poll is the only clock.
  assert.equal((createNowSource.match(/setTimeout|setInterval/g) ?? []).length, 1, "AH1 must add no timer of its own");
});

test("AH1-D. polling still covers queued and running, so the threshold copy is actually reached", () => {
  // §18: the thresholds are worthless if the screen stops looking before they arrive. The existing
  // poll is reused rather than replaced -- no websocket, no realtime subscription, no new worker.
  assert.equal(shouldPollCreativeJobStatus("queued"), true);
  assert.equal(shouldPollCreativeJobStatus("running"), true);
  assert.ok(CREATE_NOW_POLL_INTERVAL_MS > 0 && CREATE_NOW_POLL_INTERVAL_MS < CREATE_NOW_QUEUED_SLOW_MS, "the poll must tick well inside the queued threshold");
  assert.doesNotMatch(createNowSource, /WebSocket|realtime|subscribe\(/i);
});

test("T. a completed job is what causes the package to be read -- nothing reads a package before then", () => {
  assert.match(createNowSource, /if \(jobResult\.job\.status !== "completed" \|\| !packageClient\) \{\s*\n\s*return;/);
  assert.match(createNowSource, /getCreativePackageForJob\(packageClient, jobResult\.job\.id\)/);
  assert.match(createNowSource, /buildCreativePackageView\(packageResult\.creativePackage\.content\)/);
});

test("V. refreshing stops on a terminal status, and on a completed job the moment its package is in hand", () => {
  assert.equal(shouldPollCreativeJobStatus("queued"), true);
  assert.equal(shouldPollCreativeJobStatus("running"), true);
  assert.equal(shouldPollCreativeJobStatus("completed"), false);
  assert.equal(shouldPollCreativeJobStatus("failed"), false);

  const base = { hasJobError: false, hasPackage: false, hasPackageError: false, packageMissCount: 0 };
  assert.equal(shouldRefreshCreateNowJob({ ...base, status: "queued" }), true);
  assert.equal(shouldRefreshCreateNowJob({ ...base, status: "running" }), true);
  // A failed job is finished. It is never looked at again, and above all never re-queued.
  assert.equal(shouldRefreshCreateNowJob({ ...base, status: "failed" }), false);
  // A completed job keeps looking while its package could still land -- then it stops for good.
  assert.equal(shouldRefreshCreateNowJob({ ...base, status: "completed" }), true);
  assert.equal(shouldRefreshCreateNowJob({ ...base, status: "completed", hasPackage: true }), false);
  assert.equal(shouldRefreshCreateNowJob({ ...base, status: "completed", hasPackageError: true }), false);
  // A job that could not be read is not retried forever.
  assert.equal(shouldRefreshCreateNowJob({ ...base, status: "queued", hasJobError: true }), false);
  assert.equal(shouldRefreshCreateNowJob({ ...base, status: null }), false);
});

// --- F/G/H: the completed-job / package race -------------------------------------------------------
//
// The failure this guards against is specific: the worker persists the Creative Job and then writes
// the Creative Package. A completed job read in the gap between those two writes has no package.
// Giving up on the first miss strands a job that really did succeed behind a "ready" headline with
// nothing under it.

test("F. a completed job whose package has not landed keeps looking, for a BOUNDED number of looks", () => {
  const base = { status: "completed" as const, hasJobError: false, hasPackage: false, hasPackageError: false };

  // Every look inside the window keeps the recovery alive -- not just the first one.
  for (let miss = 0; miss < CREATE_NOW_PACKAGE_GRACE_LOOKS; miss += 1) {
    assert.equal(shouldRefreshCreateNowJob({ ...base, packageMissCount: miss }), true, `look ${miss} should still recover`);
    assert.equal(hasCreateNowPackageGraceExpired({ ...base, packageMissCount: miss }), false);
  }

  // And the window is genuinely a window: it is more than one look, and it is not forever.
  assert.ok(CREATE_NOW_PACKAGE_GRACE_LOOKS > 1, "one look is the stranding bug this exists to fix");
  assert.ok(CREATE_NOW_PACKAGE_GRACE_LOOKS <= 8, "the grace window must stay small and deterministic");
});

test("H. the grace window terminates: once it is spent, refreshing stops and an honest state is shown", () => {
  const spent = {
    status: "completed" as const,
    hasJobError: false,
    hasPackage: false,
    hasPackageError: false,
    packageMissCount: CREATE_NOW_PACKAGE_GRACE_LOOKS,
  };
  assert.equal(shouldRefreshCreateNowJob(spent), false);
  assert.equal(hasCreateNowPackageGraceExpired(spent), true);

  // Nothing beyond the bound reopens it either -- the count only ever rises, so this is the end.
  assert.equal(shouldRefreshCreateNowJob({ ...spent, packageMissCount: CREATE_NOW_PACKAGE_GRACE_LOOKS + 50 }), false);

  // The honest state names no failure, because nothing failed, and it points at the recovery that
  // actually works rather than leaving the owner with a headline over blank space.
  assert.doesNotMatch(CREATE_NOW_PACKAGE_PENDING_MESSAGE, /error|failed|wrong|sorry/i);
  assert.match(CREATE_NOW_PACKAGE_PENDING_MESSAGE, /refresh/i);
});

test("H. a spent grace window is never described as \"ready\" -- the screen must not contradict itself", () => {
  const spent = {
    status: "completed" as const,
    hasJobError: false,
    hasPackage: false,
    hasPackageError: false,
    packageMissCount: CREATE_NOW_PACKAGE_GRACE_LOOKS,
  };

  const shown = describeCreateNowScreenProgress("completed", spent, freshTiming());
  // The exact defect this closes: "Your content is ready." sitting directly above "taking longer to
  // show up". Content the owner cannot see is not ready, and the headline has to agree with that.
  assert.notEqual(shown.headline, describeCreateNowProgress("completed", freshTiming()).headline);
  assert.doesNotMatch(shown.headline, /ready/i);
  assert.equal(shown.headline, CREATE_NOW_PACKAGE_PENDING_HEADLINE);
  assert.equal(shown.detail, CREATE_NOW_PACKAGE_PENDING_MESSAGE);

  // Calm, not alarming: a slow write is not a failure, so it keeps the same tone as the other
  // waiting states rather than being styled as something gone wrong.
  assert.equal(shown.tone, "info");
  assert.notEqual(shown.tone, "bad");
  // But it IS settled -- nothing is still being looked for, so the way onward stays offered.
  assert.equal(shown.isSettled, true);
});

test("H. every state EXCEPT a spent grace window still reports the job's own progress, unchanged", () => {
  const live = { hasJobError: false, hasPackage: false, hasPackageError: false, packageMissCount: 0 };

  for (const status of CREATIVE_JOB_STATUSES) {
    assert.deepEqual(
      describeCreateNowScreenProgress(status, { ...live, status }, freshTiming()),
      describeCreateNowProgress(status, freshTiming()),
      `${status} must be reported exactly as before`,
    );
  }

  // A completed job whose package DID arrive is genuinely ready, at every point in the window.
  for (let miss = 0; miss <= CREATE_NOW_PACKAGE_GRACE_LOOKS; miss += 1) {
    const arrived = { status: "completed" as const, hasJobError: false, hasPackage: true, hasPackageError: false, packageMissCount: miss };
    assert.equal(describeCreateNowScreenProgress("completed", arrived, freshTiming()).headline, "Your content is ready.");
  }
});

test("G. a package that appears DURING the grace window renders, and ends the refreshing immediately", () => {
  const base = { status: "completed" as const, hasJobError: false, hasPackage: false, hasPackageError: false };

  // At every point inside the window, the package arriving is terminal and non-expired: the view
  // renders and no "taking longer than usual" notice is shown alongside it.
  for (let miss = 0; miss <= CREATE_NOW_PACKAGE_GRACE_LOOKS; miss += 1) {
    const arrived = { ...base, hasPackage: true, packageMissCount: miss };
    assert.equal(shouldRefreshCreateNowJob(arrived), false, `arrival at look ${miss} must stop refreshing`);
    assert.equal(hasCreateNowPackageGraceExpired(arrived), false, `arrival at look ${miss} is not an expiry`);
  }
});

test("F. a missing package spends the grace window; a genuinely unreadable one is an error, not a retry", () => {
  // "not-found" is the race, and it costs one look. Any other package failure is a real error and
  // stops the refreshing at once rather than burning the window on something that cannot improve.
  assert.match(createNowSource, /if \(packageResult\.reason === "not-found"\) \{[\s\S]{0,160}setPackageMissCount\(\(current\) => current \+ 1\);/);
  assert.match(createNowSource, /setPackageError\(packageResult\.message\);/);
  // The bound is wired into the live refresh decision, not just exported and left unused.
  assert.match(createNowSource, /shouldRefreshCreateNowJob\(\{[^}]*packageMissCount[^}]*\}\)/);
  // The expiry reaches the screen through the one function that decides what the screen says, so a
  // spent window cannot be shown and described by two places that could drift apart.
  assert.match(createNowSource, /describeCreateNowScreenProgress\(job\.status, refreshState, \{ createdAt: job\.createdAt, startedAt: job\.startedAt, nowMs \}\)/);
  // Starting over resets the window, so a previous job's misses never shorten the next job's grace.
  const another = createNowSource.slice(createNowSource.indexOf("function createAnother()"));
  assert.match(another.slice(0, 600), /setPackageMissCount\(0\)/);
});

test("I. a refresh or revisit still recovers a completed job's package -- a spent window is not a dead end", () => {
  // The recovery path is the route's own ?job=<uuid>, and it survives a full reload: the id is
  // validated server-side, handed to the app, and the screen opens straight back onto that job with
  // a fresh grace window (packageMissCount is component state, so a reload starts it at zero).
  assert.equal(resolveCreateNowJobId("3f2504e0-4f89-11d3-9a0c-0305e82c3301"), "3f2504e0-4f89-11d3-9a0c-0305e82c3301");
  assert.match(homeRouteSource, /<ProductLab initialCreativeJobId=\{resolveCreateNowJobId\(job\)\} \/>/);
  assert.match(todayPageSource, /const \[creativeJobId, setCreativeJobId\] = useState\(initialCreativeJobId\);/);
  assert.match(createNowSource, /const \[packageMissCount, setPackageMissCount\] = useState\(0\);/);
  // And the reloaded screen reads the package again, because a completed job is still what triggers
  // the package read -- recovery is the same code path, not a second one.
  assert.match(createNowSource, /getCreativePackageForJob\(packageClient, jobResult\.job\.id\)/);
});

test("V. the refresh cadence is a few seconds, not a hot loop", () => {
  assert.ok(CREATE_NOW_POLL_INTERVAL_MS >= 4000 && CREATE_NOW_POLL_INTERVAL_MS <= 5000, `unexpected cadence: ${CREATE_NOW_POLL_INTERVAL_MS}ms`);
});

test("W. both effects clean up on unmount -- no timer and no late write survives leaving the screen", () => {
  assert.match(createNowSource, /return \(\) => clearTimeout\(timer\);/);
  assert.match(createNowSource, /let cancelled = false;/);
  assert.match(createNowSource, /return \(\) => \{\s*\n\s*cancelled = true;/);
  assert.match(createNowSource, /if \(cancelled\) return;/);
});

test("X. a refresh reads ONE job by id and that job's own package -- never a list, never a history", () => {
  assert.match(createNowSource, /getCreativeJobById\(client, id\)/);
  assert.doesNotMatch(createNowSource, /listQueuedCreativeJobs|listOpportunities|getCreativePackageById\b/);
  // Nothing unbounded: no select("*") of a whole table lives in this component at all.
  assert.doesNotMatch(createNowSource, /\.select\(/);
});

test("X. refreshing only ever tracks the job currently on screen", () => {
  assert.match(createNowSource, /const refreshStatus = job !== null && job\.id === jobId \? job\.status : null;/);
});

// --- Realtime / infrastructure restraint ---------------------------------------------------------

test("no realtime, websocket, or second worker was introduced for S4", () => {
  assert.doesNotMatch(createNowSource, /realtime|WebSocket|channel\(|subscribe\(/i);
  assert.doesNotMatch(todayPageSource, /realtime|WebSocket/i);
});

// --- AG: refresh / revisit recovery ---------------------------------------------------------------

test("AG. the active job id round-trips through the URL, in the same shape the other routes use", () => {
  assert.equal(resolveCreateNowJobId("3f2504e0-4f89-11d3-9a0c-0305e82c3301"), "3f2504e0-4f89-11d3-9a0c-0305e82c3301");
  assert.equal(resolveCreateNowJobId(["3f2504e0-4f89-11d3-9a0c-0305e82c3301", "second"]), "3f2504e0-4f89-11d3-9a0c-0305e82c3301");
  assert.equal(resolveCreateNowJobId(undefined), null);
  // A hand-edited or truncated value reads as "no active job" rather than reaching Postgres as a
  // malformed uuid and surfacing a database error on the owner's screen.
  assert.equal(resolveCreateNowJobId("hello"), null);
  assert.equal(resolveCreateNowJobId(""), null);
  assert.equal(resolveCreateNowJobId("3f2504e0-4f89-11d3-9a0c"), null);
});

test("AG. the route resolves the job id server-side and hands the app an already-validated value", () => {
  assert.match(homeRouteSource, /import \{ resolveCreateNowJobId \} from "@\/lib\/create-now";/);
  assert.match(homeRouteSource, /const \{ job \} = await searchParams;/);
  assert.match(homeRouteSource, /<ProductLab initialCreativeJobId=\{resolveCreateNowJobId\(job\)\} \/>/);
});

test("AG. submitting writes the job id into the URL, and it is the ONLY recovery mechanism -- no shadow copy in storage", () => {
  assert.match(createNowSource, /url\.searchParams\.set\(CREATE_NOW_JOB_SEARCH_PARAM, id\)/);
  assert.match(createNowSource, /window\.history\.replaceState/);
  assert.doesNotMatch(createNowSource, /localStorage|sessionStorage|document\.cookie/);
});

test("AG. arriving with a job id in the URL opens straight onto that job", () => {
  assert.match(todayPageSource, /const \[creativeJobId, setCreativeJobId\] = useState\(initialCreativeJobId\);/);
  assert.match(todayPageSource, /const \[isCreating, setIsCreating\] = useState\(initialCreativeJobId !== null\);/);
});

// --- AH: recommendations do not gate creation -----------------------------------------------------

test("AH. creating something never depends on a recommendation: the create branch is reached before the recommendation load is even resolved", () => {
  const createBranch = todayPageSource.indexOf("if (isCreating) {");
  const loadingBranch = todayPageSource.indexOf("if (isLoading) {");
  const errorBranch = todayPageSource.indexOf("if (loadError) {");
  const stateSwitch = todayPageSource.indexOf("switch (state.kind)");
  assert.ok(createBranch > 0, "test fixture is stale -- create branch not found");
  assert.ok(createBranch < loadingBranch, "creating must not wait on the recommendation load");
  assert.ok(createBranch < errorBranch, "a failed recommendation read must not block creating");
  assert.ok(createBranch < stateSwitch, "creating must not depend on which recommendation state resolved");
});

test("AH. Create Now reads no recommendation, Opportunity or advisor data of any kind", () => {
  assert.doesNotMatch(createNowSource, /marketing-recommendations|opportunity-review|todays-recommendation|today-screen-state|marketing-advisor/);
});

test("AH. every state with nothing to recommend still offers a way in -- including the two empty ones and the error", () => {
  for (const marker of ['case "empty":', 'case "exhausted":', 'case "prep-not-ready":', "if (loadError) {"]) {
    const index = todayPageSource.indexOf(marker);
    assert.ok(index > 0, `test fixture is stale -- ${marker} not found`);
    const block = todayPageSource.slice(index, index + 900);
    assert.match(block, /Something specific/, `${marker} offers no way to create something`);
  }
});

test("AH. with nothing to recommend, \"Something specific\" is promoted to the screen's single primary action", () => {
  for (const marker of ['case "empty":', 'case "exhausted":']) {
    const index = todayPageSource.indexOf(marker);
    const block = todayPageSource.slice(index, index + 900);
    assert.match(block, /<PrimaryAction onClick=\{\(\) => setIsCreating\(true\)\}>Something specific<\/PrimaryAction>/);
  }
  // ...and stays a quiet text action on a day that does have one, so it never competes with it.
  const freshIndex = todayPageSource.indexOf('case "fresh": {');
  const freshBlock = todayPageSource.slice(freshIndex, freshIndex + 1200);
  assert.match(freshBlock, /<QuietAction onClick=\{\(\) => setIsCreating\(true\)\}>Something specific<\/QuietAction>/);
  assert.doesNotMatch(freshBlock, /PrimaryAction/);
});

// The distinction these two tests hold apart:
//
//   A. the DAILY RECOMMENDATION slot -- done for the day, and nothing may recommend a second one.
//   B. OWNER-INITIATED creation      -- a separate door, which completion does not lock.
//
// "Opportunities recommend content. They do not gate content creation." Completing today's
// recommendation is not a gate either.
function completedTodayBlock(): string {
  const index = todayPageSource.indexOf('case "completed-today": {');
  assert.ok(index > 0, "test fixture is stale -- completed-today not found");
  const end = todayPageSource.indexOf('case "prep-not-ready":');
  assert.ok(end > index, "test fixture is stale -- prep-not-ready not found after completed-today");
  return todayPageSource.slice(index, end);
}

test("D. a completed day still exposes owner-initiated creation, as a QUIET secondary action", () => {
  const block = completedTodayBlock();
  assert.match(
    block,
    /<QuietAction onClick=\{\(\) => setIsCreating\(true\)\}>Something specific<\/QuietAction>/,
    "completing today's recommendation must not close the manual creation door",
  );
});

test("E. a completed day promotes NO second task: the door is quiet, and the success copy is untouched", () => {
  const block = completedTodayBlock();

  // Not promoted. No primary button, and none of the machinery that makes a daily RECOMMENDATION:
  // no "Today's recommendation" eyebrow, no ritual create control asking for another piece, and no
  // "Not today" dismissal -- because there is no second recommendation here to accept or decline.
  assert.doesNotMatch(block, /PrimaryAction/, "a completed day must not promote a second task to primary");
  assert.doesNotMatch(block, /Today&apos;s recommendation/, "a completed day must not present a second recommendation");
  assert.doesNotMatch(block, /CreativePackageAssetCreate/, "a completed day must not ask the owner to do another task");
  assert.doesNotMatch(block, /notToday/, "there is no second recommendation to dismiss");

  // The completion message and the ready-to-publish line are exactly what they were -- adding the
  // door must not have edited the moment it sits under.
  assert.match(block, /<MessageBox message="Nice work — today's content is ready\." tone="good" \/>/);
  assert.match(block, /\{headline\} — ready to publish/);

  // And it is the LAST thing in the block: the finished work is still what the screen is about.
  assert.ok(
    block.indexOf("Something specific") > block.indexOf("CreativePackageAssets"),
    "the quiet door must sit under the finished work, not above it",
  );
});

// --- AI/AJ: failure and starting over --------------------------------------------------------------

test("AI. a failed job is never automatically re-queued, and the UI implements no provider retry of its own", () => {
  const failed = describeCreateNowProgress("failed", freshTiming());
  assert.equal(failed.isSettled, true);
  assert.equal(shouldRefreshCreateNowJob({ status: "failed", hasJobError: false, hasPackage: false, hasPackageError: false, packageMissCount: 0 }), false);
  // Nothing in the component re-submits, retries, or re-runs on failure.
  assert.doesNotMatch(createNowSource, /retry|requeue|re-queue|fallback/i);
  // The only path back is the owner asking again, deliberately -- and on a failure that is the one
  // thing left to do, so it is the screen's primary action rather than a link under an error.
  assert.match(createNowSource, /progress\.tone === "bad" \? <PrimaryAction onClick=\{createAnother\}>Create another<\/PrimaryAction>/);
  assert.match(createNowSource, /progress\.isSettled && progress\.tone !== "bad" \? <QuietAction onClick=\{createAnother\}>Create another<\/QuietAction>/);
});

test("AI. no job cancellation exists in S4", () => {
  assert.doesNotMatch(createNowSource, /cancelJob|abort|Cancel</i);
});

test("AJ. \"Create another\" clears the screen only -- it deletes nothing", () => {
  // No database delete anywhere in the component. (url.searchParams.delete is a URL edit, not a row
  // deletion -- the check below is deliberately specific enough to tell those apart.)
  assert.doesNotMatch(createNowCode, /from\([^)]*\)[\s\S]{0,40}\.delete\(|deleteCreative|removeJob|\.remove\(/);
  const index = createNowSource.indexOf("function createAnother()");
  assert.ok(index > 0, "test fixture is stale -- createAnother not found");
  const block = createNowSource.slice(index, index + 600);
  // Presentation state and the form, nothing else.
  assert.match(block, /setJob\(null\)/);
  assert.match(block, /setPackageView\(null\)/);
  assert.match(block, /setText\(""\)/);
  assert.match(block, /setActiveJob\(null\)/);
});

// --- AK: the Opportunity path survives -------------------------------------------------------------

test("AK. both entry paths still converge on the same Creative Job pipeline, differing only in origin", async () => {
  const { client, inserted, jobs } = makeJobClient();

  const built = buildCreateNowRequest(values({ text: "Give me something easy today" }));
  assert.equal(built.ok, true);
  if (!built.ok) return;
  const direct = await createCreativeJobFromRequest(client, built.request, { workerType: "creative_ai" });
  const viaOpportunity = await createCreativeJobForAcceptedOpportunity(client, "opportunity-1", { workerType: "creative_ai" });

  assert.equal(direct.ok, true);
  assert.equal(viaOpportunity.ok, true);
  if (!direct.ok || !viaOpportunity.ok) return;

  // Same table, same status, same worker -- one pipeline.
  assert.equal(jobs.length, 2);
  assert.equal(direct.job.status, viaOpportunity.job.status);
  assert.equal(direct.job.workerType, viaOpportunity.job.workerType);

  // The ONLY difference is where the job came from.
  assert.equal(direct.job.opportunityId, null);
  assert.equal(viaOpportunity.job.opportunityId, "opportunity-1");
  assert.deepEqual(inserted[0].intent, toIntentJson(built.request));
  assert.equal(inserted[1].intent, undefined);
});

test("AK. the Opportunity review surface is untouched by S4 -- it still creates jobs its own way", () => {
  const opportunitiesSource = readFileSync(new URL("../src/components/opportunities-page.tsx", import.meta.url), "utf8");
  assert.match(opportunitiesSource, /createCreativeJobForAcceptedOpportunity\(creativeJobClient, selectedOpportunity\.id\)/);
  assert.doesNotMatch(opportunitiesSource, /createCreativeJobFromRequest|CreateNow/);
});

// --- domain freeze ----------------------------------------------------------------------------------

// --- A: the request contract Create Now is allowed to speak --------------------------------------

test("A. Create Now submits ONLY fields the authoritative CreativeRequest already declares", () => {
  // The authoritative contract, read from the tracked domain module rather than restated here, so
  // this test fails if the type and the UI ever drift apart in either direction.
  const source = readFileSync(new URL("../src/lib/creative-input.ts", import.meta.url), "utf8");
  const declaration = source.slice(source.indexOf("export type CreativeRequest = {"));
  const contractFields = new Set(
    declaration
      .slice(0, declaration.indexOf("};"))
      .split("\n")
      .map((line) => /^\s*(\w+)\??:/.exec(line)?.[1])
      .filter((name): name is string => Boolean(name)),
  );
  assert.deepEqual([...contractFields].sort(), ["formatHint", "productId", "productName", "subject", "text"]);

  // Every field Create Now can ever emit, across the shapes it can emit them in.
  for (const built of [
    buildCreateNowRequest(values()),
    buildCreateNowRequest(values({ product: product() })),
    buildCreateNowRequest(values({ product: product(), formatChoice: "reel" })),
  ]) {
    assert.equal(built.ok, true);
    if (!built.ok) return;
    for (const key of Object.keys(built.request)) {
      assert.ok(contractFields.has(key), `Create Now invented a request field the domain does not declare: ${key}`);
    }
    // And the domain's own validator accepts it untouched -- no field is dropped or rewritten.
    const validated = validateCreativeRequest(built.request);
    assert.equal(validated.ok, true);
  }
});

// --- B/C: the owner's product selection is authoritative grounding ---------------------------------
//
// This is the end-to-end meaning of the optional product control: whatever the owner picks must be
// what the generator is grounded on. The path is UI selection -> CreativeRequest ->
// buildCreativeInputFromRequest -> S3A's resolveCreativeGrounding, and it is exercised whole here
// because every seam in it is a place the selection could have been silently dropped.

// Deliberately names a DIFFERENT product than the one selected below, and ranks first, so a
// selection that failed to reach S3A would visibly resolve to this one instead.
function competingProduct(chosen: Product) {
  return { productId: `${chosen.id}-other`, productName: `${chosen.name} Other` };
}

function competingRecommendation(chosen: Product): MarketingRecommendation {
  return {
    id: "no_marketing_history:other",
    recommendationType: "no_marketing_history",
    priority: 4,
    confidence: "high",
    title: "Introduce the other one",
    explanation: "It has never appeared in the Journey.",
    suggestedNextAction: "Create an introductory piece of content for it.",
    evidence: { ...competingProduct(chosen), entryCount: 0 },
  } as MarketingRecommendation;
}

function ground(request: ReturnType<typeof buildCreateNowRequest>, recommendations: MarketingRecommendation[]) {
  assert.equal(request.ok, true);
  if (!request.ok) throw new Error("unreachable");
  return resolveCreativeGrounding({
    creativeInput: buildCreativeInputFromRequest(request.request),
    recommendations,
    journal: [],
    products: [],
    brandBible: BRAND_BIBLE,
    now: Date.parse("2026-08-13T09:00:00.000Z"),
  });
}

test("B. a selected product becomes the explicit subject grounding, and outranks the recommendation engine", () => {
  const chosen = product();
  const grounding = ground(buildCreateNowRequest(values({ product: chosen })), [competingRecommendation(chosen)]);

  // The owner's real catalog selection, carried through verbatim -- no name is hardcoded here, it is
  // read back off the same fixture that was selected.
  assert.equal(grounding.subject, chosen.name);
  assert.equal(grounding.productId, chosen.id);
  assert.equal(grounding.productName, chosen.name);
  assert.equal(grounding.subjectKind, "product");
  // "stated", not "assumed": picking a product from a list IS the owner saying what it is about, so
  // nothing was inferred and there is no assumption left to justify.
  assert.equal(grounding.subjectSource, "stated");
  assert.equal(grounding.subjectGrounding, null);
});

test("C. with no product selected, the normal S3A fallback is untouched", () => {
  const expected = competingProduct(product());
  const grounding = ground(buildCreateNowRequest(values()), [competingRecommendation(product())]);

  // Falls straight through to step 2 exactly as it did before Create Now existed: the top-ranked
  // qualifying recommendation, marked assumed, with the engine's own explanation as the grounding.
  assert.equal(grounding.subject, expected.productName);
  assert.equal(grounding.productId, expected.productId);
  assert.equal(grounding.subjectSource, "assumed");
  assert.match(String(grounding.subjectGrounding), /Marketing recommendation:/);

  // And with nothing to recommend either, the brand fallback still ends the chain.
  const brand = ground(buildCreateNowRequest(values()), []);
  assert.equal(brand.subjectKind, "brand");
  assert.equal(brand.subjectSource, "assumed");
});

test("B/C. S3A itself is unchanged by this review pass -- the selection wins by USING the frozen algorithm", () => {
  const s3aSource = readFileSync(new URL("../src/lib/creative-subject-resolution.ts", import.meta.url), "utf8");
  // Step 1 still honours a stated subject outright, and it is still the first step. That property is
  // the entire mechanism by which an owner's selection beats a higher-ranked recommendation, so it
  // is asserted rather than assumed.
  assert.match(s3aSource, /const statedSubject = nonEmpty\(creativeInput\.subject\);/);
  assert.ok(
    s3aSource.indexOf("const statedSubject") < s3aSource.indexOf("for (const recommendation of recommendations)"),
    "a stated subject must be resolved before the recommendation scan, or a selection could be overridden",
  );
});

test("S4 added no second request contract: the request Create Now builds IS the frozen CreativeRequest", () => {
  const createNowLibSource = readFileSync(new URL("../src/lib/create-now.ts", import.meta.url), "utf8");
  assert.match(createNowLibSource, /import type \{ CreativeRequest \} from "\.\/creative-input\.ts";/);
  assert.doesNotMatch(createNowLibSource, /export type CreateNowRequest =|type .*Dto/);
  // And no second format vocabulary.
  assert.match(createNowLibSource, /from "\.\/creative-formats\.ts"/);
  assert.doesNotMatch(createNowLibSource, /"photo" \| "reel"/);
});
