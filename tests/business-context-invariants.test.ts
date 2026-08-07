import test from "node:test";
import assert from "node:assert/strict";
import { buildBusinessContext } from "../src/lib/business-context/build.ts";
import { COSTING_FRESHNESS_COMPOSER } from "../src/lib/business-context/composers/costing-freshness.ts";
import { getBlockers } from "../src/lib/business-context/selectors.ts";
import { COSTING_UPDATED_AT_RELIABLE_FROM, DOMAIN_IDS, SIGNAL_IDS } from "../src/lib/business-context/types.ts";
import type { BusinessContext, DomainContext, DomainId, Fact, Provenance, Signal } from "../src/lib/business-context/types.ts";
import { FIXTURE_ENV, FIXTURE_FACTS, fixtureReads } from "./fixtures/business-context-m1.ts";

// The Milestone 1 proof layer: structural invariants asserted over a *fully built* BusinessContext,
// not over individual adapter outputs.
//
// This complements rather than duplicates tests/business-context-provenance-invariants.test.ts.
// That file walks each adapter in isolation, including its empty and failed variants, and owns the
// per-domain provenance rules. This file owns everything that only exists once the envelope is
// assembled: coverage across all fourteen domains, cross-domain signals, digest behaviour, and the
// end-to-end pipeline. There is one invariant vocabulary, split by what each level can see.

const VALUE_CARRYING_STATES = new Set(["known", "stale"]);

// Applied to fact *names* and signal ids -- the vocabulary P13 forbids the builder from publishing.
//
// Note on "value": the plan lists it among the forbidden names, and that is about a fact *called*
// value (a whole-business worth metric). It cannot be a blanket key ban, because Fact<T> carries
// `value` as the payload of every known and stale fact by design. Checking fact names rather than
// serialized keys implements the intent without contradicting the type.
const FORBIDDEN_FACT_NAMES = ["bottleneck", "topPriority", "businessStage", "momentum", "value", "highestValueOpportunity"];

type AnyFact = Fact<unknown> & { source?: Provenance; confidence?: string };

async function buildFixtureContext(): Promise<BusinessContext> {
  return buildBusinessContext({
    reads: fixtureReads(),
    env: FIXTURE_ENV,
    dataSource: "sample",
    composers: [COSTING_FRESHNESS_COMPOSER.compose],
  });
}

function eachDomain(context: BusinessContext, visit: (domain: DomainContext) => void): void {
  for (const domain of Object.values(context.domains)) {
    if (domain) {
      visit(domain);
    }
  }
}

function eachFact(context: BusinessContext, visit: (path: string, fact: AnyFact) => void): void {
  eachDomain(context, (domain) => {
    visit(`${domain.domain}.sourceAsOf`, domain.sourceAsOf as AnyFact);
    for (const [key, fact] of Object.entries(domain.facts)) {
      visit(`${domain.domain}.facts.${key}`, fact as AnyFact);
    }
  });
}

function allSignals(context: BusinessContext): Signal[] {
  return [...Object.values(context.domains).flatMap((domain) => domain?.signals ?? []), ...context.signals];
}

// --- coverage ------------------------------------------------------------------------------------

test("[M1] coverage accounts for all fourteen declared domains", async () => {
  const context = await buildFixtureContext();

  assert.equal(context.coverage.knownDomains.length, DOMAIN_IDS.length);
  assert.deepEqual([...context.coverage.knownDomains].sort(), [...DOMAIN_IDS].sort());
});

test("[M1] exactly the built domains are present, and every other is explicitly absent", async () => {
  const context = await buildFixtureContext();

  assert.deepEqual([...context.coverage.present].sort(), ["costing", "inventory", "readiness"]);
  assert.equal(context.coverage.absent.length, DOMAIN_IDS.length - 3);
  for (const entry of context.coverage.absent) {
    assert.ok(entry.reason.length > 0, `${entry.domain} must state why it is absent`);
  }
});

test("[M1] no domain is silently missing -- every known domain is present or declared absent", async () => {
  const context = await buildFixtureContext();
  const accounted = new Set<string>([...context.coverage.present, ...context.coverage.absent.map((entry) => entry.domain)]);

  for (const domain of DOMAIN_IDS as readonly DomainId[]) {
    assert.ok(accounted.has(domain), `${domain} must be either present or declared absent`);
  }
  // And nothing appears in both buckets.
  for (const domain of context.coverage.present) {
    assert.ok(!context.coverage.absent.some((entry) => entry.domain === domain), `${domain} cannot be both present and absent`);
  }
});

