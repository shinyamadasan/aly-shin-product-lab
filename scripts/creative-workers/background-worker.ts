import { readFileSync } from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

import { listQueuedCreativeJobs } from "../../src/lib/creative-jobs.ts";
import type { CreativePackageMaterializedRunResult, CreativePackageRunnerClient } from "../../src/lib/creative-packages.ts";
import { loadEnvFile, readSupabaseCredentials } from "../daily-advisor/env.ts";
import { acquireLock } from "../daily-advisor/lock.ts";
import { createTrustedCreativeAiExecutor } from "./creative-ai-worker.ts";
import { runTrustedCreativeJobAndMaterializePackage, trustedCreativeJobExecutors } from "./runner.ts";

// Content Creation MVP S3D -- the local background worker for queued creative_ai Creative Jobs.
//
// This changes NOTHING about how a job executes. The claim, the AI execution, the routing, the
// retries, the persistence and the package materialization are all the already-proven S3E-A2 path;
// this file only decides WHEN to invoke it and makes it safe to invoke on a timer.
//
//   Task Scheduler (~1/min) -> this one-shot process -> lock -> at most one job -> exit
//
// Deliberately NOT a daemon. No while(true), no Windows Service, no PM2, no listener. A short-lived
// process that exits is what makes crashes and code updates uneventful: nothing to restart, nothing
// holding stale code in memory, and a machine that is off simply does not run it.

export const CREATIVE_AI_WORKER_TASK_NAME = "Aly & Shin Product Lab Creative AI Worker";

// One job per scheduled run. The AI is subscription-backed and local: draining a queue would fire
// several expensive generations back to back and spike quota for no MVP benefit. At a one-minute
// cadence a backlog still drains steadily, one job at a time, which is the right shape for an
// owner-operated tool.
export const CREATIVE_AI_WORKER_MAX_JOBS_PER_RUN = 1;

// Comfortably longer than the 15-minute creative_ai outer executor ceiling, so a healthy long run is
// never mistaken for a dead one, while a genuinely crashed worker is recovered in well under an
// hour rather than blocking generation until someone notices. Deliberately shorter than the shared
// default (60 min), because this worker runs every minute and an hour-long dead lock would silently
// disable content generation for an hour.
//
// The age threshold is the backstop, not the primary mechanism: acquireLock also treats a lock whose
// recorded PID is no longer alive as stale, so an ordinary crash is recovered on the very next run.
export const CREATIVE_AI_WORKER_STALE_LOCK_MS = 30 * 60 * 1000;

// The repository this worker is allowed to act on. Read from package.json rather than compared
// against an absolute path, so it stays correct in a worktree, a clone, or another checkout -- and
// still fails loudly if the process was launched from the wrong project entirely (the Time-audit
// repository sitting one directory up is a real, previously-hit mistake, and it has its own
// package.json with a different name).
export const CREATIVE_AI_WORKER_EXPECTED_PACKAGE_NAME = "aly-shin-product-lab";

export type CreativeAiWorkerClient = CreativePackageRunnerClient;

export type ProcessedJob = {
  jobId: string;
  // What the RUNNER reported. A job that honestly failed is a completed unit of worker work, not a
  // worker error -- the worker's job is to invoke execution, not to make it succeed.
  outcome: "completed" | "failed";
  message?: string;
  durationMs: number;
};

export type CreativeAiWorkerResult = {
  queuedFound: number;
  processed: ProcessedJob[];
  // "no-op"     -- nothing was queued
  // "processed" -- at least one job was executed, whatever its own outcome
  // "failed"    -- INFRASTRUCTURE failure (queue unreadable, bad identity, missing credentials)
  outcome: "no-op" | "processed" | "failed";
  reason?: string;
};

export type CreativeAiWorkerOptions = {
  maxJobs?: number;
  // Injection seam. Defaults to the real trusted runner with the real creative_ai executor; tests
  // substitute a deterministic stand-in so no CLI is ever spawned and no AI usage is spent.
  runJob?: (client: CreativeAiWorkerClient, jobId: string) => Promise<CreativePackageMaterializedRunResult>;
  now?: () => number;
};

export type RepositoryIdentityResult = { ok: true; name: string } | { ok: false; message: string };

