import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  ASSET_OWNER_DECISIONS,
  ASSET_STATUSES,
  setAssetOwnerDecision,
  type AssetClient,
  type AssetRow,
} from "../src/lib/assets.ts";
import { createAssetJobForReadyCreativePackage, type AssetJobClient, type AssetJobRow } from "../src/lib/asset-jobs.ts";
import {
  MACHINE_PRODUCTION_WORKER_TYPES,
  isMachineProductionWorkerType,
  resolveProductionRoute,
} from "../src/lib/production-route.ts";
import {
  WEB_PRODUCTION_EXECUTOR_TIMEOUTS_MS,
  executeProductionAssetJob,
  isProductionWorkerType,
} from "../src/lib/production-execution.ts";
import { PRODUCTION_EXECUTOR_TIMEOUTS_MS } from "../src/lib/production-asset-executors.ts";
import { authenticateOwnerWith, isProductionOwner, readAppRole, readBearerToken } from "../src/lib/production-auth.ts";
import { fromCreativePackageRow, type CreativePackageRow } from "../src/lib/creative-packages.ts";

// Production MVP Wave B -- the owner-facing production workflow.
//
// These tests cover the seam the owner actually touches: which worker a package routes to, who is
// allowed to run it, what a duplicate click does, what the owner can decide afterwards, and what
// happens when production fails. The executor internals are covered by production-generative-image
// and production-static-renderer; the pipeline by asset-jobs.

type ErrorLike = { code?: string; message: string };

function v2PackageRow(format: string, productionSource: string): CreativePackageRow {
  const isCapture = productionSource === "capture_new";
  const formatFields: Record<string, unknown> = format === "reel"
    ? { shots: [{ direction: "Board centred", onScreenText: "Mine.", approxSeconds: 3 }], targetDurationSeconds: 3, audioDirection: "Warm acoustic bed" }
    : isCapture
      ? { framing: "overhead" }
      : {
          visualBrief: {
            concept: "Two dessert characters over the last brownie",
            style: "Soft hand-drawn illustration, warm bakery palette",
            scene: ["Board centred", "Two characters lean in"],
            executionNotes: ["Keep it obviously illustrated", "Minimal background"],
          },
        };

  return {
    id: "package-1",
    creative_job_id: "job-1",
    status: "ready",
    schema_version: "v2",
    content: {
      schemaVersion: "v2",
      format,
      subject: "Brownies",
      angle: "Fresh batch",
      hook: "Still warm.",
      headline: "Brownies, still warm",
      caption: "Out of the oven at 7am.",
      cta: "Order today",
      visualDirection: "Overhead on the wooden board",
      overlayText: null,
      productionSource,
      ...formatFields,
      platformVariants: [{ platform: "instagram", caption: "Still warm.", hashtags: ["#brownies"] }],
      metadata: {
        generatedFromOpportunity: null,
        generatorVersion: "2",
        sourceCreativeJobId: "job-1",
        sourceWorker: "mock",
        sourceJobResultSchemaVersion: "v2",
        formatChosenBy: "ai",
        formatRationale: "A single hero shot suits one product.",
        subjectSource: "stated",
        subjectGrounding: null,
      },
    },
    created_at: "2026-08-19T09:05:00.000Z",
    updated_at: "2026-08-19T09:05:00.000Z",
  } as CreativePackageRow;
}

function assetRow(overrides: Partial<AssetRow> = {}): AssetRow {
  return {
    id: "asset-1",
    asset_job_id: "asset-job-1",
    status: "generated",
    asset_kind: "image",
    schema_version: "v1",
    content: { schemaVersion: "v1", metadata: { generatedFromCreativePackage: "package-1", sourceAssetJobId: "asset-job-1", generatorVersion: "1", sourceKind: "ai_generated" } },
    created_at: "2026-08-19T10:00:00.000Z",
    updated_at: "2026-08-19T10:00:00.000Z",
    ...overrides,
  } as AssetRow;
}

