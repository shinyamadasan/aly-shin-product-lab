-- Financial Release 2: additive stock-event attribution. No historical backfill or expense rows.
-- Requires separately reviewed production execution. Test only in disposable PostgreSQL until
-- production migration approval is given. Existing business rows and ledger quantities are kept.
-- Recovery: repair forward. Do not drop populated audit tables or snapshot columns; export and
-- review any data before considering rollback. Reverting writers without reverting reporting
-- would silently create unvalued events. No destructive data operation is part of this migration.

do $$
begin
  if to_regprocedure('inventory_private.claim_mutation(uuid,text,text)') is null
     or to_regprocedure('inventory_private.correct_bake_actual_pieces(uuid,uuid,integer,numeric,text)') is null
     or to_regprocedure('inventory_private.apply_finished_stock_reconciliation_batch(uuid,text,jsonb)') is null then
    raise exception 'Stock attribution requires receipts, Correct Bake and finished reconciliation';
  end if;
  if position('original.created_at <= i.inventory_reconciled_at' in
    pg_get_functiondef('inventory_private.apply_raw_inventory_adjustment(uuid,numeric,text,text,text,numeric,uuid,text,uuid)'::regprocedure)) = 0 then
    raise exception 'Stock attribution requires the restored raw count reversal boundary';
  end if;
  if to_regclass('public.stock_financial_event_reviews') is not null then
    raise exception 'Stock attribution already exists; do not reapply over audit history';
  end if;
  -- Replacing this CHECK only adds two verbs. Prove all existing rows remain valid before
  -- removing its old definition; no row is removed or altered by the constraint expansion.
  if not exists (select 1 from pg_constraint where conrelid = 'public.finished_stock_movements'::regclass
    and conname = 'finished_stock_movements_movement_type_check' and contype = 'c')
    or exists (select 1 from public.finished_stock_movements where movement_type not in
      ('production_receipt','reserve','release','fulfill','damage','giveaway','correction','bake_correction')) then
    raise exception 'Finished movement types differ from the approved current ledger; investigate before migration';
  end if;
end;
$$;

alter table public.inventory_transactions
  add column financial_classification text check (financial_classification in
    ('operating_loss','marketing','business_testing','household','unclassified')),
  add column financial_unit_cost_snapshot numeric check (financial_unit_cost_snapshot > 0
    and financial_unit_cost_snapshot::text not in ('NaN','Infinity','-Infinity'));
alter table public.finished_stock_movements
  add column financial_classification text check (financial_classification in
    ('operating_loss','marketing','business_testing','household','unclassified')),
  add column reverses_movement_id uuid references public.finished_stock_movements(id);
create unique index finished_stock_exception_reversal_once_idx
  on public.finished_stock_movements(reverses_movement_id) where reverses_movement_id is not null;
alter table public.finished_stock_movements drop constraint finished_stock_movements_movement_type_check;
alter table public.finished_stock_movements add constraint finished_stock_movements_movement_type_check check (
  movement_type in ('production_receipt','reserve','release','fulfill','damage','giveaway','household','correction','bake_correction','exception_reversal'));
alter table public.finished_stock_movements add constraint finished_stock_household_shape check (
  movement_type <> 'household' or (on_hand_delta < 0 and reserved_delta = 0
    and production_execution_id is not null and order_id is null and order_stock_allocation_id is null));
alter table public.finished_stock_movements add constraint finished_stock_exception_reversal_shape check (
  (movement_type = 'exception_reversal' and reverses_movement_id is not null and on_hand_delta > 0
    and reserved_delta = 0 and production_execution_id is not null and order_id is null and order_stock_allocation_id is null)
  or (movement_type <> 'exception_reversal' and reverses_movement_id is null));

