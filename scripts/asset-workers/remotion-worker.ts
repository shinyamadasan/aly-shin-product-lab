import path from "node:path";
import { parseArgs } from "node:util";
import { createClient } from "@supabase/supabase-js";

import type { AssetJobExecutionClient } from "../../src/lib/asset-jobs.ts";
import { DEFAULT_WORKER_POLL_INTERVAL_MS, runRemotionWorkerLoop, type RemotionWorkerJobOutcome } from "../../src/remotion/worker.ts";
import { loadEnvFile, readSupabaseCredentials } from "../daily-advisor/env.ts";
import { createInMemoryAssetJobStore, proofJobId } from "./in-memory-asset-job-store.ts";

// Production MVP Wave C2A -- the long-running Remotion worker process.
//
//   npm run remotion:worker                 poll live Supabase for queued remotion jobs
//   npm run remotion:worker -- --store memory --once   the controlled local proof (no live anything)
//
// WHAT IT IS. One process that starts, polls at a bounded interval, claims one executable job at a
// time, runs it to a terminal state, and keeps going until it is asked to stop. No manual action
// between jobs. Deliberately NOT a Windows Scheduled Task: C2A's job is to prove the worker process
// itself, and a scheduler on top of an unproven process only makes a failure harder to see.
//
// CREDENTIALS ARE NEVER PRINTED. The only thing logged about the connection is the fact that one was
// established; readSupabaseCredentials reports missing KEY NAMES, never values, and no code path here
// echoes a URL, key, token or password.
//
// HOST INDEPENDENCE. Everything machine-specific lives in this file's option values -- the scratch
// root, the poll interval, the brand mark. None of it reaches a job payload, a spec or a database
// row. Running this on a Linux container is a different --scratch-root and nothing else.

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..", "..");
const DEFAULT_SCRATCH_ROOT = path.join(PROJECT_ROOT, "outputs", "remotion-worker");

function log(line: string): void {
  console.log(`[remotion-worker] ${line}`);
}

// The controlled proof fixture: a valid v2 reel Creative Package. Written here rather than read from
// anywhere so the proof depends on no live data.
//
// IT DELIBERATELY CARRIES NO productionSource, and that is still a valid package shape.
//
// WHAT CHANGED SINCE THIS FIXTURE WAS WRITTEN. When C2A shipped, validateCreativePackageContentV2
// refused "reel + template_only" outright ("a Reel is filmed"), so no Creative Package could be
// authored that resolved to the Remotion route at all, and this fixture omitted productionSource to
// sidestep that honestly. Wave C2B-1 closed exactly that mismatch. The current truth is:
//
//   - CreativePackageContentV2 now PERMITS a narrowly valid reel + template_only package: ordered
//     shots with directions, no camera framing, a positive target duration, and spokenScript null.
//   - production-route.ts resolves that combination to remotion + short_video, as it has since
//     Wave A froze the row.
//   - owner/API execution is STILL intentionally disabled. EXECUTABLE_ASSET_KINDS remains ["image"],
//     remotion is absent from both the app-creatable and the production-API worker sets, and
//     createAssetJobForReadyCreativePackage still refuses the pair. The worker knows how; the
//     application still may not ask.
//
// WHY THE FIXTURE IS UNCHANGED ANYWAY. A Reel with no productionSource is the legitimate pre-H1-B
// shape, it validates, and buildProductionSpec reads only schemaVersion + format when building a
// short_video spec -- it never consults productionSource. So this proof exercises the identical
// executor path either way, and leaving it alone keeps the C2A proof byte-for-byte the one that was
// independently reproduced. Switching it to a real template_only package is a fair follow-up, not a
// correction.
//
// C2B-2 and C2B-3 still own operational hardening and live activation respectively.
function proofReelPackageContent() {
  return {
    schemaVersion: "v2",
    format: "reel",
    subject: "The morning sourdough",
    angle: "The quiet moment before the shop opens",
    hook: "Baked this morning",
    headline: "The kind of loaf that makes a room go quiet.",
    caption: "Slow-proofed overnight and out of the oven at seven. A social caption that belongs under the post and never on the picture.",
    cta: "Order the morning batch",
    platformVariants: [{ platform: "instagram", caption: "Out at seven.", hashtags: ["#sourdough"] }],
    metadata: {
      generatedFromOpportunity: "opp-proof",
      generatorVersion: "2",
      sourceCreativeJobId: "job-proof",
      sourceWorker: "mock",
      sourceJobResultSchemaVersion: "v2",
      formatChosenBy: "ai",
      formatRationale: "A slow reveal suits the subject.",
      subjectSource: "stated",
      subjectGrounding: null,
    },
    shots: [
      { direction: "Slow push on the cooling rack", onScreenText: "Baked this morning", approxSeconds: 4 },
      { direction: "Hands tearing the crust", onScreenText: "Slow-proofed overnight", approxSeconds: 4 },
    ],
    spokenScript: null,
    audioDirection: "Warm room tone, no music.",
    targetDurationSeconds: 8,
  };
}

type WorkerStore = { client: AssetJobExecutionClient; describe: string; seededJobId?: string };

