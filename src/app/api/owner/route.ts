// Wave B -- the owner-authorization check for the Product Lab application surface.
//
// WHY THIS EXISTS.
//
// Until now the app had exactly one gate: ProductLab renders LoginScreen unless there is a Supabase
// session. That is AUTHENTICATION, not OWNERSHIP, and the difference is load-bearing here, because
// this project deliberately has a SECOND authenticated principal -- the public-order website user in
// supabase-server.ts -- plus any other user that exists in the Supabase project. Every one of them
// holds the ordinary `authenticated` role, and every table in this schema grants that role
// `using (true)`. So "signed in" has never meant "the owner".
//
// The rule itself is NOT new and is NOT re-invented here: PRODUCTION_OWNER_EMAILS and
// isProductionOwner already exist and already gate /api/production. This route is the same decision,
// asked by the application shell instead of by the production endpoint, so there is one owner rule
// in this codebase rather than two that can drift apart.
//
// WHY A SERVER ROUTE AND NOT A CHECK IN THE BROWSER.
//
// Because a check in the browser decides nothing. The allowlist is server-only (no NEXT_PUBLIC_
// prefix, so Next.js never inlines it into a client bundle), and the caller's token is verified by a
// real round trip to the auth server inside authenticateOwner -- an expired, revoked, tampered or
// invented JWT fails there. The browser presents a token; the SERVER answers who that token belongs
// to and whether they are the owner.
//
// WHAT THIS DOES NOT DO, STATED PLAINLY.
//
// It gates the APPLICATION SURFACE, not the database. Every table this app reads is still
// `grant ... to authenticated` + `using (true)`, so a non-owner authenticated principal holding the
// public anon key can still query PostgREST directly and read Creative Packages without ever loading
// this app. Closing that is an RLS change, not an application change, and it is deliberately not in
// this slice. Do not read this route as a data boundary.

import { authenticateOwner, isProductionOwner } from "@/lib/production-auth-server";

export const runtime = "nodejs";
// Never cached: the answer depends entirely on the caller's own bearer token.
export const dynamic = "force-dynamic";

// Same public error contract as /api/production: no auth error text, no environment VALUE, and
// never the allowlist itself. A caller learns whether THEY are the owner and nothing else -- in
// particular, not who is.
function answer(status: number, body: { owner: boolean; reason: string }): Response {
  return Response.json(body, { status });
}

export async function GET(request: Request): Promise<Response> {
  const auth = await authenticateOwner(request);

  if (!auth.ok) {
    if (auth.reason === "not-configured") {
      // No Supabase configured at all. The app is in local browser-only mode, where there is no
      // session, no principal and nothing to gate -- ProductLab's own isSupabaseConfigured check
      // already handles that path and never calls this route.
      return answer(503, { owner: false, reason: "not-configured" });
    }
    // missing-token and invalid-token answer identically, exactly as /api/production does: probing
    // the difference must not reveal whether a token was absent or actually rejected.
    return answer(401, { owner: false, reason: "unauthorized" });
  }

  if (!isProductionOwner(auth.principal)) {
    return answer(403, { owner: false, reason: "forbidden" });
  }

  return answer(200, { owner: true, reason: "owner" });
}
