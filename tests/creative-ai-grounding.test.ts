import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { loadCreativeAiGrounding, type CreativeAiGroundingReadClient } from "../scripts/creative-workers/creative-ai-grounding.ts";
import { BRAND_BIBLE } from "../src/lib/marketing-advisor-context.ts";

// S3E-A2 -- the real-world data bridge that feeds S3A. These tests use a stub client shaped like
// the production one; nothing here touches a real database.

const NOW = Date.parse("2026-08-13T10:00:00.000Z");

type Rows = Record<string, Record<string, unknown>[]>;

function makeClient(rows: Rows, options: { errorOn?: string; brandProfile?: Record<string, unknown> | null } = {}) {
  const reads: string[] = [];
  const orderings: string[] = [];

  const client: CreativeAiGroundingReadClient = {
    from(table: string) {
      reads.push(table);
      return {
        select() {
          return {
            order(column: string, opts: { ascending: boolean }) {
              orderings.push(`${table}.${column}.${opts.ascending ? "asc" : "desc"}`);
              return Promise.resolve(
                options.errorOn === table ? { data: null, error: { message: "connection refused" } } : { data: rows[table] ?? [], error: null },
              );
            },
            eq(column: string, value: unknown) {
              orderings.push(`${table}.${column}=${String(value)}`);
              return {
                limit() {
                  return {
                    maybeSingle: () =>
                      Promise.resolve(
                        options.errorOn === table
                          ? { data: null, error: { message: "connection refused" } }
                          : { data: options.brandProfile ?? null, error: null },
                      ),
                  };
                },
              };
            },
          };
        },
      };
    },
  };

  return { client, reads, orderings };
}

const PRODUCT_ROW = { id: "blondies", name: "Blondies", category: "Bars", description: "", is_active: true };

test("the bridge reads the real tables, with the same ordering the app and Marketing Advisor use", async () => {
  const { client, reads, orderings } = makeClient({ products: [PRODUCT_ROW], ingredients: [], content_journal: [] });

  const result = await loadCreativeAiGrounding(client, { now: () => NOW });

  assert.equal(result.ok, true);
  assert.deepEqual(reads.sort(), ["brand_profiles", "content_journal", "ingredients", "products"]);
  assert.ok(orderings.includes("products.name.asc"), "catalog order must match product-lab.tsx and the Marketing Advisor");
  assert.ok(orderings.includes("content_journal.created_at.desc"));
  assert.ok(orderings.includes("brand_profiles.is_active=true"));
});

test("the bridge produces recommendations from the real engine, and the real BRAND_BIBLE", async () => {
  const { client } = makeClient({
    // A product with no journal history is exactly what the real no_marketing_history rule fires on.
    products: [PRODUCT_ROW],
    ingredients: [],
    content_journal: [],
  });

  const result = await loadCreativeAiGrounding(client, { now: () => NOW });
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.grounding.brandBible, BRAND_BIBLE, "one brand source, not a second copy");
  assert.equal(result.grounding.products.length, 1);
  assert.equal(result.grounding.products[0].name, "Blondies");

  // The real engine ran and produced a qualifying, product-bearing recommendation.
  assert.ok(result.grounding.recommendations.length > 0);
  const qualifying = result.grounding.recommendations.find((entry) => entry.recommendationType === "no_marketing_history");
  assert.ok(qualifying, "the real engine's no_marketing_history rule should fire for an unposted product");
  assert.equal((qualifying as { evidence: { productId: string } }).evidence.productId, "blondies");
});

test("configuredPlatforms comes from the Brand Presence row, and is empty when there is none", async () => {
  const noProfile = makeClient({ products: [PRODUCT_ROW], ingredients: [], content_journal: [] });
  const withoutResult = await loadCreativeAiGrounding(noProfile.client, { now: () => NOW });
  assert.equal(withoutResult.ok && withoutResult.grounding.configuredPlatforms.length, 0);

  const withProfile = makeClient(
    { products: [PRODUCT_ROW], ingredients: [], content_journal: [] },
    { brandProfile: { instagram_handle: "@alyandpon", tiktok_url: "https://tiktok.com/@alyandpon", facebook_handle: "", youtube_handle: "@alyandpon" } },
  );
  const withResult = await loadCreativeAiGrounding(withProfile.client, { now: () => NOW });
  assert.equal(withResult.ok, true);
  if (!withResult.ok) return;
  // YouTube is configured on the profile but is NOT a Content MVP platform, so it is excluded.
  assert.deepEqual(withResult.grounding.configuredPlatforms, ["instagram", "tiktok"]);
});

test("a read failure is reported as a failure, never softened into empty grounding", async () => {
  for (const table of ["products", "ingredients", "content_journal", "brand_profiles"]) {
    const { client } = makeClient({ products: [PRODUCT_ROW], ingredients: [], content_journal: [] }, { errorOn: table });
    const result = await loadCreativeAiGrounding(client, { now: () => NOW });
    assert.equal(result.ok, false, `${table} read failure must fail the load`);
    assert.match(!result.ok ? result.message : "", /Creative AI grounding read failed/);
  }
});

test("the bridge is read-only and reuses the existing mappers rather than inventing new ones", () => {
  const source = readFileSync(new URL("../scripts/creative-workers/creative-ai-grounding.ts", import.meta.url), "utf8");

  // No write path exists to call -- the same technique marketing-advisor-read.ts uses.
  for (const forbidden of [/\.insert\(/, /\.update\(/, /\.delete\(/, /\.upsert\(/, /\.rpc\(/]) {
    assert.doesNotMatch(source, forbidden);
  }

  // One source of truth for products, journal, recommendations and the brand bible.
  assert.match(source, /mapProductRow/);
  assert.match(source, /mapContentJournalRow/);
  assert.match(source, /buildMarketingRecommendations/);
  assert.match(source, /BRAND_BIBLE/);
  // No second Marketing engine, and no re-ranking of what the engine returned.
  assert.doesNotMatch(source, /\.sort\(/);
  assert.doesNotMatch(source, /priority|confidence|score/i);
});