// A deliberately small fake: enough for job creation and the owner decision write, which is all this
// suite drives directly. Full pipeline execution is covered where the full fakes already live.
function makeClient(options: { creativePackages?: CreativePackageRow[]; assets?: AssetRow[]; updateError?: ErrorLike } = {}) {
  const creativePackages = [...(options.creativePackages ?? [])];
  const assets = [...(options.assets ?? [])];
  const jobs: AssetJobRow[] = [];

  function builder<T extends Record<string, unknown>>(rows: T[], onUpdate?: (row: T) => void) {
    const filters: Array<{ column: string; value: string }> = [];
    const self = {
      eq(column: string, value: string) {
        filters.push({ column, value });
        return self;
      },
      order() {
        return self;
      },
      limit() {
        return self;
      },
      matches(row: T) {
        return filters.every(({ column, value }) => row[column] === value);
      },
      async maybeSingle() {
        const found = rows.find((row) => self.matches(row)) ?? null;
        if (onUpdate && found) {
          onUpdate(found);
        }
        return { data: found, error: null };
      },
      select() {
        return self;
      },
      then(resolve: (value: { data: T[] | null; error: null }) => unknown) {
        return Promise.resolve(resolve({ data: rows.filter((row) => self.matches(row)), error: null }));
      },
    };
    return self;
  }

  const client = {
    // No queued job exists in this fake, so a claim finds nothing -- exactly what a second execution
    // of an already-claimed job sees against the real RPC.
    rpc() {
      return { maybeSingle: async () => ({ data: null, error: null }) };
    },
    from(table: string) {
      if (table === "creative_packages") {
        return { select: () => builder(creativePackages as unknown as Array<Record<string, unknown>>) };
      }
      if (table === "assets") {
        return {
          select: () => builder(assets as unknown as Array<Record<string, unknown>>),
          update(row: Pick<AssetRow, "status">) {
            if (options.updateError) {
              // Mirrors the real chain shape so a failing update is exercised through the same calls.
              const failing = {
                eq: () => failing,
                select: () => failing,
                maybeSingle: async () => ({ data: null, error: options.updateError }),
              };
              return failing;
            }
            return builder(assets as unknown as Array<Record<string, unknown>>, (found) => {
              (found as unknown as AssetRow).status = row.status;
              (found as unknown as AssetRow).updated_at = "2026-08-19T11:00:00.000Z";
            });
          },
        };
      }
      // asset_jobs
      return {
        select: () => builder(jobs as unknown as Array<Record<string, unknown>>),
        insert(row: Partial<AssetJobRow>) {
          return {
            select: () => ({
              async single() {
                const inserted = {
                  ...row,
                  id: `asset-job-${jobs.length + 1}`,
                  created_at: "2026-08-19T10:00:00.000Z",
                  updated_at: "2026-08-19T10:00:00.000Z",
                  started_at: null,
                  completed_at: null,
                  failed_at: null,
                } as AssetJobRow;
                jobs.push(inserted);
                return { data: inserted, error: null };
              },
            }),
          };
        },
      };
    },
  } as unknown as AssetJobClient & AssetClient;

  return { client, jobs, assets };
}

// --- A / B / K / L: which worker the owner's package routes to ---------------------------------------

test("A: a template_only package routes the owner to the deterministic renderer", async () => {
  const store = makeClient({ creativePackages: [v2PackageRow("photo", "template_only")] });

  assert.deepEqual(resolveProductionRoute(fromCreativePackageRow(v2PackageRow("photo", "template_only"))), {
    workerType: "static_renderer",
    assetKind: "image",
  });

  // The owner UI passes NO options -- the reviewed resolver decides.
  const created = await createAssetJobForReadyCreativePackage(store.client, "package-1");
  assert.equal(created.ok, true);
  if (created.ok) {
    assert.equal(created.job.workerType, "static_renderer");
    assert.equal(created.job.assetKind, "image");
  }
});

test("B: a generate_visual package routes the owner to the generative worker", async () => {
  const store = makeClient({ creativePackages: [v2PackageRow("photo", "generate_visual")] });

  const created = await createAssetJobForReadyCreativePackage(store.client, "package-1");
  assert.equal(created.ok, true);
  if (created.ok) {
    assert.equal(created.job.workerType, "generative_image");
    assert.equal(created.job.assetKind, "image");
  }
});

test("K: capture_new still routes to external, and the app still creates that job explicitly", async () => {
  const store = makeClient({ creativePackages: [v2PackageRow("photo", "capture_new")] });

  assert.deepEqual(resolveProductionRoute(fromCreativePackageRow(v2PackageRow("photo", "capture_new"))), {
    workerType: "external",
    assetKind: "image",
  });

  const created = await createAssetJobForReadyCreativePackage(store.client, "package-1", { workerType: "external", assetKind: "image" });
  assert.equal(created.ok, true);
  if (created.ok) {
    assert.equal(created.job.workerType, "external");
  }

  // And the External Creative Workspace panel is still what renders for it.
  const component = readFileSync(new URL("../src/components/creative-package-asset-create.tsx", import.meta.url), "utf8");
  assert.match(component, /createAssetJobForReadyCreativePackage\(\s*client,\s*creativePackageId,\s*\{\s*workerType:\s*"external",\s*assetKind:\s*"image"\s*\}\s*\)/);
  assert.match(component, /External Creative Workspace/);
});

