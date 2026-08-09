// Runtime v1 (PR-1): the live read edge and the orchestrator.
//
// Everything below the reads is already proven by the M1 suite -- adapters, registry, composer,
// digests, coverage, provenance invariants -- and none of it is re-tested here. What is new, and
// therefore what these tests are about, is narrow: do the readers return the exact raw rows the
// adapters expect, do they stay honest when a read fails, and does the orchestrator assemble one
// snapshot from one clock without interpreting anything.
//
// Hand-built stub clients, no mocking library and no DOM harness -- the convention
// tests/orders-repository.test.ts already established.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { readCosting, readInventory, readReadiness, readSelling, type BusinessContextReadClient } from "../src/lib/business-context/readers/supabase.ts";
import { buildCurrentBusinessContext, resolveRuntimeEnv } from "../src/lib/business-context/runtime.ts";
import { BUSINESS_TIMEZONE, resolveBusinessDay } from "../src/lib/business-day.ts";
import { COSTING_FRESHNESS_COMPOSER_ID } from "../src/lib/business-context/composers/costing-freshness.ts";
import { COSTING_UPDATED_AT_RELIABLE_FROM } from "../src/lib/business-context/types.ts";
import type { BuildEnv, DomainId } from "../src/lib/business-context/types.ts";

// 2026-08-09T06:00:00Z is 14:00 in Manila -- comfortably mid-day, so the business day is unambiguous
// and this file's expectations do not sit on a rollover boundary.
const NOW_MS = Date.parse("2026-08-09T06:00:00.000Z");
const ENV: BuildEnv = { now: NOW_MS, timezone: BUSINESS_TIMEZONE, businessDay: "2026-08-09", budgets: {} };

const READERS_SOURCE = readFileSync(new URL("../src/lib/business-context/readers/supabase.ts", import.meta.url), "utf8");
const RUNTIME_SOURCE = readFileSync(new URL("../src/lib/business-context/runtime.ts", import.meta.url), "utf8");

// Static scans below are about CODE, not prose. Every one of these files documents in comments the
// very things the scans forbid ("insert/update/upsert/delete/rpc are not absent by convention..."),
// so scanning raw text would assert the opposite of what is meant.
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

const READERS_CODE = withoutComments(READERS_SOURCE);
const RUNTIME_CODE = withoutComments(RUNTIME_SOURCE);

// --- Stub client ---------------------------------------------------------------------------------

type StubError = { code?: string; message: string };

type StubOptions = {
  // Rows keyed by table name. A table with no entry reads as a successful empty table.
  rows?: Record<string, Record<string, unknown>[]>;
  // Errors keyed by table name.
  errors?: Record<string, StubError>;
  // Forces the driver's `data: null, error: null` shape, which is the successful-no-rows case.
  nullData?: boolean;
};

type Stub = {
  client: BusinessContextReadClient;
  tablesRead: string[];
  ordersApplied: Record<string, string[]>;
};

// Every write method throws. That is the behavioural half of the read-only proof: if any reader ever
// reaches for one, the test fails loudly rather than silently permitting a write path.
function createStub(options: StubOptions = {}): Stub {
  const tablesRead: string[] = [];
  const ordersApplied: Record<string, string[]> = {};

  function forbidden(name: string) {
    return () => {
      throw new Error(`Business Context readers must never call ${name}()`);
    };
  }

  const client = {
    from(table: string) {
      tablesRead.push(table);
      ordersApplied[table] = ordersApplied[table] ?? [];

      const error = options.errors?.[table] ?? null;
      const rows = options.rows?.[table] ?? [];

      const builder = {
        order(column: string, opts: { ascending: boolean }) {
          ordersApplied[table].push(`${column}:${opts.ascending ? "asc" : "desc"}`);
          return builder;
        },
        then(resolve: (value: { data: unknown; error: unknown }) => unknown) {
          if (error) {
            return resolve({ data: null, error });
          }
          return resolve({ data: options.nullData ? null : rows, error: null });
        },
      };

      return {
        select: () => builder,
        insert: forbidden("insert"),
        update: forbidden("update"),
        upsert: forbidden("upsert"),
        delete: forbidden("delete"),
      };
    },
    rpc: forbidden("rpc"),
  };

  return { client: client as unknown as BusinessContextReadClient, tablesRead, ordersApplied };
}

