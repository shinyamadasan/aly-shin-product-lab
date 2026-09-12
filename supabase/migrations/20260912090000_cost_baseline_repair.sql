-- Cost Baseline Repair (Stage A): durable cost-ready state, an owner-only certification RPC, a
-- server-side Bake guard, and a bounded one-time auto-backfill for ingredients whose current
-- average_unit_cost is already provably clean.
--
-- Origin: a live launch-rehearsal Bake (Blondies V3, 2026-09-12) froze PHP 1,240.24 of raw
-- ingredient cost against a saved Costing snapshot of PHP 726.72. Root cause: every purchase
-- behind this recipe was posted through the legacy, pre-Wave-0A `save_supply_with_inventory_effect`
-- (security invoker, client-computed absolute balance -- see supabase-add-manual-purchase-
-- inventory-effect.sql) six to seven weeks before Wave 0A/0B/1 existed. Wave 0A's own reconciliation
-- (`inventory_reconciled_at`) is a QUANTITY gate only -- it deliberately never touches
-- `average_unit_cost` (see that migration's own "Preserve existing rows, including discrepancies"
-- comment) -- so a corrupted cost survives every physical count untouched, and `confirm_bake_v3`
-- has no way today to tell a certified cost apart from a merely-present one. Full forensic detail:
-- COST_BASELINE_REPAIR_AUDIT_REPORT.md (this repo, kept local -- not part of any product doc set).
--
-- This migration does NOT redesign inventory costing, does NOT add accounting/P&L, does NOT touch
-- purchase posting logic, and does NOT mutate any production_execution. It adds exactly one new
-- durable fact (cost_reconciled_at), one owner-only RPC that can set it, one guard in
-- confirm_bake_v3 that requires it, and one bounded backfill so the guard's rollout does not block
-- every other product's Bake on deploy.
--
-- NOT APPLIED. Created with `supabase migration new`; leave unapplied until independent review.
-- Integration tests run against disposable Postgres containers only (see
-- tests/smoke/postgres/cost-baseline-repair.smoke.test.ts).
do $$
begin
  if to_regprocedure('inventory_private.confirm_bake_v3(uuid,uuid,text,text,numeric,numeric,jsonb)') is null
     or to_regclass('inventory_private.mutation_receipts') is null
     or to_regclass('public.ingredients') is null
     or to_regclass('public.supply_entries') is null then
    raise exception 'Cost Baseline Repair requires Wave 0A/0B (ingredients, mutation_receipts) and Wave 1 (confirm_bake_v3)';
  end if;
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'ingredients' and column_name = 'cost_reconciled_at'
  ) then
    raise exception 'Cost Baseline Repair objects already exist; this migration must not be re-applied over itself';
  end if;
end;
$$;

-- ============================================================================================
-- 1. Durable cost-ready state. Mirrors ingredients.inventory_reconciled_at exactly -- a nullable
-- timestamp set only by a guarded owner-only RPC, checked by a raise-exception gate in the one
-- function that spends it. Quantity truth (inventory_reconciled_at) and cost truth
-- (cost_reconciled_at) are two independent facts about the same row; neither write path touches
-- the other's column, and this migration keeps that true by construction (no existing RPC below is
-- changed to write cost_reconciled_at except the one new certification RPC).
--
-- A non-null average_unit_cost is NOT evidence of trust on its own -- the whole incident this
-- migration repairs is a syntactically valid, non-null, positive number (PHP 167.97/pc for Egg)
-- that was still wrong by 16.8x. This column exists so "a cost exists" and "a cost was verified"
-- are no longer the same bit.
-- ============================================================================================
alter table public.ingredients add column cost_reconciled_at timestamptz;

comment on column public.ingredients.cost_reconciled_at is
  'Set by inventory_private.certify_ingredient_cost_baseline (the owner certification RPC) or by the one-time inventory_private.backfill_clean_cost_baselines migration-time backfill, for an ingredient whose current cost is already provably clean. Null means average_unit_cost has not been owner-certified against real purchase evidence and must not be trusted merely because it is non-null or positive. Not cleared by a legitimate purchase (post_raw_purchase / confirm_purchase_import_v2 compute the new weighted average from the already-certified prior value) or by a physical count that finds the same or less stock than the ledger explains. IS cleared by apply_raw_inventory_adjustment when a physical count (mode = ''count'') finds MORE stock than the ledger explains -- that surplus has no evidenced cost of its own, so a previously certified per-unit price can no longer honestly be asserted over the new, larger quantity. See that function''s own comment for the exact rule.';

