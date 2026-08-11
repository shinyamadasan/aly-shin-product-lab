// The compact Business Brief -- the AI-facing clipboard representation.
//
// Same canonical envelope, same determinism, same honesty rules as brief.ts. The ONLY difference is
// how much of the envelope is spelled out: the full brief renders every published fact, which live
// use showed is dominated by material a model cannot act on -- on the production snapshot, 216
// readiness signals of which the overwhelming majority are `pass` or `insufficient_data`, plus a
// per-fact dump of 6 costings and 25 ingredients.
//
// WHAT COMPACTION IS ALLOWED TO DO HERE: select and count. Nothing else.
//
//   - Every blocker is rendered. Design P7: "A blocker is never dropped by a budget, in any view."
//   - Every non-blocker `fail` is rendered. Those are the actionable warnings.
//   - `pass` signals are omitted AND COUNTED. A reader is told exactly how many checks passed.
//   - `insufficient_data` stays its OWN category, is grouped by rule id, and reports its total.
//     It is never merged into failures and never allowed to look like success.
//   - Coverage and the closing unknowns section are unconditional, exactly as in the full brief.
//
// Every omission is stated with a count, which is what design section 14 rule 9 requires: never
// "truncate, sample, or summarise without recording what was dropped and why". Counting the dropped
// items is bookkeeping about the projection, not a business value invented here.
//
// WHAT IT MAY NOT DO: rank, prioritise, score, conclude, or summarise in prose. Order is the
// envelope's own order throughout -- no sort by severity, count, revenue or importance. Design
// section 5 requires a named, versioned orderingId for any ranking, and Runtime v1 defines none.
//
// Deterministic: same context in, byte-identical string out. No clock, no randomness, no options
// that change meaning. The full brief and the raw canonical JSON remain available for full fidelity.

import { productLabels, renderFact, type ProductLabels } from "./brief.ts";
import { getBlockers } from "./selectors.ts";
import { DOMAIN_IDS } from "./types.ts";
import type { BusinessContext, DomainContext, DomainId, Fact, Signal } from "./types.ts";

const INDENT = "  ";

// Ingredient states that need attention. Everything else is a healthy ingredient the compact brief
// omits -- and counts.
const ATTENTION_STOCK = new Set(["out", "low"]);
const ATTENTION_EXPIRY = new Set(["expired", "expires-today", "expires-soon"]);

// The costing metrics a pricing decision actually turns on. The remaining ~20 published facts per
// costing (individual cost components, batch totals, break-even) stay in the full brief.
const COSTING_METRICS: ReadonlyArray<[key: string, label: string]> = [
  ["suggestedPrice", "price"],
  ["costPerPiece", "cost/piece"],
  ["margin", "margin %"],
  ["foodCostPercent", "food cost %"],
];

function builtDomainIds(context: BusinessContext): DomainId[] {
  return DOMAIN_IDS.filter((domain) => context.domains[domain] !== undefined);
}

function knownCollection(fact: Fact<unknown> | undefined): Record<string, unknown>[] {
  if (fact === undefined || fact.state !== "known" || !Array.isArray(fact.value)) {
    return [];
  }
  return fact.value.filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null);
}

function factOf(member: Record<string, unknown>, key: string): Fact<unknown> | undefined {
  const value = member[key];
  return typeof value === "object" && value !== null && "state" in value ? (value as Fact<unknown>) : undefined;
}

function knownString(fact: Fact<unknown> | undefined): string | undefined {
  return fact !== undefined && fact.state === "known" && typeof fact.value === "string" ? fact.value : undefined;
}

function productRef(productId: unknown, labels: ProductLabels): string {
  if (typeof productId !== "string") {
    return "product (unidentified)";
  }
  const name = labels.get(productId);
  return name === undefined ? `product ${productId}` : `product ${productId} (${name})`;
}

function subjectRef(signal: Signal, labels: ProductLabels): string {
  if (!signal.subject) {
    return "business-wide";
  }
  if (signal.subject.kind === "product") {
    return productRef(signal.subject.id, labels);
  }
  return `${signal.subject.kind} ${signal.subject.id}`;
}

// --- Sections ---------------------------------------------------------------------------------------

