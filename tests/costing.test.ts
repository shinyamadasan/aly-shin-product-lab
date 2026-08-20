import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { buildCostingSummaryPayload, findConflictingCosting, formatCostingMetric, getCostingMetrics, getCostingTotals, getUncostedBatches, isBatchProductMismatch, resolveCostingId } from "../src/lib/costing.ts";
import { isDuplicateKeyError } from "../src/lib/database-errors.ts";
import type { CostingSummary, ProductBatch } from "../src/lib/product-lab-types.ts";

function baseCosting(overrides: Partial<CostingSummary> = {}): CostingSummary {
  return {
    id: "costing-1",
    productId: "product-1",
    batchId: "",
    ingredientCost: 200,
    packagingCost: 20,
    laborEstimate: 100,
    waterCost: 5,
    gasCost: 10,
    ovenElectricCost: 8,
    refrigerationCost: 2,
    coffeeEquipmentCost: 0,
    wasteAllowance: 15,
    overheadCost: 30,
    equipmentCost: 10,
    suggestedPrice: 50,
    notes: "Costing yield: 8",
    ...overrides,
  };
}

function baseBatch(overrides: Partial<ProductBatch> = {}): ProductBatch {
  return {
    id: "batch-1",
    productId: "product-1",
    batchVersion: "V1",
    dateMade: "2026-01-01",
    ingredientsNotes: "",
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
    launchDecision: "retest",
    ...overrides,
  };
}

test("zero yield returns no unit cost (never the whole batch cost)", () => {
  const metrics = getCostingMetrics({
    costingYield: 0,
    directCost: 300,
    indirectCost: 100,
    suggestedPrice: 50,
    targetFoodCost: 0.35,
    totalBatchCost: 400,
  });

  assert.equal(metrics.costPerPiece, null);
});

test("zero yield does not generate a misleading margin", () => {
  const metrics = getCostingMetrics({
    costingYield: 0,
    directCost: 300,
    indirectCost: 100,
    suggestedPrice: 50,
    targetFoodCost: 0.35,
    totalBatchCost: 400,
  });

  assert.equal(metrics.margin, null);
  assert.equal(metrics.grossProfit, null);
  assert.equal(metrics.foodCostPercent, null);
  assert.equal(metrics.markup, null);
  assert.equal(metrics.targetPrice, null);
  assert.equal(metrics.contributionMarginPerPiece, null);
  assert.equal(metrics.breakEvenUnits, null);
});

test("negative yield is treated the same as missing yield", () => {
  const metrics = getCostingMetrics({
    costingYield: -3,
    directCost: 300,
    indirectCost: 100,
    suggestedPrice: 50,
    targetFoodCost: 0.35,
    totalBatchCost: 400,
  });

  assert.equal(metrics.costPerPiece, null);
});

test("a real yield produces the expected unit cost and margin", () => {
  const metrics = getCostingMetrics({
    costingYield: 8,
    directCost: 320,
    indirectCost: 80,
    suggestedPrice: 50,
    targetFoodCost: 0.35,
    totalBatchCost: 400,
  });

  assert.equal(metrics.costPerPiece, 50);
  assert.equal(metrics.grossProfit, 0);
  assert.equal(metrics.margin, 0);
});

test("getCostingTotals never substitutes total batch cost for cost per piece when yield is missing", () => {
  const costing = baseCosting({ notes: "" });
  const totals = getCostingTotals(costing);

  assert.equal(totals.costingYield, 0);
  assert.notEqual(totals.costPerPiece, totals.totalBatchCost);
  assert.equal(totals.costPerPiece, null);
  assert.equal(totals.margin, null);
});

test("getCostingTotals produces a real cost per piece once yield is present", () => {
  const costing = baseCosting();
  const totals = getCostingTotals(costing);

  assert.equal(totals.costingYield, 8);
  assert.equal(totals.costPerPiece, totals.totalBatchCost / 8);
  assert.notEqual(totals.margin, null);
});

