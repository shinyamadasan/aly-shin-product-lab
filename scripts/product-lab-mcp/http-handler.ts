// Product Lab MCP -- the platform-neutral remote Streamable HTTP MCP request handler.
//
// Extracted from src/app/api/mcp/route.ts (TASK-073) so the Next.js route and the Cloudflare Worker
// (workers/product-lab-mcp/index.ts) run the EXACT SAME implementation: one tool registry
// (scripts/product-lab-mcp/mcp-server.ts createProductLabMcpServer), one auth gate, one Host/Origin
// policy. Nothing in this file knows which platform is calling it -- it takes a web-standard Request
// and returns a web-standard Response.
//
// This is a transport/hosting seam only. The five tools, their approval rules, the Supabase OAuth
// authority, RLS, and the durable preview store are unchanged; see docs/PRODUCT_LAB_MCP.md.
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
import { ProductLabError, readProductLabProjectConfig } from "../product-lab/auth.ts";
import { createInventoryCountServiceForClient } from "../product-lab/inventory-count-service.ts";
import { createProductLabMcpServer } from "./mcp-server.ts";
import { allowedMcpHostnames, canonicalMcpResourceUrl } from "./origin-policy.ts";
import { createProductLabOAuthTokenVerifier, ownerContextFromAuthInfo } from "./remote-auth.ts";
import { createProductLabReadServiceForClient } from "../product-lab/read-service.ts";

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

// `env` is read at call time, not module load, so a host that only exposes configuration per request
// (a Worker's bindings) and a host that exposes it ambiently (Node's process.env, the default) both
// work without this file knowing which one it is running on.
export async function handleProductLabMcpRequest(
  request: Request,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Response> {
  let config;
  try {
    config = readProductLabProjectConfig(env);
  } catch (error) {
    if (error instanceof ProductLabError) return configurationErrorResponse();
    throw error;
  }

  const allowedHostnames = allowedMcpHostnames(env);
  const hostRejection = hostHeaderValidationResponse(request, allowedHostnames);
  if (hostRejection) return hostRejection;
  const originRejection = originValidationResponse(request, allowedHostnames);
  if (originRejection) return originRejection;

  // Must agree with the RFC 9728 discovery document (oauth-discovery.ts) or an OAuth client's
  // discovery step and this 401 challenge point at two different origins -- e.g. Netlify's underlying
  // *.netlify.app hostname leaking into the challenge on a custom domain even though discovery
  // correctly advertises it. See canonicalMcpResourceUrl in origin-policy.ts.
  const resourceUrl = canonicalMcpResourceUrl(request.url, env);
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
