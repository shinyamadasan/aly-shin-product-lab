import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

import { loadEnvFile, readSupabaseCredentials, readTimezone } from "../daily-advisor/env.ts";
import { acquireLock } from "../daily-advisor/lock.ts";
import { formatDateInTimezone } from "../daily-advisor/run.ts";
import { runTrustedCreativeJobAndMaterializePackage } from "../creative-workers/runner.ts";
import {
  createCreativeJobForAcceptedOpportunity,
  getCreativeJobForOpportunity,
  type CreativeJobClient,
  type CreativeJobRecord,
} from "../../src/lib/creative-jobs.ts";
import { createCreativePackageFromCompletedJob, getCreativePackageForJob, type CreativePackageClient } from "../../src/lib/creative-packages.ts";
import type { CreativeJobAttemptClient } from "../../src/lib/creative-job-attempts.ts";
import { selectPreparationCandidate, updateOpportunityStatus, type OpportunityReviewClient } from "../../src/lib/opportunity-review.ts";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..", "..");

// Everything the orchestration below needs: select a candidate (OpportunityReviewClient), accept
// it (same), read/create its Creative Job (CreativeJobClient), execute it (adds
// CreativeJobAttemptClient, via the trusted runner), and read/materialize its Creative Package
// (CreativePackageClient). One composite type instead of scattering `as unknown as X` casts.
export type CreativePrepClient = OpportunityReviewClient & CreativeJobClient & CreativePackageClient & CreativeJobAttemptClient;

export type CreativePrepOutcome = "ready" | "no-op" | "skipped" | "failed";

// No heartbeat, retry-count, or repair mechanism exists for a stuck Creative Job anywhere in this
// schema -- deliberately: tests/creative-job-attempts-schema.test.ts asserts the migration SQL
// contains no `repair_stale`/`stale_running`/`heartbeat`/`max_attempts`/`retry_count` construct.
// This constant is therefore reporting-only, never a recovery mechanism: it draws the line between
// "still plausibly executing" and "long enough that it almost certainly isn't" so this script can
// tell an operator the difference, without resetting, reclaiming, or retrying anything itself. Real
// stale-job recovery, if usage ever proves it necessary, is a separate proposal -- not this one.
export const CREATIVE_PREP_RUNNING_STALE_AFTER_MS = 5 * 60 * 1000;

export type CreativePrepResult = {
  selectedOpportunityId: string | null;
  startingState: string | null;
  actionsTaken: string[];
  outcome: CreativePrepOutcome;
  reason?: string;
  creativePackageId?: string;
};

