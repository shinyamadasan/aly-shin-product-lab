// Operations Dashboard V1: the view-model and the two calculations it adds.
//
// The properties worth defending, each asserted rather than trusted:
//
//   - Selling numbers ARE buildSellingSummary's numbers; the dashboard restates no formula.
//   - Reserved orders can never be counted a second time as demand (the finished-stock chaos test
//     replays a full Wave 2 ledger to prove it).
//   - A failed Orders read is contained: inventory and stock still build, and "caught up" is never
//     claimed over an order book that was never read.
//   - Healthy things stay hidden and busy things stay compact.
//   - Nothing is labelled profit, because nothing here can truthfully be.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildDashboardModel, INVENTORY_ROW_LIMIT, STOCK_ROW_LIMIT, type OrdersSnapshot } from "../src/lib/dashboard/model.ts";
import { buildFinishedStockDemand } from "../src/lib/dashboard/finished-stock-demand.ts";
import { buildInventoryExceptions } from "../src/lib/dashboard/inventory-exceptions.ts";
import { deriveFinishedStockBalances } from "../src/lib/finished-stock.ts";
import { toDisplayPrice } from "../src/lib/orders/money.ts";
import { buildSellingSummary } from "../src/lib/orders/summary.ts";
import type { Order, OrderLine, OrderStatus } from "../src/lib/orders/types.ts";
import type { CostingSummary, FinishedStockMovement, Ingredient, IngredientAlias, Product, ProductBatch, SellingFormat } from "../src/lib/product-lab-types.ts";

const MANILA = "Asia/Manila";
// 2026-08-08 12:00 Manila. Mid-day, so nothing depends on a boundary unless a test says so.
const NOW = Date.parse("2026-08-08T04:00:00.000Z");
const TODAY_NOON = "2026-08-08T04:00:00.000Z";
const LAST_WEEK = "2026-07-30T04:00:00.000Z";

const BROWNIE = { id: "product-brownie", name: "Premium Brownie" } as Product;
const BLONDIE = { id: "product-blondie", name: "Biscoff Blondie" } as Product;

function order(id: string, status: OrderStatus, overrides: Partial<Order> = {}): Order {
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
    placedAt: TODAY_NOON,
    completedAt: null,
    cancelledAt: null,
    cancelReason: "",
    createdAt: TODAY_NOON,
    updatedAt: TODAY_NOON,
    ...overrides,
  };
}

function line(orderId: string, overrides: Partial<OrderLine> = {}): OrderLine {
  return {
    id: `${orderId}-line`,
    orderId,
    productId: BROWNIE.id,
    sellingFormatId: "format-box-6",
    itemName: "Premium Brownie",
    unitPrice: 480,
    piecesPerUnitSnapshot: 6,
    quantity: 1,
    sortOrder: 0,
    note: "",
    ...overrides,
  };
}

function byOrder(lines: OrderLine[]): Map<string, OrderLine[]> {
  const map = new Map<string, OrderLine[]>();
  for (const entry of lines) {
    map.set(entry.orderId, [...(map.get(entry.orderId) ?? []), entry]);
  }
  return map;
}

function ready(orders: Order[], lines: OrderLine[] = []): OrdersSnapshot {
  return { status: "ready", orders, linesByOrderId: byOrder(lines), loadedAtMs: NOW };
}

function movement(productId: string, type: FinishedStockMovement["movementType"], onHandDelta: number, reservedDelta: number): FinishedStockMovement {
  return { id: crypto.randomUUID(), productId, productionExecutionId: "exec-1", movementType: type, onHandDelta, reservedDelta, operationId: crypto.randomUUID(), note: "", createdAt: TODAY_NOON };
}

function ingredient(overrides: Partial<Ingredient> = {}): Ingredient {
  return {
    id: crypto.randomUUID(),
    name: "Fresh Milk",
    baseUnit: "ml",
    category: "",
    currentQuantity: 1000,
    lowStockThreshold: 200,
    targetStockQuantity: 2000,
    nearestExpirationDate: "",
    averageUnitCost: 0,
    notes: "",
    isActive: true,
    ...overrides,
  };
}

const EMPTY_LAB = {
  products: [] as Product[],
  batches: [] as ProductBatch[],
  costings: [] as CostingSummary[],
  sellingFormats: [] as SellingFormat[],
  ingredients: [] as Ingredient[],
  ingredientAliases: [] as IngredientAlias[],
  finishedStockMovements: [] as FinishedStockMovement[],
};

