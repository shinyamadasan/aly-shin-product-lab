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
import { inspectAssetBytes } from "../../src/lib/asset-binary.ts";
import type { GeneratedAssetFileCandidate } from "../../src/lib/asset-generation-validation.ts";
import type { AssetGenerationSpecV1 } from "../../src/lib/asset-generation-spec.ts";
import { renderAssetGenerationBrief } from "../../src/lib/asset-generation-brief.ts";
import { buildExternalAssetExecutor } from "../../src/lib/external-asset-provider.ts";
import { loadEnvFile, readSupabaseCredentials } from "../daily-advisor/env.ts";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..", "..");

export type CliOutcome = { exitCode: number; message?: string };
export type ExportOutcome = CliOutcome & { document?: string };

export type Subcommand = "export" | "import";
const SUBCOMMANDS: readonly Subcommand[] = ["export", "import"];

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

// Validates the imported bytes BEFORE touching the client at all -- inspectAssetBytes is the same
// function the production upload path uses, so an invalid file fails here, locally, exactly as it
// would in the browser, leaving the Asset Job untouched and still queued. Takes already-read bytes,
// not a file path, so this stays directly unit-testable with in-memory fixtures, matching
// runImportCommand's own text-worker precedent.
export async function runImportCommand(
  client: AssetJobExecutionClient,
  jobId: string,
  bytes: Uint8Array,
  workspace: string,
  sourceKind?: AssetSourceKind,
): Promise<CliOutcome> {
  const inspection = await inspectAssetBytes(bytes);
  if (!inspection.ok) {
    return { exitCode: 2, message: `Import file is invalid: ${inspection.message} Asset Job ${jobId} was NOT claimed.` };
  }

  const candidate: GeneratedAssetFileCandidate = {
    position: 0,
    mimeType: inspection.facts.actualMimeType,
    width: inspection.facts.actualWidth,
    height: inspection.facts.actualHeight,
    durationMs: null,
    fileSizeBytes: inspection.facts.byteSize,
    bytes,
  };

  const executor = buildExternalAssetExecutor(candidate);
  const result = await runAssetJobWithExecutors(client, jobId, { external: executor }, { sourceWorkspace: workspace, sourceKind });

  if (!result.ok) {
    return { exitCode: 1, message: `Asset Job ${jobId} did not complete: ${result.message}` };
  }
  return { exitCode: 0, message: `Asset Job ${jobId} completed.` };
}

function log(level: "info" | "warn" | "error", message: string): void {
  const timestamp = new Date().toISOString();
  console[level === "error" ? "error" : "log"](`[${timestamp}] [${level.toUpperCase()}] ${message}`);
}

function printUsage(): void {
  log("info", "Usage:");
  log("info", "  node scripts/asset-workers/run.ts export --job-id <id> [--out <path>]");
  log("info", "  node scripts/asset-workers/run.ts import --job-id <id> --file <path> --workspace <name> [--source-kind ai_generated|photograph|human_designed]");
  log("info", "");
  log("info", "export and import never call any image-generation API and require no API key -- the image");
  log("info", "comes from any external creative workspace (ChatGPT, Claude, Midjourney, Canva) or a real camera.");
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
