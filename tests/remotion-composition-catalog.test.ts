import test from "node:test";
import assert from "node:assert/strict";

import {
  REMOTION_COMPOSITION_FPS,
  REMOTION_VERTICAL_HEIGHT,
  REMOTION_VERTICAL_WIDTH,
  WARM_OPEN_COMPOSITION_ID,
  WARM_OPEN_DEFAULT_DURATION_SECONDS,
  WARM_OPEN_DEFAULT_PROPS,
  WARM_OPEN_MAX_DURATION_SECONDS,
  WARM_OPEN_MIN_DURATION_SECONDS,
  clampWarmOpenDurationSeconds,
  isWarmOpenDurationInRange,
  warmOpenDurationInFrames,
  warmOpenMetadata,
} from "../src/remotion/composition-catalog.ts";
import { PRODUCTION_SHORT_VIDEO_DIMENSIONS } from "../src/lib/production-spec.ts";
import { secondsToFrames } from "../src/remotion/timing.ts";

// Production MVP Wave C1 -- the composition's own metadata, and the ONE assertion that keeps it
// honest about where its dimensions came from.

test("the Remotion vertical canvas IS the Production Engine's short_video canvas", () => {
  // The catalog re-declares these rather than importing them, so the browser bundle Remotion renders
  // inside does not have to pull in production-spec.ts's whole module graph for two integers. This
  // test is the other half of that decision: the moment the two disagree, it fails.
  assert.equal(REMOTION_VERTICAL_WIDTH, PRODUCTION_SHORT_VIDEO_DIMENSIONS.width);
  assert.equal(REMOTION_VERTICAL_HEIGHT, PRODUCTION_SHORT_VIDEO_DIMENSIONS.height);
  assert.equal(PRODUCTION_SHORT_VIDEO_DIMENSIONS.aspectRatio, "9:16");
  // Vertical, not accidentally square or landscape.
  assert.ok(REMOTION_VERTICAL_HEIGHT > REMOTION_VERTICAL_WIDTH);
});

test("the composition renders at 30fps", () => {
  assert.equal(REMOTION_COMPOSITION_FPS, 30);
});

test("warmOpenDurationInFrames is the one duration computation, and it agrees with secondsToFrames", () => {
  for (const seconds of [6, 6.5, 7, 8, 9.25, 10]) {
    assert.equal(warmOpenDurationInFrames(seconds), secondsToFrames(seconds, REMOTION_COMPOSITION_FPS));
  }
  assert.equal(warmOpenDurationInFrames(8), 240);
  assert.equal(warmOpenDurationInFrames(6), 180);
  assert.equal(warmOpenDurationInFrames(10), 300);
});

test("warmOpenDurationInFrames THROWS outside the composition's range rather than clamping silently", () => {
  assert.throws(() => warmOpenDurationInFrames(5.9), /between 6 and 10 seconds/);
  assert.throws(() => warmOpenDurationInFrames(10.1), /between 6 and 10 seconds/);
  assert.throws(() => warmOpenDurationInFrames(0), /between 6 and 10 seconds/);
  assert.throws(() => warmOpenDurationInFrames(Number.NaN), /between 6 and 10 seconds/);
});

test("clampWarmOpenDurationSeconds is the SEPARATE, visible way to get a renderable duration", () => {
  assert.equal(clampWarmOpenDurationSeconds(3), WARM_OPEN_MIN_DURATION_SECONDS);
  assert.equal(clampWarmOpenDurationSeconds(15), WARM_OPEN_MAX_DURATION_SECONDS);
  // Inside the range it is the identity -- a clamp that moved a valid value would be a bug.
  for (const seconds of [6, 7, 8, 9, 10]) {
    assert.equal(clampWarmOpenDurationSeconds(seconds), seconds);
  }
  assert.throws(() => clampWarmOpenDurationSeconds(Number.NaN), /finite number of seconds/);
});

test("anything the clamp returns is renderable -- the two functions cannot disagree", () => {
  for (const requested of [-100, 0, 3, 5.99, 6, 8, 10, 10.01, 15, 600]) {
    const clamped = clampWarmOpenDurationSeconds(requested);
    assert.ok(isWarmOpenDurationInRange(clamped), `clamp produced an unrenderable ${clamped}s from ${requested}s`);
    assert.doesNotThrow(() => warmOpenDurationInFrames(clamped));
  }
});

test("warmOpenMetadata predicts everything a render will report", () => {
  const metadata = warmOpenMetadata(WARM_OPEN_DEFAULT_DURATION_SECONDS);
  assert.deepEqual(metadata, {
    compositionId: WARM_OPEN_COMPOSITION_ID,
    width: 1080,
    height: 1920,
    fps: 30,
    durationInFrames: 240,
    durationSeconds: 8,
  });
});

test("the default cut sits inside the composition's own range, and is 6-10 seconds", () => {
  assert.ok(isWarmOpenDurationInRange(WARM_OPEN_DEFAULT_DURATION_SECONDS));
  assert.equal(WARM_OPEN_MIN_DURATION_SECONDS, 6);
  assert.equal(WARM_OPEN_MAX_DURATION_SECONDS, 10);
});

test("the default props are a complete, JSON-serializable, renderable input", () => {
  // JSON-serializable is a HARD requirement, not a preference: Remotion passes input props through
  // JSON on the way into the render, so anything that does not survive a round trip silently changes
  // between the caller and the composition.
  const roundTripped = JSON.parse(JSON.stringify(WARM_OPEN_DEFAULT_PROPS));
  assert.deepEqual(roundTripped, WARM_OPEN_DEFAULT_PROPS);

  assert.doesNotThrow(() => warmOpenDurationInFrames(WARM_OPEN_DEFAULT_PROPS.durationSeconds));
  for (const field of ["kicker", "headline", "brandMark", "cta"] as const) {
    assert.equal(typeof WARM_OPEN_DEFAULT_PROPS[field], "string");
    assert.ok(WARM_OPEN_DEFAULT_PROPS[field].length > 0, `${field} must not be empty`);
  }
  // Nullable, and null must remain expressible -- the composition closes up around an absent
  // supporting line rather than substituting anything.
  assert.ok(WARM_OPEN_DEFAULT_PROPS.supportingLine === null || typeof WARM_OPEN_DEFAULT_PROPS.supportingLine === "string");
});