// --- Row builders --------------------------------------------------------------------------------

function costingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "costing-1",
    product_id: "product-1",
    batch_id: null,
    ingredient_cost: 100,
    packaging_cost: 10,
    labor_estimate: 20,
    utilities_estimate: 0,
    water_cost: 1,
    gas_cost: 2,
    oven_electric_cost: 3,
    refrigeration_cost: 4,
    coffee_equipment_cost: 5,
    waste_allowance: 6,
    overhead_cost: 7,
    equipment_cost: 8,
    suggested_price: 50,
    notes: "Yield: 20 pieces",
    created_at: "2026-08-01T00:00:00.000Z",
    // After the reliability boundary, so reviewedAt is a dependable `known` fact.
    updated_at: "2026-08-08T00:00:00.000Z",
    ...overrides,
  };
}

function ingredientRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "ingredient-1",
    name: "Butter",
    base_unit: "g",
    category: "dairy",
    current_quantity: 500,
    low_stock_threshold: 100,
    target_stock_quantity: 1000,
    nearest_expiration_date: null,
    average_unit_cost: 2,
    notes: null,
    is_active: true,
    archived_at: null,
    base_unit_migrated_from: null,
    base_unit_migrated_at: null,
    base_unit_migration_flagged_reason: null,
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

function purchaseRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "transaction-1",
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
    created_at: "2026-08-07T00:00:00.000Z",
    ...overrides,
  };
}

function orderRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "order-1",
    customer_id: "customer-1",
    status: "new",
    payment_status: "unpaid",
    payment_method: null,
    paid_at: null,
    paid_amount: null,
    refunded_at: null,
    fulfillment_method: "pickup",
    fulfillment_at: null,
    fulfillment_address: null,
    fulfillment_notes: null,
    source: "instagram",
    source_ref: null,
    entry_method: "manual",
    notes: null,
    placed_at: "2026-08-09T02:00:00.000Z",
    completed_at: null,
    cancelled_at: null,
    cancel_reason: null,
    created_at: "2026-08-09T02:00:00.000Z",
    updated_at: "2026-08-09T02:00:00.000Z",
    ...overrides,
  };
}

function orderLineRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "line-1",
    order_id: "order-1",
    product_id: "product-1",
    selling_format_id: null,
    item_name: "Brownies",
    unit_price: "120.50",
    pieces_per_unit_snapshot: null,
    quantity: "2",
    sort_order: 0,
    note: null,
    ...overrides,
  };
}

function productRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "product-1",
    name: "Brownies",
    category: "bakery",
    product_role: "hero",
    status: "active",
    description: null,
    notes: null,
    main_photo_url: null,
    decision: "Needs proof",
    is_public: false,
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

// Populated tables for a healthy four-domain read.
const HEALTHY_ROWS: Record<string, Record<string, unknown>[]> = {
  costing_summaries: [costingRow()],
  costing_entries: [],
  ingredients: [ingredientRow()],
  inventory_transactions: [purchaseRow()],
  products: [productRow()],
  product_batches: [],
  tasting_feedback: [],
  orders: [orderRow()],
  order_lines: [orderLineRow()],
};

// --- Readers: successful raw reads ----------------------------------------------------------------

