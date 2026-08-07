import test from "node:test";
import assert from "node:assert/strict";
import { buildFactsDigest, buildSignalsDigest, stableStringify } from "../src/lib/business-context/digest.ts";
import type { BusinessContextCoverage, DomainContext, DomainId, Provenance, Signal } from "../src/lib/business-context/types.ts";

const entered: Provenance = { kind: "entered", table: "costing_summaries", column: "packaging_cost" };

function domain(overrides: Partial<DomainContext> = {}): DomainContext {
  return {
    domain: "costing",
    adapterVersion: 1,
    readOutcome: { ok: true },
    sourceAsOf: { state: "known", value: "2026-08-06T00:00:00.000Z", source: entered },
    rowCounts: { read: 3, included: 3, omitted: 0 },
    facts: { packagingCost: { state: "known", value: 20, source: entered } },
    signals: [],
    notes: [],
    ...overrides,
  };
}

function signal(overrides: Partial<Signal> = {}): Signal {
  return {
    id: "FIN-001",
    domain: "readiness",
    scope: "domain",
    severity: "blocker",
    status: "fail",
    message: "Margin is below target.",
    recommendation: "Review the costing.",
    provenance: { kind: "derived", computedBy: "evaluateProduct", inputs: ["costing.facts.margin"] },
    ...overrides,
  };
}

function coverage(overrides: Partial<BusinessContextCoverage> = {}): BusinessContextCoverage {
  return {
    knownDomains: ["costing", "inventory"] as DomainId[],
    present: ["costing"] as DomainId[],
    absent: [{ domain: "inventory" as DomainId, reason: "adapter not built yet" }],
    ...overrides,
  };
}

// --- stableStringify ----------------------------------------------------------------------------

test("stableStringify: key insertion order does not affect output", () => {
  // The whole reason JSON.stringify cannot be used directly for a digest.
  assert.equal(stableStringify({ a: 1, b: 2 }), stableStringify({ b: 2, a: 1 }));
});

test("stableStringify: nested objects are sorted at every depth", () => {
  const left = { outer: { z: 1, a: { y: 2, b: 3 } } };
  const right = { outer: { a: { b: 3, y: 2 }, z: 1 } };
  assert.equal(stableStringify(left), stableStringify(right));
});

test("stableStringify: array order is meaningful and preserved", () => {
  assert.notEqual(stableStringify([1, 2, 3]), stableStringify([3, 2, 1]));
});

test("stableStringify: an undefined property is omitted, matching a missing key", () => {
  // Pinned deliberately: the choice is arbitrary, so it must be asserted rather than assumed.
  assert.equal(stableStringify({ a: 1, b: undefined }), stableStringify({ a: 1 }));
});

test("stableStringify: null is distinct from both undefined and a missing key", () => {
  assert.notEqual(stableStringify({ a: 1, b: null }), stableStringify({ a: 1 }));
});

test("stableStringify: an undefined array element becomes null, preserving length", () => {
  assert.equal(stableStringify([1, undefined, 3]), "[1,null,3]");
});

test("stableStringify: handles primitives and empty containers", () => {
  assert.equal(stableStringify(null), "null");
  assert.equal(stableStringify(undefined), "null");
  assert.equal(stableStringify(0), "0");
  assert.equal(stableStringify(""), '""');
  assert.equal(stableStringify(false), "false");
  assert.equal(stableStringify({}), "{}");
  assert.equal(stableStringify([]), "[]");
});

test("stableStringify: a real zero and an absent value are not conflated", () => {
  assert.notEqual(stableStringify({ cost: 0 }), stableStringify({ cost: undefined }));
});

// --- digests ------------------------------------------------------------------------------------

test("buildFactsDigest: is stable across two builds of identical input", async () => {
  const input = { domains: { costing: domain() }, coverage: coverage() };
  assert.equal(await buildFactsDigest(input), await buildFactsDigest(input));
});