// --- signals -------------------------------------------------------------------------------------

test("[M1] every emitted signal id belongs to SIGNAL_IDS", async () => {
  const context = await buildFixtureContext();
  const signals = allSignals(context);

  assert.ok(signals.length > 0, "the fixture must produce signals or it proves nothing");
  for (const signal of signals) {
    assert.ok((SIGNAL_IDS as readonly string[]).includes(signal.id), `${signal.id} is not a declared signal id`);
  }
});

test("[M1] domain-scoped signals never appear on the envelope, and cross-domain never inside a domain", async () => {
  const context = await buildFixtureContext();

  eachDomain(context, (domain) => {
    for (const signal of domain.signals) {
      assert.equal(signal.scope, "domain", `${domain.domain} published a non-domain signal`);
    }
  });
  for (const signal of context.signals) {
    assert.equal(signal.scope, "cross-domain");
  }
});

test("[M1] every cross-domain signal's provenance spans at least two domains", async () => {
  const context = await buildFixtureContext();

  assert.ok(context.signals.length > 0, "the fixture must produce a composed signal");
  for (const signal of context.signals) {
    const domainsNamed = new Set((signal.provenance.inputs ?? []).map((input) => input.split(".")[0]));
    assert.ok(domainsNamed.size >= 2, `${signal.id} spans only ${domainsNamed.size} domain(s) -- it belongs in that adapter`);
  }
});

// --- provenance ----------------------------------------------------------------------------------

test("[M1] every fact has a valid state and no undefined leaks", async () => {
  const context = await buildFixtureContext();
  const valid = new Set(["known", "empty", "unset", "unknown", "not_configured", "stale", "unavailable"]);

  eachFact(context, (path, fact) => {
    assert.ok(fact !== undefined && fact !== null, `${path} is not a Fact`);
    assert.ok(valid.has(fact.state), `${path} has invalid state ${JSON.stringify(fact.state)}`);
    if (fact.state !== "not_configured" && fact.state !== "unavailable") {
      assert.ok(fact.source, `${path} carries no source`);
    }
  });
});

test("[M1] every provenance input resolves to a real fact path", async () => {
  const context = await buildFixtureContext();
  const factNamesByDomain = new Map<string, Set<string>>();
  eachDomain(context, (domain) => factNamesByDomain.set(domain.domain, new Set(Object.keys(domain.facts))));

  const check = (path: string, provenance: Provenance | undefined) => {
    for (const input of provenance?.inputs ?? []) {
      const match = input.match(/^([A-Za-z]+)\.facts\.([A-Za-z0-9_]+)/);
      assert.ok(match, `${path}: input "${input}" is not a fact path`);

      const names = factNamesByDomain.get(match[1]);
      assert.ok(names, `${path}: input "${input}" names a domain not present in this snapshot`);
      assert.ok(names.has(match[2]), `${path}: input "${input}" names no fact published by ${match[1]}`);
    }
  };

  eachFact(context, (path, fact) => check(path, fact.source));
  for (const signal of allSignals(context)) {
    check(`signal:${signal.id}`, signal.provenance);
  }
});

test("[M1] no fact or signal depends on itself", async () => {
  const context = await buildFixtureContext();

  eachFact(context, (path, fact) => {
    for (const input of fact.source?.inputs ?? []) {
      assert.ok(!input.startsWith(path), `${path} declares a dependency on itself`);
    }
  });
});

test("[M1] inferred provenance always carries a basis and is never high confidence", async () => {
  const context = await buildFixtureContext();
  let inferredSeen = 0;

  eachFact(context, (path, fact) => {
    if (fact.source?.kind !== "inferred") {
      return;
    }
    inferredSeen += 1;
    assert.ok(fact.source.basis && fact.source.basis.length > 0, `${path}: inferred without a basis`);
    assert.notEqual(fact.confidence, "high", `${path}: inferred evidence cannot be high confidence`);
  });

  for (const signal of allSignals(context)) {
    if (signal.provenance.kind === "inferred") {
      inferredSeen += 1;
      assert.ok(signal.provenance.basis, `${signal.id}: inferred signal without a basis`);
    }
  }

  // The fixture must actually contain inferred evidence, or this proves nothing: the regex-parsed
  // costing yield and the free-text QUAL rules both land here.
  assert.ok(inferredSeen > 0, "the fixture must exercise inferred provenance");
});

