import type { SupportedGeneratedAssetMimeType } from "./asset-binary.ts";
import type { AssetJobExecutor } from "./asset-jobs.ts";
import { buildAssetUploadCandidate } from "./asset-upload-intake.ts";
import { isProductionSpecV1 } from "./production-spec.ts";
import { renderProductionStaticImage } from "./production-static-renderer.ts";

// Production MVP Wave B -- the MANUAL half of the generative image path.
//
// WHAT MAKES THIS A FIRST-CLASS FALLBACK RATHER THAN AN UPLOAD BOX
//
// buildExternalAssetExecutor materializes the uploaded bytes AS the finished asset -- correct for
// capture_new, where the owner photographed the actual product and the picture IS the post. It is
// wrong for a generate_visual package: there the illustration is one INPUT to a composition this app
// owns, and the automated path proves it, because buildCloudflareGenerativeImageExecutor does not
// materialize what Cloudflare returns either. It hands it to renderProductionStaticImage and stores
// the composite.
//
// So this executor makes exactly one call, and it is deliberately the SAME call, with the same
// argument shape, that the Cloudflare executor makes on its last line:
//
//     renderProductionStaticImage(productionSpec, { illustration })
//
// That identity is the whole design. Given the same spec and the same illustration bytes, the two
// paths cannot produce different pixels, because after this line there is only one code path.
// tests/production-manual-composition.test.ts asserts the resulting PNGs are byte-identical, so the
// guarantee is checked rather than merely intended.
//
// The owner therefore never has to reproduce the headline, the overlay text, the typeface, the brand
// mark or the framing in ChatGPT. They supply an illustration; the app supplies the design.

export type ManualIllustration = {
  bytes: Uint8Array;
  mimeType: SupportedGeneratedAssetMimeType;
};

export type ManualIllustrationIntakeResult = { ok: true; illustration: ManualIllustration } | { ok: false; message: string };

// Validate BEFORE the job is ever claimed, exactly as the External Creative Workspace upload does:
// an unreadable or oversized file must fail locally with the job still queued, not burn the single
// attempt this schema allows. Defers entirely to the canonical intake boundary -- this function adds
// no size rule, no MIME rule and no decoder of its own.
export async function buildManualIllustration(bytes: Uint8Array): Promise<ManualIllustrationIntakeResult> {
  const intake = await buildAssetUploadCandidate(bytes);
  if (!intake.ok) {
    return { ok: false, message: intake.message };
  }

  // A real narrowing, not a cast. GENERATED_ASSET_ALLOWED_MIME_TYPES already restricts the intake
  // candidate to these three, so this branch is unreachable in practice -- but the compositor's
  // option type is the narrow union and earning it honestly is cheaper than asserting it.
  const { mimeType } = intake.candidate;
  if (mimeType !== "image/png" && mimeType !== "image/jpeg" && mimeType !== "image/webp") {
    return { ok: false, message: "That illustration is not a PNG, JPEG or WebP image." };
  }

  return { ok: true, illustration: { bytes: intake.candidate.bytes, mimeType } };
}

export function buildManualIllustrationExecutor(illustration: ManualIllustration): AssetJobExecutor {
  return async (_job, spec) => {
    // The spec is the one the RUNNER resolved from the job's own Creative Package -- never anything a
    // browser supplied. That is what stops a client from composing arbitrary copy onto an image, and
    // it is why manual_illustration had to be a worker type that resolves ProductionSpecV1 (see the
    // note on ASSET_JOB_WORKER_TYPES).
    if (!isProductionSpecV1(spec) || spec.assetKind !== "image") {
      throw new Error("Manual illustration composition requires a production-v1 image spec.");
    }
    return [await renderProductionStaticImage(spec, { illustration })];
  };
}