test("[PR-1] the Costing reader returns costing_summaries and costing_entries as raw rows", async () => {
  const stub = createStub({ rows: { costing_summaries: [costingRow()], costing_entries: [{ id: "entry-1", product_id: "product-1", batch_id: null, ingredient_name: "Flour", quantity_used: null, unit: null, cost: 12, supplier_note: null, created_at: "2026-08-01T00:00:00.000Z" }] } });

  const result = await readCosting(stub.client, ENV);

  assert.equal(result.ok, true);
  assert.ok(result.ok);
  assert.equal(result.rows.costings.length, 1);
  assert.equal(result.rows.entries.length, 1);
  // Snake-case columns, untouched -- proof no mapper ran between the driver and the adapter.
  assert.equal(result.rows.costings[0].ingredient_cost, 100);
  assert.equal(result.rows.costings[0].suggested_price, 50);
  assert.equal(result.rows.entries[0].quantity_used, null);
  assert.deepEqual(stub.tablesRead.sort(), ["costing_entries", "costing_summaries"]);
});

test("[PR-1] the Inventory reader returns ingredients and inventory_transactions as raw rows", async () => {
  const stub = createStub({ rows: { ingredients: [ingredientRow({ average_unit_cost: null })], inventory_transactions: [purchaseRow()] } });

  const result = await readInventory(stub.client, ENV);

  assert.ok(result.ok);
  assert.equal(result.rows.ingredients.length, 1);
  assert.equal(result.rows.transactions.length, 1);
  // null survives as null. "never priced" is not "free", and only the raw row can still say so.
  assert.equal(result.rows.ingredients[0].average_unit_cost, null);
  assert.equal(result.rows.transactions[0].transaction_type, "purchase");
  assert.deepEqual(stub.tablesRead.sort(), ["ingredients", "inventory_transactions"]);
});

test("[PR-1] the Readiness reader reads the Rule Engine's full four-table input contract", async () => {
  const stub = createStub({ rows: HEALTHY_ROWS });

  const result = await readReadiness(stub.client, ENV);

  assert.ok(result.ok);
  assert.deepEqual(stub.tablesRead.sort(), ["costing_summaries", "product_batches", "products", "tasting_feedback"]);
  assert.equal(result.rows.products.length, 1);
  assert.equal(result.rows.costings.length, 1);
  assert.equal(result.rows.products[0].product_role, "hero");
});

test("[PR-1] the Readiness reader reads costing_summaries itself and never consumes the Costing reader", async () => {
  // The duplicated read is deliberate: it is what keeps the two domains independent, so neither
  // waits on nor consumes the other's rows.
  const stub = createStub({ rows: HEALTHY_ROWS });
  await readReadiness(stub.client, ENV);

  assert.ok(stub.tablesRead.includes("costing_summaries"));
  assert.equal(READERS_CODE.includes("readCosting("), false, "readReadiness must not call readCosting");
});

test("[PR-1] the Selling reader returns orders and order_lines as raw rows", async () => {
  const stub = createStub({ rows: { orders: [orderRow()], order_lines: [orderLineRow()] } });

  const result = await readSelling(stub.client, ENV);

  assert.ok(result.ok);
  assert.equal(result.rows.orders.length, 1);
  assert.equal(result.rows.lines.length, 1);
  assert.deepEqual(stub.tablesRead.sort(), ["order_lines", "orders"]);
});

// --- Readers: raw survival ------------------------------------------------------------------------

test("[PR-1] Selling raw values survive the reader byte-for-byte, including malformed ones", async () => {
  // mapOrderRow would normalise every one of these: an unrecognised status becomes "new", an
  // unrecognised payment_status becomes "unpaid", an unrecognised source becomes "unknown", and
  // numeric strings become numbers. Publishing any of those as an `entered` fact would assert that a
  // malformed database value was genuinely typed that way.
  const raw = orderRow({
    status: "definitely-not-a-status",
    payment_status: null,
    source: "carrier-pigeon",
    paid_amount: null,
    updated_at: null,
  });
  const rawLine = orderLineRow({ unit_price: "120.50", quantity: null, pieces_per_unit_snapshot: null });

  const stub = createStub({ rows: { orders: [raw], order_lines: [rawLine] } });
  const result = await readSelling(stub.client, ENV);

  assert.ok(result.ok);
  const order = result.rows.orders[0];
  assert.equal(order.status, "definitely-not-a-status");
  assert.equal(order.payment_status, null);
  assert.equal(order.source, "carrier-pigeon");
  assert.equal(order.paid_amount, null, "a null paid_amount must never become 0");
  assert.equal(order.updated_at, null);

  const line = result.rows.lines[0];
  assert.equal(line.unit_price, "120.50", "a numeric string must not be coerced to a number");
  assert.equal(line.quantity, null);
  assert.equal(line.pieces_per_unit_snapshot, null);
});

