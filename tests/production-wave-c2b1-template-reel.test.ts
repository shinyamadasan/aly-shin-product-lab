import test from "node:test";
import assert from "node:assert/strict";

import { validateCreativePackageContentV2, isCreativePackageContentV2 } from "../src/lib/creative-package-content-v2.ts";
import { buildProductionSpec } from "../src/lib/production-spec.ts";
import { resolveProductionRoute, isProductionRouteExecutable, EXECUTABLE_ASSET_JOB_WORKER_TYPES, MACHINE_PRODUCTION_WORKER_TYPES } from "../src/lib/production-route.ts";
import { EXECUTABLE_ASSET_KINDS, createAssetJobForReadyCreativePackage, toExecutableAssetJobRoute } from "../src/lib/asset-jobs.ts";
import { productionSourcesForFormat } from "../src/lib/creative-generation/contracts.ts";
import type { CreativePackageRecord } from "../src/lib/creative-packages.ts";

// Production MVP Wave C2B-1 -- the template-Reel CONTRACT BRIDGE.
//
// One mismatch is closed and nothing else. production-route.ts froze
// "reel:template_only -> remotion + short_video" in Wave A, but validateCreativePackageContentV2
// rejected that exact combination ("a Reel is filmed"), so the route was unreachable from any valid
// authored package. C1 built the renderer and C2A proved a worker rendering a real MP4 from a Reel's
// own shot list, so the premise of the categorical rule stopped being true.
//
// THE CENTRAL ACCEPTANCE TEST of this slice is the last one in this file: a VALID package, a VALID
// route resolution, and a STILL-NON-EXECUTABLE production path, all holding simultaneously.

function reelContent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: "v2",
    format: "reel",
    subject: "The morning sourdough",
    angle: "The quiet moment before the shop opens",
    hook: "Baked this morning",
    headline: "The kind of loaf that makes a room go quiet.",
    caption: "Slow-proofed overnight and out of the oven at seven.",
    cta: "Order the morning batch",
    platformVariants: [{ platform: "instagram", caption: "Out at seven.", hashtags: ["#sourdough"] }],
    metadata: {
      generatedFromOpportunity: "opp-1",
      generatorVersion: "2",
      sourceCreativeJobId: "job-1",
      sourceWorker: "mock",
      sourceJobResultSchemaVersion: "v2",
      formatChosenBy: "ai",
      formatRationale: "A slow reveal suits the subject.",
      subjectSource: "stated",
      subjectGrounding: null,
    },
    shots: [
      { direction: "Slow push on the cooling rack", onScreenText: "Baked this morning", approxSeconds: 4 },
      { direction: "Hands tearing the crust", onScreenText: "Slow-proofed overnight", approxSeconds: 4 },
    ],
    spokenScript: null,
    audioDirection: "Warm room tone, no music.",
    targetDurationSeconds: 8,
    ...overrides,
  };
}

// --- A. capture_new is untouched -----------------------------------------------------------------

test("A: reel + capture_new remains valid, with framing and with narration", () => {
  const filmed = validateCreativePackageContentV2(
    reelContent({
      productionSource: "capture_new",
      shots: [{ direction: "Overhead on the board", onScreenText: "Mine.", framing: "overhead", approxSeconds: 4 }],
      spokenScript: "Out of the oven at seven.",
    }),
  );
  assert.ok(filmed.ok, filmed.ok ? "" : filmed.message);

  // The narration rule added by this slice applies ONLY to template_only. A filmed Reel's executor is
  // a person who reads the script, so nothing about it changed.
  assert.ok(validateCreativePackageContentV2(reelContent({ productionSource: "capture_new", spokenScript: "Anything at all." })).ok);
});

test("A: a Reel with NO productionSource (pre-H1-B) remains valid", () => {
  // Absence is the legitimate legacy shape and is deliberately not read as capture_new. No migration
  // is required by this slice, and this is the assertion that proves it.
  assert.ok(validateCreativePackageContentV2(reelContent()).ok);
});

// --- B. the newly valid shape -----------------------------------------------------------------------

test("B: a narrowly valid reel + template_only NOW validates", () => {
  const result = validateCreativePackageContentV2(reelContent({ productionSource: "template_only" }));
  assert.ok(result.ok, result.ok ? "" : result.message);
});

// --- C. it is not a loophole --------------------------------------------------------------------------

