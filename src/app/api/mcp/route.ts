// Product Lab MCP Slice 2.1A -- the remote Streamable HTTP MCP endpoint, Next.js adapter.
//
// TASK-073: this is now a thin adapter. All transport composition (Host/Origin validation, the
// Supabase-OAuth bearer gate, the request-scoped five-tool registry) lives in
// scripts/product-lab-mcp/http-handler.ts, which the Cloudflare Worker
// (workers/product-lab-mcp/index.ts) calls too. This route remains present as a rollback path that is
// usable only while the web host is operational -- see docs/PRODUCT_LAB_MCP.md.
import { handleProductLabMcpRequest } from "../../../../scripts/product-lab-mcp/http-handler.ts";

export const runtime = "nodejs";
// Every response depends entirely on the caller's own bearer token; nothing here may be cached.
export const dynamic = "force-dynamic";

function handle(request: Request): Promise<Response> {
  return handleProductLabMcpRequest(request);
}

export { handle as DELETE, handle as GET, handle as POST };
