import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  SAVED_CREATIVES_DEFAULT_LIMIT,
  buildSavedCreativeReopenHref,
  deriveSavedCreativeState,
  listSavedCreatives,
  summarizeCreativePackageContent,
  type CreativeHistoryClient,
} from "../src/lib/creative-history.ts";
import { CREATE_NOW_JOB_SEARCH_PARAM, resolveCreateNowJobId } from "../src/lib/create-now.ts";
import { getCreativePackageForJob, type CreativePackageClient, type CreativePackageRow } from "../src/lib/creative-packages.ts";
import { getCreativeJobById, type CreativeJobClient, type CreativeJobRow } from "../src/lib/creative-jobs.ts";
import type { AssetJobRow } from "../src/lib/asset-jobs.ts";
import type { AssetRow } from "../src/lib/assets.ts";

// Wave B -- Creative History / reopen closure.
//
// The gap this covers was a REACHABILITY gap, not a persistence one: packages were already written
// automatically and durably, the owner just had no way back to one. So the tests below prove two
// things above all -- that the history read is a read (it can never write, which is what makes
// reopening safe), and that reopening resolves the EXISTING package through the EXISTING `?job=`
// identity rather than making a new one.

type ErrorLike = { code?: string; message: string };

// --- fixtures ------------------------------------------------------------------------------------

const BROWNIE_SUBJECT = "The Great Brownie Border Dispute";

function creativeJobRow(overrides: Partial<CreativeJobRow> = {}): CreativeJobRow {
  return {
    id: "job-1",
    opportunity_id: null,
    intent: { requestText: "Give me something easy today" },
    status: "completed",
    worker_type: "creative_ai",
    attempt_count: 1,
    result: {},
    last_error: null,
    created_at: "2026-08-18T09:00:00.000Z",
    updated_at: "2026-08-18T09:01:00.000Z",
    started_at: "2026-08-18T09:00:30.000Z",
    completed_at: "2026-08-18T09:01:00.000Z",
    failed_at: null,
    ...overrides,
  };
}

function v2PhotoContent(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: "v2",
    format: "photo",
    subject: BROWNIE_SUBJECT,
    angle: "Two brownies argue about where the edge piece ends",
    hook: "Nobody agrees where the edge ends.",
    headline: "The Great Brownie Border Dispute",
    caption: "Corner piece or bust.",
    cta: "Order for Saturday pickup",
    platformVariants: [{ platform: "instagram", caption: "Corner piece or bust.", hashtags: ["#brownies"] }],
    productionSource: "generate_visual",
    visualDirection: "Two illustrated brownies squabbling over a drawn border line.",
    overlayText: null,
    visualBrief: {
      concept: "Two brownie characters disputing a border drawn across the tray",
      style: "Flat illustrated characters, warm bakery palette",
      scene: ["Tray of brownies seen from above", "A chalk line drawn between two pieces"],
      executionNotes: ["Keep the product obviously illustrated"],
    },
    metadata: {
      generatedFromOpportunity: null,
      generatorVersion: "2",
      sourceCreativeJobId: "job-1",
      sourceWorker: "creative_ai",
      sourceJobResultSchemaVersion: "v2",
      formatChosenBy: "ai",
      formatRationale: "A single static visual carries the joke best.",
      subjectSource: "stated",
      subjectGrounding: null,
    },
    ...overrides,
  };
}

function v1Content(headline: string, jobId: string) {
  return {
    output: { headline, caption: "Real caption" },
    metadata: {
      generatedFromOpportunity: "opportunity-1",
      generatorVersion: "1",
      sourceCreativeJobId: jobId,
      sourceWorker: "opportunity_brief",
      sourceJobResultSchemaVersion: "v1",
    },
    artifacts: [],
  };
}

function creativePackageRow(overrides: Partial<CreativePackageRow> = {}): CreativePackageRow {
  return {
    id: "pkg-1",
    creative_job_id: "job-1",
    status: "ready",
    schema_version: "v2",
    content: v2PhotoContent(),
    created_at: "2026-08-18T09:01:05.000Z",
    updated_at: "2026-08-18T09:01:05.000Z",
    ...overrides,
  };
}

function assetJobRow(overrides: Partial<AssetJobRow> = {}): AssetJobRow {
  return {
    id: "asset-job-1",
    creative_package_id: "pkg-1",
    status: "completed",
    worker_type: "generative_image",
    asset_kind: "image",
    attempt_count: 1,
    result: {},
    last_error: null,
    created_at: "2026-08-18T09:05:00.000Z",
    updated_at: "2026-08-18T09:06:00.000Z",
    started_at: "2026-08-18T09:05:10.000Z",
    completed_at: "2026-08-18T09:06:00.000Z",
    failed_at: null,
    ...overrides,
  };
}

