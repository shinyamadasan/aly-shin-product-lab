-- Wave 0B only. Restores purchase posting, CSV purchase confirmation, and Bake raw consumption
-- as database-authoritative, concurrency-safe, retry-safe mutations. Preserves every Wave 0A
-- guarantee: the browser submits intent (a converted quantity delta, or a pre-resolved deduction
-- list); the database locks the affected row(s), reads its own current_quantity/average_unit_cost,
-- computes the result, and commits atomically. No ordinary client ever supplies an ending balance.
--
-- NOT YET DEPLOYED. This file's timestamp is a local placeholder, not a server-assigned version --
-- see Wave 0A's own migration-identity lesson (planning/SELLING_WAVE_0A.md). Whoever applies this
-- for real must create it via the installed Supabase CLI (or record the server-assigned version
-- and rename the file to match) before pushing, not just run this file's SQL as-is by hand.
--
-- Rollback: pause the three restored posting paths again (the old Wave 0A "must block" trigger
-- condition can be restored) and repair forward. Do not restore the legacy absolute-balance RPCs.
do $$
begin
  if to_regprocedure('inventory_private.apply_raw_inventory_adjustment(uuid,numeric,text,text,text,numeric,uuid,text,uuid)') is null
     or to_regclass('inventory_private.mutation_receipts') is not null then
    raise exception 'Wave 0B requires Wave 0A''s authority migration and must not be re-applied over itself';
  end if;
end;
$$;

