import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createProductLabMcpServer } from "../scripts/product-lab-mcp/mcp-server.ts";
import {
  createDurablePurchaseArtifactStore,
  PurchaseDomainError,
  PurchaseService,
  type PurchaseErrorCode,
} from "../scripts/product-lab-mcp/purchase-service.ts";
import { createPurchaseArtifactStore } from "../scripts/product-lab-mcp/purchase-service-local.ts";
import { purchaseLineOperationId, type PurchaseIntent } from "../scripts/purchase-operator/core.ts";
import type { Ingredient } from "../src/lib/product-lab-types.ts";

// Purchases V3 -- application service and MCP surface, against an in-memory model of exactly the
// database behavior the service relies on (verified for real in tests/smoke/postgres/
// product-lab-mcp-purchases-v3.smoke.test.ts): the owner-scoped artifact table and its guard trigger,
// post_raw_purchase's claim_mutation replay / 23514 collision, and a Safe-Purchase-Delete-style
// reversal that removes the rows but leaves the receipt (so a retry replays a STALE result).

type Row = Record<string, any>;
type DbError = { code?: string; message: string };

const COLLISION = "This operation id was already used for a different request. Reload and try again.";
let uid = 0;
const nextId = (prefix: string) => `${prefix}-0000-4000-8000-${String(++uid).padStart(12, "0")}`;

class FakeDb {
  readonly ingredients = new Map<string, Row>();
  readonly supply = new Map<string, Row>();
  readonly txs = new Map<string, Row>();
  readonly receipts = new Map<string, { hash: string; result: Row }>();
  readonly previews = new Map<string, Row>();
  readonly rpcCalls: Row[] = [];
  readonly previewWrites: Array<{ op: string; keys: string[] }> = [];
  readonly progressAtRpc: Array<Row | null> = [];
  failRpc: ((args: Row, call: number) => DbError | null) | null = null;
  failApplyUpdates = 0;
  failPreviewRead = false;
  reportCostTrust: boolean;

  constructor(options: { postV4?: boolean } = {}) {
    this.reportCostTrust = options.postV4 ?? false;
  }

  addIngredient(name: string, baseUnit: string, quantity: number, averageUnitCost: number, reconciled = true): Ingredient {
    const id = nextId("11111111");
    this.ingredients.set(id, {
      id, name, base_unit: baseUnit, current_quantity: quantity, average_unit_cost: averageUnitCost,
      inventory_reconciled_at: reconciled ? "2026-09-10T00:00:00Z" : null, cost_reconciled_at: null,
    });
    return this.domainIngredient(id);
  }

  domainIngredient(id: string): Ingredient {
    const row = this.ingredients.get(id)!;
    return {
      id, name: row.name, baseUnit: row.base_unit, category: "ingredient", currentQuantity: row.current_quantity,
      lowStockThreshold: 0, targetStockQuantity: 0, nearestExpirationDate: "", averageUnitCost: row.average_unit_cost ?? 0,
      notes: "", isActive: true, inventoryReconciledAt: row.inventory_reconciled_at, costReconciledAt: row.cost_reconciled_at,
    } as Ingredient;
  }

  // ---- post_raw_purchase (+ claim_mutation), as specified by the migrations ----
  rpc(name: string, args: Row): { data: unknown; error: DbError | null } {
    assert.equal(name, "post_raw_purchase", "the service may only ever call post_raw_purchase");
    this.rpcCalls.push(structuredClone(args));
    this.progressAtRpc.push(this.previews.size ? structuredClone([...this.previews.values()][0].apply_result) : null);
    const injected = this.failRpc?.(args, this.rpcCalls.length);
    if (injected) return { data: null, error: injected };
    const hash = JSON.stringify([args.p_ingredient_id, args.p_pack_quantity, args.p_display_unit, args.p_base_quantity,
      args.p_total_cost, args.p_brand_name, args.p_supplier_name, args.p_purchase_date, args.p_quality_rating, args.p_notes]);
    const receipt = this.receipts.get(args.p_operation_id);
    if (receipt) {
      if (receipt.hash !== hash) return { data: null, error: { code: "23514", message: COLLISION } };
      return { data: structuredClone(receipt.result), error: null }; // exact replay: no work
    }
    if (!args.p_supplier_name || !String(args.p_supplier_name).trim()) return { data: null, error: { code: "22023", message: "Supplier is required" } };
    const ingredient = this.ingredients.get(args.p_ingredient_id);
    if (!ingredient) return { data: null, error: { code: "P0001", message: "Item not found" } };
    if (!ingredient.inventory_reconciled_at) {
      return { data: null, error: { code: "23514", message: `Verify the physical stock of "${ingredient.name}" before posting a purchase for it.` } };
    }
    const before = ingredient.current_quantity as number;
    const after = before + args.p_base_quantity;
    const average = (before * (ingredient.average_unit_cost ?? 0) + args.p_total_cost) / after;
    const supplyId = nextId("22222222");
    const txId = nextId("33333333");
    this.supply.set(supplyId, {
      id: supplyId, ingredient_id: ingredient.id, ingredient_name: ingredient.name,
      brand_name: args.p_brand_name?.trim() || null, supplier_name: args.p_supplier_name.trim(), purchase_date: args.p_purchase_date,
      pack_quantity: args.p_pack_quantity, unit: args.p_display_unit, total_cost: args.p_total_cost,
      quality_rating: args.p_quality_rating ?? 0, notes: args.p_notes?.trim() || null,
    });
    this.txs.set(txId, {
      id: txId, ingredient_id: ingredient.id, transaction_type: "purchase", source_type: "manual", source_id: supplyId,
      quantity_before: before, quantity_change: args.p_base_quantity, quantity_after: after,
    });
    ingredient.current_quantity = after;
    ingredient.average_unit_cost = average;
    const result: Row = { supply_id: supplyId, transaction_id: txId, quantity_after: after, average_unit_cost: average };
    if (this.reportCostTrust) result.cost_trusted = ingredient.cost_reconciled_at !== null;
    this.receipts.set(args.p_operation_id, { hash, result });
    return { data: structuredClone(result), error: null };
  }

  // Safe Purchase Delete: removes the rows and restores the ingredient, but keeps the receipt.
  reverse(supplyId: string) {
    const tx = [...this.txs.values()].find((row) => row.source_id === supplyId)!;
    const ingredient = this.ingredients.get(tx.ingredient_id)!;
    ingredient.current_quantity = tx.quantity_before;
    this.txs.delete(tx.id);
    this.supply.delete(supplyId);
  }

  client(): SupabaseClient {
    return { from: (table: string) => new Query(this, table), rpc: async (name: string, args: Row) => this.rpc(name, args) } as unknown as SupabaseClient;
  }
}

class Query {
  private filters: Array<(row: Row) => boolean> = [];
  private operation: { kind: "select" } | { kind: "upsert"; row: Row; ignoreDuplicates: boolean } | { kind: "update"; patch: Row } = { kind: "select" };
  private single = false;
  private returning = false;
  private readonly db: FakeDb;
  private readonly table: string;
  constructor(db: FakeDb, table: string) {
    this.db = db;
    this.table = table;
  }
  select(_columns?: string) { if (this.operation.kind === "update") this.returning = true; return this; }
  upsert(row: Row, options: { onConflict: string; ignoreDuplicates?: boolean }) {
    assert.equal(options.onConflict, "owner_id,preview_id");
    this.operation = { kind: "upsert", row, ignoreDuplicates: options.ignoreDuplicates === true };
    return this;
  }
  update(patch: Row) { this.operation = { kind: "update", patch }; return this; }
  eq(column: string, value: unknown) { this.filters.push((row) => row[column] === value); return this; }
  in(column: string, values: unknown[]) { this.filters.push((row) => values.includes(row[column])); return this; }
  is(column: string, value: null) { this.filters.push((row) => (row[column] ?? null) === value); return this; }
  maybeSingle() { this.single = true; return this; }
  then<T>(resolve: (value: { data: any; error: DbError | null }) => T, reject?: (reason: unknown) => T) {
    return Promise.resolve(this.run()).then(resolve, reject);
  }