// Operations UI Cleanup V1, Part A: Finished Stock & Demand eligibility is "has an active selling
// format" (orders/menu.ts's getSellableItems), not Product.status -- see finished-stock-demand.ts's
// own comment. getLinkedCosting falls back to "any costing recorded for the product" when there is no
// batch-linked one, so a bare costing + one active format is enough; no ProductBatch is required.
function sellableSetup(productId: string): { costings: CostingSummary[]; sellingFormats: SellingFormat[] } {
  const costingId = `costing-${productId}`;
  return {
    costings: [{
      id: costingId, productId, batchId: "", ingredientCost: 0, packagingCost: 0, laborEstimate: 0, waterCost: 0, gasCost: 0,
      ovenElectricCost: 0, refrigerationCost: 0, coffeeEquipmentCost: 0, wasteAllowance: 0, overheadCost: 0, equipmentCost: 0, suggestedPrice: 0, notes: "",
    }],
    sellingFormats: [{ id: `format-${productId}`, costingId, name: "Box of 6", piecesPerUnit: 6, sellingPrice: 480, isActive: true, sortOrder: 0, notes: "" }],
  };
}

// Merges sellableSetup() for several product ids into one { costings, sellingFormats } pair, for
// fixtures with more than one sellable product.
function sellableSetups(productIds: string[]): { costings: CostingSummary[]; sellingFormats: SellingFormat[] } {
  const setups = productIds.map(sellableSetup);
  return { costings: setups.flatMap((setup) => setup.costings), sellingFormats: setups.flatMap((setup) => setup.sellingFormats) };
}

// Dashboard Inventory Attention V1 (Current Recipes Only): a minimal current (non-voided, newest)
// batch whose formula uses exactly the given ingredients, one-to-one by exact name and base unit --
// enough for getCurrentRecipeIngredientIds to resolve each row without needing an alias.
function currentBatch(productId: string, ingredientsUsed: Ingredient[], overrides: Partial<ProductBatch> = {}): ProductBatch {
  return {
    id: crypto.randomUUID(),
    productId,
    batchVersion: "V1",
    status: "completed",
    dateMade: "2026-08-01",
    ingredientsNotes: JSON.stringify(ingredientsUsed.map((item) => ({ ingredient: item.name, quantity: 1, unit: item.baseUnit }))),
    prepTimeMinutes: 0,
    bakeTimeMinutes: 0,
    coolingTimeMinutes: 0,
    usablePieces: 0,
    imperfectPieces: 0,
    stressLevel: 0,
    tasteNotes: "",
    textureNotes: "",
    wentWrong: "",
    improveNext: "",
    launchDecision: "launch",
    ...overrides,
  };
}

// --- Canonical selling logic ----------------------------------------------------------------

test("selling metrics are buildSellingSummary's own output, not a second calculation", () => {
  const orders = [
    order("a", "new", { paymentStatus: "paid", paidAt: TODAY_NOON, paidAmount: 480 }),
    order("b", "confirmed", { paymentStatus: "paid", paidAt: LAST_WEEK, paidAmount: 900 }),
    order("c", "ready"),
  ];
  const lines = [line("a"), line("b", { unitPrice: 900 }), line("c", { unitPrice: 300 })];

  const model = buildDashboardModel({ labState: EMPTY_LAB, orders: ready(orders, lines), nowMs: NOW });
  const expected = buildSellingSummary({ orders, linesByOrderId: byOrder(lines), nowMs: NOW, timeZone: MANILA });

  // model.summary IS buildSellingSummary's own output -- Orders Workspace V1.1's Sales Analytics
  // zone (dashboard-page.tsx) and Unpaid callout both read this same object directly, via a
  // sibling useMemo (see sales-analytics-section.test.ts / dashboard-sales-analytics.test.ts),
  // rather than the model restating any of it under a different shape.
  assert.deepEqual(model.summary, expected);
  assert.equal(model.selling.status, "ready");
});

test("the dashboard modules reuse the canonical owners and restate none of their formulas", () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
  const modelSource = read("../src/lib/dashboard/model.ts");
  const demandSource = read("../src/lib/dashboard/finished-stock-demand.ts");
  const exceptionsSource = read("../src/lib/dashboard/inventory-exceptions.ts");
  const pageSource = read("../src/components/dashboard-page.tsx");

  assert.match(modelSource, /buildSellingSummary/);
  assert.match(demandSource, /deriveFinishedStockBalances/);
  assert.match(demandSource, /getPreparationByProduct/);
  assert.match(exceptionsSource, /getStockUrgencyStatus/);
  assert.match(exceptionsSource, /getExpiringIngredients/);
  assert.match(exceptionsSource, /getFlaggedIngredients/);

  // Revenue, attribution and fulfilment maths stay in their owners: the model composes the summary
  // and the page renders the model. Neither imports them.
  for (const [name, source] of [["model.ts", modelSource], ["dashboard-page.tsx", pageSource]] as const) {
    for (const forbidden of ["orders/revenue", "orders/attribution", "orders/fulfillment", "orders/pieces", "orders/totals"]) {
      assert.equal(source.includes(forbidden), false, `${name} must not import ${forbidden}`);
    }
  }
  // The page reads orders through the existing repository and nothing else.
  assert.match(pageSource, /listOrders/);
  assert.match(pageSource, /listOrderLines/);
});

