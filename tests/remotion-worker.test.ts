import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { buildWorkerRenderPath, isTrustedPathSegment, workerRenderDirectory } from "../src/remotion/asset-job-executor.ts";
import {
  DEFAULT_STUCK_JOB_THRESHOLD_MS,
  RemotionBundleHost,
  formatWorkerEvent,
  isStuckRunningJob,
  recoverStuckRemotionJobs,
} from "../src/remotion/worker.ts";
import type { AssetJobExecutionClient, AssetJobRecord } from "../src/lib/asset-jobs.ts";
import { buildFfprobeArgs } from "../src/remotion/runtime/ffprobe-runtime.ts";

// Production MVP Wave C2A -- the worker layer's load-bearing logic, tested WITHOUT rendering.
//
// Everything here is a pure or near-pure decision the worker makes before or after a render: where
// the file goes, what counts as a trusted identity, how the bundle is reused, and what happens to a
// job a crashed process left behind. The render itself is proved separately, by actually running the
// worker process against a controlled job.

const SCRATCH = path.resolve("/tmp/worker-scratch");

// --- the trusted output path -----------------------------------------------------------------------

test("a render path is built from database identity into the worker's own scratch root", () => {
  const built = buildWorkerRenderPath({ scratchRoot: SCRATCH, assetJobId: "7f1b1a3c-2c6d-4a0e-9f11-2b1e5a9c8d40", attemptNumber: 3 });
  assert.equal(built, path.join(SCRATCH, "asset-job-7f1b1a3c-2c6d-4a0e-9f11-2b1e5a9c8d40", "attempt-3", "output.mp4"));
  assert.equal(workerRenderDirectory(SCRATCH, "7f1b1a3c-2c6d-4a0e-9f11-2b1e5a9c8d40", 3), path.dirname(built));
});

test("the attempt number separates attempts of the SAME job", () => {
  const first = buildWorkerRenderPath({ scratchRoot: SCRATCH, assetJobId: "job-1", attemptNumber: 1 });
  const second = buildWorkerRenderPath({ scratchRoot: SCRATCH, assetJobId: "job-1", attemptNumber: 2 });
  assert.notEqual(first, second);
  // A retry must never write over the artifact of the attempt that failed -- that file is the
  // evidence for why it failed.
  assert.match(first, /attempt-1/);
  assert.match(second, /attempt-2/);
});

test("TRAVERSAL: nothing that is not a plain identifier can become a directory name", () => {
  const hostile = [
    "..",
    "../..",
    "../../etc/passwd",
    "..\\..\\windows\\system32",
    "/etc/passwd",
    "C:\\windows",
    "a/b",
    "a\\b",
    "job-1/../../..",
    "job%2f..%2f..",
    "file:///etc/passwd",
    ".",
    "",
    " ",
    "-rf",
    "job\u0000null",
  ];

  for (const assetJobId of hostile) {
    assert.equal(isTrustedPathSegment(assetJobId), false, `${JSON.stringify(assetJobId)} must not be a trusted segment`);
    assert.throws(
      () => buildWorkerRenderPath({ scratchRoot: SCRATCH, assetJobId, attemptNumber: 1 }),
      /untrusted Asset Job id/,
      `${JSON.stringify(assetJobId)} must not produce a path`,
    );
  }
});

test("every accepted path is INSIDE the scratch root -- re-derived, not assumed", () => {
  for (const assetJobId of ["7f1b1a3c-2c6d-4a0e-9f11-2b1e5a9c8d40", "job-1", "proof-ffde05118d8a", "A0"]) {
    assert.equal(isTrustedPathSegment(assetJobId), true);
    const built = buildWorkerRenderPath({ scratchRoot: SCRATCH, assetJobId, attemptNumber: 1 });
    const relative = path.relative(SCRATCH, built);
    assert.ok(!relative.startsWith("..") && !path.isAbsolute(relative), `${built} escaped the scratch root`);
  }
});

test("an implausible attempt number or extension is refused", () => {
  for (const attemptNumber of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => buildWorkerRenderPath({ scratchRoot: SCRATCH, assetJobId: "job-1", attemptNumber }), /untrusted attempt number/);
  }
  for (const extension of ["../x", "mp4/../..", "MP4", "", "a".repeat(9)]) {
    assert.throws(() => buildWorkerRenderPath({ scratchRoot: SCRATCH, assetJobId: "job-1", attemptNumber: 1, extension }), /untrusted extension/);
  }
});

// --- ffprobe invocation hardening ----------------------------------------------------------------------

