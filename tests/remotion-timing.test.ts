import test from "node:test";
import assert from "node:assert/strict";

import { framesToSeconds, secondsToFrames, staggeredWindows, windowEnd, windowFromSeconds, windowProgress } from "../src/remotion/timing.ts";

// Production MVP Wave C1 -- the frame arithmetic every beat in every composition is built from.
//
// Tested at the CONTRACT level rather than by snapshotting a rendered tree: these functions decide
// when things happen, and "when" is a number that can be asserted directly. A React-tree snapshot
// would assert the same facts far less legibly and break on every unrelated style change.

const FPS = 30;

test("secondsToFrames rounds to the nearest whole frame and is exact on frame boundaries", () => {
  assert.equal(secondsToFrames(0, FPS), 0);
  assert.equal(secondsToFrames(1, FPS), 30);
  assert.equal(secondsToFrames(8, FPS), 240);
  // 0.55s at 30fps is 16.5 frames. Rounds, and rounds the same way every time -- which is the whole
  // reason the composition expresses beats in seconds and converts here exactly once.
  assert.equal(secondsToFrames(0.55, FPS), 17);
  assert.equal(secondsToFrames(0.5, FPS), 15);
});

test("secondsToFrames is deterministic -- the same input always yields the same frame", () => {
  const inputs = [0, 0.0333, 0.55, 1.4, 2.75, 4.3, 7.9999, 8];
  for (const seconds of inputs) {
    const first = secondsToFrames(seconds, FPS);
    for (let repeat = 0; repeat < 25; repeat += 1) {
      assert.equal(secondsToFrames(seconds, FPS), first, `secondsToFrames(${seconds}) drifted`);
    }
  }
});

test("secondsToFrames throws rather than guessing on a caller error", () => {
  assert.throws(() => secondsToFrames(Number.NaN, FPS), /finite/);
  assert.throws(() => secondsToFrames(Number.POSITIVE_INFINITY, FPS), /finite/);
  assert.throws(() => secondsToFrames(-1, FPS), /negative/);
  assert.throws(() => secondsToFrames(1, 0), /positive, finite fps/);
  assert.throws(() => secondsToFrames(1, -30), /positive, finite fps/);
});

test("framesToSeconds round-trips whole-frame durations exactly", () => {
  for (const frames of [0, 1, 30, 180, 240, 300]) {
    assert.equal(secondsToFrames(framesToSeconds(frames, FPS), FPS), frames);
  }
  assert.throws(() => framesToSeconds(1.5, FPS), /integer frame count/);
  assert.throws(() => framesToSeconds(-1, FPS), /integer frame count/);
});

test("windowFromSeconds produces Remotion-shaped from/durationInFrames", () => {
  assert.deepEqual(windowFromSeconds(1.15, 1.4, FPS), { from: 35, durationInFrames: 42 });
  assert.equal(windowEnd(windowFromSeconds(1.15, 1.4, FPS)), 77);
});

test("windowFromSeconds refuses a window that would occupy no frames", () => {
  assert.throws(() => windowFromSeconds(0, 0, FPS), /longer than zero frames/);
  // 0.01s at 30fps rounds to 0 frames. A beat that lasts no frames is a beat that never renders, and
  // silently accepting it would produce an element that is simply absent from the video.
  assert.throws(() => windowFromSeconds(0, 0.01, FPS), /longer than zero frames/);
});

test("staggeredWindows spaces equal-length windows by one step each", () => {
  const windows = staggeredWindows(3, { startSeconds: 4.3, stepSeconds: 0.25, durationSeconds: 1.2 }, FPS);
  assert.equal(windows.length, 3);
  // 4.30s -> 129, 4.55s -> 136.5 -> 137, 4.80s -> 144. The middle window lands on a half-frame and
  // is rounded, which is exactly why staggeredWindows converts each start through secondsToFrames
  // rather than computing one frame step and adding it repeatedly: repeated addition would compound
  // that half-frame across every later member.
  assert.deepEqual(
    windows.map((entry) => entry.from),
    [129, 137, 144],
  );
  // Equal durations are the contract: a stagger describes arrival rhythm, not length variation.
  assert.deepEqual(
    windows.map((entry) => entry.durationInFrames),
    [36, 36, 36],
  );
});

test("a zero-step stagger is legal and puts every window at the same frame", () => {
  const windows = staggeredWindows(3, { startSeconds: 1, stepSeconds: 0, durationSeconds: 1 }, FPS);
  assert.deepEqual(
    windows.map((entry) => entry.from),
    [30, 30, 30],
  );
});

test("staggeredWindows rejects impossible counts and backwards steps", () => {
  assert.throws(() => staggeredWindows(0, { startSeconds: 0, stepSeconds: 0.1, durationSeconds: 1 }, FPS), /at least 1/);
  assert.throws(() => staggeredWindows(2.5, { startSeconds: 0, stepSeconds: 0.1, durationSeconds: 1 }, FPS), /at least 1/);
  assert.throws(() => staggeredWindows(2, { startSeconds: 0, stepSeconds: -0.1, durationSeconds: 1 }, FPS), /stagger backwards/);
});

test("windowProgress clamps at BOTH ends -- which is what makes a held beat hold", () => {
  const window = windowFromSeconds(1, 1, FPS); // frames 30..60

  assert.equal(windowProgress(0, window), 0);
  assert.equal(windowProgress(30, window), 0);
  assert.equal(windowProgress(45, window), 0.5);
  assert.equal(windowProgress(60, window), 1);
  // Past the end it STAYS at 1 rather than continuing to grow. Nothing in this module exits frame,
  // and this is the arithmetic that guarantees it.
  assert.equal(windowProgress(239, window), 1);
  assert.equal(windowProgress(100000, window), 1);
  // Before the start it stays at 0 rather than going negative.
  assert.equal(windowProgress(-500, window), 0);
});

test("windowProgress is monotonic across a whole composition", () => {
  const window = windowFromSeconds(2, 3, FPS);
  let previous = -1;
  for (let frame = 0; frame <= 240; frame += 1) {
    const progress = windowProgress(frame, window);
    assert.ok(progress >= previous, `progress went backwards at frame ${frame}`);
    assert.ok(progress >= 0 && progress <= 1, `progress left 0..1 at frame ${frame}`);
    previous = progress;
  }
});
