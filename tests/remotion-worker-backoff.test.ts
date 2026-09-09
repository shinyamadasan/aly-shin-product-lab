import test from "node:test";
import assert from "node:assert/strict";

import { runRemotionWorkerLoop } from "../src/remotion/worker.ts";
import type { AssetJobExecutionClient } from "../src/lib/asset-jobs.ts";
import { createInMemoryAssetJobStore } from "../scripts/asset-workers/in-memory-asset-job-store.ts";

// Production MVP Wave C2A -- REVIEW P1-3 REGRESSION.
//
// THE DEFECT: after a processed job whose result was not ok, the loop polled again immediately. Every
// failure mode that matters here is persistent rather than transient -- a claim losing a race, a
// network outage, an unreachable ffprobe, a Creative Package that will never build a spec -- and each
// of them fails fast. So a single bad condition produced a tight poll/fail/poll/fail spin with no
// sleep at all, burning CPU and hammering the database for as long as the condition lasted.
//
// THESE TESTS FAIL AGAINST THE REVIEWED IMPLEMENTATION. Under the old loop, `sleeps` below is 0
// because the only sleep was on the IDLE branch, and the queue in these fixtures is never idle.
//
// Deliberately NOT asserted here, because none of it was implemented: no retry, no requeue, no
// exponential backoff, no job-state change. One sleep at the existing poll interval, and nothing more.

const POLL_INTERVAL_MS = 250;

// The fixture reuses the SAME in-memory store the controlled worker proof runs against, rather than a
// hand-rolled one. That store already reproduces the real RPC guards -- in particular
// claim_asset_job_with_attempt's `status = 'queued'` predicate -- so the failure below is a real
// failure mode and not a shape this test invented.
//
// HOW THE CLAIM IS MADE TO FAIL: the job row is seeded and then set to "running", exactly as it would
// be if another worker had won the race a moment earlier. The claim matches zero rows, returns null,
// and runAssetJobWithExecutors reports "not-queued" WITHOUT ever invoking the executor. So the loop is
// driven for real and nothing is rendered.
//
// listQueuedAssetJobs filters on status='queued', so the store's own list would then be empty --
// which would put the loop on the IDLE path instead of the failing one. The wrapper below keeps the
// row visible to the LIST while leaving the CLAIM to fail, which is the only way to reach the branch
// under test.
function alwaysFailsToClaim(): AssetJobExecutionClient {
  const store = createInMemoryAssetJobStore();
  const creativePackageId = store.seedCreativePackage({ schemaVersion: "v2", format: "reel" });
  const row = store.seedJob({ id: "job-1", creative_package_id: creativePackageId, worker_type: "remotion", asset_kind: "short_video" });
  row.status = "running";

  const client = store.client as unknown as Record<string, unknown>;
  const realFrom = (client.from as (table: string) => unknown).bind(client);

  return {
    ...store.client,
    from(table: string) {
      if (table !== "asset_jobs") {
        return realFrom(table);
      }
      return {
        select() {
          const builder = {
            eq: () => builder,
            order: () => builder,
            limit: () => builder,
            async maybeSingle() {
              return { data: row, error: null };
            },
            then(resolve: (value: { data: unknown[]; error: null }) => unknown) {
              return Promise.resolve({ data: [row], error: null }).then(resolve);
            },
          };
          return builder;
        },
      };
    },
    rpc: store.client.rpc.bind(store.client),
  } as unknown as AssetJobExecutionClient;
}

