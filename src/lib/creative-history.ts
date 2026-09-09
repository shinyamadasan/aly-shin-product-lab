import { fromAssetRow, type AssetRow, type AssetStatus } from "./assets.ts";
import type { AssetJobRow, AssetJobStatus } from "./asset-jobs.ts";
import { buildCreativePackageView } from "./creative-package-view.ts";
import { fromCreativeJobRow, type CreativeJobRow, type CreativeJobStatus } from "./creative-jobs.ts";
import { CREATE_NOW_JOB_SEARCH_PARAM } from "./create-now.ts";
import { fromCreativePackageRow, isCreativePackageContentV1, type CreativePackageRow } from "./creative-packages.ts";

// Wave B -- Creative History.
//
// WHAT THIS MODULE IS FOR, AND WHAT IT DELIBERATELY IS NOT.
//
// Creative Packages have always been persisted automatically: the worker finishes a Creative Job and
// createCreativePackageFromCompletedJob writes the package row under a UNIQUE creative_job_id. What
// the owner never had was a way BACK to one. Leaving Create Now dropped the job id, and that id was
// the only handle the app ever exposed. Nothing was lost; it just became unreachable.
//
// So this module adds READS and nothing else. It writes no row, defines no new lifecycle column, and
// introduces no second identity: a saved creative IS a Creative Job, reopened through the same
// `?job=<creativeJobId>` mechanism Create Now has always used. There is no "history" table and there
// will not be one.
//
// SCOPE. Every read below goes through the caller's own Supabase client and adds no owner predicate,
// because there is no owner column to add one on: creative_jobs, creative_packages, asset_jobs and
// assets all carry `enable row level security` plus a single `to authenticated ... using (true)`
// policy (see supabase-add-creative-jobs.sql and its siblings). Scope is therefore exactly what the
// rest of this app's scope has always been -- whatever the authenticated session can see -- and
// inventing a client-side filter here would be a fake boundary that reads as a real one.

export const SAVED_CREATIVE_STATES = [
  "generating",
  "failed",
  "ready",
  "ready-for-production",
  "producing",
  "production-failed",
  "produced",
  "accepted",
  "rejected",
] as const;

export type SavedCreativeState = (typeof SAVED_CREATIVE_STATES)[number];

// Owner-facing wording for each derived state. Fixed strings resolved by key, exactly like
// creative-package-view.ts's FORMAT_LABELS, so no enum value ever reaches the screen and no wording
// drifts between two renders of the same row.
export const SAVED_CREATIVE_STATE_LABELS: Record<SavedCreativeState, string> = {
  generating: "Generating",
  failed: "Failed",
  ready: "Ready",
  "ready-for-production": "Ready for production",
  producing: "Producing",
  "production-failed": "Production didn't finish",
  produced: "Produced",
  accepted: "Accepted",
  rejected: "Rejected",
};

export type SavedCreative = {
  // The reopen identity, and the ONLY identity this surface exposes. Deliberately the Creative Job's
  // id and not the package's: `?job=` is the deep link that already exists, and a second id under a
  // second parameter would be a parallel routing model for the same thing.
  creativeJobId: string;
  // Null while a job is still generating (or completed with its package not yet written). Present
  // purely so a caller that already has the row does not have to re-read it; reopening never needs
  // it, because the reopen surface resolves the package from the job exactly as it always did.
  creativePackageId: string | null;
  // The package's own subject (v2) or headline (v1), verbatim. Null when there is no readable
  // package yet or its content is in a shape this app cannot show -- the caller renders a plain
  // placeholder rather than this module inventing a title, which would be new creative content.
  title: string | null;
  // The Creative Job's created_at: when the owner ASKED for this. Used for ordering as well as for
  // display, so a row's position and its date can never disagree.
  createdAt: string;
  // Both null for a v1 package, and productionLabel null for a pre-H1-B v2 package that never
  // recorded the decision -- the same absence rules creative-package-view.ts already applies.
  formatLabel: string | null;
  productionLabel: string | null;
  state: SavedCreativeState;
  stateLabel: string;
};

export type SavedCreativesResult =
  | { ok: true; creatives: SavedCreative[] }
  | { ok: false; reason: "missing-table" | "failed"; message: string };

type SupabaseErrorLike = {
  code?: string;
  message: string;
};

type HistoryQueryBuilder<T> = PromiseLike<{ data: T[] | null; error: SupabaseErrorLike | null }> & {
  in(column: string, values: string[]): HistoryQueryBuilder<T>;
  order(column: string, options: { ascending: boolean }): HistoryQueryBuilder<T>;
  limit(count: number): HistoryQueryBuilder<T>;
};

