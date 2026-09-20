// Finished-stock readiness on the New order form and a selected NEW order. It is INFORMATIONAL:
// Place order is never blocked by stock, a new order reserves nothing, and confirm_order_with_reservation
// (exercised in tests/smoke/postgres/selling-wave-2-order-reservation.*) is the only hard gate.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describeDraftStockRow, describeOrderStockRow, getStockReadiness } from "../src/lib/orders/stock-readiness.ts";
import { buildLinesFromDrafts, CUSTOM_ITEM_KEY, getSellableItems, stepQuantity, type DraftLine } from "../src/lib/orders/menu.ts";
import { validateOrderForSave } from "../src/lib/orders/validation.ts";
import { submitNewOrder, type OrdersClient } from "../src/lib/orders-repository.ts";
import type { Order, OrderLine } from "../src/lib/orders/types.ts";
import type { CostingSummary, FinishedStockMovement, Product, ProductBatch, SellingFormat } from "../src/lib/product-lab-types.ts";

const PRODUCTS = [
  { id: "cookies", name: "Cookies" },
  { id: "brownies", name: "Brownies" },
];

function movement(productId: string, overrides: Partial<FinishedStockMovement> = {}): FinishedStockMovement {
  return { id: crypto.randomUUID(), productId, productionExecutionId: null, movementType: "production_receipt", onHandDelta: 0, reservedDelta: 0, operationId: crypto.randomUUID(), note: "", createdAt: "2026-09-01T00:00:00.000Z", ...overrides };
}

function stock(productId: string, onHand: number, reserved = 0): FinishedStockMovement[] {
  return [movement(productId, { onHandDelta: onHand }), ...(reserved > 0 ? [movement(productId, { movementType: "reserve", reservedDelta: reserved })] : [])];
}

function line(productId: string, quantity: number, piecesPerUnitSnapshot: number | null, sortOrder = 0): OrderLine {
  return { id: `line-${productId}-${sortOrder}`, orderId: "order-1", productId, sellingFormatId: "", itemName: productId || "Custom", unitPrice: 100, piecesPerUnitSnapshot, quantity, sortOrder, note: "" };
}

function only(readiness: ReturnType<typeof getStockReadiness>, productId: string) {
  const row = readiness.rows.find((entry) => entry.productId === productId);
  assert.ok(row, `expected a stock row for ${productId}`);
  return row;
}

// --- The numbers ---------------------------------------------------------------------------------

test("0 available and 2 needed shows a shortage of 2", () => {
  const row = only(getStockReadiness([line("cookies", 2, 1)], PRODUCTS, []), "cookies");
  assert.deepEqual([row.requiredPieces, row.availablePieces, row.shortPieces], [2, 0, 2]);
  assert.deepEqual(describeDraftStockRow(row), { summary: "2 pcs ordered · 0 available", outcome: "Need to bake 2", isShort: true });
});

test("6 available and 4 needed shows enough available", () => {
  const row = only(getStockReadiness([line("brownies", 2, 2)], PRODUCTS, stock("brownies", 6)), "brownies");
  assert.deepEqual([row.requiredPieces, row.availablePieces, row.shortPieces], [4, 6, 0]);
  assert.deepEqual(describeDraftStockRow(row), { summary: "4 pcs ordered · 6 available", outcome: "Enough available now", isShort: false });
});

test("existing reservations reduce what is available -- availablePieces, not raw on-hand", () => {
  // 10 on hand, 7 already reserved by confirmed orders: only 3 available.
  const row = only(getStockReadiness([line("cookies", 4, 1)], PRODUCTS, stock("cookies", 10, 7)), "cookies");
  assert.equal(row.availablePieces, 3);
  assert.equal(row.shortPieces, 1);
});

