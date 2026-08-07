import test from "node:test";
import assert from "node:assert/strict";
import { buildBusinessContext, type M1DomainReadResults } from "../src/lib/business-context/build.ts";
import { COSTING_FRESHNESS_COMPOSER } from "../src/lib/business-context/composers/costing-freshness.ts";
import { ADAPTER_NOT_BUILT_REASON, KNOWN_DOMAIN_IDS, M1_DOMAIN_IDS } from "../src/lib/business-context/registry.ts";
import { CONTEXT_SCHEMA_VERSION, DOMAIN_IDS } from "../src/lib/business-context/types.ts";
import type { BuildEnv, DomainId, Signal } from "../src/lib/business-context/types.ts";
import { getBlockers } from "../src/lib/business-context/selectors.ts";
import type { CostingSummaryRow, IngredientRow, InventoryTransactionRow, ProductBatchRow, ProductRow, TastingFeedbackRow } from "../src/lib/supabase-mappers.ts";

const env: BuildEnv = { now: Date.parse("2026-08-09T02:00:00.000Z"), timezone: "Asia/Manila", businessDay: "2026-08-09", budgets: {} };

const AFTER_BOUNDARY = "2026-08-08T00:00:00.000Z";
const BEFORE_BOUNDARY = "2026-08-01T00:00:00.000Z";

function costingRow(overrides: Partial<CostingSummaryRow> = {}): CostingSummaryRow {
  return {
    id: "costing-1", product_id: "brownies", batch_id: "batch-1",
    ingredient_cost: 200, packaging_cost: 20, labor_estimate: 100, utilities_estimate: 25,
    water_cost: 5, gas_cost: 10, oven_electric_cost: 8, refrigeration_cost: 2, coffee_equipment_cost: 0,
    waste_allowance: 15, overhead_cost: 30, equipment_cost: 10, suggested_price: 90,
    notes: "Costing yield: 8", created_at: "2026-08-02T00:00:00.000Z", updated_at: AFTER_BOUNDARY,
    ...overrides,
  };
}

