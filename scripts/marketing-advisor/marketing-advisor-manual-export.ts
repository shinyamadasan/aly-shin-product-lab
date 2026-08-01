import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { MarketingBrief } from "../../src/lib/marketing-brief.ts";
import type { MarketingAdvisorMode, MarketingAdvisorPrompt } from "./marketing-advisor-prompt.ts";

export const MARKETING_ADVISOR_SESSION_STATUSES = ["exported", "completed", "validation_failed", "lift_failed"] as const;
export type MarketingAdvisorSessionStatus = (typeof MARKETING_ADVISOR_SESSION_STATUSES)[number];

export type MarketingAdvisorManifest = {
  schemaVersion: "1";
  sessionId: string;
  advisor: "marketing";
  mode: MarketingAdvisorMode;
  source: "sample" | "supabase";
  status: MarketingAdvisorSessionStatus;
  exportedAt: string;
  importedAt: string | null;
  briefGeneratedAt: string;
  contextVersion: number;
  recommendationVersion: number;
  briefVersion: number;
  promptVersion: string;
};

// Deterministic, never random -- same advisor/exportedAt always produce the same id. Millisecond
// precision (not truncated to whole seconds) is deliberate: it's what keeps two exports started
// in the same second from colliding on the same session directory.
export function buildMarketingAdvisorSessionId(advisor: "marketing", exportedAt: string): string {
  return `${advisor}-${exportedAt.replace(/:/g, "-")}`;
}

export function buildMarketingAdvisorManifest(input: {
  sessionId: string;
  mode: MarketingAdvisorMode;
  source: "sample" | "supabase";
  exportedAt: string;
  brief: MarketingBrief;
  recommendationVersion: number;
  promptVersion: string;
}): MarketingAdvisorManifest {
  return {
    schemaVersion: "1",
    sessionId: input.sessionId,
    advisor: "marketing",
    mode: input.mode,
    source: input.source,
    status: "exported",
    exportedAt: input.exportedAt,
    importedAt: null,
    briefGeneratedAt: input.brief.generatedAt,
    contextVersion: input.brief.context.version,
    recommendationVersion: input.recommendationVersion,
    briefVersion: input.brief.version,
    promptVersion: input.promptVersion,
  };
}

// The one function in this milestone that reads a file it didn't just write, then writes it back.
// Called exactly once, at the very end of `import`, never mid-pipeline. No file locking -- a
// single-operator, sequential CLI tool has no concurrent writer to guard against.
export function updateMarketingAdvisorManifestStatus(sessionDir: string, status: MarketingAdvisorSessionStatus, importedAt: string): void {
  const manifestPath = path.join(sessionDir, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as MarketingAdvisorManifest;
  manifest.status = status;
  manifest.importedAt = importedAt;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
}

// Mirrors buildManualExportDocument's (Creative Job text worker) narrow role exactly: turns a
// prompt into something a human can paste into Claude Code, with the exact next command to run.
// No parse/executor logic here -- there is no job-runner interface to adapt into.
export function buildMarketingAdvisorExportDocument(brief: MarketingBrief, prompt: MarketingAdvisorPrompt, sessionDir: string): string {
  return [
    `# Marketing Advisor manual export -- session ${sessionDir}`,
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
    `  node scripts/marketing-advisor/run.ts import --session-dir "${sessionDir}" --result-file <path-to-file>`,
  ].join("\n");
}