// --- Zero and healthy states ----------------------------------------------------------------

test("zero orders, zero stock, zero ingredients: a calm, complete page rather than a broken one", () => {
  const model = buildDashboardModel({ labState: EMPTY_LAB, orders: ready([]), nowMs: NOW });

  assert.equal(model.selling.status, "ready");
  if (model.selling.status === "ready") {
    assert.equal(model.selling.hasOrders, false);
  }
  assert.deepEqual(model.attention.items, []);
  assert.equal(model.attention.isCaughtUp, true);
  assert.deepEqual(model.stock.rows, []);
  assert.deepEqual(model.inventory.rows, []);
  assert.equal(model.inventory.totalCount, 0);
});

test("everything healthy: nothing is listed and the page says it is caught up", () => {
  const orders = [order("done", "completed", { paymentStatus: "paid", paidAt: TODAY_NOON, paidAmount: 480, completedAt: TODAY_NOON })];
  const milk = ingredient();
  const model = buildDashboardModel({
    labState: {
      products: [BROWNIE],
      batches: [currentBatch(BROWNIE.id, [milk])],
      ...sellableSetup(BROWNIE.id),
      ingredients: [milk],
      ingredientAliases: [],
      finishedStockMovements: [movement(BROWNIE.id, "production_receipt", 24, 0)],
    },
    orders: ready(orders, [line("done")]),
    nowMs: NOW,
  });

  assert.deepEqual(model.attention.items, []);
  assert.equal(model.attention.isCaughtUp, true);
  assert.deepEqual(model.inventory.rows, []);
  // Healthy stock with nothing waiting on it is still a useful row.
  assert.equal(model.stock.rows.length, 1);
  assert.equal(model.stock.rows[0].shortagePieces, 0);
});

test("attention lists only what is non-zero, most urgent first, each linking to where it is handled", () => {
  const orders = [
    order("late", "confirmed", { fulfillmentAt: "2026-08-05T04:00:00.000Z" }),
    order("fresh", "new"),
    order("ready-1", "ready", { paymentStatus: "paid", paidAt: TODAY_NOON, paidAmount: 100 }),
  ];
  const model = buildDashboardModel({ labState: EMPTY_LAB, orders: ready(orders, [line("late", { unitPrice: 200 }), line("fresh", { unitPrice: 300 }), line("ready-1")]), nowMs: NOW });

  const keys = model.attention.items.map((item) => item.key);
  assert.deepEqual(keys, ["overdue", "new", "ready", "unpaid"]);
  assert.equal(model.attention.items.every((item) => item.count > 0), true);
  assert.equal(model.attention.items.every((item) => item.href === "/orders"), true);
  assert.equal(model.attention.isCaughtUp, false);
  const unpaid = model.attention.items.find((item) => item.key === "unpaid");
  assert.equal(unpaid?.value, `₱${toDisplayPrice(500)} outstanding`);
});

test("zero-count states never produce an item", () => {
  const model = buildDashboardModel({ labState: EMPTY_LAB, orders: ready([order("a", "completed")], [line("a")]), nowMs: NOW });
  assert.deepEqual(model.attention.items.filter((item) => item.key === "new" || item.key === "scheduling" || item.key === "overdue" || item.key === "ready"), []);
});

// --- Finished stock and demand ---------------------------------------------------------------

test("CHAOS: replaying a full Wave 2 ledger never counts reserved, fulfilled or cancelled orders as demand", () => {
  // The physical story, in ledger form:
  //   24 baked.
  //   Order A confirmed  -> reserve 10        (still reserved)
  //   Order B ready      -> reserve 6         (still reserved)
  //   Order C completed  -> reserve 6, fulfill 6 (left the building: on-hand AND reserved drop)
  //   Order D cancelled  -> reserve 4, release 4 (back in the pool)
  const movements: FinishedStockMovement[] = [
    movement(BROWNIE.id, "production_receipt", 24, 0),
    movement(BROWNIE.id, "reserve", 0, 10),
    movement(BROWNIE.id, "reserve", 0, 6),
    movement(BROWNIE.id, "reserve", 0, 6),
    movement(BROWNIE.id, "fulfill", -6, -6),
    movement(BROWNIE.id, "reserve", 0, 4),
    movement(BROWNIE.id, "release", 0, -4),
  ];
  const balance = deriveFinishedStockBalances([BROWNIE], movements)[0];
  assert.deepEqual([balance.onHandPieces, balance.reservedPieces, balance.availablePieces], [18, 16, 2]);

  // Every order status carries a line for the same product, 6 pieces each. Only the NEW one may count.
  const orders = [order("A", "confirmed"), order("B", "ready"), order("C", "completed"), order("D", "cancelled"), order("E", "new")];
  const lines = orders.map((entry) => line(entry.id));

  const { rows } = buildFinishedStockDemand({ products: [BROWNIE], batches: [], ...sellableSetup(BROWNIE.id), movements, orders, linesByOrderId: byOrder(lines) });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].availablePieces, 2);
  assert.equal(rows[0].reservedPieces, 16);
  assert.equal(rows[0].unreservedDemandPieces, 6, "only the new order is unreserved demand");
  assert.equal(rows[0].shortagePieces, 4, "6 wanted, 2 free");
  // What the double-count bug would have said: 6 + A + B + C + D = 30 wanted, 28 short.
  assert.notEqual(rows[0].shortagePieces, 28);
});

