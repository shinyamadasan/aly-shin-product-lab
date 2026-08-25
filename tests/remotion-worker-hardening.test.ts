import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_STUCK_JOB_THRESHOLD_MS,
  RemotionBundleHost,
  isStuckRunningJob,
  reconcileOrphanObjectsForJob,
  recoverStuckRemotionJobs,
  runRemotionWorkerLoop,
} from "../src/remotion/worker.ts";
import { buildGeneratedAssetAttemptPrefix, buildGeneratedAssetObjectPath } from "../src/lib/asset-binary.ts";
import { FFPROBE_TIMEOUT_MS } from "../src/remotion/runtime/ffprobe-runtime.ts";
import type { AssetJobExecutionClient, AssetJobRecord, AssetJobRow } from "../src/lib/asset-jobs.ts";

// Production MVP Wave C2B-2 -- OPERATIONAL HARDENING.
//
// Four reliability gaps kept live activation blocked, and each is proved closed here:
//
//   1. stale-running recovery existed but nothing called it
//   2. a rejected bundle build poisoned the host forever
//   3. a transient bundle failure killed the daemon
//   4. an upload/completion crash left storage orphans with no reconciliation path
//
// Every test below drives the REAL loop or the REAL helper. None asserts a behaviour by reading it
// back out of a stub.

// --- fixtures --------------------------------------------------------------------------------------

function runningJob(overrides: Partial<AssetJobRecord> = {}): AssetJobRecord {
  return {
    id: "job-1",
    creativePackageId: "pkg-1",
    status: "running",
    workerType: "remotion",
    assetKind: "short_video",
    attemptCount: 1,
    result: {},
    lastError: "",
    createdAt: "2026-08-22T10:00:00.000Z",
    updatedAt: "2026-08-22T10:00:00.000Z",
    startedAt: "2026-08-22T10:00:00.000Z",
    completedAt: "",
    failedAt: "",
    ...overrides,
  };
}

const NOW = Date.parse("2026-08-22T11:00:00.000Z"); // one hour after startedAt

function finishedJobRow(id: string, lastError: unknown): AssetJobRow & { id: string } {
  return {
    id,
    creative_package_id: "pkg-1",
    status: "failed",
    worker_type: "remotion",
    asset_kind: "short_video",
    attempt_count: 1,
    result: {},
    last_error: typeof lastError === "string" ? lastError : null,
    created_at: "2026-08-22T10:00:00.000Z",
    updated_at: "2026-08-22T11:00:00.000Z",
    started_at: "2026-08-22T10:00:00.000Z",
    completed_at: null,
    failed_at: "2026-08-22T11:00:00.000Z",
  };
}

// A client whose finish RPC succeeds and whose storage can be scripted.
function recoveryClient(options: { objects?: string[]; canList?: boolean; removeFails?: boolean; listFails?: boolean } = {}) {
  const objects = new Set(options.objects ?? []);
  const listedPrefixes: string[] = [];
  const removedPaths: string[] = [];
  const finishedJobs: string[] = [];

  const bucket: Record<string, unknown> = {
    async remove(paths: string[]) {
      if (options.removeFails) {
        return { data: null, error: { message: "storage remove failed" } };
      }
      for (const path of paths) {
        objects.delete(path);
        removedPaths.push(path);
      }
      return { data: [], error: null };
    },
    async upload() {
      return { data: null, error: null };
    },
    async download() {
      return { data: null, error: { message: "not used" } };
    },
  };

  if (options.canList !== false) {
    bucket.list = async (prefix: string) => {
      listedPrefixes.push(prefix);
      if (options.listFails) {
        return { data: null, error: { message: "storage list failed" } };
      }
      const names = [...objects]
        .filter((path) => path.startsWith(`${prefix}/`))
        .map((path) => path.slice(prefix.length + 1))
        .filter((name) => !name.includes("/"));
      return { data: names.map((name) => ({ name })), error: null };
    };
  }

  const client = {
    storage: { from: () => bucket },
    rpc(fn: string, args: Record<string, unknown>) {
      return {
        async maybeSingle() {
          if (fn === "finish_asset_job") {
            finishedJobs.push(String(args.p_job_id));
            return { data: finishedJobRow(String(args.p_job_id), args.p_last_error), error: null };
          }
          return { data: null, error: null };
        },
      };
    },
  } as unknown as AssetJobExecutionClient;

  return { client, objects, listedPrefixes, removedPaths, finishedJobs };
}