test("Product Detail's totals and Costing's live metrics agree for the same saved costing", () => {
  const costing = baseCosting();
  const totals = getCostingTotals(costing);

  const liveMetrics = getCostingMetrics({
    costingYield: totals.costingYield,
    directCost: totals.directCost,
    indirectCost: totals.indirectCost,
    suggestedPrice: costing.suggestedPrice,
    targetFoodCost: 0,
    totalBatchCost: totals.totalBatchCost,
  });

  assert.equal(totals.costPerPiece, liveMetrics.costPerPiece);
  assert.equal(totals.margin, liveMetrics.margin);
});

test("formatCostingMetric shows the unavailable label for null and formats real numbers", () => {
  assert.equal(formatCostingMetric(null, (value) => `PHP ${value.toFixed(2)}`), "Need yield");
  assert.equal(formatCostingMetric(null, (value) => `PHP ${value.toFixed(2)}`, "needs yield"), "needs yield");
  assert.equal(formatCostingMetric(12.5, (value) => `PHP ${value.toFixed(2)}`), "PHP 12.50");
});

test("findConflictingCosting: first costing for a batch succeeds (no conflict)", () => {
  const conflict = findConflictingCosting([], { costingId: "", productId: "product-1", batchId: "batch-1" });
  assert.equal(conflict, null);
});

test("findConflictingCosting: second costing for the same batch is rejected", () => {
  const existing = baseCosting({ id: "costing-1", batchId: "batch-1" });
  const conflict = findConflictingCosting([existing], { costingId: "", productId: "product-1", batchId: "batch-1" });
  assert.equal(conflict, existing);
});

test("findConflictingCosting: editing the existing costing succeeds (excludes itself)", () => {
  const existing = baseCosting({ id: "costing-1", batchId: "batch-1" });
  const conflict = findConflictingCosting([existing], { costingId: "costing-1", productId: "product-1", batchId: "batch-1" });
  assert.equal(conflict, null);
});

test("findConflictingCosting: moving another costing onto an occupied batch is rejected", () => {
  const occupant = baseCosting({ id: "costing-1", batchId: "batch-1" });
  const mover = baseCosting({ id: "costing-2", batchId: "batch-2" });
  const conflict = findConflictingCosting([occupant, mover], { costingId: "costing-2", productId: "product-1", batchId: "batch-1" });
  assert.equal(conflict, occupant);
});

test("findConflictingCosting: two different batches of the same product can each have a costing", () => {
  const first = baseCosting({ id: "costing-1", batchId: "batch-1" });
  const conflict = findConflictingCosting([first], { costingId: "", productId: "product-1", batchId: "batch-2" });
  assert.equal(conflict, null);
});

test("findConflictingCosting: only one unlinked costing per product is allowed", () => {
  const existing = baseCosting({ id: "costing-1", batchId: "" });
  const conflict = findConflictingCosting([existing], { costingId: "", productId: "product-1", batchId: "" });
  assert.equal(conflict, existing);
});

test("getUncostedBatches: a proof batch with no batch-linked costing remains visible for costing", () => {
  const v6 = baseBatch({ id: "batch-v6", batchVersion: "V6" });
  const v7 = baseBatch({ id: "batch-v7", batchVersion: "V7" });
  const v8 = baseBatch({ id: "batch-v8", batchVersion: "V8" });
  const costings = [
    baseCosting({ id: "costing-v6", batchId: "batch-v6" }),
    baseCosting({ id: "costing-v8", batchId: "batch-v8" }),
    baseCosting({ id: "legacy-product-costing", batchId: "" }),
  ];

  assert.deepEqual(getUncostedBatches([v8, v7, v6], costings), [v7]);
});

test("findConflictingCosting: unlinked costings for different products do not conflict", () => {
  const existing = baseCosting({ id: "costing-1", productId: "product-1", batchId: "" });
  const conflict = findConflictingCosting([existing], { costingId: "", productId: "product-2", batchId: "" });
  assert.equal(conflict, null);
});

