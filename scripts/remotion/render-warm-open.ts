import path from "node:path";
import { parseArgs } from "node:util";

import {
  WARM_OPEN_COMPOSITION_ID,
  WARM_OPEN_DEFAULT_PROPS,
  clampWarmOpenDurationSeconds,
  warmOpenMetadata,
} from "../../src/remotion/composition-catalog.ts";
import { probeVideoFile, validateProbedVideo } from "../../src/remotion/probe.ts";
import { bundleRemotionProductionModule, renderRemotionComposition } from "../../src/remotion/render.ts";
import { maxGeneratedAssetFileSizeBytes } from "../../src/lib/asset-generation-validation.ts";

// Production MVP Wave C1 -- the local render harness.
//
// Its whole job is to produce ONE real MP4 on this workstation and then tell the truth about it: what
// was rendered, how long it took, what ffprobe says the file actually contains, and whether those
// agree. It is the C1 counterpart of scripts/production-static-renderer/render-owner-visual-correction.ts
// -- a harness that drives the real module, not a private reimplementation of it.
//
// IT IS NOT A WORKER. It touches no Supabase client, creates no Asset Job, writes no row and uploads
// nothing. short_video remains non-executable through the Wave B job path; this renders to a local
// file and stops, which is exactly the boundary Wave C1 was scoped to.
//
// --repeat 2 bundles ONCE and renders twice from the same serveUrl. That is the second-render proof:
// it answers both "does a second render succeed without manual cleanup" and "do two renders of the
// same input agree", and it does so without a second bundle confusing the comparison.

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..", "..");
const DEFAULT_OUTPUT_DIR = path.join(PROJECT_ROOT, "outputs", "remotion");

function formatBytes(bytes: number): string {
  return `${bytes} bytes (${(bytes / (1024 * 1024)).toFixed(2)} MB)`;
}

export async function main(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      "out-dir": { type: "string" },
      duration: { type: "string" },
      repeat: { type: "string" },
      headline: { type: "string" },
    },
    allowPositionals: false,
  });

  const outDir = values["out-dir"] ? path.resolve(values["out-dir"]) : DEFAULT_OUTPUT_DIR;
  const repeat = values.repeat ? Number(values.repeat) : 1;
  if (!Number.isInteger(repeat) || repeat < 1) {
    console.error(`--repeat must be a positive integer. Received: ${values.repeat}`);
    return 1;
  }

  const requestedDuration = values.duration ? Number(values.duration) : WARM_OPEN_DEFAULT_PROPS.durationSeconds;
  const durationSeconds = clampWarmOpenDurationSeconds(requestedDuration);
  if (durationSeconds !== requestedDuration) {
    console.warn(`! --duration ${requestedDuration}s is outside the composition's range; rendering ${durationSeconds}s.`);
  }

  const inputProps = {
    ...WARM_OPEN_DEFAULT_PROPS,
    ...(values.headline ? { headline: values.headline } : {}),
    durationSeconds,
  };

  const predicted = warmOpenMetadata(durationSeconds);
  console.log(`Composition : ${predicted.compositionId}`);
  console.log(`Predicted   : ${predicted.width}x${predicted.height} @ ${predicted.fps}fps, ${predicted.durationInFrames} frames (${durationSeconds}s)`);
  console.log(`Node        : ${process.version} on ${process.platform}/${process.arch}`);

  const bundleStartedAt = Date.now();
  const serveUrl = await bundleRemotionProductionModule({
    onProgress: (percent) => {
      if (percent === 100) {
        console.log("Bundling    : 100%");
      }
    },
  });
  console.log(`Bundle      : ${serveUrl} (${Date.now() - bundleStartedAt}ms)`);

  let failures = 0;

  for (let attempt = 1; attempt <= repeat; attempt += 1) {
    const outputPath = path.join(outDir, `${WARM_OPEN_COMPOSITION_ID}-${attempt}.mp4`);
    console.log(`\n--- render ${attempt} of ${repeat} -------------------------------------------------`);

    const result = await renderRemotionComposition({
      serveUrl,
      compositionId: WARM_OPEN_COMPOSITION_ID,
      inputProps,
      outputPath,
    });

    console.log(`Output      : ${result.outputPath}`);
    console.log(`Remotion    : ${result.remotionVersion}`);
    console.log(`Rendered    : ${result.renderedFrameCount} frames, encoded ${result.encodedFrameCount}, in ${result.renderDurationMs}ms`);
    console.log(`Declared    : ${result.width}x${result.height} @ ${result.fps}fps, ${result.durationInFrames} frames (${result.expectedDurationSeconds}s)`);
    console.log(`Size        : ${formatBytes(result.fileSizeBytes)}`);

    const probe = await probeVideoFile(result.outputPath);
    console.log(`ffprobe     : ${probe.executable ?? "unresolved"}`);
    if (!probe.ok) {
      console.error(`FAIL probe  : ${probe.reason} -- ${probe.message}`);
      failures += 1;
      continue;
    }

    const { probed } = probe;
    console.log(`Container   : ${probed.container} (${probed.containerLongName})`);
    console.log(`Codec       : ${probed.videoCodec}`);
    console.log(`Dimensions  : ${probed.width}x${probed.height}`);
    console.log(`Frame rate  : ${probed.frameRate}`);
    console.log(`Duration    : ${probed.durationSeconds}s`);
    console.log(`Frames      : ${probed.frameCount ?? "not reported by the container"}`);
    console.log(`Streams     : ${probed.streamCount} total (${probed.videoStreamCount} video, ${probed.audioStreamCount} audio)`);

    const verdict = validateProbedVideo(probed, {
      width: result.width,
      height: result.height,
      frameRate: result.fps,
      durationSeconds: result.expectedDurationSeconds,
      maxFileSizeBytes: maxGeneratedAssetFileSizeBytes("short_video"),
    });

    if (verdict.ok) {
      console.log("Verdict     : PASS (technical). Owner creative acceptance is a SEPARATE review.");
    } else {
      failures += 1;
      console.error("Verdict     : FAIL");
      for (const issue of verdict.issues) {
        console.error(`  - ${issue}`);
      }
    }
  }

  if (repeat > 1) {
    console.log(`\nSecond-render proof: ${repeat} renders from ONE bundle, no manual cleanup between them.`);
  }

  return failures === 0 ? 0 : 1;
}

process.exitCode = await main(process.argv.slice(2));