function assetRow(overrides: Partial<AssetRow> = {}): AssetRow {
  return {
    id: "asset-1",
    asset_job_id: "asset-job-1",
    status: "generated",
    asset_kind: "image",
    schema_version: "v1",
    content: {
      files: [],
      metadata: { generatedFromCreativePackage: "pkg-1", sourceAssetJobId: "asset-job-1", generatorVersion: "1" },
    },
    created_at: "2026-08-18T09:06:00.000Z",
    updated_at: "2026-08-18T09:06:00.000Z",
    ...overrides,
  };
}

// --- fake client ---------------------------------------------------------------------------------

type QueryLog = { table: string; filters: Array<{ kind: "in"; column: string; values: string[] }>; orders: Array<{ column: string; ascending: boolean }>; limit: number | null };

function makeClient(options: {
  jobs?: CreativeJobRow[];
  packages?: CreativePackageRow[];
  assetJobs?: AssetJobRow[];
  assets?: AssetRow[];
  errors?: Partial<Record<string, ErrorLike>>;
} = {}) {
  const tables: Record<string, Record<string, unknown>[]> = {
    creative_jobs: [...(options.jobs ?? [])],
    creative_packages: [...(options.packages ?? [])],
    asset_jobs: [...(options.assetJobs ?? [])],
    assets: [...(options.assets ?? [])],
  };
  const log: QueryLog[] = [];

  function table(name: string) {
    return {
      select() {
        const entry: QueryLog = { table: name, filters: [], orders: [], limit: null };
        log.push(entry);
        const builder = {
          in(column: string, values: string[]) {
            entry.filters.push({ kind: "in", column, values });
            return builder;
          },
          order(column: string, orderOptions: { ascending: boolean }) {
            entry.orders.push({ column, ascending: orderOptions.ascending });
            return builder;
          },
          limit(count: number) {
            entry.limit = count;
            return builder;
          },
          then(resolve: (value: { data: Record<string, unknown>[] | null; error: ErrorLike | null }) => unknown, reject?: (reason: unknown) => unknown) {
            const error = options.errors?.[name] ?? null;
            if (error) {
              return Promise.resolve({ data: null, error }).then(resolve, reject);
            }
            const data = (tables[name] ?? [])
              .filter((row) => entry.filters.every((filter) => filter.values.includes(String(row[filter.column]))))
              .sort((a, b) => {
                for (const order of entry.orders) {
                  const comparison = String(a[order.column] ?? "").localeCompare(String(b[order.column] ?? ""));
                  if (comparison !== 0) return comparison * (order.ascending ? 1 : -1);
                }
                return 0;
              })
              .slice(0, entry.limit ?? undefined);
            return Promise.resolve({ data, error: null }).then(resolve, reject);
          },
        };
        return builder;
      },
      // Any write at all from the history path is a test failure, not a behaviour to assert about
      // afterwards. Acceptance items 6 and 7 ("reopening creates NO new Creative Package / Asset
      // Job") are enforced here rather than merely checked.
      insert() {
        throw new Error(`creative-history must never insert into ${name}.`);
      },
      update() {
        throw new Error(`creative-history must never update ${name}.`);
      },
      delete() {
        throw new Error(`creative-history must never delete from ${name}.`);
      },
    };
  }

  const client = {
    from(name: string) {
      if (!(name in tables)) {
        throw new Error(`Unexpected table in test client: ${name}`);
      }
      return table(name);
    },
    rpc() {
      throw new Error("creative-history must never call an RPC.");
    },
  };

  return { client: client as unknown as CreativeHistoryClient, log };
}

// --- A. owner-scoped ------------------------------------------------------------------------------

test("A: history is scoped by the caller's own authenticated client and adds no scope of its own", async () => {
  const { client, log } = makeClient({
    jobs: [creativeJobRow()],
    packages: [creativePackageRow()],
    assetJobs: [assetJobRow()],
    assets: [assetRow()],
  });

  const result = await listSavedCreatives(client);
  assert.equal(result.ok, true);

  // Every filter issued is an id join onto the previous read. There is no owner/user/tenant
  // predicate, because creative_jobs, creative_packages, asset_jobs and assets carry no such column
  // -- scope is the RLS session the client already carries, exactly as it is everywhere else in this
  // app. A client-side filter here would be a fake boundary that reads as a real one.
  const filterColumns = log.flatMap((entry) => entry.filters.map((filter) => filter.column));
  assert.deepEqual(filterColumns, ["creative_job_id", "creative_package_id", "asset_job_id"]);

  // And it only ever reads the four tables it declares.
  assert.deepEqual(
    log.map((entry) => entry.table),
    ["creative_jobs", "creative_packages", "asset_jobs", "assets"],
  );
});