test("isDuplicateKeyError: Postgres 23505 is recognized as a duplicate-key error", () => {
  assert.equal(isDuplicateKeyError({ code: "23505" }), true);
});

test("isDuplicateKeyError: other error codes and missing errors are not duplicate-key errors", () => {
  assert.equal(isDuplicateKeyError({ code: "23503" }), false);
  assert.equal(isDuplicateKeyError(null), false);
  assert.equal(isDuplicateKeyError(undefined), false);
});

test("isBatchProductMismatch: a batch that belongs to the submitted product is not a mismatch", () => {
  const batch = baseBatch({ id: "batch-1", productId: "product-1" });
  assert.equal(isBatchProductMismatch([batch], { productId: "product-1", batchId: "batch-1" }), false);
});

test("isBatchProductMismatch: a batch that belongs to a different product is a mismatch", () => {
  const batch = baseBatch({ id: "batch-1", productId: "product-1" });
  assert.equal(isBatchProductMismatch([batch], { productId: "product-2", batchId: "batch-1" }), true);
});

test("isBatchProductMismatch: a batch id that doesn't exist is a mismatch", () => {
  assert.equal(isBatchProductMismatch([], { productId: "product-1", batchId: "missing-batch" }), true);
});

test("isBatchProductMismatch: an empty batchId (unlinked legacy costing) is never a mismatch", () => {
  assert.equal(isBatchProductMismatch([], { productId: "product-1", batchId: "" }), false);
});

test("resolveCostingId: editing an existing costing always returns that exact id, never a fresh one", () => {
  assert.equal(resolveCostingId("costing-1"), "costing-1");
  assert.equal(resolveCostingId("costing-1"), resolveCostingId("costing-1"));
});

test("resolveCostingId: a new costing (empty costingId) gets a real, non-empty generated id", () => {
  const id = resolveCostingId("");
  assert.notEqual(id, "");
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
});

test("resolveCostingId: two separate new costings never collide on the same generated id", () => {
  assert.notEqual(resolveCostingId(""), resolveCostingId(""));
});

test("buildCostingSummaryPayload: the costing's id is included in the Supabase payload -- the bug this fixes", () => {
  const costing = baseCosting({ id: "costing-abc" });
  const payload = buildCostingSummaryPayload(costing);
  assert.equal(payload.id, "costing-abc");
  assert.equal(payload.id, costing.id);
});

test("buildCostingSummaryPayload: a freshly resolved id for a new costing round-trips into the payload unchanged", () => {
  const newId = resolveCostingId("");
  const costing = baseCosting({ id: newId });
  const payload = buildCostingSummaryPayload(costing);
  assert.equal(payload.id, newId);
});

test("buildCostingSummaryPayload: maps every other field to its snake_case column", () => {
  const costing = baseCosting({
    batchId: "batch-1",
    coffeeEquipmentCost: 1,
    gasCost: 2,
    ovenElectricCost: 3,
    refrigerationCost: 4,
    waterCost: 5,
  });
  const payload = buildCostingSummaryPayload(costing);

  assert.equal(payload.product_id, costing.productId);
  assert.equal(payload.batch_id, "batch-1");
  assert.equal(payload.ingredient_cost, costing.ingredientCost);
  assert.equal(payload.packaging_cost, costing.packagingCost);
  assert.equal(payload.labor_estimate, costing.laborEstimate);
  assert.equal(payload.utilities_estimate, 5 + 2 + 3 + 4 + 1);
  assert.equal(payload.waste_allowance, costing.wasteAllowance);
  assert.equal(payload.overhead_cost, costing.overheadCost);
  assert.equal(payload.equipment_cost, costing.equipmentCost);
  assert.equal(payload.suggested_price, costing.suggestedPrice);
  assert.equal(payload.notes, costing.notes);
});

