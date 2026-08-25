import type { ProductionRoute } from "./production-route.ts";
import type { CreativePackageRecord } from "./creative-packages.ts";

export const PRODUCTION_VIDEO_ACTIVATION_OFF = {
  remotionShortVideo: false,
} as const;

export const PRODUCTION_VIDEO_ACTIVATION_ON_FOR_REVIEW = {
  remotionShortVideo: true,
} as const;

export type ProductionVideoActivation = typeof PRODUCTION_VIDEO_ACTIVATION_OFF | typeof PRODUCTION_VIDEO_ACTIVATION_ON_FOR_REVIEW;

export const MAX_WARM_OPEN_EXECUTABLE_SCENES = 2;
export const PRODUCTION_REMOTION_SHORT_VIDEO_ENV = "PRODUCTION_REMOTION_SHORT_VIDEO";

export function isRemotionShortVideoActivationEnabled(activation: ProductionVideoActivation = PRODUCTION_VIDEO_ACTIVATION_OFF): boolean {
  return activation.remotionShortVideo === true;
}

export function productionVideoActivationFromEnv(env: Record<string, string | undefined> = process.env): ProductionVideoActivation {
  return env[PRODUCTION_REMOTION_SHORT_VIDEO_ENV] === "1" ? PRODUCTION_VIDEO_ACTIVATION_ON_FOR_REVIEW : PRODUCTION_VIDEO_ACTIVATION_OFF;
}

export function isActivationExecutableRoute(route: ProductionRoute, activation: ProductionVideoActivation = PRODUCTION_VIDEO_ACTIVATION_OFF): boolean {
  return isRemotionShortVideoActivationEnabled(activation) && route.workerType === "remotion" && route.assetKind === "short_video";
}

export function validateRemotionShortVideoPackageForActivation(
  creativePackage: CreativePackageRecord,
  activation: ProductionVideoActivation = PRODUCTION_VIDEO_ACTIVATION_OFF,
): { ok: true } | { ok: false; message: string } {
  if (!isRemotionShortVideoActivationEnabled(activation)) {
    return { ok: true };
  }

  const content = creativePackage.content;
  if (!content || typeof content !== "object" || Array.isArray(content)) {
    return { ok: true };
  }

  const candidate = content as { schemaVersion?: unknown; format?: unknown; productionSource?: unknown; shots?: unknown };
  if (candidate.schemaVersion !== "v2" || candidate.format !== "reel") {
    return { ok: true };
  }

  if (candidate.productionSource === "generate_visual") {
    return {
      ok: false,
      message: "Creative Package v2 reel productionSource must be capture_new or template_only, not generate_visual: no generated visual source exists for a Reel.",
    };
  }

  if (candidate.productionSource !== "template_only") {
    return { ok: true };
  }

  const shotCount = Array.isArray(candidate.shots) ? candidate.shots.length : 0;
  if (shotCount > MAX_WARM_OPEN_EXECUTABLE_SCENES) {
    return {
      ok: false,
      message: `Template-only Reel activation is limited to ${MAX_WARM_OPEN_EXECUTABLE_SCENES} shots because the current warm-open composition renders only the first two shot text beats.`,
    };
  }

  return { ok: true };
}
