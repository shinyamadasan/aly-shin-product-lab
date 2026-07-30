import { fromOpportunityRow, type OpportunityRecord, type OpportunityRow } from "./opportunities.ts";
import {
  finishCreativeJobAttempt,
  type CreativeJobAttemptClient,
  type CreativeJobAttemptFinishResult,
} from "./creative-job-attempts.ts";

export const CREATIVE_JOB_STATUSES = ["queued", "running", "completed", "failed"] as const;
export type CreativeJobStatus = (typeof CREATIVE_JOB_STATUSES)[number];

export const CREATIVE_JOB_WORKER_TYPES = ["mock", "product_text_worker"] as const;
export type CreativeJobWorkerType = (typeof CREATIVE_JOB_WORKER_TYPES)[number];

export type CreativeJobResultEnvelope = {
  schemaVersion: "v1";
  worker: CreativeJobWorkerType;
  output: {
    headline: string;
    caption: string;
  };
  metadata: {
    generatedFromOpportunity: string;
    generatorVersion: "1";
  };
  artifacts: [];
};

export type CreativeJobRow = {
  id?: string;
  opportunity_id: string;
  status: CreativeJobStatus;
  worker_type: string;
  attempt_count: number;
  result: CreativeJobResultEnvelope | Record<string, unknown>;
  last_error?: string | null;
  created_at?: string;
  updated_at?: string;
  started_at?: string | null;
  completed_at?: string | null;
  failed_at?: string | null;
};

export type CreativeJobRecord = {
  id: string;
  opportunityId: string;
  status: CreativeJobStatus;
  workerType: string;
  attemptCount: number;
  result: CreativeJobResultEnvelope | Record<string, unknown>;
  lastError: string;
  createdAt: string;
  updatedAt: string;
  startedAt: string;
  completedAt: string;
  failedAt: string;
};

type SupabaseErrorLike = {
  code?: string;
  message: string;
};

type QueryResult<T> = PromiseLike<{ data: T | null; error: SupabaseErrorLike | null }>;

type QueryBuilder<T> = PromiseLike<{ data: T[] | null; error: SupabaseErrorLike | null }> & {
  eq(column: string, value: string): QueryBuilder<T>;
  limit(count: number): QueryBuilder<T>;
  order(column: string, options: { ascending: boolean }): QueryBuilder<T>;
  maybeSingle(): QueryResult<T>;
  select(columns: string): {
    maybeSingle(): QueryResult<T>;
    single(): QueryResult<T>;
  };
};

export type CreativeJobWithAttemptRow = CreativeJobRow & { attempt_id: string; attempt_number: number };

export type CreativeJobClient = {
  from(table: "creative_jobs"): {
    select<T = unknown>(columns: string): QueryBuilder<T>;
    insert(row: Partial<CreativeJobRow>): {
      select(columns: string): {
        single(): QueryResult<CreativeJobRow>;
      };
    };
    update(row: Partial<CreativeJobRow>): QueryBuilder<CreativeJobRow>;
  };
  from(table: "opportunities"): {
    select<T = unknown>(columns: string): QueryBuilder<T>;
  };
  // Deprecated: superseded by claim_creative_job_with_attempt below. Left callable (and left
  // defined in supabase-add-creative-jobs.sql) so an in-flight rollback isn't blocked by a
  // dropped interface; no application code path calls this going forward.
  rpc(functionName: "claim_creative_job", args: { p_job_id: string }): {
    maybeSingle(): QueryResult<CreativeJobRow>;
  };
  rpc(functionName: "claim_creative_job_with_attempt", args: { p_job_id: string }): {
    maybeSingle(): QueryResult<CreativeJobWithAttemptRow>;
  };
};

// The wider client capability runCreativeJobWithExecutors actually needs: claiming a job (via
// CreativeJobClient) plus finishing the attempt row that claim created (via
// CreativeJobAttemptClient). Kept as a separate type rather than folded into CreativeJobClient so
// callers that only ever read/create jobs (e.g. the Opportunities UI) aren't forced to satisfy an
// attempts-table shape they never touch.
export type CreativeJobExecutionClient = CreativeJobClient & CreativeJobAttemptClient;

export type CreativeJobDetailResult =
  | { ok: true; job: CreativeJobRecord }
  | { ok: false; reason: "missing-table" | "not-found" | "failed"; message: string };

