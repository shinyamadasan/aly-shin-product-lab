-- Wave 0A only. No balances are reconciled by this migration.
-- Rollback: pause inventory writes and repair forward. Do not restore legacy grants after
-- verified counts exist. Historical rows and the old RPC bodies are retained, not dropped.
-- Deployment preflight: requires the existing owner-role architecture and raw inventory.
do $$
begin
  if to_regprocedure('public.is_product_lab_owner()') is null
     or to_regclass('public.inventory_transactions') is null then
    raise exception 'Wave 0A requires owner authorization and existing raw inventory';
  end if;
end;
$$;

alter table public.ingredients add column if not exists inventory_reconciled_at timestamptz;
alter table public.inventory_transactions
  add column if not exists reason text,
  add column if not exists actor text,
  add column if not exists reconciliation_snapshot jsonb;

-- Preserve existing rows, including discrepancies. Only new adjustments use this index.
create unique index if not exists inventory_adjustment_reversal_once_idx
  on public.inventory_transactions (source_id)
  where transaction_type = 'adjustment' and source_type = 'manual' and source_id is not null;

create schema if not exists inventory_private;
revoke all on schema inventory_private from public, anon, authenticated;
grant usage on schema inventory_private to authenticated;

-- Ordinary clients can read inventory and edit metadata, but cannot write its caches/history.
revoke all on public.ingredients, public.inventory_transactions from public, anon, authenticated;
-- Table-level REVOKE does not remove explicit historical column grants.
do $$
declare t text; cols text;
begin
  foreach t in array array['ingredients','inventory_transactions','supply_entries'] loop
    select string_agg(quote_ident(attname), ',') into cols from pg_attribute
      where attrelid = ('public.' || t)::regclass and attnum > 0 and not attisdropped;
    execute format('revoke insert (%s), update (%s), references (%s) on public.%I from public, anon, authenticated', cols, cols, cols, t);
  end loop;
end;
$$;
grant select on public.ingredients, public.inventory_transactions to authenticated;
grant insert (id, name, base_unit, category, low_stock_threshold, target_stock_quantity,
  nearest_expiration_date, notes, is_active, archived_at) on public.ingredients to authenticated;
grant update (name, base_unit, category, low_stock_threshold, target_stock_quantity,
  nearest_expiration_date, notes, is_active, archived_at) on public.ingredients to authenticated;

-- These invoker functions accept absolute balances or amend/delete ledger history. Keep their
-- definitions for inspection, but close every overload until Wave 0B replaces their contracts.
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as signature
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in
      ('confirm_bake', 'confirm_purchase_import', 'save_supply_with_inventory_effect',
       'delete_supply_with_inventory_effect', 'repair_supply_inventory_effects', 'apply_inventory_adjustment')
  loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', f.signature);
  end loop;
end;
$$;

-- Source purchase history cannot be rewritten independently of the now-protected ledger.
-- Draft imports remain editable; posting is unavailable until Wave 0B.
revoke insert, update, delete, truncate, trigger, references on public.supply_entries
  from public, anon, authenticated;
revoke truncate, trigger, references on public.purchase_imports, public.purchase_import_rows
  from public, anon, authenticated;

create or replace function inventory_private.protect_base_unit()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.base_unit is distinct from old.base_unit and
     (old.inventory_reconciled_at is not null or exists
       (select 1 from public.inventory_transactions where ingredient_id = old.id)) then
    raise exception 'Base unit cannot change after inventory history exists' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function inventory_private.protect_base_unit() from public, anon, authenticated;
create trigger raw_inventory_base_unit_guard before update of base_unit on public.ingredients
  for each row execute function inventory_private.protect_base_unit();

create or replace function inventory_private.protect_posted_import()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_status text;
begin
  if tg_table_name = 'purchase_imports' then
    if tg_op <> 'INSERT' and (old.status = 'confirmed' or exists
      (select 1 from public.inventory_transactions where source_type = 'purchase_import' and source_id = old.id::text)) then
      raise exception 'Posted purchase history is read-only';
    end if;
    if tg_op <> 'DELETE' and new.status = 'confirmed' then
      raise exception 'Purchase posting is unavailable until Wave 0B';
    end if;
  else
    if tg_op <> 'INSERT' then
      select status into v_status from public.purchase_imports where id = old.import_id for update;
      if v_status = 'confirmed' or exists (select 1 from public.inventory_transactions
        where source_type = 'purchase_import' and source_id = old.import_id::text) then
        raise exception 'Posted purchase history is read-only'; end if;
    end if;
    if tg_op <> 'DELETE' then
      select status into v_status from public.purchase_imports where id = new.import_id for update;
      if v_status = 'confirmed' or exists (select 1 from public.inventory_transactions
        where source_type = 'purchase_import' and source_id = new.import_id::text) then
        raise exception 'Posted purchase history is read-only'; end if;
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
revoke all on function inventory_private.protect_posted_import() from public, anon, authenticated;
create trigger raw_inventory_import_guard before insert or update or delete on public.purchase_imports
  for each row execute function inventory_private.protect_posted_import();
create trigger raw_inventory_import_row_guard before insert or update or delete on public.purchase_import_rows
  for each row execute function inventory_private.protect_posted_import();

-- One narrowly authorized inventory operation. There is no client-supplied ending balance,
-- cost, actor, timestamp, or history payload. A row lock is necessary for a coherent adjustment;
-- the broad purchase/Bake concurrency and idempotency redesign is deliberately deferred.
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
  update public.ingredients set current_quantity = v_after, updated_at = v_time,
    inventory_reconciled_at = case when p_mode = 'count' then v_time else inventory_reconciled_at end
    where id = i.id;
  return v_id;
end;
$$;
revoke all on function inventory_private.apply_raw_inventory_adjustment(uuid,numeric,text,text,text,numeric,uuid,text,uuid)
  from public, anon, authenticated;
grant execute on function inventory_private.apply_raw_inventory_adjustment(uuid,numeric,text,text,text,numeric,uuid,text,uuid)
  to authenticated;

create or replace function public.apply_raw_inventory_adjustment(
  p_ingredient_id uuid, p_quantity numeric, p_mode text, p_reason text, p_note text,
  p_expected_quantity numeric, p_expected_latest_id uuid, p_expected_unit text,
  p_reverse_id uuid default null
) returns uuid language sql security invoker set search_path = '' as $$
  select inventory_private.apply_raw_inventory_adjustment(p_ingredient_id, p_quantity, p_mode,
    p_reason, p_note, p_expected_quantity, p_expected_latest_id, p_expected_unit, p_reverse_id);
$$;
revoke all on function public.apply_raw_inventory_adjustment(uuid,numeric,text,text,text,numeric,uuid,text,uuid)
  from public, anon, authenticated;
grant execute on function public.apply_raw_inventory_adjustment(uuid,numeric,text,text,text,numeric,uuid,text,uuid)
  to authenticated;

notify pgrst, 'reload schema';
