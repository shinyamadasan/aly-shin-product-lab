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
import { isCreativeJobWorkerType, type CreativeJobWorkerType } from "./creative-worker-types.ts";
import { validateCreativePackageContentV2, type CreativePackageContentV2 } from "./creative-package-content-v2.ts";
import type { CreativeAiInvocationTraceEntry } from "./creative-generation/ai-orchestrator.ts";

export const CREATIVE_JOB_STATUSES = ["queued", "running", "completed", "failed"] as const;
export type CreativeJobStatus = (typeof CREATIVE_JOB_STATUSES)[number];

// Moved to the leaf module ./creative-worker-types.ts in S3E-A1 and re-exported here unchanged, so
// every existing importer keeps working against this module exactly as before. The move exists only
// so the v2 content validator (which checks metadata.sourceWorker against this list) can be
// imported here without closing a runtime import cycle -- see creative-worker-types.ts.
export { CREATIVE_JOB_WORKER_TYPES, isCreativeJobWorkerType, type CreativeJobWorkerType } from "./creative-worker-types.ts";

// v1, byte-for-byte as it has always been. Named explicitly as of S3E-A1 so the two versions can be
// discussed without ambiguity; CreativeJobResultEnvelope below remains an alias for it, so no
// existing importer, type annotation or stored envelope changes in any way.
export type CreativeJobResultEnvelopeV1 = {
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

// Deliberately still means "v1" rather than becoming the union. Every existing producer
// (buildMockCreativeJobResult, buildOpportunityBriefCreativeJobResult,
// buildProductTextWorkerReadinessResult) and every existing consumer
// (buildCreativePackageContentFromCompletedJob) is v1-only and must stay that way; silently
// widening this name would make each of them accept a v2 envelope they cannot handle. Code that
// genuinely handles both asks for AnyCreativeJobResultEnvelope by name.
export type CreativeJobResultEnvelope = CreativeJobResultEnvelopeV1;

// v2 (S3E-A1). A carrier, not a second content contract: `content` IS the validated S2
// CreativePackageContentV2 that will be persisted as the Creative Package, never a raw provider
// response, prompt, CLI envelope or transport payload.
//
// executionTrace is the S3C-D orchestration trace, riding along purely so the runner can hand it to
// the attempt row (creative_job_attempts.ai_execution_trace, its durable home). It is execution
// history, not creative content, and the package materializer drops it rather than persisting it as
// package content.
export type CreativeJobResultEnvelopeV2 = {
  schemaVersion: "v2";
  worker: CreativeJobWorkerType;
  content: CreativePackageContentV2;
  executionTrace: CreativeAiInvocationTraceEntry[];
};

export type AnyCreativeJobResultEnvelope = CreativeJobResultEnvelopeV1 | CreativeJobResultEnvelopeV2;

export type CreativeJobRow = {
  id?: string;
  opportunity_id: string | null;
  intent?: Record<string, unknown>;
  status: CreativeJobStatus;
  worker_type: string;
  attempt_count: number;
  result: AnyCreativeJobResultEnvelope | Record<string, unknown>;
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
  result: AnyCreativeJobResultEnvelope | Record<string, unknown>;
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

export type CreativeJobResultValidationV2 =
  | { ok: true; result: CreativeJobResultEnvelopeV2 }
  | {
      ok: false;
      reason: "unsupported-schema-version" | "unsupported-worker" | "malformed-content" | "malformed-execution-trace";
      message: string;
    };

export type AnyCreativeJobResultValidation =
  | { ok: true; result: AnyCreativeJobResultEnvelope }
  | {
      ok: false;
      reason:
        | "unsupported-schema-version"
        | "unsupported-worker"
        | "malformed-output"
        | "malformed-metadata"
        | "malformed-artifacts"
        | "malformed-content"
        | "malformed-execution-trace";
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

// --- expected executor failure (S3E-A2) ---------------------------------------------------------
//
// Closes the gap S3E-A1 left open: a throwing executor cannot hand back the AI execution trace it
// accumulated, so an ordinary provider exhaustion (first provider hits its usage limit, the fallback
// hits its own) lost the very history that explains it.
//
// Provider-neutral by construction, like the rest of this module: nothing here names a provider, a
// model or a vendor. This is the shape a failing executor reports in; which providers were tried is
// the trace's business, and choosing them is S3C-D's.
//
// The mechanism is deliberately the smallest thing that works at the EXISTING executor boundary: an
// executor already returns `unknown`, so returning this shape needs no signature change, no Result
// framework, and no second runner. Three outcomes are now distinguishable:
//
//   success            -- a v1 or v2 result envelope
//   expected failure   -- this shape: the run reached a normal, understood dead end, WITH its trace
//   unexpected failure -- a thrown exception, exactly as before
//
// A genuine programming or infrastructure bug must keep throwing. Converting every exception into an
// "expected failure" would turn real defects into routine operational noise, which is the opposite
// of what this exists for.
export type CreativeJobExecutorFailure = {
  // A brand-specific discriminant, not a generic `ok: false`. A result envelope is identified by
  // `schemaVersion`, so these two can never be confused for one another by accident.
  creativeJobExecutorFailure: true;
  // Bounded, operator-safe. Sanitized again by the runner before it reaches last_error.
  code: string;
  message: string;
  // "timed_out" only where that is semantically true (the AI itself reported a timeout), never as a
  // general-purpose failure label.
  attemptOutcome: "failed" | "timed_out";
  executionTrace: CreativeAiInvocationTraceEntry[];
};

export function isCreativeJobExecutorFailure(value: unknown): value is CreativeJobExecutorFailure {
  if (!isJsonObject(value) || value.creativeJobExecutorFailure !== true) {
    return false;
  }
  return (
    typeof value.code === "string" &&
    typeof value.message === "string" &&
    (value.attemptOutcome === "failed" || value.attemptOutcome === "timed_out") &&
    Array.isArray(value.executionTrace)
  );
}

const TERMINAL_JOB_STATUSES = new Set<CreativeJobStatus>(["completed", "failed"]);

// Provisional default pending real-provider latency data; only the trusted runner (never browser
// code) can override it via options.timeoutMs.
const DEFAULT_EXECUTOR_TIMEOUT_MS = 30000;

// The OUTER safety ceiling for a creative_ai job -- not an expected latency, and not a replacement
// for the per-invocation timeout each text provider already owns (120s apiece today). This one
// exists so a wedged executor cannot occupy a job forever.
//
// 30s could not survive a legitimate run: format decision + creative body is already two provider
// invocations, each allowed 120s, and a fallback provider can add two more. The generic ceiling
// would kill a healthy job mid-fallback and report it as a timeout. 15 minutes clears the worst
// case (S3C-D caps invocations at 6) with wide headroom. A normal run still finishes in tens of
// seconds; nothing here sleeps, backs off, or waits on purpose.
export const CREATIVE_AI_EXECUTOR_TIMEOUT_MS = 15 * 60 * 1000;

// Per-worker overrides, so raising the AI ceiling cannot silently raise it for mock,
// product_text_worker or opportunity_brief -- those keep the generic 30s exactly as before.
const EXECUTOR_TIMEOUT_MS_BY_WORKER: Partial<Record<CreativeJobWorkerType, number>> = {
  creative_ai: CREATIVE_AI_EXECUTOR_TIMEOUT_MS,
};

export function executorTimeoutMsFor(workerType: CreativeJobWorkerType): number {
  return EXECUTOR_TIMEOUT_MS_BY_WORKER[workerType] ?? DEFAULT_EXECUTOR_TIMEOUT_MS;
}

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

// --- v2 result envelope (S3E-A1) ----------------------------------------------------------------
//
// Added beside validateCreativeJobResultEnvelope above rather than folded into it. The v1 validator
// is untouched, so every v1 envelope validates and every invalid v1 fails with exactly the reason
// and message it always did -- and a v2 envelope is still rejected by it, which is what stops v2
// from being silently read as v1.

// The exact S3C-D CreativeAiInvocationTraceEntry key set. Unknown keys are REJECTED rather than
// ignored: an open-ended object is how a raw provider response, a prompt, a CLI log or a credential
// would end up persisted, and the trace column exists to hold provider-neutral operational metadata
// only. No size limit is imposed here -- S3C-D already bounds invocation count (6 without a format
// hint, 4 with one), and a second, differently-derived cap would be a competing bound, not a check.
const EXECUTION_TRACE_REQUIRED_KEYS = ["stage", "providerId", "model", "invocationNumber", "providerInvocationNumber", "outcome", "durationMs", "action"] as const;
const EXECUTION_TRACE_OPTIONAL_KEYS = ["failureReason"] as const;
const EXECUTION_TRACE_STAGES = new Set(["format_decision", "creative_body"]);
const EXECUTION_TRACE_ACTIONS = new Set(["accepted", "retry_same_provider", "fallback", "stop"]);

function validateExecutionTraceEntry(entry: unknown): { ok: true } | { ok: false; message: string } {
  if (!isJsonObject(entry)) {
    return { ok: false, message: "Creative Job v2 executionTrace entries must be objects." };
  }

  for (const key of Object.keys(entry)) {
    if (!(EXECUTION_TRACE_REQUIRED_KEYS as readonly string[]).includes(key) && !(EXECUTION_TRACE_OPTIONAL_KEYS as readonly string[]).includes(key)) {
      return { ok: false, message: `Creative Job v2 executionTrace entries must not carry unrecognized field: ${key}.` };
    }
  }
  for (const key of EXECUTION_TRACE_REQUIRED_KEYS) {
    if (!(key in entry)) {
      return { ok: false, message: `Creative Job v2 executionTrace entries require ${key}.` };
    }
  }

  if (!EXECUTION_TRACE_STAGES.has(entry.stage as string)) {
    return { ok: false, message: `Creative Job v2 executionTrace stage is not supported: ${String(entry.stage)}.` };
  }
  if (typeof entry.providerId !== "string" || entry.providerId.trim().length === 0) {
    return { ok: false, message: "Creative Job v2 executionTrace entries require a non-empty providerId." };
  }
  if (!(entry.model === null || typeof entry.model === "string")) {
    return { ok: false, message: "Creative Job v2 executionTrace model must be a string or null." };
  }
  for (const key of ["invocationNumber", "providerInvocationNumber"] as const) {
    if (typeof entry[key] !== "number" || !Number.isInteger(entry[key]) || (entry[key] as number) < 1) {
      return { ok: false, message: `Creative Job v2 executionTrace ${key} must be a positive integer.` };
    }
  }
  if (entry.outcome !== "success" && entry.outcome !== "failure") {
    return { ok: false, message: "Creative Job v2 executionTrace outcome must be \"success\" or \"failure\"." };
  }
  if (!(entry.durationMs === null || (typeof entry.durationMs === "number" && Number.isFinite(entry.durationMs)))) {
    return { ok: false, message: "Creative Job v2 executionTrace durationMs must be a finite number or null." };
  }
  if (!EXECUTION_TRACE_ACTIONS.has(entry.action as string)) {
    return { ok: false, message: `Creative Job v2 executionTrace action is not supported: ${String(entry.action)}.` };
  }
  if ("failureReason" in entry && typeof entry.failureReason !== "string") {
    return { ok: false, message: "Creative Job v2 executionTrace failureReason must be a string when present." };
  }

  return { ok: true };
}

export function validateCreativeJobResultEnvelopeV2(value: unknown): CreativeJobResultValidationV2 {
  if (!isJsonObject(value)) {
    return { ok: false, reason: "unsupported-schema-version", message: "Creative Job result must be a v2 object envelope." };
  }

  if (value.schemaVersion !== "v2") {
    return { ok: false, reason: "unsupported-schema-version", message: "Creative Job result schemaVersion must be v2." };
  }

  if (typeof value.worker !== "string" || !isCreativeJobWorkerType(value.worker)) {
    return { ok: false, reason: "unsupported-worker", message: "Creative Job result worker is not supported." };
  }

  // The authoritative S2 validator, not a second opinion written here. A v2 envelope whose content
  // does not pass S2 is not a v2 envelope.
  const content = validateCreativePackageContentV2(value.content);
  if (!content.ok) {
    return { ok: false, reason: "malformed-content", message: content.message };
  }

  if (!Array.isArray(value.executionTrace)) {
    return { ok: false, reason: "malformed-execution-trace", message: "Creative Job result executionTrace must be an array." };
  }
  for (const entry of value.executionTrace) {
    const entryResult = validateExecutionTraceEntry(entry);
    if (!entryResult.ok) {
      return { ok: false, reason: "malformed-execution-trace", message: entryResult.message };
    }
  }

  return { ok: true, result: value as unknown as CreativeJobResultEnvelopeV2 };
}

export function isCreativeJobResultEnvelopeV2(value: unknown): value is CreativeJobResultEnvelopeV2 {
  return validateCreativeJobResultEnvelopeV2(value).ok;
}

// Dispatches strictly on the stated schemaVersion, never by shape-sniffing: a v1 envelope is only
// ever read by the v1 validator and a v2 envelope only by the v2 validator, so neither version can
// be silently reinterpreted as the other. Anything that is not explicitly v2 falls through to the
// v1 validator, which is what keeps every pre-existing input -- valid or invalid -- producing
// exactly the reason and message it produced before this function existed.
export function validateAnyCreativeJobResultEnvelope(value: unknown): AnyCreativeJobResultValidation {
  if (isJsonObject(value) && value.schemaVersion === "v2") {
    return validateCreativeJobResultEnvelopeV2(value);
  }
  return validateCreativeJobResultEnvelope(value);
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
  result: AnyCreativeJobResultEnvelope | null,
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

// Accepts v1 or v2 as of S3E-A1, via the strictly version-dispatched validator. A v1 envelope takes
// exactly the path it always did -- same validator, same messages, same write -- and an invalid
// envelope of either version still fails the job rather than completing it.
export async function completeRunningCreativeJob(client: CreativeJobClient, job: CreativeJobRecord, resultEnvelope: unknown): Promise<CreativeJobRunnerResult> {
  const validation = validateAnyCreativeJobResultEnvelope(resultEnvelope);
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
  //
  // `failure.executionTrace` (S3E-A2) is threaded through so an EXPECTED AI failure persists the
  // history that explains it. It stays optional: a failure with no trace -- every non-AI worker, and
  // any unexpected exception -- still calls the original untraced RPC and leaves the column NULL.
  async function failJobAndAttempt(
    message: string,
    attemptOutcome: "failed" | "timed_out" = "failed",
    failure: { errorCode?: string; executionTrace?: CreativeAiInvocationTraceEntry[] } = {},
  ): Promise<CreativeJobRunnerResult> {
    const jobResult = await failRunningCreativeJob(client, job, message);
    if (jobResult.ok) {
      // failRunningCreativeJob never actually resolves ok:true; this satisfies the type checker
      // without misrepresenting an attempt outcome that didn't happen.
      return jobResult;
    }
    const reason = attemptOutcome === "timed_out" && jobResult.reason === "failed" ? ("timeout" as const) : jobResult.reason;
    const attempt = await finishCreativeJobAttempt(client, attemptId, attemptOutcome, {
      errorCode: failure.errorCode ?? (attemptOutcome === "timed_out" ? "timeout" : "failed"),
      errorMessage: jobResult.message,
      ...(failure.executionTrace === undefined ? {} : { executionTrace: failure.executionTrace }),
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

  // Per-worker as of S3E-A2: creative_ai gets its own outer ceiling, every other worker keeps the
  // generic 30s it always had. An explicit options.timeoutMs still wins over both, so existing
  // callers that set one are unaffected.
  const timeoutMs = options.timeoutMs ?? executorTimeoutMsFor(job.workerType);
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
    // The UNEXPECTED path, and deliberately still trace-less (S3E-A2).
    //
    // S3E-A1 flagged that a throwing executor cannot hand back its trace. S3E-A2 closes that for
    // EXPECTED AI failure by returning CreativeJobExecutorFailure (handled below) -- ordinary
    // provider exhaustion no longer arrives here at all. What is left in this branch is what should
    // be here: genuine programmer and infrastructure exceptions, plus the OUTER safety-ceiling
    // timeout, which by definition fires while the executor is still running and therefore has no
    // trace to hand over.
    //
    // Nothing fabricates a partial trace to paper over that. Recovering one would mean sharing
    // mutable trace state between executor and runner, and a trace assembled from a half-finished
    // run is a worse artifact than an honest NULL. An absent trace stays NULL.
    return failJobAndAttempt(timedOut ? message : `Worker execution failed: ${message}`, timedOut ? "timed_out" : "failed");
  }

  // EXPECTED executor failure (S3E-A2): the run reached a normal, understood dead end and returned
  // its accumulated trace rather than throwing. The job fails, the attempt records the outcome the
  // executor reported, the trace is persisted, and NO Creative Package is created -- placeholder
  // content is never fabricated to make a failure look like a success.
  if (isCreativeJobExecutorFailure(resultEnvelope)) {
    return failJobAndAttempt(resultEnvelope.message, resultEnvelope.attemptOutcome, {
      errorCode: resultEnvelope.code,
      executionTrace: resultEnvelope.executionTrace,
    });
  }

  // The execution-trace handoff (S3E-A1). The executor's return value is its only channel out of
  // the executor boundary, so a v2 envelope carries the S3C-D trace through it; the runner lifts the
  // trace off here and hands it to the attempt row, which is its durable home. Nothing is
  // reconstructed or inferred: a v1 envelope, or a v2 envelope that does not validate, yields no
  // trace and the attempt is finished by the original, unchanged RPC.
  const traceValidation = validateCreativeJobResultEnvelopeV2(resultEnvelope);
  const executionTrace = traceValidation.ok ? { executionTrace: traceValidation.result.executionTrace } : {};

  const jobResult = await completeRunningCreativeJob(client, job, resultEnvelope);
  const attempt = await finishCreativeJobAttempt(
    client,
    attemptId,
    jobResult.ok ? "completed" : "failed",
    jobResult.ok ? executionTrace : { errorCode: "failed", errorMessage: jobResult.message, ...executionTrace },
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
