import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  EXECUTABLE_ASSET_JOB_WORKER_TYPES,
  FUTURE_PRODUCTION_WORKER_TYPES,
  LEGACY_PRODUCTION_ROUTE,
  isProductionRouteExecutable,
  resolveProductionRoute,
  type ProductionRoute,
} from "../src/lib/production-route.ts";
import { CREATIVE_PRODUCTION_SOURCES } from "../src/lib/creative-production-guidance.ts";
import { CREATIVE_FORMATS } from "../src/lib/creative-formats.ts";
import { ASSET_JOB_WORKER_TYPES } from "../src/lib/asset-jobs.ts";

// Minimal structural content. resolveProductionRoute reads schemaVersion, format and
// productionSource and nothing else, so these fixtures carry exactly those -- deliberately NOT full
// valid packages, because a fuller fixture would imply the resolver inspects more than it does.
function v2Content(format: string, productionSource?: string): Record<string, unknown> {
  const content: Record<string, unknown> = { schemaVersion: "v2", format };
  if (productionSource !== undefined) {
    content.productionSource = productionSource;
  }
  return content;
}

function route(content: unknown): ProductionRoute {
  return resolveProductionRoute({ content });
}

// --- the desired route table ----------------------------------------------------------------------

test("resolveProductionRoute maps every routed format x productionSource combination to its intended future route", () => {
  const expected: Array<[string, string | undefined, ProductionRoute]> = [
    // Photo -- the format that spans all three production sources.
    ["photo", "capture_new", { workerType: "external", assetKind: "image" }],
    ["photo", "generate_visual", { workerType: "generative_image", assetKind: "image" }],
    ["photo", "template_only", { workerType: "static_renderer", assetKind: "image" }],

    // Reel. capture_new is the only combination the stored contract permits TODAY; template_only is
    // the synthetic future row that Wave D unlocks once a renderer exists. The table defines both
    // now precisely so Wave D changes validators, not routing.
    ["reel", "capture_new", { workerType: "external", assetKind: "short_video" }],
    ["reel", "template_only", { workerType: "remotion", assetKind: "short_video" }],
  ];

  for (const [format, productionSource, want] of expected) {
    assert.deepEqual(
      route(v2Content(format, productionSource)),
      want,
      `${format} + ${productionSource} routed to the wrong destination`,
    );
  }
});

// reel + generate_visual is absent from the table on purpose: there is no video MODEL, only a
// renderer, so "generate a video" is a promise nothing in the roadmap keeps. It falls to legacy
// rather than resolving to an automated route.
test("reel + generate_visual has no automated route -- there is no video generation model", () => {
  assert.deepEqual(route(v2Content("reel", "generate_visual")), LEGACY_PRODUCTION_ROUTE);
});

// --- legacy / absent productionSource ---------------------------------------------------------------

test("a package with no productionSource takes the legacy route -- absence is never read as capture_new", () => {
  for (const format of CREATIVE_FORMATS) {
    assert.deepEqual(
      route(v2Content(format)),
      LEGACY_PRODUCTION_ROUTE,
      `${format} without productionSource must keep its pre-H1-B behaviour`,
    );
  }
});

test("legacy route is exactly the behaviour shipped today: external + image", () => {
  assert.deepEqual(LEGACY_PRODUCTION_ROUTE, { workerType: "external", assetKind: "image" });
});

test("v1 and unrecognisable content take the legacy route", () => {
  const cases: unknown[] = [
    { schemaVersion: "v1", output: { headline: "h", caption: "c" } },
    { output: { headline: "h" } },
    {},
    null,
    undefined,
    "not an object",
    [],
    { schemaVersion: "v3", format: "photo", productionSource: "template_only" },
  ];

  for (const content of cases) {
    assert.deepEqual(route(content), LEGACY_PRODUCTION_ROUTE, `unexpected route for ${JSON.stringify(content)}`);
  }
});

test("unknown format or productionSource vocabulary takes the legacy route rather than throwing", () => {
  assert.deepEqual(route(v2Content("hologram", "capture_new")), LEGACY_PRODUCTION_ROUTE);
  assert.deepEqual(route(v2Content("photo", "reuse_existing")), LEGACY_PRODUCTION_ROUTE);
  assert.deepEqual(route(v2Content("photo", "remotion")), LEGACY_PRODUCTION_ROUTE);
});

// --- deferred formats ------------------------------------------------------------------------------

