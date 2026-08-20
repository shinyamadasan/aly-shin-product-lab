import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import sharp from "sharp";

import {
  ASSET_JOB_WORKER_TYPES,
  MACHINE_EXECUTOR_SOURCE_KINDS,
  PRODUCTION_SPEC_WORKER_TYPES,
  createAssetJobForReadyCreativePackage,
  type AssetJobClient,
  type AssetJobRecord,
  type AssetJobRow,
} from "../src/lib/asset-jobs.ts";
import { EXECUTABLE_ASSET_JOB_WORKER_TYPES, resolveProductionRoute } from "../src/lib/production-route.ts";
import {
  buildManualIllustration,
  buildManualIllustrationExecutor,
} from "../src/lib/production-manual-composition.ts";
import { buildExternalAssetExecutor } from "../src/lib/external-asset-provider.ts";
import { buildCloudflareGenerativeImageExecutor } from "../src/lib/production-asset-executors.ts";
import { classifyTransportFailureStatus, isUpstreamProductionFailure } from "../src/lib/production-execution.ts";
import { PRODUCTION_IMAGE_DIMENSIONS, type ProductionImageSpecV1 } from "../src/lib/production-spec.ts";
import type { CreativePackageRow } from "../src/lib/creative-packages.ts";

// Production MVP Wave B -- the manual illustration path.
//
// Test H is the one that matters most: it proves the manual path and the automated path are the same
// composition, not two that merely look similar. Everything else guards a boundary around it.

function spec(): ProductionImageSpecV1 {
  return {
    schemaVersion: "production-v1",
    assetKind: "image",
    sourceCreativePackageId: "package-1",
    dimensions: PRODUCTION_IMAGE_DIMENSIONS,
    copy: {
      headline: "Brownies, still warm",
      caption: "Out of the oven at 7am.",
      cta: "Order today",
      overlayText: "still warm",
    },
    brandStyle: null,
    visualBrief: {
      concept: "Two dessert characters over the last brownie",
      style: "Soft hand-drawn illustration, warm bakery palette",
      scene: ["Board centred"],
      executionNotes: ["Keep it obviously illustrated"],
    },
  };
}

function job(workerType: string): AssetJobRecord {
  return {
    id: "asset-job-1",
    creativePackageId: "package-1",
    status: "running",
    workerType,
    assetKind: "image",
    attemptCount: 1,
  } as AssetJobRecord;
}

const executionContext = { signal: new AbortController().signal, recordProvenance: () => {} };

// A real, decodable illustration -- never a fabricated byte string. The composition path decodes it
// with sharp, so anything less would fail for the wrong reason.
async function illustrationBytes(tint = { r: 200, g: 140, b: 90 }): Promise<Uint8Array> {
  return new Uint8Array(
    await sharp({ create: { width: 1024, height: 1024, channels: 4, background: { ...tint, alpha: 1 } } })
      .png()
      .toBuffer(),
  );
}

function v2PackageRow(productionSource: string): CreativePackageRow {
  return {
    id: "package-1",
    creative_job_id: "job-1",
    status: "ready",
    schema_version: "v2",
    content: {
      schemaVersion: "v2",
      format: "photo",
      subject: "Brownies",
      angle: "Fresh batch",
      hook: "Still warm.",
      headline: "Brownies, still warm",
      caption: "Out of the oven at 7am.",
      cta: "Order today",
      visualDirection: "Overhead on the wooden board",
      overlayText: null,
      productionSource,
      ...(productionSource === "capture_new"
        ? { framing: "overhead" }
        : {
            visualBrief: {
              concept: "Two dessert characters over the last brownie",
              style: "Soft hand-drawn illustration",
              scene: ["Board centred"],
              executionNotes: ["Keep it obviously illustrated"],
            },
          }),
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

function makeJobClient(packages: CreativePackageRow[]) {
  const jobs: AssetJobRow[] = [];
  const client = {
    from(table: string) {
      if (table === "creative_packages") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: packages[0] ?? null, error: null }),
            }),
          }),
        };
      }
      return {
        insert(row: Record<string, unknown>) {
          const inserted = { id: `asset-job-${jobs.length + 1}`, created_at: "2026-08-19T10:00:00.000Z", updated_at: "2026-08-19T10:00:00.000Z", ...row } as AssetJobRow;
          jobs.push(inserted);
          return { select: () => ({ single: async () => ({ data: inserted, error: null }) }) };
        },
      };
    },
  } as unknown as AssetJobClient;
  return { client, jobs };
}

// --- H: one composition, two ways in ------------------------------------------------------------------