test("L: the owner cannot reach a remotion or short_video route through any of this", async () => {
  for (const productionSource of ["template_only", "capture_new"]) {
    const store = makeClient({ creativePackages: [v2PackageRow("reel", productionSource)] });
    const created = await createAssetJobForReadyCreativePackage(store.client, "package-1");
    assert.equal(created.ok, false, `reel:${productionSource} must not be queueable`);
    assert.equal(store.jobs.length, 0);
  }

  // And the machine worker vocabulary the UI and route accept contains neither.
  assert.deepEqual([...MACHINE_PRODUCTION_WORKER_TYPES], ["static_renderer", "generative_image"]);
  assert.equal(isMachineProductionWorkerType("remotion"), false);
  assert.equal(isProductionWorkerType("remotion"), false);
  assert.equal(isProductionWorkerType("external"), false, "the app's production endpoint is not a way to run the human path");
  assert.equal(isProductionWorkerType("mock"), false);
});

// --- C / N: the authenticated execution boundary ------------------------------------------------------

function requestWith(headers: Record<string, string>): { headers: { get(name: string): string | null } } {
  return { headers: { get: (name: string) => headers[name.toLowerCase()] ?? null } };
}

test("C: a bearer token is read only from the Authorization header", () => {
  assert.equal(readBearerToken(requestWith({ authorization: "Bearer abc.def.ghi" })), "abc.def.ghi");
  assert.equal(readBearerToken(requestWith({ authorization: "bearer abc" })), "abc", "the scheme is case-insensitive");
  assert.equal(readBearerToken(requestWith({})), null);
  assert.equal(readBearerToken(requestWith({ authorization: "Basic abc" })), null, "only the Bearer scheme is accepted");
  assert.equal(readBearerToken(requestWith({ authorization: "Bearer" })), null);
  assert.equal(readBearerToken(requestWith({ authorization: "Bearer    " })), null);
});

test("N: execution is refused without a token, and refused when the token does not verify", async () => {
  const missing = await authenticateOwnerWith(requestWith({}), {
    createClient: () => {
      throw new Error("must not build a client without a token");
    },
    getUser: async () => {
      throw new Error("must not verify without a token");
    },
  });
  assert.equal(missing.ok, false);
  if (!missing.ok) {
    assert.equal(missing.reason, "missing-token");
  }

  // A token that Supabase rejects -- expired, revoked, tampered, or invented.
  const rejected = await authenticateOwnerWith(requestWith({ authorization: "Bearer forged" }), {
    createClient: (token) => ({ token }),
    getUser: async () => null,
  });
  assert.equal(rejected.ok, false);
  if (!rejected.ok) {
    assert.equal(rejected.reason, "invalid-token");
  }
});

test("N: a verified token yields a principal scoped to that user", async () => {
  const authenticated = await authenticateOwnerWith(requestWith({ authorization: "Bearer good" }), {
    createClient: (token) => ({ token }),
    getUser: async () => ({ id: "user-1", email: "Owner@Example.com", appMetadata: { app_role: "owner" } }),
  });
  assert.equal(authenticated.ok, true);
  if (authenticated.ok) {
    assert.equal(authenticated.principal.id, "user-1");
    assert.equal(authenticated.principal.email, "Owner@Example.com");
    // The claim travels with the principal, read from the VERIFIED user record.
    assert.equal(authenticated.principal.appRole, "owner");
  }
});

