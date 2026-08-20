import { GENERATIVE_IMAGE_NEGATIVE_CONSTRAINTS, buildGenerativeImagePrompt } from "./production-image-prompt.ts";
import { isProductionSpecV1, type ProductionImageSpecV1, type ProductionSpecV1 } from "./production-spec.ts";

// Production MVP Wave B -- the owner-facing document for the MANUAL image path, and the exact
// counterpart of renderAssetGenerationBrief one contract up.
//
// WHAT THIS IS FOR
//
// T1 is Cloudflare Workers AI. When Cloudflare is out of quota, unauthenticated or simply down, the
// owner still holds a subscription that can make an illustration -- ChatGPT Images -- and this is the
// document that lets them use it without losing anything the automated path would have given them.
//
// THE ONE RULE THIS DOCUMENT EXISTS TO ENFORCE
//
// The manual path outsources the ILLUSTRATION and nothing else. Headline, overlay text, typography,
// branding, framing and dimensions stay owned by this app and are drawn by
// production-static-renderer.ts after the illustration comes back -- exactly as they are for a
// Cloudflare generation. So the document is explicit, in its own section, about which of the three
// parties owns which artefact, because the failure mode it prevents is real and expensive: an owner
// who pastes the social caption into the image generator gets a picture with words baked into it,
// which the compositor then draws its own headline on top of.
//
// PURITY
//
// No I/O, no clock, no randomness, no AI, no native module -- the same discipline as
// renderAssetGenerationBrief and buildProductionSpec. It is rendered IN THE BROWSER, so it must stay
// importable from a client component; that is also why the prompt itself comes from the pure
// production-image-prompt.ts rather than from the executor module.
//
// COMPOSABILITY (deliberate, and the only concession to work that is NOT in this slice)
//
// This renders exactly ONE package and knows nothing about weeks, batches, ordering or scheduling.
// A later renderProductionWeekPack(specs[]) is then a concatenation of these same sections in the
// caller's chosen order -- there is no second "week format" to keep in step with this one, and
// nothing here has to change to enable it.

// Deliberately DERIVED, not authored: the checklist is what the prompt and the compositor already
// promise, restated as things the owner can actually look at. Anything here that is not checkable by
// eye against the returned illustration would be decoration.
function acceptanceChecklist(spec: ProductionImageSpecV1): string[] {
  const shortEdge = Math.min(spec.dimensions.width, spec.dimensions.height);
  return [
    `square, at least ${shortEdge}x${shortEdge} -- anything smaller gets upscaled and will look soft`,
    "no readable text, letters, numbers, logos, watermarks or signatures anywhere in the illustration",
    "the food reads as ordinary bakery food -- no goo, fusion, flesh texture or malformed pastry",
    "it is visibly illustrated or doodled, not photoreal product photography",
    "the palette sits in warm cream and brown, not neon and not cold",
    "the middle of the frame stays calm enough for this app to draw the headline over it",
  ];
}

// The band the compositor drops the illustration into is derived from the spec's own dimensions
// (see ILLUSTRATION_BAND in production-static-renderer.ts), so the guidance quotes the frame the
// owner will actually get rather than a hardcoded 1080.
function compositionNotes(spec: ProductionImageSpecV1): string[] {
  const notes = [
    `Final post is ${spec.dimensions.width}x${spec.dimensions.height} (${spec.dimensions.aspectRatio}). Ask for a square image.`,
    "Keep the subject centred with room around it. This app draws the headline across the upper area and the brand mark to the upper right, so leave those regions uncluttered.",
  ];
  // executionNotes are the package's OWN practical constraints. Passed through verbatim rather than
  // paraphrased -- they are already inside the prompt, and this is where a human reads them.
  for (const note of spec.visualBrief?.executionNotes ?? []) {
    notes.push(note);
  }
  return notes;
}

function section(title: string, body: string[]): string[] {
  return [title, ...body.map((line) => `  ${line}`), ""];
}

