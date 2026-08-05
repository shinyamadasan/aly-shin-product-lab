import { fromCreativePackageRow, type CreativePackageRecord, type CreativePackageRow } from "./creative-packages.ts";
import { buildAssetGenerationSpec, type AssetGenerationSpecV1 } from "./asset-generation-spec.ts";
import {
  validateGeneratedAssetCandidates,
  type GeneratedAssetFileCandidate,
} from "./asset-generation-validation.ts";
import type { InspectedAssetCandidate } from "./asset-binary.ts";
import type { AssetJobFileMaterializationClient, AssetJobFileMaterializationResult } from "./asset-file-materialization.ts";
import { BRAND_BIBLE } from "./marketing-advisor-context.ts";
import {
  finishAssetJobAttempt,
  type AssetJobAttemptClient,
  type AssetJobAttemptFinishResult,
} from "./asset-job-attempts.ts";

export const ASSET_JOB_STATUSES = ["queued", "running", "completed", "failed"] as const;
export type AssetJobStatus = (typeof ASSET_JOB_STATUSES)[number];

// Only "mock" ships in this milestone -- a real provider worker type is added additively
// (pure-text-union change, no migration) by the milestone that actually wires one up. Mirrors
// CREATIVE_JOB_WORKER_TYPES' own precedent of listing only what's actually implemented.
export const ASSET_JOB_WORKER_TYPES = ["mock"] as const;
export type AssetJobWorkerType = (typeof ASSET_JOB_WORKER_TYPES)[number];

// Only "image" ships in this milestone. Carousel/reel/short_video/story_graphic are each a later,
// separately-proven `asset_kind` addition -- pure-additive TS union change, no migration, per the
// approved Asset Generation roadmap.
export const ASSET_KINDS = ["image"] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

// One ordered file descriptor produced by a completed job. Candidate metadata is structurally
// validated before this persisted envelope is built, but the dimensions/size remain declared
// metadata only -- PROP-024 does not decode or inspect real binary bytes.
export type AssetFileDescriptor = {
  position: number;
  mimeType: string;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  fileSizeBytes: number;
  storageBucket: string;
  storagePath: string;
  publicUrl: string;
};

export type AssetJobResultEnvelope = {
  schemaVersion: "v1";
  worker: AssetJobWorkerType;
  assetKind: AssetKind;
  output: {
    files: AssetFileDescriptor[];
  };
  metadata: {
    generatedFromCreativePackage: string;
    generatorVersion: "1";
  };
};

export type AssetJobRow = {
  id?: string;
  creative_package_id: string;
  status: AssetJobStatus;
  worker_type: string;
  asset_kind: string;
  attempt_count: number;
  result: AssetJobResultEnvelope | Record<string, unknown>;
  last_error?: string | null;
  created_at?: string;
  updated_at?: string;
  started_at?: string | null;
  completed_at?: string | null;
  failed_at?: string | null;
};

