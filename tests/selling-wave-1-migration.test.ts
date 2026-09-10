import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const migration = readFileSync(
  path.join(import.meta.dirname, "..", "supabase/migrations/20260910120146_selling_wave_1_production_execution.sql"),
  "utf8",
);

test("Wave 1 migration: new tables are RLS-enabled with owner SELECT only and no client write path", () => {
  for (const table of ["production_executions", "finished_stock_movements"]) {
    assert.match(migration, new RegExp(`create table public\\.${table} \\(`), `${table} is created`);
    assert.match(migration, new RegExp(`alter table public\\.${table} enable row level security`), `${table} RLS enabled`);
    assert.match(migration, new RegExp(`create policy "wave1 owner reads [\\w ]+" on public\\.${table}\\s+for select to authenticated using \\(public\\.is_product_lab_owner\\(\\)\\)`), `${table} owner SELECT policy`);
    // No insert/update/delete policy for either table -- only the definer function writes.
    assert.doesNotMatch(migration, new RegExp(`create policy [^;]*on public\\.${table}[^;]*for (insert|update|delete)`, "i"), `${table} has no client write policy`);
  }
  assert.match(migration, /revoke all on public\.production_executions, public\.finished_stock_movements\s+from public, anon, authenticated/);
  assert.match(migration, /grant select on public\.production_executions, public\.finished_stock_movements to authenticated/);
  // No write grant anywhere for these tables.
  assert.doesNotMatch(migration, /grant (insert|update|delete)[^;]*on public\.(production_executions|finished_stock_movements)/i);
});

test("Wave 1 migration: production_executions is immutable-by-construction and idempotent-by-constraint", () => {
  assert.match(migration, /operation_id uuid not null unique/, "operation_id unique -- one execution per Bake intent, even if the claim helper had a bug");
  assert.match(migration, /quantity_produced_pieces integer not null check \(quantity_produced_pieces > 0\)/);
  // Expected yield frozen alongside the observed count, as reference metadata only.
  assert.match(migration, /expected_pieces integer not null check \(expected_pieces >= 0\)/);
  assert.match(migration, /frozen_ingredient_cost_total numeric not null check \(frozen_ingredient_cost_total >= 0\)/);
  assert.match(migration, /frozen_cost_per_piece numeric not null check \(frozen_cost_per_piece >= 0\)/);
  // No status/lifecycle column -- a successful Bake is atomic and immediately complete.
  const createBlock = /create table public\.production_executions \(([\s\S]*?)\n\);/.exec(migration)?.[1] ?? "";
  assert.ok(createBlock, "found the production_executions create-table block");
  assert.doesNotMatch(createBlock, /\bstatus\b/, "no status/lifecycle column");
  assert.doesNotMatch(createBlock, /\bstarted_at\b/, "no started_at -- a Bake is instantaneous at this granularity");
});

test("Wave 1 migration: finished_stock_movements keeps room for Wave 2 verbs without implementing them", () => {
  assert.match(migration, /movement_type text not null check \(movement_type in \('production_receipt', 'reserve', 'release', 'fulfill'\)\)/);
  assert.match(migration, /on_hand_delta integer not null default 0/);
  assert.match(migration, /reserved_delta integer not null default 0/);
  assert.match(migration, /production_execution_id uuid references public\.production_executions\(id\)/, "nullable FK -- future non-production movements");
  // Wave 1 must only ever write production_receipt; reserve/release/fulfill are not produced anywhere.
  const fn = /create or replace function inventory_private\.confirm_bake_v3[\s\S]*?\$\$;/.exec(migration)?.[0] ?? "";
  assert.match(fn, /'production_receipt'/);
  assert.doesNotMatch(fn, /'reserve'|'release'|'fulfill'/);
});

test("Wave 1 migration: a production_receipt movement is constrained to an impossible-to-misuse shape, Wave 2 verbs left open", () => {
  const check = /constraint finished_stock_movements_production_receipt_shape check \(([\s\S]*?)\)\s*\n\s*\)/.exec(migration)?.[1] ?? "";
  assert.ok(check, "the defensive shape check exists");
  assert.match(check, /movement_type <> 'production_receipt'/, "only constrains production_receipt rows");
  assert.match(check, /on_hand_delta > 0/);
  assert.match(check, /reserved_delta = 0/);
  assert.match(check, /production_execution_id is not null/);
});

