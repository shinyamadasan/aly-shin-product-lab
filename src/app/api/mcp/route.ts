// Product Lab MCP Slice 2.1A -- the remote Streamable HTTP MCP endpoint.
//
// This mounts the EXACT SAME tool registry the local stdio server uses
// (scripts/product-lab-mcp/mcp-server.ts createProductLabMcpServer) behind Supabase OAuth-issued
// bearer identity instead of a process-global environment token. See docs/PRODUCT_LAB_MCP.md for the
// five tools and their business rules, which do not change here.
//
// AUTH MODEL.
//
// Every request must carry `Authorization: Bearer <Supabase OAuth access token>`. requireBearerAuth
// (from @modelcontextprotocol/server) is the SDK's own web-standard bearer gate: it never runs unless
// a token is verified by createProductLabOAuthTokenVerifier, which in turn never returns unless
// authenticateProductLabRequest has confirmed, via a real Supabase Auth round trip, that the caller is
// the Product Lab owner (scripts/product-lab/auth.ts). A random unauthenticated request -- no header,
// a malformed header, an expired or invalid token, or a valid-but-non-owner token -- never reaches
// createMcpHandler's factory at all; it is answered by the gate with a 401/403 carrying a
// WWW-Authenticate challenge that names this server's Protected Resource Metadata document, per
// RFC 9728, so a compliant OAuth client can discover Supabase as the authorization server on its own.
//
// createMcpHandler's own contract performs NO token verification of its own -- authInfo is strictly
// pass-through. That is why the gate above must run in front of it, not inside it.
//
// ORIGIN / HOST HARDENING.
//
// createMcpHandler's own documentation states the entry is "deliberately validation-free" for
// Host/Origin and expects the mounting app to check both in front of it -- exactly what
// hostHeaderValidationResponse/originValidationResponse (both SDK-provided, not hand-rolled) do
// below, against the environment-derived allowlist in scripts/product-lab-mcp/origin-policy.ts. This
// runs BEFORE the bearer-auth gate: a request naming a Host/Origin outside the allowlist is refused
// before a token is even inspected.
//
// STATELESS BY DESIGN.
//
// The factory below builds a fresh, request-scoped McpServer for every HTTP exchange
// (McpServerFactory's own contract under createMcpHandler), backed by the durable Postgres preview
// store (scripts/product-lab/inventory-count-service.ts createDurableInventoryCountArtifactStore) --
// never process memory, never a local file. This is what makes the endpoint safe to run on a
// serverless platform where no two requests are guaranteed to share a process.
import {
  createMcpHandler,
  getOAuthProtectedResourceMetadataUrl,
  hostHeaderValidationResponse,
  originValidationResponse,
  requireBearerAuth,
  type McpServerFactory,
} from "@modelcontextprotocol/server";
import { ProductLabError, readProductLabProjectConfig } from "../../../../scripts/product-lab/auth.ts";
import { createInventoryCountServiceForClient } from "../../../../scripts/product-lab/inventory-count-service.ts";
import { createProductLabMcpServer } from "../../../../scripts/product-lab-mcp/mcp-server.ts";
import { allowedMcpHostnames, canonicalMcpResourceUrl } from "../../../../scripts/product-lab-mcp/origin-policy.ts";
import { createProductLabOAuthTokenVerifier, ownerContextFromAuthInfo } from "../../../../scripts/product-lab-mcp/remote-auth.ts";
import { createProductLabReadServiceForClient } from "../../../../scripts/product-lab/read-service.ts";

export const runtime = "nodejs";
// Every response depends entirely on the caller's own bearer token; nothing here may be cached.
export const dynamic = "force-dynamic";

const factory: McpServerFactory = (ctx) => {
  const context = ownerContextFromAuthInfo(ctx.authInfo);
  return createProductLabMcpServer(
    createProductLabReadServiceForClient(context.client),
    createInventoryCountServiceForClient(context.client),
  );
};

// Default ("stateless") legacy posture: serves the modern 2026-07-28 per-request envelope AND falls
// back to old-school stateless serving for 2025-era clients that have not yet upgraded, from the SAME
// factory. `legacy: "reject"` (modern-only strict) was tried first and rejected real client traffic
// that still negotiates the 2025-11-25 protocol revision by default -- this endpoint is meant to be
// usable by today's MCP clients, not only ones already fully upgraded.
const handler = createMcpHandler(factory);

function configurationErrorResponse(): Response {
  return Response.json(
    { error: { code: "configuration_error", message: "Product Lab MCP is not configured" } },
    { status: 500 },
  );
}

async function handle(request: Request): Promise<Response> {
  let config;
  try {
    config = readProductLabProjectConfig();
  } catch (error) {
    if (error instanceof ProductLabError) return configurationErrorResponse();
    throw error;
  }

  const allowedHostnames = allowedMcpHostnames();
  const hostRejection = hostHeaderValidationResponse(request, allowedHostnames);
  if (hostRejection) return hostRejection;
  const originRejection = originValidationResponse(request, allowedHostnames);
  if (originRejection) return originRejection;

  // Must agree with the RFC 9728 discovery document (src/app/.well-known/[...path]/route.ts) or an
  // OAuth client's discovery step and this 401 challenge point at two different origins -- e.g.
  // Netlify's underlying *.netlify.app hostname leaking into the challenge on a custom domain even
  // though discovery correctly advertises it. See canonicalMcpResourceUrl in origin-policy.ts.
  const resourceUrl = canonicalMcpResourceUrl(request.url);
  const gate = requireBearerAuth({
    verifier: createProductLabOAuthTokenVerifier(config),
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceUrl),
  });

  const authInfoOrResponse = await gate(request);
  if (authInfoOrResponse instanceof Response) {
    return authInfoOrResponse;
  }
  return handler.fetch(request, { authInfo: authInfoOrResponse });
}

export { handle as DELETE, handle as GET, handle as POST };
