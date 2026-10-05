// Product Lab MCP Slice 2.1A -- OAuth discovery documents for the remote MCP endpoint.
// TASK-073 -- extracted from src/app/.well-known/[...path]/route.ts so the Next.js route and the
// Cloudflare Worker serve the same documents from the same code.
//
// Serves the two well-known documents an MCP server acting as an OAuth Resource Server must expose
// (see oauthMetadataResponse's own documentation in @modelcontextprotocol/server):
//
//   GET /.well-known/oauth-protected-resource/api/mcp  (RFC 9728) -- points a client at Supabase as
//     the authorization server for the /api/mcp resource.
//   GET /.well-known/oauth-authorization-server        (RFC 8414) -- a mirror of Supabase's own
//     Authorization Server metadata, served from this origin too so legacy clients that probe the
//     resource origin directly (rather than following the Protected Resource Metadata's
//     authorization_servers entry) still discover Supabase.
//
// Supabase IS the OAuth 2.1 authorization server (see docs/PRODUCT_LAB_MCP.md and
// scripts/product-lab-mcp/remote-auth.ts) -- this handler never issues, signs, or verifies a token
// itself. It only republishes Supabase's own metadata (fetched from Supabase's real discovery
// endpoint, documented in PRODUCT_LAB_MCP.md's Supabase configuration section) under this server's
// origin, which is the RFC 8414-documented reason the mirrored route exists at all.
import { oauthMetadataResponse, type OAuthMetadata } from "@modelcontextprotocol/server";
import { ProductLabError, readProductLabProjectConfig } from "../product-lab/auth.ts";
import { canonicalMcpResourceUrl } from "./origin-policy.ts";

const METADATA_TTL_MS = 10 * 60 * 1000;
let cachedMetadata: { value: OAuthMetadata; fetchedAt: number } | null = null;

async function fetchSupabaseOAuthMetadata(supabaseUrl: string): Promise<OAuthMetadata> {
  if (cachedMetadata && Date.now() - cachedMetadata.fetchedAt < METADATA_TTL_MS) {
    return cachedMetadata.value;
  }
  const metadataUrl = new URL("/.well-known/oauth-authorization-server/auth/v1", supabaseUrl);
  const response = await fetch(metadataUrl);
  if (!response.ok) {
    throw new Error(`Supabase authorization-server metadata request failed: ${response.status}`);
  }
  const value = (await response.json()) as OAuthMetadata;
  cachedMetadata = { value, fetchedAt: Date.now() };
  return value;
}

export async function handleProductLabOAuthDiscoveryRequest(
  request: Request,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Response> {
  let config;
  try {
    config = readProductLabProjectConfig(env);
  } catch (error) {
    if (!(error instanceof ProductLabError)) throw error;
    return Response.json(
      { error: "server_error", error_description: "Product Lab MCP is not configured" },
      { status: 500 },
    );
  }

  let oauthMetadata: OAuthMetadata;
  try {
    oauthMetadata = await fetchSupabaseOAuthMetadata(config.url);
  } catch {
    return Response.json(
      { error: "server_error", error_description: "Authorization server metadata is unavailable" },
      { status: 502 },
    );
  }

  // The resource URL this metadata advertises is security-sensitive (RFC 9728) and must not be
  // derived from inbound Host/X-Forwarded-Host headers, which are attacker-controlled -- and must
  // agree with the WWW-Authenticate challenge http-handler.ts issues on a 401, or an OAuth client's
  // discovery step and its 401 challenge point at two different origins. Both call sites share
  // canonicalMcpResourceUrl for exactly that reason; see its own documentation in origin-policy.ts
  // for the trust model.
  const resourceServerUrl = canonicalMcpResourceUrl(request.url, env);

  const response = oauthMetadataResponse(request, {
    oauthMetadata,
    resourceServerUrl,
    resourceName: "Product Lab MCP",
  });
  return response ?? new Response("Not found", { status: 404 });
}