-- ============================================================================================
-- 2. Cost-certification ledger event. inventory_transactions.transaction_type and source_type
-- have no CHECK constraint (see supabase-add-inventory.sql) -- 'cost_certification' / 'manual' are
-- safe, additive values, not a semantic override of an existing one. quantity_change stays exactly
-- 0 and quantity_before/quantity_after stay exactly the ingredient's own current_quantity
-- (unchanged) -- this event never claims a quantity effect, only a cost one.
--
-- The one thing the existing ledger cannot honestly represent is "what was the cost before/after
-- this certification" -- quantity_before/quantity_after are typed and named for QUANTITY, and
-- reconciliation_snapshot (added Wave 0A) is deliberately quantity-branded: its own only producer,
-- apply_raw_inventory_adjustment's count mode, uses it as a marker to distinguish a count
-- correction from an ordinary adjustment (see that function's reversal guard, which checks
-- `reconciliation_snapshot is not null`). Storing a cost-certification payload in a column named
-- for quantity reconciliation would be exactly the "misleading meaning" this task was told to
-- avoid, and would silently interact with that existing reversal guard. The smallest honest
-- alternative -- one new, narrowly-scoped, nullable jsonb column, used by no other transaction_type
-- -- is added instead of a new table.
-- ============================================================================================
alter table public.inventory_transactions add column cost_certification_snapshot jsonb;

comment on column public.inventory_transactions.cost_certification_snapshot is
  'Set only on transaction_type = ''cost_certification'' rows: {previous_average_unit_cost, certified_unit_cost, previous_cost_reconciled_at}. Null for every other transaction_type. Kept separate from reconciliation_snapshot, which is quantity-specific (see that column''s own use in apply_raw_inventory_adjustment''s reversal guard).';

