"use client";

// Product Lab MCP Slice 2.1A -- the Supabase OAuth 2.1 Server consent page.
//
// Supabase is the OAuth 2.1 authorization server (see docs/PRODUCT_LAB_MCP.md and
// scripts/product-lab-mcp/remote-auth.ts); this page is only the "authorization UI" it delegates to.
// It does not implement OAuth itself -- the three supabase.auth.oauth.* calls below are Supabase's own
// client methods for the authorization-code flow, and every access decision they act on (approve/deny)
// is Supabase's, not this page's.
//
// WHY THIS REUSES THE EXISTING LOGIN, NOT A NEW ONE.
//
// This page requires the SAME authentication as the rest of Product Lab: a Supabase session created by
// supabase.auth.signInWithPassword (src/app/product-lab.tsx's LoginScreen), checked against the SAME
// owner rule the app shell already enforces via GET /api/owner (src/app/api/owner/route.ts, itself
// authenticateOwner + isProductionOwner from src/lib/production-auth-server.ts /
// src/lib/production-auth.ts). LoginScreen itself is an unexported component local to the monolithic
// product-lab.tsx app shell, so it cannot be imported here; this page reproduces its minimal sign-in
// form (same fields, same call, same visual language) rather than inventing a second auth system.
//
// A non-owner authenticated principal (any other Supabase Auth user in this project) is refused before
// ever seeing an authorization_id, client name, or scope list -- consent is an owner-only decision,
// exactly like every other Product Lab MCP authority.

import { useEffect, useState } from "react";
import type { OAuthAuthorizationDetails } from "@supabase/supabase-js";
import { isSupabaseConfigured, supabase } from "@/lib/supabase";

type Status = "loading" | "signed_out" | "forbidden" | "consent" | "deciding" | "error" | "not_configured";

