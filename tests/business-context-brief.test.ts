// Runtime v1 (PR-2): the deterministic Business Brief.
//
// The renderer is one pure function over a shape M1 already proves, so nothing here re-tests
// adapters, digests, provenance or coverage construction. What is new is the last step, and it is
// the step where M1's seven-state absence vocabulary meets human prose -- so these tests are
// overwhelmingly about the ways that translation could quietly lie: a real zero becoming "none", an
// unreadable domain reading as an empty one, a product id acquiring a name it does not have, a
// source vocabulary being tidied up, or model-written text reaching the page as evidence.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { buildBusinessContext } from "../src/lib/business-context/build.ts";
import { COSTING_FRESHNESS_COMPOSER } from "../src/lib/business-context/composers/costing-freshness.ts";
import { renderBusinessBrief, renderFact } from "../src/lib/business-context/brief.ts";
import { getBlockers } from "../src/lib/business-context/selectors.ts";
import type { BusinessContext, DomainContext, Fact, Provenance, Signal } from "../src/lib/business-context/types.ts";
import { FIXTURE_ENV, fixtureReads } from "./fixtures/business-context-m1.ts";

const BRIEF_SOURCE = readFileSync(new URL("../src/lib/business-context/brief.ts", import.meta.url), "utf8");

// Static scans are about CODE. brief.ts documents in prose the very things the scans forbid
// ("no LabState", "no lookup map"), so scanning raw text would assert the opposite of what is meant.
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

const BRIEF_CODE = withoutComments(BRIEF_SOURCE);

// The canonical fixture, built through the real builder rather than read from JSON, so a change in
// any adapter reaches this renderer the way it would in production.
async function fixtureContext(): Promise<BusinessContext> {
  return buildBusinessContext({
    reads: fixtureReads(),
    env: FIXTURE_ENV,
    dataSource: "sample",
    composers: [COSTING_FRESHNESS_COMPOSER.compose],
  });
}

async function failedContext(): Promise<BusinessContext> {
  const down = { ok: false, reason: "failed", message: "connection reset" } as const;
  return buildBusinessContext({
    reads: { costing: down, inventory: down, readiness: down, selling: down },
    env: FIXTURE_ENV,
    dataSource: "supabase",
    composers: [COSTING_FRESHNESS_COMPOSER.compose],
  });
}

// --- 9. Golden output -----------------------------------------------------------------------------

const GOLDEN_URL = new URL("./fixtures/business-context-brief.golden.txt", import.meta.url);

test("[PR-2] the fixture context renders to the committed expected brief", async () => {
  // A committed expectation rather than a pile of substring assertions: the brief is a document, and
  // the thing worth protecting is the whole document. Line endings are normalised on read because a
  // CRLF checkout is not a rendering difference.
  const expected = readFileSync(GOLDEN_URL, "utf8").replace(/\r\n/g, "\n");
  const actual = renderBusinessBrief(await fixtureContext());

  assert.equal(actual, expected);
});

// --- 8. Determinism -------------------------------------------------------------------------------

test("[PR-2] rendering the same context twice is byte-identical", async () => {
  const context = await fixtureContext();

  assert.equal(renderBusinessBrief(context), renderBusinessBrief(context));
});

test("[PR-2] two separately built contexts over the same fixture render identically", async () => {
  // Catches any hidden dependence on object identity, iteration accident, or clock.
  assert.equal(renderBusinessBrief(await fixtureContext()), renderBusinessBrief(await fixtureContext()));
});

// --- 10. Seven-state totality ----------------------------------------------------------------------

const SOURCE: Provenance = { kind: "entered", table: "costing_summaries", column: "suggested_price" };

const ALL_STATES: Record<string, Fact<unknown>> = {
  knownValue: { state: "known", value: 42, source: SOURCE },
  knownZero: { state: "known", value: 0, source: SOURCE },
  emptyCollection: { state: "empty", source: SOURCE },
  unsetColumn: { state: "unset", source: SOURCE },
  unknownValue: { state: "unknown", because: "an input is missing", source: SOURCE },
  notConfigured: { state: "not_configured", because: "no data source is wired" },
  staleValue: { state: "stale", value: 7, asOf: "2026-08-01T00:00:00.000Z", ageDays: 8, budgetDays: 5, source: SOURCE },
  unavailableValue: { state: "unavailable", because: "the read failed" },
};

