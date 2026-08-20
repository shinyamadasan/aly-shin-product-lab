import "server-only";

// Production MVP Wave B -- the credential-holding half of the owner-authenticated boundary.
//
// `import "server-only"` on the first line is the enforcement, exactly as supabase-server.ts does:
// importing this module from a client component is a BUILD ERROR, not a leak found in production.
//
// Everything that can be a RULE rather than a credential lives in production-auth.ts, which is pure
// and actually executed by the test suite. This file is only the parts that must touch the
// environment and construct a client.
//
// HOW THIS DIFFERS FROM supabase-server.ts, AND WHY IT HAD TO.
//
// supabase-server.ts serves the PUBLIC ordering surface, where the caller has no credential at all,
// so it signs in as a dedicated machine principal and acts on the customer's behalf. That shape
// would be a real security regression here: a shared principal would mean ANY request reaching this
// route executes production, because the route itself would be the only thing deciding who is
// allowed.
//
// The owner is different -- the owner ALREADY has a Supabase session, created by signInWithPassword
// in the browser. So this module holds NO credential of its own. The browser presents its own access
// token, Supabase verifies it, and every database operation then runs AS THAT USER under the same
// RLS the browser is subject to. No service-role key, no shared password.
//
// The Cloudflare credentials never appear in this file or in any client bundle -- they are read from
// process.env inside the executor, on the server, and are the reason the route exists at all.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { authenticateOwnerWith, isProductionOwner as isProductionOwnerRule, type OwnerAuthResult } from "./production-auth.ts";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

export const isProductionApiConfigured = Boolean(supabaseUrl && supabaseAnonKey);

// Builds a client that ACTS AS the bearer of this token.
//
// The Authorization header is attached globally, so every PostgREST call this client makes carries
// the owner's JWT and is evaluated under the owner's RLS -- not under `anon`, and not under a
// privileged shared identity. persistSession/autoRefreshToken are false for the same reasons
// supabase-server.ts documents: there is no storage on a server, and no safe place for a background
// timer in an invocation that can be frozen mid-refresh.
function createUserScopedClient(accessToken: string): SupabaseClient {
  return createClient(supabaseUrl!, supabaseAnonKey!, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

export async function authenticateOwner(request: Request): Promise<OwnerAuthResult<SupabaseClient>> {
  if (!isProductionApiConfigured) {
    return { ok: false, reason: "not-configured" };
  }

  return authenticateOwnerWith(request, {
    createClient: createUserScopedClient,
    getUser: async (client, accessToken) => {
      const { data, error } = await client.auth.getUser(accessToken);
      // app_metadata comes from getUser -- a verified round trip to the auth server -- and NOT from
      // decoding the presented JWT locally. A token's own payload is only as trustworthy as its
      // signature check, and the whole point of this call is to let the auth server be the one that
      // says who this is and what claim they carry.
      return error || !data.user ? null : { id: data.user.id, email: data.user.email ?? null, appMetadata: data.user.app_metadata };
    },
  });
}

// No environment is consulted any more: the owner claim travels with the principal. This wrapper
// stays only so the two production routes and /api/owner keep importing the same seam they always
// did -- the decision itself is the pure rule in production-auth.ts.
export function isProductionOwner(principal: { appRole: string | null }): boolean {
  return isProductionOwnerRule(principal);
}
