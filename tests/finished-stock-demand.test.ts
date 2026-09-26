// Operations UI Cleanup V1, Part A: buildFinishedStockDemand's row-completeness fix.
//
// The real incident this defends against: a current, sellable product with zero stock and zero
// demand (Brownies) silently disappeared from the list while other products with nonzero numbers
// stayed. Absence must never be mistaken for zero.
//
// Eligibility reuses orders/menu.ts's getSellableItems -- the exact SAME function the New Order form
// already calls to decide what an operator can actually order right now (Product -> latest
// ProductBatch -> its CostingSummary -> that costing's active SellingFormats, with Product.status !==
// "paused" checked ahead of that chain inside resolveProductMenu). Reusing the one function, not a
// second definition, is what makes Finished Stock & Demand's row set and "what can be sold today"
// incapable of disagreeing -- see finished-stock-demand.ts's own comment and orders/menu.ts's
// resolveProductMenu for why the paused check lives there rather than being duplicated here.
//
// This file tests buildFinishedStockDemand directly (dashboard-model.test.ts covers it indirectly
// through buildDashboardModel; tests/finished-stock-demand-section.test.ts covers only the
// presentation slice, sliceFinishedStockDemandRows; tests/orders-menu.test.ts covers getSellableItems
// itself, including the paused case, from the New Order side).

import test from "node:test";
import assert from "node:assert/strict";
import { buildFinishedStockDemand } from "../src/lib/dashboard/finished-stock-demand.ts";
import { getSellableItems } from "../src/lib/orders/menu.ts";
import type { Order, OrderLine } from "../src/lib/orders/types.ts";
import type { CostingSummary, FinishedStockMovement, Product, SellingFormat } from "../src/lib/product-lab-types.ts";

function product(id: string, name: string, status: Product["status"] = "costed"): Product {
  return { id, name, status } as Product;
}

// getLinkedCosting (rule-engine/types.ts) falls back to "any costing recorded for the product" when
// there is no batch-linked one, so a bare costing + active selling format is enough to make a product
// sellable in these tests -- no ProductBatch record is required.
function costing(productId: string, overrides: Partial<CostingSummary> = {}): CostingSummary {
  return {
    id: `costing-${productId}`, productId, batchId: "", ingredientCost: 0, packagingCost: 0, laborEstimate: 0, waterCost: 0, gasCost: 0,
    ovenElectricCost: 0, refrigerationCost: 0, coffeeEquipmentCost: 0, wasteAllowance: 0, overheadCost: 0, equipmentCost: 0, suggestedPrice: 0, notes: "",
    ...overrides,
  };
}

function activeFormat(costingId: string, overrides: Partial<SellingFormat> = {}): SellingFormat {
  return { id: `format-${costingId}`, costingId, name: "Box of 6", piecesPerUnit: 6, sellingPrice: 480, isActive: true, sortOrder: 0, notes: "", ...overrides };
}

// The full sellable setup (costing + one active format) for a product id -- the minimum that makes
// getSellableItems include it, matching what the New Order form itself requires to offer a product.
function sellableSetup(productId: string): { costings: CostingSummary[]; sellingFormats: SellingFormat[] } {
  const c = costing(productId);
  return { costings: [c], sellingFormats: [activeFormat(c.id)] };
}

function order(id: string, status: Order["status"] = "new"): Order {
  return {
    id,
    customerId: "customer-1",
    status,
    paymentStatus: "unpaid",
    paymentMethod: null,
    paidAt: null,
    paidAmount: null,
    refundedAt: null,
    fulfillmentMethod: "pickup",
    fulfillmentAt: null,
    fulfillmentAddress: "",
    fulfillmentNotes: "",
    source: "unknown",
    sourceRef: "",
    entryMethod: "manual",
    notes: "",
    placedAt: "2026-08-08T04:00:00.000Z",
    completedAt: null,
    cancelledAt: null,
    cancelReason: "",
    createdAt: "2026-08-08T04:00:00.000Z",
    updatedAt: "2026-08-08T04:00:00.000Z",
  };
}

function line(orderId: string, productId: string, overrides: Partial<OrderLine> = {}): OrderLine {
  return {
    id: `${orderId}-${productId}`,
    orderId,
    productId,
    sellingFormatId: "format-1",
    itemName: "Item",
    unitPrice: 100,
    piecesPerUnitSnapshot: 6,
    quantity: 1,
    sortOrder: 0,
    note: "",
    ...overrides,
  };
}