test("shortage is max(0, new-order demand - available): enough stock reports zero, never negative", () => {
  const movements = [movement(BROWNIE.id, "production_receipt", 30, 0)];
  const { rows } = buildFinishedStockDemand({ products: [BROWNIE], batches: [], ...sellableSetup(BROWNIE.id), movements, orders: [order("E", "new")], linesByOrderId: byOrder([line("E", { quantity: 2 })]) });
  assert.equal(rows[0].unreservedDemandPieces, 12);
  assert.equal(rows[0].shortagePieces, 0);
});

test("demand is per product, summed across every new order", () => {
  const movements = [movement(BROWNIE.id, "production_receipt", 10, 0), movement(BLONDIE.id, "production_receipt", 3, 0)];
  const orders = [order("1", "new"), order("2", "new")];
  const lines = [line("1"), line("2", { productId: BLONDIE.id, quantity: 2 })];
  const { rows } = buildFinishedStockDemand({ products: [BROWNIE, BLONDIE], batches: [], ...sellableSetups([BROWNIE.id, BLONDIE.id]), movements, orders, linesByOrderId: byOrder(lines) });

  const brownie = rows.find((row) => row.productId === BROWNIE.id);
  const blondie = rows.find((row) => row.productId === BLONDIE.id);
  assert.equal(brownie?.unreservedDemandPieces, 6);
  assert.equal(brownie?.shortagePieces, 0);
  assert.equal(blondie?.unreservedDemandPieces, 12);
  assert.equal(blondie?.shortagePieces, 9);
  // Most short first.
  assert.equal(rows[0].productId, BLONDIE.id);
});

test("manual lines are not stock-reservable, and an unknown pack size is reported rather than guessed", () => {
  const movements = [movement(BROWNIE.id, "production_receipt", 6, 0)];
  const lines = [
    line("E", { id: "manual", productId: "", sellingFormatId: "", itemName: "Custom gift pack", piecesPerUnitSnapshot: null, quantity: 3 }),
    line("E", { id: "unknown-pack", piecesPerUnitSnapshot: null, quantity: 2 }),
  ];
  const { rows, uncheckedLines } = buildFinishedStockDemand({ products: [BROWNIE], batches: [], ...sellableSetup(BROWNIE.id), movements, orders: [order("E", "new")], linesByOrderId: byOrder(lines) });

  assert.equal(rows[0].unreservedDemandPieces, 0, "neither line contributes invented pieces");
  assert.equal(uncheckedLines, 1, "only the product line with no pack size is 'unchecked'; the manual one was never stock-tracked");
});

test("a product with no stock and no demand still gets an explicit row; one with only demand is short (Part A completeness)", () => {
  const { rows } = buildFinishedStockDemand({
    products: [BROWNIE, BLONDIE],
    batches: [],
    ...sellableSetups([BROWNIE.id, BLONDIE.id]),
    movements: [],
    orders: [order("E", "new")],
    linesByOrderId: byOrder([line("E", { productId: BLONDIE.id })]),
  });
  // Most-short-first: BLONDIE (shortage 6) sorts ahead of BROWNIE (all zero), but BROWNIE must still
  // appear -- absence must never be mistaken for zero.
  assert.deepEqual(rows.map((row) => row.productId), [BLONDIE.id, BROWNIE.id]);
  assert.equal(rows[0].availablePieces, 0);
  assert.equal(rows[0].shortagePieces, 6);
  assert.deepEqual([rows[1].onHandPieces, rows[1].reservedPieces, rows[1].availablePieces, rows[1].unreservedDemandPieces, rows[1].shortagePieces], [0, 0, 0, 0, 0]);
});

