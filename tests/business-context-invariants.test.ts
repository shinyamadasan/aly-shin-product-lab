import test from "node:test";
import assert from "node:assert/strict";
import { buildBusinessContext } from "../src/lib/business-context/build.ts";
import { COSTING_FRESHNESS_COMPOSER } from "../src/lib/business-context/composers/costing-freshness.ts";
import { getBlockers } from "../src/lib/business-context/selectors.ts";
import { COSTING_UPDATED_AT_RELIABLE_FROM, DOMAIN_IDS, SIGNAL_IDS } from "../src/lib/business-context/types.ts";
import type { BusinessContext, DomainContext, DomainId, Fact, Provenance, Signal } from "../src/lib/business-context/types.ts";
import { resolveBusinessDay } from "../src/lib/business-day.ts";
import { FIXTURE_ENV, FIXTURE_FACTS, fixtureReads } from "./fixtures/business-context-m1.ts";
import { declaredPath, walkFacts, type AnyFact, type VisitedFact } from "./helpers/business-context-fact-walker.ts";

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

// Recursive: descends into collection-valued facts, so every canonical Fact in the snapshot is
// visited, not only the dozen published directly on each domain. See walkFacts for why.
function visitedFacts(context: BusinessContext): VisitedFact[] {
  const visited: VisitedFact[] = [];
  eachDomain(context, (domain) => {
    visited.push(...walkFacts(domain.sourceAsOf, `${domain.domain}.sourceAsOf`));
    for (const [key, fact] of Object.entries(domain.facts)) {
      visited.push(...walkFacts(fact, `${domain.domain}.facts.${key}`));
    }
  });
  return visited;
}

