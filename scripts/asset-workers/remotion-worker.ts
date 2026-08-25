import path from "node:path";
import { parseArgs } from "node:util";
import { createClient } from "@supabase/supabase-js";

import { listRunningAssetJobs, type AssetJobExecutionClient } from "../../src/lib/asset-jobs.ts";
import { bundleRemotionProductionModule } from "../../src/remotion/render.ts";
import {
  DEFAULT_STUCK_JOB_THRESHOLD_MS,
  DEFAULT_WORKER_POLL_INTERVAL_MS,
  recoverStuckRemotionJobs,
  runRemotionWorkerLoop,
  type RemotionWorkerJobOutcome,
} from "../../src/remotion/worker.ts";
import { loadEnvFile, readSupabaseCredentials } from "../daily-advisor/env.ts";
import { createInMemoryAssetJobStore, proofJobId } from "./in-memory-asset-job-store.ts";

// Production MVP Wave C2A -- the long-running Remotion worker process.
//
//   npm run remotion:worker                            poll live Supabase for queued remotion jobs
//   npm run remotion:worker -- --store memory --once   the controlled local proof (no live anything)
//   npm run remotion:worker -- --recover-stuck         one-shot stale-running recovery, then exit
//   npm run remotion:worker -- --recover-stuck --reconcile-storage --stale-minutes 45
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

// Injects one transient bundle failure, then builds for real. See the --fail-first-bundle note at the
// call site for why this exists.
function failFirstThenRealBundle(logLine: (line: string) => void): () => Promise<string> {
  let attempts = 0;
  return async () => {
    attempts += 1;
    if (attempts === 1) {
      logLine("bundle       INJECTED transient failure (--fail-first-bundle)");
      throw new Error("injected transient bundle failure");
    }
    logLine(`bundle       real build, attempt ${attempts}`);
    return bundleRemotionProductionModule();
  };
}

type WorkerStore = { client: AssetJobExecutionClient; describe: string; seededJobId?: string };

function appRoleFromAccessToken(accessToken: string): string | null {
  try {
    const payload = JSON.parse(Buffer.from(accessToken.split(".")[1] ?? "", "base64url").toString("utf8")) as {
      app_metadata?: { app_role?: unknown };
    };
    return typeof payload.app_metadata?.app_role === "string" ? payload.app_metadata.app_role : null;
  } catch {
    return null;
  }
}

function buildMemoryStore(): WorkerStore {
  const store = createInMemoryAssetJobStore();
  const creativePackageId = store.seedCreativePackage(proofReelPackageContent());
  // TWO jobs, so a proof run shows both halves of the bundle lifecycle: the first job survives a
  // transient build failure and then renders, and the second reuses the bundle that first job built.
  const first = proofJobId("wave-c2a-warm-open");
  const second = proofJobId("wave-c2b2-second-job");
  store.seedJob({ id: first, creative_package_id: creativePackageId, worker_type: "remotion", asset_kind: "short_video" });
  store.seedJob({ id: second, creative_package_id: creativePackageId, worker_type: "remotion", asset_kind: "short_video" });
  return { client: store.client, describe: "in-memory proof store (no live Supabase, no live storage)", seededJobId: `${first}, ${second}` };
}

