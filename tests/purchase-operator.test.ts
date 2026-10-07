import test from "node:test";
import assert from "node:assert/strict";
import {
  assertPurchasePreviewApproved,
  buildPurchasePreview,
  classifyPurchaseApply,
  deterministicUuid,
  isValidPurchaseDate,
  purchaseLineOperationId,
  previewPayloadHash,
  purchaseLineRpcArgs,
  type PurchaseIntent,
  type PurchaseLineResult,
  type PurchasePreview,
} from "../scripts/purchase-operator/core.ts";
import type { Ingredient, IngredientAlias } from "../src/lib/product-lab-types.ts";

const EGG_ID = "11111111-1111-4111-8111-111111111111";
const FLOUR_ID = "22222222-2222-4222-8222-222222222222";
const VANILLA_ID = "33333333-3333-4333-8333-333333333333";

function ingredient(overrides: Partial<Ingredient> = {}): Ingredient {
  return {
    id: EGG_ID,
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

const flour = () => ingredient({ id: FLOUR_ID, name: "Flour", baseUnit: "g", currentQuantity: 500 });
const vanilla = () => ingredient({ id: VANILLA_ID, name: "Vanilla", baseUnit: "ml", currentQuantity: 200 });

function intent(items: PurchaseIntent["items"], overrides: Partial<PurchaseIntent> = {}): PurchaseIntent {
  return {
    kind: "purchase",
    occasion_id: "2026-09-16-morning-purchase",
    supplier: "Puregold",
    purchase_date: "2026-09-16",
    items,
    ...overrides,
  };
}

const eggLine = { raw_name: "Egg", quantity: 30, unit: "pcs", total_price: 300 };

function build(items: PurchaseIntent["items"], overrides: Partial<PurchaseIntent> = {}, ingredients: Ingredient[] = [ingredient()]) {
  return buildPurchasePreview({ intent: intent(items, overrides), ingredients, aliases: [], now: "2026-09-16T00:00:00Z" });
}

// ---- valid previews ---------------------------------------------------------------------------

test("valid single-line preview resolves, converts, and can_apply", () => {
  const preview = build([eggLine]);
  assert.equal(preview.can_apply, true);
  assert.deepEqual(preview.errors, []);
  assert.equal(preview.rows.length, 1);
  assert.equal(preview.rows[0].canonical_ingredient_id, EGG_ID);
  assert.equal(preview.rows[0].converted_quantity, 30);
  assert.equal(preview.rows[0].total_price, 300);
  assert.equal(preview.supplier, "Puregold");
  assert.equal(preview.purchase_date, "2026-09-16");
  assert.equal(preview.preview_id.startsWith("pu_"), true);
});

test("valid multi-line preview resolves every line independently and converts units", () => {
  const preview = build([
    eggLine,
    { raw_name: "Flour", quantity: 2, unit: "kg", total_price: 190 },
    { raw_name: "Vanilla", quantity: 1, unit: "L", total_price: 450 },
  ], {}, [ingredient(), flour(), vanilla()]);
  assert.equal(preview.can_apply, true);
  assert.deepEqual(preview.rows.map((row) => row.converted_quantity), [30, 2000, 1000]);
  assert.deepEqual(preview.rows.map((row) => row.entered_unit), ["pcs", "kg", "L"]);
  assert.deepEqual(preview.rows.map((row) => row.total_price), [300, 190, 450]);
  assert.deepEqual(preview.rows.map((row) => row.row_number), [1, 2, 3]);
});

test("two lines of the same ingredient are both kept as separate lines (each is its own post_raw_purchase call)", () => {
  const preview = build([
    { raw_name: "Flour", quantity: 1, unit: "kg", total_price: 95 },
    { raw_name: "Flour", quantity: 1, unit: "kg", total_price: 95 },
  ], {}, [flour()]);
  assert.equal(preview.can_apply, true);
  assert.equal(preview.rows.length, 2);
  assert.notEqual(
    purchaseLineOperationId(preview.occasion_id, 1),
    purchaseLineOperationId(preview.occasion_id, 2),
    "identical lines are still two distinct posts",
  );
});

test("exact and alias ingredient resolution behave the same as the shared matcher", () => {
  const apFlour = ingredient({ id: FLOUR_ID, name: "All-Purpose Flour", baseUnit: "g", currentQuantity: 500 });
  const alias: IngredientAlias = { id: "alias-1", rawText: "flour", normalizedText: "flour", ingredientId: FLOUR_ID, source: "manual" };
  const exact = buildPurchasePreview({ intent: intent([{ raw_name: "All-Purpose Flour", quantity: 1, unit: "kg", total_price: 95 }]), ingredients: [apFlour], aliases: [] });
  assert.equal(exact.rows[0].match_type, "exact");
  assert.equal(exact.can_apply, true);
  const viaAlias = buildPurchasePreview({ intent: intent([{ raw_name: "flour", quantity: 1, unit: "kg", total_price: 95 }]), ingredients: [apFlour], aliases: [alias] });
  assert.equal(viaAlias.rows[0].match_type, "alias");
  assert.equal(viaAlias.can_apply, true);
});

// ---- purchase-level required fields -----------------------------------------------------------

test("supplier is required: missing, empty and whitespace-only all block, and nothing is substituted", () => {
  for (const supplier of [undefined, "", "   ", "\t\n"]) {
    const preview = build([eggLine], { supplier });
    assert.equal(preview.can_apply, false, JSON.stringify(supplier));
    assert.equal(preview.supplier, null);
    assert.ok(preview.errors.includes("Supplier is required"));
  }
});

test("supplier is trimmed", () => {
  assert.equal(build([eggLine], { supplier: "  Puregold  " }).supplier, "Puregold");
});

test("purchase_date is required: omitted blocks and never falls back to a default", () => {
  const preview = build([eggLine], { purchase_date: undefined });
  assert.equal(preview.can_apply, false);
  assert.equal(preview.purchase_date, null);
  assert.ok(preview.errors.some((error) => error.includes("purchase_date is required")));
});

test("purchase_date must be strict YYYY-MM-DD", () => {
  for (const purchase_date of ["", "2026-9-16", "16-09-2026", "2026/09/16", "2026-09-16T00:00:00Z", " 2026-09-16", "2026-09-16 ", "September 16", "20260916", "2026-09-160"]) {
    const preview = build([eggLine], { purchase_date });
    assert.equal(preview.can_apply, false, JSON.stringify(purchase_date));
    assert.ok(preview.errors.some((error) => error.includes("purchase_date must be a real calendar date")), JSON.stringify(purchase_date));
    assert.equal(preview.purchase_date, null);
  }
});

test("purchase_date must be a real calendar date", () => {
  for (const purchase_date of ["2026-02-30", "2026-02-29", "2026-04-31", "2026-13-01", "2026-00-10", "2026-01-00", "2026-01-32", "0000-01-01"]) {
    assert.equal(build([eggLine], { purchase_date }).can_apply, false, purchase_date);
  }
  for (const purchase_date of ["2024-02-29", "2000-02-29", "2026-02-28", "2026-12-31", "2026-01-01"]) {
    assert.equal(build([eggLine], { purchase_date }).can_apply, true, purchase_date);
  }
  assert.equal(isValidPurchaseDate("1900-02-29"), false, "1900 is not a leap year");
  assert.equal(isValidPurchaseDate(20260916), false);
  assert.equal(isValidPurchaseDate(null), false);
});

test("missing or blank occasion_id, wrong kind, and an empty item list block the preview", () => {
  assert.equal(build([eggLine], { occasion_id: "" }).can_apply, false);
  assert.equal(build([eggLine], { occasion_id: "   " }).can_apply, false);
  assert.equal(build([eggLine], { kind: "count" as unknown as "purchase" }).can_apply, false);
  assert.equal(build([]).can_apply, false);
});

test("occasion_id and source_note are trimmed; a blank source_note is absent", () => {
  const preview = build([eggLine], { occasion_id: "  occasion-a  ", source_note: "   " });
  assert.equal(preview.occasion_id, "occasion-a");
  assert.equal(preview.source_note, null);
  assert.equal(build([eggLine], { source_note: "  owner message  " }).source_note, "owner message");
  assert.equal(build([eggLine], { occasion_id: "  occasion-a  " }).preview_id, build([eggLine], { occasion_id: "occasion-a" }).preview_id);
});

// ---- per-line validation ----------------------------------------------------------------------

test("a missing or non-positive quantity blocks the row", () => {
  for (const items of [
    [{ raw_name: "Egg", unit: "pcs", total_price: 300 }],
    [{ raw_name: "Egg", quantity: 0, unit: "pcs", total_price: 300 }],
    [{ raw_name: "Egg", quantity: -5, unit: "pcs", total_price: 300 }],
    [{ raw_name: "Egg", quantity: Number.POSITIVE_INFINITY, unit: "pcs", total_price: 300 }],
    [{ raw_name: "Egg", quantity: Number.NaN, unit: "pcs", total_price: 300 }],
  ] as PurchaseIntent["items"][]) {
    const preview = build(items);
    assert.equal(preview.can_apply, false, JSON.stringify(items));
    assert.ok(preview.rows[0].errors.some((error) => error.startsWith("Quantity")), JSON.stringify(items));
  }
});

test("a missing, zero, negative or non-finite total_price blocks the row; zero is explicitly rejected", () => {
  for (const items of [
    [{ raw_name: "Egg", quantity: 30, unit: "pcs" }],
    [{ raw_name: "Egg", quantity: 30, unit: "pcs", total_price: 0 }],
    [{ raw_name: "Egg", quantity: 30, unit: "pcs", total_price: -1 }],
    [{ raw_name: "Egg", quantity: 30, unit: "pcs", total_price: Number.NaN }],
    [{ raw_name: "Egg", quantity: 30, unit: "pcs", total_price: Number.POSITIVE_INFINITY }],
  ] as PurchaseIntent["items"][]) {
    const preview = build(items);
    assert.equal(preview.can_apply, false, JSON.stringify(items));
    assert.equal(preview.rows[0].converted_quantity, null);
  }
  const zero = build([{ ...eggLine, total_price: 0 }]);
  assert.ok(zero.rows[0].errors.some((error) => error.includes("greater than zero")));
  assert.ok(zero.rows[0].errors.some((error) => error.includes("free or sample")));
});

test("a tiny positive price is allowed", () => {
  assert.equal(build([{ ...eggLine, total_price: 0.01 }]).can_apply, true);
});

test("an unsupported unit blocks the row and never guesses a conversion", () => {
  for (const unit of ["bottle", "tbsp", "cup", "box", "pack"]) {
    const preview = build([{ raw_name: "Egg", quantity: 1, unit, total_price: 450 }]);
    assert.equal(preview.can_apply, false, unit);
    assert.ok(preview.rows[0].errors.some((error) => error.includes("Unsupported purchase unit")), unit);
    assert.equal(preview.rows[0].converted_quantity, null, unit);
  }
});

test("a missing or blank unit blocks the row", () => {
  for (const unit of [undefined, "", "  "]) {
    const preview = build([{ raw_name: "Egg", quantity: 1, unit, total_price: 10 }]);
    assert.equal(preview.can_apply, false);
    assert.ok(preview.rows[0].errors.includes("Unit is required"));
  }
});

test("a mass/volume family-crossing unit blocks the row", () => {
  const preview = build([{ raw_name: "Flour", quantity: 1, unit: "L", total_price: 95 }], {}, [flour()]);
  assert.equal(preview.can_apply, false);
  assert.ok(preview.rows[0].errors.some((error) => error.includes("incompatible")));
});

test("unit conversion: kg to g, L to ml, and pcs to pcs; unit spelling is normalized", () => {
  const preview = build([
    { raw_name: "Flour", quantity: 0.25, unit: "KG", total_price: 40 },
    { raw_name: "Vanilla", quantity: 250, unit: "ML", total_price: 80 },
    { raw_name: "Egg", quantity: 12, unit: "pcs", total_price: 120 },
  ], {}, [ingredient(), flour(), vanilla()]);
  assert.equal(preview.can_apply, true, preview.errors.join("; "));
  assert.deepEqual(preview.rows.map((row) => row.converted_quantity), [250, 250, 12]);
  assert.deepEqual(preview.rows.map((row) => row.entered_unit), ["kg", "ml", "pcs"]);
});

test("a blank ingredient name blocks the row", () => {
  const preview = build([{ ...eggLine, raw_name: "   " }]);
  assert.equal(preview.can_apply, false);
  assert.ok(preview.rows[0].errors.includes("Ingredient name is required"));
});

test("ambiguous ingredient names block the whole preview", () => {
  const spread = ingredient({ id: EGG_ID, name: "Biscoff Spread" });
  const biscuit = ingredient({ id: FLOUR_ID, name: "Biscoff Biscuit" });
  const preview = build([{ raw_name: "Biscoff", quantity: 1, unit: "pcs", total_price: 100 }], {}, [spread, biscuit]);
  assert.equal(preview.rows[0].match_status, "ambiguous");
  assert.equal(preview.can_apply, false);
});

test("an unmatched ingredient name blocks the whole preview, even when other lines are fine", () => {
  const preview = build([eggLine, { raw_name: "Nonexistent Item", quantity: 1, unit: "pcs", total_price: 100 }]);
  assert.equal(preview.rows[1].match_status, "unmatched");
  assert.equal(preview.rows[0].errors.length, 0);
  assert.equal(preview.can_apply, false);
});

test("an ingredient whose physical stock has never been verified blocks the row", () => {
  const preview = build([eggLine], {}, [ingredient({ inventoryReconciledAt: null })]);
  assert.equal(preview.can_apply, false);
  assert.ok(preview.rows[0].errors.some((error) => error.includes("Verify the physical stock")));
});

// ---- brand ------------------------------------------------------------------------------------

test("brand is optional per item and per line", () => {
  const preview = build([
    { ...eggLine, brand: "Magnolia" },
    { raw_name: "Flour", quantity: 1, unit: "kg", total_price: 95 },
  ], {}, [ingredient(), flour()]);
  assert.equal(preview.can_apply, true);
  assert.deepEqual(preview.rows.map((row) => row.brand), ["Magnolia", null]);
});

test("a blank, whitespace-only, null or omitted brand all normalize to null and share one identity", () => {
  const omitted = build([eggLine]);
  for (const brand of ["", "   ", null]) {
    const preview = build([{ ...eggLine, brand }]);
    assert.equal(preview.can_apply, true);
    assert.equal(preview.rows[0].brand, null);
    assert.equal(preview.preview_id, omitted.preview_id);
  }
  assert.equal(build([{ ...eggLine, brand: "  Magnolia " }]).rows[0].brand, "Magnolia");
});

test("a non-text brand blocks instead of being silently dropped", () => {
  const preview = build([{ ...eggLine, brand: 5 as unknown as string }]);
  assert.equal(preview.can_apply, false);
  assert.ok(preview.rows[0].errors.includes("Brand must be text"));
});

// ---- preview identity and approval binding ----------------------------------------------------

test("preview identity is deterministic for identical input and ignores the creation time", () => {
  const one = build([eggLine]);
  const two = buildPurchasePreview({ intent: intent([eggLine]), ingredients: [ingredient()], aliases: [], now: "2030-01-01T00:00:00Z" });
  assert.equal(one.preview_id, two.preview_id);
  assert.equal(one.payload_hash, two.payload_hash);
  assert.equal(one.approval_code, two.approval_code);
  assert.match(one.payload_hash, /^[0-9a-f]{64}$/);
  assert.match(one.preview_id, /^pu_[a-f0-9]{20}$/);
});

test("changing ANY approved field changes preview_id, payload_hash and approval_code", () => {
  const base = build([eggLine]);
  const variants: Array<[string, PurchasePreview]> = [
    ["supplier", build([eggLine], { supplier: "SM Market" })],
    ["purchase_date", build([eggLine], { purchase_date: "2026-09-17" })],
    ["occasion_id", build([eggLine], { occasion_id: "occasion-b" })],
    ["source_note", build([eggLine], { source_note: "receipt 123" })],
    ["brand", build([{ ...eggLine, brand: "Magnolia" }])],
    ["quantity", build([{ ...eggLine, quantity: 31 }])],
    ["unit", build([{ ...eggLine, unit: "kg" }], {}, [ingredient({ baseUnit: "g" })])],
    ["price", build([{ ...eggLine, total_price: 301 }])],
    ["ingredient", build([{ ...eggLine, raw_name: "Flour" }], {}, [flour()])],
    ["extra line", build([eggLine, eggLine])],
  ];
  const seen = new Set([base.preview_id]);
  for (const [field, preview] of variants) {
    assert.notEqual(preview.preview_id, base.preview_id, field);
    assert.notEqual(preview.payload_hash, base.payload_hash, field);
    assert.notEqual(preview.approval_code, base.approval_code, field);
    seen.add(preview.preview_id);
  }
  assert.equal(seen.size, variants.length + 1, "every variant is its own identity");
});

test("line order is significant: swapping two lines is a different preview", () => {
  const a = { raw_name: "Egg", quantity: 30, unit: "pcs", total_price: 300 };
  const b = { raw_name: "Flour", quantity: 2, unit: "kg", total_price: 190 };
  const ab = build([a, b], {}, [ingredient(), flour()]);
  const ba = build([b, a], {}, [ingredient(), flour()]);
  assert.notEqual(ab.preview_id, ba.preview_id);
  assert.notEqual(ab.approval_code, ba.approval_code);
});

test("review evidence is NOT part of identity: a stock movement between previews keeps the same preview_id", () => {
  const before = build([eggLine], {}, [ingredient({ currentQuantity: 20, averageUnitCost: 8 })]);
  const after = build([eggLine], {}, [ingredient({ currentQuantity: 50, averageUnitCost: 9.5, inventoryReconciledAt: "2026-09-16T05:00:00Z" })]);
  assert.equal(after.rows[0].current_quantity, 50, "the evidence is still shown");
  assert.equal(after.preview_id, before.preview_id);
  assert.equal(after.approval_code, before.approval_code);
  assert.deepEqual(purchaseLineRpcArgs(after, 1), purchaseLineRpcArgs(before, 1), "and the RPC payload (so its claim hash) is unchanged too");
});

test("assertPurchasePreviewApproved accepts an exact, unmodified, correctly-coded preview", () => {
  const preview = build([eggLine]);
  assert.doesNotThrow(() => assertPurchasePreviewApproved(preview, preview.approval_code));
  assert.doesNotThrow(() => assertPurchasePreviewApproved(preview, ` ${preview.approval_code.toLowerCase()} `));
});

test("assertPurchasePreviewApproved rejects a mismatched approval code", () => {
  const preview = build([eggLine]);
  assert.throws(() => assertPurchasePreviewApproved(preview, "0000-0000"), /Approval code does not match/);
  assert.throws(() => assertPurchasePreviewApproved(preview, ""), /Approval code does not match/);
});

test("an approval code from a different supplier, date, brand, price, quantity or unit is rejected", () => {
  const approved = build([eggLine]);
  for (const other of [
    build([eggLine], { supplier: "SM Market" }),
    build([eggLine], { purchase_date: "2026-09-17" }),
    build([{ ...eggLine, brand: "Magnolia" }]),
    build([{ ...eggLine, total_price: 3000 }]),
    build([{ ...eggLine, quantity: 300 }]),
  ]) {
    assert.throws(() => assertPurchasePreviewApproved(other, approved.approval_code), /Approval code does not match/);
  }
});

test("a stored preview edited after hashing is rejected, field by field", () => {
  const approved = build([eggLine, { raw_name: "Flour", quantity: 2, unit: "kg", total_price: 190 }], {}, [ingredient(), flour()]);
  const row = approved.rows[0];
  const tampered: Array<[string, PurchasePreview]> = [
    ["converted_quantity", { ...approved, rows: [{ ...row, converted_quantity: 9999 }, approved.rows[1]] }],
    ["total_price", { ...approved, rows: [{ ...row, total_price: 1 }, approved.rows[1]] }],
    ["brand", { ...approved, rows: [{ ...row, brand: "Injected" }, approved.rows[1]] }],
    ["ingredient", { ...approved, rows: [{ ...row, canonical_ingredient_id: FLOUR_ID }, approved.rows[1]] }],
    ["supplier", { ...approved, supplier: "Someone Else" }],
    ["purchase_date", { ...approved, purchase_date: "2026-09-17" }],
    ["source_note", { ...approved, source_note: "injected" }],
    ["row order", { ...approved, rows: [approved.rows[1], row] }],
    ["dropped line", { ...approved, rows: [row] }],
  ];
  for (const [field, preview] of tampered) {
    assert.throws(() => assertPurchasePreviewApproved(preview, approved.approval_code), /Preview (payload changed|contains blocking errors)/, field);
  }
  assert.throws(() => assertPurchasePreviewApproved(tampered[0][1], approved.approval_code), /Preview payload changed/);
});

test("a stored preview edited into a state the builder would refuse is rejected even when its hash is recomputed to match", () => {
  const approved = build([eggLine]);
  // Re-derive the identity the way a forger who understood the hashing would, so ONLY the
  // integrity rules (never the hash comparison) can be what refuses it.
  const forged = (patch: Partial<PurchasePreview>): PurchasePreview => {
    const edited = { ...approved, ...patch };
    const payload_hash = previewPayloadHash(edited);
    return { ...edited, payload_hash, preview_id: `pu_${payload_hash.slice(0, 20)}` };
  };
  const asIfBuilt = (patch: Partial<PurchasePreview["rows"][number]>) => forged({ rows: [{ ...approved.rows[0], ...patch }] });
  assert.doesNotThrow(() => assertPurchasePreviewApproved(forged({}), approved.approval_code), "control: an unedited re-derivation is accepted");
  for (const patch of [
    { total_price: 0 },
    { total_price: -5 },
    { entered_quantity: 0 },
    { entered_unit: "bottle" },
    { converted_quantity: 0 },
    { brand: "  padded  " },
    { match_status: "suggestion" as const },
    { match_type: "suggested" as const },
    { row_number: 2 },
  ]) {
    assert.throws(() => assertPurchasePreviewApproved(asIfBuilt(patch), approved.approval_code), /blocking errors/, JSON.stringify(patch));
  }
  for (const patch of [{ supplier: "" }, { supplier: " x " }, { purchase_date: null }, { purchase_date: "2026-02-30" }, { occasion_id: "" }, { source_note: " padded " }] as Array<Partial<PurchasePreview>>) {
    assert.throws(() => assertPurchasePreviewApproved(forged(patch), approved.approval_code), /blocking errors/, JSON.stringify(patch));
  }
});

test("assertPurchasePreviewApproved rejects a preview that can_apply: false", () => {
  const preview = build([{ raw_name: "Nonexistent", quantity: 1, unit: "pcs", total_price: 1 }], {}, []);
  assert.throws(() => assertPurchasePreviewApproved(preview, preview.approval_code), /blocking errors/);
  const missingSupplier = build([eggLine], { supplier: "" });
  assert.throws(() => assertPurchasePreviewApproved(missingSupplier, missingSupplier.approval_code), /blocking errors/);
});

// ---- per-line idempotency identity ------------------------------------------------------------

test("deterministicUuid is a pure RFC-4122-shaped function of namespace and value", () => {
  assert.equal(deterministicUuid("ns", "pu_abc"), deterministicUuid("ns", "pu_abc"));
  assert.notEqual(deterministicUuid("ns", "pu_abc"), deterministicUuid("other", "pu_abc"));
  assert.notEqual(deterministicUuid("ns", "pu_abc"), deterministicUuid("ns", "pu_xyz"));
  assert.match(deterministicUuid("ns", "pu_abc"), /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

const UUID_V5_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TWO_LINES = [eggLine, { raw_name: "Flour", quantity: 2, unit: "kg", total_price: 190 }];
const eggAndFlour = () => [ingredient(), flour()];
const operationIds = (preview: PurchasePreview) => preview.rows.map((row) => purchaseLineOperationId(preview.occasion_id, row.row_number));
// The RPC arguments minus the operation id: what post_raw_purchase's claim hash is computed over
// (plus the operation id's own claim), i.e. what must differ for claim_mutation to refuse a re-use.
const claimedPayload = (preview: PurchasePreview, rowNumber: number) => {
  const { p_operation_id: _operationId, ...payload } = purchaseLineRpcArgs(preview, rowNumber);
  return payload;
};

test("line operation id: same occasion + row is stable across identical rebuilt previews", () => {
  const first = build(TWO_LINES, {}, eggAndFlour());
  const rebuilt = build(TWO_LINES, {}, eggAndFlour());
  assert.deepEqual(operationIds(first), operationIds(rebuilt));
  assert.equal(purchaseLineOperationId("2026-09-16-morning-purchase", 1), operationIds(first)[0]);
  for (const id of operationIds(first)) assert.match(id, UUID_V5_SHAPE);
  assert.equal(purchaseLineOperationId("  2026-09-16-morning-purchase  ", 1), operationIds(first)[0], "the occasion id is normalized like the preview's");
});

test("line operation id: a CORRECTED preview of the same occasion keeps the same ids but gets a new preview identity", () => {
  const original = build(TWO_LINES, { source_note: "owner message" }, eggAndFlour());
  const corrections: Array<[string, PurchasePreview]> = [
    ["supplier", build(TWO_LINES, { source_note: "owner message", supplier: "SM Market" }, eggAndFlour())],
    ["purchase_date", build(TWO_LINES, { source_note: "owner message", purchase_date: "2026-09-17" }, eggAndFlour())],
    ["quantity", build([{ ...eggLine, quantity: 31 }, TWO_LINES[1]], { source_note: "owner message" }, eggAndFlour())],
    ["price", build([{ ...eggLine, total_price: 301 }, TWO_LINES[1]], { source_note: "owner message" }, eggAndFlour())],
    ["brand", build([{ ...eggLine, brand: "Magnolia" }, TWO_LINES[1]], { source_note: "owner message" }, eggAndFlour())],
    ["source_note", build(TWO_LINES, { source_note: "corrected note" }, eggAndFlour())],
  ];
  for (const [field, corrected] of corrections) {
    assert.deepEqual(operationIds(corrected), operationIds(original), `${field}: same occasion + row => same operation id`);
    assert.notEqual(corrected.preview_id, original.preview_id, `${field}: preview_id`);
    assert.notEqual(corrected.payload_hash, original.payload_hash, `${field}: payload_hash`);
    assert.notEqual(corrected.approval_code, original.approval_code, `${field}: approval_code`);
  }
  // ...and the RPC payload bound to that reused id DIFFERS for the corrected line, which is exactly
  // what makes inventory_private.claim_mutation raise "operation id was already used for a different
  // request" instead of reposting. (The database behavior itself is proven by Phase 2's Postgres smoke.)
  const byField = Object.fromEntries(corrections);
  for (const field of ["supplier", "purchase_date", "source_note"]) {
    assert.notDeepEqual(claimedPayload(byField[field], 1), claimedPayload(original, 1), `${field} changes line 1's payload`);
    assert.notDeepEqual(claimedPayload(byField[field], 2), claimedPayload(original, 2), `${field} changes line 2's payload`);
  }
  for (const field of ["quantity", "price", "brand"]) {
    assert.notDeepEqual(claimedPayload(byField[field], 1), claimedPayload(original, 1), `${field} changes line 1's payload`);
    assert.deepEqual(claimedPayload(byField[field], 2), claimedPayload(original, 2), `${field}: an untouched line replays identically`);
  }
});

test("line operation id: a different occasion, or a different row, is a different id", () => {
  const a = purchaseLineOperationId("occasion-a", 1);
  assert.notEqual(a, purchaseLineOperationId("occasion-b", 1));
  assert.notEqual(a, purchaseLineOperationId("occasion-a", 2));
  assert.notEqual(purchaseLineOperationId("occasion-a", 2), purchaseLineOperationId("occasion-b", 2));
  const ids = [1, 2, 3, 10, 11].flatMap((row) => ["occasion-a", "occasion-b", "occasion-a:1"].map((occasion) => purchaseLineOperationId(occasion, row)));
  assert.equal(new Set(ids).size, ids.length, "no collisions, including occasion ids that contain the separator");
  const preview = build(TWO_LINES, {}, eggAndFlour());
  const other = build(TWO_LINES, { occasion_id: "another-occasion" }, eggAndFlour());
  assert.equal(operationIds(preview).filter((id) => operationIds(other).includes(id)).length, 0);
});

test("line operation id is bound to row POSITION: reordering lines rebinds the same ids to different payloads", () => {
  const ab = build([TWO_LINES[0], TWO_LINES[1]], {}, eggAndFlour());
  const ba = build([TWO_LINES[1], TWO_LINES[0]], {}, eggAndFlour());
  assert.deepEqual(operationIds(ab), operationIds(ba), "ids follow row position, not line content");
  assert.notEqual(ab.preview_id, ba.preview_id);
  for (const row of [1, 2]) {
    assert.equal(purchaseLineRpcArgs(ab, row).p_operation_id, purchaseLineRpcArgs(ba, row).p_operation_id);
    // Same operation id, different payload: after any line of `ab` is applied, claim_mutation rejects
    // `ba` (and vice versa) instead of silently reposting under a reordered preview.
    assert.notDeepEqual(claimedPayload(ab, row), claimedPayload(ba, row), `row ${row} would carry a different claim hash`);
  }
});

test("purchaseLineOperationId rejects a blank or non-text occasion id and a bad line number", () => {
  for (const occasion of ["", "   ", "\t\n", undefined, null, 5] as unknown as string[]) {
    assert.throws(() => purchaseLineOperationId(occasion, 1), /occasion id is required/, JSON.stringify(occasion));
  }
  for (const line of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "1" as unknown as number]) {
    assert.throws(() => purchaseLineOperationId("occasion-a", line), /positive integer/, String(line));
  }
});

test("purchaseLineRpcArgs is exactly the post_raw_purchase argument set, with explicit supplier and date", () => {
  const preview = build([
    { ...eggLine, brand: "Magnolia" },
    { raw_name: "Flour", quantity: 2, unit: "kg", total_price: 190 },
  ], { source_note: "owner message", supplier: "  Puregold " }, [ingredient(), flour()]);
  const first = purchaseLineRpcArgs(preview, 1);
  assert.deepEqual(Object.keys(first).sort(), [
    "p_base_quantity", "p_brand_name", "p_display_unit", "p_ingredient_id", "p_notes", "p_operation_id",
    "p_pack_quantity", "p_purchase_date", "p_quality_rating", "p_supplier_name", "p_total_cost",
  ]);
  assert.deepEqual(first, {
    p_operation_id: purchaseLineOperationId(preview.occasion_id, 1),
    p_ingredient_id: EGG_ID,
    p_pack_quantity: 30,
    p_display_unit: "pcs",
    p_base_quantity: 30,
    p_total_cost: 300,
    p_brand_name: "Magnolia",
    p_supplier_name: "Puregold",
    p_purchase_date: "2026-09-16",
    p_quality_rating: null,
    p_notes: "MCP purchase 2026-09-16-morning-purchase -- owner message",
  });
  const second = purchaseLineRpcArgs(preview, 2);
  assert.equal(second.p_pack_quantity, 2);
  assert.equal(second.p_display_unit, "kg");
  assert.equal(second.p_base_quantity, 2000, "base quantity is the converted one");
  assert.equal(second.p_brand_name, null);
  assert.equal(second.p_purchase_date, "2026-09-16", "the date is explicit on every line, never null");
  assert.equal(second.p_notes, "MCP purchase 2026-09-16-morning-purchase -- owner message");
  assert.equal(purchaseLineRpcArgs(build([eggLine]), 1).p_notes, "MCP purchase 2026-09-16-morning-purchase");
});

test("purchaseLineRpcArgs refuses a blocked, tampered, or out-of-range request", () => {
  const blocked = build([eggLine], { supplier: "" });
  assert.throws(() => purchaseLineRpcArgs(blocked, 1), /blocking errors/);
  const good = build([eggLine]);
  assert.throws(() => purchaseLineRpcArgs({ ...good, rows: [{ ...good.rows[0], total_price: 1 }] }, 1), /payload changed/);
  assert.throws(() => purchaseLineRpcArgs(good, 2), /does not exist/);
  assert.throws(() => purchaseLineRpcArgs(good, 0), /does not exist/);
});

// ---- partial application model ----------------------------------------------------------------

function line(rowNumber: number, outcome: PurchaseLineResult["outcome"]): PurchaseLineResult {
  const committed = outcome === "applied" || outcome === "replayed";
  return {
    row_number: rowNumber,
    operation_id: purchaseLineOperationId("occasion-a", rowNumber),
    ingredient_id: EGG_ID,
    ingredient_name: "Egg",
    outcome,
    supply_id: committed ? `supply-${rowNumber}` : null,
    transaction_id: committed ? `tx-${rowNumber}` : null,
    quantity_after: committed ? 50 : null,
    average_unit_cost: committed ? 9 : null,
    cost_trusted: null,
    error: outcome === "failed" ? "boom" : null,
  };
}

test("classifyPurchaseApply: every status, and no fake atomicity", () => {
  assert.equal(classifyPurchaseApply([line(1, "applied"), line(2, "applied")]), "APPLIED");
  assert.equal(classifyPurchaseApply([line(1, "replayed"), line(2, "replayed")]), "REPLAYED");
  assert.equal(classifyPurchaseApply([line(1, "replayed"), line(2, "applied")]), "APPLIED", "a resumed retry that finished the job");
  assert.equal(classifyPurchaseApply([line(1, "applied"), line(2, "failed"), line(3, "not_attempted")]), "PARTIALLY_APPLIED");
  assert.equal(classifyPurchaseApply([line(1, "replayed"), line(2, "not_attempted")]), "PARTIALLY_APPLIED");
  assert.equal(classifyPurchaseApply([line(1, "applied"), line(2, "failed")]), "PARTIALLY_APPLIED");
  assert.equal(classifyPurchaseApply([line(1, "failed"), line(2, "not_attempted")]), "NOT_APPLIED");
  assert.equal(classifyPurchaseApply([line(1, "not_attempted")]), "NOT_APPLIED");
  assert.throws(() => classifyPurchaseApply([]), /at least one line/);
});

test("a single committed line followed by a failed one is never reported as fully applied", () => {
  const status = classifyPurchaseApply([line(1, "applied"), line(2, "failed")]);
  assert.notEqual(status, "APPLIED");
  assert.notEqual(status, "REPLAYED");
  assert.notEqual(status, "NOT_APPLIED");
});