create table public.finished_stock_count_boundaries (
  id uuid primary key default gen_random_uuid(),
  product_id text not null references public.products(id),
  operation_id uuid not null,
  reconciled_at timestamptz not null,
  unique(product_id, operation_id)
);
create index finished_stock_count_boundaries_latest_idx on public.finished_stock_count_boundaries(product_id, reconciled_at desc);
create table public.stock_financial_event_reviews (
  id uuid primary key default gen_random_uuid(),
  operation_id uuid not null unique,
  source_kind text not null check (source_kind in ('raw','finished')),
  source_id uuid not null,
  classification text not null check (classification in ('operating_loss','marketing','business_testing','household','unclassified')),
  note text not null check (length(trim(note)) > 0),
  actor uuid not null,
  reviewed_at timestamptz not null default clock_timestamp()
);
create index stock_financial_event_reviews_latest_idx on public.stock_financial_event_reviews(source_kind, source_id, reviewed_at desc, id desc);
create function inventory_private.protect_stock_financial_audit() returns trigger
language plpgsql set search_path = '' as $$
begin raise exception 'Stock financial audit history is append-only.' using errcode = '42501'; end;
$$;
revoke all on function inventory_private.protect_stock_financial_audit() from public, anon, authenticated;
create trigger finished_stock_count_boundaries_history before update or delete on public.finished_stock_count_boundaries
  for each row execute function inventory_private.protect_stock_financial_audit();
create trigger finished_stock_count_boundaries_truncate before truncate on public.finished_stock_count_boundaries
  for each statement execute function inventory_private.protect_stock_financial_audit();
create trigger stock_financial_event_reviews_history before update or delete on public.stock_financial_event_reviews
  for each row execute function inventory_private.protect_stock_financial_audit();
create trigger stock_financial_event_reviews_truncate before truncate on public.stock_financial_event_reviews
  for each statement execute function inventory_private.protect_stock_financial_audit();
alter table public.finished_stock_count_boundaries enable row level security;
alter table public.stock_financial_event_reviews enable row level security;
revoke all on public.finished_stock_count_boundaries, public.stock_financial_event_reviews from public, anon, authenticated;
-- Supabase defaults grant service_role ALL on new tables; keep SELECT, close every audit write.
revoke insert, update, delete, truncate, trigger, references
  on public.finished_stock_count_boundaries, public.stock_financial_event_reviews from service_role;
grant select on public.finished_stock_count_boundaries, public.stock_financial_event_reviews to authenticated;
create policy stock_count_owner_reads on public.finished_stock_count_boundaries for select to authenticated using (public.is_product_lab_owner());
create policy stock_review_owner_reads on public.stock_financial_event_reviews for select to authenticated using (public.is_product_lab_owner());

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
  v_financial_classification text;
  v_financial_unit_cost numeric;
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
    v_financial_classification := original.financial_classification;
    v_financial_unit_cost := original.financial_unit_cost_snapshot;
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
  if p_mode <> 'reverse' then
    v_financial_classification := case
      when p_mode = 'count' or v_delta > 0 then 'unclassified'
      when p_reason = 'household_use' then 'household'
      when p_reason in ('waste_or_spoilage', 'spillage') then 'operating_loss'
      when p_reason = 'recipe_testing' then 'business_testing'
      else 'unclassified' end;
    if v_delta < 0 and i.cost_reconciled_at is not null
       and i.average_unit_cost > 0
       and i.average_unit_cost::text not in ('NaN', 'Infinity', '-Infinity') then
      v_financial_unit_cost := i.average_unit_cost;
    end if;
  end if;
  v_time := clock_timestamp();
  insert into public.inventory_transactions (ingredient_id, transaction_type, quantity_change,
    quantity_before, quantity_after, source_type, source_id, reason, actor, note,
    created_at, reconciliation_snapshot, financial_classification, financial_unit_cost_snapshot)
  values (i.id, 'adjustment', v_delta, i.current_quantity, v_after, 'manual', p_reverse_id::text,
    p_reason, auth.uid()::text, trim(p_note), v_time, v_snapshot, v_financial_classification, v_financial_unit_cost) returning id into v_id;
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