test("no finished stock movements at all still renders one explicit zero row per current product, not an empty list (Part A completeness)", () => {
  const model = buildDashboardModel({ labState: { ...EMPTY_LAB, products: [BROWNIE, BLONDIE], ...sellableSetups([BROWNIE.id, BLONDIE.id]) }, orders: ready([]), nowMs: NOW });
  assert.equal(model.stock.rows.length, 2);
  assert.equal(model.stock.hiddenCount, 0);
  assert.equal(model.stock.rows.every((row) => row.onHandPieces === 0 && row.reservedPieces === 0 && row.unreservedDemandPieces === 0 && row.shortagePieces === 0), true);
});

test("only one active product still renders one clean row", () => {
  const model = buildDashboardModel({
    labState: { ...EMPTY_LAB, products: [BROWNIE], ...sellableSetup(BROWNIE.id), finishedStockMovements: [movement(BROWNIE.id, "production_receipt", 12, 0)] },
    orders: ready([order("E", "new")], [line("E")]),
    nowMs: NOW,
  });
  assert.equal(model.stock.rows.length, 1);
  assert.equal(model.stock.hiddenCount, 0);
});

test("a stock shortage becomes one attention item pointing at Bake", () => {
  const model = buildDashboardModel({
    labState: { ...EMPTY_LAB, products: [BROWNIE, BLONDIE], ...sellableSetups([BROWNIE.id, BLONDIE.id]), finishedStockMovements: [movement(BROWNIE.id, "production_receipt", 1, 0)] },
    orders: ready([order("1", "new"), order("2", "new")], [line("1"), line("2", { productId: BLONDIE.id })]),
    nowMs: NOW,
  });
  const shortage = model.attention.items.find((item) => item.key === "stock-shortage");
  assert.equal(shortage?.count, 2);
  assert.equal(shortage?.href, "/bake");
});

// Orders Workspace V1's shared sliceFinishedStockDemandRows caps model.stock.rows at
// STOCK_ROW_LIMIT, but shortageProducts (and therefore this attention item) must keep reading the
// UNSLICED demand.rows -- a shortage sitting past the row limit must still surface. This is the
// "slice after computing shortage, not before" ordering the shared extraction depends on.
test("a shortage beyond STOCK_ROW_LIMIT still counts toward the stock-shortage attention item", () => {
  const products = Array.from({ length: STOCK_ROW_LIMIT + 1 }, (_, index) => ({ id: `short-${index}`, name: `Short Product ${index}` }) as Product);
  const movements = products.map((product) => movement(product.id, "production_receipt", 1, 0));
  const orders = products.map((_, index) => order(`o${index}`, "new"));
  const lines = products.map((product, index) => line(`o${index}`, { productId: product.id, quantity: 3 }));

  const model = buildDashboardModel({
    labState: { ...EMPTY_LAB, products, ...sellableSetups(products.map((product) => product.id)), finishedStockMovements: movements },
    orders: ready(orders, lines),
    nowMs: NOW,
  });

  assert.equal(model.stock.rows.length, STOCK_ROW_LIMIT, "the glance view still caps at the row limit");
  const shortage = model.attention.items.find((item) => item.key === "stock-shortage");
  assert.equal(shortage?.count, STOCK_ROW_LIMIT + 1, "every shortage counts, including the one past the row limit");
});

// --- Failure containment ---------------------------------------------------------------------

test("unavailable Orders data: selling reports it, everything else still builds, and it is never 'caught up'", () => {
  const butter = ingredient({ name: "Butter", currentQuantity: 0 });
  const ingredients = [butter];
  const movements = [movement(BROWNIE.id, "production_receipt", 12, 0)];
  const model = buildDashboardModel({
    labState: { products: [BROWNIE], batches: [currentBatch(BROWNIE.id, [butter])], ...sellableSetup(BROWNIE.id), ingredients, ingredientAliases: [], finishedStockMovements: movements },
    orders: { status: "unavailable", reason: "failed", message: "network down" },
    nowMs: NOW,
  });

  assert.deepEqual(model.selling, { status: "unavailable", reason: "failed", message: "network down" });
  assert.equal(model.summary, null);
  assert.equal(model.attention.isCaughtUp, false);
  // Inventory and finished stock are unaffected.
  assert.equal(model.inventory.rows[0]?.name, "Butter");
  assert.equal(model.stock.rows.length, 1);
  assert.equal(model.stock.rows[0].availablePieces, 12);
  // ...but demand is UNKNOWN, which must not read as "none".
  assert.equal(model.stock.hasDemand, false);
  assert.equal(model.stock.rows[0].unreservedDemandPieces, null);
  assert.equal(model.stock.rows[0].shortagePieces, null);
  // Inventory attention still surfaces, and no order item is invented.
  assert.deepEqual(model.attention.items.map((item) => item.key), ["inventory"]);
});

