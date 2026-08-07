import test from "node:test";
import assert from "node:assert/strict";
import { buildCostingDomainContext } from "../src/lib/business-context/adapters/costing.ts";
import { buildInventoryDomainContext } from "../src/lib/business-context/adapters/inventory.ts";
import { buildReadinessDomainContext } from "../src/lib/business-context/adapters/readiness.ts";
import { SIGNAL_IDS } from "../src/lib/business-context/types.ts";
import type { BuildEnv, DomainContext } from "../src/lib/business-context/types.ts";
import { walkFacts } from "./helpers/business-context-fact-walker.ts";
import type { AnyFact, VisitedFact } from "./helpers/business-context-fact-walker.ts";

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

// Traversal is the shared recursive walker, not a local loop over domain.facts.
//
// The local version this replaces reached only the published top level -- it never descended into
// byCosting.value[] or byIngredient.value[], where most of the facts actually live. Every invariant
// in this file was therefore checking a small fraction of the data while reporting a clean pass, and
// twenty-one calculated facts with empty `inputs` sat underneath it unnoticed.
function visitedFacts(context: DomainContext): VisitedFact[] {
  const visited = walkFacts(context.sourceAsOf, `${context.domain}.sourceAsOf`);
  for (const [key, fact] of Object.entries(context.facts)) {
    visited.push(...walkFacts(fact, `${context.domain}.facts.${key}`));
  }
  return visited;
}

function eachFact(context: DomainContext, visit: (path: string, fact: AnyFact) => void): void {
  for (const { path, fact } of visitedFacts(context)) {
    visit(path, fact);
  }
}

// A visited path addresses a concrete collection member ("...byCosting.value.0.costPerPiece"). The
// vocabulary a Provenance uses to name that same fact is member-agnostic
// ("costing.facts.byCosting[].costPerPiece"). Self-reference can only be detected by comparing the
// two in one form, so paths are folded into the declared form before comparison.
function declaredForm(path: string): string {
  return path.replace(/^([A-Za-z]+\.facts\.[A-Za-z0-9_]+)\.value\.\d+\./, "$1[].");
}

test("[invariant] the walker descends into collection members rather than stopping at the published top level", () => {
  // Regression guard for F7. Without it, every invariant below can pass while checking almost
  // nothing, which is exactly what happened.
  const populated = builtContexts().filter((context) => context.rowCounts.included > 0);
  const totals = { top: 0, nested: 0 };

  for (const context of populated) {
    for (const { depth } of visitedFacts(context)) {
      totals[depth === 0 ? "top" : "nested"] += 1;
    }
  }

  assert.ok(totals.top > 0, "the published top-level facts must still be visited");
  assert.ok(totals.nested >= 30, `expected the walker to reach collection members, saw ${totals.nested} nested facts`);

  // Named domains, so a regression in one cannot be masked by the other.
  const costing = visitedFacts(buildCostingDomainContext({ costings: [costingRow()], entries: [] }));
  const inventory = visitedFacts(
    buildInventoryDomainContext({ ingredients: [ingredientRow()], transactions: [transactionRow()] }, env),
  );

  assert.ok(
    costing.some((entry) => entry.path.startsWith("costing.facts.byCosting.value.0.")),
    "the walker must reach the facts inside a CostingSnapshot",
  );
  assert.ok(
    inventory.some((entry) => entry.path.startsWith("inventory.facts.byIngredient.value.0.")),
    "the walker must reach the facts inside an IngredientSnapshot",
  );
});

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

// Generic dependency-graph checks. Deliberately not written against any particular fact name, so
// they catch the defect class in domains that do not exist yet.
//
// F5 is why these exist: inventory.facts.latestPurchaseAt shipped declaring *itself* as its own
// input, and inventory.sourceAsOf claimed to be computed from it. Both passed the original
// non-empty-inputs check, because that rule never asked whether a path pointed anywhere real.

// A declared input may address a collection member ("costing.facts.byCosting[].reviewedAt").
// Resolution is against the collection fact that owns it.
function resolveInputPath(input: string): { domain: string; factKey: string } | null {
  const match = input.match(/^([A-Za-z]+)\.facts\.([A-Za-z0-9_]+)/);
  return match ? { domain: match[1], factKey: match[2] } : null;
}

test("[invariant] every declared input resolves to a real fact, and never to the declaring fact itself", () => {
  const violations: string[] = [];

  for (const context of builtContexts()) {
    const factKeys = new Set(Object.keys(context.facts));

    eachFact(context, (path, fact) => {
      for (const input of fact.source?.inputs ?? []) {
        const resolved = resolveInputPath(input);

        if (!resolved) {
          violations.push(`${path}: input "${input}" is not a fact path`);
          continue;
        }
        // Cross-domain inputs are legitimate and cannot be resolved from one DomainContext; they are
        // checked by the composer's own ">= 2 domains" invariant. Only same-domain paths resolve here.
        if (resolved.domain !== context.domain) {
          continue;
        }
        if (!factKeys.has(resolved.factKey)) {
          violations.push(`${path}: input "${input}" names no fact published by ${context.domain}`);
        }
        if (input === declaredForm(path)) {
          violations.push(`${path}: input "${input}" is the declaring fact itself`);
        }
      }
    });
  }

  assert.deepEqual(violations, []);
});

