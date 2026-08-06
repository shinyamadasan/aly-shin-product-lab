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

// Today's selection contract: the newest accepted Opportunity that is *actually safe to show* --
// meaning a Creative Package already exists for it -- not merely the newest eligible Opportunity.
// Deliberately separate from selectPreparationCandidate (opportunity-review.ts): preparation asks
// "what should be advanced next," this asks "what can be displayed right now." A "new" Opportunity
// can never have a Creative Package (Creative Job creation requires an accepted Opportunity), so
// only "accepted" candidates are ever considered here.
export async function selectTodaysReadyOpportunity(client: TodaysRecommendationClient): Promise<TodaysReadyOpportunityResult> {
  const acceptedResult = await listOpportunities(client, "accepted");
  if (!acceptedResult.ok) {
    return { ok: false, reason: acceptedResult.reason, message: acceptedResult.message };
  }

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

    return { ok: true, ready: { opportunity, creativePackage: packageResult.creativePackage } };
  }

  return { ok: true, ready: null };
}
