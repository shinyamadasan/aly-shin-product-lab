// S9 PR-F2: the public submission trust boundary.
//
// The browser is treated as hostile throughout. The two properties worth the most here are:
//
//   1. A hostile payload cannot influence a commercial fact. Not the price, not the item name, not
//      the pack size, not the status, not the payment, not the entry method.
//   2. A replayed submission cannot rewrite an order that already exists -- because save_order
//      writes the WHOLE order row, and a replay against a confirmed, paid order would otherwise
//      reset it to new/unpaid and wipe paid_at and paid_amount.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MAX_LINES, MAX_NAME_LENGTH, MAX_PAYLOAD_BYTES, MAX_QUANTITY_PER_LINE, MAX_SOURCE_REF_LENGTH, buildPublicOrder, parsePublicOrderRequest, resolvePublicOrderLines } from "../src/lib/orders/public-submission.ts";
import { derivePublicCustomerId, derivePublicOrderId } from "../src/lib/orders/public-order-id.ts";
import { getPublicSellableGroups } from "../src/lib/orders/public-menu.ts";
import { toDisplayPrice } from "../src/lib/orders/money.ts";
import { submitPublicOrder, type PublicOrderOutcome } from "../src/lib/public-order-service.ts";
import type { CostingSummary, Product, ProductBatch, SellingFormat } from "../src/lib/product-lab-types.ts";

const NOW = "2026-08-12T02:00:00.000Z";
const KEY = "0f5f6a70-7b3f-4d2e-9d4a-1f2c3b4a5d6e";

// --- Catalog fixtures ------------------------------------------------------------------------------

function product(id: string, name: string, overrides: Partial<Product> = {}): Product {
  return { id, name, category: "Bakery", role: "Hero candidate", status: "costed", description: "", image: `/product-images/${id}.png`, decision: "Candidate", isPublic: true, ...overrides };
}
function batch(id: string, productId: string): ProductBatch {
  return { id, productId, batchVersion: "V1", dateMade: "2026-08-01", ingredientsNotes: "", prepTimeMinutes: 0, bakeTimeMinutes: 0, coolingTimeMinutes: 0, usablePieces: 12, imperfectPieces: 0, stressLevel: 1, tasteNotes: "", textureNotes: "", wentWrong: "", improveNext: "", launchDecision: "launch" };
}
function costing(id: string, productId: string, batchId: string): CostingSummary {
  return { id, productId, batchId, ingredientCost: 100, packagingCost: 10, laborEstimate: 20, waterCost: 1, gasCost: 2, ovenElectricCost: 3, refrigerationCost: 1, coffeeEquipmentCost: 0, wasteAllowance: 5, overheadCost: 5, equipmentCost: 0, suggestedPrice: 30, notes: "" };
}
function format(id: string, costingId: string, name: string, price: number, pieces: number, overrides: Partial<SellingFormat> = {}): SellingFormat {
  return { id, costingId, name, piecesPerUnit: pieces, sellingPrice: price, isActive: true, sortOrder: 0, notes: "", ...overrides };
}

const CATALOG = {
  products: [product("brownies", "Brownies")],
  batches: [batch("batch-1", "brownies")],
  costings: [costing("costing-1", "brownies", "batch-1")],
  sellingFormats: [format("fmt-6", "costing-1", "Box of 6", 480, 6)],
};

function groups(catalog = CATALOG) {
  return getPublicSellableGroups(catalog.products, catalog.batches, catalog.costings, catalog.sellingFormats);
}

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    idempotencyKey: KEY,
    items: [{ productId: "brownies", sellingFormatId: "fmt-6", quantity: 2, displayedUnitPrice: 480 }],
    customerName: "ZZ Test Customer",
    phone: "09171234567",
    ...overrides,
  };
}

// --- Stubs -----------------------------------------------------------------------------------------

type Recorded = { rpcCalls: number; customerUpserts: number };

function createStubs({ existingOrder = null, catalog = CATALOG, rpcError }: { existingOrder?: Record<string, unknown> | null; catalog?: typeof CATALOG; rpcError?: { code?: string; message: string } } = {}) {
  const recorded: Recorded = { rpcCalls: 0, customerUpserts: 0 };
  let savedArgs: { p_customer: Record<string, unknown>; p_order: Record<string, unknown>; p_lines: Record<string, unknown>[] } | null = null;

  const ordersClient = {
    from(table: string) {
      return {
        select: () => {
          const chain = {
            eq: () => chain,
            in: () => chain,
            order: () => chain,
            limit: () => chain,
            then: (resolve: (v: unknown) => unknown) => resolve({ data: table === "orders" && existingOrder ? [existingOrder] : [], error: null }),
          };
          return chain;
        },
        upsert: () => {
          recorded.customerUpserts += 1;
          return Promise.resolve({ data: null, error: null });
        },
      };
    },
    // Models save_public_order_once: with no pre-existing row, it creates the customer and order
    // together; with one, it writes nothing.
    rpc: (_name: string, args: { p_customer: Record<string, unknown>; p_order: Record<string, unknown>; p_lines: Record<string, unknown>[] }) => {
      recorded.rpcCalls += 1;
      savedArgs = args;
      if (rpcError) return Promise.resolve({ data: null, error: rpcError });
      return Promise.resolve({ data: { created: existingOrder === null }, error: null });
    },
  };

  const catalogClient = {
    from(table: string) {
      const rows =
        table === "products"
          ? catalog.products.map((p) => ({ id: p.id, name: p.name, category: p.category, product_role: p.role, status: p.status, description: p.description, notes: null, main_photo_url: p.image, decision: p.decision, is_public: p.isPublic, created_at: NOW, updated_at: NOW }))
          : table === "product_batches"
            ? catalog.batches.map((b) => ({ id: b.id, product_id: b.productId, batch_version: b.batchVersion, status: "complete", completed_at: NOW, voided_at: null, void_reason: null, date_made: b.dateMade, ingredients_notes: "", prep_time_minutes: 0, bake_time_minutes: 0, cooling_time_minutes: 0, usable_pieces: b.usablePieces, imperfect_pieces: 0, stress_level: 1, taste_notes: "", texture_notes: "", went_wrong: "", improve_next: "", launch_decision: b.launchDecision, created_at: NOW, updated_at: NOW }))
            : table === "costing_summaries"
              ? catalog.costings.map((c) => ({ id: c.id, product_id: c.productId, batch_id: c.batchId, ingredient_cost: c.ingredientCost, packaging_cost: c.packagingCost, labor_estimate: c.laborEstimate, water_cost: c.waterCost, gas_cost: c.gasCost, oven_electric_cost: c.ovenElectricCost, refrigeration_cost: c.refrigerationCost, coffee_equipment_cost: c.coffeeEquipmentCost, waste_allowance: c.wasteAllowance, overhead_cost: c.overheadCost, equipment_cost: c.equipmentCost, suggested_price: c.suggestedPrice, notes: c.notes, created_at: NOW, updated_at: NOW }))
              : catalog.sellingFormats.map((f) => ({ id: f.id, costing_id: f.costingId, name: f.name, pieces_per_unit: f.piecesPerUnit, selling_price: f.sellingPrice, is_active: f.isActive, sort_order: f.sortOrder, notes: f.notes }));

      return {
        select: () => {
          const chain = {
            order: () => chain,
            then: (resolve: (v: unknown) => unknown) => resolve({ data: rows, error: null }),
          };
          return chain;
        },
      };
    },
  };

  return {
    recorded,
    savedOrder: () => savedArgs?.p_order ?? null,
    savedLines: () => savedArgs?.p_lines ?? [],
    savedCustomer: () => savedArgs?.p_customer ?? null,
    deps: { ordersClient: ordersClient as never, catalogClient: catalogClient as never, now: NOW },
  };
}

