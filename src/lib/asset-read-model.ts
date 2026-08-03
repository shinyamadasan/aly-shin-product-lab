import { listOrderedAssetFilesForAsset, type AssetFileClient, type AssetFileRecord } from "./asset-files.ts";
import type { AssetJobRecord, AssetJobRow, AssetJobStatus } from "./asset-jobs.ts";
import type { AssetRecord, AssetRow, AssetSchemaVersion, AssetStatus } from "./assets.ts";

type SupabaseErrorLike = {
  code?: string;
  message: string;
};

type QueryBuilder<T> = PromiseLike<{ data: T[] | null; error: SupabaseErrorLike | null }> & {
  eq(column: string, value: string): QueryBuilder<T>;
  order(column: string, options: { ascending: boolean }): QueryBuilder<T>;
  maybeSingle(): PromiseLike<{ data: T | null; error: SupabaseErrorLike | null }>;
};

export type AssetReadClient = AssetFileClient & {
  from(table: "asset_jobs"): {
    select<T = unknown>(columns: string): QueryBuilder<T>;
  };
  from(table: "assets"): {
    select<T = unknown>(columns: string): QueryBuilder<T>;
  };
};

export type AssetJobListReadResult =
  | { ok: true; jobs: AssetJobRecord[] }
  | { ok: false; reason: "missing-table" | "failed"; message: string };

export type AssetReadResult =
  | { ok: true; asset: AssetRecord }
  | { ok: false; reason: "missing-table" | "not-found" | "failed"; message: string };

export type AssetFilesReadResult =
  | { ok: true; files: AssetFileRecord[] }
  | { ok: false; reason: "missing-table" | "failed"; message: string };

function isMissingTableError(error: SupabaseErrorLike): boolean {
  return error.code === "PGRST205" || error.code === "42P01";
}

function dbErrorResult(error: SupabaseErrorLike, noun: string): { reason: "missing-table" | "failed"; message: string } {
  if (isMissingTableError(error)) {
    return {
      reason: "missing-table",
      message: `${noun} are not available yet. Verify the Asset SQL files have been applied to this Supabase project.`,
    };
  }

  return { reason: "failed", message: error.message };
}

function isAssetJobStatus(value: string): value is AssetJobStatus {
  return value === "queued" || value === "running" || value === "completed" || value === "failed";
}

function parseAssetJobStatus(value: string): AssetJobStatus {
  return isAssetJobStatus(value) ? value : "queued";
}

function fromAssetJobRow(row: AssetJobRow): AssetJobRecord {
  if (!row.id || !row.created_at || !row.updated_at) {
    throw new Error("Asset Job row is missing id, created_at, or updated_at.");
  }

  return {
    id: row.id,
    creativePackageId: row.creative_package_id,
    status: parseAssetJobStatus(row.status),
    workerType: typeof row.worker_type === "string" && row.worker_type.trim().length > 0 ? row.worker_type : "mock",
    assetKind: typeof row.asset_kind === "string" && row.asset_kind.trim().length > 0 ? row.asset_kind : "image",
    attemptCount: Number(row.attempt_count ?? 0),
    result: row.result && typeof row.result === "object" && !Array.isArray(row.result) ? row.result : {},
    lastError: row.last_error ?? "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at ?? "",
    completedAt: row.completed_at ?? "",
    failedAt: row.failed_at ?? "",
  };
}

function parseAssetStatus(value: string): AssetStatus {
  return value === "generated" ? "generated" : "generated";
}

function parseAssetSchemaVersion(value: string): AssetSchemaVersion {
  return value === "v1" ? "v1" : "v1";
}

function fromAssetRow(row: AssetRow): AssetRecord {
  if (!row.id || !row.created_at || !row.updated_at) {
    throw new Error("Asset row is missing id, created_at, or updated_at.");
  }

  return {
    id: row.id,
    assetJobId: row.asset_job_id,
    status: parseAssetStatus(row.status),
    assetKind: typeof row.asset_kind === "string" && row.asset_kind.trim().length > 0 ? row.asset_kind : "image",
    schemaVersion: parseAssetSchemaVersion(row.schema_version),
    content: row.content && typeof row.content === "object" && !Array.isArray(row.content) ? row.content : {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listAssetJobsForCreativePackageReadOnly(client: AssetReadClient, creativePackageId: string): Promise<AssetJobListReadResult> {
  const result = await client
    .from("asset_jobs")
    .select<AssetJobRow>("*")
    .eq("creative_package_id", creativePackageId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false });

  if (result.error) {
    return { ok: false, ...dbErrorResult(result.error, "Asset Jobs") };
  }

  try {
    return { ok: true, jobs: (result.data ?? []).map(fromAssetJobRow) };
  } catch (err) {
    return { ok: false, reason: "failed", message: err instanceof Error ? err.message : String(err) };
  }
}

export async function readAssetForAssetJobReadOnly(client: AssetReadClient, assetJobId: string): Promise<AssetReadResult> {
  const result = await client.from("assets").select<AssetRow>("*").eq("asset_job_id", assetJobId).maybeSingle();
  if (result.error) {
    return { ok: false, ...dbErrorResult(result.error, "Assets") };
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

export async function listOrderedAssetFilesForAssetReadOnly(client: AssetReadClient, assetId: string): Promise<AssetFilesReadResult> {
  return listOrderedAssetFilesForAsset(client, assetId);
}
