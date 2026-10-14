import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

// Regenerates src/lib/production-fonts.ts from the full Geist Sans TTFs in the `geist` dependency.
//
// WHY THE FULL TTFs, NOT THE @fontsource LATIN SUBSET THIS USED TO EMBED.
//
// The latin subset has no peso sign (U+20B1). The Content Studio dual-renderer proof drew the verified
// offer "₱160 / 2 pcs" with a NO-GLYPH box. Rewording a price to dodge a glyph would change a verified
// fact, so the one production font authority now embeds the full-coverage faces instead. The typeface
// is the same Geist Sans; only its character coverage grew.
//
// WHY THE FACES ARE EMBEDDED RATHER THAN READ FROM DISK AT RUNTIME.
//
// The renderer originally resolved the .woff files with require.resolve. That works in plain Node --
// the test suite and the CLI worker both render fine -- and fails inside the Next server runtime,
// where the first real owner-facing production run through /api/production died with:
//
//   ENOENT: no such file or directory, open '...[externals]\@fontsource\geist-sans\package.json ...'
//
// The bundler rewrites require.resolve inside a server chunk, so the "path" it returns is a bundler
// identifier rather than a filesystem location. serverExternalPackages keeps the MODULE external but
// does not make a resolved subpath real. Chasing that with cwd-relative paths would only move the
// problem to whether a deployment happens to trace the file into the lambda.
//
// Embedding removes the question. The bytes are in the module, so there is no resolution, no file
// tracing, and no bundler interaction -- and the same code path runs identically under `node --test`,
// the CLI, the Next dev server, and a serverless deployment.
//
// LICENCE. Geist Sans is SIL Open Font License 1.1, which expressly permits embedding and
// redistribution. The generated module carries the attribution, and `geist` stays a declared
// dependency so the bytes remain traceable to a versioned, licensed source rather than appearing
// from nowhere.
//
// Run with:  node scripts/production-static-renderer/generate-embedded-fonts.ts

const require = createRequire(import.meta.url);
const PROJECT_ROOT = path.resolve(import.meta.dirname, "..", "..");
const OUTPUT = path.join(PROJECT_ROOT, "src", "lib", "production-fonts.ts");

// The package exports only its next/font wrappers (dist/sans.js); the TTFs sit beside them.
const distDir = path.dirname(require.resolve("geist/font/sans"));
const packageRoot = path.dirname(distDir);
const packageVersion = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8")).version as string;

const FACES = [
  { weight: 400, file: "Geist-Regular.ttf" },
  { weight: 700, file: "Geist-Bold.ttf" },
] as const;

const encoded = FACES.map((face) => ({
  ...face,
  base64: readFileSync(path.join(distDir, "fonts", "geist-sans", face.file)).toString("base64"),
}));

const body = `// GENERATED FILE -- do not edit by hand.
//
// Regenerate with:
//   node scripts/production-static-renderer/generate-embedded-fonts.ts
//
// The two Geist Sans faces the static production renderer draws with, embedded as base64 so the
// renderer needs no filesystem access and no module resolution at render time. See that script's
// header for the Next server-runtime failure this exists to prevent.
//
// Source:  geist@${packageVersion} (full Geist Sans TTFs; includes the peso sign U+20B1)
// Typeface: Geist Sans (C) 2023 Vercel, made in collaboration with basement.studio
// Licence: SIL Open Font License 1.1 -- embedding and redistribution are expressly permitted.
//          Full text ships at node_modules/geist/LICENSE.txt
// Upstream: https://github.com/vercel/geist-font

export const PRODUCTION_FONT_SOURCE_PACKAGE = "geist";
export const PRODUCTION_FONT_SOURCE_VERSION = "${packageVersion}";
export const PRODUCTION_FONT_LICENSE = "OFL-1.1";

export type EmbeddedProductionFont = {
  weight: 400 | 700;
  fileName: string;
  // CSS @font-face format name, stated because a data URL has no extension to infer it from.
  format: "truetype";
  base64: string;
};

export const EMBEDDED_PRODUCTION_FONTS: EmbeddedProductionFont[] = [
${encoded.map((face) => `  { weight: ${face.weight}, fileName: ${JSON.stringify(face.file)}, format: "truetype", base64: ${JSON.stringify(face.base64)} },`).join("\n")}
];
`;

writeFileSync(OUTPUT, body, "utf8");
console.log(`wrote ${OUTPUT}`);
for (const face of encoded) {
  console.log(`  ${face.weight}: ${face.file} -> ${face.base64.length} base64 chars`);
}
