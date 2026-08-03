import {
  fromAssetJobRow,
  runMockAssetJob,
  validateAssetJobResultEnvelope,
  type AssetJobClient,
  type AssetJobRecord,
  type AssetJobRow,
  type AssetJobRunnerOptions,
  type AssetJobRunnerResult,
} from "./asset-jobs.ts";
import type { AssetJobAttemptClient } from "./asset-job-attempts.ts";
import { insertAssetFilesForAsset, listAssetFilesForAsset, type AssetFileClient, type AssetFileRecord } from "./asset-files.ts";
import type { AssetJobFileMaterializationClient } from "./asset-file-materialization.ts";

export const ASSET_STATUSES = ["generated"] as const;
export type AssetStatus = (typeof ASSET_STATUSES)[number];

export const ASSET_SCHEMA_VERSIONS = ["v1"] as const;
export type AssetSchemaVersion = (typeof ASSET_SCHEMA_VERSIONS)[number];

// Deliberately small -- see docs/plan §2/§7: provider, model, raw prompt text, and any raw
// provider response never reach an Asset's own content. Those live only in asset_job_attempts.
// This is the "freeze point" snapshot, mirroring AssetContentV1's design in the approved
// architecture doc exactly.
export type AssetContentV1 = {
  metadata: {
    generatedFromCreativePackage: string;
    sourceAssetJobId: string;
    generatorVersion: "1";
  };
};

export type AssetRow = {
  id?: string;
  asset_job_id: string;
  status: AssetStatus;
  asset_kind: string;
  schema_version: AssetSchemaVersion;
  content: AssetContentV1 | Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
};

export type AssetRecord = {
  id: string;
  assetJobId: string;
  status: AssetStatus;
  assetKind: string;
  schemaVersion: AssetSchemaVersion;
  content: AssetContentV1 | Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

type SupabaseErrorLike = {
  code?: string;
  message: string;
};

type QueryResult<T> = PromiseLike<{ data: T | null; error: SupabaseErrorLike | null }>;

type QueryBuilder<T> = PromiseLike<{ data: T[] | null; error: SupabaseErrorLike | null }> & {
  eq(column: string, value: string): QueryBuilder<T>;
  maybeSingle(): QueryResult<T>;
  select(columns: string): {
    maybeSingle(): QueryResult<T>;
    single(): QueryResult<T>;
  };
};

export type AssetClient = {
  from(table: "assets"): {
    select<T = unknown>(columns: string): QueryBuilder<T>;
    insert(row: Partial<AssetRow>): {
      select(columns: string): {
        single(): QueryResult<AssetRow>;
      };
    };
  };
  from(table: "asset_jobs"): {
    select<T = unknown>(columns: string): QueryBuilder<T>;
  };
};

// Everything needed to run a mock Asset Job and materialize its Asset + Asset Files in one call --
// mirrors CreativePackageRunnerClient's own composition exactly.
export type AssetRunnerClient = AssetClient & AssetFileClient & AssetJobClient & AssetJobAttemptClient & AssetJobFileMaterializationClient;

export type AssetDetailResult =
  | { ok: true; asset: AssetRecord }
  | { ok: false; reason: "missing-table" | "not-found" | "failed"; message: string };

export type AssetCreateResult =
  | { ok: true; outcome: "created" | "existing"; asset: AssetRecord; files: AssetFileRecord[] }
  | { ok: false; reason: "missing-table" | "not-found" | "invalid-job-status" | "unsupported-result" | "failed"; message: string; job?: AssetJobRecord };

type AssetJobRunnerFailure = Extract<AssetJobRunnerResult, { ok: false }>;
type AssetCreateFailure = Extract<AssetCreateResult, { ok: false }>;

export type AssetMaterializedRunResult =
  | { ok: true; job: AssetJobRecord; outcome: "created" | "existing"; asset: AssetRecord; files: AssetFileRecord[] }
  | { ok: false; reason: AssetJobRunnerFailure["reason"] | AssetCreateFailure["reason"]; message: string; job?: AssetJobRecord };

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
      message: "Assets are not available yet. Verify supabase-add-assets.sql has been applied to this Supabase project.",
    };
  }

  return { reason: "failed", message: error.message };
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isAssetStatus(value: string): value is AssetStatus {
  return ASSET_STATUSES.includes(value as AssetStatus);
}

