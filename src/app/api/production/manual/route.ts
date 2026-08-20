// Production MVP Wave B -- the owner-authenticated MANUAL composition endpoint.
//
// WHY A SECOND ROUTE RATHER THAN A MODE ON ../route.ts
//
// Its sibling exists for the credential boundary: generative_image needs the Cloudflare token and a
// browser must never hold it. This route needs no credential at all. It exists for a different
// reason -- the COMPOSITOR is native (satori, resvg, sharp) and cannot run in a browser, so the
// illustration the owner obtained from ChatGPT Images has to come here to be composed.
//
// They are also shaped differently at the wire: that one takes JSON and names a worker, this one
// takes multipart/form-data and carries image bytes. Folding two content types and two body
// contracts into one handler to save a file would make both harder to read than either is now.
//
// What they SHARE is everything that matters: both are thin, both authenticate the same way, and
// both delegate every decision to src/lib/production-execution.ts. There is no second pipeline here.

import { authenticateOwner, isProductionOwner } from "@/lib/production-auth-server";
import { WEB_MANUAL_ILLUSTRATION_TIMEOUT_MS, executeManualIllustrationAssetJob } from "@/lib/production-execution";
import { buildManualIllustration } from "@/lib/production-manual-composition";
import { isAssetSourceKind, type AssetJobExecutionClient } from "@/lib/asset-jobs";

// Node runtime: satori, resvg and sharp are native modules, and the Supabase client runs here.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Same ceiling and the same reasoning as the automated route: WEB_MANUAL_ILLUSTRATION_TIMEOUT_MS is
// set below it so our own timeout fires first and writes a truthful terminal state.
export const maxDuration = 60;

// Matches GENERATED_ASSET_MAX_FILE_SIZE_BYTES. Checked here as well as inside the intake boundary so
// an oversized upload is refused before its bytes are read into memory, not after.
const MAX_ILLUSTRATION_BYTES = 10 * 1024 * 1024;

function fail(status: number, code: string, message: string): Response {
  return Response.json({ status: code, message }, { status });
}

export async function POST(request: Request): Promise<Response> {
  const auth = await authenticateOwner(request);
  if (!auth.ok) {
    if (auth.reason === "not-configured") {
      return fail(503, "unavailable", "Production is not available in this environment.");
    }
    return fail(401, "unauthorized", "Sign in as the owner to run production.");
  }

  if (!isProductionOwner(auth.principal)) {
    return fail(403, "forbidden", "This account is not permitted to run production.");
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return fail(400, "invalid", "That upload could not be read.");
  }

  const assetJobId = form.get("assetJobId");
  if (typeof assetJobId !== "string" || assetJobId.trim().length === 0) {
    return fail(400, "invalid", "A manual production request must name an Asset Job.");
  }

  const illustrationField = form.get("illustration");
  if (!(illustrationField instanceof Blob)) {
    return fail(400, "invalid", "A manual production request must include an illustration file.");
  }
  if (illustrationField.size > MAX_ILLUSTRATION_BYTES) {
    return fail(413, "too-large", "That illustration is larger than the 10MB limit.");
  }

  // OPERATOR-DECLARED, and validated as a member of the closed set rather than trusted as text. The
  // runner honours it because manual_illustration is deliberately not in MACHINE_EXECUTOR_SOURCE_KINDS
  // -- see the note on ASSET_JOB_WORKER_TYPES. Absent is allowed and simply records nothing; this
  // route never invents an origin on the owner's behalf.
  const sourceKindField = form.get("sourceKind");
  const sourceKind = typeof sourceKindField === "string" && isAssetSourceKind(sourceKindField) ? sourceKindField : undefined;
  const sourceWorkspaceField = form.get("sourceWorkspace");
  const sourceWorkspace = typeof sourceWorkspaceField === "string" && sourceWorkspaceField.trim() ? sourceWorkspaceField.trim() : undefined;

  // VALIDATE BEFORE CLAIM. An unreadable or unsupported file fails here, with the Asset Job still
  // queued and its single attempt unspent -- the same ordering the External Creative Workspace upload
  // has always used.
  const intake = await buildManualIllustration(new Uint8Array(await illustrationField.arrayBuffer()));
  if (!intake.ok) {
    return fail(400, "invalid", intake.message);
  }

  try {
    const outcome = await executeManualIllustrationAssetJob(
      auth.principal.client as unknown as AssetJobExecutionClient,
      assetJobId.trim(),
      intake.illustration,
      { timeoutMs: WEB_MANUAL_ILLUSTRATION_TIMEOUT_MS, sourceKind, sourceWorkspace },
    );

    switch (outcome.kind) {
      case "completed":
        return Response.json(
          {
            status: "completed",
            assetJobId: outcome.job.id,
            assetId: outcome.assetId,
            files: outcome.files.map((file) => ({ storagePath: file.storagePath, width: file.width, height: file.height })),
          },
          { status: 200 },
        );

      case "bookkeeping-failed":
        return Response.json(
          {
            status: "bookkeeping-failed",
            assetJobId: outcome.job.id,
            assetId: outcome.assetId,
            files: outcome.files.map((file) => ({ storagePath: file.storagePath, width: file.width, height: file.height })),
            message:
              "The post was composed and stored correctly, but recording the attempt failed. Do not upload again for this package -- that would create a second asset. Check that supabase-add-asset-job-attempt-provenance.sql has been applied.",
          },
          { status: 207 },
        );

      // Unreachable: nothing in the manual path constructs a provider client, so there is no
      // credential to be missing. Handled because ProductionExecutionOutcome is a shared union.
      case "not-configured":
        return fail(503, "not-configured", "Manual composition is not available on the server.");

      case "failed":
        return Response.json({ status: "failed", reason: outcome.reason, message: outcome.message }, {
          status: outcome.reason === "not-found" || outcome.reason === "not-queued" ? 409 : 502,
        });
    }
  } catch {
    return fail(500, "error", "That illustration could not be composed just now.");
  }
}
