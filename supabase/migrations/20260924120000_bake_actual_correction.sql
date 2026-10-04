-- TASK-072: Safe Bake actual-count correction ("Correct Bake").
--
-- Fixes exactly one operator mistake: the operator physically produced N usable pieces but typed a
-- different ACTUAL count when confirming the Bake. It does NOT edit recipes, expected yield,
-- timestamps, ingredient deductions, or the frozen raw-cost total, and it does NOT touch
-- opening-balance lots. Three situations stay distinct:
--   1. Recipe expected yield was wrong      -> a recipe/version issue; no historical Bake is rewritten.
--   2. Actual genuinely differed from Expected (e.g. only 10 of 12 were sellable) -> correct
--      historical data; nothing to fix.
--   3. Operator typed the wrong Actual      -> this migration.
--
-- MODEL (smallest robust design):
--   - production_executions stays the effective lot record. quantity_produced_pieces and
--     frozen_cost_per_piece are the two EFFECTIVE fields a correction updates; expected_pieces,
--     frozen_ingredient_cost_total, multiplier, completed_at, product/batch/version never change.
--   - One append-only audit row per correction in production_execution_corrections preserves the
--     previous value, the corrected value, the delta, the reason, the previous/corrected cost per
--     piece, the actor, and the operation id. The original Bake stays identifiable: its first
--     previous_actual is what was originally recorded.
--   - The finished-stock ledger gets one new append-only movement, 'bake_correction', tied to the
--     same production execution. The original 'production_receipt' is never rewritten or deleted.
--     Invariant: quantity_produced_pieces = SUM(on_hand_delta) over that execution's
--     'production_receipt' + 'bake_correction' movements; the function refuses to run if that is
--     ever not true rather than guess.
--   - 'bake_correction' is deliberately NOT one of damage/giveaway/correction. Wave 3's rule that
--     arbitrary "found more stock" positive corrections are prohibited is untouched
--     (finished_stock_movements_exception_shape and record_finished_stock_exception are not
--     modified). This increase has a trustworthy cost basis because it belongs to an existing Bake
--     whose frozen raw-cost TOTAL is unchanged: cost per piece is recomputed as total / new actual,
--     so fulfilled COGS attributed to the lot can never exceed what the Bake actually cost.
--
-- SALES / COGS IMPACT: order_raw_cogs derives live from order_stock_allocations x
-- production_executions.frozen_cost_per_piece, so a correction retroactively restates the raw cost
-- per piece of already-fulfilled pieces from that lot to the true corrected yield. No allocation,
-- reservation or movement of any order is touched, no COGS is stored anywhere, and
-- (fulfilled + reserved) x corrected cost per piece <= frozen total always holds because a
-- downward correction is refused unless the lot still has enough unreserved on-hand pieces.
--
-- DECREASE SAFETY: NEW < OLD is allowed only if the lot's own unreserved on-hand
-- (SUM(on_hand_delta) - SUM(reserved_delta) for that execution) covers the reduction, i.e. the
-- corrected produced quantity is still >= pieces already fulfilled, reserved, damaged, given away
-- or removed by a count correction from that same lot. Otherwise the whole call is rejected before
-- anything is written.
--
-- AUTHORITY: same shape as every prior wave -- a private security-definer function (fixed empty
-- search_path, owner-only) behind a narrowly granted security-invoker public wrapper. The new
-- table is owner-SELECT-only with no write path for any client role; no UPDATE grant on
-- production_executions is added. Idempotent via inventory_private.claim_mutation (same
-- operation id + same payload replays the stored result; same id + changed payload is rejected).
-- Concurrency: the same products-row anchor and (completed_at, id) lot lock order Wave 2/3 use,
-- plus an expected-current-actual stale guard so two tabs cannot silently overwrite each other.
--
-- ROLLBACK (additive migration): drop function public.correct_bake_actual_pieces(uuid,uuid,integer,numeric,text);
-- drop function inventory_private.correct_bake_actual_pieces(uuid,uuid,integer,numeric,text);
-- then, only if no correction has ever been recorded (select count(*) from
-- public.production_execution_corrections = 0), drop table public.production_execution_corrections
-- and restore finished_stock_movements_movement_type_check without 'bake_correction'. If
-- corrections exist, do NOT drop: production_executions.quantity_produced_pieces would no longer
-- match the original receipts without them.
--
-- NOT APPLIED. Leave unapplied until independent review. Integration tests run against disposable
-- Postgres containers only (tests/smoke/postgres/bake-actual-correction.smoke.test.ts).
do $$
begin
  if to_regprocedure('inventory_private.record_finished_stock_exception(uuid,text,text,numeric,uuid,text)') is null
     or to_regprocedure('inventory_private.claim_mutation(uuid,text,text)') is null then
    raise exception 'Bake actual correction requires Wave 0B (claim_mutation) and Wave 3 (record_finished_stock_exception)';
  end if;
  if to_regclass('public.production_executions') is null
     or to_regclass('public.finished_stock_movements') is null then
    raise exception 'Bake actual correction requires Wave 1''s production_executions and finished_stock_movements';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'production_executions' and column_name = 'source_type'
  ) then
    raise exception 'Bake actual correction requires Finished Stock Opening Balance (production_executions.source_type)';
  end if;
  if to_regclass('public.production_execution_corrections') is not null then
    raise exception 'Bake actual correction objects already exist; this migration must not be re-applied over itself';
  end if;
