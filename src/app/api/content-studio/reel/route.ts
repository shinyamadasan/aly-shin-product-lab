// Content Studio Fast Mode -- the Reel, as video/mp4.
//
// Same owner boundary as the carousel route. A Reel needs Chrome and FFmpeg, so it is only made on a
// server marked CONTENT_STUDIO_REEL_RENDERING=1 (see src/lib/content-studio/reel-host.ts); GET tells
// the owner UI whether this server is one, so it can say so before the owner fills anything in.
// HTTP handling is in src/lib/content-studio/fast-mode-routes.ts.

import { authenticateOwner } from "@/lib/production-auth-server";
import { handleReelGet, handleReelPost, type ReelHost } from "@/lib/content-studio/fast-mode-routes";
import { reelRenderingAvailable, renderReelOnHost } from "@/lib/content-studio/reel-host";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Only meaningful on a host that can render at all; there is no platform ceiling on the studio machine.
export const maxDuration = 600;

const host: ReelHost = { available: () => reelRenderingAvailable(), render: (campaign) => renderReelOnHost(campaign) };

export async function GET(request: Request): Promise<Response> {
  return handleReelGet(request, authenticateOwner, host);
}

export async function POST(request: Request): Promise<Response> {
  return handleReelPost(request, authenticateOwner, host);
}
