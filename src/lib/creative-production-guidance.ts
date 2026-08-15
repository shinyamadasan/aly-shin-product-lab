// Content Creation MVP S6 -- the production-guidance vocabulary, in a leaf module that imports
// nothing, for the same reason creative-formats.ts is one: the model-facing contract
// (creative-generation/contracts.ts), the stored package validator (creative-package-content-v2.ts)
// and the renderer all need this vocabulary, and creative-package-content-v2.ts is deliberately a
// leaf that imports only the leaves it validates against.
//
// S5 exposed the limitation this module answers: the execution-first UI can only show what the
// package contains, and a package that says "close on the tray" without saying how long, how close,
// or whether the camera moves still leaves the owner translating a creative brief into filmmaking
// decisions. These are the smallest structured fields that remove that translation step.

// Four values, deliberately. This is practical food-content guidance for someone holding a phone,
// not a cinematography taxonomy: detail, macro, eye_level, low_angle and high_angle would all be
// distinctions the owner does not need to make and the generator would have to guess at.
export const CREATIVE_FRAMINGS = ["close_up", "medium", "wide", "overhead"] as const;
export type CreativeFraming = (typeof CREATIVE_FRAMINGS)[number];

// Reel only, and null most of the time. There is deliberately no "static" member: "no movement
// instruction is needed" is an absence, and giving it a name would invite the generator to author
// it on every shot, which is exactly the mechanical over-direction this field must not produce.
export const CREATIVE_MOVEMENTS = ["push_in", "pull_back", "pan"] as const;
export type CreativeMovement = (typeof CREATIVE_MOVEMENTS)[number];

// An executability bound, NOT a platform limit. Instagram, TikTok and Facebook each cap total video
// length and each changes that cap; those rules belong to publishing validation, not to the package
// contract. This bound says something narrower and more durable: a single phone shot shorter than a
// second is not a shot a person can take on purpose, and one longer than ten is really several.
export const CREATIVE_SHOT_SECONDS_MIN = 1;
export const CREATIVE_SHOT_SECONDS_MAX = 10;

// Content Creation MVP H1-B -- HOW the visual gets made, which is a different question from what
// format it is. S6 assumed the answer was always "point a phone at something real"; an owner who
// says "I don't have time to take photos or videos" is telling us that assumption is wrong.
//
//   capture_new     -- fresh real-world photography or filming. Everything S6 says about framing,
//                      current executability and solo operation applies.
//   generate_visual -- a stylized or conceptual visual (illustration, mini comic, doodle, character)
//                      described well enough to hand to Canva, an illustrator, or a future image
//                      generator. No image engine exists yet, so the package describes the concept
//                      and never claims one was produced.
//   template_only   -- typography, layout and simple graphical elements: text cards, comparisons,
//                      meme-like compositions. No capture and no image engine required either.
//
// There is deliberately NO reuse_existing member. Asset Memory does not exist, so the application
// cannot truthfully resolve an asset the owner already has, and an enum value it cannot honour would
// only license the generator to claim a file was selected.
export const CREATIVE_PRODUCTION_SOURCES = ["capture_new", "generate_visual", "template_only"] as const;
export type CreativeProductionSource = (typeof CREATIVE_PRODUCTION_SOURCES)[number];

export function isCreativeFraming(value: unknown): value is CreativeFraming {
  return typeof value === "string" && (CREATIVE_FRAMINGS as readonly string[]).includes(value);
}

export function isCreativeMovement(value: unknown): value is CreativeMovement {
  return typeof value === "string" && (CREATIVE_MOVEMENTS as readonly string[]).includes(value);
}

export function isCreativeProductionSource(value: unknown): value is CreativeProductionSource {
  return typeof value === "string" && (CREATIVE_PRODUCTION_SOURCES as readonly string[]).includes(value);
}

// Framing describes how to point a camera. There is no camera in a generated illustration or a
// typography card, so the field is not merely unnecessary there -- it is meaningless, and filling it
// in to satisfy a schema would be inventing a decision nobody made. One function, used by the
// generation contract, the stored validator and the renderer alike, so the three cannot disagree.
export function productionSourceRequiresFraming(productionSource: CreativeProductionSource): boolean {
  return productionSource === "capture_new";
}

// Integer on purpose. "About 2.5 seconds" is not guidance a person can act on while holding a phone,
// and a float here would only ever come from a model averaging something.
export function isCreativeShotSeconds(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= CREATIVE_SHOT_SECONDS_MIN && value <= CREATIVE_SHOT_SECONDS_MAX;
}
