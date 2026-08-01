import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { validateOpportunityDraft, type OpportunityDraft } from "../../src/lib/opportunities.ts";
import type { MarketingBrief } from "../../src/lib/marketing-brief.ts";
import type { MarketingOpportunitySuggestionsResponse } from "../../src/lib/marketing-opportunity-suggestions.ts";
import { persistOpportunityDrafts, type OpportunityPersistenceClient } from "../daily-advisor/opportunity-persistence.ts";
import type { MarketingAdvisorManifest, MarketingAdvisorSessionStatus } from "./marketing-advisor-manual-export.ts";
import { buildSessionMetadata, buildSessionStats, enrichDraftForPersistence } from "./marketing-advisor-evidence.ts";
import { runQueueEligibilityChecks, MAX_SESSION_AGE_DAYS, type QueueEligibilityExclusion } from "./marketing-advisor-queue-eligibility.ts";

export type PersistOutcome = { exitCode: number; message?: string };

const READY_STATUSES: readonly MarketingAdvisorSessionStatus[] = ["completed", "persisted", "persist_failed"];

// Its own independent read-modify-write, mirroring updateMarketingAdvisorManifestStatus's pattern
// (PROP-021's import-time function) but setting a disjoint set of fields -- called exactly once,
// at the very end of persist, never mid-pipeline.
export function updateMarketingAdvisorManifestAfterPersist(
  sessionDir: string,
  update: { status: "persisted" | "persist_failed"; persistedAt: string; persistence: NonNullable<MarketingAdvisorManifest["persistence"]> },
): void {
  const manifestPath = path.join(sessionDir, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as MarketingAdvisorManifest;
  manifest.status = update.status;
  manifest.persistedAt = update.persistedAt;
  manifest.persistence = update.persistence;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
}

function readJsonFile<T>(filePath: string, label: string): { ok: true; value: T } | { ok: false; message: string } {
  try {
    return { ok: true, value: JSON.parse(readFileSync(filePath, "utf8")) as T };
  } catch (err) {
    return { ok: false, message: `Could not read ${label}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// Orchestration only -- sequencing (read -> gate -> enrich -> structural gate -> queue eligibility
// -> persist -> record), delegating the actual work to marketing-advisor-evidence.ts, marketing-
// advisor-queue-eligibility.ts, and the reused persistOpportunityDrafts. Never falsely marks a
// session persisted: the manifest is untouched on every exit-2 (usage/refusal) path.
export async function runPersistCommand(
  client: OpportunityPersistenceClient,
  options: { sessionDir: string; now: number; force?: boolean },
): Promise<PersistOutcome> {
  const { sessionDir } = options;

  const manifestResult = readJsonFile<MarketingAdvisorManifest>(path.join(sessionDir, "manifest.json"), `manifest.json in --session-dir ${sessionDir}`);
  if (!manifestResult.ok) {
    return { exitCode: 2, message: manifestResult.message };
  }
  const manifest = manifestResult.value;

  if (!READY_STATUSES.includes(manifest.status)) {
    return { exitCode: 2, message: `Session ${sessionDir} has status "${manifest.status}" -- persist requires completed, persisted, or persist_failed.` };
  }

  const briefResult = readJsonFile<MarketingBrief>(path.join(sessionDir, "brief.json"), `brief.json in --session-dir ${sessionDir}`);
  if (!briefResult.ok) {
    return { exitCode: 2, message: briefResult.message };
  }
  const brief = briefResult.value;
  if (brief.generatedAt !== manifest.briefGeneratedAt) {
    return { exitCode: 2, message: `brief.json's generatedAt does not match manifest.briefGeneratedAt for session ${sessionDir} -- refusing a possibly tampered session.` };
  }

  const responseResult = readJsonFile<MarketingOpportunitySuggestionsResponse>(path.join(sessionDir, "response.json"), `response.json in --session-dir ${sessionDir}`);
  if (!responseResult.ok) {
    return { exitCode: 2, message: responseResult.message };
  }

  const draftsResult = readJsonFile<OpportunityDraft[]>(path.join(sessionDir, "drafts.json"), `drafts.json in --session-dir ${sessionDir}`);
  if (!draftsResult.ok) {
    return { exitCode: 2, message: draftsResult.message };
  }

  const sessionMetadata = buildSessionMetadata(manifest);
  const sessionStats = buildSessionStats(brief, responseResult.value);
  const enrichedDrafts = draftsResult.value.map((draft) => enrichDraftForPersistence(draft, sessionMetadata, sessionStats));

  const attemptedAt = new Date(options.now).toISOString();

  for (const draft of enrichedDrafts) {
    const validation = validateOpportunityDraft(draft);
    if (!validation.ok) {
      updateMarketingAdvisorManifestAfterPersist(sessionDir, {
        status: "persist_failed",
        persistedAt: attemptedAt,
        persistence: { attemptedAt, inserted: 0, updated: 0, skipped: 0, failed: enrichedDrafts.length, excluded: [] },
      });
      return { exitCode: 1, message: `A draft in session ${sessionDir} failed structural validation: ${validation.errors.join(" ")}` };
    }
  }

  let eligible: OpportunityDraft[];
  let excluded: QueueEligibilityExclusion[];

  if (options.force) {
    eligible = enrichedDrafts;
    excluded = [];
  } else {
    const eligibility = runQueueEligibilityChecks(enrichedDrafts, options.now, brief.generatedAt);
    if (eligibility.sessionStale) {
      return {
        exitCode: 2,
        message: `Session ${sessionDir} is ${eligibility.sessionAgeDays.toFixed(1)} days old, over the ${MAX_SESSION_AGE_DAYS} day limit -- refusing without --force.`,
      };
    }
    eligible = eligibility.eligible;
    excluded = eligibility.excluded;
  }

  // `eligible` may legitimately be empty here -- an empty drafts.json (the AI proposed zero
  // suggestions, already documented as a legitimate outcome by PROP-021's own prompt) or a batch
  // where every draft was excluded both reach this line with eligible=[]. persistOpportunityDrafts
  // makes zero Supabase calls for an empty array and returns ok:true with all-zero counts, so both
  // cases succeed trivially as a `persisted` session with zero queued Opportunities -- not an
  // error, since nothing failed and there was nothing left to do.
  const result = await persistOpportunityDrafts(client, eligible, { now: () => attemptedAt });

  writeFileSync(path.join(sessionDir, "persistence-result.json"), JSON.stringify({ ...result, excluded }, null, 2), "utf8");

  const excludedForManifest = excluded.map(({ title, rule, recommendationIds }) => ({ title, rule, recommendationIds }));
  updateMarketingAdvisorManifestAfterPersist(sessionDir, {
    status: result.ok ? "persisted" : "persist_failed",
    persistedAt: attemptedAt,
    persistence: {
      attemptedAt,
      inserted: result.inserted,
      updated: result.updated,
      skipped: result.skipped,
      failed: result.failed,
      excluded: excludedForManifest,
    },
  });

  const message = `Queued ${result.inserted + result.updated} Opportunity(ies) for review (${result.inserted} new, ${result.updated} updated, ${result.skipped} already reviewed, ${excluded.length} excluded by queue eligibility checks).`;

  return { exitCode: result.ok ? 0 : 1, message };
}
