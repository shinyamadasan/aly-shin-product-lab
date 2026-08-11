// The Products identity domain.
//
// It exists because live use produced findings like `[FIN-001] product bd921bd0-3c91-4b91-a67d-…`
// that no human or model could act on. These tests are about one thing: identity is resolved from
// PUBLISHED facts, and a stable id is never replaced by a name.

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildProductsDomainContext,
  buildProductsDomainContextFromFailure,
  type ProductIdentity,
  type ProductsRows,
} from "../src/lib/business-context/adapters/products.ts";
import type { Fact } from "../src/lib/business-context/types.ts";
import type { ProductRow } from "../src/lib/supabase-mappers.ts";

function productRow(overrides: Partial<ProductRow> = {}): ProductRow {
  return {
    id: "brownies",
    name: "Brownies",
    category: "Baked goods",
    product_role: "Hero candidate",
    status: "costed",
    description: null,
    notes: null,
    main_photo_url: null,
    decision: "Candidate",
    is_public: false,
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

function identities(rows: ProductsRows): ProductIdentity[] {
  const fact = buildProductsDomainContext(rows).facts.byProduct as Fact<ProductIdentity[]>;
  assert.equal(fact.state, "known");
  return (fact as { state: "known"; value: ProductIdentity[] }).value;
}

// Deletes the key outright, the way a pre-migration project actually returns a row.
function rowWithout(column: string): ProductRow {
  const row = { ...productRow() } as unknown as Record<string, unknown>;
  delete row[column];
  return row as unknown as ProductRow;
}

// --- Identity resolution ---------------------------------------------------------------------------

test("products: a slug id and a UUID id are treated identically", () => {
  const uuid = "bd921bd0-3c91-4b91-a67d-6355e2ef2784";
  const [slug, uuidIdentity] = identities({
    products: [productRow({ id: "brownies", name: "Brownies" }), productRow({ id: uuid, name: "Cold Brew Concentrate" })],
  });

  // Same shape, same states -- the id format is not a business fact and nothing branches on it.
  assert.equal(slug.productId, "brownies");
  assert.equal(slug.name.state, "known");
  assert.equal((slug.name as { value: string }).value, "Brownies");

  assert.equal(uuidIdentity.productId, uuid);
  assert.equal(uuidIdentity.name.state, "known");
  assert.equal((uuidIdentity.name as { value: string }).value, "Cold Brew Concentrate");
});

test("products: the id is published alongside the name, never replaced by it", () => {
  const [identity] = identities({ products: [productRow()] });

  // A renderer may annotate an id with a name; nothing may substitute it. Keeping both on the
  // snapshot is what makes duplicate names survivable.
  assert.equal(identity.productId, "brownies");
  assert.equal((identity.name as { value: string }).value, "Brownies");
});

test("products: duplicate names stay distinguishable because ids remain", () => {
  const list = identities({
    products: [productRow({ id: "brownies-v1", name: "Brownies" }), productRow({ id: "brownies-v2", name: "Brownies" })],
  });

  assert.deepEqual(list.map((entry) => entry.productId), ["brownies-v1", "brownies-v2"]);
  // No disambiguation logic, no ranking, no suffixing -- the id already does the work.
  assert.deepEqual(list.map((entry) => (entry.name as { value: string }).value), ["Brownies", "Brownies"]);
});

test("products: an inactive or archived product still resolves its name", () => {
  const [identity] = identities({ products: [productRow({ id: "retired", name: "Retired Loaf", status: "archived" })] });

  // Filtering these out would reintroduce the bare-id problem for exactly the products whose
  // history is most likely to be questioned.
  assert.equal((identity.name as { value: string }).value, "Retired Loaf");
});

test("products: an empty name is unset, not a fabricated label and not a missing product", () => {
  const [identity] = identities({ products: [productRow({ name: "" })] });

  assert.equal(identity.productId, "brownies");
  assert.equal(identity.name.state, "unset");
  assert.equal("value" in identity.name, false);
});

test("products: an absent name column is unknown, never known(undefined)", () => {
  const [identity] = identities({ products: [rowWithout("name")] });

  assert.equal(identity.name.state, "unknown");
  assert.equal("value" in identity.name, false);
  assert.match((identity.name as { because: string }).because, /does not exist in this project/);
});

test("products: a product id with no row simply has no identity to publish", () => {
  const list = identities({ products: [productRow({ id: "brownies" })] });

  // The renderer's fallback is driven by absence from this list, not by a fabricated placeholder.
  assert.equal(list.some((entry) => entry.productId === "deleted-product"), false);
  assert.equal(list.length, 1);
});

// --- Domain shape ------------------------------------------------------------------------------------

test("products: publishes identity only -- no catalogue, no signals", () => {
  const context = buildProductsDomainContext({ products: [productRow()] });
  const [identity] = identities({ products: [productRow()] });

  assert.deepEqual(Object.keys(context.facts).sort(), ["byProduct", "productCount"]);
  assert.deepEqual(Object.keys(identity).sort(), ["name", "productId"]);
  // Category, role, status, decision and publication state are deliberately not loaded.
  for (const field of ["category", "role", "status", "decision", "isPublic", "description"]) {
    assert.equal(field in identity, false, `${field} must not be published by an identity-only domain`);
  }
  assert.equal(context.signals.length, 0, "identity answers 'which product', it asks nothing about the business");
});

test("products: counts and source timestamp come from the rows actually read", () => {
  const context = buildProductsDomainContext({
    products: [productRow({ id: "a", updated_at: "2026-07-01T00:00:00.000Z" }), productRow({ id: "b", updated_at: "2026-07-05T00:00:00.000Z" })],
  });

  assert.equal((context.facts.productCount as { value: number }).value, 2);
  assert.deepEqual(context.rowCounts, { read: 2, included: 2, omitted: 0 });
  assert.equal((context.sourceAsOf as { value: string }).value, "2026-07-05T00:00:00.000Z");
});

test("products: zero products is empty, not unavailable", () => {
  const context = buildProductsDomainContext({ products: [] });

  // A real business fact: this project has no products yet.
  assert.equal(context.facts.byProduct.state, "empty");
  assert.equal((context.facts.productCount as { value: number }).value, 0);
  assert.equal(context.sourceAsOf.state, "empty");
  assert.deepEqual(context.readOutcome, { ok: true });
});

test("products: provenance names the real table, column and rows", () => {
  const context = buildProductsDomainContext({ products: [productRow({ id: "brownies" })] });
  const root = (context.facts.byProduct as { source: { kind: string; table?: string; rowIds?: string[] } }).source;
  const [identity] = identities({ products: [productRow()] });
  const nameSource = (identity.name as { source: { kind: string; table?: string; column?: string } }).source;

  assert.equal(root.kind, "entered");
  assert.equal(root.table, "products");
  assert.deepEqual(root.rowIds, ["brownies"]);
  assert.equal(nameSource.kind, "entered");
  assert.equal(nameSource.table, "products");
  assert.equal(nameSource.column, "name");
});

test("products: a failed read is unavailable, a missing table is not_configured", () => {
  const failed = buildProductsDomainContextFromFailure({ ok: false, reason: "failed", message: "connection reset" });
  const missing = buildProductsDomainContextFromFailure({ ok: false, reason: "missing-table", message: "no table" });

  assert.equal(failed.facts.byProduct.state, "unavailable");
  assert.match((failed.facts.byProduct as { because: string }).because, /connection reset/);
  assert.equal(missing.facts.byProduct.state, "not_configured");
  // Never an empty product catalogue: "we could not read" is not "there are no products". The state
  // assertions above are the proof -- TypeScript narrows these unions, so an `!== "empty"` check
  // here would be provably true rather than a test.
  assert.equal("value" in failed.facts.byProduct, false);
  assert.equal("value" in missing.facts.byProduct, false);
});

test("products: identity is deterministic -- same rows in, same facts out", () => {
  const rows: ProductsRows = { products: [productRow({ id: "a" }), productRow({ id: "b", name: "Bee" })] };

  assert.deepEqual(buildProductsDomainContext(rows), buildProductsDomainContext(rows));
});
