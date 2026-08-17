import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type Server, type Socket } from "node:net";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  CREATIVE_AI_WORKER_SUPABASE_REQUEST_TIMEOUT_MS,
  CREATIVE_AI_WORKER_STALE_LOCK_MS,
  createTimeoutFetch,
} from "../scripts/creative-workers/background-worker.ts";

// Content MVP AH1 §23 -- worker lifecycle, asserted at the PROCESS boundary.
//
// WHY THIS FILE EXISTS SEPARATELY FROM creative-ai-background-worker.test.ts
//
// That file proves runCreativeAiWorkerCli RETURNS the right thing, and it is still correct. The
// production incident was not a wrong return value. The worker started at 11:06:54, found no queued
// job, and then stayed alive and idle for fifteen minutes holding the run lock -- so every following
// minute-cadence run skipped (correctly: a live PID is not a stale lock), and a job the owner queued
// ten minutes later was never claimed. Only Stop-ScheduledTask recovered it, after which the same
// job was picked up immediately.
//
// A test that awaits a function can never see that. These spawn a real child process and assert it
// TERMINATES.
//
// DEMONSTRATED ROOT CAUSE, which "stalled" below reproduces: every Supabase call this worker makes
// was an unguarded fetch. @supabase/auth-js sends signInWithPassword through `_request` with no
// signal and no timeout, and postgrest-js does the same for the queue read. Node's defaults do not
// rescue either -- a black-hole socket kept the real entrypoint alive past undici's 300s
// headersTimeout with nothing logged after "lock acquired". That await sits INSIDE the lock, which
// is what turns a stalled request into a stuck worker.
//
// No Supabase project, no Claude, no Codex, and no production row is touched by anything here.

const HARNESS = path.resolve(import.meta.dirname, "fixtures", "ah1-worker-process-harness.ts");

// Generous enough that a slow machine never makes this flaky, and still far below the fifteen
// minutes the real incident ran for -- against the pre-AH1 code the stalled scenario does not exit
// at all, so the margin only has to separate "exits" from "never exits".
const EXIT_BUDGET_MS = 20_000;

type HarnessRun = {
  exited: boolean;
  exitCode: number | null;
  elapsedMs: number;
  stdout: string;
  stderr: string;
  // Both streams together. The worker logs info through console.log and errors through console.error
  // -- deliberately, so a scheduled run's failures are separable -- so any assertion about an ERROR
  // line has to read stderr, and a test that only watched stdout would silently pass on a run that
  // reported nothing at all.
  output: string;
  result: { exitCode: number; skipped: string | null; outcome: string | null; processed: Array<{ outcome: string }>; runJobCalls: number } | null;
};

function runHarness(scenario: string, lockPath: string, blackholePort?: number): Promise<HarnessRun> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HARNESS, scenario, lockPath, String(blackholePort ?? "")], { stdio: ["ignore", "pipe", "pipe"] });
    const startedAt = Date.now();
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));

    // The budget is the assertion. A process that has to be killed did NOT exit, and is reported as
    // such rather than being quietly treated as a pass.
    const killer = setTimeout(() => child.kill("SIGKILL"), EXIT_BUDGET_MS);
    let exited = false;
    child.on("exit", () => (exited = true));

    child.on("close", (code) => {
      clearTimeout(killer);
      const line = stdout.split("\n").find((l) => l.startsWith("AH1_RESULT "));
      resolve({
        exited: exited && code !== null,
        exitCode: code,
        elapsedMs: Date.now() - startedAt,
        stdout,
        stderr,
        output: `${stdout}${stderr}`,
        result: line ? JSON.parse(line.slice("AH1_RESULT ".length)) : null,
      });
    });
  });
}

function lockDir(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(path.join(tmpdir(), "ah1-worker-process-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, ".run.lock");
}

// A socket that accepts the connection and then never writes a byte -- the network shape of the
// wedged request the incident actually hit.
function blackhole(t: { after: (fn: () => void) => void }): Promise<{ port: number }> {
  const sockets: Socket[] = [];
  const server: Server = createServer((socket) => {
    sockets.push(socket);
    socket.on("error", () => {});
  });
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    server.close();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ port: (server.address() as { port: number }).port }));
  });
}

// --- §23 A/B/C/D: the zero-job run, which is the exact shape of the incident ----------------------

