import { fromCreativePackageRow, type CreativePackageRecord, type CreativePackageRow } from "./creative-packages.ts";
import { buildAssetGenerationSpec, type AssetGenerationSpecV1 } from "./asset-generation-spec.ts";
// Type-only, and deliberately so: production-spec.ts imports AssetKind back from this module, and a
// value import in either direction would close a runtime cycle. Same resolution, and same reason, as
// the existing asset-generation-spec.ts <-> asset-jobs.ts pairing directly above.
import { buildProductionSpec, isProductionSpecV1, productionSpecSha256, type ProductionSpecV1 } from "./production-spec.ts";
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
  type AssetJobAttemptProvenance,
} from "./asset-job-attempts.ts";
import { EXECUTABLE_ASSET_JOB_WORKER_TYPES, resolveProductionRoute, type ProductionRoute } from "./production-route.ts";

export const ASSET_JOB_STATUSES = ["queued", "running", "completed", "failed"] as const;
export type AssetJobStatus = (typeof ASSET_JOB_STATUSES)[number];

// "external" (PROP-027) is the External Creative Workspace executor -- a human working in any
// creative tool, or a real camera. This is an execution-mechanism value only ("which code path
// processes this job"), never a stand-in for which specific tool a human used -- that is
// sourceWorkspace, a separate field on the Asset's own content, not on the job. A real API provider
// worker type is added additively later (pure-text-union change, no migration) by the milestone
// that actually wires one up. Mirrors CREATIVE_JOB_WORKER_TYPES' own precedent of listing only
// what's actually implemented -- a precedent Production MVP Wave A deliberately keeps rather than
// breaks. The Production Route table names two further execution mechanisms for later waves, and
// they live in production-route.ts, not here, so that this union keeps meaning "runnable today":
// each later wave adds its member here in the same change that registers its executor, which is
// what stops a queued row from naming a worker nothing can ever claim.
export const ASSET_JOB_WORKER_TYPES = ["mock", "external", "static_renderer", "generative_image"] as const;
export type AssetJobWorkerType = (typeof ASSET_JOB_WORKER_TYPES)[number];

// "short_video" joins "image" in Wave A as a structural asset kind: ProductionSpecV1 and the
// candidate validator both have to be able to REPRESENT a video before any wave can produce one.
// Carousel/story_graphic remain later, separately-proven additions -- pure-additive TS union change,
// no migration, exactly as the original comment here anticipated.
//
// Declaring the kind does not make it producible. No executor emits a short_video in Wave A, and the
// generated-assets bucket still rejects video/mp4 until the authored migration is applied.
export const ASSET_KINDS = ["image", "short_video"] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

// The subset of ASSET_KINDS a registered executor can actually PRODUCE today, and the type the
// job-creation API accepts.
//
// ASSET_KINDS is the domain vocabulary -- what a spec, a route or a candidate may REPRESENT.
// This is the narrower runtime question: what can be queued and then honoured. Wave A answers
// "image", because that is the only kind any registered executor emits and the only one the
// generated-assets bucket admits. Keeping the two apart is what stops a queued row from naming an
// output nothing can make, in exactly the way ASSET_JOB_WORKER_TYPES already stops one from naming
// a worker nothing can claim -- the asset-kind half of the same activation boundary.
//
// `satisfies` is load-bearing: an executable kind that is not a real AssetKind fails to compile.
// Each later wave adds its member here in the same change that registers the executor producing it.
export const EXECUTABLE_ASSET_KINDS = ["image"] as const satisfies readonly AssetKind[];
export type ExecutableAssetKind = (typeof EXECUTABLE_ASSET_KINDS)[number];

// The three ways a human-sourced (non-API) asset can come to exist -- describes creative origin
// only. Distinct from worker_type (execution mechanism, above) and from provider/model (reserved
// exclusively for a future real API executor on asset_job_attempts, never populated here -- see
// PROP-027 retired P3). Small and closed because the distinction has real downstream meaning
// (fabricated product photography vs. a real photo is not a cosmetic difference).
export const ASSET_SOURCE_KINDS = ["ai_generated", "photograph", "human_designed"] as const;
export type AssetSourceKind = (typeof ASSET_SOURCE_KINDS)[number];