-- ============================================================================================
-- 1. Operation identity / idempotency -- one small receipt table, nothing else.
-- Same logical request + same operation id -> applies once, a retry returns the stored result.
-- Same operation id + a different payload -> rejected. Deliberately not a workflow/job engine:
-- one row per attempted mutation, written by the mutation itself, never read or written by
-- anything else.
-- ============================================================================================
create table if not exists inventory_private.mutation_receipts (
  operation_id uuid primary key,
  operation_type text not null,
  payload_hash text not null,
  -- null while the owning call is still in progress; a raised exception rolls back the whole
  -- transaction (including this row's insert), so a failed attempt never leaves a stuck claim.
  result jsonb,
  created_at timestamptz not null default now()
);
revoke all on table inventory_private.mutation_receipts from public, anon, authenticated;

-- Claim p_operation_id for p_operation_type. Returns null if the caller now owns a fresh claim
-- (proceed with the real work); returns the previously stored result if this is an exact retry
-- (caller should return it unchanged, doing no work). Raises if the same id was already used for
-- a materially different request, or if a concurrent call for the same id is still in flight (its
-- own `for update`-equivalent serialization is the plain insert conflict below: a second
-- concurrent insert of the same primary key blocks until the first call commits or rolls back,
-- so by the time this ever observes an existing row, that row is a finished, committed attempt).
create or replace function inventory_private.claim_mutation(
  p_operation_id uuid, p_operation_type text, p_payload_hash text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_row inventory_private.mutation_receipts%rowtype;
  v_inserted integer;
begin
  if p_operation_id is null or p_operation_type is null or p_payload_hash is null then
    raise exception 'An operation id is required for this action' using errcode = '22023';
  end if;

  insert into inventory_private.mutation_receipts (operation_id, operation_type, payload_hash, result)
    values (p_operation_id, p_operation_type, p_payload_hash, null)
    on conflict (operation_id) do nothing;
  get diagnostics v_inserted = row_count;
  if v_inserted = 1 then
    return null;
  end if;

  select * into v_row from inventory_private.mutation_receipts where operation_id = p_operation_id;
  if v_row.operation_type is distinct from p_operation_type or v_row.payload_hash is distinct from p_payload_hash then
    raise exception 'This operation id was already used for a different request. Reload and try again.' using errcode = '23514';
  end if;
  if v_row.result is null then
    raise exception 'This operation is still being processed. Wait a moment and try again.' using errcode = '55P03';
  end if;
  return v_row.result;
end;
$$;
revoke all on function inventory_private.claim_mutation(uuid,text,text) from public, anon, authenticated;

-- ============================================================================================
-- 2. Allow the one authorized transition Wave 0A's import guard was blocking outright. The
-- immutability half (posted history is read-only) is untouched. A plain client update can never
-- set this session-local flag, so a direct `update purchase_imports set status='confirmed'` still
-- fails exactly as it did under Wave 0A -- only inventory_private.confirm_purchase_import_v2 sets it.
-- ============================================================================================
create or replace function inventory_private.protect_posted_import()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_status text;
begin
  if tg_table_name = 'purchase_imports' then
    if tg_op <> 'INSERT' and (old.status = 'confirmed' or exists
      (select 1 from public.inventory_transactions where source_type = 'purchase_import' and source_id = old.id::text)) then
      raise exception 'Posted purchase history is read-only';
    end if;
    if tg_op <> 'DELETE' and new.status = 'confirmed'
       and (tg_op = 'INSERT' or old.status is distinct from 'confirmed')
       and coalesce(current_setting('inventory_private.posting_authorized', true), '') <> 'on' then
      raise exception 'Purchase posting must go through the safe posting function.' using errcode = '42501';
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
-- Trigger bodies are replaced in place; no drop/recreate of the triggers themselves.

-- ============================================================================================
-- 3. Manual purchase posting. One transaction: claim -> lock the ingredient -> require a trusted
-- opening count -> read the ingredient's own current_quantity/average_unit_cost -> compute the
-- new weighted average from the locked row (never from the client) -> append the ledger row and
-- the purchase record -> update the cache -> store the receipt -> commit.
--
-- p_base_quantity is the purchase already converted into the ingredient's own base unit -- the
-- same client-side, pure, already-unit-tested conversion (src/lib/unit-conversion.ts) every other
-- posting path in this app already relies on (CSV import's converted_quantity is the same kind of
-- value, precomputed and stored as draft data before Wave 0A/0B ever existed). That is a fixed
-- arithmetic transform, not a claim about current stock -- the database still independently reads
-- the ingredient's own row for everything that IS a claim about current stock (its quantity, its
-- cost, whether it has a trusted opening count). p_pack_quantity/p_display_unit are display-only,
-- stored on the purchase record as entered; they never participate in the stock/cost math.
-- ============================================================================================
create or replace function inventory_private.post_raw_purchase(
  p_operation_id uuid, p_ingredient_id uuid, p_pack_quantity numeric, p_display_unit text,
  p_base_quantity numeric, p_total_cost numeric, p_brand_name text, p_supplier_name text,
  p_purchase_date date, p_quality_rating numeric, p_notes text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_hash text; v_replay jsonb; i public.ingredients%rowtype;
  v_qty_before numeric; v_qty_after numeric; v_new_avg numeric; v_has_price boolean;
  v_supply_id uuid; v_tx_id uuid; v_result jsonb; v_now timestamptz := clock_timestamp();
begin
  if auth.uid() is null or public.is_product_lab_owner() is not true then
    raise exception 'Only the product lab owner may post a purchase' using errcode = '42501';
  end if;
  if p_pack_quantity is null or p_pack_quantity <= 0 then
    raise exception 'Pack quantity must be greater than zero' using errcode = '22023';
  end if;
  if p_base_quantity is null or p_base_quantity <= 0 or p_base_quantity::text in ('NaN','Infinity','-Infinity') then
    raise exception 'Purchase quantity must be a positive, finite number' using errcode = '22023';
  end if;
  if p_total_cost is null or p_total_cost < 0 or p_total_cost::text in ('NaN','Infinity','-Infinity') then
    raise exception 'Purchase cost cannot be negative' using errcode = '22023';
  end if;
  if p_supplier_name is null or length(trim(p_supplier_name)) = 0 then
    raise exception 'Supplier is required' using errcode = '22023';
  end if;

  v_hash := md5(concat_ws('|', p_ingredient_id, p_pack_quantity, p_display_unit, p_base_quantity,
    p_total_cost, p_brand_name, p_supplier_name, p_purchase_date, p_quality_rating, p_notes));
  v_replay := inventory_private.claim_mutation(p_operation_id, 'purchase_manual', v_hash);
  if v_replay is not null then return v_replay; end if;

  select * into i from public.ingredients where id = p_ingredient_id for update;
  if not found then raise exception 'Item not found'; end if;
  if i.inventory_reconciled_at is null then
    raise exception 'Verify the physical stock of "%" before posting a purchase for it.', i.name using errcode = '23514';
  end if;

  v_has_price := p_total_cost > 0;
  v_qty_before := i.current_quantity;
  v_qty_after := v_qty_before + p_base_quantity;
  if v_qty_after <= 0 then
    v_new_avg := coalesce(i.average_unit_cost, 0);
  else
    v_new_avg := (v_qty_before * coalesce(i.average_unit_cost, 0)
      + case when v_has_price then p_total_cost else p_base_quantity * coalesce(i.average_unit_cost, 0) end)
      / v_qty_after;
  end if;

  insert into public.supply_entries (ingredient_id, ingredient_name, brand_name, supplier_name,
    purchase_date, pack_quantity, unit, total_cost, quality_rating, notes)
  values (i.id, i.name, nullif(trim(coalesce(p_brand_name, '')), ''), trim(p_supplier_name),
    coalesce(p_purchase_date, current_date), p_pack_quantity, p_display_unit, p_total_cost,
    coalesce(p_quality_rating, 0), nullif(trim(coalesce(p_notes, '')), ''))
  returning id into v_supply_id;

  insert into public.inventory_transactions (ingredient_id, transaction_type, quantity_change,
    quantity_before, quantity_after, source_type, source_id, note, created_at)
  values (i.id, 'purchase', p_base_quantity, v_qty_before, v_qty_after, 'manual', v_supply_id::text, '', v_now)
  returning id into v_tx_id;

  update public.ingredients set current_quantity = v_qty_after, average_unit_cost = v_new_avg, updated_at = v_now
    where id = i.id;

  v_result := jsonb_build_object('supply_id', v_supply_id, 'transaction_id', v_tx_id,
    'quantity_after', v_qty_after, 'average_unit_cost', v_new_avg);
  update inventory_private.mutation_receipts set result = v_result where operation_id = p_operation_id;
  return v_result;
end;
$$;
revoke all on function inventory_private.post_raw_purchase(uuid,uuid,numeric,text,numeric,numeric,text,text,date,numeric,text)
  from public, anon, authenticated;
-- The public wrapper is security invoker, so calling it as `authenticated` still calls this
-- private function under the same invoking role -- it needs its own execute grant even though
-- its body runs as the definer once inside (same pattern as Wave 0A's own private adjustment fn).
grant execute on function inventory_private.post_raw_purchase(uuid,uuid,numeric,text,numeric,numeric,text,text,date,numeric,text)
  to authenticated;

create or replace function public.post_raw_purchase(
  p_operation_id uuid, p_ingredient_id uuid, p_pack_quantity numeric, p_display_unit text,
  p_base_quantity numeric, p_total_cost numeric, p_brand_name text, p_supplier_name text,
  p_purchase_date date, p_quality_rating numeric, p_notes text
) returns jsonb language sql security invoker set search_path = '' as $$
  select inventory_private.post_raw_purchase(p_operation_id, p_ingredient_id, p_pack_quantity,
    p_display_unit, p_base_quantity, p_total_cost, p_brand_name, p_supplier_name, p_purchase_date,
    p_quality_rating, p_notes);
$$;
revoke all on function public.post_raw_purchase(uuid,uuid,numeric,text,numeric,numeric,text,text,date,numeric,text)
  from public, anon, authenticated;
grant execute on function public.post_raw_purchase(uuid,uuid,numeric,text,numeric,numeric,text,text,date,numeric,text)
  to authenticated;

-- Once a purchase has a ledger effect, its quantity/unit/cost/item are historical fact. Only
-- non-inventory-affecting metadata may still be edited -- deliberately a separate, tiny function
-- rather than a general update, so there is no path (grant, trigger exception, or otherwise) that
-- lets an ordinary edit silently rewrite an already-applied quantity or cost.
create or replace function inventory_private.update_posted_purchase_metadata(
  p_supply_id uuid, p_brand_name text, p_supplier_name text, p_purchase_date date,
  p_quality_rating numeric, p_notes text
) returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or public.is_product_lab_owner() is not true then
    raise exception 'Only the product lab owner may edit a purchase' using errcode = '42501';
  end if;
  if p_supplier_name is null or length(trim(p_supplier_name)) = 0 then
    raise exception 'Supplier is required' using errcode = '22023';
  end if;
  update public.supply_entries set
    brand_name = nullif(trim(coalesce(p_brand_name, '')), ''),
    supplier_name = trim(p_supplier_name),
    purchase_date = coalesce(p_purchase_date, purchase_date),
    quality_rating = coalesce(p_quality_rating, quality_rating),
    notes = nullif(trim(coalesce(p_notes, '')), ''),
    updated_at = clock_timestamp()
  where id = p_supply_id;
  if not found then raise exception 'Purchase not found'; end if;
end;
$$;
revoke all on function inventory_private.update_posted_purchase_metadata(uuid,text,text,date,numeric,text)
  from public, anon, authenticated;
grant execute on function inventory_private.update_posted_purchase_metadata(uuid,text,text,date,numeric,text)
  to authenticated;

create or replace function public.update_posted_purchase_metadata(
  p_supply_id uuid, p_brand_name text, p_supplier_name text, p_purchase_date date,
  p_quality_rating numeric, p_notes text
) returns void language sql security invoker set search_path = '' as $$
  select inventory_private.update_posted_purchase_metadata(p_supply_id, p_brand_name,
    p_supplier_name, p_purchase_date, p_quality_rating, p_notes);
$$;
revoke all on function public.update_posted_purchase_metadata(uuid,text,text,date,numeric,text)
  from public, anon, authenticated;
grant execute on function public.update_posted_purchase_metadata(uuid,text,text,date,numeric,text)
  to authenticated;

-- ============================================================================================
-- 4. CSV purchase import confirmation. Reads the already-persisted, already-reviewed draft rows
-- itself -- the client sends only an operation id and the import id, nothing computed. Same
-- weighted-average formula as manual posting; one combined ledger row per affected ingredient,
-- matching the pre-Wave-0A behavior. All-or-nothing: any unsafe row, or any touched ingredient
-- without a trusted opening count, rejects the whole confirm before anything is written.
-- ============================================================================================
create or replace function inventory_private.confirm_purchase_import_v2(
  p_operation_id uuid, p_import_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_hash text; v_replay jsonb; v_import public.purchase_imports%rowtype;
  v_bad_row jsonb; v_unreconciled text; v_ids uuid[];
  i public.ingredients%rowtype; v_row record;
  v_added numeric; v_added_priced numeric; v_added_cost numeric; v_added_unpriced numeric;
  v_new_avg numeric; v_earliest date; v_qty_before numeric; v_qty_after numeric;
  v_tx_id uuid; v_tx_ids uuid[] := '{}'; v_result jsonb; v_now timestamptz := clock_timestamp();
begin
  if auth.uid() is null or public.is_product_lab_owner() is not true then
    raise exception 'Only the product lab owner may confirm a purchase import' using errcode = '42501';
  end if;

  v_hash := md5(p_import_id::text);
  v_replay := inventory_private.claim_mutation(p_operation_id, 'purchase_import', v_hash);
  if v_replay is not null then return v_replay; end if;

  select * into v_import from public.purchase_imports where id = p_import_id for update;
  if not found then raise exception 'Purchase import not found'; end if;
  if v_import.status <> 'draft' then
    raise exception 'This import is already % and cannot be confirmed again.', v_import.status using errcode = '40001';
  end if;

  if not exists (select 1 from public.purchase_import_rows where import_id = p_import_id and row_status <> 'excluded') then
    raise exception 'No rows to confirm -- every row was excluded.';
  end if;

  select to_jsonb(ir) into v_bad_row
  from public.purchase_import_rows ir
  where ir.import_id = p_import_id and ir.row_status <> 'excluded'
    and (ir.row_status <> 'matched' or ir.ingredient_id is null
      or ir.match_method in ('none', 'suggested') or coalesce(ir.converted_quantity, 0) <= 0
      or not exists (select 1 from public.ingredients ing where ing.id = ir.ingredient_id))
  limit 1;
  if v_bad_row is not null then
    raise exception 'Row "%" is not ready to confirm; resolve or exclude it first.', v_bad_row->>'raw_item_name' using errcode = '22023';
  end if;

  select string_agg(distinct ing.name, ', ') into v_unreconciled
  from public.purchase_import_rows ir join public.ingredients ing on ing.id = ir.ingredient_id
  where ir.import_id = p_import_id and ir.row_status <> 'excluded' and ing.inventory_reconciled_at is null;
  if v_unreconciled is not null then
    raise exception 'Verify the physical stock of the following Item(s) before posting this import: %.', v_unreconciled using errcode = '23514';
  end if;

  select array_agg(distinct ingredient_id) into v_ids
  from public.purchase_import_rows where import_id = p_import_id and row_status <> 'excluded';

  -- Flip status to confirmed now, while old.status is still 'draft' and no ledger row yet
  -- references this import -- protect_posted_import's read-only guard would otherwise see this
  -- import's own about-to-be-inserted ledger rows and mistake this for editing an already-posted
  -- import. Locking every ingredient happens after, so a failure past this point still rolls the
  -- status change back with everything else (this is one transaction). The authorization flag is
  -- turned off again immediately after this one statement, not left set for the rest of the
  -- transaction -- `true` (is_local) only guarantees it resets at transaction end, which would
  -- otherwise leave a window where a later statement in the same transaction could reuse it.
  perform set_config('inventory_private.posting_authorized', 'on', true);
  update public.purchase_imports set status = 'confirmed', imported_at = v_now, updated_at = v_now where id = p_import_id;
  perform set_config('inventory_private.posting_authorized', 'off', true);

  for i in select * from public.ingredients where id = any(v_ids) order by id for update
  loop
    select
      coalesce(sum(ir.converted_quantity), 0),
      coalesce(sum(ir.converted_quantity) filter (where ir.parsed_total_price > 0), 0),
      coalesce(sum(ir.parsed_total_price) filter (where ir.parsed_total_price > 0), 0)
    into v_added, v_added_priced, v_added_cost
    from public.purchase_import_rows ir
    where ir.import_id = p_import_id and ir.row_status <> 'excluded' and ir.ingredient_id = i.id;

    v_added_unpriced := v_added - v_added_priced;
    v_qty_before := i.current_quantity;
    v_qty_after := v_qty_before + v_added;
    if (v_qty_before + v_added_priced + v_added_unpriced) <= 0 then
      v_new_avg := coalesce(i.average_unit_cost, 0);
    else
      v_new_avg := (v_qty_before * coalesce(i.average_unit_cost, 0) + v_added_cost + v_added_unpriced * coalesce(i.average_unit_cost, 0))
        / (v_qty_before + v_added_priced + v_added_unpriced);
    end if;

    select least(min(ir.parsed_expiration_date), i.nearest_expiration_date) into v_earliest
    from public.purchase_import_rows ir
    where ir.import_id = p_import_id and ir.row_status <> 'excluded' and ir.ingredient_id = i.id;

    insert into public.inventory_transactions (ingredient_id, transaction_type, quantity_change,
      quantity_before, quantity_after, source_type, source_id, note, created_at)
    values (i.id, 'purchase', v_added, v_qty_before, v_qty_after, 'purchase_import', p_import_id::text, '', v_now)
    returning id into v_tx_id;
    v_tx_ids := v_tx_ids || v_tx_id;

    update public.ingredients set current_quantity = v_qty_after, average_unit_cost = v_new_avg,
      nearest_expiration_date = v_earliest, updated_at = v_now
      where id = i.id;
  end loop;

  -- Display-only purchase records, one per applicable row -- mirrors
  -- buildSupplyEntriesFromPurchaseImport's intent, not its exact note-string formatting.
  for v_row in
    select ir.*, ing.name as ingredient_name
    from public.purchase_import_rows ir join public.ingredients ing on ing.id = ir.ingredient_id
    where ir.import_id = p_import_id and ir.row_status <> 'excluded'
  loop
    insert into public.supply_entries (ingredient_id, ingredient_name, brand_name, supplier_name,
      purchase_date, pack_quantity, unit, total_cost, quality_rating, notes)
    values (
      v_row.ingredient_id, v_row.ingredient_name, nullif(trim(coalesce(v_row.brand_name, '')), ''),
      coalesce(nullif(trim(v_row.raw_supplier), ''), nullif(trim(v_import.supplier_name), ''), ''),
      coalesce(nullif(v_row.raw_purchase_date, '')::date, v_import.purchase_date, current_date),
      coalesce(v_row.parsed_quantity, 0), coalesce(nullif(v_row.raw_package_unit, ''), v_row.raw_unit),
      coalesce(v_row.parsed_total_price, 0), 0,
      concat_ws(' -- ', 'Imported via CSV', nullif(trim(v_row.raw_category), ''),
        case when coalesce(nullif(trim(v_row.raw_receipt_number), ''), nullif(trim(v_import.receipt_number), '')) is not null
          then 'receipt ' || coalesce(nullif(trim(v_row.raw_receipt_number), ''), v_import.receipt_number) end)
    );
  end loop;

  v_result := jsonb_build_object('import_id', p_import_id, 'transaction_ids', to_jsonb(v_tx_ids));
  update inventory_private.mutation_receipts set result = v_result where operation_id = p_operation_id;
  return v_result;
end;
$$;
revoke all on function inventory_private.confirm_purchase_import_v2(uuid,uuid) from public, anon, authenticated;
grant execute on function inventory_private.confirm_purchase_import_v2(uuid,uuid) to authenticated;

create or replace function public.confirm_purchase_import_v2(p_operation_id uuid, p_import_id uuid)
returns jsonb language sql security invoker set search_path = '' as $$
  select inventory_private.confirm_purchase_import_v2(p_operation_id, p_import_id);
$$;
revoke all on function public.confirm_purchase_import_v2(uuid,uuid) from public, anon, authenticated;
grant execute on function public.confirm_purchase_import_v2(uuid,uuid) to authenticated;

-- ============================================================================================
-- 5. Bake raw consumption only -- no finished stock is created here. p_deductions is the already
-- -resolved {ingredient_id, quantity}[] list (formula lookup, alias resolution, and unit
-- conversion all already happen client-side, exactly as CSV import's converted_quantity already
-- does -- see post_raw_purchase's own comment for why that line is drawn there). The database
-- locks every affected ingredient in one deterministic pass (order by id, same as the import
-- confirm above, so a Bake and a CSV confirm racing over a shared ingredient can never deadlock
-- each other), then requires a trusted opening count and sufficient stock for every one of them
-- before touching any of them. There is no negative-stock override in this function -- Wave 0B
-- does not allow production Bake to go negative, unlike the local-only demo checkbox.
-- ============================================================================================
create or replace function inventory_private.confirm_bake_v2(
  p_operation_id uuid, p_batch_id text, p_batch_label text, p_multiplier numeric, p_deductions jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_hash text; v_replay jsonb; v_note text; v_now timestamptz := clock_timestamp();
  v_ids uuid[]; v_total_count integer; v_matched_count integer; v_distinct_count integer;
  v_unreconciled text; v_short text; d record; i record;
  v_before numeric; v_after numeric; v_tx_id uuid; v_tx_ids uuid[] := '{}'; v_result jsonb;
begin
  if auth.uid() is null or public.is_product_lab_owner() is not true then
    raise exception 'Only the product lab owner may confirm a Bake' using errcode = '42501';
  end if;
  if p_multiplier is null or p_multiplier <= 0 then
    raise exception 'Batches made must be a number greater than zero' using errcode = '22023';
  end if;
  if p_batch_id is null or length(trim(p_batch_id)) = 0 then
    raise exception 'A batch is required' using errcode = '22023';
  end if;
  if p_deductions is null or jsonb_typeof(p_deductions) <> 'array' or jsonb_array_length(p_deductions) = 0 then
    raise exception 'No ingredients to deduct' using errcode = '22023';
  end if;

  select count(*), count(distinct elem->>'ingredient_id')
  into v_total_count, v_distinct_count
  from jsonb_array_elements(p_deductions) as elem;
  if v_distinct_count <> v_total_count then
    raise exception 'Duplicate Item in Bake deductions' using errcode = '22023';
  end if;

  v_hash := md5(concat_ws('|', p_batch_id, p_multiplier, p_deductions::text));
  v_replay := inventory_private.claim_mutation(p_operation_id, 'bake_consume', v_hash);
  if v_replay is not null then return v_replay; end if;

  select array_agg((elem->>'ingredient_id')::uuid) into v_ids from jsonb_array_elements(p_deductions) as elem;

  select count(*) into v_matched_count from public.ingredients where id = any(v_ids);
  if v_matched_count <> v_total_count then
    raise exception 'One of the resolved Items could not be found' using errcode = '22023';
  end if;

  -- Acquire every lock, in one deterministic order, before any check or write.
  perform id from public.ingredients where id = any(v_ids) order by id for update;

  select string_agg(distinct ing.name, ', ') into v_unreconciled
  from public.ingredients ing where ing.id = any(v_ids) and ing.inventory_reconciled_at is null;
  if v_unreconciled is not null then
    raise exception 'Verify the physical stock of the following Item(s) before this Bake can consume them: %.', v_unreconciled using errcode = '23514';
  end if;

  select string_agg(format('%s (have %s, need %s)', ing.name, ing.current_quantity, dd.quantity), '; ') into v_short
  from (select (elem->>'ingredient_id')::uuid as ingredient_id, (elem->>'quantity')::numeric as quantity
        from jsonb_array_elements(p_deductions) as elem) dd
  join public.ingredients ing on ing.id = dd.ingredient_id
  where dd.quantity > ing.current_quantity;
  if v_short is not null then
    raise exception 'Not enough stock for this Bake: %.', v_short using errcode = '23514';
  end if;

  v_note := format('Bake: %s x%s', coalesce(p_batch_label, ''), p_multiplier);

  for d in select (elem->>'ingredient_id')::uuid as ingredient_id, (elem->>'quantity')::numeric as quantity
    from jsonb_array_elements(p_deductions) as elem order by (elem->>'ingredient_id')::uuid
  loop
    select current_quantity into v_before from public.ingredients where id = d.ingredient_id;
    v_after := v_before - d.quantity;

    insert into public.inventory_transactions (ingredient_id, transaction_type, quantity_change,
      quantity_before, quantity_after, source_type, source_id, note, created_at)
    values (d.ingredient_id, 'consume', -d.quantity, v_before, v_after, 'bake', p_batch_id, v_note, v_now)
    returning id into v_tx_id;
    v_tx_ids := v_tx_ids || v_tx_id;

    update public.ingredients set current_quantity = v_after, updated_at = v_now where id = d.ingredient_id;
  end loop;

  v_result := jsonb_build_object('batch_id', p_batch_id, 'transaction_ids', to_jsonb(v_tx_ids));
  update inventory_private.mutation_receipts set result = v_result where operation_id = p_operation_id;
  return v_result;
end;
$$;
revoke all on function inventory_private.confirm_bake_v2(uuid,text,text,numeric,jsonb) from public, anon, authenticated;
grant execute on function inventory_private.confirm_bake_v2(uuid,text,text,numeric,jsonb) to authenticated;

create or replace function public.confirm_bake_v2(
  p_operation_id uuid, p_batch_id text, p_batch_label text, p_multiplier numeric, p_deductions jsonb
) returns jsonb language sql security invoker set search_path = '' as $$
  select inventory_private.confirm_bake_v2(p_operation_id, p_batch_id, p_batch_label, p_multiplier, p_deductions);
$$;
revoke all on function public.confirm_bake_v2(uuid,text,text,numeric,jsonb) from public, anon, authenticated;
grant execute on function public.confirm_bake_v2(uuid,text,text,numeric,jsonb) to authenticated;

notify pgrst, 'reload schema';