  private source(): Map<string, Row> {
    switch (this.table) {
      case "product_lab_mcp_purchase_previews": return this.db.previews;
      case "supply_entries": return this.db.supply;
      case "inventory_transactions": return this.db.txs;
      case "ingredients": return this.db.ingredients;
      default: throw new Error(`unexpected table ${this.table}`);
    }
  }

  private run(): { data: any; error: DbError | null } {
    const rows = [...this.source().entries()].filter(([, row]) => this.filters.every((filter) => filter(row)));
    if (this.table === "product_lab_mcp_purchase_previews") return this.runPreviews(rows);
    assert.equal(this.operation.kind, "select", "only the preview table is ever written by the service");
    const data = rows.map(([, row]) => structuredClone(row));
    return { data: this.single ? data[0] ?? null : data, error: null };
  }

  private runPreviews(rows: Array<[string, Row]>): { data: any; error: DbError | null } {
    const db = this.db;
    if (this.operation.kind === "select") {
      if (db.failPreviewRead) return { data: null, error: { message: "read failed" } };
      const data = rows.map(([, row]) => structuredClone(row));
      return { data: this.single ? data[0] ?? null : data, error: null };
    }
    if (this.operation.kind === "upsert") {
      const { row, ignoreDuplicates } = this.operation;
      db.previewWrites.push({ op: "upsert", keys: Object.keys(row) });
      assert.ok(ignoreDuplicates, "the first save must be an insert that ignores a duplicate, never an overwriting upsert");
      assert.ok(!("apply_result" in row) && !("verified_at" in row), "the first save must not send apply_result/verified_at");
      if (!db.previews.has(row.preview_id)) {
        const created = new Date();
        db.previews.set(row.preview_id, {
          ...structuredClone(row), apply_result: null, verified_at: null,
          created_at: created.toISOString(), expires_at: new Date(created.getTime() + 24 * 3600 * 1000).toISOString(),
        });
      }
      return { data: null, error: null };
    }
    const { patch } = this.operation;
    db.previewWrites.push({ op: "update", keys: Object.keys(patch) });
    if ("apply_result" in patch && patch.apply_result === null) return { data: null, error: { code: "23514", message: "apply_result cannot be erased" } };
    if ("verified_at" in patch && patch.verified_at === null) return { data: null, error: { code: "23514", message: "verified_at cannot be cleared" } };
    if ("apply_result" in patch && db.failApplyUpdates > 0) { db.failApplyUpdates -= 1; return { data: null, error: { message: "simulated outage" } }; }
    for (const [key, row] of rows) {
      if (row.apply_result !== null && "preview" in patch) return { data: null, error: { code: "23514", message: "An applied purchase preview cannot be modified" } };
      db.previews.set(key, { ...row, ...structuredClone(patch) });
    }
    return { data: this.returning ? rows.map(([, row]) => ({ preview_id: row.preview_id })) : null, error: null };
  }
}

// ---- scenario helpers -------------------------------------------------------------------------

function scenario(options: { postV4?: boolean } = {}) {
  const db = new FakeDb(options);
  const egg = db.addIngredient("Egg", "pcs", 20, 8);
  const flour = db.addIngredient("Flour", "g", 500, 0.5);
  const sugar = db.addIngredient("Sugar", "g", 200, 0.4);
  const client = db.client();
  const loadState = async () => ({
    ingredientRows: [], ingredients: [...db.ingredients.keys()].map((id) => db.domainIngredient(id)), aliases: [],
    transactions: [], supplies: [], supplyRows: [], authoritativeAverageUnitCosts: {},
  });
  const service = new PurchaseService({ loadState } as never, async () => client, createDurablePurchaseArtifactStore(client));
  const intent = (overrides: Partial<PurchaseIntent> = {}, lines = 3): PurchaseIntent => ({
    kind: "purchase",
    occasion_id: "occ-1",
    supplier: "Puregold",
    purchase_date: "2026-03-02",
    items: [
      { raw_name: "Egg", quantity: 30, unit: "pcs", total_price: 300 },
      { raw_name: "Flour", quantity: 2, unit: "kg", total_price: 190, brand: "Gold Medal" },
      { raw_name: "Sugar", quantity: 500, unit: "g", total_price: 60 },
    ].slice(0, lines),
    ...overrides,
  });
  return { db, client, service, intent, egg, flour, sugar };
}

async function rejectsWith(promise: Promise<unknown>, code: PurchaseErrorCode, messagePattern?: RegExp) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof PurchaseDomainError, `expected a PurchaseDomainError, got ${String(error)}`);
    assert.equal(error.purchaseCode, code, error.message);
    if (messagePattern) assert.match(error.publicMessage, messagePattern);
    return true;
  });
}

const stored = (db: FakeDb) => [...db.previews.values()][0];
const quantity = (db: FakeDb, ingredient: Ingredient) => db.ingredients.get(ingredient.id)!.current_quantity as number;
const counts = (db: FakeDb) => ({ supply: db.supply.size, txs: db.txs.size, receipts: db.receipts.size });

// ---- preview ----------------------------------------------------------------------------------

test("purchase_preview: persists the artifact, writes nothing else, and returns a reviewable view", async () => {
  const { db, service, intent, egg, flour } = scenario();
  const view = await service.preview(intent());
  assert.equal(view.can_apply, true);
  assert.equal(view.stored, true);
  assert.equal(view.supplier, "Puregold");
  assert.equal(view.purchase_date, "2026-03-02");
  assert.equal(view.total_price, 550);
  assert.match(view.approval_code, /^[0-9A-F]{4}-[0-9A-F]{4}$/);
  assert.match(view.notice, new RegExp(view.approval_code));
  assert.deepEqual(view.rows.map((row) => [row.ingredient?.name, row.entered_quantity, row.entered_unit, row.converted_quantity, row.base_unit, row.total_price, row.brand]), [
    ["Egg", 30, "pcs", 30, "pcs", 300, null],
    ["Flour", 2, "kg", 2000, "g", 190, "Gold Medal"],
    ["Sugar", 500, "g", 500, "g", 60, null],
  ]);
  assert.deepEqual(view.rows[0].evidence, { current_quantity: 20, current_average_unit_cost: 8, inventory_reconciled_at: "2026-09-10T00:00:00Z" });
  const row = stored(db);
  assert.equal(row.preview_id, view.preview_id);
  assert.equal(row.occasion_id, "occ-1");
  assert.equal(row.apply_result, null);
  assert.equal(row.preview.supplier, "Puregold");
  assert.deepEqual(db.previewWrites.map((write) => write.op), ["upsert"]);
  assert.equal(db.rpcCalls.length, 0, "preview never calls the mutation authority");
  assert.deepEqual(counts(db), { supply: 0, txs: 0, receipts: 0 });
  assert.equal(quantity(db, egg), 20);
  assert.equal(quantity(db, flour), 500);
});

test("purchase_preview: a repeated save of an active preview returns the stored artifact and does not rewrite it", async () => {
  const { db, service, intent } = scenario();
  const first = await service.preview(intent());
  const expiresAt = stored(db).expires_at;
  const second = await service.preview(intent());
  assert.equal(second.preview_id, first.preview_id);
  assert.equal(db.previews.size, 1);
  assert.equal(stored(db).expires_at, expiresAt, "the approval window is not silently extended");
  assert.deepEqual(db.previewWrites.map((write) => write.op), ["upsert", "upsert"], "no update was ever issued");
});

test("purchase_preview: a re-preview never overwrites an applied artifact, even after stock moved", async () => {
  const { db, service, intent, egg } = scenario();
  const first = await service.preview(intent());
  await service.apply(first.preview_id, first.approval_code);
  const applied = structuredClone(stored(db));
  db.ingredients.get(egg.id)!.current_quantity = 999; // unrelated later movement changes the review evidence
  const again = await service.preview(intent());
  assert.equal(again.preview_id, first.preview_id);
  assert.equal(again.apply_status, "APPLIED");
  assert.match(again.notice, /already has apply progress/);
  assert.equal(again.rows[0].evidence.current_quantity, 20, "the stored (approved) artifact is returned, not a fresh one");
  assert.deepEqual(stored(db), applied, "preview, apply_result and verified_at are untouched");
  assert.ok(!db.previewWrites.slice(-1).some((write) => write.op === "update"), "no update was issued by the re-preview");
});