export type CreativeJobCreateResult =
  | { ok: true; outcome: "created" | "existing"; job: CreativeJobRecord }
  | { ok: false; reason: "missing-table" | "not-found" | "not-accepted" | "failed"; message: string };

export type CreativeJobRunnerResult =
  | { ok: true; outcome: "completed"; job: CreativeJobRecord; attempt?: CreativeJobAttemptFinishResult }
  | {
      ok: false;
      reason: "missing-table" | "not-found" | "not-queued" | "conflict" | "failed" | "timeout";
      message: string;
      job?: CreativeJobRecord;
      attempt?: CreativeJobAttemptFinishResult;
    };

export type CreativeJobClaimResult =
  | { ok: true; job: CreativeJobRecord }
  | { ok: false; reason: "missing-table" | "not-found" | "not-queued" | "failed"; message: string; job?: CreativeJobRecord };

export type CreativeJobClaimWithAttemptResult =
  | { ok: true; job: CreativeJobRecord; attemptId: string; attemptNumber: number }
  | { ok: false; reason: "missing-table" | "not-found" | "not-queued" | "failed"; message: string; job?: CreativeJobRecord };

export type QueuedCreativeJobsResult =
  | { ok: true; jobs: CreativeJobRecord[] }
  | { ok: false; reason: "missing-table" | "failed"; message: string };

export type CreativeJobResultValidation =
  | { ok: true; result: CreativeJobResultEnvelope }
  | {
      ok: false;
      reason: "unsupported-schema-version" | "unsupported-worker" | "malformed-output" | "malformed-metadata" | "malformed-artifacts";
      message: string;
    };

// The signal is threaded through now, ahead of any real provider, so a future network-calling
// executor can support real cancellation without another signature change. Today's deterministic
// executors (mock, product_text_worker) ignore it -- there is nothing yet for them to cancel.
export type CreativeJobExecutor = (
  job: CreativeJobRecord,
  opportunity: OpportunityRecord,
  context: { signal: AbortSignal },
) => unknown | Promise<unknown>;
export type CreativeJobExecutorMap = Partial<Record<CreativeJobWorkerType, CreativeJobExecutor>>;

const TERMINAL_JOB_STATUSES = new Set<CreativeJobStatus>(["completed", "failed"]);

// Provisional default pending real-provider latency data; only the trusted runner (never browser
// code) can override it via options.timeoutMs.
const DEFAULT_EXECUTOR_TIMEOUT_MS = 30000;

function isMissingTableError(error: SupabaseErrorLike): boolean {
  return error.code === "PGRST205" || error.code === "42P01";
}

function isUniqueViolationError(error: SupabaseErrorLike): boolean {
  return error.code === "23505" || /duplicate key value violates unique constraint/i.test(error.message);
}

function dbErrorResult(error: SupabaseErrorLike): { reason: "missing-table" | "failed"; message: string } {
  if (isMissingTableError(error)) {
    return {
      reason: "missing-table",
      message: "Creative Jobs are not available yet. Verify supabase-add-creative-jobs.sql has been applied to this Supabase project.",
    };
  }

  return { reason: "failed", message: error.message };
}

function parseCreativeJobStatus(value: string): CreativeJobStatus {
  return isCreativeJobStatus(value) ? value : "queued";
}

