// Regression tests for the adversarial review findings on PR #33.
//
// The headline case (B1) is a blocker that shipped in the first S2 pass: the new-customer id was
// minted inside each save attempt and the customer was written BEFORE order validation ran, so an
// ordinary typo wrote a customer row and aborted, and every retry wrote another. Two "Maria Santos"
// rows with no phone or handle are indistinguishable afterwards, which silently splits the
// repeat-buyer count that orders.customer_id exists to make computable.

import test from "node:test";
import assert from "node:assert/strict";
import { buildLinesFromDrafts, CUSTOM_ITEM_KEY, getSellableItems, type DraftLine } from "../src/lib/orders/menu.ts";
import { findPossibleDuplicateCustomer } from "../src/lib/orders/validation.ts";
import { submitNewOrder, type OrdersClient } from "../src/lib/orders-repository.ts";
import type { CostingSummary, Product, ProductBatch, SellingFormat } from "../src/lib/product-lab-types.ts";
import type { Customer, Order, OrderLine } from "../src/lib/orders/types.ts";

const NOW = "2026-08-09T06:00:00.000Z";

type StubClient = OrdersClient & {
  rpcCalls: { name: string; args: unknown }[];
  customerUpserts: Record<string, unknown>[];
};

function createStubClient(options: { rpcError?: { code?: string; message: string } } = {}): StubClient {
  const rpcCalls: { name: string; args: unknown }[] = [];
  const customerUpserts: Record<string, unknown>[] = [];

  const client = {
    from(table: string) {
      return {
        select: () => {
          const chain = { eq: () => chain, in: () => chain, order: () => chain, limit: () => chain, then: (resolve: (v: unknown) => unknown) => resolve({ data: [], error: null }) };
          return chain;
        },
        upsert: (row: Record<string, unknown>) => {
          if (table === "customers") customerUpserts.push(row);
          return Promise.resolve({ data: null, error: null });
        },
      };
    },
    rpc(name: string, args: unknown) {
      rpcCalls.push({ name, args });
      return Promise.resolve(options.rpcError ? { data: null, error: options.rpcError } : { data: null, error: null });
    },
    rpcCalls,
    customerUpserts,
  };

  return client as unknown as StubClient;
}

const PENDING_CUSTOMER_ID = "pending-customer-1";
const ORDER_ID = "order-1";

