"use client";

import { useEffect, useState, type ReactNode } from "react";
import { CreateNow } from "@/components/create-now";
import { CreativePackageAssetCreate } from "@/components/creative-package-asset-create";
import { CreativePackageAssets } from "@/components/creative-package-assets";
import { MessageBox } from "@/components/ui";
import type { Product } from "@/lib/product-lab-types";
import { isSupabaseConfigured, supabase } from "@/lib/supabase";
import { headlineAndReason } from "@/lib/today-recommendation-copy";
import { resolveTodayScreenState, type TodayScreenState, type TodayScreenStateClient } from "@/lib/today-screen-state";

function QuietAction({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button className="text-sm font-medium text-[#6f5a4c] underline-offset-4 hover:underline" onClick={onClick} type="button">
      {children}
    </button>
  );
}

// The frozen wireframe's one exception to "Something specific is always quiet": with no
// recommendation to offer, it is promoted to the screen's single primary action rather than left as
// an orphaned text link under nothing.
function PrimaryAction({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button className="h-10 rounded-md bg-[#8f5632] px-4 text-sm font-semibold text-white hover:bg-[#774427]" onClick={onClick} type="button">
      {children}
    </button>
  );
}

// The single declarative Today screen: load resolveTodayScreenState's result, switch on its kind,
// render the corresponding view. No database or readiness logic lives here -- every decision about
// what's ready, what's in progress, or what's done was already made by the orchestration layer this
// component only calls and switches on. "Not today" is the one piece of state this component owns
// itself, and it is deliberately never sent anywhere: it only ever narrows the next call to
// resolveTodayScreenState, and is lost on reload by design.
export function TodayPage({ initialCreativeJobId, products }: { initialCreativeJobId: string | null; products: Product[] }) {
  const client = supabase as unknown as TodayScreenStateClient | null;
  const [excludeOpportunityIds, setExcludeOpportunityIds] = useState<string[]>([]);
  const [refreshToken, setRefreshToken] = useState(0);
  const [state, setState] = useState<TodayScreenState | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  // "Something specific" (S4). The frozen wireframe already names this action on every state and
  // promotes it to the primary one when there is nothing to recommend, so it is not a new concept --
  // this is the state that finally makes it do something.
  //
  // The active job id is owned here rather than inside CreateNow so that stepping back to the
  // recommendation and returning does not resurrect a job the owner already moved on from: the
  // route's search param seeds it once, and after that this is the only copy.
  const [creativeJobId, setCreativeJobId] = useState(initialCreativeJobId);
  const [isCreating, setIsCreating] = useState(initialCreativeJobId !== null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setIsLoading(true);
      setLoadError("");

      if (!isSupabaseConfigured || !client) {
        if (!cancelled) {
          setState(null);
          setLoadError("Today requires the configured Supabase project. Local browser-only mode can't check for a recommendation.");
          setIsLoading(false);
        }
        return;
      }

      const result = await resolveTodayScreenState(client, { excludeOpportunityIds });
      if (cancelled) return;
      if (!result.ok) {
        setState(null);
        setLoadError(result.message);
        setIsLoading(false);
        return;
      }
      setState(result.state);
      setIsLoading(false);
    }

    load();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [excludeOpportunityIds, refreshToken]);

  // Client-session-only: never persisted, never sent to any mutation. Appending the current
  // candidate's id and re-running resolveTodayScreenState is the entire mechanism -- the same
  // already-fetched ready list gets filtered one entry shorter, nothing about the underlying
  // Opportunity changes.
  function notToday(opportunityId: string) {
    setExcludeOpportunityIds((current) => (current.includes(opportunityId) ? current : [...current, opportunityId]));
  }

  function handleUploaded() {
    setRefreshToken((current) => current + 1);
  }

  // Deliberately ahead of the loading and error branches. Making something specific has never
  // depended on a recommendation existing, and this ordering is what proves it: the recommendation
  // read can be pending, empty, or outright failing and the owner can still type and submit.
  if (isCreating) {
    return <CreateNow jobId={creativeJobId} onExit={() => setIsCreating(false)} onJobIdChange={setCreativeJobId} products={products} />;
  }

  if (isLoading) {
    return <div className="mx-auto max-w-xl" />;
  }

  if (loadError) {
    return (
      <div className="mx-auto max-w-xl space-y-4">
        <MessageBox message={loadError} tone="bad" />
        {/* A failed recommendation read must not take creating something with it. */}
        <QuietAction onClick={() => setIsCreating(true)}>Something specific</QuietAction>
      </div>
    );
  }

  if (!state) {
    return null;
  }

  switch (state.kind) {
    case "fresh": {
      const { headline, reason } = headlineAndReason(state.candidate);
      return (
        <div className="mx-auto max-w-xl space-y-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#9a5b2f]">Today&apos;s recommendation</p>
            <h2 className="mt-1 text-3xl font-semibold tracking-tight">{headline}</h2>
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#9a5b2f]">Reason</p>
            <p className="mt-1 text-sm leading-6 text-[#4a3c32]">{reason}</p>
          </div>
          <CreativePackageAssetCreate creativePackageId={state.candidate.creativePackage.id} onUploaded={handleUploaded} variant="ritual" />
          <div className="flex flex-wrap items-center gap-4">
            <QuietAction onClick={() => notToday(state.candidate.opportunity.id)}>Not today</QuietAction>
            <QuietAction onClick={() => setIsCreating(true)}>Something specific</QuietAction>
          </div>
        </div>
      );
    }

    case "continue": {
      const { headline } = headlineAndReason(state.candidate);
      return (
        <div className="mx-auto max-w-xl space-y-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#9a5b2f]">{headline} — in progress</p>
            <p className="mt-1 text-sm leading-6 text-[#4a3c32]">Your brief is ready. Waiting for your photo.</p>
          </div>
          <CreativePackageAssetCreate creativePackageId={state.candidate.creativePackage.id} onUploaded={handleUploaded} variant="ritual" />
          <div className="flex flex-wrap items-center gap-4">
            <QuietAction onClick={() => notToday(state.candidate.opportunity.id)}>Not today</QuietAction>
            <QuietAction onClick={() => setIsCreating(true)}>Something specific</QuietAction>
          </div>
        </div>
      );
    }

    case "completed-today": {
      const { headline } = headlineAndReason(state.candidate);
      return (
        <div className="mx-auto max-w-xl space-y-4">
          <MessageBox message="Nice work — today's content is ready." tone="good" />
          <p className="text-sm font-medium text-[#4a3c32]">{headline} — ready to publish</p>
          <CreativePackageAssets creativePackageId={state.candidate.creativePackage.id} refreshSignal={refreshToken} variant="ritual" />
          {/* Two different things, deliberately not conflated: the DAILY RECOMMENDATION slot is done
              for the day and nothing here recommends, promotes or prepares a second one. OWNER-
              INITIATED creation is a separate door, and finishing today's recommendation is not a
              reason to lock it -- "Opportunities recommend content. They do not gate content
              creation." So this stays available and stays QuietAction: an option if the owner wants
              one, never a new task being asked of them. */}
          <QuietAction onClick={() => setIsCreating(true)}>Something specific</QuietAction>
        </div>
      );
    }

    case "prep-not-ready":
      return (
        <div className="mx-auto max-w-xl space-y-2">
          <p className="text-2xl font-semibold tracking-tight">Today&apos;s recommendation isn&apos;t ready yet.</p>
          <p className="text-sm leading-6 text-[#6f5a4c]">Check back shortly — it&apos;s still being prepared.</p>
          <div className="pt-2">
            <QuietAction onClick={() => setIsCreating(true)}>Something specific</QuietAction>
          </div>
        </div>
      );

    // The two states with nothing to recommend are where the frozen wireframe promotes "Something
    // specific" from a quiet text action to the screen's single primary button. The trailing
    // sentence below is the wireframe's own Empty copy, which had nowhere to lead until now.
    case "empty":
      return (
        <div className="mx-auto max-w-xl space-y-2">
          <p className="text-2xl font-semibold tracking-tight">Nothing stands out today.</p>
          <p className="text-sm leading-6 text-[#6f5a4c]">No strong pattern to point to — that&apos;s fine. Make something yourself.</p>
          <div className="pt-2">
            <PrimaryAction onClick={() => setIsCreating(true)}>Something specific</PrimaryAction>
          </div>
        </div>
      );

    case "exhausted":
      return (
        <div className="mx-auto max-w-xl space-y-2">
          <p className="text-2xl font-semibold tracking-tight">No other recommendations today.</p>
          <div className="pt-2">
            <PrimaryAction onClick={() => setIsCreating(true)}>Something specific</PrimaryAction>
          </div>
        </div>
      );

    default:
      return null;
  }
}
