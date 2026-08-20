"use client";

import { Copy, ImagePlus, Upload } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { MessageBox, SecondaryButton, Select, Tag } from "@/components/ui";
import { renderAssetGenerationBrief } from "@/lib/asset-generation-brief";
import {
  ASSET_SOURCE_KINDS,
  buildAssetGenerationSpecForJob,
  createAssetJobForReadyCreativePackage,
  findQueuedExternalAssetJob,
  listAssetJobsForCreativePackage,
  runAssetJobWithExecutors,
  type AssetJobExecutionClient,
  type AssetJobRecord,
  type AssetSourceKind,
} from "@/lib/asset-jobs";
import { buildAssetUploadCandidateFromBlob } from "@/lib/asset-upload-intake";
import { buildExternalAssetExecutor } from "@/lib/external-asset-provider";
import { getCreativePackageById, type CreativePackageClient } from "@/lib/creative-packages";
import { isProductionRouteExecutable, resolveProductionRoute, type ProductionRoute } from "@/lib/production-route";
import { CreativePackageProduction } from "@/components/creative-package-production";
import { isSupabaseConfigured, supabase } from "@/lib/supabase";

type BriefResolution = { ok: true; text: string } | { ok: false; message: string };

const SOURCE_KIND_LABELS: Record<AssetSourceKind, string> = {
  ai_generated: "AI-generated",
  photograph: "Photograph",
  human_designed: "Human-designed",
};
const SOURCE_KIND_BY_LABEL: Record<string, AssetSourceKind> = Object.fromEntries(ASSET_SOURCE_KINDS.map((kind) => [SOURCE_KIND_LABELS[kind], kind]));
const SOURCE_KIND_SELECT_OPTIONS = ["", ...ASSET_SOURCE_KINDS.map((kind) => SOURCE_KIND_LABELS[kind])];

// Read-only: buildAssetGenerationSpecForJob and renderAssetGenerationBrief never mutate or call an
// RPC -- resolving a brief, for an existing job or one just created, can never claim it or start an
// attempt. The job stays queued until a later upload step submits real image bytes.
async function resolveBrief(client: AssetJobExecutionClient, job: Pick<AssetJobRecord, "creativePackageId" | "assetKind">): Promise<BriefResolution> {
  const specResult = await buildAssetGenerationSpecForJob(client, job);
  if (!specResult.ok) {
    return { ok: false, message: specResult.message };
  }
  return { ok: true, text: renderAssetGenerationBrief(specResult.spec) };
}

function PrimaryButton({ children, disabled, onClick }: { children: ReactNode; disabled: boolean; onClick: () => void }) {
  return (
    <button
      className="inline-flex h-11 items-center gap-2 rounded-md border border-[#7aa789] bg-[#e9f3ed] px-3 text-sm font-semibold text-[#2e6b44] disabled:cursor-not-allowed disabled:opacity-50"
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  );
}