async function buildSupabaseStore(): Promise<WorkerStore | { error: string }> {
  loadEnvFile(path.join(PROJECT_ROOT, ".env.production-workers.local"));
  const credentials = readSupabaseCredentials();
  if (!credentials.ok) {
    // Names only. Never values.
    return { error: `Missing Supabase credentials: ${credentials.missing.join(", ")}` };
  }
  const client = createClient(credentials.credentials.url, credentials.credentials.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const signedIn = await client.auth.signInWithPassword({
    email: credentials.credentials.email,
    password: credentials.credentials.password,
  });
  if (signedIn.error || !signedIn.data.session) {
    return { error: `Supabase sign-in failed for production worker credentials: ${signedIn.error?.message ?? "no session returned"}` };
  }
  const appRole = appRoleFromAccessToken(signedIn.data.session.access_token);
  if (appRole !== "creative_worker") {
    return { error: `Production worker credentials authenticated as ${appRole ?? "no app_role"}, expected creative_worker.` };
  }
  return { client: client as unknown as AssetJobExecutionClient, describe: "live Supabase asset_jobs" };
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
      "recover-stuck": { type: "boolean" },
      "stale-minutes": { type: "string" },
      "reconcile-storage": { type: "boolean" },
      "fail-first-bundle": { type: "boolean" },
    },
    allowPositionals: false,
  });

  const storeKind = values.store ?? "supabase";
  if (storeKind !== "supabase" && storeKind !== "memory") {
    console.error(`--store must be "supabase" or "memory". Received: ${storeKind}`);
    return 1;
  }

  const built = storeKind === "memory" ? buildMemoryStore() : await buildSupabaseStore();
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
  if (storeKind === "supabase") {
    log("auth         creative_worker");
  }
  log(`scratch root ${scratchRoot}`);
  log(`poll every   ${pollIntervalMs}ms`);
  log(`node         ${process.version} on ${process.platform}/${process.arch}`);
  if (built.seededJobId) {
    log(`seeded job   ${built.seededJobId}`);
  }

  // --- stale-running recovery, as an EXPLICIT one-shot mode -------------------------------------
  //
  // Wave C2B-2 wires the recovery helper C2A shipped but never called.
  //
  // EXPLICIT ON PURPOSE. This does not run at startup and is not part of the polling loop. A worker
  // that terminalized every old running job when it booted would, on the day two workers are ever run
  // at once, kill the other one's in-flight render -- and it would do it silently, at the moment an
  // operator was least expecting side effects. The conservative model is that a human asks.
  //
  // It also returns BEFORE the poll loop starts, so recovery can be run against a machine that is not
  // currently rendering anything.
  if (values["recover-stuck"] === true) {
    const staleMinutes = values["stale-minutes"] ? Number(values["stale-minutes"]) : DEFAULT_STUCK_JOB_THRESHOLD_MS / 60_000;
    if (!Number.isFinite(staleMinutes) || staleMinutes <= 0) {
      console.error(`--stale-minutes must be a positive number of minutes. Received: ${values["stale-minutes"]}`);
      return 1;
    }
    const thresholdMs = staleMinutes * 60_000;
    const reconcileStorage = values["reconcile-storage"] === true;

    log(`mode         stale-running recovery (one-shot, no poll loop)`);
    log(`threshold    ${staleMinutes} minute(s)`);
    log(`reconcile    ${reconcileStorage ? "yes -- orphaned storage objects for recovered jobs will be removed" : "no (pass --reconcile-storage to enable)"}`);

    // Only remotion jobs are read, and recoverStuckRemotionJobs re-checks the worker type anyway --
    // the query narrows, the helper enforces.
    const running = await listRunningAssetJobs(built.client, 100, "remotion");
    if (!running.ok) {
      console.error(`Could not list running Asset Jobs: ${running.message}`);
      return 1;
    }
    log(`running      ${running.jobs.length} remotion job(s) currently in running state`);

    const recoveries = await recoverStuckRemotionJobs(built.client, running.jobs, { thresholdMs, reconcileStorage });
    if (recoveries.length === 0) {
      log("result       no stale jobs past the threshold -- nothing was changed.");
      return 0;
    }

    let unrecovered = 0;
    for (const recovery of recoveries) {
      // Job id, attempt number and outcome. No credential, URL or key is reachable from here.
      log(`  job=${recovery.jobId} attempt=${recovery.attemptNumber} startedAt=${recovery.startedAt} recovered=${recovery.recovered}`);
      log(`     ${recovery.message}`);
      if (recovery.reconciliation) {
        const r = recovery.reconciliation;
        log(`     storage: ${r.attempted ? `found=${r.found.length} removed=${r.removed.length} failed=${r.failed.length}` : `not attempted (${r.reason})`} -- ${r.message}`);
      }
      if (!recovery.recovered) {
        unrecovered += 1;
      }
    }
    log(`result       ${recoveries.length - unrecovered} recovered, ${unrecovered} left for a later run.`);

    // Non-zero when something was deliberately left behind, so a scheduled invocation surfaces it.
    return unrecovered === 0 ? 0 : 1;
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

  const { processed, polls, workerFailures } = await runRemotionWorkerLoop(
    built.client,
    {
      scratchRoot,
      brandMark: values["brand-mark"] ?? "Aly & Pon",
      pollIntervalMs,
      keepRenderArtifacts: values["keep-artifacts"] === true,
      log,
      // --fail-first-bundle is a PROOF AFFORDANCE, in the same spirit as --store memory: it makes the
      // C2B-2 daemon-resilience claim reproducible by anyone, instead of resting on a run nobody else
      // can repeat. It injects exactly ONE transient build failure and then defers to the real
      // bundler, so the second attempt is a genuine webpack build and a genuine render.
      //
      // Undefined when the flag is absent, which leaves RemotionBundleHost on its real default.
      bundleBuild: values["fail-first-bundle"] === true ? failFirstThenRealBundle(log) : undefined,
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

  log(`stopped after ${polls} poll(s), ${summary.length} job(s) processed, ${workerFailures.length} worker-level failure(s) survived.`);
  for (const failure of workerFailures) {
    log(`  SURVIVED job=${failure.jobId} ${failure.message}`);
  }

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
