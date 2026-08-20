import { runAssetJobWithExecutors, type AssetJobExecutionClient, type AssetJobRecord, type AssetSourceKind } from "./asset-jobs.ts";
import { buildManualIllustrationExecutor, type ManualIllustration } from "./production-manual-composition.ts";
import type { AssetFileRecord } from "./asset-files.ts";
import { MACHINE_PRODUCTION_WORKER_TYPES, isMachineProductionWorkerType, type MachineProductionWorkerType } from "./production-route.ts";
import {
  PRODUCTION_EXECUTOR_TIMEOUTS_MS,
  buildCloudflareGenerativeImageExecutor,
  buildStaticRendererExecutor,
  cloudflareGenerativeImageConfigFromEnv,
  type GenerativeImageProvenance,
} from "./production-asset-executors.ts";

// Production MVP Wave B -- THE single callable execution boundary for machine production.
//
// Both callers go through this and neither reimplements it:
//
//   scripts/asset-workers/run.ts  -- the trusted CLI (technical / acceptance testing)
//   src/app/api/production/route.ts -- the owner-facing app
//
// That is the whole point of the module. The CLI grew this logic first; copying it into a route
// handler would have produced a second production pipeline that drifts -- a different timeout here,
// a forgotten provenance capture there -- and the reviewed guarantees (validation, byte inspection,
// materialization, attempt lifecycle, provenance) would only hold on whichever path someone last
// remembered to update.
//
// Everything below the executor construction is the EXISTING reviewed architecture, untouched:
// runAssetJobWithExecutors -> executor -> validateGeneratedAssetCandidates -> validateAssetCandidateBytes
// -> materializeAssetJobFiles -> Asset / AssetFile. There is no alternate storage path here and no
// second attempt system.

// One source of truth, declared in the client-safe pure module so a browser bundle can ask the same
// question without importing this file (which reaches satori/resvg/sharp).
export type ProductionWorkerType = MachineProductionWorkerType;
export { MACHINE_PRODUCTION_WORKER_TYPES as PRODUCTION_WORKER_TYPES, isMachineProductionWorkerType as isProductionWorkerType };

// --- execution timeouts, per CALLER not just per executor --------------------------------------------
//
// The CLI runs in a plain Node process with no external ceiling, so it uses the executor's own
// budget (PRODUCTION_EXECUTOR_TIMEOUTS_MS: 120s for a provider call).
//
// A route handler does NOT have that freedom. It runs inside a serverless function with a platform
// maximum, and if the platform kills the invocation first, nothing writes a terminal state: the job
// is left `running`, its attempt is left `running`, and there is no stale-recovery function in this
// schema to clean either up. So the web budget is deliberately set BELOW the route's declared
// maxDuration, which guarantees OUR timeout fires first and records a truthful `timed_out` attempt.
//
// The numbers are sized from measured reality, not guesswork: the accepted Wave B runs recorded
// Cloudflare latencies of 1.6s-4.7s and static renders of ~0.5s. 45s is roughly ten times the
// slowest generation ever observed, and still leaves headroom under a 60s maxDuration for the
// bounded transport retry (one retry plus a backoff clamped to 10s).
export const WEB_PRODUCTION_EXECUTOR_TIMEOUTS_MS = {
  static_renderer: 20_000,
  generative_image: 45_000,
} as const satisfies Record<ProductionWorkerType, number>;

export const CLI_PRODUCTION_EXECUTOR_TIMEOUTS_MS = PRODUCTION_EXECUTOR_TIMEOUTS_MS;

// Manual composition is the SAME local, CPU-bound work as a static render -- satori, resvg and sharp
// over one frame, plus one extra sharp composite for the illustration band. No provider is contacted:
// by the time this runs, the owner has already obtained the illustration out of band. So it is
// budgeted with the static renderer, not with the generative path, and the web value stays well under
// the route's maxDuration for the same reason the others do.
export const WEB_MANUAL_ILLUSTRATION_TIMEOUT_MS = 20_000;
export const MANUAL_ILLUSTRATION_TIMEOUT_MS = 30_000;

