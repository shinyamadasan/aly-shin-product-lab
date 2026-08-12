import test from "node:test";
import assert from "node:assert/strict";
import { loadSupabaseContext, type SupabaseLikeClient } from "../scripts/daily-advisor/supabase-read.ts";
import { getProductList } from "../scripts/daily-advisor/sample-fixtures.ts";
import { detectOrphanedRecords } from "../scripts/daily-advisor/orphan-check.ts";
import { buildDailyAdvisorOpportunities } from "../scripts/daily-advisor/opportunity-producer.ts";
import { products as sampleProducts } from "../src/lib/sample-data.ts";
import { mapProductRow, type ProductRow } from "../src/lib/supabase-mappers.ts";
import type { Product } from "../src/lib/product-lab-types.ts";
import type { ProductEvaluation } from "../scripts/daily-advisor/types.ts";
import type { RuleEngineContext, RuleResult } from "../src/lib/rule-engine/index.ts";

// Content Creation MVP S0b -- the Daily Advisor's product catalog must follow --source. Before this
// slice run.ts called getProductList() unconditionally, so --source supabase evaluated REAL
// batches/costings/tastings against FIXTURE product identities.
//
// The live catalog is a hybrid: six legacy slug ids that happen to match the fixtures, plus newer
// rows with UUID ids that have no fixture counterpart at all. Those UUID products are the ones the
// old path silently dropped from every ranking and every Opportunity, so they anchor most of the
// tests below.

const FIXED_NOW = Date.parse("2026-08-12T09:00:00.000Z");
const CREDENTIALS = { email: "a@b.com", password: "x" };

// A real Aly & Pon product id observed in live Supabase data: a UUID, absent from sample-data.ts.
const LIVE_ONLY_ID = "be801165-6d37-469d-8cd7-ba4d9f545ff6";
const LIVE_ONLY_NAME = "Blondies";

function productRow(overrides: Partial<ProductRow> = {}): ProductRow {
  return {
    id: LIVE_ONLY_ID,
    name: LIVE_ONLY_NAME,
    category: "Baked goods",
    product_role: "Hero candidate",
    status: "testing",
    description: "Brown butter blondie.",
    notes: null,
    main_photo_url: null,
    decision: "Candidate",
    is_public: true,
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

function batchRow(productId: string, id = "b1") {
  return {
    id,
    product_id: productId,
    batch_version: "V1",
    date_made: "2026-08-01",
    ingredients_notes: "{}",
    usable_pieces: 8,
    imperfect_pieces: 0,
    launch_decision: "launch",
  };
}

function stubClient(rows: Record<string, Record<string, unknown>[]>): SupabaseLikeClient {
  return {
    auth: { async signInWithPassword() { return { error: null }; } },
    from(table: string) {
      return {
        select() {
          return {
            async order() {
              return { data: rows[table] ?? [], error: null };
            },
          };
        },
      };
    },
  };
}

// ---- A + D: Supabase mode reads real products, through the shared mapper ----

test("loadSupabaseContext returns the live products table, mapped by the shared mapProductRow", async () => {
  const row = productRow();
  const result = await loadSupabaseContext(stubClient({ products: [row], product_batches: [batchRow(LIVE_ONLY_ID)] }), CREDENTIALS, FIXED_NOW);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.products.length, 1);
  // Deep-equal against the shared mapper's own output, so this can never drift from its contract.
  assert.deepEqual(result.products[0], mapProductRow(row));
});

test("a products read error fails the load, never a silent fixture fallback", async () => {
  const client: SupabaseLikeClient = {
    auth: { async signInWithPassword() { return { error: null }; } },
    from(table: string) {
      return {
        select() {
          return {
            async order() {
              if (table === "products") return { data: null, error: { message: "permission denied for table products" } };
              return { data: table === "product_batches" ? [batchRow("brownies")] : [], error: null };
            },
          };
        },
      };
    },
  };

  const result = await loadSupabaseContext(client, CREDENTIALS, FIXED_NOW);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /Supabase read failed: permission denied for table products/);
});

// ---- E: empty catalog is deterministic and safe, never silently trusted ----

test("an empty catalog beside real operational rows fails loudly rather than reporting nothing to do", async () => {
  const result = await loadSupabaseContext(stubClient({ products: [], product_batches: [batchRow("brownies")] }), CREDENTIALS, FIXED_NOW);

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /products table returned zero rows/);
    assert.match(result.reason, /RLS/);
  }
});

test("an empty catalog with no operational rows still trips the pre-existing all-zero guard", async () => {
  const result = await loadSupabaseContext(stubClient({ products: [], product_batches: [], costing_summaries: [], tasting_feedback: [] }), CREDENTIALS, FIXED_NOW);

  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /zero rows/);
});

// ---- J: fixture products cannot leak into Supabase mode ----

test("a product that exists only in sample-data.ts never appears in the Supabase-mode catalog", async () => {
  // "revel-bars" is in the fixture list. The live read below does not return it.
  assert.ok(sampleProducts.some((product) => product.id === "revel-bars"), "fixture precondition");

  const result = await loadSupabaseContext(stubClient({ products: [productRow()], product_batches: [batchRow(LIVE_ONLY_ID)] }), CREDENTIALS, FIXED_NOW);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  const ids = result.products.map((product) => product.id);
  assert.deepEqual(ids, [LIVE_ONLY_ID]);
  for (const fixture of sampleProducts) {
    assert.ok(!ids.includes(fixture.id), `fixture product "${fixture.id}" leaked into the Supabase catalog`);
  }
});

// ---- B: sample mode is untouched ----

test("getProductList still returns the sample fixtures, for --source sample", () => {
  assert.deepEqual(getProductList(), sampleProducts);
});

