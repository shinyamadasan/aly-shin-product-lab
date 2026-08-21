import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { ASSET_JOB_WORKER_TYPES, EXECUTABLE_ASSET_KINDS, toExecutableAssetJobRoute } from "../src/lib/asset-jobs.ts";
import { EXECUTABLE_ASSET_JOB_WORKER_TYPES, FUTURE_PRODUCTION_WORKER_TYPES, isProductionRouteExecutable, resolveProductionRoute } from "../src/lib/production-route.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Production MVP Wave C1 -- THE ACTIVATION BOUNDARY, asserted in one place.
//
// C1 adds a Remotion renderer and stops. It does NOT make short_video producible through the Wave B
// Asset Job path, and every separate mechanism that could accidentally open that door is checked
// here rather than being spread across three files that each assume one of the others is holding.
//
// production-route.ts states the rule this enforces: each wave extends the executable set in the
// same change that registers the executor it names. C1 registers no executor, so the executable set
// must be exactly what Wave B left behind.

test("the Remotion worker is still only a FUTURE worker type -- nothing can claim it", () => {
  assert.ok((FUTURE_PRODUCTION_WORKER_TYPES as readonly string[]).includes("remotion"));
  // The compiler-level half of the boundary: "remotion" is deliberately absent from the set of
  // worker types an Asset Job row may carry, so a resolved Remotion route cannot be inserted without
  // someone first widening this list -- which is the change that should only land with an executor.
  assert.equal((ASSET_JOB_WORKER_TYPES as readonly string[]).includes("remotion"), false);
  assert.equal((EXECUTABLE_ASSET_JOB_WORKER_TYPES as readonly string[]).includes("remotion"), false);
});

test("short_video is representable but NOT executable", () => {
  assert.equal((EXECUTABLE_ASSET_KINDS as readonly string[]).includes("short_video"), false);
  assert.deepEqual([...EXECUTABLE_ASSET_KINDS], ["image"]);
});

test("no route carrying short_video is executable, whatever worker is paired with it", () => {
  // Both halves of isProductionRouteExecutable still matter. Even a REGISTERED worker paired with
  // short_video is refused, because the asset kind is the other half of the gate.
  for (const workerType of [...ASSET_JOB_WORKER_TYPES, ...FUTURE_PRODUCTION_WORKER_TYPES]) {
    assert.equal(isProductionRouteExecutable({ workerType, assetKind: "short_video" }), false, `${workerType} + short_video must not be executable`);
    assert.equal(toExecutableAssetJobRoute({ workerType, assetKind: "short_video" }), null, `${workerType} + short_video must not narrow to an executable route`);
  }
});

test("a reel template_only package still resolves to the Remotion route and is still not executable", () => {
  const route = resolveProductionRoute({ content: { schemaVersion: "v2", format: "reel", productionSource: "template_only" } });
  assert.deepEqual(route, { workerType: "remotion", assetKind: "short_video" });
  // The desired route is unchanged by C1 -- and so is its inability to run.
  assert.equal(isProductionRouteExecutable(route), false);
  assert.equal(toExecutableAssetJobRoute(route), null);
});

test("the executable worker set is EXACTLY what Wave B left behind", () => {
  assert.deepEqual([...EXECUTABLE_ASSET_JOB_WORKER_TYPES].sort(), ["external", "generative_image", "manual_illustration", "mock", "static_renderer"]);
});

// --- module isolation ------------------------------------------------------------------------------

function sourceFilesUnder(directory: string): string[] {
  const found: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current)) {
      const full = path.join(current, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (/\.(ts|tsx)$/.test(entry)) {
        found.push(full);
      }
    }
  };
  walk(directory);
  return found;
}

test("nothing in the shipped app or the Asset Job path imports the Remotion module", () => {
  // The runtime half of the boundary. The type-level checks above stop a Remotion JOB being created;
  // this stops the Remotion RENDERER being reachable from the app at all -- which matters for a
  // second reason too: src/remotion/render.ts pulls @remotion/bundler and @remotion/renderer, and
  // those must never enter a Next.js server bundle or a browser graph.
  const appFiles = sourceFilesUnder(path.join(REPO_ROOT, "src", "app"));
  const libFiles = sourceFilesUnder(path.join(REPO_ROOT, "src", "lib"));
  const componentFiles = sourceFilesUnder(path.join(REPO_ROOT, "src", "components"));

  assert.ok(appFiles.length > 0 && libFiles.length > 0, "the source scan found nothing -- the test is not actually looking");

  for (const file of [...appFiles, ...libFiles, ...componentFiles]) {
    const contents = readFileSync(file, "utf8");
    const relative = path.relative(REPO_ROOT, file);
    assert.ok(!/from\s+["'][^"']*\/remotion\//.test(contents), `${relative} imports the Remotion module`);
    assert.ok(!/from\s+["']@remotion\//.test(contents), `${relative} imports a @remotion package`);
    assert.ok(!/from\s+["']remotion["']/.test(contents), `${relative} imports remotion`);
  }
});

test("the Remotion packages are devDependencies -- C1 does not change what the deployed app ships", () => {
  // C1 renders locally and deploys nothing. Putting these in `dependencies` would enlarge the
  // serverless function for /api/production, which currently traces native modules by hand
  // (see next.config.ts) and has already failed a deploy once over exactly that kind of weight.
  // Where a C2 worker gets its Remotion packages is a runtime-packaging decision C2 makes.
  const manifest = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };

  for (const name of ["remotion", "@remotion/bundler", "@remotion/renderer"]) {
    assert.ok(name in manifest.devDependencies, `${name} must be a devDependency in C1`);
    assert.ok(!(name in manifest.dependencies), `${name} must NOT be a runtime dependency in C1`);
  }

  // Every @remotion package must be pinned to the SAME exact version. Remotion requires it, and a
  // caret range would let a bundler and a renderer drift apart on an ordinary npm install.
  const remotionVersions = new Set(
    Object.entries(manifest.devDependencies)
      .filter(([name]) => name === "remotion" || name.startsWith("@remotion/"))
      .map(([, version]) => version),
  );
  assert.equal(remotionVersions.size, 1, `Remotion packages are not on one version: ${[...remotionVersions].join(", ")}`);
  const [version] = [...remotionVersions];
  assert.match(version, /^\d+\.\d+\.\d+$/, `Remotion must be pinned exactly, found "${version}"`);
});

test("C1 applies no live SQL and authors no new migration", () => {
  // The video storage migration is Wave A's, is still unapplied, and C1 does not rewrite it. This
  // asserts its two load-bearing settings are exactly as Wave A authored them.
  const migration = readFileSync(path.join(REPO_ROOT, "supabase-add-generated-assets-video.sql"), "utf8");
  assert.match(migration, /allowed_mime_types = array\['image\/png', 'image\/jpeg', 'image\/webp', 'video\/mp4'\]/i);
  assert.match(migration, /file_size_limit = 52428800/i);
  assert.match(migration, /NOT APPLIED BY THE BUILDER/i);
});