test("purchase_preview: an expired, never-applied artifact is refreshed (new evidence, new window)", async () => {
  const { db, service, intent, egg } = scenario();
  const first = await service.preview(intent());
  stored(db).created_at = "2026-01-01T00:00:00.000Z";
  stored(db).expires_at = "2026-01-02T00:00:00.000Z";
  db.ingredients.get(egg.id)!.current_quantity = 55;
  const again = await service.preview(intent());
  assert.equal(again.preview_id, first.preview_id, "same purchase, same identity");
  assert.equal(again.rows[0].evidence.current_quantity, 55, "evidence is refreshed");
  assert.ok(Date.parse(stored(db).expires_at) > Date.now(), "a new approval window");
  assert.ok(Date.parse(stored(db).expires_at) - Date.parse(stored(db).created_at) <= 24 * 3600 * 1000);
  const update = db.previewWrites.find((write) => write.op === "update")!;
  assert.deepEqual(update.keys.sort(), ["created_at", "expires_at", "preview"], "only the refreshable columns; identity and apply state are never sent");
  assert.equal(stored(db).apply_result, null);
});

test("purchase_preview: a blocked preview is stored and shown but can never be applied", async () => {
  const { db, service, intent } = scenario();
  const view = await service.preview(intent({ items: [{ raw_name: "Nonexistent", quantity: 1, unit: "pcs", total_price: 10 }] }));
  assert.equal(view.can_apply, false);
  assert.match(view.notice, /BLOCKED/);
  assert.ok(view.errors.length > 0);
  await rejectsWith(service.apply(view.preview_id, view.approval_code), "purchase_preview_blocked");
  assert.equal(db.rpcCalls.length, 0);
});

test("purchase_preview: required purchase fields block the preview (supplier, date, zero price), and nothing is stored without an occasion", async () => {
  const { db, service, intent } = scenario();
  const noSupplier = await service.preview(intent({ supplier: "  " }));
  assert.equal(noSupplier.can_apply, false);
  assert.ok(noSupplier.errors.includes("Supplier is required"));
  const noDate = await service.preview(intent({ purchase_date: "2026-02-30" }));
  assert.equal(noDate.can_apply, false);
  const free = await service.preview(intent({ items: [{ raw_name: "Egg", quantity: 1, unit: "pcs", total_price: 0 }] }));
  assert.equal(free.can_apply, false);
  const before = db.previews.size;
  const noOccasion = await service.preview(intent({ occasion_id: "   " }));
  assert.equal(noOccasion.stored, false);
  assert.equal(noOccasion.can_apply, false);
  assert.equal(db.previews.size, before, "an unstorable preview writes nothing");
});

// ---- apply ------------------------------------------------------------------------------------

test("purchase_apply: a one-line purchase posts through post_raw_purchase and records durable progress", async () => {
  const { db, service, intent, egg } = scenario();
  const preview = await service.preview(intent({}, 1));
  const result = await service.apply(preview.preview_id, preview.approval_code);
  assert.equal(result.status, "APPLIED");
  assert.equal(result.committed_lines, 1);
  assert.equal(result.failure, null);
  assert.match(result.next_step, /purchase_verify/);
  assert.equal(db.rpcCalls.length, 1);
  assert.equal(db.rpcCalls[0].p_operation_id, purchaseLineOperationId("occ-1", 1), "deterministic operation id");
  assert.equal(db.rpcCalls[0].p_supplier_name, "Puregold");
  assert.equal(db.rpcCalls[0].p_purchase_date, "2026-03-02");
  assert.equal(quantity(db, egg), 50);
  assert.deepEqual(counts(db), { supply: 1, txs: 1, receipts: 1 });
  const line = result.lines[0];
  assert.deepEqual([line.outcome, line.ingredient_name, line.quantity_after, line.cost_trusted], ["applied", "Egg", 50, null]);
  const record = stored(db).apply_result;
  assert.equal(record.status, "APPLIED");
  assert.equal(record.lines[0].supply_id, line.supply_id);
  assert.equal(record.lines[0].transaction_id, line.transaction_id);
  assert.equal(stored(db).verified_at, null, "apply never marks a purchase verified");
});

test("purchase_apply: a multi-line purchase posts lines in order and persists progress BEFORE the next line", async () => {
  const { db, service, intent, egg, flour, sugar } = scenario();
  const preview = await service.preview(intent());
  const result = await service.apply(preview.preview_id, preview.approval_code);
  assert.equal(result.status, "APPLIED");
  assert.deepEqual(db.rpcCalls.map((call) => call.p_operation_id), [1, 2, 3].map((row) => purchaseLineOperationId("occ-1", row)));
  assert.deepEqual(db.rpcCalls.map((call) => call.p_ingredient_id), [egg.id, flour.id, sugar.id]);
  assert.deepEqual([quantity(db, egg), quantity(db, flour), quantity(db, sugar)], [50, 2500, 700]);
  assert.equal(db.rpcCalls[1].p_brand_name, "Gold Medal");
  assert.equal(db.rpcCalls[1].p_base_quantity, 2000);
  // the stored progress visible at the moment each RPC began
  assert.equal(db.progressAtRpc[0], null, "nothing recorded before the first line");
  assert.deepEqual(db.progressAtRpc[1]!.lines.map((line: Row) => line.outcome), ["applied", "not_attempted", "not_attempted"]);
  assert.deepEqual(db.progressAtRpc[2]!.lines.map((line: Row) => line.outcome), ["applied", "applied", "not_attempted"]);
  assert.deepEqual(stored(db).apply_result.lines.map((line: Row) => line.outcome), ["applied", "applied", "applied"]);
});

test("purchase_apply: an exact retry after full success posts nothing and calls no RPC", async () => {
  const { db, service, intent } = scenario();
  const preview = await service.preview(intent());
  const first = await service.apply(preview.preview_id, preview.approval_code);
  const afterFirst = { counts: counts(db), rpc: db.rpcCalls.length, record: structuredClone(stored(db).apply_result) };
  const retry = await service.apply(preview.preview_id, preview.approval_code);
  assert.equal(retry.status, "REPLAYED");
  assert.deepEqual(retry.lines.map((line) => line.outcome), ["replayed", "replayed", "replayed"]);
  assert.deepEqual(retry.lines.map((line) => line.supply_id), first.lines.map((line) => line.supply_id));
  assert.deepEqual(counts(db), afterFirst.counts);
  assert.equal(db.rpcCalls.length, afterFirst.rpc, "an already-recorded line is read back, not re-posted");
  assert.deepEqual(stored(db).apply_result, afterFirst.record, "a replay does not rewrite the durable record");
});

test("purchase_apply: line 2 fails -> PARTIALLY_APPLIED, line 3 not attempted, line 1 stays committed; a retry resumes without duplicating", async () => {
  const { db, service, intent, egg, flour, sugar } = scenario();
  const preview = await service.preview(intent());
  db.failRpc = (args) => (args.p_operation_id === purchaseLineOperationId("occ-1", 2) ? { code: "XX000", message: "connection reset" } : null);
  const partial = await service.apply(preview.preview_id, preview.approval_code);
  assert.equal(partial.status, "PARTIALLY_APPLIED");
  assert.equal(partial.committed_lines, 1);
  assert.deepEqual(partial.lines.map((line) => line.outcome), ["applied", "failed", "not_attempted"]);
  assert.equal(partial.failure?.row_number, 2);
  assert.equal(partial.failure?.code, "purchase_apply_failed");
  assert.match(partial.message, /PARTIALLY_APPLIED: 1 of 3 lines are committed .* NOT rolled back/);
  assert.match(partial.message, /not atomic/);
  assert.match(partial.next_step, /resumes at the failed line/);
  assert.equal(db.rpcCalls.length, 2, "apply stops on the first failure");
  assert.deepEqual([quantity(db, egg), quantity(db, flour), quantity(db, sugar)], [50, 500, 200]);
  assert.deepEqual(stored(db).apply_result.lines.map((line: Row) => line.outcome), ["applied", "failed", "not_attempted"]);
  assert.equal(stored(db).apply_result.status, "PARTIALLY_APPLIED");

  db.failRpc = null;
  const resumed = await service.apply(preview.preview_id, preview.approval_code);
  assert.equal(resumed.status, "APPLIED");
  assert.deepEqual(resumed.lines.map((line) => line.outcome), ["replayed", "applied", "applied"]);
  assert.equal(db.rpcCalls.length, 4, "only the two unfinished lines were posted; line 1 was not re-posted");
  assert.deepEqual([quantity(db, egg), quantity(db, flour), quantity(db, sugar)], [50, 2500, 700], "every line posted exactly once");
  assert.deepEqual(counts(db), { supply: 3, txs: 3, receipts: 3 });
  assert.deepEqual(stored(db).apply_result.lines.map((line: Row) => line.outcome), ["applied", "applied", "applied"]);
});

