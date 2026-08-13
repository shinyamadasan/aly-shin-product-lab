import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  CREATIVE_AI_WORKER_EXPECTED_PACKAGE_NAME,
  CREATIVE_AI_WORKER_MAX_JOBS_PER_RUN,
  CREATIVE_AI_WORKER_STALE_LOCK_MS,
  CREATIVE_AI_WORKER_TASK_NAME,
  processCreativeAiQueue,
  runCreativeAiWorkerCli,
  verifyRepositoryIdentity,
  type CreativeAiWorkerClient,
} from "../scripts/creative-workers/background-worker.ts";
import { acquireLock } from "../scripts/daily-advisor/lock.ts";
import { CREATIVE_AI_EXECUTOR_TIMEOUT_MS, type CreativeJobRow } from "../src/lib/creative-jobs.ts";
import type { CreativePackageMaterializedRunResult } from "../src/lib/creative-packages.ts";

// S3D -- the background worker. No CLI is spawned, no AI usage is spent, no real lock path is
// touched: every test below uses a temp directory and an injected runner.

type ErrorLike = { code?: string; message: string };

function jobRow(overrides: Partial<CreativeJobRow> = {}): CreativeJobRow {
  return {
    id: "job-1",
    opportunity_id: null,
    intent: { schemaVersion: "v1", text: "Give me something easy today" },
    status: "queued",
    worker_type: "creative_ai",
    attempt_count: 0,
    result: {},
    last_error: null,
    created_at: "2026-08-13T09:00:00.000Z",
    updated_at: "2026-08-13T09:00:00.000Z",
    started_at: null,
    completed_at: null,
    failed_at: null,
    ...overrides,
  };
}

// Honours the same eq()/order()/limit() chain listQueuedCreativeJobs actually builds, so the
// worker's queue filtering is exercised rather than assumed.
function makeClient(jobs: CreativeJobRow[], options: { selectError?: ErrorLike } = {}) {
  const queries: Array<{ filters: Record<string, string>; limit: number | null }> = [];

  function builder(rows: CreativeJobRow[]) {
    const filters: Record<string, string> = {};
    let limitValue: number | null = null;
    const self = {
      eq(column: string, value: string) {
        filters[column] = value;
        return self;
      },
      order() {
        return self;
      },
      limit(count: number) {
        limitValue = count;
        return self;
      },
      then(resolve: (value: { data: CreativeJobRow[] | null; error: ErrorLike | null }) => unknown, reject?: (reason: unknown) => unknown) {
        queries.push({ filters: { ...filters }, limit: limitValue });
        if (options.selectError) {
          return Promise.resolve({ data: null, error: options.selectError }).then(resolve, reject);
        }
        const matched = rows.filter((row) => Object.entries(filters).every(([column, value]) => (row as unknown as Record<string, unknown>)[column] === value));
        return Promise.resolve({ data: limitValue === null ? matched : matched.slice(0, limitValue), error: null }).then(resolve, reject);
      },
    };
    return self;
  }

  const client = {
    from(table: string) {
      assert.equal(table, "creative_jobs");
      return { select: () => builder(jobs) };
    },
  };

  return { client: client as unknown as CreativeAiWorkerClient, queries };
}

function completed(): CreativePackageMaterializedRunResult {
  return {
    ok: true,
    job: { id: "job-1" } as never,
    packageOutcome: "created",
    creativePackage: { id: "package-1" } as never,
  };
}

function failed(message = "Creative AI generation failed at the creative_body stage: usage_limit."): CreativePackageMaterializedRunResult {
  return { ok: false, reason: "failed", message };
}

function tempDir(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(path.join(tmpdir(), "s3d-worker-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A resolvable promise pair, so a test can hold one worker mid-generation while a second runs.
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// A throwaway project root that satisfies the identity guard.
function fakeProjectRoot(t: { after: (fn: () => void) => void }, name = CREATIVE_AI_WORKER_EXPECTED_PACKAGE_NAME): string {
  const dir = tempDir(t);
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name }));
  return dir;
}

