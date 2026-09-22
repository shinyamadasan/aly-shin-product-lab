-- Cost System Simplification V4: cost trust is automatic in normal operation; the only human step
-- left is Opening Cost Setup for legacy stock whose cost cannot be proven.
--
-- WHAT ingredients.cost_reconciled_at MEANS (unchanged column, unchanged name): "the current
-- average_unit_cost is safe to use for future costing." Null means it is not (yet). It was
-- previously written only by the owner certification RPC (certify_ingredient_cost_baseline, still
-- the one explicit path, now surfaced to the operator as Opening Cost Setup) and by the one-time
-- Cost Baseline Repair backfill. This migration lets a PURCHASE establish, preserve, or withhold
-- that trust atomically, in the same transaction and under the same row lock as the purchase, so
-- no client can decide trust after the fact (a client-side decision would race every other writer).
--
-- THE RULES (one function, inventory_private.resolve_purchase_cost_trust, used by both purchase
-- paths so they cannot drift):
--   E. previous stock < 0           -> unresolved (null). A negative balance is unresolved stock
--                                      history; a purchase never launders it into a trusted cost.
--   D. purchase without a price     -> trust unchanged. An unpriced purchase can never establish
--                                      trust and never invents a cost (its units are valued at the
--                                      existing average, exactly as before).
--   B. previous stock = 0, priced   -> trusted now. The resulting stock is entirely explained by
--                                      this purchase, so its cost is fully evidenced.
--   A. already trusted, priced      -> trust preserved (the timestamp is not touched); the existing
--                                      weighted average stays authoritative.
--   C. previous stock > 0, untrusted, priced
--                                   -> stays unresolved. The new units' price says nothing about
--                                      what the older units cost; that needs Opening Cost Setup.
--
-- PURCHASE REVERSAL: because a purchase can now change trust, reversing one must put trust back
-- exactly where it was. post_raw_purchase records previous_cost_reconciled_at in its existing
-- purchase_reversal_snapshot together with cost_trust_managed = true, and
-- delete_posted_purchase_if_reversible restores it. A reversal is only permitted while the
-- purchase is still the latest ledger row and the quantity matches, so the restored state is the
-- exact pre-purchase state -- never a guess. Purchases posted before this migration did not touch
-- trust, so their snapshot has no cost_trust_managed marker and their reversal leaves trust alone
-- (exactly the previous behavior).
--
-- STOCK ADJUSTMENTS: an INCREASE that no priced purchase backs (a physical count that finds more
-- than the ledger explains -- already true -- or an "Increase stock" adjustment, which this
-- migration adds) introduces stock with unknown cost and clears trust. A DECREASE, an exact-match
-- count, and the reversal of an earlier adjustment leave trust alone: they add no unknown-cost stock.
--
-- NO BACKFILL. This migration deliberately does NOT mark any existing ingredient trusted. An
-- ingredient's trust state today is whatever the owner certified or the one-time Cost Baseline
-- Repair backfill proved; positive stock with a null cost_reconciled_at needs Opening Cost Setup,
-- zero stock with a null one needs nothing until its next priced purchase. "Every Item with a
-- latest purchase is trusted" would certify legacy stock whose older units were never priced.
--
-- Unchanged on purpose: certify_ingredient_cost_baseline's logic (owner-only, positive cost,
-- evidence required, optimistic concurrency, quantity check, latest-ledger check, audit row,
-- average_unit_cost + cost_reconciled_at writes) and confirm_bake_v3's cost-readiness gate. Only
-- their operator-facing error wording changes, so nobody sees "certified" or "verify" language.
--
-- ONE FIX in certify_ingredient_cost_baseline (found while testing V4, present since Cost Baseline
-- Repair): its expected-average check compared a stored unbounded numeric exactly against the value
-- the client sends back as a JSON double, so any Item whose average is a repeating decimal (19/70 =
-- 0.27142857142857142857) was rejected as "changed" on every attempt. It now compares to double
-- precision (relative 1e-9); quantity and the latest ledger row are still compared exactly.
--
-- NOT APPLIED. Verified only against disposable Postgres; leave unapplied until independent review.
-- Rollback: re-apply 20260917175840_safe_purchase_delete.sql (post_raw_purchase and
-- delete_posted_purchase_if_reversible), the confirm_purchase_import_v2 body of
-- 20260910022601_selling_wave_0b_safe_mutations.sql, and the apply_raw_inventory_adjustment /
-- certify_ingredient_cost_baseline / confirm_bake_v3 bodies of 20260912090000_cost_baseline_repair.sql,
-- then drop inventory_private.resolve_purchase_cost_trust. Ledger rows and trust timestamps written
-- while this migration was live remain valid history and must not be deleted.
do $$
begin
  if to_regprocedure('inventory_private.post_raw_purchase(uuid,uuid,numeric,text,numeric,numeric,text,text,date,numeric,text)') is null
     or to_regprocedure('inventory_private.confirm_purchase_import_v2(uuid,uuid)') is null
     or to_regprocedure('inventory_private.delete_posted_purchase_if_reversible(uuid,uuid)') is null
     or to_regprocedure('inventory_private.apply_raw_inventory_adjustment(uuid,numeric,text,text,text,numeric,uuid,text,uuid)') is null
     or to_regprocedure('inventory_private.certify_ingredient_cost_baseline(uuid,numeric,text,numeric,numeric,uuid)') is null
     or to_regprocedure('inventory_private.confirm_bake_v3(uuid,uuid,text,text,numeric,numeric,jsonb)') is null then
    raise exception 'Cost System Simplification V4 requires Wave 0B, Cost Baseline Repair and Safe Purchase Delete';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'ingredients' and column_name = 'cost_reconciled_at'
  ) or not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'inventory_transactions' and column_name = 'purchase_reversal_snapshot'
  ) then
    raise exception 'Cost System Simplification V4 requires ingredients.cost_reconciled_at and inventory_transactions.purchase_reversal_snapshot';
  end if;