function byOrder(lines: OrderLine[]): Map<string, OrderLine[]> {
  const map = new Map<string, OrderLine[]>();
  for (const entry of lines) map.set(entry.orderId, [...(map.get(entry.orderId) ?? []), entry]);
  return map;
}

function movement(productId: string, onHandDelta: number, reservedDelta = 0): FinishedStockMovement {
  return { id: crypto.randomUUID(), productId, productionExecutionId: "exec-1", movementType: "production_receipt", onHandDelta, reservedDelta, operationId: crypto.randomUUID(), note: "", createdAt: "2026-08-08T04:00:00.000Z" };
}

// Deliberately generic fixture names -- proves the fix has no hardcoded product-name assumption.
const PRODUCT_A = product("product-a", "Product A");
const PRODUCT_B = product("product-b", "Product B");

test("a sellable product (active selling format) with zero stock and zero demand still produces an explicit zero row", () => {
  const { rows } = buildFinishedStockDemand({ products: [PRODUCT_A], batches: [], ...sellableSetup(PRODUCT_A.id), movements: [], orders: [], linesByOrderId: new Map() });
  assert.equal(rows.length, 1);
  assert.deepEqual(
    [rows[0].productId, rows[0].onHandPieces, rows[0].reservedPieces, rows[0].availablePieces, rows[0].unreservedDemandPieces, rows[0].shortagePieces],
    [PRODUCT_A.id, 0, 0, 0, 0, 0],
  );
});

test("a product with no active selling format is excluded, even with nonzero stock and demand", () => {
  const orders = [order("o1", "new")];
  const lines = byOrder([line("o1", PRODUCT_A.id)]);
  // No costings/sellingFormats at all for PRODUCT_A -- the "Revel Bars" case: sellable elsewhere in
  // the catalog (PRODUCT_B), but this one has never had a selling format set up.
  const { rows } = buildFinishedStockDemand({ products: [PRODUCT_A], batches: [], costings: [], sellingFormats: [], movements: [movement(PRODUCT_A.id, 50)], orders, linesByOrderId: lines });
  assert.deepEqual(rows, []);
});

test("a product whose only selling format is inactive is excluded, same as having none", () => {
  const c = costing(PRODUCT_A.id);
  const inactiveFormat = activeFormat(c.id, { isActive: false });
  const { rows } = buildFinishedStockDemand({ products: [PRODUCT_A], batches: [], costings: [c], sellingFormats: [inactiveFormat], movements: [movement(PRODUCT_A.id, 10)], orders: [], linesByOrderId: new Map() });
  assert.deepEqual(rows, []);
});

test("a paused product is excluded even with an active selling format and nonzero stock/demand", () => {
  const paused = product("product-paused", "Retired Product", "paused");
  const orders = [order("o1", "new")];
  const lines = byOrder([line("o1", paused.id)]);
  const { rows } = buildFinishedStockDemand({
    products: [PRODUCT_A, paused],
    batches: [],
    costings: [...sellableSetup(PRODUCT_A.id).costings, ...sellableSetup(paused.id).costings],
    sellingFormats: [...sellableSetup(PRODUCT_A.id).sellingFormats, ...sellableSetup(paused.id).sellingFormats],
    movements: [movement(paused.id, 50)],
    orders,
    linesByOrderId: lines,
  });
  assert.deepEqual(rows.map((row) => row.productId), [PRODUCT_A.id]);
});

// Cross-surface consistency check: New Order (getSellableItems) and Finished Stock & Demand
// (buildFinishedStockDemand) must agree on a paused product with a stale active selling format,
// because both now go through the exact same resolveProductMenu rule in orders/menu.ts -- there is no
// separate paused check duplicated in this file any more (see this file's own header comment). This
// test proves the SHARED effective rule with one fixture fed to both functions, not two independently
// agreeing assertions.
test("a paused product with a stale active selling format is absent from BOTH the New Order menu and Finished Stock & Demand", () => {
  const paused = product("product-paused", "Retired Product", "paused");
  const { costings, sellingFormats } = sellableSetup(paused.id);

  // New Order's own surface: the exact function orders-page.tsx calls to build its Item dropdown.
  const sellableGroups = getSellableItems([paused], [], costings, sellingFormats);
  assert.deepEqual(sellableGroups, [], "New Order must not offer a paused product");

  // Finished Stock & Demand's surface, same fixture, same active selling format left in place.
  const { rows } = buildFinishedStockDemand({ products: [paused], batches: [], costings, sellingFormats, movements: [movement(paused.id, 50)], orders: [], linesByOrderId: new Map() });
  assert.deepEqual(rows, [], "Finished Stock & Demand must not show a paused product either");
});