test("C: a contentless template_only Reel still fails -- shots are required as they always were", () => {
  for (const shots of [[], undefined, "not-an-array"]) {
    const result = validateCreativePackageContentV2(reelContent({ productionSource: "template_only", shots }));
    assert.equal(result.ok, false, `shots=${JSON.stringify(shots)} must not validate`);
  }

  // A shot with no direction is not deterministic material either. This rule is REUSED, not
  // duplicated -- it already applied to every Reel.
  const blankDirection = validateCreativePackageContentV2(
    reelContent({ productionSource: "template_only", shots: [{ direction: "  ", onScreenText: null }] }),
  );
  assert.equal(blankDirection.ok, false);
});

test("C: a template_only Reel still cannot carry camera framing", () => {
  // This falls out of validateOptionalFraming, which has ALWAYS refused framing on a non-capture
  // package ("there is no camera to frame"). C2B-1 adds no rule here; the assertion records that the
  // existing invariant is what makes a template_only Reel structurally camera-less.
  const framed = validateCreativePackageContentV2(
    reelContent({ productionSource: "template_only", shots: [{ direction: "Board centred", onScreenText: null, framing: "overhead" }] }),
  );
  assert.equal(framed.ok, false);
  assert.match(framed.ok === false ? framed.message : "", /no camera to frame/);
});

test("C: a template_only Reel still needs a positive duration and an audioDirection", () => {
  assert.equal(validateCreativePackageContentV2(reelContent({ productionSource: "template_only", targetDurationSeconds: 0 })).ok, false);
  assert.equal(validateCreativePackageContentV2(reelContent({ productionSource: "template_only", audioDirection: "" })).ok, false);
});

// --- D. the one new rule ------------------------------------------------------------------------------

test("D: a template_only Reel must have spokenScript === null", () => {
  const narrated = validateCreativePackageContentV2(reelContent({ productionSource: "template_only", spokenScript: "Out of the oven at seven." }));
  assert.equal(narrated.ok, false);
  assert.match(narrated.ok === false ? narrated.message : "", /spokenScript must be null when productionSource is template_only/);

  // An empty string is a string, not an absence, and is refused for the same reason.
  assert.equal(validateCreativePackageContentV2(reelContent({ productionSource: "template_only", spokenScript: "" })).ok, false);
});

test("D: the BASE spokenScript error message is unchanged for every Reel", () => {
  // The new rule runs AFTER the pre-existing nullability check, so a malformed or absent spokenScript
  // still reports what it always did rather than being relabelled as a template_only problem.
  for (const productionSource of ["capture_new", "template_only", undefined]) {
    const result = validateCreativePackageContentV2(reelContent({ productionSource, spokenScript: 42 }));
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.message : "", /spokenScript must be a string or null/);
  }
});

// --- E / F. nothing else moved --------------------------------------------------------------------------

test("E: photo, carousel and story validation is untouched", () => {
  const photo = {
    ...reelContent(),
    format: "photo",
    visualDirection: "Overhead on the board, morning light",
    overlayText: "Mine.",
    shots: undefined,
    spokenScript: undefined,
    audioDirection: undefined,
    targetDurationSeconds: undefined,
  };
  // Every production source a photo could always take, still takes.
  for (const productionSource of ["capture_new", "generate_visual", "template_only", undefined]) {
    const content = productionSource === "capture_new" ? { ...photo, productionSource, framing: "overhead" } : { ...photo, productionSource };
    const result = validateCreativePackageContentV2(content);
    assert.ok(result.ok, `photo + ${productionSource} should still validate: ${result.ok ? "" : result.message}`);
  }

  // A photo carrying a spokenScript is simply an unknown key for that format -- the new rule is
  // scoped to reels and must not have leaked.
  assert.ok(validateCreativePackageContentV2({ ...photo, productionSource: "template_only", spokenScript: "anything" }).ok);
});

test("F: reel + generate_visual is STILL rejected -- this slice broadens nothing else", () => {
  const result = validateCreativePackageContentV2(reelContent({ productionSource: "generate_visual" }));
  assert.equal(result.ok, false);
  assert.match(result.ok === false ? result.message : "", /must be capture_new or template_only/);
  // The message must carry the DISTINCTION, not just the rejection: template_only is deterministic
  // assembly of material the package already has, while generate_visual claims a generated visual
  // source that does not exist for a Reel. Matched on that semantic fragment rather than the whole
  // sentence -- an assertion overfitted to punctuation breaks on a reword that changes no meaning.
  assert.match(result.ok === false ? result.message : "", /no generated visual source exists for a Reel/);
});