// Replaces the PRODUCTION_OWNER_EMAILS allowlist this test used to cover. That mechanism was
// removed, not weakened: it defaulted to OPEN when the variable was unset -- which is precisely how
// the gate came to be effectively disabled in the live project -- and it named the owner somewhere
// the database could never read, so RLS could not agree with the application about who the owner
// was. The claim below is readable by both layers.
test("N: only the app_metadata owner claim admits a principal to paid generation", () => {
  assert.equal(isProductionOwner({ appRole: "owner" }), true);

  // A perfectly valid `authenticated` principal without the claim -- the public-order website user
  // and the advisor/worker automation user are both exactly this -- is refused.
  assert.equal(isProductionOwner({ appRole: null }), false, "absent claim fails closed");
  assert.equal(isProductionOwner({ appRole: "" }), false);
  assert.equal(isProductionOwner({ appRole: "authenticated" }), false);
  assert.equal(isProductionOwner({ appRole: "creative_worker" }), false);
  assert.equal(isProductionOwner({ appRole: "admin" }), false);

  // Exact match, deliberately. A near-miss is a miss: being lenient here could only ever widen the
  // gate, and the claim is written deliberately by an administrator, not typed by a user.
  assert.equal(isProductionOwner({ appRole: "Owner" }), false);
  assert.equal(isProductionOwner({ appRole: " owner" }), false);
  assert.equal(isProductionOwner({ appRole: "owner " }), false);
  assert.equal(isProductionOwner({ appRole: "ownerx" }), false);
  assert.equal(isProductionOwner({ appRole: "owner,admin" }), false);
});

test("N: malformed or self-servable metadata never yields an owner claim", () => {
  // Every shape that is not a string app_role collapses to null.
  for (const metadata of [null, undefined, 42, "owner", [], ["owner"], [{ app_role: "owner" }], { app_role: null }, { app_role: 1 }, { app_role: true }, { app_role: { value: "owner" } }, { app_role: ["owner"] }, { approle: "owner" }, {}]) {
    assert.equal(readAppRole(metadata), null, `${JSON.stringify(metadata)} must not read as a role`);
    assert.equal(isProductionOwner({ appRole: readAppRole(metadata) }), false);
  }
  assert.equal(readAppRole({ app_role: "owner" }), "owner");

  // user_metadata is NEVER an input. It is writable by the user through supabase.auth.updateUser(),
  // so authorizing on it would let any principal promote itself from the browser.
  const source = readFileSync(new URL("../src/lib/production-auth.ts", import.meta.url), "utf8");
  const statements = source.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
  assert.equal(statements.includes("user_metadata"), false, "user_metadata must never be read for authorization");
  assert.equal(statements.includes("PRODUCTION_OWNER_EMAILS"), false, "the email allowlist is gone, not merely bypassed");
  assert.equal(/process\.env/.test(statements), false, "no environment is consulted for the owner decision");
});

// --- D: duplicate clicks and idempotency ---------------------------------------------------------------

test("D: executing a job that is no longer queued produces no second asset", async () => {
  // The real guard is claim_asset_job_with_attempt, which only claims a `queued` row. A second
  // execution of the same job id therefore claims nothing. Here the job does not exist at all, which
  // exercises the same refusal path without needing the full pipeline.
  const outcome = await executeProductionAssetJob(
    makeClient().client as never,
    "asset-job-missing",
    "static_renderer",
    { timeoutMs: 5_000 },
  );

  assert.equal(outcome.kind, "failed");
  if (outcome.kind === "failed") {
    assert.ok(["not-found", "not-queued", "failed", "missing-table"].includes(outcome.reason));
  }
});

test("D: the web execution budget is finite and strictly below the route's platform ceiling", () => {
  // maxDuration on the route is 60s. Our own timeout must fire FIRST, or the platform kills the
  // invocation with the job left `running` and no terminal write.
  for (const worker of MACHINE_PRODUCTION_WORKER_TYPES) {
    const budget = WEB_PRODUCTION_EXECUTOR_TIMEOUTS_MS[worker];
    assert.ok(Number.isFinite(budget) && budget > 0);
    assert.ok(budget < 60_000, `${worker} web budget must sit under the 60s route maxDuration`);
    assert.ok(budget <= PRODUCTION_EXECUTOR_TIMEOUTS_MS[worker], `${worker} web budget must not exceed the executor's own`);
  }
  // And still an order of magnitude above the slowest generation ever measured (4.7s).
  assert.ok(WEB_PRODUCTION_EXECUTOR_TIMEOUTS_MS.generative_image > 10_000);
});

// --- I: truthful failure states --------------------------------------------------------------------

test("I: missing Cloudflare credentials are reported as not-configured, and cost no job state", async () => {
  const outcome = await executeProductionAssetJob(
    makeClient().client as never,
    "asset-job-1",
    "generative_image",
    { env: {} },
  );

  assert.equal(outcome.kind, "not-configured");
  if (outcome.kind === "not-configured") {
    // Names the variables so the owner can fix it; never a value.
    assert.match(outcome.message, /CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN/);
  }
});

