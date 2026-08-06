import { sha256Hex } from "./asset-digest.ts";
import type { AssetGenerationSpecV1 } from "./asset-generation-spec.ts";

// The one canonical rendering of a brief -- shared by CLI export, the browser UI, and briefSha256
// below, so all three ever produce or hash the same text for the same spec. Pure: no I/O, no
// randomness, no clock. Immutable in effect, not by caching: buildAssetGenerationSpec's own inputs
// (a Creative Package's content, read once; the job's own assetKind; the static BRAND_BIBLE
// constant) never change once an Asset Job exists, so calling this twice for the same job -- once
// when the brief is first shown, again later at completion -- is guaranteed to produce byte-identical
// text. See tests/creative-packages.test.ts's "never updated in place" test for the guarantee this
// rests on, and PROP-027's own instruction: a materially different brief requires a new Asset Job,
// never a mutated one.
export function renderAssetGenerationBrief(spec: AssetGenerationSpecV1): string {
  const lines = [
    `Create one marketing image, exactly ${spec.dimensions.width}x${spec.dimensions.height} pixels (${spec.dimensions.aspectRatio}).`,
    "",
    `Headline: ${spec.copy.headline}`,
    `Caption: ${spec.copy.caption}`,
  ];

  if (spec.brandStyle) {
    if (spec.brandStyle.tone.length > 0) {
      lines.push("", "Brand tone:", ...spec.brandStyle.tone.map((entry) => `- ${entry}`));
    }
    if (spec.brandStyle.writingPrinciples.length > 0) {
      lines.push("", "Writing principles:", ...spec.brandStyle.writingPrinciples.map((entry) => `- ${entry}`));
    }
    if (spec.brandStyle.prohibitedPatterns.length > 0) {
      lines.push("", "Avoid:", ...spec.brandStyle.prohibitedPatterns.map((entry) => `- ${entry}`));
    }
  }

  return lines.join("\n");
}

// The fingerprint is always of this exact rendered text, via one path -- never of the spec object,
// never of anything else that merely correlates with it. That is what makes it a real, checkable
// answer to "was this asset made from the brief we think it was," not an approximation.
export async function briefSha256(spec: AssetGenerationSpecV1): Promise<string> {
  return sha256Hex(new TextEncoder().encode(renderAssetGenerationBrief(spec)));
}
