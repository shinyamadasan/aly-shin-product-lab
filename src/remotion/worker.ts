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
import { buildGeneratedAssetAttemptPrefix, GENERATED_ASSETS_BUCKET } from "../lib/asset-binary.ts";
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
  // Wave C2B-2 -- a WORKER-level failure, distinct from a JOB-level one. "failed" means a job reached
  // a truthful terminal state; this means the worker could not get far enough to give it one. Keeping
  // them apart is what stops an infrastructure outage reading like a content problem in the log.
  | { kind: "worker-failure"; jobId: string; message: string }
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
    //
    // Wave C2B-2 -- A REJECTED BUILD NO LONGER POISONS THE HOST.
    //
    // The previous form was `this.#building ??= this.#build().then(...)`. When the build REJECTED,
    // #building kept holding that rejected promise: `??=` never reassigns a non-null field, so every
    // later caller -- for the rest of the process's life -- awaited the same settled rejection. One
    // transient webpack failure (a locked file, a momentary out-of-memory, an antivirus scanner
    // holding a handle) permanently bricked a daemon that was otherwise perfectly healthy.
    //
    // The fix is to clear the in-flight slot on BOTH settlement paths. On success the resolved URL is
    // cached and reused forever; on failure nothing is cached at all, so the NEXT caller starts a
    // genuinely fresh build. Concurrent first callers still share the single in-flight promise,
    // because the slot is only cleared once that promise has settled -- which is the property the
    // dedup depends on and the one a naive `catch` that reset eagerly would have broken.
    if (!this.#building) {
      const building = this.#build().then(
        (url) => {
          this.#serveUrl = url;
          this.#building = null;
          return url;
        },
        (err: unknown) => {
          // Cleared, and #serveUrl is deliberately NOT written. A failed build must never leave a
          // stale or partial serveUrl behind for a later job to render against.
          this.#building = null;
          throw err;
        },
      );
      this.#building = building;
    }
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

  // Bundle FIRST, and the "claimed" line is emitted only once it is in hand.
  //
  // Wave C2B-2 moved this log out of the polling loop, where it fired BEFORE the bundle resolved: a
  // bundle failure then printed "claimed job=X" for a job that was never claimed and never would be.
  // In a wave about truthful operational behaviour, a log line that lies during an incident is
  // exactly the wrong thing to leave in place.
  //
  // It still precedes the ATOMIC claim, which happens inside runAssetJobWithExecutors below -- so a
  // lost claim race is reported afterwards as `failed reason=not-queued`, and that remains the honest
  // sequence rather than something this log can pre-empt.
  const serveUrl = await bundleHost.serveUrl();
  record({ kind: "claimed", jobId: job.id, workerType: job.workerType, assetKind: job.assetKind });

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
): Promise<{ processed: RemotionWorkerJobOutcome[]; polls: number; workerFailures: Array<{ jobId: string; message: string }> }> {
  const bundleHost = new RemotionBundleHost(options.bundleBuild);
  const sleep = options.sleep ?? defaultSleep;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_WORKER_POLL_INTERVAL_MS;
  const processed: RemotionWorkerJobOutcome[] = [];
  // Surfaced in the return value, not merely logged: a caller (the CLI, a test) must be able to see
  // that cycles failed at the worker level even though no job outcome was produced.
  const workerFailures: Array<{ jobId: string; message: string }> = [];
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

      // --- the per-JOB error boundary ------------------------------------------------------------
      //
      // Wave C2B-2. Deliberately wrapped around ONE job's work and nothing else -- not the whole
      // loop, not the whole process. A `try { forever } catch { ignore }` would keep the daemon alive
      // by making every bug invisible, which is worse than crashing; this catches the work for a
      // single cycle, reports it as a named worker-level failure, backs off, and lets the next poll
      // decide for itself.
      //
      // WHAT THIS ACTUALLY PROTECTS AGAINST, measured rather than imagined: bundleHost.serveUrl()
      // runs inside executeRemotionAssetJob and can reject (webpack failure, a locked file, an
      // out-of-memory). Before this boundary that rejection propagated straight out of
      // runRemotionWorkerLoop and terminated the process -- a transient infrastructure failure
      // killing a worker that was otherwise healthy.
      //
      // NO JOB IS FALSELY COMPLETED HERE. The catch records a worker-level failure and pushes no
      // outcome, because there is no truthful job outcome to push: see the claim-ordering note below
      // for why the job's own state is already correct without this code touching it.
      let outcome: RemotionWorkerJobOutcome;
      try {
        outcome = await executeRemotionAssetJob(client, job, bundleHost, options);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        options.log?.(formatWorkerEvent({ kind: "worker-failure", jobId: job.id, message }));
        workerFailures.push({ jobId: job.id, message });

        // CLAIM ORDERING, and it is why this branch does not touch the job at all.
        //
        // executeRemotionAssetJob resolves the bundle BEFORE calling runAssetJobWithExecutors, and
        // the claim happens inside that runner. So anything that throws out of it -- which in
        // practice means the bundle -- threw BEFORE the atomic claim, and the job is therefore still
        // exactly what it was: QUEUED. Nothing was claimed, so nothing needs terminalizing, and
        // marking it failed here would be inventing a failure the job never had.
        //
        // Once the claim succeeds, runAssetJobWithExecutors owns every path to a terminal state and
        // returns an outcome rather than throwing. That is the property this branch relies on, and
        // tests/remotion-worker-hardening.test.ts pins it so a future change to that ordering cannot
        // silently make this comment wrong.
        if (control.shouldStop()) {
          break;
        }
        await sleep(pollIntervalMs);
        continue;
      }

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

  return { processed, polls, workerFailures };
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
export type OrphanReconciliation =
  | { attempted: false; reason: "listing-unavailable"; message: string }
  | { attempted: true; prefix: string; found: string[]; removed: string[]; failed: string[]; message: string };

export type StuckJobRecovery = {
  jobId: string;
  attemptNumber: number;
  startedAt: string;
  recovered: boolean;
  message: string;
  reconciliation?: OrphanReconciliation;
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

// --- orphan storage reconciliation -------------------------------------------------------------------
//
// THE SAFETY PROOF, and it comes from a transaction boundary rather than from a convention.
//
// materializeAssetJobFiles uploads every object FIRST, then makes exactly ONE database call:
// complete_asset_job_with_files. That function is plpgsql, so it is one transaction, and inside it it
// inserts the Asset, inserts the Asset Files, AND flips the job to 'completed' -- all or nothing.
//
// Therefore a job whose status is still 'running' has NO Asset row and NO Asset File rows. There is
// no window in which those exist while the job is not terminal, because one commit produces both.
// And every object an attempt uploads lives under a prefix derivable from job identity alone
// (buildGeneratedAssetAttemptPrefix). Put together:
//
//   job.status === 'running'  =>  nothing under asset-jobs/<jobId>/attempt-<n>/ is a durable artifact
//
// That is what makes reconciliation possible with NO schema change and no new tracking table: the
// durable fact needed to identify an orphan already exists, in the job row plus the path convention.
//
// WHAT IS DELIBERATELY NOT DONE. Nothing here matches on age alone, on a path merely resembling a job
// id, or on a job being failed. It reconciles exactly one prefix, belonging to exactly one job that is
// provably still running and provably stale, and it removes only the object names the storage layer
// itself returned under that prefix.
const ORPHAN_LISTING_LIMIT = 100;

export async function reconcileOrphanObjectsForJob(client: AssetJobExecutionClient, job: AssetJobRecord): Promise<OrphanReconciliation> {
  const bucket = client.storage.from(GENERATED_ASSETS_BUCKET);
  if (typeof bucket.list !== "function") {
    // A NAMED outcome, never a silent no-op. A client that cannot enumerate cannot be reconciled, and
    // an operator must not read an empty report as "nothing to clean".
    return { attempted: false, reason: "listing-unavailable", message: "This storage client cannot list objects, so orphans could not be enumerated." };
  }

  const prefix = buildGeneratedAssetAttemptPrefix({ assetJobId: job.id, attemptNumber: job.attemptCount });
  const listed = await bucket.list(prefix, { limit: ORPHAN_LISTING_LIMIT });
  if (listed.error) {
    return { attempted: true, prefix, found: [], removed: [], failed: [], message: `Could not list ${prefix}: ${listed.error.message}` };
  }

  const found = (listed.data ?? [])
    .map((entry) => entry.name)
    // The listing returns names RELATIVE to the prefix. Rebuilding the full path here, rather than
    // trusting anything path-shaped that came back, is what stops a surprising or hostile name from
    // addressing an object outside this prefix.
    .filter((name) => typeof name === "string" && name.length > 0 && !name.includes("/") && !name.includes(".."))
    .map((name) => `${prefix}/${name}`);

  if (found.length === 0) {
    return { attempted: true, prefix, found: [], removed: [], failed: [], message: `No orphaned objects under ${prefix}.` };
  }

  const removed: string[] = [];
  const failed: string[] = [];
  for (const path of found) {
    const result = await bucket.remove([path]);
    if (result.error) {
      failed.push(path);
    } else {
      removed.push(path);
    }
  }

  return {
    attempted: true,
    prefix,
    found,
    removed,
    failed,
    message:
      failed.length === 0
        ? `Removed ${removed.length} orphaned object(s) under ${prefix}.`
        : `Removed ${removed.length}, FAILED to remove ${failed.length} under ${prefix}.`,
  };
}

export type RecoverStuckOptions = {
  thresholdMs?: number;
  now?: number;
  // Opt-IN. Recovery that only terminalizes a job is strictly safe; recovery that also DELETES
  // objects is not something an operator should get without having asked for it.
  reconcileStorage?: boolean;
};

export async function recoverStuckRemotionJobs(
  client: AssetJobExecutionClient,
  jobs: AssetJobRecord[],
  options: RecoverStuckOptions = {},
): Promise<StuckJobRecovery[]> {
  const thresholdMs = options.thresholdMs ?? DEFAULT_STUCK_JOB_THRESHOLD_MS;
  const now = options.now ?? Date.now();
  const recoveries: StuckJobRecovery[] = [];

  for (const job of jobs) {
    if (!isStuckRunningJob(job, now, thresholdMs)) {
      continue;
    }

    // WORKER TYPE IS PART OF THE GATE, not an assumption about the caller's query. This helper is
    // named for remotion and must never terminalize a static_renderer or generative_image job that
    // happened to be in the list it was handed.
    if (job.workerType !== "remotion") {
      continue;
    }

    // RECONCILE BEFORE TERMINALIZING, and the order is load-bearing.
    //
    // The proof above -- "running implies no durable artifact" -- only holds WHILE the job is still
    // running. Fail it first and the proof evaporates: a later run would see a `failed` job, could no
    // longer tell its objects from a completed job's by status alone, and the orphan would become
    // permanently unidentifiable.
    //
    // So: reconcile while the evidence is still provable, then terminalize. If reconciliation does
    // NOT complete, the job is deliberately LEFT RUNNING and reported -- a stuck row a later run can
    // still find beats a tidy row and an orphan nobody can identify any more.
    let reconciliation: OrphanReconciliation | undefined;
    if (options.reconcileStorage) {
      reconciliation = await reconcileOrphanObjectsForJob(client, job);
      const incomplete = reconciliation.attempted === false || reconciliation.failed.length > 0;
      if (incomplete) {
        recoveries.push({
          jobId: job.id,
          attemptNumber: job.attemptCount,
          startedAt: job.startedAt,
          recovered: false,
          message: `Left running on purpose: storage reconciliation did not complete, so the orphan stays discoverable. ${reconciliation.message}`,
          reconciliation,
        });
        continue;
      }
    }

    const message = `Asset Job was left running by a worker that did not finish it (started ${job.startedAt}, threshold ${thresholdMs}ms).`;
    const result = await failRunningAssetJob(client, job, message);
    recoveries.push({
      jobId: job.id,
      attemptNumber: job.attemptCount,
      startedAt: job.startedAt,
      // failRunningAssetJob returns ok:false on SUCCESS by design -- the job did, in fact, fail.
      // "recovered" therefore means the terminal write landed, which is `reason === "failed"`.
      // An ok:true here would mean the RPC reported a completion, and any other reason
      // (conflict/not-found) means the row moved underneath us; neither is a recovery.
      recovered: !result.ok && result.reason === "failed",
      message: result.ok ? "Asset Job reported completed instead of failed during recovery." : result.message,
      reconciliation,
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
    case "worker-failure":
      return `WORKER FAIL job=${event.jobId} ${event.message}`;
    case "cleaned":
      return `cleaned     job=${event.jobId} ${event.ok ? "removed" : "COULD NOT REMOVE"} ${event.directory}`;
  }
}