test("purchase_apply: a failure on the FIRST line (nothing committed) is an error, not a partial result", async () => {
  const { db, service, intent } = scenario();
  const preview = await service.preview(intent());
  db.failRpc = () => ({ code: "XX000", message: "db down" });
  await rejectsWith(service.apply(preview.preview_id, preview.approval_code), "purchase_apply_failed", /retrying is safe/);
  assert.equal(stored(db).apply_result, null, "nothing committed, so no apply record is created (the artifact stays refreshable)");
  assert.equal(db.rpcCalls.length, 1);
});

test("purchase_apply: database refusals surface their own message; a non-owner is mapped to not_authorized", async () => {
  // The preview already blocks an uncounted ingredient, so make the count disappear AFTER the preview
  // to exercise the database's own refusal on the RPC path.
  const stock = scenario();
  const stockPreview = await stock.service.preview(stock.intent({}, 1));
  stock.db.ingredients.get(stock.egg.id)!.inventory_reconciled_at = null;
  await rejectsWith(stock.service.apply(stockPreview.preview_id, stockPreview.approval_code), "purchase_line_rejected", /Verify the physical stock of "Egg"/);
  assert.equal(stored(stock.db).apply_result, null);

  const owner = scenario();
  const ownerPreview = await owner.service.preview(owner.intent({}, 1));
  owner.db.failRpc = () => ({ code: "42501", message: "Only the product lab owner may post a purchase" });
  await rejectsWith(owner.service.apply(ownerPreview.preview_id, ownerPreview.approval_code), "purchase_not_authorized", /Only the Product Lab owner/);
});

test("purchase_apply: the DB commits but saving progress fails -> loud error, then a retry recovers without duplicating", async () => {
  const { db, service, intent, egg } = scenario();
  const preview = await service.preview(intent({}, 2));
  db.failApplyUpdates = 1; // the progress write for line 1 fails once
  await rejectsWith(service.apply(preview.preview_id, preview.approval_code), "purchase_progress_not_saved", /retry|same preview_id/);
  assert.equal(quantity(db, egg), 50, "line 1 IS committed in the database");
  assert.equal(stored(db).apply_result, null, "but its progress was not recorded");
  assert.equal(db.rpcCalls.length, 1);

  const recovered = await service.apply(preview.preview_id, preview.approval_code);
  assert.equal(recovered.status, "APPLIED");
  assert.equal(db.rpcCalls.length, 3, "line 1 was re-presented to claim_mutation (replay), then line 2 posted");
  assert.equal(db.rpcCalls[0].p_operation_id, db.rpcCalls[1].p_operation_id, "the SAME operation id");
  assert.equal(quantity(db, egg), 50, "line 1 was not posted twice");
  assert.deepEqual(counts(db), { supply: 2, txs: 2, receipts: 2 });
  assert.equal(recovered.lines[0].outcome, "applied", "recovered lines read as applied; the service does not claim to know the receipt replayed");
  assert.deepEqual(stored(db).apply_result.lines.map((line: Row) => line.outcome), ["applied", "applied"]);
});

test("purchase_apply: a corrected preview reusing an occasion fails closed with the new-occasion message (claim_mutation 23514)", async () => {
  const { db, service, intent, egg } = scenario();
  const original = await service.preview(intent({}, 1));
  await service.apply(original.preview_id, original.approval_code);
  const before = { counts: counts(db), qty: quantity(db, egg) };

  const corrected = await service.preview(intent({ items: [{ raw_name: "Egg", quantity: 30, unit: "pcs", total_price: 301 }] }));
  assert.notEqual(corrected.preview_id, original.preview_id);
  await rejectsWith(
    service.apply(corrected.preview_id, corrected.approval_code),
    "purchase_occasion_collision",
    /already been used for a different approved purchase payload\. Create a NEW occasion_id/,
  );
  assert.deepEqual({ counts: counts(db), qty: quantity(db, egg) }, before, "the rejected call changed nothing");
  assert.equal(db.previews.get(corrected.preview_id)!.apply_result, null);
  assert.equal(db.previews.get(original.preview_id)!.apply_result.status, "APPLIED", "the original is untouched");
});

test("purchase_apply: a collision on a later line is a loud partial, and its message says a new occasion is required", async () => {
  const { db, service, intent } = scenario();
  // line 2's operation id was already used for a different payload (a different preview of the same occasion)
  const other = await service.preview(intent({}, 2));
  db.failRpc = (args) => (args.p_operation_id === purchaseLineOperationId("occ-1", 2) ? { code: "XX000", message: "x" } : null);
  await service.apply(other.preview_id, other.approval_code); // line 1 committed, line 2 failed
  db.failRpc = null;
  const changedLine2 = await service.preview(intent({ items: [
    { raw_name: "Egg", quantity: 30, unit: "pcs", total_price: 300 },
    { raw_name: "Flour", quantity: 2, unit: "kg", total_price: 190, brand: "Gold Medal" },
  ] }, 2));
  assert.equal(changedLine2.preview_id, other.preview_id, "identical purchase");
  // simulate line 2 having been posted earlier under a different payload
  db.receipts.set(purchaseLineOperationId("occ-1", 2), { hash: "an-earlier-different-payload", result: { supply_id: "x", transaction_id: "y" } });
  const result = await service.apply(changedLine2.preview_id, changedLine2.approval_code);
  assert.equal(result.status, "PARTIALLY_APPLIED");
  assert.equal(result.failure?.code, "purchase_occasion_collision");
  assert.match(result.failure?.message ?? "", /NEW occasion_id/);
  assert.match(result.next_step, /will keep failing/);
});

test("purchase_apply: an already-committed line is read back; a missing (reversed) row fails closed and nothing is reposted", async () => {
  const { db, service, intent, egg } = scenario();
  const preview = await service.preview(intent({}, 2));
  const applied = await service.apply(preview.preview_id, preview.approval_code);
  db.reverse(applied.lines[0].supply_id as string); // Safe Purchase Delete of line 1
  const afterReversal = { counts: counts(db), qty: quantity(db, egg), rpc: db.rpcCalls.length };
  await rejectsWith(service.apply(preview.preview_id, preview.approval_code), "purchase_reversed_or_missing", /NEW occasion_id/);
  assert.deepEqual({ counts: counts(db), qty: quantity(db, egg), rpc: db.rpcCalls.length }, afterReversal, "no RPC, no repost, receipts untouched");
  assert.equal(stored(db).apply_result.lines[0].supply_id, applied.lines[0].supply_id, "recorded identifiers are never cleared");
});

test("purchase_apply: an already-committed line whose row no longer matches the approved line fails closed", async () => {
  const { db, service, intent } = scenario();
  const preview = await service.preview(intent({}, 2));
  const applied = await service.apply(preview.preview_id, preview.approval_code);
  for (const [patch, label] of [
    [{ total_cost: 999 }, "cost"], [{ supplier_name: "Elsewhere" }, "supplier"], [{ purchase_date: "2026-03-09" }, "date"], [{ brand_name: "Other" }, "brand"],
  ] as Array<[Row, string]>) {
    const supplyRow = db.supply.get(applied.lines[1].supply_id as string)!;
    const original = { ...supplyRow };
    Object.assign(supplyRow, patch);
    const rpcBefore = db.rpcCalls.length;
    await rejectsWith(service.apply(preview.preview_id, preview.approval_code), "purchase_reversed_or_missing", new RegExp(label === "cost" ? "total cost" : label === "date" ? "purchase date" : label));
    assert.equal(db.rpcCalls.length, rpcBefore);
    Object.assign(supplyRow, original);
  }
  const tx = db.txs.get(applied.lines[0].transaction_id as string)!;
  tx.quantity_after = 12345;
  await rejectsWith(service.apply(preview.preview_id, preview.approval_code), "purchase_reversed_or_missing", /ledger/);
});