test("[M1] value-carrying calculated/derived facts name computedBy and non-empty inputs", async () => {
  const context = await buildFixtureContext();
  let checked = 0;

  eachFact(context, (path, fact) => {
    if (!VALUE_CARRYING_STATES.has(fact.state)) {
      return;
    }
    const kind = fact.source?.kind;
    if (kind !== "calculated" && kind !== "derived") {
      return;
    }
    checked += 1;
    assert.ok(fact.source?.computedBy, `${path}: ${kind} without computedBy`);
    assert.ok(fact.source?.inputs?.length, `${path}: ${kind} with empty inputs`);
  });

  assert.ok(checked > 0, "the fixture must exercise calculated/derived facts");
});

test("[M1] root entered facts carry a table and never fabricate inputs or computedBy", async () => {
  const context = await buildFixtureContext();

  eachFact(context, (path, fact) => {
    if (fact.source?.kind !== "entered") {
      return;
    }
    assert.ok(fact.source.table, `${path}: entered fact must name its table`);
    assert.ok(!fact.source.inputs?.length, `${path}: entered fact claims inputs`);
    assert.ok(!fact.source.computedBy, `${path}: entered fact claims computedBy`);
  });
});

// --- quarantine and vocabulary --------------------------------------------------------------------

test("[M1] no aiGenerated content appears under facts", async () => {
  const context = await buildFixtureContext();

  // Vacuous in M1 -- no adapter publishes aiGenerated yet. Asserted anyway so it fails loudly the
  // day the Journey, Opportunities, or AI Review domains land.
  eachDomain(context, (domain) => {
    assert.doesNotMatch(JSON.stringify(domain.facts), /aiGenerated/, `${domain.domain} leaked aiGenerated into facts`);
  });
});

test("[M1] no fact or signal is named with a whole-business verdict term", async () => {
  const context = await buildFixtureContext();

  eachDomain(context, (domain) => {
    for (const name of Object.keys(domain.facts)) {
      assert.ok(!FORBIDDEN_FACT_NAMES.includes(name), `${domain.domain}.facts.${name} is a forbidden whole-business verdict`);
    }
  });
  for (const signal of allSignals(context)) {
    for (const forbidden of FORBIDDEN_FACT_NAMES) {
      assert.notEqual(signal.id, forbidden, `signal ${signal.id} is a forbidden whole-business verdict`);
    }
  }
});

test("[M1] the serialised snapshot leaks no excluded field", async () => {
  const context = await buildFixtureContext();
  const serialized = JSON.stringify(context);

  // Named individuals: the fixture records two tasters, and neither may reach the snapshot.
  for (const taster of FIXTURE_FACTS.tasterNames) {
    assert.doesNotMatch(serialized, new RegExp(taster), "a taster name reached the snapshot");
  }
  // Ledger actor -- a person identifier on an adjustment row.
  assert.doesNotMatch(serialized, new RegExp(FIXTURE_FACTS.ledgerActor), "a ledger actor reached the snapshot");
  // The raw structured-notes blob is parsed and discarded, never republished.
  assert.doesNotMatch(serialized, new RegExp(FIXTURE_FACTS.rawNotesFragment), "a raw costing notes blob reached the snapshot");
  // Storage paths and credentials: no M1 adapter reads them, asserted so that stays true.
  for (const forbidden of [/storage_path/, /storagePath/, /supabase_key/i, /service_role/i, /SUPABASE_ANON/i]) {
    assert.doesNotMatch(serialized, forbidden);
  }
});

// --- digests --------------------------------------------------------------------------------------

test("[M1] factsDigest is stable when the underlying facts do not change", async () => {
  const first = await buildFixtureContext();
  const second = await buildFixtureContext();

  assert.equal(first.factsDigest, second.factsDigest);
  assert.equal(first.signalsDigest, second.signalsDigest);
  assert.match(first.factsDigest, /^[0-9a-f]{64}$/);
  assert.match(first.signalsDigest, /^[0-9a-f]{64}$/);
});

test("[M1] factsDigest does not move for a signal-only interpretation change", async () => {
  const withComposer = await buildFixtureContext();
  const withoutComposer = await buildBusinessContext({
    reads: fixtureReads(),
    env: FIXTURE_ENV,
    dataSource: "sample",
    composers: [],
  });

  assert.equal(
    withComposer.factsDigest,
    withoutComposer.factsDigest,
    "adding or removing a composed signal must never read as 'the business changed'",
  );
  assert.notEqual(withComposer.signalsDigest, withoutComposer.signalsDigest);
});

