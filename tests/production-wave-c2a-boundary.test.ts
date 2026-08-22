import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  ASSET_JOB_WORKER_TYPES,
  ASSET_KINDS,
  EXECUTABLE_ASSET_KINDS,
  PRODUCTION_SPEC_WORKER_TYPES,
  MACHINE_EXECUTOR_SOURCE_KINDS,
  createAssetJobForReadyCreativePackage,
  toExecutableAssetJobRoute,
} from "../src/lib/asset-jobs.ts";
import {
  EXECUTABLE_ASSET_JOB_WORKER_TYPES,
  FUTURE_PRODUCTION_WORKER_TYPES,
  MACHINE_PRODUCTION_WORKER_TYPES,
  isMachineProductionWorkerType,
  isProductionRouteExecutable,
  resolveProductionRoute,
} from "../src/lib/production-route.ts";
import {
  ASSET_WORKER_EXECUTABLE_ASSET_KINDS,
  ASSET_WORKER_EXECUTABLE_WORKER_TYPES,
  WORKER_ONLY_ASSET_KINDS,
  isAssetWorkerExecutable,
} from "../src/lib/asset-worker-activation.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Production MVP Wave C2A -- THE ONE SENTENCE THIS WAVE IS ABOUT:
//
//   the worker knows HOW to execute a short_video
//   the application is NOT yet allowed to ASK it to
//
// C1's boundary test asserted the simpler, earlier state: nothing could execute a short_video at all.
// C2A deliberately changes half of that and must not change the other half, so every gate is asserted
// here together rather than spread across files that each assume another one is holding.

// --- the capability half: the worker CAN ------------------------------------------------------------

test("remotion is now a REGISTERED worker type the runner can claim", () => {
  assert.ok((ASSET_JOB_WORKER_TYPES as readonly string[]).includes("remotion"));
  // It reads ProductionSpecV1, like the other machine workers.
  assert.ok(PRODUCTION_SPEC_WORKER_TYPES.includes("remotion"));
  // Deterministic assembly, never a model. Recording it as ai_generated would be a provenance lie in
  // the same direction MACHINE_EXECUTOR_SOURCE_KINDS already refuses for the static renderer.
  assert.equal(MACHINE_EXECUTOR_SOURCE_KINDS.remotion, "human_designed");
  assert.notEqual(MACHINE_EXECUTOR_SOURCE_KINDS.remotion, "ai_generated");
});

test("nothing is a purely FUTURE worker any more -- remotion moved into the registered set", () => {
  // Wave A created this list to name workers the route table could want but nothing could claim.
  // Registering remotion empties it, which is the truthful statement that no route currently points
  // at an unbuildable worker. The concept survives for the next wave that needs it.
  assert.deepEqual([...FUTURE_PRODUCTION_WORKER_TYPES], []);
});

test("the WORKER's executable set admits short_video", () => {
  assert.deepEqual([...ASSET_WORKER_EXECUTABLE_ASSET_KINDS], ["image", "short_video"]);
  assert.ok((ASSET_WORKER_EXECUTABLE_WORKER_TYPES as readonly string[]).includes("remotion"));
  assert.equal(isAssetWorkerExecutable({ workerType: "remotion", assetKind: "short_video" }), true);
});

test("the worker gate still refuses combinations it cannot run", () => {
  // Both halves matter, mirroring isProductionRouteExecutable's own two-part shape.
  assert.equal(isAssetWorkerExecutable({ workerType: "external", assetKind: "short_video" }), false);
  assert.equal(isAssetWorkerExecutable({ workerType: "remotion", assetKind: "carousel" }), false);
  assert.equal(isAssetWorkerExecutable({ workerType: "not_a_worker", assetKind: "image" }), false);
});

// --- the activation half: the APPLICATION STILL CANNOT ------------------------------------------------

test("EXECUTABLE_ASSET_KINDS is UNCHANGED -- the app still cannot queue a short_video", () => {
  assert.deepEqual([...EXECUTABLE_ASSET_KINDS], ["image"]);
  assert.equal((EXECUTABLE_ASSET_KINDS as readonly string[]).includes("short_video"), false);
  // Still representable, which is what lets a spec, a route and a candidate describe one.
  assert.ok((ASSET_KINDS as readonly string[]).includes("short_video"));
});

test("no route carrying short_video is app-executable, whatever worker is paired with it", () => {
  for (const workerType of ASSET_JOB_WORKER_TYPES) {
    assert.equal(isProductionRouteExecutable({ workerType, assetKind: "short_video" }), false, `${workerType} + short_video must not be app-executable`);
    assert.equal(toExecutableAssetJobRoute({ workerType, assetKind: "short_video" }), null, `${workerType} + short_video must not narrow to a creatable route`);
  }
});

test("remotion is absent from the app-creatable worker set AND from the production API's set", () => {
  // The job-creation API's union is derived from this list, so absence here is a COMPILE error at the
  // call site as well as a runtime refusal.
  assert.equal((EXECUTABLE_ASSET_JOB_WORKER_TYPES as readonly string[]).includes("remotion"), false);
  // /api/production validates its workerType with isMachineProductionWorkerType.
  assert.equal((MACHINE_PRODUCTION_WORKER_TYPES as readonly string[]).includes("remotion"), false);
  assert.equal(isMachineProductionWorkerType("remotion"), false);
  assert.deepEqual([...MACHINE_PRODUCTION_WORKER_TYPES], ["static_renderer", "generative_image"]);
});

