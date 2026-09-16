import test from "node:test";
import assert from "node:assert/strict";
import {
  approvalCodeForHash,
  assertPurchasePreviewApproved,
  buildPurchasePreview,
  deterministicUuid,
  operationIdForOccasion,
  stableJson,
  type PurchaseIntent,
} from "../scripts/purchase-operator/core.ts";
import type { Ingredient, IngredientAlias } from "../src/lib/product-lab-types.ts";

function ingredient(overrides: Partial<Ingredient> = {}): Ingredient {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Egg",
    baseUnit: "pcs",
    category: "ingredient",
    currentQuantity: 20,
    lowStockThreshold: 0,
    targetStockQuantity: 0,
    nearestExpirationDate: "",
    averageUnitCost: 8,
    notes: "",
    isActive: true,
    inventoryReconciledAt: "2026-09-10T00:00:00Z",
    costReconciledAt: "2026-09-10T00:00:00Z",
    ...overrides,
  };
}

function intent(items: PurchaseIntent["items"], overrides: Partial<PurchaseIntent> = {}): PurchaseIntent {
  return {
    kind: "purchase",
    occasion_id: "2026-09-16-morning-purchase",
    items,
    ...overrides,
  };
}

test("single-item purchase preview resolves, converts, and can_apply", () => {
  const egg = ingredient();
  const preview = buildPurchasePreview({
    intent: intent([{ raw_name: "Egg", quantity: 30, unit: "pcs", total_price: 300 }]),
    ingredients: [egg], aliases: [],
  });
  assert.equal(preview.can_apply, true);
  assert.equal(preview.rows.length, 1);
  assert.equal(preview.rows[0].canonical_ingredient_id, egg.id);
  assert.equal(preview.rows[0].converted_quantity, 30);
  assert.equal(preview.rows[0].total_price, 300);
  assert.equal(preview.preview_id.startsWith("pu_"), true);
});

test("multi-item purchase preview resolves every line independently", () => {
  const egg = ingredient();
  const flour = ingredient({ id: "22222222-2222-4222-8222-222222222222", name: "Flour", baseUnit: "g", currentQuantity: 500 });
  const vanilla = ingredient({ id: "33333333-3333-4333-8333-333333333333", name: "Vanilla", baseUnit: "ml", currentQuantity: 200 });
  const preview = buildPurchasePreview({
    intent: intent([
      { raw_name: "Egg", quantity: 30, unit: "pcs", total_price: 300 },
      { raw_name: "Flour", quantity: 2, unit: "kg", total_price: 190 },
      { raw_name: "Vanilla", quantity: 1, unit: "L", total_price: 450 },
    ]),
    ingredients: [egg, flour, vanilla], aliases: [],
  });
  assert.equal(preview.can_apply, true);
  assert.deepEqual(preview.rows.map((row) => row.converted_quantity), [30, 2000, 1000]);
  assert.deepEqual(preview.rows.map((row) => row.total_price), [300, 190, 450]);
});

test("two lines of the same ingredient are both kept -- confirm_purchase_import_v2 sums them server-side", () => {
  const flour = ingredient({ id: "22222222-2222-4222-8222-222222222222", name: "Flour", baseUnit: "g", currentQuantity: 500 });
  const preview = buildPurchasePreview({
    intent: intent([
      { raw_name: "Flour", quantity: 1, unit: "kg", total_price: 95 },
      { raw_name: "Flour", quantity: 1, unit: "kg", total_price: 95 },
    ]),
    ingredients: [flour], aliases: [],
  });
  assert.equal(preview.can_apply, true);
  assert.equal(preview.rows.length, 2);
});

test("preview hash is deterministic and stable for identical input", () => {
  const egg = ingredient();
  const args = { intent: intent([{ raw_name: "Egg", quantity: 30, unit: "pcs", total_price: 300 }]), ingredients: [egg], aliases: [] as IngredientAlias[], now: "2026-09-16T00:00:00Z" };
  const one = buildPurchasePreview(args);
  const two = buildPurchasePreview(args);
  assert.equal(one.preview_id, two.preview_id);
  assert.equal(one.payload_hash, two.payload_hash);
  assert.equal(one.approval_code, two.approval_code);
  assert.equal(one.operation_id, two.operation_id);
});