test("AH1-C/A. a zero-job worker run exits the PROCESS, not merely the function", async (t) => {
  const lockPath = lockDir(t);
  const run = await runHarness("empty", lockPath);

  // The property the incident violated. The harness never calls process.exit, so this is only true
  // if nothing the worker touched is still holding the event loop open.
  assert.equal(run.exited, true, `worker process did not exit within ${EXIT_BUDGET_MS}ms: ${run.stderr}`);
  assert.equal(run.exitCode, 0, "an empty queue is a normal run, not a failure");
  assert.equal(run.result?.outcome, "no-op");
  assert.ok(run.elapsedMs < EXIT_BUDGET_MS, "the run must finish well inside the budget");
});

test("AH1-C/B. a zero-job run invokes no job runner at all -- no Claude, no Codex, no generation", async (t) => {
  const run = await runHarness("empty", lockDir(t));
  // Exiting is not enough on its own: a run that quietly invoked the AI and then exited would still
  // pass the test above. This is what proves the empty queue really did cost nothing.
  assert.equal(run.result?.runJobCalls, 0);
  assert.deepEqual(run.result?.processed, []);
});

test("AH1-C/C. the lock is acquired and released, leaving no lock file behind", async (t) => {
  const lockPath = lockDir(t);
  const run = await runHarness("empty", lockPath);

  assert.match(run.stdout, /lock acquired/);
  assert.match(run.stdout, /lock released/);
  // §12E. A stale lock after a terminal path is what would disable generation until someone noticed.
  assert.equal(existsSync(lockPath), false, "a finished worker must leave no run lock behind");
});

// --- §23 D: the demonstrated root cause, and the regression that fails against the old code -------

test("AH1-C/D. a stalled Supabase request now aborts and releases the process instead of hanging forever", async (t) => {
  const { port } = await blackhole(t);
  const lockPath = lockDir(t);
  const run = await runHarness("stalled", lockPath, port);

  // THE REGRESSION. Against pre-AH1 code this request never settles: the black-hole socket is
  // accepted and never answered, auth-js supplies no signal, and the process sits inside the lock
  // exactly as it did at 11:06:54. It is only the bounded fetch that ends it.
  assert.equal(run.exited, true, `a stalled request must not keep the process alive: ${run.stderr}`);
  assert.equal(run.exitCode, 1, "an unreachable Supabase is an infrastructure failure");

  // Reported honestly rather than swallowed as "nothing queued", so a wedged network is visible in
  // the log instead of looking like a healthy idle run. This is the other half of the incident's
  // cost: it was invisible, and the owner had no way to tell a hung worker from a busy one.
  assert.match(run.output, /Supabase sign-in failed/);
  assert.match(run.output, /timeout|abort/i);

  // And the lock is still released on the failure path, so the next scheduled run is free.
  assert.match(run.stdout, /lock released/);
  assert.equal(existsSync(lockPath), false, "a failed run must not strand the lock");
});

test("AH1-C. the production request bound is a real, bounded value well under the scheduler's own limit", () => {
  // The scheduled task's ExecutionTimeLimit is 20 minutes and the creative_ai executor ceiling is
  // 15. A request bound anywhere near those would let the hang recur inside its own margin.
  assert.ok(CREATIVE_AI_WORKER_SUPABASE_REQUEST_TIMEOUT_MS > 0, "an unbounded request is the defect itself");
  assert.ok(CREATIVE_AI_WORKER_SUPABASE_REQUEST_TIMEOUT_MS <= 60_000, "the bound must end a dead request inside a scheduler cycle or two");
  // Comfortably above the ~2-3s a healthy empty-queue run takes end to end, so it cannot fire on a
  // working request and turn a healthy worker into a flapping one.
  assert.ok(CREATIVE_AI_WORKER_SUPABASE_REQUEST_TIMEOUT_MS >= 10_000, "too tight a bound would abort healthy requests");
  // Untouched by AH1, and asserted here so a future edit to one constant cannot silently invert
  // their relationship: the lock must outlive any single request by a wide margin.
  assert.ok(CREATIVE_AI_WORKER_STALE_LOCK_MS > CREATIVE_AI_WORKER_SUPABASE_REQUEST_TIMEOUT_MS * 10);
});