// --- §20 queue behavior -------------------------------------------------------------------------

test("A. no queued jobs -> the runner is never invoked", async () => {
  const store = makeClient([]);
  let invocations = 0;

  const result = await processCreativeAiQueue(store.client, {
    runJob: async () => {
      invocations += 1;
      return completed();
    },
  });

  assert.equal(invocations, 0, "nothing queued must mean no AI invocation at all");
  assert.equal(result.outcome, "no-op");
  assert.equal(result.queuedFound, 0);
  assert.deepEqual(result.processed, []);
});

test("B. a queued creative_ai job -> the runner is invoked with that job id", async () => {
  const store = makeClient([jobRow()]);
  const seen: string[] = [];

  const result = await processCreativeAiQueue(store.client, {
    runJob: async (_client, jobId) => {
      seen.push(jobId);
      return completed();
    },
  });

  assert.deepEqual(seen, ["job-1"]);
  assert.equal(result.outcome, "processed");
  assert.equal(result.queuedFound, 1);
  assert.equal(result.processed[0].outcome, "completed");
});

test("C. other worker types and non-queued statuses are ignored", async () => {
  const store = makeClient([
    jobRow({ id: "mock-job", worker_type: "mock" }),
    jobRow({ id: "text-job", worker_type: "product_text_worker" }),
    jobRow({ id: "brief-job", worker_type: "opportunity_brief" }),
    jobRow({ id: "running-job", status: "running" }),
    jobRow({ id: "completed-job", status: "completed" }),
    jobRow({ id: "failed-job", status: "failed" }),
    jobRow({ id: "the-only-eligible-job" }),
  ]);
  const seen: string[] = [];

  await processCreativeAiQueue(store.client, {
    runJob: async (_client, jobId) => {
      seen.push(jobId);
      return completed();
    },
  });

  assert.deepEqual(seen, ["the-only-eligible-job"]);
  // The filter is pushed to the query, not applied after reading everything.
  assert.deepEqual(store.queries[0].filters, { status: "queued", worker_type: "creative_ai" });
});

test("D. at most the configured cap is processed, and the cap defaults to one", async () => {
  assert.equal(CREATIVE_AI_WORKER_MAX_JOBS_PER_RUN, 1);

  const store = makeClient([jobRow({ id: "job-1" }), jobRow({ id: "job-2" }), jobRow({ id: "job-3" })]);
  const seen: string[] = [];

  const result = await processCreativeAiQueue(store.client, {
    runJob: async (_client, jobId) => {
      seen.push(jobId);
      return completed();
    },
  });

  assert.deepEqual(seen, ["job-1"], "three queued jobs must still yield exactly one generation");
  assert.equal(result.processed.length, 1);
  assert.equal(store.queries[0].limit, 1, "the cap is applied by the query, not after fetching the queue");
});