function bullets(lines: readonly string[]): string[] {
  return lines.map((line) => `- ${line}`);
}

// The exact document the owner copies from. Deterministic: the same spec always renders the same
// bytes, which is what makes it testable as text and what lets a week pack be a concatenation.
export function renderProductionPromptPackage(spec: ProductionImageSpecV1): string {
  // Mirrors renderProductionStaticImage's own guard. short_video has no executor, no storage path
  // and no manual fallback -- refusing here keeps the Reel formats blocked on every path equally,
  // rather than quietly handing an owner a document for something the system cannot finish.
  if (!isProductionSpecV1(spec) || spec.assetKind !== "image") {
    throw new Error("A manual prompt package requires a production-v1 image spec.");
  }

  const brief = spec.visualBrief;

  const lines: string[] = [
    `# Manual image package -- Creative Package ${spec.sourceCreativePackageId}`,
    "",
    // The ownership split, first and unmissable. Everything below is an elaboration of these three
    // lines, and the whole first-class-manual-fallback design rests on the owner reading them.
    "WHO MAKES WHAT",
    "  IMAGE GENERATOR   a text-free illustration, and nothing else",
    "  THIS APP          headline, overlay text, typography, branding, framing, final PNG",
    "  SOCIAL PLATFORM   the caption, pasted under the post when you publish",
    "",
  ];

  lines.push(...section("CONCEPT", [brief?.concept ?? spec.copy.headline]));
  lines.push(
    ...section("VISUAL DIRECTION", [
      `Style: ${brief?.style ?? "warm editorial bakery illustration"}`,
      ...(brief?.scene.length ? [`Scene: ${brief.scene.join(" ")}`] : []),
    ]),
  );

  lines.push(
    "-- COPY EVERYTHING BETWEEN THE MARKERS INTO CHATGPT IMAGES ----------------",
    "",
    // VERBATIM, from the same function the Cloudflare executor calls. Never re-assembled here.
    buildGenerativeImagePrompt(spec),
    "",
    "-- END OF PROMPT ---------------------------------------------------------",
    "",
  );

  lines.push(
    ...section("DO NOT ASK THE IMAGE GENERATOR FOR", [
      ...bullets(GENERATIVE_IMAGE_NEGATIVE_CONSTRAINTS),
      "- the overlay text or the caption below -- this app draws the first, and you post the second",
    ]),
  );

  lines.push(
    ...section("OVERLAY TEXT -- drawn by this app, do NOT put it in the image", [
      spec.copy.overlayText ?? "(none -- this post shows the headline alone)",
    ]),
  );

  // Named as post copy in its own heading, kept away from every generator-facing section above, and
  // never handed to the compositor. This is the field the first real production run drew into the
  // picture by mistake, which is why it is labelled this emphatically.
  lines.push(...section("CAPTION -- goes under the post, never inside the picture", [spec.copy.caption]));
  lines.push(...section("CALL TO ACTION -- part of the caption, not the image", [spec.copy.cta]));
  lines.push(...section("COMPOSITION", bullets(compositionNotes(spec))));
  lines.push(...section("BEFORE YOU UPLOAD, CHECK", acceptanceChecklist(spec).map((entry) => `[ ] ${entry}`)));

  lines.push(
    "NEXT",
    "  Save the illustration as PNG, JPEG or WebP, then upload it under this package.",
    '  Leave the source kind on "AI-generated" -- a model made it, just not this app.',
    "  This app then draws the headline, overlay text and branding onto it and stores the final post.",
  );

  return lines.join("\n");
}

// Convenience for callers holding the wider union (the UI resolves a ProductionSpecV1 before it
// knows the kind). Returns null for short_video rather than throwing, so a component can simply not
// offer the manual path instead of handling an exception.
export function renderProductionPromptPackageIfImage(spec: ProductionSpecV1): string | null {
  return spec.assetKind === "image" ? renderProductionPromptPackage(spec) : null;
}
