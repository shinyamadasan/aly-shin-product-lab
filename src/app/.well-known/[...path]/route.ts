// Product Lab MCP Slice 2.1A -- OAuth discovery documents for the remote MCP endpoint, Next.js adapter.
//
// TASK-073: a thin adapter over scripts/product-lab-mcp/oauth-discovery.ts, which the Cloudflare
// Worker serves too. Supabase remains the authorization server; this route never issues or verifies
// a token.
import { handleProductLabOAuthDiscoveryRequest } from "../../../../scripts/product-lab-mcp/oauth-discovery.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request): Promise<Response> {
  return handleProductLabOAuthDiscoveryRequest(request);
}
