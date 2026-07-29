import { existsSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { createClient } from "@supabase/supabase-js";
import { evaluateProduct } from "../../src/lib/rule-engine/index.ts";
import { invokeClaude } from "./claude-invoke.ts";
import { loadEnvFile, readClaudeBinary, readSupabaseCredentials, readTimezone } from "./env.ts";
import { acquireLock } from "./lock.ts";
import { detectOrphanedRecords } from "./orphan-check.ts";
import { buildDailyAdvisorOpportunities } from "./opportunity-producer.ts";
import { persistOpportunityDrafts, type OpportunityPersistenceClient } from "./opportunity-persistence.ts";
import { createFileBriefingWriter } from "./persistence.ts";
import { mergeClaudeEnrichment, renderDeterministicBriefing } from "./render-briefing.ts";
import { buildPortfolioPrompt } from "./prompt.ts";
import { getExperimentSignal, rankPortfolio } from "./portfolio-ranking.ts";
import { loadSupabaseContext } from "./supabase-read.ts";
import { buildSampleContext, getProductList } from "./sample-fixtures.ts";
import type { DataSourceMode, ProductEvaluation } from "./types.ts";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..", "..");

// Exit codes mirror run-claude.ps1's convention so both schedulers share one mental model:
// 0 = clean run (briefing generated, or an idempotent no-op skip)
// 1 = mid-run failure (Supabase load failed, unexpected exception, file write error)
// 2 = preflight/usage abort (bad CLI args, missing required env vars) -- nothing was attempted
// 3 = another instance already holds the run lock -- nothing was attempted, this run was skipped
function log(level: "info" | "warn" | "error", message: string): void {
  const timestamp = new Date().toISOString();
  console[level === "error" ? "error" : "log"](`[${timestamp}] [${level.toUpperCase()}] ${message}`);
}

function formatDateInTimezone(ms: number, timeZone: string): string {
  // en-CA formats as YYYY-MM-DD directly -- no dependency needed, Node's Intl carries full ICU.
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
}

// Module-scoped (not local to main()) so the outer unhandled-rejection handler at the bottom of
// this file can also release it -- process.exit() never runs a pending finally block, so every
// exit path (including an uncaught exception) must release explicitly, not rely on try/finally.
let releaseLock: (() => void) | null = null;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      source: { type: "string" },
      force: { type: "boolean", default: false },
      timezone: { type: "string" },
      "skip-claude": { type: "boolean", default: false },
    },
  });

  loadEnvFile(path.join(PROJECT_ROOT, ".env.advisor.local"));

  // Single-instance lock, acquired unconditionally before anything else runs (including --source
  // validation) -- --force below only ever bypasses the separate same-day idempotency check, it
  // is structurally incapable of bypassing this. When daily-advisor.ps1 invokes this script, it
  // has already acquired the same lock file itself (spanning generation AND publication as one
  // critical section) and sets ADVISOR_LOCK_OWNED_EXTERNALLY=1 so this process doesn't try to
  // acquire it a second time under a different pid and reject itself.
  const lockPath = path.join(PROJECT_ROOT, "daily-advisor", ".run.lock");
  const lockOwnedExternally = process.env.ADVISOR_LOCK_OWNED_EXTERNALLY === "1";

  function exitWithCode(code: number): never {
    releaseLock?.();
    process.exit(code);
  }

  if (!lockOwnedExternally) {
    const lockResult = acquireLock(lockPath);
    if (!lockResult.ok) {
      log("error", `Run lock rejected: ${lockResult.reason}`);
      process.exit(3);
      return;
    }
    releaseLock = lockResult.release;
  }

  const source = values.source;
  if (source !== "supabase" && source !== "sample") {
    log("error", `--source must be "supabase" or "sample" (got: ${values.source ?? "<none>"}). Refusing to guess -- see DAILY_AI_ADVISOR.md's "no silent fallback" requirement.`);
    exitWithCode(2);
  }
  const dataSource: DataSourceMode = source;

  const timezone = readTimezone(values.timezone);
  const now = Date.now();
  const date = formatDateInTimezone(now, timezone);

  const outputDir = path.join(PROJECT_ROOT, "daily-advisor", "output");
  const datedPath = path.join(outputDir, `${date}.md`);
  if (!values.force && existsSync(datedPath)) {
    log("info", `Briefing for ${date} already exists at ${datedPath}. Skipping (pass --force to regenerate).`);
    exitWithCode(0);
  }

  let context;
  let opportunityClient: OpportunityPersistenceClient | null = null;
  if (dataSource === "supabase") {
    const credsResult = readSupabaseCredentials();
    if (!credsResult.ok) {
      log("error", `Missing required Supabase credentials in .env.advisor.local: ${credsResult.missing.join(", ")}`);
      exitWithCode(2);
    }
    const client = createClient(credsResult.credentials.url, credsResult.credentials.anonKey);
    opportunityClient = client as unknown as OpportunityPersistenceClient;
    const result = await loadSupabaseContext(client, { email: credsResult.credentials.email, password: credsResult.credentials.password }, now);
    if (!result.ok) {
      log("error", `Supabase data load failed: ${result.reason}`);
      log("error", "Refusing to generate a briefing from sample data as a silent fallback. Re-run with --source sample if you explicitly want fixture data.");
      exitWithCode(1);
    }
    context = result.context;
    log("info", `Loaded live Supabase data: ${context.batches.length} batches, ${context.costings.length} costings, ${context.tastings.length} tastings, ${context.supplies.length} supplies.`);
  } else {
    context = buildSampleContext(now);
    log("info", "Using explicit sample-data fixtures (--source sample). This is synthetic data, not real business activity.");
  }

  const products = getProductList();

  const orphanReport = detectOrphanedRecords(context, products);
  if (orphanReport.total > 0) {
    log(
      "warn",
      `${orphanReport.total} operational record(s) reference a product ID not in the static catalog ` +
        `(batches: ${orphanReport.batches}, costings: ${orphanReport.costings}, tastings: ${orphanReport.tastings}). ` +
        "These are excluded from every ranking and never affect it -- see DAILY_AI_ADVISOR.md.",
    );
  }

  const evaluations: ProductEvaluation[] = products.map((product) => ({
    product,
    ruleEngineOutput: evaluateProduct(product, context, { includeLaunch: true }),
    experimentSignal: getExperimentSignal(product, context),
  }));

  const ranking = rankPortfolio(evaluations);
  const deterministicMarkdown = renderDeterministicBriefing({ date, timezone, dataSource, ranking, orphanReport });

  let finalMarkdown = deterministicMarkdown;
  let claudeUsed = false;
  if (!values["skip-claude"]) {
    const prompt = buildPortfolioPrompt(deterministicMarkdown);
    const claudeResult = await invokeClaude(prompt, { binary: readClaudeBinary(), timeoutMs: 45000 });
    if (claudeResult.ok) {
      finalMarkdown = mergeClaudeEnrichment(deterministicMarkdown, claudeResult.text);
      claudeUsed = true;
      log("info", "Claude enrichment succeeded.");
    } else {
      log("warn", `Claude enrichment skipped (${claudeResult.reason}): ${claudeResult.detail.slice(0, 200)}`);
    }
  } else {
    log("info", "Claude enrichment skipped (--skip-claude passed explicitly).");
  }

  try {
    const writer = createFileBriefingWriter(outputDir);
    const written = await writer.write(date, finalMarkdown);
    log("info", `Briefing written: ${written.datedPath} (+ ${written.latestPath}). dataSource=${dataSource} claudeUsed=${claudeUsed}`);
  } catch (err) {
    log("error", `Failed to write briefing output: ${err instanceof Error ? err.message : String(err)}`);
    exitWithCode(1);
  }

  if (dataSource === "supabase" && opportunityClient) {
    try {
      const drafts = buildDailyAdvisorOpportunities({ evaluations, context, date, timezone, dataSource, detectedAt: new Date(now).toISOString() });
      if (drafts.length > 0) {
        const result = await persistOpportunityDrafts(opportunityClient, drafts);
        if (result.ok) {
          log("info", `Opportunity persistence complete: inserted=${result.inserted} updated=${result.updated} skipped=${result.skipped}.`);
        } else {
          const reasons = result.details
            .filter((detail) => detail.outcome === "failed")
            .map((detail) => detail.reason)
            .filter(Boolean)
            .join("; ");
          log(
            "warn",
            `Opportunity persistence skipped or partially failed: inserted=${result.inserted} updated=${result.updated} skipped=${result.skipped} failed=${result.failed}. ` +
              `${reasons || "unknown write failure"}. Markdown briefing was written and will still publish; run/verify supabase-add-opportunities.sql before relying on Opportunity records.`,
          );
        }
      } else {
        log("info", "No Daily Advisor Opportunities emitted for this run.");
      }
    } catch (err) {
      log(
        "warn",
        `Opportunity persistence skipped: ${err instanceof Error ? err.message : String(err)}. ` +
          "Markdown briefing was written and will still publish; run/verify supabase-add-opportunities.sql before relying on Opportunity records.",
      );
    }
  }

  exitWithCode(0);
}

// Guard so this module can be imported by tests (e.g. to reuse buildClaudeArgs indirectly)
// without triggering a real run as a side effect of import.
const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename);
if (isMainModule) {
  main().catch((err) => {
    log("error", `Unhandled error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    releaseLock?.();
    process.exit(1);
  });
}

export { formatDateInTimezone };