function ingredientRow(overrides: Partial<IngredientRow> = {}): IngredientRow {
  return {
    id: "ingredient-1", name: "Fresh Milk", base_unit: "ml", category: "ingredient",
    current_quantity: 1000, low_stock_threshold: 200, target_stock_quantity: 2000,
    nearest_expiration_date: null, average_unit_cost: 0.08, notes: null, is_active: true, archived_at: null,
    base_unit_migrated_from: null, base_unit_migrated_at: null, base_unit_migration_flagged_reason: null,
    created_at: "2026-08-01T00:00:00.000Z", updated_at: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

function transactionRow(overrides: Partial<InventoryTransactionRow> = {}): InventoryTransactionRow {
  return {
    id: "txn-1", ingredient_id: "ingredient-1", transaction_type: "purchase",
    quantity_change: 500, quantity_before: 500, quantity_after: 1000,
    source_type: "purchase_import", source_id: null, note: null, reason: null, actor: null,
    created_at: "2026-08-05T00:00:00.000Z",
    ...overrides,
  };
}

function productRow(): ProductRow {
  return {
    id: "brownies", name: "Brownies", category: "Baked goods", product_role: "Hero candidate",
    status: "testing", description: "Dense fudgy brownies.", notes: null, main_photo_url: null,
    decision: "Needs proof", created_at: "2026-08-01T00:00:00.000Z", updated_at: "2026-08-01T00:00:00.000Z",
  };
}

function batchRow(): ProductBatchRow {
  return {
    id: "batch-1", product_id: "brownies", batch_version: "V1", status: "completed",
    completed_at: null, voided_at: null, void_reason: null, date_made: "2026-08-02",
    ingredients_notes: "{}", prep_start_time: null, prep_time_minutes: 20, bake_time_minutes: 30,
    cooling_time_minutes: 15, usable_pieces: 12, imperfect_pieces: 2, stress_level: 3,
    taste_notes: "", texture_notes: "", went_wrong: "", improve_next: "", launch_decision: "retest",
    created_at: "2026-08-02T00:00:00.000Z", updated_at: "2026-08-02T00:00:00.000Z",
  };
}

function tastingRow(): TastingFeedbackRow {
  return {
    id: "tasting-1", product_id: "brownies", batch_id: "batch-1", taster_name: "Taster",
    rating: 8, liked: "", improve: "", would_buy: "yes", willing_to_pay: 100, would_reorder: "yes",
    packaging_reaction: "", notes: null, time_label: "Day 1", created_at: "2026-08-02T00:00:00.000Z",
  };
}

// One realistic M1 fixture: a costed product with a proof batch, a tasting, an ingredient, and a
// purchase. Overrides let each test move exactly one thing.
function reads(overrides: Partial<M1DomainReadResults> = {}): M1DomainReadResults {
  return {
    costing: { ok: true, rows: { costings: [costingRow()], entries: [] } },
    inventory: { ok: true, rows: { ingredients: [ingredientRow()], transactions: [transactionRow()] } },
    readiness: { ok: true, rows: { products: [productRow()], batches: [batchRow()], costings: [costingRow()], tastings: [tastingRow()] } },
    ...overrides,
  };
}

function build(overrides: Partial<M1DomainReadResults> = {}, composers = [COSTING_FRESHNESS_COMPOSER.compose]) {
  return buildBusinessContext({ reads: reads(overrides), env, dataSource: "supabase", composers });
}

function freshnessSignals(signals: Signal[]): Signal[] {
  return signals.filter((signal) => signal.id === "costing.staleVsPurchases");
}

// --- Integration proof 1-3: the three domains build ----------------------------------------------

test("integration: Costing, Inventory, and Readiness all build into one envelope", async () => {
  const context = await build();

  for (const domain of M1_DOMAIN_IDS) {
    assert.ok(context.domains[domain], `${domain} must be present`);
    assert.deepEqual(context.domains[domain]?.readOutcome, { ok: true });
  }

  assert.equal(context.contextSchemaVersion, CONTEXT_SCHEMA_VERSION);
  assert.equal(context.timezone, "Asia/Manila");
  assert.equal(context.businessDay, "2026-08-09");
  assert.equal(context.dataSource, "supabase");
  assert.equal(context.generatedAt, new Date(env.now).toISOString());
});

// --- Integration proof 4: honest coverage --------------------------------------------------------

test("integration: coverage names all 14 known domains and lists the 11 unbuilt ones honestly", async () => {
  const context = await build();

  assert.deepEqual([...context.coverage.knownDomains], [...KNOWN_DOMAIN_IDS]);
  assert.equal(context.coverage.knownDomains.length, DOMAIN_IDS.length);
  assert.deepEqual([...context.coverage.present].sort(), ["costing", "inventory", "readiness"]);

  assert.equal(context.coverage.absent.length, 11);
  for (const entry of context.coverage.absent) {
    assert.equal(entry.reason, ADAPTER_NOT_BUILT_REASON);
  }

  // No domain may vanish: every known domain is either present or explicitly absent.
  for (const domain of KNOWN_DOMAIN_IDS as DomainId[]) {
    const accounted = context.coverage.present.includes(domain) || context.coverage.absent.some((entry) => entry.domain === domain);
    assert.ok(accounted, `${domain} must be either present or declared absent`);
  }
});

test("integration: a failed read degrades that domain without aborting the build", async () => {
  const context = await build({ inventory: { ok: false, reason: "failed", message: "connection reset" } });

  // The build still succeeds and the other two domains are intact.
  assert.deepEqual(context.domains.costing?.readOutcome, { ok: true });
  assert.deepEqual(context.domains.readiness?.readOutcome, { ok: true });

  // The failure is stated, not hidden, and never rendered as an empty business.
  assert.equal(context.domains.inventory?.readOutcome.ok, false);
  assert.equal(context.domains.inventory?.facts.byIngredient.state, "unavailable");
  assert.ok(!context.coverage.present.includes("inventory"));
  assert.ok(context.coverage.absent.some((entry) => entry.domain === "inventory" && entry.reason === "connection reset"));
});

test("integration: a missing table is not_configured, distinct from a failed read", async () => {
  const context = await build({ inventory: { ok: false, reason: "missing-table", message: "relation does not exist" } });
  assert.equal(context.domains.inventory?.facts.byIngredient.state, "not_configured");
});

// --- Integration proof 5-6: digests --------------------------------------------------------------

test("integration: factsDigest is stable across two builds of unchanged data", async () => {
  const first = await build();
  const second = await build();

  assert.equal(first.factsDigest, second.factsDigest);
  assert.equal(first.signalsDigest, second.signalsDigest);
  assert.match(first.factsDigest, /^[0-9a-f]{64}$/);
});

test("integration: generatedAt never enters either digest", async () => {
  const early = await buildBusinessContext({ reads: reads(), env, dataSource: "supabase", composers: [] });
  const later = await buildBusinessContext({
    reads: reads(),
    env: { ...env, now: env.now + 86_400_000 },
    dataSource: "supabase",
    composers: [],
  });

  assert.notEqual(early.generatedAt, later.generatedAt);
  assert.equal(early.factsDigest, later.factsDigest, "a different clock must not move factsDigest");
});

test("integration: signalsDigest covers both domain and composed signals", async () => {
  const withoutComposer = await build({}, []);
  const withComposer = await build();

  // Same facts either way -- only the interpretation changed.
  assert.equal(withoutComposer.factsDigest, withComposer.factsDigest, "adding a composed signal must not move factsDigest");
  assert.notEqual(withoutComposer.signalsDigest, withComposer.signalsDigest, "a composed signal must move signalsDigest");

  // A domain signal moves it too.
  const withDomainSignal = await build({
    inventory: { ok: true, rows: { ingredients: [ingredientRow({ current_quantity: 0 })], transactions: [transactionRow()] } },
  });
  assert.notEqual(withComposer.signalsDigest, withDomainSignal.signalsDigest);
});

// --- Integration proof 7: costing.staleVsPurchases -----------------------------------------------

test("integration: staleVsPurchases passes when a reliable review is at or after the latest purchase", async () => {
  // Reviewed 2026-08-08, purchased 2026-08-05.
  const context = await build();
  const [signal] = freshnessSignals(context.signals);

  assert.equal(signal.status, "pass");
  assert.equal(signal.scope, "cross-domain");
  assert.deepEqual(signal.subject, { kind: "costing", id: "costing-1" });
});

test("integration: staleVsPurchases fails when a reliable review predates the latest purchase", async () => {
  const context = await build({
    inventory: {
      ok: true,
      rows: { ingredients: [ingredientRow()], transactions: [transactionRow({ created_at: "2026-08-09T00:00:00.000Z" })] },
    },
  });
  const [signal] = freshnessSignals(context.signals);

  assert.equal(signal.status, "fail");
  assert.match(signal.message, /has not been reviewed since the latest recorded ingredient purchase/);
  // Reports only what the timestamps prove -- never that a number is wrong.
  for (const forbidden of [/wrong/i, /incorrect/i, /outdated/i, /should be/i]) {
    assert.doesNotMatch(signal.message, forbidden);
    assert.doesNotMatch(signal.recommendation, forbidden);
  }
});

test("integration: staleVsPurchases is insufficient_data when the review time is historically unreliable", async () => {
  const context = await build({
    costing: { ok: true, rows: { costings: [costingRow({ updated_at: BEFORE_BOUNDARY })], entries: [] } },
  });
  const [signal] = freshnessSignals(context.signals);

  assert.equal(signal.status, "insufficient_data");
  assert.match(signal.message, /cannot be determined reliably/);
  assert.match(signal.provenance.basis ?? "", /2026-08-07T18:32:04Z/);
});

test("integration: staleVsPurchases is insufficient_data when no purchase has ever been recorded", async () => {
  const context = await build({
    inventory: { ok: true, rows: { ingredients: [ingredientRow()], transactions: [] } },
  });
  const [signal] = freshnessSignals(context.signals);

  assert.equal(signal.status, "insufficient_data");
  assert.match(signal.message, /no recorded ingredient purchases/i);
});

test("integration: staleVsPurchases emits nothing when either domain is unavailable", async () => {
  // The gap is already visible in coverage.absent; a signal missing half its evidence is worse than
  // no signal.
  const noInventory = await build({ inventory: { ok: false, reason: "failed", message: "boom" } });
  assert.deepEqual(freshnessSignals(noInventory.signals), []);

  const noCosting = await build({ costing: { ok: false, reason: "failed", message: "boom" } });
  assert.deepEqual(freshnessSignals(noCosting.signals), []);
});

test("integration: the composed signal spans two domains and lands only on the envelope", async () => {
  const context = await build();
  const [signal] = freshnessSignals(context.signals);

  const domainsNamed = new Set(signal.provenance.inputs?.map((input) => input.split(".")[0]));
  assert.deepEqual([...domainsNamed].sort(), ["costing", "inventory"]);

  // One signal, one home: cross-domain output never appears inside a DomainContext.
  for (const domain of M1_DOMAIN_IDS) {
    assert.ok(context.domains[domain]?.signals.every((entry) => entry.scope === "domain"));
  }
});

// --- Integration proof 8: getBlockers over a real envelope ---------------------------------------

test("integration: getBlockers returns existing signal references from a real built context", async () => {
  const context = await build({
    inventory: { ok: true, rows: { ingredients: [ingredientRow({ current_quantity: 0 })], transactions: [transactionRow()] } },
  });

  const blockers = getBlockers(context);
  assert.ok(blockers.length > 0);

  // References, not copies -- every blocker is the same object the context holds.
  const inContext = [
    ...Object.values(context.domains).flatMap((domain) => domain?.signals ?? []),
    ...context.signals,
  ];
  for (const blocker of blockers) {
    assert.ok(inContext.some((signal) => signal === blocker), "getBlockers must return references into the context");
    assert.equal(blocker.severity, "blocker");
    assert.equal(blocker.status, "fail");
  }

  // The freshness signal is a warning, so it is correctly excluded.
  assert.ok(!blockers.some((signal) => signal.id === "costing.staleVsPurchases"));
});

test("integration: an empty business builds a complete, honest envelope rather than failing", async () => {
  const context = await buildBusinessContext({
    reads: {
      costing: { ok: true, rows: { costings: [], entries: [] } },
      inventory: { ok: true, rows: { ingredients: [], transactions: [] } },
      readiness: { ok: true, rows: { products: [], batches: [], costings: [], tastings: [] } },
    },
    env,
    dataSource: "sample",
    composers: [COSTING_FRESHNESS_COMPOSER.compose],
  });

  assert.equal(context.domains.costing?.facts.byCosting.state, "empty");
  assert.equal(context.domains.inventory?.facts.byIngredient.state, "empty");
  assert.deepEqual(context.signals, [], "no costings means nothing to compare");
  assert.deepEqual(getBlockers(context), []);
  assert.equal(context.coverage.present.length, 3);
});