test("buildFactsDigest: is insensitive to domain key insertion order", async () => {
  const first = { domains: { costing: domain(), inventory: domain({ domain: "inventory" }) }, coverage: coverage() };
  const second = { domains: { inventory: domain({ domain: "inventory" }), costing: domain() }, coverage: coverage() };
  assert.equal(await buildFactsDigest(first), await buildFactsDigest(second));
});

test("buildFactsDigest: changes when a fact value changes", async () => {
  const before = { domains: { costing: domain() }, coverage: coverage() };
  const after = {
    domains: { costing: domain({ facts: { packagingCost: { state: "known", value: 21, source: entered } } }) },
    coverage: coverage(),
  };
  assert.notEqual(await buildFactsDigest(before), await buildFactsDigest(after));
});

test("buildFactsDigest: changes when a fact's state changes even though no value moved", async () => {
  // known(0) vs unset is the distinction the whole builder exists to preserve -- the digest must
  // see it too.
  const known = { domains: { costing: domain({ facts: { cost: { state: "known", value: 0, source: entered } } }) }, coverage: coverage() };
  const unset = { domains: { costing: domain({ facts: { cost: { state: "unset", source: entered } } }) }, coverage: coverage() };
  assert.notEqual(await buildFactsDigest(known), await buildFactsDigest(unset));
});

test("buildFactsDigest: changes when a read outcome changes", async () => {
  const healthy = { domains: { costing: domain() }, coverage: coverage() };
  const failed = {
    domains: { costing: domain({ readOutcome: { ok: false, reason: "failed", message: "boom" } }) },
    coverage: coverage(),
  };
  assert.notEqual(await buildFactsDigest(healthy), await buildFactsDigest(failed));
});

test("buildFactsDigest: does NOT change when only adapterVersion changes", async () => {
  // A code version bump with every value identical is not the business changing. If it moved this
  // digest it would invalidate grounded prior AI answers for no reason.
  const before = { domains: { costing: domain({ adapterVersion: 1 }) }, coverage: coverage() };
  const after = { domains: { costing: domain({ adapterVersion: 2 }) }, coverage: coverage() };
  assert.equal(await buildFactsDigest(before), await buildFactsDigest(after));
});

test("buildFactsDigest: does NOT change when only notes change", async () => {
  // Notes are explanatory prose about how a value was obtained -- not the value.
  const before = { domains: { costing: domain({ notes: [] }) }, coverage: coverage() };
  const after = {
    domains: { costing: domain({ notes: ["Yield parsed from free-text costing.notes."] }) },
    coverage: coverage(),
  };
  assert.equal(await buildFactsDigest(before), await buildFactsDigest(after));
});

test("buildFactsDigest: does NOT change when adapterVersion and notes both change together", async () => {
  const before = { domains: { costing: domain({ adapterVersion: 1, notes: [] }) }, coverage: coverage() };
  const after = { domains: { costing: domain({ adapterVersion: 7, notes: ["a", "b"] }) }, coverage: coverage() };
  assert.equal(await buildFactsDigest(before), await buildFactsDigest(after));
});

test("buildFactsDigest: still changes when rowCounts or sourceAsOf change", async () => {
  // The exclusions above must not be over-broad: these two are statements about the data itself.
  const base = { domains: { costing: domain() }, coverage: coverage() };

  const movedRowCounts = {
    domains: { costing: domain({ rowCounts: { read: 4, included: 4, omitted: 0 } }) },
    coverage: coverage(),
  };
  assert.notEqual(await buildFactsDigest(base), await buildFactsDigest(movedRowCounts));

  const movedSourceAsOf = {
    domains: { costing: domain({ sourceAsOf: { state: "known", value: "2026-08-07T00:00:00.000Z", source: entered } }) },
    coverage: coverage(),
  };
  assert.notEqual(await buildFactsDigest(base), await buildFactsDigest(movedSourceAsOf));
});

