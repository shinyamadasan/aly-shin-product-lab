import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type LockInfo = { pid: number; startedAt: string };

export type AcquireLockResult = { ok: true; release: () => void } | { ok: false; reason: string };

// Comfortably above worst-case runtime (Claude's own timeout is 45s, Supabase reads take
// seconds, git retries take at most a few seconds each) while still recovering promptly from a
// genuinely abandoned lock (a crashed prior run) rather than blocking every future run forever.
//
// The DEFAULT, kept exactly as it was for the daily-advisor and creative-prep callers that have
// always relied on it. A caller whose worst case is materially different may pass its own
// threshold to acquireLock -- see the Creative AI background worker, which runs on a one-minute
// cadence and so wants a dead lock recovered sooner than an hour.
const STALE_AFTER_MS = 60 * 60 * 1000;

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0: existence check only, never actually sent
    return true;
  } catch {
    return false;
  }
}

function readLockInfo(lockPath: string): LockInfo | null {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, "utf8"));
    if (typeof parsed.pid === "number" && typeof parsed.startedAt === "string") {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

function isStale(info: LockInfo | null, staleAfterMs: number): boolean {
  if (!info) {
    return true; // missing or malformed lock file -- never block forever on a file we can't read
  }
  const age = Date.now() - Date.parse(info.startedAt);
  if (!Number.isFinite(age) || age > staleAfterMs) {
    return true;
  }
  return !isProcessAlive(info.pid);
}

// Single-instance lock covering the whole run (generation, and -- via daily-advisor.ps1 holding
// this same lock across both phases -- publication too). Never bypassable by --force: run.ts
// checks this unconditionally before ever consulting the --force flag, which only ever affects
// the separate same-day idempotency check. Stale locks (dead PID, or older than STALE_AFTER_MS)
// are recovered automatically rather than requiring manual cleanup after a crash.
export function acquireLock(lockPath: string, options: { staleAfterMs?: number } = {}): AcquireLockResult {
  const staleAfterMs = options.staleAfterMs ?? STALE_AFTER_MS;
  // The lock file's directory may not exist yet on a fresh checkout or a brand-new scheduled
  // script's first-ever run (found while verifying creative-prep against real Supabase: its
  // parent directory had never been created, and the wx-flag ENOENT below was misreported as
  // "lost a race acquiring the lock"). Safe to call unconditionally -- recursive mkdir on an
  // already-existing directory is a no-op.
  mkdirSync(dirname(lockPath), { recursive: true });

  if (existsSync(lockPath)) {
    const info = readLockInfo(lockPath);
    if (!isStale(info, staleAfterMs)) {
      return { ok: false, reason: `Another instance is already running (pid ${info?.pid}, started ${info?.startedAt}).` };
    }
    try {
      unlinkSync(lockPath);
    } catch {
      // Another process may have already cleaned it up between our check and now -- fine.
    }
  }

  try {
    // wx: exclusive create, fails with EEXIST if the file already exists -- the atomic
    // test-and-set that makes this safe against two processes racing to acquire simultaneously.
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() } satisfies LockInfo), { flag: "wx" });
  } catch (err) {
    return { ok: false, reason: `Lost a race acquiring the lock (${err instanceof Error ? err.message : String(err)}) -- a concurrent run.` };
  }

  return {
    ok: true,
    release: () => {
      try {
        if (readLockInfo(lockPath)?.pid === process.pid) {
          unlinkSync(lockPath);
        }
      } catch {
        // Best-effort: a missing lock file at release time is not an error.
      }
    },
  };
}