function buildMemoryStore(): WorkerStore {
  const store = createInMemoryAssetJobStore();
  const creativePackageId = store.seedCreativePackage(proofReelPackageContent());
  const jobId = proofJobId("wave-c2a-warm-open");
  store.seedJob({ id: jobId, creative_package_id: creativePackageId, worker_type: "remotion", asset_kind: "short_video" });
  return { client: store.client, describe: "in-memory proof store (no live Supabase, no live storage)", seededJobId: jobId };
}

function buildSupabaseStore(): WorkerStore | { error: string } {
  loadEnvFile(path.join(PROJECT_ROOT, ".env.production-workers.local"));
  const credentials = readSupabaseCredentials();
  if (!credentials.ok) {
    // Names only. Never values.
    return { error: `Missing Supabase credentials: ${credentials.missing.join(", ")}` };
  }
  const client = createClient(credentials.credentials.url, credentials.credentials.anonKey) as unknown as AssetJobExecutionClient;
  return { client, describe: "live Supabase asset_jobs" };
}

export async function main(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      store: { type: "string" },
      "poll-interval": { type: "string" },
      "scratch-root": { type: "string" },
      "brand-mark": { type: "string" },
      once: { type: "boolean" },
      "keep-artifacts": { type: "boolean" },
    },
    allowPositionals: false,
  });

  const storeKind = values.store ?? "supabase";
  if (storeKind !== "supabase" && storeKind !== "memory") {
    console.error(`--store must be "supabase" or "memory". Received: ${storeKind}`);
    return 1;
  }

  const built = storeKind === "memory" ? buildMemoryStore() : buildSupabaseStore();
  if ("error" in built) {
    console.error(built.error);
    return 1;
  }

  const scratchRoot = values["scratch-root"] ? path.resolve(values["scratch-root"]) : DEFAULT_SCRATCH_ROOT;
  const pollIntervalMs = values["poll-interval"] ? Number(values["poll-interval"]) : DEFAULT_WORKER_POLL_INTERVAL_MS;
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 100) {
    console.error(`--poll-interval must be at least 100ms. Received: ${values["poll-interval"]}`);
    return 1;
  }

  log(`store        ${built.describe}`);
  log(`scratch root ${scratchRoot}`);
  log(`poll every   ${pollIntervalMs}ms`);
  log(`node         ${process.version} on ${process.platform}/${process.arch}`);
  if (built.seededJobId) {
    log(`seeded job   ${built.seededJobId}`);
  }

  // --- graceful shutdown ----------------------------------------------------------------------------
  //
  // WHAT ACTUALLY HAPPENS, stated exactly.
  //
  // SIGINT/SIGTERM sets a stop flag. runRemotionWorkerLoop consults shouldStop() before each poll and
  // after each idle wait, so the process stops BETWEEN jobs.
  //
  // A job that is already claimed and rendering when the signal arrives RUNS TO COMPLETION -- render,
  // probe, byte validation, materialization, its terminal write, and its artifact cleanup all finish
  // normally. The loop then stops before claiming another. There is no mid-render cancellation and no
  // job is failed because someone pressed Ctrl-C: a render that succeeded is recorded as succeeding.
  //
  // WHAT THIS DOES NOT COVER, and it is important that the comment does not pretend otherwise: a
  // FORCED kill (kill -9, a closed console, power loss) can still leave a job 'running' with no
  // process intending to finish it. This schema has no lease to expire it. That debt is handled only
  // by recoverStuckRemotionJobs -- which is a helper this CLI does not yet call -- and by C2B's
  // operational wiring.
  //
  // OPERATIONAL DEBT, recorded rather than fixed here: a second Ctrl-C does not force-quit. Once the
  // stop flag is set, the process waits for the current render (~10s for warm-open) regardless of how
  // many more signals arrive.
  let stopping = false;

  const requestStop = (signal: string) => {
    if (stopping) {
      return;
    }
    stopping = true;
    log(`${signal} received -- finishing the current job, then stopping.`);
  };
  process.on("SIGINT", () => requestStop("SIGINT"));
  process.on("SIGTERM", () => requestStop("SIGTERM"));

  const summary: RemotionWorkerJobOutcome[] = [];

  const { processed, polls } = await runRemotionWorkerLoop(
    built.client,
    {
      scratchRoot,
      brandMark: values["brand-mark"] ?? "Aly & Pon",
      pollIntervalMs,
      keepRenderArtifacts: values["keep-artifacts"] === true,
      log,
    },
    {
      shouldStop: () => stopping,
      // --once turns the daemon into a single-pass run for the controlled proof and for a manual
      // drain. It stops on the first IDLE poll, never mid-queue, so it still drains everything that
      // was waiting rather than doing exactly one job.
      onIdle: () => {
        if (values.once === true) {
          stopping = true;
          log("queue is empty and --once was passed -- stopping.");
        }
      },
    },
  );
  summary.push(...processed);

  log(`stopped after ${polls} poll(s), ${summary.length} job(s) processed.`);

  let failures = 0;
  for (const outcome of summary) {
    if (outcome.result.ok) {
      log(`RESULT job=${outcome.jobId} completed`);
    } else {
      failures += 1;
      log(`RESULT job=${outcome.jobId} FAILED reason=${outcome.result.reason}: ${outcome.result.message}`);
    }
  }

  return failures === 0 ? 0 : 1;
}

process.exitCode = await main(process.argv.slice(2));