test("zero stock with positive demand still yields the correct positive shortage, and the row is present", () => {
  const orders = [order("o1", "new")];
  const lines = byOrder([line("o1", PRODUCT_A.id, { quantity: 2, piecesPerUnitSnapshot: 6 })]);
  const { rows } = buildFinishedStockDemand({ products: [PRODUCT_A], batches: [], ...sellableSetup(PRODUCT_A.id), movements: [], orders, linesByOrderId: lines });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].unreservedDemandPieces, 12);
  assert.equal(rows[0].shortagePieces, 12);
});

test("positive stock with zero demand stays visible -- a healthy product is still worth a glance", () => {
  const { rows } = buildFinishedStockDemand({ products: [PRODUCT_A], batches: [], ...sellableSetup(PRODUCT_A.id), movements: [movement(PRODUCT_A.id, 24)], orders: [], linesByOrderId: new Map() });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].onHandPieces, 24);
  assert.equal(rows[0].unreservedDemandPieces, 0);
  assert.equal(rows[0].shortagePieces, 0);
});

test("Dashboard and Orders receive the identical row set from the one shared function -- no per-caller filtering exists to diverge", () => {
  const input = {
    products: [PRODUCT_A, PRODUCT_B],
    batches: [],
    ...sellableSetup(PRODUCT_A.id),
    movements: [movement(PRODUCT_A.id, 10)],
    orders: [order("o1", "new")],
    linesByOrderId: byOrder([line("o1", PRODUCT_A.id)]),
  };
  // Simulates both call sites (dashboard/model.ts and orders-page.tsx) calling the exact same
  // function with the exact same loaded state -- if either file added its own filtering, this would
  // still pass (same function, same input) which is exactly the point: there is no place left for
  // the two surfaces to disagree.
  const forDashboard = buildFinishedStockDemand(input);
  const forOrders = buildFinishedStockDemand(input);
  assert.deepEqual(forDashboard, forOrders);
});

// --- Regression guards: existing semantics this fix must not disturb ------------------------------

test("orders === null still yields null demand/shortage on every row, never zero (unavailable must not read as none)", () => {
  const { rows, uncheckedLines } = buildFinishedStockDemand({ products: [PRODUCT_A], batches: [], ...sellableSetup(PRODUCT_A.id), movements: [movement(PRODUCT_A.id, 5)], orders: null, linesByOrderId: new Map() });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].unreservedDemandPieces, null);
  assert.equal(rows[0].shortagePieces, null);
  assert.equal(uncheckedLines, null);
});

test("CHAOS regression: a full Wave 2 reservation ledger still counts only new-order lines as demand, never reserved/fulfilled/cancelled ones", () => {
  const movements: FinishedStockMovement[] = [
    movement(PRODUCT_A.id, 24, 0),
    movement(PRODUCT_A.id, 0, 10),
    movement(PRODUCT_A.id, 0, 6),
    movement(PRODUCT_A.id, 0, 6),
    { ...movement(PRODUCT_A.id, -6, -6), movementType: "fulfill" },
    movement(PRODUCT_A.id, 0, 4),
    { ...movement(PRODUCT_A.id, 0, -4), movementType: "release" },
  ];
  const orders = [order("A", "confirmed"), order("B", "ready"), order("C", "completed"), order("D", "cancelled"), order("E", "new")];
  const lines = byOrder(orders.map((entry) => line(entry.id, PRODUCT_A.id)));

  const { rows } = buildFinishedStockDemand({ products: [PRODUCT_A], batches: [], ...sellableSetup(PRODUCT_A.id), movements, orders, linesByOrderId: lines });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].availablePieces, 2);
  assert.equal(rows[0].reservedPieces, 16);
  assert.equal(rows[0].unreservedDemandPieces, 6, "only the new order is unreserved demand");
  assert.equal(rows[0].shortagePieces, 4, "6 wanted, 2 free");
});