test("buildFactsDigest: coverage.absent ordering is stable regardless of input order", async () => {
  // Guards the antisymmetric 3-way comparator: the same set listed in either order must digest
  // identically, or the digest's whole purpose is undermined.
  const forward = {
    domains: { costing: domain() },
    coverage: coverage({
      absent: [
        { domain: "brand" as DomainId, reason: "adapter not built yet" },
        { domain: "inventory" as DomainId, reason: "adapter not built yet" },
      ],
    }),
  };
  const reversed = {
    domains: { costing: domain() },
    coverage: coverage({
      absent: [
        { domain: "inventory" as DomainId, reason: "adapter not built yet" },
        { domain: "brand" as DomainId, reason: "adapter not built yet" },
      ],
    }),
  };

  assert.equal(await buildFactsDigest(forward), await buildFactsDigest(reversed));
});

test("buildFactsDigest: changes when coverage changes", async () => {
  const before = { domains: { costing: domain() }, coverage: coverage() };
  const after = { domains: { costing: domain() }, coverage: coverage({ present: ["costing", "inventory"] as DomainId[] }) };
  assert.notEqual(await buildFactsDigest(before), await buildFactsDigest(after));
});

test("buildSignalsDigest: is stable and covers both signal homes", async () => {
  const input = { domains: { readiness: domain({ domain: "readiness", signals: [signal()] }) }, signals: [] as Signal[] };
  assert.equal(await buildSignalsDigest(input), await buildSignalsDigest(input));

  // A cross-domain signal on the envelope moves the digest just as a domain-scoped one does.
  const withCrossDomain = {
    domains: input.domains,
    signals: [signal({ id: "costing.staleVsPurchases", domain: "cross-domain", scope: "cross-domain", severity: "warning" })],
  };
  assert.notEqual(await buildSignalsDigest(input), await buildSignalsDigest(withCrossDomain));
});

test("buildSignalsDigest: changes when a signal's status changes", async () => {
  const failing = { domains: { readiness: domain({ domain: "readiness", signals: [signal()] }) }, signals: [] as Signal[] };
  const passing = {
    domains: { readiness: domain({ domain: "readiness", signals: [signal({ status: "pass" })] }) },
    signals: [] as Signal[],
  };
  assert.notEqual(await buildSignalsDigest(failing), await buildSignalsDigest(passing));
});

test("the two digests are independent: signals moving leaves factsDigest byte-identical", async () => {
  // The property that keeps §6's invalidation rule honest -- tuning a rule must not read as
  // "the business changed", or grounded prior answers get discarded for no reason.
  const quiet = domain({ domain: "readiness", signals: [] });
  const noisy = domain({ domain: "readiness", signals: [signal()] });

  const factsBefore = await buildFactsDigest({ domains: { readiness: quiet }, coverage: coverage() });
  const factsAfter = await buildFactsDigest({ domains: { readiness: noisy }, coverage: coverage() });
  assert.equal(factsBefore, factsAfter, "signals must not participate in factsDigest");

  const signalsBefore = await buildSignalsDigest({ domains: { readiness: quiet }, signals: [] });
  const signalsAfter = await buildSignalsDigest({ domains: { readiness: noisy }, signals: [] });
  assert.notEqual(signalsBefore, signalsAfter, "signalsDigest must move when a signal appears");
});

test("both digests are sha256 hex", async () => {
  const facts = await buildFactsDigest({ domains: { costing: domain() }, coverage: coverage() });
  const signals = await buildSignalsDigest({ domains: { costing: domain() }, signals: [] });
  assert.match(facts, /^[0-9a-f]{64}$/);
  assert.match(signals, /^[0-9a-f]{64}$/);
});

test("neither digest can include generatedAt -- it is not part of either input", async () => {
  // Enforced by construction: neither function is given the field, so it cannot leak in. This test
  // pins that the signature stays that way.
  const before = await buildFactsDigest({ domains: { costing: domain() }, coverage: coverage() });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const after = await buildFactsDigest({ domains: { costing: domain() }, coverage: coverage() });
  assert.equal(before, after, "identical data at two different wall-clock moments must digest identically");
});
