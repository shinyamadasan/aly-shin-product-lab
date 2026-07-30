import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { createClient } from "@supabase/supabase-js";

import { getCreativeJobById } from "../../src/lib/creative-jobs.ts";
import type { CreativePackageRunnerClient } from "../../src/lib/creative-packages.ts";
import { getOpportunityDetail, type OpportunityReviewClient } from "../../src/lib/opportunity-review.ts";
import { loadEnvFile, readSupabaseCredentials } from "../daily-advisor/env.ts";
import { buildManualExportDocument, buildManualResultExecutor, parseManualProductTextResult } from "./manual-text-provider.ts";
import { createAnthropicProductTextExecutor } from "./anthropic-text-provider.ts";
import { runTrustedCreativeJobAndMaterializePackage } from "./runner.ts";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..", "..");

// Everything below needs read+write on creative_jobs/creative_job_attempts/creative_packages
// (via CreativePackageRunnerClient, which already includes CreativeJobAttemptClient) plus
// read on opportunities (via OpportunityReviewClient). One local composite type instead of
// scattering `as unknown as X` casts at each call site.
export type CreativeWorkerCliClient = CreativePackageRunnerClient & OpportunityReviewClient;

export type CliOutcome = { exitCode: number; message?: string };
export type ExportOutcome = CliOutcome & { document?: string };

export type Subcommand = "export" | "import" | "run-api";
const SUBCOMMANDS: readonly Subcommand[] = ["export", "import", "run-api"];

export function parseSubcommand(argv: string[]): Subcommand | null {
  const [candidate] = argv;
  return candidate && (SUBCOMMANDS as readonly string[]).includes(candidate) ? (candidate as Subcommand) : null;
}

export function resolveAnthropicApiKey(env: Record<string, string | undefined>): { ok: true; apiKey: string } | { ok: false; message: string } {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { ok: false, message: "ANTHROPIC_API_KEY is not set. Set it in .env.creative-workers.local or the environment before using run-api." };
  }
  return { ok: true, apiKey };
}

// Read-only: looks up the queued job and its Opportunity, builds the export document. Never
// claims or mutates the job -- there is no `.update(` or `.rpc(` call anywhere in this function.
export async function runExportCommand(client: CreativeWorkerCliClient, jobId: string): Promise<ExportOutcome> {
  const jobResult = await getCreativeJobById(client, jobId);
  if (!jobResult.ok) {
    return { exitCode: 1, message: jobResult.message };
  }
  if (jobResult.job.status !== "queued") {
    return { exitCode: 2, message: `Creative Job ${jobId} is not queued (status: ${jobResult.job.status}). Export only reads queued jobs; nothing is claimed.` };
  }
  if (jobResult.job.workerType !== "product_text_worker") {
    return { exitCode: 2, message: `Creative Job ${jobId} has worker type ${jobResult.job.workerType}, not product_text_worker.` };
  }

  const opportunityResult = await getOpportunityDetail(client, jobResult.job.opportunityId);
  if (!opportunityResult.ok) {
    return { exitCode: 1, message: opportunityResult.message };
  }

  return { exitCode: 0, document: buildManualExportDocument(jobResult.job, opportunityResult.opportunity) };
}

// Validates the manual result BEFORE touching the client at all. An invalid/incomplete result
// returns here, and runTrustedCreativeJobAndMaterializePackage (and therefore the atomic claim)
// is never reached -- the job is never claimed on a bad input.
export async function runImportCommand(client: CreativeWorkerCliClient, jobId: string, rawResult: string): Promise<CliOutcome> {
  const parsed = parseManualProductTextResult(rawResult);
  if (!parsed.ok) {
    return { exitCode: 2, message: `Manual result is invalid: ${parsed.message}. Creative Job ${jobId} was NOT claimed.` };
  }

  const executor = buildManualResultExecutor(parsed.result);
  const result = await runTrustedCreativeJobAndMaterializePackage(client, jobId, { executors: { product_text_worker: executor } });

  if (!result.ok) {
    return { exitCode: 1, message: `Creative Job ${jobId} did not complete: ${result.message}` };
  }
  return { exitCode: 0, message: `Creative Job ${jobId} completed. Package outcome: ${result.packageOutcome}.` };
}

