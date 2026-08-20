import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { createClient } from "@supabase/supabase-js";

import {
  ASSET_SOURCE_KINDS,
  buildAssetGenerationSpecForJob,
  getAssetJobById,
  isAssetSourceKind,
  runAssetJobWithExecutors,
  type AssetJobExecutionClient,
  type AssetJobRecord,
  type AssetSourceKind,
} from "../../src/lib/asset-jobs.ts";
import { buildAssetUploadCandidate } from "../../src/lib/asset-upload-intake.ts";
import type { AssetGenerationSpecV1 } from "../../src/lib/asset-generation-spec.ts";
import { renderAssetGenerationBrief } from "../../src/lib/asset-generation-brief.ts";
import { buildExternalAssetExecutor } from "../../src/lib/external-asset-provider.ts";
import type { GenerativeImageProvenance } from "../../src/lib/production-asset-executors.ts";
import {
  CLI_PRODUCTION_EXECUTOR_TIMEOUTS_MS,
  executeProductionAssetJob,
  type ProductionWorkerType,
} from "../../src/lib/production-execution.ts";
import { loadEnvFile, readSupabaseCredentials } from "../daily-advisor/env.ts";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..", "..");

export type CliOutcome = { exitCode: number; message?: string };

// Distinct from 1 on purpose, because it demands the OPPOSITE operator response.
//
//   1 -> nothing was produced; fix the cause and re-run.
//   3 -> the asset WAS produced and is correct; only bookkeeping failed. Re-running would create a
//        second asset, so the fix is to apply the missing migration, not to retry the job.
export const ATTEMPT_BOOKKEEPING_EXIT_CODE = 3;
export type ExportOutcome = CliOutcome & { document?: string };

export type Subcommand = "export" | "import" | "run";
const SUBCOMMANDS: readonly Subcommand[] = ["export", "import", "run"];

export function parseSubcommand(argv: string[]): Subcommand | null {
  const [candidate] = argv;
  return candidate && (SUBCOMMANDS as readonly string[]).includes(candidate) ? (candidate as Subcommand) : null;
}

// The one CLI-specific piece of presentation: wraps the shared, canonical brief (identical to
// whatever a future browser UI will show) with copy/paste and import instructions. Never renders
// the brief itself -- that stays renderAssetGenerationBrief's job, so CLI and UI can never disagree
// about what the brief actually says.
export function buildAssetExportDocument(job: Pick<AssetJobRecord, "id">, spec: AssetGenerationSpecV1): string {
  return [
    `# Asset Job manual export -- job ${job.id}`,
    "",
    "Paste everything below the divider into any external creative workspace (ChatGPT, Claude, Midjourney, Canva, or similar) and save the resulting image. A real camera photo works too -- skip straight to saving the image.",
    "",
    "---",
    "",
    renderAssetGenerationBrief(spec),
    "",
    "---",
    "",
    "Save the image, then run:",
    `  node scripts/asset-workers/run.ts import --job-id ${job.id} --file <path-to-image> --workspace <workspace-name>`,
  ].join("\n");
}

// Read-only: looks up the queued job, resolves its spec via the same function
// runAssetJobWithExecutors itself uses post-claim, and renders the export document. Never claims
// or mutates the job -- there is no .update( or .rpc( call anywhere in this function.
export async function runExportCommand(client: AssetJobExecutionClient, jobId: string): Promise<ExportOutcome> {
  const jobResult = await getAssetJobById(client, jobId);
  if (!jobResult.ok) {
    return { exitCode: 1, message: jobResult.message };
  }
  if (jobResult.job.status !== "queued") {
    return { exitCode: 2, message: `Asset Job ${jobId} is not queued (status: ${jobResult.job.status}). Export only reads queued jobs; nothing is claimed.` };
  }
  if (jobResult.job.workerType !== "external") {
    return { exitCode: 2, message: `Asset Job ${jobId} has worker type ${jobResult.job.workerType}, not external.` };
  }

  const specResult = await buildAssetGenerationSpecForJob(client, jobResult.job);
  if (!specResult.ok) {
    return { exitCode: 1, message: specResult.message };
  }

  return { exitCode: 0, document: buildAssetExportDocument(jobResult.job, specResult.spec) };
}

