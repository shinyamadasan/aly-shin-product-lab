import "server-only";

// S9 PR-F2: the server-only Supabase client for the public ordering surface.
//
// See planning/S9_PUBLIC_ORDERING_IMPLEMENTATION_PLAN.md (Revision 3, FROZEN) section 6 Q1.
//
// `import "server-only"` on the first line is the enforcement: importing this module from a client
// component is a BUILD ERROR, not a runtime surprise and not a leak discovered in production. The
// absent NEXT_PUBLIC_ prefix on the credentials below is the second layer, and a test asserts the
// third -- that no "use client" module reaches this file.
//
// WHICH CREDENTIAL, AND WHY NOT service_role.
// This signs in as a dedicated Supabase Auth user holding the ordinary `authenticated` role. That
// is the least-privilege principal that works: prerequisite P1 measured it live -- the account
// reaches save_order and is rejected by the function's OWN validation (P0001), never by the grant
// system (42501, which is still what `anon` receives). No new grant, no anon privilege and no
// service-role key are required, and none is used here.
//
// UPDATED BY SECURITY S1/S1.1. The last clause of this paragraph used to read "since every policy
// in this schema is already `using (true)` for authenticated", which was true when this file was
// written and is the exact condition S1 removed. Every policy is now claim-based, and this account
// holds `app_metadata.app_role = 'public_order'` -- assigned out of band, never stored here.
//
// What that claim buys it is deliberately small: SELECT on the four catalog tables
// public-catalog-repository.ts reads, SELECT + INSERT on `orders` and `order_lines`, and
// SELECT + INSERT + UPDATE on `customers` (the upsert in save_public_order_once needs all three).
// It has no UPDATE on an order, no DELETE anywhere, and no read of any Product Lab business table.
//
// A service-role key would still be the wrong tool, and now for a stronger reason than when this
// was written: it would bypass every one of those policies rather than merely being redundant.
//
// The browser never receives any of this. The public surface talks to a Route Handler; the Route
// Handler talks to Supabase.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
// Server-only. No NEXT_PUBLIC_ prefix, so Next.js will not inline these into any client bundle.
const websiteEmail = process.env.PUBLIC_ORDER_SUPABASE_EMAIL;
const websitePassword = process.env.PUBLIC_ORDER_SUPABASE_PASSWORD;

export const isPublicOrderingConfigured = Boolean(supabaseUrl && supabaseAnonKey && websiteEmail && websitePassword);

// Held in module scope so a warm serverless invocation reuses the session instead of signing in on
// every request. It dies with the instance; nothing is written to disk.
let cachedClient: SupabaseClient | null = null;

function createServerClient(): SupabaseClient {
  return createClient(supabaseUrl!, supabaseAnonKey!, {
    auth: {
      // There is no storage on a server, and a session must never be written anywhere.
      persistSession: false,
      // No background timers in a serverless invocation -- a container can be frozen mid-refresh.
      // Refresh is explicit instead: the caller re-authenticates once on a 401 and retries once.
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}

async function signIn(client: SupabaseClient): Promise<boolean> {
  const { error } = await client.auth.signInWithPassword({ email: websiteEmail!, password: websitePassword! });
  return !error;
}

// Returns a signed-in client, reusing the cached session when there is one.
export async function getPublicOrderClient(): Promise<SupabaseClient | null> {
  if (!isPublicOrderingConfigured) {
    return null;
  }

  if (cachedClient) {
    return cachedClient;
  }

  const client = createServerClient();
  if (!(await signIn(client))) {
    return null;
  }

  cachedClient = client;
  return client;
}

// Runs `operation` against the signed-in client. If it reports an internal failure -- most often a
// session that expired while this instance was warm -- the cached session is dropped, the principal
// re-authenticates ONCE, and the operation is retried ONCE. Never loops: a second failure is
// reported to the caller, which surfaces publicly as generic temporary unavailability.
//
// Retrying is safe because the operation is idempotent by construction: the order id is derived
// from the submitted key, so a retry either finds the order already created (and returns a replay)
// or creates it exactly once.
export async function withPublicOrderClient<T>(operation: (client: SupabaseClient) => Promise<T>, shouldRetry: (result: T) => boolean): Promise<{ ok: true; result: T } | { ok: false }> {
  const client = await getPublicOrderClient();
  if (!client) {
    return { ok: false };
  }

  const first = await operation(client);
  if (!shouldRetry(first)) {
    return { ok: true, result: first };
  }

  // The cached session went stale. Drop it, sign in again, and try exactly one more time.
  cachedClient = null;
  const retryClient = createServerClient();
  if (!(await signIn(retryClient))) {
    return { ok: false };
  }
  cachedClient = retryClient;

  const second = await operation(retryClient);
  return shouldRetry(second) ? { ok: false } : { ok: true, result: second };
}

// Test seam: lets a test reset module-scope state. Not used by application code.
export function __resetPublicOrderClientForTests(): void {
  cachedClient = null;
}