end;
$$;

comment on column public.ingredients.cost_reconciled_at is
  'Internal cost-trust marker: non-null means the current average_unit_cost is safe to use for future costing (confirm_bake_v3 requires it). Established automatically by a priced purchase posted while stock is exactly zero, preserved by any priced purchase while already trusted, or set explicitly by Opening Cost Setup (certify_ingredient_cost_baseline) for legacy stock. Never set by an unpriced purchase, and a purchase never sets it when previous stock was positive-but-untrusted or negative. Cleared by a stock increase that no priced purchase backs (a count finding more than the ledger explains, or an Increase stock adjustment) and by a purchase posted onto negative stock. Restored to its previous value when a trust-managed purchase is reversed. See inventory_private.resolve_purchase_cost_trust.';

-- ============================================================================================
-- 1. The one place the purchase-trust rules live.
-- ============================================================================================
create or replace function inventory_private.resolve_purchase_cost_trust(
  p_quantity_before numeric,
  p_previous_trust timestamptz,
  p_is_priced boolean,
  p_now timestamptz
) returns timestamptz language sql immutable set search_path = '' as $$
  select case
    when p_quantity_before < 0 then null                    -- E: negative stock stays unresolved
    when not p_is_priced then p_previous_trust              -- D: no price, nothing established
    when p_quantity_before = 0 then p_now                   -- B: fully explained by this purchase
    when p_previous_trust is not null then p_previous_trust -- A: trusted stays trusted
    else null                                               -- C: older stock still unpriced
  end;
$$;
-- Called only from the security-definer purchase functions below, never directly by a client.
revoke all on function inventory_private.resolve_purchase_cost_trust(numeric,timestamptz,boolean,timestamptz)
  from public, anon, authenticated;

-- ============================================================================================
-- 2. post_raw_purchase (manual purchase).
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
  v_reversal_snapshot jsonb; v_new_trust timestamptz;
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

  -- Captured before any weighting math runs -- the exact pre-purchase facts Safe Purchase Delete
  -- needs to restore later, independent of quantity_before. cost_trust_managed marks a purchase
  -- whose trust effect the reversal must undo (purchases posted before V4 never touched trust).
  v_reversal_snapshot := jsonb_build_object(
    'previous_average_unit_cost', i.average_unit_cost,
    'previous_cost_reconciled_at', i.cost_reconciled_at,
    'cost_trust_managed', true
  );

  v_has_price := p_total_cost > 0;
  v_qty_before := i.current_quantity;
  v_qty_after := v_qty_before + p_base_quantity;
  -- Trust is decided here, from the locked row, never by the client (see resolve_purchase_cost_trust).
  v_new_trust := inventory_private.resolve_purchase_cost_trust(v_qty_before, i.cost_reconciled_at, v_has_price, v_now);
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
    quantity_before, quantity_after, source_type, source_id, note, created_at, purchase_reversal_snapshot)
  values (i.id, 'purchase', p_base_quantity, v_qty_before, v_qty_after, 'manual', v_supply_id::text, '', v_now, v_reversal_snapshot)
  returning id into v_tx_id;

  update public.ingredients set current_quantity = v_qty_after, average_unit_cost = v_new_avg,
    cost_reconciled_at = v_new_trust, updated_at = v_now
    where id = i.id;

  v_result := jsonb_build_object('supply_id', v_supply_id, 'transaction_id', v_tx_id,
    'quantity_after', v_qty_after, 'average_unit_cost', v_new_avg,
    'cost_trusted', v_new_trust is not null);
  update inventory_private.mutation_receipts set result = v_result where operation_id = p_operation_id;
  return v_result;