test("while orders are still loading the page is not 'caught up' either", () => {
  const model = buildDashboardModel({ labState: EMPTY_LAB, orders: { status: "loading" }, nowMs: NOW });
  assert.equal(model.selling.status, "loading");
  assert.equal(model.attention.isCaughtUp, false);
});

test("every unavailable reason is carried through, including a database that is not configured", () => {
  for (const reason of ["missing-table", "failed", "not-configured"] as const) {
    const model = buildDashboardModel({ labState: EMPTY_LAB, orders: { status: "unavailable", reason, message: "x" }, nowMs: NOW });
    assert.equal(model.selling.status === "unavailable" ? model.selling.reason : null, reason);
  }
});

test("the page contains a thrown read as well as a reported one", () => {
  const source = readFileSync(new URL("../src/components/dashboard-page.tsx", import.meta.url), "utf8");
  assert.match(source, /catch \(error\)/);
  assert.match(source, /reason: "failed"/);
});

// --- Volume ----------------------------------------------------------------------------------

test("28+ orders, a dozen products and thirty low ingredients stay compact", () => {
  const products = Array.from({ length: 12 }, (_, index) => ({ id: `p${index}`, name: `Product ${String(index).padStart(2, "0")}` }) as Product);
  const movements = products.map((product) => movement(product.id, "production_receipt", 6, 0));
  const statuses: OrderStatus[] = ["new", "confirmed", "ready", "completed", "cancelled"];
  const orders = Array.from({ length: 40 }, (_, index) => order(`o${index}`, statuses[index % statuses.length]));
  const lines = orders.map((entry, index) => line(entry.id, { productId: products[index % products.length].id }));
  const ingredients = Array.from({ length: 30 }, (_, index) => ingredient({ name: `Ingredient ${String(index).padStart(2, "0")}`, currentQuantity: 0 }));
  // One current batch's formula uses all 30 -- Current Recipes Only must not itself narrow this list.
  const batches = [currentBatch(products[0].id, ingredients)];

  const model = buildDashboardModel({
    labState: { products, batches, ...sellableSetups(products.map((product) => product.id)), ingredients, ingredientAliases: [], finishedStockMovements: movements },
    orders: ready(orders, lines),
    nowMs: NOW,
  });

  // At most one attention row per kind, however many orders sit behind it.
  assert.equal(model.attention.items.length <= 7, true);
  assert.equal(model.stock.rows.length, STOCK_ROW_LIMIT);
  assert.equal(model.stock.hiddenCount, 12 - STOCK_ROW_LIMIT);
  assert.equal(model.inventory.rows.length, INVENTORY_ROW_LIMIT);
  assert.equal(model.inventory.hiddenCount, 30 - INVENTORY_ROW_LIMIT);
  assert.equal(model.inventory.totalCount, 30);
  // The inventory attention count is the true total, not the capped list.
  assert.equal(model.attention.items.find((item) => item.key === "inventory")?.count, 30);
});

// --- Inventory exceptions --------------------------------------------------------------------

test("only exceptions appear; an ingredient with two problems is one row with two reasons", () => {
  const all = [
    ingredient({ id: "healthy", name: "Flour" }),
    ingredient({ id: "low-and-expiring", name: "Cream", currentQuantity: 100, nearestExpirationDate: "2026-08-09" }),
    ingredient({ id: "out", name: "Butter", currentQuantity: 0 }),
    ingredient({ id: "archived", name: "Old Sugar", currentQuantity: 0, isActive: false }),
    ingredient({ id: "flagged", name: "Mystery", baseUnitMigrationFlaggedReason: "unrecognised unit" }),
  ];
  // This test is about reason-merging, not recipe filtering -- every ingredient is "current" so the
  // recipe gate itself contributes nothing here (see the "Current Recipes Only" section below).
  const rows = buildInventoryExceptions(all, "2026-08-08", new Set(all.map((item) => item.id)));

  assert.deepEqual(rows.map((row) => row.ingredientId), ["out", "low-and-expiring", "flagged"]);
  assert.deepEqual(rows[1].reasons.map((reason) => reason.kind), ["stock", "expiry"]);
});

test("expiry is judged against the Manila business day, not UTC", () => {
  // 01:00 Manila on 8 Aug is still 7 Aug in UTC. A UTC "today" would call an 8 Aug expiry
  // "expires soon" instead of "expires today" for the first eight hours of every working day.
  const earlyManila = Date.parse("2026-08-07T17:00:00.000Z");
  const cream = ingredient({ name: "Cream", nearestExpirationDate: "2026-08-08" });
  const model = buildDashboardModel({
    labState: { ...EMPTY_LAB, products: [BROWNIE], batches: [currentBatch(BROWNIE.id, [cream])], ingredients: [cream] },
    orders: ready([]),
    nowMs: earlyManila,
  });
  assert.equal(model.businessDay, "2026-08-08");
  const reason = model.inventory.rows[0].reasons[0];
  assert.equal(reason.kind === "expiry" ? reason.status : null, "expires-today");
});

