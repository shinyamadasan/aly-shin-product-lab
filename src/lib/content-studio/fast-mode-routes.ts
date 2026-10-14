import { isProductionOwner, type OwnerAuthResult } from "../production-auth.ts";
import { generateCarouselSlide, generateReel } from "./fast-mode-service.ts";
import type { FastModeSourceClient } from "./fast-mode-sources.ts";
import type { PreparedCampaign } from "./creative-plan.ts";
import type { ReelHostResult } from "./reel-host.ts";

// Content Studio Fast Mode -- the two owner routes' HTTP handling, with authentication injected.
//
// The route files (src/app/api/content-studio/*/route.ts) pass in authenticateOwner from the
// server-only auth module; tests pass in authenticateOwnerWith over a fake auth server. The owner
// decision is the same pure isProductionOwner rule /api/production uses. Everything that is a
// decision about content lives in fast-mode-service.ts; this file does HTTP.

export type FastModeAuthenticate = (request: Request) => Promise<OwnerAuthResult<unknown>>;

export type ReelHost = { available: () => boolean; render: (campaign: PreparedCampaign) => Promise<ReelHostResult> };

function fail(status: number, message: string): Response {
  return Response.json({ message }, { status });
}

async function owner(request: Request, authenticate: FastModeAuthenticate): Promise<{ client: FastModeSourceClient } | { response: Response }> {
  const auth = await authenticate(request);
  if (!auth.ok) {
    return { response: auth.reason === "not-configured" ? fail(503, "Content creation is not available in this environment.") : fail(401, "Sign in as the owner to create content.") };
  }
  if (!isProductionOwner(auth.principal)) return { response: fail(403, "This account is not permitted to create content.") };
  return { client: auth.principal.client as FastModeSourceClient };
}

async function readJson(request: Request): Promise<{ body: unknown } | { response: Response }> {
  try {
    return { body: await request.json() };
  } catch {
    return { response: fail(400, "That request could not be read. Reload and try again.") };
  }
}

export async function handleCarouselPost(request: Request, authenticate: FastModeAuthenticate): Promise<Response> {
  const checked = await owner(request, authenticate);
  if ("response" in checked) return checked.response;
  const read = await readJson(request);
  if ("response" in read) return read.response;

  const result = await generateCarouselSlide(checked.client, read.body);
  if (!result.ok) return fail(result.status, result.message);
  return new Response(result.png as BodyInit, {
    status: 200,
    headers: { "content-type": "image/png", "cache-control": "no-store", "x-file-name": result.fileName },
  });
}

export async function handleReelGet(request: Request, authenticate: FastModeAuthenticate, host: ReelHost): Promise<Response> {
  const checked = await owner(request, authenticate);
  if ("response" in checked) return checked.response;
  return Response.json({ available: host.available() }, { headers: { "cache-control": "no-store" } });
}

export async function handleReelPost(request: Request, authenticate: FastModeAuthenticate, host: ReelHost): Promise<Response> {
  const checked = await owner(request, authenticate);
  if ("response" in checked) return checked.response;
  const read = await readJson(request);
  if ("response" in read) return read.response;

  const result = await generateReel(checked.client, read.body, host);
  if (!result.ok) return fail(result.status, result.message);
  return new Response(result.mp4 as BodyInit, { status: 200, headers: { "content-type": "video/mp4", "cache-control": "no-store" } });
}
