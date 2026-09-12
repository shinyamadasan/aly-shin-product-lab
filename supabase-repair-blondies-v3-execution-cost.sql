-- Stage B: one-time, guarded correction of frozen_ingredient_cost_total / frozen_cost_per_piece /
-- note for exactly ONE production_execution row (Blondies V3, first real Bake, 2026-09-12), which
-- froze raw cost against uncertified/corrupted legacy ingredient cost baselines before Cost
-- Baseline Repair (Stage A) existed. Full forensic detail: COST_BASELINE_REPAIR_AUDIT_REPORT.md.
--
-- NOT YET RUN. Manual, human-reviewed execution only -- same convention as every other
-- supabase-check-*.sql / supabase-repair-*.sql in this repo (see AGENTS.md's Recovery Rules:
-- guarded preflight, proof not assumption, rollback notes, explicit human review before
-- execution). This is deliberately NOT a migration under supabase/migrations/ -- it targets one
-- specific historical row by literal id, not a repeatable schema change.
--
-- Run ONLY after, in this order:
--   1. supabase/migrations/20260912090000_cost_baseline_repair.sql (Stage A) is applied to the
--      target database.
--   2. Every ingredient this execution's Bake actually deducted from has been owner-certified
--      (cost_reconciled_at is not null) via inventory_private.certify_ingredient_cost_baseline.
--      This script aborts itself, with zero changes, if any ingredient it actually deducted from
--      (read live from the ledger, not hand-typed) is not yet certified.
--
-- Every precondition below is RE-VERIFIED against the live row at run time, not assumed from any
-- prior audit or from this comment. Any failed precondition raises and aborts with ZERO changes --
-- the whole script is one transaction, and every check is a `raise exception` before the single
-- UPDATE at the very end.
--
-- No hand-typed replacement cost anywhere below (not 1240.24, not 726.72, not any of the ten
-- per-ingredient numbers) -- the corrected total is recomputed from the exact deduction quantities
-- this Bake's own ledger rows recorded, times the now-certified average_unit_cost, the identical
-- formula confirm_bake_v3 itself uses.
--
-- Rollback: if this ever needs undoing after a successful run, the original values are preserved
-- verbatim in the row's own `note` column by this same script -- restore
-- frozen_ingredient_cost_total / frozen_cost_per_piece from that note's recorded originals and
-- clear `note` back to null. No other row or table is touched by this script, so no other rollback
-- step is needed.
begin;

do $$
declare
  v_exec_id constant uuid := '91d84608-8f4c-405e-a87b-ec2e4a74ea32';
  v_product_id constant text := 'be801165-6d37-469d-8cd7-ba4d9f545ff6';
  v_batch_id constant uuid := 'a3e62fbc-2b74-4b8f-b9ca-0c8c55b7d4ae';
  v_expected_pieces constant integer := 16;
  v_original_total constant numeric := 1240.2434952507851;
  v_original_per_piece constant numeric := 77.51521845317407;

  v_row public.production_executions%rowtype;
  v_exec_count_for_batch bigint;
  v_receipt_count bigint;
  v_other_movement_count bigint;
  v_allocation_count bigint;
  v_uncertified text;
  v_deduction_count integer;
  v_corrected_total numeric;
  v_corrected_per_piece numeric;
  v_updated_count integer;
  v_note text;
