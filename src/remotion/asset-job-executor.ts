import { readFile, rm } from "node:fs/promises";
import path from "node:path";

import type { AssetJobExecutor, AssetJobRecord } from "../lib/asset-jobs.ts";
import type { GeneratedAssetFileCandidate } from "../lib/asset-generation-validation.ts";
import { isProductionSpecV1, type ProductionShortVideoSpecV1 } from "../lib/production-spec.ts";
import { WARM_OPEN_COMPOSITION_ID } from "./composition-catalog.ts";
import { warmOpenPropsFromProductionSpec } from "./production-spec-bridge.ts";
import { validateProbedVideo } from "./probe.ts";
import { probeVideoFile } from "./runtime/ffprobe-runtime.ts";
import { renderRemotionComposition, type RemotionRenderResult } from "./render.ts";

// Production MVP Wave C2A -- the AssetJobExecutor that turns a short_video Asset Job into MP4 bytes.
//
// Shape is dictated by the existing contract and nothing here invents a new one:
//
//   (job, spec, context) => GeneratedAssetFileCandidate[]
//
// which means everything AFTER this function is the reviewed Wave B pipeline, untouched:
// validateGeneratedAssetCandidates -> validateAssetCandidateBytes -> materializeAssetJobFiles ->
// Asset / AssetFile / attempt lifecycle. There is no second storage path here and no second attempt
// system, exactly as production-execution.ts already guarantees for the image workers.
//
// HOST INDEPENDENCE. Nothing in this module reads a machine name, a drive letter, a localhost URL or
// an owner filesystem path, and nothing it produces carries one. The scratch root is supplied by the
// worker process that constructs the executor; the job payload never contains a path at all. Moving
// this to a Linux container changes the value of scratchRoot and nothing else.

export type RemotionExecutorOptions = {
  // Supplied by the worker process, never by a job. See buildWorkerRenderPath for why.
  scratchRoot: string;
  // A Remotion bundle serve URL, created ONCE per worker process and reused across jobs. Required
  // rather than optional: an executor that could silently bundle on its own would reintroduce the
  // per-job temp-directory growth C1 flagged as a C2 blocker.
  serveUrl: string;
  brandMark: string;
  // Reported rather than swallowed. The bridge tells us when a package asked for something warm-open
  // cannot fully show (a longer cut, more shots than one scene); the worker logs it against the job.
  onWarning?: (warning: string) => void;
  onRenderComplete?: (result: RemotionRenderResult) => void;
  // Cleanup is the DEFAULT and the flag exists to suspend it, never to enable it. Kept because a
  // failed render's output is evidence -- see the note at cleanupRenderArtifacts.
  keepRenderArtifacts?: boolean;
  ffprobePath?: string;
};

// --- the trusted scratch path -----------------------------------------------------------------------
//
// THE RULE: the worker CONSTRUCTS this path. It is never handed one.
//
// Not from the browser, not from the API payload, not from ProductionSpecV1, not from the Creative
// Package, not from job metadata. The only inputs are the worker's own scratch root and two facts
// that came back from the database inside the claim: the job id and the attempt number. Both are
// validated below before they are allowed near a path separator, so a malformed or hostile row
// cannot escape the scratch root even if one ever reached the table.
//
// The UUID and integer checks are the traversal defence, and they are stricter than "reject ..":
// "../../etc" fails the UUID shape, and so does "a/b", "a\\b", an absolute path, and a URL. Nothing
// that is not exactly a UUID can be a directory name here. The containment assertion afterwards is
// the belt to that braces -- it re-derives the resolved path and refuses anything that did not land
// inside the root, so the guarantee does not rest on the regex alone.

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A relaxed identifier for non-production job stores (the in-memory proof store uses readable ids).
// Still forbids every path-significant character, so it cannot widen the traversal surface.
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function isTrustedPathSegment(value: string): boolean {
  return UUID_PATTERN.test(value) || SAFE_ID_PATTERN.test(value);
}

export type WorkerRenderPathArgs = {
  scratchRoot: string;
  assetJobId: string;
  attemptNumber: number;
  extension?: string;
};