test("the probed path is passed as -i and resolved to an absolute path", () => {
  const args = buildFfprobeArgs("outputs/x.mp4");
  assert.deepEqual(args.slice(0, 6), ["-v", "error", "-print_format", "json", "-show_format", "-show_streams"]);
  assert.equal(args[6], "-i");
  assert.equal(args[7], path.resolve("outputs/x.mp4"));
  // C1 passed the path as a trailing positional, where ffprobe would read a leading "-" as an option.
  assert.equal(args.length, 8);
});

test("a flag-shaped path is NEUTRALISED by resolution before ffprobe ever sees it", () => {
  // The honest statement of the protection, rather than the one it would be tempting to write.
  //
  // path.resolve() always returns an absolute path -- "/" on POSIX, a drive or UNC prefix on Windows
  // -- so a flag-shaped input can never survive as a bare flag. THAT is what stops "-i /etc/passwd"
  // being read as an option: not the throw, but the resolution plus the explicit -i that follows it.
  //
  // The startsWith("-") guard inside buildFfprobeArgs is therefore unreachable on both platforms
  // today, and is kept as a defence against a future resolve() that returns something relative. It is
  // deliberately NOT asserted as reachable here, because a test that pretended it fired would be
  // asserting a protection that does not exist.
  for (const hostile of ["-i /etc/passwd", "-f lavfi", "--help"]) {
    const args = buildFfprobeArgs(hostile);
    assert.equal(args[6], "-i", "the input must always be named explicitly");
    assert.ok(path.isAbsolute(args[7]), `${args[7]} should have been resolved to an absolute path`);
    assert.ok(!args[7].startsWith("-"), `${args[7]} would still be read as an option`);
  }
});

// --- bundle lifecycle ------------------------------------------------------------------------------------

test("ONE bundle per worker process, reused across every job", async () => {
  let builds = 0;
  const host = new RemotionBundleHost(async () => {
    builds += 1;
    return `bundle://${builds}`;
  });

  // Ten jobs, one bundle. C1's harness bundled per invocation, which for a daemon means an unbounded
  // pile of ~10 MB temp directories -- the exact C2 blocker this class closes.
  const urls = [];
  for (let job = 0; job < 10; job += 1) {
    urls.push(await host.serveUrl());
  }
  assert.equal(builds, 1, `expected exactly one bundle, got ${builds}`);
  assert.deepEqual(new Set(urls), new Set(["bundle://1"]));
  assert.equal(host.current, "bundle://1");
});

test("concurrent first calls still produce ONE bundle, not two", async () => {
  let builds = 0;
  const host = new RemotionBundleHost(async () => {
    builds += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return "bundle://only";
  });

  // The in-flight promise is cached, not just the settled result. Defensive today (the loop is
  // serial) and the reason a future parallel loop cannot silently double the build.
  const [a, b, c] = await Promise.all([host.serveUrl(), host.serveUrl(), host.serveUrl()]);
  assert.equal(builds, 1);
  assert.deepEqual([a, b, c], ["bundle://only", "bundle://only", "bundle://only"]);
});

test("dispose clears the cached bundle so a later call rebuilds", async () => {
  let builds = 0;
  const host = new RemotionBundleHost(async () => {
    builds += 1;
    return "bundle://x";
  });
  await host.serveUrl();
  await host.dispose();
  assert.equal(host.current, null);
  await host.serveUrl();
  assert.equal(builds, 2);
});

test("a non-filesystem serveUrl is not treated as a directory to delete", async () => {
  const host = new RemotionBundleHost();
  // dispose() must be a no-op for a hosted bundle URL, and must never throw for one.
  await assert.doesNotReject(() => host.dispose());
});

// --- crash recovery ---------------------------------------------------------------------------------------

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
    createdAt: "2026-08-21T10:00:00.000Z",
    updatedAt: "2026-08-21T10:00:00.000Z",
    startedAt: "2026-08-21T10:00:00.000Z",
    completedAt: "",
    failedAt: "",
    ...overrides,
  };
}

const NOW = Date.parse("2026-08-21T11:00:00.000Z"); // one hour after startedAt

test("a job is stuck only when it is RUNNING and older than the threshold", () => {
  assert.equal(isStuckRunningJob(runningJob(), NOW, DEFAULT_STUCK_JOB_THRESHOLD_MS), true);

  // Not stuck: still inside the threshold.
  assert.equal(isStuckRunningJob(runningJob({ startedAt: "2026-08-21T10:59:00.000Z" }), NOW, DEFAULT_STUCK_JOB_THRESHOLD_MS), false);
  // Not stuck: not running.
  for (const status of ["queued", "completed", "failed"] as const) {
    assert.equal(isStuckRunningJob(runningJob({ status }), NOW, DEFAULT_STUCK_JOB_THRESHOLD_MS), false);
  }
  // Not stuck: no startedAt at all.
  assert.equal(isStuckRunningJob(runningJob({ startedAt: "" }), NOW, DEFAULT_STUCK_JOB_THRESHOLD_MS), false);
});

