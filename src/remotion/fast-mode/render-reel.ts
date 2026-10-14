import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { ensureBrowser, renderMedia, selectComposition } from "@remotion/renderer";
import sharp from "sharp";

import { EDITORIAL_COLLAGE_COMPOSITION_ID, planEditorialCollageReel, resolvedMediaFor, sceneMediaIds, type PreparedCampaign } from "../../lib/content-studio/creative-plan.ts";
import { assertSpecSupportsFormat, parseCreativeSpec } from "../../lib/content-studio/creative-spec.ts";
import { validateProbedVideo } from "../probe.ts";
import { REMOTION_RENDER_SETTINGS, bundleRemotionProductionModule } from "../render.ts";
import { probeVideoFile, resolveFfprobe } from "../runtime/ffprobe-runtime.ts";

// Content Studio Fast Mode -- MOTION REEL render + output gate. NODE ONLY, and never inside a Next
// server chunk: it runs in a plain Node child process (scripts/content-studio/render-reel.ts), the
// same way the Asset Job worker keeps Remotion out of the web bundle.
//
// Reuses the production bundler, the pinned encoder settings and the ffprobe validation, so a Fast
// Mode reel is encoded and checked exactly like the warm-open reel. On top of that it decodes EVERY
// frame of the finished MP4 and refuses the file if any frame is blank or near-black: the
// scene-continuity guard from the dual-renderer proof, promoted from a review harness to the gate.

export const FAST_MODE_REEL_ENTRY_POINT = path.resolve(import.meta.dirname, "index.ts");

// Calibrated in the dual-renderer proof: its one blank frame (a cut onto bare background) scored
// 0.000 content share; every real frame scored 0.155 or more.
export const MIN_FRAME_CONTENT_SHARE = 0.1;
export const MIN_FRAME_MEAN_LUMA = 20;
const SCRUB_SIZE = { width: 270, height: 480 };
const FFMPEG_TIMEOUT_MS = 120_000;

export class ReelOutputInvalidError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`The reel did not pass its output checks:\n${issues.map((issue) => `  - ${issue}`).join("\n")}`);
    this.name = "ReelOutputInvalidError";
    this.issues = issues;
  }
}

// Every media item a scene draws must be prepared, with the right kind for the spec.
export function assertReelInputsReady(campaign: PreparedCampaign): PreparedCampaign {
  const spec = parseCreativeSpec(campaign.spec);
  assertSpecSupportsFormat(spec, "reel");
  for (const scene of planEditorialCollageReel(spec).scenes) {
    for (const id of sceneMediaIds(scene)) {
      const resolved = resolvedMediaFor(campaign.media, id);
      const declared = spec.media.find((item) => item.id === id)!;
      if (resolved.kind !== declared.mediaType) throw new Error(`Media "${id}" was prepared as a ${resolved.kind} but the spec says ${declared.mediaType}.`);
    }
  }
  return { ...campaign, spec };
}

export type FrameStats = { content: number; luma: number };

// Share of pixels that differ from the brand background by more than 40 in some channel, and the
// mean luma. Exported so the threshold logic is unit-testable without a render.
export function frameStatsFromRaw(data: Uint8Array, width: number, height: number, background: string): FrameStats {
  const bg = [1, 3, 5].map((i) => parseInt(background.slice(i, i + 2), 16));
  let differing = 0;
  let luma = 0;
  const pixels = width * height;
  for (let p = 0; p < pixels; p += 1) {
    const o = p * 3;
    luma += 0.2126 * data[o] + 0.7152 * data[o + 1] + 0.0722 * data[o + 2];
    if (Math.max(Math.abs(data[o] - bg[0]), Math.abs(data[o + 1] - bg[1]), Math.abs(data[o + 2] - bg[2])) > 40) differing += 1;
  }
  return { content: differing / pixels, luma: luma / pixels };
}

export function blankFrames(stats: FrameStats[]): number[] {
  return stats.flatMap((s, frame) => (s.content < MIN_FRAME_CONTENT_SHARE || s.luma < MIN_FRAME_MEAN_LUMA ? [frame] : []));
}