end;
$$;
revoke all on function inventory_private.post_raw_purchase(uuid,uuid,numeric,text,numeric,numeric,text,text,date,numeric,text)
  from public, anon, authenticated;
grant execute on function inventory_private.post_raw_purchase(uuid,uuid,numeric,text,numeric,numeric,text,text,date,numeric,text)
  to authenticated;
-- public.post_raw_purchase (the invoker wrapper) is unchanged.

-- ============================================================================================
-- 3. confirm_purchase_import_v2 (CSV purchase import).
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
  v_new_trust timestamptz;
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

    -- An Item's stock is fully explained by this import only when every row for it carries a price:
    -- an unpriced row's units are valued at the existing average (or zero), never at a real cost,
    -- so a mixed import can preserve trust but never establish it (see resolve_purchase_cost_trust).
    v_new_trust := inventory_private.resolve_purchase_cost_trust(
      v_qty_before, i.cost_reconciled_at, v_added_cost > 0 and v_added_unpriced = 0, v_now);

    select least(min(ir.parsed_expiration_date), i.nearest_expiration_date) into v_earliest
    from public.purchase_import_rows ir
    where ir.import_id = p_import_id and ir.row_status <> 'excluded' and ir.ingredient_id = i.id;

    insert into public.inventory_transactions (ingredient_id, transaction_type, quantity_change,
      quantity_before, quantity_after, source_type, source_id, note, created_at)
    values (i.id, 'purchase', v_added, v_qty_before, v_qty_after, 'purchase_import', p_import_id::text, '', v_now)
    returning id into v_tx_id;
    v_tx_ids := v_tx_ids || v_tx_id;

    update public.ingredients set current_quantity = v_qty_after, average_unit_cost = v_new_avg,
      cost_reconciled_at = v_new_trust, nearest_expiration_date = v_earliest, updated_at = v_now
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

