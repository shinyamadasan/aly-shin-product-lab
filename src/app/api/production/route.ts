// Production MVP Wave B -- the owner-authenticated machine production endpoint.
//
// WHY A ROUTE HANDLER AT ALL, when every other owner write in this app goes straight from the
// browser to Supabase.
//
// Exactly one reason: generative_image needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN, and
// those must never reach a browser. Everything else the owner does in this workflow -- creating the
// Asset Job, reading its status, previewing the Asset, accepting, rejecting -- needs no secret and
// keeps going through the ordinary browser client under RLS. This route exists for the credential
// boundary and nothing more, which is why it has one verb and one job.
//
// static_renderer needs no credential either, but runs here too: it is the same executor seam, and
// splitting "run production" across two mechanisms by whether it happens to need a key would be a
// worse contract than one endpoint that runs the Production Route's chosen worker.
//
// Deliberately thin, mirroring api/public-orders/route.ts: every decision lives in
// src/lib/production-execution.ts (shared with the CLI) and src/lib/production-auth-server.ts. This
// file does HTTP.

import { authenticateOwner, isProductionOwner } from "@/lib/production-auth-server";
import {
  WEB_PRODUCTION_EXECUTOR_TIMEOUTS_MS,
  executeProductionAssetJob,
  isProductionWorkerType,
  isUpstreamProductionFailure,
} from "@/lib/production-execution";
import type { AssetJobExecutionClient } from "@/lib/asset-jobs";

// Node runtime: satori, resvg and sharp are native modules, and the Supabase client runs here.
// Not an edge isolate.
export const runtime = "nodejs";
// Never statically evaluated or cached -- every call claims a job and writes.
export const dynamic = "force-dynamic";
// The platform ceiling this route is allowed to consume. WEB_PRODUCTION_EXECUTOR_TIMEOUTS_MS is
// deliberately set BELOW this so our own timeout fires first and writes a truthful terminal state,
// rather than the platform killing the invocation with the job left `running` forever. 60 is chosen
// because it is valid on every Vercel plan tier; measured Cloudflare generations are 1.6s-4.7s, so
// this is roughly an order of magnitude of headroom, not a tight fit.
export const maxDuration = 60;

type ProductionRequestBody = { assetJobId?: unknown; workerType?: unknown };

// The public error contract. No PostgreSQL message, no table name, no stack, no Supabase auth error,
// no provider response body, and never an environment VALUE.
function fail(status: number, code: string, message: string): Response {
  return Response.json({ status: code, message }, { status });
}

export async function POST(request: Request): Promise<Response> {
  const auth = await authenticateOwner(request);
  if (!auth.ok) {
    if (auth.reason === "not-configured") {
      return fail(503, "unavailable", "Production is not available in this environment.");
    }
    // missing-token and invalid-token are answered identically: a caller probing for the difference
    // learns nothing about whether a token was merely absent or actually rejected.
    return fail(401, "unauthorized", "Sign in as the owner to run production.");
  }

  if (!isProductionOwner(auth.principal)) {
    return fail(403, "forbidden", "This account is not permitted to run production.");
  }

  let body: ProductionRequestBody;
  try {
    body = (await request.json()) as ProductionRequestBody;
  } catch {
    return fail(400, "invalid", "That production request could not be read.");
  }

  const { assetJobId, workerType } = body;
  if (typeof assetJobId !== "string" || assetJobId.trim().length === 0) {
    return fail(400, "invalid", "A production request must name an Asset Job.");
  }

  // CLOSED VOCABULARY, and load-bearing for security. The client may choose only between the two
  // registered machine workers. It cannot name "external" or "mock", and -- more importantly -- there
  // is deliberately NO path anywhere in this body for a provider endpoint, a model id, or a
  // reference-image filesystem path. All three are read from server environment inside the executor,
  // so a browser cannot point production at another provider, another model, or another file.
  if (typeof workerType !== "string" || !isProductionWorkerType(workerType)) {
    return fail(400, "invalid", "A production request must name a supported production worker.");
  }

  try {
    const outcome = await executeProductionAssetJob(
      auth.principal.client as unknown as AssetJobExecutionClient,
      assetJobId.trim(),
      workerType,
      { timeoutMs: WEB_PRODUCTION_EXECUTOR_TIMEOUTS_MS[workerType] },
    );

    switch (outcome.kind) {
      case "completed":
        return Response.json(
          {
            status: "completed",
            assetJobId: outcome.job.id,
            assetId: outcome.assetId,
            // No publicUrl: the generated-assets bucket is private and that column is always "". The
            // browser re-reads the Asset and mints a short-lived signed URL for the preview.
            files: outcome.files.map((file) => ({ storagePath: file.storagePath, width: file.width, height: file.height })),
          },
          { status: 200 },
        );

      case "bookkeeping-failed":
        // 200 would be a lie and 500 would be a different lie -- the asset really was produced. 207
        // says exactly that: partial success, and the body tells the owner not to retry.
        return Response.json(
          {
            status: "bookkeeping-failed",
            assetJobId: outcome.job.id,
            assetId: outcome.assetId,
            // No publicUrl: the generated-assets bucket is private and that column is always "". The
            // browser re-reads the Asset and mints a short-lived signed URL for the preview.
            files: outcome.files.map((file) => ({ storagePath: file.storagePath, width: file.width, height: file.height })),
            message:
              "The asset was produced and stored correctly, but recording the attempt failed. Do not run production again for this package -- that would create a second asset. Check that supabase-add-asset-job-attempt-provenance.sql has been applied.",
          },
          { status: 207 },
        );

      case "not-configured":
        // Names the missing configuration, never a value.
        return fail(503, "not-configured", "Image generation is not configured on the server.");

      case "failed": {
        // Three-way, because the three groups mean different things to the browser:
        //   409 -- this job is not in a state that can run (owner/state error, no fallback offered)
        //   503 -- the provider is out of quota, rejecting our credential, or down. The client reads
        //          `reason` and offers the manual and static alternatives instead of a retry.
        //   502 -- anything else that went wrong while producing.
        const status =
          outcome.reason === "not-found" || outcome.reason === "not-queued"
            ? 409
            : isUpstreamProductionFailure(outcome.reason)
              ? 503
              : 502;
        return Response.json({ status: "failed", reason: outcome.reason, message: outcome.message }, { status });
      }
    }
  } catch {
    // Nothing about an unexpected failure travels to the browser.
    return fail(500, "error", "Production could not be completed just now.");
  }
}