// --- outcome ------------------------------------------------------------------------------------------
//
// Deliberately distinguishes "nothing was produced" from "the asset WAS produced but bookkeeping
// failed", because those demand opposite responses from whoever is looking at them: the first is
// safe to retry, the second must NOT be retried (it would produce a second asset) and needs a
// migration applied instead. The CLI turns this into exit codes; the route turns it into HTTP
// statuses; neither invents the distinction itself.
export type ProductionExecutionOutcome =
  | {
      kind: "completed";
      job: AssetJobRecord;
      assetId: string;
      files: AssetFileRecord[];
      provenance?: GenerativeImageProvenance;
    }
  | {
      kind: "bookkeeping-failed";
      job: AssetJobRecord;
      assetId: string;
      files: AssetFileRecord[];
      message: string;
      provenance?: GenerativeImageProvenance;
    }
  // The generative executor could not even be constructed -- Cloudflare credentials are absent.
  // Distinct from "failed" because nothing was attempted and no job state changed.
  | { kind: "not-configured"; message: string }
  | {
      kind: "failed";
      reason: ProductionFailureReason;
      message: string;
      job?: AssetJobRecord;
      provenance?: GenerativeImageProvenance;
    };

// The three UPSTREAM reasons, added in Wave B so the owner can be offered the right next move rather
// than one undifferentiated "production failed".
//
//   quota       -- the provider rate-limited or exhausted the allowance (429)
//   auth        -- the credential was rejected (401/403)
//   unavailable -- the provider or its gateway is down (502/503/504)
//
// All three mean the same thing to the owner -- no automated illustration right now -- and the same
// thing operationally: do not keep asking Cloudflare inside this action. They stay distinct because
// they need different fixes from whoever reads the diagnostics.
export type ProductionFailureReason =
  | "missing-table"
  | "not-found"
  | "not-queued"
  | "conflict"
  | "failed"
  | "timeout"
  | "quota"
  | "auth"
  | "unavailable";

// The one status -> reason mapping. Derived from the HTTP status the executor actually observed and
// reported through onTransportFailure -- never from matching text in an error message.
export function classifyTransportFailureStatus(status: number): ProductionFailureReason | null {
  if (status === 429) {
    return "quota";
  }
  if (status === 401 || status === 403) {
    return "auth";
  }
  if (status === 502 || status === 503 || status === 504) {
    return "unavailable";
  }
  return null;
}

// True when there is no point asking Cloudflare again right now, and the owner should be shown the
// manual and static alternatives instead of a retry. "not-configured" is handled separately because
// no job state changed at all.
export function isUpstreamProductionFailure(reason: ProductionFailureReason): boolean {
  return reason === "quota" || reason === "auth" || reason === "unavailable";
}

export type ProductionExecutionOptions = {
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
};

