import { rm } from "node:fs/promises";

import {
  failRunningAssetJob,
  listQueuedAssetJobs,
  runAssetJobWithExecutors,
  type AssetJobExecutionClient,
  type AssetJobRecord,
  type AssetJobRunnerResult,
} from "../lib/asset-jobs.ts";
import { isAssetWorkerExecutable } from "../lib/asset-worker-activation.ts";
import { buildRemotionAssetExecutor, cleanupRenderArtifacts, workerRenderDirectory } from "./asset-job-executor.ts";
import { bundleRemotionProductionModule } from "./render.ts";

// Production MVP Wave C2A -- the long-running Remotion worker loop.
//
// EXECUTION HOST vs DOMAIN CONTRACT. This file is the first executor host, and deliberately the only
// place that knows it is one. It holds a bundle, a scratch root and a polling interval; the Asset Job
// contract holds none of those. Moving this process to a Linux container or a managed worker means
// re-instantiating this loop with different option values -- no job payload, no RPC, no table and no
// spec changes. That is the whole reason the loop takes a client rather than constructing one.
//
// IT DOES NOT INVENT A QUEUE. Polling, claiming, running and finishing all go through the existing
// claim_asset_job_with_attempt / finish_asset_job / finish_asset_job_attempt lifecycle via
// runAssetJobWithExecutors. There is no second attempt system, no worker-side state file, and no
// lease table.

export type RemotionWorkerOptions = {
  scratchRoot: string;
  brandMark: string;
  pollIntervalMs?: number;
  // Per-job execution budget. Generous compared with the web path's 45s because this process has no
  // platform ceiling above it: a measured warm-open render is ~8s, and 10 minutes leaves room for a
  // longer composition or a loaded machine without ever being mistaken for "no timeout at all".
  timeoutMs?: number;
  ffprobePath?: string;
  keepRenderArtifacts?: boolean;
  log?: (line: string) => void;
  // Injectable so tests do not have to wait in real time.
  sleep?: (ms: number) => Promise<void>;
  // Injectable for the same reason as `sleep`, and used the same way: the loop builds its own
  // RemotionBundleHost, and a test of LOOP behaviour must not be forced to run webpack to reach it.
  // Defaults to the real bundler; nothing in production passes it.
  bundleBuild?: () => Promise<string>;
};

export const DEFAULT_WORKER_POLL_INTERVAL_MS = 5_000;
export const DEFAULT_WORKER_TIMEOUT_MS = 10 * 60 * 1000;

// Structured, so a caller can log or assert on transitions without parsing prose.
export type RemotionWorkerEvent =
  | { kind: "poll"; queued: number }
  | { kind: "skipped"; jobId: string; workerType: string; assetKind: string; reason: string }
  | { kind: "claimed"; jobId: string; workerType: string; assetKind: string }
  | { kind: "rendered"; jobId: string; outputPath: string; fileSizeBytes: number; renderDurationMs: number; durationInFrames: number }
  | { kind: "warning"; jobId: string; warning: string }
  | { kind: "completed"; jobId: string; assetId: string; attemptNumber: number }
  | { kind: "failed"; jobId: string; reason: string; message: string }
  | { kind: "cleaned"; jobId: string; directory: string; ok: boolean };

export type RemotionWorkerJobOutcome = {
  jobId: string;
  result: AssetJobRunnerResult;
  events: RemotionWorkerEvent[];
};

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- bundle lifecycle -------------------------------------------------------------------------------
//
// ONE BUNDLE PER WORKER PROCESS, built lazily on the first job that needs it and reused for every
// job afterwards. C1's harness bundled per invocation, which was correct for a one-shot CLI and is
// exactly wrong for a daemon: bundle() writes a fresh directory under the OS temp root every time,
// and a long-running process doing that per job grows an unbounded pile of ~10 MB directories that
// nothing ever removes. C1's own report listed it as a C2 blocker.
//
// Lazy rather than eager so a worker that never sees a Remotion job never pays for webpack at all --
// which is the normal case for a process that also handles image workers.
//
// Disposed on clean shutdown. A hard kill leaves one directory behind, in the OS temp root, which the
// OS is entitled to clean; that is a bounded leak of exactly one directory per killed process rather
// than one per job.
export class RemotionBundleHost {
  #serveUrl: string | null = null;
  #building: Promise<string> | null = null;
  readonly #build: () => Promise<string>;

