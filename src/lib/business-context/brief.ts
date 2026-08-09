// Runtime v1: the deterministic Business Brief.
//
// One pure function: BusinessContext in, string out. That is the complete data boundary. No client,
// no rows, no LabState, no lookup map, no clock, no I/O, no AI. This module imports only from
// business-context/**, which is what makes "the brief cannot know more than the envelope" a
// structural property rather than a promise.
//
// WHAT THIS IS NOT. It is not an advisor and not a view with a budget. It reports what the system
// knows and what it does not, and it stops there -- no verdict, no priority, no ranking, no
// "healthy". Interpretation belongs to whoever reads the brief (today: a human pasting it into
// ChatGPT or Claude), never to the deterministic context layer. Design P13 and section 14 rule 16.
//
// NO ENRICHMENT, AND THE PRODUCT CASE IS THE ONE THAT MATTERS. The envelope contains productId and
// Signal.subject.id, and NO product name anywhere: Readiness publishes zero facts by design, and
// CostingSnapshot carries costingId/productId only. So products are rendered by ID, verbatim.
// Turning "fixture-brownies" into "Brownies" would mean either a lookup outside this contract or an
// invented mapping, and both are the laundering this architecture exists to prevent.
//
// The asymmetry with Inventory is deliberate and is enforced structurally rather than by a rule:
// renderMember below prints whatever plain scalar fields a snapshot actually publishes.
// IngredientSnapshot publishes `name`, so ingredient names appear. CostingSnapshot does not, so no
// product name can appear -- there is nothing to print.
//
// ORDER IS SERIALIZATION, NOT RANKING. Sections follow a fixed declaration order; domains follow
// DOMAIN_IDS; facts, signals, notes and keyed records follow the order the envelope already holds.
// Nothing is sorted by severity, revenue, count or importance. Design section 5 requires a named,
// versioned orderingId for any ranking, and Runtime v1 introduces none.
//
// NUMBERS ARE RENDERED VERBATIM. No currency symbol, no thousands separator, no rounding. Design
// section 14 rule 11 permits the final renderer to format, but the machine envelope carries full
// precision and sub-centavo costs are real in this schema, so any rounding here could quietly change
// what a number says. Money/date presentation is an open owner decision recorded in the Runtime v1
// plan; until it is answered, raw is the only option that cannot be wrong.

import { getBlockers } from "./selectors.ts";
import { DOMAIN_IDS } from "./types.ts";
import type { BusinessContext, DomainContext, DomainId, Fact, Signal } from "./types.ts";

// Section headings for the domains a snapshot can currently build. A domain with no entry renders
// under its canonical id verbatim rather than a guessed title.
const DOMAIN_HEADINGS: Partial<Record<DomainId, string>> = {
  costing: "Costing",
  inventory: "Inventory",
  readiness: "Readiness",
  selling: "Selling",
};

// Selling's two evidence roots. They exist so the fourteen aggregates can cite where they came
// from, and they carry per-order rows; reproducing them here would turn a brief into a data dump
// and would put order-level detail into something written to a clipboard. Skipped deliberately, and
// the skip is STATED in the section rather than left silent (design section 14 rule 9).
const SELLING_EVIDENCE_FACTS = new Set(["orderBasis", "orderLineBasis"]);

const INDENT = "  ";

// --- Fact rendering ------------------------------------------------------------------------------

function isFact(value: unknown): value is Fact<unknown> {
  return typeof value === "object" && value !== null && "state" in value && typeof (value as { state: unknown }).state === "string";
}