test("Wave 1 migration: the finished quantity is the operator's observed count, not a projection", () => {
  const fn = /create or replace function inventory_private\.confirm_bake_v3[\s\S]*?\$\$;/.exec(migration)?.[0] ?? "";
  // Signature carries the observed usable-piece count.
  assert.match(migration, /create or replace function inventory_private\.confirm_bake_v3\([\s\S]*?p_actual_pieces_produced numeric[\s\S]*?\) returns jsonb/);
  // Finished quantity comes from that parameter; the recipe projection is only frozen reference.
  assert.match(fn, /v_pieces\s*:=\s*p_actual_pieces_produced::integer/);
  assert.match(fn, /v_expected_pieces\s*:=\s*round\(v_batch\.usable_pieces \* p_multiplier\)::integer/);
  assert.doesNotMatch(fn, /v_pieces\s*:=\s*round\(v_batch\.usable_pieces/);
  // Observed count validated independently of any client-side calculation: integer, >= 1, finite.
  assert.match(fn, /p_actual_pieces_produced is null/);
  assert.match(fn, /p_actual_pieces_produced <> trunc\(p_actual_pieces_produced\)/);
  assert.match(fn, /p_actual_pieces_produced < 1/);
  assert.match(fn, /p_actual_pieces_produced::text = any\(array\['NaN','Infinity','-Infinity'\]\)/);
  // Malformed multiplier now gets the same clean rejection instead of a raw cast error.
  assert.match(fn, /p_multiplier::text = any\(array\['NaN','Infinity','-Infinity'\]\)/);
  // The observed count is part of the idempotency payload -- a changed count on the same op id is rejected.
  assert.match(fn, /v_hash := md5\(concat_ws\('\|'[\s\S]*?p_actual_pieces_produced[\s\S]*?p_deductions::text\)\)/);
  // Per-piece cost divides by the observed count.
  assert.match(fn, /v_cost_per_piece := v_cost_total \/ v_pieces/);
  // Execution row stores both numbers.
  assert.match(fn, /insert into public\.production_executions \([\s\S]*?quantity_produced_pieces, expected_pieces,/);
});

test("Wave 1 migration: confirm_bake_v3 is the atomic contract and follows the Wave 0A/0B security pattern", () => {
  const fn = /create or replace function inventory_private\.confirm_bake_v3[\s\S]*?\$\$;/.exec(migration)?.[0] ?? "";
  assert.ok(fn, "the private function exists");
  assert.match(fn, /security definer set search_path = ''/);
  assert.match(fn, /is_product_lab_owner\(\) is not true/, "owner check");
  assert.match(fn, /inventory_private\.claim_mutation\(p_operation_id, 'bake_produce'/, "reuses the narrow Wave 0B idempotency helper");
  // The whole event in one function body: raw consume + production execution + finished receipt.
  assert.match(fn, /insert into public\.inventory_transactions[\s\S]*insert into public\.production_executions[\s\S]*insert into public\.finished_stock_movements/);
  // Reconciliation gate + all-or-nothing sufficiency, same as Wave 0B.
  assert.match(fn, /inventory_reconciled_at is null/);
  assert.match(fn, /Not enough stock for this Bake/);
  // Deterministic lock order.
  assert.match(fn, /where id = any\(v_ids\) order by id for update/);
  // Expected yield still computed from the recipe/version, but only as frozen reference metadata
  // (the authoritative finished quantity is the operator's observed count -- see the dedicated test).
  assert.match(fn, /round\(v_batch\.usable_pieces \* p_multiplier\)::integer/);
  // completed_at set once, never overwritten.
  assert.match(fn, /if v_batch\.completed_at is null then\s*update public\.product_batches set completed_at/);

  // Public wrapper is invoker, both layers revoked then narrowly granted.
  assert.match(migration, /create or replace function public\.confirm_bake_v3\([\s\S]*?\) returns jsonb language sql security invoker set search_path = ''/);
  assert.match(migration, /revoke all on function public\.confirm_bake_v3\([^)]*\)\s+from public, anon, authenticated/);
  assert.match(migration, /grant execute on function public\.confirm_bake_v3\([^)]*\) to authenticated/);
});

test("Wave 1 migration: the retired Wave 0B raw-only Bake is no longer callable, its definition kept for history", () => {
  assert.match(migration, /revoke execute on function public\.confirm_bake_v2\(uuid,text,text,numeric,jsonb\) from authenticated/);
  assert.match(migration, /revoke execute on function inventory_private\.confirm_bake_v2\(uuid,text,text,numeric,jsonb\) from authenticated/);
  // Wave 1 must not drop or redefine confirm_bake_v2 (would break the Wave 0B migration's history).
  assert.doesNotMatch(migration, /drop function[^;]*confirm_bake_v2/i);
  assert.doesNotMatch(migration, /create or replace function[^;(]*confirm_bake_v2/i);
});

test("Wave 1 migration: has a preflight guard and no destructive change to Wave 0A/0B objects", () => {
  assert.match(migration, /Wave 1 requires Wave 0B/);
  assert.match(migration, /Wave 1 objects already exist; this migration must not be re-applied/);
  assert.doesNotMatch(migration, /drop table/i);
  assert.doesNotMatch(migration, /alter table public\.ingredients/i);
  assert.doesNotMatch(migration, /alter table public\.inventory_transactions/i);
});