test("buildCostingSummaryPayload: an unlinked (legacy) costing's empty batchId becomes null, not an empty string", () => {
  const costing = baseCosting({ batchId: "" });
  const payload = buildCostingSummaryPayload(costing);
  assert.equal(payload.batch_id, null);
});

// --- updated_at maintenance (SP1) -------------------------------------------------------------
//
// costing_summaries.updated_at existed since the table was created but nothing wrote it after the
// insert default, and no trigger maintains it -- so it could not answer "has this costing been
// reviewed since?". These tests pin the fix: the shared payload builder writes it on every save,
// and an injected timestamp stays exact so callers (and later Business Context Builder slices) can
// reason about it deterministically.
//
// The static tests below deliberately scan line-by-line rather than with multi-line regexes.
// tests/creative-package-asset-create.test.ts uses a regex ending in `\n\1\}\n`, which silently
// fails against a CRLF checkout (core.autocrlf=true on Windows) even though the code it looks for
// is present. Splitting on /\r?\n/ and matching single-line substrings is CRLF-agnostic.

function readRepoFile(relativePath: string): string {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

function toLines(source: string): string[] {
  return source.split(/\r?\n/);
}

test("buildCostingSummaryPayload: the payload includes updated_at", () => {
  const payload = buildCostingSummaryPayload(baseCosting());
  assert.ok("updated_at" in payload, "payload must carry updated_at so the column stops being a second created_at");
  assert.equal(typeof payload.updated_at, "string");
});

test("buildCostingSummaryPayload: an explicitly injected timestamp is preserved exactly", () => {
  const injected = "2026-08-06T01:23:45.678Z";
  const payload = buildCostingSummaryPayload(baseCosting(), injected);
  assert.equal(payload.updated_at, injected);
});

test("buildCostingSummaryPayload: two different injected timestamps produce two different updated_at values", () => {
  // The behaviour a costing-freshness comparison depends on: editing a costing must move the
  // timestamp, not leave it pinned at creation time.
  const first = buildCostingSummaryPayload(baseCosting(), "2026-08-01T00:00:00.000Z");
  const second = buildCostingSummaryPayload(baseCosting(), "2026-08-06T00:00:00.000Z");
  assert.notEqual(first.updated_at, second.updated_at);
  assert.ok(Date.parse(second.updated_at) > Date.parse(first.updated_at));
});

test("buildCostingSummaryPayload: the default is a current absolute UTC ISO instant, not a localized date", () => {
  const before = Date.now();
  const payload = buildCostingSummaryPayload(baseCosting());
  const after = Date.now();

  const parsed = Date.parse(payload.updated_at);
  assert.ok(Number.isFinite(parsed), "default must parse as a real timestamp");
  assert.ok(parsed >= before && parsed <= after, "default must be read at call time, not module load");
  // Absolute UTC instant -- this is a database audit column, never a business-day value.
  assert.match(payload.updated_at, /Z$/);
  assert.equal(payload.updated_at, new Date(parsed).toISOString());
});

test("buildCostingSummaryPayload: every pre-existing payload field is unchanged by the updated_at addition", () => {
  const costing = baseCosting({ batchId: "batch-1", coffeeEquipmentCost: 1, gasCost: 2, ovenElectricCost: 3, refrigerationCost: 4, waterCost: 5 });
  const payload = buildCostingSummaryPayload(costing, "2026-08-06T00:00:00.000Z");

  assert.equal(payload.id, costing.id);
  assert.equal(payload.product_id, costing.productId);
  assert.equal(payload.batch_id, "batch-1");
  assert.equal(payload.ingredient_cost, costing.ingredientCost);
  assert.equal(payload.packaging_cost, costing.packagingCost);
  assert.equal(payload.labor_estimate, costing.laborEstimate);
  assert.equal(payload.utilities_estimate, 5 + 2 + 3 + 4 + 1);
  assert.equal(payload.waste_allowance, costing.wasteAllowance);
  assert.equal(payload.overhead_cost, costing.overheadCost);
  assert.equal(payload.equipment_cost, costing.equipmentCost);
  assert.equal(payload.suggested_price, costing.suggestedPrice);
  assert.equal(payload.notes, costing.notes);

  // updated_at is the only new key -- nothing was dropped, renamed, or silently added alongside it.
  const expectedKeys = [
    "id", "product_id", "batch_id", "ingredient_cost", "packaging_cost", "labor_estimate",
    "utilities_estimate", "waste_allowance", "overhead_cost", "equipment_cost", "suggested_price",
    "notes", "updated_at",
  ];
  assert.deepEqual(Object.keys(payload).sort(), expectedKeys.sort());
});

test("[static] CostingSummary does not gain an updatedAt field", () => {
  // The in-memory type stays untouched on purpose: adding updatedAt would ripple into the
  // localStorage fallback mode, the Costing form, and every row mapper, for no read-side benefit.
  const lines = toLines(readRepoFile("src/lib/product-lab-types.ts"));
  const start = lines.findIndex((line) => line.trim() === "export type CostingSummary = {");
  assert.notEqual(start, -1, "CostingSummary type declaration not found -- test fixture is stale.");

  const end = lines.findIndex((line, index) => index > start && line.trim() === "};");
  assert.notEqual(end, -1, "CostingSummary type has no closing brace -- test fixture is stale.");

  const body = lines.slice(start + 1, end).join("\n");
  assert.doesNotMatch(body, /updatedAt/, "CostingSummary must not gain updatedAt (SP1 keeps the change database-side only)");
});

test("[static] both costing_summaries write paths go through the shared payload builder", () => {
  const lines = toLines(readRepoFile("src/app/product-lab.tsx"));

  const builderCall = lines.filter((line) => line.includes("buildCostingSummaryPayload(") && !line.trim().startsWith("//") && !line.includes("import "));
  assert.equal(builderCall.length, 2, "expected normal save and create_batch_with_costing RPC call sites to use buildCostingSummaryPayload");
  assert.ok(builderCall.some((line) => line.includes("p_costing: buildCostingSummaryPayload(costing)")), "the atomic batch + costing RPC must receive the shared costing payload");

  const writes = lines.filter((line) => line.includes('from("costing_summaries")') && (line.includes(".insert(") || line.includes(".update(") || line.includes(".upsert(")));
  assert.equal(writes.length, 2, "expected exactly two costing_summaries write call sites (one insert, one update)");
  assert.ok(writes.some((line) => line.includes(".update(")), "the update path must exist");
  assert.ok(writes.some((line) => line.includes(".insert(")), "the insert path must exist");
  for (const line of writes) {
    assert.match(line, /payload/, "every costing_summaries write must pass the shared payload, never an inline literal");
  }
});

test("[static] no module other than product-lab.tsx writes costing_summaries", () => {
  // If a second writer ever appears -- an import path, a repair utility, a worker, an RPC wrapper --
  // it would bypass the payload builder and silently reintroduce the unmaintained-timestamp bug.
  const offenders: string[] = [];

  for (const root of ["src", "scripts"]) {
    const entries = readdirSync(new URL(`../${root}`, import.meta.url), { recursive: true, encoding: "utf8" });
    for (const entry of entries) {
      const relative = `${root}/${entry.split("\\").join("/")}`;
      if (!relative.endsWith(".ts") && !relative.endsWith(".tsx")) {
        continue;
      }
      if (relative === "src/app/product-lab.tsx") {
        continue;
      }
      for (const line of toLines(readRepoFile(relative))) {
        if (line.includes('from("costing_summaries")') && (line.includes(".insert(") || line.includes(".update(") || line.includes(".upsert("))) {
          offenders.push(`${relative}: ${line.trim()}`);
        }
      }
    }
  }

  assert.deepEqual(offenders, [], "costing_summaries must have exactly one writing module");
});
