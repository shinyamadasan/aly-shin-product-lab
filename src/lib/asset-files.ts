import type { AssetFileDescriptor } from "./asset-jobs.ts";

export type AssetFileRow = {
  id?: string;
  asset_id: string;
  position: number;
  storage_bucket: string;
  storage_path: string;
  public_url: string;
  mime_type: string;
  file_size_bytes: number;
  width?: number | null;
  height?: number | null;
  duration_ms?: number | null;
  checksum_sha256?: string | null;
  created_at?: string;
};

export type AssetFileRecord = {
  id: string;
  assetId: string;
  position: number;
  storageBucket: string;
  storagePath: string;
  publicUrl: string;
  mimeType: string;
  fileSizeBytes: number;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  checksumSha256: string;
  createdAt: string;
};

type SupabaseErrorLike = {
  code?: string;
  message: string;
};

type QueryBuilder<T> = PromiseLike<{ data: T[] | null; error: SupabaseErrorLike | null }> & {
  eq(column: string, value: string): QueryBuilder<T>;
  order(column: string, options: { ascending: boolean }): QueryBuilder<T>;
};

// Files have no lifecycle/status of their own (see supabase-add-asset-files.sql's disallowed-
// column guard), so the only writes are a one-time multi-row insert; select is read-only,
// ordered by position for multi-file kinds.
export type AssetFileClient = {
  from(table: "asset_files"): {
    select<T = unknown>(columns: string): QueryBuilder<T>;
    insert(rows: Partial<AssetFileRow>[]): {
      select(columns: string): PromiseLike<{ data: AssetFileRow[] | null; error: SupabaseErrorLike | null }>;
    };
  };
};

export type AssetFilesInsertResult =
  | { ok: true; files: AssetFileRecord[] }
  | { ok: false; reason: "missing-table" | "failed"; message: string };

export type AssetFilesListResult =
  | { ok: true; files: AssetFileRecord[] }
  | { ok: false; reason: "missing-table" | "failed"; message: string };

function isMissingTableError(error: SupabaseErrorLike): boolean {
  return error.code === "PGRST205" || error.code === "42P01";
}

function dbErrorResult(error: SupabaseErrorLike): { reason: "missing-table" | "failed"; message: string } {
  if (isMissingTableError(error)) {
    return {
      reason: "missing-table",
      message: "Asset Files are not available yet. Verify supabase-add-asset-files.sql has been applied to this Supabase project.",
    };
  }

  return { reason: "failed", message: error.message };
}

export function fromAssetFileRow(row: AssetFileRow): AssetFileRecord {
  if (!row.id || !row.created_at) {
    throw new Error("Asset File row is missing id or created_at.");
  }

  return {
    id: row.id,
    assetId: row.asset_id,
    position: row.position,
    storageBucket: row.storage_bucket,
    storagePath: row.storage_path,
    publicUrl: row.public_url,
    mimeType: row.mime_type,
    fileSizeBytes: row.file_size_bytes,
    width: row.width ?? null,
    height: row.height ?? null,
    durationMs: row.duration_ms ?? null,
    checksumSha256: row.checksum_sha256 ?? "",
    createdAt: row.created_at,
  };
}

// A pure, order-preserving projection of a completed job's own file descriptors onto asset_files
// rows -- no transformation, no re-derivation. Called exactly once, from
// createAssetFromCompletedJob in assets.ts, after that function's own assets insert has already
// succeeded; no other code path in this milestone writes to this table.
export async function insertAssetFilesForAsset(client: AssetFileClient, assetId: string, files: AssetFileDescriptor[]): Promise<AssetFilesInsertResult> {
  const rows: Partial<AssetFileRow>[] = files.map((file) => ({
    asset_id: assetId,
    position: file.position,
    storage_bucket: file.storageBucket,
    storage_path: file.storagePath,
    public_url: file.publicUrl,
    mime_type: file.mimeType,
    file_size_bytes: file.fileSizeBytes,
    width: file.width,
    height: file.height,
    duration_ms: file.durationMs,
    checksum_sha256: null,
  }));

  const result = await client.from("asset_files").insert(rows).select("*");
  if (result.error) {
    return { ok: false, ...dbErrorResult(result.error) };
  }

  try {
    return { ok: true, files: (result.data ?? []).map(fromAssetFileRow) };
  } catch (err) {
    return { ok: false, reason: "failed", message: err instanceof Error ? err.message : String(err) };
  }
}

// Read-only, position-ordered. Used by createAssetFromCompletedJob's "existing" outcome (a
// concurrent materialization race) so the caller gets the real, already-written files back
// instead of an empty placeholder list.
export async function listAssetFilesForAsset(client: AssetFileClient, assetId: string): Promise<AssetFilesListResult> {
  const result = await client.from("asset_files").select<AssetFileRow>("*").eq("asset_id", assetId).order("position", { ascending: true });
  if (result.error) {
    return { ok: false, ...dbErrorResult(result.error) };
  }

  try {
    return { ok: true, files: (result.data ?? []).map(fromAssetFileRow) };
  } catch (err) {
    return { ok: false, reason: "failed", message: err instanceof Error ? err.message : String(err) };
  }
}

export async function listOrderedAssetFilesForAsset(client: AssetFileClient, assetId: string): Promise<AssetFilesListResult> {
  return listAssetFilesForAsset(client, assetId);
}