create or replace function inventory_private.record_finished_stock_exception(
  p_operation_id uuid, p_product_id text, p_exception_type text, p_quantity_delta numeric,
  p_production_execution_id uuid, p_note text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_hash text; v_replay jsonb; v_now timestamptz := clock_timestamp();
  v_exec record;
  v_remaining numeric; v_take numeric; v_total_available numeric := 0;
  v_note text; v_movements jsonb := '[]'::jsonb; v_movement_id uuid;
  v_result jsonb;
begin
  if auth.uid() is null or public.is_product_lab_owner() is not true then
    raise exception 'Only the product lab owner may record a finished-stock exception' using errcode = '42501';
  end if;
  if p_product_id is null or length(trim(p_product_id)) = 0 then
    raise exception 'A product is required' using errcode = '22023';
  end if;
  if p_exception_type is null or p_exception_type not in ('damage', 'giveaway', 'household', 'correction') then
    raise exception 'Exception type must be damage, giveaway, household, or correction' using errcode = '22023';
  end if;
  if p_quantity_delta is null or p_quantity_delta::text = any(array['NaN','Infinity','-Infinity'])
     or p_quantity_delta <> trunc(p_quantity_delta) or p_quantity_delta = 0 then
    raise exception 'Quantity must be a non-zero whole number' using errcode = '22023';
  end if;
  -- POST-REVIEW FIX: positive ("found more than recorded") is not supported for any exception
  -- type -- an unattributed positive correction violates cost conservation: a positive correction has
  -- no trustworthy cost basis of its own, and attributing it to an existing execution can inflate
  -- that execution's fulfilled raw COGS beyond what it actually cost). Rejected before any lock.
  if p_quantity_delta > 0 then
    raise exception 'Positive finished-stock correction is not supported because found-more stock does not yet have a trustworthy raw-cost basis.' using errcode = '22023';
  end if;
  -- The operator never chooses a lot: damage, giveaway, household consumption and negative
  -- correction are all FIFO-allocated automatically from the
  -- oldest unreserved stock below.
  if p_production_execution_id is not null then
    raise exception 'Finished-stock exceptions are allocated automatically from the oldest unreserved stock; do not choose a lot' using errcode = '22023';
  end if;
  if not exists (select 1 from public.products where id = p_product_id) then
    raise exception 'Product not found' using errcode = '22023';
  end if;

  v_hash := md5(concat_ws('|', p_product_id, p_exception_type, p_quantity_delta::text,
    coalesce(p_production_execution_id::text, ''), coalesce(p_note, '')));
  v_replay := inventory_private.claim_mutation(p_operation_id, 'finished_stock_exception', v_hash);
  if v_replay is not null then return v_replay; end if;

  -- Serialization anchor: the same canonical products row lock Wave 2 takes before ever reading
  -- production-execution availability, so a concurrent order confirmation, a concurrent
  -- exception, and this call all queue on the same row regardless of which one arrives first.
  perform id from public.products where id = p_product_id for update;

  -- Lock every candidate lot for this product, in the same deterministic order Wave 2's FIFO
  -- allocator uses, before reading any availability.
  perform pe.id from public.production_executions pe
  where pe.product_id = p_product_id
  order by pe.completed_at, pe.id
  for update;

  v_note := coalesce(nullif(trim(p_note), ''), initcap(p_exception_type));

  -- Always negative from here: damage, giveaway, household, or a "found fewer" correction. FIFO-deduct from
  -- unreserved lots only, oldest first, exactly like Wave 2's allocator -- reserved stock is
  -- never touched and never reachable.
  v_remaining := abs(p_quantity_delta);

  select coalesce(sum(greatest(lot.on_hand - lot.reserved, 0)), 0) into v_total_available
  from (
    select pe.id,
           coalesce(sum(fsm.on_hand_delta), 0) as on_hand,
           coalesce(sum(fsm.reserved_delta), 0) as reserved
    from public.production_executions pe
    left join public.finished_stock_movements fsm on fsm.production_execution_id = pe.id
    where pe.product_id = p_product_id
    group by pe.id
  ) lot;

  if v_total_available < v_remaining then
    raise exception 'Not enough unreserved stock to record this %: % requested, only % available (reserved pieces are protected).', p_exception_type, v_remaining::integer, v_total_available::integer using errcode = '23514';
  end if;

  for v_exec in
    select pe.id as execution_id,
           coalesce(sum(fsm.on_hand_delta), 0) - coalesce(sum(fsm.reserved_delta), 0) as lot_available
    from public.production_executions pe
    left join public.finished_stock_movements fsm on fsm.production_execution_id = pe.id
    where pe.product_id = p_product_id
    group by pe.id, pe.completed_at
    order by pe.completed_at, pe.id
  loop
    exit when v_remaining <= 0;
    continue when v_exec.lot_available <= 0;
    v_take := least(v_remaining, v_exec.lot_available);

    insert into public.finished_stock_movements (product_id, production_execution_id, movement_type, on_hand_delta, reserved_delta, operation_id, note, financial_classification, created_at)
    values (p_product_id, v_exec.execution_id, p_exception_type, -v_take::integer, 0, p_operation_id, v_note,
      case p_exception_type when 'damage' then 'operating_loss' when 'giveaway' then 'marketing'
        when 'household' then 'household' else 'unclassified' end, clock_timestamp())
    returning id into v_movement_id;

    v_movements := v_movements || jsonb_build_object(
      'finished_stock_movement_id', v_movement_id, 'production_execution_id', v_exec.execution_id,
      'quantity', -v_take::integer);

    v_remaining := v_remaining - v_take;
  end loop;

  if v_remaining > 0 then
    -- Unreachable given the availability check above ran against the same locked snapshot;
    -- guarded anyway rather than silently under-applying (matches Wave 2's own guard).
    raise exception 'Could not allocate this % across available unreserved lots (internal consistency error).', p_exception_type using errcode = '23514';
  end if;

  v_result := jsonb_build_object(
    'product_id', p_product_id, 'exception_type', p_exception_type, 'quantity_delta', p_quantity_delta,
    'movements', v_movements);
  update inventory_private.mutation_receipts set result = v_result where operation_id = p_operation_id;
  return v_result;
end;
$$;

create or replace function inventory_private.apply_finished_stock_reconciliation_batch(
  p_operation_id uuid, p_payload_hash text, p_items jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_claim jsonb; v_results jsonb := '[]'::jsonb; v_item jsonb;
  v_product_id text; v_physical_count integer;
  v_expected_on_hand integer; v_expected_reserved integer; v_expected_latest_movement_id uuid;
  v_effective_at timestamptz; v_estimated_cost_per_piece numeric; v_cost_basis_snapshot jsonb; v_note text;
  v_on_hand integer; v_reserved integer; v_latest_movement_id uuid;
  v_difference integer; v_sub_op uuid;
  v_opening_result jsonb; v_correction_result jsonb; v_action text;
begin
  if auth.uid() is null or public.is_product_lab_owner() is not true then
    raise exception 'Only the product lab owner may apply a finished-stock reconciliation' using errcode = '42501';
  end if;
  if p_operation_id is null or p_payload_hash is null or length(trim(p_payload_hash)) <> 64
     or p_payload_hash !~ '^[0-9a-f]{64}$'
     or p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Operation id, SHA-256 payload hash, and at least one reconciliation item are required' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_items) as row
    group by (row->>'product_id') having count(*) > 1
  ) then
    raise exception 'A reconciliation batch cannot contain duplicate products' using errcode = '23514';
  end if;

  v_claim := inventory_private.claim_mutation(p_operation_id, 'finished_stock_reconciliation', p_payload_hash);
  if v_claim is not null then return v_claim; end if;

  -- Deterministic global lock order for every batch, same discipline as
  -- apply_inventory_physical_count_batch's ingredient-id order.
  perform p.id from public.products p
  where p.id in (select value->>'product_id' from jsonb_array_elements(p_items))
  order by p.id for update;

  for v_item in select value from jsonb_array_elements(p_items) order by (value->>'product_id')
  loop
    begin
      v_product_id := v_item->>'product_id';
      v_physical_count := (v_item->>'physical_count')::integer;
      v_expected_on_hand := (v_item->>'expected_on_hand_pieces')::integer;
      v_expected_reserved := (v_item->>'expected_reserved_pieces')::integer;
      v_expected_latest_movement_id := nullif(v_item->>'expected_latest_movement_id', '')::uuid;
      v_effective_at := nullif(v_item->>'effective_at', '')::timestamptz;
      v_estimated_cost_per_piece := nullif(v_item->>'estimated_cost_per_piece', '')::numeric;
      v_cost_basis_snapshot := v_item->'cost_basis_snapshot';
      v_note := v_item->>'note';
    exception when invalid_text_representation or numeric_value_out_of_range then
      raise exception 'Every reconciliation item requires valid typed values' using errcode = '22023';
    end;
    if v_product_id is null or length(trim(v_product_id)) = 0
       or v_physical_count is null or v_physical_count < 0
       or v_expected_on_hand is null or v_expected_reserved is null then
      raise exception 'Every reconciliation item requires a product, a non-negative physical count, and expected on-hand/reserved stale guards' using errcode = '22023';
    end if;

    select coalesce(sum(on_hand_delta), 0), coalesce(sum(reserved_delta), 0)
      into v_on_hand, v_reserved
      from public.finished_stock_movements where product_id = v_product_id;
    select id into v_latest_movement_id from public.finished_stock_movements
      where product_id = v_product_id order by created_at desc, id desc limit 1;

    if v_on_hand <> v_expected_on_hand or v_reserved <> v_expected_reserved
       or v_latest_movement_id is distinct from v_expected_latest_movement_id then
      raise exception 'Stock for % changed since this reconciliation was previewed. Re-preview and try again.', v_product_id using errcode = '23514';
    end if;

    v_difference := v_physical_count - v_on_hand;
    v_sub_op := md5(p_operation_id::text || ':' || v_product_id)::uuid;

    if v_difference = 0 then
      v_action := 'no_change';
    elsif v_difference < 0 then
      v_action := 'correction';
      v_correction_result := inventory_private.record_finished_stock_exception(
        v_sub_op, v_product_id, 'correction', v_difference, null, coalesce(nullif(trim(v_note), ''), 'Physical count reconciliation'));
    else
      if exists (select 1 from public.production_executions where product_id = v_product_id) then
        raise exception 'Product % already has production history. A further stock increase must be investigated, not reconciled as an opening balance.', v_product_id using errcode = '23514';
      end if;
      v_action := 'opening_balance';
      v_opening_result := inventory_private.create_finished_stock_opening_balance(
        v_sub_op, p_operation_id, v_product_id, v_difference, v_effective_at,
        v_estimated_cost_per_piece, v_cost_basis_snapshot, v_note);
    end if;

    -- An exact recount is a physical-truth boundary too, even though it adds no movement.
    insert into public.finished_stock_count_boundaries(product_id, operation_id, reconciled_at)
    values (v_product_id, p_operation_id, clock_timestamp());

    v_results := v_results || jsonb_build_object(
      'product_id', v_product_id, 'action', v_action, 'difference', v_difference,
      'correction_result', v_correction_result, 'opening_balance_result', v_opening_result);
    v_correction_result := null; v_opening_result := null;
  end loop;

  update inventory_private.mutation_receipts set result = to_jsonb(v_results) where operation_id = p_operation_id;
  return to_jsonb(v_results);
end;
$$;

-- Reversal restores one exact allocated lot; it never guesses a product-level allocation.
create function inventory_private.reverse_finished_stock_exception(
  p_operation_id uuid, p_movement_id uuid, p_note text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_original public.finished_stock_movements%rowtype;
  v_product text; v_boundary timestamptz; v_replay jsonb; v_result jsonb; v_id uuid;
begin
  if auth.uid() is null or public.is_product_lab_owner() is not true then
    raise exception 'Only the product lab owner may reverse a stock loss' using errcode = '42501';
  end if;
  if p_movement_id is null or nullif(trim(p_note), '') is null then
    raise exception 'A stock movement and reversal reason note are required' using errcode = '22023';
  end if;
  v_replay := inventory_private.claim_mutation(p_operation_id, 'finished_stock_exception_reverse',
    md5(jsonb_build_array(p_movement_id, trim(p_note))::text));
  if v_replay is not null then return v_replay; end if;
  select product_id into v_product from public.finished_stock_movements where id = p_movement_id;
  if not found then raise exception 'Finished stock movement not found' using errcode = '22023'; end if;
  perform id from public.products where id = v_product for update;
  perform pe.id from public.production_executions pe where pe.product_id = v_product
    order by pe.completed_at, pe.id for update;
  select * into v_original from public.finished_stock_movements where id = p_movement_id;
  if v_original.movement_type not in ('damage','giveaway','household')
    or v_original.financial_classification is null or v_original.reverses_movement_id is not null then
    raise exception 'Only a newly classified consumption or loss can be reversed; count corrections and legacy movements require investigation' using errcode = '23514';
  end if;
  select max(boundary_at) into v_boundary from (
    select reconciled_at as boundary_at from public.finished_stock_count_boundaries where product_id = v_product
    union all
    select created_at from public.finished_stock_movements where product_id = v_product and movement_type = 'correction'
  ) boundaries;
  if v_original.created_at <= v_boundary then
    raise exception 'This stock loss was superseded by a later physical count and cannot be reversed' using errcode = '23514';
  end if;
  insert into public.finished_stock_movements(product_id, production_execution_id, movement_type,
    on_hand_delta, reserved_delta, operation_id, note, financial_classification, reverses_movement_id, created_at)
  values (v_product, v_original.production_execution_id, 'exception_reversal', -v_original.on_hand_delta,
    0, p_operation_id, trim(p_note), v_original.financial_classification, v_original.id, clock_timestamp()) returning id into v_id;
  v_result := jsonb_build_object('movement_id', v_id, 'reverses_movement_id', v_original.id,
    'product_id', v_product, 'quantity', -v_original.on_hand_delta);
  update inventory_private.mutation_receipts set result = v_result where operation_id = p_operation_id;
  return v_result;
end;
$$;
revoke all on function inventory_private.reverse_finished_stock_exception(uuid,uuid,text) from public, anon, authenticated;
grant execute on function inventory_private.reverse_finished_stock_exception(uuid,uuid,text) to authenticated;
create function public.reverse_finished_stock_exception(p_operation_id uuid, p_movement_id uuid, p_note text)
returns jsonb language sql security invoker set search_path = '' as $$
  select inventory_private.reverse_finished_stock_exception(p_operation_id, p_movement_id, p_note);
$$;
revoke all on function public.reverse_finished_stock_exception(uuid,uuid,text) from public, anon, authenticated;
grant execute on function public.reverse_finished_stock_exception(uuid,uuid,text) to authenticated;

-- Reviews are append-only classification evidence, never a second physical or expense ledger.
create function inventory_private.classify_stock_financial_event(
  p_operation_id uuid, p_source_kind text, p_source_id uuid, p_classification text,
  p_expected_review_id uuid, p_note text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_replay jsonb; v_source_id uuid; v_ingredient uuid; v_product text;
  v_latest uuid; v_review uuid; v_result jsonb;
begin
  if auth.uid() is null or public.is_product_lab_owner() is not true then
    raise exception 'Only the product lab owner may review stock financial events' using errcode = '42501';
  end if;
  if p_source_kind is null or p_source_kind not in ('raw','finished') or p_source_id is null
    or p_classification is null or p_classification not in ('operating_loss','marketing','business_testing','household','unclassified')
    or nullif(trim(p_note), '') is null then
    raise exception 'A stock event, financial classification and evidence note are required' using errcode = '22023';
  end if;
  v_replay := inventory_private.claim_mutation(p_operation_id, 'stock_financial_classify',
    md5(jsonb_build_array(p_source_kind,p_source_id,p_classification,p_expected_review_id,trim(p_note))::text));
  if v_replay is not null then return v_replay; end if;
  if p_source_kind = 'raw' then
    select ingredient_id into v_ingredient from public.inventory_transactions
      where id = p_source_id and transaction_type in ('adjustment','waste') and quantity_change <> 0 and source_type = 'manual';
    if not found then raise exception 'Raw stock financial event not found' using errcode = '22023'; end if;
    perform id from public.ingredients where id = v_ingredient for update;
    select coalesce(original.id,t.id) into v_source_id from public.inventory_transactions t
      left join public.inventory_transactions original on original.id::text = t.source_id
        and original.ingredient_id = t.ingredient_id and original.transaction_type = 'adjustment'
      where t.id = p_source_id;
    perform id from public.inventory_transactions where id = v_source_id for update;
  else
    select product_id into v_product from public.finished_stock_movements
      where id = p_source_id and movement_type in ('damage','giveaway','household','correction','exception_reversal');
    if not found then raise exception 'Finished stock financial event not found' using errcode = '22023'; end if;
    perform id from public.products where id = v_product for update;
    perform pe.id from public.production_executions pe where pe.product_id = v_product
      order by pe.completed_at, pe.id for update;
    select coalesce(reverses_movement_id,id) into v_source_id from public.finished_stock_movements where id = p_source_id;
    perform id from public.finished_stock_movements where id = v_source_id for update;
  end if;
  select id into v_latest from public.stock_financial_event_reviews
    where source_kind = p_source_kind and source_id = v_source_id order by reviewed_at desc, id desc limit 1;
  if v_latest is distinct from p_expected_review_id then
    raise sqlstate 'PT409' using message = 'This stock event was reviewed since you opened it. Reload and try again.';
  end if;
  insert into public.stock_financial_event_reviews(operation_id,source_kind,source_id,classification,note,actor,reviewed_at)
  values(p_operation_id,p_source_kind,v_source_id,p_classification,trim(p_note),auth.uid(),clock_timestamp()) returning id into v_review;
  v_result := jsonb_build_object('review_id',v_review,'source_kind',p_source_kind,'source_id',v_source_id,'classification',p_classification);
  update inventory_private.mutation_receipts set result = v_result where operation_id = p_operation_id;
  return v_result;
end;
$$;
revoke all on function inventory_private.classify_stock_financial_event(uuid,text,uuid,text,uuid,text) from public, anon, authenticated;
grant execute on function inventory_private.classify_stock_financial_event(uuid,text,uuid,text,uuid,text) to authenticated;
create function public.classify_stock_financial_event(p_operation_id uuid,p_source_kind text,p_source_id uuid,p_classification text,p_expected_review_id uuid,p_note text)
returns jsonb language sql security invoker set search_path = '' as $$
  select inventory_private.classify_stock_financial_event(p_operation_id,p_source_kind,p_source_id,p_classification,p_expected_review_id,p_note);
$$;
revoke all on function public.classify_stock_financial_event(uuid,text,uuid,text,uuid,text) from public, anon, authenticated;
grant execute on function public.classify_stock_financial_event(uuid,text,uuid,text,uuid,text) to authenticated;

create view public.stock_financial_events with (security_invoker = true) as
with events as (
  select 'raw:' || t.id::text as id, t.created_at as occurred_at, 'raw'::text as source_kind,
    t.id as source_id, coalesce(original.id,t.id) as origin_id,
    t.financial_classification as classification, -t.quantity_change as quantity,
    case when t.financial_unit_cost_snapshot is not null then -t.quantity_change * t.financial_unit_cost_snapshot end as amount,
    false as estimated
  from public.inventory_transactions t
  left join public.inventory_transactions original on original.id::text = t.source_id
    and original.ingredient_id = t.ingredient_id and original.transaction_type = 'adjustment'
  where t.transaction_type in ('adjustment','waste') and t.source_type = 'manual' and t.quantity_change <> 0
  union all
  select 'finished:' || m.id::text, m.created_at, 'finished', m.id, coalesce(m.reverses_movement_id,m.id),
    m.financial_classification, -m.on_hand_delta::numeric,
    case when pe.frozen_cost_per_piece > 0 and pe.frozen_cost_per_piece::text not in ('NaN','Infinity','-Infinity')
      then -m.on_hand_delta * pe.frozen_cost_per_piece end,
    coalesce(pe.cost_basis_source = 'historical_estimate',false)
  from public.finished_stock_movements m
  left join public.production_executions pe on pe.id = m.production_execution_id and pe.product_id = m.product_id
  where m.movement_type in ('damage','giveaway','household','correction','exception_reversal')
)
select e.id,e.occurred_at,e.source_kind,e.source_id,
  coalesce(r.classification,e.classification,'unclassified') as classification,
  e.quantity,e.amount,e.estimated,r.id as review_id
from events e
left join lateral (
  select id,classification from public.stock_financial_event_reviews
  where source_kind = e.source_kind and source_id = e.origin_id order by reviewed_at desc,id desc limit 1
) r on true;
revoke all on public.stock_financial_events from public, anon, authenticated;
grant select on public.stock_financial_events to authenticated;

comment on view public.stock_financial_events is
  'Derived stock-event attribution only: positive losses, negative reversals. Raw costs are captured at event time; null stays unknown. Finished costs follow allocated lots and Correct Bake like sales COGS. No business_expenses row is created. Historical null classifications remain unclassified until explicit owner review.';
notify pgrst, 'reload schema';