// `createClient` is a lazily-invoked factory, not an already-built client: the API-key check
// below must happen before any Supabase connection is attempted, not just before any Anthropic
// request. If the key is missing, `createClient` is never called and `fetchImpl` is never called.
export async function runApiCommand(
  createClient: () => Promise<CreativeWorkerCliClient>,
  jobId: string,
  env: Record<string, string | undefined>,
  fetchImpl?: typeof fetch,
): Promise<CliOutcome> {
  const keyResult = resolveAnthropicApiKey(env);
  if (!keyResult.ok) {
    return { exitCode: 2, message: keyResult.message };
  }

  const client = await createClient();
  const executor = createAnthropicProductTextExecutor({ apiKey: keyResult.apiKey, fetchImpl });
  const result = await runTrustedCreativeJobAndMaterializePackage(client, jobId, { executors: { product_text_worker: executor } });

  if (!result.ok) {
    return { exitCode: 1, message: `Creative Job ${jobId} did not complete: ${result.message}` };
  }
  return { exitCode: 0, message: `Creative Job ${jobId} completed via the Anthropic API. Package outcome: ${result.packageOutcome}.` };
}

function log(level: "info" | "warn" | "error", message: string): void {
  const timestamp = new Date().toISOString();
  console[level === "error" ? "error" : "log"](`[${timestamp}] [${level.toUpperCase()}] ${message}`);
}

function printUsage(): void {
  log("info", "Usage:");
  log("info", "  node scripts/creative-workers/run.ts export --job-id <id> [--out <path>]");
  log("info", "  node scripts/creative-workers/run.ts import --job-id <id> --result-file <path>");
  log("info", "  node scripts/creative-workers/run.ts run-api --job-id <id>");
  log("info", "");
  log("info", "export and import are free and require no API key -- they use your existing Claude Code subscription manually.");
  log("info", "run-api calls the Anthropic API directly and may incur real charges. Requires ANTHROPIC_API_KEY.");
}

async function createRealClient(): Promise<CreativeWorkerCliClient> {
  loadEnvFile(path.join(PROJECT_ROOT, ".env.advisor.local"));
  const credsResult = readSupabaseCredentials();
  if (!credsResult.ok) {
    log("error", `Missing required Supabase credentials in .env.advisor.local: ${credsResult.missing.join(", ")}`);
    process.exit(2);
  }
  const client = createClient(credsResult.credentials.url, credsResult.credentials.anonKey);
  const signIn = await client.auth.signInWithPassword({ email: credsResult.credentials.email, password: credsResult.credentials.password });
  if (signIn.error) {
    log("error", `Supabase sign-in failed: ${signIn.error.message}`);
    process.exit(1);
  }
  return client as unknown as CreativeWorkerCliClient;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const subcommand = parseSubcommand(argv);

  if (!subcommand) {
    printUsage();
    process.exit(argv[0] ? 2 : 0);
  }

  const { values } = parseArgs({
    args: argv.slice(1),
    options: {
      "job-id": { type: "string" },
      out: { type: "string" },
      "result-file": { type: "string" },
    },
  });

  const jobId = values["job-id"];
  if (!jobId) {
    log("error", "--job-id is required.");
    process.exit(2);
  }

  if (subcommand === "export") {
    const client = await createRealClient();
    const outcome = await runExportCommand(client, jobId);
    if (outcome.document) {
      if (values.out) {
        writeFileSync(values.out, outcome.document, "utf8");
        log("info", `Export written to ${values.out}. Job ${jobId} was only read, not claimed.`);
      } else {
        console.log(outcome.document);
      }
    }
    if (outcome.message) {
      log(outcome.exitCode === 0 ? "info" : "error", outcome.message);
    }
    process.exit(outcome.exitCode);
  }

  if (subcommand === "import") {
    if (!values["result-file"]) {
      log("error", "--result-file is required for import.");
      process.exit(2);
    }
    const raw = readFileSync(values["result-file"], "utf8");
    const client = await createRealClient();
    const outcome = await runImportCommand(client, jobId, raw);
    log(outcome.exitCode === 0 ? "info" : "error", outcome.message ?? "");
    process.exit(outcome.exitCode);
  }

  // run-api: load the creative-workers env file only for this branch, and only after we're
  // already committed to the paid path by virtue of the explicit subcommand.
  loadEnvFile(path.join(PROJECT_ROOT, ".env.creative-workers.local"));
  const outcome = await runApiCommand(createRealClient, jobId, process.env);
  log(outcome.exitCode === 0 ? "info" : "error", outcome.message ?? "");
  process.exit(outcome.exitCode);
}

const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename);
if (isMainModule) {
  main().catch((err) => {
    log("error", `Unhandled error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    process.exit(1);
  });
}