function header(context: BusinessContext): string[] {
  const { present, absent, knownDomains } = context.coverage;
  return [
    "# Aly & Pon — Business Context (compact)",
    "",
    `As of ${context.generatedAt} · timezone ${context.timezone} · business day ${context.businessDay}`,
    `Data source: ${context.dataSource} · context schema v${context.contextSchemaVersion}`,
    `Coverage: ${present.length} of ${knownDomains.length} domains available, ${absent.length} not`,
    `factsDigest ${context.factsDigest}`,
    `signalsDigest ${context.signalsDigest}`,
    "",
    "This is a compacted rendering of a canonical snapshot. Every omission below is stated with a",
    "count. Nothing here is ranked, prioritised or concluded -- it reports what the system knows and",
    "what it does not.",
  ];
}

function coverage(context: BusinessContext): string[] {
  const { present, absent } = context.coverage;
  const lines = ["## Coverage", ""];

  lines.push(`${INDENT}Available: ${present.length === 0 ? "none" : present.join(" · ")}`);
  lines.push(`${INDENT}Not available (${absent.length}):`);
  if (absent.length === 0) {
    lines.push(`${INDENT}${INDENT}none`);
  }
  for (const entry of absent) {
    lines.push(`${INDENT}${INDENT}${entry.domain.padEnd(16)}— ${entry.reason}`);
  }

  return lines;
}

function currency(context: BusinessContext): string[] {
  const lines = ["## Data currency", ""];

  for (const domainId of builtDomainIds(context)) {
    const domain = context.domains[domainId] as DomainContext;
    const counts = domain.rowCounts;
    const failed = domain.readOutcome.ok ? "" : ` · READ FAILED: ${domain.readOutcome.message}`;
    lines.push(`${INDENT}${domainId.padEnd(11)}as of ${renderFact(domain.sourceAsOf)} · ${counts.read} row(s)${failed}`);
  }

  return lines;
}

function costing(context: BusinessContext, labels: ProductLabels): string[] {
  const domain = context.domains.costing;
  const lines = ["## Costing", ""];

  if (!domain) {
    lines.push(`${INDENT}not built`);
    return lines;
  }

  if (!domain.readOutcome.ok) {
    lines.push(`${INDENT}could not be read — ${domain.readOutcome.message}`);
    return lines;
  }

  const snapshots = knownCollection(domain.facts.byCosting);
  if (snapshots.length === 0) {
    lines.push(`${INDENT}${renderFact(domain.facts.byCosting)}`);
    return lines;
  }

  for (const snapshot of snapshots) {
    lines.push(`${INDENT}${productRef(snapshot.productId, labels)} · costing ${String(snapshot.costingId)}`);

    // Known metrics collapse onto one line. Anything that is NOT known gets its own line carrying
    // the envelope's reason verbatim -- paraphrasing or truncating it would be exactly the kind of
    // quiet flattening the Fact vocabulary exists to prevent.
    const inline: string[] = [];
    const spilled: string[] = [];

    for (const [key, label] of COSTING_METRICS) {
      const fact = factOf(snapshot, key);
      if (fact === undefined) {
        continue;
      }
      if (fact.state === "known") {
        inline.push(`${label} ${renderFact(fact)}`);
      } else {
        spilled.push(`${INDENT}${INDENT}${label}: ${renderFact(fact)}`);
      }
    }

    if (inline.length > 0) {
      lines.push(`${INDENT}${INDENT}${inline.join(" · ")}`);
    }
    lines.push(...spilled);
  }

  lines.push("");
  lines.push(`${INDENT}Showing ${COSTING_METRICS.length} pricing facts per costing. The full brief carries every published cost component.`);

  return lines;
}