test("I: static_renderer never reports not-configured -- it needs no credential", async () => {
  const outcome = await executeProductionAssetJob(makeClient().client as never, "asset-job-1", "static_renderer", { env: {} });
  assert.notEqual(outcome.kind, "not-configured");
});

// --- F / G / H: the owner's decision -----------------------------------------------------------------

test("F: accepting records the owner's decision on the real Asset", async () => {
  const store = makeClient({ assets: [assetRow()] });

  const result = await setAssetOwnerDecision(store.client, "asset-1", "accepted");

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.asset.status, "accepted");
  }
  assert.equal(store.assets[0].status, "accepted");
});

test("G: rejecting is NON-DESTRUCTIVE -- the asset, its job and its provenance all survive", async () => {
  const store = makeClient({ assets: [assetRow()] });

  const result = await setAssetOwnerDecision(store.client, "asset-1", "rejected");

  assert.equal(result.ok, true);
  assert.equal(store.assets[0].status, "rejected");
  // Still exactly one Asset row, still bound to its Asset Job, still carrying its origin. Rejection
  // is an opinion, not a delete.
  assert.equal(store.assets.length, 1);
  assert.equal(store.assets[0].asset_job_id, "asset-job-1");
  const content = store.assets[0].content as { metadata?: { sourceKind?: string } };
  assert.equal(content.metadata?.sourceKind, "ai_generated");
});

test("G: a rejected asset can still be accepted later -- the decision is current opinion, not a tombstone", async () => {
  const store = makeClient({ assets: [assetRow({ status: "rejected" })] });

  const result = await setAssetOwnerDecision(store.client, "asset-1", "accepted");
  assert.equal(result.ok, true);
  assert.equal(store.assets[0].status, "accepted");
});

test("H: regenerating creates a DISTINCT Asset Job and destroys nothing that came before", async () => {
  const store = makeClient({ creativePackages: [v2PackageRow("photo", "generate_visual")], assets: [assetRow()] });

  const first = await createAssetJobForReadyCreativePackage(store.client, "package-1");
  const second = await createAssetJobForReadyCreativePackage(store.client, "package-1");

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (first.ok && second.ok) {
    assert.notEqual(first.job.id, second.job.id, "each owner-requested regeneration is its own attempt history");
  }
  assert.equal(store.jobs.length, 2, "the earlier job is preserved, not overwritten");
  // And the earlier Asset is untouched by asking for another.
  assert.equal(store.assets.length, 1);
  assert.equal(store.assets[0].status, "generated");
});

test("owner decision failures are surfaced rather than silently swallowed", async () => {
  const store = makeClient({ assets: [assetRow()], updateError: { message: "update denied" } });
  const result = await setAssetOwnerDecision(store.client, "asset-1", "accepted");

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.message, "update denied");
  }
  assert.equal(store.assets[0].status, "generated", "a failed decision must not appear to have been recorded");
});

// --- M: credentials stay on the server ----------------------------------------------------------------

