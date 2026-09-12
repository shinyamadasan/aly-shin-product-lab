import test from "node:test";
import assert from "node:assert/strict";
import {
  approvalCodeForHash,
  assertPreviewApproved,
  batchRpcArgs,
  buildCountPreview,
  operationIdForOccurrence,
  reconciliationSnapshotMismatches,
  sha256Hex,
  type PhysicalCountIntent,
} from "../scripts/inventory-operator/core.ts";
import { assertUnprivilegedSupabaseProjectKey } from "../scripts/inventory-operator/credentials.ts";
import { resolveIngredientReferenceDetailed } from "../src/lib/ingredient-matching.ts";
import type { Ingredient, IngredientAlias, InventoryTransaction } from "../src/lib/product-lab-types.ts";

function ingredient(overrides: Partial<Ingredient> = {}): Ingredient {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Butter",
    baseUnit: "g",
    category: "ingredient",
    currentQuantity: 900,
    lowStockThreshold: 0,
    targetStockQuantity: 0,
    nearestExpirationDate: "",
    averageUnitCost: 1,
    notes: "",
    isActive: true,
    inventoryReconciledAt: "2026-09-10T00:00:00Z",
    costReconciledAt: "2026-09-10T00:00:00Z",
    ...overrides,
  };
}

function movement(item = ingredient()): InventoryTransaction {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    ingredientId: item.id,
    transactionType: "purchase",
    quantityBefore: 0,
    quantityAfter: item.currentQuantity,
    quantityChange: item.currentQuantity,
    sourceType: "manual",
    sourceId: "source",
    note: "",
    createdAt: "2026-09-11T00:00:00Z",
  };
}

function intent(rows: PhysicalCountIntent["rows"]): PhysicalCountIntent {
  return {
    kind: "physical_count",
    source: { name: "count.txt", fingerprint: sha256Hex("Butter,1.6,kg"), occurrence_id: "2026-09-12-morning-count" },
    rows,
  };
}

