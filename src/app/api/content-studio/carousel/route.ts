// Content Studio Fast Mode -- one carousel slide per request, as image/png.
//
// Owner-authenticated exactly like /api/production: the browser presents its own Supabase session and
// every read runs AS THE OWNER under RLS. No credential of its own, no service role. Everything that is
// a decision lives in src/lib/content-studio/fast-mode-service.ts; this file does HTTP.
//
// One slide per request keeps every response well under serverless response limits and means each
// request reads only the one photo its slide draws. The browser previews the five PNGs it receives and
// zips exactly those bytes for export.

import { authenticateOwner, isProductionOwner } from "@/lib/production-auth-server";
import { generateCarouselSlide } from "@/lib/content-studio/fast-mode-service";
import type { FastModeSourceClient } from "@/lib/content-studio/fast-mode-sources";

// satori, resvg and sharp are native modules. Not an edge isolate.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function fail(status: number, message: string): Response {
  return Response.json({ message }, { status });
}

export async function POST(request: Request): Promise<Response> {
  const auth = await authenticateOwner(request);
  if (!auth.ok) {
    return auth.reason === "not-configured" ? fail(503, "Content creation is not available in this environment.") : fail(401, "Sign in as the owner to create content.");
  }
  if (!isProductionOwner(auth.principal)) return fail(403, "This account is not permitted to create content.");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "That request could not be read. Reload and try again.");
  }

  const result = await generateCarouselSlide(auth.principal.client as unknown as FastModeSourceClient, body);
  if (!result.ok) return fail(result.status, result.message);
  return new Response(result.png as BodyInit, {
    status: 200,
    headers: { "content-type": "image/png", "cache-control": "no-store", "x-file-name": result.fileName },
  });
}