// select() only. No insert, no update, no delete and no rpc appear on this type, which is the
// compiler-level guarantee that opening this screen can never write anything -- the property owner
// acceptance items 6 and 7 ("reopening creates NO new Creative Package / Asset Job") depend on.
export type CreativeHistoryClient = {
  from(table: "creative_jobs" | "creative_packages" | "asset_jobs" | "assets"): {
    select<T = unknown>(columns: string): HistoryQueryBuilder<T>;
  };
};

// Bounded on purpose. A history that grows without limit gets slower every day the app is used, and
// the owner's question ("where is the thing I made?") is answered by the recent end of the list.
export const SAVED_CREATIVES_DEFAULT_LIMIT = 30;

function isMissingTableError(error: SupabaseErrorLike): boolean {
  return error.code === "PGRST205" || error.code === "42P01";
}

function dbErrorResult(error: SupabaseErrorLike): { reason: "missing-table" | "failed"; message: string } {
  if (isMissingTableError(error)) {
    return {
      reason: "missing-table",
      message: "Saved creatives are not available yet. Verify the Creative Job and Creative Package SQL files have been applied to this Supabase project.",
    };
  }

  return { reason: "failed", message: error.message };
}

// --- summary -------------------------------------------------------------------------------------

export type SavedCreativeSummary = {
  title: string | null;
  formatLabel: string | null;
  productionLabel: string | null;
};

const EMPTY_SUMMARY: SavedCreativeSummary = { title: null, formatLabel: null, productionLabel: null };

// Pure, total, and deliberately delegating to buildCreativePackageView for v2 rather than reading
// `format` and `productionSource` itself. The list row and the reopened package must say the same
// words about the same package -- "Static post", "Graphic - No shooting required" -- and deriving
// both from the same function is the only way to guarantee they cannot drift apart.
//
// A v1 package has no format and no production route, so it contributes a headline and two absences
// rather than a guess. Anything unreadable contributes nothing at all: a row with no title still
// reopens perfectly well, which is why this never throws.
export function summarizeCreativePackageContent(content: unknown): SavedCreativeSummary {
  const view = buildCreativePackageView(content);
  if (view.ok) {
    return { title: view.view.subject, formatLabel: view.view.formatLabel, productionLabel: view.view.productionLabel };
  }

  if (isCreativePackageContentV1(content)) {
    return { title: content.output.headline, formatLabel: null, productionLabel: null };
  }

  return EMPTY_SUMMARY;
}

// --- state derivation ----------------------------------------------------------------------------

export type SavedCreativeProductionAttempt = {
  status: AssetJobStatus;
  // The Asset this Asset Job materialized, or null when it has not produced one. Never invented: a
  // completed job with no Asset row is a real, if transient, state and is reported as such below.
  assetStatus: AssetStatus | null;
};

// The whole lifecycle vocabulary of this screen, derived from records that already exist. No column,
// table, enum or migration was added for it -- every branch below names the exact evidence it reads.
//
// Order matters, and it is outcome-first once there is an outcome to have:
//
//   1. A failed Creative Job produced no content at all.
//   2. No package row yet means the content is still being made (or, for a job that just completed,
//      still being written). Either way the owner has nothing in hand.
//   3. A package with no Asset Job has never been sent to production.
//   4. An ACCEPTED asset is the strongest outcome and outranks everything else, including a later
//      queued retry: the owner has already said yes to something.
//   5. A GENERATED (undecided) asset means there is something to look at.
//   6. Assets that are all REJECTED means production ran and produced nothing usable.
//   7. Otherwise the newest attempt's own status is the truth.
export function deriveSavedCreativeState(input: {
  jobStatus: CreativeJobStatus;
  hasPackage: boolean;
  // Newest first, matching listAssetJobsForCreativePackage's own ordering.
  attempts: SavedCreativeProductionAttempt[];
}): SavedCreativeState {
  if (input.jobStatus === "failed") {
    return "failed";
  }
  if (!input.hasPackage) {
    return "generating";
  }
  if (input.attempts.length === 0) {
    return "ready";
  }

  const assetStatuses = input.attempts.map((attempt) => attempt.assetStatus).filter((status): status is AssetStatus => status !== null);
  if (assetStatuses.includes("accepted")) {
    return "accepted";
  }
  if (assetStatuses.includes("generated")) {
    return "produced";
  }
  if (assetStatuses.includes("rejected")) {
    return "rejected";
  }

  const newest = input.attempts[0];
  if (newest.status === "queued") {
    return "ready-for-production";
  }
  if (newest.status === "failed") {
    return "production-failed";
  }
  // "running", plus the transient "completed but its Asset row is not readable yet". Both mean the
  // same thing to the owner: something is being made and there is nothing to look at yet.
  return "producing";
}

// --- deep link -----------------------------------------------------------------------------------

// The reopen URL, built from the EXISTING `?job=` parameter and the EXISTING Creative Job id. No new
// route, no new parameter name, no new identifier. resolveCreateNowJobId reads this back verbatim,
// which is what makes refreshing the URL land on the same Creative Package.
export function buildSavedCreativeReopenHref(basePath: string, creativeJobId: string): string {
  return `${basePath}?${CREATE_NOW_JOB_SEARCH_PARAM}=${encodeURIComponent(creativeJobId)}`;
}