  // The builder is injectable and defaults to the real one. Not a general-purpose seam: it exists so
  // the CACHING behaviour can be tested without running webpack, which is the only way a test of
  // "one bundle per process" can be honest -- stubbing serveUrl() itself would test nothing.
  constructor(build: () => Promise<string> = bundleRemotionProductionModule) {
    this.#build = build;
  }

  async serveUrl(): Promise<string> {
    if (this.#serveUrl) {
      return this.#serveUrl;
    }
    // The in-flight promise is cached, not just the result: two jobs arriving together must produce
    // one bundle, not two. The loop is serial today, so this is defensive rather than load-bearing --
    // and it is the kind of defence that costs one line and saves a duplicated 10 MB build the day
    // the loop stops being serial.
    this.#building ??= this.#build().then((url) => {
      this.#serveUrl = url;
      this.#building = null;
      return url;
    });
    return this.#building;
  }

  get current(): string | null {
    return this.#serveUrl;
  }

  async dispose(): Promise<void> {
    const serveUrl = this.#serveUrl;
    this.#serveUrl = null;
    this.#building = null;
    if (!serveUrl) {
      return;
    }
    // bundle() returns a filesystem path for a local bundle. Guarded anyway: if a future Remotion
    // returns a real URL, there is nothing on disk to remove and this must not throw.
    if (/^[a-z]+:\/\//i.test(serveUrl)) {
      return;
    }
    await rm(serveUrl, { recursive: true, force: true }).catch(() => undefined);
  }
}

// --- one job ------------------------------------------------------------------------------------------

export async function executeRemotionAssetJob(
  client: AssetJobExecutionClient,
  job: AssetJobRecord,
  bundleHost: RemotionBundleHost,
  options: RemotionWorkerOptions,
): Promise<RemotionWorkerJobOutcome> {
  const events: RemotionWorkerEvent[] = [];
  const record = (event: RemotionWorkerEvent) => {
    events.push(event);
    options.log?.(formatWorkerEvent(event));
  };

  const serveUrl = await bundleHost.serveUrl();

  const executor = buildRemotionAssetExecutor({
    scratchRoot: options.scratchRoot,
    serveUrl,
    brandMark: options.brandMark,
    ffprobePath: options.ffprobePath,
    onWarning: (warning) => record({ kind: "warning", jobId: job.id, warning }),
    onRenderComplete: (result) =>
      record({
        kind: "rendered",
        jobId: job.id,
        outputPath: result.outputPath,
        fileSizeBytes: result.fileSizeBytes,
        renderDurationMs: result.renderDurationMs,
        durationInFrames: result.durationInFrames,
      }),
  });

  // The claim happens INSIDE runAssetJobWithExecutors, atomically, together with the attempt insert.
  // The worker never sets status itself, which is what stops two workers from both believing they
  // own the same job.
  const result = await runAssetJobWithExecutors(client, job.id, { remotion: executor }, { timeoutMs: options.timeoutMs ?? DEFAULT_WORKER_TIMEOUT_MS });

  // attemptCount on the claimed job is the attempt number the executor built its path from; fall
  // back to the pre-claim value only if the runner returned no job at all (a not-found race).
  const attemptNumber = result.job?.attemptCount ?? job.attemptCount + 1;

  if (result.ok) {
    record({ kind: "completed", jobId: job.id, assetId: result.materialization?.ok ? result.materialization.materialized.asset.id : "", attemptNumber });
  } else {
    record({ kind: "failed", jobId: job.id, reason: result.reason, message: result.message });
  }

  // AFTER the terminal state is recorded, never before. See cleanupRenderArtifacts' own note: a
  // render whose materialization failed is the one case where the local MP4 is the only evidence,
  // so it survives until the failure itself is durable.
  //
  // GUARDED ON attemptNumber >= 1, and the guard is not theoretical -- the P1-3 regression test found
  // this crash. When a CLAIM fails (another worker won the race), the runner re-reads the row and
  // returns it with its pre-claim attemptCount of 0. Cleanup then asked for "attempt-0", and
  // buildWorkerRenderPath correctly refuses a non-positive attempt number by throwing -- which
  // escaped executeRemotionAssetJob and took the whole worker loop down on every lost claim.
  //
  // Skipping is the right answer rather than clamping to 1: if the claim never succeeded, this
  // process never rendered anything, so there is no attempt directory of ours to remove and inventing
  // a path to delete would be worse than doing nothing.
  if (!options.keepRenderArtifacts && attemptNumber >= 1) {
    const directory = workerRenderDirectory(options.scratchRoot, job.id, attemptNumber);
    const cleanup = await cleanupRenderArtifacts(directory);
    record({ kind: "cleaned", jobId: job.id, directory, ok: cleanup.ok });
  }

  return { jobId: job.id, result, events };
}

