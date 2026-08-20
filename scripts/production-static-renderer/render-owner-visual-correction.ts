import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ProductionImageSpecV1 } from "../../src/lib/production-spec.ts";
import { PRODUCTION_IMAGE_DIMENSIONS } from "../../src/lib/production-spec.ts";
import { renderProductionStaticImage } from "../../src/lib/production-static-renderer.ts";

const PREVIOUS_ROOT = path.join("outputs", "production-mvp-wave-b-acceptance");
const OUTPUT_ROOT = path.join("outputs", "production-mvp-wave-b-owner-visual-correction");
const RAW_ILLUSTRATION_PATH = path.join(PREVIOUS_ROOT, "generate_visual-raw-attempt-2.jpg");

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function spec(overrides: Partial<ProductionImageSpecV1>): ProductionImageSpecV1 {
  return {
    schemaVersion: "production-v1",
    assetKind: "image",
    sourceCreativePackageId: "owner-visual-correction",
    dimensions: PRODUCTION_IMAGE_DIMENSIONS,
    copy: {
      headline: "",
      caption: "",
      cta: "",
      overlayText: null,
    },
    brandStyle: null,
    visualBrief: null,
    ...overrides,
  };
}

function html(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Wave B Owner Visual Correction</title>
    <style>
      body { margin: 0; background: #fff8ef; color: #261813; font-family: Arial, sans-serif; }
      main { max-width: 1480px; margin: 0 auto; padding: 32px; }
      h1 { font-size: 28px; margin: 0 0 8px; }
      p { color: #6d5548; margin: 0 0 28px; }
      section { margin-top: 30px; }
      h2 { font-size: 18px; margin: 0 0 12px; }
      .pair { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
      figure { margin: 0; border: 1px solid #d9c5b4; background: #fffdf8; padding: 12px; }
      img { display: block; width: 100%; height: auto; background: #f4e6d5; }
      figcaption { color: #6d5548; font-size: 13px; margin-top: 8px; }
      code { color: #5b3826; }
      @media (max-width: 860px) { .pair { grid-template-columns: 1fr; } }
    </style>
  </head>
  <body>
    <main>
      <h1>Wave B Owner Visual Correction</h1>
      <p>Review chrome is only in this HTML. Exported PNGs contain public-facing creative only.</p>
      <section>
        <h2>photo + template_only</h2>
        <div class="pair">
          <figure>
            <img src="../production-mvp-wave-b-acceptance/template_only-final.png" alt="Old template-only output" />
            <figcaption>OLD</figcaption>
          </figure>
          <figure>
            <img src="./template_only-final-v2.png" alt="New template-only output" />
            <figcaption>NEW · <code>template_only-final-v2.png</code></figcaption>
          </figure>
        </div>
      </section>
      <section>
        <h2>photo + generate_visual</h2>
        <div class="pair">
          <figure>
            <img src="../production-mvp-wave-b-acceptance/generate_visual-final.png" alt="Old generated visual output" />
            <figcaption>OLD</figcaption>
          </figure>
          <figure>
            <img src="./generate_visual-final-v2.png" alt="New generated visual output" />
            <figcaption>NEW · <code>generate_visual-final-v2.png</code></figcaption>
          </figure>
        </div>
      </section>
    </main>
  </body>
</html>`;
}

async function main() {
  await mkdir(OUTPUT_ROOT, { recursive: true });
  const rawIllustration = await readFile(RAW_ILLUSTRATION_PATH);

  const template = await renderProductionStaticImage(
    spec({
      copy: {
        headline: "some days deserve",
        caption: "a little reward.",
        cta: "",
        overlayText: null,
      },
    }),
  );

  const generated = await renderProductionStaticImage(
    spec({
      copy: {
        headline: "sharing is caring.",
        caption: "until someone starts measuring the pieces",
        cta: "",
        overlayText: null,
      },
      visualBrief: {
        concept: "A gentle sharing dessert moment.",
        style: "Warm hand-drawn editorial bakery illustration.",
        scene: ["Two simple human figures sharing dessert at a table"],
        executionNotes: ["Reuse existing raw illustration only", "Do not generate new imagery"],
      },
    }),
    { illustration: { bytes: rawIllustration, mimeType: "image/jpeg" } },
  );

  const templatePath = path.join(OUTPUT_ROOT, "template_only-final-v2.png");
  const generatedPath = path.join(OUTPUT_ROOT, "generate_visual-final-v2.png");
  await writeFile(templatePath, template.bytes);
  await writeFile(generatedPath, generated.bytes);
  await writeFile(path.join(OUTPUT_ROOT, "review.html"), html());
  await writeFile(
    path.join(OUTPUT_ROOT, "metadata.json"),
    `${JSON.stringify(
      {
        createdAt: new Date().toISOString(),
        cloudflareGenerationCalls: 0,
        rawIllustrationReused: RAW_ILLUSTRATION_PATH,
        outputs: [
          {
            case: "template_only",
            path: templatePath,
            publicCopy: ["some days deserve", "a little reward."],
            dimensions: `${template.width}x${template.height}`,
            bytes: template.bytes.length,
            sha256: sha256(template.bytes),
          },
          {
            case: "generate_visual",
            path: generatedPath,
            publicCopy: ["sharing is caring.", "until someone starts measuring the pieces"],
            dimensions: `${generated.width}x${generated.height}`,
            bytes: generated.bytes.length,
            sha256: sha256(generated.bytes),
          },
        ],
      },
      null,
      2,
    )}\n`,
  );

  console.log(JSON.stringify({ outputRoot: OUTPUT_ROOT, cloudflareGenerationCalls: 0 }, null, 2));
}

await main();