test("A: history performs no insert, update, delete or rpc", async () => {
  // The fake client throws on every write verb, so this passing at all is the assertion.
  const { client } = makeClient({ jobs: [creativeJobRow()], packages: [creativePackageRow()] });
  const result = await listSavedCreatives(client);
  assert.equal(result.ok, true);
});

// --- B. newest-first ordering ----------------------------------------------------------------------

test("B: saved creatives are newest first", async () => {
  const older = creativeJobRow({ id: "job-old", created_at: "2026-08-10T09:00:00.000Z" });
  const newer = creativeJobRow({ id: "job-new", created_at: "2026-08-18T09:00:00.000Z" });
  const middle = creativeJobRow({ id: "job-mid", created_at: "2026-08-14T09:00:00.000Z" });

  const { client, log } = makeClient({ jobs: [older, newer, middle] });
  const result = await listSavedCreatives(client);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.creatives.map((creative) => creative.creativeJobId), ["job-new", "job-mid", "job-old"]);

  // Ordered by the database, not re-sorted in memory afterwards -- and bounded, so the list cannot
  // get slower every day the app is used.
  assert.deepEqual(log[0].orders, [
    { column: "created_at", ascending: false },
    { column: "id", ascending: false },
  ]);
  assert.equal(log[0].limit, SAVED_CREATIVES_DEFAULT_LIMIT);
});

// --- C. a persisted package appears -----------------------------------------------------------------

test("C: the persisted Brownie Border Dispute package appears with its own title, format and production route", async () => {
  const { client } = makeClient({ jobs: [creativeJobRow()], packages: [creativePackageRow()] });

  const result = await listSavedCreatives(client);
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.creatives.length, 1);
  const [creative] = result.creatives;
  assert.equal(creative.title, BROWNIE_SUBJECT);
  assert.equal(creative.creativeJobId, "job-1");
  assert.equal(creative.creativePackageId, "pkg-1");
  assert.equal(creative.createdAt, "2026-08-18T09:00:00.000Z");
  // The same words the reopened package shows, because both come from buildCreativePackageView.
  assert.equal(creative.formatLabel, "Static post");
  assert.equal(creative.productionLabel, "Illustrated visual · No shooting required");
  // No Asset Job yet, so it is content that has never been sent to production.
  assert.equal(creative.state, "ready");
  assert.equal(creative.stateLabel, "Ready");
});

test("C: a v1 package still appears, with its headline and honest absences", async () => {
  const { client } = makeClient({
    jobs: [creativeJobRow({ id: "job-v1", opportunity_id: "opp-1", intent: {} })],
    packages: [creativePackageRow({ id: "pkg-v1", creative_job_id: "job-v1", schema_version: "v1", content: v1Content("Brownies are back", "job-v1") })],
  });

  const result = await listSavedCreatives(client);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.creatives[0].title, "Brownies are back");
  assert.equal(result.creatives[0].formatLabel, null);
  assert.equal(result.creatives[0].productionLabel, null);
});

// --- D / E. reopen loads the existing package and creates nothing -------------------------------------

test("D+E: reopening reads the existing Creative Job and its existing package, and inserts nothing", async () => {
  let inserts = 0;

  const readOnlyClient = {
    from(table: string) {
      return {
        select() {
          const filters: Array<{ column: string; value: string }> = [];
          const builder = {
            eq(column: string, value: string) {
              filters.push({ column, value });
              return builder;
            },
            async maybeSingle() {
              const rows: Record<string, unknown>[] = table === "creative_jobs" ? [creativeJobRow()] : [creativePackageRow()];
              const match = rows.find((row) => filters.every((filter) => row[filter.column] === filter.value)) ?? null;
              return { data: match, error: null as ErrorLike | null };
            },
          };
          return builder;
        },
        insert() {
          inserts += 1;
          throw new Error("Reopening must never create a Creative Package.");
        },
      };
    },
  };

  const job = await getCreativeJobById(readOnlyClient as unknown as CreativeJobClient, "job-1");
  assert.equal(job.ok, true);
  if (!job.ok) return;
  assert.equal(job.job.id, "job-1");

  // The reopen path resolves the package FOR the job. It never materializes one: that is
  // createCreativePackageFromCompletedJob's job, and it is the worker that calls it.
  const existing = await getCreativePackageForJob(readOnlyClient as unknown as CreativePackageClient, "job-1");
  assert.equal(existing.ok, true);
  if (!existing.ok) return;
  assert.equal(existing.creativePackage.id, "pkg-1");
  assert.equal(existing.creativePackage.creativeJobId, "job-1");
  assert.equal(inserts, 0);
});