test("even a remotion + image pair cannot be created by the application", () => {
  // remotion is a real AssetJobWorkerType now, so this pair is nameable. It must still be refused,
  // because remotion is not in the app-creatable set -- the runtime half of the compile-time gate.
  assert.equal(toExecutableAssetJobRoute({ workerType: "remotion", assetKind: "image" }), null);
});

test("a reel package still resolves to the Remotion route and still cannot be queued from it", async () => {
  const route = resolveProductionRoute({ content: { schemaVersion: "v2", format: "reel", productionSource: "template_only" } });
  assert.deepEqual(route, { workerType: "remotion", assetKind: "short_video" });
  assert.equal(isProductionRouteExecutable(route), false);
  assert.equal(toExecutableAssetJobRoute(route), null);

  // And end to end through the creation API: a ready reel package must be REFUSED, with the route
  // named in the message rather than a generic failure.
  const client = {
    from() {
      return {
        select() {
          return {
            eq() {
              return {
                async maybeSingle() {
                  return {
                    data: {
                      id: "pkg-1",
                      status: "ready",
                      content: { schemaVersion: "v2", format: "reel", productionSource: "template_only" },
                      created_at: "2026-08-21T10:00:00.000Z",
                      updated_at: "2026-08-21T10:00:00.000Z",
                    },
                    error: null,
                  };
                },
              };
            },
          };
        },
      };
    },
  } as unknown as Parameters<typeof createAssetJobForReadyCreativePackage>[0];

  const created = await createAssetJobForReadyCreativePackage(client, "pkg-1");
  assert.equal(created.ok, false);
  assert.match(created.ok === false ? created.message : "", /not executable yet: remotion \+ short_video/);
});

// --- the two sets differ by EXACTLY the capability C2A added --------------------------------------------

test("the worker set strictly contains the app set, and the difference is short_video alone", () => {
  for (const kind of EXECUTABLE_ASSET_KINDS) {
    assert.ok((ASSET_WORKER_EXECUTABLE_ASSET_KINDS as readonly string[]).includes(kind), `the worker must still be able to run ${kind}`);
  }
  assert.deepEqual([...WORKER_ONLY_ASSET_KINDS], ["short_video"]);
});

// --- module isolation ------------------------------------------------------------------------------------

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

test("NOTHING the application can reach imports the worker activation set or the worker itself", () => {
  // The runtime half of the boundary, and the one that catches an accidental crossing. The moment a
  // route or a component imports asset-worker-activation.ts, the application has gained the wider
  // set -- which is precisely what C2B is for and precisely what C2A must not do by accident.
  const appFiles = [
    ...sourceFilesUnder(path.join(REPO_ROOT, "src", "app")),
    ...sourceFilesUnder(path.join(REPO_ROOT, "src", "components")),
    ...sourceFilesUnder(path.join(REPO_ROOT, "src", "lib")),
  ].filter((file) => !file.endsWith(`${path.sep}asset-worker-activation.ts`));

  assert.ok(appFiles.length > 0, "the source scan found nothing -- the test is not actually looking");

  // IMPORT STATEMENTS ONLY, not prose. asset-jobs.ts names asset-worker-activation.ts in a comment
  // that explains the boundary, and a bare substring match flagged that comment as a violation --
  // which would have made the correct explanation of the rule a breach of it.
  const importSpecifiers = (contents: string): string[] =>
    [...contents.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((match) => match[1]);

  const forbidden = [/asset-worker-activation/, /remotion\/worker/, /remotion\/asset-job-executor/, /remotion\/runtime\//, /^@remotion\//, /^remotion$/];

  for (const file of appFiles) {
    const relative = path.relative(REPO_ROOT, file);
    for (const specifier of importSpecifiers(readFileSync(file, "utf8"))) {
      for (const pattern of forbidden) {
        assert.doesNotMatch(specifier, pattern, `${relative} must not import ${specifier} (matches ${pattern})`);
      }
    }
  }
});

test("the production API route still refuses any worker type outside the two machine image workers", () => {
  const route = readFileSync(path.join(REPO_ROOT, "src", "app", "api", "production", "route.ts"), "utf8");
  // The gate is a call to isProductionWorkerType, which is MACHINE_PRODUCTION_WORKER_TYPES' guard.
  assert.match(route, /isProductionWorkerType\(workerType\)/);
  assert.doesNotMatch(route, /remotion/i);
});

// --- storage: untouched ------------------------------------------------------------------------------------

test("C2A applies no SQL and does not rewrite the video storage migration", () => {
  const migration = readFileSync(path.join(REPO_ROOT, "supabase-add-generated-assets-video.sql"), "utf8");
  assert.match(migration, /allowed_mime_types = array\['image\/png', 'image\/jpeg', 'image\/webp', 'video\/mp4'\]/i);
  assert.match(migration, /file_size_limit = 52428800/i);
  // Still unapplied, still Wave A's file, still C2B's to apply.
  assert.match(migration, /NOT APPLIED BY THE BUILDER/i);
});
