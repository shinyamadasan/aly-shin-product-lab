// S9 PR-F1: the public catalog gate.
//
// Two properties are being defended, and the first one is the reason this slice exists separately
// from the rest of S9:
//
//   1. PUBLICATION IS EXPLICIT. Nothing is offered to a customer because it happens to be sellable.
//      A product is public only when someone ticked the box, and unticking it removes it again.
//
//   2. SELLABILITY IS NOT REIMPLEMENTED. getPublicMenu adds one filter and delegates everything
//      else to getSellableItems, so "which batch is current", "which costing is linked", "which
//      formats are offerable" and "what does it cost" have exactly one answer in this codebase.
//      A second implementation could disagree with the first, and the version customers see is the
//      worst possible one to have wrong.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getPublicMenu } from "../src/lib/orders/public-menu.ts";
import { getSellableItems } from "../src/lib/orders/menu.ts";
import { mapProductRow, type ProductRow } from "../src/lib/supabase-mappers.ts";
import type { CostingSummary, Product, ProductBatch, SellingFormat } from "../src/lib/product-lab-types.ts";

function product(id: string, name: string, overrides: Partial<Product> = {}): Product {
  return { id, name, category: "Bakery", role: "Hero candidate", status: "costed", description: "", image: `/product-images/${id}.png`, decision: "Candidate", isPublic: false, ...overrides };
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

// One product, one current batch, one linked costing, two active formats. The only thing varied
// across the tests below is the publication flag.
function catalog(isPublic: boolean) {
  return {
    products: [product("brownies", "Brownies", { isPublic })],
    batches: [batch("batch-1", "brownies")],
    costings: [costing("costing-1", "brownies", "batch-1")],
    formats: [format("fmt-6", "costing-1", "Box of 6", 480, 6), format("fmt-12", "costing-1", "Box of 12", 900, 12)],
  };
}

// --- Publication safety ---------------------------------------------------------------------------

test("a sellable product is NOT public merely because it is sellable", () => {
  const { products, batches, costings, formats } = catalog(false);

  // It really is sellable -- the internal menu offers it.
  assert.equal(getSellableItems(products, batches, costings, formats).length, 1);
  // ...and it is still not on the public menu.
  assert.deepEqual(getPublicMenu(products, batches, costings, formats), []);
});

test("explicitly publishing a sellable product makes it eligible", () => {
  const { products, batches, costings, formats } = catalog(true);
  const menu = getPublicMenu(products, batches, costings, formats);

  assert.equal(menu.length, 1);
  assert.equal(menu[0].productId, "brownies");
  assert.equal(menu[0].formats.length, 2);
});

test("unpublishing removes a product from the public menu again", () => {
  const { batches, costings, formats } = catalog(true);
  const published = [product("brownies", "Brownies", { isPublic: true })];
  const withdrawn = [product("brownies", "Brownies", { isPublic: false })];

  assert.equal(getPublicMenu(published, batches, costings, formats).length, 1);
  assert.equal(getPublicMenu(withdrawn, batches, costings, formats).length, 0);
});

test("a published product with nothing sellable does not appear", () => {
  // Published, but its only format is archived -- so there is nothing to sell and nothing to show.
  const products = [product("brownies", "Brownies", { isPublic: true })];
  const formats = [format("fmt-6", "costing-1", "Box of 6", 480, 6, { isActive: false })];

  assert.deepEqual(getPublicMenu(products, [batch("batch-1", "brownies")], [costing("costing-1", "brownies", "batch-1")], formats), []);
});

test("a published product with no costing at all does not appear", () => {
  const products = [product("brownies", "Brownies", { isPublic: true })];
  assert.deepEqual(getPublicMenu(products, [batch("batch-1", "brownies")], [], []), []);
});

test("publication is per product -- one published product does not carry an unpublished one", () => {
  const products = [product("brownies", "Brownies", { isPublic: true }), product("cookies", "Cookies", { isPublic: false })];
  const batches = [batch("batch-1", "brownies"), batch("batch-2", "cookies")];
  const costings = [costing("costing-1", "brownies", "batch-1"), costing("costing-2", "cookies", "batch-2")];
  const formats = [format("fmt-6", "costing-1", "Box of 6", 480, 6), format("fmt-c", "costing-2", "Pack of 6", 240, 6)];

  const menu = getPublicMenu(products, batches, costings, formats);
  assert.deepEqual(menu.map((entry) => entry.productId), ["brownies"]);
});

// --- Selling reuse ----------------------------------------------------------------------------------

test("the public menu reports exactly the facts getSellableItems reports", () => {
  // The gate is the ONLY difference. Given the same eligible product, every value on the public
  // menu is the one the internal sellable menu already computed -- no second price, no second
  // pack size, no second name.
  const { products, batches, costings, formats } = catalog(true);

  const internal = getSellableItems(products, batches, costings, formats);
  const publicMenu = getPublicMenu(products, batches, costings, formats);

  assert.equal(publicMenu.length, internal.length);
  assert.equal(publicMenu[0].productName, internal[0].productName);
  assert.deepEqual(
    publicMenu[0].formats.map((entry) => [entry.sellingFormatId, entry.formatName, entry.unitPrice, entry.piecesPerUnit]),
    internal[0].items.map((item) => [item.sellingFormatId, item.formatName, item.unitPrice, item.piecesPerUnit]),
  );
});

test("the price is the selling format's own price -- nothing is recalculated", () => {
  const { products, batches, costings } = catalog(true);
  // A deliberately odd price that no margin formula would produce.
  const formats = [format("fmt-6", "costing-1", "Box of 6", 477.33, 6)];

  assert.equal(getPublicMenu(products, batches, costings, formats)[0].formats[0].unitPrice, 477.33);
});

test("pieces per unit is carried through unchanged", () => {
  const { products, batches, costings } = catalog(true);
  const formats = [format("fmt-odd", "costing-1", "Tray of 15", 1100, 15)];

  assert.equal(getPublicMenu(products, batches, costings, formats)[0].formats[0].piecesPerUnit, 15);
});

test("the product image is carried through, and an unset image is an empty string", () => {
  const { batches, costings, formats } = catalog(true);

  const withImage = getPublicMenu([product("brownies", "Brownies", { isPublic: true })], batches, costings, formats);
  assert.equal(withImage[0].image, "/product-images/brownies.png");

  const withoutImage = getPublicMenu([product("brownies", "Brownies", { isPublic: true, image: "" })], batches, costings, formats);
  assert.equal(withoutImage[0].image, "");
});

// --- Sanitization -------------------------------------------------------------------------------------

test("the public menu exposes ONLY the approved customer-facing fields", () => {
  const { products, batches, costings, formats } = catalog(true);
  const menu = getPublicMenu(products, batches, costings, formats);

  assert.deepEqual(Object.keys(menu[0]).sort(), ["formats", "image", "productId", "productName"]);
  assert.deepEqual(Object.keys(menu[0].formats[0]).sort(), ["formatName", "piecesPerUnit", "sellingFormatId", "unitPrice"]);
});

test("no costing, batch, margin or internal product field can reach a customer", () => {
  // Asserted over the serialized output, so a field added to the shape later has to pass here too.
  const { products, batches, costings, formats } = catalog(true);
  const serialized = JSON.stringify(getPublicMenu(products, batches, costings, formats));

  // Every one of these is a real field on CostingSummary, ProductBatch, SellingFormat or Product
  // that a customer has no business seeing -- ingredient costs and margins most of all.
  for (const leaked of [
    "ingredientCost", "packagingCost", "laborEstimate", "waterCost", "gasCost", "ovenElectricCost",
    "refrigerationCost", "coffeeEquipmentCost", "wasteAllowance", "overheadCost", "equipmentCost", "suggestedPrice",
    "batchId", "batchVersion", "costingId", "usablePieces", "imperfectPieces", "stressLevel", "launchDecision",
    "tasteNotes", "textureNotes", "wentWrong", "improveNext", "ingredientsNotes",
    "decision", "status", "role", "category", "description", "isPublic", "isActive", "sortOrder", "notes",
  ]) {
    assert.equal(serialized.includes(leaked), false, `${leaked} must never appear in the public menu`);
  }
});

// --- Mapper round-trip --------------------------------------------------------------------------------

function productRow(overrides: Partial<ProductRow> = {}): ProductRow {
  return {
    id: "brownies",
    name: "Brownies",
    category: "Baked goods",
    product_role: "Hero candidate",
    status: "testing",
    description: null,
    notes: null,
    main_photo_url: null,
    decision: "Candidate",
    is_public: false,
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

test("mapProductRow preserves true and false accurately", () => {
  assert.equal(mapProductRow(productRow({ is_public: true })).isPublic, true);
  assert.equal(mapProductRow(productRow({ is_public: false })).isPublic, false);
});

test("a pre-migration row with no is_public column reads as unpublished, never as published", () => {
  // Schema availability, not value nullability -- the same case ProductRow.decision documents. If
  // the column is absent the honest answer is "not published", and it is also the safe one.
  const row = productRow();
  delete (row as Partial<ProductRow>).is_public;

  assert.equal(mapProductRow(row).isPublic, false);
});

// --- Migration text -----------------------------------------------------------------------------------

const migration = readFileSync(new URL("../supabase-add-public-ordering.sql", import.meta.url), "utf8");
const migrationStatements = migration
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n");

test("the migration adds is_public defaulting to false, idempotently", () => {
  assert.match(migrationStatements, /alter table products add column if not exists is_public boolean not null default false;/i);
});

test("the migration grants nothing and creates no policy -- anonymous access is unchanged", () => {
  // PR-F1 deliberately creates no public read path. The public menu is served by the application in
  // a later slice; the database's posture toward `anon` must not move at all.
  for (const forbidden of [/\bgrant\b/i, /\brevoke\b/i, /create policy/i, /\banon\b/i, /service_role/i, /row level security/i, /create table/i, /create or replace function/i]) {
    assert.equal(forbidden.test(migrationStatements), false, `PR-F1's migration must not contain ${forbidden}`);
  }
});

test("the migration alters nothing that already exists", () => {
  for (const forbidden of [/drop /i, /alter column/i, /rename/i, /update products set/i, /delete from/i]) {
    assert.equal(forbidden.test(migrationStatements), false, `PR-F1's migration must not contain ${forbidden}`);
  }
});
