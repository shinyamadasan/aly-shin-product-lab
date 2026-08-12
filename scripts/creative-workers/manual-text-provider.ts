import type { CreativeJobExecutor, CreativeJobRecord } from "../../src/lib/creative-jobs.ts";
import type { OpportunityRecord } from "../../src/lib/opportunities.ts";
import { buildCreativeInputFromOpportunity } from "../../src/lib/creative-input.ts";
import { buildProductTextPrompt } from "./product-text-prompt.ts";

// This file makes no network call of any kind -- no fetch, no API key, no SDK. The whole point of
// manual_subscription mode is that a human obtains the {headline, caption} result out-of-band
// (pasting the exported prompt into Claude Code under their own subscription) and this file only
// ever validates and wraps a result that already exists.

export type ManualProductTextResult = {
  headline: string;
  caption: string;
};

export type ManualResultParseResult = { ok: true; result: ManualProductTextResult } | { ok: false; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// Validates the human-supplied JSON BEFORE anything is claimed. Called by the `import` CLI
// subcommand ahead of any Supabase call -- an invalid or incomplete result fails here, locally,
// leaving the Creative Job untouched and still queued.
export function parseManualProductTextResult(raw: string): ManualResultParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, message: `Manual result is not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (!isRecord(parsed)) {
    return { ok: false, message: "Manual result must be a JSON object." };
  }

  const { headline, caption } = parsed;
  if (typeof headline !== "string" || headline.trim().length === 0) {
    return { ok: false, message: 'Manual result is missing a non-empty "headline" string.' };
  }
  if (typeof caption !== "string" || caption.trim().length === 0) {
    return { ok: false, message: 'Manual result is missing a non-empty "caption" string.' };
  }

  return { ok: true, result: { headline, caption } };
}

// Builds the document a human pastes into Claude Code. Read-only with respect to the job --
// callers must not claim or mutate anything to produce this.
export function buildManualExportDocument(job: Pick<CreativeJobRecord, "id">, opportunity: OpportunityRecord): string {
  // Still takes an OpportunityRecord: this is the Opportunity-backed export path, and run.ts
  // refuses request-backed jobs before reaching here. The adapter is applied at this boundary so
  // the exported prompt stays byte-identical to the pre-S1 document.
  const prompt = buildProductTextPrompt(buildCreativeInputFromOpportunity(opportunity));
  return [
    `# Creative Job manual export -- job ${job.id}`,
    "",
    "Paste everything below the divider into Claude Code (this session or any other) and use the reply as-is.",
    "",
    "---",
    "",
    prompt.system,
    "",
    prompt.user,
    "",
    "---",
    "",
    "Save the JSON reply to a file, then run:",
    `  node scripts/creative-workers/run.ts import --job-id ${job.id} --result-file <path-to-file>`,
  ].join("\n");
}

// Wraps an already-validated result into the same envelope shape the Anthropic adapter produces.
// The executor itself does zero I/O -- it just returns the given result synchronously.
export function buildManualResultExecutor(result: ManualProductTextResult): CreativeJobExecutor {
  return (_job, input) => ({
    schemaVersion: "v1",
    worker: "product_text_worker",
    output: {
      headline: result.headline,
      caption: result.caption,
    },
    metadata: {
      generatedFromOpportunity: input.origin.kind === "opportunity" ? input.origin.opportunityId : null,
      generatorVersion: "1",
    },
    artifacts: [],
  });
}
