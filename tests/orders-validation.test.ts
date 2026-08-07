import test from "node:test";
import assert from "node:assert/strict";
import { findPossibleDuplicateCustomer, validateCustomerForSave, validateOrderForSave } from "../src/lib/orders/validation.ts";
import { ORDER_ENTRY_METHODS, ORDER_SOURCES, type Order, type OrderLine } from "../src/lib/orders/types.ts";

function orderWith(overrides: Partial<Order> = {}): Order {
  return {
    id: "order-1",
    customerId: "customer-1",
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
    placedAt: "2026-08-09T02:00:00.000Z",
    completedAt: null,
    cancelledAt: null,
    cancelReason: "",
    createdAt: "2026-08-09T02:00:00.000Z",
    updatedAt: "2026-08-09T02:00:00.000Z",
    ...overrides,
  };
}

function line(overrides: Partial<OrderLine> = {}): OrderLine {
  return {
    id: "line-1",
    orderId: "order-1",
    productId: "brownies",
    sellingFormatId: "format-1",
    itemName: "Brownies, Box of 6",
    unitPrice: 480,
    piecesPerUnitSnapshot: 6,
    quantity: 1,
    sortOrder: 0,
    note: "",
    ...overrides,
  };
}

test("a well-formed catalog order passes", () => {
  assert.equal(validateOrderForSave(orderWith(), [line()]), null);
});

test("an order with no lines is rejected", () => {
  const message = validateOrderForSave(orderWith(), []);
  assert.match(String(message), /at least one item/i);
});

test("an order with no customer is rejected", () => {
  const message = validateOrderForSave(orderWith({ customerId: "" }), [line()]);
  assert.match(String(message), /needs a customer/i);
});

test("a line belonging to a different order is rejected before it reaches the database", () => {
  // The RPC also raises on this, but "which item?" is only answerable at this layer.
  const message = validateOrderForSave(orderWith(), [line({ orderId: "some-other-order" })]);
  assert.match(String(message), /different order/i);
});

test("a negative price is rejected; zero is allowed", () => {
  assert.notEqual(validateOrderForSave(orderWith(), [line({ unitPrice: -1 })]), null);
  // A free sample recorded on an order is legitimate.
  assert.equal(validateOrderForSave(orderWith(), [line({ unitPrice: 0 })]), null);
});

test("a fractional or zero quantity is rejected", () => {
  // Bakery selling units are discrete: 2.5 boxes is not a thing.
  assert.match(String(validateOrderForSave(orderWith(), [line({ quantity: 2.5 })])), /whole quantity/i);
  assert.match(String(validateOrderForSave(orderWith(), [line({ quantity: 0 })])), /whole quantity/i);
  assert.match(String(validateOrderForSave(orderWith(), [line({ quantity: -1 })])), /whole quantity/i);
  assert.equal(validateOrderForSave(orderWith(), [line({ quantity: 3 })]), null);
});

test("a manual line with both catalog pointers empty and a null pieces snapshot is accepted", () => {
  const manualLine = line({ productId: "", sellingFormatId: "", piecesPerUnitSnapshot: null, itemName: "Delivery", unitPrice: 60 });
  assert.equal(validateOrderForSave(orderWith(), [manualLine]), null);
});

test("a product line with a hand-entered price and no pieces snapshot is accepted", () => {
  const productLine = line({ sellingFormatId: "", piecesPerUnitSnapshot: null });
  assert.equal(validateOrderForSave(orderWith(), [productLine]), null);
});

test("a zero or negative pieces snapshot is rejected, but null is accepted", () => {
  // null means "not recorded" and is honest. Zero is neither a real pack size nor an honest
  // unknown.
  assert.notEqual(validateOrderForSave(orderWith(), [line({ piecesPerUnitSnapshot: 0 })]), null);
  assert.notEqual(validateOrderForSave(orderWith(), [line({ piecesPerUnitSnapshot: -2 })]), null);
  assert.equal(validateOrderForSave(orderWith(), [line({ piecesPerUnitSnapshot: null })]), null);
});

test("a selling format without a product is rejected", () => {
  const message = validateOrderForSave(orderWith(), [line({ productId: "", sellingFormatId: "format-1" })]);
  assert.match(String(message), /selling format but not to a product/i);
});

test("duplicate line ids are rejected", () => {
  const message = validateOrderForSave(orderWith(), [line({ id: "line-1" }), line({ id: "line-1", itemName: "Cookies" })]);
  assert.match(String(message), /same id/i);
});

test("an empty item name is rejected", () => {
  assert.match(String(validateOrderForSave(orderWith(), [line({ itemName: "   " })])), /needs a name/i);
});

test("the money invariants are enforced at save time too", () => {
  const paidWithoutAmount = orderWith({ paymentStatus: "paid", paidAt: "2026-08-09T06:00:00.000Z", paidAmount: null });
  assert.notEqual(validateOrderForSave(paidWithoutAmount, [line()]), null);

  const refundedWithoutAmount = orderWith({
    paymentStatus: "refunded",
    paidAt: "2026-08-09T06:00:00.000Z",
    paidAmount: null,
    refundedAt: "2026-09-01T06:00:00.000Z",
  });
  assert.notEqual(validateOrderForSave(refundedWithoutAmount, [line()]), null);
});

test("validateCustomerForSave requires only a name", () => {
  assert.equal(validateCustomerForSave("Maria Santos"), null);
  assert.notEqual(validateCustomerForSave("   "), null);
});

test("duplicate customer detection is a warning signal, matched case- and whitespace-insensitively", () => {
  const existing = [
    { id: "customer-1", name: "Maria Santos" },
    { id: "customer-2", name: "Ana Cruz" },
  ];

  assert.equal(findPossibleDuplicateCustomer(existing, { id: "new", name: "  maria santos " })?.id, "customer-1");
  assert.equal(findPossibleDuplicateCustomer(existing, { id: "new", name: "Someone Else" }), null);
  // Editing a customer without renaming them must not flag them against themselves.
  assert.equal(findPossibleDuplicateCustomer(existing, { id: "customer-1", name: "Maria Santos" }), null);
});

// --- Attribution vocabulary ---------------------------------------------------------------------

test("source defaults to unknown and never to manual", () => {
  assert.equal(orderWith().source, "unknown");
  assert.ok((ORDER_SOURCES as readonly string[]).includes("unknown"));
  // `manual` describes record entry, not acquisition. It must not be a source at all.
  assert.ok(!(ORDER_SOURCES as readonly string[]).includes("manual"));
});

test("repeat is not a source -- it is derivable from order count", () => {
  // Storing it as an entered value would create a second answer that can disagree with the data.
  assert.ok(!(ORDER_SOURCES as readonly string[]).includes("repeat"));
});

test("entry method is a separate vocabulary from source", () => {
  assert.deepEqual([...ORDER_ENTRY_METHODS], ["manual", "website"]);
  assert.equal(orderWith().entryMethod, "manual");
});

test("source_ref is opaque and survives validation unparsed", () => {
  const withRef = orderWith({ source: "instagram", sourceRef: "POST-184?utm=x&y=1" });
  assert.equal(validateOrderForSave(withRef, [line()]), null);
  assert.equal(withRef.sourceRef, "POST-184?utm=x&y=1");
});
