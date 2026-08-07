import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  COSTING_UPDATED_AT_RELIABLE_FROM,
  CONTEXT_SCHEMA_VERSION,
  DOMAIN_IDS,
  SIGNAL_IDS,
} from "../src/lib/business-context/types.ts";

test("SIGNAL_IDS has no duplicates", () => {
  assert.equal(new Set(SIGNAL_IDS).size, SIGNAL_IDS.length);
});

test("SIGNAL_IDS declares every Rule Engine id, sourced from the rule modules themselves", () => {
  // Not a hand-maintained list: the expectation is extracted from the engine's own source, so a
  // rule added later fails this test rather than silently emitting an id outside the vocabulary.
  const ruleSources = ["development", "financial", "launch", "production", "quality", "supply"]
    .map((name) => readFileSync(new URL(`../src/lib/rule-engine/${name}.ts`, import.meta.url), "utf8"))
    .join("\n");

  const declaredInEngine = [...new Set(ruleSources.match(/"(?:FIN|PROD|DEV|QUAL|SUP|LAUNCH)-\d{3}"/g) ?? [])]
    .map((quoted) => quoted.slice(1, -1))
    .sort();

  assert.ok(declaredInEngine.length > 0, "no rule ids found -- test fixture is stale");

  const missing = declaredInEngine.filter((id) => !(SIGNAL_IDS as readonly string[]).includes(id));
  assert.deepEqual(missing, [], "every Rule Engine id must be in SIGNAL_IDS before an adapter can emit it");
});

test("SIGNAL_IDS declares the domain-scoped and cross-domain ids M1 emits", () => {
  // Declared up front in S2 precisely so the adapters never edit this array and therefore never
  // collide with each other.
  for (const id of ["inventory.outOfStock", "inventory.expiring", "inventory.flagged", "costing.staleVsPurchases"]) {
    assert.ok((SIGNAL_IDS as readonly string[]).includes(id), `${id} must be declared in SIGNAL_IDS`);
  }
});

test("DOMAIN_IDS covers all fourteen designed domains, with no duplicates", () => {
  assert.equal(DOMAIN_IDS.length, 14);
  assert.equal(new Set(DOMAIN_IDS).size, 14);
  // The three M1 adapters build these; the other eleven are declared absent by the envelope.
  for (const domain of ["costing", "inventory", "readiness"]) {
    assert.ok((DOMAIN_IDS as readonly string[]).includes(domain));
  }
});

test("COSTING_UPDATED_AT_RELIABLE_FROM is the recorded production-live instant, exactly", () => {
  // Must be the moment the PR0 deployment went live -- deliberately not the GitHub merge time
  // (2026-08-07T18:31:23Z) and not the Vercel build-start time (2026-08-07T18:31:26.228Z).
  assert.equal(COSTING_UPDATED_AT_RELIABLE_FROM, "2026-08-07T18:32:04Z");

  assert.notEqual(COSTING_UPDATED_AT_RELIABLE_FROM, "2026-08-07T18:31:23Z");
  assert.notEqual(COSTING_UPDATED_AT_RELIABLE_FROM, "2026-08-07T18:31:26.228Z");
});

test("COSTING_UPDATED_AT_RELIABLE_FROM parses as a real UTC instant", () => {
  const parsed = Date.parse(COSTING_UPDATED_AT_RELIABLE_FROM);
  assert.ok(Number.isFinite(parsed));
  assert.match(COSTING_UPDATED_AT_RELIABLE_FROM, /Z$/);
  // An absolute instant, never localised: this is a database audit boundary, not a business day.
  assert.equal(new Date(parsed).toISOString(), "2026-08-07T18:32:04.000Z");
});

test("COSTING_UPDATED_AT_RELIABLE_FROM orders correctly against pre- and post-boundary rows", () => {
  // The comparison a later slice performs: at-or-after is reliable, before is not evidence of
  // review. Pinning the ordering here means a mistyped constant fails loudly.
  const boundary = Date.parse(COSTING_UPDATED_AT_RELIABLE_FROM);

  assert.ok(Date.parse("2026-08-07T18:32:04Z") >= boundary, "the boundary itself counts as reliable");
  assert.ok(Date.parse("2026-08-08T00:00:00Z") >= boundary, "a later save is reliable");
  assert.ok(Date.parse("2026-08-07T18:32:03Z") < boundary, "one second earlier is not");
  assert.ok(Date.parse("2026-08-01T00:00:00Z") < boundary, "a historical row is not");
});

test("CONTEXT_SCHEMA_VERSION starts at 1", () => {
  assert.equal(CONTEXT_SCHEMA_VERSION, 1);
});

test("[static] the type module imports no node builtins, so it bundles for the browser", () => {
  // sha256Hex is crypto.subtle-based for exactly this reason; a node:crypto import anywhere in this
  // subtree would break the browser bundle.
  for (const relative of ["src/lib/business-context/types.ts", "src/lib/business-context/digest.ts", "src/lib/business-day.ts"]) {
    const source = readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /from "node:/, `${relative} must not import a node builtin`);
  }
});