// --- the loop -------------------------------------------------------------------------------------------

export type RemotionWorkerRunState = {
  stopped: boolean;
};

// Polls for ONE claimable job at a time and runs it to a terminal state before polling again.
//
// Serial on purpose. A parallel worker would need a lease to stop two renders sharing a scratch
// directory and a bundle, and the schema has no lease column (see the recovery note in the worker
// CLI). One job at a time needs none of that, and a single Windows workstation rendering one 8-second
// composition at a time is not the bottleneck this MVP has.
export async function runRemotionWorkerLoop(
  client: AssetJobExecutionClient,
  options: RemotionWorkerOptions,
  control: { shouldStop: () => boolean; onIdle?: () => void } = { shouldStop: () => false },
): Promise<{ processed: RemotionWorkerJobOutcome[]; polls: number }> {
  const bundleHost = new RemotionBundleHost(options.bundleBuild);
  const sleep = options.sleep ?? defaultSleep;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_WORKER_POLL_INTERVAL_MS;
  const processed: RemotionWorkerJobOutcome[] = [];
  let polls = 0;

  try {
    while (!control.shouldStop()) {
      polls += 1;
      const queued = await listQueuedAssetJobs(client, 10, "remotion");
      if (!queued.ok) {
        options.log?.(`poll failed: ${queued.message}`);
        await sleep(pollIntervalMs);
        continue;
      }

      options.log?.(formatWorkerEvent({ kind: "poll", queued: queued.jobs.length }));

      // The worker's OWN activation gate, applied before the job is touched. It is the only place
      // short_video is admitted, and it is deliberately not the app's gate -- see
      // asset-worker-activation.ts for why the two sets are separate.
      const claimable = queued.jobs.filter((job) => isAssetWorkerExecutable(job));
      for (const skipped of queued.jobs.filter((job) => !isAssetWorkerExecutable(job))) {
        options.log?.(
          formatWorkerEvent({
            kind: "skipped",
            jobId: skipped.id,
            workerType: skipped.workerType,
            assetKind: skipped.assetKind,
            reason: "not executable by this worker",
          }),
        );
      }

      const [job] = claimable;
      if (!job) {
        control.onIdle?.();
        if (control.shouldStop()) {
          break;
        }
        await sleep(pollIntervalMs);
        continue;
      }

      options.log?.(formatWorkerEvent({ kind: "claimed", jobId: job.id, workerType: job.workerType, assetKind: job.assetKind }));
      const outcome = await executeRemotionAssetJob(client, job, bundleHost, options);
      processed.push(outcome);

      // BACKOFF AFTER AN UNSUCCESSFUL OUTCOME.
      //
      // A successful job falls straight through and the loop polls again immediately, which is right:
      // work was done, and there may be more waiting.
      //
      // A FAILED one must not. The failure modes that matter here are persistent, not transient -- a
      // claim losing a race, a network outage, an unreachable ffprobe, a Creative Package that will
      // never build a spec. Every one of them fails fast, so an immediate repoll produces a tight
      // poll/fail/poll/fail spin that burns CPU, floods the log, and hammers the database for as long
      // as the condition lasts. The job is already terminal by this point, so the spin does not even
      // retry it -- it just re-reads a queue that will hand back the next equally-doomed row.
      //
      // One sleep at the EXISTING poll interval is the whole fix. Deliberately not exponential and
      // deliberately not a retry framework: nothing here re-attempts a job, changes its state, or
      // requeues it. The loop simply declines to spin.
      if (!outcome.result.ok) {
        if (control.shouldStop()) {
          break;
        }
        await sleep(pollIntervalMs);
      }
    }
  } finally {
    await bundleHost.dispose();
  }

  return { processed, polls };
}