function inventory(context: BusinessContext): string[] {
  const domain = context.domains.inventory;
  const lines = ["## Inventory", ""];

  if (!domain) {
    lines.push(`${INDENT}not built`);
    return lines;
  }

  if (!domain.readOutcome.ok) {
    lines.push(`${INDENT}could not be read — ${domain.readOutcome.message}`);
    return lines;
  }

  for (const key of ["summaryCounts", "totalInventoryValue", "flaggedIngredientCount", "latestPurchaseAt"]) {
    const fact = domain.facts[key];
    if (fact !== undefined) {
      lines.push(`${INDENT}${key.padEnd(24)}${renderFact(fact)}`);
    }
  }

  const ingredients = knownCollection(domain.facts.byIngredient);
  const attention = ingredients.filter((ingredient) => {
    const stock = knownString(factOf(ingredient, "stockStatus"));
    const expiry = knownString(factOf(ingredient, "expirationStatus"));
    const flagged = factOf(ingredient, "flaggedReason");
    return (
      (stock !== undefined && ATTENTION_STOCK.has(stock)) ||
      (expiry !== undefined && ATTENTION_EXPIRY.has(expiry)) ||
      (flagged !== undefined && flagged.state === "known")
    );
  });

  lines.push("");
  lines.push(`${INDENT}Needing attention (${attention.length} of ${ingredients.length}):`);
  if (attention.length === 0) {
    lines.push(`${INDENT}${INDENT}none`);
  }
  for (const ingredient of attention) {
    const stock = knownString(factOf(ingredient, "stockStatus")) ?? "stock unknown";
    const expiry = knownString(factOf(ingredient, "expirationStatus"));
    const flagged = factOf(ingredient, "flaggedReason");
    const parts = [`${String(ingredient.name)} (${String(ingredient.ingredientId)})`, `stock ${stock}`];
    if (expiry !== undefined && ATTENTION_EXPIRY.has(expiry)) {
      parts.push(`expiry ${expiry}`);
    }
    if (flagged !== undefined && flagged.state === "known") {
      parts.push(`flagged: ${renderFact(flagged)}`);
    }
    lines.push(`${INDENT}${INDENT}${parts.join(" · ")}`);
  }

  const omitted = ingredients.length - attention.length;
  if (omitted > 0) {
    lines.push(`${INDENT}${INDENT}(${omitted} further ingredient(s) recorded with no stock, expiry or data-integrity attention item — full detail in the full brief.)`);
  }

  return lines;
}

function selling(context: BusinessContext): string[] {
  const domain = context.domains.selling;
  const lines = ["## Selling", ""];

  if (!domain) {
    lines.push(`${INDENT}not built`);
    return lines;
  }

  if (!domain.readOutcome.ok) {
    lines.push(`${INDENT}could not be read — ${domain.readOutcome.message}`);
    return lines;
  }

  // Every published aggregate, unchanged. The Selling domain is already compact -- fourteen numbers
  // -- so compaction here would remove signal, not noise. Only the two per-order evidence roots are
  // skipped, and the skip is stated.
  const skipped: string[] = [];
  for (const [key, fact] of Object.entries(domain.facts)) {
    if (key === "orderBasis" || key === "orderLineBasis") {
      skipped.push(key);
      continue;
    }
    lines.push(`${INDENT}${key.padEnd(30)}${renderFact(fact)}`);
  }

  if (skipped.length > 0) {
    lines.push("");
    lines.push(`${INDENT}Not shown: ${skipped.join(", ")} — per-order evidence roots held as provenance for the figures above.`);
  }

  return lines;
}

function readiness(context: BusinessContext): string[] {
  const domain = context.domains.readiness;
  const lines = ["## Readiness", ""];

  if (!domain) {
    lines.push(`${INDENT}not built`);
    return lines;
  }

  if (!domain.readOutcome.ok) {
    lines.push(`${INDENT}could not be read — ${domain.readOutcome.message}`);
    return lines;
  }

  lines.push(`${INDENT}Publishes no facts by design; its ${domain.signals.length} finding(s) appear in the signal sections below.`);
  return lines;
}

// --- Signals -----------------------------------------------------------------------------------------

function allSignals(context: BusinessContext): Signal[] {
  const domainSignals = builtDomainIds(context).flatMap((domainId) => (context.domains[domainId] as DomainContext).signals);
  return [...domainSignals, ...context.signals];
}

function blockerLines(blockers: Signal[], labels: ProductLabels): string[] {
  const lines = ["## Blockers", ""];

  if (blockers.length === 0) {
    lines.push(`${INDENT}none — no signal is a known, active failure at blocker severity`);
    return lines;
  }

  // Every one, in envelope order. Never truncated, never sampled, never ranked.
  for (const signal of blockers) {
    lines.push(`${INDENT}[${signal.id}] ${subjectRef(signal, labels)}`);
    lines.push(`${INDENT}${INDENT}${signal.message}`);
    lines.push(`${INDENT}${INDENT}→ ${signal.recommendation}`);
  }

  return lines;
}

