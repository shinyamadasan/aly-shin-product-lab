import { statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";

import { bundle } from "@remotion/bundler";
import { VERSION as REMOTION_VERSION } from "remotion";
import { ensureBrowser, renderMedia, selectComposition } from "@remotion/renderer";

import { WARM_OPEN_COMPOSITION_ID, warmOpenDurationInFrames, type WarmOpenProps } from "./composition-catalog.ts";

// Production MVP Wave C1 -- the programmatic render entry point.
//
// NODE ONLY. It reaches @remotion/bundler and @remotion/renderer, which spawn webpack and a headless
// Chrome; nothing in src/app may import this file, and nothing does. It is the video counterpart of
// production-static-renderer.ts, which is likewise a Node-side module the browser never sees.
//
// WHAT C2 WILL DO WITH IT
//
// An AssetJobExecutor is `(job, spec, context) => GeneratedAssetFileCandidate[]`. A Remotion executor
// is therefore: bridge the spec to props (production-spec-bridge.ts), call renderRemotionComposition
// below, probe the output (probe.ts), and return one candidate. Every one of those four steps exists
// and is separately testable today. C2 wires them; it does not redesign them, which is the reason
// this function takes explicit structured props and returns explicit structured facts rather than
// reaching for a job record it has no business knowing about.
//
// NO HIDDEN GLOBAL STATE. There is no module-level bundle cache, no memoized serveUrl and no
// singleton browser. A caller that wants to reuse a bundle across renders bundles once and passes
// the serveUrl back in -- which is visible at the call site, and is the only way two renders can be
// honestly compared.

export type RemotionBundleOptions = {
  // Defaults to src/remotion/index.ts resolved from this file. Overridable so a test or a future
  // second entry point does not have to move this module.
  entryPoint?: string;
  onProgress?: (percent: number) => void;
};

export type RemotionRenderRequest = {
  serveUrl: string;
  compositionId: string;
  inputProps: WarmOpenProps;
  outputPath: string;
  onProgress?: (progress: { renderedFrames: number; encodedFrames: number }) => void;
};

// Everything a reviewer needs to decide whether the render did what was asked, WITHOUT opening the
// file. The file is then probed separately and independently -- see probe.ts -- so the two answers
// can be compared rather than one being derived from the other.
export type RemotionRenderResult = {
  outputPath: string;
  compositionId: string;
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
  expectedDurationSeconds: number;
  // What renderMedia actually reported rendering, not what was predicted. The two agreeing is the
  // claim; asserting one from the other would make the claim circular.
  renderedFrameCount: number;
  encodedFrameCount: number;
  fileSizeBytes: number;
  codec: "h264";
  serveUrl: string;
  remotionVersion: string;
  renderDurationMs: number;
};

export const REMOTION_ENTRY_POINT = path.resolve(import.meta.dirname, "index.ts");

// --- deterministic encoder settings ----------------------------------------------------------------
//
// PINNED, not defaulted. Every one of these has a Remotion default that could change between minor
// versions, and a renderer whose output silently changes when a dependency is bumped is not the
// deterministic renderer this wave set out to build. Stating them here makes an encoder change a
// visible diff.
//
// yuv420p and h264 are the pairing every social platform ingests without re-encoding. CRF 18 is
// Remotion's own default for h264 and is kept deliberately -- it is named here to freeze it, not to
// change it.
export const REMOTION_RENDER_SETTINGS = {
  codec: "h264",
  crf: 18,
  pixelFormat: "yuv420p",
  // JPEG frames at quality 90. Remotion's default for h264 is jpeg; the quality is raised from the
  // default 80 because this composition is flat warm colour and large type, where JPEG ringing on
  // the letterforms is the first thing that shows.
  imageFormat: "jpeg",
  jpegQuality: 90,
  // TRUE, and kept true deliberately after the first render revealed it.
  //
  // warm-open authors no audio, so an MP4 with a silent AAC track looks at first like an encoder
  // adding something nobody asked for. It is Remotion's `enforceAudioTrack` default, and the reason
  // it defaults on is that several social platforms and players mishandle an MP4 with no audio
  // stream at all -- which is precisely what a Reel is going to be uploaded to. Keeping it is the
  // right call for the destination; PINNING it is what turns an inherited default into a decision.
  //
  // The cost is that the container runs about two AAC frames longer than the video, which is why
  // probe.ts derives its duration tolerance from audio granularity rather than from fps alone.
  enforceAudioTrack: true,
} as const;

export async function bundleRemotionProductionModule(options: RemotionBundleOptions = {}): Promise<string> {
  return bundle({
    entryPoint: options.entryPoint ?? REMOTION_ENTRY_POINT,
    // Left unchanged on purpose. Remotion's own webpack config already handles the TypeScript and
    // JSX in this module, and an override here would be a second, undocumented build configuration
    // sitting beside next.config.ts.
    webpackOverride: (config) => config,
    onProgress: options.onProgress,
  });
}

export async function renderRemotionComposition(request: RemotionRenderRequest): Promise<RemotionRenderResult> {
  // Guard BEFORE bundling or launching anything. An out-of-range duration is a caller error and
  // should cost nothing to discover; letting it through would surface as a confusing failure inside
  // calculateMetadata after a browser had already been started. The value is compared against what
  // Remotion actually resolves, below, rather than being trusted.
  const expectedDurationInFrames = warmOpenDurationInFrames(request.inputProps.durationSeconds);

  // Explicit rather than implicit. renderMedia will download Chrome Headless Shell on demand, but
  // doing it here means the download is a separate, reportable step rather than time that silently
  // lands inside the measured render duration.
  await ensureBrowser();

  await mkdir(path.dirname(path.resolve(request.outputPath)), { recursive: true });

  const composition = await selectComposition({
    serveUrl: request.serveUrl,
    id: request.compositionId,
    inputProps: request.inputProps,
  });

  // The catalog and calculateMetadata are two independent computations of the same number, and this
  // is where they are made to agree. A mismatch means the registry and the catalog have drifted,
  // which would otherwise only show up as a video of the wrong length.
  if (composition.durationInFrames !== expectedDurationInFrames) {
    throw new Error(
      `Composition ${composition.id} resolved to ${composition.durationInFrames} frames but the catalog predicts ${expectedDurationInFrames} for ${request.inputProps.durationSeconds}s.`,
    );
  }

  let renderedFrameCount = 0;
  let encodedFrameCount = 0;

  const startedAt = Date.now();
  await renderMedia({
    composition,
    serveUrl: request.serveUrl,
    outputLocation: request.outputPath,
    inputProps: request.inputProps,
    codec: REMOTION_RENDER_SETTINGS.codec,
    crf: REMOTION_RENDER_SETTINGS.crf,
    pixelFormat: REMOTION_RENDER_SETTINGS.pixelFormat,
    imageFormat: REMOTION_RENDER_SETTINGS.imageFormat,
    jpegQuality: REMOTION_RENDER_SETTINGS.jpegQuality,
    enforceAudioTrack: REMOTION_RENDER_SETTINGS.enforceAudioTrack,
    onProgress: ({ renderedFrames, encodedFrames }) => {
      renderedFrameCount = Math.max(renderedFrameCount, renderedFrames);
      encodedFrameCount = Math.max(encodedFrameCount, encodedFrames);
      request.onProgress?.({ renderedFrames, encodedFrames });
    },
  });
  const renderDurationMs = Date.now() - startedAt;

  // Read back from disk rather than trusting the request: the size reported is the size of the file
  // that exists, which is the number a size policy will later be enforced against.
  const fileSizeBytes = statSync(request.outputPath).size;

  return {
    outputPath: path.resolve(request.outputPath),
    compositionId: composition.id,
    width: composition.width,
    height: composition.height,
    fps: composition.fps,
    durationInFrames: composition.durationInFrames,
    expectedDurationSeconds: composition.durationInFrames / composition.fps,
    renderedFrameCount,
    encodedFrameCount,
    fileSizeBytes,
    codec: REMOTION_RENDER_SETTINGS.codec,
    serveUrl: request.serveUrl,
    remotionVersion: REMOTION_VERSION,
    renderDurationMs,
  };
}

// The convenience path the CLI harness uses: bundle, then render, in one call. Kept SEPARATE from
// renderRemotionComposition rather than folded in as an optional serveUrl, because a caller rendering
// twice must be able to see that it bundled once -- and an optional parameter that silently changes
// how much work happens is exactly how a second render accidentally becomes a second bundle.
export async function bundleAndRenderWarmOpen(args: {
  inputProps: WarmOpenProps;
  outputPath: string;
  onBundleProgress?: (percent: number) => void;
  onRenderProgress?: (progress: { renderedFrames: number; encodedFrames: number }) => void;
}): Promise<RemotionRenderResult> {
  const serveUrl = await bundleRemotionProductionModule({ onProgress: args.onBundleProgress });
  return renderRemotionComposition({
    serveUrl,
    compositionId: WARM_OPEN_COMPOSITION_ID,
    inputProps: args.inputProps,
    outputPath: args.outputPath,
    onProgress: args.onRenderProgress,
  });
}
