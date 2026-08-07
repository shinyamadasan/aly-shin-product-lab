import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getBlockers } from "../src/lib/business-context/selectors.ts";
import type { BusinessContext, DomainContext, DomainId, Signal } from "../src/lib/business-context/types.ts";

// Testable against a hand-built context: the selector depends only on the shape, not on any adapter
// or the envelope builder existing.

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

function domain(signals: Signal[], domainId: DomainId = "readiness"): DomainContext {
  return {
    domain: domainId,
    adapterVersion: 1,
    readOutcome: { ok: true },
    sourceAsOf: { state: "known", value: "2026-08-06T00:00:00.000Z", source: { kind: "entered" } },
    rowCounts: { read: 1, included: 1, omitted: 0 },
    facts: {},
    signals,
    notes: [],
  };
}

function context(overrides: Partial<BusinessContext> = {}): BusinessContext {
  return {
    contextSchemaVersion: 1,
    generatedAt: "2026-08-06T09:00:00.000Z",
    timezone: "Asia/Manila",
    businessDay: "2026-08-06",
    dataSource: "supabase",
    coverage: { knownDomains: [], present: [], absent: [] },
    domains: {},
    signals: [],
    factsDigest: "f".repeat(64),
    signalsDigest: "5".repeat(64),
    ...overrides,
  };
}

test("getBlockers: returns failing blocker-severity signals", () => {
  const blocker = signal();
  const result = getBlockers(context({ domains: { readiness: domain([blocker]) } }));
  assert.equal(result.length, 1);
  assert.equal(result[0].id, "FIN-001");
});

test("getBlockers: returns references, not copies", () => {
  // The property that makes selectors a safe replacement for a summary object: there is no
  // parallel copy that can drift from the context it came from.
  const blocker = signal();
  const result = getBlockers(context({ domains: { readiness: domain([blocker]) } }));
  assert.strictEqual(result[0], blocker);
});

test("getBlockers: draws from both homes -- domain signals and cross-domain signals", () => {
  const domainBlocker = signal({ id: "DEV-001" });
  const crossDomainBlocker = signal({
    id: "costing.staleVsPurchases",
    domain: "cross-domain",
    scope: "cross-domain",
  });

  const result = getBlockers(
    context({ domains: { readiness: domain([domainBlocker]) }, signals: [crossDomainBlocker] }),
  );

  assert.equal(result.length, 2);
  assert.strictEqual(result[0], domainBlocker);
  assert.strictEqual(result[1], crossDomainBlocker);
});

test("getBlockers: collects across multiple domains", () => {
  const first = signal({ id: "FIN-001" });
  const second = signal({ id: "inventory.outOfStock", domain: "inventory" });

  const result = getBlockers(
    context({ domains: { readiness: domain([first]), inventory: domain([second], "inventory") } }),
  );

  assert.equal(result.length, 2);
  assert.deepEqual(result.map((entry) => entry.id).sort(), ["FIN-001", "inventory.outOfStock"]);
});

test("getBlockers: an empty context returns an empty array", () => {
  assert.deepEqual(getBlockers(context()), []);
});

test("getBlockers: warnings and infos are excluded", () => {
  const result = getBlockers(
    context({
      domains: {
        readiness: domain([
          signal({ severity: "warning" }),
          signal({ severity: "info" }),
        ]),
      },
    }),
  );
  assert.deepEqual(result, []);
});

test("getBlockers: a passing blocker-severity signal is excluded", () => {
  const result = getBlockers(context({ domains: { readiness: domain([signal({ status: "pass" })]) } }));
  assert.deepEqual(result, []);
});

test("getBlockers: a blocker with status insufficient_data is NOT returned", () => {
  // "We could not evaluate this" is not "we found a failure". Returning it would turn milestone
  // scope or missing data into an apparent business problem -- the exact laundering the
  // architecture forbids.
  const result = getBlockers(
    context({ domains: { readiness: domain([signal({ status: "insufficient_data" })]) } }),
  );
  assert.deepEqual(result, []);
});

test("getBlockers: is pure -- two calls on the same context agree, and the context is unmutated", () => {
  const blocker = signal();
  const built = context({ domains: { readiness: domain([blocker]) }, signals: [] });

  const first = getBlockers(built);
  const second = getBlockers(built);

  assert.deepEqual(first, second);
  assert.equal(built.domains.readiness?.signals.length, 1);
  assert.equal(built.signals.length, 0);
});

test("getBlockers: does not sort -- ranking is a view concern with a named comparator", () => {
  // Deliberately asserted: a selector that quietly sorted would be an unversioned ranking, which is
  // how a defensible sort order gets mistaken for an analytical claim.
  const first = signal({ id: "SUP-001" });
  const second = signal({ id: "DEV-001" });
  const result = getBlockers(context({ domains: { readiness: domain([first, second]) } }));

  assert.strictEqual(result[0], first);
  assert.strictEqual(result[1], second);
});

test("[static] getBlockers is the only export, and no BusinessState appears under any name", () => {
  const source = readFileSync(new URL("../src/lib/business-context/selectors.ts", import.meta.url), "utf8");

  const exported = [...source.matchAll(/^export (?:function|const|type|interface) (\w+)/gm)].map((match) => match[1]);
  assert.deepEqual(exported, ["getBlockers"], "M1 ships exactly one selector");

  for (const forbidden of [/BusinessState/, /businessStage/, /currentBottleneck/, /topPriority/, /highestValueOpportunity/]) {
    assert.doesNotMatch(source.replace(/^\/\/.*$/gm, ""), forbidden, "no whole-business verdict may appear in a selector");
  }
});