async function submit(body: unknown, options?: Parameters<typeof createStubs>[0]) {
  const stubs = createStubs(options);
  const outcome = await submitPublicOrder(stubs.deps, body);
  return { outcome, ...stubs };
}

// --- Hostile payload: commercial facts ---------------------------------------------------------------

test("a hostile unitPrice cannot affect the persisted price", async () => {
  // The headline attack: buy a 480-peso box for 1 peso.
  const { outcome, savedLines } = await submit(
    validBody({ items: [{ productId: "brownies", sellingFormatId: "fmt-6", quantity: 1, displayedUnitPrice: 480, unitPrice: 1, unit_price: 1, price: 1 }] }),
  );

  assert.equal(outcome.kind, "accepted");
  assert.equal(savedLines()[0].unit_price, 480, "the catalog price wins");
  assert.notEqual(savedLines()[0].unit_price, 1);
});

test("a hostile item name and pieces snapshot are ignored", async () => {
  const { savedLines } = await submit(
    validBody({ items: [{ productId: "brownies", sellingFormatId: "fmt-6", quantity: 1, displayedUnitPrice: 480, item_name: "FREE CAKE", itemName: "FREE CAKE", pieces_per_unit_snapshot: 9999, piecesPerUnitSnapshot: 9999 }] }),
  );

  assert.equal(savedLines()[0].item_name, "Brownies — Box of 6");
  assert.equal(savedLines()[0].pieces_per_unit_snapshot, 6);
});

test("hostile lifecycle and payment fields have no persistence path", async () => {
  const { outcome, savedOrder } = await submit(
    validBody({
      status: "completed",
      payment_status: "paid",
      paymentStatus: "paid",
      paid_amount: 999999,
      paidAmount: 999999,
      paid_at: NOW,
      refunded_at: NOW,
      payment_method: "cash",
      entry_method: "manual",
      entryMethod: "manual",
      completed_at: NOW,
      orderId: "11111111-1111-4111-8111-111111111111",
      customerId: "22222222-2222-4222-8222-222222222222",
    }),
  );

  assert.equal(outcome.kind, "accepted");
  const order = savedOrder()!;
  assert.equal(order.status, "new");
  assert.equal(order.payment_status, "unpaid");
  assert.equal(order.paid_amount, null);
  assert.equal(order.paid_at, null);
  assert.equal(order.refunded_at, null);
  assert.equal(order.payment_method, null);
  assert.equal(order.completed_at, null);
  assert.equal(order.entry_method, "website");
  // Ids are derived server-side, never taken from the request.
  assert.equal(order.id, await derivePublicOrderId(KEY));
  assert.notEqual(order.id, "11111111-1111-4111-8111-111111111111");
  assert.equal(order.customer_id, await derivePublicCustomerId(KEY));
  assert.notEqual(order.customer_id, "22222222-2222-4222-8222-222222222222");
});

test("the server always creates new / unpaid / website", async () => {
  const { savedOrder } = await submit(validBody());
  const order = savedOrder()!;
  assert.equal(order.status, "new");
  assert.equal(order.payment_status, "unpaid");
  assert.equal(order.entry_method, "website");
});

test("the persisted price comes from the CATALOG even when the displayed price differs within tolerance", async () => {
  // On every successful path the displayed and catalog prices are equal, which means no ordinary
  // test can tell which of the two was actually persisted. Consent is compared at CENTAVO precision
  // -- the precision the customer is actually shown -- so a sub-centavo difference is the one place
  // the two values can legitimately diverge, and therefore the one place this can be proven. If
  // displayedUnitPrice ever reached buildCatalogOrderLine, the saved price would be 480.004.
  const { outcome, savedLines } = await submit(
    validBody({ items: [{ productId: "brownies", sellingFormatId: "fmt-6", quantity: 1, displayedUnitPrice: 480.004 }] }),
  );

  assert.equal(outcome.kind, "accepted", "sub-centavo noise must not reject a legitimate order");
  assert.equal(savedLines()[0].unit_price, 480, "the catalog value is persisted exactly");
  assert.notEqual(savedLines()[0].unit_price, 480.004, "the browser's number is never the source");
});

test("the saved line uses the current catalog price, not the displayed one", async () => {
  // Displayed and catalog agree here, but the persisted value is proven to come from the catalog by
  // moving the catalog price and the displayed price together.
  const dearer = { ...CATALOG, sellingFormats: [format("fmt-6", "costing-1", "Box of 6", 505.5, 6)] };
  const { savedLines } = await submit(validBody({ items: [{ productId: "brownies", sellingFormatId: "fmt-6", quantity: 1, displayedUnitPrice: 505.5 }] }), { catalog: dearer });

  assert.equal(savedLines()[0].unit_price, 505.5);
});

// --- Availability ------------------------------------------------------------------------------------

test("an unresolvable item rejects the WHOLE submission with zero writes", async () => {
  const { outcome, recorded } = await submit(validBody({ items: [{ productId: "brownies", sellingFormatId: "does-not-exist", quantity: 1, displayedUnitPrice: 480 }] }));

  assert.equal(outcome.kind, "unavailable");
  assert.equal(recorded.rpcCalls, 0);
  assert.equal(recorded.customerUpserts, 0);
});

test("a product that is no longer public rejects the submission", async () => {
  const withdrawn = { ...CATALOG, products: [product("brownies", "Brownies", { isPublic: false })] };
  const { outcome, recorded } = await submit(validBody(), { catalog: withdrawn });

  assert.equal(outcome.kind, "unavailable");
  assert.equal(recorded.rpcCalls, 0);
});

test("a format that is no longer sellable rejects the submission", async () => {
  const archived = { ...CATALOG, sellingFormats: [format("fmt-6", "costing-1", "Box of 6", 480, 6, { isActive: false })] };
  const { outcome, recorded } = await submit(validBody(), { catalog: archived });

  assert.equal(outcome.kind, "unavailable");
  assert.equal(recorded.rpcCalls, 0);
});

// --- Stale price -------------------------------------------------------------------------------------

test("a stale displayed price returns prices-changed and writes NOTHING", async () => {
  const { outcome, recorded } = await submit(validBody({ items: [{ productId: "brownies", sellingFormatId: "fmt-6", quantity: 1, displayedUnitPrice: 450 }] }));

  assert.equal(outcome.kind, "prices-changed");
  assert.equal(recorded.rpcCalls, 0, "no order may be created at a price the customer never saw");
  assert.equal(recorded.customerUpserts, 0);
  if (outcome.kind !== "prices-changed") return;
  // The refreshed menu comes back so the customer can review the real price.
  assert.equal(outcome.menu[0].formats[0].unitPrice, 480);
});

test("a tampered LOW displayed price only rejects the attacker's own request", async () => {
  const { outcome, recorded } = await submit(validBody({ items: [{ productId: "brownies", sellingFormatId: "fmt-6", quantity: 1, displayedUnitPrice: 1 }] }));

  assert.equal(outcome.kind, "prices-changed");
  assert.equal(recorded.rpcCalls, 0);
});

test("a tampered HIGH displayed price is rejected too", async () => {
  const { outcome, recorded } = await submit(validBody({ items: [{ productId: "brownies", sellingFormatId: "fmt-6", quantity: 1, displayedUnitPrice: 99999 }] }));

  assert.equal(outcome.kind, "prices-changed");
  assert.equal(recorded.rpcCalls, 0);
});