test("purchase_apply: with the artifact's progress lost, retrying a reversed line replays the stale receipt, reads back, and refuses -- never reposting", async () => {
  const { db, service, intent, egg } = scenario();
  const first = await service.preview(intent({}, 1));
  const applied = await service.apply(first.preview_id, first.approval_code);
  db.reverse(applied.lines[0].supply_id as string);
  db.previews.clear(); // the artifact (and its progress) is gone; the receipt remains
  const again = await service.preview(intent({}, 1));
  const afterReversal = { counts: counts(db), qty: quantity(db, egg) };
  await rejectsWith(service.apply(again.preview_id, again.approval_code), "purchase_reversed_or_missing", /NEW occasion_id/);
  assert.equal(db.rpcCalls.length, 2, "the RPC was consulted once (replay) and its stale result was NOT trusted");
  assert.deepEqual({ counts: counts(db), qty: quantity(db, egg) }, afterReversal, "nothing was recreated under the same occasion");
  assert.equal(stored(db).apply_result, null, "the unverifiable line was not recorded as committed");
});

test("purchase_apply: id, approval, expiry and integrity guards all refuse before any RPC", async () => {
  const { db, service, intent } = scenario();
  const preview = await service.preview(intent());
  await rejectsWith(service.apply("pc_00000000000000000000", "X"), "purchase_preview_not_found");
  await rejectsWith(service.apply("pu_00000000000000000000", "X"), "purchase_preview_not_found");
  await rejectsWith(service.apply(preview.preview_id, "0000-0000"), "purchase_approval_mismatch");
  await rejectsWith(service.apply(preview.preview_id, " "), "purchase_approval_mismatch");

  const tampered = structuredClone(stored(db));
  stored(db).preview.rows[0].total_price = 1;
  await rejectsWith(service.apply(preview.preview_id, preview.approval_code), "purchase_preview_integrity_failed");
  stored(db).preview = tampered.preview;

  stored(db).apply_result = { version: 1, lines: [], status: "APPLIED" };
  await rejectsWith(service.apply(preview.preview_id, preview.approval_code), "purchase_preview_integrity_failed", /integrity check/);
  stored(db).apply_result = null;

  stored(db).expires_at = "2020-01-01T00:00:00.000Z";
  await rejectsWith(service.apply(preview.preview_id, preview.approval_code), "purchase_preview_expired", /expired/);
  assert.equal(db.rpcCalls.length, 0);
});

test("purchase_apply: cost_trusted is observed, never assumed -- missing before V4, boolean after", async () => {
  const pre = scenario({ postV4: false });
  const prePreview = await pre.service.preview(pre.intent({}, 1));
  assert.equal((await pre.service.apply(prePreview.preview_id, prePreview.approval_code)).lines[0].cost_trusted, null);
  const post = scenario({ postV4: true });
  const postPreview = await post.service.preview(post.intent({}, 1));
  const applied = await post.service.apply(postPreview.preview_id, postPreview.approval_code);
  assert.equal(typeof applied.lines[0].cost_trusted, "boolean");
  assert.equal(stored(post.db).apply_result.lines[0].cost_trusted, applied.lines[0].cost_trusted);
});

// ---- expiry bounds STARTING an approval, not safely continuing one ---------------------------

const expire = (db: FakeDb) => { stored(db).expires_at = "2020-01-01T00:00:00.000Z"; };

test("expiry: an expired never-started preview is blocked with zero RPC calls, a cautious message, and no silent refresh", async () => {
  const { db, service, intent, egg } = scenario();
  const preview = await service.preview(intent());
  expire(db);
  const before = structuredClone(stored(db));
  const writesBefore = db.previewWrites.length;
  await rejectsWith(service.apply(preview.preview_id, preview.approval_code), "purchase_preview_expired",
    /expired and no durable apply progress can be confirmed\. Do not recreate or repost it until purchase history is reviewed\./);
  await assert.rejects(service.apply(preview.preview_id, preview.approval_code), (error: unknown) => {
    const message = (error as PurchaseDomainError).publicMessage;
    assert.doesNotMatch(message, /NEW occasion_id/, "expiry alone never tells the owner to create a new occasion_id");
    assert.doesNotMatch(message, /nothing was (posted|written)|never written/i, "must not claim nothing was ever written");
    return true;
  });
  assert.equal(db.rpcCalls.length, 0);
  assert.deepEqual(counts(db), { supply: 0, txs: 0, receipts: 0 });
  assert.equal(quantity(db, egg), 20);
  assert.equal(db.previewWrites.length, writesBefore, "apply never writes to an expired never-started artifact (no refresh)");
  assert.deepEqual(stored(db), before);
  // purchase_preview still owns the separate expired-never-applied refresh semantics
  const refreshed = await service.preview(intent());
  assert.equal(refreshed.preview_id, preview.preview_id);
  assert.ok(Date.parse(stored(db).expires_at) > Date.now());
});

test("expiry: an expired preview with an apply_result but NO committed line is still 'never started' (blocked, no RPC)", async () => {
  const { db, service, intent } = scenario();
  const preview = await service.preview(intent());
  stored(db).apply_result = {
    version: 1, status: "NOT_APPLIED", preview_id: preview.preview_id, occasion_id: "occ-1", updated_at: "2026-01-01T00:00:00.000Z",
    lines: (stored(db).preview.rows as Row[]).map((row) => ({
      row_number: row.row_number, operation_id: purchaseLineOperationId("occ-1", row.row_number), ingredient_id: row.canonical_ingredient_id,
      outcome: "not_attempted", supply_id: null, transaction_id: null, quantity_after: null, average_unit_cost: null, cost_trusted: null, error: null,
    })),
  };
  expire(db);
  await rejectsWith(service.apply(preview.preview_id, preview.approval_code), "purchase_preview_expired");
  assert.equal(db.rpcCalls.length, 0);
});

test("expiry: crash-gap after expiry (DB committed, progress never saved) is refused WITHOUT probing the database", async () => {
  const { db, service, intent, egg } = scenario();
  const preview = await service.preview(intent({}, 2));
  db.failApplyUpdates = 1;
  await rejectsWith(service.apply(preview.preview_id, preview.approval_code), "purchase_progress_not_saved");
  assert.equal(quantity(db, egg), 50, "line 1 really is committed, but unrecorded");
  expire(db);
  const rpcBefore = db.rpcCalls.length;
  await rejectsWith(service.apply(preview.preview_id, preview.approval_code), "purchase_preview_expired", /Do not recreate or repost it until purchase history is reviewed/);
  assert.equal(db.rpcCalls.length, rpcBefore, "no RPC just to discover whether something happened: that could START a purchase on an expired approval");
  assert.deepEqual(counts(db), { supply: 1, txs: 1, receipts: 1 });
});

