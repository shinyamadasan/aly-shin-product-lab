import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { Resvg } from "@resvg/resvg-js";
import { createElement, type ReactNode } from "react";
import sharp from "sharp";
import satori from "satori";

import type { GeneratedAssetFileCandidate } from "./asset-generation-validation.ts";
import { isProductionSpecV1, type ProductionSpecV1 } from "./production-spec.ts";

const require = createRequire(import.meta.url);

// --- portable, app-owned font set -----------------------------------------------------------------
//
// This deliberately does NOT resolve next/dist/compiled/@vercel/og/Geist-Regular.ttf.
//
// That path is a PRIVATE Next build artefact. Nothing guarantees it survives the next Next release,
// it does not exist in an install that omits Next, and depending on it made this renderer's
// typography a side effect of a framework's internal layout rather than a decision this app owns.
// @fontsource/geist-sans is a declared production dependency, so the faces below resolve from our
// own dependency graph and survive `npm ci --omit=dev --omit=optional`.
//
// Same typeface as the composition the owner accepted (Geist Sans) -- this is a SOURCING change, not
// a redesign.
//
// LICENCE: SIL Open Font License 1.1. Geist Sans (C) 2023 Vercel, made in collaboration with
// basement.studio. Embedding and redistributing the faces in this form is exactly what the OFL
// permits, and the full licence text ships inside the package at @fontsource/geist-sans/LICENSE.
// Upstream source: https://github.com/vercel/geist-font
//
// No proprietary system font is read, bundled or redistributed anywhere in this module.
const FONT_FAMILY = "Geist";

// BOTH weights the compositions actually ask for are registered as REAL faces.
//
// The renderer previously registered a single 400 face and then styled the brand mark at weight 700.
// Satori does not synthesize a bold from a regular -- it falls back to the nearest registered face --
// so the mark silently rendered at 400 and the `fontWeight: 700` in the style object was decorative.
// Registering the real 700 face is what makes the declared weight true.
const FONT_FACES = [
  { weight: 400, path: require.resolve("@fontsource/geist-sans/files/geist-sans-latin-400-normal.woff") },
  { weight: 700, path: require.resolve("@fontsource/geist-sans/files/geist-sans-latin-700-normal.woff") },
] as const;

type ProductionStaticRendererFont = {
  name: string;
  data: ArrayBuffer;
  weight: (typeof FONT_FACES)[number]["weight"];
  style: "normal";
};

export type ProductionStaticRenderOptions = {
  illustration?: {
    bytes: Uint8Array;
    mimeType: "image/png" | "image/jpeg" | "image/webp";
  };
};

let fontsPromise: Promise<ProductionStaticRendererFont[]> | null = null;

async function loadFonts(): Promise<ProductionStaticRendererFont[]> {
  fontsPromise ??= Promise.all(
    FONT_FACES.map(async (face) => {
      const buffer = await readFile(face.path);
      return {
        name: FONT_FAMILY,
        data: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
        weight: face.weight,
        style: "normal" as const,
      };
    }),
  );
  return fontsPromise;
}

// --- dimension-aware geometry ----------------------------------------------------------------------
//
// The composition below was authored against, and accepted by the owner at, a 1080x1080 square. Every
// number in it used to be a hardcoded pixel constant, which meant any other supported dimension
// produced silently invalid geometry: a 1080-wide layout with 1080-relative offsets floating inside a
// 1080x1920 frame, with the illustration band pinned at top=300 regardless of how tall the canvas was.
//
// So the constants are now read as coordinates in this REFERENCE FRAME and projected onto the spec's
// actual dimensions. Three projections, because they answer three different questions:
//
//   sx  horizontal position/size  -> scales with width
//   sy  vertical position/size    -> scales with height
//   su  type size and round shapes -> scales UNIFORMLY (the smaller edge), so glyphs and circles
//       never distort when the frame is not square
//
// For the 1080x1080 case all three are the identity and the accepted composition is reproduced
// exactly, constant for constant. This is deliberately a projection of ONE authored layout, not a
// layout engine: nothing here reflows, rewraps or re-composes.
const REFERENCE_EDGE = 1080;