test("M: the auth boundary is server-only and holds no second credential", () => {
  const source = readFileSync(new URL("../src/lib/production-auth-server.ts", import.meta.url), "utf8");

  assert.match(source.split("\n")[0], /^import "server-only";$/, "server-only must be the first line, so a client import is a build error");
  assert.match(source, /persistSession:\s*false/);
  assert.match(source, /autoRefreshToken:\s*false/);

  const statements = source
    .split("\n")
    .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*") && !line.trim().startsWith("/*"))
    .join("\n");
  assert.equal(/service_role|SERVICE_ROLE/.test(statements), false, "no service-role credential is used");
  // No password/email principal of its own: the owner presents their OWN token.
  assert.equal(/signInWithPassword/.test(statements), false);
  assert.equal(/NEXT_PUBLIC_[A-Z_]*(EMAIL|PASSWORD|SECRET|TOKEN)/.test(statements), false);
});

test("M: no client module reaches the server-only auth module, the route, or the executors", () => {
  const clientFiles = [
    "../src/components/creative-package-production.tsx",
    "../src/components/creative-package-asset-create.tsx",
    "../src/components/today-page.tsx",
    "../src/components/opportunities-page.tsx",
    "../src/app/product-lab.tsx",
  ];
  for (const path of clientFiles) {
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    assert.equal(source.includes("production-auth-server"), false, `${path} must not import the server auth module`);
    assert.equal(source.includes("production-asset-executors"), false, `${path} must not import the executors`);
    assert.equal(source.includes("production-static-renderer"), false, `${path} must not import the renderer`);
    // production-execution reaches the executors transitively, so a client component must not import
    // it either -- that is what dragged resvg/sharp into the browser graph and broke the build.
    assert.equal(source.includes("production-execution"), false, `${path} must not import the execution boundary`);
    assert.equal(source.includes("CLOUDFLARE_"), false, `${path} must never name a Cloudflare credential`);
  }
});

test("M: the browser sends only a job id and a worker name -- never a model, endpoint or file path", () => {
  const component = readFileSync(new URL("../src/components/creative-package-production.tsx", import.meta.url), "utf8");
  const body = /body:\s*JSON\.stringify\(\{([^}]*)\}\)/.exec(component)?.[1] ?? "";
  assert.match(body, /assetJobId/);
  assert.match(body, /workerType/);
  for (const forbidden of ["model", "endpoint", "referenceImagePaths", "apiToken", "accountId", "prompt"]) {
    assert.equal(body.includes(forbidden), false, `the browser must not be able to supply ${forbidden}`);
  }

  const route = readFileSync(new URL("../src/app/api/production/route.ts", import.meta.url), "utf8");
  const statements = route
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
  // The route destructures exactly two fields from the body and validates both.
  assert.match(statements, /const \{ assetJobId, workerType \} = body;/);
  assert.match(statements, /isProductionWorkerType\(workerType\)/);
  for (const forbidden of ["body.model", "body.endpoint", "body.referenceImagePaths", "body.prompt"]) {
    assert.equal(statements.includes(forbidden), false, `the route must not read ${forbidden} from the request`);
  }
});

test("the route runs on the Node runtime, is never cached, and declares a platform ceiling", () => {
  const route = readFileSync(new URL("../src/app/api/production/route.ts", import.meta.url), "utf8");
  assert.match(route, /export const runtime = "nodejs";/);
  assert.match(route, /export const dynamic = "force-dynamic";/);
  assert.match(route, /export const maxDuration = 60;/);
  // POST only. A GET would turn a job id into a way to read production state without RLS review.
  assert.match(route, /export async function POST\(/);
  assert.equal(/export async function (GET|PUT|PATCH|DELETE)\(/.test(route), false);
});

// --- the acceptance vocabulary the owner writes --------------------------------------------------------

test("accepted assets are ready for content use and nothing publishes them", () => {
  assert.deepEqual([...ASSET_OWNER_DECISIONS], ["accepted", "rejected"]);
  assert.ok((ASSET_STATUSES as readonly string[]).includes("accepted"));

  // No publishing anywhere in the owner workflow.
  for (const path of ["../src/components/creative-package-production.tsx", "../src/app/api/production/route.ts", "../src/lib/production-execution.ts"]) {
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    for (const forbidden of ["postiz", "publishing_jobs", "schedulePost", "publish("]) {
      assert.equal(source.toLowerCase().includes(forbidden.toLowerCase()), false, `${path} must not publish`);
    }
  }
});

// --- E: the preview shows the REAL stored object ------------------------------------------------------

test("E: the preview is a signed URL for the stored Asset File, never the always-empty public_url", () => {
  const component = readFileSync(new URL("../src/components/creative-package-production.tsx", import.meta.url), "utf8");

  // asset-file-materialization.ts hardcodes publicUrl to "" -- the generated-assets bucket is
  // private. A preview built on file.publicUrl renders a broken image, which is exactly what the
  // first real production run against the live project produced before this was corrected.
  assert.match(component, /createSignedUrlForAssetFile/);
  assert.equal(/src=\{[^}]*publicUrl[^}]*\}/.test(component), false, "the preview must not be sourced from public_url");

  // And the preview is read back from the Asset pipeline, not from the production response body or a
  // scratch file.
  assert.match(component, /readAssetForAssetJobReadOnly/);
  assert.match(component, /listOrderedAssetFilesForAssetReadOnly/);
  assert.equal(component.includes("outputs/"), false, "the preview must never point at scratch output");
});

test("E: materialization really does leave public_url empty -- the reason a signed URL is required", () => {
  const materialization = readFileSync(new URL("../src/lib/asset-file-materialization.ts", import.meta.url), "utf8");
  assert.match(materialization, /publicUrl:\s*""/);
});