// --- 1. STALE RECOVERY -------------------------------------------------------------------------------

test("recovery ignores queued, completed and failed jobs", async () => {
  const { client, finishedJobs } = recoveryClient();
  const jobs = (["queued", "completed", "failed"] as const).map((status, index) => runningJob({ id: `job-${index}`, status }));
  const recoveries = await recoverStuckRemotionJobs(client, jobs, { now: NOW });
  assert.deepEqual(recoveries, []);
  assert.deepEqual(finishedJobs, [], "no job may be terminalized");
});

test("recovery ignores running jobs newer than the threshold", async () => {
  const { client, finishedJobs } = recoveryClient();
  const fresh = runningJob({ startedAt: "2026-08-22T10:59:00.000Z" });
  assert.equal(isStuckRunningJob(fresh, NOW, DEFAULT_STUCK_JOB_THRESHOLD_MS), false);
  assert.deepEqual(await recoverStuckRemotionJobs(client, [fresh], { now: NOW }), []);
  assert.deepEqual(finishedJobs, []);
});

test("recovery ignores an unparseable startedAt -- fail-safe", async () => {
  const { client, finishedJobs } = recoveryClient();
  for (const startedAt of ["", "not-a-date", "yesterday", "0000-00-00"]) {
    assert.deepEqual(await recoverStuckRemotionJobs(client, [runningJob({ startedAt })], { now: NOW }), []);
  }
  // Recovery TERMINATES jobs. It must never be able to kill a healthy in-flight render because a
  // timestamp format surprised it; the safe direction is always to leave the row alone.
  assert.deepEqual(finishedJobs, []);
});

test("recovery ignores non-remotion workers even when handed them", async () => {
  const { client, finishedJobs } = recoveryClient();
  const jobs = (["static_renderer", "generative_image", "external", "mock"] as const).map((workerType, index) =>
    runningJob({ id: `job-${index}`, workerType }),
  );
  assert.deepEqual(await recoverStuckRemotionJobs(client, jobs, { now: NOW }), []);
  assert.deepEqual(finishedJobs, [], "this helper is named for remotion and must terminalize nothing else");
});

test("recovery FAILS a stale running remotion job truthfully, and never requeues", async () => {
  const { client, finishedJobs } = recoveryClient();
  const recoveries = await recoverStuckRemotionJobs(client, [runningJob()], { now: NOW });

  assert.equal(recoveries.length, 1);
  assert.equal(recoveries[0].jobId, "job-1");
  assert.equal(recoveries[0].attemptNumber, 1);
  assert.equal(recoveries[0].recovered, true);
  assert.match(recoveries[0].message, /left running by a worker that did not finish it/);
  // Exactly one write, and it is the EXISTING finish RPC. No lease, no heartbeat, no requeue, no new
  // table, and above all no transition back to 'queued'.
  assert.deepEqual(finishedJobs, ["job-1"]);
});

// --- 2. ORPHAN RECONCILIATION ---------------------------------------------------------------------------

