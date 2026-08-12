import { fromOpportunityRow, type OpportunityRow } from "./opportunities.ts";
import {
  buildCreativeInputFromOpportunity,
  buildCreativeInputFromRequest,
  fromIntentJson,
  toIntentJson,
  validateCreativeRequest,
  type CreativeInput,
} from "./creative-input.ts";
import {
  finishCreativeJobAttempt,
  type CreativeJobAttemptClient,
  type CreativeJobAttemptFinishResult,
} from "./creative-job-attempts.ts";

export const CREATIVE_JOB_STATUSES = ["queued", "running", "completed", "failed"] as const;
export type CreativeJobStatus = (typeof CREATIVE_JOB_STATUSES)[number];

export const CREATIVE_JOB_WORKER_TYPES = ["mock", "product_text_worker", "opportunity_brief"] as const;
export type CreativeJobWorkerType = (typeof CREATIVE_JOB_WORKER_TYPES)[number];

export type CreativeJobResultEnvelope = {
  schemaVersion: "v1";
  worker: CreativeJobWorkerType;
  output: {
    headline: string;
    caption: string;
  };
  metadata: {
    // Nullable as of S1: a request-backed job was genuinely not generated from an Opportunity, and
    // null says so. Widening only -- every envelope written before S1 carries a string and stays
    // valid. This is NOT the v2 content shape; the output contract is untouched.
    generatedFromOpportunity: string | null;
    generatorVersion: "1";
  };
  artifacts: [];
};

