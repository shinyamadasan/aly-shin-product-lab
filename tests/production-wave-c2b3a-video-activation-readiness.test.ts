import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  PRODUCTION_VIDEO_ACTIVATION_OFF,
  PRODUCTION_VIDEO_ACTIVATION_ON_FOR_REVIEW,
  MAX_WARM_OPEN_EXECUTABLE_SCENES,
  type ProductionVideoActivation,
} from "../src/lib/production-video-activation.ts";
import { isProductionRouteExecutable, MACHINE_PRODUCTION_WORKER_TYPES, EXECUTABLE_ASSET_JOB_WORKER_TYPES, resolveProductionRoute, type ProductionRoute } from "../src/lib/production-route.ts";
import { ASSET_JOB_WORKER_TYPES, ASSET_KINDS, createAssetJobForReadyCreativePackage, toExecutableAssetJobRoute, type AssetJobRow } from "../src/lib/asset-jobs.ts";
import { productionSourcesForFormat } from "../src/lib/creative-generation/contracts.ts";

function reelContent(shots = 2, productionSource: "capture_new" | "generate_visual" | "template_only" = "template_only"): Record<string, unknown> {
  return {
    schemaVersion: "v2",
    format: "reel",
    productionSource,
    subject: "Morning sourdough",
    angle: "Warm open",
    hook: "Baked this morning",
    headline: "Fresh from the oven.",
    caption: "Slow-proofed and ready.",
    cta: "Order today",
    platformVariants: [{ platform: "instagram", caption: "Fresh today.", hashtags: [] }],
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
    shots: Array.from({ length: shots }, (_, index) => ({
      direction: `Shot ${index + 1}`,
      onScreenText: `Beat ${index + 1}`,
      approxSeconds: 4,
    })),
    spokenScript: null,
    audioDirection: "Room tone only.",
    targetDurationSeconds: shots * 4,
  };
}

