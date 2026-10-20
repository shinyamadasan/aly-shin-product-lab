-- Restore the approved Wave 0A reversal boundary on the latest V4 authority.
-- No rows are changed. Preserve the current V4 body, signature, grants and cost-trust rules;
-- the only behavioral change is rejection of adjustments superseded by a physical count.
-- Recovery: repair forward. Do not reinstall an older body or remove the boundary guard;
-- either would discard V4 behavior or reopen the verified-count defect. Investigate any
-- historical invalid reversals separately; this migration never infers corrected balances.

do $$
begin
  if to_regprocedure('inventory_private.apply_raw_inventory_adjustment(uuid,numeric,text,text,text,numeric,uuid,text,uuid)') is null
     or to_regprocedure('public.apply_raw_inventory_adjustment(uuid,numeric,text,text,text,numeric,uuid,text,uuid)') is null then
    raise exception 'Reversal boundary restore requires the existing raw adjustment authority';
  end if;
  if position('p_mode in (''count'', ''delta'') and v_delta > 0' in
       pg_get_functiondef('inventory_private.apply_raw_inventory_adjustment(uuid,numeric,text,text,text,numeric,uuid,text,uuid)'::regprocedure)) = 0 then
    raise exception 'Reversal boundary restore requires the V4 cost-trust adjustment authority';
  end if;
end;
$$;

create or replace function inventory_private.apply_raw_inventory_adjustment(
  p_ingredient_id uuid, p_quantity numeric, p_mode text, p_reason text, p_note text,
  p_expected_quantity numeric, p_expected_latest_id uuid, p_expected_unit text,
  p_reverse_id uuid default null
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  i public.ingredients%rowtype;
  latest public.inventory_transactions%rowtype;
  original public.inventory_transactions%rowtype;
  v_after numeric;
  v_delta numeric;
  v_snapshot jsonb;
  v_id uuid;
  v_time timestamptz;
begin
  if auth.uid() is null or public.is_product_lab_owner() is not true then
    raise exception 'Only the product lab owner may adjust inventory' using errcode = '42501';
  end if;
  if p_mode is null or p_mode not in ('count', 'delta', 'reverse')
     or p_note is null or length(trim(p_note)) = 0 then
    raise exception 'Adjustment mode and a reason note are required' using errcode = '22023';
  end if;
  select * into i from public.ingredients where id = p_ingredient_id for update;
  if not found then raise exception 'Ingredient not found'; end if;
  select * into latest from public.inventory_transactions where ingredient_id = i.id
    order by created_at desc, id desc limit 1;
  if i.current_quantity is distinct from p_expected_quantity or latest.id is distinct from p_expected_latest_id
     or i.base_unit is distinct from p_expected_unit then
    raise exception 'Inventory changed. Reload and verify the count again.' using errcode = '40001';
  end if;
  if p_mode <> 'count' and i.inventory_reconciled_at is null then
    raise exception 'Record a verified physical count before adjusting this ingredient';
  end if;
  if p_mode = 'reverse' then
    select * into original from public.inventory_transactions where id = p_reverse_id;
    if not found or original.ingredient_id <> i.id or original.transaction_type <> 'adjustment'
       or original.source_type <> 'manual' or original.source_id is not null
       or original.reconciliation_snapshot is not null then
      raise exception 'Only an ordinary adjustment can be reversed';
    end if;
    if original.created_at <= i.inventory_reconciled_at then
      raise exception 'This adjustment cannot be reversed because a later physical reconciliation superseded it.' using errcode = '23514';
    end if;
    v_delta := -original.quantity_change;
    p_reason := original.reason;
  else
    if p_reverse_id is not null or p_quantity is null
       or p_quantity::text in ('NaN', 'Infinity', '-Infinity') then
      raise exception 'A finite quantity is required' using errcode = '22023';
    end if;
    if p_mode = 'count' then
      if p_quantity < 0 then raise exception 'Physical quantity cannot be negative'; end if;
      p_reason := 'stock_count_correction';
      v_delta := p_quantity - i.current_quantity;
      v_snapshot := jsonb_build_object('cache_quantity', i.current_quantity,
        'latest_ledger_quantity', latest.quantity_after, 'latest_ledger_id', latest.id,
        'base_unit', i.base_unit, 'average_unit_cost', i.average_unit_cost,
        'previous_reconciled_at', i.inventory_reconciled_at, 'verified_quantity', p_quantity);
    else
      if p_quantity = 0 or p_reason is null or p_reason not in
        ('household_use', 'waste_or_spoilage', 'recipe_testing', 'spillage', 'other') then
        raise exception 'Choose an adjustment reason; use a verified count for count corrections';
      end if;
      v_delta := p_quantity;
    end if;
  end if;
  v_after := i.current_quantity + v_delta;
  if v_after < 0 or v_after::text in ('NaN', 'Infinity', '-Infinity') then
    raise exception 'Adjustment would produce an invalid or negative stock balance';
  end if;
  v_time := clock_timestamp();
  insert into public.inventory_transactions (ingredient_id, transaction_type, quantity_change,
    quantity_before, quantity_after, source_type, source_id, reason, actor, note,
    created_at, reconciliation_snapshot)
  values (i.id, 'adjustment', v_delta, i.current_quantity, v_after, 'manual', p_reverse_id::text,
    p_reason, auth.uid()::text, trim(p_note), v_time, v_snapshot) returning id into v_id;
  -- Cost trust (V4). Stock that no priced purchase backs has no evidenced cost, so trust is
  -- cleared (cost_reconciled_at -> null; average_unit_cost itself is left untouched) whenever the
  -- balance goes UP by a count or an ordinary adjustment: a count that found more than the ledger
  -- explains (Cost Baseline Repair) and, new in V4, an "Increase stock" adjustment (mode = 'delta',
  -- v_delta > 0) -- which previously slipped past this rule and left the old per-unit price
  -- asserted over stock nothing priced. Every other case leaves trust exactly as it was: a
  -- decrease, an exact-match recount, and mode = 'reverse' (which only undoes an earlier ordinary
  -- adjustment, so it can only put back units that were already part of the counted stock).
  update public.ingredients set current_quantity = v_after, updated_at = v_time,
    inventory_reconciled_at = case when p_mode = 'count' then v_time else inventory_reconciled_at end,
    cost_reconciled_at = case when p_mode in ('count', 'delta') and v_delta > 0 then null else cost_reconciled_at end
    where id = i.id;
  return v_id;
end;
$$;
notify pgrst, 'reload schema';
