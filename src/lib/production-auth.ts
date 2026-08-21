// Production MVP Wave B -- the owner-authorization RULES, with no credential and no framework.
//
// Split out of production-auth-server.ts deliberately. That module carries `import "server-only"`,
// which is exactly what should happen to anything holding a credential -- but it also makes the
// module unimportable outside Next, so every rule inside it could only ever be checked by reading
// its source as text. These are the decisions worth testing for real (does a malformed header yield
// a token? is a non-owner refused?), so they live here, are pure, and are executed by the suite.
//
// Nothing in this file reads process.env at module scope, constructs a client, or knows a secret.

export type AuthenticatedUser = {
  id: string;
  email: string;
  // The authorization claim, read from Supabase Auth's app_metadata. Null means the claim is
  // absent, unreadable, or not a string -- all of which are the same thing to every caller: NOT the
  // owner. There is deliberately no "unknown" third state to reason about.
  appRole: string | null;
};

export type OwnerPrincipal<TClient> = AuthenticatedUser & { client: TClient };

export type OwnerAuthResult<TClient> =
  | { ok: true; principal: OwnerPrincipal<TClient> }
  | { ok: false; reason: "not-configured" | "missing-token" | "invalid-token" };

// RFC 6750 form only. A token in a query string would end up in server logs and browser history.
export function readBearerToken(request: { headers: { get(name: string): string | null } }): string | null {
  const header = request.headers.get("authorization") ?? request.headers.get("Authorization");
  if (!header) {
    return null;
  }
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const token = match?.[1]?.trim();
  return token && token.length > 0 ? token : null;
}

// The client this needs is described by what it must do, not by which library provides it: build a
// client for a token, and ask that client who the token belongs to.
export type OwnerAuthDeps<TClient> = {
  createClient: (accessToken: string) => TClient;
  // appMetadata is passed through RAW and parsed here by readAppRole, so the rule about what counts
  // as a valid claim lives in one testable place rather than in whichever adapter fetched the user.
  getUser: (
    client: TClient,
    accessToken: string,
  ) => Promise<{ id: string; email: string | null; appMetadata: unknown } | null>;
};

// Verifies the presented token BEFORE anything else happens.
//
// getUser is a real round trip to the auth server, not a local decode: an expired, revoked, tampered
// or simply invented JWT fails here, so an unauthenticated caller never reaches an executor, a
// provider credential, or anyone else's Asset Job.
export async function authenticateOwnerWith<TClient>(
  request: { headers: { get(name: string): string | null } },
  deps: OwnerAuthDeps<TClient>,
): Promise<OwnerAuthResult<TClient>> {
  const token = readBearerToken(request);
  if (!token) {
    return { ok: false, reason: "missing-token" };
  }

  const client = deps.createClient(token);
  let user: { id: string; email: string | null; appMetadata: unknown } | null;
  try {
    user = await deps.getUser(client, token);
  } catch {
    return { ok: false, reason: "invalid-token" };
  }
  if (!user) {
    return { ok: false, reason: "invalid-token" };
  }

  return { ok: true, principal: { id: user.id, email: user.email ?? "", appRole: readAppRole(user.appMetadata), client } };
}

// --- who is the owner ---------------------------------------------------------------------------------
//
// ONE authoritative owner CLAIM, carried by Supabase Auth itself.
//
// One claim, not one person. `owner` is a ROLE: a business with co-owners assigns it to each of
// their accounts, and every holder gets identical access -- there is no seniority and no per-account
// ownership of a row anywhere in this system. What matters is that the claim has exactly one
// definition and exactly one place it can be written from. Nothing here counts owners, and neither
// does any policy in the database: `isProductionOwner()` below and `is_product_lab_owner()` in SQL
// are the same equality test. (Corrected by SECURITY S1.2, which removed the stale exactly-one-owner
// assumption from the migration guards and runbooks; runtime behaviour is unchanged.)
//
// WHY app_metadata AND NOT THE THINGS IT REPLACED.
//
//   user_metadata is writable BY THE USER through supabase.auth.updateUser(). Authorizing on it
//   would let any authenticated principal promote itself to owner from the browser. It is user
//   PREFERENCE storage and must never be an authorization input.
//
//   app_metadata is writable only through the Admin API (service-role) or SQL. A principal cannot
//   grant itself this claim, which is the entire property an authorization source needs.
//
//   An email allowlist in the environment (the previous PRODUCTION_OWNER_EMAILS mechanism) was
//   removed rather than kept alongside this. It defaulted to OPEN when unset -- which is exactly how
//   the gate came to be effectively disabled in the live environment -- and it named the owner in a
//   place the DATABASE cannot read, so RLS could never agree with the application about who the
//   owner was. The claim below is readable by both, which is what lets one definition of "owner"
//   govern both layers.
//
// The owner identifier itself appears NOWHERE in this repository: no email, no UUID, no default.
// The claim is assigned once, out of band, against the Supabase project.

export const OWNER_APP_ROLE = "owner";

// The claim path, stated once. The migration reads exactly this path in SQL
// (auth.jwt() -> 'app_metadata' ->> 'app_role'), so the application and the database cannot drift
// apart about where the owner claim lives.
export const OWNER_APP_ROLE_CLAIM_PATH = "app_metadata.app_role";

// Total and defensive. Every non-string, every wrong shape, and every absence collapses to null --
// there is no coercion, no trimming into validity, and no truthiness test anywhere in the path.
//
// In particular a nested object, an array, a number, or the STRING "owner" wrapped in anything else
// all read as null rather than as an owner claim. Malformed metadata must fail closed, and the only
// way to guarantee that is to accept exactly one shape.
export function readAppRole(appMetadata: unknown): string | null {
  if (!appMetadata || typeof appMetadata !== "object" || Array.isArray(appMetadata)) {
    return null;
  }
  const value = (appMetadata as Record<string, unknown>).app_role;
  return typeof value === "string" ? value : null;
}

// The whole authorization decision, in one comparison against one constant.
//
// Exact match, case-sensitively, with no trimming: "Owner", " owner", "owner,admin" and "ownerx"
// are all NOT the owner. A claim written by an administrator through the Admin API is written
// deliberately and exactly; being lenient here would only ever widen the gate.
//
// No environment is read. No default. Absent claim -> false, which is what makes an unconfigured
// project closed rather than open.
export function isProductionOwner(principal: { appRole: string | null }): boolean {
  return principal.appRole === OWNER_APP_ROLE;
}