export type CreativeJobRow = {
  id?: string;
  opportunity_id: string | null;
  intent?: Record<string, unknown>;
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
  // Null for a request-backed job. Exactly one of opportunityId / intent is populated -- the
  // database enforces that (creative_jobs_origin_check), this type merely reflects it.
  opportunityId: string | null;
  intent: Record<string, unknown>;
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
  // No timestamptz parameter -- completed_at/failed_at are computed inside the function from the
  // database's own now(), never accepted from the caller. p_outcome is guarded server-side too
  // (finish_creative_job only writes 'completed'|'failed'); this signature doesn't encode that,
  // it's enforced by the SQL function itself.
  rpc(
    functionName: "finish_creative_job",
    args: { p_job_id: string; p_outcome: string; p_result: unknown; p_last_error: string | null },
  ): {
    maybeSingle(): QueryResult<CreativeJobRow>;
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
// Takes a CreativeInput, not an OpportunityRecord, as of S1. That single substitution is what
// decouples generation from the Opportunity domain: an executor is handed the context its source
// provided and cannot tell -- or care -- which entry path produced it.
export type CreativeJobExecutor = (
  job: CreativeJobRecord,
  input: CreativeInput,
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

  // generatedFromOpportunity is either a well-formed opportunity id or explicitly null (S1: a
  // request-backed job has no Opportunity). Null is accepted; a present-but-empty or whitespace-
  // bearing string is still rejected exactly as before -- absence must be stated, never implied.
  const generatedFrom = isJsonObject(metadata) ? metadata.generatedFromOpportunity : undefined;
  const generatedFromIsValid =
    generatedFrom === null || (typeof generatedFrom === "string" && generatedFrom.trim().length > 0 && !/\s/.test(generatedFrom));
  if (!isJsonObject(metadata) || !generatedFromIsValid || metadata.generatorVersion !== "1") {
    return { ok: false, reason: "malformed-metadata", message: "Creative Job result metadata must include a valid generatedFromOpportunity value (an opportunity id, or null for a request-backed job) and generatorVersion 1." };
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
    opportunityId: row.opportunity_id ?? null,
    intent: isJsonObject(row.intent) ? row.intent : {},
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

// Reads from CreativeInput rather than OpportunityRecord as of S1. The v1 output contract is
// unchanged; only where the strings come from changed, so an Opportunity-backed job produces
// byte-identical output to before (subject falls back to the Opportunity title, which is what
// `opportunity.title` was).
function inputHeadlineSource(input: CreativeInput): string {
  return input.subject ?? input.requestText ?? "";
}

function inputCaptionSource(input: CreativeInput): string {
  return input.evidenceSummary || input.reason || input.requestText || "";
}

function generatedFromOpportunityOf(input: CreativeInput): string | null {
  return input.origin.kind === "opportunity" ? input.origin.opportunityId : null;
}

export function buildMockCreativeJobResult(input: CreativeInput): CreativeJobResultEnvelope {
  return {
    schemaVersion: "v1",
    worker: "mock",
    output: {
      headline: `MOCK ONLY - ${inputHeadlineSource(input)}`,
      caption: `MOCK ONLY - ${inputCaptionSource(input)}`,
    },
    metadata: {
      generatedFromOpportunity: generatedFromOpportunityOf(input),
      generatorVersion: "1",
    },
    artifacts: [],
  };
}

// Creative Package initialization (PROP-034): composes the Creative Package's initial content
// from fields the selected Opportunity already carries -- nothing invented, nothing reworded,
// nothing fetched. Not a copywriter and not an AI replacement; every produced string is either a
// verbatim field or a deterministic choice between two verbatim fields. Deliberately the opposite
// of buildMockCreativeJobResult above: no placeholder prefix, because this result is meant to
// actually reach the owner, not just prove the pipeline executes.
export function buildOpportunityBriefCreativeJobResult(input: CreativeInput): CreativeJobResultEnvelope {
  const trimmedSummary = (input.evidenceSummary ?? "").trim();
  return {
    schemaVersion: "v1",
    worker: "opportunity_brief",
    output: {
      headline: inputHeadlineSource(input),
      caption: trimmedSummary.length > 0 ? trimmedSummary : (input.reason ?? input.requestText ?? ""),
    },
    metadata: {
      generatedFromOpportunity: generatedFromOpportunityOf(input),
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

// The on-demand entry point, beside createCreativeJobForAcceptedOpportunity rather than replacing
// it. Deliberately has NO deduplication and NO "existing" outcome: asking twice for the same thing
// on the same day is an ordinary action, and each ask is its own job. That is exactly why a
// request is not modelled as a fabricated Opportunity -- the Opportunity domain's unique
// deduplication_key would collide on the second ask and silently hand back the first job.
export async function createCreativeJobFromRequest(
  client: CreativeJobClient,
  request: unknown,
  options: { workerType?: CreativeJobWorkerType } = {},
): Promise<CreativeJobCreateResult> {
  const validation = validateCreativeRequest(request);
  if (!validation.ok) {
    return { ok: false, reason: "failed", message: validation.message };
  }

  const inserted = await client
    .from("creative_jobs")
    .insert({
      opportunity_id: null,
      intent: toIntentJson(validation.request),
      status: "queued",
      worker_type: options.workerType ?? "mock",
      attempt_count: 0,
      result: {},
      last_error: null,
    })
    .select("*")
    .single();

  if (!inserted.error && inserted.data) {
    return { ok: true, outcome: "created", job: fromCreativeJobRow(inserted.data) };
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

type FinishCreativeJobWriteResult =
  | { written: true; job: CreativeJobRecord }
  | { written: false; reason: "missing-table" | "not-found" | "conflict" | "failed"; message: string; job?: CreativeJobRecord };

// Shared by completeRunningCreativeJob and failRunningCreativeJob -- both callers interpret the
// neutral written:true/false result into their own correct ok/reason shape (a successful *write*
// means ok:true for complete but ok:false for fail, since "the job failed" is not itself an
// operation failure). No timestamp is passed in; finish_creative_job computes completed_at/
// failed_at from now() internally.
async function finishCreativeJobViaRpc(
  client: CreativeJobClient,
  job: CreativeJobRecord,
  outcome: "completed" | "failed",
  result: CreativeJobResultEnvelope | null,
  lastError: string | null,
): Promise<FinishCreativeJobWriteResult> {
  const rpcResult = await client.rpc("finish_creative_job", { p_job_id: job.id, p_outcome: outcome, p_result: result, p_last_error: lastError }).maybeSingle();
  if (rpcResult.error) {
    return { written: false, ...dbErrorResult(rpcResult.error) };
  }
  if (rpcResult.data) {
    return { written: true, job: fromCreativeJobRow(rpcResult.data) };
  }

  const reread = await getCreativeJobById(client, job.id);
  return reread.ok
    ? { written: false, reason: "conflict", message: `Creative Job status changed to ${reread.job.status} before the runner could finish.`, job: reread.job }
    : { written: false, reason: reread.reason === "not-found" ? "not-found" : reread.reason, message: reread.message };
}

export async function completeRunningCreativeJob(client: CreativeJobClient, job: CreativeJobRecord, resultEnvelope: unknown): Promise<CreativeJobRunnerResult> {
  const validation = validateCreativeJobResultEnvelope(resultEnvelope);
  if (!validation.ok) {
    return failRunningCreativeJob(client, job, validation.message);
  }

  const result = await finishCreativeJobViaRpc(client, job, "completed", validation.result, null);
  return result.written ? { ok: true, outcome: "completed", job: result.job } : { ok: false, reason: result.reason, message: result.message, job: result.job };
}

export async function failRunningCreativeJob(client: CreativeJobClient, job: CreativeJobRecord, message = "Creative Job execution failed."): Promise<CreativeJobRunnerResult> {
  const lastError = sanitizeCreativeJobErrorMessage(message);
  const result = await finishCreativeJobViaRpc(client, job, "failed", null, lastError);
  return result.written
    ? { ok: false, reason: "failed", message: lastError, job: result.job }
    : { ok: false, reason: result.reason, message: result.message, job: result.job };
}

export type CreativeJobRunnerOptions = {
  /**
   * @deprecated No longer consulted. completed_at/failed_at (and the attempt's completed_at/
   * latency_ms) are computed by finish_creative_job/finish_creative_job_attempt from the
   * database's own now() -- there is no application-supplied timestamp anywhere in this call
   * chain anymore. Kept on the public type for backward compatibility; slated for removal in a
   * later cleanup milestone.
   */
  now?: () => string;
  timeoutMs?: number;
};

export async function runCreativeJobWithExecutors(
  client: CreativeJobExecutionClient,
  id: string,
  executors: CreativeJobExecutorMap,
  options: CreativeJobRunnerOptions = {},
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

  // Job-first, attempt-second: if the process crashes between the two writes below, the job is
  // already correctly terminal (everything that matters -- package materialization, Opportunity
  // state -- gates on the job, not the attempt) and only the attempt is left cosmetically stale.
  // The reverse order would risk the attempt saying "completed" while the job silently gets
  // stale-recovered later -- a direct contradiction. finishCreativeJobAttempt's own failure is
  // deliberately non-fatal here: it's merged onto the result as `attempt`, never used to flip
  // `ok`/`reason`/`message`.
  async function failJobAndAttempt(message: string, attemptOutcome: "failed" | "timed_out" = "failed"): Promise<CreativeJobRunnerResult> {
    const jobResult = await failRunningCreativeJob(client, job, message);
    if (jobResult.ok) {
      // failRunningCreativeJob never actually resolves ok:true; this satisfies the type checker
      // without misrepresenting an attempt outcome that didn't happen.
      return jobResult;
    }
    const reason = attemptOutcome === "timed_out" && jobResult.reason === "failed" ? ("timeout" as const) : jobResult.reason;
    const attempt = await finishCreativeJobAttempt(client, attemptId, attemptOutcome, {
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

  // The decoupling, in one branch. An Opportunity-backed job still re-reads its Opportunity and
  // still requires it to be accepted -- that gate is unchanged, deliberately, because an
  // Opportunity dismissed between creation and execution must not quietly produce content. A
  // request-backed job has no Opportunity to check; its input is rebuilt from the stored intent,
  // which is why intent is persisted rather than resolved once and thrown away.
  let input: CreativeInput;
  if (job.opportunityId === null) {
    const request = fromIntentJson(job.intent);
    if (!request.ok) {
      return failJobAndAttempt(`Creative Job could not read its stored request: ${request.message}`);
    }
    input = buildCreativeInputFromRequest(request.request);
  } else {
    const opportunity = await readOpportunity(client, job.opportunityId);
    if (!opportunity.ok || opportunity.opportunity.status !== "accepted") {
      return failJobAndAttempt("Creative Job could not load an accepted Opportunity.");
    }
    input = buildCreativeInputFromOpportunity(opportunity.opportunity);
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

      Promise.resolve(executor(job, input, { signal: controller.signal })).then(
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

  const jobResult = await completeRunningCreativeJob(client, job, resultEnvelope);
  const attempt = await finishCreativeJobAttempt(
    client,
    attemptId,
    jobResult.ok ? "completed" : "failed",
    jobResult.ok ? {} : { errorCode: "failed", errorMessage: jobResult.message },
  );
  return { ...jobResult, attempt };
}

export async function runMockCreativeJob(client: CreativeJobExecutionClient, id: string, options: CreativeJobRunnerOptions = {}): Promise<CreativeJobRunnerResult> {
  return runCreativeJobWithExecutors(client, id, { mock: (_job, input) => buildMockCreativeJobResult(input) }, options);
}

export async function runQueuedMockCreativeJobs(client: CreativeJobExecutionClient, limit = 1, options: CreativeJobRunnerOptions = {}) {
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
