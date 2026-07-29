-- Manual "Log a purchase" has never updated ingredients.current_quantity/average_unit_cost or
-- written a ledger row -- only CSV import's confirm step and Bake's confirm step did. This file
-- adds three RPCs (same "security invoker, one plpgsql function = one transaction" pattern as
-- confirm_purchase_import/confirm_bake in supabase-add-inventory.sql) so create/edit/delete of a
-- manual purchase and the one-time historical backfill all apply atomically. No new tables, no new
-- business logic -- src/lib/supply-inventory-effect.ts remains the only place that decides *what*
-- changes; these functions only apply an already-computed result.
--
-- Safe to run more than once (create or replace).

do $$
begin
  if exists (
    select 1
    from inventory_transactions
    where source_type = 'manual'
      and transaction_type = 'purchase'
      and source_id is not null
    group by source_type, source_id, transaction_type
    having count(*) > 1
  ) then
    raise exception 'Duplicate manual purchase inventory transactions exist; reconcile them before applying inventory_transactions_manual_purchase_source_identity_idx.';
  end if;
end $$;

create unique index if not exists inventory_transactions_manual_purchase_source_identity_idx
  on inventory_transactions (source_type, source_id, transaction_type)
  where source_type = 'manual'
    and transaction_type = 'purchase'
    and source_id is not null;