test("changing the quantity changes the pieces this order needs", () => {
  const movements = stock("cookies", 5);
  assert.equal(only(getStockReadiness([line("cookies", 1, 1)], PRODUCTS, movements), "cookies").requiredPieces, 1);
  assert.equal(only(getStockReadiness([line("cookies", 3, 1)], PRODUCTS, movements), "cookies").requiredPieces, 3);

  // Through the real draft path: the stepper's output feeds buildLinesFromDrafts and the readout.
  const groups = getSellableItems(
    [{ id: "cookies", name: "Cookies", category: "Bakery", role: "Hero candidate", status: "costed", description: "", image: "", decision: "Candidate", isPublic: false } as Product],
    [{ id: "b1", productId: "cookies", batchVersion: "V1", dateMade: "2026-08-01", ingredientsNotes: "", prepTimeMinutes: 0, bakeTimeMinutes: 0, coolingTimeMinutes: 0, usablePieces: 12, imperfectPieces: 0, stressLevel: 1, tasteNotes: "", textureNotes: "", wentWrong: "", improveNext: "", launchDecision: "launch" } as ProductBatch],
    [{ id: "c1", productId: "cookies", batchId: "b1" } as CostingSummary],
    [{ id: "f1", costingId: "c1", name: "2 cookies", piecesPerUnit: 2, sellingPrice: 100, isActive: true, sortOrder: 0, notes: "" } as SellingFormat],
  );
  const draft = (quantity: string): DraftLine => ({ rowId: "r1", itemKey: "cookies::f1", itemName: "", unitPrice: "100", quantity });
  const two = stepQuantity("1", 1);
  assert.equal(only(getStockReadiness(buildLinesFromDrafts([draft(two)], groups, "preview"), PRODUCTS, movements), "cookies").requiredPieces, 4);
  assert.equal(only(getStockReadiness(buildLinesFromDrafts([draft(stepQuantity(two, 1))], groups, "preview"), PRODUCTS, movements), "cookies").requiredPieces, 6);
});

test("a pack of 2 x quantity 2 needs 4 pieces", () => {
  assert.equal(only(getStockReadiness([line("brownies", 2, 2)], PRODUCTS, []), "brownies").requiredPieces, 4);
});

test("several lines of the same product are summed into ONE check, not judged independently", () => {
  // Single cookie x2 and x3, with only 4 in stock: one row needing 5, short by 1 -- not two rows that
  // each believe the same 4 pieces are theirs.
  const readiness = getStockReadiness([line("cookies", 2, 1, 0), line("cookies", 3, 1, 1)], PRODUCTS, stock("cookies", 4));
  assert.equal(readiness.rows.length, 1);
  assert.deepEqual([readiness.rows[0].requiredPieces, readiness.rows[0].availablePieces, readiness.rows[0].shortPieces], [5, 4, 1]);
});

test("different products are checked independently", () => {
  const readiness = getStockReadiness([line("cookies", 2, 1), line("brownies", 2, 2)], PRODUCTS, [...stock("cookies", 0), ...stock("brownies", 6)]);
  assert.deepEqual(readiness.rows.map((row) => [row.productName, row.shortPieces]), [["Brownies", 0], ["Cookies", 2]]);
});

test("a custom line invents no stock data, and a missing pack size is never assumed to be 1", () => {
  const custom = getStockReadiness([line("", 1, null)], PRODUCTS, stock("cookies", 9));
  assert.deepEqual(custom.rows, []);
  assert.equal(custom.hasUncheckedLines, true);

  // A product line with no recorded pack size contributes nothing rather than 1 piece.
  const unknownPack = getStockReadiness([line("cookies", 3, null)], PRODUCTS, stock("cookies", 9));
  assert.deepEqual(unknownPack.rows, []);
  assert.equal(unknownPack.hasUncheckedLines, true);

  // Mixed: the catalog line is still checked, the custom one is flagged as unchecked.
  const mixed = getStockReadiness([line("cookies", 2, 1, 0), line("", 1, null, 1)], PRODUCTS, stock("cookies", 9));
  assert.equal(mixed.rows.length, 1);
  assert.equal(mixed.hasUncheckedLines, true);
  assert.equal(getStockReadiness([line("cookies", 1, 1)], PRODUCTS, []).hasUncheckedLines, false);
});

test("an empty draft, or a zero quantity, produces no rows", () => {
  assert.deepEqual(getStockReadiness([], PRODUCTS, stock("cookies", 5)).rows, []);
  assert.deepEqual(getStockReadiness([line("cookies", 0, 1)], PRODUCTS, stock("cookies", 5)).rows, []);
});

test("a selected NEW order reads its persisted lines against current stock, in its own wording", () => {
  const readiness = getStockReadiness([line("brownies", 2, 2), line("cookies", 2, 1, 1)], PRODUCTS, [...stock("brownies", 2), ...stock("cookies", 5)]);
  const brownies = only(readiness, "brownies");
  const cookies = only(readiness, "cookies");
  assert.deepEqual(describeOrderStockRow(brownies), { summary: "Needs 4 pcs · 2 available", outcome: "Short 2 pcs", isShort: true });
  assert.deepEqual(describeOrderStockRow(cookies), { summary: "Needs 2 pcs · 5 available", outcome: "Enough available now", isShort: false });
});

test("the readout never mutates its inputs", () => {
  const lines = [line("cookies", 2, 1)];
  const movements = stock("cookies", 3);
  const frozen = JSON.stringify([lines, movements, PRODUCTS]);
  getStockReadiness(lines, PRODUCTS, movements);
  assert.equal(JSON.stringify([lines, movements, PRODUCTS]), frozen);
});

