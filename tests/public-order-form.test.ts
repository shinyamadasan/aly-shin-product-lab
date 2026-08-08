// S9 PR-F3: the customer-facing order form's logic.
//
// The property this file exists to protect is the IDEMPOTENCY LIFECYCLE. F2 guarantees one key
// produces at most one order however many times it is submitted; that guarantee is only reachable
// if this side keeps the key stable across exactly the situations where a customer retries. Minting
// a fresh key on a failure would turn one person's repeated attempts into several real orders --
// silently, and with F2 powerless to notice.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  applyResponse,
  applyTransportFailure,
  buildRequestBody,
  canSubmit,
  createInitialState,
  getOrderTotal,
  getSafePublicImage,
  getSelectedLines,
  getSubmitBlocker,
  markSubmitting,
  parsePublicOrderResponse,
  resolveAttribution,
  setContact,
  setQuantity,
  startNewOrder,
  type PublicOrderFormState,
} from "../src/lib/orders/public-order-form-state.ts";
import { getPublicMenu } from "../src/lib/orders/public-menu.ts";
import { toDisplayPrice } from "../src/lib/orders/money.ts";
import type { PublicMenuProduct } from "../src/lib/orders/public-menu.ts";
import type { CostingSummary, Product, ProductBatch, SellingFormat } from "../src/lib/product-lab-types.ts";

// Deterministic keys, so "same key" and "new key" are observable.
let keyCounter = 0;
const nextKey = () => `key-${++keyCounter}`;

const MENU: PublicMenuProduct[] = [
  { productId: "brownies", productName: "Brownies", image: "/product-images/brownies.png", formats: [
    { sellingFormatId: "fmt-6", formatName: "Box of 6", unitPrice: 480, piecesPerUnit: 6 },
    { sellingFormatId: "fmt-12", formatName: "Box of 12", unitPrice: 900, piecesPerUnit: 12 },
  ] },
  { productId: "cookies", productName: "Cookies", image: "", formats: [
    { sellingFormatId: "fmt-c", formatName: "Pack of 6", unitPrice: 240, piecesPerUnit: 6 },
  ] },
];

function ready(): PublicOrderFormState {
  let s = createInitialState(MENU, nextKey);
  s = setQuantity(s, "fmt-6", 2);
  s = setContact(s, { customerName: "Maria Santos", phone: "09171234567" });
  return s;
}

// --- Menu and selection ---------------------------------------------------------------------------

test("the page shows only what the shared public-menu contract considers public and sellable", () => {
  // F3 does not re-derive sellability; it renders getPublicMenu's output. Proven by feeding the same
  // catalog through the shared helper: a private product and an inactive format never appear.
  const product = (id: string, name: string, isPublic: boolean): Product => ({ id, name, category: "Bakery", role: "Hero candidate", status: "costed", description: "", image: "", decision: "Candidate", isPublic });
  const batch = (id: string, productId: string): ProductBatch => ({ id, productId, batchVersion: "V1", dateMade: "2026-08-01", ingredientsNotes: "", prepTimeMinutes: 0, bakeTimeMinutes: 0, coolingTimeMinutes: 0, usablePieces: 12, imperfectPieces: 0, stressLevel: 1, tasteNotes: "", textureNotes: "", wentWrong: "", improveNext: "", launchDecision: "launch" });
  const costing = (id: string, productId: string, batchId: string): CostingSummary => ({ id, productId, batchId, ingredientCost: 1, packagingCost: 1, laborEstimate: 1, waterCost: 0, gasCost: 0, ovenElectricCost: 0, refrigerationCost: 0, coffeeEquipmentCost: 0, wasteAllowance: 0, overheadCost: 0, equipmentCost: 0, suggestedPrice: 1, notes: "" });
  const format = (id: string, costingId: string, isActive: boolean): SellingFormat => ({ id, costingId, name: "Box of 6", piecesPerUnit: 6, sellingPrice: 480, isActive, sortOrder: 0, notes: "" });

  const menu = getPublicMenu(
    [product("public-sellable", "Shown", true), product("private", "Hidden", false), product("public-unsellable", "No formats", true)],
    [batch("b1", "public-sellable"), batch("b2", "private"), batch("b3", "public-unsellable")],
    [costing("c1", "public-sellable", "b1"), costing("c2", "private", "b2"), costing("c3", "public-unsellable", "b3")],
    [format("f1", "c1", true), format("f2", "c2", true), format("f3", "c3", false)],
  );

  assert.deepEqual(menu.map((m) => m.productId), ["public-sellable"]);
});