create or replace function save_supply_with_inventory_effect(
  p_supply_id uuid,
  p_is_new_supply boolean,
  -- {ingredient_id, ingredient_name, brand_name, supplier_name, purchase_date, pack_quantity,
  --  unit, total_cost, quality_rating, notes} -- supply_entries' own columns, id passed separately.
  p_supply jsonb,
  -- {id, current_quantity, average_unit_cost} or null if this purchase's effect isn't (yet)
  -- applied to inventory (see planSupplyEdit's "not-applied"/"quantity-only" cases).
  p_ingredient_update jsonb,
  -- {id, ingredient_id, transaction_type, quantity_change, quantity_before, quantity_after,
  --  source_type, source_id, note} or null. Upserted by id -- update if this purchase already has
  -- a ledger row (amending it in place), insert otherwise.
  p_transaction_upsert jsonb
) returns void
language plpgsql
security invoker
as $$
declare
  v_supply_ingredient_id uuid;
  v_ingredient_update_id uuid;
  v_transaction_ingredient_id uuid;
  v_transaction_row_count integer;
begin
  if p_supply_id is null then
    raise exception 'Supply id is required';
  end if;

  if p_is_new_supply is null then
    raise exception 'Supply create/update intent is required';
  end if;

  if p_supply is null then
    raise exception 'Supply payload is required';
  end if;

  if nullif(p_supply->>'ingredient_id', '') is null then
    raise exception 'Supply ingredient_id is required';
  end if;
  v_supply_ingredient_id := (p_supply->>'ingredient_id')::uuid;

  if nullif(p_supply->>'ingredient_name', '') is null then
    raise exception 'Supply ingredient_name is required';
  end if;

  if nullif(p_supply->>'supplier_name', '') is null then
    raise exception 'Supply supplier_name is required';
  end if;

  if nullif(p_supply->>'purchase_date', '') is null then
    raise exception 'Supply purchase_date is required';
  end if;

  if nullif(p_supply->>'pack_quantity', '') is null then
    raise exception 'Supply pack_quantity is required';
  end if;

  if (p_supply->>'pack_quantity')::numeric <= 0 then
    raise exception 'Pack quantity must be greater than zero';
  end if;

  if nullif(p_supply->>'total_cost', '') is null then
    raise exception 'Supply total_cost is required';
  end if;

  if (p_supply->>'total_cost')::numeric < 0 then
    raise exception 'Total cost cannot be negative';
  end if;

  if nullif(p_supply->>'quality_rating', '') is null then
    raise exception 'Supply quality_rating is required';
  end if;

  if p_ingredient_update is not null then
    if nullif(p_ingredient_update->>'id', '') is null then
      raise exception 'Ingredient update id is required';
    end if;
    v_ingredient_update_id := (p_ingredient_update->>'id')::uuid;

    if v_supply_ingredient_id is distinct from v_ingredient_update_id then
      raise exception 'Ingredient mismatch between supply and inventory update';
    end if;

    if nullif(p_ingredient_update->>'current_quantity', '') is null then
      raise exception 'Ingredient update current_quantity is required';
    end if;

    if nullif(p_ingredient_update->>'average_unit_cost', '') is null then
      raise exception 'Ingredient update average_unit_cost is required';
    end if;
  end if;

  if p_transaction_upsert is not null then
    if nullif(p_transaction_upsert->>'id', '') is null then
      raise exception 'Transaction id is required';
    end if;

    if nullif(p_transaction_upsert->>'ingredient_id', '') is null then
      raise exception 'Transaction ingredient_id is required';
    end if;
    v_transaction_ingredient_id := (p_transaction_upsert->>'ingredient_id')::uuid;

    if v_supply_ingredient_id is distinct from v_transaction_ingredient_id then
      raise exception 'Ingredient mismatch between supply and transaction';
    end if;

    if nullif(p_transaction_upsert->>'transaction_type', '') is null then
      raise exception 'Transaction transaction_type is required';
    end if;

    if p_transaction_upsert->>'transaction_type' <> 'purchase' then
      raise exception 'Manual supply transaction_type must be purchase';
    end if;

    if nullif(p_transaction_upsert->>'source_type', '') is null then
      raise exception 'Transaction source_type is required';
    end if;

    if p_transaction_upsert->>'source_type' <> 'manual' then
      raise exception 'Manual supply transaction source_type must be manual';
    end if;

    if nullif(p_transaction_upsert->>'source_id', '') is null then
      raise exception 'Transaction source_id is required';
    end if;

    if p_transaction_upsert->>'source_id' <> p_supply_id::text then
      raise exception 'Manual supply transaction source_id must match the supply id';
    end if;

    if nullif(p_transaction_upsert->>'quantity_change', '') is null then
      raise exception 'Transaction quantity_change is required';
    end if;

    if nullif(p_transaction_upsert->>'quantity_before', '') is null then
      raise exception 'Transaction quantity_before is required';
    end if;

    if nullif(p_transaction_upsert->>'quantity_after', '') is null then
      raise exception 'Transaction quantity_after is required';
    end if;
  end if;

  if p_is_new_supply then
    if exists (
      select 1
      from supply_entries
      where id = p_supply_id
    ) then
      raise exception 'Supply entry % already exists', p_supply_id;
    end if;

    insert into supply_entries (
      id, ingredient_id, ingredient_name, brand_name, supplier_name, purchase_date,
      pack_quantity, unit, total_cost, quality_rating, notes
    ) values (
      p_supply_id,
      v_supply_ingredient_id,
      p_supply->>'ingredient_name',
      p_supply->>'brand_name',
      p_supply->>'supplier_name',
      (p_supply->>'purchase_date')::date,
      (p_supply->>'pack_quantity')::numeric,
      p_supply->>'unit',
      (p_supply->>'total_cost')::numeric,
      (p_supply->>'quality_rating')::numeric,
      p_supply->>'notes'
    );
  else
    update supply_entries
    set
      ingredient_id = nullif(p_supply->>'ingredient_id', '')::uuid,
      ingredient_name = p_supply->>'ingredient_name',
      brand_name = p_supply->>'brand_name',
      supplier_name = p_supply->>'supplier_name',
      purchase_date = (p_supply->>'purchase_date')::date,
      pack_quantity = (p_supply->>'pack_quantity')::numeric,
      unit = p_supply->>'unit',
      total_cost = (p_supply->>'total_cost')::numeric,
      quality_rating = (p_supply->>'quality_rating')::numeric,
      notes = p_supply->>'notes',
      updated_at = now()
    where id = p_supply_id;

    if not found then
      raise exception 'Supply entry % was not found', p_supply_id;
    end if;
  end if;

  if p_ingredient_update is not null then
    update ingredients
    set
      current_quantity = (p_ingredient_update->>'current_quantity')::numeric,
      average_unit_cost = (p_ingredient_update->>'average_unit_cost')::numeric,
      updated_at = now()
    where id = v_ingredient_update_id;

    if not found then
      raise exception 'Ingredient % was not found', v_ingredient_update_id;
    end if;
  end if;

  if p_transaction_upsert is not null then
    insert into inventory_transactions (
      id, ingredient_id, transaction_type, quantity_change, quantity_before, quantity_after,
      source_type, source_id, note
    ) values (
      (p_transaction_upsert->>'id')::uuid,
      (p_transaction_upsert->>'ingredient_id')::uuid,
      p_transaction_upsert->>'transaction_type',
      (p_transaction_upsert->>'quantity_change')::numeric,
      (p_transaction_upsert->>'quantity_before')::numeric,
      (p_transaction_upsert->>'quantity_after')::numeric,
      p_transaction_upsert->>'source_type',
      p_transaction_upsert->>'source_id',
      p_transaction_upsert->>'note'
    )
    on conflict (id) do update set
      quantity_change = excluded.quantity_change,
      quantity_before = excluded.quantity_before,
      quantity_after = excluded.quantity_after,
      note = excluded.note
    where inventory_transactions.ingredient_id = excluded.ingredient_id
      and inventory_transactions.transaction_type = excluded.transaction_type
      and inventory_transactions.source_type = excluded.source_type
      and inventory_transactions.source_id = excluded.source_id;

    get diagnostics v_transaction_row_count = row_count;
    if v_transaction_row_count <> 1 then
      raise exception 'Inventory transaction % was not inserted or updated for supply %', p_transaction_upsert->>'id', p_supply_id;
    end if;
  end if;
end;
$$;

grant execute on function save_supply_with_inventory_effect(uuid, boolean, jsonb, jsonb, jsonb) to authenticated;

create or replace function delete_supply_with_inventory_effect(
  p_supply_id uuid,
  -- {id, current_quantity, average_unit_cost} or null (this purchase's effect was never applied).
  p_ingredient_update jsonb,
  -- Set only in the "safe to reverse" case -- deletes that purchase's own ledger row along with
  -- it, rather than leaving an orphaned entry for something that no longer exists.
  p_transaction_id_to_remove uuid
) returns void
language plpgsql
security invoker
as $$
declare
  v_ingredient_update_id uuid;
begin
  if p_supply_id is null then
    raise exception 'Supply id is required';
  end if;

  if p_ingredient_update is not null then
    if nullif(p_ingredient_update->>'id', '') is null then
      raise exception 'Ingredient update id is required';
    end if;
    v_ingredient_update_id := (p_ingredient_update->>'id')::uuid;

    if nullif(p_ingredient_update->>'current_quantity', '') is null then
      raise exception 'Ingredient update current_quantity is required';
    end if;

    if nullif(p_ingredient_update->>'average_unit_cost', '') is null then
      raise exception 'Ingredient update average_unit_cost is required';
    end if;

    update ingredients
    set
      current_quantity = (p_ingredient_update->>'current_quantity')::numeric,
      average_unit_cost = (p_ingredient_update->>'average_unit_cost')::numeric,
      updated_at = now()
    where id = v_ingredient_update_id;

    if not found then
      raise exception 'Ingredient % was not found', v_ingredient_update_id;
    end if;
  end if;

  if p_transaction_id_to_remove is not null then
    delete from inventory_transactions
    where id = p_transaction_id_to_remove
      and source_type = 'manual'
      and source_id = p_supply_id::text;

    if not found then
      raise exception 'Inventory transaction % was not found for supply %', p_transaction_id_to_remove, p_supply_id;
    end if;
  end if;

  delete from supply_entries where id = p_supply_id;

  if not found then
    raise exception 'Supply entry % was not found', p_supply_id;
  end if;
end;
$$;

grant execute on function delete_supply_with_inventory_effect(uuid, jsonb, uuid) to authenticated;

-- One-time, idempotent catch-up for purchases logged before this fix shipped -- see
-- repairMissingSupplyInventoryEffects. Same shape as confirm_bake: bulk ingredient updates, bulk
-- ledger inserts, nothing else. p_transactions must be in the chronological order already used
-- to calculate quantity_before/quantity_after; the TypeScript planner owns that ordering.
create or replace function repair_supply_inventory_effects(
  -- [{ id, current_quantity, average_unit_cost }, ...] -- one entry per ingredient that had at
  -- least one missing purchase effect applied.
  p_ingredient_updates jsonb,
  -- toInventoryTransactionRow's own shape, including a stable id, one entry per purchase newly applied.
  p_transactions jsonb
) returns void
language plpgsql
security invoker
as $$
declare
  v_update jsonb;
  v_transaction jsonb;
  v_update_id uuid;
  v_transaction_ingredient_id uuid;
  v_transaction_row_count integer;
begin
  if p_ingredient_updates is null then
    raise exception 'Ingredient updates payload is required';
  end if;

  if p_transactions is null then
    raise exception 'Transactions payload is required';
  end if;

  for v_update in select * from jsonb_array_elements(p_ingredient_updates)
  loop
    if nullif(v_update->>'id', '') is null then
      raise exception 'Ingredient update id is required';
    end if;
    v_update_id := (v_update->>'id')::uuid;

    if nullif(v_update->>'current_quantity', '') is null then
      raise exception 'Ingredient update current_quantity is required';
    end if;

    if nullif(v_update->>'average_unit_cost', '') is null then
      raise exception 'Ingredient update average_unit_cost is required';
    end if;

    update ingredients
    set
      current_quantity = (v_update->>'current_quantity')::numeric,
      average_unit_cost = (v_update->>'average_unit_cost')::numeric,
      updated_at = now()
    where id = v_update_id;

    if not found then
      raise exception 'Ingredient % was not found', v_update_id;
    end if;
  end loop;

  for v_transaction in select * from jsonb_array_elements(p_transactions)
  loop
    if nullif(v_transaction->>'id', '') is null then
      raise exception 'Transaction id is required';
    end if;

    if nullif(v_transaction->>'ingredient_id', '') is null then
      raise exception 'Transaction ingredient_id is required';
    end if;
    v_transaction_ingredient_id := (v_transaction->>'ingredient_id')::uuid;

    if nullif(v_transaction->>'transaction_type', '') is null then
      raise exception 'Transaction transaction_type is required';
    end if;

    if v_transaction->>'transaction_type' <> 'purchase' then
      raise exception 'Repair transaction_type must be purchase';
    end if;

    if nullif(v_transaction->>'source_type', '') is null then
      raise exception 'Transaction source_type is required';
    end if;

    if v_transaction->>'source_type' <> 'manual' then
      raise exception 'Repair transaction source_type must be manual';
    end if;

    if nullif(v_transaction->>'source_id', '') is null then
      raise exception 'Repair transaction source_id is required';
    end if;

    if nullif(v_transaction->>'quantity_change', '') is null then
      raise exception 'Transaction quantity_change is required';
    end if;

    if nullif(v_transaction->>'quantity_before', '') is null then
      raise exception 'Transaction quantity_before is required';
    end if;

    if nullif(v_transaction->>'quantity_after', '') is null then
      raise exception 'Transaction quantity_after is required';
    end if;

    insert into inventory_transactions (
      id, ingredient_id, transaction_type, quantity_change, quantity_before, quantity_after,
      source_type, source_id, note
    ) values (
      (v_transaction->>'id')::uuid,
      v_transaction_ingredient_id,
      v_transaction->>'transaction_type',
      (v_transaction->>'quantity_change')::numeric,
      (v_transaction->>'quantity_before')::numeric,
      (v_transaction->>'quantity_after')::numeric,
      v_transaction->>'source_type',
      v_transaction->>'source_id',
      v_transaction->>'note'
    )
    on conflict (source_type, source_id, transaction_type)
      where source_type = 'manual'
        and transaction_type = 'purchase'
        and source_id is not null
    do update set
      quantity_change = excluded.quantity_change,
      quantity_before = excluded.quantity_before,
      quantity_after = excluded.quantity_after,
      note = excluded.note
    where inventory_transactions.ingredient_id = excluded.ingredient_id;

    get diagnostics v_transaction_row_count = row_count;
    if v_transaction_row_count <> 1 then
      raise exception 'Inventory transaction % was not inserted or updated for repair source %', v_transaction->>'id', v_transaction->>'source_id';
    end if;
  end loop;
end;
$$;

grant execute on function repair_supply_inventory_effects(jsonb, jsonb) to authenticated;