function eachFact(context: BusinessContext, visit: (path: string, fact: AnyFact) => void): void {
  for (const { path, fact } of visitedFacts(context)) {
    visit(path, fact);
  }
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

  assert.deepEqual([...context.coverage.present].sort(), ["costing", "inventory", "readiness", "selling"]);
  assert.equal(context.coverage.absent.length, DOMAIN_IDS.length - 4);
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

// Resolution and self-reference are written as predicates returning violation lists, so the real
// assertions and the mutation probes below run the *same* code. A probe that re-implemented the rule
// would only prove the probe works.

// The member names each collection fact actually publishes, read off a real member rather than a
// hardcoded list, so a renamed snapshot field cannot silently keep passing.
function collectionMembers(context: BusinessContext): Map<string, Set<string>> {
  const members = new Map<string, Set<string>>();
  eachDomain(context, (domain) => {
    for (const [key, fact] of Object.entries(domain.facts)) {
      const value = (fact as AnyFact).value;
      if (Array.isArray(value) && value.length > 0 && typeof value[0] === "object" && value[0] !== null) {
        members.set(`${domain.domain}.facts.${key}`, new Set(Object.keys(value[0] as Record<string, unknown>)));
      }
    }
  });
  return members;
}

function inputResolutionViolations(context: BusinessContext): string[] {
  const violations: string[] = [];
  const factNamesByDomain = new Map<string, Set<string>>();
  eachDomain(context, (domain) => factNamesByDomain.set(domain.domain, new Set(Object.keys(domain.facts))));
  const members = collectionMembers(context);

  const check = (path: string, provenance: Provenance | undefined) => {
    for (const input of provenance?.inputs ?? []) {
      const match = input.match(/^([A-Za-z]+)\.facts\.([A-Za-z0-9_]+)/);
      if (!match) {
        violations.push(`${path}: input "${input}" is not a fact path`);
        continue;
      }
      const names = factNamesByDomain.get(match[1]);
      if (!names) {
        violations.push(`${path}: input "${input}" names a domain not present in this snapshot`);
        continue;
      }
      if (!names.has(match[2])) {
        violations.push(`${path}: input "${input}" names no fact published by ${match[1]}`);
        continue;
      }

      // Resolve the member segment too. Without this, "byCosting[].costPerPeice" resolves to the
      // byCosting fact and passes -- a typo in a dependency list would never be caught.
      const member = input.match(/^([A-Za-z]+\.facts\.[A-Za-z0-9_]+)\[\]\.([A-Za-z0-9_]+)$/);
      if (member) {
        const published = members.get(member[1]);
        if (published && !published.has(member[2])) {
          violations.push(`${path}: input "${input}" names no member published on ${member[1]}`);
        }
      }
    }
  };

  for (const { path, fact } of visitedFacts(context)) {
    check(path, fact.source);
  }
  for (const signal of allSignals(context)) {
    check(`signal:${signal.id}`, signal.provenance);
  }
  return violations;
}

function selfReferenceViolations(context: BusinessContext): string[] {
  const violations: string[] = [];

  for (const { path, fact } of visitedFacts(context)) {
    // Compared in the declared form. The raw walked path is member-indexed
    // ("...byCosting.value.0.margin") while a declared input is member-agnostic
    // ("...byCosting[].margin"), so a direct comparison answers "never equal" for every nested fact
    // -- which is what made the original check vacuous for 129 of 141 facts.
    const self = declaredPath(path);
    for (const input of fact.source?.inputs ?? []) {
      if (input === self) {
        violations.push(`${path}: declares a dependency on itself`);
      }
    }
  }

  for (const signal of allSignals(context)) {
    // A Signal has no fact path of its own -- it is addressed by id, and Provenance.inputs is
    // documented as *fact* paths. So a signal cannot name itself the way a fact can. The
    // self-reference it can structurally express is naming the signal collection it lives in, which
    // is not a fact path at all and resolves to nothing. That is not hypothetical: it shipped as
    // inputs: ["readiness.signals"] and was removed as F6. Both degenerate forms are checked.
    for (const input of signal.provenance.inputs ?? []) {
      if (/^[A-Za-z-]+\.signals\b/.test(input)) {
        violations.push(`signal:${signal.id}: input "${input}" names a signal collection, not a fact`);
      }
      if (input.includes(signal.id)) {
        violations.push(`signal:${signal.id}: input "${input}" names the signal itself`);
      }
    }
  }

  return violations;
}

test("[M1] every provenance input resolves to a real fact path, down to the collection member", async () => {
  assert.deepEqual(inputResolutionViolations(await buildFixtureContext()), []);
});

test("[M1] no fact or signal depends on itself", async () => {
  assert.deepEqual(selfReferenceViolations(await buildFixtureContext()), []);
});

test("[M1] the fact walker reaches nested facts, not just the domain's published top level", async () => {
  // The regression guard for F7. The original walker visited only domain.facts[key] and reached 12
  // of 141 facts -- every costing metric, reviewedAt, and ingredient snapshot field went unchecked,
  // hiding 21 real provenance violations. If traversal ever collapses back to the top level, the
  // thresholds below fail rather than the suite quietly passing on 9% of the data.
  const context = await buildFixtureContext();
  const visited = visitedFacts(context);

  const top = visited.filter((entry) => entry.depth === 0);
  const nested = visited.filter((entry) => entry.depth > 0);
  const nestedCosting = nested.filter((entry) => entry.path.startsWith("costing.facts.byCosting"));
  const nestedInventory = nested.filter((entry) => entry.path.startsWith("inventory.facts.byIngredient"));

  // Reported so a reviewer can see the real number without reading the fixture.
  console.log(`[M1] fact traversal: ${visited.length} facts (${top.length} top-level, ${nested.length} nested)`);

  assert.ok(top.length >= 10, `expected the published top-level facts, saw ${top.length}`);
  assert.ok(nested.length > top.length, "most facts in this fixture are nested; traversal must reach them");
  assert.ok(nestedCosting.length >= 20, `expected nested Costing facts, saw ${nestedCosting.length}`);
  assert.ok(nestedInventory.length >= 20, `expected nested Inventory facts, saw ${nestedInventory.length}`);

  // Every visited path is unique -- each Fact is visited exactly once.
  assert.equal(new Set(visited.map((entry) => entry.path)).size, visited.length);
});

test("[M1] inferred provenance always carries a basis and is never high confidence", async () => {
  const context = await buildFixtureContext();

  // Counted separately, deliberately. Signal provenance must never make a fact-level guard look
  // exercised -- that is exactly how the original version passed while checking no inferred fact
  // at all.
  const facts = inferredViolations(visitedFacts(context));
  assert.deepEqual(facts.violations, []);

  let inferredSignals = 0;
  for (const signal of allSignals(context)) {
    if (signal.provenance.kind === "inferred") {
      inferredSignals += 1;
      assert.ok(signal.provenance.basis, `${signal.id}: inferred signal without a basis`);
    }
  }

  const inferredFacts = facts.checked;

  // The regex-parsed costing yield and target food cost are nested inside byCosting, so this only
  // holds once traversal is recursive.
  assert.ok(inferredFacts > 0, "the fixture must exercise inferred provenance at FACT level");
  assert.ok(inferredSignals > 0, "the fixture must exercise inferred provenance at SIGNAL level");
});

// The two provenance rules, written once as predicates so the real assertions and the mutation probe
// below cannot drift apart. `checked` is what keeps them from passing on an empty walk.
function provenanceViolations(visited: VisitedFact[]): { violations: string[]; checked: number } {
  const violations: string[] = [];
  let checked = 0;

  for (const { path, fact } of visited) {
    if (!VALUE_CARRYING_STATES.has(fact.state)) {
      continue;
    }
    const kind = fact.source?.kind;
    if (kind !== "calculated" && kind !== "derived") {
      continue;
    }
    checked += 1;
    if (!fact.source?.computedBy) {
      violations.push(`${path}: ${kind} without computedBy`);
    }
    if (!fact.source?.inputs?.length) {
      violations.push(`${path}: ${kind} with empty inputs`);
    }
  }

  return { violations, checked };
}

function inferredViolations(visited: VisitedFact[]): { violations: string[]; checked: number } {
  const violations: string[] = [];
  let checked = 0;

  for (const { path, fact } of visited) {
    if (fact.source?.kind !== "inferred") {
      continue;
    }
    checked += 1;
    if (!fact.source.basis) {
      violations.push(`${path}: inferred without a basis`);
    }
    if (fact.confidence === "high") {
      violations.push(`${path}: inferred with high confidence`);
    }
  }

  return { violations, checked };
}

test("[M1] value-carrying calculated/derived facts name computedBy and non-empty inputs", async () => {
  const { violations, checked } = provenanceViolations(visitedFacts(await buildFixtureContext()));

  assert.deepEqual(violations, []);
  assert.ok(checked > 0, "the fixture must exercise calculated/derived facts");
});

// --- anti-vacuity -------------------------------------------------------------------------------
//
// An invariant that never fails proves nothing, and this suite has already shipped two that could
// not fail: the F7 walker gap left every rule checking 12 of 141 facts, and the self-reference
// comparison could not match a nested path at all (F9). Every probe below therefore corrupts a fact
// *inside* a collection -- never a top-level one -- so a regression to top-level-only traversal, or
// to a member-blind comparison, fails this test rather than passing quietly.
//
// Each probe runs the same predicate the real invariant runs, asserts the violation is reported,
// restores the original value, and asserts the violation clears. The expected result is a fixed
// string, never recomputed from the mutated state.

/** Applies `mutate`, returns what `detect` reports, then puts the original value back. */
function probe<T>(target: Record<string, T>, key: string, mutated: T, detect: () => string[]): { during: string[]; after: string[] } {
  const original = target[key];
  target[key] = mutated;
  const during = detect();
  target[key] = original;
  return { during, after: detect() };
}

test("[M1] mutation proof: all four provenance defect classes are caught on NESTED facts", async () => {
  const context = await buildFixtureContext();
  const snapshot = (context.domains.costing?.facts.byCosting as { value: Record<string, AnyFact>[] }).value[0];

  const provenance = () => provenanceViolations(visitedFacts(context)).violations;
  const inferred = () => inferredViolations(visitedFacts(context)).violations;
  const resolution = () => inputResolutionViolations(context);
  const selfRef = () => selfReferenceViolations(context);

  // Baseline: every predicate is clean before anything is touched, so a violation seen below is
  // caused by the mutation and nothing else.
  for (const [label, detect] of [["provenance", provenance], ["inferred", inferred], ["resolution", resolution], ["self-reference", selfRef]] as const) {
    assert.deepEqual(detect(), [], `${label} must be clean before mutating`);
  }

  // (1) A nested calculated fact loses its dependency list -- the exact F8 defect shape.
  assert.equal(snapshot.costPerPiece.source?.kind, "calculated", "probe 1 must target a genuinely calculated fact");
  const one = probe(snapshot.costPerPiece as unknown as Record<string, unknown>, "source", { ...snapshot.costPerPiece.source!, inputs: [] }, provenance);
  assert.ok(
    one.during.some((entry) => entry.endsWith("value.0.costPerPiece: calculated with empty inputs")),
    `(1) emptying a nested calculated fact's inputs must be caught, got: ${JSON.stringify(one.during)}`,
  );
  assert.deepEqual(one.after, [], "(1) must clear on restoration");

  // (2) A nested inferred fact claims certainty a value parsed out of prose cannot have.
  assert.equal(snapshot.costingYield.source?.kind, "inferred", "probe 2 must target a genuinely inferred fact");
  const two = probe(snapshot.costingYield as unknown as Record<string, unknown>, "confidence", "high", inferred);
  assert.ok(
    two.during.some((entry) => entry.endsWith("value.0.costingYield: inferred with high confidence")),
    `(2) a nested inferred fact claiming high confidence must be caught, got: ${JSON.stringify(two.during)}`,
  );
  assert.deepEqual(two.after, [], "(2) must clear on restoration");

  // (3) A nested input misspells a collection member. It still resolves to the byCosting fact, so
  // only member-level resolution can catch it.
  const three = probe(
    snapshot.costPerPiece as unknown as Record<string, unknown>,
    "source",
    { ...snapshot.costPerPiece.source!, inputs: ["costing.facts.byCosting[].costPerPeice", "costing.facts.byCosting[].costingYield"] },
    resolution,
  );
  assert.ok(
    three.during.some((entry) => entry.includes('input "costing.facts.byCosting[].costPerPeice" names no member published on costing.facts.byCosting')),
    `(3) a misspelled collection member must be caught, got: ${JSON.stringify(three.during)}`,
  );
  assert.deepEqual(three.after, [], "(3) must clear on restoration");

  // (4) A nested fact declares itself as its own input -- the F5 shape, one level down.
  const four = probe(
    snapshot.margin as unknown as Record<string, unknown>,
    "source",
    { ...snapshot.margin.source!, inputs: ["costing.facts.byCosting[].margin"] },
    selfRef,
  );
  assert.ok(
    four.during.some((entry) => entry.endsWith("value.0.margin: declares a dependency on itself")),
    `(4) a nested self-reference must be caught, got: ${JSON.stringify(four.during)}`,
  );
  assert.deepEqual(four.after, [], "(4) must clear on restoration");
});

test("[M1] mutation proof: a signal naming its own signal collection is caught", async () => {
  // The signal half of the self-reference rule. A Signal has no fact path of its own -- it is
  // addressed by id, and Provenance.inputs holds *fact* paths -- so it cannot name itself the way a
  // fact can. Manufacturing an impossible state would prove nothing; the degenerate form the
  // contract genuinely permits is a signal naming the signal collection it lives in, which resolves
  // to no fact at all. That is not hypothetical: it shipped as inputs: ["readiness.signals"] and was
  // removed as F6. Both that shape and a signal naming its own id are asserted here.
  const context = await buildFixtureContext();
  const signal = context.domains.readiness?.signals[0];
  assert.ok(signal, "the fixture must publish a Readiness signal for this probe to mean anything");
  assert.ok(!signal.provenance.inputs, "F6 removed the fabricated input; the probe reintroduces it deliberately");

  const collection = probe(
    signal.provenance as unknown as Record<string, unknown>,
    "inputs",
    ["readiness.signals"],
    () => selfReferenceViolations(context),
  );
  assert.ok(
    collection.during.some((entry) => entry.includes(`signal:${signal.id}`) && entry.includes("names a signal collection, not a fact")),
    `the F6 shape must be caught, got: ${JSON.stringify(collection.during)}`,
  );
  assert.deepEqual(collection.after, [], "must clear on restoration");

  // The same input is also not a resolvable fact path, so the resolution invariant independently
  // rejects it. Two rules, two reasons -- neither relies on the other.
  const unresolvable = probe(
    signal.provenance as unknown as Record<string, unknown>,
    "inputs",
    ["readiness.signals"],
    () => inputResolutionViolations(context),
  );
  assert.ok(
    unresolvable.during.some((entry) => entry.includes(`signal:${signal.id}`)),
    `the F6 shape must also fail input resolution, got: ${JSON.stringify(unresolvable.during)}`,
  );

  // A signal naming its own id is the other degenerate form, and is caught too.
  const byId = probe(
    signal.provenance as unknown as Record<string, unknown>,
    "inputs",
    [`readiness.facts.${signal.id}`],
    () => selfReferenceViolations(context),
  );
  assert.ok(
    byId.during.some((entry) => entry.includes("names the signal itself")),
    `a signal naming its own id must be caught, got: ${JSON.stringify(byId.during)}`,
  );
  assert.deepEqual(byId.after, [], "must clear on restoration");
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

test("[M1] the Manila day boundary shifts businessDay and only the day-scoped facts", async () => {
  // businessDay is derived through the real resolveBusinessDay rather than hardcoded into env.
  // Asserting a value that the test itself supplied would be circular -- it would prove only that
  // the builder copies what it is handed, not that the boundary lands at 16:00Z.
  const justBefore = Date.parse("2026-08-09T15:59:00.000Z");
  const justAfter = Date.parse("2026-08-09T16:01:00.000Z");

  const before = await buildBusinessContext({
    reads: fixtureReads(),
    env: { ...FIXTURE_ENV, now: justBefore, businessDay: resolveBusinessDay(justBefore, FIXTURE_ENV.timezone) },
    dataSource: "sample",
    composers: [COSTING_FRESHNESS_COMPOSER.compose],
  });
  const after = await buildBusinessContext({
    reads: fixtureReads(),
    env: { ...FIXTURE_ENV, now: justAfter, businessDay: resolveBusinessDay(justAfter, FIXTURE_ENV.timezone) },
    dataSource: "sample",
    composers: [COSTING_FRESHNESS_COMPOSER.compose],
  });

  // Two minutes apart, one day apart -- computed, not asserted into existence.
  assert.equal(before.businessDay, "2026-08-09");
  assert.equal(after.businessDay, "2026-08-10");

  // The TIMEZONE-INDEPENDENT domains publish identical FACTS on both sides. Nothing about their
  // fixture data depends on which side of the boundary we are on -- the expiring ingredient is
  // already expired either way.
  //
  // Facts rather than the whole DomainContext, deliberately: inventory's `notes` quote the business
  // day ("anchored to 2026-08-09 in Asia/Manila"), which correctly differs. buildFactsDigest
  // excludes notes for exactly that reason -- a disclosure sentence naming the day is not the
  // business changing.
  for (const domain of ["costing", "inventory", "readiness"] as const) {
    assert.deepEqual(before.domains[domain]?.facts, after.domains[domain]?.facts, `${domain} facts must not move across a day boundary`);
    assert.deepEqual(before.domains[domain]?.sourceAsOf, after.domains[domain]?.sourceAsOf);
    assert.deepEqual(before.domains[domain]?.rowCounts, after.domains[domain]?.rowCounts);
  }
  assert.deepEqual(before.signals, after.signals);
  assert.equal(before.signalsDigest, after.signalsDigest);

  // Selling DOES move, and must: it publishes day-scoped measurements, so at midnight in Manila
  // "today's revenue" genuinely stops being today's. This was asserted as an envelope-wide
  // invariant before S8, when no domain was day-scoped; keeping that assertion would now require
  // Selling to report yesterday's takings as today's.
  //
  // The fixture's two paid orders land on 2026-08-09 Manila, so they are today's before the
  // boundary and outside it after.
  const sellingBefore = before.domains.selling?.facts;
  const sellingAfter = after.domains.selling?.facts;
  const value = (fact: Fact<unknown> | undefined) => (fact && fact.state === "known" ? fact.value : undefined);
  assert.equal(value(sellingBefore?.grossPaidRevenueToday), 720, "both fixture payments land on 2026-08-09 Manila");
  assert.equal(value(sellingAfter?.grossPaidRevenueToday), 0, "after midnight they are no longer today's");
  assert.equal(value(sellingBefore?.ordersPlacedToday), 2);
  assert.equal(value(sellingAfter?.ordersPlacedToday), 0);

  // The two basis facts are raw evidence and carry no window, so they are identical on both sides.
  // That is the tell that Selling's movement comes from the window, not from the rows.
  assert.deepEqual(sellingBefore?.orderBasis, sellingAfter?.orderBasis);
  assert.deepEqual(sellingBefore?.orderLineBasis, sellingAfter?.orderLineBasis);

  // And therefore the facts digest moves, while the signals digest does not.
  assert.notEqual(before.factsDigest, after.factsDigest);
});