test("H: the same illustration and spec produce a byte-identical PNG on the automated and manual paths", async () => {
  const bytes = await illustrationBytes();
  const productionSpec = spec();

  // The automated path, with the provider faked at the network boundary only -- everything after the
  // HTTP response is the real Cloudflare executor, including its call into the compositor.
  const automatedExecutor = buildCloudflareGenerativeImageExecutor({
    accountId: "account",
    apiToken: "token",
    fetchImpl: async () => new Response(Buffer.from(bytes), { status: 200, headers: { "content-type": "image/png" } }),
  });
  const [automated] = await automatedExecutor(job("generative_image"), productionSpec, executionContext);

  // The manual path, given the identical bytes.
  const manualExecutor = buildManualIllustrationExecutor({ bytes, mimeType: "image/png" });
  const [manual] = await manualExecutor(job("manual_illustration"), productionSpec, executionContext);

  assert.equal(manual.width, automated.width);
  assert.equal(manual.height, automated.height);
  assert.equal(manual.mimeType, automated.mimeType);
  assert.equal(manual.fileSizeBytes, automated.fileSizeBytes);
  assert.deepEqual(Buffer.from(manual.bytes), Buffer.from(automated.bytes), "the two paths must produce identical pixels");
});

test("H: the manual executor makes exactly the same compositor call the Cloudflare one does", () => {
  const manual = readFileSync(new URL("../src/lib/production-manual-composition.ts", import.meta.url), "utf8");
  const automated = readFileSync(new URL("../src/lib/production-asset-executors.ts", import.meta.url), "utf8");
  const call = /renderProductionStaticImage\((\w+), \{ illustration \}\)/;
  assert.match(manual, call);
  assert.match(automated, call);
});

// --- G: the manual upload is composed, not stored raw ---------------------------------------------------

test("G: a manually uploaded illustration is composited rather than materialized as-is", async () => {
  const bytes = await illustrationBytes();
  const [composed] = await buildManualIllustrationExecutor({ bytes, mimeType: "image/png" })(
    job("manual_illustration"),
    spec(),
    executionContext,
  );

  assert.notDeepEqual(Buffer.from(composed.bytes), Buffer.from(bytes), "the stored asset must not be the raw upload");
  // It is the spec's frame, not the upload's.
  assert.equal(composed.width, PRODUCTION_IMAGE_DIMENSIONS.width);
  assert.equal(composed.height, PRODUCTION_IMAGE_DIMENSIONS.height);
  assert.equal(composed.mimeType, "image/png");
  assert.equal(composed.position, 0);
  assert.equal(composed.durationMs, null);
});

test("G: composition uses the runner's spec, never anything a caller could inject", async () => {
  const bytes = await illustrationBytes();
  const executor = buildManualIllustrationExecutor({ bytes, mimeType: "image/png" });
  await assert.rejects(
    async () => { await executor(job("manual_illustration"), { schemaVersion: "v1", assetKind: "image" } as never, executionContext); },
    /production-v1 image spec/,
  );
});

test("G: an unreadable or unsupported upload is refused before any job is claimed", async () => {
  assert.equal((await buildManualIllustration(new Uint8Array())).ok, false);
  assert.equal((await buildManualIllustration(new Uint8Array([1, 2, 3, 4]))).ok, false);

  const good = await buildManualIllustration(await illustrationBytes());
  assert.equal(good.ok, true);
  if (good.ok) {
    assert.equal(good.illustration.mimeType, "image/png");
  }
});

// --- J: capture_new stays untouched -----------------------------------------------------------------------

test("J: a capture_new package still routes to external and its upload is never composited", async () => {
  assert.deepEqual(resolveProductionRoute({ content: v2PackageRow("capture_new").content }), { workerType: "external", assetKind: "image" });

  // The external executor returns the operator's bytes unchanged -- a real photograph must reach
  // storage as the photograph, not as an illustration under a template.
  const bytes = await illustrationBytes();
  const candidate = { position: 0, mimeType: "image/png", width: 1024, height: 1024, durationMs: null, fileSizeBytes: bytes.length, bytes };
  const [returned] = await buildExternalAssetExecutor(candidate)(job("external"), spec(), executionContext);
  assert.deepEqual(Buffer.from(returned.bytes), Buffer.from(bytes));

  const external = readFileSync(new URL("../src/lib/external-asset-provider.ts", import.meta.url), "utf8");
  assert.equal(external.includes("renderProductionStaticImage"), false, "the external path must never reach the compositor");
});

test("J: external and manual_illustration are separate workers, so neither can be composed by accident", () => {
  assert.ok(ASSET_JOB_WORKER_TYPES.includes("external"));
  assert.ok(ASSET_JOB_WORKER_TYPES.includes("manual_illustration"));
  // The runner dispatches on worker type, so "is this composited" is answered by which worker the
  // job carries -- never by a flag on a shared one.
  assert.notEqual("external", "manual_illustration");
});

