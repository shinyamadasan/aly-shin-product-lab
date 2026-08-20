import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { resolveOwnerAccess } from "../src/lib/owner-access.ts";
import { authenticateOwnerWith, isProductionOwner } from "../src/lib/production-auth.ts";

// Wave B -- the Saved Creatives authorization boundary.
//
// THE INVARIANT UNDER TEST: being authenticated is not being the owner.
//
// Every table this app reads is `grant ... to authenticated` plus a policy of `using (true)`, so the
// DATABASE cannot tell two signed-in principals apart -- and this project deliberately has more than
// one (the public-order website user in supabase-server.ts). Until now the application shell agreed
// with the database: its only gate was "is there a session". These tests hold the new gate in place.
//
// What they do NOT claim: that a non-owner cannot read creative_packages at all. They cannot claim
// that, because it is not true -- see the final test, which pins that limitation in writing rather
// than letting it be quietly forgotten.

const productLabSource = readFileSync(new URL("../src/app/product-lab.tsx", import.meta.url), "utf8");
const ownerRouteSource = readFileSync(new URL("../src/app/api/owner/route.ts", import.meta.url), "utf8");
const savedCreativesSource = readFileSync(new URL("../src/components/saved-creatives.tsx", import.meta.url), "utf8");
const historySource = readFileSync(new URL("../src/lib/creative-history.ts", import.meta.url), "utf8");

// --- the verdict rule, fail-closed ------------------------------------------------------------------

test("only an explicit server 'owner: true' grants access", () => {
  assert.equal(resolveOwnerAccess({ kind: "response", status: 200, body: { owner: true, reason: "owner" } }), "owner");
});

test("every other answer is refused or unusable -- never a grant", () => {
  const cases: Array<[Parameters<typeof resolveOwnerAccess>[0], string]> = [
    // Real verdicts about the caller.
    [{ kind: "response", status: 401, body: { owner: false } }, "denied"],
    [{ kind: "response", status: 403, body: { owner: false } }, "denied"],
    // Not verdicts at all.
    [{ kind: "response", status: 503, body: { owner: false } }, "unavailable"],
    [{ kind: "response", status: 500, body: null }, "unavailable"],
    [{ kind: "unreachable" }, "unavailable"],
    // 200 is not enough on its own. A proxy, captive portal or rewritten route can answer 200 with
    // anything; the gate must depend on the SERVER's answer, not the network's honesty.
    [{ kind: "response", status: 200, body: { owner: false } }, "unavailable"],
    [{ kind: "response", status: 200, body: {} }, "unavailable"],
    [{ kind: "response", status: 200, body: null }, "unavailable"],
    [{ kind: "response", status: 200, body: "owner" }, "unavailable"],
    [{ kind: "response", status: 200, body: [{ owner: true }] }, "unavailable"],
    // Truthy-but-not-true must not slip through a loose comparison.
    [{ kind: "response", status: 200, body: { owner: "true" } }, "unavailable"],
    [{ kind: "response", status: 200, body: { owner: 1 } }, "unavailable"],
  ];

  for (const [outcome, expected] of cases) {
    assert.equal(resolveOwnerAccess(outcome), expected, `${JSON.stringify(outcome)} must resolve to ${expected}`);
  }
});

// --- 4. a non-owner authenticated principal ------------------------------------------------------------

test("4: a verified, genuinely authenticated NON-OWNER principal is refused", async () => {
  // A real token, a real user, a real round trip that succeeds. Authentication passes completely --
  // this is exactly the principal the old gate would have admitted.
  const auth = await authenticateOwnerWith(
    { headers: { get: (name: string) => (name.toLowerCase() === "authorization" ? "Bearer real-token-for-the-website-account" : null) } },
    {
      createClient: () => ({}),
      // Exactly the shape the LIVE public-order principal returns today: app_metadata is present,
      // but carries only Supabase's own provider keys and no app_role.
      getUser: async () => ({ id: "website-user", email: "website@alyandshin.test", appMetadata: { provider: "email", providers: ["email"] } }),
    },
  );

  assert.equal(auth.ok, true, "the non-owner is genuinely authenticated -- that is the point");
  if (!auth.ok) return;

  assert.equal(auth.principal.appRole, null);
  assert.equal(isProductionOwner(auth.principal), false);

  // And that refusal is what the shell receives, so Content Studio never renders.
  assert.equal(resolveOwnerAccess({ kind: "response", status: 403, body: { owner: false, reason: "forbidden" } }), "denied");
});