test("an unparseable startedAt is NEVER treated as stuck", () => {
  // Recovery terminates jobs. It must never be able to kill a healthy in-flight render because a
  // timestamp format surprised it -- the safe direction is to leave the row alone.
  for (const startedAt of ["not-a-date", "yesterday", "0000-00-00"]) {
    assert.equal(isStuckRunningJob(runningJob({ startedAt }), NOW, DEFAULT_STUCK_JOB_THRESHOLD_MS), false);
  }
});

test("recovery FAILS a stranded job truthfully through the existing finish RPC", async () => {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const client = {
    rpc(fn: string, args: Record<string, unknown>) {
      calls.push({ fn, args });
      return {
        async maybeSingle() {
          return {
            data: {
              id: args.p_job_id,
              status: "failed",
              creative_package_id: "pkg-1",
              worker_type: "remotion",
              asset_kind: "short_video",
              attempt_count: 1,
              result: {},
              last_error: args.p_last_error,
              created_at: "2026-08-21T10:00:00.000Z",
              updated_at: "2026-08-21T11:00:00.000Z",
              started_at: "2026-08-21T10:00:00.000Z",
              completed_at: null,
              failed_at: "2026-08-21T11:00:00.000Z",
            },
            error: null,
          };
        },
      };
    },
  } as unknown as AssetJobExecutionClient;

  const recoveries = await recoverStuckRemotionJobs(client, [runningJob(), runningJob({ id: "job-2", startedAt: "2026-08-21T10:59:30.000Z" })], { now: NOW });

  assert.equal(recoveries.length, 1, "only the stranded job is recovered");
  assert.equal(recoveries[0].jobId, "job-1");
  assert.equal(recoveries[0].recovered, true);

  // It uses the EXISTING finish_asset_job RPC. No new table, no new function, no parallel queue.
  assert.equal(calls.length, 1);
  assert.equal(calls[0].fn, "finish_asset_job");
  assert.equal(calls[0].args.p_outcome, "failed");
  assert.match(String(calls[0].args.p_last_error), /left running by a worker that did not finish it/);
});

test("recovery reports honestly when the row moved underneath it", async () => {
  // finish_asset_job is guarded by status='running'. If the job already reached a terminal state, it
  // matches zero rows and returns null -- which must be reported as NOT recovered rather than
  // silently counted as a success.
  const client = {
    rpc() {
      return {
        async maybeSingle() {
          return { data: null, error: null };
        },
      };
    },
    from() {
      return {
        select() {
          return {
            eq() {
              return {
                async maybeSingle() {
                  return { data: null, error: null };
                },
              };
            },
          };
        },
      };
    },
  } as unknown as AssetJobExecutionClient;

  const recoveries = await recoverStuckRemotionJobs(client, [runningJob()], { now: NOW });
  assert.equal(recoveries.length, 1);
  assert.equal(recoveries[0].recovered, false);
});

// --- logging -------------------------------------------------------------------------------------------------

test("every worker event renders a line carrying the job id and the state", () => {
  const lines = [
    formatWorkerEvent({ kind: "poll", queued: 2 }),
    formatWorkerEvent({ kind: "claimed", jobId: "job-1", workerType: "remotion", assetKind: "short_video" }),
    formatWorkerEvent({ kind: "rendered", jobId: "job-1", outputPath: "/x/output.mp4", fileSizeBytes: 949555, renderDurationMs: 10513, durationInFrames: 240 }),
    formatWorkerEvent({ kind: "completed", jobId: "job-1", assetId: "asset-1", attemptNumber: 1 }),
    formatWorkerEvent({ kind: "failed", jobId: "job-1", reason: "timeout", message: "too slow" }),
    formatWorkerEvent({ kind: "cleaned", jobId: "job-1", directory: "/x", ok: true }),
    formatWorkerEvent({ kind: "skipped", jobId: "job-2", workerType: "external", assetKind: "image", reason: "not executable by this worker" }),
    formatWorkerEvent({ kind: "warning", jobId: "job-1", warning: "scenes-unused: ..." }),
  ];

  for (const line of lines.slice(1)) {
    assert.match(line, /job=job-\d/, `missing a job id: ${line}`);
  }
  assert.match(lines[2], /frames=240/);
  assert.match(lines[3], /attempt=1/);
  // No credential-shaped text is ever formatted by this function -- it has no access to one, and this
  // asserts the shape stays that way.
  for (const line of lines) {
    assert.doesNotMatch(line, /key|token|password|secret|eyJ/i, `a worker log line must never look like a credential: ${line}`);
  }
});