test("reconciliation targets ONLY the exact job+attempt prefix", async () => {
  const mine = buildGeneratedAssetObjectPath({ assetJobId: "job-1", attemptNumber: 1, sha256: "aaa", extension: "mp4" });
  const myOtherAttempt = buildGeneratedAssetObjectPath({ assetJobId: "job-1", attemptNumber: 2, sha256: "bbb", extension: "mp4" });
  const someoneElse = buildGeneratedAssetObjectPath({ assetJobId: "job-9", attemptNumber: 1, sha256: "ccc", extension: "mp4" });

  const { client, objects, listedPrefixes } = recoveryClient({ objects: [mine, myOtherAttempt, someoneElse] });
  const result = await reconcileOrphanObjectsForJob(client, runningJob());

  assert.ok(result.attempted);
  assert.deepEqual(listedPrefixes, [buildGeneratedAssetAttemptPrefix({ assetJobId: "job-1", attemptNumber: 1 })]);
  assert.deepEqual(result.removed, [mine]);
  // A different attempt of the same job, and another job entirely, are both untouched.
  assert.ok(objects.has(myOtherAttempt));
  assert.ok(objects.has(someoneElse));
});

test("reconciliation reports listing-unavailable rather than silently doing nothing", async () => {
  const { client } = recoveryClient({ canList: false });
  const result = await reconcileOrphanObjectsForJob(client, runningJob());
  assert.equal(result.attempted, false);
  assert.equal(result.attempted === false ? result.reason : null, "listing-unavailable");
});

test("a completed job's storage is NEVER reconciled -- it is not stale-running", async () => {
  const durable = buildGeneratedAssetObjectPath({ assetJobId: "job-1", attemptNumber: 1, sha256: "aaa", extension: "mp4" });
  const { client, objects, removedPaths } = recoveryClient({ objects: [durable] });

  // The safety proof in one assertion: complete_asset_job_with_files inserts the Asset AND flips the
  // job to completed in ONE transaction, so a completed job's objects are its durable artifact.
  // Recovery only ever considers running jobs, so it can never reach them.
  await recoverStuckRemotionJobs(client, [runningJob({ status: "completed" })], { now: NOW, reconcileStorage: true });
  assert.deepEqual(removedPaths, []);
  assert.ok(objects.has(durable), "a completed asset's object must never be removed");
});

test("reconciliation runs BEFORE terminalizing, and a failed reconciliation leaves the job running", async () => {
  const orphan = buildGeneratedAssetObjectPath({ assetJobId: "job-1", attemptNumber: 1, sha256: "aaa", extension: "mp4" });
  const { client, objects, finishedJobs } = recoveryClient({ objects: [orphan], removeFails: true });

  const [recovery] = await recoverStuckRemotionJobs(client, [runningJob()], { now: NOW, reconcileStorage: true });

  // The job is deliberately LEFT RUNNING. "running" is the only status that proves the object is an
  // orphan; terminalizing first would make it permanently unidentifiable.
  assert.equal(recovery.recovered, false);
  assert.match(recovery.message, /Left running on purpose/);
  assert.deepEqual(finishedJobs, [], "the job must not be terminalized while its orphan is unreconciled");
  assert.ok(objects.has(orphan), "the orphan survives and stays discoverable");
});

test("a successful reconciliation removes the orphan AND then terminalizes the job", async () => {
  const orphan = buildGeneratedAssetObjectPath({ assetJobId: "job-1", attemptNumber: 1, sha256: "aaa", extension: "mp4" });
  const { client, objects, finishedJobs } = recoveryClient({ objects: [orphan] });

  const [recovery] = await recoverStuckRemotionJobs(client, [runningJob()], { now: NOW, reconcileStorage: true });

  assert.equal(recovery.recovered, true);
  assert.equal(recovery.reconciliation?.attempted, true);
  assert.equal(objects.has(orphan), false, "the orphan is gone");
  assert.deepEqual(finishedJobs, ["job-1"], "and only then is the job terminalized");
});

test("reconciliation is OPT-IN -- plain recovery deletes nothing", async () => {
  const orphan = buildGeneratedAssetObjectPath({ assetJobId: "job-1", attemptNumber: 1, sha256: "aaa", extension: "mp4" });
  const { client, objects, removedPaths, finishedJobs } = recoveryClient({ objects: [orphan] });

  const [recovery] = await recoverStuckRemotionJobs(client, [runningJob()], { now: NOW });

  assert.equal(recovery.recovered, true);
  assert.equal(recovery.reconciliation, undefined);
  assert.deepEqual(removedPaths, [], "recovery without --reconcile-storage must not touch storage");
  assert.ok(objects.has(orphan));
  assert.deepEqual(finishedJobs, ["job-1"]);
});

