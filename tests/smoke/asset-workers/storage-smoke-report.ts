export type AssetStorageSmokeSummary = {
  assetJobId: string;
  attemptId: string | null;
  assetId: string | null;
  assetFileId: string | null;
  storageBucket: string | null;
  storagePath: string | null;
  objectDisposition: "uploaded-this-run" | "reused-existing" | "unknown";
  rowDisposition: "created" | "reused" | "unknown";
};

export type AssetStorageSmokeReport = {
  summary: AssetStorageSmokeSummary;
  cleanup: {
    manualOnly: true;
    deleteAssetFileId: string | null;
    deleteAssetId: string | null;
    resetOrDeleteDedicatedAssetJobId: string;
    removeStorageObject: { bucket: string; path: string } | null;
    verification: string[];
    notes: string[];
  };
};

export type AssetStorageSmokeObjectPreflightClient = {
  storage: {
    from(bucket: string): {
      download(path: string): PromiseLike<{ data: unknown; error: { message: string; statusCode?: string | number } | null }>;
    };
  };
};

export type AssetStorageSmokeObjectPreflightResult =
  | { ok: true; disposition: "absent" }
  | { ok: false; reason: "object-exists" | "object-operation-unavailable"; message: string };

export async function confirmSmokeObjectPathAbsent(
  client: AssetStorageSmokeObjectPreflightClient,
  bucket: string,
  storagePath: string,
): Promise<AssetStorageSmokeObjectPreflightResult> {
  const result = await client.storage.from(bucket).download(storagePath);
  if (!result.error) {
    return { ok: false, reason: "object-exists", message: `Smoke Storage path already exists: ${bucket}/${storagePath}` };
  }

  if (String(result.error.statusCode) === "404") {
    return { ok: true, disposition: "absent" };
  }

  return {
    ok: false,
    reason: "object-operation-unavailable",
    message: `Authenticated Storage object preflight failed for ${bucket}/${storagePath}: ${result.error.message}`,
  };
}

export function buildAssetStorageSmokeReport(summary: AssetStorageSmokeSummary): AssetStorageSmokeReport {
  const canRemoveObject = summary.objectDisposition === "uploaded-this-run" && summary.storageBucket !== null && summary.storagePath !== null;
  const removeStorageObject = canRemoveObject && summary.storageBucket !== null && summary.storagePath !== null
    ? { bucket: summary.storageBucket, path: summary.storagePath }
    : null;
  return {
    summary,
    cleanup: {
      manualOnly: true,
      deleteAssetFileId: summary.assetFileId,
      deleteAssetId: summary.assetId,
      resetOrDeleteDedicatedAssetJobId: summary.assetJobId,
      removeStorageObject,
      verification: [
        "Verify no asset_files row remains for the reported Asset File ID.",
        "Verify no assets row remains for the reported Asset ID.",
        "Verify only the dedicated smoke Asset Job/attempt records were reset or deleted, if they were created specifically for smoke testing.",
        "Verify the exact reported generated-assets object path no longer exists when it was uploaded by this smoke run.",
      ],
      notes: [
        "Cleanup is manual and must be scoped only to the exact IDs and path in this report.",
        "Delete the Asset File row first if the live schema/RPC contract allows direct cleanup, then delete the Asset row.",
        "Delete or reset the dedicated Asset Job and attempt test records only if they were created specifically for smoke testing.",
        "Never remove a reused pre-existing Storage object automatically.",
      ],
    },
  };
}

export function stringifyAssetStorageSmokeReport(report: AssetStorageSmokeReport): string {
  return JSON.stringify(report, null, 2);
}