test("carousel and story are deferred: every productionSource keeps the current external behaviour", () => {
  for (const format of ["carousel", "story"]) {
    for (const productionSource of CREATIVE_PRODUCTION_SOURCES) {
      assert.deepEqual(
        route(v2Content(format, productionSource)),
        LEGACY_PRODUCTION_ROUTE,
        `${format} + ${productionSource} must not gain an automated route in Production MVP`,
      );
    }
  }
});

// --- totality and determinism ------------------------------------------------------------------------

test("resolveProductionRoute is total over every format x productionSource combination, including absence", () => {
  for (const format of CREATIVE_FORMATS) {
    for (const productionSource of [...CREATIVE_PRODUCTION_SOURCES, undefined]) {
      const resolved = route(v2Content(format, productionSource));
      assert.ok(resolved, `no route for ${format} + ${String(productionSource)}`);
      assert.ok(typeof resolved.workerType === "string" && resolved.workerType.length > 0);
      assert.ok(resolved.assetKind === "image" || resolved.assetKind === "short_video");
    }
  }
});

test("resolveProductionRoute is deterministic -- no clock, no randomness, no I/O", () => {
  for (const format of CREATIVE_FORMATS) {
    for (const productionSource of [...CREATIVE_PRODUCTION_SOURCES, undefined]) {
      const content = v2Content(format, productionSource);
      const first = route(content);
      for (let i = 0; i < 25; i += 1) {
        assert.deepEqual(route(content), first, `${format} + ${String(productionSource)} was not stable across calls`);
      }
    }
  }
});

// --- vocabulary invariants ----------------------------------------------------------------------------

test("productionSource vocabulary is unchanged: exactly capture_new, generate_visual, template_only", () => {
  assert.deepEqual([...CREATIVE_PRODUCTION_SOURCES], ["capture_new", "generate_visual", "template_only"]);
});

test("no execution technology leaked into the productionSource vocabulary", () => {
  for (const forbidden of ["remotion", "generate_motion", "ai_video", "generative_image", "image_provider", "ffmpeg", "comfyui"]) {
    assert.equal(
      (CREATIVE_PRODUCTION_SOURCES as readonly string[]).includes(forbidden),
      false,
      `${forbidden} must never become a productionSource: it answers "which software executes it", not "how should this come into existence"`,
    );
  }
});

// The domain boundary, enforced against the source text rather than trusted. A Creative Package
// describes creative intent; naming a renderer, a provider, a model or a codec in the package
// contract is the failure this checks for.
test("[static] the Creative Package contract names no execution technology", () => {
  for (const path of [
    "src/lib/creative-package-content-v2.ts",
    "src/lib/creative-production-guidance.ts",
    "src/lib/creative-formats.ts",
  ]) {
    const source = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
    for (const forbidden of [/remotion/i, /comfyui/i, /openai/i, /midjourney/i, /\bffmpeg\b/i, /\bh\.?264\b/i, /durationInFrames/, /\bfps\b/i]) {
      assert.doesNotMatch(source, forbidden, `${path} must not name execution technology`);
    }
  }
});

// --- the runtime activation boundary (Wave A's load-bearing guarantee) ----------------------------------

// Wave C2A is the first wave in which these two sets DIFFER, and the difference is the whole point.
//
// Before C2A they were equal, and equality was a fine way to say "every claimable worker is also
// app-creatable". Registering the Remotion executor separates them: the worker runtime can claim it,
// the application may not name it. So the invariant becomes a strict-subset relation plus an exact
// statement of the gap -- which pins more, not less, than the old equality did.
test("the app-creatable worker set is a STRICT SUBSET of what the runner can claim", () => {
  for (const workerType of EXECUTABLE_ASSET_JOB_WORKER_TYPES) {
    assert.ok(
      (ASSET_JOB_WORKER_TYPES as readonly string[]).includes(workerType),
      `${workerType} is app-creatable but is not a worker the runner can claim -- a queued row naming it could never run`,
    );
  }

  const workerOnly = ASSET_JOB_WORKER_TYPES.filter((workerType) => !(EXECUTABLE_ASSET_JOB_WORKER_TYPES as readonly string[]).includes(workerType));
  assert.deepEqual([...workerOnly], ["remotion"], "the only worker the app may not create is the Remotion one, until C2B activates it");
});

test("only future worker types stay outside the Asset Job worker vocabulary", () => {
  for (const future of FUTURE_PRODUCTION_WORKER_TYPES) {
    assert.equal(
      (ASSET_JOB_WORKER_TYPES as readonly string[]).includes(future),
      false,
      `${future} must not join ASSET_JOB_WORKER_TYPES until the wave that registers its executor -- an Asset Job naming it could never be claimed`,
    );
  }
});

