import type { ProductionSpecV1 } from "./production-spec.ts";

// Production MVP Wave B -- THE canonical image-generation prompt, and the only place it is built.
//
// WHY THIS IS ITS OWN MODULE RATHER THAN STAYING IN production-asset-executors.ts
//
// The prompt now has TWO consumers with opposite runtime requirements:
//
//   the Cloudflare executor  -- server only, POSTs this string to Workers AI
//   the manual prompt package -- rendered IN THE BROWSER for the owner to copy into ChatGPT Images
//
// production-asset-executors.ts reaches node:fs/promises and (through the static renderer) satori,
// resvg and sharp. None of those may ever be reachable from a browser bundle, so a client component
// cannot import the prompt from there. The alternative -- a second manual prompt implementation on
// the client -- is precisely the drift this module exists to make impossible: the moment the two
// differ, a manually produced week stops looking like an automated one, and nobody finds out until
// the images are already posted.
//
// So the prompt moved to where both callers can reach it: pure, no I/O, no clock, no randomness, no
// native module. production-asset-executors.ts re-exports it, so every existing importer is
// unaffected.
//
// The string this produces is UNCHANGED from the reviewed Wave B prompt, byte for byte. The two
// constants below are an extraction of lines that were already there, in the same order, for the
// sole reason that the prompt package needs to show the negative constraints as their own section --
// see tests/production-prompt-package.test.ts, which pins both the byte-identity and the reuse.

// The positive half: what the illustration SHOULD be.
export const GENERATIVE_IMAGE_STYLE_DIRECTIVES: readonly string[] = [
  "Create a text-free expressive illustration for a square social post.",
  "Warm hand-drawn editorial bakery style, simple human characters are allowed, cream background, charming minimal composition.",
];

// The anti-slop half: what it must NOT be. Extracted because the prompt package renders these as an
// owner-facing "do not ask for this" list, and a second hand-written copy of them in the package
// renderer would be free to drift away from what the provider is actually told.
export const GENERATIVE_IMAGE_NEGATIVE_CONSTRAINTS: readonly string[] = [
  "Do not generate readable text, logos, captions, signatures, UI, labels, or branding.",
  "Use reference input only for broad visual language: warmth, palette, simplified linework, texture, density. Do not copy exact artwork, characters, pose, joke, text, or composition.",
  "The imagery must stay visibly illustrated or doodled, not photoreal product documentation.",
  "Desserts must read as ordinary bakery food: neat brownies, blondies, pastry slices, or clean crumb texture.",
  "Avoid flesh-like texture, skin-like tearing, grotesque food, ambiguous goo, slop, malformed pastry anatomy, severe fusion, body-horror, mutilation, or peeling layers.",
];

// --- the final text-ownership override ------------------------------------------------------------
//
// WHY THIS EXISTS, AND WHY IT MUST BE LAST.
//
// The five constraints above are STATIC and appear near the top of the prompt. Everything after them
// is DYNAMIC: concept, style, scene and executionNotes come out of a stored CreativeVisualBrief that
// this module does not control and must not rewrite.
//
// Real packages contain briefs that contradict the static rules. Creative Package
// eecc4f85-cf4f-490a-a9b5-53b692328572 asks, in its own scene text, for "a rounded speech bubble
// carrying the first line of the overlay text" and for a "hand-lettered or soft rounded typeface for
// the bubbles". Read in order, that brief is the LAST thing the model is told, and it asks the image
// generator to render readable words -- directly reversing the ownership split the app depends on.
// This is not hypothetical and it is not confined to the manual path: the same bytes already go to
// Cloudflare today.
//
// So the boundary is hardened by PRECEDENCE, not by editing anyone's brief. The stored package is
// untouched, CreativePackageContentV2 and ProductionSpecV1 are unchanged, no AI call is added, and
// nothing tries to parse or sanitize natural language -- an unwinnable game against freeform prose.
// Instead the last instruction the model reads is always this one, and it names the earlier material
// explicitly so a contradiction resolves in a known direction rather than by position.
//
// Layout intent is deliberately PRESERVED rather than discarded: a brief that reserves space for a
// speech bubble still gets a composition with that space in it -- empty, and therefore exactly where
// the app's own text can land.
export const GENERATIVE_IMAGE_TEXT_OWNERSHIP_OVERRIDE: readonly string[] = [
  "FINAL TEXT-OWNERSHIP OVERRIDE:",
  "Ignore any earlier brief instruction asking the image generator to render readable text, words, letters, speech-bubble contents, captions, labels, signage, typography, fonts/typefaces, logos, or branding.",
  "Preserve only the visual/layout intent of those instructions.",
  "If the brief calls for an area that will contain text, leave that area blank or visually suitable for app-rendered text.",
  "Do not render glyphs or pseudo-text.",
  "The app adds all readable copy after illustration generation.",
];

// NOTE what falls back to spec.copy.caption and what does not.
//
// `scene` falls back to the social caption ONLY when the package carries no visualBrief at all --
// that is the pre-P1 package case, where the caption is the only description of the creative that
// exists. It is a fallback for the IMAGE GENERATOR's scene description, and it is emphatically not
// image body copy: the prompt's first line already forbids drawing any text, and the caption is
// never handed to the compositor (see production-static-renderer.ts, which draws headline and
// overlayText only). The prompt package states that ownership split explicitly for the same reason.
export function buildGenerativeImagePrompt(spec: ProductionSpecV1): string {
  const brief = spec.visualBrief;
  const scene = brief?.scene.join(" ") ?? spec.copy.caption;
  const notes = brief?.executionNotes.join(" ") ?? "";

  return [
    ...GENERATIVE_IMAGE_STYLE_DIRECTIVES,
    ...GENERATIVE_IMAGE_NEGATIVE_CONSTRAINTS,
    `Concept: ${brief?.concept ?? spec.copy.headline}`,
    `Style: ${brief?.style ?? "warm editorial bakery illustration"}`,
    `Scene: ${scene}`,
    notes ? `Constraints: ${notes}` : "",
    // LAST, unconditionally, and after every line derived from the brief. The filter(Boolean) above
    // can drop an absent Constraints line but can never drop these -- they are non-empty literals --
    // so no combination of package content can leave a brief instruction as the final word.
    ...GENERATIVE_IMAGE_TEXT_OWNERSHIP_OVERRIDE,
  ]
    .filter(Boolean)
    .join("\n");
}
