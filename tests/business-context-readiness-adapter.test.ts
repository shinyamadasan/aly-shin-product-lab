import test from "node:test";
import assert from "node:assert/strict";
import {
  buildReadinessDomainContext,
  buildReadinessDomainContextFromFailure,
  type ReadinessRows,
} from "../src/lib/business-context/adapters/readiness.ts";
import { SIGNAL_IDS } from "../src/lib/business-context/types.ts";
import type { BuildEnv } from "../src/lib/business-context/types.ts";
import type { CostingSummaryRow, ProductBatchRow, ProductRow, TastingFeedbackRow } from "../src/lib/supabase-mappers.ts";

const env: BuildEnv = { now: Date.parse("2026-08-08T02:00:00.000Z"), timezone: "Asia/Manila", businessDay: "2026-08-08", budgets: {} };

function productRow(overrides: Partial<ProductRow> = {}): ProductRow {
  return {
    id: "brownies",
    name: "Brownies",
    category: "Baked goods",
    product_role: "Hero candidate",
    status: "testing",
    description: "Dense fudgy brownies.",
    notes: null,
    main_photo_url: null,
    decision: "Needs proof",
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

function batchRow(overrides: Partial<ProductBatchRow> = {}): ProductBatchRow {
  return {
    id: "batch-1",
    product_id: "brownies",
    batch_version: "V1",
    status: "completed",
    completed_at: "2026-08-02T00:00:00.000Z",
    voided_at: null,
    void_reason: null,
    date_made: "2026-08-02",
    ingredients_notes: "{}",
    prep_start_time: null,
    prep_time_minutes: 20,
    bake_time_minutes: 30,
    cooling_time_minutes: 15,
    usable_pieces: 12,
    imperfect_pieces: 2,
    stress_level: 3,
    taste_notes: "good",
    texture_notes: "fudgy",
    went_wrong: "",
    improve_next: "",
    launch_decision: "retest",
    created_at: "2026-08-02T00:00:00.000Z",
    updated_at: "2026-08-02T00:00:00.000Z",
    ...overrides,
  };
}

function costingRow(overrides: Partial<CostingSummaryRow> = {}): CostingSummaryRow {
  return {
    id: "costing-1",
    product_id: "brownies",
    batch_id: "batch-1",
    ingredient_cost: 200,
    packaging_cost: 20,
    labor_estimate: 100,
    utilities_estimate: 25,
    water_cost: 5,
    gas_cost: 10,
    oven_electric_cost: 8,
    refrigeration_cost: 2,
    coffee_equipment_cost: 0,
    waste_allowance: 15,
    overhead_cost: 30,
    equipment_cost: 10,
    suggested_price: 90,
    notes: "Costing yield: 8",
    created_at: "2026-08-02T00:00:00.000Z",
    updated_at: "2026-08-08T00:00:00.000Z",
    ...overrides,
  };
}

function tastingRow(overrides: Partial<TastingFeedbackRow> = {}): TastingFeedbackRow {
  return {
    id: "tasting-1",
    product_id: "brownies",
    batch_id: "batch-1",
    taster_name: "Taster",
    rating: 8,
    liked: "rich",
    improve: "less sweet",
    would_buy: "yes",
    willing_to_pay: 100,
    would_reorder: "yes",
    packaging_reaction: "nice",
    notes: null,
    time_label: "Day 1",
    created_at: "2026-08-02T00:00:00.000Z",
    ...overrides,
  };
}

function rows(overrides: Partial<ReadinessRows> = {}): ReadinessRows {
  return { products: [productRow()], batches: [batchRow()], costings: [costingRow()], tastings: [tastingRow()], ...overrides };
}

test("readiness adapter: facts is empty by design, in every state", () => {
  // The invariant that makes the duplicated costing_summaries read safe: this domain publishes no
  // facts, so there is no second source of truth for anything the Costing adapter owns.
  assert.deepEqual(buildReadinessDomainContext(rows(), env).facts, {});
  assert.deepEqual(buildReadinessDomainContext(rows({ products: [] }), env).facts, {});
  assert.deepEqual(buildReadinessDomainContextFromFailure({ ok: false, reason: "failed", message: "boom" }).facts, {});
  assert.deepEqual(buildReadinessDomainContextFromFailure({ ok: false, reason: "missing-table", message: "gone" }).facts, {});
});

test("readiness adapter: publishes signals and reuses evaluateProduct rather than recomputing", () => {
  const context = buildReadinessDomainContext(rows(), env);
  assert.ok(context.signals.length > 0);
  for (const signal of context.signals) {
    assert.equal(signal.provenance.computedBy, "evaluateProduct");
  }
});

test("readiness adapter: maps passed true/false/null onto pass/fail/insufficient_data", () => {
  // A product with no batches at all produces DEV blockers (fail) and, because several rules cannot
  // be evaluated without data, insufficient_data results too.
  const context = buildReadinessDomainContext(rows({ batches: [], costings: [], tastings: [] }), env);
  const statuses = new Set(context.signals.map((signal) => signal.status));

  assert.ok(statuses.has("fail"), "a product with no batches must produce failures");
  assert.ok(statuses.has("insufficient_data"), "unevaluable rules must be insufficient_data, never a guessed pass");
  for (const signal of context.signals) {
    assert.ok(["pass", "fail", "insufficient_data"].includes(signal.status));
  }
});

test("readiness adapter: every signal is domain-scoped with a product subject and a declared id", () => {
  const context = buildReadinessDomainContext(rows(), env);

  for (const signal of context.signals) {
    assert.equal(signal.scope, "domain");
    assert.equal(signal.domain, "readiness");
    assert.deepEqual(signal.subject, { kind: "product", id: "brownies" });
    assert.ok((SIGNAL_IDS as readonly string[]).includes(signal.id), `${signal.id} must be declared in SIGNAL_IDS`);
  }
});

test("readiness adapter: rule ids are preserved verbatim", () => {
  const context = buildReadinessDomainContext(rows(), env);
  const ids = context.signals.map((signal) => signal.id);
  assert.ok(ids.some((id) => id.startsWith("FIN-")));
  assert.ok(ids.some((id) => id.startsWith("QUAL-")));
});

test("readiness adapter: free-text QUAL rules carry inferred provenance with a basis, never high confidence", () => {
  const context = buildReadinessDomainContext(rows(), env);
  const freeText = context.signals.filter((signal) => ["QUAL-001", "QUAL-002", "QUAL-003", "QUAL-005"].includes(signal.id));

  assert.ok(freeText.length > 0, "the free-text quality rules must be present");
  for (const signal of freeText) {
    assert.equal(signal.provenance.kind, "inferred");
    assert.ok(signal.provenance.basis && signal.provenance.basis.length > 0);
    assert.match(signal.provenance.basis, /keyword search/);
  }

  // Arithmetic and presence checks are derived, not inferred -- the distinction is the point.
  const financial = context.signals.find((signal) => signal.id === "FIN-001");
  assert.ok(financial);
  assert.equal(financial.provenance.kind, "derived");
});

test("readiness adapter: Supply results are insufficient_data, disclosed as milestone scope not a business finding", () => {
  const context = buildReadinessDomainContext(rows(), env);
  const supply = context.signals.filter((signal) => signal.id.startsWith("SUP-"));

  assert.ok(supply.length > 0);
  for (const signal of supply) {
    assert.equal(signal.status, "insufficient_data", "Supply rules must never report a pass on an empty supplies context");
  }

  const note = context.notes.find((entry) => entry.includes("Supplies domain is not part of this milestone"));
  assert.ok(note, "the milestone-scope cause must be stated in plain language");
  assert.match(note, /not because the business lacks purchase history/);
});

test("readiness adapter: launch composite gates are not evaluated", () => {
  const context = buildReadinessDomainContext(rows(), env);
  assert.equal(context.signals.filter((signal) => signal.id.startsWith("LAUNCH-")).length, 0);
});

test("readiness adapter: now is injected -- the same rows at two clocks stay reproducible", () => {
  const input = rows();
  const early = buildReadinessDomainContext(input, { ...env, now: Date.parse("2026-08-08T02:00:00.000Z") });
  const late = buildReadinessDomainContext(input, { ...env, now: Date.parse("2027-08-08T02:00:00.000Z") });

  // Each build is internally consistent; the engine reads env.now rather than a wall clock.
  assert.deepEqual(buildReadinessDomainContext(input, env), early);
  assert.equal(early.signals.length, late.signals.length);
});

test("readiness adapter: sourceAsOf is unknown -- a derived domain owns no source rows", () => {
  const context = buildReadinessDomainContext(rows(), env);
  assert.equal(context.sourceAsOf.state, "unknown");
});

test("readiness adapter: multiple products each get their own subject", () => {
  const context = buildReadinessDomainContext(
    rows({ products: [productRow({ id: "brownies" }), productRow({ id: "cookies", name: "Cookies" })] }),
    env,
  );

  const subjects = new Set(context.signals.map((signal) => signal.subject?.id));
  assert.deepEqual([...subjects].sort(), ["brownies", "cookies"]);
});

test("readiness adapter: signal provenance never names a non-existent fact path (F6 regression)", () => {
  // Provenance.inputs names fact paths, and this domain publishes no facts -- so a Readiness signal
  // has no fact to name. It previously declared inputs: ["readiness.signals"], which pointed at the
  // signal array the signal itself lives in and resolved to nothing. Omitting inputs is honest;
  // inventing a path is not. Same shape as F5's self-referential ledger provenance.
  const context = buildReadinessDomainContext(rows(), env);
  const factNames = new Set(Object.keys(context.facts));

  assert.ok(context.signals.length > 0, "the fixture must produce signals or this proves nothing");

  for (const signal of context.signals) {
    const inputs = signal.provenance.inputs ?? [];

    assert.ok(!inputs.includes("readiness.signals"), `${signal.id} still declares the fabricated readiness.signals input`);

    // If a future change does add inputs, every one must resolve to a fact this domain publishes.
    for (const input of inputs) {
      const match = input.match(/^readiness\.facts\.([A-Za-z0-9_]+)/);
      assert.ok(match, `${signal.id}: input "${input}" is not a fact path`);
      assert.ok(factNames.has(match[1]), `${signal.id}: input "${input}" names no fact published by readiness`);
    }

    // Traceability is preserved without the invented path.
    assert.equal(signal.provenance.computedBy, "evaluateProduct");
    assert.deepEqual(signal.provenance.rowIds, ["brownies"]);
  }

  // And the reason there is nothing to name: this domain still publishes no facts.
  assert.deepEqual(context.facts, {});
});

test("readiness adapter: is pure -- same rows and env produce identical output", () => {
  const input = rows();
  assert.deepEqual(buildReadinessDomainContext(input, env), buildReadinessDomainContext(input, env));
});