test("[PR-2] all seven Fact states render distinctly", () => {
  const rendered = Object.entries(ALL_STATES).map(([key, fact]) => [key, renderFact(fact)] as const);
  const byKey = Object.fromEntries(rendered);

  assert.equal(byKey.knownValue, "42");
  assert.equal(byKey.emptyCollection, "none recorded");
  assert.equal(byKey.unsetColumn, "not set — suggested_price was never filled");
  assert.equal(byKey.unknownValue, "not known — an input is missing");
  assert.equal(byKey.notConfigured, "not configured — no data source is wired");
  assert.equal(byKey.staleValue, "7 (as of 2026-08-01T00:00:00.000Z, 8d old, budget 5d)");
  assert.equal(byKey.unavailableValue, "could not be read — the read failed");

  // The five absence states must never collapse into one another.
  const absences = [byKey.emptyCollection, byKey.unsetColumn, byKey.unknownValue, byKey.notConfigured, byKey.unavailableValue];
  assert.equal(new Set(absences).size, 5, "empty / unset / unknown / not_configured / unavailable must all read differently");
});

test("[PR-2] a real zero renders as 0 and never as an absence", () => {
  const zero = renderFact(ALL_STATES.knownZero);

  assert.equal(zero, "0");
  assert.notEqual(zero, "none recorded");
  assert.equal(zero.includes("none"), false);
  assert.equal(zero.includes("—"), false);
  assert.equal(zero.trim().length > 0, true);
});

test("[PR-2] because strings are reproduced verbatim, never paraphrased", () => {
  const because = "1 ingredient(s) could not be converted to a canonical unit, so any total that includes them is not meaningful.";
  const rendered = renderFact({ state: "unknown", because, source: SOURCE });

  assert.ok(rendered.includes(because));
});

test("[PR-2] inferred provenance is labelled inline with its basis verbatim", () => {
  const basis = "Parsed from free-text costing.notes with a line-anchored regex; no dedicated column exists for this value.";
  const rendered = renderFact({ state: "known", value: 16, source: { kind: "inferred", table: "costing_summaries", basis } });

  assert.ok(rendered.includes("[inferred:"), "an inferred value must not read with the same authority as an entered one");
  assert.ok(rendered.includes(basis));
});

test("[PR-2] all seven states survive an end-to-end render", async () => {
  const context = await fixtureContext();
  const probe: DomainContext = {
    domain: "costing",
    adapterVersion: 1,
    readOutcome: { ok: true },
    sourceAsOf: { state: "known", value: "2026-08-08T00:00:00.000Z", source: SOURCE },
    rowCounts: { read: 1, included: 1, omitted: 0 },
    facts: ALL_STATES,
    signals: [],
    notes: [],
  };

  const brief = renderBusinessBrief({ ...context, domains: { ...context.domains, costing: probe } });

  assert.ok(brief.includes("knownZero                     0"));
  assert.ok(brief.includes("emptyCollection               none recorded"));
  assert.ok(brief.includes("not set — suggested_price was never filled"));
  assert.ok(brief.includes("not known — an input is missing"));
  assert.ok(brief.includes("not configured — no data source is wired"));
  assert.ok(brief.includes("(as of 2026-08-01T00:00:00.000Z, 8d old, budget 5d)"));
  assert.ok(brief.includes("could not be read — the read failed"));
});

// --- 11. No verdicts ------------------------------------------------------------------------------

const FORBIDDEN_VOCABULARY = [
  "your business is healthy",
  "top priority",
  "business stage",
  "biggest bottleneck",
  "you should focus on",
  "momentum",
  "highest-value opportunity",
  "best channel",
  "top product",
  "currentBottleneck",
];

test("[PR-2] the rendered brief contains no whole-business verdict vocabulary", async () => {
  const brief = renderBusinessBrief(await fixtureContext()).toLowerCase();

  for (const term of FORBIDDEN_VOCABULARY) {
    assert.equal(brief.includes(term.toLowerCase()), false, `the brief must not contain "${term}"`);
  }
});