// Cheap and deterministic: read the package.json next to this script's own project root and check
// its name. Runs BEFORE any Supabase call, so a worker pointed at the wrong project never touches
// the database at all.
export function verifyRepositoryIdentity(projectRoot: string, expectedName = CREATIVE_AI_WORKER_EXPECTED_PACKAGE_NAME): RepositoryIdentityResult {
  let name: unknown;
  try {
    name = (JSON.parse(readFileSync(path.join(projectRoot, "package.json"), "utf8")) as { name?: unknown }).name;
  } catch (err) {
    return {
      ok: false,
      message: `Could not read package.json at ${projectRoot} to confirm this is the ${expectedName} repository: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (name !== expectedName) {
    return {
      ok: false,
      message: `Refusing to run: ${projectRoot} is package "${String(name)}", not "${expectedName}". The Creative AI worker must run from the Product Lab repository.`,
    };
  }

  return { ok: true, name: expectedName };
}

async function runJobWithRealExecutor(client: CreativeAiWorkerClient, jobId: string): Promise<CreativePackageMaterializedRunResult> {
  // The real S3E-A2 path, unchanged: real providers, real S3A grounding, real S3C-D routing, real
  // v2 persistence and package materialization. This worker adds nothing to it.
  const creativeAi = createTrustedCreativeAiExecutor(client);
  return runTrustedCreativeJobAndMaterializePackage(client, jobId, { executors: trustedCreativeJobExecutors({ creativeAi }) });
}

// Reads only queued creative_ai jobs (listQueuedCreativeJobs filters on both status and worker
// type), then executes them ONE AT A TIME. The serial `for` loop is the point: two concurrent
// generations would contend for the same local subscription session and double the quota burst for
// no benefit. There is deliberately no Promise.all anywhere in this function.
export async function processCreativeAiQueue(client: CreativeAiWorkerClient, options: CreativeAiWorkerOptions = {}): Promise<CreativeAiWorkerResult> {
  const maxJobs = options.maxJobs ?? CREATIVE_AI_WORKER_MAX_JOBS_PER_RUN;
  const runJob = options.runJob ?? runJobWithRealExecutor;
  const now = options.now ?? Date.now;

  const queued = await listQueuedCreativeJobs(client, maxJobs, "creative_ai");
  if (!queued.ok) {
    return { queuedFound: 0, processed: [], outcome: "failed", reason: queued.message };
  }
  if (queued.jobs.length === 0) {
    return { queuedFound: 0, processed: [], outcome: "no-op", reason: "No queued creative_ai Creative Job." };
  }

  const processed: ProcessedJob[] = [];
  for (const job of queued.jobs) {
    const startedAt = now();
    const result = await runJob(client, job.id);
    processed.push({
      jobId: job.id,
      outcome: result.ok ? "completed" : "failed",
      // Already bounded and operator-safe by the runner's own sanitizer. No prompt, model output,
      // provider stdout/stderr or credential can reach here.
      message: result.ok ? undefined : result.message,
      durationMs: now() - startedAt,
    });
  }

  // A job that failed is not a worker failure. The runner already persisted the failure honestly
  // (status, bounded error, execution trace), and nothing here requeues it, retries the AI, or
  // touches provider behaviour -- that is S3C-D's and the job's own business. If the job is no
  // longer queued, the next scheduled run simply will not see it.
  return { queuedFound: queued.jobs.length, processed, outcome: "processed" };
}

function log(level: "info" | "error", message: string): void {
  const timestamp = new Date().toISOString();
  console[level === "error" ? "error" : "log"](`[${timestamp}] [${level.toUpperCase()}] [creative-ai-worker] ${message}`);
}

export type CreativeAiWorkerCliOptions = {
  projectRoot: string;
  lockPath: string;
  envPath: string;
  createClient: () => Promise<{ ok: true; client: CreativeAiWorkerClient } | { ok: false; exitCode: number; message: string }>;
  maxJobs?: number;
  runJob?: CreativeAiWorkerOptions["runJob"];
  staleLockMs?: number;
  now?: () => number;
};

export type CreativeAiWorkerCliResult = { exitCode: number; result?: CreativeAiWorkerResult; skipped?: "locked" };

// EXIT CODES
//   0  worker ran normally -- including "nothing queued", including "another run holds the lock",
//      and including "the job itself failed and was honestly persisted as failed".
//   1  infrastructure failure (queue unreadable, sign-in failed, unexpected crash).
//   2  preflight abort (wrong repository, missing Supabase credentials).
//
// A held lock exits 0 ON PURPOSE, departing from creative-prep's exit 3. That script runs nightly,
// where an overlap is genuinely notable. This one runs every minute against generations that take
// tens of seconds, so overlaps are routine and expected -- reporting each as a task failure would
// fill Task Scheduler's history with red every single day and train the owner to ignore it. A
// skipped run is a correct outcome here, not an error, and the log line still records it.
export async function runCreativeAiWorkerCli(options: CreativeAiWorkerCliOptions): Promise<CreativeAiWorkerCliResult> {
  const startedAt = options.now?.() ?? Date.now();
  log("info", "worker started");

  // Identity first, before the lock and before any credential or network access.
  const identity = verifyRepositoryIdentity(options.projectRoot);
  if (!identity.ok) {
    log("error", identity.message);
    return { exitCode: 2 };
  }

  const lock = acquireLock(options.lockPath, { staleAfterMs: options.staleLockMs ?? CREATIVE_AI_WORKER_STALE_LOCK_MS });
  if (!lock.ok) {
    log("info", `lock skipped: ${lock.reason}`);
    return { exitCode: 0, skipped: "locked" };
  }
  log("info", "lock acquired");

  try {
    loadEnvFile(options.envPath);

    const clientResult = await options.createClient();
    if (!clientResult.ok) {
      log("error", clientResult.message);
      return { exitCode: clientResult.exitCode };
    }

    const result = await processCreativeAiQueue(clientResult.client, { maxJobs: options.maxJobs, runJob: options.runJob, now: options.now });
    const durationMs = (options.now?.() ?? Date.now()) - startedAt;

    if (result.outcome === "failed") {
      log("error", `infrastructure failure after ${durationMs}ms: ${result.reason}`);
      return { exitCode: 1, result };
    }

    log("info", `queued creative_ai jobs found: ${result.queuedFound}`);
    for (const job of result.processed) {
      log("info", `job ${job.jobId} -> ${job.outcome} in ${job.durationMs}ms${job.outcome === "failed" ? ` (${job.message})` : ""}`);
    }
    log("info", `worker finished in ${durationMs}ms (${result.outcome})`);
    return { exitCode: 0, result };
  } catch (err) {
    // Caught so the lock is always released by the finally below, and so an unexpected crash is
    // reported as an infrastructure failure rather than a silent non-zero exit.
    log("error", `unexpected worker failure: ${err instanceof Error ? err.message : String(err)}`);
    return { exitCode: 1 };
  } finally {
    lock.release();
    log("info", "lock released");
  }
}

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..", "..");

async function createRealClient(): Promise<{ ok: true; client: CreativeAiWorkerClient } | { ok: false; exitCode: number; message: string }> {
  const credsResult = readSupabaseCredentials();
  if (!credsResult.ok) {
    return { ok: false, exitCode: 2, message: `Missing required Supabase credentials in .env.advisor.local: ${credsResult.missing.join(", ")}` };
  }
  const client = createClient(credsResult.credentials.url, credsResult.credentials.anonKey);
  const signIn = await client.auth.signInWithPassword({ email: credsResult.credentials.email, password: credsResult.credentials.password });
  if (signIn.error) {
    return { ok: false, exitCode: 1, message: `Supabase sign-in failed: ${signIn.error.message}` };
  }
  return { ok: true, client: client as unknown as CreativeAiWorkerClient };
}

async function main(): Promise<void> {
  const { exitCode } = await runCreativeAiWorkerCli({
    projectRoot: PROJECT_ROOT,
    lockPath: path.join(PROJECT_ROOT, "creative-ai-worker", ".run.lock"),
    // The same credential file every other scheduled script in this repo already uses. No new
    // secret store, and nothing secret is ever passed as an argument or written to a log.
    envPath: path.join(PROJECT_ROOT, ".env.advisor.local"),
    createClient: createRealClient,
  });

  process.exit(exitCode);
}

// Guard so tests can import runCreativeAiWorkerCli/processCreativeAiQueue without triggering a real
// run as a side effect of import -- same convention as creative-prep/run.ts.
const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename);
if (isMainModule) {
  main().catch((err) => {
    log("error", `Unhandled error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    process.exit(1);
  });
}