test("expiry: an expired PARTIAL purchase resumes -- committed rows read back, no RPC for them, the rest posts once", async () => {
  const { db, service, intent, egg, flour, sugar } = scenario();
  const preview = await service.preview(intent());
  db.failRpc = (args) => (args.p_operation_id === purchaseLineOperationId("occ-1", 2) ? { code: "XX000", message: "connection reset" } : null);
  const partial = await service.apply(preview.preview_id, preview.approval_code);
  assert.equal(partial.status, "PARTIALLY_APPLIED");
  db.failRpc = null;
  expire(db);
  const rpcBefore = db.rpcCalls.length;
  const originalPreview = structuredClone(stored(db).preview);

  const resumed = await service.apply(preview.preview_id, preview.approval_code);
  assert.equal(resumed.status, "APPLIED");
  assert.deepEqual(resumed.lines.map((line) => line.outcome), ["replayed", "applied", "applied"]);
  assert.deepEqual(db.rpcCalls.slice(rpcBefore).map((call) => call.p_operation_id), [2, 3].map((row) => purchaseLineOperationId("occ-1", row)),
    "only the incomplete lines were posted, with the same deterministic occasion + row ids; the committed line got no RPC");
  assert.deepEqual([quantity(db, egg), quantity(db, flour), quantity(db, sugar)], [50, 2500, 700], "every line posted exactly once");
  assert.deepEqual(counts(db), { supply: 3, txs: 3, receipts: 3 });
  assert.deepEqual(stored(db).apply_result.lines.map((line: Row) => line.outcome), ["applied", "applied", "applied"]);
  assert.deepEqual(stored(db).preview, originalPreview, "the immutable approved artifact was the authority; it was not refreshed or rewritten");
  assert.doesNotMatch(JSON.stringify(resumed), /NEW occasion_id/, "expiry alone never produces new-occasion advice");
  assert.match(resumed.next_step, /purchase_verify/);
});

test("expiry: an expired partial resume still validates the approval code and the stored preview's integrity first", async () => {
  const { db, service, intent } = scenario();
  const preview = await service.preview(intent());
  db.failRpc = (args) => (args.p_operation_id === purchaseLineOperationId("occ-1", 2) ? { code: "XX000", message: "x" } : null);
  await service.apply(preview.preview_id, preview.approval_code);
  db.failRpc = null;
  expire(db);
  const rpcBefore = db.rpcCalls.length;
  await rejectsWith(service.apply(preview.preview_id, "0000-0000"), "purchase_approval_mismatch");
  stored(db).preview.rows[1].total_price = 1;
  await rejectsWith(service.apply(preview.preview_id, preview.approval_code), "purchase_preview_integrity_failed");
  assert.equal(db.rpcCalls.length, rpcBefore);
});

test("expiry: an expired partial whose committed row is missing fails closed and reposts nothing", async () => {
  const { db, service, intent, egg } = scenario();
  const preview = await service.preview(intent());
  db.failRpc = (args) => (args.p_operation_id === purchaseLineOperationId("occ-1", 2) ? { code: "XX000", message: "x" } : null);
  const partial = await service.apply(preview.preview_id, preview.approval_code);
  db.failRpc = null;
  db.reverse(partial.lines[0].supply_id as string);
  expire(db);
  const after = { counts: counts(db), qty: quantity(db, egg), rpc: db.rpcCalls.length };
  await rejectsWith(service.apply(preview.preview_id, preview.approval_code), "purchase_reversed_or_missing", /NEW occasion_id/);
  assert.deepEqual({ counts: counts(db), qty: quantity(db, egg), rpc: db.rpcCalls.length }, after, "no RPC, no repost of the recorded line, no later line started");
  assert.equal(stored(db).apply_result.lines[0].supply_id, partial.lines[0].supply_id, "recorded identifiers are never cleared");
});

test("expiry: an expired FULLY applied purchase returns REPLAYED after read-back, with zero RPC calls", async () => {
  const { db, service, intent } = scenario();
  const preview = await service.preview(intent());
  const first = await service.apply(preview.preview_id, preview.approval_code);
  expire(db);
  const rpcBefore = db.rpcCalls.length;
  const record = structuredClone(stored(db).apply_result);
  const replay = await service.apply(preview.preview_id, preview.approval_code);
  assert.equal(replay.status, "REPLAYED");
  assert.deepEqual(replay.lines.map((line) => line.supply_id), first.lines.map((line) => line.supply_id));
  assert.equal(db.rpcCalls.length, rpcBefore);
  assert.deepEqual(stored(db).apply_result, record);
  // and read-back still guards it
  db.reverse(first.lines[2].supply_id as string);
  await rejectsWith(service.apply(preview.preview_id, preview.approval_code), "purchase_reversed_or_missing");
  assert.equal(db.rpcCalls.length, rpcBefore);
});

test("expiry: an expired artifact with a malformed apply_result is an integrity failure -- never 'never started', never reposted", async () => {
  const { db, service, intent } = scenario();
  const preview = await service.preview(intent());
  const rows = stored(db).preview.rows as Row[];
  const line = (row: Row, patch: Row = {}) => ({
    row_number: row.row_number, operation_id: purchaseLineOperationId("occ-1", row.row_number), ingredient_id: row.canonical_ingredient_id,
    outcome: "not_attempted", supply_id: null, transaction_id: null, quantity_after: null, average_unit_cost: null, cost_trusted: null, error: null, ...patch,
  });
  const malformed: Array<[string, unknown]> = [
    ["a string", "oops"],
    ["an empty object", {}],
    ["an array", []],
    ["wrong version", { version: 2, lines: rows.map((row) => line(row)) }],
    ["too few lines", { version: 1, lines: [line(rows[0])] }],
    ["committed without ids", { version: 1, lines: rows.map((row, index) => line(row, index === 0 ? { outcome: "applied" } : {})) }],
    ["a foreign operation id", { version: 1, lines: rows.map((row, index) => line(row, index === 0 ? { outcome: "applied", supply_id: "s", transaction_id: "t", operation_id: purchaseLineOperationId("another-occasion", 1) } : {})) }],
    ["an unknown outcome", { version: 1, lines: rows.map((row) => line(row, { outcome: "exploded" })) }],
    ["mismatched ingredient", { version: 1, lines: rows.map((row) => line(row, { ingredient_id: "someone-else" })) }],
  ];
  for (const expired of [false, true]) {
    for (const [label, record] of malformed) {
      stored(db).apply_result = record;
      stored(db).expires_at = expired ? "2020-01-01T00:00:00.000Z" : new Date(Date.now() + 3600_000).toISOString();
      await rejectsWith(service.apply(preview.preview_id, preview.approval_code), "purchase_preview_integrity_failed", /Do not recreate or repost this purchase until purchase history has been reviewed/);
      assert.equal(db.rpcCalls.length, 0, `${label} (expired=${expired}): zero RPC calls`);
    }
  }
  assert.deepEqual(counts(db), { supply: 0, txs: 0, receipts: 0 });
  await assert.rejects(service.apply(preview.preview_id, preview.approval_code), (error: unknown) => {
    assert.doesNotMatch((error as PurchaseDomainError).publicMessage, /NEW occasion_id/, "an integrity failure never advises recreating the purchase");
    return true;
  });
});

test("expiry: purchase_verify keeps working after expiry for a partial and for a complete purchase", async () => {
  const { db, service, intent } = scenario();
  const preview = await service.preview(intent());
  db.failRpc = (args) => (args.p_operation_id === purchaseLineOperationId("occ-1", 3) ? { code: "XX000", message: "x" } : null);
  await service.apply(preview.preview_id, preview.approval_code);
  expire(db);
  const partial = await service.verify(preview.preview_id);
  assert.equal(partial.status, "partial");
  assert.deepEqual(partial.uncommitted_rows, [3]);
  assert.equal(stored(db).verified_at, null);
  db.failRpc = null;
  await service.apply(preview.preview_id, preview.approval_code); // resumes although expired
  const full = await service.verify(preview.preview_id);
  assert.equal(full.status, "verified");
  assert.ok(stored(db).verified_at);
});

// ---- verify -----------------------------------------------------------------------------------

test("purchase_verify: full success reads the real rows, records verified_at, and changes nothing else", async () => {
  const { db, service, intent } = scenario();
  const preview = await service.preview(intent());
  await service.apply(preview.preview_id, preview.approval_code);
  const before = structuredClone(stored(db));
  const verified = await service.verify(preview.preview_id);
  assert.equal(verified.status, "verified");
  assert.equal(verified.apply_status, "APPLIED");
  assert.equal(verified.verified_lines, 3);
  assert.deepEqual(verified.uncommitted_rows, []);
  assert.equal(verified.total_spent, 550);
  const flourRow = verified.rows[1];
  assert.deepEqual(
    [flourRow.ingredient, flourRow.supplier, flourRow.purchase_date, flourRow.brand, flourRow.entered_quantity, flourRow.entered_unit, flourRow.total_price, flourRow.base_unit, flourRow.quantity_before, flourRow.quantity_change, flourRow.quantity_after],
    ["Flour", "Puregold", "2026-03-02", "Gold Medal", 2, "kg", 190, "g", 500, 2000, 2500],
  );
  assert.equal(flourRow.quantity_before + flourRow.quantity_change, flourRow.quantity_after, "internal consistency");
  assert.equal(verified.rows[0].brand, null);
  const after = stored(db);
  assert.ok(after.verified_at && Date.parse(after.verified_at) <= Date.now());
  assert.deepEqual({ ...after, verified_at: null }, { ...before, verified_at: null }, "preview and apply_result are untouched");
});

