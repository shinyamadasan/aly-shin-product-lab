import { Easing, interpolate } from "remotion";

import type { ReelScenePlan } from "../../lib/content-studio/creative-plan.ts";

// Content Studio Fast Mode -- when each reel layer arrives, as data.
//
// PURE (no React, no DOM), so the composition and `node --test` read the same numbers. The
// composition draws every photo or clip through photoLayerStyle() below, so the coverage test is a
// test of what is actually rendered, not of a parallel model.
//
// THE RULE THIS FILE EXISTS FOR: on every frame -- and in particular the first frame of every scene --
// at least one photo or clip is fully visible. Every cut is a hard cut from one picture to another,
// never to an empty background. The dual-renderer proof's first render broke it: both collage tiles
// faded in from opacity 0, so the cut out of the hero landed on bare cream for about half a second.

const EASE = Easing.bezier(0.22, 1, 0.36, 1);
const ARRIVAL_FRAMES = 16;

export type LayerArrival = {
  // Local frame (from the scene's start) at which the arrival begins.
  start: number;
  // 1 = present on the cut, only settling into place; 0 = fades up from nothing.
  fromOpacity: number;
  // Pixels the layer rises while it settles.
  rise: number;
};

const ON_CUT: LayerArrival = { start: 0, fromOpacity: 1, rise: 0 };

export const SCENE_PHOTO_LAYERS = {
  hero: { photo: ON_CUT },
  // The detail tile is there on the cut and settles up 40px; the context tile follows 10 frames later
  // as a fade-and-rise over an already covered frame.
  collage: {
    detail: { start: 0, fromOpacity: 1, rise: 40 },
    context: { start: 10, fromOpacity: 0, rise: 40 },
  },
  offer: { photo: ON_CUT },
  end_card: { photo: ON_CUT },
} as const satisfies Record<ReelScenePlan["kind"], Record<string, LayerArrival>>;

export function progress(frame: number, start: number, length: number = ARRIVAL_FRAMES): number {
  return interpolate(frame, [start, start + length], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: EASE });
}

// Fade up while rising a little. How text arrives.
export function arrive(frame: number, start: number, rise = 32): { opacity: number; transform: string } {
  const p = progress(frame, start);
  return { opacity: p, transform: `translateY(${(1 - p) * rise}px)` };
}

export function photoLayerOpacity(layer: LayerArrival, frame: number): number {
  return layer.fromOpacity + (1 - layer.fromOpacity) * progress(frame, layer.start);
}

export function photoLayerStyle(layer: LayerArrival, frame: number): { opacity: number; transform: string } {
  const p = progress(frame, layer.start);
  return { opacity: photoLayerOpacity(layer, frame), transform: `translateY(${(1 - p) * layer.rise}px)` };
}

// The most visible picture in a scene at a local frame. 0 means the frame shows only background.
export function scenePhotoCoverage(kind: ReelScenePlan["kind"], localFrame: number): number {
  const layers: Record<string, LayerArrival> = SCENE_PHOTO_LAYERS[kind];
  return Math.max(...Object.values(layers).map((layer) => photoLayerOpacity(layer, localFrame)));
}