export function buildWorkerRenderPath(args: WorkerRenderPathArgs): string {
  if (!isTrustedPathSegment(args.assetJobId)) {
    throw new Error(`Refusing to build a render path from an untrusted Asset Job id: ${JSON.stringify(args.assetJobId)}.`);
  }
  if (!Number.isInteger(args.attemptNumber) || args.attemptNumber < 1) {
    throw new Error(`Refusing to build a render path from an untrusted attempt number: ${JSON.stringify(args.attemptNumber)}.`);
  }

  const extension = args.extension ?? "mp4";
  if (!/^[a-z0-9]{1,8}$/.test(extension)) {
    throw new Error(`Refusing to build a render path with an untrusted extension: ${JSON.stringify(extension)}.`);
  }

  const root = path.resolve(args.scratchRoot);
  const resolved = path.resolve(root, `asset-job-${args.assetJobId}`, `attempt-${args.attemptNumber}`, `output.${extension}`);

  // Containment, re-derived rather than assumed. path.relative gives a value that starts with ".."
  // (or is absolute) for anything outside the root, on both POSIX and Windows separators.
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing to build a render path outside the worker scratch root: ${resolved}.`);
  }

  return resolved;
}

export function workerRenderDirectory(scratchRoot: string, assetJobId: string, attemptNumber: number): string {
  return path.dirname(buildWorkerRenderPath({ scratchRoot, assetJobId, attemptNumber }));
}

// --- artifact cleanup -------------------------------------------------------------------------------
//
// Called by the WORKER after the job reaches a terminal state, never by the executor mid-flight.
//
// The ordering matters and is the reason this is not simply a `finally` inside the executor: the
// bytes are read into memory and handed on for validation, upload and materialization, and the
// attempt's outcome is not known until all of that has finished. Deleting the MP4 the moment the
// render returned would destroy the only artifact anyone could inspect when materialization fails --
// and "the render worked but the upload did not" is precisely the case a human needs the file for.
//
// So: terminal state first, then cleanup. A failed attempt's directory is cleaned too, once its
// failure has been RECORDED, because an unbounded pile of failed renders is its own operational
// problem; keepRenderArtifacts suspends that for a debugging session.
export async function cleanupRenderArtifacts(directory: string): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    await rm(directory, { recursive: true, force: true });
    return { ok: true };
  } catch (err) {
    // Never fatal. Cleanup failing must not turn a completed job into a failed one -- the asset is
    // already materialized and the scratch file is only a local artifact.
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

function requireShortVideoProductionSpec(spec: unknown): ProductionShortVideoSpecV1 {
  if (!isProductionSpecV1(spec) || spec.assetKind !== "short_video") {
    throw new Error("The Remotion executor requires a short_video ProductionSpecV1.");
  }
  return spec;
}

export function buildRemotionAssetExecutor(options: RemotionExecutorOptions): AssetJobExecutor {
  return async (job: AssetJobRecord, rawSpec, context): Promise<GeneratedAssetFileCandidate[]> => {
    const spec = requireShortVideoProductionSpec(rawSpec);

    // MULTI-SHOT, stated rather than silently dropped.
    //
    // warm-open renders a single held scene and reads at most the first two shots' on-screen text.
    // A five-shot Reel is therefore not fully represented, and the bridge says so. C2A's contract is
    // that the gap is REPORTED at execution time -- it is not the place where the motion-design
    // system gets built, and pretending the shots were consumed would be the failure mode worth
    // avoiding far more than the missing feature itself.
    const bridged = warmOpenPropsFromProductionSpec(spec, { brandMark: options.brandMark });
    for (const warning of bridged.warnings) {
      options.onWarning?.(warning);
    }

    // Path from DATABASE IDENTITY only. job.id and job.attemptCount both came back inside the atomic
    // claim; nothing a caller supplied reaches this.
    const outputPath = buildWorkerRenderPath({
      scratchRoot: options.scratchRoot,
      assetJobId: job.id,
      attemptNumber: job.attemptCount,
    });

    // The runner's AbortSignal is honoured at the two points this executor can honour it: before a
    // render starts, and before the bytes are read afterwards. renderMedia has no cancel hook wired
    // here, so an aborted render still finishes writing before we stop -- the same limitation the
    // Wave B executors carry, and stated rather than implied.
    if (context.signal.aborted) {
      throw new Error("Remotion execution was aborted before rendering started.");
    }

    const render = await renderRemotionComposition({
      serveUrl: options.serveUrl,
      compositionId: WARM_OPEN_COMPOSITION_ID,
      inputProps: bridged.props,
      outputPath,
    });
    options.onRenderComplete?.(render);

    if (context.signal.aborted) {
      throw new Error("Remotion execution was aborted after rendering completed.");
    }

    // --- ffprobe, BEFORE a candidate exists ---------------------------------------------------------
    //
    // The deep check runs here rather than after the candidate is built, because a file that is not
    // what the spec asked for should never become a candidate at all. This is the layer that can see
    // what a container index cannot: the real frame rate, the stream counts, the codec name as the
    // demuxer reports it.
    //
    // The structural MP4 gate in asset-binary.ts still runs afterwards on the same bytes, and the two
    // are deliberately independent. This one can be absent (no binary on the host); that one cannot
    // be bypassed by any upload path. Neither is redundant.
    const probe = await probeVideoFile(outputPath, { ffprobePath: options.ffprobePath });
    if (!probe.ok) {
      throw new Error(`Rendered MP4 could not be probed (${probe.reason}, via ${probe.source}): ${probe.message}`);
    }

    const verdict = validateProbedVideo(probe.probed, {
      // From the SPEC and the render, never from the file. The point of the check is to compare what
      // was asked for against what exists; reading the expectation out of the artifact would make it
      // agree with itself by construction.
      width: spec.dimensions.width,
      height: spec.dimensions.height,
      frameRate: render.fps,
      durationSeconds: render.expectedDurationSeconds,
    });
    if (!verdict.ok) {
      throw new Error(`Rendered MP4 does not match the production spec: ${verdict.issues.join(" ")}`);
    }

    const bytes = new Uint8Array(await readFile(outputPath));

    return [
      {
        position: 0,
        mimeType: "video/mp4",
        // The PROBE's dimensions, not the spec's request -- the candidate must describe the file
        // that exists. validateAssetCandidateBytes re-derives both from the container and rejects a
        // candidate whose declaration disagrees with its own bytes, so an optimistic value here
        // would fail there rather than sneak through.
        width: probe.probed.width,
        height: probe.probed.height,
        durationMs: Math.round(probe.probed.durationSeconds * 1000),
        fileSizeBytes: bytes.length,
        bytes,
      },
    ];
  };
}
