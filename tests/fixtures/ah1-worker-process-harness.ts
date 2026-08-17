import path from "node:path";

import {
  createTimeoutFetch,
  runCreativeAiWorkerCli,
  type CreativeAiWorkerClient,
} from "../../scripts/creative-workers/background-worker.ts";
import type { CreativePackageMaterializedRunResult } from "../../src/lib/creative-packages.ts";
import type { CreativeJobRow } from "../../src/lib/creative-jobs.ts";

// Content MVP AH1 §23 -- the child process the worker lifecycle tests actually observe.
//
// This exists because "runWorker() resolved" is not the property that broke. The production incident
// was a process that finished no work, reported nothing, and STAYED ALIVE holding the run lock, so
// the only test that can catch it has to watch a real OS process terminate. That is what this file
// is spawned as.
//
// TWO DELIBERATE DEPARTURES FROM THE REAL ENTRYPOINT, both load-bearing:
//
//   1. It never calls process.exit(). The real main() does, and process.exit() would mask exactly the
//      defect class under test by tearing down the process regardless of what is still holding it
//      open. Setting process.exitCode and letting Node exit on its own means this process terminates
//      ONLY if nothing is left on the event loop -- which is the actual assertion.
//
//   2. Its clients are injected. No Supabase project is contacted, no Claude or Codex CLI is
//      spawned, and no production row is read or written by any scenario here.
//
// Everything between those two ends -- the identity guard, the lock, the queue read, the serial job
// loop, the exit-code contract and the finally-release -- is the real runCreativeAiWorkerCli.

type Scenario = "empty" | "success" | "failure" | "stalled" | "locked";

const [, , rawScenario, lockPath, blackholePort] = process.argv;
const scenario = rawScenario as Scenario;

// Counted rather than assumed. A zero-job run that quietly invoked the runner would still exit, so
// the exit assertion alone cannot prove the AI was left alone -- this number is what proves it.
let runJobCalls = 0;

function queueClient(rows: CreativeJobRow[]): CreativeAiWorkerClient {
  // Honours the eq()/order()/limit() chain listQueuedCreativeJobs actually builds, so the worker's
  // own queue filtering runs rather than being bypassed by a stub that returns rows unconditionally.
  function builder() {
    const filters: Record<string, string> = {};
    let limitValue: number | null = null;
    const self = {
      eq(column: string, value: string) {
        filters[column] = value;
        return self;
      },
      order: () => self,
      limit(count: number) {
        limitValue = count;
        return self;
      },
      then(resolve: (value: { data: CreativeJobRow[] | null; error: null }) => unknown, reject?: (reason: unknown) => unknown) {
        const matched = rows.filter((row) =>
          Object.entries(filters).every(([column, value]) => (row as unknown as Record<string, unknown>)[column] === value),
        );
        return Promise.resolve({ data: limitValue === null ? matched : matched.slice(0, limitValue), error: null }).then(resolve, reject);
      },
    };
    return self;
  }

  return { from: () => ({ select: () => builder() }) } as unknown as CreativeAiWorkerClient;
}

function queuedRow(): CreativeJobRow {
  return {
    id: "ah1-job-1",
    opportunity_id: null,
    intent: { schemaVersion: "v1", text: "Give me something easy today" },
    status: "queued",
    worker_type: "creative_ai",
    attempt_count: 0,
    result: {},
    last_error: null,
    created_at: "2026-08-17T09:00:00.000Z",
    updated_at: "2026-08-17T09:00:00.000Z",
    started_at: null,
    completed_at: null,
    failed_at: null,
  };
}

// The pre-AH1 failure mode, reproduced without a Supabase project: a socket that ACCEPTS the
// connection and then never answers. Before AH1 this await never settled and the process never
// exited; the only reason it now does is the bounded fetch the real createRealClient installs, which
// is the same function called here.
async function stalledClient(): Promise<{ ok: false; exitCode: number; message: string }> {
  // A short bound rather than the production 30s: the property under test is that the await settles
  // and the process is released at all, and asserting that takes the same shape at 300ms as at 30s.
  // The production constant is asserted separately, as a value, by the worker test file.
  const boundedFetch = createTimeoutFetch(300);
  try {
    await boundedFetch(`http://127.0.0.1:${blackholePort}/auth/v1/token`, { method: "POST" });
    return { ok: false, exitCode: 1, message: "black-hole endpoint unexpectedly answered" };
  } catch (err) {
    return { ok: false, exitCode: 1, message: `Supabase sign-in failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function createClient(): Promise<{ ok: true; client: CreativeAiWorkerClient } | { ok: false; exitCode: number; message: string }> {
  if (scenario === "stalled") {
    return stalledClient();
  }
  return { ok: true, client: queueClient(scenario === "empty" || scenario === "locked" ? [] : [queuedRow()]) };
}

async function runJob(): Promise<CreativePackageMaterializedRunResult> {
  runJobCalls += 1;
  if (scenario === "failure") {
    return { ok: false, reason: "failed", message: "Creative AI generation failed at the creative_body stage: usage_limit." };
  }
  return { ok: true, job: { id: "ah1-job-1" } as never, packageOutcome: "created", creativePackage: { id: "ah1-package-1" } as never };
}

const result = await runCreativeAiWorkerCli({
  // The harness's own directory is not the repo root, so the identity guard is pointed at the real
  // one -- the guard itself is not what these tests stub out.
  projectRoot: path.resolve(import.meta.dirname, "..", ".."),
  lockPath,
  // Deliberately a path that does not exist. loadEnvFile treats a missing file as "nothing to load"
  // and returns, which keeps every credential in this run injected rather than read from disk.
  envPath: path.join(path.dirname(lockPath), ".env.does-not-exist"),
  createClient,
  runJob,
});

// stdout is the test's only channel, so it is one parseable line and nothing else.
console.log(`AH1_RESULT ${JSON.stringify({ exitCode: result.exitCode, skipped: result.skipped ?? null, outcome: result.result?.outcome ?? null, processed: result.result?.processed ?? [], runJobCalls })}`);

// Sets the code WITHOUT forcing termination. If anything the worker touched left a timer, socket,
// or handle behind, this process now hangs and the spawning test fails on its budget -- which is
// precisely the regression the production incident demanded.
process.exitCode = result.exitCode;
