// Content Studio Fast Mode -- one carousel slide per request, as image/png.
//
// Owner-authenticated exactly like /api/production: the browser presents its own Supabase session and
// every read runs AS THE OWNER under RLS. No credential of its own, no service role. HTTP handling is
// in src/lib/content-studio/fast-mode-routes.ts (so it is testable without Next); every decision about
// content lives in src/lib/content-studio/fast-mode-service.ts.
//
// One slide per request keeps every response well under serverless response limits and means each
// request reads only the one photo its slide draws. The browser previews the five PNGs it receives and
// zips exactly those bytes for export.

import { authenticateOwner } from "@/lib/production-auth-server";
import { handleCarouselPost } from "@/lib/content-studio/fast-mode-routes";

// satori, resvg and sharp are native modules. Not an edge isolate.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request): Promise<Response> {
  return handleCarouselPost(request, authenticateOwner);
}