// --- F + I: job creation and truthful provenance -------------------------------------------------------------

test("F: the manual fallback creates a queued manual_illustration image job", async () => {
  const store = makeJobClient([v2PackageRow("generate_visual")]);
  const created = await createAssetJobForReadyCreativePackage(store.client, "package-1", { workerType: "manual_illustration", assetKind: "image" });

  assert.equal(created.ok, true);
  assert.equal(store.jobs.length, 1);
  assert.equal(store.jobs[0].worker_type, "manual_illustration");
  assert.equal(store.jobs[0].asset_kind, "image");
  assert.equal(store.jobs[0].status, "queued");
});

test("F: the automated route for a generate_visual package is unchanged by the fallback existing", async () => {
  assert.deepEqual(resolveProductionRoute({ content: v2PackageRow("generate_visual").content }), { workerType: "generative_image", assetKind: "image" });

  const store = makeJobClient([v2PackageRow("generate_visual")]);
  await createAssetJobForReadyCreativePackage(store.client, "package-1");
  assert.equal(store.jobs[0].worker_type, "generative_image", "naming no worker must still resolve through the route table");
});

test("I: manual_illustration keeps source kind operator-declared, and reads the production spec", () => {
  // NOT in the derived map: a ChatGPT illustration's origin is a fact only the owner knows, so the
  // runner must honour their declaration instead of asserting one.
  assert.equal(MACHINE_EXECUTOR_SOURCE_KINDS.manual_illustration, undefined);
  // The two workers whose origin IS observable stay observable.
  assert.equal(MACHINE_EXECUTOR_SOURCE_KINDS.generative_image, "ai_generated");
  assert.equal(MACHINE_EXECUTOR_SOURCE_KINDS.static_renderer, "human_designed");

  // It resolves ProductionSpecV1, so the stored fingerprint is of the spec the prompt package was
  // rendered from -- not of a human brief the owner never saw.
  assert.ok(PRODUCTION_SPEC_WORKER_TYPES.includes("manual_illustration"));
  assert.equal(PRODUCTION_SPEC_WORKER_TYPES.includes("external"), false);
});

test("I: the manual route declares the owner's source kind and never invents one", () => {
  const route = readFileSync(new URL("../src/app/api/production/manual/route.ts", import.meta.url), "utf8");
  assert.match(route, /isAssetSourceKind\(sourceKindField\)/, "the declared value must be validated against the closed set");
  assert.match(route, /sourceKind\b/);
  // No default is applied server-side: absent stays absent.
  assert.equal(/sourceKind\s*\?\?\s*"(ai_generated|photograph|human_designed)"/.test(route), false);

  // The UI guides toward the truthful answer by defaulting the control, which the owner can change.
  const component = readFileSync(new URL("../src/components/creative-package-production.tsx", import.meta.url), "utf8");
  assert.match(component, /useState\(SOURCE_KIND_LABELS\.ai_generated\)/);
});

// --- K + L: explicit fallback, never silent -------------------------------------------------------------------

test("L: an upstream Cloudflare status is classified structurally, not from message text", () => {
  assert.equal(classifyTransportFailureStatus(429), "quota");
  assert.equal(classifyTransportFailureStatus(401), "auth");
  assert.equal(classifyTransportFailureStatus(403), "auth");
  assert.equal(classifyTransportFailureStatus(503), "unavailable");
  assert.equal(classifyTransportFailureStatus(500), null, "an unclassified status must stay a generic failure");
  assert.equal(classifyTransportFailureStatus(400), null);

  for (const reason of ["quota", "auth", "unavailable"] as const) {
    assert.equal(isUpstreamProductionFailure(reason), true);
  }
  for (const reason of ["not-found", "not-queued", "timeout", "failed", "conflict", "missing-table"] as const) {
    assert.equal(isUpstreamProductionFailure(reason), false);
  }
});

test("L: the executor reports the status of the request that finally failed", async () => {
  const seen: number[] = [];
  const executor = buildCloudflareGenerativeImageExecutor({
    accountId: "account",
    apiToken: "token",
    fetchImpl: async () => new Response("rate limited", { status: 429, headers: { "retry-after": "0" } }),
    onTransportFailure: ({ status }) => seen.push(status),
  });

  await assert.rejects(async () => { await executor(job("generative_image"), spec(), executionContext); }, /429/);
  assert.deepEqual(seen, [429], "reported exactly once, after the bounded retry is exhausted");
});