end;
$$;

-- ============================================================================================
-- 1. Audit table. Append-only: owner SELECT only, no client write path. The definer function is
-- the only writer and only ever inserts.
-- ============================================================================================
create table public.production_execution_corrections (
  id uuid primary key default gen_random_uuid(),
  production_execution_id uuid not null references public.production_executions(id) on delete restrict,
  operation_id uuid not null unique,
  previous_actual integer not null check (previous_actual > 0),
  corrected_actual integer not null check (corrected_actual > 0),
  delta integer not null check (delta <> 0 and delta = corrected_actual - previous_actual),
  reason text not null check (length(trim(reason)) > 0),
  frozen_ingredient_cost_total numeric not null check (frozen_ingredient_cost_total >= 0),
  previous_cost_per_piece numeric not null check (previous_cost_per_piece >= 0),
  corrected_cost_per_piece numeric not null check (corrected_cost_per_piece >= 0),
  finished_stock_movement_id uuid not null references public.finished_stock_movements(id),
  actor uuid not null,
  corrected_at timestamptz not null
);
create index production_execution_corrections_execution_idx
  on public.production_execution_corrections (production_execution_id, corrected_at);

comment on table public.production_execution_corrections is
  'Append-only audit of Correct Bake events: one row per correction of a real Bake''s ACTUAL usable-piece count. Preserves previous/corrected actual, delta, reason, cost per piece before/after, the unchanged frozen raw-cost total, the actor, and the operation id. Written only by inventory_private.correct_bake_actual_pieces.';

alter table public.production_execution_corrections enable row level security;
revoke all on public.production_execution_corrections from public, anon, authenticated;
grant select on public.production_execution_corrections to authenticated;
create policy "task072 owner reads production execution corrections" on public.production_execution_corrections
  for select to authenticated using (public.is_product_lab_owner());

-- ============================================================================================
-- 2. Ledger: one new movement type, with its own shape check. It is a signed on-hand change tied
-- to a specific production execution and never touches reserved or any order linkage. Existing
-- constraints (production_receipt shape, order movement shape, exception shape) are untouched --
-- in particular the exception shape's negative-only rule for damage/giveaway/correction.
-- ============================================================================================
alter table public.finished_stock_movements
  drop constraint finished_stock_movements_movement_type_check;
alter table public.finished_stock_movements
  add constraint finished_stock_movements_movement_type_check check (
    movement_type in ('production_receipt', 'reserve', 'release', 'fulfill', 'damage', 'giveaway', 'correction', 'bake_correction')
  );

alter table public.finished_stock_movements
  add constraint finished_stock_movements_bake_correction_shape check (
    movement_type <> 'bake_correction'
    or (
      order_id is null
      and order_stock_allocation_id is null
      and reserved_delta = 0
      and production_execution_id is not null
      and on_hand_delta <> 0
    )
  );

comment on constraint finished_stock_movements_bake_correction_shape on public.finished_stock_movements is
  'bake_correction: signed on-hand adjustment of ONE production execution''s produced quantity, written only by correct_bake_actual_pieces. Never order-linked, never touches reserved. Distinct from damage/giveaway/correction (physical losses) so a corrected Bake is never confused with a physical-count correction.';

