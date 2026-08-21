import { cancelRender, continueRender, delayRender } from "remotion";

import { EMBEDDED_PRODUCTION_FONTS, PRODUCTION_FONT_LICENSE, PRODUCTION_FONT_SOURCE_PACKAGE } from "../lib/production-fonts.ts";

// Production MVP Wave C1 -- typography for the Remotion module, from the SAME faces the static
// renderer already draws with.
//
// src/lib/production-fonts.ts is a generated, dependency-free data module: two Geist Sans faces
// (400 and 700, latin subset) as base64, under OFL-1.1, sourced from the declared @fontsource
// dependency. Wave B embedded them because require.resolve returned a bundler identifier rather than
// a real path inside a Next server chunk. That same property is exactly what this module needs for a
// different reason: a Remotion render runs inside headless Chrome against a webpack bundle, and a
// font fetched over the network would make the render non-deterministic and non-offline. A base64
// data URL is neither fetched nor resolved -- it is already in the bundle.
//
// So the video and the still share one typeface from one source of truth. That is a correctness
// property, not a convenience: a Reel and a feed image produced from the same Creative Package would
// otherwise be free to disagree about what the brand's letterforms are.
//
// WHY NOT @remotion/fonts
//
// Its loadFont() does precisely what the code below does -- FontFace, document.fonts.add, wrapped in
// delayRender/continueRender. It is the right call for the case the official guidance describes: a
// file in public/ referenced by staticFile(). Here the bytes are already a base64 string in our own
// module, so the only thing the package would add is a delayRender label containing ~240 KB of
// base64, which is what Remotion prints when a render times out. Twelve lines of the documented core
// API buys a readable label and one fewer dependency.
export const REMOTION_FONT_FAMILY = "Geist";
export const REMOTION_FONT_LICENSE = PRODUCTION_FONT_LICENSE;
export const REMOTION_FONT_SOURCE_PACKAGE = PRODUCTION_FONT_SOURCE_PACKAGE;

// Module scope, not a hook or an effect.
//
// delayRender() must be registered before Remotion captures the first frame, and Remotion evaluates
// the bundle once before rendering begins -- so a module-level handle is the earliest and only point
// at which the promise is guaranteed to be outstanding for frame 0. A useEffect would fire after the
// first paint, which is exactly when it is too late.
//
// Registered once per bundle evaluation, so the faces are decoded once no matter how many frames or
// compositions are rendered from it.
const fontHandle = delayRender(`Loading ${EMBEDDED_PRODUCTION_FONTS.length} embedded ${REMOTION_FONT_FAMILY} faces (OFL-1.1, no network)`);

Promise.all(
  EMBEDDED_PRODUCTION_FONTS.map(async (face) => {
    // The faces are .woff. The format has to be stated rather than inferred, because a data URL has
    // no extension for anything to infer from.
    const font = new FontFace(REMOTION_FONT_FAMILY, `url(data:font/woff;base64,${face.base64}) format('woff')`, {
      weight: String(face.weight),
      style: "normal",
      // "block" rather than "swap": a render must never capture a frame drawn in a fallback face.
      // There is no user waiting for a paint here, so the usual reason to prefer swap does not apply.
      display: "block",
    });
    await font.load();
    document.fonts.add(font);
  }),
)
  .then(() => {
    continueRender(fontHandle);
  })
  .catch((err: unknown) => {
    // cancelRender, not continueRender: a render that silently proceeded in a fallback face would
    // produce a plausible-looking MP4 with the wrong typography, which is worse than no MP4.
    cancelRender(err);
  });

// The one stack every text element in this module uses. The fallbacks exist for the Remotion Studio
// preview's benefit during the moment before the faces resolve; a RENDER never reaches them, because
// the delayRender above is outstanding until the real faces are added.
export const REMOTION_FONT_STACK = `${REMOTION_FONT_FAMILY}, ui-sans-serif, system-ui, sans-serif`;