test("purchase_verify: later unrelated inventory movements do NOT false-fail, and are reported as observed", async () => {
  const { db, service, intent, flour } = scenario();
  const preview = await service.preview(intent());
  await service.apply(preview.preview_id, preview.approval_code);
  const flourRow = db.ingredients.get(flour.id)!;
  flourRow.current_quantity = 100; // a Bake consumed most of it
  flourRow.average_unit_cost = 9.99;
  flourRow.cost_reconciled_at = "2026-10-01T00:00:00Z";
  db.txs.set("later-1", { id: "later-1", ingredient_id: flour.id, transaction_type: "consume", source_type: "bake", source_id: "b", quantity_before: 2500, quantity_change: -2400, quantity_after: 100 });
  const verified = await service.verify(preview.preview_id);
  assert.equal(verified.status, "verified");
  assert.deepEqual(verified.rows[1].current_observed, { current_quantity: 100, average_unit_cost: 9.99, cost_reconciled_at: "2026-10-01T00:00:00Z" });
  assert.equal(verified.rows[1].quantity_after, 2500, "the purchase's own ledger row is still what was posted");
});

test("purchase_verify: tolerates a missing cost_trusted (pre-V4) and accepts a reported one (post-V4)", async () => {
  const pre = scenario({ postV4: false });
  const prePreview = await pre.service.preview(pre.intent({}, 1));
  await pre.service.apply(prePreview.preview_id, prePreview.approval_code);
  assert.equal((await pre.service.verify(prePreview.preview_id)).rows[0].cost_trusted_at_post, null);
  const post = scenario({ postV4: true });
  const postPreview = await post.service.preview(post.intent({}, 1));
  await post.service.apply(postPreview.preview_id, postPreview.approval_code);
  const verified = await post.service.verify(postPreview.preview_id);
  assert.equal(verified.status, "verified");
  assert.equal(typeof verified.rows[0].cost_trusted_at_post, "boolean");
});

test("purchase_verify: a missing (reversed) row FAILS and verified_at is not set; a mismatched row fails too", async () => {
  const { db, service, intent } = scenario();
  const preview = await service.preview(intent({}, 2));
  const applied = await service.apply(preview.preview_id, preview.approval_code);
  db.reverse(applied.lines[1].supply_id as string);
  await rejectsWith(service.verify(preview.preview_id), "purchase_reversed_or_missing", /Verification FAILED: line 2.*NEW occasion_id/);
  assert.equal(stored(db).verified_at, null);

  const other = scenario();
  const otherPreview = await other.service.preview(other.intent({}, 1));
  const otherApplied = await other.service.apply(otherPreview.preview_id, otherPreview.approval_code);
  other.db.txs.get(otherApplied.lines[0].transaction_id as string)!.quantity_change = 31;
  await rejectsWith(other.service.verify(otherPreview.preview_id), "purchase_verification_failed", /ledger quantity change/);
  assert.equal(stored(other.db).verified_at, null);
});

test("purchase_verify: a partially applied purchase is reported as partial and is NEVER marked verified", async () => {
  const { db, service, intent } = scenario();
  const preview = await service.preview(intent());
  db.failRpc = (args) => (args.p_operation_id === purchaseLineOperationId("occ-1", 2) ? { code: "XX000", message: "boom" } : null);
  await service.apply(preview.preview_id, preview.approval_code);
  const verified = await service.verify(preview.preview_id);
  assert.equal(verified.status, "partial");
  assert.equal(verified.apply_status, "PARTIALLY_APPLIED");
  assert.equal(verified.verified_lines, 1);
  assert.deepEqual(verified.uncommitted_rows, [2, 3]);
  assert.match(verified.note, /NOT fully applied and is NOT marked verified/);
  assert.equal(stored(db).verified_at, null);
});

test("purchase_verify: nothing applied, an unknown id and a tampered preview are all refused", async () => {
  const { db, service, intent } = scenario();
  const preview = await service.preview(intent());
  await rejectsWith(service.verify(preview.preview_id), "purchase_not_applied");
  await rejectsWith(service.verify("pu_00000000000000000000"), "purchase_preview_not_found");
  await rejectsWith(service.verify("not-an-id"), "purchase_preview_not_found");
  stored(db).preview.supplier = "Tampered";
  await rejectsWith(service.verify(preview.preview_id), "purchase_preview_integrity_failed");
});

test("purchase_verify: an expired but applied artifact can still be verified (expiry only limits the approval window)", async () => {
  const { db, service, intent } = scenario();
  const preview = await service.preview(intent({}, 1));
  await service.apply(preview.preview_id, preview.approval_code);
  stored(db).expires_at = "2020-01-01T00:00:00.000Z";
  assert.equal((await service.verify(preview.preview_id)).status, "verified");
});

// ---- the local (stdio) store shares the same rules --------------------------------------------

test("local artifact store: same insert-if-absent / never-overwrite-applied / refresh-expired behavior", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "purchase-local-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { db, client, intent } = scenario();
  const loadState = async () => ({
    ingredientRows: [], ingredients: [...db.ingredients.keys()].map((id) => db.domainIngredient(id)), aliases: [],
    transactions: [], supplies: [], supplyRows: [], authoritativeAverageUnitCosts: {},
  });
  const service = new PurchaseService({ loadState } as never, async () => client, createPurchaseArtifactStore(directory));
  const preview = await service.preview(intent({}, 1));
  const file = path.join(directory, `${preview.preview_id}.json`);
  assert.deepEqual(await readdir(directory), [`${preview.preview_id}.json`]);
  assert.equal((await service.preview(intent({}, 1))).preview_id, preview.preview_id);

  const applied = await service.apply(preview.preview_id, preview.approval_code);
  assert.equal(applied.status, "APPLIED");
  assert.equal((await service.verify(preview.preview_id)).status, "verified");
  const onDisk = JSON.parse(await readFile(file, "utf8"));
  assert.equal(onDisk.apply_result.status, "APPLIED");
  assert.ok(onDisk.verified_at);
  assert.equal((await service.preview(intent({}, 1))).apply_status, "APPLIED");
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), onDisk, "an applied artifact is never overwritten");

  // an expired never-applied artifact is refreshed
  const other = await service.preview(intent({ occasion_id: "occ-local-2" }, 1));
  const otherFile = path.join(directory, `${other.preview_id}.json`);
  const expired = JSON.parse(await readFile(otherFile, "utf8"));
  expired.expires_at = "2020-01-01T00:00:00.000Z";
  await writeFile(otherFile, JSON.stringify(expired));
  await service.preview(intent({ occasion_id: "occ-local-2" }, 1));
  assert.ok(Date.parse(JSON.parse(await readFile(otherFile, "utf8")).expires_at) > Date.now());
  await rejectsWith(service.apply("pu_ffffffffffffffffffff", "X"), "purchase_preview_not_found");
});

// ---- MCP surface ------------------------------------------------------------------------------

async function connectMcp(service: PurchaseService | object) {
  const readStub = { inventoryList: async () => ({ inventory: [], returned: 0, total: 0, truncated: false }) };
  const server = createProductLabMcpServer(readStub as never, {} as never, service as never);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "purchase-test", version: "1.0.0" });
  await client.connect(clientTransport);
  return client;
}