// --- the read ------------------------------------------------------------------------------------

// Four flat reads, never N+1: jobs, then their packages, then those packages' Asset Jobs, then those
// jobs' Assets. Each later read is skipped entirely when the previous one returned nothing, so an
// empty history costs exactly one query.
export async function listSavedCreatives(
  client: CreativeHistoryClient,
  options: { limit?: number } = {},
): Promise<SavedCreativesResult> {
  const limit = options.limit ?? SAVED_CREATIVES_DEFAULT_LIMIT;

  // Job-first, not package-first, and that is what lets this list show a job that is still
  // generating or one that failed. A package-first list could only ever show work that already
  // finished -- which is precisely the work the owner is least worried about losing.
  const jobsResult = await client
    .from("creative_jobs")
    .select<CreativeJobRow>("*")
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit);

  if (jobsResult.error) {
    return { ok: false, ...dbErrorResult(jobsResult.error) };
  }

  // One malformed row must not empty the whole screen. Rows that cannot be parsed are dropped, not
  // guessed at and not thrown over -- a job row with no id has nothing to reopen anyway.
  const jobs = (jobsResult.data ?? []).flatMap((row) => {
    try {
      return [fromCreativeJobRow(row)];
    } catch {
      return [];
    }
  });

  if (jobs.length === 0) {
    return { ok: true, creatives: [] };
  }

  const packagesResult = await client
    .from("creative_packages")
    .select<CreativePackageRow>("*")
    .in("creative_job_id", jobs.map((job) => job.id));

  if (packagesResult.error) {
    return { ok: false, ...dbErrorResult(packagesResult.error) };
  }

  const packagesByJobId = new Map<string, { id: string; content: unknown }>();
  for (const row of packagesResult.data ?? []) {
    try {
      const record = fromCreativePackageRow(row);
      packagesByJobId.set(record.creativeJobId, { id: record.id, content: record.content });
    } catch {
      // Same rule as above: an unreadable package row costs that one row its title, nothing more.
    }
  }

  const attemptsByPackageId = new Map<string, SavedCreativeProductionAttempt[]>();
  const packageIds = [...packagesByJobId.values()].map((entry) => entry.id);

  if (packageIds.length > 0) {
    const assetJobsResult = await client
      .from("asset_jobs")
      .select<AssetJobRow>("*")
      .in("creative_package_id", packageIds)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false });

    if (assetJobsResult.error) {
      return { ok: false, ...dbErrorResult(assetJobsResult.error) };
    }

    const assetJobRows = (assetJobsResult.data ?? []).filter(
      (row): row is AssetJobRow & { id: string } => typeof row.id === "string" && row.id.length > 0,
    );

    const assetStatusByJobId = new Map<string, AssetStatus>();
    if (assetJobRows.length > 0) {
      const assetsResult = await client
        .from("assets")
        .select<AssetRow>("*")
        .in("asset_job_id", assetJobRows.map((row) => row.id));

      if (assetsResult.error) {
        return { ok: false, ...dbErrorResult(assetsResult.error) };
      }

      for (const row of assetsResult.data ?? []) {
        try {
          const asset = fromAssetRow(row);
          assetStatusByJobId.set(asset.assetJobId, asset.status);
        } catch {
          // An unreadable Asset row leaves its attempt reporting the Asset Job's own status, which
          // is still true -- it just cannot upgrade it to Produced / Accepted / Rejected.
        }
      }
    }

    // The query already returned them newest first, so pushing in order preserves that per package.
    for (const row of assetJobRows) {
      const attempts = attemptsByPackageId.get(row.creative_package_id) ?? [];
      attempts.push({ status: row.status, assetStatus: assetStatusByJobId.get(row.id) ?? null });
      attemptsByPackageId.set(row.creative_package_id, attempts);
    }
  }

  const creatives = jobs.map((job) => {
    const creativePackage = packagesByJobId.get(job.id) ?? null;
    const summary = creativePackage === null ? EMPTY_SUMMARY : summarizeCreativePackageContent(creativePackage.content);
    const attempts = creativePackage === null ? [] : attemptsByPackageId.get(creativePackage.id) ?? [];
    const state = deriveSavedCreativeState({ jobStatus: job.status, hasPackage: creativePackage !== null, attempts });

    return {
      creativeJobId: job.id,
      creativePackageId: creativePackage?.id ?? null,
      title: summary.title,
      createdAt: job.createdAt,
      formatLabel: summary.formatLabel,
      productionLabel: summary.productionLabel,
      state,
      stateLabel: SAVED_CREATIVE_STATE_LABELS[state],
    };
  });

  return { ok: true, creatives };
}
