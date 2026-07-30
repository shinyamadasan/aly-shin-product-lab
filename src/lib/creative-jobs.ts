import { fromOpportunityRow, type OpportunityRecord, type OpportunityRow } from "./opportunities.ts";

export const CREATIVE_JOB_STATUSES = ["queued", "running", "completed", "failed"] as const;
export type CreativeJobStatus = (typeof CREATIVE_JOB_STATUSES)[number];

export type CreativeJobWorkerType = "mock";

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
  worker_type: CreativeJobWorkerType;
  attempt_count: number;
  result: CreativeJobResultEnvelope | Record<string, unknown>;
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
  workerType: CreativeJobWorkerType;
  attemptCount: number;
  result: CreativeJobResultEnvelope | Record<string, unknown>;
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
  rpc(functionName: "claim_creative_job", args: { p_job_id: string }): {
    maybeSingle(): QueryResult<CreativeJobRow>;
  };
};

export type CreativeJobDetailResult =
  | { ok: true; job: CreativeJobRecord }
  | { ok: false; reason: "missing-table" | "not-found" | "failed"; message: string };

export type CreativeJobCreateResult =
  | { ok: true; outcome: "created" | "existing"; job: CreativeJobRecord }
  | { ok: false; reason: "missing-table" | "not-found" | "not-accepted" | "failed"; message: string };

export type CreativeJobRunnerResult =
  | { ok: true; outcome: "completed"; job: CreativeJobRecord }
  | { ok: false; reason: "missing-table" | "not-found" | "not-queued" | "conflict" | "failed"; message: string; job?: CreativeJobRecord };

export type CreativeJobClaimResult =
  | { ok: true; job: CreativeJobRecord }
  | { ok: false; reason: "missing-table" | "not-found" | "not-queued" | "failed"; message: string; job?: CreativeJobRecord };

export type QueuedCreativeJobsResult =
  | { ok: true; jobs: CreativeJobRecord[] }
  | { ok: false; reason: "missing-table" | "failed"; message: string };

const TERMINAL_JOB_STATUSES = new Set<CreativeJobStatus>(["completed", "failed"]);

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

function parseWorkerType(value: string): CreativeJobWorkerType {
  return value === "mock" ? "mock" : "mock";
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isCreativeJobStatus(value: string): value is CreativeJobStatus {
  return CREATIVE_JOB_STATUSES.includes(value as CreativeJobStatus);
}

export function isCreativeJobResultEnvelope(value: unknown): value is CreativeJobResultEnvelope {
  if (!isJsonObject(value)) {
    return false;
  }

  const output = value.output;
  const metadata = value.metadata;

  return (
    value.schemaVersion === "v1" &&
    value.worker === "mock" &&
    isJsonObject(output) &&
    typeof output.headline === "string" &&
    output.headline.trim().length > 0 &&
    typeof output.caption === "string" &&
    output.caption.trim().length > 0 &&
    isJsonObject(metadata) &&
    typeof metadata.generatedFromOpportunity === "string" &&
    metadata.generatedFromOpportunity.trim().length > 0 &&
    metadata.generatorVersion === "1" &&
    Array.isArray(value.artifacts)
  );
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

export async function createCreativeJobForAcceptedOpportunity(client: CreativeJobClient, opportunityId: string): Promise<CreativeJobCreateResult> {
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

  const existing = await getCreativeJobForOpportunity(client, opportunityId);
  if (existing.ok) {
    return { ok: true, outcome: "existing", job: existing.job };
  }
  if (existing.reason !== "not-found") {
    return { ok: false, reason: existing.reason, message: existing.message };
  }

  const inserted = await client
    .from("creative_jobs")
    .insert({ opportunity_id: opportunityId, status: "queued", worker_type: "mock", attempt_count: 0, result: {} })
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

export async function listQueuedCreativeJobs(client: CreativeJobClient, limit = 1): Promise<QueuedCreativeJobsResult> {
  const result = await client
    .from("creative_jobs")
    .select<CreativeJobRow>("*")
    .eq("status", "queued")
    .order("created_at", { ascending: true })
    .limit(limit);

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

export async function completeRunningCreativeJob(client: CreativeJobClient, job: CreativeJobRecord, resultEnvelope: CreativeJobResultEnvelope, completedAt: string): Promise<CreativeJobRunnerResult> {
  return finishRunningJob(
    client,
    job,
    { status: "completed", result: resultEnvelope, completed_at: completedAt, failed_at: null, updated_at: completedAt },
    "conflict",
  );
}

export async function failRunningCreativeJob(client: CreativeJobClient, job: CreativeJobRecord, failedAt: string): Promise<CreativeJobRunnerResult> {
  const result = await client.from("creative_jobs").update({ status: "failed", failed_at: failedAt, updated_at: failedAt }).eq("id", job.id).eq("status", "running").select("*").maybeSingle();
  if (result.error) {
    return { ok: false, ...dbErrorResult(result.error) };
  }
  if (result.data) {
    return { ok: false, reason: "failed", message: "Creative Job failed during mock worker execution.", job: fromCreativeJobRow(result.data) };
  }

  const reread = await getCreativeJobById(client, job.id);
  return reread.ok
    ? { ok: false, reason: "conflict", message: `Creative Job status changed to ${reread.job.status} before the runner could mark it failed.`, job: reread.job }
    : { ok: false, reason: reread.reason === "not-found" ? "not-found" : reread.reason, message: reread.message };
}

export async function runMockCreativeJob(client: CreativeJobClient, id: string, options: { now?: () => string } = {}): Promise<CreativeJobRunnerResult> {
  const claimed = await claimQueuedCreativeJob(client, id);
  if (!claimed.ok) {
    return claimed;
  }

  const opportunity = await readOpportunity(client, claimed.job.opportunityId);
  if (!opportunity.ok || opportunity.opportunity.status !== "accepted") {
    return failRunningCreativeJob(client, claimed.job, options.now?.() ?? new Date().toISOString());
  }

  const completedAt = options.now?.() ?? new Date().toISOString();
  const resultEnvelope = buildMockCreativeJobResult(opportunity.opportunity);
  return completeRunningCreativeJob(client, claimed.job, resultEnvelope, completedAt);
}

export async function runQueuedMockCreativeJobs(client: CreativeJobClient, limit = 1, options: { now?: () => string } = {}) {
  const queued = await listQueuedCreativeJobs(client, limit);
  if (!queued.ok) {
    return queued;
  }

  const results: CreativeJobRunnerResult[] = [];
  for (const job of queued.jobs) {
    results.push(await runMockCreativeJob(client, job.id, options));
  }

  return { ok: true as const, results };
}