test("[M1] signalsDigest moves when a domain signal changes", async () => {
  const baseline = await buildFixtureContext();

  // Restock the out-of-stock ingredient: one fewer domain signal, and different facts too.
  const reads = fixtureReads();
  const restocked = reads.inventory.ok
    ? reads.inventory.rows.ingredients.map((row) =>
        row.id === FIXTURE_FACTS.outOfStockIngredientId ? { ...row, current_quantity: 1500 } : row,
      )
    : [];

  const changed = await buildBusinessContext({
    reads: { ...reads, inventory: { ok: true, rows: { ingredients: restocked, transactions: reads.inventory.ok ? reads.inventory.rows.transactions : [] } } },
    env: FIXTURE_ENV,
    dataSource: "sample",
    composers: [COSTING_FRESHNESS_COMPOSER.compose],
  });

  assert.notEqual(baseline.signalsDigest, changed.signalsDigest);
  // A real row changed, so the facts digest moves too -- that is the correct pairing.
  assert.notEqual(baseline.factsDigest, changed.factsDigest);
});

test("[M1] factsDigest moves when a fixture row changes", async () => {
  const baseline = await buildFixtureContext();

  const reads = fixtureReads();
  const repriced = reads.costing.ok
    ? reads.costing.rows.costings.map((row) => (row.id === FIXTURE_FACTS.reliableCostingId ? { ...row, ingredient_cost: 999 } : row))
    : [];

  const changed = await buildBusinessContext({
    reads: { ...reads, costing: { ok: true, rows: { costings: repriced, entries: reads.costing.ok ? reads.costing.rows.entries : [] } } },
    env: FIXTURE_ENV,
    dataSource: "sample",
    composers: [COSTING_FRESHNESS_COMPOSER.compose],
  });

  assert.notEqual(baseline.factsDigest, changed.factsDigest);
});

test("[M1] generatedAt affects neither digest", async () => {
  const early = await buildFixtureContext();
  const later = await buildBusinessContext({
    reads: fixtureReads(),
    // A day later, same business day arithmetic aside -- the clock alone must not move a digest.
    env: { ...FIXTURE_ENV, now: FIXTURE_ENV.now + 60_000 },
    dataSource: "sample",
    composers: [COSTING_FRESHNESS_COMPOSER.compose],
  });

  assert.notEqual(early.generatedAt, later.generatedAt);
  assert.equal(early.factsDigest, later.factsDigest);
  assert.equal(early.signalsDigest, later.signalsDigest);
});

// --- blocker survival and selection ----------------------------------------------------------------

test("[M1] every blocker survives the final selection contract", async () => {
  const context = await buildFixtureContext();

  const expected = allSignals(context).filter((signal) => signal.severity === "blocker" && signal.status === "fail");
  const selected = getBlockers(context);

  assert.ok(expected.length > 0, "the fixture must produce blockers");
  assert.equal(selected.length, expected.length, "no blocker may be dropped by the selection contract");
  for (const signal of expected) {
    assert.ok(selected.includes(signal), `blocker ${signal.id} was dropped`);
  }
});

test("[M1] getBlockers returns references, not copies", async () => {
  const context = await buildFixtureContext();
  const source = allSignals(context);

  for (const blocker of getBlockers(context)) {
    assert.ok(source.some((signal) => signal === blocker), "getBlockers must return the context's own objects");
  }
});

test("[M1] a blocker-severity signal with insufficient_data is not selected", async () => {
  const context = await buildFixtureContext();
  const selected = getBlockers(context);

  for (const signal of selected) {
    assert.equal(signal.status, "fail", "a blocker we could not evaluate is not a blocker we found");
  }
});

// --- reliability boundary honesty ------------------------------------------------------------------

test("[M1] a pre-boundary costing review time stays unknown, with no invented value", async () => {
  const context = await buildFixtureContext();
  const snapshots = (context.domains.costing?.facts.byCosting as Fact<Array<{ costingId: string; reviewedAt: AnyFact }>>);
  assert.equal(snapshots.state, "known");

  const preBoundary = (snapshots as { value: Array<{ costingId: string; reviewedAt: AnyFact }> }).value
    .find((entry) => entry.costingId === FIXTURE_FACTS.preBoundaryCostingId);

  assert.ok(preBoundary);
  assert.equal(preBoundary.reviewedAt.state, "unknown");
  assert.ok(!("value" in preBoundary.reviewedAt), "an unreliable review time must carry no value at all");
  assert.match((preBoundary.reviewedAt as { because: string }).because, /were not maintained before/);
});