-- ============================================================================================
-- 4. delete_posted_purchase_if_reversible (purchase reversal).
-- ============================================================================================
create or replace function inventory_private.delete_posted_purchase_if_reversible(
  p_operation_id uuid, p_supply_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_hash text; v_replay jsonb;
  s public.supply_entries%rowtype;
  i public.ingredients%rowtype;
  v_tx public.inventory_transactions%rowtype;
  v_latest public.inventory_transactions%rowtype;
  v_has_price boolean;
  v_qty_after numeric;
  v_avg_after numeric;
  v_snapshot_avg text;
  v_trust_after timestamptz;
  v_result jsonb;
begin
  if auth.uid() is null or public.is_product_lab_owner() is not true then
    raise exception 'Only the product lab owner may delete a purchase' using errcode = '42501';
  end if;
  if p_supply_id is null then
    raise exception 'A purchase is required' using errcode = '22023';
  end if;

  v_hash := md5(p_supply_id::text);
  v_replay := inventory_private.claim_mutation(p_operation_id, 'purchase_delete', v_hash);
  if v_replay is not null then return v_replay; end if;

  select * into s from public.supply_entries where id = p_supply_id for update;
  if not found then
    raise exception 'Purchase not found';
  end if;

  if s.ingredient_id is null then
    -- Never matched to an Item. source_id is a loose text column, not a foreign key to
    -- supply_entries -- re-verify directly rather than trust the schema shape alone: any ledger
    -- row that happens to carry this purchase's id as its source_id blocks the delete outright,
    -- since which ingredient/history it actually belongs to is unknown and must never be guessed.
    if exists (select 1 from public.inventory_transactions where source_id = p_supply_id::text) then
      raise exception 'This purchase has an unexpected ledger reference and cannot be safely deleted. Contact the owner for manual reconciliation.' using errcode = '23514';
    end if;
    delete from public.supply_entries where id = p_supply_id;
    v_result := jsonb_build_object('supply_id', p_supply_id, 'reversed', false);
    update inventory_private.mutation_receipts set result = v_result where operation_id = p_operation_id;
    return v_result;
  end if;

  select * into i from public.ingredients where id = s.ingredient_id for update;
  if not found then
    raise exception 'Ingredient not found';
  end if;

  select * into v_tx from public.inventory_transactions
    where transaction_type = 'purchase' and source_type = 'manual' and source_id = p_supply_id::text
      and ingredient_id = i.id;
  if not found then
    raise exception 'This purchase''s inventory effect cannot be isolated (it may be part of a CSV import batch, or predates per-purchase ledger tracking). Use a stock adjustment to correct the balance instead.' using errcode = '23514';
  end if;

  select * into v_latest from public.inventory_transactions where ingredient_id = i.id
    order by created_at desc, id desc limit 1;
  if v_latest.id is distinct from v_tx.id then
    raise exception 'Later inventory activity exists for "%", so this purchase can no longer be safely reversed. Use a stock adjustment to correct the balance instead.', i.name using errcode = '23514';
  end if;
  if i.current_quantity is distinct from v_tx.quantity_after then
    raise exception 'Inventory changed. Reload and try again.' using errcode = '40001';
  end if;

  v_has_price := s.total_cost > 0;
  v_qty_after := v_tx.quantity_before;
  if v_qty_after < 0 or v_qty_after::text in ('NaN', 'Infinity', '-Infinity') then
    raise exception 'Inventory changed. Reload and try again.' using errcode = '40001';
  end if;

  if not v_has_price then
    -- Unpriced purchases never move average_unit_cost in the forward direction, regardless of
    -- quantity_before (its weight in the weighted-average formula is always zero) -- the
    -- ingredient's current value already IS the exact pre-purchase value.
    v_avg_after := i.average_unit_cost;
  elsif v_tx.purchase_reversal_snapshot is not null then
    -- Durably recorded at post time -- exact regardless of quantity_before, and never a guess even
    -- when the true previous value was itself zero or null.
    v_snapshot_avg := v_tx.purchase_reversal_snapshot->>'previous_average_unit_cost';
    v_avg_after := case when v_snapshot_avg is null then null else v_snapshot_avg::numeric end;
  elsif v_qty_after > 0 then
    -- Legacy purchase, posted before purchase_reversal_snapshot existed. average_unit_cost is
    -- nullable, and post_raw_purchase's forward math always reads it through coalesce(..., 0) --
    -- so a prior value of NULL and a prior value of exactly 0 drive the SAME forward computation
    -- and land on the SAME current average_unit_cost. The algebraic inverse below recovers that
    -- current average's implied prior value exactly, but a reconstructed result of exactly 0 is
    -- inherently ambiguous between "the prior value truly was 0" and "the prior value was NULL,
    -- coalesced away" -- nothing in the post-purchase state can tell those apart. A NONZERO
    -- reconstruction has no such ambiguity: coalesce(NULL, 0) always contributes exactly 0 to the
    -- forward formula, so any nonzero result can only have come from a real, nonzero prior numeric
    -- value, recovered here without guessing.
    v_avg_after := (i.current_quantity * coalesce(i.average_unit_cost, 0) - s.total_cost) / v_qty_after;
    if v_avg_after = 0 then
      raise exception 'This purchase predates exact cost-reversal tracking, and its prior average cost for "%" cannot be proven: the reconstructed value is zero, which is indistinguishable from an unset (null) prior cost. Use a stock adjustment to correct the balance instead.', i.name using errcode = '23514';
    end if;
  else
    -- Legacy purchase, no snapshot, and quantity_before = 0 -- the prior average_unit_cost cannot
    -- be proven by any means available (it may have been a real, certified, positive value with a
    -- zero weight in the forward math -- see this migration's own header comment). Refuse rather
    -- than guess.
    raise exception 'This purchase predates exact cost-reversal tracking and "%" had zero recorded stock before it, so its prior average cost cannot be proven. Use a stock adjustment to correct the balance instead.', i.name using errcode = '23514';
  end if;

  -- Cost trust. A purchase posted by V4 recorded the trust value it found and may have changed it
  -- (established it from zero stock, or withheld it on negative stock), so reversing it restores
  -- exactly that recorded value -- the purchase was the latest movement and the quantity matches,
  -- so this is the exact pre-purchase state, not a guess. A purchase posted before V4 never
  -- touched trust, so a reversal leaves trust exactly as it is.
  if v_tx.purchase_reversal_snapshot->>'cost_trust_managed' = 'true' then
    v_trust_after := (v_tx.purchase_reversal_snapshot->>'previous_cost_reconciled_at')::timestamptz;
  else
    v_trust_after := i.cost_reconciled_at;
  end if;

  delete from public.inventory_transactions where id = v_tx.id;
  delete from public.supply_entries where id = p_supply_id;
  update public.ingredients set current_quantity = v_qty_after, average_unit_cost = v_avg_after,
    cost_reconciled_at = v_trust_after, updated_at = clock_timestamp()
    where id = i.id;

  v_result := jsonb_build_object('supply_id', p_supply_id, 'reversed', true, 'transaction_id', v_tx.id,
    'ingredient_id', i.id, 'quantity_after', v_qty_after, 'average_unit_cost', v_avg_after,
    'cost_trusted', v_trust_after is not null);
  update inventory_private.mutation_receipts set result = v_result where operation_id = p_operation_id;
  return v_result;
end;
$$;
revoke all on function inventory_private.delete_posted_purchase_if_reversible(uuid,uuid)
  from public, anon, authenticated;
grant execute on function inventory_private.delete_posted_purchase_if_reversible(uuid,uuid)
  to authenticated;

-- ============================================================================================
-- 5. apply_raw_inventory_adjustment (stock adjustments and physical counts).
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
-- 6. certify_ingredient_cost_baseline (Opening Cost Setup authority).
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
    raise exception 'Only the product lab owner may set an opening cost' using errcode = '42501';
  end if;
  if p_ingredient_id is null then
    raise exception 'An ingredient is required' using errcode = '22023';
  end if;
  if p_certified_unit_cost is null or p_certified_unit_cost::text = any(array['NaN','Infinity','-Infinity'])
     or p_certified_unit_cost <= 0 then
    raise exception 'Opening cost must be a positive, finite number' using errcode = '22023';
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

  -- average_unit_cost is an unbounded numeric, so a weighted average such as 19/70 is stored as
  -- 0.27142857142857142857, but the client reads it as a JSON double and can only send back
  -- 0.2714285714285714. An exact comparison rejects that as "changed" every time, forever, for any
  -- Item whose average is a repeating decimal (the normal case once costs come from weighted
  -- purchases). Compare the cost to double precision instead (relative 1e-9, the same tolerance the
  -- client's own read-back uses). This cannot admit a genuinely stale baseline: every real change to
  -- the average comes with a quantity change and a new ledger row, both still checked exactly.
  if i.current_quantity is distinct from p_expected_quantity
     or latest.id is distinct from p_expected_latest_id
     or (i.average_unit_cost is null) is distinct from (p_expected_current_cost is null)
     or abs(i.average_unit_cost - p_expected_current_cost)
        > 1e-9 * greatest(1, abs(i.average_unit_cost), abs(p_expected_current_cost)) then
    raise exception 'Cost details changed. Reload and set the opening cost again.' using errcode = '40001';
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
-- 7. confirm_bake_v3 (operator-facing cost-readiness message only).
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

  -- Cost-readiness gate (Cost Baseline Repair; V4 only rewords the error). A non-null, positive average_unit_cost is not
  -- sufficient on its own -- it must also have been owner-certified. This is what makes an Egg-
  -- class defect (a syntactically valid, non-null, positive but wrong cost) unreachable, not just
  -- the null/zero case Biscoff Spread/White Chocolate Buttons already showed.
  select string_agg(distinct ing.name, ', ') into v_uncertified
  from public.ingredients ing
  where ing.id = any(v_ids)
    and (ing.cost_reconciled_at is null or ing.average_unit_cost is null or ing.average_unit_cost <= 0);
  if v_uncertified is not null then
    raise exception 'Opening cost setup is needed for % before this Bake can be confirmed.', v_uncertified using errcode = '23514';
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

comment on column public.inventory_transactions.purchase_reversal_snapshot is
  'Set only by inventory_private.post_raw_purchase, on the ledger row it inserts: {previous_average_unit_cost, previous_cost_reconciled_at, cost_trust_managed}, the ingredient''s own values immediately before this purchase''s math ran. delete_posted_purchase_if_reversible restores previous_average_unit_cost exactly (even when quantity_before = 0, which no arithmetic can recover) and, when cost_trust_managed is true (purchases posted from Cost System Simplification V4 onward, which can establish or withhold cost trust), also restores previous_cost_reconciled_at. Purchases posted before V4 lack the marker and their reversal leaves cost_reconciled_at untouched. Null on every row from before this column existed and on every non-post_raw_purchase row.';

notify pgrst, 'reload schema';