type Geometry = {
  width: number;
  height: number;
  sx: (value: number) => number;
  sy: (value: number) => number;
  su: (value: number) => number;
};

function geometryFor(dimensions: { width: number; height: number }): Geometry {
  const { width, height } = dimensions;
  const uniform = Math.min(width, height);
  return {
    width,
    height,
    sx: (value) => Math.round((value * width) / REFERENCE_EDGE),
    sy: (value) => Math.round((value * height) / REFERENCE_EDGE),
    su: (value) => Math.round((value * uniform) / REFERENCE_EDGE),
  };
}

function h(type: string, props: Record<string, unknown> | null, ...children: ReactNode[]): ReactNode {
  return createElement(type, props, ...children);
}

function brandMark(g: Geometry): ReactNode {
  return h("div", { style: { color: "#6f4d3d", fontSize: g.su(24), fontWeight: 700 } }, "aly & pon");
}

function doodleHeart(g: Geometry, style: Record<string, unknown> = {}): ReactNode {
  return h("div", { style: { color: "#b77442", fontSize: g.su(38), lineHeight: 1, ...style } }, "♡");
}

function editorialTextComposition(spec: ProductionSpecV1, g: Geometry): ReactNode {
  const background = "#fff8ef";
  const ink = "#2a1812";
  const accent = "#b77442";

  return h(
    "div",
    {
      style: {
        width: `${g.width}px`,
        height: `${g.height}px`,
        display: "flex",
        position: "relative",
        background,
        color: ink,
        fontFamily: FONT_FAMILY,
        padding: `${g.su(82)}px`,
        overflow: "hidden",
      },
    },
    h("div", {
      style: {
        position: "absolute",
        left: g.sx(118),
        top: g.sy(124),
        width: g.sx(190),
        height: g.sy(54),
        borderTop: `${g.su(3)}px solid #d9b894`,
        transform: "rotate(-5deg)",
      },
    }),
    doodleHeart(g, { position: "absolute", right: g.sx(196), top: g.sy(170), transform: "rotate(8deg)" }),
    h(
      "div",
      {
        style: {
          position: "absolute",
          left: g.sx(154),
          top: g.sy(238),
          width: g.sx(760),
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-start",
        },
      },
      h(
        "div",
        {
          style: {
            fontSize: g.su(96),
            lineHeight: 0.98,
            letterSpacing: 0,
            maxWidth: g.sx(720),
          },
        },
        spec.copy.headline,
      ),
      h(
        "div",
        {
          style: {
            marginTop: g.sy(28),
            marginLeft: g.sx(142),
            fontSize: g.su(104),
            lineHeight: 0.96,
            letterSpacing: 0,
            color: accent,
          },
        },
        spec.copy.caption,
      ),
    ),
    h("div", {
      style: {
        position: "absolute",
        left: g.sx(255),
        bottom: g.sy(246),
        width: g.sx(408),
        height: g.su(7),
        borderRadius: g.su(4),
        background: accent,
        transform: "rotate(-2deg)",
      },
    }),
    h("div", {
      style: {
        position: "absolute",
        right: g.sx(172),
        bottom: g.sy(242),
        width: g.su(92),
        height: g.su(92),
        borderRadius: g.su(46),
        border: `${g.su(4)}px solid #8c5634`,
      },
    }),
    h("div", {
      style: {
        position: "absolute",
        right: g.sx(148),
        bottom: g.sy(226),
        width: g.su(58),
        height: g.su(58),
        borderRadius: g.su(10),
        background: "#6a3d27",
        transform: "rotate(7deg)",
      },
    }),
    h("div", {
      style: {
        position: "absolute",
        right: g.sx(128),
        bottom: g.sy(220),
        width: g.su(12),
        height: g.su(12),
        borderRadius: g.su(6),
        background: "#a87448",
      },
    }),
    h("div", { style: { position: "absolute", left: 0, right: 0, bottom: g.sy(70), display: "flex", justifyContent: "center" } }, brandMark(g)),
  );
}