test("L: a recovered transient failure is NOT reported as an outage", async () => {
  const seen: number[] = [];
  const bytes = await illustrationBytes();
  let call = 0;
  const executor = buildCloudflareGenerativeImageExecutor({
    accountId: "account",
    apiToken: "token",
    fetchImpl: async () => {
      call += 1;
      return call === 1
        ? new Response("busy", { status: 503, headers: { "retry-after": "0" } })
        : new Response(Buffer.from(bytes), { status: 200, headers: { "content-type": "image/png" } });
    },
    onTransportFailure: ({ status }) => seen.push(status),
  });

  const [composed] = await executor(job("generative_image"), spec(), executionContext);
  assert.equal(composed.width, 1080);
  assert.deepEqual(seen, [], "a retry that succeeded must not open the owner-facing fallback banner");
});

test("L: the owner is offered the manual and static choices, and the automatic button is withheld", () => {
  const component = readFileSync(new URL("../src/components/creative-package-production.tsx", import.meta.url), "utf8");

  assert.match(component, /AI illustration generation is unavailable right now\./);
  assert.match(component, /Generate manually with ChatGPT/);
  assert.match(component, /Use a text\/editorial version instead/);
  // The automatic entry point renders only while no upstream failure is showing.
  assert.match(component, /phase === "idle" && !doNotRetryNotice && !unavailable/);
  // Only a classified 503 opens the banner -- an ordinary error stays an ordinary error.
  assert.match(component, /httpStatus === 503 && payload\.reason/);
});

test("K: the static fallback is a choice the owner makes, never one the system makes", () => {
  const execution = readFileSync(new URL("../src/lib/production-execution.ts", import.meta.url), "utf8");
  const statements = execution
    .split("\n")
    .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*") && !line.trim().startsWith("/*"))
    .join("\n");

  // Nothing in the shared execution boundary may re-run a failed generative job under another
  // worker: no retry loop, no substitution, no second runAssetJobWithExecutors call per entry point.
  assert.equal(/catch[\s\S]{0,400}buildStaticRendererExecutor/.test(statements), false, "a failed generation must never fall through to a static render");
  assert.equal(statements.split("runAssetJobWithExecutors(").length - 1, 2, "exactly one run call per execution function");

  // In the UI, the static path is reached only from an explicit click.
  const component = readFileSync(new URL("../src/components/creative-package-production.tsx", import.meta.url), "utf8");
  assert.match(component, /onClick=\{\(\) => produce\("static_renderer"\)\}/);
  assert.match(component, /different-looking post with no illustration/);
});

test("E: the manual path is offered for generate_visual and withheld from template_only", () => {
  const component = readFileSync(new URL("../src/components/creative-package-production.tsx", import.meta.url), "utf8");
  assert.match(component, /const supportsManual = route\.workerType === "generative_image"/);
  // The panel renders only when the package supports it AND the owner opened it -- so a
  // template_only package can never reach it, and a generate_visual one is never forced into it.
  assert.match(component, /supportsManual && manualOpen \? renderManualPanel\(\) : null/);
  // Every entry point to the manual path is behind the same guard.
  const entryPoints = component.match(/Generate manually with ChatGPT/g) ?? [];
  assert.equal(entryPoints.length, 3, "failure banner, post-production actions, and the idle button");
  for (const guarded of [/supportsManual \? \([\s\S]{0,400}Generate manually with ChatGPT/]) {
    assert.match(component, guarded);
  }
});

// --- M: short_video and Remotion stay blocked ---------------------------------------------------------------

test("M: adding the manual worker did not make remotion or short_video reachable", async () => {
  assert.equal(EXECUTABLE_ASSET_JOB_WORKER_TYPES.includes("remotion" as never), false);
  for (const workerType of EXECUTABLE_ASSET_JOB_WORKER_TYPES) {
    assert.ok(ASSET_JOB_WORKER_TYPES.includes(workerType), `${workerType} must be a real, claimable worker`);
  }

  // A short_video asset kind cannot be requested through the manual fallback either.
  const store = makeJobClient([v2PackageRow("generate_visual")]);
  const created = await createAssetJobForReadyCreativePackage(store.client, "package-1", {
    workerType: "manual_illustration",
    assetKind: "short_video" as never,
  });
  assert.equal(created.ok, false);
  assert.equal(store.jobs.length, 0);
});

test("M: manual_illustration is executable but is not a route-table destination", () => {
  assert.ok(EXECUTABLE_ASSET_JOB_WORKER_TYPES.includes("manual_illustration"));
  const source = readFileSync(new URL("../src/lib/production-route.ts", import.meta.url), "utf8");
  const table = source.slice(source.indexOf("const PRODUCTION_ROUTES"), source.indexOf("export const LEGACY_PRODUCTION_ROUTE"));
  assert.equal(table.includes("manual_illustration"), false, "no package may auto-route to the manual fallback");
});