// --- Current Recipes Only (Dashboard Inventory Attention V1) --------------------------------

test("Current Recipes Only: an ingredient retired from the current recipe never appears, even at zero stock", () => {
  // The historical formula used Coffee; the current batch replaced it with Chocolate Coins.
  const coffee = ingredient({ name: "100% Colombian Regular Instant Coffee", currentQuantity: 0, lowStockThreshold: 100 });
  const chocolateCoins = ingredient({ name: "Chocolate Coins", currentQuantity: 1786, lowStockThreshold: 220 });
  const model = buildDashboardModel({
    labState: {
      products: [BROWNIE],
      batches: [currentBatch(BROWNIE.id, [chocolateCoins])],
      costings: [],
      sellingFormats: [],
      ingredients: [coffee, chocolateCoins],
      ingredientAliases: [],
      finishedStockMovements: [],
    },
    orders: ready([]),
    nowMs: NOW,
  });
  assert.deepEqual(model.inventory.rows, []);
});

test("Current Recipes Only: a future-use ingredient not yet in any current recipe creates no alert, however low its stock", () => {
  const whiteChocolateCompound = ingredient({ name: "White Chocolate Compound", currentQuantity: 0, lowStockThreshold: 50 });
  const model = buildDashboardModel({
    labState: { ...EMPTY_LAB, products: [BROWNIE], batches: [], ingredients: [whiteChocolateCompound] },
    orders: ready([]),
    nowMs: NOW,
  });
  assert.deepEqual(model.inventory.rows, []);
});

test("Current Recipes Only: a current-recipe ingredient at Reorder Soon is included and labeled", () => {
  const cocoa = ingredient({ name: "Cocoa Powder", currentQuantity: 220, lowStockThreshold: 220 });
  const model = buildDashboardModel({
    labState: { products: [BROWNIE], batches: [currentBatch(BROWNIE.id, [cocoa])], costings: [], sellingFormats: [], ingredients: [cocoa], ingredientAliases: [], finishedStockMovements: [] },
    orders: ready([]),
    nowMs: NOW,
  });
  assert.deepEqual(model.inventory.rows.map((row) => row.name), ["Cocoa Powder"]);
  assert.deepEqual(model.inventory.rows[0].reasons, [{ kind: "stock", status: "reorder_soon" }]);
});

test("Current Recipes Only: a current-recipe ingredient at Critical is included and labeled", () => {
  const cocoa = ingredient({ name: "Cocoa Powder", currentQuantity: 110, lowStockThreshold: 220 });
  const model = buildDashboardModel({
    labState: { products: [BROWNIE], batches: [currentBatch(BROWNIE.id, [cocoa])], costings: [], sellingFormats: [], ingredients: [cocoa], ingredientAliases: [], finishedStockMovements: [] },
    orders: ready([]),
    nowMs: NOW,
  });
  assert.deepEqual(model.inventory.rows.map((row) => row.name), ["Cocoa Powder"]);
  assert.deepEqual(model.inventory.rows[0].reasons, [{ kind: "stock", status: "critical" }]);
});

test("Current Recipes Only: a current-recipe ingredient at zero stock is included, labeled Out of Stock", () => {
  const cocoa = ingredient({ name: "Cocoa Powder", currentQuantity: 0, lowStockThreshold: 220 });
  const model = buildDashboardModel({
    labState: { products: [BROWNIE], batches: [currentBatch(BROWNIE.id, [cocoa])], costings: [], sellingFormats: [], ingredients: [cocoa], ingredientAliases: [], finishedStockMovements: [] },
    orders: ready([]),
    nowMs: NOW,
  });
  assert.deepEqual(model.inventory.rows.map((row) => row.name), ["Cocoa Powder"]);
  assert.deepEqual(model.inventory.rows[0].reasons, [{ kind: "stock", status: "out_of_stock" }]);
});

test("Current Recipes Only: a Good current-recipe ingredient is excluded", () => {
  const cocoa = ingredient({ name: "Cocoa Powder", currentQuantity: 500, lowStockThreshold: 220 });
  const model = buildDashboardModel({
    labState: { products: [BROWNIE], batches: [currentBatch(BROWNIE.id, [cocoa])], costings: [], sellingFormats: [], ingredients: [cocoa], ingredientAliases: [], finishedStockMovements: [] },
    orders: ready([]),
    nowMs: NOW,
  });
  assert.deepEqual(model.inventory.rows, []);
});

