// Production MVP Wave C1 -- deterministic frame/timing arithmetic for the Remotion module.
//
// PURE, and deliberately free of any `remotion` import. Two reasons, both load-bearing:
//
//   1. It is the only way this module can be unit-tested under `node --test`, which runs in plain
//      Node with no DOM and no Remotion render environment. Every number the compositions animate
//      between is decided here, so those numbers have to be checkable without a browser.
//
//   2. The official Remotion markup guidance is to keep the `interpolate()` call INLINE in the
//      `style` prop. Pulling interpolation in here would fight that. So this module owns WHEN
//      something happens (frames), and the components own WHAT it looks like (opacity, translate,
//      scale) with the interpolate call left where a reader can see it.
//
// DETERMINISM. There is no clock, no randomness and no environment read anywhere below. Every
// function is a total function of its arguments, and `Math.round` is the only rounding used --
// consistently, so two callers asking for the same second never disagree by a frame.

// A slice of the timeline, in the same shape Remotion's own `from` / `durationInFrames` props take,
// so a window can be spread straight onto a component without translation at the call site.
export type TimingWindow = {
  from: number;
  durationInFrames: number;
};

function assertPositiveFps(fps: number): void {
  if (!Number.isFinite(fps) || fps <= 0) {
    throw new Error(`Remotion timing requires a positive, finite fps. Received: ${fps}.`);
  }
}

function assertFiniteSeconds(label: string, seconds: number): void {
  if (!Number.isFinite(seconds)) {
    throw new Error(`Remotion timing requires a finite ${label} in seconds. Received: ${seconds}.`);
  }
}

// Throws rather than guesses on a caller error, matching buildProductionSpec's precedent in
// production-spec.ts: a composition asked to start a beat at NaN seconds is a bug, not a beat that
// should quietly land on frame 0.
export function secondsToFrames(seconds: number, fps: number): number {
  assertPositiveFps(fps);
  assertFiniteSeconds("duration", seconds);
  if (seconds < 0) {
    throw new Error(`Remotion timing cannot convert a negative duration to frames. Received: ${seconds}.`);
  }
  return Math.round(seconds * fps);
}

export function framesToSeconds(frames: number, fps: number): number {
  assertPositiveFps(fps);
  if (!Number.isInteger(frames) || frames < 0) {
    throw new Error(`Remotion timing requires a non-negative integer frame count. Received: ${frames}.`);
  }
  return frames / fps;
}

// The HOLD helper. A window says "appear at this second, and stay for this long" -- it deliberately
// does not describe an exit, because the first composition's creative direction is that nothing
// leaves the frame abruptly. A beat that should run to the end of the video is given the remaining
// time, not an exit animation.
export function windowFromSeconds(startSeconds: number, durationSeconds: number, fps: number): TimingWindow {
  const from = secondsToFrames(startSeconds, fps);
  const durationInFrames = secondsToFrames(durationSeconds, fps);
  if (durationInFrames <= 0) {
    throw new Error(`Remotion timing requires a window longer than zero frames. Received ${durationSeconds}s at ${fps}fps.`);
  }
  return { from, durationInFrames };
}

export function windowEnd(window: TimingWindow): number {
  return window.from + window.durationInFrames;
}

// The STAGGER helper, and the whole of it: n windows of equal length, each one step later than the
// last. That is the only stagger the first composition earns -- its closing group of three elements
// arriving one after another rather than as a block.
//
// Equal durations on purpose. A stagger whose members also varied in length would be two decisions
// wearing one name, and the caller could no longer read the arrival rhythm off the step alone.
export function staggeredWindows(
  count: number,
  spec: { startSeconds: number; stepSeconds: number; durationSeconds: number },
  fps: number,
): TimingWindow[] {
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`Remotion timing requires a stagger count of at least 1. Received: ${count}.`);
  }
  assertFiniteSeconds("stagger step", spec.stepSeconds);
  if (spec.stepSeconds < 0) {
    throw new Error(`Remotion timing cannot stagger backwards. Received a step of ${spec.stepSeconds}s.`);
  }

  return Array.from({ length: count }, (_unused, index) =>
    windowFromSeconds(spec.startSeconds + index * spec.stepSeconds, spec.durationSeconds, fps),
  );
}

// Where a frame sits inside a window, as a 0..1 progress value CLAMPED at both ends.
//
// Clamping is what makes a held beat hold: past the end of its window the value stays at 1 rather
// than continuing to grow, so a component that maps progress to opacity simply stays visible. It is
// the arithmetic counterpart of `extrapolateLeft: "clamp", extrapolateRight: "clamp"`, which every
// inline interpolate() in this module also passes.
export function windowProgress(frame: number, window: TimingWindow): number {
  if (window.durationInFrames <= 0) {
    throw new Error(`Remotion timing cannot compute progress across a window of ${window.durationInFrames} frames.`);
  }
  const elapsed = frame - window.from;
  if (elapsed <= 0) {
    return 0;
  }
  if (elapsed >= window.durationInFrames) {
    return 1;
  }
  return elapsed / window.durationInFrames;
}