test("4: only the owner claim is admitted -- and the worker principal is not the owner", async () => {
  const owner = await authenticateOwnerWith(
    { headers: { get: () => "Bearer owner-token" } },
    { createClient: () => ({}), getUser: async () => ({ id: "owner-user", email: "o@x.test", appMetadata: { provider: "email", app_role: "owner" } }) },
  );
  assert.equal(owner.ok, true);
  if (owner.ok) assert.equal(isProductionOwner(owner.principal), true);

  // The advisor/worker automation principal signs in with its own credentials and writes Creative
  // Packages and Assets. It is emphatically NOT the owner, and must never open the owner surface.
  const worker = await authenticateOwnerWith(
    { headers: { get: () => "Bearer worker-token" } },
    { createClient: () => ({}), getUser: async () => ({ id: "worker-user", email: "w@x.test", appMetadata: { app_role: "creative_worker" } }) },
  );
  assert.equal(worker.ok, true);
  if (worker.ok) assert.equal(isProductionOwner(worker.principal), false);
});

// --- 5. anonymous ---------------------------------------------------------------------------------------

test("5: an anonymous caller never reaches a principal at all", async () => {
  for (const header of [null, "", "Basic abc", "Bearer", "Bearer    "]) {
    const auth = await authenticateOwnerWith(
      { headers: { get: () => header } },
      { createClient: () => ({}), getUser: async () => ({ id: "u", email: "owner@alyandshin.test", appMetadata: { app_role: "owner" } }) },
    );
    assert.equal(auth.ok, false, `"${header}" must not authenticate`);
  }

  // A token that does not verify is refused even though it was well-formed.
  const invalid = await authenticateOwnerWith(
    { headers: { get: () => "Bearer forged" } },
    { createClient: () => ({}), getUser: async () => null },
  );
  assert.equal(invalid.ok, false);
});

// --- the gate is wired at the shell, before any view --------------------------------------------------------

test("the owner gate runs after authentication and BEFORE any view renders", () => {
  const loginGate = productLabSource.indexOf("return <LoginScreen message={message} signIn={signIn} />;");
  const ownerGate = productLabSource.indexOf('ownerAccess !== "owner"');
  const appShell = productLabSource.indexOf("<AppShell navigationConfirmationMessage=");

  assert.ok(loginGate > 0 && ownerGate > 0 && appShell > 0);
  assert.ok(loginGate < ownerGate, "authentication is checked first");
  assert.ok(ownerGate < appShell, "authorization is checked before any view is rendered");
});

test("the gate covers the whole shell, not just Content Studio", () => {
  // Saved Creatives is not a special surface: Today reopens the same packages via ?job=, and
  // Opportunities renders the same jobs. A per-screen gate would look protective while the screen
  // next door served the same rows, so the gate must sit above the view switch -- which the ordering
  // test above proves -- and must not be duplicated inside any single view.
  const contentStudio = productLabSource.slice(productLabSource.indexOf("function ContentStudio("));
  assert.equal(/ownerAccess|isProductionOwner|PRODUCTION_OWNER_EMAILS/.test(contentStudio), false);
});

test("the shell holds no client-side owner filter -- the verdict is the server's", () => {
  const statements = productLabSource
    .split("\n")
    .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
    .join("\n");

  // No allowlist, no email comparison, and no owner address anywhere in the client bundle.
  assert.equal(statements.includes("PRODUCTION_OWNER_EMAILS"), false);
  assert.equal(/NEXT_PUBLIC_[A-Z_]*OWNER/.test(statements), false);
  assert.equal(/session[?.]*\.user[?.]*\.email\s*===/.test(statements), false);
  assert.equal(/isProductionOwner/.test(statements), false);
  // It must not import the credential-holding module either (already asserted for the production
  // slice; restated here because this change is what added an auth concern to this file).
  assert.equal(productLabSource.includes("production-auth-server"), false);

  // It asks the server, presenting its own token.
  assert.match(statements, /fetch\("\/api\/owner", \{ headers: \{ Authorization: `Bearer \$\{accessToken\}` \} \}\)/);
});

// --- the route composes BOTH checks --------------------------------------------------------------------------