begin
  -- A/B/D/C. Exact execution id, expected product id, expected batch id, expected piece count, and
  -- the original frozen values -- all re-verified together against the live row before anything
  -- else runs.
  select * into v_row from public.production_executions where id = v_exec_id for update;
  if not found then
    raise exception 'ABORT: production_execution % not found -- nothing to repair', v_exec_id;
  end if;
  if v_row.product_id is distinct from v_product_id then
    raise exception 'ABORT: execution % has product_id %, expected % -- refusing to touch a different product''s execution', v_exec_id, v_row.product_id, v_product_id;
  end if;
  if v_row.product_batch_id is distinct from v_batch_id then
    raise exception 'ABORT: execution % has product_batch_id %, expected % -- refusing to touch an unexpected batch', v_exec_id, v_row.product_batch_id, v_batch_id;
  end if;
  if v_row.quantity_produced_pieces is distinct from v_expected_pieces then
    raise exception 'ABORT: execution % has quantity_produced_pieces %, expected % -- this is not the row this script was written for', v_exec_id, v_row.quantity_produced_pieces, v_expected_pieces;
  end if;
  if v_row.frozen_ingredient_cost_total is distinct from v_original_total
     or v_row.frozen_cost_per_piece is distinct from v_original_per_piece then
    raise exception 'ABORT: execution % frozen values no longer match this script''s recorded originals (found total=%, per_piece=%) -- something else already touched this row; do not proceed blind', v_exec_id, v_row.frozen_ingredient_cost_total, v_row.frozen_cost_per_piece;
  end if;

  -- Guard against ambiguous ledger attribution: a Bake's consume rows in inventory_transactions
  -- are keyed by source_id = the BATCH id, not the execution id (Wave 1 does not link consume rows
  -- to a specific execution). If this batch were ever baked more than once, recomputing cost from
  -- "consume rows for this batch" could not safely attribute quantities to just this execution.
  -- Not the case today (this batch has exactly one execution), but checked rather than assumed.
  select count(*) into v_exec_count_for_batch from public.production_executions where product_batch_id = v_batch_id;
  if v_exec_count_for_batch <> 1 then
    raise exception 'ABORT: batch % has % production_executions, expected exactly 1 -- ledger attribution by batch id would be ambiguous', v_batch_id, v_exec_count_for_batch;
  end if;

  -- E. Exactly one production_receipt references this execution.
  select count(*) into v_receipt_count from public.finished_stock_movements
    where production_execution_id = v_exec_id and movement_type = 'production_receipt';
  if v_receipt_count <> 1 then
    raise exception 'ABORT: expected exactly 1 production_receipt for execution %, found %', v_exec_id, v_receipt_count;
  end if;

  -- F. NO other finished_stock_movements reference it -- reserve/release/fulfill/damage/giveaway/
  -- correction, anything at all besides the one production_receipt above.
  select count(*) into v_other_movement_count from public.finished_stock_movements
    where production_execution_id = v_exec_id and movement_type <> 'production_receipt';
  if v_other_movement_count <> 0 then
    raise exception 'ABORT: execution % has % non-production_receipt finished_stock_movements -- these pieces have already been reserved, released, fulfilled, or adjusted; a historical cost repair is not safe here', v_exec_id, v_other_movement_count;
  end if;

  -- G. ZERO order_stock_allocations reference it. Checked directly against this base table, not
  -- against order_raw_cogs -- that view is derived from order_stock_allocations (see the Wave 3
  -- migration's own view definition), so checking it separately adds no independent information
  -- and could silently pass if a future migration ever changes the view's own where-clause.
  select count(*) into v_allocation_count from public.order_stock_allocations
    where production_execution_id = v_exec_id;
  if v_allocation_count <> 0 then
    raise exception 'ABORT: execution % has % order_stock_allocations rows -- an order has already drawn from this lot; a historical cost repair is not safe here', v_exec_id, v_allocation_count;
  end if;

  -- Stage A must be fully certified for every ingredient this Bake actually deducted from, derived
  -- live from the ledger's own consume rows for this batch -- not hand-typed from the audit report.
  select string_agg(distinct ing.name, ', ') into v_uncertified
  from public.inventory_transactions it
  join public.ingredients ing on ing.id = it.ingredient_id
  where it.source_type = 'bake' and it.source_id = v_batch_id::text and it.transaction_type = 'consume'
    and (ing.cost_reconciled_at is null or ing.average_unit_cost is null or ing.average_unit_cost <= 0);
  if v_uncertified is not null then
    raise exception 'ABORT: cost baseline not yet certified for: %. Certify every affected ingredient (Stage A) before running Stage B.', v_uncertified;
  end if;

  select count(*) into v_deduction_count
  from public.inventory_transactions
  where source_type = 'bake' and source_id = v_batch_id::text and transaction_type = 'consume';
  if v_deduction_count = 0 then
    raise exception 'ABORT: no bake consume rows found for batch % -- cannot recompute a corrected cost from nothing', v_batch_id;
  end if;

  -- Recompute the corrected cost from the EXACT deduction quantities this Bake actually consumed
  -- (this batch's own consume rows), times the now-certified current average_unit_cost -- the
  -- identical formula confirm_bake_v3 itself uses when it freezes cost at Bake time.
  select sum(abs(it.quantity_change) * ing.average_unit_cost) into v_corrected_total
  from public.inventory_transactions it
  join public.ingredients ing on ing.id = it.ingredient_id
  where it.source_type = 'bake' and it.source_id = v_batch_id::text and it.transaction_type = 'consume';

  if v_corrected_total is null then
    raise exception 'ABORT: corrected cost computed as null -- refusing to write an invalid value';
  end if;

  v_corrected_per_piece := v_corrected_total / v_row.quantity_produced_pieces;

  v_note := format(
    'Cost Baseline Repair: frozen raw cost corrected on %s. Original frozen_ingredient_cost_total=%s, frozen_cost_per_piece=%s (derived from uncertified/missing legacy ingredient cost baselines, before cost certification existed). Corrected using this Bake''s own deduction quantities and the now-certified average_unit_cost values. See COST_BASELINE_REPAIR_AUDIT_REPORT.md.',
    to_char(clock_timestamp(), 'YYYY-MM-DD"T"HH24:MI:SSOF'), v_original_total, v_original_per_piece
  );

  update public.production_executions
    set frozen_ingredient_cost_total = v_corrected_total,
        frozen_cost_per_piece = v_corrected_per_piece,
        note = v_note
    where id = v_exec_id
      and product_id = v_product_id
      and quantity_produced_pieces = v_expected_pieces
      and frozen_ingredient_cost_total = v_original_total
      and frozen_cost_per_piece = v_original_per_piece;
  get diagnostics v_updated_count = row_count;
  if v_updated_count <> 1 then
    raise exception 'ABORT: guarded UPDATE affected % rows, expected exactly 1 -- the row changed between the checks above and this statement; nothing was applied', v_updated_count;
  end if;

  raise notice 'Stage B repair applied: execution % corrected total=% corrected per_piece=%', v_exec_id, v_corrected_total, v_corrected_per_piece;
end;
$$;

commit;
