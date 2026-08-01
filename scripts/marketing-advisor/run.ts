import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { createClient } from "@supabase/supabase-js";

import { buildMarketingAdvisorContext } from "../../src/lib/marketing-advisor-context.ts";
import { buildMarketingRecommendations, MARKETING_RECOMMENDATIONS_VERSION } from "../../src/lib/marketing-recommendations.ts";
import { buildMarketingBrief, type MarketingBrief } from "../../src/lib/marketing-brief.ts";
import { validateMarketingOpportunitySuggestions } from "../../src/lib/marketing-opportunity-suggestions.ts";
import { buildOpportunityDraftsFromSuggestions } from "../../src/lib/marketing-opportunity-drafts.ts";
import { validateOpportunityDraft, type OpportunityDraft } from "../../src/lib/opportunities.ts";
import { buildMarketingAdvisorPrompt, MARKETING_ADVISOR_MODES, MARKETING_ADVISOR_PROMPT_VERSION, type MarketingAdvisorMode } from "./marketing-advisor-prompt.ts";
import { buildMarketingAdvisorExportDocument, buildMarketingAdvisorManifest, buildMarketingAdvisorSessionId, updateMarketingAdvisorManifestStatus } from "./marketing-advisor-manual-export.ts";
import {
  loadMarketingAdvisorSampleInput,
  loadMarketingAdvisorSupabaseInput,
  MARKETING_ADVISOR_SOURCES,
  type MarketingAdvisorReadClient,
  type MarketingAdvisorSource,
} from "./marketing-advisor-read.ts";
import { runPersistCommand, type PersistOutcome } from "./marketing-advisor-persist.ts";
import { loadEnvFile, readSupabaseCredentials } from "../daily-advisor/env.ts";
import type { OpportunityPersistenceClient } from "../daily-advisor/opportunity-persistence.ts";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..", "..");
const DEFAULT_OUTPUT_ROOT = path.join(PROJECT_ROOT, "marketing-advisor", "output");

export type Subcommand = "export" | "import" | "persist";
const SUBCOMMANDS: readonly Subcommand[] = ["export", "import", "persist"];

export function parseSubcommand(argv: string[]): Subcommand | null {
  const [candidate] = argv;
  return candidate && (SUBCOMMANDS as readonly string[]).includes(candidate) ? (candidate as Subcommand) : null;
}

export type CliOutcome = { exitCode: number; message?: string };
export type ExportOutcome = CliOutcome & { sessionId?: string; sessionDir?: string };
export type ImportOutcome = CliOutcome & { drafts?: OpportunityDraft[] };