async function scrubDecodedFrames(videoPath: string, background: string): Promise<FrameStats[]> {
  const probe = await resolveFfprobe();
  const dir = path.dirname(probe.executable);
  const ffmpeg = dir === "." ? "ffmpeg" : path.join(dir, `ffmpeg${path.extname(probe.executable)}`);
  const framesDir = await mkdtemp(path.join(os.tmpdir(), "fast-mode-scrub-"));
  try {
    await promisify(execFile)(
      ffmpeg,
      ["-v", "error", "-i", path.resolve(videoPath), "-vf", `scale=${SCRUB_SIZE.width}:${SCRUB_SIZE.height}`, "-start_number", "0", path.join(framesDir, "f%04d.png")],
      { timeout: FFMPEG_TIMEOUT_MS, killSignal: "SIGKILL" },
    );
    const files = (await readdir(framesDir)).filter((f) => f.endsWith(".png")).sort();
    const stats: FrameStats[] = [];
    for (const file of files) {
      const { data, info } = await sharp(path.join(framesDir, file)).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      stats.push(frameStatsFromRaw(data, info.width, info.height, background));
    }
    return stats;
  } finally {
    await rm(framesDir, { recursive: true, force: true });
  }
}

export type ReelRenderResult = {
  outputPath: string;
  width: number;
  height: number;
  fps: number;
  durationSeconds: number;
  codec: string;
  fileSizeBytes: number;
  decodedFrames: number;
  minFrameContent: number;
  renderDurationMs: number;
};

export async function renderFastModeReel(args: { campaign: PreparedCampaign; outputPath: string; serveUrl?: string }): Promise<ReelRenderResult> {
  const campaign = assertReelInputsReady(args.campaign);
  const plan = planEditorialCollageReel(campaign.spec);
  const startedAt = Date.now();

  await ensureBrowser();
  const serveUrl = args.serveUrl ?? (await bundleRemotionProductionModule({ entryPoint: FAST_MODE_REEL_ENTRY_POINT }));
  await mkdir(path.dirname(path.resolve(args.outputPath)), { recursive: true });

  const composition = await selectComposition({ serveUrl, id: EDITORIAL_COLLAGE_COMPOSITION_ID, inputProps: campaign });
  if (composition.width !== plan.width || composition.height !== plan.height || composition.fps !== plan.fps || composition.durationInFrames !== plan.durationInFrames) {
    throw new ReelOutputInvalidError([
      `composition resolved to ${composition.width}x${composition.height}@${composition.fps} ${composition.durationInFrames}f; the plan expects ${plan.width}x${plan.height}@${plan.fps} ${plan.durationInFrames}f.`,
    ]);
  }

  await renderMedia({
    composition,
    serveUrl,
    outputLocation: args.outputPath,
    inputProps: campaign,
    codec: REMOTION_RENDER_SETTINGS.codec,
    crf: REMOTION_RENDER_SETTINGS.crf,
    pixelFormat: REMOTION_RENDER_SETTINGS.pixelFormat,
    imageFormat: REMOTION_RENDER_SETTINGS.imageFormat,
    jpegQuality: REMOTION_RENDER_SETTINGS.jpegQuality,
    enforceAudioTrack: REMOTION_RENDER_SETTINGS.enforceAudioTrack,
  });

  // --- output gate ---
  const issues: string[] = [];
  const probe = await probeVideoFile(args.outputPath);
  if (!probe.ok) throw new ReelOutputInvalidError([`ffprobe: ${probe.reason} -- ${probe.message}`]);
  const verdict = validateProbedVideo(probe.probed, {
    width: campaign.spec.output.reel.width,
    height: campaign.spec.output.reel.height,
    frameRate: campaign.spec.output.reel.fps,
    durationSeconds: campaign.spec.output.reel.durationSeconds,
  });
  if (!verdict.ok) issues.push(...verdict.issues);

  const stats = await scrubDecodedFrames(args.outputPath, campaign.spec.brand.color.background);
  if (stats.length !== plan.durationInFrames) issues.push(`decoded ${stats.length} frames, expected ${plan.durationInFrames}.`);
  const blank = blankFrames(stats);
  if (blank.length > 0) issues.push(`blank or near-black frames: ${blank.join(", ")}.`);
  if (issues.length > 0) throw new ReelOutputInvalidError(issues);

  return {
    outputPath: path.resolve(args.outputPath),
    width: probe.probed.width,
    height: probe.probed.height,
    fps: probe.probed.frameRate,
    durationSeconds: probe.probed.durationSeconds,
    codec: probe.probed.videoCodec,
    fileSizeBytes: (await stat(args.outputPath)).size,
    decodedFrames: stats.length,
    minFrameContent: Math.min(...stats.map((s) => s.content)),
    renderDurationMs: Date.now() - startedAt,
  };
}
