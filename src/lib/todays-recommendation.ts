import { getCreativeJobForOpportunity, type CreativeJobClient } from "./creative-jobs.ts";
import { getCreativePackageForJob, type CreativePackageClient, type CreativePackageRecord } from "./creative-packages.ts";
import { listOpportunities, type OpportunityListRecord, type OpportunityReviewClient } from "./opportunity-review.ts";

export type TodaysRecommendationClient = OpportunityReviewClient & CreativeJobClient & CreativePackageClient;

export type TodaysReadyOpportunity = {
  opportunity: OpportunityListRecord;
  creativePackage: CreativePackageRecord;
};

export type TodaysReadyOpportunityResult =
  | { ok: true; ready: TodaysReadyOpportunity | null }
  | { ok: false; reason: "missing-table" | "failed"; message: string };

export type TodaysReadyOpportunitiesResult =
  | { ok: true; ready: TodaysReadyOpportunity[] }
  | { ok: false; reason: "missing-table" | "failed"; message: string };

// Today's selection contract: every accepted Opportunity that is *actually safe to show* -- meaning
// a Creative Package already exists for it -- not merely eligible. Deliberately separate from
// selectPreparationCandidate (opportunity-review.ts): preparation asks "what should be advanced
// next," this asks "what can be displayed right now." A "new" Opportunity can never have a Creative
// Package (Creative Job creation requires an accepted Opportunity), so only "accepted" candidates
// are ever considered here. Ordered newest-detected-first, per listOpportunities' own ordering.
//
// This is the one enumeration the file is built on -- selectTodaysReadyOpportunity below is a thin,
// behavior-preserving wrapper over it (first entry, or null). Session-scoped concerns like "Not
// today" exclusion belong entirely to the orchestration layer that calls this (today-screen-state.ts),
// never here: this function only ever answers "what's ready," nothing about what a given browser
// session has already skipped. Note this walks every accepted Opportunity rather than short-
// circuiting on the first ready one (selectTodaysReadyOpportunity used to stop early) -- a few extra
// reads in exchange for letting "Not today" filter an already-fetched list instead of re-querying.
export async function listReadyOpportunities(client: TodaysRecommendationClient): Promise<TodaysReadyOpportunitiesResult> {
  const acceptedResult = await listOpportunities(client, "accepted");
  if (!acceptedResult.ok) {
    return { ok: false, reason: acceptedResult.reason, message: acceptedResult.message };
  }

  const ready: TodaysReadyOpportunity[] = [];
  for (const opportunity of acceptedResult.opportunities) {
    const jobResult = await getCreativeJobForOpportunity(client, opportunity.id);
    if (!jobResult.ok) {
      if (jobResult.reason === "not-found") {
        continue;
      }
      return { ok: false, reason: jobResult.reason, message: jobResult.message };
    }
    if (jobResult.job.status !== "completed") {
      continue;
    }

    const packageResult = await getCreativePackageForJob(client, jobResult.job.id);
    if (!packageResult.ok) {
      if (packageResult.reason === "not-found") {
        continue;
      }
      return { ok: false, reason: packageResult.reason, message: packageResult.message };
    }

    ready.push({ opportunity, creativePackage: packageResult.creativePackage });
  }

  return { ok: true, ready };
}

export async function selectTodaysReadyOpportunity(client: TodaysRecommendationClient): Promise<TodaysReadyOpportunityResult> {
  const result = await listReadyOpportunities(client);
  if (!result.ok) {
    return result;
  }
  return { ok: true, ready: result.ready[0] ?? null };
}
