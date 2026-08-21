// Production MVP Wave C1 -- what the Remotion module can render, stated once, in a pure module.
//
// PURE and DEPENDENCY-FREE on purpose. This is imported by three very different callers -- the
// browser bundle Remotion renders inside, the Node render entry point, and `node --test` -- and it
// must behave identically in all three. It therefore imports no React, no `remotion`, and nothing
// from src/lib that would drag a Supabase client or a native module into a webpack bundle.
//
// WHY THE DIMENSIONS ARE RE-DECLARED RATHER THAN IMPORTED
//
// PRODUCTION_SHORT_VIDEO_DIMENSIONS already exists, in production-spec.ts, and IS the canonical
// answer. It is not imported here because production-spec.ts reaches creative-packages.ts and
// asset-digest.ts, and importing it would pull that whole graph into the browser bundle Remotion
// serves -- for two integers.
//
// So the two are held together the way this codebase already holds such pairs together: by a
// regression test rather than by a comment. tests/remotion-composition-catalog.test.ts asserts these
// constants equal PRODUCTION_SHORT_VIDEO_DIMENSIONS, and fails the moment they drift.

export const WARM_OPEN_COMPOSITION_ID = "warm-open";

// 30, not 24, 25 or 60. Vertical social video is authored and delivered at 30fps, and every duration
// in this module is expressed in seconds and converted through secondsToFrames -- so this number is
// read, never assumed, by anything that needs a frame count.
export const REMOTION_COMPOSITION_FPS = 30;

// Mirrors PRODUCTION_SHORT_VIDEO_DIMENSIONS. See the note above.
export const REMOTION_VERTICAL_WIDTH = 1080;
export const REMOTION_VERTICAL_HEIGHT = 1920;

// The window the first composition was designed inside. Below six seconds the closing group has no
// room to arrive without hurrying; above ten the held beats become dead air. Both bounds are creative
// decisions about THIS composition, not a platform limit, which is why they live beside it.
export const WARM_OPEN_MIN_DURATION_SECONDS = 6;
export const WARM_OPEN_MAX_DURATION_SECONDS = 10;
export const WARM_OPEN_DEFAULT_DURATION_SECONDS = 8;

// The explicit, structured input the composition takes. JSON-serializable throughout, because
// Remotion passes input props through JSON on the way into the render -- a Date, a Map or a function
// here would not survive the trip.
//
// Deliberately a SHAPE THE COMPOSITION NEEDS rather than a copy of ProductionSpecV1. The composition
// does not know what a Creative Package is and must not learn; production-spec-bridge.ts owns the
// translation, and that separation is what lets C2 wire the executor without editing any of the
// markup below.
export type WarmOpenProps = {
  // The small line above the headline. Short by construction -- an eyebrow, not a sentence.
  kicker: string;
  // The one line the video is actually about.
  headline: string;
  // Null is a real answer, mirroring ProductionSpecCopy.overlayText and ProductionScene.text: a
  // composition with no supporting line shows the headline alone rather than substituting something.
  supportingLine: string | null;
  brandMark: string;
  cta: string;
  // Seconds, not frames. The caller states creative intent; secondsToFrames turns it into a frame
  // count exactly once, here in this module.
  durationSeconds: number;
};

// CLAMPS, and is named so the call site cannot pretend otherwise.
//
// A Creative Package may legitimately state a targetDurationSeconds outside this composition's
// window -- fifteen seconds is a perfectly ordinary Reel. Silently rendering fifteen seconds of a
// composition designed for eight would produce dead air; silently refusing would make the bridge
// throw on real packages. So the clamp is a separate, visible step: the bridge calls it knowingly
// and reports what it did, and warmOpenDurationInFrames below still refuses anything out of range.
export function clampWarmOpenDurationSeconds(durationSeconds: number): number {
  if (!Number.isFinite(durationSeconds)) {
    throw new Error(`warm-open duration must be a finite number of seconds. Received: ${durationSeconds}.`);
  }
  return Math.min(WARM_OPEN_MAX_DURATION_SECONDS, Math.max(WARM_OPEN_MIN_DURATION_SECONDS, durationSeconds));
}

export function isWarmOpenDurationInRange(durationSeconds: number): boolean {
  return (
    Number.isFinite(durationSeconds) &&
    durationSeconds >= WARM_OPEN_MIN_DURATION_SECONDS &&
    durationSeconds <= WARM_OPEN_MAX_DURATION_SECONDS
  );
}

// THROWS out of range, deliberately, and is the function `calculateMetadata` and the render entry
// point both call. Anything that wants a clamp asks for one above, in a line a reviewer can see.
export function warmOpenDurationInFrames(durationSeconds: number): number {
  if (!isWarmOpenDurationInRange(durationSeconds)) {
    throw new Error(
      `warm-open duration must be between ${WARM_OPEN_MIN_DURATION_SECONDS} and ${WARM_OPEN_MAX_DURATION_SECONDS} seconds. Received: ${durationSeconds}.`,
    );
  }
  return Math.round(durationSeconds * REMOTION_COMPOSITION_FPS);
}

// The metadata a caller can compute WITHOUT rendering, and without Remotion installed.
//
// This is what makes the render result checkable: the entry point reports what Remotion actually
// produced, a test asserts this function predicts it, and ffprobe then confirms the file agrees with
// both. Three independent answers to the same question is the point.
export type WarmOpenCompositionMetadata = {
  compositionId: string;
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
  durationSeconds: number;
};

export function warmOpenMetadata(durationSeconds: number): WarmOpenCompositionMetadata {
  const durationInFrames = warmOpenDurationInFrames(durationSeconds);
  return {
    compositionId: WARM_OPEN_COMPOSITION_ID,
    width: REMOTION_VERTICAL_WIDTH,
    height: REMOTION_VERTICAL_HEIGHT,
    fps: REMOTION_COMPOSITION_FPS,
    durationInFrames,
    durationSeconds,
  };
}

// The props the Studio and the render harness both start from. Held here rather than only inline on
// <Composition> so a test can assert they are renderable, and so the harness has something to render
// without a Creative Package in hand.
export const WARM_OPEN_DEFAULT_PROPS: WarmOpenProps = {
  kicker: "Baked this morning",
  headline: "The kind of loaf that makes a room go quiet.",
  supportingLine: "Slow-proofed overnight. Out of the oven at seven.",
  brandMark: "Aly & Pon",
  cta: "Order the morning batch",
  durationSeconds: WARM_OPEN_DEFAULT_DURATION_SECONDS,
};
