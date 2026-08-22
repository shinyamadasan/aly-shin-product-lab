import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { parseFfprobeJson, type ProbeResult } from "../probe.ts";

const execFileAsync = promisify(execFile);

// Production MVP Wave C2A -- THE ONE PLACE that knows how to find and run an ffprobe binary.
//
// WHY THIS MODULE EXISTS AT ALL
//
// C1 resolved the binary inside src/remotion/probe.ts, via RenderInternals.getExecutablePath. Two
// separate problems with that, and they are worth stating apart:
//
//   1. RenderInternals is, by its own name, not a public API. A Remotion upgrade may move or remove
//      it with no deprecation, and C1's own report listed that as a C2 blocker.
//
//   2. Worse than the coupling: it put a PROCESS SPAWN and a node_modules layout assumption inside a
//      module whose other half (parseFfprobeJson, validateProbedVideo) is pure domain validation
//      that C2B may want to run somewhere with no Remotion install at all -- a serverless verifier,
//      a test, a different host.
//
// So probe.ts keeps the pure half and this owns the runtime half. Nothing in src/lib imports this.
//
// IS THERE A PUBLIC API? Not for the binary path. @remotion/renderer exports getVideoMetadata(),
// which is public and would avoid the internals entirely -- but it reports neither the CONTAINER nor
// the STREAM COUNT, and both are part of what C1's contract checks. Remotion also ships
// `npx remotion ffprobe`, which is documented and stable but pays a full CLI bootstrap per call and
// still gives no programmatic path. So the honest answer is: no stable public API exposes the binary,
// the internal accessor is the best available route, and the fallback below is what makes that
// acceptable rather than fragile.

export type FfprobeResolution = {
  executable: string;
  // How it was found, so a report can say which route answered rather than just naming a path.
  source: "remotion-internals" | "path-fallback" | "explicit";
};

// Resolution order, each step a deliberate choice:
//
//   1. FFPROBE_PATH, if set. An operator override always wins -- it is the escape hatch for a host
//      where neither of the other two work, and it means a packaging problem never becomes a code
//      change.
//   2. Remotion's bundled binary. Preferred because a machine that can render can necessarily probe:
//      no extra install, and the ffprobe version is the one that shipped with the encoder that wrote
//      the file.
//   3. "ffprobe" on PATH. The fallback that turns an internal-API break into a degraded-but-working
//      state instead of a dead validation path.
export async function resolveFfprobe(explicitPath?: string): Promise<FfprobeResolution> {
  const override = explicitPath ?? process.env.FFPROBE_PATH;
  if (override && existsSync(override)) {
    return { executable: override, source: "explicit" };
  }

  try {
    const { RenderInternals } = await import("@remotion/renderer");
    const resolved = RenderInternals.getExecutablePath({
      type: "ffprobe",
      indent: false,
      logLevel: "error",
      binariesDirectory: null,
    });
    if (typeof resolved === "string" && existsSync(resolved)) {
      return { executable: resolved, source: "remotion-internals" };
    }
  } catch {
    // Deliberately swallowed. A moved or removed internal accessor must degrade to the PATH fallback,
    // not take the whole validation path down with it.
  }

  return { executable: "ffprobe", source: "path-fallback" };
}

// -i, not a bare positional argument.
//
// C1 passed the file path as the last positional argument. ffprobe parses positionals as the input
// URL, which means a path that begins with "-" is read as an OPTION -- and a path containing a
// protocol prefix is read as a protocol. Neither can happen with the paths this worker builds today
// (they come from buildWorkerRenderPath, which constructs them from database identity), but the
// hardening is cheap and the invariant should not depend on every future caller being careful.
//
// Three things together close it: -i names the argument explicitly, the path is resolved to an
// absolute path first, and a leading "-" is rejected outright rather than escaped.
export const FFPROBE_BASE_ARGS = ["-v", "error", "-print_format", "json", "-show_format", "-show_streams"] as const;

export function buildFfprobeArgs(filePath: string): string[] {
  const absolute = path.resolve(filePath);
  if (absolute.startsWith("-")) {
    throw new Error(`Refusing to probe a path that would be read as an ffprobe option: ${absolute}`);
  }
  return [...FFPROBE_BASE_ARGS, "-i", absolute];
}

export type RuntimeProbeResult = ProbeResult & { executable: string; source: FfprobeResolution["source"] };

export async function probeVideoFile(filePath: string, options: { ffprobePath?: string } = {}): Promise<RuntimeProbeResult> {
  const resolution = await resolveFfprobe(options.ffprobePath);
  const base = { executable: resolution.executable, source: resolution.source };

  if (!existsSync(filePath)) {
    return { ok: false, reason: "missing-file", message: `No file exists at ${filePath}.`, ...base };
  }

  let args: string[];
  try {
    args = buildFfprobeArgs(filePath);
  } catch (err) {
    return { ok: false, reason: "probe-failed", message: err instanceof Error ? err.message : String(err), ...base };
  }

  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(resolution.executable, args, { maxBuffer: 8 * 1024 * 1024 }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // ENOENT means no probe was reachable at all, which demands a different response from an
    // otherwise-working probe rejecting a file: resolve or install a binary, rather than fix the
    // video. Worth distinguishing precisely because the PATH fallback makes ENOENT a real outcome.
    const reason = message.includes("ENOENT") ? ("probe-unavailable" as const) : ("probe-failed" as const);
    return { ok: false, reason, message: `${resolution.executable}: ${message}`, ...base };
  }

  return { ...parseFfprobeJson(stdout, statSync(filePath).size), ...base };
}
