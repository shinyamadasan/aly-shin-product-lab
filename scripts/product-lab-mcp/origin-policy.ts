import { localhostAllowedHostnames } from "@modelcontextprotocol/server";

// Product Lab MCP Slice 2.1A -- the Host/Origin allowlist for the remote MCP endpoint.
// Netlify Migration Slice 1 -- made platform-neutral; see below.
//
// @modelcontextprotocol/server's own createMcpHandler documentation says the entry is "deliberately
// validation-free" for Host/Origin and expects the mounting app to put this in front of it. This is
// that allowlist, kept a pure function of the environment so it is directly testable and so the
// route handler stays a thin composition of SDK-provided checks (hostHeaderValidationResponse /
// originValidationResponse) rather than a hand-rolled security layer.
//
// WHY THIS MUST NEVER HARDCODE A HOSTNAME, AND WHY IT GATES ON NODE_ENV, NOT ON A PLATFORM VAR.
//
// An earlier version of this file trusted localhost whenever `VERCEL` was unset. That is backwards
// once a second host enters the picture: `VERCEL` is *only* ever set by Vercel's own build, so
// "unset" is true for local dev AND for every other platform's production deployment (Netlify
// included) -- meaning a non-Vercel production deployment would have silently inherited localhost
// trust. Local-vs-deployed must instead come from a signal every platform sets the same way.
// NODE_ENV is that signal: Next.js itself forces NODE_ENV=production for any `next build`/`next
// start` output regardless of host (Vercel, Netlify, or a bare server), and sets it to
// "development" for `next dev`; nothing in an inbound request can influence it. Gating localhost
// inclusion on NODE_ENV !== "production" therefore keeps every real deployment closed while leaving
// local development and this repo's in-process route tests (which don't set NODE_ENV) working
// without a test-only branch in this file.
export type OriginPolicyEnv = Record<string, string | undefined>;

function hostnameFromUrl(url: string): string | undefined {
  try {
    return new URL(url).hostname || undefined;
  } catch {
    return undefined;
  }
}

export function allowedMcpHostnames(
  env: OriginPolicyEnv = process.env,
  localAllowlist: () => string[] = localhostAllowedHostnames,
): string[] {
  const hostnames = new Set<string>();
  if (env.NODE_ENV !== "production") {
    for (const hostname of localAllowlist()) hostnames.add(hostname);
  }
  // Vercel's own env vars, not attacker-controlled request data: VERCEL_URL is this exact
  // deployment's unique hostname (covers preview deployments too); VERCEL_PROJECT_PRODUCTION_URL is
  // the project's assigned production domain.
  if (env.VERCEL_URL) hostnames.add(env.VERCEL_URL);
  if (env.VERCEL_PROJECT_PRODUCTION_URL) hostnames.add(env.VERCEL_PROJECT_PRODUCTION_URL);
  // Netlify's own build-provided production site URL (a full URL, unlike Vercel's bare-hostname
  // vars, so it needs parsing down to a hostname). Netlify does not guarantee build-scoped vars like
  // `URL` reach a Function at request time unless the site explicitly scopes them to Functions, so
  // this is a best-effort addition, not the primary mechanism -- PRODUCT_LAB_MCP_PUBLIC_HOSTNAME
  // below is what an operator should actually configure for the deployed Netlify hostname.
  if (env.URL) {
    const hostname = hostnameFromUrl(env.URL);
    if (hostname) hostnames.add(hostname);
  }
  // Escape hatch for a custom domain a platform's own env vars do not cover (e.g. a domain not yet
  // set as the project's primary production domain, or a platform whose runtime doesn't forward its
  // build-time URL var to Functions). Operator-configured, not derived from the request.
  if (env.PRODUCT_LAB_MCP_PUBLIC_HOSTNAME) hostnames.add(env.PRODUCT_LAB_MCP_PUBLIC_HOSTNAME);
  return [...hostnames];
}

// The canonical `/api/mcp` resource URL this deployment must advertise -- shared by RFC 9728
// discovery (src/app/.well-known/[...path]/route.ts) and the WWW-Authenticate challenge the bearer
// gate issues on a 401 (src/app/api/mcp/route.ts). Both call sites must agree, or an OAuth client's
// discovery step and its 401 challenge point at two different origins -- exactly the Netlify
// custom-domain mismatch (challenge naming the underlying *.netlify.app hostname instead of the
// configured custom domain) this function exists to prevent. Never derived from Host,
// X-Forwarded-Host, or any other inbound header: only the operator-configured
// PRODUCT_LAB_MCP_PUBLIC_HOSTNAME (the same trusted variable allowedMcpHostnames above allowlists)
// or, absent that, `requestUrl` itself, which keeps local/dev and platforms without an explicit
// override working exactly as before this existed.
export function canonicalMcpResourceUrl(requestUrl: string, env: OriginPolicyEnv = process.env): URL {
  const publicHostname = env.PRODUCT_LAB_MCP_PUBLIC_HOSTNAME;
  const resourceUrl = publicHostname ? new URL(`https://${publicHostname}/api/mcp`) : new URL(requestUrl);
  resourceUrl.pathname = "/api/mcp";
  resourceUrl.search = "";
  return resourceUrl;
}
