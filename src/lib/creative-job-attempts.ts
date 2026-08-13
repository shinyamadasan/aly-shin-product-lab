import type { CreativeAiInvocationTraceEntry } from "./creative-generation/ai-orchestrator.ts";

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
  // Null for every attempt that did not run an AI orchestration -- which is every attempt written
  // before S3E-A1 and every non-AI worker after it. Null says "this attempt had no AI execution",
  // which is the truth; an empty array would say "AI ran and did nothing", which is not.
  ai_execution_trace?: CreativeAiInvocationTraceEntry[] | null;
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
  // Null, not [], when the attempt ran no AI orchestration -- see the row comment above.
  aiExecutionTrace: CreativeAiInvocationTraceEntry[] | null;
  createdAt: string;
};

type SupabaseErrorLike = {
  code?: string;
  message: string;
};

type QueryResult<T> = PromiseLike<{ data: T | null; error: SupabaseErrorLike | null }>;

// No `from(...)`/`update(...)` here anymore -- finishCreativeJobAttempt's only interaction with
// this table is the finish RPCs below, both of which are database-timestamped and
// database-outcome-guarded. There is no other writer of this table.
//
// Two RPCs rather than one, as of S3E-A1. The original is left exactly as it was, and an attempt
// with no AI execution trace still calls it, byte for byte -- so no existing caller, worker or
// stored row changes. finish_creative_job_attempt_with_trace is the additive trace-aware sibling.
export type CreativeJobAttemptClient = {
  rpc(
    functionName: "finish_creative_job_attempt",
    args: { p_attempt_id: string; p_outcome: string; p_error_code: string | null; p_error_message: string | null },
  ): {
    maybeSingle(): QueryResult<CreativeJobAttemptRow>;
  };
  rpc(
    functionName: "finish_creative_job_attempt_with_trace",
    args: {
      p_attempt_id: string;
      p_outcome: string;
      p_error_code: string | null;
      p_error_message: string | null;
      p_ai_execution_trace: CreativeAiInvocationTraceEntry[];
    },
  ): {
    maybeSingle(): QueryResult<CreativeJobAttemptRow>;
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
    aiExecutionTrace: Array.isArray(row.ai_execution_trace) ? row.ai_execution_trace : null,
    createdAt: row.created_at,
  };
}

// Called after the job-level complete/fail write already succeeded (job-first, attempt-second):
// a crash between the two writes leaves the job correctly terminal and only the attempt
// cosmetically stale, never the reverse. Failure here is deliberately non-fatal to the caller's
// job result -- see CreativeJobRunnerResult's optional `attempt` field in creative-jobs.ts.
//
// completed_at and latency_ms are computed entirely inside finish_creative_job_attempt from the
// database's own now() and the row's own started_at -- no timestamp is accepted here or passed
// to the RPC, so this function cannot produce a mixed-clock terminal record even if a caller
// wanted it to.
//
// executionTrace (S3E-A1) selects the RPC rather than being appended to the existing one's
// arguments: an attempt with no trace makes exactly the call it made before, so no non-AI worker
// and no already-deployed database is affected by this addition. Absence is expressed by not
// supplying a trace at all, never by supplying an empty array.
export async function finishCreativeJobAttempt(
  client: CreativeJobAttemptClient,
  attemptId: string,
  outcome: Exclude<CreativeJobAttemptStatus, "running">,
  details: { errorCode?: string; errorMessage?: string; executionTrace?: CreativeAiInvocationTraceEntry[] } = {},
): Promise<CreativeJobAttemptFinishResult> {
  const errorCode = outcome === "completed" ? null : (details.errorCode ?? "failed");
  const errorMessage = outcome === "completed" ? null : (details.errorMessage ?? "Creative Job attempt failed.");

  const result = await (details.executionTrace === undefined
    ? client.rpc("finish_creative_job_attempt", {
        p_attempt_id: attemptId,
        p_outcome: outcome,
        p_error_code: errorCode,
        p_error_message: errorMessage,
      })
    : client.rpc("finish_creative_job_attempt_with_trace", {
        p_attempt_id: attemptId,
        p_outcome: outcome,
        p_error_code: errorCode,
        p_error_message: errorMessage,
        p_ai_execution_trace: details.executionTrace,
      })
  ).maybeSingle();

  if (result.error) {
    return { ok: false, ...dbErrorResult(result.error) };
  }
  if (result.data) {
    return { ok: true, attemptId };
  }

  return { ok: false, reason: "not-found", message: "Creative Job attempt was not finished because it could not be found in a running state." };
}
