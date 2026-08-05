import { fromAssetFileRow, type AssetFileRecord, type AssetFileRow } from "./asset-files.ts";
import {
  buildGeneratedAssetObjectPath,
  GENERATED_ASSETS_BUCKET,
  inspectAssetBytes,
  type InspectedAssetCandidate,
} from "./asset-binary.ts";
import type { AssetJobRecord, AssetJobResultEnvelope, AssetJobRow } from "./asset-jobs.ts";
import type { AssetRecord, AssetRow } from "./assets.ts";

type SupabaseErrorLike = {
  statusCode?: string;
  code?: string;
  message: string;
};

type StorageUploadResult = PromiseLike<{ data: { path?: string } | null; error: SupabaseErrorLike | null }>;
type StorageDownloadResult = PromiseLike<{ data: Blob | ArrayBuffer | Uint8Array | null; error: SupabaseErrorLike | null }>;
type StorageRemoveResult = PromiseLike<{ data: unknown[] | null; error: SupabaseErrorLike | null }>;
type QueryResult<T> = PromiseLike<{ data: T | null; error: SupabaseErrorLike | null }>;

export type AssetJobFileMaterializationClient = {
  storage: {
    from(bucket: typeof GENERATED_ASSETS_BUCKET): {
      upload(path: string, body: Uint8Array, options: { contentType: string; upsert: false }): StorageUploadResult;
      download(path: string): StorageDownloadResult;
      remove(paths: string[]): StorageRemoveResult;
    };
  };
  rpc(
    functionName: "complete_asset_job_with_files",
    args: {
      p_asset_job_id: string;
      p_result: AssetJobResultEnvelope;
      p_files: Array<Record<string, unknown>>;
    },
  ): {
    maybeSingle(): QueryResult<CompletedAssetJobWithFilesRow>;
  };
};

export type CompletedAssetJobWithFilesRow = {
  job: AssetJobRow;
  asset: AssetRow;
  files: AssetFileRow[];
};

export type MaterializedAssetJobFiles = {
  job: AssetJobRecord;
  asset: AssetRecord;
  files: AssetFileRecord[];
};

export type CleanupResult = { ok: true; removedPaths: string[] } | { ok: false; removedPaths: string[]; failedPaths: string[]; message: string };

export type AssetJobFileMaterializationResult =
  | { ok: true; outcome: "created" | "existing"; materialized: MaterializedAssetJobFiles; uploadedThisRun: string[]; reusedExistingPaths: string[] }
  | {
      ok: false;
      reason: "storage-upload-failed" | "existing-object-verification-failed" | "db-materialization-failed" | "cleanup-failed" | "idempotency-conflict";
      message: string;
      uploadedThisRun: string[];
      reusedExistingPaths: string[];
      cleanup?: CleanupResult;
    };

function isAlreadyExistsStorageError(error: SupabaseErrorLike): boolean {
  return error.statusCode === "409" || error.code === "409" || /already exists|duplicate/i.test(error.message);
}

function isMissingTableError(error: SupabaseErrorLike): boolean {
  return error.code === "PGRST205" || error.code === "42P01";
}

