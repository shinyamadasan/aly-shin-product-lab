import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { REEL_FILE_NAME, type PreparedCampaign } from "./creative-plan.ts";

// Content Studio Fast Mode -- where a Reel gets made.
//
// A Reel needs Chrome and FFmpeg (Remotion). A serverless function has neither, so a Reel can only be
// made on a server that is explicitly marked as able to make one -- in practice the owner's own
// machine running the app, the same machine the Asset Job Remotion worker already runs on. Off by
// default; a host that is not marked says so plainly and the owner UI offers the carousel instead.
//
// The render runs in a CHILD Node process (scripts/content-studio/render-reel.ts), never in the Next
// server chunk: bundling Remotion into a route would fight the same bundler path rewriting that
// forced the fonts to be embedded. One Reel at a time per server, with a hard timeout.

export const CONTENT_STUDIO_REEL_RENDERING_ENV = "CONTENT_STUDIO_REEL_RENDERING";
export const REEL_RENDER_TIMEOUT_MS = 8 * 60 * 1000;

const RENDER_SCRIPT = path.join("scripts", "content-studio", "render-reel.ts");

export function reelRenderingAvailable(env: Record<string, string | undefined> = process.env, cwd = process.cwd()): boolean {
  return env[CONTENT_STUDIO_REEL_RENDERING_ENV] === "1" && existsSync(path.join(cwd, RENDER_SCRIPT));
}

export type ReelHostResult =
  | { ok: true; mp4: Uint8Array }
  | { ok: false; reason: "busy" | "invalid-output" | "failed"; issues: string[] };

let rendering = false;

export async function renderReelOnHost(campaign: PreparedCampaign, cwd = process.cwd()): Promise<ReelHostResult> {
  if (rendering) return { ok: false, reason: "busy", issues: ["Another Reel is being made."] };
  rendering = true;
  const workDir = await mkdtemp(path.join(os.tmpdir(), "fast-mode-reel-"));
  try {
    const input = path.join(workDir, "campaign.json");
    const output = path.join(workDir, REEL_FILE_NAME);
    await writeFile(input, JSON.stringify(campaign), "utf8");

    const stdout = await new Promise<string>((resolve) => {
      execFile(
        process.execPath,
        [path.join(cwd, RENDER_SCRIPT), "--input", input, "--output", output],
        { cwd, timeout: REEL_RENDER_TIMEOUT_MS, killSignal: "SIGKILL", maxBuffer: 16 * 1024 * 1024 },
        (_error, out) => resolve(String(out ?? "")),
      );
    });

    const last = stdout.trim().split("\n").pop() ?? "";
    let parsed: { ok?: boolean; kind?: string; issues?: string[] } = {};
    try {
      parsed = JSON.parse(last);
    } catch {
      return { ok: false, reason: "failed", issues: ["The Reel process ended without a result (it may have timed out)."] };
    }
    if (parsed.ok !== true) {
      return { ok: false, reason: parsed.kind === "invalid-output" ? "invalid-output" : "failed", issues: parsed.issues ?? [] };
    }
    return { ok: true, mp4: new Uint8Array(await readFile(output)) };
  } finally {
    rendering = false;
    await rm(workDir, { recursive: true, force: true });
  }
}