// Validates the imported bytes BEFORE touching the client at all, via buildAssetUploadCandidate --
// the same canonical intake boundary a future browser upload uses, so an invalid file fails here,
// locally, exactly as it would in the browser, leaving the Asset Job untouched and still queued.
// Takes already-read bytes, not a file path, so this stays directly unit-testable with in-memory
// fixtures, matching runImportCommand's own text-worker precedent. The CLI holds no independent
// "bytes -> candidate" logic of its own -- there is exactly one implementation, shared with every
// other upload source.
export async function runImportCommand(
  client: AssetJobExecutionClient,
  jobId: string,
  bytes: Uint8Array,
  workspace: string,
  sourceKind?: AssetSourceKind,
): Promise<CliOutcome> {
  const intake = await buildAssetUploadCandidate(bytes);
  if (!intake.ok) {
    return { exitCode: 2, message: `Import file is invalid: ${intake.message} Asset Job ${jobId} was NOT claimed.` };
  }

  const executor = buildExternalAssetExecutor(intake.candidate);
  const result = await runAssetJobWithExecutors(client, jobId, { external: executor }, { sourceWorkspace: workspace, sourceKind });

  if (!result.ok) {
    return { exitCode: 1, message: `Asset Job ${jobId} did not complete: ${result.message}` };
  }
  return { exitCode: 0, message: `Asset Job ${jobId} completed.` };
}

// TECHNICAL / ACCEPTANCE-TESTING SURFACE, deliberately.
//
// This is the CLI half of machine production. It shares ONE execution boundary with the owner-facing
// route -- executeProductionAssetJob -- so neither path can drift from the other's guarantees. All
// this function adds is the CLI's own contract: exit codes and operator-readable lines.
//
// Unlike the route, this runs in a plain Node process with no platform ceiling, so it uses the
// executor's own full budget rather than the reduced web one.
export async function runProductionWorkerCommand(
  client: AssetJobExecutionClient,
  jobId: string,
  workerType: ProductionWorkerType,
): Promise<CliOutcome & { provenance?: GenerativeImageProvenance }> {
  const outcome = await executeProductionAssetJob(client, jobId, workerType, {
    timeoutMs: CLI_PRODUCTION_EXECUTOR_TIMEOUTS_MS[workerType],
  });

  switch (outcome.kind) {
    case "not-configured":
      return { exitCode: 2, message: outcome.message };

    case "failed":
      return { exitCode: 1, message: `Asset Job ${jobId} did not complete: ${outcome.message}`, provenance: outcome.provenance };

    case "bookkeeping-failed": {
      const file = outcome.files[0];
      const asset = file ? `: ${file.publicUrl || file.storagePath}` : ".";
      return {
        exitCode: ATTEMPT_BOOKKEEPING_EXIT_CODE,
        message:
          `Asset Job ${jobId} produced its asset${asset} BUT attempt bookkeeping FAILED: ${outcome.message}
` +
          `The Asset and the Asset Job are complete and correct -- do NOT re-run this command, which would produce a SECOND asset.
` +
          `asset_job_attempts row for this run is likely still status='running', and its provider/model were not recorded.
` +
          `Most likely cause: supabase-add-asset-job-attempt-provenance.sql has not been applied to this Supabase project.`,
        provenance: outcome.provenance,
      };
    }

    case "completed": {
      const file = outcome.files[0];
      const asset = file ? `: ${file.publicUrl || file.storagePath}` : ".";
      return { exitCode: 0, message: `Asset Job ${jobId} completed${asset}`, provenance: outcome.provenance };
    }
  }
}

