"use client";

import { Check, Copy, ImagePlus, RefreshCw, Type, Upload, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { MessageBox, SecondaryButton, Select, Tag } from "@/components/ui";
import {
  ASSET_SOURCE_KINDS,
  createAssetJobForReadyCreativePackage,
  type AssetJobClient,
  type AssetJobRecord,
  type AppCreatableAssetJobWorkerType,
  type AssetSourceKind,
} from "@/lib/asset-jobs";
import {
  listAssetJobsForCreativePackageReadOnly,
  listOrderedAssetFilesForAssetReadOnly,
  readAssetForAssetJobReadOnly,
  type AssetReadClient,
} from "@/lib/asset-read-model";
import { setAssetOwnerDecision, type AssetClient, type AssetRecord } from "@/lib/assets";
import type { AssetFileRecord } from "@/lib/asset-files";
import { createSignedUrlForAssetFile, type AssetFileUrlClient } from "@/lib/asset-file-urls";
// Client-safe by construction: production-route is pure and pulls in no renderer, and the prompt
// package + production spec modules are pure for exactly the same reason. Importing the execution
// module here would drag satori/resvg/sharp into the browser bundle.
import { isMachineProductionWorkerType, type ProductionRoute } from "@/lib/production-route";
import { buildProductionSpec } from "@/lib/production-spec";
import { renderProductionPromptPackageIfImage } from "@/lib/production-prompt-package";
import { buildGenerativeImagePrompt } from "@/lib/production-image-prompt";
import { BRAND_BIBLE } from "@/lib/marketing-advisor-context";
import { getCreativePackageById, type CreativePackageClient } from "@/lib/creative-packages";
import { isSupabaseConfigured, supabase } from "@/lib/supabase";

// Production MVP Wave B -- the owner's machine-production surface.
//
// Rendered instead of the External Creative Workspace panel when the Production Route resolves to a
// machine worker (photo:template_only -> static_renderer, photo:generate_visual -> generative_image).
// capture_new still resolves to external and still gets the upload panel, unchanged.
//
// WHAT THIS COMPONENT MAY AND MAY NOT DO.
//
// It may create Asset Jobs and read Assets straight from Supabase under the owner's own RLS, exactly
// like every other page in this app. It may NOT execute one: generative_image needs the Cloudflare
// credential (server-only) and both composition paths need native modules (satori/resvg/sharp) that
// cannot run in a browser. So execution goes through POST /api/production or
// POST /api/production/manual, carrying the owner's own access token. There is no second pipeline
// here -- both routes call the same shared execution boundary the CLI uses.
//
// THE THREE PATHS, AND WHY NONE OF THEM IS AUTOMATIC.
//
//   T1  Cloudflare        automated illustration, composed by this app
//   T2  ChatGPT Images    the owner generates the illustration, this app composes it identically
//   T3  static_renderer   deterministic text/editorial post, no illustration at all
//
// T3 is a real CREATIVE DOWNGRADE -- a different-looking post, not a retry -- so the system never
// selects it on the owner's behalf. When Cloudflare is unavailable the owner is told so plainly and
// offered T2 and T3 as explicit choices. Silently substituting T3 would hand them a post they never
// asked for, which they might publish without noticing the illustration was gone.
//
// Deliberately NOT built: no canvas, no drag handles, no layers, no prompt playground, no provider
// picker, and no batch/week workflow.

type ProductionPhase = "loading" | "idle" | "producing" | "done";

type ProductionResponse = {
  status?: string;
  message?: string;
  assetId?: string;
  reason?: string;
};

const SOURCE_KIND_LABELS: Record<AssetSourceKind, string> = {
  ai_generated: "AI-generated",
  photograph: "Photograph",
  human_designed: "Human-designed",
};
const SOURCE_KIND_BY_LABEL: Record<string, AssetSourceKind> = Object.fromEntries(ASSET_SOURCE_KINDS.map((kind) => [SOURCE_KIND_LABELS[kind], kind]));
const SOURCE_KIND_SELECT_OPTIONS = ASSET_SOURCE_KINDS.map((kind) => SOURCE_KIND_LABELS[kind]);

function describeRoute(route: ProductionRoute): string {
  return route.workerType === "static_renderer"
    ? "Deterministic template render -- no AI image generation."
    : "AI-generated illustration composed under the deterministic template.";
}

function describeSourceKind(asset: AssetRecord | null): { label: string; tone: "green" | "warm" | "danger" } | null {
  const content = asset?.content as { metadata?: { sourceKind?: string } } | undefined;
  const sourceKind = content?.metadata?.sourceKind;
  if (sourceKind === "ai_generated") {
    return { label: "AI-generated", tone: "warm" };
  }
  if (sourceKind === "human_designed") {
    return { label: "Deterministic render", tone: "green" };
  }
  if (sourceKind === "photograph") {
    return { label: "Photograph", tone: "green" };
  }
  return null;
}

export function CreativePackageProduction({
  creativePackageId,
  route,
  onProduced,
}: {
  creativePackageId: string;
  route: ProductionRoute;
  onProduced: () => void;
}) {
  const [phase, setPhase] = useState<ProductionPhase>("loading");
  const [job, setJob] = useState<AssetJobRecord | null>(null);
  const [asset, setAsset] = useState<AssetRecord | null>(null);
  const [files, setFiles] = useState<AssetFileRecord[]>([]);
  const [error, setError] = useState("");
  // Set only for the bookkeeping-failure case, where the asset IS correct and re-running would
  // duplicate it. Kept separate from `error` so the UI can refuse to offer a retry.
  const [doNotRetryNotice, setDoNotRetryNotice] = useState("");
  const [decisionBusy, setDecisionBusy] = useState(false);
  // The generated-assets bucket is PRIVATE and asset_files.public_url is always "" by design, so a
  // preview needs a short-lived signed URL -- the same mechanism creative-package-assets.tsx uses.
  const [previewUrl, setPreviewUrl] = useState("");

  // Wave B manual fallback state.
  //
  // `unavailable` is set ONLY from a structural upstream reason (quota / auth / unavailable) that the
  // server classified from the HTTP status Cloudflare actually returned -- never by reading the error
  // text. While it is set, this component does not offer another automatic attempt: that is what
  // "do not keep firing Cloudflare after a known quota failure" means at the UI layer.
  const [unavailable, setUnavailable] = useState("");
  const [manualOpen, setManualOpen] = useState(false);
  // TWO values, and the distinction is the whole point of keeping them apart.
  //
  //   promptPackage -- OWNER DOCUMENTATION. The full rendered package, shown on screen. It carries
  //                    sections that exist for a human and must never reach an image model: the
  //                    social caption, the overlay text, and a COMPOSITION list that passes the
  //                    brief's raw executionNotes through verbatim (typeface and lettering notes
  //                    included).
  //   imagePrompt   -- IMAGE-MODEL INPUT. Exactly buildGenerativeImagePrompt(spec), the same bytes
  //                    the Cloudflare executor POSTs.
  //
  // Copying the document would have undone the text-ownership hardening completely: the FINAL
  // TEXT-OWNERSHIP OVERRIDE is the last line of the PROMPT, but it is nowhere near the last line of
  // the DOCUMENT -- "Hand-lettered or soft rounded typeface for the bubbles" appears after it under
  // COMPOSITION, and would have been the model's closing instruction.
  const [promptPackage, setPromptPackage] = useState("");
  const [imagePrompt, setImagePrompt] = useState("");
  const [promptPackageError, setPromptPackageError] = useState("");
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">("idle");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  // Defaults to AI-generated because that is what a ChatGPT Images illustration truthfully is. It
  // stays an owner-editable declaration rather than a value this app asserts -- only the owner knows
  // which tool actually made the file they are about to upload.
  const [sourceKindLabel, setSourceKindLabel] = useState(SOURCE_KIND_LABELS.ai_generated);

  const client = supabase as unknown as (AssetReadClient & AssetJobClient & AssetClient & AssetFileUrlClient) | null;

  // The manual path exists only where there is an illustration to outsource. A template_only package
  // routes to static_renderer and has no illustration at all, so it keeps the single Produce button.
  const supportsManual = route.workerType === "generative_image";

  const loadLatest = useCallback(async () => {
    if (!client) {
      return;
    }
    const jobs = await listAssetJobsForCreativePackageReadOnly(client, creativePackageId);
    if (!jobs.ok) {
      setError(jobs.message);
      setPhase("idle");
      return;
    }

    // Newest first: listAssetJobsForCreativePackage orders by created_at desc, so the head is the
    // most recent production attempt for this package. Earlier ones are deliberately left alone --
    // regenerating never deletes or overwrites what came before.
    const latest = jobs.jobs[0] ?? null;
    setJob(latest);

    if (!latest || latest.status !== "completed") {
      setAsset(null);
      setFiles([]);
      setPhase("idle");
      return;
    }

    const assetResult = await readAssetForAssetJobReadOnly(client, latest.id);
    if (!assetResult.ok) {
      setAsset(null);
      setFiles([]);
      setPhase("idle");
      return;
    }
    setAsset(assetResult.asset);

    const fileResult = await listOrderedAssetFilesForAssetReadOnly(client, assetResult.asset.id);
    const loadedFiles = fileResult.ok ? fileResult.files : [];
    setFiles(loadedFiles);

    const first = loadedFiles[0];
    if (first) {
      const signed = await createSignedUrlForAssetFile(client, first);
      setPreviewUrl(signed.ok ? signed.signedUrl : "");
    } else {
      setPreviewUrl("");
    }
    setPhase("done");
  }, [client, creativePackageId]);

  // Resolved READ-ONLY and up front, from the same Creative Package the server will resolve its own
  // spec from. Nothing here is sent to the server: the manual route rebuilds the spec itself, so this
  // copy can only ever affect what the owner READS, never what gets composed.
  const loadPromptPackage = useCallback(async () => {
    if (!client || !supportsManual) {
      return;
    }
    const packageResult = await getCreativePackageById(client as unknown as CreativePackageClient, creativePackageId);
    if (!packageResult.ok) {
      setPromptPackageError(packageResult.message);
      return;
    }
    try {
      const spec = buildProductionSpec(packageResult.creativePackage, { assetKind: "image", brandBible: BRAND_BIBLE });
      const rendered = renderProductionPromptPackageIfImage(spec);
      if (!rendered) {
        setPromptPackageError("This package does not produce a still image, so there is no manual prompt for it.");
        return;
      }
      setPromptPackage(rendered);
      // From the SAME spec, in the same pass, so the document on screen and the bytes on the
      // clipboard can never describe two different generations.
      setImagePrompt(buildGenerativeImagePrompt(spec));
      setPromptPackageError("");
    } catch (err) {
      setPromptPackageError(err instanceof Error ? err.message : String(err));
    }
  }, [client, creativePackageId, supportsManual]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!isSupabaseConfigured || !client) {
        setError("Production requires the configured Supabase project.");
        setPhase("idle");
        return;
      }
      await loadLatest();
      if (cancelled) {
        return;
      }
      await loadPromptPackage();
    }
    load();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [creativePackageId]);

  // Finds a queued job this action may reuse. Deliberately matches on WORKER TYPE as well as status:
  // a queued generative_image job left behind by a failed Cloudflare attempt must never be handed to
  // the manual composer, because the runner would look up its executor by the job's own worker type
  // and find nothing registered.
  // Wave C2A narrows these two from AssetJobWorkerType to the APP-CREATABLE subset. The UI's three
  // callers already pass only generative_image / static_renderer / manual_illustration; the wider
  // type merely failed to say so, and after "remotion" joined AssetJobWorkerType it would have let
  // this component ask for a worker the application is not allowed to launch.
  function reusableJobId(workerType: AppCreatableAssetJobWorkerType): string | null {
    return job && job.status === "queued" && job.workerType === workerType ? job.id : null;
  }

  async function ensureJob(workerType: AppCreatableAssetJobWorkerType): Promise<string | null> {
    const reusable = reusableJobId(workerType);
    if (reusable) {
      return reusable;
    }
    if (!client) {
      return null;
    }
    // The automated path names NO worker and lets the reviewed route resolver decide. The two
    // fallbacks DO name one, because they are the owner overriding that route on purpose -- the same
    // way the External Creative Workspace panel has always named "external" explicitly.
    const created =
      workerType === route.workerType
        ? await createAssetJobForReadyCreativePackage(client, creativePackageId)
        : await createAssetJobForReadyCreativePackage(client, creativePackageId, { workerType, assetKind: "image" });
    if (!created.ok) {
      setError(created.message);
      return null;
    }
    setJob(created.job);
    return created.job.id;
  }

  async function accessToken(): Promise<string | null> {
    const session = await supabase?.auth.getSession();
    return session?.data.session?.access_token ?? null;
  }

  function beginAction() {
    setPhase("producing");
    setError("");
    setDoNotRetryNotice("");
  }

  // Handles the two shapes both production routes share, so the automated and manual callers cannot
  // drift about what a 207 or a 503 means.
  async function settle(httpStatus: number, payload: ProductionResponse): Promise<boolean> {
    if (httpStatus === 207) {
      setDoNotRetryNotice(payload.message ?? "The asset was produced, but recording the attempt failed.");
      await loadLatest();
      onProduced();
      return true;
    }

    if (httpStatus !== 200) {
      // 503 + a classified reason is the ONLY thing that opens the fallback banner. Everything else
      // is an ordinary error the owner may simply try again.
      if (httpStatus === 503 && payload.reason) {
        setUnavailable(payload.message ?? "AI illustration generation is unavailable right now.");
      } else {
        setError(payload.message ?? "Production did not complete.");
      }
      await loadLatest();
      setPhase("idle");
      return false;
    }

    setUnavailable("");
    await loadLatest();
    onProduced();
    return true;
  }

  // T1 and T3. One call does BOTH halves: create/reuse the queued Asset Job (browser, under RLS) and
  // then ask the server to execute it (route handler, holding the Cloudflare credential).
  //
  // IDEMPOTENCY. `phase === "producing"` disables the buttons synchronously, which stops a same-tab
  // double click before any network call. The real guarantee is below it and is not cosmetic:
  // execution claims the job through claim_asset_job_with_attempt, which only ever claims a row that
  // is still `queued`. A second execution of the same job therefore claims nothing and reports
  // not-queued rather than producing a second asset.
  async function produce(workerType: "generative_image" | "static_renderer") {
    if (!client) {
      return;
    }
    beginAction();

    const jobId = await ensureJob(workerType);
    if (!jobId) {
      setPhase("idle");
      return;
    }

    const token = await accessToken();
    if (!token) {
      setError("Your session has expired. Sign in again to run production.");
      setPhase("idle");
      return;
    }

    let payload: ProductionResponse = {};
    let httpStatus = 0;
    try {
      const response = await fetch("/api/production", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ assetJobId: jobId, workerType }),
      });
      httpStatus = response.status;
      payload = (await response.json()) as ProductionResponse;
    } catch {
      setError("Production could not be reached. Check your connection and look at the job status before running it again.");
      setPhase("idle");
      return;
    }

    await settle(httpStatus, payload);
  }

  // T2. The illustration already exists -- the owner made it in ChatGPT Images from the prompt above.
  // This uploads it and the SERVER composes it under the very same deterministic template a
  // Cloudflare generation goes through, so the finished post is identical in everything but who drew
  // the picture.
  async function uploadIllustration() {
    if (!client || !selectedFile) {
      return;
    }
    beginAction();

    const jobId = await ensureJob("manual_illustration");
    if (!jobId) {
      setPhase("idle");
      return;
    }

    const token = await accessToken();
    if (!token) {
      setError("Your session has expired. Sign in again to run production.");
      setPhase("idle");
      return;
    }

    const form = new FormData();
    form.append("assetJobId", jobId);
    form.append("illustration", selectedFile);
    form.append("sourceKind", SOURCE_KIND_BY_LABEL[sourceKindLabel] ?? "ai_generated");
    form.append("sourceWorkspace", "ChatGPT Images");

    let payload: ProductionResponse = {};
    let httpStatus = 0;
    try {
      const response = await fetch("/api/production/manual", {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: form,
      });
      httpStatus = response.status;
      payload = (await response.json()) as ProductionResponse;
    } catch {
      setError("The upload could not be reached. Check your connection and look at the job status before uploading again.");
      setPhase("idle");
      return;
    }

    const settled = await settle(httpStatus, payload);
    if (settled) {
      setSelectedFile(null);
      setManualOpen(false);
    }
  }

  // Copies the IMAGE-MODEL INPUT, never the owner documentation. The clipboard payload is required
  // to be byte-identical to what Cloudflare receives -- see tests/production-prompt-package.test.ts.
  async function copyPrompt() {
    if (!imagePrompt) {
      return;
    }
    try {
      await navigator.clipboard.writeText(imagePrompt);
      setCopyStatus("copied");
    } catch {
      setCopyStatus("failed");
    }
  }

  async function decide(decision: "accepted" | "rejected") {
    if (!client || !asset) {
      return;
    }
    setDecisionBusy(true);
    setError("");
    const result = await setAssetOwnerDecision(client, asset.id, decision);
    if (!result.ok) {
      setError(result.message);
    } else {
      setAsset(result.asset);
    }
    setDecisionBusy(false);
  }

  const previewFile = files[0] ?? null;
  const origin = describeSourceKind(asset);
  const isDecided = asset?.status === "accepted" || asset?.status === "rejected";
  const workerSupported = isMachineProductionWorkerType(route.workerType);
  const busy = phase === "producing";

  // A plain JSX-returning function, deliberately NOT a nested component. Declaring a component
  // inside render gives it a new identity every pass, so React unmounts and remounts its subtree --
  // which would silently clear the owner's chosen file and the source-kind select on every state
  // change. Calling it keeps the elements part of THIS component's tree.
  function renderManualPanel() {
    return (
      <div className="mt-3 space-y-3 rounded-md border border-[#ead9c8] bg-[#fffaf3] p-3">
        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#9a5b2f]">Generate this one in ChatGPT Images</p>
        <p className="text-sm text-[#6f5a4c]">
          Hit Copy image prompt, paste it into ChatGPT Images, download the illustration, and upload it here. This app still draws the
          headline, overlay text and branding -- you only need the picture.
        </p>

        {promptPackageError ? <MessageBox message={promptPackageError} tone="bad" /> : null}

        {promptPackage ? (
          <>
            <pre className="max-h-[320px] overflow-auto whitespace-pre-wrap break-words rounded-md bg-[#231813] p-3 text-xs leading-5 text-[#fff8ef]">
              {promptPackage}
            </pre>
            <div className="flex flex-wrap items-center gap-2">
              <SecondaryButton onClick={copyPrompt}>
                <Copy className="mr-1 inline" size={14} />
                Copy image prompt
              </SecondaryButton>
              {copyStatus === "copied" ? <span className="text-xs font-medium text-[#2e6b44]">Copied.</span> : null}
              {copyStatus === "failed" ? (
                <span className="text-xs font-medium text-[#8a3827]">Couldn&apos;t copy automatically -- copy the block between the two marker lines above, and nothing outside them.</span>
              ) : null}
            </div>
            {/* The document below is longer than what the button copies, and deliberately so: the
                sections after the prompt (overlay text, caption, composition notes) are owner
                context. Pasting them into an image model would put the brief's raw typeface and
                lettering notes AFTER the text-ownership override and undo it. */}
            <p className="text-xs text-[#6f5a4c]">
              This copies only the prompt between the two marker lines -- not the whole page. The sections below it are notes for you, not
              instructions for the image generator.
            </p>
            {/* Honest, unconditional note rather than a claim about server configuration this
                component cannot see. Reference images (when configured) steer the automated path
                only, so a manual illustration can legitimately drift in style. */}
            <p className="text-xs text-[#6f5a4c]">
              Automatic generations can be steered by reference images kept on the server. ChatGPT won&apos;t have those, so expect some
              style variation -- attach your own reference images in ChatGPT if you want a closer match.
            </p>
          </>
        ) : null}

        <label className="grid gap-1 text-sm font-medium">
          Illustration from ChatGPT
          <input
            accept="image/png,image/jpeg,image/webp"
            className="h-11 w-full rounded-md border border-[#d8c7b7] bg-white px-3 py-2 text-sm"
            onChange={(event) => setSelectedFile(event.target.files?.[0] ?? null)}
            type="file"
          />
        </label>
        {selectedFile ? <p className="text-xs text-[#6f5a4c]">Selected: {selectedFile.name}</p> : null}

        <Select
          label="Source kind"
          onChange={(event) => setSourceKindLabel(event.target.value)}
          options={SOURCE_KIND_SELECT_OPTIONS}
          value={sourceKindLabel}
        />
        <p className="text-xs text-[#6f5a4c]">
          A ChatGPT illustration is AI-generated. Change this only if the picture you are uploading genuinely came from somewhere else.
        </p>

        <button
          className="inline-flex h-11 items-center gap-2 rounded-md border border-[#7aa789] bg-[#e9f3ed] px-3 text-sm font-semibold text-[#2e6b44] disabled:cursor-not-allowed disabled:opacity-50"
          disabled={busy || !selectedFile || !client}
          onClick={uploadIllustration}
          type="button"
        >
          <Upload size={15} />
          {busy ? "Composing..." : "Upload illustration"}
        </button>
      </div>
    );
  }

  return (
    <section className="mt-3 rounded-md border border-[#ead9c8] bg-white p-3">
      <div className="flex items-center gap-2">
        <ImagePlus className="text-[#9a5b2f]" size={17} />
        <h4 className="font-semibold text-[#211713]">Production</h4>
      </div>
      <p className="mt-1 text-xs text-[#6f5a4c]">{describeRoute(route)}</p>

      {phase === "loading" ? <p className="mt-3 text-sm text-[#6f5a4c]">Checking for existing production...</p> : null}

      {!workerSupported ? <MessageBox message="This package routes to a production worker that is not available yet." tone="info" /> : null}

      {job ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <Tag tone={job.status === "completed" ? "green" : job.status === "queued" ? "warm" : "danger"}>Status: {job.status}</Tag>
          {origin ? <Tag tone={origin.tone}>{origin.label}</Tag> : null}
          {asset?.status === "accepted" ? <Tag tone="green">Accepted</Tag> : null}
          {asset?.status === "rejected" ? <Tag tone="danger">Rejected</Tag> : null}
        </div>
      ) : null}

      {busy ? <MessageBox message="Working... this can take a few seconds." tone="info" /> : null}
      {error ? <MessageBox message={error} tone="bad" /> : null}
      {doNotRetryNotice ? <MessageBox message={doNotRetryNotice} tone="bad" /> : null}

      {/* THE FAILURE FORK. Says plainly what is wrong, then offers the two things that still work.
          It never re-offers the automatic button, and it never picks one of these for the owner. */}
      {unavailable ? (
        <div className="mt-3 space-y-3 rounded-md border border-[#e0b4a4] bg-[#fdf1ec] p-3">
          <p className="text-sm font-semibold text-[#8a3827]">AI illustration generation is unavailable right now.</p>
          <p className="text-sm text-[#6f5a4c]">{unavailable}</p>
          <p className="text-sm text-[#6f5a4c]">The rest of this post is ready. Choose how you want to finish it:</p>
          <div className="flex flex-wrap gap-2">
            <SecondaryButton disabled={busy} onClick={() => setManualOpen(true)}>
              <ImagePlus className="mr-1 inline" size={14} />
              Generate manually with ChatGPT
            </SecondaryButton>
            <SecondaryButton disabled={busy} onClick={() => produce("static_renderer")}>
              <Type className="mr-1 inline" size={14} />
              Use a text/editorial version instead
            </SecondaryButton>
          </div>
          <p className="text-xs text-[#6f5a4c]">
            The text/editorial version is a different-looking post with no illustration. Nothing is chosen for you, and picking one now
            does not stop you producing again later.
          </p>
        </div>
      ) : null}

      {previewFile ? (
        <div className="mt-3 space-y-2">
          {/* The REAL stored object from the Asset pipeline -- never a scratch file and never a
              locally reconstructed preview. Served through a short-lived signed URL because the
              bucket is private. */}
          {previewUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img alt="Produced asset" className="w-full max-w-[420px] rounded-md border border-[#ead9c8]" src={previewUrl} />
          ) : (
            <MessageBox message="The asset was produced and stored, but a preview link could not be created just now." tone="info" />
          )}
          <p className="break-words text-xs text-[#6f5a4c]">
            {previewFile.width}x{previewFile.height} PNG -- {previewFile.storagePath}
          </p>
        </div>
      ) : null}

      {phase === "done" && asset ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <SecondaryButton disabled={decisionBusy || asset.status === "accepted"} onClick={() => decide("accepted")}>
            <Check className="mr-1 inline" size={14} />
            Accept
          </SecondaryButton>
          <SecondaryButton disabled={decisionBusy || asset.status === "rejected"} onClick={() => decide("rejected")}>
            <X className="mr-1 inline" size={14} />
            Reject
          </SecondaryButton>
          <SecondaryButton disabled={decisionBusy} onClick={() => produce(route.workerType === "static_renderer" ? "static_renderer" : "generative_image")}>
            <RefreshCw className="mr-1 inline" size={14} />
            Regenerate
          </SecondaryButton>
          {supportsManual ? (
            <SecondaryButton disabled={decisionBusy} onClick={() => setManualOpen(true)}>
              <ImagePlus className="mr-1 inline" size={14} />
              Generate manually with ChatGPT
            </SecondaryButton>
          ) : null}
        </div>
      ) : null}

      {isDecided ? (
        <p className="mt-2 text-xs text-[#6f5a4c]">
          Accepted assets are ready for content use. Nothing is published automatically.
        </p>
      ) : null}

      {/* The two first-class entry points, side by side. The manual path is not hidden behind a
          failure: an owner who simply prefers ChatGPT for today's post can reach it directly. */}
      {phase === "idle" && !doNotRetryNotice && !unavailable ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            className="inline-flex h-11 items-center gap-2 rounded-md border border-[#7aa789] bg-[#e9f3ed] px-3 text-sm font-semibold text-[#2e6b44] disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!client || !workerSupported || busy}
            onClick={() => produce(route.workerType === "static_renderer" ? "static_renderer" : "generative_image")}
            type="button"
          >
            <ImagePlus size={15} />
            {job ? "Generate automatically again" : "Generate automatically"}
          </button>
          {supportsManual ? (
            <SecondaryButton disabled={!client || busy} onClick={() => setManualOpen((open) => !open)}>
              <ImagePlus className="mr-1 inline" size={14} />
              Generate manually with ChatGPT
            </SecondaryButton>
          ) : null}
        </div>
      ) : null}

      {supportsManual && manualOpen ? renderManualPanel() : null}
    </section>
  );
}