export async function executeProductionAssetJob(
  client: AssetJobExecutionClient,
  jobId: string,
  workerType: ProductionWorkerType,
  options: ProductionExecutionOptions = {},
): Promise<ProductionExecutionOutcome> {
  // Captured from the executor that actually ran, never reconstructed from config afterwards, so a
  // model override or a retried transport attempt is reported as it happened.
  let provenance: GenerativeImageProvenance | undefined;
  // Set only when the executor reported the status of a request that finally failed. Read once,
  // below, to upgrade the runner's generic "failed" into the specific upstream reason.
  let transportFailureReason: ProductionFailureReason | undefined;

  let executors;
  if (workerType === "static_renderer") {
    executors = { static_renderer: buildStaticRendererExecutor() };
  } else {
    try {
      executors = {
        generative_image: buildCloudflareGenerativeImageExecutor({
          ...cloudflareGenerativeImageConfigFromEnv(options.env),
          onProvenance: (captured) => {
            provenance = captured;
          },
          onTransportFailure: ({ status }) => {
            transportFailureReason = classifyTransportFailureStatus(status) ?? undefined;
          },
        }),
      };
    } catch (err) {
      // The only thing this can throw is the missing-credentials guard. The message names the two
      // environment VARIABLES; it never contains a value.
      return { kind: "not-configured", message: err instanceof Error ? err.message : String(err) };
    }
  }

  const timeoutMs = options.timeoutMs ?? PRODUCTION_EXECUTOR_TIMEOUTS_MS[workerType];

  // sourceKind is NOT passed: the runner derives it from the worker that ran, so a generated
  // illustration is always recorded ai_generated and a deterministic render never is. provider/model
  // are not passed either -- the executor reports them to the runner through the execution context.
  const result = await runAssetJobWithExecutors(client, jobId, executors, { timeoutMs });

  if (!result.ok) {
    // The upstream reason WINS over the runner's generic "failed", but only over that: a
    // not-found/not-queued/timeout is a real answer about this job's own state and must not be
    // relabelled as a provider outage.
    const reason = result.reason === "failed" && transportFailureReason ? transportFailureReason : result.reason;
    return { kind: "failed", reason, message: result.message, job: result.job, provenance };
  }

  // A successful run always materialized, so this is defensive rather than expected.
  const materialized = result.materialization?.ok ? result.materialization.materialized : null;
  if (!materialized) {
    return { kind: "failed", reason: "failed", message: "Asset Job completed without materializing an Asset.", job: result.job, provenance };
  }

  if (result.attempt && !result.attempt.ok) {
    return {
      kind: "bookkeeping-failed",
      job: result.job,
      assetId: materialized.asset.id,
      files: materialized.files,
      message: result.attempt.message,
      provenance,
    };
  }

  return { kind: "completed", job: result.job, assetId: materialized.asset.id, files: materialized.files, provenance };
}

// --- the manual path ---------------------------------------------------------------------------------
//
// A SIBLING of executeProductionAssetJob, not a mode of it, because the two take genuinely different
// inputs: the automated function is handed a worker name and finds its own bytes, while this one is
// handed the bytes and already knows its worker. Folding them together would have meant an optional
// illustration parameter that is required for one worker and forbidden for the other two -- a shape
// that cannot be read correctly without knowing which branch you are in.
//
// Everything AFTER executor construction is deliberately identical, and shared through the same
// runAssetJobWithExecutors call: validation, byte inspection, materialization, attempt lifecycle and
// the outcome mapping below. There is no second storage path and no second attempt system here,
// which is the same guarantee the module header already makes for the automated callers.
export type ManualIllustrationExecutionOptions = {
  timeoutMs?: number;
  // Operator-declared creative origin. Threaded straight through to the runner, which honours it
  // because manual_illustration is deliberately absent from MACHINE_EXECUTOR_SOURCE_KINDS -- only the
  // owner knows which tool actually made the illustration.
  sourceKind?: AssetSourceKind;
  sourceWorkspace?: string;
};

export async function executeManualIllustrationAssetJob(
  client: AssetJobExecutionClient,
  jobId: string,
  illustration: ManualIllustration,
  options: ManualIllustrationExecutionOptions = {},
): Promise<ProductionExecutionOutcome> {
  const result = await runAssetJobWithExecutors(
    client,
    jobId,
    { manual_illustration: buildManualIllustrationExecutor(illustration) },
    {
      timeoutMs: options.timeoutMs ?? MANUAL_ILLUSTRATION_TIMEOUT_MS,
      sourceKind: options.sourceKind,
      sourceWorkspace: options.sourceWorkspace,
    },
  );

  if (!result.ok) {
    // No transport reason to fold in: nothing here contacts a provider, so a failure is this job's
    // own state or the composition itself (e.g. CopyDoesNotFitError), never an upstream outage.
    return { kind: "failed", reason: result.reason, message: result.message, job: result.job };
  }

  const materialized = result.materialization?.ok ? result.materialization.materialized : null;
  if (!materialized) {
    return { kind: "failed", reason: "failed", message: "Asset Job completed without materializing an Asset.", job: result.job };
  }

  if (result.attempt && !result.attempt.ok) {
    return {
      kind: "bookkeeping-failed",
      job: result.job,
      assetId: materialized.asset.id,
      files: materialized.files,
      message: result.attempt.message,
    };
  }

  return { kind: "completed", job: result.job, assetId: materialized.asset.id, files: materialized.files };
}