test("MCP: exactly eight tools, strict schemas, and apply/verify accept only ids and the approval code", async (t) => {
  const { service } = scenario();
  const client = await connectMcp(service);
  t.after(() => client.close());
  const tools = (await client.listTools()).tools;
  assert.deepEqual(tools.map((tool) => tool.name).sort(), [
    "ingredient_inspect", "inventory_count_apply", "inventory_count_preview", "inventory_count_verify", "inventory_list",
    "purchase_apply", "purchase_preview", "purchase_verify",
  ]);
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  const properties = (name: string) => Object.keys((byName[name].inputSchema as { properties?: object }).properties ?? {}).sort();
  assert.deepEqual(properties("purchase_apply"), ["approval_code", "preview_id"]);
  assert.deepEqual(properties("purchase_verify"), ["preview_id"]);
  assert.deepEqual(properties("purchase_preview"), ["items", "kind", "occasion_id", "purchase_date", "source_note", "supplier"]);
  for (const tool of tools) {
    assert.equal(tool.inputSchema.type, "object");
    assert.equal(tool.outputSchema?.type, "object");
    assert.equal((tool.inputSchema as { additionalProperties?: unknown }).additionalProperties, false, `${tool.name} input must be strict`);
  }
  assert.equal(byName.purchase_verify.annotations?.readOnlyHint, true);
  assert.equal(byName.purchase_apply.annotations?.destructiveHint, true);
  assert.equal(byName.purchase_apply.annotations?.readOnlyHint, false);
  assert.equal(byName.purchase_preview.annotations?.destructiveHint, false);
  for (const forbidden of ["sql", "rpc", "payload", "items", "quantity", "supplier", "occasion_id"]) {
    assert.equal(properties("purchase_apply").includes(forbidden), false, `apply must not accept ${forbidden}`);
  }
  assert.equal(tools.some((tool) => /sql|rpc|reverse|delete/.test(tool.name)), false, "no generic or reversal tool");
});

test("MCP: apply and preview reject unknown or payload-bearing arguments before reaching the service", async (t) => {
  const calls: string[] = [];
  const spy = { preview: async () => { calls.push("preview"); throw new Error("must not run"); }, apply: async () => { calls.push("apply"); throw new Error("must not run"); }, verify: async () => { calls.push("verify"); throw new Error("must not run"); } };
  const client = await connectMcp(spy);
  t.after(() => client.close());
  const attempts: Array<[string, Record<string, unknown>]> = [
    ["purchase_apply", { preview_id: "pu_00000000000000000000", approval_code: "ABCD-1234", items: [{ raw_name: "Egg" }] }],
    ["purchase_apply", { preview_id: "pu_00000000000000000000", approval_code: "ABCD-1234", supplier: "Elsewhere" }],
    ["purchase_apply", { preview_id: "pc_00000000000000000000", approval_code: "ABCD-1234" }],
    ["purchase_apply", { preview_id: "pu_00000000000000000000" }],
    ["purchase_verify", { preview_id: "pu_00000000000000000000", approval_code: "X" }],
    ["purchase_preview", { kind: "purchase", occasion_id: "o", supplier: "S", purchase_date: "2026-01-01", items: [{ raw_name: "Egg", quantity: 1, unit: "pcs", total_price: 1, price_per_unit: 1 }] }],
    ["purchase_preview", { kind: "purchase", occasion_id: "o", supplier: "S", purchase_date: "2026-01-01", items: [], metadata: {} }],
    ["purchase_preview", { kind: "purchase", occasion_id: "o", purchase_date: "2026-01-01", items: [{ raw_name: "Egg", quantity: 1, unit: "pcs", total_price: 1 }] }],
  ];
  for (const [name, args] of attempts) {
    const outcome = await client.callTool({ name, arguments: args }).then((result) => result, (error) => error);
    assert.ok(outcome instanceof Error || (outcome as { isError?: boolean }).isError === true, `${name} ${JSON.stringify(args)} must be rejected`);
  }
  assert.deepEqual(calls, [], "the service was never reached");
});

test("MCP: purchase tools call the injected required service and the existing five tools are unchanged", async (t) => {
  const seen: unknown[] = [];
  const view = { sentinel: true };
  const stub = {
    preview: async (intent: unknown) => { seen.push(["preview", intent]); return view; },
    apply: async (id: string, code: string) => { seen.push(["apply", id, code]); throw new PurchaseDomainError("purchase_approval_mismatch", "preview_error", "stub mismatch"); },
    verify: async (id: string) => { seen.push(["verify", id]); throw new PurchaseDomainError("purchase_not_applied", "verification_failed", "stub not applied"); },
  };
  const client = await connectMcp(stub);
  t.after(() => client.close());
  const applyResult = await client.callTool({ name: "purchase_apply", arguments: { preview_id: "pu_aaaaaaaaaaaaaaaaaaaa", approval_code: " abcd-1234 " } });
  assert.equal(applyResult.isError, true);
  assert.deepEqual(JSON.parse((applyResult.content as Array<{ text: string }>)[0].text), { error: { code: "purchase_approval_mismatch", message: "stub mismatch" } });
  const verifyResult = await client.callTool({ name: "purchase_verify", arguments: { preview_id: "pu_aaaaaaaaaaaaaaaaaaaa" } });
  assert.deepEqual(JSON.parse((verifyResult.content as Array<{ text: string }>)[0].text).error.code, "purchase_not_applied");
  assert.deepEqual(seen, [["apply", "pu_aaaaaaaaaaaaaaaaaaaa", "abcd-1234"], ["verify", "pu_aaaaaaaaaaaaaaaaaaaa"]]);
  const inventory = await client.callTool({ name: "inventory_list", arguments: {} });
  assert.equal(inventory.isError, undefined);
  assert.deepEqual(inventory.structuredContent, { inventory: [], returned: 0, total: 0, truncated: false });
});

test("MCP: preview -> apply -> verify end to end, schema-valid, with a loud partial and a clear collision message", async (t) => {
  const { db, service, intent } = scenario();
  const client = await connectMcp(service);
  t.after(() => client.close());
  const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });

  const preview = await call("purchase_preview", intent() as unknown as Record<string, unknown>);
  assert.equal(preview.isError, undefined, JSON.stringify(preview.content));
  const view = preview.structuredContent as { preview_id: string; approval_code: string; can_apply: boolean; stored: boolean };
  assert.equal(view.can_apply, true);
  assert.equal(db.rpcCalls.length, 0);

  db.failRpc = (args) => (args.p_operation_id === purchaseLineOperationId("occ-1", 3) ? { code: "XX000", message: "boom" } : null);
  const partial = await call("purchase_apply", { preview_id: view.preview_id, approval_code: view.approval_code });
  assert.equal(partial.isError, true, "PARTIALLY_APPLIED must be flagged as an error");
  assert.equal((partial.structuredContent as { status: string }).status, "PARTIALLY_APPLIED");
  assert.equal((partial.structuredContent as { committed_lines: number }).committed_lines, 2);
  const partialVerify = await call("purchase_verify", { preview_id: view.preview_id });
  assert.equal(partialVerify.isError, true);
  assert.equal((partialVerify.structuredContent as { status: string }).status, "partial");

  db.failRpc = null;
  const done = await call("purchase_apply", { preview_id: view.preview_id, approval_code: view.approval_code });
  assert.equal(done.isError, undefined, JSON.stringify(done.content));
  assert.equal((done.structuredContent as { status: string }).status, "APPLIED");
  const verified = await call("purchase_verify", { preview_id: view.preview_id });
  assert.equal(verified.isError, undefined, JSON.stringify(verified.content));
  assert.equal((verified.structuredContent as { status: string }).status, "verified");
  assert.equal(stored(db).verified_at !== null, true);

  const corrected = await call("purchase_preview", intent({ items: [{ raw_name: "Egg", quantity: 30, unit: "pcs", total_price: 777 }] }) as unknown as Record<string, unknown>);
  const correctedView = corrected.structuredContent as { preview_id: string; approval_code: string };
  const collision = await call("purchase_apply", { preview_id: correctedView.preview_id, approval_code: correctedView.approval_code });
  assert.equal(collision.isError, true);
  const body = JSON.parse((collision.content as Array<{ text: string }>)[0].text);
  assert.equal(body.error.code, "purchase_occasion_collision");
  assert.match(body.error.message, /Create a NEW occasion_id/);
  assert.doesNotMatch(JSON.stringify(body), /23514|claim_mutation|operation id was already used/, "no raw SQL detail in the user-facing message");
});