test("price consent matches what the customer SEES, not an arithmetic approximation of it", async () => {
  // Math.round(value * 100) disagrees with the app's formatter on values like 1.005 (which renders
  // "1.01" but computes to 100 centavos, because 1.005 * 100 === 100.49999999999999). The rule is
  // therefore defined by the formatter itself.
  assert.equal(toDisplayPrice(1.005), "1.01");
  assert.equal(Math.round(1.005 * 100), 100, "the arithmetic route would disagree");
  assert.equal(toDisplayPrice(8.165), "8.17");
  assert.equal(Math.round(8.165 * 100), 816, "and again here");

  // Same display => indistinguishable to the customer => proceed.
  for (const [catalogPrice, displayed] of [[1.005, 1.005], [2.675, 2.675], [480.004, 480.0041], [22, 22.0001]] as const) {
    const cat = { ...CATALOG, sellingFormats: [format("fmt-6", "costing-1", "Box of 6", catalogPrice, 6)] };
    const { outcome } = await submit(validBody({ items: [{ productId: "brownies", sellingFormatId: "fmt-6", quantity: 1, displayedUnitPrice: displayed }] }), { catalog: cat });
    assert.equal(outcome.kind, "accepted", `${displayed} vs ${catalogPrice} render identically (${toDisplayPrice(catalogPrice)}) and must proceed`);
  }

  // Different display => the customer can see the change => refuse. 1.004 vs 1.005 is the case the
  // arithmetic rule waved through: both are 100 centavos, but they render "1.00" and "1.01".
  for (const [catalogPrice, displayed] of [[1.004, 1.005], [8.164, 8.165], [480, 480.01], [22, 21.99]] as const) {
    assert.notEqual(toDisplayPrice(catalogPrice), toDisplayPrice(displayed), "fixture must actually differ on screen");
    const cat = { ...CATALOG, sellingFormats: [format("fmt-6", "costing-1", "Box of 6", catalogPrice, 6)] };
    const { outcome, recorded } = await submit(validBody({ items: [{ productId: "brownies", sellingFormatId: "fmt-6", quantity: 1, displayedUnitPrice: displayed }] }), { catalog: cat });
    assert.equal(outcome.kind, "prices-changed", `${displayed} renders ${toDisplayPrice(displayed)} but the catalog renders ${toDisplayPrice(catalogPrice)} -- consent is broken`);
    assert.equal(recorded.rpcCalls, 0, "and nothing may be written");
  }
});

test("the persisted price is the catalog number, never the displayed one, even at half-cent boundaries", async () => {
  // 1.005 and 1.00501 both render "1.01", so consent passes -- and the value stored must still be
  // the catalog's, not the browser's.
  assert.equal(toDisplayPrice(1.005), toDisplayPrice(1.00501));
  const cat = { ...CATALOG, sellingFormats: [format("fmt-6", "costing-1", "Box of 6", 1.005, 6)] };
  const { outcome, savedLines } = await submit(validBody({ items: [{ productId: "brownies", sellingFormatId: "fmt-6", quantity: 1, displayedUnitPrice: 1.00501 }] }), { catalog: cat });

  assert.equal(outcome.kind, "accepted");
  assert.equal(savedLines()[0].unit_price, 1.005, "the authoritative catalog value is persisted exactly");
  assert.notEqual(savedLines()[0].unit_price, 1.00501);
});

test("a matching displayed price succeeds", async () => {
  const { outcome, recorded } = await submit(validBody());
  assert.equal(outcome.kind, "accepted");
  assert.equal(recorded.rpcCalls, 1);
});

// --- Idempotency and replay ----------------------------------------------------------------------------

test("the same idempotency key always derives the same ids", async () => {
  assert.equal(await derivePublicOrderId(KEY), await derivePublicOrderId(KEY));
  assert.notEqual(await derivePublicOrderId(KEY), await derivePublicOrderId("a-different-key"));
  // Order and customer ids are independent, so one is not computable from the other.
  assert.notEqual(await derivePublicOrderId(KEY), await derivePublicCustomerId(KEY));
});