// Verbatim. `0` renders as "0" because a real zero is a value, not an absence -- rendering it as
// "none" or a dash is exactly the flattening the Fact vocabulary exists to prevent.
function renderScalar(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(renderScalar).join(", ")}]`;
  if (typeof value === "object") {
    // Keyed records -- inventory summaryCounts, selling orderCountBySourceRolling7d. Iterated in the
    // object's OWN key order, with every key printed including zero-valued ones. No sorting, no
    // aliasing, no omission: adapters/selling.ts re-keys source counts onto the full vocabulary with
    // explicit zeroes precisely so "no orders from Facebook" stays distinguishable from "Facebook is
    // not a channel we track", and the renderer must not undo that.
    return Object.entries(value as Record<string, unknown>)
      .map(([key, entry]) => `${key} ${renderScalar(entry)}`)
      .join(" · ");
  }
  return String(value);
}

// A value parsed out of free text must never read with the same authority as one that was entered
// or calculated (design section 14 rule 12). The basis is printed verbatim, never paraphrased.
function inferredSuffix(fact: Fact<unknown>): string {
  if (!("source" in fact) || fact.source.kind !== "inferred") return "";
  return fact.source.basis ? `  [inferred: ${fact.source.basis}]` : "  [inferred]";
}

// Total over all seven states. The `never` in the default branch is the enforcement: adding an
// eighth Fact state to types.ts breaks this file at compile time instead of silently falling
// through to a wrong rendering.
//
// The five absence states are deliberately NOT interchangeable phrasings. "we could not read it",
// "there is no data source", "the column was never filled", "it is computable but an input is
// missing", and "the collection exists and is empty" are five different facts about the business.
export function renderFact(fact: Fact<unknown>): string {
  switch (fact.state) {
    case "known":
      return `${renderScalar(fact.value)}${inferredSuffix(fact)}`;
    case "empty":
      return "none recorded";
    case "unset":
      // Names the real column when the provenance carries one, and never invents a name.
      return fact.source.column ? `not set — ${fact.source.column} was never filled` : "not set";
    case "unknown":
      return `not known — ${fact.because}`;
    case "not_configured":
      return `not configured — ${fact.because}`;
    case "stale":
      return `${renderScalar(fact.value)} (as of ${fact.asOf}, ${fact.ageDays}d old, budget ${fact.budgetDays}d)`;
    case "unavailable":
      return `could not be read — ${fact.because}`;
    default: {
      const exhaustive: never = fact;
      return exhaustive;
    }
  }
}

// --- Collection members --------------------------------------------------------------------------

// A snapshot inside a collection fact (CostingSnapshot, IngredientSnapshot, a needToBuy entry).
//
// Generic on purpose: plain scalar fields go on the header line as `key: value`, nested Fact fields
// are listed beneath. Nothing here knows what a costing or an ingredient is, so the renderer can
// only ever print identifiers and names the adapter genuinely published -- which is precisely why no
// product name can leak in, and why ingredient names legitimately appear.
function renderMember(member: Record<string, unknown>, indent: string): string[] {
  const scalars: string[] = [];
  const facts: string[] = [];

  for (const [key, value] of Object.entries(member)) {
    if (isFact(value)) {
      facts.push(`${indent}${INDENT}${key.padEnd(28)}${renderFact(value)}`);
    } else {
      scalars.push(`${key}: ${renderScalar(value)}`);
    }
  }

  return [`${indent}- ${scalars.join(" · ")}`, ...facts];
}

function isMemberCollection(value: unknown): value is Record<string, unknown>[] {
  return Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === "object" && entry !== null && !Array.isArray(entry));
}

function renderFactEntry(key: string, fact: Fact<unknown>, indent: string): string[] {
  if (fact.state === "known" && isMemberCollection(fact.value)) {
    const members = fact.value.flatMap((member) => renderMember(member, `${indent}${INDENT}`));
    return [`${indent}${key} (${fact.value.length})${inferredSuffix(fact)}`, ...members];
  }
  return [`${indent}${key.padEnd(30)}${renderFact(fact)}`];
}

// --- Sections ------------------------------------------------------------------------------------

function builtDomainIds(context: BusinessContext): DomainId[] {
  // DOMAIN_IDS order, filtered to what was actually built. Canonical, deterministic, and not a
  // hand-maintained list that could drift from the vocabulary.
  return DOMAIN_IDS.filter((domain) => context.domains[domain] !== undefined);
}

function renderHeader(context: BusinessContext): string[] {
  return [
    "# Aly & Pon — Business Context",
    "",
    `As of ${context.generatedAt} · timezone ${context.timezone} · business day ${context.businessDay}`,
    `Data source: ${context.dataSource} · context schema v${context.contextSchemaVersion}`,
    `factsDigest ${context.factsDigest}`,
    `signalsDigest ${context.signalsDigest}`,
  ];
}

// Mandatory and unconditional. A brief that omitted coverage would read as authoritative about
// domains it never touched, which is the failure that looks most like success.
function renderCoverage(context: BusinessContext): string[] {
  const lines = ["## Domain coverage", ""];
  const { present, absent, knownDomains } = context.coverage;

  lines.push(`Available (${present.length} of ${knownDomains.length}): ${present.length === 0 ? "none" : present.join(" · ")}`);
  lines.push("");
  lines.push(`Not available (${absent.length}):`);
  if (absent.length === 0) {
    lines.push(`${INDENT}none`);
  }
  for (const entry of absent) {
    // Reason verbatim. An absent domain is never called "empty": "the builder does not know about
    // this" and "there is nothing there" are different statements.
    lines.push(`${INDENT}${entry.domain.padEnd(16)}— ${entry.reason}`);
  }

  return lines;
}

function renderCurrency(context: BusinessContext): string[] {
  const lines = ["## Data currency", ""];

  for (const domainId of builtDomainIds(context)) {
    const domain = context.domains[domainId] as DomainContext;
    const counts = domain.rowCounts;
    lines.push(`${domainId.padEnd(12)}source as of ${renderFact(domain.sourceAsOf)}`);
    lines.push(`${" ".repeat(12)}rows read ${counts.read}, included ${counts.included}, omitted ${counts.omitted} · adapter v${domain.adapterVersion}`);
  }

  return lines;
}

function renderDomainSection(context: BusinessContext, domainId: DomainId): string[] {
  const heading = DOMAIN_HEADINGS[domainId] ?? domainId;
  const domain = context.domains[domainId];
  const lines = [`## ${heading}`, ""];

  if (!domain) {
    const absent = context.coverage.absent.find((entry) => entry.domain === domainId);
    lines.push(`${INDENT}not built — ${absent ? absent.reason : "this domain is not part of the current snapshot"}`);
    return lines;
  }

  if (!domain.readOutcome.ok) {
    lines.push(`${INDENT}read failed — ${domain.readOutcome.message}`);
    lines.push("");
  }

  const factKeys = Object.keys(domain.facts).filter((key) => !(domainId === "selling" && SELLING_EVIDENCE_FACTS.has(key)));

  if (Object.keys(domain.facts).length === 0) {
    // Readiness is the live example: it publishes signals only, by design. Saying so plainly keeps
    // "this domain reports no facts" from reading as "this domain's data is missing" -- but only
    // when the read actually succeeded. On a failed read the failure above is the honest account,
    // and claiming "by design" on top of it would explain away a real gap.
    if (domain.readOutcome.ok) {
      lines.push(`${INDENT}This domain publishes no facts by design; its findings appear in the signal sections below (${domain.signals.length} signal(s)).`);
    }
    return lines;
  }

  for (const key of factKeys) {
    lines.push(...renderFactEntry(key, domain.facts[key], INDENT));
  }

  if (domainId === "selling") {
    const skipped = Object.keys(domain.facts).filter((key) => SELLING_EVIDENCE_FACTS.has(key));
    if (skipped.length > 0) {
      lines.push("");
      lines.push(`${INDENT}Not shown: ${skipped.join(", ")} — per-order evidence roots held as provenance for the figures above, deliberately not reproduced here.`);
    }
  }

  return lines;
}