-- ============================================================================================
-- 3. certify_ingredient_cost_baseline -- the cost-side mirror of Wave 0A's
-- apply_raw_inventory_adjustment. Same shape: security definer, fixed empty search_path, owner-
-- only, one ingredient locked FOR UPDATE, optimistic-concurrency expected-value check, a required
-- non-empty evidence note, one audit row. Writes ONLY average_unit_cost / cost_reconciled_at /
-- updated_at -- never current_quantity, never inventory_reconciled_at, never purchase history.
--
-- No claim_mutation/operation_id: this is a rare, owner-driven, single-row action in the same
-- class as apply_raw_inventory_adjustment (which also has no operation_id) -- not a high-frequency,
-- network-retry-prone path like post_raw_purchase/confirm_bake_v3. The optimistic-concurrency
-- expected-value check alone is the correct, precedented safeguard for this class.
-- ============================================================================================
create or replace function inventory_private.certify_ingredient_cost_baseline(
  p_ingredient_id uuid,
  p_certified_unit_cost numeric,
  p_evidence_note text,
  p_expected_current_cost numeric,
  p_expected_quantity numeric,
  p_expected_latest_id uuid
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  i public.ingredients%rowtype;
  latest public.inventory_transactions%rowtype;
  v_time timestamptz;
  v_snapshot jsonb;
  v_id uuid;
begin
  if auth.uid() is null or public.is_product_lab_owner() is not true then
    raise exception 'Only the product lab owner may certify an ingredient cost baseline' using errcode = '42501';
  end if;
  if p_ingredient_id is null then
    raise exception 'An ingredient is required' using errcode = '22023';
  end if;
  if p_certified_unit_cost is null or p_certified_unit_cost::text = any(array['NaN','Infinity','-Infinity'])
     or p_certified_unit_cost <= 0 then
    raise exception 'Certified unit cost must be a positive, finite number' using errcode = '22023';
  end if;
  if p_evidence_note is null or length(trim(p_evidence_note)) = 0 then
    raise exception 'A note describing the evidence for this cost is required' using errcode = '22023';
  end if;

  select * into i from public.ingredients where id = p_ingredient_id for update;
  if not found then
    raise exception 'Ingredient not found' using errcode = '22023';
  end if;

  select * into latest from public.inventory_transactions where ingredient_id = i.id
    order by created_at desc, id desc limit 1;

  if i.current_quantity is distinct from p_expected_quantity
     or latest.id is distinct from p_expected_latest_id
     or i.average_unit_cost is distinct from p_expected_current_cost then
    raise exception 'Cost baseline changed. Reload and verify the cost again.' using errcode = '40001';
  end if;

  v_time := clock_timestamp();
  v_snapshot := jsonb_build_object(
    'previous_average_unit_cost', i.average_unit_cost,
    'certified_unit_cost', p_certified_unit_cost,
    'previous_cost_reconciled_at', i.cost_reconciled_at
  );

  insert into public.inventory_transactions (
    ingredient_id, transaction_type, quantity_change, quantity_before, quantity_after,
    source_type, source_id, reason, actor, note, created_at, cost_certification_snapshot
  ) values (
    i.id, 'cost_certification', 0, i.current_quantity, i.current_quantity,
    'manual', null, 'cost_certification', auth.uid()::text, trim(p_evidence_note), v_time, v_snapshot
  ) returning id into v_id;

  update public.ingredients
    set average_unit_cost = p_certified_unit_cost, cost_reconciled_at = v_time, updated_at = v_time
    where id = i.id;

  return v_id;
end;
$$;
revoke all on function inventory_private.certify_ingredient_cost_baseline(uuid,numeric,text,numeric,numeric,uuid)
  from public, anon, authenticated;
grant execute on function inventory_private.certify_ingredient_cost_baseline(uuid,numeric,text,numeric,numeric,uuid)
  to authenticated;

create or replace function public.certify_ingredient_cost_baseline(
  p_ingredient_id uuid,
  p_certified_unit_cost numeric,
  p_evidence_note text,
  p_expected_current_cost numeric,
  p_expected_quantity numeric,
  p_expected_latest_id uuid
) returns uuid language sql security invoker set search_path = '' as $$
  select inventory_private.certify_ingredient_cost_baseline(
    p_ingredient_id, p_certified_unit_cost, p_evidence_note,
    p_expected_current_cost, p_expected_quantity, p_expected_latest_id);
$$;
revoke all on function public.certify_ingredient_cost_baseline(uuid,numeric,text,numeric,numeric,uuid)
  from public, anon, authenticated;
grant execute on function public.certify_ingredient_cost_baseline(uuid,numeric,text,numeric,numeric,uuid)
  to authenticated;

-- ============================================================================================
-- 4. apply_raw_inventory_adjustment gains one rule: a positive physical count (mode = 'count',
-- found MORE stock than the ledger explains) clears cost_reconciled_at. Found empirically, not
-- hypothetically, during independent review: without this, an ingredient could be certified at
-- quantity 100 / cost 10, then a physical count could report 200 with no purchase or adjustment
-- of any kind explaining the other 100 units, and the system would keep asserting the full 200
-- units are certified at the original per-unit price -- exactly the kind of unevidenced-cost claim
-- this entire repair exists to eliminate, just recurring one level up.
--
-- The asymmetry is deliberate and matches this migration's own certified-cost model:
--   - v_delta > 0 (found MORE than the ledger explains): new, unpriced units just entered
--     inventory with no evidence of what they cost -- cost_reconciled_at is cleared. average_unit_cost
--     itself is left untouched (it remains useful historical/context information; only its
--     CERTIFICATION is revoked) -- the owner re-certifies through the exact same generic RPC,
--     with the new expected_quantity, no special repair path needed.
--   - v_delta <= 0 (found the SAME or FEWER units than the ledger explains, i.e. shrinkage or an
--     exact-match recount): the remaining units are the SAME already-evidenced units, merely fewer
--     of them (or exactly as many) -- nothing new needs verifying, so cost_reconciled_at survives
--     unchanged, exactly as it already did before this fix.
--   - mode = 'delta' or mode = 'reverse': untouched. Only a physical count can discover
--     previously-unknown stock; a delta adjustment (household use, waste, spillage, a recipe test)
--     only ever removes stock, and a reversal only undoes an ordinary adjustment -- neither can
--     ever introduce unevidenced units, so neither has any reason to affect cost certification.
--
-- Every line above the final UPDATE statement is byte-identical to Wave 0A's original function
-- (supabase/migrations/20260909132327_selling_wave_0a_raw_authority.sql) -- this is a
-- create-or-replace of the same signature adding one conditional column to one existing UPDATE,
-- not a redesign, matching the same discipline already applied to confirm_bake_v3 below.
-- ============================================================================================
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
  -- Cost Baseline Repair: a positive count (v_delta > 0 under mode = 'count') found MORE stock
  -- than the ledger explains -- those extra units have no evidenced cost, so certification is
  -- revoked (cost_reconciled_at -> null) even though average_unit_cost itself is left untouched.
  -- Every other case (shrinkage, exact-match recount, delta, reverse) leaves cost_reconciled_at
  -- exactly as it already was.
  update public.ingredients set current_quantity = v_after, updated_at = v_time,
    inventory_reconciled_at = case when p_mode = 'count' then v_time else inventory_reconciled_at end,
    cost_reconciled_at = case when p_mode = 'count' and v_delta > 0 then null else cost_reconciled_at end
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

-- ============================================================================================
-- 5. confirm_bake_v3 gains one guard, placed before any write (raw deduction, production
-- execution, finished-stock receipt, or mutation-receipt finalization): every ingredient in the
-- deduction list must be cost-certified, non-null, and positive. This is the exact template
-- already used two lines below it for the inventory_reconciled_at (quantity) gate --
-- string_agg(distinct ing.name) + raise exception '23514' -- so a Bake blocked on cost reads
-- exactly like a Bake blocked on an unverified count.
--
-- This makes `coalesce(ing.average_unit_cost, 0)` in the cost-freeze query below unreachable with
-- an uncertified/null/non-positive cost on a successful Bake -- proven by the Bake-guard smoke
-- tests, not just asserted. The coalesce itself is left in place as an explicit "this arithmetic
-- can never see a null here" statement rather than replaced with a second silent fallback.
--
-- Everything else in this function is byte-for-byte the same Wave 1 body (see
-- supabase/migrations/20260910120146_selling_wave_1_production_execution.sql) -- this is a
-- create-or-replace of the same signature, not a redesign.
-- ============================================================================================
create or replace function inventory_private.confirm_bake_v3(
  p_operation_id uuid, p_batch_id uuid, p_product_id text, p_batch_label text,
  p_multiplier numeric, p_actual_pieces_produced numeric, p_deductions jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_hash text; v_replay jsonb; v_now timestamptz := clock_timestamp();
  v_batch public.product_batches%rowtype;
  v_ids uuid[]; v_total_count integer; v_matched_count integer; v_distinct_count integer;
  v_unreconciled text; v_uncertified text; v_short text; d record;
  v_before numeric; v_after numeric; v_tx_id uuid; v_tx_ids uuid[] := '{}';
  v_pieces integer; v_expected_pieces integer; v_cost_total numeric; v_cost_per_piece numeric;
  v_note text; v_exec_id uuid; v_fsm_id uuid; v_result jsonb;
begin
  if auth.uid() is null or public.is_product_lab_owner() is not true then
    raise exception 'Only the product lab owner may confirm a Bake' using errcode = '42501';
  end if;
  if p_multiplier is null or p_multiplier::text = any(array['NaN','Infinity','-Infinity'])
     or p_multiplier <= 0 then
    raise exception 'Batches made must be a number greater than zero' using errcode = '22023';
  end if;
  if p_actual_pieces_produced is null then
    raise exception 'Enter the actual usable pieces produced for this Bake' using errcode = '22023';
  end if;
  if p_actual_pieces_produced::text = any(array['NaN','Infinity','-Infinity'])
     or p_actual_pieces_produced <> trunc(p_actual_pieces_produced)
     or p_actual_pieces_produced < 1 then
    raise exception 'Actual usable pieces produced must be a whole number of at least 1' using errcode = '22023';
  end if;
  if p_batch_id is null then raise exception 'A batch is required' using errcode = '22023'; end if;
  if p_product_id is null or length(trim(p_product_id)) = 0 then
    raise exception 'A product is required' using errcode = '22023';
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

  v_hash := md5(concat_ws('|', p_batch_id::text, p_product_id, p_multiplier,
    p_actual_pieces_produced, p_deductions::text));
  v_replay := inventory_private.claim_mutation(p_operation_id, 'bake_produce', v_hash);
  if v_replay is not null then return v_replay; end if;

  -- Resolve and lock the recipe/version. The lock also serializes two Bakes of the same batch.
  select * into v_batch from public.product_batches where id = p_batch_id for update;
  if not found then raise exception 'Batch not found' using errcode = '22023'; end if;
  if v_batch.product_id is distinct from p_product_id then
    raise exception 'This batch does not belong to the given product' using errcode = '22023';
  end if;
  if v_batch.voided_at is not null or v_batch.status = 'voided' then
    raise exception 'This batch is voided and cannot be baked' using errcode = '22023';
  end if;
  if not exists (select 1 from public.products where id = p_product_id) then
    raise exception 'Product not found' using errcode = '22023';
  end if;
  if v_batch.usable_pieces is null or v_batch.usable_pieces <= 0 then
    raise exception 'This recipe version has no usable-pieces yield recorded. Set it on the batch before baking for production.' using errcode = '22023';
  end if;

  v_expected_pieces := round(v_batch.usable_pieces * p_multiplier)::integer;
  v_pieces := p_actual_pieces_produced::integer;

  select array_agg((elem->>'ingredient_id')::uuid) into v_ids from jsonb_array_elements(p_deductions) as elem;
  select count(*) into v_matched_count from public.ingredients where id = any(v_ids);
  if v_matched_count <> v_total_count then
    raise exception 'One of the resolved Items could not be found' using errcode = '22023';
  end if;

  -- Lock every affected ingredient in one deterministic order, before any check or write.
  perform id from public.ingredients where id = any(v_ids) order by id for update;

  select string_agg(distinct ing.name, ', ') into v_unreconciled
  from public.ingredients ing where ing.id = any(v_ids) and ing.inventory_reconciled_at is null;
  if v_unreconciled is not null then
    raise exception 'Verify the physical stock of the following Item(s) before this Bake can consume them: %.', v_unreconciled using errcode = '23514';
  end if;

  -- Cost-readiness gate (Cost Baseline Repair). A non-null, positive average_unit_cost is not
  -- sufficient on its own -- it must also have been owner-certified. This is what makes an Egg-
  -- class defect (a syntactically valid, non-null, positive but wrong cost) unreachable, not just
  -- the null/zero case Biscoff Spread/White Chocolate Buttons already showed.
  select string_agg(distinct ing.name, ', ') into v_uncertified
  from public.ingredients ing
  where ing.id = any(v_ids)
    and (ing.cost_reconciled_at is null or ing.average_unit_cost is null or ing.average_unit_cost <= 0);
  if v_uncertified is not null then
    raise exception 'Cannot confirm this Bake. Cost baseline is not certified for: %.', v_uncertified using errcode = '23514';
  end if;

  select string_agg(format('%s (have %s, need %s)', ing.name, ing.current_quantity, dd.quantity), '; ') into v_short
  from (select (elem->>'ingredient_id')::uuid as ingredient_id, (elem->>'quantity')::numeric as quantity
        from jsonb_array_elements(p_deductions) as elem) dd
  join public.ingredients ing on ing.id = dd.ingredient_id
  where dd.quantity > ing.current_quantity;
  if v_short is not null then
    raise exception 'Not enough stock for this Bake: %.', v_short using errcode = '23514';
  end if;

  -- Freeze the raw production cost from the locked, authoritative, now-guaranteed-certified
  -- ingredient state. coalesce(...,0) is defensive only -- the guard above already proved every
  -- ingredient here has a non-null, positive, certified average_unit_cost.
  select coalesce(sum(dd.quantity * coalesce(ing.average_unit_cost, 0)), 0) into v_cost_total
  from (select (elem->>'ingredient_id')::uuid as ingredient_id, (elem->>'quantity')::numeric as quantity
        from jsonb_array_elements(p_deductions) as elem) dd
  join public.ingredients ing on ing.id = dd.ingredient_id;
  v_cost_per_piece := v_cost_total / v_pieces;

  v_note := format('Bake: %s x%s -> %s pcs', coalesce(nullif(trim(p_batch_label), ''), 'batch'), p_multiplier, v_pieces);

  for d in select (elem->>'ingredient_id')::uuid as ingredient_id, (elem->>'quantity')::numeric as quantity
    from jsonb_array_elements(p_deductions) as elem order by (elem->>'ingredient_id')::uuid
  loop
    select current_quantity into v_before from public.ingredients where id = d.ingredient_id;
    v_after := v_before - d.quantity;
    insert into public.inventory_transactions (ingredient_id, transaction_type, quantity_change,
      quantity_before, quantity_after, source_type, source_id, note, created_at)
    values (d.ingredient_id, 'consume', -d.quantity, v_before, v_after, 'bake', p_batch_id::text, v_note, v_now)
    returning id into v_tx_id;
    v_tx_ids := v_tx_ids || v_tx_id;
    update public.ingredients set current_quantity = v_after, updated_at = v_now where id = d.ingredient_id;
  end loop;

  insert into public.production_executions (product_id, product_batch_id, batch_version_snapshot,
    operation_id, multiplier, quantity_produced_pieces, expected_pieces, frozen_ingredient_cost_total,
    frozen_cost_per_piece, completed_at)
  values (p_product_id, p_batch_id, v_batch.batch_version, p_operation_id, p_multiplier, v_pieces,
    v_expected_pieces, v_cost_total, v_cost_per_piece, v_now)
  returning id into v_exec_id;

  insert into public.finished_stock_movements (product_id, production_execution_id, movement_type,
    on_hand_delta, reserved_delta, operation_id, note)
  values (p_product_id, v_exec_id, 'production_receipt', v_pieces, 0, p_operation_id, v_note)
  returning id into v_fsm_id;

  if v_batch.completed_at is null then
    update public.product_batches set completed_at = v_now, updated_at = v_now
      where id = p_batch_id and completed_at is null;
  end if;

  v_result := jsonb_build_object(
    'batch_id', p_batch_id, 'product_id', p_product_id, 'production_execution_id', v_exec_id,
    'finished_stock_movement_id', v_fsm_id, 'quantity_produced_pieces', v_pieces,
    'expected_pieces', v_expected_pieces,
    'frozen_ingredient_cost_total', v_cost_total, 'frozen_cost_per_piece', v_cost_per_piece,
    'transaction_ids', to_jsonb(v_tx_ids));
  update inventory_private.mutation_receipts set result = v_result where operation_id = p_operation_id;
  return v_result;
end;
$$;
revoke all on function inventory_private.confirm_bake_v3(uuid,uuid,text,text,numeric,numeric,jsonb)
  from public, anon, authenticated;
grant execute on function inventory_private.confirm_bake_v3(uuid,uuid,text,text,numeric,numeric,jsonb) to authenticated;

create or replace function public.confirm_bake_v3(
  p_operation_id uuid, p_batch_id uuid, p_product_id text, p_batch_label text,
  p_multiplier numeric, p_actual_pieces_produced numeric, p_deductions jsonb
) returns jsonb language sql security invoker set search_path = '' as $$
  select inventory_private.confirm_bake_v3(p_operation_id, p_batch_id, p_product_id, p_batch_label,
    p_multiplier, p_actual_pieces_produced, p_deductions);
$$;
revoke all on function public.confirm_bake_v3(uuid,uuid,text,text,numeric,numeric,jsonb)
  from public, anon, authenticated;
grant execute on function public.confirm_bake_v3(uuid,uuid,text,text,numeric,numeric,jsonb) to authenticated;

-- ============================================================================================
-- 6. Bounded one-time auto-backfill. Without this, cost_reconciled_at defaults null for every
-- ingredient in the catalog and the guard above would block every product's next Bake, not just
-- Blondies'. Eligibility is deliberately conservative -- false negatives (an ingredient that stays
-- uncertified and needs one manual owner action) are acceptable; false positives (a bad cost
-- auto-certified) are not. An ingredient is auto-certified only if ALL of:
--
--   1. average_unit_cost is non-null and > 0 (a null/zero cost is never auto-certified --
--      Biscoff Spread / White Chocolate Buttons stay uncertified by this alone).
--   2. It has at least one "relevant valid" supply_entries row -- correctly linked via
--      ingredient_id (legacy rows with ingredient_id null are never matched by name here, since
--      fuzzy name matching is exactly the kind of judgment call that produced this incident, not
--      something to re-run blind in a migration), with pack_quantity > 0 and total_cost > 0 (a row
--      with no usable pack size or price is not evidence of anything, priced or not -- the same
--      predicate isValidSupplyForCosting already applies client-side in src/lib/supplies.ts) --
--      whose unit is exact-compatible with the ingredient's own base_unit (no cross-unit
--      conversion is attempted). Egg's only supply_entries row fails this outright (no linked
--      ingredient_id), so Egg is excluded by this condition alone.
--   3. COMPLETENESS: it has ZERO "relevant valid" supply_entries rows (same predicate as #2, minus
--      the unit filter) whose unit does NOT match base_unit. A purchase's display unit routinely
--      differs from the ingredient's base_unit under the current safe RPCs (post_raw_purchase's
--      own comment: "p_pack_quantity/p_display_unit are display-only... they never participate in
--      the stock/cost math") -- e.g. a real ingredient bought as "1kg" but tracked in grams. Only
--      summing the matching-unit subset of evidence while silently ignoring a mismatched-unit
--      purchase would let an ingredient auto-certify on INCOMPLETE evidence; requiring completeness
--      instead means any mismatched-unit evidence at all pushes the ingredient to manual owner
--      certification, never a silent partial-evidence pass. False negative (an otherwise-clean
--      ingredient needs one manual click because its purchase happened to be logged in a different
--      display unit) is acceptable; a false positive from partial evidence is not.
--   4. sum(total_cost)/sum(pack_quantity) over the (now, by #3, complete) linked, unit-matching
--      evidence set -- the true full-history weighted average, since average_unit_cost only ever
--      changes on a purchase event and no ingredient here had any other change between purchases --
--      matches the live average_unit_cost within a small tolerance. This is what excludes Biscoff
--      Biscuit (live 5.03125 vs its own ledger's 6.53125) and, together with #2, is why Brown
--      Sugar's exact cost-math match (both equal 0.075/g from its one linked purchase) is not
--      enough on its own -- see #5.
--   5. No proven pre-reconciliation drift is recorded for this ingredient. Wave 0A's physical-count
--      reconciliation (apply_raw_inventory_adjustment, mode='count') stores a reconciliation_snapshot
--      with the ingredient's cached quantity and the transaction ledger's own last known quantity
--      at that moment; if those two ever disagreed, something wrote to this ingredient's row
--      outside the ledger at some point -- exactly the defect class that produced Egg's and Brown
--      Sugar's corrupted cost. Any ingredient whose most recent reconciliation snapshot shows that
--      disagreement is excluded regardless of how clean its cost math looks, which is what excludes
--      Brown Sugar specifically (condition 4 alone would have passed it).
--
-- This reconstructs, from generic and reusable rules (not from any hardcoded ingredient id or
-- production-specific value -- none belong in a schema migration), exactly the same five
-- ingredients this incident's own forensic audit found untrustworthy by hand: Egg (excluded by
-- #2), Biscoff Spread and White Chocolate Buttons (excluded by #1), Biscoff Biscuit (excluded by
-- #4), and Brown Sugar (excluded by #5). Whether any of the remaining five ingredients also carry
-- mismatched-unit purchase evidence -- and would therefore now be excluded by #3 instead of
-- auto-certified -- has not been checked against the live production data; #3 pushes such a case
-- to a safe, explicit manual certification rather than a silent partial-evidence pass either way,
-- so this is a possible increase in manual work, never a safety regression.
--
-- Defined as a function, called once immediately below, rather than an inline statement -- this is
-- what lets the smoke test suite invoke the exact same eligibility rule again (as a superuser,
-- bypassing RLS the same way any fixture-setup statement already does) against fixture ingredients
-- that could not exist yet at migration-apply time, without duplicating this SQL a second place.
-- Not exposed to `authenticated` -- this runs once, at migration time (or ad hoc, superuser-only,
-- if it is ever useful to re-run after certifying more ingredients through legitimate purchases),
-- never from the application.
-- ============================================================================================
create or replace function inventory_private.backfill_clean_cost_baselines()
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_count integer;
begin
  with valid_supply_evidence as (
    -- "Relevant valid" evidence, unit-agnostic: correctly linked, priceable, real. Same predicate
    -- as clean_purchase_evidence below, minus the unit filter -- the one CTE both completeness
    -- (#3) and the weighted-average calculation (#4) share, so the two can never silently
    -- disagree about what counts as evidence.
    select se.ingredient_id, se.unit, se.total_cost, se.pack_quantity
    from public.supply_entries se
    where se.ingredient_id is not null
      and se.pack_quantity > 0
      and se.total_cost > 0
  ),
  mismatched_unit_evidence as (
    -- Completeness guard (#3): any relevant valid evidence in a unit that does not match the
    -- ingredient's base_unit disqualifies that ingredient from auto-certification entirely, rather
    -- than silently summing only the matching-unit subset.
    select distinct vse.ingredient_id
    from valid_supply_evidence vse
    join public.ingredients ing on ing.id = vse.ingredient_id
    where lower(trim(vse.unit)) <> lower(trim(ing.base_unit))
  ),
  clean_purchase_evidence as (
    select vse.ingredient_id, sum(vse.total_cost) as total_cost, sum(vse.pack_quantity) as total_qty
    from valid_supply_evidence vse
    join public.ingredients ing on ing.id = vse.ingredient_id
    where lower(trim(vse.unit)) = lower(trim(ing.base_unit))
    group by vse.ingredient_id
  ),
  latest_ledger as (
    select distinct on (ingredient_id) ingredient_id, quantity_after
    from public.inventory_transactions
    order by ingredient_id, created_at desc, id desc
  ),
  latest_reconciliation as (
    select distinct on (ingredient_id) ingredient_id,
      nullif(reconciliation_snapshot->>'cache_quantity', '')::numeric as snapshot_cache_quantity,
      nullif(reconciliation_snapshot->>'latest_ledger_quantity', '')::numeric as snapshot_latest_ledger_quantity
    from public.inventory_transactions
    where reconciliation_snapshot is not null
    order by ingredient_id, created_at desc, id desc
  ),
  eligible as (
    select ing.id
    from public.ingredients ing
    join clean_purchase_evidence cpe on cpe.ingredient_id = ing.id
    join latest_ledger ll on ll.ingredient_id = ing.id
    where ing.average_unit_cost is not null
      and ing.average_unit_cost > 0
      and ing.cost_reconciled_at is null
      and cpe.total_qty > 0
      and abs((cpe.total_cost / cpe.total_qty) - ing.average_unit_cost) <= greatest(0.01, ing.average_unit_cost * 0.005)
      and ll.quantity_after = ing.current_quantity
      and not exists (
        select 1 from latest_reconciliation lr
        where lr.ingredient_id = ing.id
          and lr.snapshot_cache_quantity is not null
          and lr.snapshot_latest_ledger_quantity is not null
          and lr.snapshot_cache_quantity is distinct from lr.snapshot_latest_ledger_quantity
      )
      and not exists (
        select 1 from mismatched_unit_evidence mue where mue.ingredient_id = ing.id
      )
  )
  update public.ingredients
    set cost_reconciled_at = now(), updated_at = now()
    where id in (select id from eligible);
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function inventory_private.backfill_clean_cost_baselines() from public, anon, authenticated;

select inventory_private.backfill_clean_cost_baselines();

notify pgrst, 'reload schema';
