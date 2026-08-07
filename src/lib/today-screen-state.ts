import { listReadyOpportunities, type TodaysReadyOpportunity, type TodaysRecommendationClient } from "./todays-recommendation.ts";
import { listOpportunities } from "./opportunity-review.ts";
import { findQueuedExternalAssetJob, listAssetJobsForCreativePackage, type AssetJobClient, type AssetJobRecord } from "./asset-jobs.ts";

export type TodayScreenStateClient = TodaysRecommendationClient & AssetJobClient;

// The single orchestration layer between repository state and what Today's screen renders. Every
// read here delegates to an already-existing, already-tested function -- this module's only job is
// composing their results into one typed state a component can switch on declaratively. It never
// decides business rules (readiness, ordering, what "ready" means) itself.
export type TodayScreenState =
  | { kind: "fresh"; candidate: TodaysReadyOpportunity }
  | { kind: "continue"; candidate: TodaysReadyOpportunity; assetJob: AssetJobRecord }
  | { kind: "completed-today"; candidate: TodaysReadyOpportunity; assetJob: AssetJobRecord }
  | { kind: "prep-not-ready" }
  | { kind: "empty" }
  | { kind: "exhausted" };

export type TodayScreenStateResult =
  | { ok: true; state: TodayScreenState }
  | { ok: false; reason: "missing-table" | "failed"; message: string };

// excludeOpportunityIds is session-only UI state ("Not today" taps this browser tab has made) --
// owned entirely by the caller and never persisted. Filtering happens here, over the full ready
// list listReadyOpportunities already fetched, not via a second query -- the business selector
// itself never learns that "Not today" exists.
export async function resolveTodayScreenState(
  client: TodayScreenStateClient,
  options: { excludeOpportunityIds?: string[] } = {},
): Promise<TodayScreenStateResult> {
  const excluded = new Set(options.excludeOpportunityIds ?? []);

  const readyResult = await listReadyOpportunities(client);
  if (!readyResult.ok) {
    return readyResult;
  }

  const remaining = readyResult.ready.filter((entry) => !excluded.has(entry.opportunity.id));

  if (remaining.length > 0) {
    const candidate = remaining[0];
    const jobsResult = await listAssetJobsForCreativePackage(client, candidate.creativePackage.id);
    if (!jobsResult.ok) {
      return jobsResult;
    }

    const completedJob = jobsResult.jobs.find((job) => job.status === "completed");
    if (completedJob) {
      return { ok: true, state: { kind: "completed-today", candidate, assetJob: completedJob } };
    }

    const queuedJob = findQueuedExternalAssetJob(jobsResult.jobs);
    if (queuedJob) {
      return { ok: true, state: { kind: "continue", candidate, assetJob: queuedJob } };
    }

    return { ok: true, state: { kind: "fresh", candidate } };
  }

  // Nothing ready remains. If the unfiltered list was non-empty, exclusion removed everything --
  // ready candidates existed this session, the owner just walked past all of them via "Not today."
  if (readyResult.ready.length > 0) {
    return { ok: true, state: { kind: "exhausted" } };
  }

  // Distinguish a true empty day from "prep hasn't materialized a package yet" with plain existence
  // reads only -- never selectPreparationCandidate. docs/ARCHITECTURE.md's PROP-034 section is
  // explicit that Today must never use that selection algorithm; a bare listOpportunities existence
  // check answers "does anything exist at all" without reusing the "what should be advanced next"
  // business decision that function encodes.
  const [newResult, acceptedResult] = await Promise.all([listOpportunities(client, "new"), listOpportunities(client, "accepted")]);
  if (!newResult.ok) {
    return newResult;
  }
  if (!acceptedResult.ok) {
    return acceptedResult;
  }

  if (newResult.opportunities.length === 0 && acceptedResult.opportunities.length === 0) {
    return { ok: true, state: { kind: "empty" } };
  }

  return { ok: true, state: { kind: "prep-not-ready" } };
}