function warningLines(warnings: Signal[], labels: ProductLabels): string[] {
  const lines = ["## Other active failures", ""];

  if (warnings.length === 0) {
    lines.push(`${INDENT}none`);
    return lines;
  }

  // Every non-blocker `fail`, one line each. These are actionable; none is dropped.
  for (const signal of warnings) {
    lines.push(`${INDENT}[${signal.id}] ${signal.severity} · ${subjectRef(signal, labels)} — ${signal.message}`);
  }

  return lines;
}

function insufficientLines(insufficient: Signal[]): string[] {
  const lines = ["## Could not be evaluated (insufficient data)", ""];

  if (insufficient.length === 0) {
    lines.push(`${INDENT}none — every signal could be evaluated`);
    return lines;
  }

  // Grouped by rule id, in first-appearance order. Counting is not ranking: the order is the
  // envelope's own, and no group is promoted for being larger.
  const byRule = new Map<string, number>();
  for (const signal of insufficient) {
    byRule.set(signal.id, (byRule.get(signal.id) ?? 0) + 1);
  }

  lines.push(`${INDENT}${insufficient.length} finding(s) could not be evaluated. This is "we did not look", NOT "the business is`);
  lines.push(`${INDENT}fine". Grouped by rule; per-subject detail is in the full brief.`);
  lines.push("");
  for (const [ruleId, count] of byRule) {
    lines.push(`${INDENT}${INDENT}${ruleId.padEnd(28)}${count}`);
  }

  return lines;
}

function passLine(passed: Signal[]): string[] {
  return [
    "## Checks that passed",
    "",
    // Omitted, and counted. A reader knows exactly how much was left out and where to find it.
    `${INDENT}${passed.length} check(s) passed and are not listed individually. The full brief carries each one.`,
  ];
}

function notes(context: BusinessContext): string[] {
  const lines = ["## Notes and caveats", ""];
  let any = false;

  for (const domainId of builtDomainIds(context)) {
    for (const note of (context.domains[domainId] as DomainContext).notes) {
      lines.push(`${INDENT}${domainId}: ${note}`);
      any = true;
    }
  }

  if (!any) {
    lines.push(`${INDENT}none recorded`);
  }

  return lines;
}

function unknowns(context: BusinessContext): string[] {
  const { knownDomains } = context.coverage;
  const unbuilt = knownDomains.filter((domain) => context.domains[domain] === undefined);
  const failed = builtDomainIds(context).filter((domainId) => !(context.domains[domainId] as DomainContext).readOutcome.ok);
  const lines = ["## What this snapshot does not know", ""];

  lines.push(`${INDENT}${unbuilt.length} of ${knownDomains.length} declared domains have no adapter: ${unbuilt.length === 0 ? "none" : unbuilt.join(", ")}.`);

  if (failed.length > 0) {
    lines.push("");
    lines.push(`${INDENT}${failed.length} domain(s) could not be read this run (${failed.join(", ")}). Their facts are`);
    lines.push(`${INDENT}unavailable, which is not the same as empty: this snapshot says nothing about them.`);
  }

  return lines;
}

// --- Entry point -------------------------------------------------------------------------------------

export function renderCompactBrief(context: BusinessContext): string {
  const labels = productLabels(context);
  const signals = allSignals(context);
  const blockers = getBlockers(context);
  const blockerSet = new Set(blockers);

  // The same three-way partition the full brief uses, plus `pass` split out so it can be counted
  // rather than printed. Every signal lands in exactly one bucket.
  const insufficient = signals.filter((signal) => signal.status === "insufficient_data");
  const passed = signals.filter((signal) => signal.status === "pass");
  const warnings = signals.filter((signal) => signal.status === "fail" && !blockerSet.has(signal));

  const sections: string[][] = [
    header(context),
    coverage(context),
    currency(context),
    costing(context, labels),
    inventory(context),
    selling(context),
    readiness(context),
    blockerLines(blockers, labels),
    warningLines(warnings, labels),
    insufficientLines(insufficient),
    passLine(passed),
    notes(context),
    unknowns(context),
  ];

  return `${sections.map((lines) => lines.join("\n")).join("\n\n")}\n`;
}
