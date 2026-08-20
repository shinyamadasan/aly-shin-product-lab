import { Resvg } from "@resvg/resvg-js";
import { createElement } from "react";
import satori from "satori";

// Production MVP Wave B -- bounded deterministic text fitting for the static composition.
//
// WHY THIS EXISTS. The composition was authored against short copy and hardcoded its type sizes, so
// the first real production run against a live Creative Package ran its text off the bottom of the
// canvas and through the brand mark. Hardcoded sizes only ever worked because the sample copy was
// short.
//
// WHAT IT IS NOT. Not a layout engine. It does not reflow the composition, move elements, choose
// alternative arrangements, or invent styles. It answers exactly one question -- "what is the
// largest size in this explicit range at which this string fits this box?" -- and refuses when the
// answer is none.
//
// MEASURE, DO NOT GUESS. The height comes from actually laying the text out with satori (the same
// engine, the same fonts, the same wrapping the real render uses) and reading the rendered content
// bounds back from resvg. An estimator based on average glyph widths would be wrong for exactly the
// strings that matter -- long words, punctuation runs, capitals.

export type FittableFont = { name: string; data: ArrayBuffer; weight: 400 | 700; style: "normal" };

export type CopyFitBox = {
  text: string;
  // The box the text must fit inside, in final rendered pixels.
  maxWidth: number;
  maxHeight: number;
  // Largest first. Explicit, so the readable range is a stated decision rather than an emergent one.
  candidateSizes: number[];
  lineHeight: number;
  fontWeight?: 400 | 700;
};

export type CopyFitResult =
  | { ok: true; fontSize: number; measuredHeight: number }
  | { ok: false; reason: "copy_does_not_fit"; measuredHeight: number; smallestTriedSize: number };

// Deliberately generous: the probe only needs somewhere for the text to lay out so its true height
// can be read. It is never rendered into the asset.
const PROBE_HEIGHT_MULTIPLIER = 6;

// Lays the text out for real and returns the height it actually occupies.
export async function measureTextBlockHeight(box: Omit<CopyFitBox, "candidateSizes">, fontSize: number, fonts: FittableFont[]): Promise<number> {
  const probeHeight = Math.max(box.maxHeight * PROBE_HEIGHT_MULTIPLIER, fontSize * box.lineHeight * 24);

  const svg = await satori(
    createElement(
      "div",
      {
        style: {
          width: `${box.maxWidth}px`,
          display: "flex",
          fontFamily: fonts[0]?.name ?? "Geist",
          fontSize,
          fontWeight: box.fontWeight ?? 400,
          lineHeight: box.lineHeight,
          color: "#000000",
        },
      },
      box.text,
    ),
    { width: Math.ceil(box.maxWidth), height: Math.ceil(probeHeight), fonts },
  );

  const bbox = new Resvg(svg, { fitTo: { mode: "width", value: Math.ceil(box.maxWidth) } }).innerBBox();
  // No glyphs (empty or whitespace-only text) means no height, not a failure.
  return bbox ? bbox.height : 0;
}

// Largest candidate size whose real laid-out height fits the box.
//
// Returns copy_does_not_fit rather than shrinking past the smallest stated size. That refusal is the
// point: an unreadable 12px wall of text, or a silently truncated public sentence, is worse than an
// honest production failure the owner can answer by choosing a shorter creative treatment.
export async function fitTextBlock(box: CopyFitBox, fonts: FittableFont[]): Promise<CopyFitResult> {
  const sizes = [...box.candidateSizes].sort((a, b) => b - a);
  let smallestMeasured = 0;

  for (const fontSize of sizes) {
    const measuredHeight = await measureTextBlockHeight(box, fontSize, fonts);
    smallestMeasured = measuredHeight;
    if (measuredHeight <= box.maxHeight) {
      return { ok: true, fontSize, measuredHeight };
    }
  }

  return { ok: false, reason: "copy_does_not_fit", measuredHeight: smallestMeasured, smallestTriedSize: sizes[sizes.length - 1] ?? 0 };
}

// Thrown by the renderer when legitimately visual-facing copy cannot be made to fit. Named so a
// caller can tell it apart from a provider or storage failure and surface it to the owner as a
// creative problem rather than a system fault.
export class CopyDoesNotFitError extends Error {
  // Explicit fields rather than constructor parameter properties: this repo runs `node --test`
  // directly on .ts in strip-only mode, which does not support them.
  readonly reason = "copy_does_not_fit";
  readonly field: string;
  readonly smallestTriedSize: number;
  readonly measuredHeight: number;
  readonly availableHeight: number;

  constructor(field: string, smallestTriedSize: number, measuredHeight: number, availableHeight: number) {
    super(
      `copy_does_not_fit: ${field} still needs ${Math.ceil(measuredHeight)}px at the smallest readable size (${Math.round(smallestTriedSize)}px) but only ${Math.floor(availableHeight)}px are available. Choose a shorter creative treatment for this field.`,
    );
    this.name = "CopyDoesNotFitError";
    this.field = field;
    this.smallestTriedSize = smallestTriedSize;
    this.measuredHeight = measuredHeight;
    this.availableHeight = availableHeight;
  }
}
