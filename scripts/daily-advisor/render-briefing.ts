import type { OrphanReport } from "./orphan-check.ts";
import type { DataSourceMode, PortfolioRanking } from "./types.ts";

export type BriefingContext = {
  date: string; // YYYY-MM-DD, already resolved in the configured timezone
  timezone: string;
  dataSource: DataSourceMode;
  ranking: PortfolioRanking;
  orphanReport?: OrphanReport;
};

const FALLBACK_NOTICE = "_Deterministic fallback: this briefing was generated entirely from the Rule Engine, with no AI enrichment this run._";

// Pure: same BriefingContext always produces the same markdown. This is the guaranteed-complete
// briefing -- Claude enrichment (see prompt.ts/claude-invoke.ts) is a strictly additive pass over
// this output, never a replacement generator. If Claude fails for any reason, this is exactly
// what gets published, with FALLBACK_NOTICE intact.
export function renderDeterministicBriefing(ctx: BriefingContext): string {
  const lines: string[] = [];

  lines.push("# Aly & Shin Product Lab -- Daily Briefing");
  lines.push("");
  lines.push(`Date: ${ctx.date} (${ctx.timezone})`);
  // Two separate lines, not one -- an earlier "Data source: Supabase" label implied the WHOLE
  // briefing (including which products exist) came from Supabase, which was never true: the
  // product catalog is always the static list in src/lib/sample-data.ts in both modes (see
  // DAILY_AI_ADVISOR.md section 1 -- the real app itself sources products the same way, this
  // isn't a shortcut). Splitting the label so catalog provenance and operational-data provenance
  // can never be conflated, per an independent review's finding.
  if (ctx.dataSource === "supabase") {
    lines.push("Product catalog: Static application data");
    lines.push("Operational data: Supabase");
  } else {
    lines.push("Product catalog: Sample fixtures");
    lines.push("Operational data: Sample fixtures");
    lines.push("_Sample data mode -- this briefing reflects synthetic fixture data, not real business activity._");
  }
  lines.push("");

  lines.push("## Portfolio summary");
  const total = ctx.ranking.findings.length;
  lines.push(`${total} active finding${total === 1 ? "" : "s"} across the portfolio. ${ctx.ranking.noActionProducts.length} product(s) need no action today.`);
  lines.push("");

  lines.push("## Highest-priority product");
  if (ctx.ranking.topFinding) {
    const finding = ctx.ranking.topFinding;
    lines.push(`**${finding.product.name}** -- ${finding.result.id}: ${finding.result.message}`);
    lines.push(`Recommendation: ${finding.result.recommendation}`);
  } else {
    lines.push("No active findings today -- every product is clear.");
  }
  lines.push("");

  lines.push("## Up to 3 actions for today");
  const topThree = ctx.ranking.findings.slice(0, 3);
  if (topThree.length === 0) {
    lines.push("Nothing requires action today.");
  } else {
    topThree.forEach((finding, index) => {
      lines.push(`${index + 1}. **${finding.product.name}** (${finding.result.id}): ${finding.result.recommendation}`);
    });
  }
  lines.push("");

  const warnings = ctx.ranking.findings.filter((finding) => finding.tier === "warning");
  if (warnings.length > 0) {
    lines.push("## Important warnings");
    for (const finding of warnings) {
      lines.push(`- **${finding.product.name}**: ${finding.result.message}`);
    }
    lines.push("");
  }

  if (ctx.ranking.experimentSignals.length > 0) {
    lines.push("## Active experiments");
    for (const signal of ctx.ranking.experimentSignals) {
      const label = signal.status === "active" ? "active, no due-date data available" : "lacks recent observations";
      lines.push(`- **${signal.product.name}** (${label}): ${signal.detail}`);
    }
    lines.push("");
  }

  lines.push("## Products needing no action");
  if (ctx.ranking.noActionProducts.length === 0) {
    lines.push("None -- every product has at least one open finding.");
  } else {
    lines.push(ctx.ranking.noActionProducts.map((product) => product.name).join(", "));
  }
  lines.push("");

  // Diagnostics only -- never influences ranking or which findings appear above. Omitted
  // entirely when zero (the normal case), so this never clutters a healthy run.
  if (ctx.orphanReport && ctx.orphanReport.total > 0) {
    lines.push("## Data diagnostics");
    lines.push(
      `${ctx.orphanReport.total} operational record(s) reference a product ID not in the catalog and were excluded from this briefing ` +
        `(batches: ${ctx.orphanReport.batches}, costings: ${ctx.orphanReport.costings}, tastings: ${ctx.orphanReport.tastings}). Ranking above is not affected.`,
    );
    lines.push("");
  }

  lines.push(FALLBACK_NOTICE);

  return lines.join("\n");
}

// Splices Claude's optional prose in and swaps the fallback notice for an attribution line.
// Never touches anything above the notice -- the deterministic sections are untouched text.
export function mergeClaudeEnrichment(deterministicMarkdown: string, claudeText: string): string {
  const withoutNotice = deterministicMarkdown.endsWith(FALLBACK_NOTICE) ? deterministicMarkdown.slice(0, -FALLBACK_NOTICE.length).trimEnd() : deterministicMarkdown;

  return [withoutNotice, "", "## AI note (optional, Claude-generated -- does not change the ranking above)", claudeText.trim(), ""].join("\n");
}