function parseWorkerType(value: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value : "mock";
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isCreativeJobStatus(value: string): value is CreativeJobStatus {
  return CREATIVE_JOB_STATUSES.includes(value as CreativeJobStatus);
}

export function isCreativeJobWorkerType(value: string): value is CreativeJobWorkerType {
  return CREATIVE_JOB_WORKER_TYPES.includes(value as CreativeJobWorkerType);
}

export function validateCreativeJobResultEnvelope(value: unknown): CreativeJobResultValidation {
  if (!isJsonObject(value)) {
    return { ok: false, reason: "unsupported-schema-version", message: "Creative Job result must be a v1 object envelope." };
  }

  if (value.schemaVersion !== "v1") {
    return { ok: false, reason: "unsupported-schema-version", message: "Creative Job result schemaVersion must be v1." };
  }

  if (typeof value.worker !== "string" || !isCreativeJobWorkerType(value.worker)) {
    return { ok: false, reason: "unsupported-worker", message: "Creative Job result worker is not supported." };
  }

  const output = value.output;
  const metadata = value.metadata;
  const artifacts = value.artifacts;

  if (!isJsonObject(output) || typeof output.headline !== "string" || output.headline.trim().length === 0 || typeof output.caption !== "string" || output.caption.trim().length === 0) {
    return { ok: false, reason: "malformed-output", message: "Creative Job result output must include non-empty headline and caption strings." };
  }

  if (!isJsonObject(metadata) || typeof metadata.generatedFromOpportunity !== "string" || metadata.generatedFromOpportunity.trim().length === 0 || /\s/.test(metadata.generatedFromOpportunity) || metadata.generatorVersion !== "1") {
    return { ok: false, reason: "malformed-metadata", message: "Creative Job result metadata must include a valid generatedFromOpportunity value and generatorVersion 1." };
  }

  if (!Array.isArray(artifacts) || artifacts.length !== 0) {
    return { ok: false, reason: "malformed-artifacts", message: "Creative Job result artifacts must be an empty array for this milestone." };
  }

  return { ok: true, result: value as CreativeJobResultEnvelope };
}

export function isCreativeJobResultEnvelope(value: unknown): value is CreativeJobResultEnvelope {
  return validateCreativeJobResultEnvelope(value).ok;
}

export function fromCreativeJobRow(row: CreativeJobRow): CreativeJobRecord {
  if (!row.id || !row.created_at || !row.updated_at) {
    throw new Error("Creative Job row is missing id, created_at, or updated_at.");
  }

  return {
    id: row.id,
    opportunityId: row.opportunity_id,
    status: parseCreativeJobStatus(row.status),
    workerType: parseWorkerType(row.worker_type),
    attemptCount: Number(row.attempt_count ?? 0),
    result: isJsonObject(row.result) ? row.result : {},
    lastError: row.last_error ?? "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at ?? "",
    completedAt: row.completed_at ?? "",
    failedAt: row.failed_at ?? "",
  };
}

export function buildMockCreativeJobResult(opportunity: OpportunityRecord): CreativeJobResultEnvelope {
  return {
    schemaVersion: "v1",
    worker: "mock",
    output: {
      headline: `MOCK ONLY - ${opportunity.title}`,
      caption: `MOCK ONLY - ${opportunity.summary || opportunity.reason}`,
    },
    metadata: {
      generatedFromOpportunity: opportunity.id,
      generatorVersion: "1",
    },
    artifacts: [],
  };
}

export function sanitizeCreativeJobErrorMessage(message: string, maxLength = 500): string {
  const collapsed = message
    .replace(/\b(key|token|password)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const fallback = "Creative Job execution failed.";
  const safeMessage = collapsed.length > 0 ? collapsed : fallback;
  return safeMessage.length > maxLength ? `${safeMessage.slice(0, maxLength - 1)}...` : safeMessage;
}

export function getCreativeJobStatusLabel(status: CreativeJobStatus): string {
  return status.slice(0, 1).toUpperCase() + status.slice(1);
}

export function isCreativeJobTerminal(job: Pick<CreativeJobRecord, "status">): boolean {
  return TERMINAL_JOB_STATUSES.has(job.status);
}

async function readOpportunity(client: CreativeJobClient, id: string) {
  const result = await client.from("opportunities").select<OpportunityRow>("*").eq("id", id).maybeSingle();
  if (result.error) {
    return { ok: false as const, ...dbErrorResult(result.error) };
  }
  if (!result.data) {
    return { ok: false as const, reason: "not-found" as const, message: "Opportunity not found. It may have been removed or filtered out by access rules." };
  }

  try {
    return { ok: true as const, opportunity: fromOpportunityRow(result.data) };
  } catch (err) {
    return { ok: false as const, reason: "failed" as const, message: err instanceof Error ? err.message : String(err) };
  }
}

export async function getCreativeJobById(client: CreativeJobClient, id: string): Promise<CreativeJobDetailResult> {
  const result = await client.from("creative_jobs").select<CreativeJobRow>("*").eq("id", id).maybeSingle();
  if (result.error) {
    return { ok: false, ...dbErrorResult(result.error) };
  }
  if (!result.data) {
    return { ok: false, reason: "not-found", message: "Creative Job not found." };
  }

  try {
    return { ok: true, job: fromCreativeJobRow(result.data) };
  } catch (err) {
    return { ok: false, reason: "failed", message: err instanceof Error ? err.message : String(err) };
  }
}

export async function getCreativeJobForOpportunity(client: CreativeJobClient, opportunityId: string): Promise<CreativeJobDetailResult> {
  const result = await client.from("creative_jobs").select<CreativeJobRow>("*").eq("opportunity_id", opportunityId).maybeSingle();
  if (result.error) {
    return { ok: false, ...dbErrorResult(result.error) };
  }
  if (!result.data) {
    return { ok: false, reason: "not-found", message: "No Creative Job exists for this Opportunity yet." };
  }

  try {
    return { ok: true, job: fromCreativeJobRow(result.data) };
  } catch (err) {
    return { ok: false, reason: "failed", message: err instanceof Error ? err.message : String(err) };
  }
}

export async function createCreativeJobForAcceptedOpportunity(
  client: CreativeJobClient,
  opportunityId: string,
  options: { workerType?: CreativeJobWorkerType } = {},
): Promise<CreativeJobCreateResult> {
  const opportunityResult = await readOpportunity(client, opportunityId);
  if (!opportunityResult.ok) {
    return { ok: false, reason: opportunityResult.reason, message: opportunityResult.message };
  }
  if (opportunityResult.opportunity.status !== "accepted") {
    return {
      ok: false,
      reason: "not-accepted",
      message: `Creative Jobs can only be created from accepted Opportunities. Current status: ${opportunityResult.opportunity.status}.`,
    };
  }

  const workerType = options.workerType ?? "mock";
  const existing = await getCreativeJobForOpportunity(client, opportunityId);
  if (existing.ok) {
    return { ok: true, outcome: "existing", job: existing.job };
  }
  if (existing.reason !== "not-found") {
    return { ok: false, reason: existing.reason, message: existing.message };
  }

  const inserted = await client
    .from("creative_jobs")
    .insert({ opportunity_id: opportunityId, status: "queued", worker_type: workerType, attempt_count: 0, result: {}, last_error: null })
    .select("*")
    .single();

  if (!inserted.error && inserted.data) {
    return { ok: true, outcome: "created", job: fromCreativeJobRow(inserted.data) };
  }

  if (inserted.error && isUniqueViolationError(inserted.error)) {
    const reread = await getCreativeJobForOpportunity(client, opportunityId);
    if (reread.ok) {
      return { ok: true, outcome: "existing", job: reread.job };
    }
    return { ok: false, reason: reread.reason, message: reread.message };
  }

  return { ok: false, ...dbErrorResult(inserted.error ?? { message: "Creative Job insert returned no row." }) };
}

export async function listQueuedCreativeJobs(client: CreativeJobClient, limit = 1, workerType?: CreativeJobWorkerType): Promise<QueuedCreativeJobsResult> {
  let query = client.from("creative_jobs").select<CreativeJobRow>("*").eq("status", "queued");
  if (workerType) {
    query = query.eq("worker_type", workerType);
  }
  const result = await query.order("created_at", { ascending: true }).limit(limit);

  if (result.error) {
    return { ok: false, ...dbErrorResult(result.error) };
  }

  try {
    return { ok: true, jobs: (result.data ?? []).map(fromCreativeJobRow) };
  } catch (err) {
    return { ok: false, reason: "failed", message: err instanceof Error ? err.message : String(err) };
  }
}

export async function claimQueuedCreativeJob(client: CreativeJobClient, id: string): Promise<CreativeJobClaimResult> {
  const result = await client.rpc("claim_creative_job", { p_job_id: id }).maybeSingle();
  if (result.error) {
    return { ok: false, ...dbErrorResult(result.error) };
  }
  if (result.data) {
    return { ok: true, job: fromCreativeJobRow(result.data) };
  }

  const reread = await getCreativeJobById(client, id);
  if (!reread.ok) {
    return reread.reason === "not-found"
      ? { ok: false, reason: "not-found", message: "Creative Job was not claimed because it could not be found after the atomic claim." }
      : { ok: false, reason: reread.reason, message: reread.message };
  }

  return {
    ok: false,
    reason: "not-queued",
    message: `Creative Job was not claimed because its status is ${reread.job.status}.`,
    job: reread.job,
  };
}

export async function claimQueuedCreativeJobWithAttempt(client: CreativeJobClient, id: string): Promise<CreativeJobClaimWithAttemptResult> {
  const result = await client.rpc("claim_creative_job_with_attempt", { p_job_id: id }).maybeSingle();
  if (result.error) {
    return { ok: false, ...dbErrorResult(result.error) };
  }
  if (result.data) {
    const { attempt_id, attempt_number, ...jobRow } = result.data;
    return { ok: true, job: fromCreativeJobRow(jobRow), attemptId: attempt_id, attemptNumber: attempt_number };
  }

  const reread = await getCreativeJobById(client, id);
  if (!reread.ok) {
    return reread.reason === "not-found"
      ? { ok: false, reason: "not-found", message: "Creative Job was not claimed because it could not be found after the atomic claim." }
      : { ok: false, reason: reread.reason, message: reread.message };
  }

  return {
    ok: false,
    reason: "not-queued",
    message: `Creative Job was not claimed because its status is ${reread.job.status}.`,
    job: reread.job,
  };
}

async function finishRunningJob(
  client: CreativeJobClient,
  job: CreativeJobRecord,
  update: Partial<CreativeJobRow>,
  failureReason: "conflict" | "failed",
): Promise<CreativeJobRunnerResult> {
  const result = await client.from("creative_jobs").update(update).eq("id", job.id).eq("status", "running").select("*").maybeSingle();
  if (result.error) {
    return { ok: false, ...dbErrorResult(result.error) };
  }
  if (result.data) {
    return { ok: true, outcome: "completed", job: fromCreativeJobRow(result.data) };
  }

  const reread = await getCreativeJobById(client, job.id);
  return reread.ok
    ? { ok: false, reason: failureReason, message: `Creative Job status changed to ${reread.job.status} before the runner could finish.`, job: reread.job }
    : { ok: false, reason: reread.reason === "not-found" ? "not-found" : reread.reason, message: reread.message };
}

export async function completeRunningCreativeJob(client: CreativeJobClient, job: CreativeJobRecord, resultEnvelope: unknown, completedAt: string): Promise<CreativeJobRunnerResult> {
  const validation = validateCreativeJobResultEnvelope(resultEnvelope);
  if (!validation.ok) {
    return failRunningCreativeJob(client, job, completedAt, validation.message);
  }

  return finishRunningJob(
    client,
    job,
    { status: "completed", result: validation.result, completed_at: completedAt, failed_at: null, last_error: null, updated_at: completedAt },
    "conflict",
  );
}

export async function failRunningCreativeJob(client: CreativeJobClient, job: CreativeJobRecord, failedAt: string, message = "Creative Job execution failed."): Promise<CreativeJobRunnerResult> {
  const lastError = sanitizeCreativeJobErrorMessage(message);
  const result = await client
    .from("creative_jobs")
    .update({ status: "failed", failed_at: failedAt, completed_at: null, last_error: lastError, updated_at: failedAt })
    .eq("id", job.id)
    .eq("status", "running")
    .select("*")
    .maybeSingle();
  if (result.error) {
    return { ok: false, ...dbErrorResult(result.error) };
  }
  if (result.data) {
    return { ok: false, reason: "failed", message: lastError, job: fromCreativeJobRow(result.data) };
  }

  const reread = await getCreativeJobById(client, job.id);
  return reread.ok
    ? { ok: false, reason: "conflict", message: `Creative Job status changed to ${reread.job.status} before the runner could mark it failed.`, job: reread.job }
    : { ok: false, reason: reread.reason === "not-found" ? "not-found" : reread.reason, message: reread.message };
}

export async function runCreativeJobWithExecutors(
  client: CreativeJobExecutionClient,
  id: string,
  executors: CreativeJobExecutorMap,
  options: { now?: () => string; timeoutMs?: number } = {},
): Promise<CreativeJobRunnerResult> {
  const claimed = await claimQueuedCreativeJobWithAttempt(client, id);
  if (!claimed.ok) {
    return claimed;
  }

  // Captured as plain, non-union locals rather than read off `claimed` inside the closures below --
  // TypeScript does not carry the `claimed.ok` narrowing performed above into a nested function
  // declaration, since it can't guarantee the closure runs only while that narrowing still holds.
  const job = claimed.job;
  const attemptId = claimed.attemptId;

  const finishedAt = () => options.now?.() ?? new Date().toISOString();

  // Job-first, attempt-second: if the process crashes between the two writes below, the job is
  // already correctly terminal (everything that matters -- package materialization, Opportunity
  // state -- gates on the job, not the attempt) and only the attempt is left cosmetically stale.
  // The reverse order would risk the attempt saying "completed" while the job silently gets
  // stale-recovered later -- a direct contradiction. finishCreativeJobAttempt's own failure is
  // deliberately non-fatal here: it's merged onto the result as `attempt`, never used to flip
  // `ok`/`reason`/`message`.
  async function failJobAndAttempt(message: string, attemptOutcome: "failed" | "timed_out" = "failed"): Promise<CreativeJobRunnerResult> {
    const failedAt = finishedAt();
    const jobResult = await failRunningCreativeJob(client, job, failedAt, message);
    if (jobResult.ok) {
      // failRunningCreativeJob never actually resolves ok:true; this satisfies the type checker
      // without misrepresenting an attempt outcome that didn't happen.
      return jobResult;
    }
    const reason = attemptOutcome === "timed_out" && jobResult.reason === "failed" ? ("timeout" as const) : jobResult.reason;
    const attempt = await finishCreativeJobAttempt(client, attemptId, attemptOutcome, {
      startedAt: job.startedAt,
      completedAt: failedAt,
      errorCode: attemptOutcome === "timed_out" ? "timeout" : "failed",
      errorMessage: jobResult.message,
    });
    return { ...jobResult, reason, attempt };
  }

  if (!isCreativeJobWorkerType(job.workerType)) {
    return failJobAndAttempt(`Unsupported worker type: ${job.workerType}.`);
  }

  const executor = executors[job.workerType];
  if (!executor) {
    return failJobAndAttempt(`No executor is registered for worker type: ${job.workerType}.`);
  }

  const opportunity = await readOpportunity(client, job.opportunityId);
  if (!opportunity.ok || opportunity.opportunity.status !== "accepted") {
    return failJobAndAttempt("Creative Job could not load an accepted Opportunity.");
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_EXECUTOR_TIMEOUT_MS;
  const controller = new AbortController();
  let timedOut = false;

  let resultEnvelope: unknown;
  try {
    resultEnvelope = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        timedOut = true;
        // Only stops waiting -- nothing here can forcibly terminate in-flight executor work.
        // A future provider adapter that honors signal.aborted is what would make this a real
        // cancellation; today's deterministic executors have no in-flight network call to cancel.
        controller.abort();
        reject(new Error(`Creative Job execution exceeded ${timeoutMs}ms timeout.`));
      }, timeoutMs);

      Promise.resolve(executor(job, opportunity.opportunity, { signal: controller.signal })).then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (err) => {
          clearTimeout(timer);
          reject(err);
        },
      );
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return failJobAndAttempt(timedOut ? message : `Worker execution failed: ${message}`, timedOut ? "timed_out" : "failed");
  }

  const completedAt = finishedAt();
  const jobResult = await completeRunningCreativeJob(client, job, resultEnvelope, completedAt);
  const attempt = await finishCreativeJobAttempt(
    client,
    attemptId,
    jobResult.ok ? "completed" : "failed",
    jobResult.ok ? { startedAt: job.startedAt, completedAt } : { startedAt: job.startedAt, completedAt, errorCode: "failed", errorMessage: jobResult.message },
  );
  return { ...jobResult, attempt };
}

export async function runMockCreativeJob(
  client: CreativeJobExecutionClient,
  id: string,
  options: { now?: () => string; timeoutMs?: number } = {},
): Promise<CreativeJobRunnerResult> {
  return runCreativeJobWithExecutors(client, id, { mock: (_job, opportunity) => buildMockCreativeJobResult(opportunity) }, options);
}

export async function runQueuedMockCreativeJobs(client: CreativeJobExecutionClient, limit = 1, options: { now?: () => string; timeoutMs?: number } = {}) {
  const queued = await listQueuedCreativeJobs(client, limit, "mock");
  if (!queued.ok) {
    return queued;
  }

  const results: CreativeJobRunnerResult[] = [];
  for (const job of queued.jobs) {
    results.push(await runMockCreativeJob(client, job.id, options));
  }

  return { ok: true as const, results };
}