// ---- F + I: identity joins, and the exact defect S0b fixes ----

test("a live product absent from the fixtures is no longer orphaned once the live catalog is used", async () => {
  const context: RuleEngineContext = {
    batches: [{ id: "b1", productId: LIVE_ONLY_ID } as RuleEngineContext["batches"][number]],
    costings: [{ id: "c1", productId: LIVE_ONLY_ID } as RuleEngineContext["costings"][number]],
    tastings: [{ id: "t1", productId: LIVE_ONLY_ID } as RuleEngineContext["tastings"][number]],
    supplies: [],
    now: FIXED_NOW,
  };

  // The old behaviour: the fixture catalog has no row with this UUID, so every real record for it
  // was counted as an orphan and -- per orphan-check.ts -- excluded from every ranking.
  const underFixtureCatalog = detectOrphanedRecords(context, sampleProducts);
  assert.equal(underFixtureCatalog.total, 3);

  // The new behaviour: the live catalog contains it, so nothing is orphaned.
  const result = await loadSupabaseContext(stubClient({ products: [productRow()], product_batches: [batchRow(LIVE_ONLY_ID)] }), CREDENTIALS, FIXED_NOW);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const underLiveCatalog = detectOrphanedRecords(context, result.products);
  assert.equal(underLiveCatalog.total, 0);
});

test("legacy slug ids still join correctly -- the live catalog is a hybrid, not a replacement", async () => {
  const context: RuleEngineContext = {
    batches: [{ id: "b1", productId: "brownies" } as RuleEngineContext["batches"][number]],
    costings: [],
    tastings: [],
    supplies: [],
    now: FIXED_NOW,
  };

  const result = await loadSupabaseContext(
    stubClient({ products: [productRow({ id: "brownies", name: "Brownies" })], product_batches: [batchRow("brownies")] }),
    CREDENTIALS,
    FIXED_NOW,
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(detectOrphanedRecords(context, result.products).total, 0);
});

// ---- G + H: downstream semantics are unchanged; only the identities flowing in are correct ----

function evaluationFor(product: Product): ProductEvaluation {
  const passing: RuleResult = { id: "LAUNCH-001", category: "launch", severity: "blocker", passed: true, message: "ok", recommendation: "none" };
  return {
    product,
    ruleEngineOutput: { productHealth: "ready", readinessPercentage: 100, blockers: [], warnings: [], infos: [], insufficientData: [], nextBestAction: null, ruleResults: [passing] },
    experimentSignal: null,
  };
}

test("an Opportunity for a live-only product carries its real id through evidence, sourceId and the dedup key", () => {
  const product = mapProductRow(productRow());
  const context: RuleEngineContext = {
    batches: [{ id: "b1", productId: LIVE_ONLY_ID, batchVersion: "V1", dateMade: "2026-08-01", usablePieces: 8, imperfectPieces: 0, launchDecision: "launch" } as RuleEngineContext["batches"][number]],
    costings: [{ id: "c1", productId: LIVE_ONLY_ID, batchId: "b1", suggestedPrice: 200, notes: "Costing yield: 8" } as RuleEngineContext["costings"][number]],
    tastings: [{ id: "t1", productId: LIVE_ONLY_ID, batchId: "b1", rating: 9 } as RuleEngineContext["tastings"][number]],
    supplies: [],
    now: FIXED_NOW,
  };

  const drafts = buildDailyAdvisorOpportunities({
    evaluations: [evaluationFor(product)],
    context,
    date: "2026-08-12",
    timezone: "Asia/Manila",
    dataSource: "supabase",
    detectedAt: new Date(FIXED_NOW).toISOString(),
  });

  assert.equal(drafts.length, 1);
  const draft = drafts[0];
  // The identity the whole downstream pipeline keys off -- and the field CreativeInput will read.
  assert.equal((draft.evidence.product as { id: string }).id, LIVE_ONLY_ID);
  assert.equal((draft.evidence.product as { name: string }).name, LIVE_ONLY_NAME);
  assert.match(draft.title, new RegExp(LIVE_ONLY_NAME));
  assert.match(draft.sourceId, new RegExp(LIVE_ONLY_ID));
  assert.match(draft.deduplicationKey, new RegExp(`entity:product=${LIVE_ONLY_ID}`));
  // Unchanged producer semantics: same type, action and lifecycle as every other Daily Advisor draft.
  assert.equal(draft.opportunityType, "product_marketing_content");
  assert.equal(draft.recommendedAction, "create_content");
  assert.equal(draft.status, "new");
});

test("the producer is unchanged: identical evaluations and context yield identical drafts", () => {
  const product = mapProductRow(productRow());
  const context: RuleEngineContext = {
    batches: [{ id: "b1", productId: LIVE_ONLY_ID, batchVersion: "V1", dateMade: "2026-08-01", usablePieces: 8, imperfectPieces: 0, launchDecision: "launch" } as RuleEngineContext["batches"][number]],
    costings: [{ id: "c1", productId: LIVE_ONLY_ID, batchId: "b1", suggestedPrice: 200, notes: "Costing yield: 8" } as RuleEngineContext["costings"][number]],
    tastings: [{ id: "t1", productId: LIVE_ONLY_ID, batchId: "b1", rating: 9 } as RuleEngineContext["tastings"][number]],
    supplies: [],
    now: FIXED_NOW,
  };
  const input = {
    evaluations: [evaluationFor(product)],
    context,
    date: "2026-08-12",
    timezone: "Asia/Manila",
    dataSource: "supabase" as const,
    detectedAt: new Date(FIXED_NOW).toISOString(),
  };

  assert.deepEqual(buildDailyAdvisorOpportunities(input), buildDailyAdvisorOpportunities(input));
});