test("/api/owner authenticates first, then applies the existing owner rule", () => {
  const authAt = ownerRouteSource.indexOf("await authenticateOwner(request)");
  const ownerAt = ownerRouteSource.indexOf("isProductionOwner(auth.principal)");
  const grantAt = ownerRouteSource.indexOf("owner: true");

  assert.ok(authAt > 0 && ownerAt > 0 && grantAt > 0);
  assert.ok(authAt < ownerAt, "the token is verified before the allowlist is consulted");
  assert.ok(ownerAt < grantAt, "nothing is granted before both checks have passed");

  // It reuses the existing rule rather than restating it: no second allowlist, no second parser.
  // Comments are stripped first -- the header explains WHY the allowlist lives elsewhere, and a
  // prose mention of it is not a second implementation of it.
  const statements = ownerRouteSource
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
  assert.match(statements, /from "@\/lib\/production-auth-server"/);
  assert.equal(statements.includes("PRODUCTION_OWNER_EMAILS"), false);

  // Never cached -- the answer depends entirely on the caller's own token.
  assert.match(ownerRouteSource, /export const dynamic = "force-dynamic";/);
});

test("/api/owner tells a caller only about itself", () => {
  // No email, no allowlist, no auth error text, no user id in any response body.
  // Asserted as an exact KEY SET rather than by forbidden substrings: "forbidden" contains "id",
  // and a check that can be tripped by its own vocabulary proves nothing.
  const bodies = [...ownerRouteSource.matchAll(/answer\(\d+, \{([^}]*)\}\)/g)].map((match) => match[1]);
  assert.ok(bodies.length >= 3);
  for (const body of bodies) {
    const keys = body
      .split(",")
      .map((entry) => entry.split(":")[0].trim())
      .filter(Boolean)
      .sort();
    assert.deepEqual(keys, ["owner", "reason"], `the response body must carry only owner and reason, got: ${body}`);
  }
});

// --- 6. existing owner flows are unchanged ----------------------------------------------------------------------

test("6: the gate is now closed by default -- an unconfigured project admits nobody", () => {
  // The DELIBERATE behaviour change from the previous slice. PRODUCTION_OWNER_EMAILS defaulted to
  // OPEN when unset, which is exactly how the gate came to be effectively disabled in the live
  // project. There is no such default any more: until the owner claim is assigned, every principal
  // -- including the human owner -- is refused. That is the correct direction for a gate to fail,
  // and it is why the owner must assign the claim and re-authenticate before acceptance.
  assert.equal(isProductionOwner({ appRole: null }), false);
  assert.equal(resolveOwnerAccess({ kind: "response", status: 403, body: { owner: false, reason: "forbidden" } }), "denied");

  // With the claim assigned, the shell falls through to the app.
  assert.equal(isProductionOwner({ appRole: "owner" }), true);
  assert.equal(resolveOwnerAccess({ kind: "response", status: 200, body: { owner: true, reason: "owner" } }), "owner");
});

test("6: the production endpoints keep their own gate -- this one did not replace it", () => {
  for (const path of ["../src/app/api/production/route.ts", "../src/app/api/production/manual/route.ts"]) {
    const route = readFileSync(new URL(path, import.meta.url), "utf8");
    assert.match(route, /await authenticateOwner\(request\)/);
    assert.match(route, /isProductionOwner\(auth\.principal\)/);
  }
});

// --- the history slice itself is unchanged and still carries no auth ---------------------------------------

test("6: the fix stayed at the auth boundary -- creative-history.ts holds no authorization code", () => {
  for (const source of [historySource, savedCreativesSource]) {
    assert.equal(/isProductionOwner|PRODUCTION_OWNER_EMAILS|authenticateOwner|\/api\/owner/.test(source), false);
  }
  // And still cannot write anything.
  assert.equal(/\.insert\(|\.update\(|\.delete\(|\.rpc\(/.test(historySource), false);
});

// --- the honest limit ------------------------------------------------------------------------------------------

test("the boundary is the APPLICATION SURFACE, not the database -- pinned so it is not forgotten", () => {
  // Every one of these tables grants the whole `authenticated` role blanket access. A non-owner
  // authenticated principal holding the public anon key can still read them straight from PostgREST
  // without ever loading this app. Closing THAT is an RLS change, not an application change, and it
  // is deliberately not in this slice.
  //
  // This test exists so that if someone later tightens RLS, it fails and forces the claim above to
  // be rewritten -- rather than the app quietly keeping a comment that says the gap is still open.
  for (const file of ["creative-jobs", "creative-packages", "asset-jobs", "assets"]) {
    const sql = readFileSync(new URL(`../supabase-add-${file}.sql`, import.meta.url), "utf8");
    assert.match(sql, /to authenticated[\s\S]{0,40}using \(true\)/, `${file} is still role-scoped, not owner-scoped`);
  }

  // The route says so in its own header, so a reader of the code cannot mistake it for a data gate.
  assert.match(ownerRouteSource, /gates the APPLICATION SURFACE, not the database/);
});
