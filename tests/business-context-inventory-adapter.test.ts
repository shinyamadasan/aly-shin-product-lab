import test from "node:test";
import assert from "node:assert/strict";
import {
  buildInventoryDomainContext,
  buildInventoryDomainContextFromFailure,
  type InventoryRows,
  type IngredientSnapshot,
} from "../src/lib/business-context/adapters/inventory.ts";
import { SIGNAL_IDS } from "../src/lib/business-context/types.ts";
import type { BuildEnv, Fact } from "../src/lib/business-context/types.ts";
import type { IngredientRow, InventoryTransactionRow } from "../src/lib/supabase-mappers.ts";

const env: BuildEnv = { now: Date.parse("2026-08-08T02:00:00.000Z"), timezone: "Asia/Manila", businessDay: "2026-08-08", budgets: {} };

function ingredientRow(overrides: Partial<IngredientRow> = {}): IngredientRow {
  return {
    id: "ingredient-1",
    name: "Fresh Milk",
    base_unit: "ml",
    category: "ingredient",
    current_quantity: 1000,
    low_stock_threshold: 200,
    target_stock_quantity: 2000,
    nearest_expiration_date: null,
    average_unit_cost: 0.08,
    notes: null,
    is_active: true,
    archived_at: null,
    base_unit_migrated_from: null,
    base_unit_migrated_at: null,
    base_unit_migration_flagged_reason: null,
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

function transactionRow(overrides: Partial<InventoryTransactionRow> = {}): InventoryTransactionRow {
  return {
    id: "txn-1",
    ingredient_id: "ingredient-1",
    transaction_type: "purchase",
    quantity_change: 500,
    quantity_before: 500,
    quantity_after: 1000,
    source_type: "purchase_import",
    source_id: "import-1",
    note: null,
    reason: null,
    actor: null,
    created_at: "2026-08-05T00:00:00.000Z",
    ...overrides,
  };
}

function rows(overrides: Partial<InventoryRows> = {}): InventoryRows {
  return { ingredients: [ingredientRow()], transactions: [transactionRow()], ...overrides };
}

function snapshots(context: ReturnType<typeof buildInventoryDomainContext>): IngredientSnapshot[] {
  const fact = context.facts.byIngredient as Fact<IngredientSnapshot[]>;
  assert.equal(fact.state, "known");
  return (fact as { state: "known"; value: IngredientSnapshot[] }).value;
}

test("inventory adapter: a null average_unit_cost is unset; a real 0 is known(0)", () => {
  const [neverPriced] = snapshots(buildInventoryDomainContext(rows({ ingredients: [ingredientRow({ average_unit_cost: null })] }), env));
  assert.equal(neverPriced.averageUnitCost.state, "unset");

  const [free] = snapshots(buildInventoryDomainContext(rows({ ingredients: [ingredientRow({ average_unit_cost: 0 })] }), env));
  assert.equal(free.averageUnitCost.state, "known");
  assert.equal((free.averageUnitCost as { value: number }).value, 0);
});

test("inventory adapter: a real 0 current_quantity is known(0), and drives an out-of-stock signal", () => {
  const context = buildInventoryDomainContext(rows({ ingredients: [ingredientRow({ current_quantity: 0 })] }), env);
  const [snapshot] = snapshots(context);

  assert.equal(snapshot.currentQuantity.state, "known");
  assert.equal((snapshot.currentQuantity as { value: number }).value, 0);
  assert.equal((snapshot.stockStatus as { value: string }).value, "out");
  assert.ok(context.signals.some((signal) => signal.id === "inventory.outOfStock"));
});

test("inventory adapter: no expiration date makes expirationStatus unknown, never \"good\"", () => {
  // getExpirationStatus returns "none" for an absent date -- an absence, not a verdict.
  const [snapshot] = snapshots(buildInventoryDomainContext(rows({ ingredients: [ingredientRow({ nearest_expiration_date: null })] }), env));

  assert.equal(snapshot.nearestExpirationDate.state, "unset");
  assert.equal(snapshot.expirationStatus.state, "unknown");
  assert.doesNotMatch(JSON.stringify(snapshot.expirationStatus), /good|none/);
});

test("inventory adapter: expiration is anchored to the business day in the business timezone", () => {
  // 2026-08-08T02:00Z is 10:00 on 08-08 in Manila but still 08-07 in UTC. An ingredient expiring
  // 08-08 is "expires-today" on the Manila anchor -- the UTC answer would be a day out.
  const context = buildInventoryDomainContext(rows({ ingredients: [ingredientRow({ nearest_expiration_date: "2026-08-08" })] }), env);
  const [snapshot] = snapshots(context);

  assert.equal((snapshot.expirationStatus as { value: string }).value, "expires-today");
  assert.ok(context.notes.some((note) => note.includes("Asia/Manila")));
});

test("inventory adapter: a flagged ingredient produces a data-integrity signal and makes valuation unknown", () => {
  const context = buildInventoryDomainContext(
    rows({ ingredients: [ingredientRow({ base_unit_migration_flagged_reason: "unrecognized legacy base_unit" })] }),
    env,
  );

  const flaggedSignal = context.signals.find((signal) => signal.id === "inventory.flagged");
  assert.ok(flaggedSignal, "a flagged ingredient must be surfaced, never filtered out");
  assert.equal(flaggedSignal.subject?.kind, "ingredient");

  // Any total that includes an unknown-unit quantity is arithmetic over an unknown, not an estimate.
  assert.equal(context.facts.totalInventoryValue.state, "unknown");
  assert.equal((context.facts.flaggedIngredientCount as { value: number }).value, 1);
});

test("inventory adapter: totalInventoryValue is known when nothing is flagged", () => {
  const context = buildInventoryDomainContext(rows(), env);
  assert.equal(context.facts.totalInventoryValue.state, "known");
  assert.equal((context.facts.totalInventoryValue as { value: number }).value, 1000 * 0.08);
});

test("inventory adapter: latestPurchaseAt picks the newest purchase and ignores other ledger types", () => {
  const context = buildInventoryDomainContext(
    rows({
      transactions: [
        transactionRow({ id: "t1", created_at: "2026-08-05T00:00:00.000Z" }),
        transactionRow({ id: "t2", created_at: "2026-08-06T00:00:00.000Z" }),
        // Newer, but not a purchase -- consuming or adjusting stock says nothing about purchasing.
        transactionRow({ id: "t3", transaction_type: "consume", created_at: "2026-08-07T00:00:00.000Z" }),
        transactionRow({ id: "t4", transaction_type: "adjustment", created_at: "2026-08-07T12:00:00.000Z" }),
      ],
    }),
    env,
  );

  assert.equal(context.facts.latestPurchaseAt.state, "known");
  assert.equal((context.facts.latestPurchaseAt as { value: string }).value, "2026-08-06T00:00:00.000Z");
});

test("inventory adapter: a ledger with no purchases reports latestPurchaseAt as empty, never a fabricated date", () => {
  const context = buildInventoryDomainContext(rows({ transactions: [transactionRow({ transaction_type: "consume" })] }), env);
  assert.equal(context.facts.latestPurchaseAt.state, "empty");
  assert.ok(!("value" in context.facts.latestPurchaseAt));
});

test("inventory adapter: zero ingredients with a healthy read is empty; failures are unavailable / not_configured", () => {
  const empty = buildInventoryDomainContext(rows({ ingredients: [], transactions: [] }), env);
  assert.equal(empty.facts.byIngredient.state, "empty");
  assert.deepEqual(empty.readOutcome, { ok: true });

  assert.equal(buildInventoryDomainContextFromFailure({ ok: false, reason: "failed", message: "boom" }).facts.byIngredient.state, "unavailable");
  assert.equal(
    buildInventoryDomainContextFromFailure({ ok: false, reason: "missing-table", message: "no table" }).facts.byIngredient.state,
    "not_configured",
  );
});

test("inventory adapter: every signal is domain-scoped, has an ingredient subject, and a declared id", () => {
  const context = buildInventoryDomainContext(
    rows({
      ingredients: [
        ingredientRow({ id: "a", current_quantity: 0 }),
        ingredientRow({ id: "b", nearest_expiration_date: "2026-08-01" }),
        ingredientRow({ id: "c", base_unit_migration_flagged_reason: "bad unit" }),
      ],
    }),
    env,
  );

  assert.ok(context.signals.length >= 3);
  for (const signal of context.signals) {
    assert.equal(signal.scope, "domain");
    assert.equal(signal.domain, "inventory");
    assert.equal(signal.subject?.kind, "ingredient");
    assert.ok((SIGNAL_IDS as readonly string[]).includes(signal.id));
    assert.ok(signal.provenance.computedBy, "every derived signal must name its calculator");
  }
});

test("inventory adapter: publishes no cross-domain signal", () => {
  const context = buildInventoryDomainContext(rows(), env);
  assert.ok(context.signals.every((signal) => signal.scope === "domain"));
  assert.doesNotMatch(JSON.stringify(context), /staleVsPurchases/);
});

test("inventory adapter: import machinery, aliases, and ledger actors never appear", () => {
  const context = buildInventoryDomainContext(
    rows({ transactions: [transactionRow({ actor: "owner-name", note: "receipt 12345", source_id: "import-secret" })] }),
    env,
  );
  const serialized = JSON.stringify(context);

  assert.doesNotMatch(serialized, /owner-name/);
  assert.doesNotMatch(serialized, /receipt 12345/);
  assert.doesNotMatch(serialized, /import-secret/);
});

test("inventory adapter: is pure and reads no clock", () => {
  const input = rows();
  assert.deepEqual(buildInventoryDomainContext(input, env), buildInventoryDomainContext(input, env));
});
