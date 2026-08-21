import { Composition } from "remotion";

import { WarmOpen } from "./compositions/warm-open.tsx";
import {
  REMOTION_COMPOSITION_FPS,
  REMOTION_VERTICAL_HEIGHT,
  REMOTION_VERTICAL_WIDTH,
  WARM_OPEN_COMPOSITION_ID,
  WARM_OPEN_DEFAULT_DURATION_SECONDS,
  warmOpenDurationInFrames,
  type WarmOpenProps,
} from "./composition-catalog.ts";

// Production MVP Wave C1 -- the composition registry.
//
// ONE composition. Wave C1 proves a renderer, and a second composition would be a second creative
// decision made before the first one has been reviewed.
//
// The official Remotion guidance prefers literal width/height/fps on <Composition> so Remotion Studio
// can write edited values back into the source. This module deliberately uses the catalog constants
// instead, and the reason is specific rather than stylistic: these dimensions are not this file's to
// choose. They must equal PRODUCTION_SHORT_VIDEO_DIMENSIONS, a regression test asserts exactly that,
// and a literal typed here would be a fourth place the number lives and the one place nothing checks.
// This is a programmatic render foundation, not a Studio-authored video, so the round-trip the rule
// protects is not a round-trip anyone here makes.
//
// defaultProps IS kept as an inline object literal, per the same guidance, because that costs
// nothing and keeps the values visible next to the composition they parameterize.
export function RemotionRoot() {
  return (
    <Composition
      id={WARM_OPEN_COMPOSITION_ID}
      component={WarmOpen}
      width={REMOTION_VERTICAL_WIDTH}
      height={REMOTION_VERTICAL_HEIGHT}
      fps={REMOTION_COMPOSITION_FPS}
      durationInFrames={warmOpenDurationInFrames(WARM_OPEN_DEFAULT_DURATION_SECONDS)}
      defaultProps={{
        kicker: "Baked this morning",
        headline: "The kind of loaf that makes a room go quiet.",
        supportingLine: "Slow-proofed overnight. Out of the oven at seven.",
        brandMark: "Aly & Pon",
        cta: "Order the morning batch",
        durationSeconds: WARM_OPEN_DEFAULT_DURATION_SECONDS,
      } satisfies WarmOpenProps}
      // The duration follows the PROPS, so a caller passing durationSeconds: 10 gets a ten-second
      // render without the registry being edited. Deliberately calls the throwing variant rather
      // than the clamping one: input props that reach here have already been through the bridge or
      // the render entry point, both of which clamp visibly, so an out-of-range value at this point
      // is a bug and should say so rather than be quietly rounded into range.
      calculateMetadata={({ props }) => ({
        durationInFrames: warmOpenDurationInFrames(props.durationSeconds),
      })}
    />
  );
}