// --- 3. BUNDLE RESILIENCE -------------------------------------------------------------------------------

test("a rejected first build does NOT poison the host -- a later request retries", async () => {
  let builds = 0;
  const host = new RemotionBundleHost(async () => {
    builds += 1;
    if (builds === 1) {
      throw new Error("webpack exploded");
    }
    return `bundle://${builds}`;
  });

  // 1. first build rejects
  await assert.rejects(() => host.serveUrl(), /webpack exploded/);
  assert.equal(host.current, null, "a failed build must not cache a serveUrl");

  // 2. a LATER request retries rather than replaying the cached rejection. This is the defect: the
  //    old `??=` form kept the rejected promise forever, so one transient failure bricked the daemon.
  assert.equal(await host.serveUrl(), "bundle://2");
  assert.equal(builds, 2);

  // 3. the successful bundle is then cached and reused
  assert.equal(await host.serveUrl(), "bundle://2");
  assert.equal(await host.serveUrl(), "bundle://2");
  assert.equal(builds, 2, "a successful build must never be rebuilt");
  assert.equal(host.current, "bundle://2");
});

test("concurrent first callers still deduplicate onto ONE build", async () => {
  let builds = 0;
  const host = new RemotionBundleHost(async () => {
    builds += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return "bundle://only";
  });

  const results = await Promise.all([host.serveUrl(), host.serveUrl(), host.serveUrl()]);
  assert.equal(builds, 1, "the in-flight promise must still be shared");
  assert.deepEqual(results, ["bundle://only", "bundle://only", "bundle://only"]);
});

test("concurrent first callers all reject together, and the NEXT caller still retries", async () => {
  // The property the fix must not break: clearing the slot eagerly would have let a second concurrent
  // caller start its own build while the first was still running.
  let builds = 0;
  const host = new RemotionBundleHost(async () => {
    builds += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    if (builds === 1) {
      throw new Error("transient");
    }
    return "bundle://recovered";
  });

  const settled = await Promise.allSettled([host.serveUrl(), host.serveUrl()]);
  assert.deepEqual(settled.map((r) => r.status), ["rejected", "rejected"]);
  assert.equal(builds, 1, "both concurrent callers shared the one failing build");

  assert.equal(await host.serveUrl(), "bundle://recovered");
  assert.equal(builds, 2);
});

// --- 4. DAEMON SURVIVES A TRANSIENT BUNDLE FAILURE ---------------------------------------------------------

// A client that always offers one queued remotion job and can be told whether the claim succeeds.
function queuedJobClient(rows: Array<AssetJobRow & { id: string }>): AssetJobExecutionClient {
  return {
    from() {
      return {
        select() {
          const builder = {
            eq: () => builder,
            order: () => builder,
            limit: () => builder,
            async maybeSingle() {
              return { data: rows[0] ?? null, error: null };
            },
            then(resolve: (value: { data: unknown[]; error: null }) => unknown) {
              return Promise.resolve({ data: rows, error: null }).then(resolve);
            },
          };
          return builder;
        },
      };
    },
    rpc() {
      return {
        async maybeSingle() {
          return { data: null, error: null };
        },
      };
    },
  } as unknown as AssetJobExecutionClient;
}

function queuedRow(id: string): AssetJobRow & { id: string } {
  return {
    id,
    creative_package_id: "pkg-1",
    status: "queued",
    worker_type: "remotion",
    asset_kind: "short_video",
    attempt_count: 0,
    result: {},
    last_error: null,
    created_at: "2026-08-22T10:00:00.000Z",
    updated_at: "2026-08-22T10:00:00.000Z",
    started_at: null,
    completed_at: null,
    failed_at: null,
  };
}