test("[PR-1] the readers module imports and calls no Selling mapper or repository list function", () => {
  for (const forbidden of ["mapOrderRow", "mapOrderLineRow", "listOrders", "listOrderLines", "orders-repository"]) {
    assert.equal(READERS_CODE.includes(forbidden), false, `readers/supabase.ts must not reference ${forbidden}`);
  }
  // Type-only imports of the raw row shapes are the intended dependency and must remain.
  assert.ok(READERS_SOURCE.includes('import type { OrderLineRow, OrderRow } from "../../orders/types.ts"'));
});

// --- Readers: failure semantics -------------------------------------------------------------------

const DOMAIN_READERS = [
  { name: "costing", read: readCosting, table: "costing_summaries" },
  { name: "inventory", read: readInventory, table: "ingredients" },
  { name: "readiness", read: readReadiness, table: "products" },
  { name: "selling", read: readSelling, table: "orders" },
] as const;

for (const domain of DOMAIN_READERS) {
  test(`[PR-1] ${domain.name}: PGRST205 maps to missing-table`, async () => {
    const stub = createStub({ rows: HEALTHY_ROWS, errors: { [domain.table]: { code: "PGRST205", message: "Could not find the table in the schema cache" } } });
    const result = await domain.read(stub.client, ENV);

    assert.equal(result.ok, false);
    assert.ok(!result.ok);
    assert.equal(result.reason, "missing-table");
    assert.ok(result.message.length > 0);
  });

  test(`[PR-1] ${domain.name}: 42P01 maps to missing-table`, async () => {
    const stub = createStub({ rows: HEALTHY_ROWS, errors: { [domain.table]: { code: "42P01", message: 'relation "x" does not exist' } } });
    const result = await domain.read(stub.client, ENV);

    assert.ok(!result.ok);
    assert.equal(result.reason, "missing-table");
  });

  test(`[PR-1] ${domain.name}: any other PostgREST error maps to failed, carrying the driver message`, async () => {
    const stub = createStub({ rows: HEALTHY_ROWS, errors: { [domain.table]: { code: "PGRST301", message: "JWT expired" } } });
    const result = await domain.read(stub.client, ENV);

    assert.ok(!result.ok);
    assert.equal(result.reason, "failed");
    assert.equal(result.message, "JWT expired");
  });

  test(`[PR-1] ${domain.name}: a read error never becomes a successful empty read`, async () => {
    const stub = createStub({ errors: { [domain.table]: { message: "network unreachable" } } });
    const result = await domain.read(stub.client, ENV);

    // The failure this guards is the one that looks most like success: rows: [] with ok: true would
    // render a healthy, quiet, entirely fabricated empty business.
    assert.equal(result.ok, false);
    assert.equal("rows" in result, false);
  });
}

test("[PR-1] an error with no code at all is failed, never missing-table", async () => {
  const stub = createStub({ errors: { ingredients: { message: "socket hang up" } } });
  const result = await readInventory(stub.client, ENV);

  assert.ok(!result.ok);
  assert.equal(result.reason, "failed");
});

test("[PR-1] missing-table is decided by error code, never by message text", () => {
  // A message-text match would misclassify any error whose prose happens to mention a table.
  assert.ok(READERS_CODE.includes('error.code === "PGRST205"'));
  assert.ok(READERS_CODE.includes('error.code === "42P01"'));
  assert.equal(/message\s*\.\s*(includes|match|indexOf|startsWith)/.test(READERS_CODE), false);
});