function log(level: "info" | "warn" | "error", message: string): void {
  const timestamp = new Date().toISOString();
  console[level === "error" ? "error" : "log"](`[${timestamp}] [${level.toUpperCase()}] ${message}`);
}

function printUsage(): void {
  log("info", "Usage:");
  log("info", "  node scripts/asset-workers/run.ts export --job-id <id> [--out <path>]");
  log("info", "  node scripts/asset-workers/run.ts import --job-id <id> --file <path> --workspace <name> [--source-kind ai_generated|photograph|human_designed]");
  log("info", "  node scripts/asset-workers/run.ts run --job-id <id> --worker static_renderer|generative_image");
  log("info", "");
  log("info", "export and import never call any image-generation API and require no API key -- the image");
  log("info", "comes from any external creative workspace (ChatGPT, Claude, Midjourney, Canva) or a real camera.");
  log("info", "");
  log("info", "MIGRATION ORDER: `run --worker generative_image` records provider/model provenance on");
  log("info", "asset_job_attempts and therefore REQUIRES supabase-add-asset-job-attempt-provenance.sql to");
  log("info", "have been applied first. Without it the asset is still produced, but attempt bookkeeping");
  log("info", `fails and this command exits ${ATTEMPT_BOOKKEEPING_EXIT_CODE} rather than 0. static_renderer, export and import do not need it.`);
  log("info", "");
  log("info", "Exit codes: 0 ok | 1 the job did not complete | 2 bad arguments |");
  log("info", `            ${ATTEMPT_BOOKKEEPING_EXIT_CODE} the asset WAS produced but attempt bookkeeping failed (do not re-run; apply the migration)`);
}

async function createRealClient(): Promise<AssetJobExecutionClient> {
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
  return client as unknown as AssetJobExecutionClient;
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
      file: { type: "string" },
      workspace: { type: "string" },
      "source-kind": { type: "string" },
      worker: { type: "string" },
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

  if (subcommand === "run") {
    if (values.worker !== "static_renderer" && values.worker !== "generative_image") {
      log("error", "--worker must be static_renderer or generative_image.");
      process.exit(2);
    }
    const client = await createRealClient();
    const outcome = await runProductionWorkerCommand(client, jobId, values.worker);
    if (outcome.provenance) {
      const { provider, model, transportAttempts, promptSha256, references } = outcome.provenance;
      log("info", `Provenance: provider=${provider} model=${model} transportAttempts=${transportAttempts} promptSha256=${promptSha256}`);
      for (const reference of references) {
        log("info", `Reference: ${reference.fileName} ${reference.mimeType} ${reference.width}x${reference.height} ${reference.byteSize}B sha256=${reference.sha256}`);
      }
      // provider/model are now persisted by the runner onto asset_job_attempts. The rest of this
      // object (endpoint, transport attempt count, prompt digest, reference identities) has no
      // column and is deliberately reported here only -- see the SECURITY / PRIVACY note in
      // supabase-add-asset-job-attempt-provenance.sql.
      log("info", "provider/model were recorded on this attempt; the prompt digest and reference identities above are reported only, never stored.");
    }
    log(outcome.exitCode === 0 ? "info" : "error", outcome.message ?? "");
    process.exit(outcome.exitCode);
  }

  // import
  if (!values.file) {
    log("error", "--file is required for import.");
    process.exit(2);
  }
  if (!values.workspace) {
    log("error", "--workspace is required for import.");
    process.exit(2);
  }
  if (values["source-kind"] !== undefined && !isAssetSourceKind(values["source-kind"])) {
    log("error", `--source-kind must be one of: ${ASSET_SOURCE_KINDS.join(", ")}.`);
    process.exit(2);
  }
  const sourceKind = values["source-kind"] as AssetSourceKind | undefined;

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(readFileSync(values.file));
  } catch (err) {
    log("error", `Could not read ${values.file}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }

  const client = await createRealClient();
  const outcome = await runImportCommand(client, jobId, bytes, values.workspace, sourceKind);
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