function clientForPackage(content: Record<string, unknown>, inserted: Partial<AssetJobRow>[] = []) {
  return {
    from(table: "creative_packages" | "asset_jobs") {
      if (table === "creative_packages") {
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
                        content,
                        created_at: "2026-08-24T10:00:00.000Z",
                        updated_at: "2026-08-24T10:00:00.000Z",
                      },
                      error: null,
                    };
                  },
                };
              },
            };
          },
        };
      }

      return {
        insert(row: Partial<AssetJobRow>) {
          inserted.push(row);
          return {
            select() {
              return {
                async single() {
                  return {
                    data: {
                      id: `job-${inserted.length}`,
                      creative_package_id: row.creative_package_id ?? "pkg-1",
                      status: row.status ?? "queued",
                      worker_type: row.worker_type ?? "mock",
                      asset_kind: row.asset_kind ?? "image",
                      attempt_count: row.attempt_count ?? 0,
                      result: row.result ?? {},
                      last_error: row.last_error ?? null,
                      created_at: "2026-08-24T10:00:01.000Z",
                      updated_at: "2026-08-24T10:00:01.000Z",
                      started_at: null,
                      completed_at: null,
                      failed_at: null,
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
}

function expectedExecutable(route: ProductionRoute, activation: ProductionVideoActivation): boolean {
  const defaultImageRoute = route.assetKind === "image" && (EXECUTABLE_ASSET_JOB_WORKER_TYPES as readonly string[]).includes(route.workerType);
  const activatedVideoRoute = activation.remotionShortVideo === true && route.workerType === "remotion" && route.assetKind === "short_video";
  return defaultImageRoute || activatedVideoRoute;
}

function assertRouteMatrix(activation: ProductionVideoActivation) {
  for (const workerType of ASSET_JOB_WORKER_TYPES) {
    for (const assetKind of ASSET_KINDS) {
      const route = { workerType, assetKind };
      const expected = expectedExecutable(route, activation);
      assert.equal(
        isProductionRouteExecutable(route, activation),
        expected,
        `predicate mismatch for ${workerType} + ${assetKind} with activation=${activation.remotionShortVideo}`,
      );
      assert.equal(
        toExecutableAssetJobRoute(route, activation) !== null,
        expected,
        `narrowing mismatch for ${workerType} + ${assetKind} with activation=${activation.remotionShortVideo}`,
      );
      assert.equal(
        toExecutableAssetJobRoute(route, activation) !== null,
        isProductionRouteExecutable(route, activation),
        `predicate and narrowing disagree for ${workerType} + ${assetKind} with activation=${activation.remotionShortVideo}`,
      );
    }
  }
}

test("C2B-3A default activation remains OFF at every owner/API registry", async () => {
  const route = { workerType: "remotion", assetKind: "short_video" } as const;
  assert.equal(isProductionRouteExecutable(route), false);
  assert.equal(isProductionRouteExecutable(route, PRODUCTION_VIDEO_ACTIVATION_OFF), false);
  assert.equal(toExecutableAssetJobRoute(route), null);
  assert.equal(toExecutableAssetJobRoute(route, PRODUCTION_VIDEO_ACTIVATION_OFF), null);
  assert.equal((EXECUTABLE_ASSET_JOB_WORKER_TYPES as readonly string[]).includes("remotion"), false);
  assert.equal((MACHINE_PRODUCTION_WORKER_TYPES as readonly string[]).includes("remotion"), false);

  const inserted: Partial<AssetJobRow>[] = [];
  const created = await createAssetJobForReadyCreativePackage(clientForPackage(reelContent(), inserted), "pkg-1");
  assert.equal(created.ok, false);
  assert.deepEqual(inserted, []);
});

test("C2B-3A OFF route-pair matrix covers every known worker and asset kind", () => {
  assertRouteMatrix(PRODUCTION_VIDEO_ACTIVATION_OFF);

  assert.equal(isProductionRouteExecutable({ workerType: "remotion", assetKind: "short_video" }, PRODUCTION_VIDEO_ACTIVATION_OFF), false);
  assert.equal(toExecutableAssetJobRoute({ workerType: "remotion", assetKind: "short_video" }, PRODUCTION_VIDEO_ACTIVATION_OFF), null);
  assert.equal(isProductionRouteExecutable({ workerType: "remotion", assetKind: "image" }, PRODUCTION_VIDEO_ACTIVATION_OFF), false);
  assert.equal(toExecutableAssetJobRoute({ workerType: "remotion", assetKind: "image" }, PRODUCTION_VIDEO_ACTIVATION_OFF), null);
  assert.equal(isProductionRouteExecutable({ workerType: "static_renderer", assetKind: "short_video" }, PRODUCTION_VIDEO_ACTIVATION_OFF), false);
  assert.equal(toExecutableAssetJobRoute({ workerType: "static_renderer", assetKind: "short_video" }, PRODUCTION_VIDEO_ACTIVATION_OFF), null);
  assert.equal(isProductionRouteExecutable({ workerType: "generative_image", assetKind: "short_video" }, PRODUCTION_VIDEO_ACTIVATION_OFF), false);
  assert.equal(toExecutableAssetJobRoute({ workerType: "generative_image", assetKind: "short_video" }, PRODUCTION_VIDEO_ACTIVATION_OFF), null);
});

test("C2B-3A ON route-pair matrix admits only remotion + short_video beyond existing image routes", () => {
  assertRouteMatrix(PRODUCTION_VIDEO_ACTIVATION_ON_FOR_REVIEW);

  assert.equal(isProductionRouteExecutable({ workerType: "remotion", assetKind: "short_video" }, PRODUCTION_VIDEO_ACTIVATION_ON_FOR_REVIEW), true);
  assert.deepEqual(toExecutableAssetJobRoute({ workerType: "remotion", assetKind: "short_video" }, PRODUCTION_VIDEO_ACTIVATION_ON_FOR_REVIEW), {
    workerType: "remotion",
    assetKind: "short_video",
  });
  assert.equal(isProductionRouteExecutable({ workerType: "remotion", assetKind: "image" }, PRODUCTION_VIDEO_ACTIVATION_ON_FOR_REVIEW), false);
  assert.equal(toExecutableAssetJobRoute({ workerType: "remotion", assetKind: "image" }, PRODUCTION_VIDEO_ACTIVATION_ON_FOR_REVIEW), null);
  assert.equal(isProductionRouteExecutable({ workerType: "static_renderer", assetKind: "short_video" }, PRODUCTION_VIDEO_ACTIVATION_ON_FOR_REVIEW), false);
  assert.equal(toExecutableAssetJobRoute({ workerType: "static_renderer", assetKind: "short_video" }, PRODUCTION_VIDEO_ACTIVATION_ON_FOR_REVIEW), null);
  assert.equal(isProductionRouteExecutable({ workerType: "generative_image", assetKind: "short_video" }, PRODUCTION_VIDEO_ACTIVATION_ON_FOR_REVIEW), false);
  assert.equal(toExecutableAssetJobRoute({ workerType: "generative_image", assetKind: "short_video" }, PRODUCTION_VIDEO_ACTIVATION_ON_FOR_REVIEW), null);
  assert.equal(isProductionRouteExecutable({ workerType: "external", assetKind: "short_video" }, PRODUCTION_VIDEO_ACTIVATION_ON_FOR_REVIEW), false);
  assert.equal(toExecutableAssetJobRoute({ workerType: "external", assetKind: "short_video" }, PRODUCTION_VIDEO_ACTIVATION_ON_FOR_REVIEW), null);
});

test("C2B-3A ON route-spoofing cannot combine an activated worker with another kind or another worker with short_video", () => {
  const spoofedMixedRoutes = [
    { workerType: "remotion", assetKind: "image" },
    { workerType: "static_renderer", assetKind: "short_video" },
    { workerType: "generative_image", assetKind: "short_video" },
    { workerType: "external", assetKind: "short_video" },
    { workerType: "manual_illustration", assetKind: "short_video" },
  ] as const;

  for (const route of spoofedMixedRoutes) {
    assert.equal(isProductionRouteExecutable(route, PRODUCTION_VIDEO_ACTIVATION_ON_FOR_REVIEW), false);
    assert.equal(toExecutableAssetJobRoute(route, PRODUCTION_VIDEO_ACTIVATION_ON_FOR_REVIEW), null);
  }
});

test("C2B-3A ON review seam narrows and queues remotion + short_video without editing default registries", async () => {
  const route = { workerType: "remotion", assetKind: "short_video" } as const;
  assert.deepEqual(resolveProductionRoute({ content: reelContent(2) }), route);
  assert.equal(isProductionRouteExecutable(route, PRODUCTION_VIDEO_ACTIVATION_ON_FOR_REVIEW), true);
  assert.deepEqual(toExecutableAssetJobRoute(route, PRODUCTION_VIDEO_ACTIVATION_ON_FOR_REVIEW), route);

  const inserted: Partial<AssetJobRow>[] = [];
  const created = await createAssetJobForReadyCreativePackage(clientForPackage(reelContent(), inserted), "pkg-1", {
    activation: PRODUCTION_VIDEO_ACTIVATION_ON_FOR_REVIEW,
  });

  assert.equal(created.ok, true);
  assert.deepEqual(inserted.map((row) => ({ worker_type: row.worker_type, asset_kind: row.asset_kind, status: row.status })), [
    { worker_type: "remotion", asset_kind: "short_video", status: "queued" },
  ]);
});

test("C2B-3A ON review seam rejects a package the current composition would lose scenes from", async () => {
  const inserted: Partial<AssetJobRow>[] = [];
  const created = await createAssetJobForReadyCreativePackage(clientForPackage(reelContent(MAX_WARM_OPEN_EXECUTABLE_SCENES + 1), inserted), "pkg-1", {
    activation: PRODUCTION_VIDEO_ACTIVATION_ON_FOR_REVIEW,
  });

  assert.equal(created.ok, false);
  assert.match(created.ok ? "" : created.message, /limited to 2 shots/);
  assert.deepEqual(inserted, []);
});

test("D1 ON review seam rejects template-only Reels that promise unsupported custom visual execution", async () => {
  const inserted: Partial<AssetJobRow>[] = [];
  const unsupported = {
    ...reelContent(2),
    headline: "The Brownie Split Test",
    cta: "Which half are you taking?",
    shots: [
      {
        direction: "Draw a rounded brownie and animate a dashed dividing line across it.",
        onScreenText: "one brownie. two people.",
        approxSeconds: 4,
      },
      {
        direction: "Show the lopsided split diagram with yours/mine labels attached to the pieces.",
        onScreenText: "somehow one half is always bigger.",
        approxSeconds: 5,
      },
    ],
    targetDurationSeconds: 9,
  };

  const created = await createAssetJobForReadyCreativePackage(clientForPackage(unsupported, inserted), "pkg-1", {
    activation: PRODUCTION_VIDEO_ACTIVATION_ON_FOR_REVIEW,
  });

  assert.equal(created.ok, false);
  assert.match(created.ok ? "" : created.message, /cannot execute custom product visuals/);
  assert.deepEqual(inserted, []);
});

test("D1 ON review seam rejects template-only Reels outside warm-open duration capability before clamp", async () => {
  const inserted: Partial<AssetJobRow>[] = [];
  const elevenSeconds = {
    ...reelContent(2),
    shots: [
      { direction: "First typography beat introduces the setup.", onScreenText: "one", approxSeconds: 5 },
      { direction: "Second text beat lands as the reveal.", onScreenText: "two", approxSeconds: 6 },
    ],
    targetDurationSeconds: 11,
  };

  const created = await createAssetJobForReadyCreativePackage(clientForPackage(elevenSeconds, inserted), "pkg-1", {
    activation: PRODUCTION_VIDEO_ACTIVATION_ON_FOR_REVIEW,
  });

  assert.equal(created.ok, false);
  assert.match(created.ok ? "" : created.message, /total duration must be 6-10 seconds/);
  assert.deepEqual(inserted, []);
});

test("C2B-3A ON review seam rejects reel + generate_visual before queue creation even with a caller-supplied image route", async () => {
  const inserted: Partial<AssetJobRow>[] = [];
  const created = await createAssetJobForReadyCreativePackage(clientForPackage(reelContent(2, "generate_visual"), inserted), "pkg-1", {
    workerType: "external",
    assetKind: "image",
    activation: PRODUCTION_VIDEO_ACTIVATION_ON_FOR_REVIEW,
  });

  assert.equal(created.ok, false);
  assert.match(created.ok ? "" : created.message, /no generated visual source exists for a Reel/);
  assert.deepEqual(inserted, []);
});

test("C2B-3A/D1 Reel generator authoring excludes generated visual sources", () => {
  assert.deepEqual([...productionSourcesForFormat("reel")], ["capture_new", "template_only"]);
});

test("C2B-3A preview prepares signed MP4 video rendering without public URL storage", () => {
  const component = readFileSync("src/components/creative-package-assets.tsx", "utf8");
  assert.match(component, /file\.mimeType === "video\/mp4"/);
  assert.match(component, /<video[\s\S]*controls[\s\S]*playsInline[\s\S]*src=\{signed\.url\}/);
  assert.match(component, /createSignedUrlForAssetFile/);
  assert.doesNotMatch(component, /publicUrl/);
  assert.match(component, /No Asset has been materialized yet\./);
});