function illustrationComposition(spec: ProductionSpecV1, g: Geometry): ReactNode {
  const ink = "#2a1812";

  return h(
    "div",
    {
      style: {
        width: `${g.width}px`,
        height: `${g.height}px`,
        display: "flex",
        position: "relative",
        color: ink,
        fontFamily: FONT_FAMILY,
        overflow: "hidden",
      },
    },
    h(
      "div",
      {
        style: {
          position: "absolute",
          left: g.sx(70),
          top: g.sy(72),
          width: g.sx(760),
          display: "flex",
          flexDirection: "column",
        },
      },
      h("div", { style: { fontSize: g.su(88), lineHeight: 0.96, letterSpacing: 0 } }, spec.copy.headline),
      h(
        "div",
        {
          style: {
            marginTop: g.sy(18),
            marginLeft: g.sx(18),
            width: g.sx(620),
            color: "#6a4635",
            fontSize: g.su(34),
            lineHeight: 1.14,
          },
        },
        spec.copy.caption,
      ),
      h("div", {
        style: {
          marginTop: g.sy(20),
          marginLeft: g.sx(22),
          width: g.sx(235),
          height: g.su(6),
          borderRadius: g.su(3),
          background: "#b77442",
          transform: "rotate(-2deg)",
        },
      }),
    ),
    doodleHeart(g, { position: "absolute", right: g.sx(142), top: g.sy(150) }),
    h(
      "div",
      {
        style: {
          position: "absolute",
          right: g.sx(80),
          top: g.sy(232),
          display: "flex",
        },
      },
      brandMark(g),
    ),
  );
}

// The band the generated illustration occupies, in the same reference frame as the composition above:
// full width, 780 tall, starting 300 down. Derived rather than hardcoded for exactly the reason the
// composition is -- at 1080x1920 a fixed top=300/height=780 would have left the lower two-fifths of
// the canvas empty and the art detached from the copy above it.
const ILLUSTRATION_BAND = { top: 300, height: 780 } as const;

function composition(spec: ProductionSpecV1, options: ProductionStaticRenderOptions, g: Geometry): ReactNode {
  if (options.illustration) {
    return illustrationComposition(spec, g);
  }

  return editorialTextComposition(spec, g);
}

export async function renderProductionStaticImage(
  spec: ProductionSpecV1,
  options: ProductionStaticRenderOptions = {},
): Promise<GeneratedAssetFileCandidate> {
  if (!isProductionSpecV1(spec) || spec.assetKind !== "image") {
    throw new Error("Static production rendering requires a production-v1 image spec.");
  }

  const g = geometryFor(spec.dimensions);

  const svg = await satori(composition(spec, options, g), {
    width: g.width,
    height: g.height,
    fonts: await loadFonts(),
  });
  let bytes = new Uint8Array(new Resvg(svg, { fitTo: { mode: "width", value: g.width } }).render().asPng());
  if (options.illustration) {
    const background = await sharp({
      create: {
        width: g.width,
        height: g.height,
        channels: 4,
        background: "#fff8ef",
      },
    })
      .png()
      .toBuffer();
    const illustration = await sharp(options.illustration.bytes)
      .resize(g.width, g.sy(ILLUSTRATION_BAND.height), { fit: "cover" })
      .png()
      .toBuffer();
    bytes = new Uint8Array(
      await sharp(background)
        .composite([
          { input: illustration, left: 0, top: g.sy(ILLUSTRATION_BAND.top) },
          { input: Buffer.from(bytes), left: 0, top: 0 },
        ])
        .png()
        .toBuffer(),
    );
  }

  return {
    position: 0,
    mimeType: "image/png",
    width: g.width,
    height: g.height,
    durationMs: null,
    fileSizeBytes: bytes.length,
    bytes,
  };
}

// Declared so the font strategy is inspectable (and testable) rather than only a comment: the
// renderer must never be able to drift back onto a private framework path without this changing too.
export const PRODUCTION_STATIC_RENDERER_FONT = {
  family: FONT_FAMILY,
  package: "@fontsource/geist-sans",
  weights: FONT_FACES.map((face) => face.weight),
  paths: FONT_FACES.map((face) => face.path),
  license: "OFL-1.1",
  source: "Geist Sans (C) 2023 Vercel / basement.studio, redistributed under the SIL Open Font License 1.1 via the @fontsource/geist-sans dependency.",
} as const;
