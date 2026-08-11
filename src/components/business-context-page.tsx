"use client";

// Runtime v1 PR-3: the one real consumer of the Business Context.
//
// Read-only. This page reads live data, assembles the canonical snapshot, renders the deterministic
// brief, and lets the operator copy it. It edits nothing -- business data keeps being edited in the
// modules that own it -- and it adds no write path of any kind.
//
// THE GATE IS THE MOST IMPORTANT THING IN THIS FILE. buildCurrentBusinessContext is never called
// unless Supabase is configured AND there is a signed-in session, and that decision is made BEFORE
// any read is issued. Without it the readers would do exactly what they are designed to do: report
// what the database returned. An unauthenticated read is filtered to nothing by RLS and comes back
// as a successful empty result, so the snapshot would render "0 orders, 0 ingredients" -- a
// completely fabricated healthy-looking empty business. The readers cannot tell the difference and
// deliberately do not pretend to; refusing to build is this page's job.
//
// Nothing is cached and nothing is persisted. Every load and every Refresh rebuilds from scratch,
// because a cached business snapshot is one whose staleness is invisible.

import { Database, FileText, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { AppShell } from "@/components/app-shell";
import { MessageBox, Panel, SecondaryButton } from "@/components/ui";
import { renderBusinessBrief } from "@/lib/business-context/brief";
import { renderCompactBrief } from "@/lib/business-context/compact-brief";
import type { BusinessContextReadClient } from "@/lib/business-context/readers/supabase";
import { buildCurrentBusinessContext } from "@/lib/business-context/runtime";
import type { BusinessContext, DomainContext } from "@/lib/business-context/types";
import { isSupabaseConfigured, supabase } from "@/lib/supabase";

// Both briefs are rendered once, when the context is built, and stored beside it. Each copy button
// hands over those exact bytes rather than re-rendering, so what was read on screen is what gets
// pasted.
//
// `compact` is the primary readout and what Copy Context copies: it is the AI-facing payload. `full`
// stays one click away so fidelity is never lost, and the canonical JSON below it is the source of
// truth for both.
//
// `userId` is OWNERSHIP, not data. It records which authenticated identity authorized this build, so
// a snapshot can never outlive the session that produced it: sign out and back in as someone else
// and the previous operator's business context is not displayable, even for the moment before the
// new build lands. It is UI state only -- never rendered, never copied, never persisted, and not
// part of the canonical BusinessContext.
type Snapshot = {
  context: BusinessContext;
  compact: string;
  brief: string;
  userId: string;
};

// Errors carry the same ownership, for the same reason: one identity's failure must not be shown
// to the next.
type LoadError = {
  message: string;
  userId: string;
};

type CopyNotice = { message: string; tone: "good" | "bad" };

const NOT_CONFIGURED = "Business Context needs a live Supabase connection. This page does not read the localStorage fallback.";
const SIGNED_OUT = "Sign in to generate a snapshot.";
const CHECKING_SESSION = "Checking session…";
const READING = "Reading live data…";

// True when the builder produced domains and not one of them could be read. Derived from the
// DomainContexts actually present, never from a coverage count: coverage.absent also holds the
// domains that have no adapter at all, and hard-coding "11 unbuilt" or "15 absent" would break the
// moment a new adapter ships.
function hasNoReadableDomain(context: BusinessContext): boolean {
  const built = Object.values(context.domains).filter((domain): domain is DomainContext => domain !== undefined);
  return built.length > 0 && built.every((domain) => !domain.readOutcome.ok);
}

export function BusinessContextPage() {
  const [session, setSession] = useState<Session | null>(null);
  const [isAuthLoading, setIsAuthLoading] = useState(isSupabaseConfigured);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  // Starts true when a build is expected, so the first render is honestly "reading" rather than an
  // empty page that flips. Same shape orders-page.tsx uses: the effect below performs no state
  // update before its first await, and the explicit set-to-true lives in the user-driven refresh.
  const [isBuilding, setIsBuilding] = useState(isSupabaseConfigured);
  const [reloadToken, setReloadToken] = useState(0);
  const [loadError, setLoadError] = useState<LoadError | null>(null);
  const [copyNotice, setCopyNotice] = useState<CopyNotice | null>(null);

  // The authenticated identity, not the Session object. Keying on the user id means a routine token
  // refresh -- which replaces the Session object for the SAME operator -- does not throw away a
  // valid snapshot or trigger a pointless rebuild, while an actual change of operator does both.
  const sessionUserId = session?.user.id ?? null;

  // The app's existing session lifecycle, unchanged. No new auth system, no second client, and no
  // sign-in form: the app already owns sign-in, and this page only needs to know whether one
  // happened.
  useEffect(() => {
    if (!supabase) {
      return;
    }

    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setIsAuthLoading(false);
    });

    const { data } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);

      if (!nextSession) {
        // Signed out: drop the previous identity's context rather than merely hiding it. Ownership
        // below would already make it undisplayable; this also stops it lingering in memory.
        setSnapshot(null);
        setLoadError(null);
        setCopyNotice(null);
      }
    });

    return () => data.subscription.unsubscribe();
  }, []);

  // The build, declared inside the effect with a `cancelled` flag -- the same shape orders-page.tsx
  // and opportunities-page.tsx already use. Two properties come from it: no state is written
  // synchronously during the effect body, and a response arriving after a newer build started is
  // discarded rather than overwriting a fresher snapshot with a staler one.
  useEffect(() => {
    let cancelled = false;

    async function buildSnapshot() {
      // THE GATE, before any I/O. Both conditions, every time -- including on Refresh. Nothing is
      // read until we know there is a configured project and a signed-in identity to read as.
      if (!isSupabaseConfigured || !supabase || !sessionUserId) {
        return;
      }

      // ONE clock for this build, captured at the page boundary and threaded through the runtime to
      // every adapter. The runtime resolves timezone and business day from it; nothing below reads a
      // clock, so a snapshot cannot contain two disagreeing notions of "now".
      const nowMs = Date.now();

      try {
        const context = await buildCurrentBusinessContext({
          client: supabase as unknown as BusinessContextReadClient,
          nowMs,
        });
        if (cancelled) return;
        // The previous snapshot is replaced only now, once a canonical context exists -- and it is
        // stamped with the identity that authorized this build.
        setSnapshot({ context, compact: renderCompactBrief(context), brief: renderBusinessBrief(context), userId: sessionUserId });
        setLoadError(null);
        setCopyNotice(null);
      } catch (error) {
        if (cancelled) return;
        // A structured reader failure never reaches here -- it comes back inside the context as a
        // degraded domain, which is a success path. This is the other case: the driver threw. The
        // runtime deliberately lets that escape rather than pretending it was an empty business, so
        // the page reports a real failure and keeps the message for debugging.
        //
        // The previous snapshot is dropped rather than left on screen, so a failed Refresh can
        // never be mistaken for a successful one.
        setSnapshot(null);
        setLoadError({ message: error instanceof Error ? error.message : String(error), userId: sessionUserId });
      } finally {
        // A cancelled build no longer owns this flag; the newer one does.
        if (!cancelled) {
          setIsBuilding(false);
        }
      }
    }

    void buildSnapshot();
    return () => {
      cancelled = true;
    };
  }, [sessionUserId, reloadToken]);

  // Refresh is user-driven and is the only path that flips into the building state explicitly. It
  // bumps the token, which re-runs the effect, which captures a NEW nowMs and rebuilds everything
  // from scratch. Nothing is cached, so there is nothing to invalidate.
  const refresh = useCallback(() => {
    setIsBuilding(true);
    setCopyNotice(null);
    setReloadToken((token) => token + 1);
  }, []);

  async function copyText(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopyNotice({ message: `${label} copied to the clipboard.`, tone: "good" });
    } catch (error) {
      setCopyNotice({ message: `Could not copy ${label}: ${error instanceof Error ? error.message : String(error)}`, tone: "bad" });
    }
  }

  return (
    <AppShell view="context">
      <div className="space-y-4">{renderBody()}</div>
    </AppShell>
  );

  function renderBody() {
    if (!isSupabaseConfigured) {
      // No runtime call, no localStorage read, no emptyState. A fabricated context is worse than none.
      return <MessageBox message={NOT_CONFIGURED} tone="info" />;
    }

    if (isAuthLoading) {
      return <MessageBox message={CHECKING_SESSION} tone="info" />;
    }

    if (!sessionUserId) {
      return <MessageBox message={SIGNED_OUT} tone="info" />;
    }

    if (isBuilding) {
      // No skeleton, no zeroes, no previous snapshot presented as current.
      return <MessageBox message={READING} tone="info" />;
    }

    // OWNERSHIP, checked before anything from a previous build can reach the screen. After an
    // identity change the effect has started a fresh build but isBuilding is still false, so
    // without this the outgoing operator's context would render to the incoming one.
    const ownedError = loadError && loadError.userId === sessionUserId ? loadError : null;
    const ownedSnapshot = snapshot && snapshot.userId === sessionUserId ? snapshot : null;

    if (ownedError) {
      return (
        <div className="space-y-4">
          <MessageBox message={`Could not build the business context: ${ownedError.message}`} tone="bad" />
          <SecondaryButton onClick={refresh}>Refresh</SecondaryButton>
        </div>
      );
    }

    if (!ownedSnapshot) {
      return <MessageBox message={READING} tone="info" />;
    }

    return renderSnapshot(ownedSnapshot);
  }

  function renderSnapshot({ context, compact, brief }: Snapshot) {
    return (
      <div className="space-y-4">
        {hasNoReadableDomain(context) ? (
          <MessageBox
            message="No domain could be read on this run. This snapshot describes no live business data that was successfully read -- every built domain reports a failed read, and its facts are unavailable rather than empty."
            tone="bad"
          />
        ) : null}

        {copyNotice ? <MessageBox message={copyNotice.message} tone={copyNotice.tone} /> : null}

        <Panel icon={<Database size={16} />} title="Snapshot">
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            <Metadata label="Generated at" value={context.generatedAt} />
            <Metadata label="Business day" value={context.businessDay} />
            <Metadata label="Timezone" value={context.timezone} />
            <Metadata label="Data source" value={context.dataSource} />
            <Metadata label="Context schema" value={`v${context.contextSchemaVersion}`} />
            <Metadata label="Facts digest" value={context.factsDigest} />
            <Metadata label="Signals digest" value={context.signalsDigest} />
          </dl>

          <div className="mt-4 flex flex-wrap gap-2">
            <SecondaryButton disabled={isBuilding} onClick={refresh}>
              <span className="inline-flex items-center gap-2">
                <RefreshCw size={14} />
                Refresh
              </span>
            </SecondaryButton>
            {/* Copies the already-rendered COMPACT bytes: no wrapper prompt, no instruction, no
                JSON, no Markdown fence. What is on screen is what is pasted. */}
            <SecondaryButton onClick={() => void copyText(compact, "Business context")}>Copy Context</SecondaryButton>
          </div>
        </Panel>

        <Panel icon={<FileText size={16} />} title="Business brief (compact)">
          <pre className="max-h-[32rem] overflow-auto rounded-md border border-[#e1d4c4] bg-[#fffaf3] p-4 text-xs leading-5 text-[#3d2c22]">{compact}</pre>
        </Panel>

        {/* Full fidelity, one click away. Every fact the envelope publishes, rendered in full. */}
        <details className="rounded-lg border border-[#e1d4c4] bg-white p-5">
          <summary className="cursor-pointer text-sm font-semibold text-[#5f4a3d]">Full brief (every published fact)</summary>
          <div className="mt-4 space-y-3">
            <SecondaryButton onClick={() => void copyText(brief, "Full brief")}>Copy Full Brief</SecondaryButton>
            <pre className="max-h-[32rem] overflow-auto rounded-md border border-[#e1d4c4] bg-[#fffaf3] p-4 text-xs leading-5 text-[#3d2c22]">{brief}</pre>
          </div>
        </details>

        {/* Debugging only, and collapsed by default. The canonical BusinessContext -- not a database
            row, not a query result. Nothing here is persisted or downloaded. */}
        <details className="rounded-lg border border-[#e1d4c4] bg-white p-5">
          <summary className="cursor-pointer text-sm font-semibold text-[#5f4a3d]">Raw BusinessContext JSON</summary>
          <div className="mt-4 space-y-3">
            <SecondaryButton onClick={() => void copyText(JSON.stringify(context, null, 2), "Raw JSON")}>Copy JSON</SecondaryButton>
            <pre className="max-h-[32rem] overflow-auto rounded-md border border-[#e1d4c4] bg-[#fffaf3] p-4 text-xs leading-5 text-[#3d2c22]">{JSON.stringify(context, null, 2)}</pre>
          </div>
        </details>
      </div>
    );
  }
}

function Metadata({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs uppercase tracking-wide text-[#9a5b2f]">{label}</dt>
      <dd className="break-all font-mono text-xs text-[#3d2c22]">{value}</dd>
    </div>
  );
}