test("quantity changes add, increment and remove", () => {
  let s = createInitialState(MENU, nextKey);
  assert.equal(getSelectedLines(s).length, 0);

  s = setQuantity(s, "fmt-6", 2);
  assert.equal(getSelectedLines(s)[0].quantity, 2);
  assert.equal(getOrderTotal(s), 960);

  s = setQuantity(s, "fmt-c", 1);
  assert.equal(getSelectedLines(s).length, 2);
  assert.equal(getOrderTotal(s), 960 + 240);

  s = setQuantity(s, "fmt-6", 0);
  assert.deepEqual(getSelectedLines(s).map((l) => l.format.sellingFormatId), ["fmt-c"]);
  // Never negative, never fractional.
  s = setQuantity(s, "fmt-c", -5);
  assert.equal(getSelectedLines(s).length, 0);
  s = setQuantity(s, "fmt-c", 2.7);
  assert.equal(getSelectedLines(s)[0].quantity, 2);
});

test("the form uses the SHARED display-price helper, not its own rounding", () => {
  const component = readFileSync(new URL("../src/components/public-order-form.tsx", import.meta.url), "utf8");
  assert.match(component, /toDisplayPrice/);
  assert.equal(/toFixed\(|Math\.round\(.*100|toLocaleString\(/.test(component), false, "no second peso-rounding implementation");
  // And the shared helper is the one whose output the customer sees.
  assert.equal(toDisplayPrice(1.005), "1.01");
});

test("name and phone are required before anything can be submitted", () => {
  let s = createInitialState(MENU, nextKey);
  assert.equal(getSubmitBlocker(s), "Choose at least one item.");

  s = setQuantity(s, "fmt-6", 1);
  assert.equal(getSubmitBlocker(s), "Please add your name.");

  s = setContact(s, { customerName: "Maria" });
  assert.equal(getSubmitBlocker(s), "Please add a mobile number so we can confirm.");

  s = setContact(s, { phone: "09171234567" });
  assert.equal(getSubmitBlocker(s), null);
  assert.equal(canSubmit(s), true);

  // Whitespace is not a name.
  assert.equal(canSubmit(setContact(s, { customerName: "   " })), false);
  assert.equal(canSubmit(setContact(s, { phone: "  " })), false);
});

test("the requested time travels as the customer's own wording, and no fulfilment time is sent", () => {
  const s = setContact(ready(), { requestedTime: "  Saturday afternoon if possible  " });
  const body = buildRequestBody(s, { source: "unknown", sourceRef: "" }, "");

  assert.equal(body.requestedTime, "Saturday afternoon if possible");
  assert.equal(Object.hasOwn(body, "fulfillmentAt"), false);
  assert.equal(Object.hasOwn(body, "fulfillment_at"), false);
  assert.equal(Object.hasOwn(body, "fulfillmentMethod"), false);
});

test("the request body carries NO authority the server owns", () => {
  const body = buildRequestBody(ready(), { source: "instagram", sourceRef: "POST-184" }, "");

  assert.deepEqual(Object.keys(body).sort(), ["customerName", "idempotencyKey", "items", "notes", "phone", "requestedTime", "source", "sourceRef", "trap"]);
  assert.deepEqual(Object.keys(body.items[0]).sort(), ["displayedUnitPrice", "productId", "quantity", "sellingFormatId"]);

  const serialized = JSON.stringify(body);
  for (const forbidden of ["unit_price", "unitPrice\"", "item_name", "itemName", "pieces_per_unit", "piecesPerUnit", "orderId", "customerId", "status", "payment", "paid_", "entry_method", "entryMethod"]) {
    assert.equal(serialized.includes(forbidden), false, `the browser must not send ${forbidden}`);
  }
  // displayedUnitPrice is the one number sent, and it is what was on screen.
  assert.equal(body.items[0].displayedUnitPrice, 480);
});

// --- Idempotency lifecycle -- the heart of F3 ---------------------------------------------------------

test("a definitive success shows 'received', never 'confirmed'", () => {
  const s = applyResponse(ready(), { status: "accepted" });
  assert.equal(s.status.kind, "received");

  const component = readFileSync(new URL("../src/components/public-order-form.tsx", import.meta.url), "utf8");
  assert.match(component, /Order received/);
  assert.equal(/Order confirmed/i.test(component), false, "the persisted order is `new` until Aly & Pon reviews it");
});

test("a double submit cannot become two logical orders", () => {
  const s = ready();
  const first = buildRequestBody(s, { source: "unknown", sourceRef: "" }, "");

  // The in-flight guard blocks the second click outright...
  const inFlight = markSubmitting(s);
  assert.equal(canSubmit(inFlight), false);

  // ...and even if a click did get through, it carries the SAME key, so F2 collapses it.
  const second = buildRequestBody(s, { source: "unknown", sourceRef: "" }, "");
  assert.equal(first.idempotencyKey, second.idempotencyKey);
});

test("a transport failure keeps the same key -- the order may already exist", () => {
  const s = ready();
  const before = s.idempotencyKey;
  const after = applyTransportFailure(markSubmitting(s));

  assert.equal(after.idempotencyKey, before, "a timeout is indistinguishable from a lost response");
  assert.equal(after.status.kind, "error");
  // Retrying reuses it.
  assert.equal(buildRequestBody(after, { source: "unknown", sourceRef: "" }, "").idempotencyKey, before);
});

test("every non-success response keeps the key AND the customer's work", () => {
  const s = setContact(ready(), { requestedTime: "Saturday", notes: "no nuts please" });
  const key = s.idempotencyKey;

  const responses = [
    { status: "error", message: "temporary" },
    { status: "invalid", message: "Please add your name." },
    { status: "prices-changed", message: "Prices changed.", menu: MENU },
    { status: "unavailable", message: "No longer available.", menu: MENU },
  ] as const;

  for (const response of responses) {
    const after = applyResponse(markSubmitting(s), response);
    assert.equal(after.idempotencyKey, key, `${response.status} must not rotate the key`);
    assert.equal(after.contact.customerName, "Maria Santos", `${response.status} must keep the name`);
    assert.equal(after.contact.phone, "09171234567", `${response.status} must keep the phone`);
    assert.equal(after.contact.requestedTime, "Saturday", `${response.status} must keep the requested time`);
    assert.equal(after.contact.notes, "no nuts please", `${response.status} must keep the notes`);
    assert.deepEqual(after.quantities, s.quantities, `${response.status} must keep the selections`);
    assert.notEqual(after.status.kind, "received");
  }
});

test("prices-changed and unavailable refresh the menu and never auto-submit", () => {
  const s = ready();
  const dearer: PublicMenuProduct[] = [{ ...MENU[0], formats: [{ ...MENU[0].formats[0], unitPrice: 540 }] }];

  const changed = applyResponse(markSubmitting(s), { status: "prices-changed", message: "Prices changed.", menu: dearer });
  assert.equal(changed.status.kind, "prices-changed");
  assert.equal(changed.menu[0].formats[0].unitPrice, 540, "the refreshed menu is shown");
  assert.equal(changed.idempotencyKey, s.idempotencyKey);
  // The next submission would carry the NEW displayed price, so the customer is consenting again.
  assert.equal(buildRequestBody(changed, { source: "unknown", sourceRef: "" }, "").items[0].displayedUnitPrice, 540);

  const gone = applyResponse(markSubmitting(s), { status: "unavailable", message: "Gone.", menu: [] });
  assert.equal(gone.status.kind, "unavailable");
  assert.deepEqual(gone.menu, []);
  // A selection whose format vanished simply stops counting; it can never be submitted.
  assert.equal(getSelectedLines(gone).length, 0);
  assert.equal(canSubmit(gone), false);
});

test("a successful order is retired and cannot be resubmitted", () => {
  const received = applyResponse(ready(), { status: "accepted" });
  assert.equal(canSubmit(received), false);
  assert.equal(getSubmitBlocker(received), "This order has already been sent.");
});

test("a genuinely NEW order gets a NEW key, and only after success", () => {
  const received = applyResponse(ready(), { status: "accepted" });
  const fresh = startNewOrder(received, nextKey);

  assert.notEqual(fresh.idempotencyKey, received.idempotencyKey, "a second order is a different logical order");
  assert.deepEqual(fresh.quantities, {});
  assert.equal(fresh.contact.customerName, "");
  assert.equal(fresh.status.kind, "editing");
  assert.deepEqual(fresh.menu, received.menu, "the menu is kept -- only the order is new");
});

// --- Attribution ----------------------------------------------------------------------------------

test("attribution comes from the link and degrades safely", () => {
  assert.deepEqual(resolveAttribution("instagram", "POST-184"), { source: "instagram", sourceRef: "POST-184" });
  assert.deepEqual(resolveAttribution("pinterest", "x"), { source: "unknown", sourceRef: "x" });
  assert.deepEqual(resolveAttribution(undefined, undefined), { source: "unknown", sourceRef: "" });
  // Opaque: not trimmed, not parsed.
  assert.equal(resolveAttribution("direct", "  https://x/y?utm_source=ig  ").sourceRef, "  https://x/y?utm_source=ig  ");
  // Over-long is dropped rather than truncated; the channel survives.
  const long = resolveAttribution("facebook", "z".repeat(500));
  assert.equal(long.sourceRef, "");
  assert.equal(long.source, "facebook");
});

test("the customer is never offered an attribution control", () => {
  const component = readFileSync(new URL("../src/components/public-order-form.tsx", import.meta.url), "utf8");
  assert.equal(/name="source"|Where did .* come from/i.test(component), false);
});

// --- Product image safety ----------------------------------------------------------------------------

test("only a same-origin product-images path is rendered", () => {
  assert.equal(getSafePublicImage("/product-images/P001_Brownies.png"), "/product-images/P001_Brownies.png");
  assert.equal(getSafePublicImage("/product-images/a.jpg"), "/product-images/a.jpg");

  for (const unsafe of [
    "", "not-a-path.png", "https://evil.example/x.png", "//evil.example/x.png",
    "/product-images/../../etc/passwd.png", "/product-images/x.png?a=b", "/product-images/x.png#f",
    "javascript:alert(1)", "data:image/png;base64,AAA", "/product-images/x.svg", "/other/x.png",
    "/product-images/a\\b.png",
  ]) {
    assert.equal(getSafePublicImage(unsafe), null, `${unsafe} must not be rendered`);
  }
});

// --- Only a known response class may be acted on ---------------------------------------------------------
//
// The body is JSON from the network. Casting it would let an unexpected payload -- a proxy error
// page, a truncated response, a future status this build does not know -- flow into applyResponse
// and be handled as whichever branch it happened to resemble. The worst case is an unrecognised body
// landing on `accepted` and telling a customer their order was received when nothing was created.

test("an unknown status is rejected and handled as a temporary failure", () => {
  for (const unknown of [{ status: "queued" }, { status: "ACCEPTED" }, { status: "" }, { status: 200 }, { status: null }, {}]) {
    assert.equal(parsePublicOrderResponse(unknown), null, `${JSON.stringify(unknown)} must not be acted on`);
  }
});

test("malformed or non-object bodies are rejected", () => {
  for (const malformed of [null, undefined, "accepted", 42, true, ["accepted"], [{ status: "accepted" }]]) {
    assert.equal(parsePublicOrderResponse(malformed), null, `${JSON.stringify(malformed) ?? "undefined"} must not be acted on`);
  }
});

test("a known class missing its required fields is rejected", () => {
  // A 409 without a menu cannot refresh anything; an invalid without a message has nothing to show.
  assert.equal(parsePublicOrderResponse({ status: "prices-changed", message: "x" }), null);
  assert.equal(parsePublicOrderResponse({ status: "prices-changed", menu: MENU }), null);
  assert.equal(parsePublicOrderResponse({ status: "unavailable", message: "x", menu: "not-a-menu" }), null);
  assert.equal(parsePublicOrderResponse({ status: "invalid" }), null);
});

test("the five known classes are admitted intact", () => {
  assert.deepEqual(parsePublicOrderResponse({ status: "accepted" }), { status: "accepted" });
  assert.deepEqual(parsePublicOrderResponse({ status: "invalid", message: "Please add your name." }), { status: "invalid", message: "Please add your name." });
  assert.deepEqual(parsePublicOrderResponse({ status: "prices-changed", message: "changed", menu: MENU }), { status: "prices-changed", message: "changed", menu: MENU });
  assert.deepEqual(parsePublicOrderResponse({ status: "unavailable", message: "gone", menu: [] }), { status: "unavailable", message: "gone", menu: [] });
  assert.deepEqual(parsePublicOrderResponse({ status: "error", message: "later" }), { status: "error", message: "later" });
  // An error with no copy falls back to the local wording rather than being rejected.
  assert.deepEqual(parsePublicOrderResponse({ status: "error" }), { status: "error", message: undefined });
});

test("a rejected body preserves the key and every field, exactly like a transport failure", () => {
  const s = setContact(ready(), { requestedTime: "Saturday", notes: "no nuts" });
  const parsed = parsePublicOrderResponse({ status: "who-knows" });
  assert.equal(parsed, null);

  const after = applyTransportFailure(markSubmitting(s));
  assert.equal(after.idempotencyKey, s.idempotencyKey);
  assert.equal(after.contact.customerName, "Maria Santos");
  assert.equal(after.contact.phone, "09171234567");
  assert.equal(after.contact.requestedTime, "Saturday");
  assert.equal(after.contact.notes, "no nuts");
  assert.deepEqual(after.quantities, s.quantities);
  assert.equal(after.status.kind, "error");
  assert.notEqual(after.status.kind, "received");
});

test("the form parses the response instead of casting it", () => {
  const component = readFileSync(new URL("../src/components/public-order-form.tsx", import.meta.url), "utf8");
  assert.match(component, /parsePublicOrderResponse\(/);
  assert.equal(/as PublicOrderResponse/.test(component), false, "a cast is not a check");
});

// --- The page must use the auth recovery wrapper -----------------------------------------------------------

test("/order reads the catalog through withPublicOrderClient, not a bare client", () => {
  // The website principal's session is non-persistent with autoRefreshToken:false, so a warm
  // instance can hold an expired one. F2 built the recovery path for exactly this; the page must
  // not bypass it -- which is the same mistake the F2 route made before review caught it.
  const page = readFileSync(new URL("../src/app/order/page.tsx", import.meta.url), "utf8");
  assert.match(page, /withPublicOrderClient\(/, "the recovery wrapper must actually be used");
  assert.equal(/getPublicOrderClient\(/.test(page), false, "a bare client bypasses re-authentication and retry");
  // A read-only operation, so retrying it once is safe.
  assert.match(page, /loadPublicCatalog\(/);
  // Recovery failure still ends in the generic public state.
  assert.match(page, /<Unavailable \/>/);
});

// --- Structural: no new write path, no credential, no lookup endpoint ---------------------------------

const f3Files = ["../src/components/public-order-form.tsx", "../src/app/order/page.tsx", "../src/lib/orders/public-order-form-state.ts"];

test("F3 introduces NO browser Supabase write path", () => {
  const client = readFileSync(new URL("../src/components/public-order-form.tsx", import.meta.url), "utf8");
  const banned: [string, string][] = [
    ["createClient", "no Supabase client in the browser"],
    ["@supabase/supabase-js", "no Supabase SDK in the browser"],
    ["save_order", "no direct RPC"],
    ["save_public_order_once", "no direct RPC"],
    ['from("orders")', "no direct table access"],
    ['from("customers")', "no direct table access"],
    ['from("order_lines")', "no direct table access"],
  ];
  for (const [token, why] of banned) {
    assert.equal(client.includes(token), false, why);
  }
  // The only persistence route is the F2 endpoint.
  assert.match(client, /fetch\("\/api\/public-orders"/);
});

test("no website-user credential can reach client code", () => {
  for (const path of f3Files) {
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    assert.equal(/PUBLIC_ORDER_SUPABASE/.test(source), false, `${path} must not reference the server credential`);
    assert.equal(/SERVICE_ROLE|service_role/.test(source), false, `${path} must not reference a service role`);
  }
  // The page may use the server-only client; the form may not.
  const form = readFileSync(new URL("../src/components/public-order-form.tsx", import.meta.url), "utf8");
  assert.equal(form.includes("supabase-server"), false, "a client component must never import the server client");
  assert.match(form.split("\n")[0], /^"use client";$/);
});

test("F3 adds no order-status lookup or GET endpoint", () => {
  const page = readFileSync(new URL("../src/app/order/page.tsx", import.meta.url), "utf8");
  assert.equal(/export async function (GET|POST|PUT|DELETE)/.test(page), false, "a page is not an endpoint");
  const form = readFileSync(new URL("../src/components/public-order-form.tsx", import.meta.url), "utf8");
  assert.equal(/method:\s*"GET"|\/api\/public-orders\?/.test(form), false, "no order lookup -- a key is not a read credential");
  const routes = readFileSync(new URL("../src/app/api/public-orders/route.ts", import.meta.url), "utf8");
  assert.equal(/export async function GET/.test(routes), false, "the endpoint still exposes POST only");
});

test("the page builds its menu with the shared helper, not its own query", () => {
  const page = readFileSync(new URL("../src/app/order/page.tsx", import.meta.url), "utf8");
  assert.match(page, /getPublicMenu\(/);
  assert.match(page, /loadPublicCatalog\(/);

  // Comments stripped first, as tests/orders-schema.test.ts does: the page DESCRIBES the delegation
  // to getSellableItems in prose while deliberately not performing it.
  const statements = page
    .split("\n")
    .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*") && !line.trim().startsWith("/*"))
    .join("\n");
  assert.equal(/getSellableItems|isPublic|selling_price/.test(statements), false, "sellability must not be re-derived here");
});
