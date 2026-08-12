import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  loadMarketingAdvisorSampleInput,
  loadMarketingAdvisorSupabaseInput,
  type MarketingAdvisorReadClient,
} from "../scripts/marketing-advisor/marketing-advisor-read.ts";
import { products as sampleProducts } from "../src/lib/sample-data.ts";
import { mapProductRow, type ProductRow } from "../src/lib/supabase-mappers.ts";
import { buildMarketingAdvisorContext } from "../src/lib/marketing-advisor-context.ts";
import { buildMarketingRecommendations } from "../src/lib/marketing-recommendations.ts";

// Content Creation MVP S0 -- the Marketing Advisor's product facts must come from the real Supabase
// `products` table, not from src/lib/sample-data.ts. Every test below is about the SOURCE of those
// facts; none of them assert recommendation semantics, which S0 deliberately does not change.

const CREDENTIALS = { email: "owner@example.com", password: "secret" };
const NOW = Date.parse("2026-08-11T09:00:00.000Z");

function productRow(overrides: Partial<ProductRow> = {}): ProductRow {
  return {
    id: "biscoff-blondie",
    name: "Biscoff Blondie",
    category: "Baked goods",
    product_role: "Hero candidate",
    status: "testing",
    description: "Brown butter blondie with a Biscoff swirl.",
    notes: null,
    main_photo_url: "/product-images/P010_BiscoffBlondie.png",
    decision: "Candidate",
    is_public: true,
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

// Records every table read so a test can assert on ordering arguments as well as call shape.
function fakeClient(tables: Record<string, Record<string, unknown>[]>, options: { errorOn?: string } = {}) {
  const calls: Array<{ table: string; column: string; ascending: boolean }> = [];
  const client: MarketingAdvisorReadClient = {
    auth: { signInWithPassword: async () => ({ error: null }) },
    from: (table: string) => ({
      select: () => ({
        order: async (column: string, orderOptions: { ascending: boolean }) => {
          calls.push({ table, column, ascending: orderOptions.ascending });
          if (options.errorOn === table) {
            return { data: null, error: { message: `${table} exploded` } };
          }
          return { data: tables[table] ?? [], error: null };
        },
      }),
    }),
  };
  return { client, calls };
}

// ---- A. products come from Supabase ----

test("loadMarketingAdvisorSupabaseInput reads products from the Supabase products table", async () => {
  const { client, calls } = fakeClient({ products: [productRow()], ingredients: [], content_journal: [] });

  const result = await loadMarketingAdvisorSupabaseInput(client, CREDENTIALS);

  assert.equal(result.ok, true);
  assert.ok(calls.some((call) => call.table === "products"), "expected a read of the products table");
  assert.equal(result.ok && result.input.products.length, 1);
  assert.equal(result.ok && result.input.products[0].name, "Biscoff Blondie");
});

test("the products read is ordered by name ascending, matching product-lab.tsx's own ordering", async () => {
  const { client, calls } = fakeClient({ products: [], ingredients: [], content_journal: [] });

  await loadMarketingAdvisorSupabaseInput(client, CREDENTIALS);

  const productCall = calls.find((call) => call.table === "products");
  assert.deepEqual(productCall, { table: "products", column: "name", ascending: true });
});

// ---- B. the live path no longer depends on sample-data ----

test("the Supabase path returns real catalog products, never the sample-data fixtures", async () => {
  const { client } = fakeClient({ products: [productRow()], ingredients: [], content_journal: [] });

  const result = await loadMarketingAdvisorSupabaseInput(client, CREDENTIALS);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  const names = result.input.products.map((product) => product.name);
  assert.deepEqual(names, ["Biscoff Blondie"]);
  // The precise failure S0 exists to fix: the six fixture products must not reach the live path.
  for (const fixture of sampleProducts) {
    assert.ok(!names.includes(fixture.name), `sample product "${fixture.name}" leaked into the Supabase path`);
  }
});

test("[static] loadMarketingAdvisorSupabaseInput's product facts come from the mapped read, not the fixture import", () => {
  const source = readFileSync(new URL("../scripts/marketing-advisor/marketing-advisor-read.ts", import.meta.url), "utf8");
  const supabaseFn = source.slice(source.indexOf("export async function loadMarketingAdvisorSupabaseInput"));

  assert.match(supabaseFn, /from\("products"\)/, "the Supabase reader must read the products table");
  assert.match(supabaseFn, /mapProductRow/, "the Supabase reader must map rows with the shared mapper");
  // sampleProducts is the aliased fixture import; it must never be referenced past this boundary.
  assert.doesNotMatch(supabaseFn, /sampleProducts/, "the Supabase reader must not reference the sample fixtures");
});

test("[static] the reader no longer claims Product Lab has no Supabase products table", () => {
  const source = readFileSync(new URL("../scripts/marketing-advisor/marketing-advisor-read.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /Product Lab has no Supabase "products" table/);
  assert.doesNotMatch(source, /Always used regardless of --source/);
});

// ---- D. real product fields adapt correctly ----

test("rows are adapted through the shared mapProductRow, field for field", async () => {
  const row = productRow();
  const { client } = fakeClient({ products: [row], ingredients: [], content_journal: [] });

  const result = await loadMarketingAdvisorSupabaseInput(client, CREDENTIALS);

  assert.equal(result.ok, true);
  // Deep-equal against the shared mapper's own output rather than a hand-written expectation, so
  // this test can never drift from mapProductRow's contract.
  assert.deepEqual(result.ok && result.input.products[0], mapProductRow(row));
});

test("a pre-migration row missing decision/is_public still maps to the mapper's safe defaults", async () => {
  const row = productRow();
  delete (row as Partial<ProductRow>).decision;
  delete (row as Partial<ProductRow>).is_public;
  const { client } = fakeClient({ products: [row], ingredients: [], content_journal: [] });

  const result = await loadMarketingAdvisorSupabaseInput(client, CREDENTIALS);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.input.products[0].decision, "Needs proof");
  assert.equal(result.input.products[0].isPublic, false);
});

// ---- E. empty and failing reads stay deterministic and safe ----

test("an empty products table yields an empty catalog, not the fixtures, and still builds a context", async () => {
  const { client } = fakeClient({ products: [], ingredients: [], content_journal: [] });

  const result = await loadMarketingAdvisorSupabaseInput(client, CREDENTIALS);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.input.products, []);

  // Deterministic and safe downstream: no throw, and no recommendations invented from nothing.
  const context = buildMarketingAdvisorContext({ ...result.input, now: NOW });
  assert.deepEqual(context.products, []);
  assert.deepEqual(buildMarketingRecommendations(context), []);
});

test("a products read failure fails the whole load rather than silently serving an empty catalog", async () => {
  const { client } = fakeClient({ products: [], ingredients: [], content_journal: [] }, { errorOn: "products" });

  const result = await loadMarketingAdvisorSupabaseInput(client, CREDENTIALS);

  assert.equal(result.ok, false);
  assert.match(result.ok === false ? result.reason : "", /Supabase read failed: products exploded/);
});

// ---- F. recommendation semantics unchanged, only the facts differ ----

test("recommendations are the same function of the products given -- only the source of those products changed", async () => {
  const rows = [productRow(), productRow({ id: "cocoa-cookies", name: "Cocoa Cookies", decision: "Needs proof", is_public: false })];
  const { client } = fakeClient({ products: rows, ingredients: [], content_journal: [] });

  const result = await loadMarketingAdvisorSupabaseInput(client, CREDENTIALS);
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const fromReader = buildMarketingRecommendations(buildMarketingAdvisorContext({ ...result.input, now: NOW }));
  const fromMappedRowsDirectly = buildMarketingRecommendations(
    buildMarketingAdvisorContext({ products: rows.map(mapProductRow), ingredients: [], journal: [], now: NOW }),
  );

  assert.deepEqual(fromReader, fromMappedRowsDirectly);
  // Determinism: the same input twice produces the same output.
  assert.deepEqual(fromReader, buildMarketingRecommendations(buildMarketingAdvisorContext({ ...result.input, now: NOW })));
});

// ---- the sample path is untouched ----

test("loadMarketingAdvisorSampleInput still serves the static fixtures, unchanged", () => {
  const input = loadMarketingAdvisorSampleInput();

  assert.deepEqual(input.products, sampleProducts);
  assert.deepEqual(input.ingredients, []);
  assert.deepEqual(input.journal, []);
});