// The one orchestration function this whole slice exists to add. Every state transition below
// delegates to an existing, already-tested canonical function -- this function only decides
// *when* to call each one, based on what it finds. No business rule is reimplemented here.
export async function runCreativePreparation(client: CreativePrepClient, options: { now?: () => number } = {}): Promise<CreativePrepResult> {
  const now = options.now ?? Date.now;
  const actionsTaken: string[] = [];

  const selection = await selectPreparationCandidate(client);
  if (!selection.ok) {
    return { selectedOpportunityId: null, startingState: null, actionsTaken, outcome: "failed", reason: selection.message };
  }
  if (!selection.opportunity) {
    return { selectedOpportunityId: null, startingState: null, actionsTaken, outcome: "no-op", reason: "No new or accepted Opportunity is eligible for preparation." };
  }

  const opportunityId = selection.opportunity.id;
  const startingState = selection.opportunity.status;

  if (selection.opportunity.status === "new") {
    const accepted = await updateOpportunityStatus(client, opportunityId, "accepted", {});
    if (!accepted.ok) {
      return { selectedOpportunityId: opportunityId, startingState, actionsTaken, outcome: "failed", reason: accepted.message };
    }
    actionsTaken.push("accepted-opportunity");
  }

  let jobRecord: CreativeJobRecord;
  const existingJob = await getCreativeJobForOpportunity(client, opportunityId);
  if (existingJob.ok) {
    jobRecord = existingJob.job;
  } else if (existingJob.reason === "not-found") {
    const created = await createCreativeJobForAcceptedOpportunity(client, opportunityId, { workerType: "opportunity_brief" });
    if (!created.ok) {
      return { selectedOpportunityId: opportunityId, startingState, actionsTaken, outcome: "failed", reason: created.message };
    }
    actionsTaken.push(created.outcome === "created" ? "created-creative-job" : "creative-job-already-existed");
    jobRecord = created.job;
  } else {
    return { selectedOpportunityId: opportunityId, startingState, actionsTaken, outcome: "failed", reason: existingJob.message };
  }

  if (jobRecord.status === "queued") {
    const run = await runTrustedCreativeJobAndMaterializePackage(client, jobRecord.id);
    if (!run.ok) {
      return { selectedOpportunityId: opportunityId, startingState, actionsTaken, outcome: "failed", reason: run.message };
    }
    actionsTaken.push("executed-creative-job", "materialized-creative-package");
    return { selectedOpportunityId: opportunityId, startingState, actionsTaken, outcome: "ready", creativePackageId: run.creativePackage.id };
  }

  if (jobRecord.status === "completed") {
    const existingPackage = await getCreativePackageForJob(client, jobRecord.id);
    if (existingPackage.ok) {
      return {
        selectedOpportunityId: opportunityId,
        startingState,
        actionsTaken,
        outcome: "no-op",
        reason: "Creative Package already ready.",
        creativePackageId: existingPackage.creativePackage.id,
      };
    }
    if (existingPackage.reason !== "not-found") {
      return { selectedOpportunityId: opportunityId, startingState, actionsTaken, outcome: "failed", reason: existingPackage.message };
    }

    const materialized = await createCreativePackageFromCompletedJob(client, jobRecord.id);
    if (!materialized.ok) {
      return { selectedOpportunityId: opportunityId, startingState, actionsTaken, outcome: "failed", reason: materialized.message };
    }
    actionsTaken.push("materialized-creative-package");
    return { selectedOpportunityId: opportunityId, startingState, actionsTaken, outcome: "ready", creativePackageId: materialized.creativePackage.id };
  }

  // A terminal failure is not the same operational condition as a job someone else is currently
  // executing. "failed" means the selected Opportunity cannot become ready without an operator
  // looking at it -- that must surface as this run's own failure, not a shrug.
  if (jobRecord.status === "failed") {
    return {
      selectedOpportunityId: opportunityId,
      startingState,
      actionsTaken,
      outcome: "failed",
      reason: `Creative Job failed and requires operator attention: ${jobRecord.lastError || "no error message recorded"}.`,
    };
  }

  // jobRecord.status === "running" here. Ordinarily benign and temporary -- another trusted-worker
  // invocation may genuinely own this job right now -- but with no heartbeat or repair mechanism
  // anywhere in this schema (see CREATIVE_PREP_RUNNING_STALE_AFTER_MS above), a job abandoned by a
  // crashed process would otherwise stay "running" forever and get silently reported as fine every
  // single night. This branch never mutates the row -- it only decides how to *describe* what it
  // found, using the job's own started_at, already in hand from the read above.
  const startedAtMs = jobRecord.startedAt ? Date.parse(jobRecord.startedAt) : NaN;
  if (!Number.isFinite(startedAtMs)) {
    return {
      selectedOpportunityId: opportunityId,
      startingState,
      actionsTaken,
      outcome: "failed",
      reason: "Creative Job is running, but its started_at is missing or invalid, so this script cannot safely establish that the running state is healthy. Requires operator attention. The job row was not modified.",
    };
  }

  const runningForMs = now() - startedAtMs;
  if (runningForMs >= CREATIVE_PREP_RUNNING_STALE_AFTER_MS) {
    return {
      selectedOpportunityId: opportunityId,
      startingState,
      actionsTaken,
      outcome: "failed",
      reason: `Creative Job appears stuck (suspected stale): running for ${runningForMs}ms, at or beyond the ${CREATIVE_PREP_RUNNING_STALE_AFTER_MS}ms staleness threshold. Requires operator attention. The job row was not modified.`,
    };
  }

  return {
    selectedOpportunityId: opportunityId,
    startingState,
    actionsTaken,
    outcome: "skipped",
    reason: `Creative Job is running elsewhere (started ${runningForMs}ms ago, below the ${CREATIVE_PREP_RUNNING_STALE_AFTER_MS}ms staleness threshold); execution may still be active. Not advanced automatically.`,
  };
}

function log(level: "info" | "warn" | "error", message: string): void {
  const timestamp = new Date().toISOString();
  console[level === "error" ? "error" : "log"](`[${timestamp}] [${level.toUpperCase()}] ${message}`);
}

// 0 = clean run where nothing requires attention: ready, no-op, or a benign skip (running
// elsewhere, recently enough that it's still plausible). 1 = a terminal failure -- an outright
// operation error, a Creative Job that actually failed, or one whose "running" state can no
// longer be trusted (suspected stale, or started_at missing/invalid) -- all of which mean the
// selected Opportunity cannot become ready without an operator. 2 = preflight abort (missing
// credentials). 3 = another instance already holds the run lock. Mirrors daily-advisor/run.ts's
// own convention so both scheduled scripts share one mental model for monitoring -- with the
// important difference that a monitor watching only exit codes must still see anything blocking
// Today's readiness as a non-zero run, not just an outright crash.
export function exitCodeForOutcome(outcome: CreativePrepOutcome): number {
  return outcome === "failed" ? 1 : 0;
}

