import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  PRODUCTION_REMOTION_SHORT_VIDEO_ENV,
  PRODUCTION_VIDEO_ACTIVATION_OFF,
  PRODUCTION_VIDEO_ACTIVATION_ON_FOR_REVIEW,
  productionVideoActivationFromEnv,
} from "../src/lib/production-video-activation.ts";

test("C2B-3B server activation defaults OFF and turns on only from the exact server env value", () => {
  assert.equal(productionVideoActivationFromEnv({}), PRODUCTION_VIDEO_ACTIVATION_OFF);
  assert.equal(productionVideoActivationFromEnv({ [PRODUCTION_REMOTION_SHORT_VIDEO_ENV]: "0" }), PRODUCTION_VIDEO_ACTIVATION_OFF);
  assert.equal(productionVideoActivationFromEnv({ [PRODUCTION_REMOTION_SHORT_VIDEO_ENV]: "true" }), PRODUCTION_VIDEO_ACTIVATION_OFF);
  assert.equal(productionVideoActivationFromEnv({ [PRODUCTION_REMOTION_SHORT_VIDEO_ENV]: "1" }), PRODUCTION_VIDEO_ACTIVATION_ON_FOR_REVIEW);
});

test("C2B-3B video queueing is server-derived from creativePackageId, never browser-supplied route data", () => {
  const route = readFileSync(new URL("../src/app/api/production/route.ts", import.meta.url), "utf8");
  const statements = route
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");

  assert.match(statements, /productionVideoActivationFromEnv\(\)/);
  assert.match(statements, /createAssetJobForReadyCreativePackage/);
  assert.match(statements, /getCreativePackageById/);
  assert.match(statements, /resolveProductionRoute/);
  assert.match(statements, /validateRemotionShortVideoPackageForActivation/);
  assert.match(statements, /resolvedRoute\.workerType !== "remotion"/);
  assert.match(statements, /resolvedRoute\.assetKind !== "short_video"/);
  assert.ok(
    statements.indexOf("const resolvedRoute = resolveProductionRoute") <
      statements.indexOf("const created = await createAssetJobForReadyCreativePackage"),
  );
  assert.equal(statements.includes("body.assetKind"), false);
  assert.equal(statements.includes("body.activation"), false);
});

test("C2B-3B owner UI queues video with only creativePackageId and uses the same path for Regenerate", () => {
  const component = readFileSync(new URL("../src/components/creative-package-production.tsx", import.meta.url), "utf8");
  assert.match(component, /const isActivatedVideoRoute = route\.workerType === "remotion" && route\.assetKind === "short_video";/);
  assert.match(component, /fetch\("\/api\/owner"/);
  assert.match(component, /payload\.production\?\.remotionShortVideo === true/);
  assert.match(component, /Video production is unavailable in this environment/);
  assert.match(component, /const workerSupported = isMachineProductionWorkerType\(route\.workerType\) \|\| \(isActivatedVideoRoute && videoAvailable === true\);/);
  assert.match(component, /body:\s*JSON\.stringify\(\{\s*creativePackageId\s*\}\)/);
  assert.match(component, /function produceRoute\(\)/);
  assert.match(component, /onClick=\{produceRoute\}/);
});

test("C2B-3B Remotion worker signs in and refuses anything except creative_worker", () => {
  const worker = readFileSync(new URL("../scripts/asset-workers/remotion-worker.ts", import.meta.url), "utf8");
  const statements = worker
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");

  assert.match(statements, /signInWithPassword/);
  assert.match(statements, /persistSession:\s*false/);
  assert.match(statements, /autoRefreshToken:\s*false/);
  assert.match(statements, /appRole !== "creative_worker"/);
  assert.equal(/service_role|SERVICE_ROLE/.test(statements), false);
  assert.equal(/OWNER_SUPABASE|PRODUCTION_OWNER/.test(statements), false);
});
