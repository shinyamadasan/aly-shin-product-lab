"use client";

import { History } from "lucide-react";
import { useEffect, useState } from "react";
import { MessageBox, Panel, Tag } from "@/components/ui";
import {
  buildSavedCreativeReopenHref,
  listSavedCreatives,
  type CreativeHistoryClient,
  type SavedCreative,
  type SavedCreativeState,
} from "@/lib/creative-history";
import { isSupabaseConfigured, supabase } from "@/lib/supabase";

// Wave B -- the Saved Creatives surface.
//
// The entire fix for "I made something and now I can't find it". It is a LIST and an OPEN, and that
// is deliberately all it is: no folders, no tags, no search, no archive, no bulk actions. A DAM
// library is a product; this is a way back to yesterday's work.
//
// It renders no creative content of its own and duplicates no Production component. Open is an
// ordinary link carrying the Creative Job id in the `?job=` parameter Create Now already owns, so
// the reopened screen is literally the same screen, resolved by the same route, from the same id.

function formatCreatedAt(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value || "Unknown" : date.toLocaleString();
}

// Tone maps to what the state MEANS to the owner, not to how far along it is: a finished asset and
// an accepted one are both good news, a failure of either kind is bad news, and everything in
// between is simply in motion.
const STATE_TONES: Record<SavedCreativeState, "warm" | "green" | "danger"> = {
  generating: "warm",
  failed: "danger",
  ready: "warm",
  "ready-for-production": "warm",
  producing: "warm",
  "production-failed": "danger",
  produced: "green",
  accepted: "green",
  rejected: "danger",
};

function SavedCreativeRow({ basePath, creative }: { basePath: string; creative: SavedCreative }) {
  // Never invented. A package with no readable content still has a real, reopenable job behind it,
  // and saying so plainly beats generating a title for something this app cannot read.
  const title = creative.title ?? "Untitled creative";

  return (
    <div className="border-t border-[#ead9c8] pt-3 first:border-t-0 first:pt-0">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm font-medium text-[#211713]">{title}</p>
        <a
          className="shrink-0 text-xs font-semibold text-[#8f5632] underline"
          href={buildSavedCreativeReopenHref(basePath, creative.creativeJobId)}
        >
          Open
        </a>
      </div>
      <p className="mt-1 text-sm text-[#6f5a4c]">
        {formatCreatedAt(creative.createdAt)}
        {creative.formatLabel ? ` · ${creative.formatLabel}` : ""}
      </p>
      {creative.productionLabel ? <p className="mt-0.5 text-sm text-[#6f5a4c]">{creative.productionLabel}</p> : null}
      <div className="mt-2">
        <Tag tone={STATE_TONES[creative.state]}>{creative.stateLabel}</Tag>
      </div>
    </div>
  );
}

export function SavedCreatives({ basePath }: { basePath: string }) {
  const client = supabase as unknown as CreativeHistoryClient | null;

  const [creatives, setCreatives] = useState<SavedCreative[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    let cancelled = false;

    async function load() {
      if (!isSupabaseConfigured || !client) {
        if (!cancelled) {
          setLoadError("Saved creatives need the shared workspace connection.");
          setIsLoading(false);
        }
        return;
      }

      const result = await listSavedCreatives(client);
      if (cancelled) return;

      if (!result.ok) {
        setLoadError(result.message);
        setIsLoading(false);
        return;
      }

      setLoadError("");
      setCreatives(result.creatives);
      setIsLoading(false);
    }

    load();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Panel icon={<History size={18} />} title="Saved creatives">
      {isLoading ? <p className="text-sm text-[#6f5a4c]">Looking for what you&apos;ve made...</p> : null}
      {loadError ? <MessageBox message={loadError} tone="bad" /> : null}
      {!isLoading && !loadError && creatives.length === 0 ? (
        <p className="text-sm text-[#6f5a4c]">
          Nothing here yet. Everything you create is saved automatically and shows up here — newest first.
        </p>
      ) : null}
      {!isLoading && !loadError && creatives.length > 0 ? (
        <div className="space-y-3">
          {creatives.map((creative) => (
            <SavedCreativeRow basePath={basePath} creative={creative} key={creative.creativeJobId} />
          ))}
        </div>
      ) : null}
    </Panel>
  );
}