// The creative origin each MACHINE executor produces, BY CONSTRUCTION.
//
// For "external" the origin is a fact only the operator knows -- a real camera photo, a Midjourney
// render, a hand-built Canva graphic all arrive through the same worker -- so it stays an
// operator-declared option. For the two machine workers it is not a matter of opinion:
//
//   generative_image calls an image model, so its output IS ai_generated and must say so.
//   static_renderer composes this app's own authored template deterministically and never calls a
//   model, so labelling it ai_generated would be a lie about provenance in the opposite direction.
//
// Derived by the runner from the worker that actually ran, rather than passed as a parameter every
// call site has to remember, because "the caller forgot" is exactly how a generated illustration ends
// up materialized with an undefined source kind. For the same reason the derived value WINS over
// options.sourceKind for these two workers: a machine executor's origin is observed, not declared,
// and an operator must not be able to relabel a model's output as a photograph.
export const MACHINE_EXECUTOR_SOURCE_KINDS: Partial<Record<AssetJobWorkerType, AssetSourceKind>> = {
  generative_image: "ai_generated",
  static_renderer: "human_designed",
};

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
  // sourceWorkspace/sourceKind/briefSchemaVersion/briefSha256 (PROP-027 P4) describe the creative
  // origin when a human/external workspace produced this asset. provider/model are deliberately
  // never fields here -- they are reserved exclusively for a future real API executor, on
  // asset_job_attempts, not this envelope (see retired P3, and the "never blur" regression tests).
  metadata: {
    generatedFromCreativePackage: string;
    generatorVersion: "1";
    sourceWorkspace?: string;
    sourceKind?: AssetSourceKind;
    briefSchemaVersion?: string;
    briefSha256?: string;
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
  | {
      ok: true;
      outcome: "completed";
      job: AssetJobRecord;
      attempt?: AssetJobAttemptFinishResult;
      materialization?: AssetJobFileMaterializationResult;
      // Advisory-only (PROP-027 P5/AC-4) -- e.g. spec-dimension mismatches. Never blocks completion;
      // exists so a caller (the browser upload UI) can show the operator what to expect. Empty, not
      // omitted, when there is nothing to warn about.
      warnings: string[];
    }
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
//
// Production MVP Wave A widens the SPEC PARAMETER ONLY. Everything else about this seam is
// deliberately unchanged, because everything else about it is already right: executors still return
// candidates rather than persisted files, so validation, upload and materialization stay owned by
// the runner and an executor cannot invent a storage path, skip validation or bypass the attempt
// lifecycle. Widening the union is what lets a future automated executor read a ProductionSpecV1
// without a second executor abstraction existing alongside this one.
// recordProvenance is how an executor tells the runner WHICH PROVIDER AND MODEL it actually used.
//
// It is a callback rather than a return value because the runner has to be able to persist it on a
// FAILED or TIMED-OUT attempt too, and a failing executor never returns anything. An executor calls
// this at the moment provider and model are settled and a request is about to be made, so:
//
//   - a failure after that point still records what was really contacted, which is exactly when
//     "which model did we call" matters most;
//   - a failure BEFORE that point (a rejected spec, an invalid reference set) records nothing, and a
//     null provider then truthfully means no provider was ever contacted.
//
// Optional so an executor that contacts no provider -- mock, external, static_renderer -- simply
// never calls it, and so a direct unit-test invocation need not supply one. The runner always does.
export type AssetJobExecutor = (
  job: AssetJobRecord,
  spec: AssetGenerationSpecV1 | ProductionSpecV1,
  context: { signal: AbortSignal; recordProvenance?: (provenance: AssetJobAttemptProvenance) => void },
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

export function isAssetSourceKind(value: string): value is AssetSourceKind {
  return ASSET_SOURCE_KINDS.includes(value as AssetSourceKind);
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

  if (
    !isJsonObject(metadata) ||
    typeof metadata.generatedFromCreativePackage !== "string" ||
    metadata.generatedFromCreativePackage.trim().length === 0 ||
    /\s/.test(metadata.generatedFromCreativePackage) ||
    metadata.generatorVersion !== "1" ||
    (metadata.sourceWorkspace !== undefined && typeof metadata.sourceWorkspace !== "string") ||
    (metadata.sourceKind !== undefined && (typeof metadata.sourceKind !== "string" || !isAssetSourceKind(metadata.sourceKind))) ||
    (metadata.briefSchemaVersion !== undefined && typeof metadata.briefSchemaVersion !== "string") ||
    (metadata.briefSha256 !== undefined && typeof metadata.briefSha256 !== "string")
  ) {
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

// Reads nothing but spec.dimensions, which both spec types carry, so widening the parameter costs
// no branch. The mock stays an IMAGE fixture whatever it is handed -- it is the "no real executor"
// stand-in, not a second renderer, and giving it a video branch would make it one.
function buildMockGeneratedAssetFileCandidates(spec: AssetGenerationSpecV1 | ProductionSpecV1): GeneratedAssetFileCandidate[] {
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

export type AssetGenerationSpecResult =
  | { ok: true; spec: AssetGenerationSpecV1 }
  | { ok: false; reason: "unsupported-asset-kind" | "missing-table" | "not-found" | "not-ready" | "failed"; message: string };

export type AssetJobSpecResult =
  | { ok: true; spec: AssetGenerationSpecV1 | ProductionSpecV1 }
  | { ok: false; reason: "unsupported-asset-kind" | "missing-table" | "not-found" | "not-ready" | "failed"; message: string };

// The one place a job's spec is resolved -- reused by runAssetJobWithExecutors (post-claim) and by
// the desktop CLI's export command (pre-claim, read-only). Deliberately takes only the two fields
// it needs, not a full job, so a pre-claim caller (which has no attempt/status context yet) can call
// it just as naturally as the post-claim runner. Job status is each caller's own concern, not this
// function's -- it only ever resolves "what would this job's spec be," never whether the job is in
// the right state to use it. reason is a distinct value per failure mode (not just "failed") so a
// caller that wants runAssetJobWithExecutors's original, less granular message for the "job cannot
// load its Creative Package at all" case can select on it structurally, never by matching message text.
export async function buildAssetGenerationSpecForJob(
  client: AssetJobClient,
  job: Pick<AssetJobRecord, "creativePackageId" | "assetKind">,
): Promise<AssetGenerationSpecResult> {
  if (!isAssetKind(job.assetKind)) {
    return { ok: false, reason: "unsupported-asset-kind", message: `Unsupported asset kind: ${job.assetKind}.` };
  }
  const assetKind = job.assetKind;

  const creativePackage = await readCreativePackage(client, job.creativePackageId);
  if (!creativePackage.ok) {
    return { ok: false, reason: creativePackage.reason, message: creativePackage.message };
  }
  if (creativePackage.creativePackage.status !== "ready") {
    return { ok: false, reason: "not-ready", message: "Asset Job could not load a ready Creative Package." };
  }

  try {
    return { ok: true, spec: buildAssetGenerationSpec(creativePackage.creativePackage, { assetKind, brandBible: BRAND_BIBLE }) };
  } catch (err) {
    return { ok: false, reason: "failed", message: err instanceof Error ? err.message : String(err) };
  }
}

export async function buildAssetJobSpecForJob(
  client: AssetJobClient,
  job: Pick<AssetJobRecord, "creativePackageId" | "assetKind" | "workerType">,
): Promise<AssetJobSpecResult> {
  if (!isAssetKind(job.assetKind)) {
    return { ok: false, reason: "unsupported-asset-kind", message: `Unsupported asset kind: ${job.assetKind}.` };
  }
  const assetKind = job.assetKind;

  if (job.workerType !== "static_renderer" && job.workerType !== "generative_image") {
    return buildAssetGenerationSpecForJob(client, job);
  }

  const creativePackage = await readCreativePackage(client, job.creativePackageId);
  if (!creativePackage.ok) {
    return { ok: false, reason: creativePackage.reason, message: creativePackage.message };
  }
  if (creativePackage.creativePackage.status !== "ready") {
    return { ok: false, reason: "not-ready", message: "Asset Job could not load a ready Creative Package." };
  }

  try {
    return { ok: true, spec: buildProductionSpec(creativePackage.creativePackage, { assetKind, brandBible: BRAND_BIBLE }) };
  } catch (err) {
    return { ok: false, reason: "failed", message: err instanceof Error ? err.message : String(err) };
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

// The executable projection of a ProductionRoute: both halves already narrowed to the runtime types
// the job-creation API accepts.
//
// Deliberately CONSTRUCTED, not asserted. The two values returned are the ones found INSIDE
// EXECUTABLE_ASSET_JOB_WORKER_TYPES and EXECUTABLE_ASSET_KINDS, so their narrow types come from the
// executable sets themselves -- there is no `as` here, and no hand-written type predicate whose body
// TypeScript would have taken on trust. Widen either set and this widens with it; widen neither and
// no route naming a still-unregistered future worker, or a still-unproducible asset kind, can yield
// an ExecutableAssetJobRoute at all. (Those future workers are named in production-route.ts, never
// here -- this module stays free of future-domain technology names, and a static test enforces it.)
//
// It lives in this module rather than in production-route.ts because it needs EXECUTABLE_ASSET_KINDS
// as a VALUE, and production-route.ts imports from here type-only on purpose -- a value import in
// that direction would close the runtime cycle both files' headers exist to prevent.
export type ExecutableAssetJobRoute = {
  workerType: AssetJobWorkerType;
  assetKind: ExecutableAssetKind;
};

export function toExecutableAssetJobRoute(route: ProductionRoute): ExecutableAssetJobRoute | null {
  const workerType = EXECUTABLE_ASSET_JOB_WORKER_TYPES.find((candidate) => candidate === route.workerType);
  const assetKind = EXECUTABLE_ASSET_KINDS.find((candidate) => candidate === route.assetKind);
  return workerType && assetKind ? { workerType, assetKind } : null;
}

// Unlike createCreativeJobForAcceptedOpportunity, there is no "return the existing job instead"
// branch here: asset_jobs.creative_package_id is deliberately not unique (a Creative Package may
// have many Asset Jobs over time), so every call simply inserts a new queued row.
export async function createAssetJobForReadyCreativePackage(
  client: AssetJobClient,
  creativePackageId: string,
  options: { workerType?: AssetJobWorkerType; assetKind?: ExecutableAssetKind } = {},
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

  // THE ACTIVATION INVARIANT.
  //
  // The question asked here is about the FINAL PAIR that is about to be inserted, never about the
  // resolved route alone. That distinction is the whole fix: options may override either half
  // independently, so a guard that only fired when BOTH were absent let a partial override through --
  // pass only workerType on a reel package and assetKind still fell back to the route's "short_video",
  // pass only assetKind and workerType still fell back to that route's unregistered future worker --
  // and the two casts that followed then laundered those non-executable values into
  // AssetJobWorkerType / ExecutableAssetKind.
  // The result was a queued row no runner could ever claim, on a package the owner was told was being
  // produced.
  //
  // toExecutableAssetJobRoute replaces both casts with construction: it can only return values it
  // took OUT of the executable sets, so there is no path from a non-executable route to an inserted
  // row, whatever combination of options a caller supplies.
  const resolvedRoute = resolveProductionRoute(packageResult.creativePackage);
  const requestedRoute: ProductionRoute = {
    workerType: options.workerType ?? resolvedRoute.workerType,
    assetKind: options.assetKind ?? resolvedRoute.assetKind,
  };
  const executableRoute = toExecutableAssetJobRoute(requestedRoute);
  if (!executableRoute) {
    return { ok: false, reason: "failed", message: `Production route is not executable yet: ${requestedRoute.workerType} + ${requestedRoute.assetKind}.` };
  }

  const { workerType, assetKind } = executableRoute;

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

// The one place that decides which Asset Job a "Create asset job" UI action reuses instead of
// duplicating -- asset_jobs.creative_package_id has no unique constraint (a Creative Package may
// have many Asset Jobs over time; supabase-add-asset-jobs.sql's own guard raises an exception if
// that index is ever made unique), so this is the only protection against a rapid double-tap
// producing two equivalent queued jobs. Relies on the caller passing jobs already ordered newest
// first -- exactly what listAssetJobsForCreativePackage returns -- and simply returns the first
// match rather than independently re-sorting; a caller passing unsorted jobs would get an
// arbitrary match, not the newest, so this is not a general-purpose query.
export function findQueuedExternalAssetJob(jobs: AssetJobRecord[]): AssetJobRecord | null {
  return jobs.find((job) => job.status === "queued" && job.workerType === "external") ?? null;
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
  // No candidateValidation step happens on this lower-level path (it completes an
  // already-validated envelope directly, bypassing the executor pipeline) -- warnings is honestly
  // empty here, not omitted, since runAssetJobWithExecutors' own success path is what actually runs
  // the spec-dimension advisory check.
  return result.written ? { ok: true, outcome: "completed", job: result.job, warnings: [] } : { ok: false, reason: result.reason, message: result.message, job: result.job };
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
  // Operator-declared creative-origin provenance for an external job, threaded straight into the
  // completion envelope's metadata. Never a stand-in for provider/model -- those stay reserved for
  // a real API executor, on asset_job_attempts, and are never set by this option (see PROP-027 P4,
  // retired P3).
  //
  // sourceKind is IGNORED for the machine workers in MACHINE_EXECUTOR_SOURCE_KINDS: their creative
  // origin is a fact the runner observes from the executor that ran, not something a caller declares.
  sourceWorkspace?: string;
  sourceKind?: AssetSourceKind;
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

  // Whatever the executor reported about the provider it actually contacted, if it contacted one.
  //
  // Declared HERE, before the executor runs, so both terminal paths below can read it: an attempt
  // that reached a provider and then failed or timed out records the same provider/model a
  // successful one would. It stays undefined when no provider was ever selected, and undefined is
  // what makes "no provider was contacted" a truthful stored answer rather than a guess.
  let attemptProvenance: AssetJobAttemptProvenance | undefined;

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
      provenance: attemptProvenance,
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

  // Preserves this function's own three original messages exactly -- "Unsupported asset kind: X.",
  // a thrown buildAssetGenerationSpec error forwarded verbatim (e.g. malformed package content),
  // and the generic "...could not load a ready Creative Package." only for the package-read/not-
  // ready case -- even though the resolution itself now lives in one shared place. Selecting on
  // reason, never on message text, so this can never silently drift from
  // buildAssetGenerationSpecForJob's own, more specific messages.
  const specResult = await buildAssetJobSpecForJob(client, job);
  if (!specResult.ok) {
    const usesGenericMessage = specResult.reason === "not-found" || specResult.reason === "missing-table" || specResult.reason === "not-ready";
    return failJobAndAttempt(usesGenericMessage ? "Asset Job could not load a ready Creative Package." : specResult.message);
  }
  const spec = specResult.spec;

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

      Promise.resolve(
        executor(job, spec, {
          signal: controller.signal,
          recordProvenance: (provenance) => {
            attemptProvenance = provenance;
          },
        }),
      ).then(
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
  const { briefSha256 } = await import("./asset-generation-brief.ts");

  // TRANSITIONAL NAMING, stated plainly rather than papered over.
  //
  // The persisted columns are still called briefSchemaVersion/briefSha256 because renaming them is a
  // schema migration, and this pass does not migrate. What they hold is now ONE OF TWO things,
  // depending on which contract the executor was handed:
  //
  //   AssetGenerationSpecV1 -> briefSha256(spec): the digest of the RENDERED HUMAN BRIEF TEXT, the
  //     exact prose a person is given in an external creative workspace. Byte-for-byte unchanged from
  //     Wave A, which is the guarantee asset-generation-brief.ts exists to make.
  //
  //   ProductionSpecV1 -> productionSpecSha256(spec): the digest of the CANONICAL SERIALIZATION OF
  //     THE SPEC ITSELF. A production spec is read by a machine executor and has no rendered human
  //     brief to hash, so there is no "brief" here in the older sense of the word.
  //
  // Both answer the same provenance question -- "was this asset made from the input we think it was"
  // -- for two different contracts, and briefSchemaVersion ("v1" vs "production-v1") is what tells
  // the two apart when reading a stored envelope. Do not read a stored briefSha256 as a brief-text
  // digest without checking briefSchemaVersion first.
  const specSha256 = isProductionSpecV1(spec) ? await productionSpecSha256(spec) : await briefSha256(spec);

  // SOURCE KIND. For a machine executor the creative origin is observed, not declared, so the derived
  // value wins over anything the caller passed -- see MACHINE_EXECUTOR_SOURCE_KINDS. For external/mock
  // there is nothing to derive and the operator's declaration is the only available truth (undefined
  // for mock jobs, which never pass one).
  const sourceKind = MACHINE_EXECUTOR_SOURCE_KINDS[workerType] ?? options.sourceKind;

  // workerType here is the same already-narrowed value used above to select the executor
  // (executors[workerType]) -- the envelope's worker field records the executor that actually ran,
  // never re-derived from the job row after the fact. briefSchemaVersion is always available here at
  // zero cost (spec is already built above). The digest is safe to (re-)compute here, at completion
  // time, rather than only at brief-view time, because the spec's own inputs (a Creative Package's
  // content, this job's assetKind, the static BRAND_BIBLE) are all immutable once this job exists --
  // see tests/creative-packages.test.ts's "never updated in place" test. A materially different input
  // always means a different, new Asset Job, never a changed fingerprint on this one.
  const materialization = await materializeAssetJobFiles(client, {
    job,
    inspected,
    workerType,
    metadata: {
      sourceWorkspace: options.sourceWorkspace,
      sourceKind,
      briefSchemaVersion: spec.schemaVersion,
      briefSha256: specSha256,
    },
  });
  if (!materialization.ok) {
    const jobResult = await failRunningAssetJob(client, job, materialization.message);
    if (jobResult.ok) {
      return { ...jobResult, materialization };
    }
    // Materialization failed AFTER the executor already produced bytes, so if a provider was
    // contacted it was contacted successfully -- that provenance is still true and is still recorded.
    const attempt = await finishAssetJobAttempt(client, attemptId, "failed", {
      errorCode: materialization.reason,
      errorMessage: jobResult.message,
      provenance: attemptProvenance,
    });
    return { ...jobResult, attempt, materialization };
  }

  const attempt = await finishAssetJobAttempt(client, attemptId, "completed", { provenance: attemptProvenance });
  return { ok: true, outcome: "completed", job: materialization.materialized.job, attempt, materialization, warnings: candidateValidation.warnings };
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
