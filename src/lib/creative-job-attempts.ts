export const CREATIVE_JOB_ATTEMPT_STATUSES = ["running", "completed", "failed", "timed_out"] as const;
export type CreativeJobAttemptStatus = (typeof CREATIVE_JOB_ATTEMPT_STATUSES)[number];

export type CreativeJobAttemptRow = {
  id?: string;
  creative_job_id: string;
  attempt_number: number;
  worker_type: string;
  status: CreativeJobAttemptStatus;
  started_at: string;
  completed_at?: string | null;
  latency_ms?: number | null;
  error_code?: string | null;
  error_message?: string | null;
  provider?: string | null;
  model?: string | null;
  created_at?: string;
};

export type CreativeJobAttemptRecord = {
  id: string;
  creativeJobId: string;
  attemptNumber: number;
  workerType: string;
  status: CreativeJobAttemptStatus;
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

type UpdateBuilder<T> = {
  eq(column: string, value: string): UpdateBuilder<T>;
  select(columns: string): {
    maybeSingle(): QueryResult<T>;
  };
};

export type CreativeJobAttemptClient = {
  from(table: "creative_job_attempts"): {
    update(row: Partial<CreativeJobAttemptRow>): UpdateBuilder<CreativeJobAttemptRow>;
  };
};

export type CreativeJobAttemptFinishResult =
  | { ok: true; attemptId: string }
  | { ok: false; reason: "missing-table" | "not-found" | "failed"; message: string };

function isMissingTableError(error: SupabaseErrorLike): boolean {
  return error.code === "PGRST205" || error.code === "42P01";
}

function dbErrorResult(error: SupabaseErrorLike): { reason: "missing-table" | "failed"; message: string } {
  if (isMissingTableError(error)) {
    return {
      reason: "missing-table",
      message: "Creative Job attempts are not available yet. Verify supabase-add-creative-job-attempts.sql has been applied to this Supabase project.",
    };
  }

  return { reason: "failed", message: error.message };
}

export function isCreativeJobAttemptStatus(value: string): value is CreativeJobAttemptStatus {
  return CREATIVE_JOB_ATTEMPT_STATUSES.includes(value as CreativeJobAttemptStatus);
}

export function fromCreativeJobAttemptRow(row: CreativeJobAttemptRow): CreativeJobAttemptRecord {
  if (!row.id || !row.created_at) {
    throw new Error("Creative Job attempt row is missing id or created_at.");
  }

  return {
    id: row.id,
    creativeJobId: row.creative_job_id,
    attemptNumber: row.attempt_number,
    workerType: row.worker_type,
    status: isCreativeJobAttemptStatus(row.status) ? row.status : "running",
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
// cosmetically stale, never the reverse. Failure here is deliberately non-fatal to the caller's
// job result -- see CreativeJobRunnerResult's optional `attempt` field in creative-jobs.ts.
export async function finishCreativeJobAttempt(
  client: CreativeJobAttemptClient,
  attemptId: string,
  outcome: Exclude<CreativeJobAttemptStatus, "running">,
  details: { startedAt: string; completedAt: string; errorCode?: string; errorMessage?: string },
): Promise<CreativeJobAttemptFinishResult> {
  const latencyMs = Date.parse(details.completedAt) - Date.parse(details.startedAt);

  const result = await client
    .from("creative_job_attempts")
    .update({
      status: outcome,
      completed_at: details.completedAt,
      latency_ms: Number.isFinite(latencyMs) ? latencyMs : null,
      error_code: outcome === "completed" ? null : (details.errorCode ?? "failed"),
      error_message: outcome === "completed" ? null : (details.errorMessage ?? "Creative Job attempt failed."),
    })
    .eq("id", attemptId)
    .eq("status", "running")
    .select("*")
    .maybeSingle();

  if (result.error) {
    return { ok: false, ...dbErrorResult(result.error) };
  }
  if (result.data) {
    return { ok: true, attemptId };
  }

  return { ok: false, reason: "not-found", message: "Creative Job attempt was not finished because it could not be found in a running state." };
}
