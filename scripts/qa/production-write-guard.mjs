// FAIL-CLOSED guard for browser QA against anything connected to the PRODUCTION Supabase project.
//
// Incident, 2026-10-20: a smoke test written for a build WITH a refund confirmation was run against production, which had
// none. Each "dismiss the dialog" click therefore recorded a real refund. The rule that follows: a QA script may never
// send a mutation to the production Supabase project, whichever app URL it is driving (production, a Netlify draft, or a
// local server that happens to be configured with production keys).
//
// Direct production writes AND non-read app/preview/function requests are blocked. Browser routing cannot inspect
// a function's server-side egress, so allowing a preview POST would defeat the production-host check.
//
// Usage (Playwright):
//   import { createGuardedContext } from "./production-write-guard.mjs";
//   const { context, guard } = await createGuardedContext(browser, process.env.OWNER_SUPABASE_URL);
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
export function decideRequest({ method, url }, productionHost, disposableSupabaseOrigin) {
  if (!productionHost) return { allow: false, reason: "no production host configured (fail closed)" };
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { allow: false, reason: "unparseable URL (fail closed)" };
  }
  const m = String(method).toUpperCase();
  if (SAFE_METHODS.has(m)) return { allow: true, reason: "read-only request" };
  if (parsed.host === productionHost && ALLOWED_WRITES.some((rule) => rule.method === m && rule.path.test(parsed.pathname))) return { allow: true, reason: "sign-in/out or owner check" };
  if (disposableSupabaseOrigin && parsed.origin === disposableSupabaseOrigin
      && parsed.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)
      && parsed.host !== productionHost && /^\/(auth|rest|storage)\/v1\//.test(parsed.pathname)) {
    return { allow: true, reason: "explicit disposable Supabase backend" };
  }
  return { allow: false, reason: `${m} ${parsed.pathname} could mutate production directly or through a server function` };
}

export async function installProductionWriteGuard(context, supabaseUrl, { disposableSupabaseUrl } = {}) {
  const productionHost = productionHostOf(supabaseUrl);
  const disposable = disposableSupabaseUrl ? new URL(disposableSupabaseUrl) : undefined;
  const disposableSupabaseOrigin = disposable?.origin;
  if (disposable && (disposable.protocol !== "http:"
      || !["127.0.0.1", "localhost", "[::1]"].includes(disposable.hostname)
      || disposable.host === productionHost)) {
    throw new Error("production-write-guard: disposable backend must be a separate loopback HTTP origin");
  }
  const blocked = [];
  await context.route("**/*", (route) => {
    const request = route.request();
    const decision = decideRequest({ method: request.method(), url: request.url() }, productionHost, disposableSupabaseOrigin);
    if (decision.allow) return route.continue();
    blocked.push(decision.reason);
    return route.abort("blockedbyclient");
  });
  return { blocked, productionHost };
}

// Own context creation so service workers cannot intercept requests before Playwright's routes.
export async function createGuardedContext(browser, supabaseUrl, options = {}, guardOptions = {}) {
  const context = await browser.newContext({ ...options, serviceWorkers: "block" });
  const guard = await installProductionWriteGuard(context, supabaseUrl, guardOptions);
  return { context, guard };
}