// Duplicate protection here is client-side only, and deliberately scoped, not exhaustive: the
// create button disables synchronously on click (stops a same-component double-tap before any
// network call), and findQueuedExternalAssetJob makes a later mount/reload reuse an already-queued
// job instead of offering to create another. Neither covers two tabs or two devices racing each
// other -- both can load the "no job yet" state and both click before either insert lands, since
// asset_jobs.creative_package_id has no unique constraint and never will (see the guard in
// supabase-add-asset-jobs.sql). That gap is an accepted, owner-only limitation: this app's whole
// data model already assumes one trusted operator at a time (see PROP-027-SPEC.md's browser
// authorization trust assumption), not a DB-level guarantee waiting to be added. Do not add a
// migration or RPC for this unless real usage proves concurrent creation is an actual problem.
// variant "ritual" hides provenance/job-lifecycle presentation only (Workspace, Source kind, the
// Asset Job ID, and the origin/status tags) for a caller composing this component into a screen
// that doesn't want that vocabulary on it (e.g. Today, PROP-035) -- it changes no state, no network
// call, and no validation path. Every existing caller keeps the default "full" behavior unchanged.
export function CreativePackageAssetCreate({
  creativePackageId,
  onUploaded,
  variant = "full",
}: {
  creativePackageId: string;
  onUploaded: () => void;
  variant?: "full" | "ritual";
}) {
  const [job, setJob] = useState<AssetJobRecord | null>(null);
  // Distinguishes "found already queued on load" from "just created this session" -- the only
  // difference is which message renders; both mean the same thing to every other code path below.
  const [jobOrigin, setJobOrigin] = useState<"resumed" | "created" | null>(null);
  const [brief, setBrief] = useState("");
  const [isLoadingInitial, setIsLoadingInitial] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [createError, setCreateError] = useState("");
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">("idle");

  const [workspace, setWorkspace] = useState("");
  const [sourceKindLabel, setSourceKindLabel] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const [uploadWarnings, setUploadWarnings] = useState<string[]>([]);

  // The resolved Production Route for this package, or null while it is still being read.
  //
  // This is what decides WHICH owner surface renders. capture_new (and every legacy/unroutable
  // package) resolves to external and keeps the External Creative Workspace panel below, byte for
  // byte. template_only and generate_visual resolve to a machine worker and render the Production
  // panel instead -- which is the gap Wave B's P1-6 fix deliberately left open until the app could
  // actually carry a machine job to completion. It now can, via /api/production.
  const [route, setRoute] = useState<ProductionRoute | null>(null);

  const client = supabase as unknown as AssetJobExecutionClient | null;
  const canUpload = job !== null && job.status === "queued";

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setIsLoadingInitial(true);
      setLoadError("");

      if (!isSupabaseConfigured || !client) {
        if (!cancelled) {
          setJob(null);
          setBrief("");
          setLoadError("Asset Jobs require the configured Supabase project. Local browser-only mode cannot create or read them.");
          setIsLoadingInitial(false);
        }
        return;
      }

      const packageResult = await getCreativePackageById(client as unknown as CreativePackageClient, creativePackageId);
      if (cancelled) return;
      const resolvedRoute = packageResult.ok ? resolveProductionRoute(packageResult.creativePackage) : null;
      setRoute(resolvedRoute);
      // A machine route hands off entirely to the Production panel, which does its own loading.
      if (resolvedRoute && resolvedRoute.workerType !== "external" && isProductionRouteExecutable(resolvedRoute)) {
        setIsLoadingInitial(false);
        return;
      }

      const jobsResult = await listAssetJobsForCreativePackage(client, creativePackageId);
      if (cancelled) return;
      if (!jobsResult.ok) {
        setJob(null);
        setBrief("");
        setLoadError(jobsResult.message);
        setIsLoadingInitial(false);
        return;
      }

      const existing = findQueuedExternalAssetJob(jobsResult.jobs);
      if (!existing) {
        setJob(null);
        setBrief("");
        setIsLoadingInitial(false);
        return;
      }

      const briefResult = await resolveBrief(client, existing);
      if (cancelled) return;
      setJob(existing);
      setJobOrigin("resumed");
      if (briefResult.ok) {
        setBrief(briefResult.text);
      } else {
        setBrief("");
        setLoadError(briefResult.message);
      }
      setIsLoadingInitial(false);
    }

    load();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [creativePackageId]);

  async function createJob() {
    if (!client) {
      return;
    }

    setIsCreating(true);
    setCreateError("");
    setCopyStatus("idle");
    setUploadError("");
    setUploadWarnings([]);

    // Explicitly external + image, and this function is now only ever reached for a package whose
    // resolved route IS external -- a machine route returned the Production panel above and never
    // gets here. Stating the pair explicitly keeps this call site honest about the one flow it
    // serves: a human produces the image elsewhere and uploads it.
    const created = await createAssetJobForReadyCreativePackage(client, creativePackageId, { workerType: "external", assetKind: "image" });
    if (!created.ok) {
      setCreateError(created.message);
      setIsCreating(false);
      return;
    }

    const briefResult = await resolveBrief(client, created.job);
    setJob(created.job);
    setJobOrigin("created");
    setBrief(briefResult.ok ? briefResult.text : "");
    setCreateError(briefResult.ok ? "" : briefResult.message);
    setIsCreating(false);
  }

  async function copyBrief() {
    if (!brief) {
      return;
    }
    try {
      await navigator.clipboard.writeText(brief);
      setCopyStatus("copied");
    } catch {
      setCopyStatus("failed");
    }
  }

  // Pre-claim validation happens entirely inside buildAssetUploadCandidateFromBlob, before this
  // function ever attempts to claim the job -- an invalid file is rejected here, locally, and the
  // job is never touched (validate-before-claim, PROP-027-SPEC.md section 2). A failure past that
  // point means the job was claimed and is now terminal (no requeue mechanism exists anywhere in
  // this codebase -- see spec Non-goals); selectedFile is deliberately never cleared on failure so
  // a follow-up "Create asset job" can immediately reuse the same picked file without re-picking.
  async function uploadImage() {
    if (!client || !job || !selectedFile) {
      return;
    }

    setIsUploading(true);
    setUploadError("");
    setUploadWarnings([]);

    const intake = await buildAssetUploadCandidateFromBlob(selectedFile);
    if (!intake.ok) {
      setUploadError(intake.message);
      setIsUploading(false);
      return;
    }

    const executor = buildExternalAssetExecutor(intake.candidate);
    const result = await runAssetJobWithExecutors(client, job.id, { external: executor }, {
      sourceWorkspace: workspace.trim() || undefined,
      sourceKind: SOURCE_KIND_BY_LABEL[sourceKindLabel],
    });

    if (!result.ok) {
      setUploadError(result.message);
      if (result.job) {
        setJob(result.job);
      }
      setIsUploading(false);
      return;
    }

    setJob(result.job);
    setUploadWarnings(result.warnings);
    setSelectedFile(null);
    setWorkspace("");
    setSourceKindLabel("");
    setIsUploading(false);
    onUploaded();
  }

  // A machine route renders the Production panel instead of this one. Everything below stays exactly
  // the External Creative Workspace flow that capture_new packages have always used.
  if (route && route.workerType !== "external" && isProductionRouteExecutable(route)) {
    return <CreativePackageProduction creativePackageId={creativePackageId} onProduced={onUploaded} route={route} />;
  }

  return (
    <section className="mt-3 rounded-md border border-[#ead9c8] bg-white p-3">
      {variant === "full" ? (
        <div className="flex items-center gap-2">
          <ImagePlus className="text-[#9a5b2f]" size={17} />
          <h4 className="font-semibold text-[#211713]">External Creative Workspace</h4>
        </div>
      ) : null}

      {isLoadingInitial ? <p className="mt-3 text-sm text-[#6f5a4c]">{variant === "full" ? "Checking for an existing Asset Job..." : "Checking for a brief already in progress..."}</p> : null}
      {loadError ? <MessageBox message={loadError} tone="bad" /> : null}

      {!isLoadingInitial && !canUpload ? (
        <div className="mt-3 space-y-3">
          <p className="rounded-md border border-[#ead9c8] bg-[#fffaf3] p-3 text-sm">
            {variant === "full"
              ? job
                ? "Create a new Asset Job (reusing the image you already picked, if any) to try again."
                : "Create an Asset Job to get a brief you can paste into ChatGPT, Midjourney, Canva, or any other creative workspace -- or use as a shot list for a real product photo."
              : job
                ? "Get a fresh brief (reusing the image you already picked, if any) to try again."
                : "Get today's brief to paste into ChatGPT, Midjourney, Canva, or any other creative tool -- or use as a shot list for a real product photo."}
          </p>
          <PrimaryButton disabled={isCreating || !client} onClick={createJob}>
            <ImagePlus size={15} />
            {variant === "full" ? (isCreating ? "Creating asset job..." : "Create asset job") : isCreating ? "Starting today's post..." : "Start today's post"}
          </PrimaryButton>
          {createError ? <MessageBox message={createError} tone="bad" /> : null}
        </div>
      ) : null}

      {job ? (
        <div className="mt-3 space-y-3">
          {variant === "full" ? (
            <div className="flex flex-wrap gap-2">
              <Tag tone={jobOrigin === "resumed" ? "warm" : "green"}>{jobOrigin === "resumed" ? "Resuming existing Asset Job" : "Asset Job created"}</Tag>
              <Tag tone={job.status === "completed" ? "green" : job.status === "queued" ? "warm" : "danger"}>Status: {job.status}</Tag>
            </div>
          ) : null}
          {variant === "full" ? (
            <div className="text-sm">
              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#9a5b2f]">Asset Job ID</p>
              <p className="mt-1 break-words font-semibold">{job.id}</p>
            </div>
          ) : null}

          {uploadError ? <MessageBox message={uploadError} tone="bad" /> : null}

          {brief ? (
            <>
              <div className="grid gap-2">
                <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#9a5b2f]">Brief</p>
                <pre className="max-h-[300px] overflow-auto whitespace-pre-wrap break-words rounded-md bg-[#231813] p-3 text-xs leading-5 text-[#fff8ef]">{brief}</pre>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <SecondaryButton onClick={copyBrief}>
                  <Copy className="mr-1 inline" size={14} />
                  Copy brief
                </SecondaryButton>
                {copyStatus === "copied" ? <span className="text-xs font-medium text-[#2e6b44]">Copied.</span> : null}
                {copyStatus === "failed" ? <span className="text-xs font-medium text-[#8a3827]">Couldn&apos;t copy automatically -- select the text above and copy manually.</span> : null}
              </div>
            </>
          ) : null}

          {canUpload ? (
            <div className="space-y-3 rounded-md border border-[#ead9c8] bg-[#fffaf3] p-3">
              {variant === "full" ? (
                <label className="grid gap-1 text-sm font-medium">
                  Workspace (optional)
                  <input
                    className="h-11 rounded-md border border-[#d8c7b7] bg-white px-3"
                    onChange={(event) => setWorkspace(event.target.value)}
                    placeholder="ChatGPT, Midjourney, Canva, camera..."
                    type="text"
                    value={workspace}
                  />
                </label>
              ) : null}
              {variant === "full" ? (
                <Select label="Source kind (optional)" onChange={(event) => setSourceKindLabel(event.target.value)} options={SOURCE_KIND_SELECT_OPTIONS} value={sourceKindLabel} />
              ) : null}
              <label className="grid gap-1 text-sm font-medium">
                Image file
                <input
                  accept="image/png,image/jpeg,image/webp"
                  className="h-11 w-full rounded-md border border-[#d8c7b7] bg-white px-3 py-2 text-sm"
                  onChange={(event) => setSelectedFile(event.target.files?.[0] ?? null)}
                  type="file"
                />
              </label>
              {selectedFile ? <p className="text-xs text-[#6f5a4c]">Selected: {selectedFile.name}</p> : null}
              <PrimaryButton disabled={isUploading || !selectedFile || !client} onClick={uploadImage}>
                <Upload size={15} />
                {isUploading ? "Uploading..." : "Upload image"}
              </PrimaryButton>
            </div>
          ) : null}

          {job.status === "completed" ? (
            <>
              <MessageBox message={variant === "full" ? "Upload complete. See it below in Assets." : "Upload complete."} tone="good" />
              {uploadWarnings.map((warning) => (
                <MessageBox key={warning} message={warning} tone="info" />
              ))}
            </>
          ) : null}

          {canUpload && variant === "full" ? (
            <p className="text-xs text-[#6f5a4c]">Creating this job and viewing or copying its brief never claimed it -- it only stays queued until you upload an image above, which does claim it.</p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
