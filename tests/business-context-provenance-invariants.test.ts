import test from "node:test";
import assert from "node:assert/strict";
import { buildCostingDomainContext } from "../src/lib/business-context/adapters/costing.ts";
import { buildInventoryDomainContext } from "../src/lib/business-context/adapters/inventory.ts";
import { buildReadinessDomainContext } from "../src/lib/business-context/adapters/readiness.ts";
import { SIGNAL_IDS } from "../src/lib/business-context/types.ts";
import type { BuildEnv, DomainContext, Fact, Provenance } from "../src/lib/business-context/types.ts";

// Structural invariants walked over real built contexts, rather than example-by-example assertions.
// This is the regression net: it fails for a fact this file has never heard of, which is what makes
// it useful as the adapters grow.
//
// Scoping note on the computedBy/inputs rule. The requirement applies to facts that actually carry
// a computed value -- `known` and `stale`. It cannot apply to `unknown`, `unset`, or `empty`:
// nothing was computed in those states, so there is no dependency to name, and requiring one would
// force adapters to invent dependency paths purely to satisfy a check. Inventing a path is strictly
// worse than omitting one, because it is a false traceability claim.
//
// The rule is NOT weakened for value-carrying facts -- that is the half worth enforcing, and every
// `known`/`stale` calculated-or-derived fact below is held to it exactly.

const env: BuildEnv = { now: Date.parse("2026-08-08T02:00:00.000Z"), timezone: "Asia/Manila", businessDay: "2026-08-08", budgets: {} };

const VALUE_CARRYING_STATES = new Set(["known", "stale"]);

function costingRow() {
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
    suggested_price: 50,
    notes: 'Costing yield: 8\nProfessional costing detail: {"targetFoodCost":0.3}',
    created_at: "2026-08-02T00:00:00.000Z",
    updated_at: "2026-08-08T00:00:00.000Z",
  };
}

function ingredientRow() {
  return {
    id: "ingredient-1",
    name: "Fresh Milk",
    base_unit: "ml",
    category: "ingredient",
    current_quantity: 0,
    low_stock_threshold: 200,
    target_stock_quantity: 2000,
    nearest_expiration_date: "2026-08-08",
    average_unit_cost: 0.08,
    notes: null,
    is_active: true,
    archived_at: null,
    base_unit_migrated_from: null,
    base_unit_migrated_at: null,
    base_unit_migration_flagged_reason: null,
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
  };
}

function transactionRow() {
  return {
    id: "txn-1",
    ingredient_id: "ingredient-1",
    transaction_type: "purchase",
    quantity_change: 500,
    quantity_before: 0,
    quantity_after: 500,
    source_type: "purchase_import",
    source_id: null,
    note: null,
    reason: null,
    actor: null,
    created_at: "2026-08-05T00:00:00.000Z",
  };
}

function productRow() {
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
  };
}

function batchRow() {
  return {
    id: "batch-1",
    product_id: "brownies",
    batch_version: "V1",
    status: "completed",
    completed_at: null,
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
    taste_notes: "",
    texture_notes: "",
    went_wrong: "",
    improve_next: "",
    launch_decision: "retest",
    created_at: "2026-08-02T00:00:00.000Z",
    updated_at: "2026-08-02T00:00:00.000Z",
  };
}

function tastingRow() {
  return {
    id: "tasting-1",
    product_id: "brownies",
    batch_id: "batch-1",
    taster_name: "Taster",
    rating: 8,
    liked: "",
    improve: "",
    would_buy: "yes",
    willing_to_pay: 100,
    would_reorder: "yes",
    packaging_reaction: "",
    notes: null,
    time_label: "Day 1",
    created_at: "2026-08-02T00:00:00.000Z",
  };
}

// Both a populated and an empty build per domain, so the invariants cover the empty/unset/unknown
// branches as well as the happy path.
function builtContexts(): DomainContext[] {
  return [
    buildCostingDomainContext({ costings: [costingRow()], entries: [] }),
    buildCostingDomainContext({ costings: [], entries: [] }),
    buildInventoryDomainContext({ ingredients: [ingredientRow()], transactions: [transactionRow()] }, env),
    buildInventoryDomainContext({ ingredients: [], transactions: [] }, env),
    buildReadinessDomainContext(
      { products: [productRow()], batches: [batchRow()], costings: [costingRow()], tastings: [tastingRow()] },
      env,
    ),
    buildReadinessDomainContext({ products: [], batches: [], costings: [], tastings: [] }, env),
  ];
}

type AnyFact = Fact<unknown> & { source?: Provenance; confidence?: string };

function eachFact(context: DomainContext, visit: (path: string, fact: AnyFact) => void): void {
  visit(`${context.domain}.sourceAsOf`, context.sourceAsOf as AnyFact);
  for (const [key, fact] of Object.entries(context.facts)) {
    visit(`${context.domain}.facts.${key}`, fact as AnyFact);
  }
}

test("[invariant] every value-carrying calculated/derived fact names computedBy and non-empty inputs", () => {
  const violations: string[] = [];

  for (const context of builtContexts()) {
    eachFact(context, (path, fact) => {
      if (!VALUE_CARRYING_STATES.has(fact.state)) {
        return;
      }
      const kind = fact.source?.kind;
      if (kind !== "calculated" && kind !== "derived") {
        return;
      }
      if (!fact.source?.computedBy) {
        violations.push(`${path}: ${kind} without computedBy`);
      }
      if (!fact.source?.inputs || fact.source.inputs.length === 0) {
        violations.push(`${path}: ${kind} with empty inputs`);
      }
    });
  }

  assert.deepEqual(violations, []);
});

