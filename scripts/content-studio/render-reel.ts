import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";

import type { PreparedCampaign } from "../../src/lib/content-studio/creative-plan.ts";
import { ReelOutputInvalidError, renderFastModeReel } from "../../src/remotion/fast-mode/render-reel.ts";

// Content Studio Fast Mode -- the reel render process. Spawned by the owner route
// (src/lib/content-studio/reel-host.ts) so Remotion, Chrome and FFmpeg stay out of the Next server
// bundle, exactly as the Asset Job worker keeps them out.
//
//   node scripts/content-studio/render-reel.ts --input <prepared-campaign.json> --output <reel.mp4>
//
// The last stdout line is one JSON object: { ok: true, result } or { ok: false, kind, issues }.
// The input file holds a PreparedCampaign the route already validated; it contains no secrets beyond
// short-lived signed URLs to the owner's own clips, and the route deletes it afterwards.

async function main(argv: string[]): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { input: { type: "string" }, output: { type: "string" } } });
  if (!values.input || !values.output) {
    console.log(JSON.stringify({ ok: false, kind: "usage", issues: ["--input and --output are required."] }));
    return 2;
  }
  try {
    const campaign = JSON.parse(await readFile(values.input, "utf8")) as PreparedCampaign;
    const result = await renderFastModeReel({ campaign, outputPath: values.output });
    console.log(JSON.stringify({ ok: true, result }));
    return 0;
  } catch (error) {
    const issues = error instanceof ReelOutputInvalidError ? error.issues : [error instanceof Error ? error.message : String(error)];
    console.log(JSON.stringify({ ok: false, kind: error instanceof ReelOutputInvalidError ? "invalid-output" : "render-failed", issues }));
    return 1;
  }
}

process.exitCode = await main(process.argv.slice(2));
