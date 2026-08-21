import test from "node:test";
import assert from "node:assert/strict";

import { warmOpenPropsFromProductionSpec } from "../src/remotion/production-spec-bridge.ts";
import { isWarmOpenDurationInRange, warmOpenDurationInFrames } from "../src/remotion/composition-catalog.ts";
import { PRODUCTION_SHORT_VIDEO_DIMENSIONS, type ProductionShortVideoSpecV1 } from "../src/lib/production-spec.ts";

// Production MVP Wave C1 -- the seam C2 wires into, tested now so C2 is wiring rather than design.
//
// Nothing here executes a job, touches Supabase, or makes short_video producible. It asserts one
// thing: that a ProductionSpecV1 can become renderable composition props, purely and repeatably.

function shortVideoSpec(overrides: Partial<ProductionShortVideoSpecV1> = {}): ProductionShortVideoSpecV1 {
  return {
    schemaVersion: "production-v1",
    assetKind: "short_video",
    sourceCreativePackageId: "pkg-1",
    dimensions: PRODUCTION_SHORT_VIDEO_DIMENSIONS,
    copy: {
      headline: "Sourdough, out at seven.",
      caption: "A 231-character social caption that belongs UNDER the post and never on the picture.",
      cta: "Order the morning batch",
      overlayText: null,
    },
    brandStyle: null,
    visualBrief: null,
    scenes: [
      { direction: "Slow push on the cooling rack", text: "Baked this morning", approxSeconds: 3 },
      { direction: "Hands tearing the crust", text: "Slow-proofed overnight", approxSeconds: 3 },
    ],
    targetDurationSeconds: 8,
    ...overrides,
  };
}

test("a short_video spec becomes renderable warm-open props", () => {
  const { props, clampedFrom, warnings } = warmOpenPropsFromProductionSpec(shortVideoSpec(), { brandMark: "Aly & Pon" });

  assert.equal(props.headline, "Sourdough, out at seven.");
  assert.equal(props.kicker, "Baked this morning");
  assert.equal(props.supportingLine, "Slow-proofed overnight");
  assert.equal(props.cta, "Order the morning batch");
  assert.equal(props.brandMark, "Aly & Pon");
  assert.equal(props.durationSeconds, 8);
  assert.equal(clampedFrom, null);
  assert.deepEqual(warnings, []);
  assert.equal(warmOpenDurationInFrames(props.durationSeconds), 240);
});

test("the SOCIAL CAPTION is never drawn on the video", () => {
  // production-spec.ts is explicit that caption is post copy and is never drawn on the visual. Wave B
  // learned that the hard way when a 231-character caption ran off a still. The same rule holds for a
  // frame of video, and this is the assertion that holds it.
  const spec = shortVideoSpec();
  const { props } = warmOpenPropsFromProductionSpec(spec, { brandMark: "Aly & Pon" });
  for (const value of Object.values(props)) {
    if (typeof value === "string") {
      assert.notEqual(value, spec.copy.caption);
      assert.ok(!value.includes("231-character"), `the social caption leaked into props: ${value}`);
    }
  }
});

test("the bridge is PURE -- the same spec always produces the same props", () => {
  const spec = shortVideoSpec();
  const first = warmOpenPropsFromProductionSpec(spec, { brandMark: "Aly & Pon" });
  for (let repeat = 0; repeat < 20; repeat += 1) {
    assert.deepEqual(warmOpenPropsFromProductionSpec(spec, { brandMark: "Aly & Pon" }), first);
  }
});

test("an out-of-range package duration is clamped AND reported, never silently shortened", () => {
  const { props, clampedFrom, warnings } = warmOpenPropsFromProductionSpec(shortVideoSpec({ targetDurationSeconds: 15 }), {
    brandMark: "Aly & Pon",
  });

  assert.equal(props.durationSeconds, 10);
  assert.equal(clampedFrom, 15);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /duration-clamped/);
  assert.match(warnings[0], /15s/);
  assert.ok(isWarmOpenDurationInRange(props.durationSeconds));
});

test("a short package is clamped upward and reported too", () => {
  const { props, clampedFrom } = warmOpenPropsFromProductionSpec(shortVideoSpec({ targetDurationSeconds: 3 }), { brandMark: "Aly & Pon" });
  assert.equal(props.durationSeconds, 6);
  assert.equal(clampedFrom, 3);
});

test("shots the composition cannot show are REPORTED rather than dropped in silence", () => {
  const spec = shortVideoSpec({
    scenes: [
      { direction: "a", text: "One", approxSeconds: 2 },
      { direction: "b", text: "Two", approxSeconds: 2 },
      { direction: "c", text: "Three", approxSeconds: 2 },
      { direction: "d", text: "Four", approxSeconds: 2 },
    ],
  });
  const { warnings } = warmOpenPropsFromProductionSpec(spec, { brandMark: "Aly & Pon" });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /scenes-unused/);
  assert.match(warnings[0], /4 shots/);
});

test("a shot with no on-screen text falls back to the package's OWN cta, never to an invented phrase", () => {
  const spec = shortVideoSpec({ scenes: [{ direction: "Silent opener", text: null, approxSeconds: 4 }] });
  const { props } = warmOpenPropsFromProductionSpec(spec, { brandMark: "Aly & Pon" });
  assert.equal(props.kicker, spec.copy.cta);
});

test("absence stays absence -- no second shot means no supporting line", () => {
  const oneScene = warmOpenPropsFromProductionSpec(shortVideoSpec({ scenes: [{ direction: "Only shot", text: "Baked today", approxSeconds: 8 }] }), {
    brandMark: "Aly & Pon",
  });
  assert.equal(oneScene.props.supportingLine, null);

  // Whitespace-only on-screen text is absence too, not a line made of spaces.
  const blankSecond = warmOpenPropsFromProductionSpec(
    shortVideoSpec({
      scenes: [
        { direction: "a", text: "Baked today", approxSeconds: 4 },
        { direction: "b", text: "   ", approxSeconds: 4 },
      ],
    }),
    { brandMark: "Aly & Pon" },
  );
  assert.equal(blankSecond.props.supportingLine, null);
});

test("an empty shot list is survivable rather than a crash", () => {
  const { props } = warmOpenPropsFromProductionSpec(shortVideoSpec({ scenes: [] }), { brandMark: "Aly & Pon" });
  assert.equal(props.kicker, "Order the morning batch");
  assert.equal(props.supportingLine, null);
});

test("an image spec is refused -- warm-open is a short_video composition", () => {
  const imageSpec = { ...shortVideoSpec(), assetKind: "image" } as unknown as ProductionShortVideoSpecV1;
  assert.throws(() => warmOpenPropsFromProductionSpec(imageSpec, { brandMark: "Aly & Pon" }), /require a short_video/);
});

test("every bridged prop set is JSON-serializable, because Remotion transports input props as JSON", () => {
  for (const targetDurationSeconds of [3, 6, 8, 10, 15]) {
    const { props } = warmOpenPropsFromProductionSpec(shortVideoSpec({ targetDurationSeconds }), { brandMark: "Aly & Pon" });
    assert.deepEqual(JSON.parse(JSON.stringify(props)), props);
  }
});