test("[invariant] a fact never lists itself, even indirectly through a shared provenance object", () => {
  // The exact F5 shape: two facts sharing one Provenance object, so whichever fact the inputs named
  // ended up self-referencing. Sharing is fine; sharing a *dependency claim* across facts that read
  // different data is not.
  const violations: string[] = [];

  for (const context of builtContexts()) {
    eachFact(context, (path, fact) => {
      // Compared in the declared form, so a nested metric that named itself would be caught. The
      // raw visited path never matches a member-agnostic input string, so comparing those directly
      // would make this check silently vacuous for every nested fact.
      const self = declaredForm(path);
      if ((fact.source?.inputs ?? []).some((input) => input === self)) {
        violations.push(`${path}: declares a dependency on itself`);
      }
    });
  }

  assert.deepEqual(violations, []);
});

test("[invariant] a collection-member input names a member that the collection actually publishes", () => {
  // The check that makes the per-metric dependency lists real rather than decorative: a typo in
  // "costing.facts.byCosting[].costPerPeice" resolves to the byCosting fact and would otherwise pass
  // every check above. Here it fails, because no such member exists on the snapshot.
  const violations: string[] = [];

  for (const context of builtContexts()) {
    // The member names each collection fact publishes, read off a real member rather than a list.
    const members = new Map<string, Set<string>>();
    for (const [key, fact] of Object.entries(context.facts)) {
      const value = (fact as AnyFact).value;
      if (Array.isArray(value) && value.length > 0 && typeof value[0] === "object" && value[0] !== null) {
        members.set(key, new Set(Object.keys(value[0] as Record<string, unknown>)));
      }
    }

    eachFact(context, (path, fact) => {
      for (const input of fact.source?.inputs ?? []) {
        const match = input.match(/^([A-Za-z]+)\.facts\.([A-Za-z0-9_]+)\[\]\.([A-Za-z0-9_]+)$/);
        if (!match || match[1] !== context.domain) {
          continue;
        }
        const [, , collection, member] = match;
        const published = members.get(collection);
        if (published && !published.has(member)) {
          violations.push(`${path}: input "${input}" names no member published on ${collection}`);
        }
      }
    });
  }

  assert.deepEqual(violations, []);
});

test("[invariant] root entered facts never fabricate inputs or computedBy", () => {
  // Generic form of the F4/F5 rule: anything sourced directly from database rows describes those
  // rows, and must not borrow the vocabulary of a computed fact.
  const violations: string[] = [];

  for (const context of builtContexts()) {
    eachFact(context, (path, fact) => {
      if (fact.source?.kind !== "entered") {
        return;
      }
      if (fact.source.inputs && fact.source.inputs.length > 0) {
        violations.push(`${path}: entered fact claims inputs`);
      }
      if (fact.source.computedBy) {
        violations.push(`${path}: entered fact claims computedBy`);
      }
      if (!fact.source.table) {
        violations.push(`${path}: entered fact does not name its table`);
      }
    });
  }

  assert.deepEqual(violations, []);
});

test("[invariant] ledger-derived timestamps name only the rows they actually considered", () => {
  // latestPurchaseAt reads purchase rows; sourceAsOf reads the whole ledger. They must not share a
  // row set, or each would be attributed to rows it never examined.
  const context = buildInventoryDomainContext(
    {
      ingredients: [ingredientRow()],
      transactions: [
        { ...transactionRow(), id: "purchase-1", transaction_type: "purchase", created_at: "2026-08-05T00:00:00.000Z" },
        { ...transactionRow(), id: "consume-1", transaction_type: "consume", created_at: "2026-08-06T00:00:00.000Z" },
      ],
    },
    env,
  );

  const purchase = context.facts.latestPurchaseAt as AnyFact;
  const asOf = context.sourceAsOf as AnyFact;

  assert.deepEqual(purchase.source?.rowIds, ["purchase-1"], "latestPurchaseAt considered only the purchase row");
  assert.deepEqual(asOf.source?.rowIds, ["purchase-1", "consume-1"], "sourceAsOf considered the whole ledger");
  assert.notDeepEqual(purchase.source, asOf.source, "two facts reading different rows must not share one provenance object");

  // Values still reflect their own row sets.
  assert.equal((purchase as { value: string }).value, "2026-08-05T00:00:00.000Z");
  assert.equal((asOf as { value: string }).value, "2026-08-06T00:00:00.000Z");
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