// --- Signals -------------------------------------------------------------------------------------

function allSignals(context: BusinessContext): Signal[] {
  const domainSignals = builtDomainIds(context).flatMap((domainId) => (context.domains[domainId] as DomainContext).signals);
  return [...domainSignals, ...context.signals];
}

function renderSubject(signal: Signal): string {
  // Verbatim id, labelled by its kind so a reader knows it is an identifier and not a name.
  return signal.subject ? `${signal.subject.kind} ${signal.subject.id}` : "business-wide";
}

function renderSignal(signal: Signal): string[] {
  const lines = [`${INDENT}[${signal.id}] ${renderSubject(signal)} — ${signal.severity} · ${signal.status}`];
  lines.push(`${INDENT}${INDENT}${signal.message}`);
  // The Signal's own deterministic recommendation, printed verbatim. This is serialization of a
  // value the rule already produced, not advice generated here.
  lines.push(`${INDENT}${INDENT}Recommendation: ${signal.recommendation}`);
  return lines;
}

function renderSignalSection(heading: string, signals: Signal[], emptyLine: string, trailer?: string): string[] {
  const lines = [`## ${heading}`, ""];
  if (signals.length === 0) {
    lines.push(`${INDENT}${emptyLine}`);
    return lines;
  }
  if (trailer) {
    lines.push(`${INDENT}${trailer}`, "");
  }
  for (const signal of signals) {
    lines.push(...renderSignal(signal));
  }
  return lines;
}

