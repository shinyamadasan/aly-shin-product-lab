-- Claude Inventory Operator V1A: one owner-only, atomic, idempotent physical-count batch.
-- This is a wrapper around inventory_private.apply_raw_inventory_adjustment, not a second
-- inventory authority. Every per-ingredient rule (stale guards, reconciliation snapshot,
-- nonnegative balance, ledger truth, and cost-certification effect) remains owned there.
--
-- Rollback: revoke/drop the public wrapper, then revoke/drop the private batch function. Existing
-- inventory transactions and mutation receipts are authoritative history and must not be deleted.
do $$
begin
  if to_regprocedure('inventory_private.claim_mutation(uuid,text,text)') is null
     or to_regprocedure('inventory_private.apply_raw_inventory_adjustment(uuid,numeric,text,text,text,numeric,uuid,text,uuid)') is null
     or to_regclass('inventory_private.mutation_receipts') is null then
    raise exception 'Inventory Operator V1A requires current Wave 0B inventory authority';
  end if;
end;
$$;

create or replace function inventory_private.apply_inventory_physical_count_batch(
  p_operation_id uuid,
  p_payload_hash text,
  p_rows jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_claim jsonb;
  v_result jsonb;
  v_results jsonb := '[]'::jsonb;
  v_row jsonb;
  v_transaction_id uuid;
  v_ingredient public.ingredients%rowtype;
  v_transaction public.inventory_transactions%rowtype;
  v_ingredient_id uuid;
  v_counted_quantity numeric;
  v_expected_quantity numeric;
  v_expected_latest_id uuid;
  v_expected_unit text;
  v_note text;
begin
  if auth.uid() is null or public.is_product_lab_owner() is not true then
    raise exception 'Only the product lab owner may apply a physical-count batch' using errcode = '42501';
  end if;
  if p_operation_id is null or p_payload_hash is null or length(trim(p_payload_hash)) <> 64
     or p_payload_hash !~ '^[0-9a-f]{64}$'
     or p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception 'Operation id, SHA-256 payload hash, and at least one count row are required' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_rows) as row
    group by (row->>'ingredient_id')::uuid having count(*) > 1
  ) then
    raise exception 'A physical-count batch cannot contain duplicate ingredients' using errcode = '23514';
  end if;

  v_claim := inventory_private.claim_mutation(p_operation_id, 'physical_count', p_payload_hash);
  if v_claim is not null then
    return v_claim;
  end if;

  -- UUID order is the global lock order for every batch. Overlapping concurrent batches therefore
  -- serialize without choosing different ingredient lock orders.
  for v_row in
    select value from jsonb_array_elements(p_rows) order by (value->>'ingredient_id')::uuid
  loop
    begin
      v_ingredient_id := (v_row->>'ingredient_id')::uuid;
      v_counted_quantity := (v_row->>'counted_quantity')::numeric;
      v_expected_quantity := (v_row->>'expected_quantity')::numeric;
      v_expected_latest_id := nullif(v_row->>'expected_latest_id', '')::uuid;
      v_expected_unit := v_row->>'expected_unit';
      v_note := trim(v_row->>'note');
    exception when invalid_text_representation or numeric_value_out_of_range then
      raise exception 'Every physical-count row requires valid typed values' using errcode = '22023';
    end;
    if v_ingredient_id is null or v_counted_quantity is null or v_expected_quantity is null
       or v_expected_unit is null or v_note is null or length(v_note) = 0
       or v_counted_quantity::text in ('NaN', 'Infinity', '-Infinity') then
      raise exception 'Every physical-count row requires ingredient, count, stale guards, unit, and note' using errcode = '22023';
    end if;

    v_transaction_id := inventory_private.apply_raw_inventory_adjustment(
      v_ingredient_id,
      v_counted_quantity,
      'count',
      null,
      v_note,
      v_expected_quantity,
      v_expected_latest_id,
      v_expected_unit,
      null
    );

    select * into strict v_ingredient from public.ingredients where id = v_ingredient_id;
    select * into strict v_transaction from public.inventory_transactions where id = v_transaction_id;
    v_results := v_results || jsonb_build_array(jsonb_build_object(
      'ingredient_id', v_ingredient.id,
      'ingredient_name', v_ingredient.name,
      'base_unit', v_ingredient.base_unit,
      'quantity_before', v_transaction.quantity_before,
      'quantity_after', v_transaction.quantity_after,
      'quantity_change', v_transaction.quantity_change,
      'transaction_id', v_transaction.id,
      'inventory_reconciled_at', v_ingredient.inventory_reconciled_at,
      'cost_reconciled_at', v_ingredient.cost_reconciled_at
    ));
  end loop;

  v_result := jsonb_build_object(
    'operation_id', p_operation_id,
    'payload_hash', p_payload_hash,
    'applied_reconciliation_events', jsonb_array_length(v_results),
    'rows', v_results
  );
  update inventory_private.mutation_receipts set result = v_result where operation_id = p_operation_id;
  return v_result;
end;
$$;
revoke all on function inventory_private.apply_inventory_physical_count_batch(uuid,text,jsonb)
  from public, anon, authenticated;
grant execute on function inventory_private.apply_inventory_physical_count_batch(uuid,text,jsonb)
  to authenticated;

create or replace function public.apply_inventory_physical_count_batch(
  p_operation_id uuid,
  p_payload_hash text,
  p_rows jsonb
) returns jsonb language sql security invoker set search_path = '' as $$
  select inventory_private.apply_inventory_physical_count_batch(p_operation_id, p_payload_hash, p_rows);
$$;
revoke all on function public.apply_inventory_physical_count_batch(uuid,text,jsonb)
  from public, anon, authenticated;
grant execute on function public.apply_inventory_physical_count_batch(uuid,text,jsonb) to authenticated;

notify pgrst, 'reload schema';