export default function OAuthConsentPage() {
  const [status, setStatus] = useState<Status>(isSupabaseConfigured ? "loading" : "not_configured");
  const [details, setDetails] = useState<OAuthAuthorizationDetails | null>(null);
  const [errorMessage, setErrorMessage] = useState("");
  const [loginMessage, setLoginMessage] = useState("");

  useEffect(() => {
    if (!isSupabaseConfigured || !supabase) return;
    let cancelled = false;

    async function evaluate(hasSession: boolean) {
      if (cancelled) return;
      if (!hasSession) {
        setStatus("signed_out");
        return;
      }
      await loadAuthorizationDetails();
    }

    async function loadAuthorizationDetails() {
      const { data: sessionData } = await supabase!.auth.getSession();
      const accessToken = sessionData.session?.access_token;
      if (!accessToken) {
        if (!cancelled) setStatus("signed_out");
        return;
      }
      const ownerResponse = await fetch("/api/owner", { headers: { Authorization: `Bearer ${accessToken}` } });
      const ownerBody = (await ownerResponse.json().catch(() => null)) as { owner?: boolean } | null;
      if (cancelled) return;
      if (!ownerResponse.ok || !ownerBody?.owner) {
        setStatus("forbidden");
        return;
      }

      const authorizationId = new URLSearchParams(window.location.search).get("authorization_id");
      if (!authorizationId) {
        setStatus("error");
        setErrorMessage("This link is missing its authorization request. Ask the MCP client to restart sign-in.");
        return;
      }
      const { data, error } = await supabase!.auth.oauth.getAuthorizationDetails(authorizationId);
      if (cancelled) return;
      if (error || !data) {
        setStatus("error");
        setErrorMessage(error?.message ?? "Unable to load this authorization request.");
        return;
      }
      if ("authorization_id" in data) {
        setDetails(data);
        setStatus("consent");
      } else {
        window.location.href = data.redirect_url;
      }
    }

    const { data: subscription } = supabase.auth.onAuthStateChange((_event, session) => {
      void evaluate(session !== null);
    });
    supabase.auth.getSession().then(({ data }) => evaluate(data.session !== null));
    return () => {
      cancelled = true;
      subscription.subscription.unsubscribe();
    };
  }, []);

  async function signIn(formData: FormData) {
    setLoginMessage("");
    const email = String(formData.get("email"));
    const password = String(formData.get("password"));
    const { error } = await supabase!.auth.signInWithPassword({ email, password });
    if (error) setLoginMessage(error.message);
  }

  async function decide(approve: boolean) {
    if (!details) return;
    setStatus("deciding");
    const { data, error } = approve
      ? await supabase!.auth.oauth.approveAuthorization(details.authorization_id, { skipBrowserRedirect: true })
      : await supabase!.auth.oauth.denyAuthorization(details.authorization_id, { skipBrowserRedirect: true });
    if (error || !data) {
      setStatus("error");
      setErrorMessage(error?.message ?? "Unable to complete the authorization decision.");
      return;
    }
    window.location.href = data.redirect_url;
  }

  return (
    <main className="grid min-h-screen place-items-center bg-[#f7f2ea] px-4 text-[#211713]">
      <section className="w-full max-w-md rounded-lg border border-[#e1d4c4] bg-white p-6">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#9a5b2f]">Aly & Shin</p>
        <h1 className="mt-2 text-2xl font-semibold">Product Lab MCP Access</h1>

        {status === "not_configured" && (
          <p className="mt-4 text-sm leading-6 text-[#6f5a4c]">Product Lab is not configured in this environment.</p>
        )}

        {status === "loading" && <p className="mt-4 text-sm leading-6 text-[#6f5a4c]">Checking your session...</p>}

        {status === "signed_out" && (
          <>
            <p className="mt-2 text-sm leading-6 text-[#6f5a4c]">Sign in as the Product Lab owner to continue.</p>
            <form action={signIn} className="mt-6 grid gap-4">
              <label className="grid gap-1 text-sm">
                Email
                <input name="email" type="email" required className="rounded-md border border-[#e1d4c4] px-3 py-2" />
              </label>
              <label className="grid gap-1 text-sm">
                Password
                <input name="password" type="password" required className="rounded-md border border-[#e1d4c4] px-3 py-2" />
              </label>
              <button type="submit" className="rounded-md bg-[#9a5b2f] px-4 py-2 text-white">Sign in</button>
            </form>
            {loginMessage && <p className="mt-4 rounded-md bg-[#fff2d8] p-3 text-sm text-[#7a531d]">{loginMessage}</p>}
          </>
        )}

        {status === "forbidden" && (
          <p className="mt-4 rounded-md bg-[#fff2d8] p-3 text-sm text-[#7a531d]">
            This account is signed in but is not the Product Lab owner. Only the owner can authorize MCP access.
          </p>
        )}

        {(status === "consent" || status === "deciding") && details && (
          <div className="mt-4">
            <p className="text-sm leading-6 text-[#6f5a4c]">
              <span className="font-semibold">{details.client.name}</span> is requesting access to Product Lab MCP
              as <span className="font-semibold">{details.user.email}</span>.
            </p>
            <p className="mt-3 text-xs uppercase tracking-wide text-[#9a5b2f]">Requested scope</p>
            <p className="mt-1 text-sm text-[#211713]">{details.scope || "(none)"}</p>
            <div className="mt-6 flex gap-3">
              <button
                type="button"
                disabled={status === "deciding"}
                onClick={() => void decide(true)}
                className="rounded-md bg-[#9a5b2f] px-4 py-2 text-white disabled:opacity-60"
              >
                Approve
              </button>
              <button
                type="button"
                disabled={status === "deciding"}
                onClick={() => void decide(false)}
                className="rounded-md border border-[#e1d4c4] px-4 py-2 text-[#211713] disabled:opacity-60"
              >
                Deny
              </button>
            </div>
          </div>
        )}

        {status === "error" && (
          <p className="mt-4 rounded-md bg-[#fff2d8] p-3 text-sm text-[#7a531d]">{errorMessage}</p>
        )}
      </section>
    </main>
  );
}