test("a different occasion_id changes preview_id, payload_hash, and operation_id even for byte-identical items", () => {
  const egg = ingredient();
  const first = buildPurchasePreview({ intent: intent([{ raw_name: "Egg", quantity: 30, unit: "pcs", total_price: 300 }], { occasion_id: "occasion-a" }), ingredients: [egg], aliases: [] });
  const second = buildPurchasePreview({ intent: intent([{ raw_name: "Egg", quantity: 30, unit: "pcs", total_price: 300 }], { occasion_id: "occasion-b" }), ingredients: [egg], aliases: [] });
  assert.notEqual(first.preview_id, second.preview_id);
  assert.notEqual(first.operation_id, second.operation_id);
  assert.equal(first.operation_id, operationIdForOccasion("occasion-a"));
  assert.equal(second.operation_id, operationIdForOccasion("occasion-b"));
});

test("deterministicUuid is a pure function of namespace and value", () => {
  assert.equal(deterministicUuid("purchase_import", "pu_abc"), deterministicUuid("purchase_import", "pu_abc"));
  assert.notEqual(deterministicUuid("purchase_import", "pu_abc"), deterministicUuid("purchase_import_row", "pu_abc"));
  assert.notEqual(deterministicUuid("purchase_import", "pu_abc"), deterministicUuid("purchase_import", "pu_xyz"));
  assert.match(deterministicUuid("purchase_import", "pu_abc"), /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("exact and alias ingredient resolution behave the same as the shared matcher", () => {
  const flour = ingredient({ id: "22222222-2222-4222-8222-222222222222", name: "All-Purpose Flour", baseUnit: "g", currentQuantity: 500 });
  const alias: IngredientAlias = { id: "alias-1", rawText: "flour", normalizedText: "flour", ingredientId: flour.id, source: "manual" };
  const exactPreview = buildPurchasePreview({ intent: intent([{ raw_name: "All-Purpose Flour", quantity: 1, unit: "kg", total_price: 95 }]), ingredients: [flour], aliases: [] });
  assert.equal(exactPreview.rows[0].match_type, "exact");
  assert.equal(exactPreview.can_apply, true);
  const aliasPreview = buildPurchasePreview({ intent: intent([{ raw_name: "flour", quantity: 1, unit: "kg", total_price: 95 }]), ingredients: [flour], aliases: [alias] });
  assert.equal(aliasPreview.rows[0].match_type, "alias");
  assert.equal(aliasPreview.can_apply, true);
});

test("ambiguous ingredient names block the whole preview", () => {
  const spread = ingredient({ id: "11111111-1111-4111-8111-111111111111", name: "Biscoff Spread" });
  const biscuit = ingredient({ id: "22222222-2222-4222-8222-222222222222", name: "Biscoff Biscuit" });
  const preview = buildPurchasePreview({ intent: intent([{ raw_name: "Biscoff", quantity: 1, unit: "pcs", total_price: 100 }]), ingredients: [spread, biscuit], aliases: [] });
  assert.equal(preview.rows[0].match_status, "ambiguous");
  assert.equal(preview.can_apply, false);
});

test("an unmatched ingredient name blocks the whole preview", () => {
  const preview = buildPurchasePreview({ intent: intent([{ raw_name: "Nonexistent Item", quantity: 1, unit: "pcs", total_price: 100 }]), ingredients: [], aliases: [] });
  assert.equal(preview.rows[0].match_status, "unmatched");
  assert.equal(preview.can_apply, false);
});

test("an unsupported unit blocks the row and never guesses a conversion", () => {
  const egg = ingredient();
  const preview = buildPurchasePreview({ intent: intent([{ raw_name: "Egg", quantity: 1, unit: "bottle", total_price: 450 }]), ingredients: [egg], aliases: [] });
  assert.equal(preview.can_apply, false);
  assert.ok(preview.rows[0].errors.some((error) => error.includes("Unsupported purchase unit")));
});

test("a mass/volume family-crossing unit blocks the row", () => {
  const flour = ingredient({ id: "22222222-2222-4222-8222-222222222222", name: "Flour", baseUnit: "g", currentQuantity: 500 });
  const preview = buildPurchasePreview({ intent: intent([{ raw_name: "Flour", quantity: 1, unit: "L", total_price: 95 }]), ingredients: [flour], aliases: [] });
  assert.equal(preview.can_apply, false);
  assert.ok(preview.rows[0].errors.some((error) => error.includes("incompatible")));
});

test("missing or non-positive quantity blocks the row", () => {
  const egg = ingredient();
  for (const items of [
    [{ raw_name: "Egg", unit: "pcs", total_price: 300 }],
    [{ raw_name: "Egg", quantity: 0, unit: "pcs", total_price: 300 }],
    [{ raw_name: "Egg", quantity: -5, unit: "pcs", total_price: 300 }],
    [{ raw_name: "Egg", quantity: Number.POSITIVE_INFINITY, unit: "pcs", total_price: 300 }],
  ] as PurchaseIntent["items"][]) {
    const preview = buildPurchasePreview({ intent: intent(items), ingredients: [egg], aliases: [] });
    assert.equal(preview.can_apply, false, JSON.stringify(items));
  }
});

test("missing or negative total price blocks the row", () => {
  const egg = ingredient();
  for (const items of [
    [{ raw_name: "Egg", quantity: 30, unit: "pcs" }],
    [{ raw_name: "Egg", quantity: 30, unit: "pcs", total_price: -1 }],
    [{ raw_name: "Egg", quantity: 30, unit: "pcs", total_price: Number.NaN }],
  ] as PurchaseIntent["items"][]) {
    const preview = buildPurchasePreview({ intent: intent(items), ingredients: [egg], aliases: [] });
    assert.equal(preview.can_apply, false, JSON.stringify(items));
  }
});

test("a zero total price is allowed (a free/sample item is still a valid stock addition)", () => {
  const egg = ingredient();
  const preview = buildPurchasePreview({ intent: intent([{ raw_name: "Egg", quantity: 30, unit: "pcs", total_price: 0 }]), ingredients: [egg], aliases: [] });
  assert.equal(preview.can_apply, true);
});

test("an ingredient whose physical stock has never been verified blocks the row", () => {
  const egg = ingredient({ inventoryReconciledAt: null });
  const preview = buildPurchasePreview({ intent: intent([{ raw_name: "Egg", quantity: 30, unit: "pcs", total_price: 300 }]), ingredients: [egg], aliases: [] });
  assert.equal(preview.can_apply, false);
  assert.ok(preview.rows[0].errors.some((error) => error.includes("Verify the physical stock")));
});

test("missing occasion_id or an empty item list blocks the preview", () => {
  const egg = ingredient();
  const noOccasion = buildPurchasePreview({ intent: intent([{ raw_name: "Egg", quantity: 30, unit: "pcs", total_price: 300 }], { occasion_id: "" }), ingredients: [egg], aliases: [] });
  assert.equal(noOccasion.can_apply, false);
  const noItems = buildPurchasePreview({ intent: intent([]), ingredients: [egg], aliases: [] });
  assert.equal(noItems.can_apply, false);
});

test("assertPurchasePreviewApproved accepts an exact, unmodified, correctly-coded preview", () => {
  const egg = ingredient();
  const preview = buildPurchasePreview({ intent: intent([{ raw_name: "Egg", quantity: 30, unit: "pcs", total_price: 300 }]), ingredients: [egg], aliases: [] });
  assert.doesNotThrow(() => assertPurchasePreviewApproved(preview, preview.approval_code));
  assert.doesNotThrow(() => assertPurchasePreviewApproved(preview, preview.approval_code.toLowerCase()));
});

test("assertPurchasePreviewApproved rejects a mismatched approval code", () => {
  const egg = ingredient();
  const preview = buildPurchasePreview({ intent: intent([{ raw_name: "Egg", quantity: 30, unit: "pcs", total_price: 300 }]), ingredients: [egg], aliases: [] });
  assert.throws(() => assertPurchasePreviewApproved(preview, "0000-0000"), /Approval code does not match/);
});

test("assertPurchasePreviewApproved rejects a preview whose payload was mutated after hashing (stale/tampered)", () => {
  const egg = ingredient();
  const preview = buildPurchasePreview({ intent: intent([{ raw_name: "Egg", quantity: 30, unit: "pcs", total_price: 300 }]), ingredients: [egg], aliases: [] });
  const tampered = { ...preview, rows: [{ ...preview.rows[0], converted_quantity: 9999 }] };
  assert.throws(() => assertPurchasePreviewApproved(tampered, preview.approval_code), /Preview payload changed/);
});

test("assertPurchasePreviewApproved rejects a preview that can_apply: false", () => {
  const preview = buildPurchasePreview({ intent: intent([{ raw_name: "Nonexistent", quantity: 1, unit: "pcs", total_price: 1 }]), ingredients: [], aliases: [] });
  assert.throws(() => assertPurchasePreviewApproved(preview, preview.approval_code), /blocking errors/);
});

test("stable JSON hashing rejects non-finite numbers, matching the shared V1A hashing helper's contract", () => {
  assert.throws(() => stableJson(Number.NaN), /non-finite/);
  assert.throws(() => stableJson(Number.POSITIVE_INFINITY), /non-finite/);
  assert.equal(approvalCodeForHash("0123456789abcdef".repeat(4)), "0123-4567");
});