comment on column public.production_executions.quantity_produced_pieces is
  'Effective actual usable pieces for this lot. Equals the original receipt plus any bake_correction movements; changed only by correct_bake_actual_pieces (audited in production_execution_corrections). Never edited by a recipe change.';
comment on column public.production_executions.frozen_cost_per_piece is
  'frozen_ingredient_cost_total / quantity_produced_pieces. The total is frozen at Bake time; this per-piece value is recomputed only by correct_bake_actual_pieces when the actual count is corrected (audited in production_execution_corrections).';

-- ============================================================================================
-- 3. correct_bake_actual_pieces -- the single writer. One transaction:
--   auth -> validate inputs -> claim operation identity -> lock the products row (the anchor
--   every wave uses) -> lock every lot of that product in (completed_at, id) order -> re-read the
--   target lot -> real-Bake only -> stale guard on the recorded actual -> ledger-consistency check
--   -> decrease safety -> update the lot's effective actual + cost per piece -> append the
--   bake_correction movement -> append the audit row -> store the receipt.
-- Any failure rolls back everything; the operation id stays retryable.
-- ============================================================================================
create or replace function inventory_private.correct_bake_actual_pieces(
  p_operation_id uuid, p_production_execution_id uuid, p_expected_current_actual integer,
  p_corrected_actual numeric, p_reason text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_hash text; v_replay jsonb; v_now timestamptz := clock_timestamp();
  v_product_id text;
  v_exec public.production_executions%rowtype;
  v_reason text; v_new integer; v_delta integer;
  v_on_hand integer; v_reserved integer; v_ledger_produced integer; v_removable integer;
  v_old_cpp numeric; v_new_cpp numeric;
  v_fsm_id uuid; v_correction_id uuid; v_result jsonb;
begin
  if auth.uid() is null or public.is_product_lab_owner() is not true then
    raise exception 'Only the product lab owner may correct a Bake' using errcode = '42501';
  end if;
  if p_production_execution_id is null then
    raise exception 'A Bake is required' using errcode = '22023';
  end if;
  if p_expected_current_actual is null or p_expected_current_actual < 1 then
    raise exception 'The currently recorded actual count is required' using errcode = '22023';
  end if;
  if p_corrected_actual is null then
    raise exception 'Enter the corrected actual usable pieces' using errcode = '22023';
  end if;
  if p_corrected_actual::text = any(array['NaN','Infinity','-Infinity'])
     or p_corrected_actual <> trunc(p_corrected_actual)
     or p_corrected_actual < 1 or p_corrected_actual > 1000000 then
    raise exception 'Corrected actual usable pieces must be a whole number of at least 1' using errcode = '22023';
  end if;
  v_reason := nullif(trim(coalesce(p_reason, '')), '');
  if v_reason is null then
    raise exception 'A reason for the correction is required' using errcode = '22023';
  end if;
  v_new := p_corrected_actual::integer;

  v_hash := md5(concat_ws('|', p_production_execution_id::text, p_expected_current_actual::text,
    v_new::text, v_reason));
  v_replay := inventory_private.claim_mutation(p_operation_id, 'bake_actual_correction', v_hash);
  if v_replay is not null then return v_replay; end if;

  -- product_id is immutable, so reading it before the locks is safe; it only tells us which
  -- product's anchor and lots to lock.
  select product_id into v_product_id from public.production_executions where id = p_production_execution_id;
  if not found then
    raise exception 'Bake not found' using errcode = '22023';
  end if;

  perform id from public.products where id = v_product_id for update;
  perform pe.id from public.production_executions pe
    where pe.product_id = v_product_id order by pe.completed_at, pe.id for update;

  select * into v_exec from public.production_executions where id = p_production_execution_id;

  if v_exec.source_type <> 'bake' then
    raise exception 'Only a real Bake can be corrected here. Opening-balance stock is not a Bake.' using errcode = '23514';
  end if;
  if v_exec.quantity_produced_pieces <> p_expected_current_actual then
    raise exception 'This Bake was changed since you opened it (now recorded as % pieces). Reload and try again.', v_exec.quantity_produced_pieces using errcode = '40001';
  end if;
  if v_new = v_exec.quantity_produced_pieces then
    raise exception 'The corrected count is the same as the recorded count (% pieces). Nothing to correct.', v_new using errcode = '22023';
  end if;

  select coalesce(sum(on_hand_delta), 0), coalesce(sum(reserved_delta), 0),
         coalesce(sum(on_hand_delta) filter (where movement_type in ('production_receipt', 'bake_correction')), 0)
    into v_on_hand, v_reserved, v_ledger_produced
    from public.finished_stock_movements where production_execution_id = v_exec.id;

  if v_ledger_produced <> v_exec.quantity_produced_pieces then
    raise exception 'This Bake''s recorded pieces (%) do not match its stock ledger (%). It cannot be corrected automatically; investigate first.', v_exec.quantity_produced_pieces, v_ledger_produced using errcode = '23514';
  end if;

  v_delta := v_new - v_exec.quantity_produced_pieces;

  if v_delta < 0 then
    -- Pieces from this lot that can still be taken away: on hand and not reserved. Everything
    -- else is already sold, reserved for a customer, damaged, given away, or removed by a count.
    v_removable := v_on_hand - v_reserved;
    if v_removable < -v_delta then
      raise exception 'Cannot lower this Bake from % to % pieces: only % of its pieces are still unreserved and on hand (the rest are sold, reserved, damaged, or given away).', v_exec.quantity_produced_pieces, v_new, greatest(v_removable, 0) using errcode = '23514';
    end if;
  end if;

  v_old_cpp := v_exec.frozen_cost_per_piece;
  v_new_cpp := v_exec.frozen_ingredient_cost_total / v_new;

  update public.production_executions
    set quantity_produced_pieces = v_new, frozen_cost_per_piece = v_new_cpp
    where id = v_exec.id;

  insert into public.finished_stock_movements (product_id, production_execution_id, movement_type,
    on_hand_delta, reserved_delta, operation_id, note)
  values (v_exec.product_id, v_exec.id, 'bake_correction', v_delta, 0, p_operation_id,
    format('Bake correction: %s -> %s pcs (%s)', v_exec.quantity_produced_pieces, v_new, v_reason))
  returning id into v_fsm_id;

  insert into public.production_execution_corrections (production_execution_id, operation_id,
    previous_actual, corrected_actual, delta, reason, frozen_ingredient_cost_total,
    previous_cost_per_piece, corrected_cost_per_piece, finished_stock_movement_id, actor, corrected_at)
  values (v_exec.id, p_operation_id, v_exec.quantity_produced_pieces, v_new, v_delta, v_reason,
    v_exec.frozen_ingredient_cost_total, v_old_cpp, v_new_cpp, v_fsm_id, auth.uid(), v_now)
  returning id into v_correction_id;

  v_result := jsonb_build_object(
    'production_execution_id', v_exec.id, 'product_id', v_exec.product_id,
    'correction_id', v_correction_id, 'finished_stock_movement_id', v_fsm_id,
    'previous_actual', v_exec.quantity_produced_pieces, 'corrected_actual', v_new, 'delta', v_delta,
    'expected_pieces', v_exec.expected_pieces,
    'frozen_ingredient_cost_total', v_exec.frozen_ingredient_cost_total,
    'previous_cost_per_piece', v_old_cpp, 'corrected_cost_per_piece', v_new_cpp);
  update inventory_private.mutation_receipts set result = v_result where operation_id = p_operation_id;
  return v_result;
end;
$$;
revoke all on function inventory_private.correct_bake_actual_pieces(uuid,uuid,integer,numeric,text)
  from public, anon, authenticated;
grant execute on function inventory_private.correct_bake_actual_pieces(uuid,uuid,integer,numeric,text) to authenticated;

create or replace function public.correct_bake_actual_pieces(
  p_operation_id uuid, p_production_execution_id uuid, p_expected_current_actual integer,
  p_corrected_actual numeric, p_reason text
) returns jsonb language sql security invoker set search_path = '' as $$
  select inventory_private.correct_bake_actual_pieces(p_operation_id, p_production_execution_id,
    p_expected_current_actual, p_corrected_actual, p_reason);
$$;
revoke all on function public.correct_bake_actual_pieces(uuid,uuid,integer,numeric,text)
  from public, anon, authenticated;
grant execute on function public.correct_bake_actual_pieces(uuid,uuid,integer,numeric,text) to authenticated;

notify pgrst, 'reload schema';