function fromAssetRow(row: AssetRow): AssetRecord {
  if (!row.id || !row.created_at || !row.updated_at) {
    throw new Error("Asset row is missing id, created_at, or updated_at.");
  }
  return {
    id: row.id,
    assetJobId: row.asset_job_id,
    status: row.status,
    assetKind: typeof row.asset_kind === "string" && row.asset_kind.trim().length > 0 ? row.asset_kind : "image",
    schemaVersion: row.schema_version === "v1" ? "v1" : "v1",
    content: row.content && typeof row.content === "object" && !Array.isArray(row.content) ? row.content : {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function fromAssetJobRow(row: AssetJobRow): AssetJobRecord {
  if (!row.id || !row.created_at || !row.updated_at) {
    throw new Error("Asset Job row is missing id, created_at, or updated_at.");
  }
  return {
    id: row.id,
    creativePackageId: row.creative_package_id,
    status: row.status,
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

async function bytesFromDownloadedObject(value: Blob | ArrayBuffer | Uint8Array): Promise<Uint8Array> {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  return new Uint8Array(await value.arrayBuffer());
}

function inspectedMatches(left: InspectedAssetCandidate, right: Omit<InspectedAssetCandidate, "candidate">): boolean {
  return (
    left.sha256 === right.sha256 &&
    left.byteSize === right.byteSize &&
    left.actualMimeType === right.actualMimeType &&
    left.actualWidth === right.actualWidth &&
    left.actualHeight === right.actualHeight
  );
}

async function verifyExistingObject(client: AssetJobFileMaterializationClient, path: string, inspected: InspectedAssetCandidate): Promise<{ ok: true } | { ok: false; message: string }> {
  const downloaded = await client.storage.from(GENERATED_ASSETS_BUCKET).download(path);
  if (downloaded.error || !downloaded.data) {
    return { ok: false, message: downloaded.error?.message ?? "Existing generated asset object could not be downloaded for verification." };
  }

  const existingBytes = await bytesFromDownloadedObject(downloaded.data);
  const existingInspection = await inspectAssetBytes(existingBytes);
  if (!existingInspection.ok) {
    return { ok: false, message: existingInspection.message };
  }
  if (!inspectedMatches(inspected, existingInspection.facts)) {
    return { ok: false, message: "Existing generated asset object bytes do not match the current validated candidate." };
  }

  return { ok: true };
}

async function cleanupUploadedObjects(client: AssetJobFileMaterializationClient, paths: string[]): Promise<CleanupResult> {
  const removedPaths: string[] = [];
  const failedPaths: string[] = [];

  for (const path of paths) {
    const result = await client.storage.from(GENERATED_ASSETS_BUCKET).remove([path]);
    if (result.error) {
      failedPaths.push(path);
    } else {
      removedPaths.push(path);
    }
  }

  return failedPaths.length === 0
    ? { ok: true, removedPaths }
    : { ok: false, removedPaths, failedPaths, message: `Failed to clean up ${failedPaths.length} generated asset object(s).` };
}

function buildResultEnvelope(job: AssetJobRecord, files: InspectedAssetCandidate[]): AssetJobResultEnvelope {
  return {
    schemaVersion: "v1",
    worker: "mock",
    assetKind: "image",
    output: {
      files: files.map((file) => ({
        position: file.candidate.position,
        mimeType: file.actualMimeType,
        width: file.actualWidth,
        height: file.actualHeight,
        durationMs: null,
        fileSizeBytes: file.byteSize,
        storageBucket: GENERATED_ASSETS_BUCKET,
        storagePath: buildGeneratedAssetObjectPath({ assetJobId: job.id, attemptNumber: job.attemptCount, sha256: file.sha256, extension: file.extension }),
        publicUrl: "",
      })),
    },
    metadata: {
      generatedFromCreativePackage: job.creativePackageId,
      generatorVersion: "1",
    },
  };
}

function verifyRpcRows(materialized: MaterializedAssetJobFiles, inspected: InspectedAssetCandidate[]): { ok: true } | { ok: false; message: string } {
  if (materialized.asset.assetJobId === "" || materialized.asset.assetJobId !== materialized.job.id) {
    return { ok: false, message: "Materialized Asset does not belong to the completed Asset Job." };
  }
  if (materialized.files.length !== inspected.length) {
    return { ok: false, message: "Materialized Asset Files count does not match the validated candidates." };
  }

  for (const image of inspected) {
    const expectedPath = buildGeneratedAssetObjectPath({ assetJobId: materialized.job.id, attemptNumber: materialized.job.attemptCount, sha256: image.sha256, extension: image.extension });
    const file = materialized.files.find((row) => row.position === image.candidate.position);
    if (!file || file.storageBucket !== GENERATED_ASSETS_BUCKET || file.storagePath !== expectedPath || file.checksumSha256 !== image.sha256 || file.fileSizeBytes !== image.byteSize || file.mimeType !== image.actualMimeType || file.width !== image.actualWidth || file.height !== image.actualHeight) {
      return { ok: false, message: "Materialized Asset File does not match the validated uploaded bytes." };
    }
  }

  return { ok: true };
}

export async function materializeAssetJobFiles(
  client: AssetJobFileMaterializationClient,
  args: { job: AssetJobRecord; inspected: InspectedAssetCandidate[] },
): Promise<AssetJobFileMaterializationResult> {
  const uploadedThisRun: string[] = [];
  const reusedExistingPaths: string[] = [];
  const resultEnvelope = buildResultEnvelope(args.job, args.inspected);

  for (const image of args.inspected) {
    const path = buildGeneratedAssetObjectPath({ assetJobId: args.job.id, attemptNumber: args.job.attemptCount, sha256: image.sha256, extension: image.extension });
    const upload = await client.storage.from(GENERATED_ASSETS_BUCKET).upload(path, image.bytes, { contentType: image.actualMimeType, upsert: false });
    if (upload.error && isAlreadyExistsStorageError(upload.error)) {
      const verification = await verifyExistingObject(client, path, image);
      if (!verification.ok) {
        return { ok: false, reason: "existing-object-verification-failed", message: verification.message, uploadedThisRun, reusedExistingPaths };
      }
      reusedExistingPaths.push(path);
      continue;
    }
    if (upload.error) {
      const cleanup = uploadedThisRun.length > 0 ? await cleanupUploadedObjects(client, uploadedThisRun) : undefined;
      return {
        ok: false,
        reason: cleanup && !cleanup.ok ? "cleanup-failed" : "storage-upload-failed",
        message: upload.error.message,
        uploadedThisRun,
        reusedExistingPaths,
        cleanup,
      };
    }
    uploadedThisRun.push(path);
  }

  const rpcResult = await client
    .rpc("complete_asset_job_with_files", {
      p_asset_job_id: args.job.id,
      p_result: resultEnvelope,
      p_files: resultEnvelope.output.files.map((file, index) => ({
        position: file.position,
        storage_bucket: file.storageBucket,
        storage_path: file.storagePath,
        public_url: file.publicUrl,
        mime_type: file.mimeType,
        file_size_bytes: file.fileSizeBytes,
        width: file.width,
        height: file.height,
        duration_ms: file.durationMs,
        checksum_sha256: args.inspected[index]?.sha256 ?? null,
      })),
    })
    .maybeSingle();

  if (rpcResult.error || !rpcResult.data) {
    const cleanup = await cleanupUploadedObjects(client, uploadedThisRun);
    const missingTableMessage = rpcResult.error && isMissingTableError(rpcResult.error) ? "Asset Job file materialization RPC is not available yet. Verify supabase-add-asset-job-file-materialization.sql has been applied." : null;
    return {
      ok: false,
      reason: cleanup.ok ? "db-materialization-failed" : "cleanup-failed",
      message: missingTableMessage ?? rpcResult.error?.message ?? "Asset Job file materialization RPC returned no row.",
      uploadedThisRun,
      reusedExistingPaths,
      cleanup,
    };
  }

  try {
    const materialized = {
      job: fromAssetJobRow(rpcResult.data.job),
      asset: fromAssetRow(rpcResult.data.asset),
      files: rpcResult.data.files.map(fromAssetFileRow),
    };
    const verification = verifyRpcRows(materialized, args.inspected);
    if (!verification.ok) {
      const cleanup = await cleanupUploadedObjects(client, uploadedThisRun);
      return { ok: false, reason: cleanup.ok ? "idempotency-conflict" : "cleanup-failed", message: verification.message, uploadedThisRun, reusedExistingPaths, cleanup };
    }
    return { ok: true, outcome: reusedExistingPaths.length > 0 ? "existing" : "created", materialized, uploadedThisRun, reusedExistingPaths };
  } catch (err) {
    const cleanup = await cleanupUploadedObjects(client, uploadedThisRun);
    return {
      ok: false,
      reason: cleanup.ok ? "db-materialization-failed" : "cleanup-failed",
      message: err instanceof Error ? err.message : String(err),
      uploadedThisRun,
      reusedExistingPaths,
      cleanup,
    };
  }
}