// Read-only: loads input (sample, or Supabase via the given client), builds context/
// recommendations/brief via the three already-shipped PROP-018/019/020 functions unchanged, builds
// the prompt, and writes brief.json/prompt.md/manifest.json into the session directory. Never
// claims, writes, or mutates anything in Supabase -- only `select` is ever reachable via `client`.
export async function runExportCommand(
  client: MarketingAdvisorReadClient | null,
  options: {
    mode: MarketingAdvisorMode;
    source: MarketingAdvisorSource;
    now: number;
    outputRoot: string;
    sessionDir?: string;
    credentials?: { email: string; password: string };
  },
): Promise<ExportOutcome> {
  const exportedAt = new Date(options.now).toISOString();

  const inputResult =
    options.source === "sample"
      ? { ok: true as const, input: loadMarketingAdvisorSampleInput() }
      : await (async () => {
          if (!client || !options.credentials) {
            return { ok: false as const, reason: "Supabase credentials are required for --source supabase." };
          }
          return loadMarketingAdvisorSupabaseInput(client, options.credentials);
        })();

  if (!inputResult.ok) {
    return { exitCode: 1, message: inputResult.reason };
  }

  const context = buildMarketingAdvisorContext({ ...inputResult.input, now: options.now });
  const recommendations = buildMarketingRecommendations(context);
  const brief = buildMarketingBrief(context, recommendations);
  const prompt = buildMarketingAdvisorPrompt(brief, options.mode);

  const sessionId = buildMarketingAdvisorSessionId("marketing", exportedAt);
  const sessionDir = options.sessionDir ?? path.join(options.outputRoot, sessionId);

  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(path.join(sessionDir, "brief.json"), JSON.stringify(brief, null, 2), "utf8");
  writeFileSync(path.join(sessionDir, "prompt.md"), buildMarketingAdvisorExportDocument(brief, prompt, sessionDir), "utf8");

  const manifest = buildMarketingAdvisorManifest({
    sessionId,
    mode: options.mode,
    source: options.source,
    exportedAt,
    brief,
    recommendationVersion: MARKETING_RECOMMENDATIONS_VERSION,
    promptVersion: MARKETING_ADVISOR_PROMPT_VERSION,
  });
  writeFileSync(path.join(sessionDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

  return { exitCode: 0, message: `Marketing Advisor Session ${sessionId} created at ${sessionDir}.`, sessionId, sessionDir };
}

// Validates the human-supplied JSON BEFORE anything else. response.json is written immediately
// (before validation) so a rejected reply is preserved for audit exactly as faithfully as an
// accepted one. manifest.json's status/importedAt are updated exactly once, at the very end, to
// whichever outcome actually happened -- never mid-pipeline, never on a read failure that means
// nothing about the session actually changed.
export async function runImportCommand(options: { sessionDir: string; resultFile: string; outFile?: string; now: number }): Promise<ImportOutcome> {
  let raw: string;
  try {
    raw = readFileSync(options.resultFile, "utf8");
  } catch (err) {
    return { exitCode: 2, message: `Could not read --result-file ${options.resultFile}: ${err instanceof Error ? err.message : String(err)}` };
  }

  let briefRaw: string;
  try {
    briefRaw = readFileSync(path.join(options.sessionDir, "brief.json"), "utf8");
  } catch (err) {
    return { exitCode: 2, message: `Could not read brief.json in --session-dir ${options.sessionDir}: ${err instanceof Error ? err.message : String(err)}` };
  }
  const brief = JSON.parse(briefRaw) as MarketingBrief;

  writeFileSync(path.join(options.sessionDir, "response.json"), raw, "utf8");
  const importedAt = new Date(options.now).toISOString();

  const validation = validateMarketingOpportunitySuggestions(raw, brief);
  if (!validation.ok) {
    updateMarketingAdvisorManifestStatus(options.sessionDir, "validation_failed", importedAt);
    return { exitCode: 2, message: `Marketing Advisor response failed validation (${validation.reason}): ${validation.message}` };
  }

  const drafts = buildOpportunityDraftsFromSuggestions(validation.result, brief);
  for (const draft of drafts) {
    const draftValidation = validateOpportunityDraft(draft);
    if (!draftValidation.ok) {
      updateMarketingAdvisorManifestStatus(options.sessionDir, "lift_failed", importedAt);
      return { exitCode: 1, message: `A lifted Opportunity draft failed validateOpportunityDraft (this should never happen): ${draftValidation.errors.join(" ")}` };
    }
  }

  const draftsPath = options.outFile ?? path.join(options.sessionDir, "drafts.json");
  writeFileSync(draftsPath, JSON.stringify(drafts, null, 2), "utf8");
  updateMarketingAdvisorManifestStatus(options.sessionDir, "completed", importedAt);

  return { exitCode: 0, message: `${drafts.length} Opportunity draft(s) written to ${draftsPath}.`, drafts };
}

function log(level: "info" | "warn" | "error", message: string): void {
  const timestamp = new Date().toISOString();
  console[level === "error" ? "error" : "log"](`[${timestamp}] [${level.toUpperCase()}] ${message}`);
}

function printUsage(): void {
  log("info", "Usage:");
  log("info", "  node scripts/marketing-advisor/run.ts export [--mode opportunity_generation] [--source sample|supabase] [--session-dir <path>]");
  log("info", "  node scripts/marketing-advisor/run.ts import --session-dir <path> --result-file <path> [--out <path>]");
  log("info", "  node scripts/marketing-advisor/run.ts persist --session-dir <path> [--force]");
  log("info", "    Queue this session's Opportunities for review in the existing /opportunities Review UI.");
  log("info", "    --force skips the queue eligibility checks (staleness, duplicate titles/products, short");
  log("info", "    reasons, already-expired) -- never skips structural validation.");
  log("info", "");
  log("info", "export/import are free and require no API key -- they use your existing Claude Code subscription manually.");
  log("info", "persist authenticates against Supabase using .env.advisor.local, same as export --source supabase.");
  log("info", "There is no automated or paid invocation mode in this milestone.");
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
      mode: { type: "string" },
      source: { type: "string" },
      "session-dir": { type: "string" },
      "result-file": { type: "string" },
      out: { type: "string" },
      force: { type: "boolean" },
    },
  });

  const now = Date.now();

  if (subcommand === "export") {
    const mode = values.mode ?? "opportunity_generation";
    if (!(MARKETING_ADVISOR_MODES as readonly string[]).includes(mode)) {
      log("error", `Unsupported --mode ${mode}. Supported: ${MARKETING_ADVISOR_MODES.join(", ")}.`);
      process.exit(2);
    }

    const source = values.source ?? "sample";
    if (!(MARKETING_ADVISOR_SOURCES as readonly string[]).includes(source)) {
      log("error", `Unsupported --source ${source}. Supported: ${MARKETING_ADVISOR_SOURCES.join(", ")}.`);
      process.exit(2);
    }

    let client: MarketingAdvisorReadClient | null = null;
    let credentials: { email: string; password: string } | undefined;
    if (source === "supabase") {
      loadEnvFile(path.join(PROJECT_ROOT, ".env.advisor.local"));
      const credsResult = readSupabaseCredentials();
      if (!credsResult.ok) {
        log("error", `Missing required Supabase credentials in .env.advisor.local: ${credsResult.missing.join(", ")}`);
        process.exit(2);
      }
      client = createClient(credsResult.credentials.url, credsResult.credentials.anonKey) as unknown as MarketingAdvisorReadClient;
      credentials = { email: credsResult.credentials.email, password: credsResult.credentials.password };
    }

    const outcome = await runExportCommand(client, {
      mode: mode as MarketingAdvisorMode,
      source: source as MarketingAdvisorSource,
      now,
      outputRoot: DEFAULT_OUTPUT_ROOT,
      sessionDir: values["session-dir"],
      credentials,
    });
    log(outcome.exitCode === 0 ? "info" : "error", outcome.message ?? "");
    process.exit(outcome.exitCode);
  }

  if (subcommand === "import") {
    if (!values["session-dir"]) {
      log("error", "--session-dir is required for import.");
      process.exit(2);
    }
    if (!values["result-file"]) {
      log("error", "--result-file is required for import.");
      process.exit(2);
    }

    const outcome = await runImportCommand({ sessionDir: values["session-dir"], resultFile: values["result-file"], outFile: values.out, now });
    if (outcome.drafts) {
      console.log(JSON.stringify(outcome.drafts, null, 2));
    }
    log(outcome.exitCode === 0 ? "info" : "error", outcome.message ?? "");
    process.exit(outcome.exitCode);
  }

  // persist
  if (!values["session-dir"]) {
    log("error", "--session-dir is required for persist.");
    process.exit(2);
  }

  loadEnvFile(path.join(PROJECT_ROOT, ".env.advisor.local"));
  const credsResult = readSupabaseCredentials();
  if (!credsResult.ok) {
    log("error", `Missing required Supabase credentials in .env.advisor.local: ${credsResult.missing.join(", ")}`);
    process.exit(2);
  }
  const client = createClient(credsResult.credentials.url, credsResult.credentials.anonKey);
  const { error: signInError } = await client.auth.signInWithPassword({
    email: credsResult.credentials.email,
    password: credsResult.credentials.password,
  });
  if (signInError) {
    log("error", `Failed to authenticate against Supabase: ${signInError.message}`);
    process.exit(2);
  }

  const opportunityClient = client as unknown as OpportunityPersistenceClient;
  const persistOutcome: PersistOutcome = await runPersistCommand(opportunityClient, { sessionDir: values["session-dir"], now, force: values.force ?? false });
  log(persistOutcome.exitCode === 0 ? "info" : "error", persistOutcome.message ?? "");
  process.exit(persistOutcome.exitCode);
}

const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename);
if (isMainModule) {
  main().catch((err) => {
    log("error", `Unhandled error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    process.exit(1);
  });
}