test("[PR-1] a genuinely empty authenticated read is a success, not a failure", async () => {
  const stub = createStub({ rows: {} });
  const result = await readSelling(stub.client, ENV);

  assert.ok(result.ok);
  assert.deepEqual(result.rows.orders, []);
  assert.deepEqual(result.rows.lines, []);
});

test("[PR-1] a driver returning null data with no error is a successful empty read", async () => {
  const stub = createStub({ nullData: true });
  const result = await readCosting(stub.client, ENV);

  assert.ok(result.ok);
  assert.deepEqual(result.rows.costings, []);
});

// --- Readers: determinism and read-only boundary ---------------------------------------------------

test("[PR-1] every read applies a deterministic order with an id tie-breaker", async () => {
  const stub = createStub({ rows: HEALTHY_ROWS });
  await Promise.all([readCosting(stub.client, ENV), readInventory(stub.client, ENV), readReadiness(stub.client, ENV), readSelling(stub.client, ENV)]);

  // Row order is an input to the adapters and is hashed into factsDigest, so an unstable read order
  // would move the digest while no business data had changed. Ties are real: rows written in one
  // statement share created_at exactly.
  for (const [table, applied] of Object.entries(stub.ordersApplied)) {
    assert.ok(applied.length >= 2, `${table} must declare a primary sort and a tie-breaker`);
    assert.equal(applied[applied.length - 1], "id:asc", `${table} must end with the id tie-breaker`);
  }
});

test("[PR-1] readers and runtime expose and reach no write API", () => {
  for (const code of [READERS_CODE, RUNTIME_CODE]) {
    for (const write of [".insert(", ".update(", ".upsert(", ".delete(", ".rpc("]) {
      assert.equal(code.includes(write), false, `write call ${write} must not appear`);
    }
  }
  // The client contract itself offers only from/select/order, so a write is a type error rather than
  // a convention review has to catch.
  assert.equal(/insert|update|upsert|delete|rpc/.test(READERS_CODE.slice(READERS_CODE.indexOf("BusinessContextReadClient"), READERS_CODE.indexOf("ALL_COLUMNS"))), false);
});

test("[PR-1] neither module imports a server-only or privileged credential path", () => {
  // Comment-stripped, like the write-API scan above: both files document in prose that they never
  // import supabase-server.ts, and scanning raw text would fail on the very statement of the rule.
  for (const code of [READERS_CODE, RUNTIME_CODE]) {
    for (const forbidden of ["supabase-server", "server-only", "SERVICE_ROLE", "service_role", "PUBLIC_ORDER_SUPABASE"]) {
      assert.equal(code.includes(forbidden), false, `must not reference ${forbidden}`);
    }
  }
});

test("[PR-1] no clock is read inside the readers or the orchestrator", () => {
  for (const code of [READERS_CODE, RUNTIME_CODE]) {
    assert.equal(code.includes("Date.now("), false);
    assert.equal(code.includes("new Date("), false);
    assert.equal(code.includes("getToday("), false);
  }
});

// --- Orchestrator: one clock, one env ---------------------------------------------------------------

test("[PR-1] resolveRuntimeEnv derives businessDay from the injected clock and keeps budgets empty", () => {
  const env = resolveRuntimeEnv(NOW_MS);

  assert.equal(env.now, NOW_MS);
  assert.equal(env.timezone, BUSINESS_TIMEZONE);
  assert.equal(env.businessDay, resolveBusinessDay(NOW_MS, BUSINESS_TIMEZONE));
  // M1 ships no budgets and the values are an open owner decision. Runtime v1 invents none.
  assert.deepEqual(env.budgets, {});
});

