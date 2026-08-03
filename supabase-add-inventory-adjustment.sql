-- Stock adjustments: inventory moved outside baking (household use, waste/spoilage, recipe
-- testing, spillage, a stock-count correction, or anything else). Reuses the existing
-- inventory_transactions ledger and transaction_type = 'adjustment' (already a documented-but-
-- unused value) -- no new table. Reason/actor are the only new columns, additive and nullable so
-- every existing purchase/bake/repair transaction is unaffected.
--
-- Safe to run more than once (add column if not exists / create or replace function).

alter table inventory_transactions
  add column if not exists reason text,
  add column if not exists actor text;

-- {id, current_quantity} -- an adjustment never touches average_unit_cost, same rule as
-- confirm_bake's own ingredient-update payload (src/lib/stock-adjustment.ts computes this; this
-- function only persists it, same "TS decides what, SQL only applies it" pattern as every other
-- RPC in this schema).
--
-- A reversal is just another call to this same function with a pre-computed negated payload
-- (src/lib/stock-adjustment.ts's reverseStockAdjustment) -- there is no separate reversal RPC, and
-- an adjustment is never amended in place (a plain insert, not an upsert): corrections happen via
-- a new reversal row, never by rewriting history.
create or replace function apply_inventory_adjustment(
  p_ingredient_update jsonb,
  -- toInventoryTransactionRow's shape, including reason/actor. transaction_type must be
  -- 'adjustment', source_type must be 'manual'.
  p_transaction jsonb
) returns void
language plpgsql
security invoker
as $$
declare
  v_ingredient_id uuid;
  v_transaction_ingredient_id uuid;
begin
  if p_ingredient_update is null then
    raise exception 'Ingredient update payload is required';
  end if;

  if nullif(p_ingredient_update->>'id', '') is null then
    raise exception 'Ingredient update id is required';
  end if;
  v_ingredient_id := (p_ingredient_update->>'id')::uuid;

  if nullif(p_ingredient_update->>'current_quantity', '') is null then
    raise exception 'Ingredient update current_quantity is required';
  end if;

  if p_transaction is null then
    raise exception 'Transaction payload is required';
  end if;

  if nullif(p_transaction->>'id', '') is null then
    raise exception 'Transaction id is required';
  end if;

  if nullif(p_transaction->>'ingredient_id', '') is null then
    raise exception 'Transaction ingredient_id is required';
  end if;
  v_transaction_ingredient_id := (p_transaction->>'ingredient_id')::uuid;

  if v_ingredient_id is distinct from v_transaction_ingredient_id then
    raise exception 'Ingredient mismatch between ingredient update and transaction';
  end if;

  if nullif(p_transaction->>'transaction_type', '') is null or p_transaction->>'transaction_type' <> 'adjustment' then
    raise exception 'Stock adjustment transaction_type must be adjustment';
  end if;

  if nullif(p_transaction->>'source_type', '') is null or p_transaction->>'source_type' <> 'manual' then
    raise exception 'Stock adjustment transaction source_type must be manual';
  end if;

  if nullif(p_transaction->>'quantity_change', '') is null then
    raise exception 'Transaction quantity_change is required';
  end if;

  if nullif(p_transaction->>'quantity_before', '') is null then
    raise exception 'Transaction quantity_before is required';
  end if;

  if nullif(p_transaction->>'quantity_after', '') is null then
    raise exception 'Transaction quantity_after is required';
  end if;

  update ingredients
  set current_quantity = (p_ingredient_update->>'current_quantity')::numeric, updated_at = now()
  where id = v_ingredient_id;

  if not found then
    raise exception 'Ingredient % was not found', v_ingredient_id;
  end if;

  insert into inventory_transactions (
    id, ingredient_id, transaction_type, quantity_change, quantity_before, quantity_after,
    source_type, source_id, note, reason, actor
  ) values (
    (p_transaction->>'id')::uuid,
    v_transaction_ingredient_id,
    p_transaction->>'transaction_type',
    (p_transaction->>'quantity_change')::numeric,
    (p_transaction->>'quantity_before')::numeric,
    (p_transaction->>'quantity_after')::numeric,
    p_transaction->>'source_type',
    p_transaction->>'source_id',
    p_transaction->>'note',
    p_transaction->>'reason',
    p_transaction->>'actor'
  );
end;
$$;

grant execute on function apply_inventory_adjustment(jsonb, jsonb) to authenticated;

notify pgrst, 'reload schema';
