export const ASSET_JOB_ATTEMPT_STATUSES = ["running", "completed", "failed", "timed_out"] as const;
export type AssetJobAttemptStatus = (typeof ASSET_JOB_ATTEMPT_STATUSES)[number];

export type AssetJobAttemptRow = {
  id?: string;
  asset_job_id: string;
  attempt_number: number;
  worker_type: string;
  status: AssetJobAttemptStatus;
  started_at: string;
  completed_at?: string | null;
  latency_ms?: number | null;
  error_code?: string | null;
  error_message?: string | null;
  provider?: string | null;
  model?: string | null;
  created_at?: string;
};

export type AssetJobAttemptRecord = {
  id: string;
  assetJobId: string;
  attemptNumber: number;
  workerType: string;
  status: AssetJobAttemptStatus;
  startedAt: string;
  completedAt: string;
  latencyMs: number | null;
  errorCode: string;
  errorMessage: string;
  provider: string;
  model: string;
  createdAt: string;
};

type SupabaseErrorLike = {
  code?: string;
  message: string;
};

type QueryResult<T> = PromiseLike<{ data: T | null; error: SupabaseErrorLike | null }>;

// No `from(...)`/`update(...)` here -- finishAssetJobAttempt's only interaction with this table
// is the finish_asset_job_attempt RPC below, mirroring CreativeJobAttemptClient exactly. There is
// no other writer of this table.
export type AssetJobAttemptClient = {
  rpc(
    functionName: "finish_asset_job_attempt",
    args: { p_attempt_id: string; p_outcome: string; p_error_code: string | null; p_error_message: string | null },
  ): {
    maybeSingle(): QueryResult<AssetJobAttemptRow>;
  };
};

export type AssetJobAttemptFinishResult =
  | { ok: true; attemptId: string }
  | { ok: false; reason: "missing-table" | "not-found" | "failed"; message: string };

function isMissingTableError(error: SupabaseErrorLike): boolean {
  return error.code === "PGRST205" || error.code === "42P01";
}

function dbErrorResult(error: SupabaseErrorLike): { reason: "missing-table" | "failed"; message: string } {
  if (isMissingTableError(error)) {
    return {
      reason: "missing-table",
      message: "Asset Job attempts are not available yet. Verify supabase-add-asset-job-attempts.sql has been applied to this Supabase project.",
    };
  }

  return { reason: "failed", message: error.message };
}

export function isAssetJobAttemptStatus(value: string): value is AssetJobAttemptStatus {
  return ASSET_JOB_ATTEMPT_STATUSES.includes(value as AssetJobAttemptStatus);
}

export function fromAssetJobAttemptRow(row: AssetJobAttemptRow): AssetJobAttemptRecord {
  if (!row.id || !row.created_at) {
    throw new Error("Asset Job attempt row is missing id or created_at.");
  }

  return {
    id: row.id,
    assetJobId: row.asset_job_id,
    attemptNumber: row.attempt_number,
    workerType: row.worker_type,
    status: isAssetJobAttemptStatus(row.status) ? row.status : "running",
    startedAt: row.started_at,
    completedAt: row.completed_at ?? "",
    latencyMs: row.latency_ms ?? null,
    errorCode: row.error_code ?? "",
    errorMessage: row.error_message ?? "",
    provider: row.provider ?? "",
    model: row.model ?? "",
    createdAt: row.created_at,
  };
}

// Called after the job-level complete/fail write already succeeded (job-first, attempt-second):
// a crash between the two writes leaves the job correctly terminal and only the attempt
// cosmetically stale, never the reverse -- mirrors finishCreativeJobAttempt exactly. Failure here
// is deliberately non-fatal to the caller's job result -- see AssetJobRunnerResult's optional
// `attempt` field in asset-jobs.ts.
//
// completed_at and latency_ms are computed entirely inside finish_asset_job_attempt from the
// database's own now() and the row's own started_at -- no timestamp is accepted here or passed
// to the RPC, so this function cannot produce a mixed-clock terminal record even if a caller
// wanted it to.
export async function finishAssetJobAttempt(
  client: AssetJobAttemptClient,
  attemptId: string,
  outcome: Exclude<AssetJobAttemptStatus, "running">,
  details: { errorCode?: string; errorMessage?: string } = {},
): Promise<AssetJobAttemptFinishResult> {
  const result = await client
    .rpc("finish_asset_job_attempt", {
      p_attempt_id: attemptId,
      p_outcome: outcome,
      p_error_code: outcome === "completed" ? null : (details.errorCode ?? "failed"),
      p_error_message: outcome === "completed" ? null : (details.errorMessage ?? "Asset Job attempt failed."),
    })
    .maybeSingle();

  if (result.error) {
    return { ok: false, ...dbErrorResult(result.error) };
  }
  if (result.data) {
    return { ok: true, attemptId };
  }

  return { ok: false, reason: "not-found", message: "Asset Job attempt was not finished because it could not be found in a running state." };
}
