import { Easing, interpolate, useCurrentFrame, useVideoConfig } from "remotion";

import { HearthIllustration } from "../fixtures/hearth-illustration.tsx";
import { MediaFrame, Reveal, TypeBlock, WARM_PALETTE, VerticalCanvas } from "../primitives.tsx";
import { staggeredWindows, windowFromSeconds, windowProgress } from "../timing.ts";
import type { WarmOpenProps } from "../composition-catalog.ts";

// Production MVP Wave C1 -- the first composition, and the proof that the module renders.
//
// SIMPLE LAYOUT, EXPRESSIVE ELEMENTS. One column, one picture, four lines of type, one drawn rule.
// There is no grid, no card, no badge, no gradient text and no second column, because every one of
// those would be layout complexity spent instead of on the two things that actually carry the frame:
// the typography and the slowness.
//
// THE TIMELINE, in seconds, for the default eight-second cut. Every number is stated once, below, as
// a window -- never as a magic frame index -- so the whole rhythm can be read in one place and so a
// six- or ten-second cut rescales without any of it being re-derived.
//
//   0.00 - 1.40   the plate arrives
//   0.55 - 1.65   the kicker
//   1.15 - 2.55   the headline
//   2.30 - 3.30   the drawn rule under it
//   2.75 - 4.05   the supporting line
//   4.30 - ...    the closing group, staggered: mark, hairline, call to action
//   0.00 - end    the savoring zoom, running underneath all of it
//
// NOTHING EXITS. Every beat arrives and then holds to the last frame. That is a creative decision
// and it is also why there is no exit primitive to reach for.
//
// The windows are expressed as FRACTIONS OF THE COMPOSITION, not as absolute seconds. A ten-second
// cut should feel like the same video taken slower, not like an eight-second video with two seconds
// of silence welded on -- so the beats stretch with the duration and their relationship to each other
// is fixed. Each fraction is the default cut's second divided by eight.
const BEATS = {
  plate: { start: 0, duration: 0.175 },
  kicker: { start: 0.06875, duration: 0.1375 },
  headline: { start: 0.14375, duration: 0.175 },
  rule: { start: 0.2875, duration: 0.125 },
  support: { start: 0.34375, duration: 0.1625 },
  closing: { start: 0.5375, duration: 0.15, step: 0.03125 },
} as const;

export function WarmOpen({ kicker, headline, supportingLine, brandMark, cta }: WarmOpenProps) {
  const { fps, durationInFrames } = useVideoConfig();
  const frame = useCurrentFrame();

  // The one place seconds are derived. durationInFrames is the authority -- it is what Remotion is
  // actually rendering, whether that came from defaultProps, from calculateMetadata, or from an
  // override passed to selectComposition -- so the beats can never disagree with the real cut.
  const totalSeconds = durationInFrames / fps;
  const at = (beat: { start: number; duration: number }) =>
    windowFromSeconds(beat.start * totalSeconds, beat.duration * totalSeconds, fps);

  const closingWindows = staggeredWindows(
    3,
    {
      startSeconds: BEATS.closing.start * totalSeconds,
      stepSeconds: BEATS.closing.step * totalSeconds,
      durationSeconds: BEATS.closing.duration * totalSeconds,
    },
    fps,
  );

  const ruleWindow = at(BEATS.rule);

  return (
    <VerticalCanvas>
      <MediaFrame window={at(BEATS.plate)} totalDurationInFrames={durationInFrames}>
        <HearthIllustration />
      </MediaFrame>

      {/* The gap under the plate is the largest in the composition on purpose: it is the pause
          before the video says anything, and it is doing as much work as the type below it. */}
      <div style={{ height: 84 }} />

      <Reveal window={at(BEATS.kicker)} riseFrom={16} style={{ width: "100%" }}>
        <TypeBlock role="kicker">{kicker}</TypeBlock>
      </Reveal>

      <div style={{ height: 34 }} />

      <Reveal window={at(BEATS.headline)} riseFrom={28} style={{ width: "100%" }}>
        <TypeBlock role="headline">{headline}</TypeBlock>
      </Reveal>

      {/* The one handmade gesture in the composition: a rule drawn under the headline the way
          someone would underline it, revealed by stroke-dashoffset rather than by width so it reads
          as being DRAWN rather than as a bar growing. The path is deliberately not straight. */}
      <div style={{ height: 26, width: "100%" }} />
      <svg width="100%" height="18" viewBox="0 0 864 18" preserveAspectRatio="none" role="presentation" style={{ overflow: "visible" }}>
        <path
          d="M 4 12 C 168 4, 372 3, 520 8 C 606 11, 668 9, 706 6"
          fill="none"
          stroke={WARM_PALETTE.accent}
          strokeWidth="7"
          strokeLinecap="round"
          // pathLength normalizes the path to 1 unit, so the dash arithmetic below is independent of
          // the path's real length and stays correct if the curve is ever redrawn.
          pathLength={1}
          strokeDasharray={1}
          strokeDashoffset={interpolate(frame, [ruleWindow.from, ruleWindow.from + ruleWindow.durationInFrames], [1, 0], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: Easing.bezier(0.22, 1, 0.36, 1),
          })}
        />
      </svg>

      {/* Null is a real answer -- mirroring ProductionSpecCopy.overlayText, which is nullable for the
          same reason. A package with no supporting line shows the headline alone; it does not get a
          substitute, and the layout closes up around the absence rather than leaving a hole. */}
      {supportingLine === null ? null : (
        <>
          <div style={{ height: 40 }} />
          <Reveal window={at(BEATS.support)} riseFrom={20} style={{ width: "100%" }}>
            <TypeBlock role="support">{supportingLine}</TypeBlock>
          </Reveal>
        </>
      )}

      {/* Pushes the closing group to the bottom of the safe frame. flexGrow rather than a fixed
          spacer, so the group stays pinned whether or not the supporting line is present. */}
      <div style={{ flexGrow: 1, minHeight: 56 }} />

      <Reveal window={closingWindows[0]} riseFrom={14} style={{ width: "100%" }}>
        <TypeBlock role="mark">{brandMark}</TypeBlock>
      </Reveal>

      {/* The hairline between mark and call to action. Its own stagger step, and it grows from the
          left edge rather than fading, which is the only place in the composition where a shape
          changes size. */}
      <div style={{ height: 22, width: "100%" }} />
      <div
        style={{
          height: 2,
          backgroundColor: WARM_PALETTE.ink,
          opacity: 0.16,
          alignSelf: "flex-start",
          width: `${(windowProgress(frame, closingWindows[1]) * 100).toFixed(3)}%`,
        }}
      />
      <div style={{ height: 22, width: "100%" }} />

      <Reveal window={closingWindows[2]} riseFrom={14} style={{ width: "100%" }}>
        <TypeBlock role="support" style={{ color: WARM_PALETTE.accent, fontSize: 32, letterSpacing: "0.01em" }}>
          {cta}
        </TypeBlock>
      </Reveal>
    </VerticalCanvas>
  );
}