test("the derived order id is a valid v5 UUID", async () => {
  assert.match(await derivePublicOrderId(KEY), /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("two submissions with the same key converge on one order", async () => {
  const first = await submit(validBody());
  assert.equal(first.outcome.kind, "accepted");
  const orderId = first.savedOrder()!.id;

  // The second arrives after the first has persisted.
  const second = await submit(validBody(), { existingOrder: { id: orderId, customer_id: "c", status: "new", payment_status: "unpaid", payment_method: null, paid_at: null, paid_amount: null, refunded_at: null, fulfillment_method: "pickup", fulfillment_at: null, fulfillment_address: null, fulfillment_notes: null, source: "unknown", source_ref: null, entry_method: "website", notes: null, placed_at: NOW, completed_at: null, cancelled_at: null, cancel_reason: null, created_at: NOW, updated_at: NOW } });

  assert.equal(second.outcome.kind, "accepted");
  assert.equal(second.recorded.rpcCalls, 0, "a replay must not reach save_order");
});

test("REPLAY AGAINST A CONFIRMED, PAID ORDER WRITES NOTHING", async () => {
  // The highest-value guard in S9. save_order writes the whole order row, so a replay that reached
  // it would reset this order to new/unpaid and wipe paid_at and paid_amount.
  const paid = {
    id: await derivePublicOrderId(KEY), customer_id: "customer-1",
    status: "confirmed", payment_status: "paid", payment_method: "gcash",
    paid_at: "2026-08-13T01:00:00.000Z", paid_amount: 960, refunded_at: null,
    fulfillment_method: "pickup", fulfillment_at: "2026-08-14T02:00:00.000Z", fulfillment_address: null, fulfillment_notes: null,
    source: "instagram", source_ref: "POST-1", entry_method: "website", notes: null,
    placed_at: NOW, completed_at: null, cancelled_at: null, cancel_reason: null, created_at: NOW, updated_at: NOW,
  };

  const { outcome, recorded } = await submit(validBody(), { existingOrder: paid });

  assert.equal(outcome.kind, "accepted", "the replay still looks ordinary to the caller");
  assert.equal(recorded.rpcCalls, 0, "save_order must never be called for an existing order");
  assert.equal(recorded.customerUpserts, 0, "and the customer must not be re-upserted either");
});

test("the replay response discloses nothing about the persisted order", async () => {
  const paid = {
    id: await derivePublicOrderId(KEY), customer_id: "customer-1", status: "confirmed", payment_status: "paid",
    payment_method: "gcash", paid_at: "2026-08-13T01:00:00.000Z", paid_amount: 960, refunded_at: null,
    fulfillment_method: "pickup", fulfillment_at: null, fulfillment_address: null, fulfillment_notes: null,
    source: "instagram", source_ref: "SECRET-REF", entry_method: "website", notes: "private note",
    placed_at: NOW, completed_at: null, cancelled_at: null, cancel_reason: null, created_at: NOW, updated_at: NOW,
  };

  const replay = await submit(validBody(), { existingOrder: paid });
  const first = await submit(validBody());

  // Byte-identical to a first-time success: an idempotency key is not a read credential.
  assert.deepEqual(replay.outcome, { kind: "accepted" });
  assert.deepEqual(replay.outcome, first.outcome);

  const serialized = JSON.stringify(replay.outcome);
  for (const leaked of ["confirmed", "paid", "gcash", "960", "SECRET-REF", "private note", "customer-1", "instagram", paid.paid_at]) {
    assert.equal(serialized.includes(leaked), false, `replay response must not disclose ${leaked}`);
  }
});

// --- Atomic create-once: the TOCTOU race the live database reproduced ------------------------------------
//
// Revision 2 relied on an application-side existence check. Against the real database that let a
// second caller, which had already passed its check, call save_order afterwards and reset a
// confirmed, paid order to new/unpaid. The stub below models the CORRECTED contract:
// save_public_order_once takes a per-order-id lock, checks existence under it, and only then
// delegates -- so a loser writes nothing.

type DbOrder = Record<string, unknown>;

function createDbStub() {
  const orders = new Map<string, DbOrder>();
  const customers = new Map<string, DbOrder>();
  // One waiter chain per order id -- the in-process equivalent of pg_advisory_xact_lock, and like
  // it, held for the whole critical section rather than around the read alone.
  const locks = new Map<string, Promise<void>>();
  const saveOrderCalls: string[] = [];
  // A ONE-SHOT gate, consumed by the first caller to reach the RPC. It must park only that caller:
  // a gate that stopped everyone would force the test to release before the other caller ran, which
  // would let the parked caller win the lock first and quietly stop testing the sequence that
  // actually failed in production.
  let armedGate: { promise: Promise<void>; release: () => void } | null = null;

  async function withLock<T>(id: string, body: () => Promise<T>): Promise<T> {
    const previous = locks.get(id) ?? Promise.resolve();
    let release!: () => void;
    locks.set(id, previous.then(() => new Promise<void>((resolve) => { release = resolve; })));
    await previous;
    try {
      return await body();
    } finally {
      release();
    }
  }

  const client = {
    from(table: string) {
      return {
        select: () => {
          const chain = {
            eq: (_c: string, value: string) => { chain._id = value; return chain; },
            in: () => chain,
            order: () => chain,
            limit: () => chain,
            _id: "",
            then: (resolve: (v: unknown) => unknown) => {
              const row = table === "orders" ? orders.get(chain._id) : undefined;
              return resolve({ data: row ? [row] : [], error: null });
            },
          };
          return chain;
        },
        upsert: () => Promise.resolve({ data: null, error: null }),
      };
    },
    rpc: async (_name: string, args: { p_customer: DbOrder; p_order: DbOrder; p_lines: DbOrder[] }) => {
      const id = String(args.p_order.id);
      // The parked caller waits here -- BEFORE the lock, exactly where a real request pauses
      // between its application-side check and its RPC.
      if (armedGate) {
        const gate = armedGate;
        armedGate = null;
        await gate.promise;
      }
      return withLock(id, async () => {
        if (orders.has(id)) {
          // A loser writes NOTHING -- not the order, and not the customer.
          return { data: { created: false }, error: null };
        }
        saveOrderCalls.push(id);
        customers.set(String(args.p_customer.id), { ...args.p_customer });
        orders.set(id, { ...args.p_order });
        return { data: { created: true }, error: null };
      });
    },
  };

  return {
    client: client as never,
    orders,
    customers,
    saveOrderCalls,
    get: (id: string) => orders.get(id),
    getCustomer: (id: string) => customers.get(id),
    // Simulates the operator moving the order on, using the same columns S3/S4 write.
    confirmAndPay(id: string) {
      const row = orders.get(id)!;
      orders.set(id, { ...row, status: "confirmed", payment_status: "paid", payment_method: "gcash", paid_at: "2026-08-13T01:00:00.000Z", paid_amount: 44, updated_at: "2026-08-13T01:00:00.000Z" });
    },
    park() {
      let release!: () => void;
      const promise = new Promise<void>((resolve) => { release = resolve; });
      armedGate = { promise, release };
      return release;
    },
  };
}

function depsFor(db: ReturnType<typeof createDbStub>) {
  const stubs = createStubs();
  return { ordersClient: db.client, catalogClient: stubs.deps.catalogClient, now: NOW };
}

test("sequential replay: the wrapper reports created:false and persists nothing", async () => {
  const db = createDbStub();
  const orderId = await derivePublicOrderId(KEY);

  const first = await submitPublicOrder(depsFor(db), validBody());
  assert.equal(first.kind, "accepted");
  assert.equal(db.saveOrderCalls.length, 1);

  const second = await submitPublicOrder(depsFor(db), validBody());
  assert.equal(second.kind, "accepted", "the public response stays generic");
  assert.equal(db.saveOrderCalls.length, 1, "no second persistence");
  assert.equal(db.orders.size, 1);
  assert.ok(db.get(orderId));
});

test("two concurrent initial submissions produce exactly ONE creation", async () => {
  const db = createDbStub();

  const [a, b] = await Promise.all([
    submitPublicOrder(depsFor(db), validBody()),
    submitPublicOrder(depsFor(db), validBody()),
  ]);

  assert.equal(a.kind, "accepted");
  assert.equal(b.kind, "accepted");
  assert.equal(db.saveOrderCalls.length, 1, "the loser must not persist a second time");
  assert.equal(db.orders.size, 1, "exactly one order");
});

test("THE RACE: a paused caller cannot reset a confirmed, paid order", async () => {
  // The exact live sequence, deterministically. B passes its application-side check, parks, A
  // creates, the operator confirms and pays, then B resumes and attempts its creation.
  const db = createDbStub();
  const orderId = await derivePublicOrderId(KEY);

  // B starts, passes its application-side existence check (absent), and parks at the RPC.
  const release = db.park();
  const bPromise = submitPublicOrder(depsFor(db), validBody());
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(db.saveOrderCalls.length, 0, "B has not persisted anything yet -- it is parked");

  // A runs to completion while B is parked, and creates the order.
  const a = await submitPublicOrder(depsFor(db), validBody());
  assert.equal(a.kind, "accepted");
  assert.ok(db.get(orderId), "A created the order");
  assert.equal(db.saveOrderCalls.length, 1);

  // The operator confirms and pays it -- while B is still parked.
  db.confirmAndPay(orderId);
  const before = { ...db.get(orderId)! };
  assert.equal(before.payment_status, "paid");

  // Only now does B resume, carrying its original creation payload.
  release();
  const b = await bPromise;
  assert.equal(b.kind, "accepted", "B still receives the ordinary generic acceptance");

  const after = db.get(orderId)!;
  for (const field of ["status", "payment_status", "payment_method", "paid_at", "paid_amount", "refunded_at", "completed_at", "cancelled_at", "updated_at"]) {
    assert.equal(after[field], before[field], `${field} must be byte-identical after the losing caller finishes`);
  }
  assert.equal(db.saveOrderCalls.length, 1, "the losing caller must never reach save_order");
});

// --- Divergent customer details under one idempotency key --------------------------------------------
//
// The BLOCKER found by adversarial review, reproduced live in both orderings before the fix: two
// submissions sharing a key but carrying different contact details derive the SAME customer id, and
// the loser's customer write landed AFTER the winner's order already referenced it. An order placed
// by Alice ended up addressed to Bob's name and phone -- the two fields the whole public flow exists
// to capture.

const ALICE = { customerName: "Alice Race", phone: "111111" };
const BOB = { customerName: "Bob Race", phone: "222222" };

async function runDivergentRace(winner: typeof ALICE, loser: typeof ALICE) {
  const db = createDbStub();
  const orderId = await derivePublicOrderId(KEY);
  const customerId = await derivePublicCustomerId(KEY);

  // The loser starts first, passes its application precheck while the order is absent, and parks.
  const release = db.park();
  const loserPromise = submitPublicOrder(depsFor(db), validBody(loser));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(db.saveOrderCalls.length, 0, "the parked caller has written nothing yet");

  // The winner completes.
  const w = await submitPublicOrder(depsFor(db), validBody(winner));
  assert.equal(w.kind, "accepted");
  const orderAfterWinner = { ...db.get(orderId)! };
  const customerAfterWinner = { ...db.getCustomer(customerId)! };
  assert.equal(customerAfterWinner.name, winner.customerName);

  // The loser resumes, carrying its own different contact details.
  release();
  const l = await loserPromise;

  return { db, orderId, customerId, winnerOutcome: w, loserOutcome: l, orderAfterWinner, customerAfterWinner };
}

test("DIVERGENT CUSTOMER RACE (A wins): the loser cannot overwrite the winner's customer", async () => {
  const { db, orderId, customerId, loserOutcome, orderAfterWinner, customerAfterWinner } = await runDivergentRace(ALICE, BOB);

  assert.equal(loserOutcome.kind, "accepted", "the loser still gets the ordinary generic acceptance");

  const customer = db.getCustomer(customerId)!;
  assert.equal(customer.name, "Alice Race", "the winning order's customer name must survive");
  assert.equal(customer.phone, "111111", "and its phone -- this is how the order gets confirmed");
  assert.notEqual(customer.name, "Bob Race");
  assert.notEqual(customer.phone, "222222");

  // Nothing at all moved.
  assert.deepEqual(customer, customerAfterWinner, "customer row byte-identical after the loser");
  assert.deepEqual(db.get(orderId), orderAfterWinner, "order row byte-identical after the loser");
  assert.equal(db.saveOrderCalls.length, 1, "exactly one creation");
  assert.equal(db.customers.size, 1);
});

test("DIVERGENT CUSTOMER RACE (B wins): inverted, with the same guarantee", async () => {
  const { db, orderId, customerId, loserOutcome, orderAfterWinner, customerAfterWinner } = await runDivergentRace(BOB, ALICE);

  assert.equal(loserOutcome.kind, "accepted");

  const customer = db.getCustomer(customerId)!;
  assert.equal(customer.name, "Bob Race");
  assert.equal(customer.phone, "222222");
  assert.notEqual(customer.name, "Alice Race");

  assert.deepEqual(customer, customerAfterWinner);
  assert.deepEqual(db.get(orderId), orderAfterWinner);
  assert.equal(db.saveOrderCalls.length, 1);
});

test("neither racer's response reveals which one won", async () => {
  const first = await runDivergentRace(ALICE, BOB);
  const second = await runDivergentRace(BOB, ALICE);

  for (const outcome of [first.winnerOutcome, first.loserOutcome, second.winnerOutcome, second.loserOutcome]) {
    assert.deepEqual(outcome, { kind: "accepted" });
  }
  const serialized = JSON.stringify([first.loserOutcome, second.loserOutcome]);
  for (const leaked of ["Alice", "Bob", "111111", "222222"]) {
    assert.equal(serialized.includes(leaked), false, `no response may disclose ${leaked}`);
  }
});

test("the winner's ORDER CONTENT and CUSTOMER always come from the same request", async () => {
  // The state the BLOCKER produced: winning order content married to losing customer data. It must
  // be impossible for any divergent field.
  const db = createDbStub();
  const orderId = await derivePublicOrderId(KEY);
  const customerId = await derivePublicCustomerId(KEY);

  const release = db.park();
  const loser = submitPublicOrder(depsFor(db), validBody({ ...BOB, quantity: 1, notes: "loser notes", source: "facebook", sourceRef: "LOSER-REF" }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  await submitPublicOrder(depsFor(db), validBody({ ...ALICE, notes: "winner notes", source: "instagram", sourceRef: "WINNER-REF" }));
  release();
  await loser;

  const order = db.get(orderId)!;
  const customer = db.getCustomer(customerId)!;

  assert.equal(customer.name, "Alice Race");
  assert.equal(order.notes, "winner notes");
  assert.equal(order.source, "instagram");
  assert.equal(order.source_ref, "WINNER-REF");
  for (const losing of ["Bob Race", "222222", "loser notes", "facebook", "LOSER-REF"]) {
    assert.equal(JSON.stringify({ order, customer }).includes(losing), false, `no losing value may reach persisted state: ${losing}`);
  }
});

test("submissions with DIFFERENT derived ids do not block or couple", async () => {
  const db = createDbStub();
  const otherKey = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";

  const [a, b] = await Promise.all([
    submitPublicOrder(depsFor(db), validBody()),
    submitPublicOrder(depsFor(db), validBody({ idempotencyKey: otherKey })),
  ]);

  assert.equal(a.kind, "accepted");
  assert.equal(b.kind, "accepted");
  assert.equal(db.orders.size, 2, "two independent orders");
  assert.equal(db.saveOrderCalls.length, 2, "neither suppressed the other");
  assert.notEqual(await derivePublicOrderId(KEY), await derivePublicOrderId(otherKey));
});

// --- The wrapper's own structure --------------------------------------------------------------------------

const wrapperSql = readFileSync(new URL("../supabase-add-public-order-once.sql", import.meta.url), "utf8");
const wrapperStatements = wrapperSql
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n");

test("the wrapper locks BEFORE checking existence, and delegates persistence", () => {
  const lockAt = wrapperStatements.indexOf("pg_advisory_xact_lock");
  const checkAt = wrapperStatements.indexOf("select true into v_exists");
  const delegateAt = wrapperStatements.indexOf("perform save_order(");

  assert.notEqual(lockAt, -1, "the wrapper must take an advisory lock");
  assert.notEqual(checkAt, -1, "the wrapper must check existence");
  assert.notEqual(delegateAt, -1, "the wrapper must delegate to save_order");
  assert.ok(lockAt < checkAt, "the lock must be acquired BEFORE the existence check -- otherwise the race survives");
  assert.ok(checkAt < delegateAt, "existence is decided before anything is persisted");
});

test("the wrapper is transaction-scoped and keyed to the order id alone", () => {
  // xact-scoped: released automatically at transaction end, including on an exception. A session
  // lock would need an unlock path that a failed request could skip.
  assert.match(wrapperStatements, /pg_advisory_xact_lock\(hashtextextended\(v_order_id::text, 0\)\)/);
  assert.equal(wrapperStatements.includes("pg_advisory_lock("), false, "must not use a session-scoped lock");
  assert.equal(wrapperStatements.includes("pg_advisory_unlock"), false, "an xact lock needs no unlock path");
});

test("the wrapper reimplements NO order or line persistence", () => {
  // It may now write the ONE customer row that must be created together with the order -- that is
  // the fix for the divergent-customer race. It must still never touch orders or order_lines
  // itself: save_order stays canonical for those.
  for (const forbidden of [/insert\s+into\s+orders/i, /insert\s+into\s+order_lines/i, /update\s+orders\s+set/i, /update\s+order_lines\s+set/i, /delete\s+from\s+order/i]) {
    assert.equal(forbidden.test(wrapperStatements), false, `the wrapper must not contain ${forbidden} -- save_order stays canonical`);
  }
  // Exactly one upsert, and it is the customer's.
  const upserts = wrapperStatements.match(/on\s+conflict/gi) ?? [];
  assert.equal(upserts.length, 1, "the wrapper may contain exactly one upsert");
  assert.match(wrapperStatements, /insert into customers \(/i);
  assert.match(wrapperStatements, /perform save_order\(/);
});

test("the customer write is INSIDE the lock and only on the created path", () => {
  const lockAt = wrapperStatements.indexOf("pg_advisory_xact_lock");
  const replayReturn = wrapperStatements.indexOf("'created', false");
  const customerAt = wrapperStatements.indexOf("insert into customers");

  assert.ok(lockAt < customerAt, "the customer must be written under the lock, never before it");
  assert.ok(replayReturn < customerAt, "the replay branch must return BEFORE any customer write -- a loser writes nothing");
});

test("the wrapper matches save_order's privilege boundary on its NEW signature", () => {
  assert.match(wrapperStatements, /security invoker/i);
  assert.match(wrapperStatements, /revoke execute on function save_public_order_once\(jsonb, jsonb, jsonb\) from public;/i);
  assert.match(wrapperStatements, /grant\s+execute on function save_public_order_once\(jsonb, jsonb, jsonb\) to authenticated;/i);
  assert.equal(/to anon|service_role/i.test(wrapperStatements), false, "no anon or service-role access");
});

test("the obsolete two-argument overload is explicitly dropped", () => {
  // `create or replace` does not replace a function whose argument list differs -- it would leave
  // the old two-argument version callable and still granted, able to create an order with no
  // customer. It must be dropped by name and signature.
  assert.match(wrapperStatements, /drop function if exists save_public_order_once\(jsonb, jsonb\);/i);
  const dropAt = wrapperStatements.indexOf("drop function if exists save_public_order_once(jsonb, jsonb)");
  const createAt = wrapperStatements.indexOf("create or replace function save_public_order_once");
  assert.ok(dropAt < createAt, "the drop must precede the create");
});

test("the wrapper migration is idempotent and touches no table", () => {
  assert.match(wrapperStatements, /create or replace function save_public_order_once/i);
  assert.match(wrapperStatements, /drop function if exists/i, "the only drop is the obsolete overload, guarded by if exists");
  for (const forbidden of [/create table/i, /alter table/i, /drop table/i, /drop schema/i, /create policy/i]) {
    assert.equal(forbidden.test(wrapperStatements), false, `migration must not contain ${forbidden}`);
  }
});

test("the public creation path invokes only the wrapper, never save_order directly", () => {
  const repository = readFileSync(new URL("../src/lib/orders-repository.ts", import.meta.url), "utf8");
  const publicSection = repository.slice(repository.indexOf("export async function submitPublicOrderOnce"));
  assert.equal(publicSection.includes("saveOrder("), false, "the public path must not call saveOrder directly");
  assert.match(publicSection, /savePublicOrderOnce\(/);

  const service = readFileSync(new URL("../src/lib/public-order-service.ts", import.meta.url), "utf8");
  assert.equal(service.includes("submitNewOrder"), false, "the service must no longer use the manual-flow submitter");
  assert.match(service, /submitPublicOrderOnce/);
});

// --- Replay must not depend on the catalog still matching -------------------------------------------------
//
// A retry of an order that already exists is answered from its existence alone. The catalog is
// irrelevant to it: the order was created at the price and availability of the moment it was
// created, and nothing about a later price change or an unpublished product can retroactively make
// that submission invalid. Resolving the catalog first meant a customer whose response was lost got
// "prices have changed" for an order that had, in fact, already been placed.

const PERSISTED_ORDER = {
  id: "", customer_id: "customer-1", status: "new", payment_status: "unpaid", payment_method: null,
  paid_at: null, paid_amount: null, refunded_at: null, fulfillment_method: "pickup", fulfillment_at: null,
  fulfillment_address: null, fulfillment_notes: null, source: "unknown", source_ref: null,
  entry_method: "website", notes: null, placed_at: NOW, completed_at: null, cancelled_at: null,
  cancel_reason: null, created_at: NOW, updated_at: NOW,
};

async function persistedOrder(overrides: Record<string, unknown> = {}) {
  return { ...PERSISTED_ORDER, id: await derivePublicOrderId(KEY), ...overrides };
}

const DEARER = { ...CATALOG, sellingFormats: [format("fmt-6", "costing-1", "Box of 6", 540, 6)] };
const WITHDRAWN = { ...CATALOG, products: [product("brownies", "Brownies", { isPublic: false })] };

test("existing order + price changed since -> accepted, zero write", async () => {
  const { outcome, recorded } = await submit(validBody(), { existingOrder: await persistedOrder(), catalog: DEARER });

  assert.deepEqual(outcome, { kind: "accepted" }, "the order already exists; a later price change cannot un-place it");
  assert.equal(recorded.rpcCalls, 0);
});

test("existing order + product unpublished since -> accepted, zero write", async () => {
  const { outcome, recorded } = await submit(validBody(), { existingOrder: await persistedOrder(), catalog: WITHDRAWN });

  assert.deepEqual(outcome, { kind: "accepted" });
  assert.equal(recorded.rpcCalls, 0);
});

test("existing CONFIRMED + PAID order + catalog changed -> accepted, zero write", async () => {
  const paid = await persistedOrder({ status: "confirmed", payment_status: "paid", payment_method: "gcash", paid_at: NOW, paid_amount: 960 });
  const { outcome, recorded } = await submit(validBody(), { existingOrder: paid, catalog: DEARER });

  assert.deepEqual(outcome, { kind: "accepted" }, "a paid order is certainly not 'prices-changed'");
  assert.equal(recorded.rpcCalls, 0);
});

test("NO existing order + price changed -> still prices-changed", async () => {
  const { outcome, recorded } = await submit(validBody(), { catalog: DEARER });
  assert.equal(outcome.kind, "prices-changed");
  assert.equal(recorded.rpcCalls, 0);
});

test("NO existing order + product unpublished -> still unavailable", async () => {
  const { outcome, recorded } = await submit(validBody(), { catalog: WITHDRAWN });
  assert.equal(outcome.kind, "unavailable");
  assert.equal(recorded.rpcCalls, 0);
});

// --- Persistence failure is a SERVER failure, not a customer mistake ---------------------------------------

test("a database failure during persistence is classified as a temporary server error", async () => {
  // It must never surface as 400 invalid: the customer did nothing wrong, and telling them their
  // order was invalid would make them edit a submission that was fine.
  const { outcome } = await submit(validBody(), { rpcError: { code: "57P01", message: 'terminating connection due to administrator command; relation "orders"' } });

  assert.equal(outcome.kind, "error", "a persistence failure is a server problem");
  assert.notEqual(outcome.kind, "invalid");
  // And nothing about the database travels with it.
  const serialized = JSON.stringify(outcome);
  for (const leaked of ["57P01", "terminating", "relation", "orders"]) {
    assert.equal(serialized.includes(leaked), false, `the public outcome must not carry ${leaked}`);
  }
});

test("a genuine validation failure is still classified as invalid", async () => {
  const { outcome } = await submit(validBody({ customerName: "  " }));
  assert.equal(outcome.kind, "invalid");
});

// --- Auth recovery: exactly one re-authentication, exactly one retry ---------------------------------------
//
// withPublicOrderClient existed but the Route Handler called getPublicOrderClient directly, so the
// recovery path was dead code. The route now runs through it. These tests exercise the wrapper's
// contract with an injected operation, since the handler itself needs a Next.js runtime.

function retryHarness(outcomes: PublicOrderOutcome[]) {
  const calls: number[] = [];
  let signIns = 0;
  let attempt = 0;

  // Mirrors withPublicOrderClient's contract: run, and on a retryable result re-authenticate once
  // and run once more. Never more.
  async function run(shouldRetry: (o: PublicOrderOutcome) => boolean): Promise<PublicOrderOutcome> {
    signIns += 1;
    const first = outcomes[attempt++] ?? { kind: "error" };
    calls.push(1);
    if (!shouldRetry(first)) return first;

    signIns += 1;
    const second = outcomes[attempt++] ?? { kind: "error" };
    calls.push(2);
    return shouldRetry(second) ? { kind: "error" } : second;
  }

  return { run, get attempts() { return calls.length; }, get signIns() { return signIns; } };
}

const retryable = (o: PublicOrderOutcome) => o.kind === "error";

test("a first internal failure re-authenticates once and the retry succeeds", async () => {
  const h = retryHarness([{ kind: "error" }, { kind: "accepted" }]);
  const result = await h.run(retryable);

  assert.deepEqual(result, { kind: "accepted" });
  assert.equal(h.attempts, 2, "exactly one retry");
  assert.equal(h.signIns, 2, "exactly one re-authentication");
});

test("repeated failure retries exactly once, then reports a temporary server failure", async () => {
  const h = retryHarness([{ kind: "error" }, { kind: "error" }, { kind: "accepted" }]);
  const result = await h.run(retryable);

  assert.deepEqual(result, { kind: "error" }, "a second failure is not retried again");
  assert.equal(h.attempts, 2, "no loop -- at most two attempts");
  assert.equal(h.signIns, 2);
});

test("a settled rejection is never retried", async () => {
  // invalid / prices-changed / unavailable are answers, not failures. Retrying them would
  // re-run the whole submission for no reason and could surprise the customer.
  for (const settled of [{ kind: "invalid", message: "x" }, { kind: "prices-changed", message: "x", menu: [] }, { kind: "unavailable", message: "x", menu: [] }, { kind: "accepted" }] as PublicOrderOutcome[]) {
    const h = retryHarness([settled, { kind: "accepted" }]);
    const result = await h.run(retryable);
    assert.deepEqual(result, settled);
    assert.equal(h.attempts, 1, `${settled.kind} must not be retried`);
    assert.equal(h.signIns, 1, `${settled.kind} must not re-authenticate`);
  }
});

test("the route runs submissions through the recovery wrapper, not a bare client", () => {
  const route = readFileSync(new URL("../src/app/api/public-orders/route.ts", import.meta.url), "utf8");
  assert.match(route, /withPublicOrderClient\(/, "the recovery wrapper must actually be used");
  assert.equal(/getPublicOrderClient\(/.test(route), false, "a bare client bypasses the retry path");
  assert.match(route, /outcome\.kind === "error"/, "only an internal failure may trigger a retry");
});

test("the server client keeps its non-persistent session contract", () => {
  const source = readFileSync(new URL("../src/lib/supabase-server.ts", import.meta.url), "utf8");
  assert.match(source, /persistSession:\s*false/);
  assert.match(source, /autoRefreshToken:\s*false/);
  assert.match(source, /detectSessionInUrl:\s*false/);
  // Module-scope session reuse, and exactly one re-auth path.
  assert.match(source, /let cachedClient/);
  const signInCalls = source.match(/await signIn\(/g) ?? [];
  assert.equal(signInCalls.length, 2, "one initial sign-in and exactly one retry sign-in -- no loop");
});

// --- Attribution ---------------------------------------------------------------------------------------

test("a valid source is preserved and an invalid one degrades to unknown", async () => {
  const good = await submit(validBody({ source: "instagram" }));
  assert.equal(good.savedOrder()!.source, "instagram");

  const bad = await submit(validBody({ source: "pinterest" }));
  assert.equal(bad.savedOrder()!.source, "unknown");

  const missing = await submit(validBody());
  assert.equal(missing.savedOrder()!.source, "unknown");
});

test("source_ref is opaque -- stored exactly, never parsed or trimmed", async () => {
  const reference = "  https://instagram.com/p/Cxyz/?utm_source=ig&utm_campaign=x — kapitbahay  ";
  const { savedOrder } = await submit(validBody({ sourceRef: reference }));
  assert.equal(savedOrder()!.source_ref, reference);
});

test("an over-long source_ref is dropped rather than truncated, and the channel survives", async () => {
  const tooLong = "x".repeat(MAX_SOURCE_REF_LENGTH + 1);
  const { savedOrder } = await submit(validBody({ source: "facebook", sourceRef: tooLong }));

  assert.equal(savedOrder()!.source_ref, null, "a corrupted-but-plausible reference is worse than none");
  assert.equal(savedOrder()!.source, "facebook", "the channel is still recorded");
});

test("entry_method is always website and cannot be overridden", async () => {
  for (const attempt of ["manual", "", null, 123]) {
    const { savedOrder } = await submit(validBody({ entry_method: attempt, entryMethod: attempt }));
    assert.equal(savedOrder()!.entry_method, "website");
  }
});

// --- Fulfilment ------------------------------------------------------------------------------------------

test("a requested pickup time does NOT become fulfillment_at", async () => {
  // fulfillment_at is the AGREED handover time (S5). Nothing has been agreed at submission.
  const { savedOrder } = await submit(validBody({ requestedTime: "Saturday afternoon if possible" }));
  const order = savedOrder()!;

  assert.equal(order.fulfillment_at, null);
  assert.match(String(order.fulfillment_notes), /Saturday afternoon if possible/);
  assert.equal(order.fulfillment_method, "pickup");
  assert.equal(order.fulfillment_address, null);
});

test("pickup only -- no delivery can be requested", async () => {
  const { savedOrder } = await submit(validBody({ fulfillment_method: "delivery", fulfillmentMethod: "delivery", fulfillment_address: "12 Mabini St" }));
  const order = savedOrder()!;

  assert.equal(order.fulfillment_method, "pickup");
  assert.equal(order.fulfillment_address, null);
});

// --- Validation and limits ---------------------------------------------------------------------------------

test("name and phone are required", async () => {
  assert.equal((await submit(validBody({ customerName: "   " }))).outcome.kind, "invalid");
  assert.equal((await submit(validBody({ phone: "" }))).outcome.kind, "invalid");
  assert.equal((await submit(validBody({ customerName: undefined }))).outcome.kind, "invalid");
});

test("at least one item is required", async () => {
  assert.equal((await submit(validBody({ items: [] }))).outcome.kind, "invalid");
  assert.equal((await submit(validBody({ items: "not-an-array" }))).outcome.kind, "invalid");
});

test("non-integer, zero and negative quantities are rejected before any write", async () => {
  for (const quantity of [2.5, 0, -1, "3", null]) {
    const { outcome, recorded } = await submit(validBody({ items: [{ productId: "brownies", sellingFormatId: "fmt-6", quantity, displayedUnitPrice: 480 }] }));
    assert.equal(outcome.kind, "invalid", `quantity ${String(quantity)} must be rejected`);
    assert.equal(recorded.rpcCalls, 0);
  }
});

test("the per-line quantity ceiling is enforced", async () => {
  const { outcome } = await submit(validBody({ items: [{ productId: "brownies", sellingFormatId: "fmt-6", quantity: MAX_QUANTITY_PER_LINE + 1, displayedUnitPrice: 480 }] }));
  assert.equal(outcome.kind, "invalid");
});

test("the line-count ceiling is enforced", async () => {
  const items = Array.from({ length: MAX_LINES + 1 }, () => ({ productId: "brownies", sellingFormatId: "fmt-6", quantity: 1, displayedUnitPrice: 480 }));
  const { outcome, recorded } = await submit(validBody({ items }));
  assert.equal(outcome.kind, "invalid");
  assert.equal(recorded.rpcCalls, 0);
});

test("an over-long name is rejected", async () => {
  assert.equal((await submit(validBody({ customerName: "z".repeat(MAX_NAME_LENGTH + 1) }))).outcome.kind, "invalid");
});

test("a missing or unusable idempotency key is rejected", async () => {
  assert.equal((await submit(validBody({ idempotencyKey: "" }))).outcome.kind, "invalid");
  assert.equal((await submit(validBody({ idempotencyKey: undefined }))).outcome.kind, "invalid");
  assert.equal((await submit(validBody({ idempotencyKey: "z".repeat(101) }))).outcome.kind, "invalid");
});

test("a non-object body is rejected", async () => {
  for (const body of [null, "string", 42, []]) {
    assert.equal((await submit(body)).outcome.kind, "invalid");
  }
});

test("the honeypot silently accepts and writes nothing", async () => {
  const { outcome, recorded } = await submit(validBody({ trap: "bot@example.com" }));
  assert.deepEqual(outcome, { kind: "accepted" }, "a bot is told the same boring thing as everyone else");
  assert.equal(recorded.rpcCalls, 0);
  assert.equal(recorded.customerUpserts, 0);
});

// --- Customer -----------------------------------------------------------------------------------------------

test("the customer travels INSIDE the atomic call, never as a separate write", async () => {
  const { outcome, savedCustomer, recorded } = await submit(validBody({ customerName: "Maria Santos", phone: "09171234567" }));

  assert.equal(outcome.kind, "accepted");
  assert.equal(recorded.customerUpserts, 0, "no customer write may happen outside the transaction");
  const customer = savedCustomer()!;
  assert.equal(customer.name, "Maria Santos");
  assert.equal(customer.phone, "09171234567");
  // Only the fields the public form collects.
  assert.equal(customer.messaging_handle, null);
  assert.equal(customer.email, null);
});

test("the customer id is derived, so a retry reconciles onto the same row", async () => {
  assert.equal(await derivePublicCustomerId(KEY), await derivePublicCustomerId(KEY));
});

// --- Pure helpers -------------------------------------------------------------------------------------------

test("resolvePublicOrderLines builds line ids that are stable across retries", () => {
  const parsed = parsePublicOrderRequest(validBody());
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;

  const first = resolvePublicOrderLines(parsed.request, groups(), "550e8400-e29b-41d4-a716-446655440000");
  const second = resolvePublicOrderLines(parsed.request, groups(), "550e8400-e29b-41d4-a716-446655440000");
  assert.equal(first.ok && second.ok, true);
  if (!first.ok || !second.ok) return;

  assert.deepEqual(first.lines.map((l) => l.id), second.lines.map((l) => l.id));
  assert.match(first.lines[0].id, /^[0-9a-f-]{36}$/);
});

test("buildPublicOrder never emits a payment or lifecycle value", () => {
  const parsed = parsePublicOrderRequest(validBody());
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;

  const order = buildPublicOrder(parsed.request, { orderId: "o", customerId: "c", now: NOW });
  assert.equal(order.status, "new");
  assert.equal(order.paymentStatus, "unpaid");
  assert.equal(order.paidAmount, null);
  assert.equal(order.paidAt, null);
  assert.equal(order.refundedAt, null);
  assert.equal(order.paymentMethod, null);
  assert.equal(order.completedAt, null);
  assert.equal(order.cancelledAt, null);
  assert.equal(order.entryMethod, "website");
});

// --- Structural guarantees ------------------------------------------------------------------------------------

test("the server credential module is server-only and its secrets are not public", () => {
  const source = readFileSync(new URL("../src/lib/supabase-server.ts", import.meta.url), "utf8");

  assert.match(source.split("\n")[0], /^import "server-only";$/, "server-only must be the first line, so a client import is a build error");
  assert.equal(/NEXT_PUBLIC_[A-Z_]*(EMAIL|PASSWORD|SECRET|SERVICE)/.test(source), false, "credentials must never carry a NEXT_PUBLIC_ prefix");
  assert.match(source, /persistSession:\s*false/);
  assert.match(source, /autoRefreshToken:\s*false/);
  assert.match(source, /detectSessionInUrl:\s*false/);

  // Comments are stripped first, exactly as tests/orders-schema.test.ts does: this module DISCUSSES
  // service_role at length in order to explain why it is deliberately not used, and prose must not
  // be mistaken for implementation.
  const statements = source
    .split("\n")
    .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*") && !line.trim().startsWith("/*"))
    .join("\n");
  assert.equal(/service_role|SERVICE_ROLE/.test(statements), false, "no service-role credential is used");
});

test("no client module imports the server credential module or the API route", () => {
  const clientFiles = ["../src/components/orders-page.tsx", "../src/app/product-lab.tsx", "../src/components/product-controls.tsx"];
  for (const path of clientFiles) {
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    assert.equal(source.includes("supabase-server"), false, `${path} must not import the server client`);
    assert.equal(source.includes("api/public-orders"), false, `${path} must not import the route`);
  }
});

test("the route exposes only POST -- no order-status or lookup endpoint", () => {
  const route = readFileSync(new URL("../src/app/api/public-orders/route.ts", import.meta.url), "utf8");
  assert.match(route, /export async function POST/);
  for (const method of ["GET", "PUT", "PATCH", "DELETE"]) {
    assert.equal(new RegExp(`export (async )?function ${method}`).test(route), false, `${method} must not be exported -- a key is not a read credential`);
  }
});

test("the public error contract leaks no internal detail", () => {
  const route = readFileSync(new URL("../src/app/api/public-orders/route.ts", import.meta.url), "utf8");
  // The five stable classes, and nothing that forwards a database or auth message.
  for (const kind of ["accepted", "invalid", "prices-changed", "unavailable", "error"]) {
    assert.ok(route.includes(`"${kind}"`), `missing response class ${kind}`);
  }
  assert.equal(/error\.message|\.stack|console\.(log|error)/.test(route), false, "no internal message or log may reach the response");
});

test("F2 introduces no order-line editing, so M1 remains unreachable", () => {
  for (const path of ["../src/lib/public-order-service.ts", "../src/lib/orders/public-submission.ts", "../src/app/api/public-orders/route.ts", "../src/lib/public-catalog-repository.ts"]) {
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    assert.equal(/order_lines"\)\.(insert|update|upsert|delete)/.test(source), false, `${path} must not write order_lines directly`);
    assert.equal(source.includes("removedLineIds: ["), false, `${path} must not compute line removals`);
  }
});

test("F2 adds no anon grant, policy or schema change", () => {
  for (const path of ["../src/lib/public-order-service.ts", "../src/lib/supabase-server.ts", "../src/lib/public-catalog-repository.ts", "../src/app/api/public-orders/route.ts"]) {
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    assert.equal(/create policy|grant |revoke |alter table/i.test(source), false, `${path} must contain no DDL`);
  }
});

test("the payload ceiling is a real number the route enforces", () => {
  const route = readFileSync(new URL("../src/app/api/public-orders/route.ts", import.meta.url), "utf8");
  assert.ok(MAX_PAYLOAD_BYTES > 0);
  assert.match(route, /MAX_PAYLOAD_BYTES/);
  assert.match(route, /content-length/i);
});