// --- F. production and assets stay connected ---------------------------------------------------------

test("F: an existing Asset Job and its Asset are reflected on the saved creative", async () => {
  const { client } = makeClient({
    jobs: [creativeJobRow()],
    packages: [creativePackageRow()],
    assetJobs: [assetJobRow()],
    assets: [assetRow()],
  });

  const result = await listSavedCreatives(client);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.creatives[0].state, "produced");
  assert.equal(result.creatives[0].stateLabel, "Produced");
});

test("F: an accepted Asset outranks a later queued retry", () => {
  assert.equal(
    deriveSavedCreativeState({
      jobStatus: "completed",
      hasPackage: true,
      attempts: [
        { status: "queued", assetStatus: null },
        { status: "completed", assetStatus: "accepted" },
      ],
    }),
    "accepted",
  );
});

test("F: every derived state names evidence that exists today", () => {
  const base = { jobStatus: "completed" as const, hasPackage: true };

  assert.equal(deriveSavedCreativeState({ jobStatus: "queued", hasPackage: false, attempts: [] }), "generating");
  assert.equal(deriveSavedCreativeState({ jobStatus: "running", hasPackage: false, attempts: [] }), "generating");
  assert.equal(deriveSavedCreativeState({ jobStatus: "completed", hasPackage: false, attempts: [] }), "generating");
  assert.equal(deriveSavedCreativeState({ jobStatus: "failed", hasPackage: false, attempts: [] }), "failed");
  // A failed Creative Job is failed whatever else exists -- there is no content to have an outcome
  // about.
  assert.equal(deriveSavedCreativeState({ jobStatus: "failed", hasPackage: true, attempts: [] }), "failed");
  assert.equal(deriveSavedCreativeState({ ...base, attempts: [] }), "ready");
  assert.equal(deriveSavedCreativeState({ ...base, attempts: [{ status: "queued", assetStatus: null }] }), "ready-for-production");
  assert.equal(deriveSavedCreativeState({ ...base, attempts: [{ status: "running", assetStatus: null }] }), "producing");
  assert.equal(deriveSavedCreativeState({ ...base, attempts: [{ status: "completed", assetStatus: null }] }), "producing");
  assert.equal(deriveSavedCreativeState({ ...base, attempts: [{ status: "failed", assetStatus: null }] }), "production-failed");
  assert.equal(deriveSavedCreativeState({ ...base, attempts: [{ status: "completed", assetStatus: "generated" }] }), "produced");
  assert.equal(deriveSavedCreativeState({ ...base, attempts: [{ status: "completed", assetStatus: "rejected" }] }), "rejected");
  assert.equal(deriveSavedCreativeState({ ...base, attempts: [{ status: "completed", assetStatus: "accepted" }] }), "accepted");
});

// --- G. deep link ------------------------------------------------------------------------------------

test("G: the reopen href uses the existing ?job= parameter and refreshing it resolves the same id", () => {
  const jobId = "2b1b8f2e-6a3f-4f0e-9c5e-8f1a2b3c4d5e";
  const href = buildSavedCreativeReopenHref("/content-studio", jobId);

  assert.equal(href, `/content-studio?${CREATE_NOW_JOB_SEARCH_PARAM}=${jobId}`);

  // A refresh of that URL hands the route this value, and the existing validator reads it back
  // unchanged -- no parallel identifier and no second routing model anywhere in the round trip.
  const parsed = new URL(href, "http://localhost:3000");
  assert.equal(resolveCreateNowJobId(parsed.searchParams.get(CREATE_NOW_JOB_SEARCH_PARAM) ?? undefined), jobId);
});

// --- H. empty state ------------------------------------------------------------------------------------

test("H: an empty history is an empty list, and costs exactly one query", async () => {
  const { client, log } = makeClient({ jobs: [] });
  const result = await listSavedCreatives(client);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.creatives, []);
  assert.equal(log.length, 1);
});

// --- I. failed and incomplete jobs -----------------------------------------------------------------------

