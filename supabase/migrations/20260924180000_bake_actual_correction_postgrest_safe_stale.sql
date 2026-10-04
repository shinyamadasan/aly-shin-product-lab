-- TASK-072A: PostgREST-14-safe stale guard for Correct Bake.
--
-- Production PostgREST is 14.x. Supabase documents that an RPC raising SQLSTATE 40001
-- (serialization_failure) can make PostgREST 14 retry the whole transaction repeatedly. TASK-072's
-- stale expected-current-actual guard raised exactly that. This migration replaces ONLY that one
-- raise with SQLSTATE PT409, which PostgREST surfaces as HTTP 409 with code "PT409" and never retries.
--
-- Nothing else changes: the function below is the 20260924120000 definition verbatim except that
-- single statement (security definer, search_path = '', owner auth, claim_mutation, lock order,
-- ledger-consistency check, decrease safety, writes and audit are all identical). The public
-- invoker wrapper and every grant are untouched; create or replace keeps the existing ACL, and the
-- revoke/grant below restates the same convention idempotently. The already-applied migration file
-- is NOT edited.
--
-- ROLLBACK: re-run the function definition from 20260924120000_bake_actual_correction.sql (restores
-- the 40001 raise -- not recommended on PostgREST 14).
--
-- NOT APPLIED. Leave unapplied until review.
do $$
begin
  if to_regprocedure('inventory_private.correct_bake_actual_pieces(uuid,uuid,integer,numeric,text)') is null
     or to_regprocedure('public.correct_bake_actual_pieces(uuid,uuid,integer,numeric,text)') is null
     or to_regclass('public.production_execution_corrections') is null then
    raise exception 'TASK-072A requires the TASK-072 migration (20260924120000_bake_actual_correction.sql) to be applied first';
  end if;
end;
$$;

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
    raise sqlstate 'PT409' using message = format('This Bake was changed since you opened it (now recorded as %s pieces). Reload and try again.', v_exec.quantity_produced_pieces);
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

notify pgrst, 'reload schema';
