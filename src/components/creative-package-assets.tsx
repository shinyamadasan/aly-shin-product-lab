"use client";

import { ImageIcon, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { MessageBox, Tag } from "@/components/ui";
import type { AssetFileRecord } from "@/lib/asset-files";
import { createSignedUrlForAssetFile, type AssetFileUrlClient } from "@/lib/asset-file-urls";
import { listAssetJobsForCreativePackageReadOnly, listOrderedAssetFilesForAssetReadOnly, readAssetForAssetJobReadOnly, type AssetReadClient } from "@/lib/asset-read-model";
import { createAssetUiRequestCoordinator, shouldStartAutomaticImageRetry } from "@/lib/asset-ui-request-coordinator";
import type { AssetJobRecord } from "@/lib/asset-jobs";
import type { AssetRecord } from "@/lib/assets";
import { isSupabaseConfigured, supabase } from "@/lib/supabase";

type CreativePackageAssetsClient = AssetReadClient & AssetFileUrlClient;

type JobAssetState = {
  asset: AssetRecord | null;
  files: AssetFileRecord[];
  error: string;
};

type SignedFileState = {
  url: string;
  error: string;
  isLoading: boolean;
  autoRetried: boolean;
  imageFailed: boolean;
};

function formatDateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value || "Unknown" : date.toLocaleString();
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "Unknown";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function statusTone(status: AssetJobRecord["status"]): "warm" | "green" | "danger" {
  if (status === "completed") return "green";
  if (status === "failed") return "danger";
  return "warm";
}

function assetJobStatusLabel(status: AssetJobRecord["status"]): string {
  return status.slice(0, 1).toUpperCase() + status.slice(1);
}

function metadataBlock(label: string, value: string) {
  return (
    <div className="text-sm">
      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#9a5b2f]">{label}</p>
      <p className="mt-1 break-words font-semibold">{value || "Not recorded"}</p>
    </div>
  );
}

function SmallButton({ children, disabled = false, onClick }: { children: ReactNode; disabled?: boolean; onClick: () => void }) {
  return (
    <button
      className="inline-flex h-8 items-center gap-2 rounded-md border border-[#d8c7b7] bg-white px-2.5 text-xs font-semibold text-[#5f4a3d] disabled:cursor-not-allowed disabled:opacity-50"
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  );
}

function signedStateKey(file: AssetFileRecord): string {
  return file.id;
}

export function CreativePackageAssets({ creativePackageId }: { creativePackageId: string }) {
  const [jobs, setJobs] = useState<AssetJobRecord[]>([]);
  const [jobAssets, setJobAssets] = useState<Record<string, JobAssetState>>({});
  const [signedFiles, setSignedFiles] = useState<Record<string, SignedFileState>>({});
  const [isLoadingMetadata, setIsLoadingMetadata] = useState(false);
  const [metadataError, setMetadataError] = useState("");

  const client = supabase as unknown as CreativePackageAssetsClient | null;
  const requestCoordinator = useRef(createAssetUiRequestCoordinator());
  const signedFilesRef = useRef<Record<string, SignedFileState>>({});
  const allFiles = useMemo(() => Object.values(jobAssets).flatMap((entry) => entry.files), [jobAssets]);

  function updateSignedFiles(updater: (current: Record<string, SignedFileState>) => Record<string, SignedFileState>) {
    setSignedFiles((current) => {
      const next = updater(current);
      signedFilesRef.current = next;
      return next;
    });
  }

  async function refreshSignedUrls(files: AssetFileRecord[] = allFiles, options: { resetAutoRetry?: boolean } = {}) {
    if (!client || files.length === 0) {
      return;
    }

    for (const file of files) {
      const key = signedStateKey(file);
      const requestVersion = requestCoordinator.current.beginSignedUrl(key);
      updateSignedFiles((current) => ({
        ...current,
        [key]: {
          url: current[key]?.url ?? "",
          error: "",
          isLoading: true,
          autoRetried: options.resetAutoRetry ? false : (current[key]?.autoRetried ?? false),
          imageFailed: false,
        },
      }));

      const result = await createSignedUrlForAssetFile(client, file);
      if (!requestCoordinator.current.isCurrentSignedUrl(key, requestVersion)) {
        continue;
      }
      updateSignedFiles((current) => ({
        ...current,
        [key]: {
          url: result.ok ? result.signedUrl : "",
          error: result.ok ? "" : result.message,
          isLoading: false,
          autoRetried: options.resetAutoRetry ? false : (current[key]?.autoRetried ?? false),
          imageFailed: false,
        },
      }));
    }
  }

  async function refreshMetadata() {
    const requestVersion = requestCoordinator.current.beginMetadata();
    setMetadataError("");
    setIsLoadingMetadata(true);
    updateSignedFiles(() => ({}));

    if (!isSupabaseConfigured || !client) {
      if (!requestCoordinator.current.isCurrentMetadata(requestVersion)) return;
      setJobs([]);
      setJobAssets({});
      setMetadataError("Assets require the configured Supabase project. Local browser-only mode cannot read generated Asset records.");
      setIsLoadingMetadata(false);
      return;
    }

    const jobResult = await listAssetJobsForCreativePackageReadOnly(client, creativePackageId);
    if (!requestCoordinator.current.isCurrentMetadata(requestVersion)) return;
    if (!jobResult.ok) {
      setJobs([]);
      setJobAssets({});
      setMetadataError(jobResult.message);
      setIsLoadingMetadata(false);
      return;
    }

    setJobs(jobResult.jobs);
    const nextAssets: Record<string, JobAssetState> = {};
    const filesToSign: AssetFileRecord[] = [];

    for (const job of jobResult.jobs) {
      const assetResult = await readAssetForAssetJobReadOnly(client, job.id);
      if (!requestCoordinator.current.isCurrentMetadata(requestVersion)) return;
      if (!assetResult.ok) {
        nextAssets[job.id] = { asset: null, files: [], error: assetResult.reason === "not-found" ? "" : assetResult.message };
        continue;
      }

      const filesResult = await listOrderedAssetFilesForAssetReadOnly(client, assetResult.asset.id);
      if (!requestCoordinator.current.isCurrentMetadata(requestVersion)) return;
      if (!filesResult.ok) {
        nextAssets[job.id] = { asset: assetResult.asset, files: [], error: filesResult.message };
        continue;
      }

      nextAssets[job.id] = { asset: assetResult.asset, files: filesResult.files, error: "" };
      filesToSign.push(...filesResult.files);
    }

    setJobAssets(nextAssets);
    setIsLoadingMetadata(false);
    await refreshSignedUrls(filesToSign, { resetAutoRetry: true });
  }

  async function retryAfterImageFailure(file: AssetFileRecord) {
    const key = signedStateKey(file);
    const current = signedFilesRef.current[key];
    if (!shouldStartAutomaticImageRetry(current)) {
      updateSignedFiles((state) => ({
        ...state,
        [key]: { ...(state[key] ?? { url: "", error: "", isLoading: false, autoRetried: true }), imageFailed: true, autoRetried: true },
      }));
      return;
    }

    const requestVersion = requestCoordinator.current.beginSignedUrl(key);
    updateSignedFiles((state) => ({
      ...state,
      [key]: { ...(state[key] ?? { url: "", error: "", isLoading: false, imageFailed: false }), autoRetried: true, isLoading: true, error: "" },
    }));

    if (!client) return;
    const result = await createSignedUrlForAssetFile(client, file);
    if (!requestCoordinator.current.isCurrentSignedUrl(key, requestVersion)) {
      return;
    }
    updateSignedFiles((state) => ({
      ...state,
      [key]: {
        url: result.ok ? result.signedUrl : "",
        error: result.ok ? "" : result.message,
        isLoading: false,
        autoRetried: true,
        imageFailed: !result.ok,
      },
    }));
  }

  useEffect(() => {
    requestCoordinator.current = createAssetUiRequestCoordinator();
    const timer = window.setTimeout(() => {
      void refreshMetadata();
    }, 0);
    return () => {
      window.clearTimeout(timer);
      requestCoordinator.current.unmount();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [creativePackageId]);

  return (
    <section className="mt-3 rounded-md border border-[#ead9c8] bg-white p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <ImageIcon className="text-[#9a5b2f]" size={17} />
          <h4 className="font-semibold text-[#211713]">Assets</h4>
        </div>
        <div className="flex flex-wrap gap-2">
          <SmallButton disabled={isLoadingMetadata} onClick={refreshMetadata}>
            <RefreshCw size={13} />
            {isLoadingMetadata ? "Refreshing..." : "Refresh Asset Jobs"}
          </SmallButton>
          <SmallButton disabled={isLoadingMetadata || allFiles.length === 0} onClick={() => refreshSignedUrls(allFiles, { resetAutoRetry: true })}>
            <RefreshCw size={13} />
            Refresh signed URLs
          </SmallButton>
        </div>
      </div>

      {metadataError ? <div className="mt-3"><MessageBox message={metadataError} tone="bad" /></div> : null}
      {isLoadingMetadata ? <p className="mt-3 text-sm text-[#6f5a4c]">Loading Asset Jobs...</p> : null}
      {!isLoadingMetadata && !metadataError && jobs.length === 0 ? <p className="mt-3 rounded-md border border-[#ead9c8] bg-[#fffaf3] p-3 text-sm">No Asset Jobs have been created for this Creative Package yet.</p> : null}

      <div className="mt-3 space-y-3">
        {jobs.map((job, index) => {
          const assetState = jobAssets[job.id] ?? { asset: null, files: [], error: "" };
          return (
            <details className="rounded-md border border-[#ead9c8] bg-[#fffaf3] p-3" key={job.id} open={index === 0}>
              <summary className="cursor-pointer text-sm font-semibold text-[#5f4a3d]">
                Asset Job {index + 1} · {assetJobStatusLabel(job.status)}
              </summary>
              <div className="mt-3 space-y-3">
                <div className="flex flex-wrap gap-2">
                  <Tag tone={statusTone(job.status)}>Job status: {assetJobStatusLabel(job.status)}</Tag>
                  {job.workerType === "mock" ? <Tag tone="warm">Fixture/mock output</Tag> : null}
                  {assetState.asset ? <Tag tone="green">Asset status: {assetState.asset.status}</Tag> : null}
                </div>

                <div className="grid gap-3">
                  {metadataBlock("Queued", formatDateTime(job.createdAt))}
                  {job.completedAt ? metadataBlock("Completed", formatDateTime(job.completedAt)) : null}
                  {job.failedAt ? metadataBlock("Failed", formatDateTime(job.failedAt)) : null}
                  {job.lastError ? metadataBlock("Last error", job.lastError) : null}
                </div>

                {assetState.error ? <MessageBox message={assetState.error} tone="bad" /> : null}
                {!assetState.asset ? <p className="rounded-md border border-[#ead9c8] bg-white p-3 text-sm">No Asset has been materialized yet.</p> : null}
                {assetState.asset && assetState.files.length === 0 ? <p className="rounded-md border border-[#ead9c8] bg-white p-3 text-sm">This Asset has no Asset Files yet.</p> : null}

                {assetState.files.map((file) => {
                  const signed = signedFiles[signedStateKey(file)];
                  return (
                    <article className="rounded-md border border-[#ead9c8] bg-white p-3" key={file.id}>
                      <div className="grid gap-3">
                        {signed?.url && !signed.imageFailed ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img alt={`Generated Asset file ${file.position + 1}`} className="max-h-72 w-full rounded-md border border-[#ead9c8] object-contain" onError={() => void retryAfterImageFailure(file)} src={signed.url} />
                        ) : (
                          <div className="grid min-h-32 place-items-center rounded-md border border-[#ead9c8] bg-[#fffaf3] p-3 text-sm text-[#6f5a4c]">
                            {signed?.isLoading ? "Loading signed image URL..." : "Image preview is not available."}
                          </div>
                        )}

                        {(signed?.error || signed?.imageFailed) ? (
                          <MessageBox message={signed.error || "Image could not be loaded after one automatic signed URL refresh."} tone="bad" />
                        ) : null}

                        <div className="grid gap-3">
                          {metadataBlock("MIME", file.mimeType)}
                          {metadataBlock("Dimensions", file.width && file.height ? `${file.width} x ${file.height}` : "Not recorded")}
                          {metadataBlock("File size", formatBytes(file.fileSizeBytes))}
                          {metadataBlock("File created", formatDateTime(file.createdAt))}
                        </div>

                        <SmallButton disabled={signed?.isLoading} onClick={() => refreshSignedUrls([file], { resetAutoRetry: true })}>
                          <RefreshCw size={13} />
                          Refresh signed URL
                        </SmallButton>

                        <details className="rounded-md border border-[#ead9c8] bg-[#fffaf3] p-3">
                          <summary className="cursor-pointer text-sm font-semibold text-[#5f4a3d]">Technical details</summary>
                          <div className="mt-3 grid gap-3">
                            {metadataBlock("Worker type", job.workerType)}
                            {metadataBlock("Attempt count", String(job.attemptCount))}
                            {metadataBlock("Schema version", assetState.asset?.schemaVersion ?? "Not recorded")}
                            {metadataBlock("Bucket", file.storageBucket)}
                            {metadataBlock("Storage path", file.storagePath)}
                            {metadataBlock("Checksum", file.checksumSha256)}
                          </div>
                        </details>
                      </div>
                    </article>
                  );
                })}
              </div>
            </details>
          );
        })}
      </div>
    </section>
  );
}
