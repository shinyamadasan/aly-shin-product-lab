// Product Lab MCP Slice 2.1A -- OAuth discovery documents for the remote MCP endpoint.
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
// scripts/product-lab-mcp/remote-auth.ts) -- this route never issues, signs, or verifies a token
// itself. It only republishes Supabase's own metadata (fetched from Supabase's real discovery
// endpoint, documented in PRODUCT_LAB_MCP.md's Supabase configuration section) under this server's
// origin, which is the RFC 8414-documented reason the mirrored route exists at all.
import { oauthMetadataResponse, type OAuthMetadata } from "@modelcontextprotocol/server";
import { ProductLabError, readProductLabProjectConfig } from "../../../../scripts/product-lab/auth.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

export async function GET(request: Request): Promise<Response> {
  let config;
  try {
    config = readProductLabProjectConfig();
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
  // derived from inbound Host/X-Forwarded-Host headers, which are attacker-controlled. When an
  // operator has configured the deployment's public hostname (see origin-policy.ts, which uses the
  // same variable for Host/Origin allowlisting), that trusted value wins over whatever hostname
  // `request.url` happened to carry -- e.g. Netlify's underlying site hostname on a custom domain.
  // Falling back to `request.url` keeps local/dev and platforms without an explicit override working.
  const publicHostname = process.env.PRODUCT_LAB_MCP_PUBLIC_HOSTNAME;
  const resourceServerUrl = publicHostname
    ? new URL(`https://${publicHostname}/api/mcp`)
    : new URL(request.url);
  resourceServerUrl.pathname = "/api/mcp";
  resourceServerUrl.search = "";

  const response = oauthMetadataResponse(request, {
    oauthMetadata,
    resourceServerUrl,
    resourceName: "Product Lab MCP",
  });
  return response ?? new Response("Not found", { status: 404 });
}
