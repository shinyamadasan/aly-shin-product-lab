// FAIL-CLOSED guard for browser QA against anything connected to the PRODUCTION Supabase project.
//
// Incident, 2026-10-20: a smoke test written for a build WITH a refund confirmation was run against production, which had
// none. Each "dismiss the dialog" click therefore recorded a real refund. The rule that follows: a QA script may never
// send a mutation to the production Supabase project, whichever app URL it is driving (production, a Netlify draft, or a
// local server that happens to be configured with production keys).
//
// The decision is made on the SUPABASE host the request is going to, not on the app host, so a preview deployment that
// was built with production environment variables is covered too.
//
// Usage (Playwright):
//   import { installProductionWriteGuard } from "./production-write-guard.mjs";
//   const guard = await installProductionWriteGuard(context, process.env.OWNER_SUPABASE_URL);
//   ...run the test...
//   if (guard.blocked.length) fail the run   // an attempted write is a test bug even though it was stopped
//
// Anything not explicitly allowed is blocked. Read-only requests (GET/HEAD/OPTIONS) always pass.

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// The ONLY non-read requests permitted to the production project:
//   - signing in and out (a token exchange writes nothing to the business tables);
//   - the pure STABLE owner check the app makes on load.
const ALLOWED_WRITES = [
  { method: "POST", path: /^\/auth\/v1\/token$/ },
  { method: "POST", path: /^\/auth\/v1\/logout$/ },
  { method: "POST", path: /^\/rest\/v1\/rpc\/is_product_lab_owner$/ },
];

export function productionHostOf(supabaseUrl) {
  if (!supabaseUrl) throw new Error("production-write-guard: the production Supabase URL is required (fail closed)");
  return new URL(supabaseUrl).host;
}

// Pure decision, unit-tested. Returns { allow: boolean, reason: string }.
export function decideRequest({ method, url }, productionHost) {
  if (!productionHost) return { allow: false, reason: "no production host configured (fail closed)" };
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { allow: false, reason: "unparseable URL (fail closed)" };
  }
  if (parsed.host !== productionHost) return { allow: true, reason: "not the production Supabase project" };
  const m = String(method).toUpperCase();
  if (SAFE_METHODS.has(m)) return { allow: true, reason: "read-only request" };
  if (ALLOWED_WRITES.some((rule) => rule.method === m && rule.path.test(parsed.pathname))) return { allow: true, reason: "sign-in/out or owner check" };
  return { allow: false, reason: `${m} ${parsed.pathname} would mutate the production project` };
}

export async function installProductionWriteGuard(context, supabaseUrl) {
  const productionHost = productionHostOf(supabaseUrl);
  const blocked = [];
  await context.route("**/*", (route) => {
    const request = route.request();
    const decision = decideRequest({ method: request.method(), url: request.url() }, productionHost);
    if (decision.allow) return route.continue();
    blocked.push(decision.reason);
    return route.abort("blockedbyclient");
  });
  return { blocked, productionHost };
}