test("[PR-2] the renderer sorts nothing by severity, value or count", () => {
  // Ranking is a view concern requiring a named, versioned comparator, and Runtime v1 defines none.
  // Fixed declaration order is serialization, not a ranking.
  assert.equal(/\.sort\s*\(/.test(BRIEF_CODE), false, "brief.ts must not sort");
  assert.equal(/\breverse\s*\(/.test(BRIEF_CODE), false);
  assert.equal(BRIEF_CODE.includes("orderingId"), false);
});

// --- 12. Coverage is mandatory ---------------------------------------------------------------------

test("[PR-2] coverage and the closing unknowns section render even when every domain failed", async () => {
  const brief = renderBusinessBrief(await failedContext());

  assert.ok(brief.includes("## Domain coverage"));
  assert.ok(brief.includes("## What this snapshot does not know"));
  assert.ok(brief.includes("Available (0 of 15): none"));
  assert.ok(brief.includes("Not available (15):"));

  // Every failed domain is named with its real reason, and never as "empty".
  for (const domain of ["costing", "inventory", "readiness", "selling"]) {
    assert.ok(brief.includes(`read failed — connection reset`), `${domain} failure reason must appear verbatim`);
  }
  assert.ok(brief.includes("could not be read this run"));
  assert.equal(brief.includes("none recorded\n\n## What"), false);
});

test("[PR-2] a failed domain reports unavailable facts, never an empty business", async () => {
  const brief = renderBusinessBrief(await failedContext());

  assert.ok(brief.includes("could not be read — The Selling read failed: connection reset"));
  // "unavailable" and "empty" must not be interchangeable at the last step.
  assert.equal(/ordersPlacedToday\s+none recorded/.test(brief), false);
  assert.equal(/ordersPlacedToday\s+0\b/.test(brief), false);
});

test("[PR-2] every absent domain keeps its verbatim reason and is never called empty", async () => {
  const context = await fixtureContext();
  const brief = renderBusinessBrief(context);

  assert.equal(context.coverage.absent.length, 11);
  for (const entry of context.coverage.absent) {
    assert.ok(brief.includes(`${entry.domain.padEnd(16)}— ${entry.reason}`), `${entry.domain} must render with its reason verbatim`);
  }
});

// --- Unbuilt domains vs unreadable domains -----------------------------------------------------------
//
// coverage.absent holds both, and conflating them is a real defect rather than a wording nit: a
// Runtime domain whose read failed still HAS an adapter, and reporting it as architecturally missing
// turns a transient outage into a permanent gap.

function unbuiltDomains(context: BusinessContext): string[] {
  return context.coverage.knownDomains.filter((domain) => context.domains[domain] === undefined);
}

const RUNTIME_DOMAINS = ["costing", "inventory", "readiness", "selling"] as const;

test("[PR-2] the healthy fixture reports exactly the eleven genuinely unbuilt domains", async () => {
  const context = await fixtureContext();
  const brief = renderBusinessBrief(context);

  assert.equal(unbuiltDomains(context).length, 11);
  assert.equal(context.coverage.absent.length, 11, "with no failures the two happen to agree");
  assert.ok(brief.includes("11 of 15 declared domains have no adapter:"));
});

test("[PR-2] all four Runtime reads failing still reports 11 unbuilt domains, not 15", async () => {
  const context = await failedContext();
  const brief = renderBusinessBrief(context);

  // The regression: coverage.absent is now 15, because the four failed domains joined the eleven
  // that were never built. The closing statement must not follow it.
  assert.equal(context.coverage.absent.length, 15);
  assert.equal(unbuiltDomains(context).length, 11);

  assert.ok(brief.includes("11 of 15 declared domains have no adapter:"));
  assert.equal(brief.includes("15 of 15 declared domains have no adapter"), false);
});

test("[PR-2] a failed Runtime domain is never described as lacking an adapter", async () => {
  const brief = renderBusinessBrief(await failedContext());
  const sentence = brief.slice(brief.indexOf("declared domains have no adapter:"));
  // Exact list membership, not substring: "sellingFormats" legitimately contains "selling", and a
  // substring check would fail on a correct brief.
  const listed = sentence.slice(sentence.indexOf(":") + 1, sentence.indexOf(".")).split(",").map((entry) => entry.trim());

  assert.deepEqual(listed, ["products", "batches", "sellingFormats", "tasting", "supplies", "equipment", "journey", "opportunities", "creative", "brand", "aiReviews"]);
  for (const domain of RUNTIME_DOMAINS) {
    assert.equal(listed.includes(domain), false, `${domain} has an adapter; its read merely failed`);
  }
});

test("[PR-2] failed Runtime domains are still reported separately as unreadable", async () => {
  const brief = renderBusinessBrief(await failedContext());

  assert.ok(brief.includes("4 domain(s) could not be read this run (costing, inventory, readiness, selling)."));
  assert.ok(brief.includes("unavailable, which is not the same as empty"));
  // Both statements coexist: eleven are missing by architecture, four by outage.
  assert.ok(brief.includes("11 of 15 declared domains have no adapter:"));
});

test("[PR-2] one failed Runtime domain does not increase the unbuilt-domain count", async () => {
  const down = { ok: false, reason: "failed", message: "connection reset" } as const;
  const reads = fixtureReads();
  const mixed = await buildBusinessContext({
    reads: { ...reads, selling: down },
    env: FIXTURE_ENV,
    dataSource: "supabase",
    composers: [COSTING_FRESHNESS_COMPOSER.compose],
  });
  const brief = renderBusinessBrief(mixed);

  assert.equal(mixed.coverage.absent.length, 12, "eleven unbuilt plus one failed");
  assert.equal(unbuiltDomains(mixed).length, 11);

  assert.ok(brief.includes("11 of 15 declared domains have no adapter:"));
  assert.equal(brief.includes("12 of 15 declared domains have no adapter"), false);
  assert.ok(brief.includes("1 domain(s) could not be read this run (selling)."));
  assert.ok(brief.includes("costing"), "the healthy domains are unaffected");
});

test("[PR-2] the unbuilt-domain count is derived from built contexts, not from coverage.absent", () => {
  // Kills the mutation back to coverage.absent.length: the closing statement must be derived from
  // which domains the builder actually produced, which is the only thing that distinguishes
  // "no adapter" from "adapter ran and the read failed".
  assert.ok(BRIEF_CODE.includes("knownDomains.filter"));
  const closing = BRIEF_CODE.slice(BRIEF_CODE.indexOf("function renderUnknowns"));
  const statement = closing.slice(0, closing.indexOf("No canonical Product domain"));
  assert.equal(statement.includes("absent.length"), false, "the no-adapter count must not come from coverage.absent");
});

test("[PR-2] the closing section carries the corrected Product statement", async () => {
  const brief = renderBusinessBrief(await fixtureContext());

  assert.ok(brief.includes("No canonical Product domain is available. Costing and Readiness above still refer to"));
  assert.ok(brief.includes("products, but only by product ID — no product name, category, or description is in"));
});

// --- 13. No mutation -------------------------------------------------------------------------------

test("[PR-2] rendering does not mutate the context", async () => {
  const context = await fixtureContext();
  const before = JSON.stringify(context);
  const factsDigest = context.factsDigest;
  const signalsDigest = context.signalsDigest;

  renderBusinessBrief(context);

  assert.equal(context.factsDigest, factsDigest);
  assert.equal(context.signalsDigest, signalsDigest);
  assert.equal(JSON.stringify(context), before, "the entire envelope must be structurally unchanged");
});

// --- 14. Selling boundary ---------------------------------------------------------------------------

test("[PR-2] brief.ts imports only from business-context and performs no I/O", () => {
  const imports = [...BRIEF_CODE.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]);
  assert.ok(imports.length > 0);

  for (const specifier of imports) {
    assert.ok(
      specifier.startsWith("./") && !specifier.startsWith("../"),
      `brief.ts may import only from business-context/**, found "${specifier}"`,
    );
  }

  for (const forbidden of ["orders/", "orders-repository", "lab-state", "supabase", "supabase-mappers", "inventory-status", "inventory-cost", "costing.ts", "rule-engine", "components/", "app/", "scripts/", "node:"]) {
    assert.equal(BRIEF_CODE.includes(forbidden), false, `brief.ts must not reference ${forbidden}`);
  }

  for (const io of ["fetch(", "Date.now(", "new Date(", "process.env", "localStorage", "require("]) {
    assert.equal(BRIEF_CODE.includes(io), false, `brief.ts must not use ${io}`);
  }
});

test("[PR-2] Selling figures come only from the published facts, with no recalculation", async () => {
  const context = await fixtureContext();
  const selling = context.domains.selling as DomainContext;
  const brief = renderBusinessBrief(context);

  // Every rendered aggregate equals the published fact value exactly.
  for (const key of ["ordersPlacedToday", "grossPaidRevenueRolling7d", "netRevenueRolling7d", "unpaidReceivableValue", "overdueHandovers"]) {
    const fact = selling.facts[key] as Extract<Fact<number>, { state: "known" }>;
    assert.equal(fact.state, "known");
    assert.ok(brief.includes(`${key.padEnd(30)}${fact.value}`), `${key} must render its published value verbatim`);
  }

  // No Selling calculator is reachable from here.
  for (const helper of ["buildSellingSummary", "getOrderTotals", "getOrderCountsBySource", "netRevenue", "filterOrdersByFulfillment", "mapOrderRow"]) {
    assert.equal(BRIEF_CODE.includes(helper), false, `brief.ts must not call ${helper}`);
  }
});

test("[PR-2] the Selling evidence roots are not reproduced, and the omission is stated", async () => {
  const context = await fixtureContext();
  const brief = renderBusinessBrief(context);

  // The basis facts carry per-order rows; a brief is written to a clipboard and must not become a
  // data dump. The skip is declared rather than silent.
  assert.ok(brief.includes("Not shown: orderBasis, orderLineBasis"));
  assert.equal(brief.includes("orderBasis (") , false, "orderBasis rows must not be expanded");
  assert.equal(brief.includes("paidAmount"), false, "no per-order evidence field may leak");
  assert.equal(brief.includes("fulfillmentAt"), false);
});

// --- Correction A: product IDs ---------------------------------------------------------------------

test("[PR-2] a product id renders verbatim and never acquires a display name", async () => {
  const context = await fixtureContext();

  // An id whose "obvious" human name is unmistakable, so any attempt at enrichment is visible.
  const enrichmentBait = "dark-chocolate-brownie-v2";
  const baited: Signal = {
    id: "DEV-001",
    domain: "readiness",
    scope: "domain",
    subject: { kind: "product", id: enrichmentBait },
    severity: "blocker",
    status: "fail",
    message: "Not enough tasting feedback yet.",
    recommendation: "Log more tasting feedback.",
    provenance: { kind: "derived", computedBy: "evaluateProduct" },
  };

  const readiness = context.domains.readiness as DomainContext;
  const brief = renderBusinessBrief({
    ...context,
    domains: { ...context.domains, readiness: { ...readiness, signals: [baited] } },
  });

  assert.ok(brief.includes(`product ${enrichmentBait}`), "the id must appear verbatim, labelled as an id");

  // None of the plausible fabrications may appear.
  for (const fabricated of ["Dark Chocolate Brownie", "Dark-Chocolate-Brownie", "dark chocolate brownie v2", "Brownies", "Brownie V2"]) {
    assert.equal(brief.includes(fabricated), false, `the brief must not invent "${fabricated}"`);
  }
});

test("[PR-2] costing snapshots render product ids and publish no product name to render", async () => {
  const context = await fixtureContext();
  const brief = renderBusinessBrief(context);

  assert.ok(brief.includes("productId: fixture-brownies"));
  assert.ok(brief.includes("costingId: fixture-costing-brownies"));
  // Proof the envelope itself has no name to leak: no CostingSnapshot carries one.
  const snapshots = (context.domains.costing as DomainContext).facts.byCosting as Extract<Fact<Record<string, unknown>[]>, { state: "known" }>;
  for (const snapshot of snapshots.value) {
    assert.equal("name" in snapshot, false, "CostingSnapshot must not carry a product name");
    assert.equal("productName" in snapshot, false);
  }
});

test("[PR-2] brief.ts contains no product lookup, id-to-name transform or title-casing", () => {
  for (const pattern of ["toUpperCase", "titleCase", "startCase", "capitalize", "replace(/-/", "split(\"-\")", "productName", "products["]) {
    assert.equal(BRIEF_CODE.includes(pattern), false, `brief.ts must not contain ${pattern}`);
  }
});

// --- Ingredient asymmetry ---------------------------------------------------------------------------

test("[PR-2] ingredient names render because the envelope actually publishes them", async () => {
  const context = await fixtureContext();
  const inventory = context.domains.inventory as DomainContext;
  const brief = renderBusinessBrief(context);

  const snapshots = inventory.facts.byIngredient as Extract<Fact<Record<string, unknown>[]>, { state: "known" }>;
  const first = snapshots.value[0];

  // The asymmetry with products is intentional: this name is a published fact, so rendering it is
  // serialization rather than enrichment.
  assert.ok("name" in first, "IngredientSnapshot publishes a name");
  assert.ok(brief.includes(`name: ${first.name as string}`));
  assert.ok(brief.includes("ingredientId: fixture-ing-flour"));
});

// --- Correction B: Selling source counts --------------------------------------------------------------

test("[PR-2] every canonical source key renders, zeroes included, in the fact's own order", async () => {
  const context = await fixtureContext();
  const selling = context.domains.selling as DomainContext;
  const fact = selling.facts.orderCountBySourceRolling7d as Extract<Fact<Record<string, number>>, { state: "known" }>;
  const brief = renderBusinessBrief(context);

  const keys = Object.keys(fact.value);
  assert.deepEqual(keys, ["unknown", "facebook", "instagram", "tiktok", "messenger", "website", "referral", "direct"]);

  // Rendered exactly as the record supplies it: same keys, same order, zeroes visible.
  const expected = keys.map((key) => `${key} ${fact.value[key]}`).join(" · ");
  assert.ok(brief.includes(expected), "source counts must render in the fact's own key order");

  const zeroKeys = keys.filter((key) => fact.value[key] === 0);
  assert.ok(zeroKeys.length > 0, "the fixture must exercise at least one zero-count source");
  for (const key of zeroKeys) {
    assert.ok(brief.includes(`${key} 0`), `${key} must render its explicit zero`);
  }
});

test("[PR-2] no source alias, relabel or vocabulary import exists", () => {
  assert.equal(BRIEF_CODE.includes("walk_in"), false, "walk_in is not a canonical source and must never appear");
  assert.equal(BRIEF_CODE.includes("ORDER_SOURCES"), false, "the renderer must iterate the fact's own keys, not import the vocabulary");
  // Specific relabels only: a bare "Other" would match this file's own "Other signals" heading,
  // which is a section name, not a source alias.
  for (const alias of ["Walk-in", "Walk in", "Direct sale", "Unknown source", "In person"]) {
    assert.equal(BRIEF_CODE.includes(alias), false, `brief.ts must not relabel a source as "${alias}"`);
  }
});

test("[PR-2] the rendered brief never contains a non-canonical source name", async () => {
  const brief = renderBusinessBrief(await fixtureContext());

  assert.equal(brief.includes("walk_in"), false);
  assert.equal(brief.includes("walk-in"), false);
});

// --- Signals: blockers vs insufficient data ------------------------------------------------------------

test("[PR-2] insufficient_data never appears under Blockers, even at blocker severity", async () => {
  const context = await fixtureContext();
  const readiness = context.domains.readiness as DomainContext;

  const undetermined: Signal = {
    id: "QUAL-001",
    domain: "readiness",
    scope: "domain",
    subject: { kind: "product", id: "fixture-brownies" },
    severity: "blocker",
    status: "insufficient_data",
    message: "Shelf-life testing could not be evaluated.",
    recommendation: "Record a shelf-life test.",
    provenance: { kind: "inferred", computedBy: "evaluateProduct", basis: "keyword search over free text" },
  };

  const probed = { ...context, domains: { ...context.domains, readiness: { ...readiness, signals: [undetermined] } } };
  const brief = renderBusinessBrief(probed);

  // getBlockers already excludes it; this proves the renderer honours that rather than re-filtering.
  // Inventory's own genuine blockers remain, which is exactly the point: the undetermined check is
  // the only thing excluded, not blockers in general.
  const blockers = getBlockers(probed);
  assert.ok(blockers.length > 0, "real blockers must survive");
  assert.equal(blockers.some((signal) => signal.id === "QUAL-001"), false);

  const blockerSection = brief.slice(brief.indexOf("## Blockers"), brief.indexOf("## Other signals"));
  const insufficientSection = brief.slice(brief.indexOf("## Could not be evaluated"), brief.indexOf("## Notes and caveats"));

  assert.equal(blockerSection.includes("QUAL-001"), false, "an unevaluated check is not a found blocker");
  assert.ok(insufficientSection.includes("QUAL-001"));
  assert.ok(insufficientSection.includes('"we did not look"'));
});

test("[PR-2] every signal appears exactly once across the three signal sections", async () => {
  const context = await fixtureContext();
  const brief = renderBusinessBrief(context);

  const all = [
    ...Object.values(context.domains).flatMap((domain) => (domain as DomainContext).signals),
    ...context.signals,
  ];
  const blockers = getBlockers(context);
  const insufficient = all.filter((signal) => signal.status === "insufficient_data");
  const others = all.filter((signal) => !blockers.includes(signal) && signal.status !== "insufficient_data");

  assert.equal(blockers.length + insufficient.length + others.length, all.length, "the three buckets must partition the signals");
  assert.ok(blockers.length > 0 && insufficient.length > 0 && others.length > 0, "the fixture must exercise all three");

  // Recommendations are the rule's own deterministic text, reproduced verbatim.
  const first = blockers[0];
  assert.ok(brief.includes(`Recommendation: ${first.recommendation}`));
  assert.ok(brief.includes(first.message));
});

// --- AI quarantine --------------------------------------------------------------------------------------

test("[PR-2] aiGenerated content never reaches the brief", async () => {
  const context = await fixtureContext();
  const marker = "AI-WRITTEN-TEXT-THAT-MUST-NEVER-APPEAR-IN-A-DETERMINISTIC-BRIEF";
  const costing = context.domains.costing as DomainContext;

  const brief = renderBusinessBrief({
    ...context,
    domains: { ...context.domains, costing: { ...costing, aiGenerated: { summary: marker, priority: marker } } },
  });

  // An AI that reads its own earlier output back as fact compounds error invisibly, which is why the
  // envelope quarantines it and why the renderer must never open that drawer.
  assert.equal(brief.includes(marker), false);
  assert.equal(BRIEF_CODE.includes("aiGenerated"), false, "brief.ts must not reference aiGenerated at all");
});

// --- Structure ------------------------------------------------------------------------------------------

test("[PR-2] sections render in the fixed approved order", async () => {
  const brief = renderBusinessBrief(await fixtureContext());

  const expected = [
    "# Aly & Pon — Business Context",
    "## Domain coverage",
    "## Data currency",
    "## Costing",
    "## Inventory",
    "## Readiness",
    "## Selling",
    "## Blockers (getBlockers)",
    "## Other signals",
    "## Could not be evaluated (insufficient data)",
    "## Notes and caveats",
    "## What this snapshot does not know",
  ];

  let cursor = -1;
  for (const heading of expected) {
    const at = brief.indexOf(heading);
    assert.ok(at > cursor, `${heading} must appear, after the previous section`);
    cursor = at;
  }
});

test("[PR-2] a signals-only domain is described as such, not as missing data", async () => {
  const context = await fixtureContext();
  const brief = renderBusinessBrief(context);

  assert.equal(Object.keys((context.domains.readiness as DomainContext).facts).length, 0);
  assert.ok(brief.includes("This domain publishes no facts by design"));
  // Readiness has no source rows of its own, and the envelope says so; no timestamp is manufactured.
  assert.ok(brief.includes("Readiness is derived from other domains' tables and has no source rows of its own."));
});

test("[PR-2] domain notes render verbatim, in fixed domain order", async () => {
  const context = await fixtureContext();
  const brief = renderBusinessBrief(context);

  for (const domainId of ["costing", "inventory", "readiness"] as const) {
    for (const note of (context.domains[domainId] as DomainContext).notes) {
      assert.ok(brief.includes(`${domainId}: ${note}`), `${domainId} note must render verbatim`);
    }
  }
});