test("Current Recipes Only: a current-recipe ingredient with no threshold configured is excluded -- never shown as Good or Out of Stock", () => {
  const cocoa = ingredient({ name: "Cocoa Powder", currentQuantity: 0, lowStockThreshold: 0 });
  const model = buildDashboardModel({
    labState: { products: [BROWNIE], batches: [currentBatch(BROWNIE.id, [cocoa])], costings: [], sellingFormats: [], ingredients: [cocoa], ingredientAliases: [], finishedStockMovements: [] },
    orders: ready([]),
    nowMs: NOW,
  });
  assert.deepEqual(model.inventory.rows, []);
});

test("Current Recipes Only: the Needs Attention inventory count exactly matches the qualifying (current-recipe, alerting) ingredients", () => {
  const critical = ingredient({ name: "Cocoa Powder", currentQuantity: 110, lowStockThreshold: 220 });
  const reorderSoon = ingredient({ name: "Butter", currentQuantity: 220, lowStockThreshold: 220 });
  const outOfStock = ingredient({ name: "Vanilla", currentQuantity: 0, lowStockThreshold: 50 });
  const good = ingredient({ name: "Sugar", currentQuantity: 500, lowStockThreshold: 220 });
  const notConfigured = ingredient({ name: "Salt", currentQuantity: 0, lowStockThreshold: 0 });
  const retired = ingredient({ name: "100% Colombian Regular Instant Coffee", currentQuantity: 0, lowStockThreshold: 100 });

  const model = buildDashboardModel({
    labState: {
      products: [BROWNIE],
      // The current recipe uses every ingredient except the retired one.
      batches: [currentBatch(BROWNIE.id, [critical, reorderSoon, outOfStock, good, notConfigured])],
      costings: [],
      sellingFormats: [],
      ingredients: [critical, reorderSoon, outOfStock, good, notConfigured, retired],
      ingredientAliases: [],
      finishedStockMovements: [],
    },
    orders: ready([]),
    nowMs: NOW,
  });

  assert.deepEqual(model.inventory.rows.map((row) => row.name).sort(), ["Butter", "Cocoa Powder", "Vanilla"]);
  assert.equal(model.inventory.totalCount, 3);
  assert.equal(model.attention.items.find((item) => item.key === "inventory")?.count, 3);
});

// --- Profit ----------------------------------------------------------------------------------

test("nothing on the dashboard is labelled profit, margin or cost", () => {
  // Deliberately absent. order_raw_cogs is ingredient-only cost for FULFILLED orders while revenue
  // here is cash received when paid, so the two cannot be honestly subtracted. If a verified Profit
  // slice ever lands (planning/DASHBOARD_PROFIT_V1.md), this test is the one to change on purpose.
  const model = buildDashboardModel({ labState: EMPTY_LAB, orders: ready([order("a", "new")], [line("a")]), nowMs: NOW });
  assert.equal(/profit|margin|cogs|cost/i.test(JSON.stringify(model)), false);

  const pageSource = readFileSync(new URL("../src/components/dashboard-page.tsx", import.meta.url), "utf8");
  // What the owner can actually see: quoted string literals and JSX text nodes, not comments or code.
  const userFacing = pageSource.match(/"(?:[^"\\]|\\.)*"|>[^<>{}\n]+</g) ?? [];
  assert.ok(userFacing.length > 0, "fixture is stale -- no user-facing strings found");
  for (const piece of userFacing) {
    assert.doesNotMatch(piece, /profit|margin|cogs/i, `profit language found: ${piece}`);
  }
  for (const file of ["../src/components/dashboard-page.tsx", "../src/lib/dashboard/model.ts", "../src/lib/dashboard/finished-stock-demand.ts", "../src/lib/dashboard/inventory-exceptions.ts"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.equal(/listOrderRawCogs|order_raw_cogs/.test(source.replace(/\/\/.*$/gm, "")), false, `${file} must not read raw COGS in code`);
  }
});

test("removed product-development panels are gone from the Dashboard but still live on their own pages", () => {
  const dashboard = readFileSync(new URL("../src/components/dashboard-page.tsx", import.meta.url), "utf8");
  for (const removed of ["ReadinessPanels", "Guardrails", "Coffee is not a hero", "Next Product Proof Day", "Launch-ready", "Taste entries", "Closest To Launch"]) {
    assert.equal(dashboard.includes(removed), false, `${removed} must not be on the Dashboard`);
  }
  const productLab = readFileSync(new URL("../src/app/product-lab.tsx", import.meta.url), "utf8");
  assert.match(productLab, /<ProductReadiness labState=\{labState\} \/>/, "Products still shows launch readiness");
  assert.match(productLab, /<ReadinessPanels labState=\{labState\} \/>/, "the Guide still shows the readiness panels");
});