test("[PR-1] resolveRuntimeEnv honours an explicitly injected timezone", () => {
  const manila = resolveRuntimeEnv(Date.parse("2026-08-09T00:30:00.000Z"), "Asia/Manila");
  const utc = resolveRuntimeEnv(Date.parse("2026-08-09T00:30:00.000Z"), "UTC");

  // 00:30Z is already 08:30 the same day in Manila, so both land on the 9th; the point is that the
  // timezone is threaded rather than assumed.
  assert.equal(manila.timezone, "Asia/Manila");
  assert.equal(utc.timezone, "UTC");
  assert.equal(manila.businessDay, resolveBusinessDay(manila.now, "Asia/Manila"));
});

test("[PR-1] the orchestrator reads all nine unique tables required by the four domains", async () => {
  // Nine UNIQUE tables, from ten read executions: costing_summaries is read twice, once by Costing
  // and once independently by Readiness. That duplication is deliberate -- it is what keeps the two
  // domains independent, so neither waits on nor consumes the other's rows.
  const stub = createStub({ rows: HEALTHY_ROWS });
  await buildCurrentBusinessContext({ client: stub.client, nowMs: NOW_MS });

  assert.deepEqual(
    [...new Set(stub.tablesRead)].sort(),
    ["costing_entries", "costing_summaries", "ingredients", "inventory_transactions", "order_lines", "orders", "product_batches", "products", "tasting_feedback"].sort(),
  );
});

test("[PR-1] the snapshot carries one injected now and one business day", async () => {
  const stub = createStub({ rows: HEALTHY_ROWS });
  const context = await buildCurrentBusinessContext({ client: stub.client, nowMs: NOW_MS });

  assert.equal(context.generatedAt, new Date(NOW_MS).toISOString());
  assert.equal(context.businessDay, resolveBusinessDay(NOW_MS, BUSINESS_TIMEZONE));
  assert.equal(context.timezone, BUSINESS_TIMEZONE);
});

test("[PR-1] two builds over the same rows and the same clock are byte-identical", async () => {
  const first = await buildCurrentBusinessContext({ client: createStub({ rows: HEALTHY_ROWS }).client, nowMs: NOW_MS });
  const second = await buildCurrentBusinessContext({ client: createStub({ rows: HEALTHY_ROWS }).client, nowMs: NOW_MS });

  assert.equal(first.factsDigest, second.factsDigest);
  assert.equal(first.signalsDigest, second.signalsDigest);
  assert.deepEqual(first, second);
});

test("[PR-1] the snapshot declares supabase as its data source", async () => {
  const stub = createStub({ rows: HEALTHY_ROWS });
  const context = await buildCurrentBusinessContext({ client: stub.client, nowMs: NOW_MS });

  assert.equal(context.dataSource, "supabase");
  assert.equal(context.contextSchemaVersion, 1);
});

test("[PR-1] the costing-freshness composer is registered and runs", async () => {
  // A costing reviewed BEFORE the latest recorded purchase is the composer's determinate failing
  // case; its presence proves the composer was passed to the builder rather than merely existing.
  const stub = createStub({
    rows: {
      ...HEALTHY_ROWS,
      costing_summaries: [costingRow({ updated_at: "2026-08-08T00:00:00.000Z" })],
      inventory_transactions: [purchaseRow({ created_at: "2026-08-08T12:00:00.000Z" })],
    },
  });

  const context = await buildCurrentBusinessContext({ client: stub.client, nowMs: NOW_MS });

  const composed = context.signals.filter((signal) => signal.id === "costing.staleVsPurchases");
  assert.equal(composed.length, 1);
  assert.equal(composed[0].scope, "cross-domain");
  assert.equal(composed[0].status, "fail");
  assert.equal(COSTING_FRESHNESS_COMPOSER_ID, "costing-freshness");
  // The reliability boundary still governs which review times are usable, untouched by PR-1.
  assert.ok(Date.parse("2026-08-08T00:00:00.000Z") >= Date.parse(COSTING_UPDATED_AT_RELIABLE_FROM));
});

