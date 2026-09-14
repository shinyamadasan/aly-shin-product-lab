import { localhostAllowedHostnames } from "@modelcontextprotocol/server";

// Product Lab MCP Slice 2.1A -- the Host/Origin allowlist for the remote MCP endpoint.
//
// @modelcontextprotocol/server's own createMcpHandler documentation says the entry is "deliberately
// validation-free" for Host/Origin and expects the mounting app to put this in front of it. This is
// that allowlist, kept a pure function of the environment so it is directly testable and so the
// route handler stays a thin composition of SDK-provided checks (hostHeaderValidationResponse /
// originValidationResponse) rather than a hand-rolled security layer.
//
// WHY THIS MUST NEVER HARDCODE A HOSTNAME.
//
// `VERCEL` is set (to "1") in every Vercel-built environment -- preview deployments and production
// alike -- and is absent for a plain local `next dev`/`node --test` run. Gating localhost inclusion
// on its absence means a production deployment can never end up trusting "localhost" (an attacker
// cannot set VERCEL from outside the platform), while local development and this repo's in-process
// route tests keep working without any test-only branch in this file.
export type OriginPolicyEnv = Record<string, string | undefined>;

export function allowedMcpHostnames(
  env: OriginPolicyEnv = process.env,
  localAllowlist: () => string[] = localhostAllowedHostnames,
): string[] {
  const hostnames = new Set<string>();
  if (!env.VERCEL) {
    for (const hostname of localAllowlist()) hostnames.add(hostname);
  }
  // Vercel's own env vars, not attacker-controlled request data: VERCEL_URL is this exact
  // deployment's unique hostname (covers preview deployments too); VERCEL_PROJECT_PRODUCTION_URL is
  // the project's assigned production domain.
  if (env.VERCEL_URL) hostnames.add(env.VERCEL_URL);
  if (env.VERCEL_PROJECT_PRODUCTION_URL) hostnames.add(env.VERCEL_PROJECT_PRODUCTION_URL);
  // Escape hatch for a custom domain Vercel's own env vars do not cover (e.g. a domain not yet set
  // as the project's primary production domain). Operator-configured, not derived from the request.
  if (env.PRODUCT_LAB_MCP_PUBLIC_HOSTNAME) hostnames.add(env.PRODUCT_LAB_MCP_PUBLIC_HOSTNAME);
  return [...hostnames];
}