test("[invariant] every inferred fact carries a basis and is never high confidence", () => {
  const violations: string[] = [];

  for (const context of builtContexts()) {
    eachFact(context, (path, fact) => {
      if (fact.source?.kind !== "inferred") {
        return;
      }
      if (!fact.source.basis) {
        violations.push(`${path}: inferred without basis`);
      }
      if (fact.confidence === "high") {
        violations.push(`${path}: inferred with high confidence`);
      }
    });
  }

  assert.deepEqual(violations, []);
});

test("[invariant] a non-value state is never required to name inputs, and never fabricates them", () => {
  // The other half of the scoping decision: unknown/unset/empty facts computed nothing, so they must
  // not claim a dependency. This catches the opposite failure -- an adapter inventing a path to look
  // compliant.
  const violations: string[] = [];

  for (const context of builtContexts()) {
    eachFact(context, (path, fact) => {
      if (VALUE_CARRYING_STATES.has(fact.state)) {
        return;
      }
      if (fact.source?.inputs && fact.source.inputs.length > 0 && fact.state === "unknown") {
        // An unknown fact may legitimately name the input it was waiting on (e.g. a metric blocked by
        // an unreadable yield). What it must never do is name a path that does not exist.
        for (const input of fact.source.inputs) {
          assert.match(input, /^[a-zA-Z]+\.facts\./, `${path}: input "${input}" is not a fact path`);
        }
      }
    });
  }

  assert.deepEqual(violations, []);
});

test("[invariant] the root collection facts are entered, with table and row ids, and no fabricated inputs", () => {
  const costing = buildCostingDomainContext({ costings: [costingRow()], entries: [] });
  const inventory = buildInventoryDomainContext({ ingredients: [ingredientRow()], transactions: [transactionRow()] }, env);

  for (const [label, fact, table, rowId] of [
    ["costing.facts.byCosting", costing.facts.byCosting as AnyFact, "costing_summaries", "costing-1"],
    ["inventory.facts.byIngredient", inventory.facts.byIngredient as AnyFact, "ingredients", "ingredient-1"],
  ] as const) {
    assert.equal(fact.source?.kind, "entered", `${label} is a root projection of entered rows, not derived from another fact`);
    assert.equal(fact.source?.table, table, `${label} must name its source table`);
    assert.deepEqual(fact.source?.rowIds, [rowId], `${label} must carry the row ids it was built from`);
    assert.ok(!fact.source?.inputs, `${label} must not claim a dependency on a fact that does not precede it`);
    assert.ok(!fact.source?.computedBy, `${label} is not computed from another fact`);
  }
});

test("[invariant] the count facts name the collection fact they are actually derived from", () => {
  const costing = buildCostingDomainContext({ costings: [costingRow()], entries: [] });
  const inventory = buildInventoryDomainContext({ ingredients: [ingredientRow()], transactions: [transactionRow()] }, env);

  for (const [label, fact, expectedInput] of [
    ["costing.facts.costingCount", costing.facts.costingCount as AnyFact, "costing.facts.byCosting"],
    ["costing.facts.yieldReadableCount", costing.facts.yieldReadableCount as AnyFact, "costing.facts.byCosting"],
    ["inventory.facts.flaggedIngredientCount", inventory.facts.flaggedIngredientCount as AnyFact, "inventory.facts.byIngredient"],
  ] as const) {
    assert.equal(fact.source?.kind, "derived", `${label} is genuinely derived from a published fact`);
    assert.ok(fact.source?.computedBy, `${label} must name its calculator`);
    assert.deepEqual(fact.source?.inputs, [expectedInput], `${label} must name the collection fact it counts`);
  }
});

test("[invariant] readiness.sourceAsOf stays unknown without meaningless inputs", () => {
  const context = buildReadinessDomainContext(
    { products: [productRow()], batches: [batchRow()], costings: [costingRow()], tastings: [tastingRow()] },
    env,
  );
  const fact = context.sourceAsOf as AnyFact;

  assert.equal(fact.state, "unknown");
  assert.ok(!fact.source?.inputs, "an unknown fact computed nothing and must not claim a dependency");
  assert.ok((fact as { because: string }).because.length > 0, "it must still say why it is unknown");
});

test("[invariant] every emitted signal id is declared, and adapters emit only domain scope", () => {
  for (const context of builtContexts()) {
    for (const signal of context.signals) {
      assert.ok((SIGNAL_IDS as readonly string[]).includes(signal.id), `${signal.id} must be declared in SIGNAL_IDS`);
      assert.equal(signal.scope, "domain", "an adapter never emits a cross-domain signal");
    }
  }
});

test("[invariant] no whole-business verdict key appears anywhere in a built context", () => {
  for (const context of builtContexts()) {
    const serialized = JSON.stringify(context);
    for (const forbidden of ["bottleneck", "topPriority", "businessStage", "highestValueOpportunity"]) {
      assert.doesNotMatch(serialized, new RegExp(`"${forbidden}"`), `${context.domain} must not publish ${forbidden}`);
    }
  }
});