// --- Orchestrator: partial failure ------------------------------------------------------------------

test("[PR-1] one failed domain still yields a complete snapshot, with the real reason in coverage", async () => {
  const stub = createStub({ rows: HEALTHY_ROWS, errors: { orders: { message: "JWT expired" } } });
  const context = await buildCurrentBusinessContext({ client: stub.client, nowMs: NOW_MS });

  // Complete envelope, not an exception and not a truncated object.
  assert.equal(context.contextSchemaVersion, 1);
  assert.equal(typeof context.factsDigest, "string");
  assert.equal(context.coverage.knownDomains.length, 15);

  const absent = context.coverage.absent.find((entry) => entry.domain === "selling");
  assert.ok(absent, "the failed domain must be named in coverage.absent");
  assert.equal(absent.reason, "JWT expired", "the real driver reason, not a generic placeholder");

  // The other three are unaffected -- one broken domain does not degrade the rest.
  for (const domain of ["costing", "inventory", "readiness"] as DomainId[]) {
    assert.ok(context.coverage.present.includes(domain), `${domain} must remain present`);
  }
  assert.equal(context.coverage.present.includes("selling"), false);

  // Its facts are unavailable rather than empty: "we could not read" is not "there is nothing".
  const selling = context.domains.selling;
  assert.ok(selling);
  assert.equal(selling.readOutcome.ok, false);
  assert.equal(selling.facts.ordersPlacedToday.state, "unavailable");
});

test("[PR-1] a missing table is reported as not_configured, distinct from a failed read", async () => {
  const stub = createStub({ rows: HEALTHY_ROWS, errors: { ingredients: { code: "PGRST205", message: "no such table" } } });
  const context = await buildCurrentBusinessContext({ client: stub.client, nowMs: NOW_MS });

  const inventory = context.domains.inventory;
  assert.ok(inventory);
  assert.equal(inventory.facts.byIngredient.state, "not_configured");
  const absent = context.coverage.absent.find((entry) => entry.domain === "inventory");
  assert.ok(absent);
  assert.match(absent.reason, /supabase-add-inventory\.sql/);
});

test("[PR-1] all four domains failing still returns a canonical context, never a fabricated empty business", async () => {
  const stub = createStub({
    errors: {
      costing_summaries: { message: "down" },
      costing_entries: { message: "down" },
      ingredients: { message: "down" },
      inventory_transactions: { message: "down" },
      products: { message: "down" },
      product_batches: { message: "down" },
      tasting_feedback: { message: "down" },
      orders: { message: "down" },
      order_lines: { message: "down" },
    },
  });

  const context = await buildCurrentBusinessContext({ client: stub.client, nowMs: NOW_MS });

  assert.equal(context.contextSchemaVersion, 1);
  assert.deepEqual(context.coverage.present, []);
  assert.equal(context.coverage.absent.length, 15);

  for (const domain of ["costing", "inventory", "readiness", "selling"] as DomainId[]) {
    const built = context.domains[domain];
    assert.ok(built, `${domain} must still be built in degraded form`);
    assert.equal(built.readOutcome.ok, false);
  }

  // Nothing reads as a real, quiet, empty business.
  assert.equal(context.domains.selling?.facts.orderBasis.state, "unavailable");
  assert.equal(context.domains.costing?.facts.byCosting.state, "unavailable");
});

test("[PR-1] the four domain reads are issued concurrently, not sequenced", async () => {
  // Ordering evidence rather than timing: all four from() calls are recorded before any read
  // resolves, which is only true if they were started together.
  const stub = createStub({ rows: HEALTHY_ROWS });
  const pending = buildCurrentBusinessContext({ client: stub.client, nowMs: NOW_MS });

  const startedSynchronously = [...new Set(stub.tablesRead)].length;
  await pending;

  assert.equal(startedSynchronously, 9, "every domain read must start before any of them is awaited");
  assert.ok(RUNTIME_CODE.includes("Promise.all"));
});