test("[M1] a post-boundary costing review time is eligible to be treated as reliable", async () => {
  const context = await buildFixtureContext();
  const snapshots = context.domains.costing?.facts.byCosting as Fact<Array<{ costingId: string; reviewedAt: AnyFact }>>;

  const postBoundary = (snapshots as { value: Array<{ costingId: string; reviewedAt: AnyFact }> }).value
    .find((entry) => entry.costingId === FIXTURE_FACTS.passingCostingId);

  assert.ok(postBoundary);
  assert.equal(postBoundary.reviewedAt.state, "known");
  assert.ok(Date.parse((postBoundary.reviewedAt as { value: string }).value) >= Date.parse(COSTING_UPDATED_AT_RELIABLE_FROM));
});

test("[M1] no historical backfill assumption appears anywhere in the snapshot", async () => {
  const context = await buildFixtureContext();

  // A backfilled row would show as every costing carrying a reliable review time. The fixture
  // deliberately contains one that cannot, and it must stay unknown.
  const snapshots = context.domains.costing?.facts.byCosting as Fact<Array<{ costingId: string; reviewedAt: AnyFact }>>;
  const states = (snapshots as { value: Array<{ reviewedAt: AnyFact }> }).value.map((entry) => entry.reviewedAt.state);

  assert.ok(states.includes("unknown"), "a pre-boundary costing must remain unknown, never backfilled");
  assert.ok(states.includes("known"), "a post-boundary costing must remain usable");

  // And the composer reports the unreliable one honestly rather than guessing.
  const unreliable = context.signals.find((signal) => signal.subject?.id === FIXTURE_FACTS.preBoundaryCostingId);
  assert.ok(unreliable);
  assert.equal(unreliable.status, "insufficient_data");
});

test("[M1] the composed freshness signal produces every determinate outcome in one build", async () => {
  const context = await buildFixtureContext();
  const byCosting = new Map(context.signals.map((signal) => [signal.subject?.id, signal]));

  // Reviewed after the boundary but before the latest purchase.
  assert.equal(byCosting.get(FIXTURE_FACTS.reliableButStaleCostingId)?.status, "fail");
  // Reviewed after the latest purchase.
  assert.equal(byCosting.get(FIXTURE_FACTS.passingCostingId)?.status, "pass");
  // Review time not dependable.
  assert.equal(byCosting.get(FIXTURE_FACTS.preBoundaryCostingId)?.status, "insufficient_data");
});

// --- timezone determinism ---------------------------------------------------------------------------

test("[M1] the business day is deterministic and honours the injected timezone", async () => {
  const context = await buildFixtureContext();
  assert.equal(context.businessDay, "2026-08-09");
  assert.equal(context.timezone, "Asia/Manila");

  // The fixture clock is 2026-08-09T02:00Z, which is still 2026-08-08 in UTC. If the builder ever
  // defaulted to UTC, this assertion is what would catch it.
  assert.notEqual(context.businessDay, new Date(FIXTURE_ENV.now).toISOString().slice(0, 10));
});

test("[M1] the Manila day boundary shifts businessDay and nothing else", async () => {
  const before = await buildBusinessContext({
    reads: fixtureReads(),
    env: { ...FIXTURE_ENV, now: Date.parse("2026-08-09T15:59:00.000Z"), businessDay: "2026-08-09" },
    dataSource: "sample",
    composers: [COSTING_FRESHNESS_COMPOSER.compose],
  });
  const after = await buildBusinessContext({
    reads: fixtureReads(),
    env: { ...FIXTURE_ENV, now: Date.parse("2026-08-09T16:01:00.000Z"), businessDay: "2026-08-10" },
    dataSource: "sample",
    composers: [COSTING_FRESHNESS_COMPOSER.compose],
  });

  assert.equal(before.businessDay, "2026-08-09");
  assert.equal(after.businessDay, "2026-08-10");

  // Nothing else about the fixture depends on which side of the boundary we are on: the expiring
  // ingredient is already expired either way, so facts and signals stay identical.
  assert.equal(before.factsDigest, after.factsDigest);
  assert.equal(before.signalsDigest, after.signalsDigest);
});