// --- Placing an order is never gated or changed by stock ---------------------------------------------

function newOrder(): Order {
  return {
    id: "order-1", customerId: "cust-1", status: "new", paymentStatus: "unpaid", paymentMethod: null, paidAt: null, paidAmount: null, refundedAt: null,
    fulfillmentMethod: "pickup", fulfillmentAt: null, fulfillmentAddress: "", fulfillmentNotes: "", source: "unknown", sourceRef: "", entryMethod: "manual", notes: "",
    placedAt: "2026-09-19T06:00:00.000Z", completedAt: null, cancelledAt: null, cancelReason: "", createdAt: "2026-09-19T06:00:00.000Z", updatedAt: "2026-09-19T06:00:00.000Z",
  };
}

test("Place order is allowed with zero stock: validation and submission do not consult stock", async () => {
  const lines = [line("cookies", 2, 1)];
  assert.equal(validateOrderForSave(newOrder(), lines), null);

  const rpcCalls: string[] = [];
  const otherCalls: string[] = [];
  const client = {
    rpc(name: string) { rpcCalls.push(name); return Promise.resolve({ data: null, error: null }); },
    from(table: string) { otherCalls.push(table); throw new Error(`unexpected table access: ${table}`); },
  } as unknown as OrdersClient;

  const result = await submitNewOrder(client, { order: newOrder(), lines: lines.map((entry) => ({ ...entry, orderId: "order-1" })), newCustomer: null, now: "2026-09-19T06:00:00.000Z" });
  assert.deepEqual(result, { ok: true });
  // The only thing written is the order itself: no confirm/reserve RPC, no stock table touched.
  assert.deepEqual(rpcCalls, ["save_order"]);
  assert.deepEqual(otherCalls, []);
});

test("the page's save path never reads stock, and nothing disables Confirm or Place order from it", () => {
  const source = readFileSync(new URL("../src/components/orders-page.tsx", import.meta.url), "utf8");
  const save = source.slice(source.indexOf("async function handleSave"), source.indexOf("async function handleSave") + 2500);

  assert.equal(save.length > 0 && save.includes("submitNewOrder"), true);
  assert.equal(/StockReadiness|finishedStockMovements|availablePieces/.test(save), false, "saving an order must not consult stock");
  assert.equal(/disabled=\{[^}]*[Ss]tock/.test(source), false, "no control may be disabled from loaded stock");
  // Confirm is still the same button, still routed to the database RPC.
  assert.match(source, /next === "confirmed" \? "Confirm"/);
  assert.match(readFileSync(new URL("../src/lib/orders-repository.ts", import.meta.url), "utf8"), /client\.rpc\("confirm_order_with_reservation"/);
});

test("the readout is shown for a NEW selected order only, and says stock is re-checked at Confirm", () => {
  const source = readFileSync(new URL("../src/components/orders-page.tsx", import.meta.url), "utf8");

  assert.match(source, /selectedOrder\?\.status === "new" \? getStockReadiness\(selectedLines, labState\.products, labState\.finishedStockMovements\) : null/);
  assert.match(source, /Availability is checked again when you Confirm\./);
  assert.match(source, /Stock is checked again when you Confirm the order\. Nothing is reserved until then\./);
  assert.match(source, /Stock not tracked for custom item\./);
  // No new query: the readout reads state the page already receives.
  assert.equal((source.match(/finished_stock_movements/g) ?? []).length, 0);
});

test("the readout reuses the existing stock and piece helpers instead of a second rule", () => {
  const source = readFileSync(new URL("../src/lib/orders/stock-readiness.ts", import.meta.url), "utf8")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");

  assert.match(source, /deriveFinishedStockBalances\(/);
  assert.match(source, /getPreparationByProduct\(/);
  assert.equal(/piecesPerUnitSnapshot\s*\*|quantity\s*\*/.test(source), false, "no local quantity x pieces arithmetic");
  assert.equal(/supabase|\.rpc\(|\.from\(/.test(source), false, "no database access");
});

test("the public ordering flow does not depend on finished stock", () => {
  for (const file of ["../src/lib/orders/public-menu.ts", "../src/lib/public-order-service.ts", "../src/lib/public-catalog-repository.ts", "../src/app/order/page.tsx"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.equal(/stock-readiness|finished-stock|finishedStock|availablePieces/.test(source), false, `${file} must not read finished stock`);
  }
  // Custom-only draft keeps working.
  assert.equal(getStockReadiness(buildLinesFromDrafts([{ rowId: "r", itemKey: CUSTOM_ITEM_KEY, itemName: "Delivery", unitPrice: "60", quantity: "1" }], [], "preview"), PRODUCTS, []).rows.length, 0);
});