export function isAssetContentV1(value: unknown): value is AssetContentV1 {
  if (!isJsonObject(value)) {
    return false;
  }

  const metadata = value.metadata;

  return (
    isJsonObject(metadata) &&
    typeof metadata.generatedFromCreativePackage === "string" &&
    metadata.generatedFromCreativePackage.trim().length > 0 &&
    typeof metadata.sourceAssetJobId === "string" &&
    metadata.sourceAssetJobId.trim().length > 0 &&
    metadata.generatorVersion === "1"
  );
}

function parseAssetStatus(value: string): AssetStatus {
  return isAssetStatus(value) ? value : "generated";
}

function parseAssetSchemaVersion(value: string): AssetSchemaVersion {
  return value === "v1" ? "v1" : "v1";
}

function parseAssetKind(value: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value : "image";
}

export function fromAssetRow(row: AssetRow): AssetRecord {
  if (!row.id || !row.created_at || !row.updated_at) {
    throw new Error("Asset row is missing id, created_at, or updated_at.");
  }

  return {
    id: row.id,
    assetJobId: row.asset_job_id,
    status: parseAssetStatus(row.status),
    assetKind: parseAssetKind(row.asset_kind),
    schemaVersion: parseAssetSchemaVersion(row.schema_version),
    content: isJsonObject(row.content) ? row.content : {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function readAssetJob(client: AssetClient, assetJobId: string) {
  const result = await client.from("asset_jobs").select<AssetJobRow>("*").eq("id", assetJobId).maybeSingle();
  if (result.error) {
    return { ok: false as const, ...dbErrorResult(result.error) };
  }
  if (!result.data) {
    return { ok: false as const, reason: "not-found" as const, message: "Asset Job not found." };
  }

  try {
    return { ok: true as const, job: fromAssetJobRow(result.data) };
  } catch (err) {
    return { ok: false as const, reason: "failed" as const, message: err instanceof Error ? err.message : String(err) };
  }
}

// Deliberately smaller than the full result envelope -- drops the file descriptors (which become
// asset_files rows, not Asset content) and everything provider-shaped. This is the permanent,
// small, version-marked snapshot; the file descriptors are handled separately by
// createAssetFromCompletedJob via insertAssetFilesForAsset.
export function buildAssetContentFromCompletedJob(job: AssetJobRecord): AssetContentV1 {
  if (job.status !== "completed") {
    throw new Error(`Assets can only be materialized from completed Asset Jobs. Current status: ${job.status}.`);
  }

  const validation = validateAssetJobResultEnvelope(job.result);
  if (!validation.ok) {
    throw new Error("Asset Job result is not a supported v1 asset source.");
  }

  return {
    metadata: {
      generatedFromCreativePackage: validation.result.metadata.generatedFromCreativePackage,
      sourceAssetJobId: job.id,
      generatorVersion: validation.result.metadata.generatorVersion,
    },
  };
}

export async function getAssetForJob(client: AssetClient, assetJobId: string): Promise<AssetDetailResult> {
  const result = await client.from("assets").select<AssetRow>("*").eq("asset_job_id", assetJobId).maybeSingle();
  if (result.error) {
    return { ok: false, ...dbErrorResult(result.error) };
  }
  if (!result.data) {
    return { ok: false, reason: "not-found", message: "No Asset has been materialized yet." };
  }

  try {
    return { ok: true, asset: fromAssetRow(result.data) };
  } catch (err) {
    return { ok: false, reason: "failed", message: err instanceof Error ? err.message : String(err) };
  }
}

async function existingAssetWithFiles(client: AssetClient & AssetFileClient, assetJobId: string): Promise<AssetCreateResult | null> {
  const existing = await getAssetForJob(client, assetJobId);
  if (!existing.ok) {
    return existing.reason === "not-found" ? null : { ok: false, reason: existing.reason, message: existing.message };
  }

  const files = await listAssetFilesForAsset(client, existing.asset.id);
  return { ok: true, outcome: "existing", asset: existing.asset, files: files.ok ? files.files : [] };
}

// Sequenced as: read job -> validate -> check for an existing Asset (race-safe re-read on unique
// violation) -> insert the Asset row -> insert its Asset Files. The last two writes are
// deliberately not wrapped in one transaction/RPC -- a known, accepted non-atomicity for this
// milestone (an Asset Files write failure after a successful Asset insert leaves an Asset with
// zero files), the same category of accepted non-atomicity this codebase already documents for
// purchase-import confirmation before its own RPC milestone. The Asset row is never deleted to
// "undo" that partial failure -- retrying this function is always safe, since the next call finds
// the existing Asset and only re-attempts the Asset Files insert.
export async function createAssetFromCompletedJob(client: AssetClient & AssetFileClient, assetJobId: string): Promise<AssetCreateResult> {
  const jobResult = await readAssetJob(client, assetJobId);
  if (!jobResult.ok) {
    return { ok: false, reason: jobResult.reason, message: jobResult.message };
  }

  if (jobResult.job.status !== "completed") {
    return {
      ok: false,
      reason: "invalid-job-status",
      message: `Assets can only be materialized from completed Asset Jobs. Current status: ${jobResult.job.status}.`,
      job: jobResult.job,
    };
  }

  const resultValidation = validateAssetJobResultEnvelope(jobResult.job.result);
  if (!resultValidation.ok) {
    return {
      ok: false,
      reason: "unsupported-result",
      message: "Asset Job result is not a supported v1 asset source.",
      job: jobResult.job,
    };
  }

  const existing = await existingAssetWithFiles(client, assetJobId);
  if (existing) {
    return existing.ok ? existing : { ok: false, reason: existing.reason, message: existing.message, job: jobResult.job };
  }

  const content = buildAssetContentFromCompletedJob(jobResult.job);
  const inserted = await client
    .from("assets")
    .insert({ asset_job_id: assetJobId, status: "generated", asset_kind: jobResult.job.assetKind, schema_version: "v1", content })
    .select("*")
    .single();

  if (inserted.error || !inserted.data) {
    if (inserted.error && isUniqueViolationError(inserted.error)) {
      const raced = await existingAssetWithFiles(client, assetJobId);
      if (raced) {
        return raced.ok ? raced : { ok: false, reason: raced.reason, message: raced.message, job: jobResult.job };
      }
    }
    return { ok: false, ...dbErrorResult(inserted.error ?? { message: "Asset insert returned no row." }), job: jobResult.job };
  }

  const asset = fromAssetRow(inserted.data);
  const filesResult = await insertAssetFilesForAsset(client, asset.id, resultValidation.result.output.files);
  if (!filesResult.ok) {
    return { ok: false, reason: filesResult.reason, message: filesResult.message, job: jobResult.job };
  }

  return { ok: true, outcome: "created", asset, files: filesResult.files };
}

export async function runMockAssetJobAndMaterializeAsset(
  client: AssetRunnerClient,
  assetJobId: string,
  options: AssetJobRunnerOptions = {},
): Promise<AssetMaterializedRunResult> {
  const jobResult = await runMockAssetJob(client, assetJobId, options);
  if (!jobResult.ok) {
    return { ok: false, reason: jobResult.reason, message: jobResult.message, job: jobResult.job };
  }

  const materialized = jobResult.materialization;
  if (materialized?.ok) {
    return {
      ok: true,
      job: materialized.materialized.job,
      outcome: materialized.outcome,
      asset: materialized.materialized.asset,
      files: materialized.materialized.files,
    };
  }

  const existing = await getAssetForJob(client, jobResult.job.id);
  if (!existing.ok) {
    return { ok: false, reason: existing.reason, message: existing.message, job: jobResult.job };
  }
  const files = await listAssetFilesForAsset(client, existing.asset.id);
  if (!files.ok) {
    return { ok: false, reason: files.reason, message: files.message, job: jobResult.job };
  }

  return { ok: true, job: jobResult.job, outcome: "existing", asset: existing.asset, files: files.files };
}