test("isProductionRouteExecutable is true only for routes a registered executor can run today", () => {
  assert.equal(isProductionRouteExecutable({ workerType: "external", assetKind: "image" }), true);
  assert.equal(isProductionRouteExecutable({ workerType: "mock", assetKind: "image" }), true);

  assert.equal(isProductionRouteExecutable({ workerType: "generative_image", assetKind: "image" }), true);
  assert.equal(isProductionRouteExecutable({ workerType: "static_renderer", assetKind: "image" }), true);
  assert.equal(isProductionRouteExecutable({ workerType: "remotion", assetKind: "image" }), false);

  // And short_video is not executable even behind a registered worker: nothing produces one, and
  // the storage bucket still rejects video/mp4.
  assert.equal(isProductionRouteExecutable({ workerType: "external", assetKind: "short_video" }), false);
  assert.equal(isProductionRouteExecutable({ workerType: "remotion", assetKind: "short_video" }), false);
});

// THE load-bearing Wave A regression.
//
// The resolver is allowed to KNOW the future route. The live system must not ACT on it. Since the
// only way an unclaimable Asset Job could be written is for a creation path to consume a resolved
// route, this asserts against the source text that no such path exists yet -- which is precisely the
// assertion that will fail, loudly and in the right place, if Wave B or Wave C wires the resolver in
// without also registering the executor it selects.
//
// It walks the real source tree rather than naming files. A fixed allowlist can only prove things
// about the files someone remembered to list, so it silently stops protecting anything the moment
// Wave B adds a new module -- which is precisely when this invariant matters most.
function collectSourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...collectSourceFiles(full));
    } else if (entry.isFile() && /[.]tsx?$/.test(entry.name)) {
      found.push(full);
    }
  }
  return found;
}

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const RESOLVER_MODULE = path.join(REPO_ROOT, "src", "lib", "production-route.ts");

test("[static] production route consumption is allowed now that Wave B image executors are registered", () => {
  // src/ is the application; scripts/ is the worker and CLI surface that actually creates and runs
  // Asset Jobs. Both are production, so both are scanned -- an activation wired from a worker would
  // queue exactly the same unclaimable row as one wired from a component.
  const sources = [path.join(REPO_ROOT, "src"), path.join(REPO_ROOT, "scripts")].flatMap(collectSourceFiles);

  // A scan that silently found nothing would pass this test forever. Assert the walker actually
  // reached the tree, and reached the resolver itself, before trusting an empty result below.
  assert.ok(sources.length > 50, `expected a populated source tree, scanned ${sources.length} file(s)`);
  assert.ok(sources.includes(RESOLVER_MODULE), "the scan must reach production-route.ts itself");

  // Only the resolver's own module is exempt. Tests live outside src/ and scripts/ and are never
  // scanned, so no test-shaped exception is needed here.
  const consumers = sources
    .filter((file) => file !== RESOLVER_MODULE)
    .filter((file) => /resolveProductionRoute/.test(readFileSync(file, "utf8")))
    .map((file) => path.relative(REPO_ROOT, file).split(path.sep).join("/"));

  assert.ok(consumers.includes("src/lib/asset-jobs.ts"), "Asset Job creation must consume the resolver now that image production routes are executable.");
});

test("[static] the owner-facing app still creates only the external image job it can lead the owner through", () => {
  const creation = readFileSync(new URL("../src/components/creative-package-asset-create.tsx", import.meta.url), "utf8");

  // Wave B registers both machine executors, but ONLY the trusted CLI worker can run them: this app
  // has no scheduler, no background worker and no in-browser executor. Letting the owner-facing button
  // queue a machine route therefore created a job the app could not execute, on a screen where upload
  // was disabled and no completion path existed.
  //
  // So the single owner call site stays explicitly external + image until the final owner-workflow
  // integration lands. This assertion is what stops that narrowing from being quietly undone: deleting
  // the options here would re-open the dead end, not "activate a feature".
  assert.match(creation, /createAssetJobForReadyCreativePackage\(\s*client,\s*creativePackageId,\s*\{\s*workerType:\s*"external",\s*assetKind:\s*"image"\s*\}\s*\)/);

  // And the app never names a machine worker in a job it creates.
  assert.doesNotMatch(creation, /workerType:\s*"(static_renderer|generative_image)"/);
});
