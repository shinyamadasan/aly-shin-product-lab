import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import sharp from "sharp";

import { ALY_PON_BRAND_TOKENS } from "../../../src/lib/content-studio/brand-tokens.ts";
import { prepareCampaign } from "../../../src/lib/content-studio/campaign-media.ts";
import { CREATIVE_OUTPUT_V1, parseCreativeSpec } from "../../../src/lib/content-studio/creative-spec.ts";
import { renderReelOnHost } from "../../../src/lib/content-studio/reel-host.ts";
import { validateProbedVideo } from "../../../src/remotion/probe.ts";
import { probeVideoFile, resolveFfprobe } from "../../../src/remotion/runtime/ffprobe-runtime.ts";

// OPT-IN (RUN_REEL_SMOKE=1): renders a REAL Fast Mode Reel through the production host path -- the
// child render process, Remotion, Chrome, FFmpeg -- and its output gate (ffprobe + every-frame blank
// scrub). Media are SYNTHETIC test patterns (four stills and one H.264 clip), never food, served from a
// local HTTP server standing in for the signed Media Library URL. MP4 copy: outputs/fast-mode-acceptance/.

const ROOT = path.resolve(import.meta.dirname, "../../..");
const enabled = process.env.RUN_REEL_SMOKE === "1";

test("a mixed photo + real-clip Reel renders as valid 1080x1920 H.264 ~11s with no blank frame", { skip: !enabled, timeout: 15 * 60 * 1000 }, async () => {
  const work = await mkdtemp(path.join(os.tmpdir(), "fast-mode-smoke-"));
  const probe = await resolveFfprobe();
  const ffmpeg = path.join(path.dirname(probe.executable), `ffmpeg${path.extname(probe.executable)}`);
  const clip = path.join(work, "clip.mp4");
  // A moving bar over a solid field, 5s at 30fps: real motion, encoded to H.264 by Remotion's FFmpeg
  // (its build has no lavfi test sources).
  const frames = path.join(work, "frames");
  await mkdir(frames);
  for (let i = 0; i < 150; i += 1) {
    const y = Math.round((i / 149) * 1100);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="1280"><rect width="100%" height="100%" fill="#2f5d62"/><rect x="0" y="${y}" width="720" height="180" fill="#f2c14e"/></svg>`;
    await sharp(Buffer.from(svg)).png().toFile(path.join(frames, `f${String(i).padStart(3, "0")}.png`));
  }
  await promisify(execFile)(ffmpeg, ["-v", "error", "-framerate", "30", "-i", path.join(frames, "f%03d.png"), "-c:v", "libx264", "-pix_fmt", "yuv420p", clip]);
  const clipBytes = await readFile(clip);
  const server = createServer((request, response) => {
    if (request.url !== "/clip.mp4") return void response.writeHead(404).end();
    const range = /bytes=(\d+)-(\d*)/.exec(request.headers.range ?? "");
    if (range) {
      const start = Number(range[1]);
      const end = range[2] ? Number(range[2]) : clipBytes.length - 1;
      response.writeHead(206, { "content-type": "video/mp4", "accept-ranges": "bytes", "content-range": `bytes ${start}-${end}/${clipBytes.length}`, "content-length": end - start + 1 });
      return void response.end(clipBytes.subarray(start, end + 1));
    }
    response.writeHead(200, { "content-type": "video/mp4", "accept-ranges": "bytes", "content-length": clipBytes.length }).end(clipBytes);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const clipUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/clip.mp4`;

  try {
    const roles = ["hero", "detail", "context", "offer", "supporting"] as const;
    const colours = ["#7a4a2a", "#c08850", "#5d6b3a", "#a33f2a", "#3b4f6b"];
    const spec = parseCreativeSpec({
      specVersion: 1,
      product: { id: "smoke-product", name: "Smoke Test Product" },
      media: roles.map((role, i) => ({
        id: `m${i + 1}`,
        role,
        // The context tile is real footage; everything else is a still.
        mediaType: role === "context" ? "video" : "photo",
        source: { kind: "fixture", name: `pattern-${i + 1}` },
        provenance: "test_fixture",
        durationSeconds: role === "context" ? 5 : null,
      })),
      brand: ALY_PON_BRAND_TOKENS,
      offer: { price: { amount: 160, currency: "PHP" }, unit: "2 pcs", cta: "Message us to order", confirmedByOwner: true },
      content: { purpose: "product_offer", headline: null },
      output: CREATIVE_OUTPUT_V1,
    });
    const campaign = await prepareCampaign(spec, {
      readPhoto: async (media) => {
        const colour = colours[Number(media.id.slice(1)) - 1];
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1500"><rect width="100%" height="100%" fill="${colour}"/><path d="M0 0 L1200 1500" stroke="#fff" stroke-width="40"/></svg>`;
        return new Uint8Array(await sharp(Buffer.from(svg)).jpeg().toBuffer());
      },
      videoUrl: async () => clipUrl,
    });
    assert.equal(campaign.notForPublishing, true);

    const result = await renderReelOnHost(campaign, ROOT);
    assert.ok(result.ok, `render failed: ${result.ok ? "" : `${result.reason}: ${result.issues.join("; ")}`}`);

    const out = path.join(ROOT, "outputs", "fast-mode-acceptance");
    await mkdir(out, { recursive: true });
    const mp4 = path.join(out, "reel-smoke.mp4");
    await writeFile(mp4, result.mp4);
    const probed = await probeVideoFile(mp4);
    assert.ok(probed.ok);
    assert.deepEqual(validateProbedVideo(probed.probed, { width: 1080, height: 1920, frameRate: 30, durationSeconds: 11 }).ok, true);
    assert.equal(probed.probed.videoCodec, "h264");
    console.log(`reel ${probed.probed.width}x${probed.probed.height} ${probed.probed.videoCodec} ${probed.probed.durationSeconds}s ${result.mp4.length} bytes -> ${mp4}`);
  } finally {
    server.close();
    await rm(work, { recursive: true, force: true });
  }
});