function unsignedJwt(role: string): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "HS256", typ: "JWT" })}.${part({ role })}.test-signature`;
}

test("project key validation allows publishable/legacy anon and rejects privileged or malformed forms locally", () => {
  assert.equal(assertUnprivilegedSupabaseProjectKey("sb_publishable_test_public_key"), "publishable");
  assert.equal(assertUnprivilegedSupabaseProjectKey(unsignedJwt("anon")), "legacy_anon");
  assert.throws(() => assertUnprivilegedSupabaseProjectKey("sb_secret_test_privileged_key"), /not allowed/);
  assert.throws(() => assertUnprivilegedSupabaseProjectKey("sb_admin_test_privileged_key"), /not allowed/);
  assert.throws(() => assertUnprivilegedSupabaseProjectKey(unsignedJwt("service_role")), /service-role/);
  assert.throws(() => assertUnprivilegedSupabaseProjectKey(unsignedJwt("authenticated")), /publishable key or legacy anon JWT/);
  assert.throws(() => assertUnprivilegedSupabaseProjectKey("not-a-project-key"), /publishable key or legacy anon JWT/);
});

test("operator matching accepts one active exact canonical name", () => {
  const result = resolveIngredientReferenceDetailed("butter", [ingredient()], []);
  assert.equal(result.status, "matched");
  assert.equal(result.method, "exact");
});

test("operator matching accepts a known alias only when its sole target is active", () => {
  const item = ingredient();
  const alias: IngredientAlias = { id: "alias", rawText: "Unsalted Butter", normalizedText: "unsalted butter", ingredientId: item.id, source: "manual" };
  assert.equal(resolveIngredientReferenceDetailed("Unsalted Butter", [item], [alias]).status, "matched");
  assert.equal(resolveIngredientReferenceDetailed("Unsalted Butter", [item], [alias, { ...alias, id: "duplicate-alias" }]).status, "matched");
  const inactive = { ...item, isActive: false };
  assert.equal(resolveIngredientReferenceDetailed("Unsalted Butter", [inactive], [alias]).status, "inactive_alias");
});

test("duplicate normalized active candidates are ambiguous, never first-row wins", () => {
  const one = ingredient({ id: "11111111-1111-4111-8111-111111111111", name: "Fresh Milk" });
  const two = ingredient({ id: "22222222-2222-4222-8222-222222222222", name: "Fresh Milk 1L" });
  const result = resolveIngredientReferenceDetailed("Fresh Milk 2L", [one, two], []);
  assert.equal(result.status, "ambiguous");
  assert.equal(result.ingredientId, null);
  assert.deepEqual(result.candidates.map((candidate) => candidate.ingredientId), [one.id, two.id]);
});

test("strong partial match is suggestion only and blocks apply", () => {
  const item = ingredient({ name: "Van Houten Dark Chocolate" });
  const preview = buildCountPreview({ intent: intent([{ raw_name: "Van Houten Dark Chocolate Compound", quantity: 1, unit: "kg" }]), ingredients: [item], aliases: [], transactions: [movement(item)] });
  assert.equal(preview.rows[0].match_status, "suggestion");
  assert.equal(preview.can_apply, false);
});

test("Biscoff is ambiguous between Spread and Biscuit", () => {
  const spread = ingredient({ id: "11111111-1111-4111-8111-111111111111", name: "Biscoff Spread" });
  const biscuit = ingredient({ id: "22222222-2222-4222-8222-222222222222", name: "Biscoff Biscuit" });
  const result = resolveIngredientReferenceDetailed("Biscoff", [spread, biscuit], []);
  assert.equal(result.status, "ambiguous");
  assert.deepEqual(result.candidates.map((candidate) => candidate.ingredientName), ["Biscoff Spread", "Biscoff Biscuit"]);
});

test("an owner-clarified match name preserves the raw source name", () => {
  const spread = ingredient({ name: "Biscoff Spread" });
  const biscuit = ingredient({ id: "22222222-2222-4222-8222-222222222222", name: "Biscoff Biscuit" });
  const preview = buildCountPreview({
    intent: intent([{ raw_name: "Biscoff", match_name: "Biscoff Spread", quantity: 1, unit: "kg" }]),
    ingredients: [spread, biscuit], aliases: [], transactions: [movement(spread), movement(biscuit)],
  });
  assert.equal(preview.rows[0].raw_name, "Biscoff");
  assert.equal(preview.rows[0].match_name, "Biscoff Spread");
  assert.equal(preview.rows[0].canonical_ingredient_id, spread.id);
  assert.equal(preview.can_apply, true);
});

test("kg, g, L, ml, and pcs normalize through the canonical conversion authority", () => {
  const butter = ingredient();
  const milk = ingredient({ id: "22222222-2222-4222-8222-222222222222", name: "Milk", baseUnit: "ml", currentQuantity: 1000 });
  const eggs = ingredient({ id: "33333333-3333-4333-8333-333333333333", name: "Eggs", baseUnit: "pcs", currentQuantity: 10 });
  const preview = buildCountPreview({
    intent: intent([
      { raw_name: "Butter", quantity: 1.6, unit: "kg" },
      { raw_name: "Milk", quantity: 2, unit: "L" },
      { raw_name: "Eggs", quantity: 23, unit: "pcs" },
    ]),
    ingredients: [butter, milk, eggs], aliases: [], transactions: [movement(butter), movement(milk), movement(eggs)],
  });
  assert.deepEqual(preview.rows.map((row) => row.normalized_counted_quantity), [1600, 2000, 23]);
  assert.equal(preview.can_apply, true);
});

test("explicit 3 x 700g pack size normalizes to 2100g", () => {
  const item = ingredient();
  const preview = buildCountPreview({ intent: intent([{ raw_name: "Butter", pack_count: 3, pack_size: 700, pack_unit: "g" }]), ingredients: [item], aliases: [], transactions: [movement(item)] });
  assert.equal(preview.rows[0].normalized_counted_quantity, 2100);
  assert.equal(preview.can_apply, true);
});

test("incompatible, unknown, negative, and non-finite counts fail closed", () => {
  const item = ingredient();
  for (const row of [
    { raw_name: "Butter", quantity: 3, unit: "jars" },
    { raw_name: "Butter", quantity: 1, unit: "L" },
    { raw_name: "Butter", quantity: -1, unit: "g" },
    { raw_name: "Butter", quantity: Number.POSITIVE_INFINITY, unit: "g" },
  ]) {
    const preview = buildCountPreview({ intent: intent([row]), ingredients: [item], aliases: [], transactions: [movement(item)] });
    assert.equal(preview.can_apply, false, JSON.stringify(row));
  }
});

test("duplicate ingredient rows block the whole preview", () => {
  const item = ingredient();
  const preview = buildCountPreview({ intent: intent([{ raw_name: "Butter", quantity: 1, unit: "kg" }, { raw_name: "butter", quantity: 900, unit: "g" }]), ingredients: [item], aliases: [], transactions: [movement(item)] });
  assert.equal(preview.can_apply, false);
  assert.ok(preview.rows.every((row) => row.errors.some((error) => error.includes("more than once"))));
});

test("alias/canonical and normalized formatting variants cannot duplicate one ingredient", () => {
  const item = ingredient({ name: "Unsalted Butter" });
  const alias: IngredientAlias = { id: "alias", rawText: "Butter block", normalizedText: "butter block", ingredientId: item.id, source: "manual" };
  for (const rows of [
    [{ raw_name: "Butter block", quantity: 1, unit: "kg" }, { raw_name: "Unsalted Butter", quantity: 900, unit: "g" }],
    [{ raw_name: "Unsalted Butter", quantity: 1, unit: "kg" }, { raw_name: "unsalted-butter 2kg", quantity: 900, unit: "g" }],
  ]) {
    const preview = buildCountPreview({ intent: intent(rows), ingredients: [item], aliases: [alias], transactions: [movement(item)] });
    assert.equal(preview.can_apply, false);
    assert.ok(preview.rows.every((row) => row.errors.includes("Ingredient appears more than once in this physical count")));
  }
});

test("all material reconciliation snapshot fields are verified and mismatch independently", () => {
  const item = ingredient();
  const preview = buildCountPreview({ intent: intent([{ raw_name: "Butter", quantity: 1.6, unit: "kg" }]), ingredients: [item], aliases: [], transactions: [movement(item)] });
  const row = preview.rows[0];
  const snapshot = {
    cache_quantity: row.current_quantity,
    latest_ledger_quantity: row.expected_latest_transaction_quantity,
    latest_ledger_id: row.expected_latest_transaction_id,
    base_unit: row.base_unit,
    average_unit_cost: row.current_average_unit_cost,
    previous_reconciled_at: row.current_inventory_reconciled_at,
    verified_quantity: row.normalized_counted_quantity,
  };
  assert.deepEqual(reconciliationSnapshotMismatches(row, snapshot), []);
  for (const [field, wrong] of [
    ["cache_quantity", 901],
    ["latest_ledger_quantity", 899],
    ["latest_ledger_id", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"],
    ["base_unit", "ml"],
    ["average_unit_cost", 99],
    ["previous_reconciled_at", "2020-01-01T00:00:00Z"],
    ["verified_quantity", 1599],
  ] as const) {
    assert.deepEqual(reconciliationSnapshotMismatches(row, { ...snapshot, [field]: wrong }), [field]);
  }
  const nullCostPreview = buildCountPreview({
    intent: intent([{ raw_name: "Butter", quantity: 1.6, unit: "kg" }]),
    ingredients: [item], aliases: [], transactions: [movement(item)],
    authoritativeAverageUnitCosts: { [item.id]: null },
  });
  const nullCostRow = nullCostPreview.rows[0];
  assert.equal(nullCostRow.current_average_unit_cost, null);
  assert.deepEqual(reconciliationSnapshotMismatches(nullCostRow, { ...snapshot, average_unit_cost: null }), []);
});

test("cost effect distinguishes cleared, existing certification preserved, and remained uncertified", () => {
  const increased = ingredient({ id: "11111111-1111-4111-8111-111111111111", name: "Increased" });
  const decreased = ingredient({ id: "22222222-2222-4222-8222-222222222222", name: "Decreased" });
  const exactUncertified = ingredient({ id: "33333333-3333-4333-8333-333333333333", name: "Exact", costReconciledAt: null });
  const preview = buildCountPreview({
    intent: intent([
      { raw_name: "Increased", quantity: 1100, unit: "g" },
      { raw_name: "Decreased", quantity: 800, unit: "g" },
      { raw_name: "Exact", quantity: 900, unit: "g" },
    ]),
    ingredients: [increased, decreased, exactUncertified], aliases: [],
    transactions: [movement(increased), movement(decreased), movement(exactUncertified)],
  });
  assert.deepEqual(preview.rows.map((row) => row.expected_cost_certification_effect), [
    "cleared", "existing_certification_preserved", "remained_uncertified",
  ]);
});

test("preview hash is stable, source-sensitive, and binds approval to the exact normalized payload", () => {
  const item = ingredient();
  const args = { intent: intent([{ raw_name: "Butter", quantity: 1.6, unit: "kg" }]), ingredients: [item], aliases: [] as IngredientAlias[], transactions: [movement(item)], now: "2026-09-12T00:00:00Z" };
  const one = buildCountPreview(args);
  const two = buildCountPreview(args);
  assert.equal(one.payload_hash, two.payload_hash);
  assert.equal(one.approval_code, approvalCodeForHash(one.payload_hash));
  assert.doesNotThrow(() => assertPreviewApproved(one, one.approval_code));
  const changed = structuredClone(one);
  changed.rows[0].normalized_counted_quantity = 1700;
  assert.throws(() => assertPreviewApproved(changed, one.approval_code), /changed/);
  const changedOperation = structuredClone(one);
  changedOperation.operation_id = operationIdForOccurrence("different-occurrence");
  assert.throws(() => assertPreviewApproved(changedOperation, one.approval_code), /operation identity changed/);
  const differentSource = buildCountPreview({ ...args, intent: { ...args.intent, source: { ...args.intent.source, fingerprint: sha256Hex("different bytes") } } });
  assert.notEqual(differentSource.payload_hash, one.payload_hash);
});

test("editing a blocked suggestion artifact cannot make it apply", () => {
  const item = ingredient({ name: "Van Houten Dark Chocolate" });
  const blocked = buildCountPreview({ intent: intent([{ raw_name: "Van Houten Dark Chocolate Compound", quantity: 1, unit: "kg" }]), ingredients: [item], aliases: [], transactions: [movement(item)] });
  const edited = structuredClone(blocked);
  edited.can_apply = true;
  edited.errors = [];
  edited.rows[0].errors = [];
  assert.throws(() => assertPreviewApproved(edited, edited.approval_code), /blocking errors/);
});

test("source fingerprint and occurrence operation identity are stable", () => {
  assert.equal(sha256Hex("same raw text"), sha256Hex(Buffer.from("same raw text")));
  assert.equal(operationIdForOccurrence("count-1"), operationIdForOccurrence("count-1"));
  assert.notEqual(operationIdForOccurrence("count-1"), operationIdForOccurrence("count-2"));
});

test("batch RPC rows are sorted by ingredient id and carry only intent plus stale guards", () => {
  const a = ingredient({ id: "11111111-1111-4111-8111-111111111111", name: "Butter" });
  const b = ingredient({ id: "22222222-2222-4222-8222-222222222222", name: "Sugar" });
  const preview = buildCountPreview({ intent: intent([{ raw_name: "Sugar", quantity: 1, unit: "kg" }, { raw_name: "Butter", quantity: 1, unit: "kg" }]), ingredients: [b, a], aliases: [], transactions: [movement(a), movement(b)] });
  const args = batchRpcArgs(preview);
  assert.deepEqual(args.p_rows.map((row) => row.ingredient_id), [a.id, b.id]);
  assert.ok(args.p_rows.every((row) => !("quantity_after" in row) && !("cost_reconciled_at" in row)));
});
