// Product Lab remote MCP -- Cloudflare Worker entrypoint (TASK-073).
//
// The Worker is ONLY the remote HTTP MCP resource server. Supabase remains the OAuth 2.1
// authorization server, the user/token authority, the RLS/data authority, the durable preview store
// and the inventory mutation authority. Every route below delegates to the same platform-neutral
// handlers the Next.js routes use (scripts/product-lab-mcp/http-handler.ts and oauth-discovery.ts); no
// request is proxied to the web app and no tool logic lives here.
//
// STATELESS: each request builds a fresh request-scoped MCP server and keeps preview state in
// Supabase, so no Durable Object is needed. The Worker's ephemeral filesystem is never used.
import { handleProductLabMcpRequest } from "../../scripts/product-lab-mcp/http-handler.ts";
import { handleProductLabOAuthDiscoveryRequest } from "../../scripts/product-lab-mcp/oauth-discovery.ts";

// The only configuration the Worker may receive. Anything else bound to the Worker is deliberately
// not forwarded, so a stray binding can never widen the Host allowlist (origin-policy.ts also trusts
// VERCEL_URL / URL) or fall back to the NEXT_PUBLIC_* keys.
const FORWARDED_BINDINGS = [
  "PRODUCT_LAB_SUPABASE_URL",
  "PRODUCT_LAB_SUPABASE_PUBLISHABLE_KEY",
  "PRODUCT_LAB_MCP_PUBLIC_HOSTNAME",
] as const;

// NODE_ENV is forced, not read: origin-policy.ts trusts localhost whenever NODE_ENV !== "production",
// and a Worker has no NODE_ENV unless one is configured. Leaving it to configuration would make
// "forgot a var" fail OPEN to localhost Host/Origin trust instead of closed.
function workerEnv(bindings: Record<string, unknown>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { NODE_ENV: "production" };
  for (const name of FORWARDED_BINDINGS) {
    const value = bindings[name];
    if (typeof value === "string") env[name] = value;
  }
  return env;
}

const MCP_PATH = "/api/mcp";
const MCP_METHODS = ["GET", "POST", "DELETE"];
const DISCOVERY_PATHS = new Set([
  "/.well-known/oauth-protected-resource/api/mcp",
  "/.well-known/oauth-authorization-server",
]);
const DISCOVERY_METHODS = ["GET"];

function methodNotAllowed(allowed: string[]): Response {
  return new Response("Method not allowed", { status: 405, headers: { allow: allowed.join(", ") } });
}

const worker = {
  async fetch(request: Request, bindings: Record<string, unknown>): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (pathname === MCP_PATH) {
      if (!MCP_METHODS.includes(request.method)) return methodNotAllowed(MCP_METHODS);
      return handleProductLabMcpRequest(request, workerEnv(bindings));
    }

    if (DISCOVERY_PATHS.has(pathname)) {
      if (!DISCOVERY_METHODS.includes(request.method)) return methodNotAllowed(DISCOVERY_METHODS);
      return handleProductLabOAuthDiscoveryRequest(request, workerEnv(bindings));
    }

    return new Response("Not found", { status: 404 });
  },
};

export default worker;
