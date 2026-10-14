// Content Studio Fast Mode -- the Reel, as video/mp4.
//
// Same owner boundary as the carousel route. A Reel needs Chrome and FFmpeg, so it is only made on a
// server marked CONTENT_STUDIO_REEL_RENDERING=1 (see src/lib/content-studio/reel-host.ts); GET tells
// the owner UI whether this server is one, so it can say so before the owner fills anything in.

import { authenticateOwner, isProductionOwner } from "@/lib/production-auth-server";
import { generateReel } from "@/lib/content-studio/fast-mode-service";
import type { FastModeSourceClient } from "@/lib/content-studio/fast-mode-sources";
import { reelRenderingAvailable, renderReelOnHost } from "@/lib/content-studio/reel-host";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Only meaningful on a host that can render at all; there is no platform ceiling on the studio machine.
export const maxDuration = 600;

function fail(status: number, message: string): Response {
  return Response.json({ message }, { status });
}

async function owner(request: Request) {
  const auth = await authenticateOwner(request);
  if (!auth.ok) {
    return { response: auth.reason === "not-configured" ? fail(503, "Content creation is not available in this environment.") : fail(401, "Sign in as the owner to create content.") };
  }
  if (!isProductionOwner(auth.principal)) return { response: fail(403, "This account is not permitted to create content.") };
  return { client: auth.principal.client as unknown as FastModeSourceClient };
}

export async function GET(request: Request): Promise<Response> {
  const checked = await owner(request);
  if ("response" in checked) return checked.response!;
  return Response.json({ available: reelRenderingAvailable() }, { headers: { "cache-control": "no-store" } });
}

export async function POST(request: Request): Promise<Response> {
  const checked = await owner(request);
  if ("response" in checked) return checked.response!;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "That request could not be read. Reload and try again.");
  }

  const result = await generateReel(checked.client, body, { available: () => reelRenderingAvailable(), render: (campaign) => renderReelOnHost(campaign) });
  if (!result.ok) return fail(result.status, result.message);
  return new Response(result.mp4 as BodyInit, { status: 200, headers: { "content-type": "video/mp4", "cache-control": "no-store" } });
}