export type ClientCreationResult = { ok: true; client: CreativePrepClient } | { ok: false; exitCode: number; message: string };

async function createRealClient(): Promise<ClientCreationResult> {
  const credsResult = readSupabaseCredentials();
  if (!credsResult.ok) {
    return { ok: false, exitCode: 2, message: `Missing required Supabase credentials in .env.advisor.local: ${credsResult.missing.join(", ")}` };
  }
  const client = createClient(credsResult.credentials.url, credsResult.credentials.anonKey);
  const signIn = await client.auth.signInWithPassword({ email: credsResult.credentials.email, password: credsResult.credentials.password });
  if (signIn.error) {
    return { ok: false, exitCode: 1, message: `Supabase sign-in failed: ${signIn.error.message}` };
  }
  return { ok: true, client: client as unknown as CreativePrepClient };
}

// Writes are isolated in their own function so a write failure can be caught and reported as this
// run's own failure (see runCreativePrepCli) without losing the lock-release guarantee below.
export function writeCreativePrepOutput(outputDir: string, date: string, record: Record<string, unknown>): void {
  mkdirSync(outputDir, { recursive: true });
  const line = JSON.stringify(record);
  // Appended, not overwritten -- a failed scheduled run followed by a successful manual catch-up
  // must both remain visible in today's history, not have the first silently erased.
  appendFileSync(path.join(outputDir, `${date}.jsonl`), `${line}\n`, "utf8");
  // Convenience pointer only, always overwritten -- mirrors daily-advisor's own latest.md, which
  // its README notes is "deliberately never read by the delivery workflow, to avoid resending
  // stale content on a missed run." Nothing here should read this file as a source of truth either.
  writeFileSync(path.join(outputDir, "latest.json"), `${line}\n`, "utf8");
}

export type CreativePrepCliOptions = {
  lockPath: string;
  outputDir: string;
  createClient: () => Promise<ClientCreationResult>;
  timezone?: string;
  now?: () => number;
};

export type CreativePrepCliResult = { exitCode: number; result?: CreativePrepResult };

// The entire testable CLI shell: lock, credentials, orchestration, output, exit code -- as one
// function with a single try/finally, rather than daily-advisor/run.ts's pattern of calling
// process.exit() at each of several internal exit points. That pattern exists there because
// process.exit() skips a pending finally block, so a script with several internal process.exit()
// calls has to release the lock explicitly before each one. This script instead has exactly one
// process.exit() call, in main() below, made only *after* this function has already returned --
// by then there is no pending finally left to skip, so a plain try/finally is both correct and
// (unlike scattered process.exit calls) directly unit-testable without ending the test process.
export async function runCreativePrepCli(options: CreativePrepCliOptions): Promise<CreativePrepCliResult> {
  const lockResult = acquireLock(options.lockPath);
  if (!lockResult.ok) {
    log("error", `Run lock rejected: ${lockResult.reason}`);
    return { exitCode: 3 };
  }

  try {
    const clientResult = await options.createClient();
    if (!clientResult.ok) {
      log("error", clientResult.message);
      return { exitCode: clientResult.exitCode };
    }

    const timezone = options.timezone ?? readTimezone(undefined);
    const startedAt = options.now?.() ?? Date.now();
    const date = formatDateInTimezone(startedAt, timezone);

    const result = await runCreativePreparation(clientResult.client, { now: options.now });
    const durationMs = (options.now?.() ?? Date.now()) - startedAt;
    const record = { date, timezone, ...result, durationMs };

    try {
      writeCreativePrepOutput(options.outputDir, date, record);
    } catch (err) {
      log("error", `Failed to write creative-prep output: ${err instanceof Error ? err.message : String(err)}`);
      return { exitCode: 1, result };
    }

    log(
      result.outcome === "failed" ? "error" : "info",
      `Outcome: ${result.outcome}. ${result.reason ?? ""} (Opportunity: ${result.selectedOpportunityId ?? "none"}; actions: ${result.actionsTaken.join(", ") || "none"})`,
    );

    return { exitCode: exitCodeForOutcome(result.outcome), result };
  } finally {
    lockResult.release();
  }
}

async function main(): Promise<void> {
  loadEnvFile(path.join(PROJECT_ROOT, ".env.advisor.local"));

  const { exitCode } = await runCreativePrepCli({
    lockPath: path.join(PROJECT_ROOT, "creative-prep", ".run.lock"),
    outputDir: path.join(PROJECT_ROOT, "creative-prep", "output"),
    createClient: createRealClient,
  });

  process.exit(exitCode);
}

// Guard so this module can be imported by tests (to reuse runCreativePreparation/runCreativePrepCli)
// without triggering a real run as a side effect of import.
const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename);
if (isMainModule) {
  main().catch((err) => {
    log("error", `Unhandled error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    process.exit(1);
  });
}