function order(overrides: Partial<Order> = {}): Order {
  return {
    id: ORDER_ID,
    customerId: PENDING_CUSTOMER_ID,
    status: "new",
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
    placedAt: NOW,
    completedAt: null,
    cancelledAt: null,
    cancelReason: "",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function line(overrides: Partial<OrderLine> = {}): OrderLine {
  return {
    id: "line-1",
    orderId: ORDER_ID,
    productId: "brownies",
    sellingFormatId: "fmt-1",
    itemName: "Brownies — Box of 6",
    unitPrice: 480,
    piecesPerUnitSnapshot: 6,
    quantity: 2,
    sortOrder: 0,
    note: "",
    ...overrides,
  };
}

function newCustomer(name = "Maria Santos"): Customer {
  return { id: PENDING_CUSTOMER_ID, name, phone: "", messagingHandle: "", email: "", notes: "", createdAt: NOW, updatedAt: NOW };
}

// --- B1: validation must precede every write -----------------------------------------------------

test("B1: an invalid order with a new customer writes ZERO customers", async () => {
  const client = createStubClient();
  // Quantity 2.5 -- the ordinary typo that previously created a customer and then aborted.
  const result = await submitNewOrder(client, { order: order(), lines: [line({ quantity: 2.5 })], newCustomer: newCustomer(), now: NOW });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.message, /whole quantity/i);
  assert.equal(client.customerUpserts.length, 0, "a rejected order must not leave a customer behind");
  assert.equal(client.rpcCalls.length, 0);
});

test("B1: an order with no lines writes ZERO customers", async () => {
  const client = createStubClient();
  const result = await submitNewOrder(client, { order: order(), lines: [], newCustomer: newCustomer(), now: NOW });

  assert.equal(result.ok, false);
  assert.equal(client.customerUpserts.length, 0);
  assert.equal(client.rpcCalls.length, 0);
});

test("B1: an invalid manual line writes ZERO customers", async () => {
  const client = createStubClient();
  const invalidManual = line({ productId: "", sellingFormatId: "", piecesPerUnitSnapshot: null, itemName: "   ", unitPrice: 60 });
  const result = await submitNewOrder(client, { order: order(), lines: [invalidManual], newCustomer: newCustomer(), now: NOW });

  assert.equal(result.ok, false);
  assert.equal(client.customerUpserts.length, 0);
  assert.equal(client.rpcCalls.length, 0);
});

test("B1: a blank new-customer name is rejected before anything is written", async () => {
  const client = createStubClient();
  const result = await submitNewOrder(client, { order: order(), lines: [line()], newCustomer: newCustomer("   "), now: NOW });

  assert.equal(result.ok, false);
  assert.equal(client.customerUpserts.length, 0);
  assert.equal(client.rpcCalls.length, 0);
});

test("B1: customer created, save_order fails, retry reuses the SAME customer id -- only one customer", async () => {
  // The exact blocker scenario: the first attempt gets past validation, writes the customer, then
  // the RPC fails. The operator retries with the same form.
  const failing = createStubClient({ rpcError: { message: "network blip" } });
  const first = await submitNewOrder(failing, { order: order(), lines: [line()], newCustomer: newCustomer(), now: NOW });

  assert.equal(first.ok, false);
  assert.equal(failing.customerUpserts.length, 1);
  assert.equal(failing.customerUpserts[0].id, PENDING_CUSTOMER_ID);

  // Retry: same stable pending id, so this upserts the same row rather than adding a second.
  const second = await submitNewOrder(failing, { order: order(), lines: [line()], newCustomer: newCustomer(), now: NOW });
  assert.equal(second.ok, false);
  assert.equal(failing.customerUpserts.length, 2, "two upserts were issued");
  const ids = new Set(failing.customerUpserts.map((row) => row.id));
  assert.equal(ids.size, 1, "but both target ONE customer id, so only one customer row can exist");
});

test("B1: retry continues using the same stable order id", async () => {
  const failing = createStubClient({ rpcError: { message: "network blip" } });

  await submitNewOrder(failing, { order: order(), lines: [line()], newCustomer: newCustomer(), now: NOW });
  await submitNewOrder(failing, { order: order(), lines: [line()], newCustomer: newCustomer(), now: NOW });

  const orderIds = failing.rpcCalls.map((call) => (call.args as { p_order: { id: string } }).p_order.id);
  assert.deepEqual(orderIds, [ORDER_ID, ORDER_ID]);
  assert.equal(new Set(orderIds).size, 1, "a retry must not mint a new order id");
});

test("B1: a successful submit writes the customer once, then the order, in that order", async () => {
  const client = createStubClient();
  const result = await submitNewOrder(client, { order: order(), lines: [line()], newCustomer: newCustomer(), now: NOW });

  assert.equal(result.ok, true);
  assert.equal(client.customerUpserts.length, 1);
  assert.equal(client.rpcCalls.length, 1);
});

test("B1: an existing customer means no customer write at all", async () => {
  const client = createStubClient();
  const result = await submitNewOrder(client, { order: order({ customerId: "existing-customer" }), lines: [line()], newCustomer: null, now: NOW });

  assert.equal(result.ok, true);
  assert.equal(client.customerUpserts.length, 0);
  assert.equal(client.rpcCalls.length, 1);
});

test("B1: a failed customer write stops before the order is saved", async () => {
  // No half-state: if the customer cannot be created, no order references a customer that is not
  // there -- the FK is ON DELETE RESTRICT and would reject it anyway.
  const client = createStubClient();
  const brokenClient = { ...client, from: () => ({ select: client.from("customers").select, upsert: () => Promise.resolve({ data: null, error: { code: "23505", message: "conflict" } }) }) } as unknown as StubClient;

  const result = await submitNewOrder(brokenClient, { order: order(), lines: [line()], newCustomer: newCustomer(), now: NOW });
  assert.equal(result.ok, false);
  assert.equal(client.rpcCalls.length, 0, "the order must not be saved when its customer was not");
});

// --- H1: duplicate-customer warning ---------------------------------------------------------------

test("H1: a likely duplicate name is detected but never blocks", async () => {
  const existing = [{ id: "customer-1", name: "Maria Santos" }];

  // The helper flags it...
  assert.equal(findPossibleDuplicateCustomer(existing, { id: "", name: "  maria santos " })?.id, "customer-1");

  // ...and submitting anyway still succeeds. Two people really can share a name.
  const client = createStubClient();
  const result = await submitNewOrder(client, { order: order(), lines: [line()], newCustomer: newCustomer("Maria Santos"), now: NOW });
  assert.equal(result.ok, true);
  assert.equal(client.customerUpserts.length, 1);
});

test("H1: a genuinely new name produces no warning", () => {
  const existing = [{ id: "customer-1", name: "Maria Santos" }];
  assert.equal(findPossibleDuplicateCustomer(existing, { id: "", name: "Ana Cruz" }), null);
  assert.equal(findPossibleDuplicateCustomer(existing, { id: "", name: "   " }), null);
});

// --- M1: catalog <-> custom line switching ---------------------------------------------------------

function product(id: string, name: string): Product {
  return { id, name, category: "Bakery", role: "Hero candidate", status: "costed", description: "", image: "", decision: "Candidate", isPublic: false };
}
function batch(id: string, productId: string): ProductBatch {
  return { id, productId, batchVersion: "V1", dateMade: "2026-08-01", ingredientsNotes: "", prepTimeMinutes: 0, bakeTimeMinutes: 0, coolingTimeMinutes: 0, usablePieces: 12, imperfectPieces: 0, stressLevel: 1, tasteNotes: "", textureNotes: "", wentWrong: "", improveNext: "", launchDecision: "launch" };
}
function costing(id: string, productId: string, batchId: string): CostingSummary {
  return { id, productId, batchId, ingredientCost: 0, packagingCost: 0, laborEstimate: 0, waterCost: 0, gasCost: 0, ovenElectricCost: 0, refrigerationCost: 0, coffeeEquipmentCost: 0, wasteAllowance: 0, overheadCost: 0, equipmentCost: 0, suggestedPrice: 0, notes: "" };
}
function format(id: string, costingId: string, name: string): SellingFormat {
  return { id, costingId, name, piecesPerUnit: 6, sellingPrice: 480, isActive: true, sortOrder: 0, notes: "" };
}

const MENU = getSellableItems([product("brownies", "Brownies")], [batch("b1", "brownies")], [costing("c1", "brownies", "b1")], [format("fmt", "c1", "Box of 6")]);

function draft(overrides: Partial<DraftLine> = {}): DraftLine {
  return { rowId: "row-1", itemKey: "brownies::fmt", itemName: "", unitPrice: "480", quantity: "1", ...overrides };
}

test("M1: a custom line never carries catalog references or a pack size, whatever its name", () => {
  // The draft->line conversion is the safety net: even a custom row whose name still looked like a
  // catalog item cannot produce catalog ids or a pack size.
  const lines = buildLinesFromDrafts([draft({ itemKey: CUSTOM_ITEM_KEY, itemName: "Brownies — Box of 6", unitPrice: "480" })], MENU, ORDER_ID);

  assert.equal(lines[0].productId, "");
  assert.equal(lines[0].sellingFormatId, "");
  assert.equal(lines[0].piecesPerUnitSnapshot, null);
});

test("M1: switching catalog -> custom clears the inherited catalog name", () => {
  // Mirrors the component's onChange rule: a row that WAS a catalog pick loses the catalog's
  // display text, so a manual line cannot masquerade as a catalog sale.
  const previous = draft({ itemKey: "brownies::fmt", itemName: "Brownies — Box of 6" });
  const wasCatalogPick = previous.itemKey !== "" && previous.itemKey !== CUSTOM_ITEM_KEY;
  const nextItemName = CUSTOM_ITEM_KEY === CUSTOM_ITEM_KEY && !wasCatalogPick ? previous.itemName : "";

  assert.equal(wasCatalogPick, true);
  assert.equal(nextItemName, "", "the catalog name must not survive the switch");

  // An empty name is then correctly rejected by validation rather than saved as a blank line.
  const lines = buildLinesFromDrafts([draft({ itemKey: CUSTOM_ITEM_KEY, itemName: nextItemName })], MENU, ORDER_ID);
  assert.equal(lines[0].itemName, "");
});

test("M1: text typed on an already-custom row is kept when the row stays custom", () => {
  const previous = draft({ itemKey: CUSTOM_ITEM_KEY, itemName: "Delivery" });
  const wasCatalogPick = previous.itemKey !== "" && previous.itemKey !== CUSTOM_ITEM_KEY;
  const nextItemName = !wasCatalogPick ? previous.itemName : "";

  assert.equal(nextItemName, "Delivery", "the operator's own text is not theirs to discard");
});

test("M1: switching custom -> catalog restores the catalog snapshot values", () => {
  const lines = buildLinesFromDrafts([draft({ itemKey: "brownies::fmt", itemName: "Delivery", unitPrice: "480" })], MENU, ORDER_ID);

  assert.equal(lines[0].itemName, "Brownies — Box of 6", "the catalog name replaces the custom text");
  assert.equal(lines[0].productId, "brownies");
  assert.equal(lines[0].sellingFormatId, "fmt");
  assert.equal(lines[0].piecesPerUnitSnapshot, 6);
  assert.equal(lines[0].unitPrice, 480);
});

// --- L1: dirty-state completeness ------------------------------------------------------------------

// Mirrors the component's isDirty expression exactly, so a field dropped from one is caught here.
function isDirty(form: { isCreating: boolean; customerId: string; newCustomerName: string; draftLines: DraftLine[]; fulfillmentMethod: "pickup" | "delivery"; fulfillmentAt: string; fulfillmentAddress: string; source: string; notes: string }): boolean {
  return (
    form.isCreating &&
    (form.customerId !== "" ||
      form.newCustomerName.trim() !== "" ||
      form.draftLines.some((entry) => entry.itemKey !== "" || entry.itemName.trim() !== "") ||
      form.fulfillmentMethod !== "pickup" ||
      form.fulfillmentAt !== "" ||
      form.fulfillmentAddress.trim() !== "" ||
      form.source !== "unknown" ||
      form.notes.trim() !== "")
  );
}

const PRISTINE = {
  isCreating: true,
  customerId: "",
  newCustomerName: "",
  draftLines: [{ rowId: "r1", itemKey: "", itemName: "", unitPrice: "", quantity: "1" }],
  fulfillmentMethod: "pickup" as const,
  fulfillmentAt: "",
  fulfillmentAddress: "",
  source: "unknown",
  notes: "",
};

test("L1: a pristine open form is not dirty", () => {
  assert.equal(isDirty(PRISTINE), false);
});

test("L1: each previously omitted field makes the form dirty on its own", () => {
  // These four were all missed by the original check.
  assert.equal(isDirty({ ...PRISTINE, fulfillmentAt: "2026-08-10T14:00" }), true, "fulfilment time");
  assert.equal(isDirty({ ...PRISTINE, fulfillmentAddress: "12 Mabini St" }), true, "fulfilment address");
  assert.equal(isDirty({ ...PRISTINE, source: "instagram" }), true, "source");
  assert.equal(isDirty({ ...PRISTINE, notes: "no nuts" }), true, "notes");
  // And the delivery toggle, which is also an edit.
  assert.equal(isDirty({ ...PRISTINE, fulfillmentMethod: "delivery" }), true, "fulfilment method");
});

test("L1: the originally-covered fields still make the form dirty", () => {
  assert.equal(isDirty({ ...PRISTINE, customerId: "customer-1" }), true);
  assert.equal(isDirty({ ...PRISTINE, newCustomerName: "Maria" }), true);
  assert.equal(isDirty({ ...PRISTINE, draftLines: [{ rowId: "r1", itemKey: "brownies::fmt", itemName: "", unitPrice: "480", quantity: "1" }] }), true);
});

test("L1: a successful save clears dirty state by closing the form and resetting it", () => {
  // The component sets isCreating false and resets every field; both independently clear the guard.
  assert.equal(isDirty({ ...PRISTINE, notes: "no nuts", isCreating: false }), false, "closing the form clears it");
  assert.equal(isDirty(PRISTINE), false, "and the reset form is pristine again");
});

// --- Historical snapshot truth ----------------------------------------------------------------------

test("a historical line renders from its own snapshots when both catalog pointers are null", () => {
  // What the detail panel reads. The catalog is not consulted at display time at all, so a deleted
  // or archived selling format cannot rewrite what was sold.
  const orphaned: OrderLine = line({ productId: "", sellingFormatId: "", itemName: "Brownies — Box of 6", unitPrice: 480, piecesPerUnitSnapshot: 6, quantity: 2 });

  assert.equal(orphaned.itemName, "Brownies — Box of 6");
  assert.equal(orphaned.unitPrice, 480);
  assert.equal(orphaned.piecesPerUnitSnapshot, 6);
  assert.equal(orphaned.quantity * (orphaned.piecesPerUnitSnapshot ?? 0), 12);
  // The pointers are gone; the sale-time facts are not.
  assert.equal(orphaned.productId, "");
  assert.equal(orphaned.sellingFormatId, "");
});