test("E. jobs are processed strictly serially, never concurrently", async () => {
  const store = makeClient([jobRow({ id: "job-1" }), jobRow({ id: "job-2" }), jobRow({ id: "job-3" })]);
  let inFlight = 0;
  let maxInFlight = 0;
  const order: string[] = [];

  // Raised cap only to make overlap observable at all -- the shipped default is 1.
  await processCreativeAiQueue(store.client, {
    maxJobs: 3,
    runJob: async (_client, jobId) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      order.push(`start:${jobId}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push(`end:${jobId}`);
      inFlight -= 1;
      return completed();
    },
  });

  assert.equal(maxInFlight, 1, "two Creative AI generations must never run at the same time");
  assert.deepEqual(order, ["start:job-1", "end:job-1", "start:job-2", "end:job-2", "start:job-3", "end:job-3"]);
});

test("an unreadable queue is an infrastructure failure, not a silent no-op", async () => {
  const store = makeClient([jobRow()], { selectError: { code: "PGRST205", message: "relation does not exist" } });
  let invocations = 0;

  const result = await processCreativeAiQueue(store.client, {
    runJob: async () => {
      invocations += 1;
      return completed();
    },
  });

  assert.equal(result.outcome, "failed");
  assert.equal(invocations, 0);
});

// --- §22 job failure ----------------------------------------------------------------------------

test("an honestly failed job is recorded, never requeued or retried by the worker", async () => {
  const store = makeClient([jobRow()]);
  let invocations = 0;

  const result = await processCreativeAiQueue(store.client, {
    runJob: async () => {
      invocations += 1;
      return failed();
    },
  });

  assert.equal(invocations, 1, "the worker must not retry the AI itself");
  assert.equal(result.outcome, "processed", "a failed job is still a completed unit of worker work");
  assert.equal(result.processed[0].outcome, "failed");
  assert.match(result.processed[0].message ?? "", /usage_limit/);

  // Nothing in the worker writes to creative_jobs -- its only table access is the queue read.
  assert.deepEqual(Object.keys(store.queries[0].filters), ["status", "worker_type"]);
});

test("a failed job does not crash the scheduled command", async (t) => {
  const root = fakeProjectRoot(t);
  const store = makeClient([jobRow()]);
  const cli = await runCreativeAiWorkerCli({
    projectRoot: root,
    lockPath: path.join(root, "lock", ".run.lock"),
    envPath: path.join(root, ".env.missing"),
    createClient: async () => ({ ok: true, client: store.client }),
    runJob: async () => failed(),
  });

  assert.equal(cli.exitCode, 0, "an honestly-persisted job failure is not a scheduler failure");
  assert.equal(cli.result?.processed[0].outcome, "failed");
});

// --- §21 lock -----------------------------------------------------------------------------------

test("F + G. the first worker takes the lock and a second concurrent worker skips cleanly", async (t) => {
  const root = fakeProjectRoot(t);
  const lockPath = path.join(root, "lock", ".run.lock");
  const store = makeClient([jobRow()]);
  let invocations = 0;

  const started = deferred();
  const mayFinish = deferred();

  const first = runCreativeAiWorkerCli({
    projectRoot: root,
    lockPath,
    envPath: path.join(root, ".env.missing"),
    createClient: async () => ({ ok: true, client: store.client }),
    runJob: async () => {
      invocations += 1;
      started.resolve();
      await mayFinish.promise;
      return completed();
    },
  });

  await started.promise; // the first worker is now mid-generation, holding the lock

  const second = await runCreativeAiWorkerCli({
    projectRoot: root,
    lockPath,
    envPath: path.join(root, ".env.missing"),
    createClient: async () => ({ ok: true, client: store.client }),
    runJob: async () => {
      invocations += 1;
      return completed();
    },
  });

  assert.equal(second.skipped, "locked");
  assert.equal(second.exitCode, 0, "a skipped run is a normal outcome, not a Task Scheduler error");
  assert.equal(second.result, undefined, "the skipped worker must not have touched the queue");

  mayFinish.resolve();
  const firstResult = await first;
  assert.equal(firstResult.exitCode, 0);
  assert.equal(invocations, 1, "exactly one generation ran across both overlapping invocations");
});

test("H. the lock is released after a successful run, so the next run can take it", async (t) => {
  const root = fakeProjectRoot(t);
  const lockPath = path.join(root, "lock", ".run.lock");
  const store = makeClient([jobRow()]);

  const first = await runCreativeAiWorkerCli({
    projectRoot: root,
    lockPath,
    envPath: path.join(root, ".env.missing"),
    createClient: async () => ({ ok: true, client: store.client }),
    runJob: async () => completed(),
  });
  assert.equal(first.exitCode, 0);

  const second = await runCreativeAiWorkerCli({
    projectRoot: root,
    lockPath,
    envPath: path.join(root, ".env.missing"),
    createClient: async () => ({ ok: true, client: makeClient([jobRow()]).client }),
    runJob: async () => completed(),
  });
  assert.notEqual(second.skipped, "locked", "the lock must not survive a successful run");
  assert.equal(second.exitCode, 0);
});

test("I. the lock is released after a handled infrastructure failure, and after a thrown one", async (t) => {
  const root = fakeProjectRoot(t);
  const lockPath = path.join(root, "lock", ".run.lock");

  // Handled failure: the queue read fails.
  const handled = await runCreativeAiWorkerCli({
    projectRoot: root,
    lockPath,
    envPath: path.join(root, ".env.missing"),
    createClient: async () => ({ ok: true, client: makeClient([jobRow()], { selectError: { message: "boom" } }).client }),
    runJob: async () => completed(),
  });
  assert.equal(handled.exitCode, 1);

  // Thrown failure: the runner itself explodes.
  const thrown = await runCreativeAiWorkerCli({
    projectRoot: root,
    lockPath,
    envPath: path.join(root, ".env.missing"),
    createClient: async () => ({ ok: true, client: makeClient([jobRow()]).client }),
    runJob: async () => {
      throw new Error("unexpected infrastructure explosion");
    },
  });
  assert.equal(thrown.exitCode, 1);

  // After both, the lock must be free.
  const after = await runCreativeAiWorkerCli({
    projectRoot: root,
    lockPath,
    envPath: path.join(root, ".env.missing"),
    createClient: async () => ({ ok: true, client: makeClient([]).client }),
    runJob: async () => completed(),
  });
  assert.notEqual(after.skipped, "locked", "a crashed run must not leave the worker permanently locked out");
  assert.equal(after.exitCode, 0);
});

test("J. a stale lock is recovered rather than disabling generation forever", async (t) => {
  const dir = tempDir(t);
  mkdirSync(dir, { recursive: true });

  // Two independent staleness paths, tested separately so neither can mask the other.

  // 1. AGE. The recorded pid is THIS process, which is very much alive -- so the dead-pid check
  //    cannot help here and only the configured threshold can declare it stale. (An earlier version
  //    of this test used a fake dead pid, which passed even when the threshold was ignored entirely.)
  const agedPath = path.join(dir, "aged.lock");
  writeFileSync(agedPath, JSON.stringify({ pid: process.pid, startedAt: new Date(Date.now() - CREATIVE_AI_WORKER_STALE_LOCK_MS - 60_000).toISOString() }));
  const byAge = acquireLock(agedPath, { staleAfterMs: CREATIVE_AI_WORKER_STALE_LOCK_MS });
  assert.equal(byAge.ok, true, "a lock older than the threshold must be reclaimable even if its pid is alive");
  if (byAge.ok) byAge.release();

  // 2. DEAD PROCESS. A recent lock whose owner has died is reclaimed immediately, without waiting
  //    out the threshold -- which is what makes an ordinary crash recover on the very next run.
  const deadPath = path.join(dir, "dead.lock");
  writeFileSync(deadPath, JSON.stringify({ pid: 999999999, startedAt: new Date().toISOString() }));
  const byDeadPid = acquireLock(deadPath, { staleAfterMs: CREATIVE_AI_WORKER_STALE_LOCK_MS });
  assert.equal(byDeadPid.ok, true, "a crashed run's lock must not survive to the threshold");
  if (byDeadPid.ok) byDeadPid.release();

  // 3. A malformed lock file is never allowed to block forever either.
  const brokenPath = path.join(dir, "broken.lock");
  writeFileSync(brokenPath, "not json at all");
  const byMalformed = acquireLock(brokenPath, { staleAfterMs: CREATIVE_AI_WORKER_STALE_LOCK_MS });
  assert.equal(byMalformed.ok, true, "an unreadable lock file must not disable generation permanently");
  if (byMalformed.ok) byMalformed.release();
});

test("K. a fresh lock held by a live process cannot be stolen", async (t) => {
  const dir = tempDir(t);
  const lockPath = path.join(dir, ".run.lock");

  const held = acquireLock(lockPath, { staleAfterMs: CREATIVE_AI_WORKER_STALE_LOCK_MS });
  assert.equal(held.ok, true);

  const stolen = acquireLock(lockPath, { staleAfterMs: CREATIVE_AI_WORKER_STALE_LOCK_MS });
  assert.equal(stolen.ok, false, "a live, fresh lock must never be taken over");

  if (held.ok) held.release();
});

test("the stale-lock threshold is longer than the creative_ai outer ceiling but well under an hour", () => {
  assert.ok(
    CREATIVE_AI_WORKER_STALE_LOCK_MS > CREATIVE_AI_EXECUTOR_TIMEOUT_MS,
    "a healthy long generation must never be mistaken for a dead lock",
  );
  assert.equal(CREATIVE_AI_WORKER_STALE_LOCK_MS, 30 * 60 * 1000);
  assert.ok(CREATIVE_AI_WORKER_STALE_LOCK_MS < 60 * 60 * 1000, "a dead lock must not block generation for an hour on a one-minute cadence");
});

// --- §23 repository identity --------------------------------------------------------------------

test("the worker refuses to run against the wrong repository, before touching Supabase", async (t) => {
  const wrong = fakeProjectRoot(t, "time-audit");
  let clientCreated = false;

  const cli = await runCreativeAiWorkerCli({
    projectRoot: wrong,
    lockPath: path.join(wrong, "lock", ".run.lock"),
    envPath: path.join(wrong, ".env.missing"),
    createClient: async () => {
      clientCreated = true;
      return { ok: true, client: makeClient([jobRow()]).client };
    },
    runJob: async () => completed(),
  });

  assert.equal(cli.exitCode, 2, "wrong repository is a preflight abort");
  assert.equal(clientCreated, false, "no Supabase client may be created in the wrong repository");
  assert.equal(cli.result, undefined);
});

test("the identity guard accepts the real repository and rejects its neighbours", (t) => {
  const realRoot = path.resolve(import.meta.dirname, "..");
  const ok = verifyRepositoryIdentity(realRoot);
  assert.equal(ok.ok, true, "the actual Product Lab checkout must pass");

  const wrong = fakeProjectRoot(t, "some-other-project");
  const bad = verifyRepositoryIdentity(wrong);
  assert.equal(bad.ok, false);
  assert.match(!bad.ok ? bad.message : "", /Refusing to run/);

  // A directory with no package.json at all (e.g. a parent folder) is refused, not assumed fine.
  const empty = tempDir(t);
  const missing = verifyRepositoryIdentity(empty);
  assert.equal(missing.ok, false);
});

test("a correct repository proceeds to process the queue", async (t) => {
  const root = fakeProjectRoot(t);
  const store = makeClient([jobRow()]);
  let ran = false;

  const cli = await runCreativeAiWorkerCli({
    projectRoot: root,
    lockPath: path.join(root, "lock", ".run.lock"),
    envPath: path.join(root, ".env.missing"),
    createClient: async () => ({ ok: true, client: store.client }),
    runJob: async () => {
      ran = true;
      return completed();
    },
  });

  assert.equal(cli.exitCode, 0);
  assert.equal(ran, true);
});

test("missing credentials abort with the preflight code and never reach the queue", async (t) => {
  const root = fakeProjectRoot(t);
  const cli = await runCreativeAiWorkerCli({
    projectRoot: root,
    lockPath: path.join(root, "lock", ".run.lock"),
    envPath: path.join(root, ".env.missing"),
    createClient: async () => ({ ok: false, exitCode: 2, message: "Missing required Supabase credentials" }),
    runJob: async () => completed(),
  });

  assert.equal(cli.exitCode, 2);
  assert.equal(cli.result, undefined);
});

test("a zero-job run exits 0 -- the ordinary case on a one-minute cadence", async (t) => {
  const root = fakeProjectRoot(t);
  const cli = await runCreativeAiWorkerCli({
    projectRoot: root,
    lockPath: path.join(root, "lock", ".run.lock"),
    envPath: path.join(root, ".env.missing"),
    createClient: async () => ({ ok: true, client: makeClient([]).client }),
    runJob: async () => completed(),
  });

  assert.equal(cli.exitCode, 0);
  assert.equal(cli.result?.outcome, "no-op");
  assert.equal(cli.result?.queuedFound, 0);
});

// --- §24 Task Scheduler setup script -------------------------------------------------------------

test("the Task Scheduler setup script points at this repo, sets the working directory, and embeds no secret", () => {
  const ps1 = readFileSync(new URL("../scripts/creative-workers/install-background-worker.ps1", import.meta.url), "utf8");

  // Repo root is DERIVED, never a hardcoded personal path.
  assert.match(ps1, /\$PSScriptRoot/);
  assert.doesNotMatch(ps1, /C:\\Users\\Admin/i);
  assert.doesNotMatch(ps1, /C:\/Users\/Admin/i);

  // The working directory is set explicitly -- the System32 default is the mistake this prevents.
  assert.match(ps1, /-WorkingDirectory \$repoRoot/);

  // It invokes the one-shot worker, not a daemon or a different script.
  assert.match(ps1, /background-worker\.ts/);

  // Cadence is approximately once per minute.
  assert.match(ps1, /-RepetitionInterval \(New-TimeSpan -Minutes 1\)/);

  // It refuses to schedule against the wrong project.
  assert.match(ps1, /aly-shin-product-lab/);
  assert.match(ps1, /Refusing to schedule a worker against the wrong repository/);

  // No secret material of any kind is embedded or passed as an argument.
  for (const forbidden of [/ANTHROPIC_API_KEY/, /OPENAI_API_KEY/, /ADVISOR_SUPABASE_PASSWORD\s*=/, /anonKey/i, /-Password /, /ConvertTo-SecureString/]) {
    assert.doesNotMatch(ps1, forbidden);
  }

  // Task name matches what the worker module declares, so docs and code cannot drift.
  assert.ok(ps1.includes(CREATIVE_AI_WORKER_TASK_NAME));
});

test("the setup script preflights the three executables a scheduled process must resolve", () => {
  const ps1 = readFileSync(new URL("../scripts/creative-workers/install-background-worker.ps1", import.meta.url), "utf8");
  assert.match(ps1, /foreach \(\$tool in 'node', 'claude', 'codex'\)/);
  assert.match(ps1, /is not on PATH for this user/);
});

test("the worker builds no daemon, no polling loop, and no second execution path", () => {
  const raw = readFileSync(new URL("../scripts/creative-workers/background-worker.ts", import.meta.url), "utf8");
  // Comments are stripped first, mirroring the sqlStatementsOnly convention the schema tests use.
  // The module's own comments say "No while(true)" and "no Promise.all anywhere", so a naive text
  // search would match the very prose promising the opposite -- this must assert on CODE.
  const source = raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");

  // No daemon shapes.
  assert.doesNotMatch(source, /while\s*\(\s*true\s*\)/);
  assert.doesNotMatch(source, /setInterval/);
  assert.doesNotMatch(source, /\bcron\b/i);

  // No concurrency over jobs.
  assert.doesNotMatch(source, /Promise\.all/);
  assert.doesNotMatch(source, /Promise\.allSettled/);

  // No provider, prompt or AI logic -- the worker only invokes the existing runner.
  for (const forbidden of [/ANTHROPIC_API_KEY/, /OPENAI_API_KEY/, /systemPrompt/, /userPrompt/, /runCreativeGenerationWithProviders/]) {
    assert.doesNotMatch(source, forbidden);
  }

  // It does not reimplement claim/execution/persistence: it delegates to the trusted runner.
  assert.match(source, /runTrustedCreativeJobAndMaterializePackage/);
  assert.doesNotMatch(source, /claim_creative_job/);
  assert.doesNotMatch(source, /finish_creative_job/);
});