export type AssetJobRecord = {
  id: string;
  creativePackageId: string;
  status: AssetJobStatus;
  workerType: string;
  assetKind: string;
  attemptCount: number;
  result: AssetJobResultEnvelope | Record<string, unknown>;
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

export type AssetJobWithAttemptRow = AssetJobRow & { attempt_id: string; attempt_number: number };

export type AssetJobClient = {
  from(table: "asset_jobs"): {
    select<T = unknown>(columns: string): QueryBuilder<T>;
    insert(row: Partial<AssetJobRow>): {
      select(columns: string): {
        single(): QueryResult<AssetJobRow>;
      };
    };
    update(row: Partial<AssetJobRow>): QueryBuilder<AssetJobRow>;
  };
  from(table: "creative_packages"): {
    select<T = unknown>(columns: string): QueryBuilder<T>;
  };
  rpc(functionName: "claim_asset_job_with_attempt", args: { p_job_id: string }): {
    maybeSingle(): QueryResult<AssetJobWithAttemptRow>;
  };
  // No timestamptz parameter -- completed_at/failed_at are computed inside the function from the
  // database's own now(), never accepted from the caller, mirroring finish_creative_job exactly.
  rpc(
    functionName: "finish_asset_job",
    args: { p_job_id: string; p_outcome: string; p_result: unknown; p_last_error: string | null },
  ): {
    maybeSingle(): QueryResult<AssetJobRow>;
  };
};

// The wider client capability runAssetJobWithExecutors actually needs: claiming a job (via
// AssetJobClient) plus finishing the attempt row that claim created (via AssetJobAttemptClient).
// Kept separate from AssetJobClient for the same reason CreativeJobExecutionClient is kept
// separate from CreativeJobClient -- callers that only ever read/create jobs aren't forced to
// satisfy an attempts-table shape they never touch.
export type AssetJobExecutionClient = AssetJobClient & AssetJobAttemptClient & AssetJobFileMaterializationClient;

export type AssetJobDetailResult =
  | { ok: true; job: AssetJobRecord }
  | { ok: false; reason: "missing-table" | "not-found" | "failed"; message: string };

export type AssetJobCreateResult =
  | { ok: true; outcome: "created"; job: AssetJobRecord }
  | { ok: false; reason: "missing-table" | "not-found" | "not-ready" | "failed"; message: string };

export type AssetJobRunnerResult =
  | { ok: true; outcome: "completed"; job: AssetJobRecord; attempt?: AssetJobAttemptFinishResult; materialization?: AssetJobFileMaterializationResult }
  | {
      ok: false;
      reason: "missing-table" | "not-found" | "not-queued" | "conflict" | "failed" | "timeout";
      message: string;
      job?: AssetJobRecord;
      attempt?: AssetJobAttemptFinishResult;
      materialization?: AssetJobFileMaterializationResult;
    };

export type AssetJobClaimWithAttemptResult =
  | { ok: true; job: AssetJobRecord; attemptId: string; attemptNumber: number }
  | { ok: false; reason: "missing-table" | "not-found" | "not-queued" | "failed"; message: string; job?: AssetJobRecord };

export type QueuedAssetJobsResult =
  | { ok: true; jobs: AssetJobRecord[] }
  | { ok: false; reason: "missing-table" | "failed"; message: string };

export type CreativePackageAssetJobsResult =
  | { ok: true; jobs: AssetJobRecord[] }
  | { ok: false; reason: "missing-table" | "failed"; message: string };

export type AssetJobResultValidation =
  | { ok: true; result: AssetJobResultEnvelope }
  | {
      ok: false;
      reason: "unsupported-schema-version" | "unsupported-worker" | "unsupported-asset-kind" | "malformed-output" | "malformed-metadata";
      message: string;
    };

// The signal is threaded through now, ahead of any real provider, so a future network-calling
// executor can support real cancellation without another signature change -- mirrors
// CreativeJobExecutor exactly. Today's only executor (mock) ignores it.
export type AssetJobExecutor = (
  job: AssetJobRecord,
  spec: AssetGenerationSpecV1,
  context: { signal: AbortSignal },
) => GeneratedAssetFileCandidate[] | Promise<GeneratedAssetFileCandidate[]>;
export type AssetJobExecutorMap = Partial<Record<AssetJobWorkerType, AssetJobExecutor>>;

const TERMINAL_JOB_STATUSES = new Set<AssetJobStatus>(["completed", "failed"]);

// Provisional default pending real-provider latency data; only the trusted runner (never browser
// code) can override it via options.timeoutMs. Mirrors DEFAULT_EXECUTOR_TIMEOUT_MS exactly.
const DEFAULT_EXECUTOR_TIMEOUT_MS = 30000;

function isMissingTableError(error: SupabaseErrorLike): boolean {
  return error.code === "PGRST205" || error.code === "42P01";
}

function dbErrorResult(error: SupabaseErrorLike): { reason: "missing-table" | "failed"; message: string } {
  if (isMissingTableError(error)) {
    return {
      reason: "missing-table",
      message: "Asset Jobs are not available yet. Verify supabase-add-asset-jobs.sql has been applied to this Supabase project.",
    };
  }

  return { reason: "failed", message: error.message };
}

function parseAssetJobStatus(value: string): AssetJobStatus {
  return isAssetJobStatus(value) ? value : "queued";
}

function parseWorkerType(value: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value : "mock";
}

function parseAssetKind(value: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value : "image";
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isAssetJobStatus(value: string): value is AssetJobStatus {
  return ASSET_JOB_STATUSES.includes(value as AssetJobStatus);
}

export function isAssetJobWorkerType(value: string): value is AssetJobWorkerType {
  return ASSET_JOB_WORKER_TYPES.includes(value as AssetJobWorkerType);
}

export function isAssetKind(value: string): value is AssetKind {
  return ASSET_KINDS.includes(value as AssetKind);
}

function isAssetFileDescriptor(value: unknown, expectedPosition: number): value is AssetFileDescriptor {
  if (!isJsonObject(value)) {
    return false;
  }

  return (
    value.position === expectedPosition &&
    typeof value.mimeType === "string" &&
    value.mimeType.trim().length > 0 &&
    (value.width === null || typeof value.width === "number") &&
    (value.height === null || typeof value.height === "number") &&
    (value.durationMs === null || typeof value.durationMs === "number") &&
    typeof value.fileSizeBytes === "number" &&
    value.fileSizeBytes > 0 &&
    typeof value.storageBucket === "string" &&
    value.storageBucket.trim().length > 0 &&
    typeof value.storagePath === "string" &&
    value.storagePath.trim().length > 0 &&
    typeof value.publicUrl === "string"
  );
}

export function validateAssetJobResultEnvelope(value: unknown): AssetJobResultValidation {
  if (!isJsonObject(value)) {
    return { ok: false, reason: "unsupported-schema-version", message: "Asset Job result must be a v1 object envelope." };
  }

  if (value.schemaVersion !== "v1") {
    return { ok: false, reason: "unsupported-schema-version", message: "Asset Job result schemaVersion must be v1." };
  }

  if (typeof value.worker !== "string" || !isAssetJobWorkerType(value.worker)) {
    return { ok: false, reason: "unsupported-worker", message: "Asset Job result worker is not supported." };
  }

  if (typeof value.assetKind !== "string" || !isAssetKind(value.assetKind)) {
    return { ok: false, reason: "unsupported-asset-kind", message: "Asset Job result assetKind is not supported." };
  }

  const output = value.output;
  const metadata = value.metadata;

  if (!isJsonObject(output) || !Array.isArray(output.files) || output.files.length === 0 || !output.files.every((file, index) => isAssetFileDescriptor(file, index))) {
    return { ok: false, reason: "malformed-output", message: "Asset Job result output must include a non-empty, 0-based, sequentially-positioned files array." };
  }

  if (!isJsonObject(metadata) || typeof metadata.generatedFromCreativePackage !== "string" || metadata.generatedFromCreativePackage.trim().length === 0 || /\s/.test(metadata.generatedFromCreativePackage) || metadata.generatorVersion !== "1") {
    return { ok: false, reason: "malformed-metadata", message: "Asset Job result metadata must include a valid generatedFromCreativePackage value and generatorVersion 1." };
  }

  return { ok: true, result: value as AssetJobResultEnvelope };
}

export function isAssetJobResultEnvelope(value: unknown): value is AssetJobResultEnvelope {
  return validateAssetJobResultEnvelope(value).ok;
}

export function fromAssetJobRow(row: AssetJobRow): AssetJobRecord {
  if (!row.id || !row.created_at || !row.updated_at) {
    throw new Error("Asset Job row is missing id, created_at, or updated_at.");
  }

  return {
    id: row.id,
    creativePackageId: row.creative_package_id,
    status: parseAssetJobStatus(row.status),
    workerType: parseWorkerType(row.worker_type),
    assetKind: parseAssetKind(row.asset_kind),
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

// Deliberately labeled "mock" throughout (storageBucket/storagePath), never a real bucket name --
// mirrors buildMockCreativeJobResult's "MOCK ONLY -" headline prefix. This proves the full
// asset_jobs -> assets -> asset_files write path without any Supabase Storage integration, which
// is a later, separate milestone.
export function buildMockAssetJobResult(creativePackage: CreativePackageRecord, assetKind: AssetKind): AssetJobResultEnvelope {
  const spec = buildAssetGenerationSpec(creativePackage, { assetKind });
  const candidates = buildMockGeneratedAssetFileCandidates(spec);

  return {
    schemaVersion: "v1",
    worker: "mock",
    assetKind,
    output: {
      files: attachMockAssetFileDescriptors(candidates, creativePackage.id),
    },
    metadata: {
      generatedFromCreativePackage: creativePackage.id,
      generatorVersion: "1",
    },
  };
}

function buildMockGeneratedAssetFileCandidates(spec: AssetGenerationSpecV1): GeneratedAssetFileCandidate[] {
  const bytes = buildMockPngBytes(spec.dimensions.width, spec.dimensions.height);
  return [
    {
      position: 0,
      mimeType: "image/png",
      width: spec.dimensions.width,
      height: spec.dimensions.height,
      durationMs: null,
      fileSizeBytes: bytes.length,
      bytes,
    },
  ];
}

function attachMockAssetFileDescriptors(candidates: GeneratedAssetFileCandidate[], creativePackageId: string): AssetFileDescriptor[] {
  return candidates.map((candidate) => {
    const metadata = {
      position: candidate.position,
      mimeType: candidate.mimeType,
      width: candidate.width,
      height: candidate.height,
      durationMs: candidate.durationMs,
      fileSizeBytes: candidate.fileSizeBytes,
    };
    return {
      ...metadata,
      // Legacy compatibility only: production runner success now uses real Storage materialization.
      storageBucket: "mock",
      storagePath: `mock/${creativePackageId}/${candidate.position}.png`,
      publicUrl: "",
    };
  });
}

function buildMockPngBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d,
    0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
    0x08, 0x04, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
  ]);
  bytes[16] = (width >>> 24) & 0xff;
  bytes[17] = (width >>> 16) & 0xff;
  bytes[18] = (width >>> 8) & 0xff;
  bytes[19] = width & 0xff;
  bytes[20] = (height >>> 24) & 0xff;
  bytes[21] = (height >>> 16) & 0xff;
  bytes[22] = (height >>> 8) & 0xff;
  bytes[23] = height & 0xff;
  return bytes;
}

export function sanitizeAssetJobErrorMessage(message: string, maxLength = 500): string {
  const collapsed = message
    .replace(/\b(key|token|password)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const fallback = "Asset Job execution failed.";
  const safeMessage = collapsed.length > 0 ? collapsed : fallback;
  return safeMessage.length > maxLength ? `${safeMessage.slice(0, maxLength - 1)}...` : safeMessage;
}

export function getAssetJobStatusLabel(status: AssetJobStatus): string {
  return status.slice(0, 1).toUpperCase() + status.slice(1);
}

export function isAssetJobTerminal(job: Pick<AssetJobRecord, "status">): boolean {
  return TERMINAL_JOB_STATUSES.has(job.status);
}

async function readCreativePackage(client: AssetJobClient, id: string) {
  const result = await client.from("creative_packages").select<CreativePackageRow>("*").eq("id", id).maybeSingle();
  if (result.error) {
    return { ok: false as const, ...dbErrorResult(result.error) };
  }
  if (!result.data) {
    return { ok: false as const, reason: "not-found" as const, message: "Creative Package not found. It may have been removed or filtered out by access rules." };
  }

  try {
    return { ok: true as const, creativePackage: fromCreativePackageRow(result.data) };
  } catch (err) {
    return { ok: false as const, reason: "failed" as const, message: err instanceof Error ? err.message : String(err) };
  }
}

export async function getAssetJobById(client: AssetJobClient, id: string): Promise<AssetJobDetailResult> {
  const result = await client.from("asset_jobs").select<AssetJobRow>("*").eq("id", id).maybeSingle();
  if (result.error) {
    return { ok: false, ...dbErrorResult(result.error) };
  }
  if (!result.data) {
    return { ok: false, reason: "not-found", message: "Asset Job not found." };
  }

  try {
    return { ok: true, job: fromAssetJobRow(result.data) };
  } catch (err) {
    return { ok: false, reason: "failed", message: err instanceof Error ? err.message : String(err) };
  }
}

// Unlike createCreativeJobForAcceptedOpportunity, there is no "return the existing job instead"
// branch here: asset_jobs.creative_package_id is deliberately not unique (a Creative Package may
// have many Asset Jobs over time), so every call simply inserts a new queued row.
export async function createAssetJobForReadyCreativePackage(
  client: AssetJobClient,
  creativePackageId: string,
  options: { workerType?: AssetJobWorkerType; assetKind?: AssetKind } = {},
): Promise<AssetJobCreateResult> {
  const packageResult = await readCreativePackage(client, creativePackageId);
  if (!packageResult.ok) {
    return { ok: false, reason: packageResult.reason, message: packageResult.message };
  }
  // Mirrors createCreativeJobForAcceptedOpportunity's gate-on-parent-status pattern. Currently
  // unreachable in practice -- CreativePackageStatus is the single-value union ["ready"], and its
  // own row parser normalizes anything else back to "ready" -- but kept so this call site is
  // already guarded the moment creative_packages ever gains a second status value.
  if (packageResult.creativePackage.status !== "ready") {
    return {
      ok: false,
      reason: "not-ready",
      message: `Asset Jobs can only be created from ready Creative Packages. Current status: ${packageResult.creativePackage.status}.`,
    };
  }

  const workerType = options.workerType ?? "mock";
  const assetKind = options.assetKind ?? "image";

  const inserted = await client
    .from("asset_jobs")
    .insert({ creative_package_id: creativePackageId, status: "queued", worker_type: workerType, asset_kind: assetKind, attempt_count: 0, result: {}, last_error: null })
    .select("*")
    .single();

  if (!inserted.error && inserted.data) {
    return { ok: true, outcome: "created", job: fromAssetJobRow(inserted.data) };
  }

  return { ok: false, ...dbErrorResult(inserted.error ?? { message: "Asset Job insert returned no row." }) };
}

export async function listQueuedAssetJobs(client: AssetJobClient, limit = 1, workerType?: AssetJobWorkerType): Promise<QueuedAssetJobsResult> {
  let query = client.from("asset_jobs").select<AssetJobRow>("*").eq("status", "queued");
  if (workerType) {
    query = query.eq("worker_type", workerType);
  }
  const result = await query.order("created_at", { ascending: true }).limit(limit);

  if (result.error) {
    return { ok: false, ...dbErrorResult(result.error) };
  }

  try {
    return { ok: true, jobs: (result.data ?? []).map(fromAssetJobRow) };
  } catch (err) {
    return { ok: false, reason: "failed", message: err instanceof Error ? err.message : String(err) };
  }
}

export async function listAssetJobsForCreativePackage(client: AssetJobClient, creativePackageId: string): Promise<CreativePackageAssetJobsResult> {
  const result = await client
    .from("asset_jobs")
    .select<AssetJobRow>("*")
    .eq("creative_package_id", creativePackageId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false });

  if (result.error) {
    return { ok: false, ...dbErrorResult(result.error) };
  }

  try {
    return { ok: true, jobs: (result.data ?? []).map(fromAssetJobRow) };
  } catch (err) {
    return { ok: false, reason: "failed", message: err instanceof Error ? err.message : String(err) };
  }
}

export async function claimQueuedAssetJobWithAttempt(client: AssetJobClient, id: string): Promise<AssetJobClaimWithAttemptResult> {
  const result = await client.rpc("claim_asset_job_with_attempt", { p_job_id: id }).maybeSingle();
  if (result.error) {
    return { ok: false, ...dbErrorResult(result.error) };
  }
  if (result.data) {
    const { attempt_id, attempt_number, ...jobRow } = result.data;
    return { ok: true, job: fromAssetJobRow(jobRow), attemptId: attempt_id, attemptNumber: attempt_number };
  }

  const reread = await getAssetJobById(client, id);
  if (!reread.ok) {
    return reread.reason === "not-found"
      ? { ok: false, reason: "not-found", message: "Asset Job was not claimed because it could not be found after the atomic claim." }
      : { ok: false, reason: reread.reason, message: reread.message };
  }

  return {
    ok: false,
    reason: "not-queued",
    message: `Asset Job was not claimed because its status is ${reread.job.status}.`,
    job: reread.job,
  };
}

type FinishAssetJobWriteResult =
  | { written: true; job: AssetJobRecord }
  | { written: false; reason: "missing-table" | "not-found" | "conflict" | "failed"; message: string; job?: AssetJobRecord };

// Shared by completeRunningAssetJob and failRunningAssetJob -- mirrors finishCreativeJobViaRpc
// exactly, including its ok:true-for-complete/ok:false-for-fail asymmetry. No timestamp is passed
// in; finish_asset_job computes completed_at/failed_at from now() internally.
async function finishAssetJobViaRpc(
  client: AssetJobClient,
  job: AssetJobRecord,
  outcome: "completed" | "failed",
  result: AssetJobResultEnvelope | null,
  lastError: string | null,
): Promise<FinishAssetJobWriteResult> {
  const rpcResult = await client.rpc("finish_asset_job", { p_job_id: job.id, p_outcome: outcome, p_result: result, p_last_error: lastError }).maybeSingle();
  if (rpcResult.error) {
    return { written: false, ...dbErrorResult(rpcResult.error) };
  }
  if (rpcResult.data) {
    return { written: true, job: fromAssetJobRow(rpcResult.data) };
  }

  const reread = await getAssetJobById(client, job.id);
  return reread.ok
    ? { written: false, reason: "conflict", message: `Asset Job status changed to ${reread.job.status} before the runner could finish.`, job: reread.job }
    : { written: false, reason: reread.reason === "not-found" ? "not-found" : reread.reason, message: reread.message };
}

export async function completeRunningAssetJob(client: AssetJobClient, job: AssetJobRecord, resultEnvelope: unknown): Promise<AssetJobRunnerResult> {
  const validation = validateAssetJobResultEnvelope(resultEnvelope);
  if (!validation.ok) {
    return failRunningAssetJob(client, job, validation.message);
  }

  const result = await finishAssetJobViaRpc(client, job, "completed", validation.result, null);
  return result.written ? { ok: true, outcome: "completed", job: result.job } : { ok: false, reason: result.reason, message: result.message, job: result.job };
}

export async function failRunningAssetJob(client: AssetJobClient, job: AssetJobRecord, message = "Asset Job execution failed."): Promise<AssetJobRunnerResult> {
  const lastError = sanitizeAssetJobErrorMessage(message);
  const result = await finishAssetJobViaRpc(client, job, "failed", null, lastError);
  return result.written
    ? { ok: false, reason: "failed", message: lastError, job: result.job }
    : { ok: false, reason: result.reason, message: result.message, job: result.job };
}

export type AssetJobRunnerOptions = {
  timeoutMs?: number;
};

export async function runAssetJobWithExecutors(
  client: AssetJobExecutionClient,
  id: string,
  executors: AssetJobExecutorMap,
  options: AssetJobRunnerOptions = {},
): Promise<AssetJobRunnerResult> {
  const claimed = await claimQueuedAssetJobWithAttempt(client, id);
  if (!claimed.ok) {
    return claimed;
  }

  // Captured as plain, non-union locals rather than read off `claimed` inside the closures below
  // -- TypeScript does not carry the `claimed.ok` narrowing into a nested function declaration.
  const job = claimed.job;
  const attemptId = claimed.attemptId;

  // Job-first, attempt-second: if the process crashes between the two writes below, the job is
  // already correctly terminal (everything that matters -- Asset materialization -- gates on the
  // job, not the attempt) and only the attempt is left cosmetically stale. Mirrors
  // runCreativeJobWithExecutors' own failJobAndAttempt exactly.
  async function failJobAndAttempt(message: string, attemptOutcome: "failed" | "timed_out" = "failed"): Promise<AssetJobRunnerResult> {
    const jobResult = await failRunningAssetJob(client, job, message);
    if (jobResult.ok) {
      return jobResult;
    }
    const reason = attemptOutcome === "timed_out" && jobResult.reason === "failed" ? ("timeout" as const) : jobResult.reason;
    const attempt = await finishAssetJobAttempt(client, attemptId, attemptOutcome, {
      errorCode: attemptOutcome === "timed_out" ? "timeout" : "failed",
      errorMessage: jobResult.message,
    });
    return { ...jobResult, reason, attempt };
  }

  if (!isAssetJobWorkerType(job.workerType)) {
    return failJobAndAttempt(`Unsupported worker type: ${job.workerType}.`);
  }
  const workerType = job.workerType;

  const executor = executors[workerType];
  if (!executor) {
    return failJobAndAttempt(`No executor is registered for worker type: ${workerType}.`);
  }

  if (!isAssetKind(job.assetKind)) {
    return failJobAndAttempt(`Unsupported asset kind: ${job.assetKind}.`);
  }
  const assetKind = job.assetKind;

  const creativePackage = await readCreativePackage(client, job.creativePackageId);
  if (!creativePackage.ok || creativePackage.creativePackage.status !== "ready") {
    return failJobAndAttempt("Asset Job could not load a ready Creative Package.");
  }
  const readyCreativePackage = creativePackage.creativePackage;

  let spec: AssetGenerationSpecV1;
  try {
    spec = buildAssetGenerationSpec(readyCreativePackage, { assetKind, brandBible: BRAND_BIBLE });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return failJobAndAttempt(message);
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_EXECUTOR_TIMEOUT_MS;
  const controller = new AbortController();
  let timedOut = false;

  let candidateResult: unknown;
  try {
    candidateResult = await new Promise<GeneratedAssetFileCandidate[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        timedOut = true;
        // Only stops waiting -- nothing here can forcibly terminate in-flight executor work.
        // Mirrors runCreativeJobWithExecutors' own timeout handling exactly.
        controller.abort();
        reject(new Error(`Asset Job execution exceeded ${timeoutMs}ms timeout.`));
      }, timeoutMs);

      Promise.resolve(executor(job, spec, { signal: controller.signal })).then(
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

  const candidateValidation = validateGeneratedAssetCandidates(candidateResult, spec);
  if (!candidateValidation.ok) {
    return failJobAndAttempt(candidateValidation.message);
  }

  const inspected: InspectedAssetCandidate[] = [];
  const { validateAssetCandidateBytes } = await import("./asset-binary.ts");
  for (const candidate of candidateValidation.candidates) {
    const byteValidation = await validateAssetCandidateBytes(candidate);
    if (!byteValidation.ok) {
      return failJobAndAttempt(byteValidation.message);
    }
    inspected.push(byteValidation.inspected);
  }

  const { materializeAssetJobFiles } = await import("./asset-file-materialization.ts");
  const materialization = await materializeAssetJobFiles(client, { job, inspected });
  if (!materialization.ok) {
    const jobResult = await failRunningAssetJob(client, job, materialization.message);
    if (jobResult.ok) {
      return { ...jobResult, materialization };
    }
    const attempt = await finishAssetJobAttempt(client, attemptId, "failed", { errorCode: materialization.reason, errorMessage: jobResult.message });
    return { ...jobResult, attempt, materialization };
  }

  const attempt = await finishAssetJobAttempt(client, attemptId, "completed");
  return { ok: true, outcome: "completed", job: materialization.materialized.job, attempt, materialization };
}

export async function runMockAssetJob(client: AssetJobExecutionClient, id: string, options: AssetJobRunnerOptions = {}): Promise<AssetJobRunnerResult> {
  return runAssetJobWithExecutors(client, id, { mock: (_job, spec) => buildMockGeneratedAssetFileCandidates(spec) }, options);
}

export async function runQueuedMockAssetJobs(client: AssetJobExecutionClient, limit = 1, options: AssetJobRunnerOptions = {}) {
  const queued = await listQueuedAssetJobs(client, limit, "mock");
  if (!queued.ok) {
    return queued;
  }

  const results: AssetJobRunnerResult[] = [];
  for (const job of queued.jobs) {
    results.push(await runMockAssetJob(client, job.id, options));
  }

  return { ok: true as const, results };
}