test("AH1-C. the bounded fetch aborts on time and preserves a caller's own signal", async (t) => {
  const { port } = await blackhole(t);

  // Aborts on its own deadline.
  const startedAt = Date.now();
  await assert.rejects(() => createTimeoutFetch(200)(`http://127.0.0.1:${port}/`), /abort|timeout/i);
  assert.ok(Date.now() - startedAt < 5_000, "the bound must actually fire rather than fall through to a default");

  // And does not silently discard a signal the caller already supplied -- postgrest exposes
  // .abortSignal(), and replacing it would trade one lifecycle bug for another.
  const caller = new AbortController();
  const pending = assert.rejects(() => createTimeoutFetch(30_000)(`http://127.0.0.1:${port}/`, { signal: caller.signal }), /abort/i);
  caller.abort();
  await pending;
});

// --- §23 E/F: the job paths still terminate, and still mean what they meant ----------------------

test("AH1-C/E. a successful job run exits the process cleanly and releases the lock", async (t) => {
  const lockPath = lockDir(t);
  const run = await runHarness("success", lockPath);

  assert.equal(run.exited, true, `a successful run must exit: ${run.stderr}`);
  assert.equal(run.exitCode, 0);
  assert.equal(run.result?.outcome, "processed");
  assert.deepEqual(run.result?.processed.map((job) => job.outcome), ["completed"]);
  assert.equal(run.result?.runJobCalls, 1, "exactly one job per scheduled run, unchanged");
  assert.equal(existsSync(lockPath), false);
});

test("AH1-C/F. a FAILED job is still a completed unit of worker work: exit 0, lock released, nothing retried", async (t) => {
  const lockPath = lockDir(t);
  const run = await runHarness("failure", lockPath);

  assert.equal(run.exited, true, `a failed job must not keep the process alive: ${run.stderr}`);
  // The existing contract, unchanged by AH1: the runner persisted the failure honestly, so the
  // WORKER did its job. Exit 1 here would paint Task Scheduler red for a job that failed correctly.
  assert.equal(run.exitCode, 0);
  assert.equal(run.result?.outcome, "processed");
  assert.deepEqual(run.result?.processed.map((job) => job.outcome), ["failed"]);
  assert.equal(run.result?.runJobCalls, 1, "a failed job is never retried inside the same run");
  assert.equal(existsSync(lockPath), false);
});

// --- §23 G: overlap semantics are untouched -------------------------------------------------------

test("AH1-C/G. a run that finds a live lock still skips with exit 0 and leaves the holder's lock alone", async (t) => {
  const lockPath = lockDir(t);
  // A lock held by a process that is genuinely alive -- this test runner. Not stale by age and not
  // stale by PID, which is exactly the state every minute-cadence run hit during the incident.
  const held = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() });
  writeFileSync(lockPath, held);

  const run = await runHarness("empty", lockPath);

  assert.equal(run.exited, true, `a skipped run must still exit: ${run.stderr}`);
  // Unchanged and deliberate: overlaps are routine on a one-minute cadence, so a skip is a correct
  // outcome rather than a task failure. AH1 must not have converted these into red history entries.
  assert.equal(run.exitCode, 0);
  assert.equal(run.result?.skipped, "locked");
  assert.equal(run.result?.runJobCalls, 0, "a skipped run must not touch the queue");
  assert.match(run.stdout, /lock skipped/);

  // The critical half: a skipping run must never release a lock it does not own.
  assert.equal(existsSync(lockPath), true, "a skipped run must not delete the holder's lock");
  assert.equal(readFileSync(lockPath, "utf8"), held, "the holder's lock must be left byte-for-byte alone");
});

test("AH1-C. the real scheduled entrypoint installs the bounded fetch on the client it builds", () => {
  // The harness injects its client, so it cannot prove the PRODUCTION client is bounded. This does:
  // the bound has to be installed where every request passes through it, at construction, rather
  // than wrapped around the two calls the reproduction happened to exercise.
  const source = readFileSync(new URL("../scripts/creative-workers/background-worker.ts", import.meta.url), "utf8");
  assert.match(source, /createClient\(\s*credsResult\.credentials\.url,\s*credsResult\.credentials\.anonKey,\s*\{\s*global: \{ fetch: createTimeoutFetch\(\) \}/);
  // And the entrypoint still exits on the code the CLI returned -- AH1 changed what makes the awaits
  // settle, never the exit contract itself.
  assert.match(source, /process\.exit\(exitCode\)/);
});