test("I: failed, in-flight and malformed rows are listed without crashing", async () => {
  const { client } = makeClient({
    jobs: [
      creativeJobRow({ id: "job-queued", status: "queued", created_at: "2026-08-18T12:00:00.000Z", started_at: null, completed_at: null }),
      creativeJobRow({ id: "job-failed", status: "failed", created_at: "2026-08-18T11:00:00.000Z", completed_at: null, failed_at: "2026-08-18T11:02:00.000Z", last_error: "worker unavailable" }),
      creativeJobRow({ id: "job-unreadable", created_at: "2026-08-18T10:00:00.000Z" }),
      // No id: nothing to reopen, so it is dropped rather than rendered as a dead row.
      creativeJobRow({ id: undefined, created_at: "2026-08-18T08:00:00.000Z" }),
    ],
    packages: [
      // Content this app cannot show. The row still reopens; it just has no title to offer.
      creativePackageRow({ id: "pkg-unreadable", creative_job_id: "job-unreadable", content: { nonsense: true } }),
    ],
  });

  const result = await listSavedCreatives(client);
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.deepEqual(result.creatives.map((creative) => creative.creativeJobId), ["job-queued", "job-failed", "job-unreadable"]);
  assert.equal(result.creatives[0].state, "generating");
  assert.equal(result.creatives[1].state, "failed");
  assert.equal(result.creatives[2].title, null);
  assert.equal(result.creatives[2].state, "ready");
});

test("I: a missing table is reported as setup, not as a crash", async () => {
  const { client } = makeClient({ jobs: [creativeJobRow()], errors: { creative_jobs: { code: "PGRST205", message: "relation does not exist" } } });
  const result = await listSavedCreatives(client);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "missing-table");
});

test("I: summarizing unreadable content never throws", () => {
  for (const content of [null, undefined, 42, "text", [], {}, { schemaVersion: "v2" }]) {
    assert.deepEqual(summarizeCreativePackageContent(content), { title: null, formatLabel: null, productionLabel: null });
  }
});

// --- J. Create Now generation is unchanged, and Production is not duplicated ---------------------------------

const createNowSource = readFileSync(new URL("../src/components/create-now.tsx", import.meta.url), "utf8");
const savedCreativesSource = readFileSync(new URL("../src/components/saved-creatives.tsx", import.meta.url), "utf8");
const historySource = readFileSync(new URL("../src/lib/creative-history.ts", import.meta.url), "utf8");
const productLabSource = readFileSync(new URL("../src/app/product-lab.tsx", import.meta.url), "utf8");
const contentStudioRouteSource = readFileSync(new URL("../src/app/content-studio/page.tsx", import.meta.url), "utf8");

test("J: Create Now remains the only creation entrance -- history creates nothing", () => {
  // One creation call, in one place, still on the submit path.
  assert.equal((createNowSource.match(/createCreativeJobFromRequest\(/g) ?? []).length, 1);

  // And neither new file can create anything at all. Matched as CALLS (identifier immediately
  // followed by an open paren), so a prose mention of a creation function in a comment is not
  // mistaken for one being invoked.
  for (const source of [savedCreativesSource, historySource]) {
    assert.ok(!/(createCreativeJobFromRequest|createCreativePackageFromCompletedJob|createAssetJobForReadyCreativePackage)\(/.test(source));
    assert.ok(!/\.insert\(|\.update\(|\.delete\(|\.rpc\(/.test(source));
  }
});

test("J: reopening reuses the Create Now surface rather than duplicating Production components", () => {
  // Content Studio renders the same component Today renders, and nothing else: no second package
  // view, no second Production panel, no second Assets list.
  assert.ok(/<CreateNow\s/.test(productLabSource));
  assert.ok(!/<CreativePackageProduction\s/.test(productLabSource));
  assert.ok(!/<CreativePackageAssetCreate\s/.test(productLabSource));
  assert.ok(!/<CreativePackageAssets\s/.test(productLabSource));

  // Saved Creatives lists and links. It renders no creative content of its own.
  assert.ok(!/CreativePackageProduction|CreativePackageAssetCreate|CreativePackageAssets/.test(savedCreativesSource));
});

test("J: the Content Studio route resolves the existing ?job= parameter with the existing validator", () => {
  assert.ok(/resolveCreateNowJobId\(job\)/.test(contentStudioRouteSource));
  assert.ok(/initialCreativeJobId=\{resolveCreateNowJobId\(job\)\}/.test(contentStudioRouteSource));
  // No second parameter name was invented for this route.
  assert.ok(!/searchParams\.get\("(package|creative|pkg)"/.test(contentStudioRouteSource));
});