test("a transient bundle failure does NOT terminate the worker loop", async () => {
  const sleeps: number[] = [];
  let builds = 0;

  const { workerFailures, polls } = await runRemotionWorkerLoop(
    queuedJobClient([queuedRow("job-1")]),
    {
      scratchRoot: "/tmp/c2b2-scratch",
      brandMark: "Aly & Pon",
      pollIntervalMs: 250,
      // Fails every time: the loop must keep going regardless, not die on the first rejection.
      bundleBuild: async () => {
        builds += 1;
        throw new Error("webpack exploded");
      },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    },
    { shouldStop: () => sleeps.length >= 3 },
  );

  // Before this wave the first rejection propagated out of runRemotionWorkerLoop and killed the
  // process. Now the loop survives, reports, backs off, and polls again.
  assert.equal(workerFailures.length, 3, `expected three surviving cycles, saw ${workerFailures.length}`);
  for (const failure of workerFailures) {
    assert.equal(failure.jobId, "job-1");
    assert.match(failure.message, /webpack exploded/);
  }
  assert.equal(polls, 3);
  // And it BACKS OFF -- a bundle failure must not busy-spin any more than a job failure does.
  assert.deepEqual(sleeps, [250, 250, 250]);
  // Each cycle really did retry the build rather than replay a poisoned promise.
  assert.equal(builds, 3);
});

test("a bundle failure leaves the job QUEUED, because the bundle resolves BEFORE the claim", async () => {
  // Pins the actual repository ordering rather than an assumption. executeRemotionAssetJob awaits
  // bundleHost.serveUrl() before runAssetJobWithExecutors, and the claim lives inside that runner --
  // so a bundle failure throws before any claim RPC is issued.
  const rows = [queuedRow("job-1")];
  const rpcCalls: string[] = [];
  const client = {
    from() {
      return {
        select() {
          const builder = {
            eq: () => builder,
            order: () => builder,
            limit: () => builder,
            async maybeSingle() {
              return { data: rows[0], error: null };
            },
            then(resolve: (value: { data: unknown[]; error: null }) => unknown) {
              return Promise.resolve({ data: rows, error: null }).then(resolve);
            },
          };
          return builder;
        },
      };
    },
    rpc(fn: string) {
      rpcCalls.push(fn);
      return {
        async maybeSingle() {
          return { data: null, error: null };
        },
      };
    },
  } as unknown as AssetJobExecutionClient;

  const sleeps: number[] = [];
  const { processed, workerFailures } = await runRemotionWorkerLoop(
    client,
    {
      scratchRoot: "/tmp/c2b2-scratch",
      brandMark: "Aly & Pon",
      pollIntervalMs: 100,
      bundleBuild: async () => {
        throw new Error("bundle down");
      },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    },
    { shouldStop: () => sleeps.length >= 1 },
  );

  assert.equal(workerFailures.length, 1);
  assert.deepEqual(processed, [], "no job outcome may be invented when nothing was claimed");
  // THE ASSERTION THAT MATTERS: no claim RPC was ever issued, so the row is untouched and stays queued.
  assert.deepEqual(rpcCalls, [], "a bundle failure must not reach the claim RPC");
  assert.equal(rows[0].status, "queued");
});

// --- 5. FFPROBE CHILD BOUND ---------------------------------------------------------------------------------

test("the ffprobe child has a bounded timeout", () => {
  // The C2A review recorded an unbounded child as P2. It matters operationally on Windows: a wedged
  // probe keeps a handle on the MP4 the cleanup step is about to delete.
  assert.equal(typeof FFPROBE_TIMEOUT_MS, "number");
  assert.ok(FFPROBE_TIMEOUT_MS > 0 && Number.isFinite(FFPROBE_TIMEOUT_MS));
  // Far above any real probe of a ~1 MB file, so it can only ever fire on a genuinely stuck child.
  assert.ok(FFPROBE_TIMEOUT_MS >= 30_000, "the bound must not be tight enough to kill a healthy probe");
});
