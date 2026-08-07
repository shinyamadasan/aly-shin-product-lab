import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  COSTING_FRESHNESS_COMPOSER,
  COSTING_FRESHNESS_INPUT_DOMAINS,
  composeCostingFreshnessSignals,
} from "../src/lib/business-context/composers/costing-freshness.ts";
import { buildCostingDomainContext } from "../src/lib/business-context/adapters/costing.ts";
import { buildInventoryDomainContext } from "../src/lib/business-context/adapters/inventory.ts";
import { SIGNAL_IDS } from "../src/lib/business-context/types.ts";
import type { BuildEnv, DomainContext, DomainId } from "../src/lib/business-context/types.ts";
import type { CostingSummaryRow, IngredientRow, InventoryTransactionRow } from "../src/lib/supabase-mappers.ts";

const env: BuildEnv = { now: Date.parse("2026-08-09T02:00:00.000Z"), timezone: "Asia/Manila", businessDay: "2026-08-09", budgets: {} };

function costingRow(overrides: Partial<CostingSummaryRow> = {}): CostingSummaryRow {
  return {
    id: "costing-1", product_id: "brownies", batch_id: "batch-1",
    ingredient_cost: 200, packaging_cost: 20, labor_estimate: 100, utilities_estimate: 25,
    water_cost: 5, gas_cost: 10, oven_electric_cost: 8, refrigeration_cost: 2, coffee_equipment_cost: 0,
    waste_allowance: 15, overhead_cost: 30, equipment_cost: 10, suggested_price: 90,
    notes: "Costing yield: 8", created_at: "2026-08-02T00:00:00.000Z", updated_at: "2026-08-08T00:00:00.000Z",
    ...overrides,
  };
}

function ingredientRow(): IngredientRow {
  return {
    id: "ingredient-1", name: "Fresh Milk", base_unit: "ml", category: "ingredient",
    current_quantity: 1000, low_stock_threshold: 200, target_stock_quantity: 2000,
    nearest_expiration_date: null, average_unit_cost: 0.08, notes: null, is_active: true, archived_at: null,
    base_unit_migrated_from: null, base_unit_migrated_at: null, base_unit_migration_flagged_reason: null,
    created_at: "2026-08-01T00:00:00.000Z", updated_at: "2026-08-01T00:00:00.000Z",
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

function domains(costings: CostingSummaryRow[], transactions: InventoryTransactionRow[]): Partial<Record<DomainId, DomainContext>> {
  return {
    costing: buildCostingDomainContext({ costings, entries: [] }),
    inventory: buildInventoryDomainContext({ ingredients: [ingredientRow()], transactions }, env),
  };
}

test("composer: is pure -- the same finished domains twice produce identical signals", () => {
  const built = domains([costingRow()], [transactionRow()]);
  assert.deepEqual(composeCostingFreshnessSignals(built, env), composeCostingFreshnessSignals(built, env));
});

test("composer: does not mutate the domain contexts it is given", () => {
  const built = domains([costingRow()], [transactionRow()]);
  const before = JSON.stringify(built);
  composeCostingFreshnessSignals(built, env);
  assert.equal(JSON.stringify(built), before);
});

test("composer: every emitted signal uses the declared id, cross-domain scope, and a costing subject", () => {
  const signals = composeCostingFreshnessSignals(domains([costingRow()], [transactionRow()]), env);

  assert.equal(signals.length, 1);
  for (const signal of signals) {
    assert.ok((SIGNAL_IDS as readonly string[]).includes(signal.id));
    assert.equal(signal.id, "costing.staleVsPurchases");
    assert.equal(signal.scope, "cross-domain");
    assert.equal(signal.domain, "cross-domain");
    assert.equal(signal.subject?.kind, "costing");
    assert.equal(signal.severity, "warning");
  }
});

test("composer: provenance inputs span at least two domains", () => {
  const [signal] = composeCostingFreshnessSignals(domains([costingRow()], [transactionRow()]), env);
  const named = new Set(signal.provenance.inputs?.map((input) => input.split(".")[0]));

  assert.ok(named.size >= 2, "a cross-domain signal whose inputs sit in one domain belongs in that adapter");
  assert.deepEqual([...named].sort(), [...COSTING_FRESHNESS_INPUT_DOMAINS].sort());
  assert.equal(signal.provenance.computedBy, "buildCostingFreshnessSignals");
});

test("composer: emits one signal per costing", () => {
  const signals = composeCostingFreshnessSignals(
    domains([costingRow({ id: "costing-1" }), costingRow({ id: "costing-2" })], [transactionRow()]),
    env,
  );

  assert.equal(signals.length, 2);
  assert.deepEqual(signals.map((signal) => signal.subject?.id).sort(), ["costing-1", "costing-2"]);
  // No aggregate verdict across costings -- that would be a whole-business claim.
  assert.ok(!signals.some((signal) => signal.subject === undefined));
});

test("composer: emits nothing when there are no costings to evaluate", () => {
  assert.deepEqual(composeCostingFreshnessSignals(domains([], [transactionRow()]), env), []);
});

test("[static] the composer reads no rows, holds no client, and does no fuzzy ingredient matching", () => {
  const source = readFileSync(new URL("../src/lib/business-context/composers/costing-freshness.ts", import.meta.url), "utf8");
  const code = source.split(/\r?\n/).filter((line) => !line.trim().startsWith("//")).join("\n");

  // Business-wide by construction: no ingredient join, no fuzzy name matching, no supplier read.
  for (const forbidden of [/ingredient-matching/, /resolveIngredientReference/, /supabase/i, /\.from\(/, /ingredient_id/]) {
    assert.doesNotMatch(code, forbidden, "the composer must read finished facts only");
  }
  // No threshold: this is a direct timestamp comparison, so there is no number to tune.
  assert.doesNotMatch(code, /DAYS|threshold|budget/i);
});

test("composer: registration exposes an id and version alongside the pure function", () => {
  assert.equal(COSTING_FRESHNESS_COMPOSER.composerId, "costing-freshness");
  assert.equal(typeof COSTING_FRESHNESS_COMPOSER.version, "number");
  assert.equal(COSTING_FRESHNESS_COMPOSER.compose, composeCostingFreshnessSignals);
});