// --- Notes and closing ----------------------------------------------------------------------------

function renderNotes(context: BusinessContext): string[] {
  const lines = ["## Notes and caveats", ""];
  let any = false;

  for (const domainId of builtDomainIds(context)) {
    const domain = context.domains[domainId] as DomainContext;
    for (const note of domain.notes) {
      // Verbatim. These are architecture-owned caveats about how a value was obtained; summarising
      // or softening one would remove exactly the qualification it exists to carry.
      lines.push(`${INDENT}${domainId}: ${note}`);
      any = true;
    }
  }

  if (!any) {
    lines.push(`${INDENT}none recorded`);
  }

  return lines;
}

function renderUnknowns(context: BusinessContext): string[] {
  const { knownDomains } = context.coverage;
  const lines = ["## What this snapshot does not know", ""];

  // coverage.absent mixes TWO different situations: a domain with no adapter at all, and a built
  // domain whose read failed this run. Only the first means "this system cannot describe that yet";
  // the second means "we tried and could not read it", and it is reported in its own paragraph
  // below. Counting absent.length here would report a transient outage as a permanent gap in the
  // architecture -- with all four Runtime domains failing it would claim 15 of 15 declared domains
  // have no adapter, and name Costing, Inventory, Readiness and Selling among them, which is false.
  //
  // Derived from the envelope alone: a domain is unbuilt exactly when the builder produced no
  // DomainContext for it. No new coverage field, no new selector.
  const unbuilt = knownDomains.filter((domain) => context.domains[domain] === undefined);

  lines.push(`${INDENT}${unbuilt.length} of ${knownDomains.length} declared domains have no adapter: ${unbuilt.length === 0 ? "none" : unbuilt.join(", ")}.`);
  lines.push("");
  lines.push(`${INDENT}No canonical Product domain is available. Costing and Readiness above still refer to`);
  lines.push(`${INDENT}products, but only by product ID — no product name, category, or description is in`);
  lines.push(`${INDENT}this snapshot.`);

  const failed = builtDomainIds(context).filter((domainId) => !(context.domains[domainId] as DomainContext).readOutcome.ok);
  if (failed.length > 0) {
    lines.push("");
    lines.push(`${INDENT}${failed.length} domain(s) could not be read this run (${failed.join(", ")}). Their facts are`);
    lines.push(`${INDENT}unavailable, which is not the same as empty: this snapshot says nothing about them.`);
  }

  return lines;
}

// --- Entry point ----------------------------------------------------------------------------------

// Deterministic: same context in, byte-identical string out. Reads nothing outside its argument and
// mutates nothing -- every array it walks is iterated, never sorted in place.
export function renderBusinessBrief(context: BusinessContext): string {
  const signals = allSignals(context);
  const blockers = getBlockers(context);
  const blockerSet = new Set(blockers);

  // Three disjoint buckets over the same signal list, and the split is the point. `getBlockers`
  // deliberately excludes status "insufficient_data" even at blocker severity, because a blocker we
  // could not evaluate is not a blocker we found -- reporting it as one would turn "we did not look"
  // into "the business is broken".
  const insufficient = signals.filter((signal) => signal.status === "insufficient_data");
  const others = signals.filter((signal) => !blockerSet.has(signal) && signal.status !== "insufficient_data");

  const sections: string[][] = [
    renderHeader(context),
    renderCoverage(context),
    renderCurrency(context),
    ...DOMAIN_IDS.filter((domainId) => DOMAIN_HEADINGS[domainId] !== undefined).map((domainId) => renderDomainSection(context, domainId)),
    renderSignalSection("Blockers (getBlockers)", blockers, "none — no signal is a known, active failure at blocker severity"),
    renderSignalSection("Other signals", others, "none recorded"),
    renderSignalSection(
      "Could not be evaluated (insufficient data)",
      insufficient,
      "none — every signal could be evaluated",
      'These could not be evaluated. That is "we did not look", not "the business is broken".',
    ),
    renderNotes(context),
    renderUnknowns(context),
  ];

  return `${sections.map((lines) => lines.join("\n")).join("\n\n")}\n`;
}