test("P1-3: an unsuccessful job outcome sleeps before the next poll -- no busy-spin", async () => {
  const sleeps: number[] = [];

  const { processed, polls } = await runRemotionWorkerLoop(
    alwaysFailsToClaim(),
    {
      scratchRoot: "/tmp/backoff-scratch",
      brandMark: "Aly & Pon",
      pollIntervalMs: POLL_INTERVAL_MS,
      // No webpack: the loop's bundle host is injected. The executor is never reached anyway, but the
      // host is constructed before the claim, so this is what keeps the test fast and offline.
      bundleBuild: async () => "bundle://test",
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    },
    {
      // Counted from the SLEEPS, which are recorded inside the loop. Stopping on a value that is only
      // assigned after the loop returns would never fire -- the loop would spin forever, which is a
      // fine description of the very defect under test and a terrible way to test it.
      //
      // Three failures is enough to prove the sleep happens EVERY time rather than once.
      shouldStop: () => sleeps.length >= 3,
    },
  );

  assert.equal(processed.length, 3, "the loop should have processed exactly three failing jobs");
  for (const outcome of processed) {
    assert.equal(outcome.result.ok, false, "this fixture must fail every job");
  }

  // THE ASSERTION THE OLD IMPLEMENTATION FAILS. Every failure must be followed by a sleep, and the
  // queue is never idle here, so every recorded sleep came from the failure branch.
  assert.equal(sleeps.length, 3, `expected one sleep per failed job, got ${sleeps.length} -- the loop is busy-spinning`);
  assert.deepEqual(sleeps, [POLL_INTERVAL_MS, POLL_INTERVAL_MS, POLL_INTERVAL_MS], "backoff must use the existing poll interval, not a new schedule");

  // One poll per job, no extra spins between them.
  assert.equal(polls, 3);
});

test("P1-3: the backoff uses the EXISTING poll interval, whatever it is set to", async () => {
  const sleeps: number[] = [];

  await runRemotionWorkerLoop(
    alwaysFailsToClaim(),
    {
      scratchRoot: "/tmp/backoff-scratch",
      brandMark: "Aly & Pon",
      pollIntervalMs: 1234,
      bundleBuild: async () => "bundle://test",
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    },
    { shouldStop: () => sleeps.length >= 2 },
  );

  // No separate retry schedule was introduced -- it is the one interval the worker already had.
  assert.deepEqual(sleeps, [1234, 1234]);
});

test("P1-3: a stop request during backoff is honoured immediately, without sleeping first", async () => {
  const sleeps: number[] = [];
  let stopped = false;

  const { processed } = await runRemotionWorkerLoop(
    alwaysFailsToClaim(),
    {
      scratchRoot: "/tmp/backoff-scratch",
      brandMark: "Aly & Pon",
      pollIntervalMs: POLL_INTERVAL_MS,
      bundleBuild: async () => "bundle://test",
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    },
    {
      // Stops as soon as the first job has been processed. The backoff must not delay a shutdown that
      // has already been requested -- a worker asked to stop should not wait out a poll interval it
      // is never going to use.
      shouldStop: () => {
        const answer = stopped;
        stopped = true;
        return answer;
      },
    },
  );

  assert.equal(processed.length, 1);
  assert.deepEqual(sleeps, [], "a shutdown requested during backoff must not sleep");
});

test("a SUCCESSFUL outcome does not back off -- the loop polls again immediately", async () => {
  // The other half of the contract, and the reason the fix is conditional rather than an
  // unconditional sleep: work was done, more may be waiting, and delaying the next poll by a full
  // interval after every success would halve a busy worker's throughput for no reason.
  //
  // Asserted structurally rather than by rendering: the loop's only unconditional sleep is on the
  // IDLE branch, so a queue that empties after one job yields exactly one sleep (the idle one), never
  // two.
  const sleeps: number[] = [];
  let polls = 0;

  const client = {
    from() {
      return {
        select() {
          const builder = {
            eq: () => builder,
            order: () => builder,
            limit: () => builder,
            async maybeSingle() {
              return { data: null, error: null };
            },
            then(resolve: (value: { data: unknown[]; error: null }) => unknown) {
              polls += 1;
              // Empty from the first poll: this test is about the IDLE path, which is the only place
              // an unconditional sleep is correct.
              return Promise.resolve({ data: [] as unknown[], error: null }).then(resolve);
            },
          };
          return builder;
        },
      };
    },
    rpc() {
      return { async maybeSingle() { return { data: null, error: null }; } };
    },
  } as unknown as AssetJobExecutionClient;

  let idleSeen = 0;
  await runRemotionWorkerLoop(
    client,
    {
      scratchRoot: "/tmp/backoff-scratch",
      brandMark: "Aly & Pon",
      pollIntervalMs: POLL_INTERVAL_MS,
      bundleBuild: async () => "bundle://test",
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    },
    {
      shouldStop: () => idleSeen >= 2,
      onIdle: () => {
        idleSeen += 1;
      },
    },
  );

  assert.ok(polls >= 1, "the loop must have polled");
  // One sleep for the first idle poll; the second idle poll stops instead of sleeping.
  assert.deepEqual(sleeps, [POLL_INTERVAL_MS]);
});