test("F: the GENERATOR still only ever chooses capture_new for a Reel", () => {
  // The separation this slice depends on: a validator that MAY ACCEPT a shape is not a generator that
  // WILL EMIT it. productionSourcesForFormat is the generation-side contract and C2B-1 does not touch
  // it, so default authoring behaviour is unchanged. Wave D owns the owner-facing selection.
  assert.deepEqual([...productionSourcesForFormat("reel")], ["capture_new"]);
});

// --- G. the route -----------------------------------------------------------------------------------------

test("G: a valid template_only Reel resolves to remotion + short_video", () => {
  const content = reelContent({ productionSource: "template_only" });
  assert.ok(isCreativePackageContentV2(content), "the fixture must be a valid v2 package");
  assert.deepEqual(resolveProductionRoute({ content }), { workerType: "remotion", assetKind: "short_video" });
});

test("G: the now-valid package compiles into a ProductionSpecV1 the Remotion module can consume", () => {
  // The point of the bridge, demonstrated end to end at the contract level: the package is valid, and
  // buildProductionSpec maps its shot list 1:1 into the spec the C2A executor already renders from.
  const content = reelContent({ productionSource: "template_only" });
  const spec = buildProductionSpec({ id: "pkg-1", content } as unknown as CreativePackageRecord, { assetKind: "short_video" });

  assert.equal(spec.assetKind, "short_video");
  assert.equal(spec.schemaVersion, "production-v1");
  assert.deepEqual(spec.dimensions, { width: 1080, height: 1920, aspectRatio: "9:16" });
  assert.equal(spec.assetKind === "short_video" ? spec.targetDurationSeconds : null, 8);
  assert.deepEqual(
    spec.assetKind === "short_video" ? spec.scenes : [],
    [
      { direction: "Slow push on the cooling rack", text: "Baked this morning", approxSeconds: 4 },
      { direction: "Hands tearing the crust", text: "Slow-proofed overnight", approxSeconds: 4 },
    ],
  );
});

// --- H / I / J. ACTIVATION IS STILL OFF ----------------------------------------------------------------------

test("H: the resolved route is still NOT executable", () => {
  const route = resolveProductionRoute({ content: reelContent({ productionSource: "template_only" }) });
  assert.equal(isProductionRouteExecutable(route), false);
  assert.equal(toExecutableAssetJobRoute(route), null);
  assert.deepEqual([...EXECUTABLE_ASSET_KINDS], ["image"]);
});

test("I: createAssetJobForReadyCreativePackage still REFUSES the now-valid package", async () => {
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
                      content: reelContent({ productionSource: "template_only" }),
                      created_at: "2026-08-22T10:00:00.000Z",
                      updated_at: "2026-08-22T10:00:00.000Z",
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

test("J: no owner/API worker union includes remotion", () => {
  assert.equal((EXECUTABLE_ASSET_JOB_WORKER_TYPES as readonly string[]).includes("remotion"), false);
  assert.equal((MACHINE_PRODUCTION_WORKER_TYPES as readonly string[]).includes("remotion"), false);
});

// --- THE CENTRAL ACCEPTANCE TEST -------------------------------------------------------------------------------

test("C2B-1 ACCEPTANCE: valid package + valid route resolution + non-executable production, all at once", async () => {
  const content = reelContent({ productionSource: "template_only" });

  // 1. The package is VALID. This is what C2B-1 changed.
  const validation = validateCreativePackageContentV2(content);
  assert.ok(validation.ok, validation.ok ? "" : validation.message);

  // 2. The route RESOLVES to the row Wave A froze. This was already true and is now reachable.
  assert.deepEqual(resolveProductionRoute({ content }), { workerType: "remotion", assetKind: "short_video" });

  // 3. Production still REFUSES it, at every gate. This is what C2B-1 did NOT change, and the reason
  //    the slice is safe to merge without activating anything.
  assert.equal(isProductionRouteExecutable({ workerType: "remotion", assetKind: "short_video" }), false);
  assert.equal(toExecutableAssetJobRoute({ workerType: "remotion", assetKind: "short_video" }), null);
  assert.equal((EXECUTABLE_ASSET_JOB_WORKER_TYPES as readonly string[]).includes("remotion"), false);
  assert.equal((MACHINE_PRODUCTION_WORKER_TYPES as readonly string[]).includes("remotion"), false);
});