// --- crash recovery ------------------------------------------------------------------------------------
//
// THE EXACT SEMANTICS, because this is the part a long-running worker on a workstation actually meets.
//
// There is NO LEASE and NO HEARTBEAT in this schema. claim_asset_job_with_attempt is a single atomic
// UPDATE guarded by `status = 'queued'`, so exactly one claimer can ever win -- but once a job is
// 'running' nothing expires it. Concretely:
//
//   PC OFF                  a queued job stays queued. Nothing claimed it, nothing to recover.
//   WORKER STOPPED CLEANLY  the in-flight job is failed truthfully by the shutdown handler in the CLI.
//   WORKER HARD-KILLED      the job stays 'running' and its attempt stays 'running', forever, with no
//                           process left that intends to finish them. This is the real gap.
//
// recoverStuckRemotionJobs is the DEFINED recovery path for that last case, and it deliberately uses
// only what already exists: finish_asset_job requires status='running', so failRunningAssetJob can
// terminate exactly the rows a crash stranded, with a truthful message. No new table, no new RPC, no
// requeue.
//
// IT FAILS RATHER THAN REQUEUES, and that is a decision worth stating. finish_asset_job can only
// write 'completed' or 'failed'; there is no queued transition, so an automatic retry is not
// expressible without a schema change. Failing is also the honest outcome: the crashed attempt
// produced nothing that was materialized (materialization is the last step before completion), so
// there is no orphaned Asset -- only, possibly, orphaned storage objects if the crash landed between
// upload and completion, which C2B must reconcile before live uploads begin.
export type StuckJobRecovery = {
  jobId: string;
  startedAt: string;
  recovered: boolean;
  message: string;
};

export const DEFAULT_STUCK_JOB_THRESHOLD_MS = 30 * 60 * 1000;

export function isStuckRunningJob(job: AssetJobRecord, now: number, thresholdMs: number): boolean {
  if (job.status !== "running" || !job.startedAt) {
    return false;
  }
  const startedAt = Date.parse(job.startedAt);
  // An unparseable timestamp is NOT treated as stuck. Recovery must never be able to terminate a
  // healthy in-flight job because a clock or a format surprised it.
  return Number.isFinite(startedAt) && now - startedAt > thresholdMs;
}

export async function recoverStuckRemotionJobs(
  client: AssetJobExecutionClient,
  jobs: AssetJobRecord[],
  options: { thresholdMs?: number; now?: number } = {},
): Promise<StuckJobRecovery[]> {
  const thresholdMs = options.thresholdMs ?? DEFAULT_STUCK_JOB_THRESHOLD_MS;
  const now = options.now ?? Date.now();
  const recoveries: StuckJobRecovery[] = [];

  for (const job of jobs) {
    if (!isStuckRunningJob(job, now, thresholdMs)) {
      continue;
    }
    const message = `Asset Job was left running by a worker that did not finish it (started ${job.startedAt}, threshold ${thresholdMs}ms).`;
    const result = await failRunningAssetJob(client, job, message);
    recoveries.push({
      jobId: job.id,
      startedAt: job.startedAt,
      // failRunningAssetJob returns ok:false on SUCCESS by design -- the job did, in fact, fail.
      // "recovered" therefore means the terminal write landed, which is `reason === "failed"`.
      // An ok:true here would mean the RPC reported a completion, and any other reason
      // (conflict/not-found) means the row moved underneath us; neither is a recovery.
      recovered: !result.ok && result.reason === "failed",
      message: result.ok ? "Asset Job reported completed instead of failed during recovery." : result.message,
    });
  }

  return recoveries;
}

export function formatWorkerEvent(event: RemotionWorkerEvent): string {
  switch (event.kind) {
    case "poll":
      return `poll        queued=${event.queued}`;
    case "skipped":
      return `skipped     job=${event.jobId} worker=${event.workerType} kind=${event.assetKind} (${event.reason})`;
    case "claimed":
      return `claimed     job=${event.jobId} worker=${event.workerType} kind=${event.assetKind}`;
    case "rendered":
      return `rendered    job=${event.jobId} frames=${event.durationInFrames} bytes=${event.fileSizeBytes} in ${event.renderDurationMs}ms -> ${event.outputPath}`;
    case "warning":
      return `warning     job=${event.jobId} ${event.warning}`;
    case "completed":
      return `completed   job=${event.jobId} attempt=${event.attemptNumber} asset=${event.assetId}`;
    case "failed":
      return `failed      job=${event.jobId} reason=${event.reason} ${event.message}`;
    case "cleaned":
      return `cleaned     job=${event.jobId} ${event.ok ? "removed" : "COULD NOT REMOVE"} ${event.directory}`;
  }
}
