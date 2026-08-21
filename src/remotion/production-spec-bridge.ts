import type { ProductionShortVideoSpecV1 } from "../lib/production-spec.ts";
import {
  WARM_OPEN_MAX_DURATION_SECONDS,
  WARM_OPEN_MIN_DURATION_SECONDS,
  clampWarmOpenDurationSeconds,
  type WarmOpenProps,
} from "./composition-catalog.ts";

// Production MVP Wave C1 -- the ONE place a ProductionSpecV1 becomes composition props.
//
// This is the seam Wave C2 wires into. An AssetJobExecutor is handed a ProductionSpecV1 and must
// hand a renderer something it understands; this function is that translation and it is deliberately
// the only one. Put it in the executor instead and the mapping becomes invisible to tests, un-runnable
// from the CLI, and impossible to review without also reviewing job lifecycle code.
//
// PURE AND TOTAL. No AI, no clock, no I/O, no environment -- the same discipline production-route.ts
// and buildProductionSpec already hold. The same spec always produces the same props, which is what
// lets determinism be a testable claim rather than an aspiration.
//
// C1 DOES NOT CALL THIS FROM ANY EXECUTOR, and nothing in the job path imports it. It exists now so
// that C2 is a wiring change rather than a design change, and so that "ProductionSpec-compatible
// deterministic input" is something a test can demonstrate today.

// WHAT WAS CLAMPED, reported rather than hidden.
//
// A Reel's targetDurationSeconds is the sum the owner was shown; warm-open renders 6-10 seconds.
// When those disagree, silently rendering the clamped length would make the video quietly shorter
// than the plan it came from, and throwing would make an ordinary fifteen-second package unrenderable.
// So the clamp happens and it is announced. C2 decides what to do with the announcement -- record it
// on the attempt, warn the owner, or route to a different composition. C1 only refuses to be silent.
export type WarmOpenBridgeResult = {
  props: WarmOpenProps;
  // Null when the spec's own duration was already inside the composition's range and nothing moved.
  clampedFrom: number | null;
  // Advisory strings in the same spirit as validateGeneratedAssetCandidates' warnings: things a
  // reviewer should see, none of which are failures.
  warnings: string[];
};

// The kicker is NOT invented. A Reel's first shot already carries the on-screen text the video opens
// with, and that is what an eyebrow line is. When the first shot has no text there is nothing
// truthful to put there, so the fallback is the package's own call to action -- copy the generator
// did author -- and never a generic phrase this module made up.
function deriveKicker(spec: ProductionShortVideoSpecV1): string {
  const firstSceneText = spec.scenes[0]?.text?.trim();
  return firstSceneText && firstSceneText.length > 0 ? firstSceneText : spec.copy.cta;
}

// The supporting line is the SECOND shot's on-screen text, for the same reason: it is the line the
// package says comes after the opening one. Null when the package does not have one -- absence stays
// absence, exactly as ProductionScene.text and ProductionSpecCopy.overlayText both model it, and the
// composition closes up around it rather than substituting the social caption.
//
// spec.copy.caption is never read here. It is the SOCIAL POST caption and production-spec.ts is
// explicit that it is never drawn on the visual; the same rule holds for a video frame.
function deriveSupportingLine(spec: ProductionShortVideoSpecV1): string | null {
  const secondSceneText = spec.scenes[1]?.text?.trim();
  return secondSceneText && secondSceneText.length > 0 ? secondSceneText : null;
}

export function warmOpenPropsFromProductionSpec(spec: ProductionShortVideoSpecV1, options: { brandMark: string }): WarmOpenBridgeResult {
  if (spec.assetKind !== "short_video") {
    throw new Error(`warm-open props require a short_video ProductionSpecV1. Received assetKind: ${(spec as { assetKind: string }).assetKind}.`);
  }

  const warnings: string[] = [];

  const requested = spec.targetDurationSeconds;
  const durationSeconds = clampWarmOpenDurationSeconds(requested);
  const clampedFrom = durationSeconds === requested ? null : requested;
  if (clampedFrom !== null) {
    warnings.push(
      `duration-clamped: the package asks for ${requested}s and warm-open renders ${WARM_OPEN_MIN_DURATION_SECONDS}-${WARM_OPEN_MAX_DURATION_SECONDS}s. Rendering ${durationSeconds}s.`,
    );
  }

  // Scenes beyond the two the composition reads are not silently dropped -- they are reported. A
  // five-shot Reel rendered as a one-scene open is a real creative gap, and C2 needs to know it
  // exists rather than discover it in an owner review.
  if (spec.scenes.length > 2) {
    warnings.push(`scenes-unused: the package has ${spec.scenes.length} shots and warm-open renders a single held scene. Shots 3+ are not shown.`);
  }

  return {
    props: {
      kicker: deriveKicker(spec),
      headline: spec.copy.headline,
      supportingLine: deriveSupportingLine(spec),
      brandMark: options.brandMark,
      cta: spec.copy.cta,
      durationSeconds,
    },
    clampedFrom,
    warnings,
  };
}
