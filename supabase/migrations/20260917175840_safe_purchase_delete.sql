-- Safe Purchase Delete: closes the gap RAW_PURCHASE_DELETE_BLOCKED's own comment used to describe
-- unconditionally ("Wave 0B intentionally does not add a safe way to delete one" -- see
-- planning/SELLING_WAVE_0B.md's "Manual purchase delete" row, a historical record of that decision,
-- left as-is). Ingredient permanent-delete (hard_delete_ingredient_if_unreferenced, 20260917175753)
-- already refuses whenever any supply_entries row references the Item; this migration is what lets
-- a genuinely incorrect purchase -- duplicate, test, accidental, never actually happened -- be
-- removed together with its exact inventory effect, clearing that one specific reference.
--
-- This does NOT, by itself, make permanent-delete available: hard_delete_ingredient_if_unreferenced
-- also counts inventory_transactions rows, and post_raw_purchase requires a verified physical count
-- (inventory_reconciled_at) before it will ever post a purchase in the first place -- that count is
-- itself an inventory_transactions row (apply_raw_inventory_adjustment, mode = 'count'), which this
-- migration does not touch, delete, or auto-clean. An ingredient with a deleted purchase still has
-- every other independent reference (its reconciliation/count history, any adjustment, any Bake,
-- any alias, any costing entry, any other purchase, any Selling Format packaging line) blocking
-- permanent delete exactly as before -- deleting one purchase clears that one reference, nothing
-- more.
--
-- Same inventory_private/public pair shape every other privileged mutation in this schema already
-- uses (post_raw_purchase, apply_raw_inventory_adjustment, hard_delete_ingredient_if_unreferenced,
-- certify_ingredient_cost_baseline): SECURITY DEFINER, `set search_path = ''` so every reference is
-- fully schema-qualified, an in-body owner check (a SECURITY DEFINER function's own statements
-- bypass RLS on the tables it touches, so the table's own RLS policy is never actually consulted
-- here), EXECUTE revoked from public/anon and granted only to authenticated on both layers, and
-- inventory_private.claim_mutation idempotency for this retry-prone remote-mutation class (the same
-- class post_raw_purchase/confirm_bake_v2/v3/confirm_purchase_import_v2 already belong to).
--
-- Scope, deliberately conservative (V1) -- a purchase is only ever deleted when Postgres itself can
-- PROVE its exact inventory contribution, never guessed at:
--
--   1. supply_entries.ingredient_id is null -- never matched to any Item. Structurally impossible
--      for this purchase to have ever produced an inventory_transactions row through any current
--      write path (that table's ingredient_id is NOT NULL, see supabase-add-inventory.sql, and
--      every writer that could set source_id also always sets a real ingredient_id in the same
--      insert). source_id is a loose text column, not a foreign key to supply_entries, so this is
--      re-verified directly rather than trusted from schema shape alone: a query for any
--      inventory_transactions row whose source_id equals this purchase's own id must return
--      nothing before the delete proceeds. Any hit blocks the delete outright rather than guessing
--      which ingredient or history it might belong to.
--
--   2. supply_entries has a directly-linked ledger row -- transaction_type = 'purchase',
--      source_type = 'manual', source_id = the purchase's own id, exactly the row
--      post_raw_purchase inserts -- AND that row is still the single latest inventory_transactions
--      row for its ingredient (no later purchase, Bake, adjustment, physical count, or cost
--      certification of any kind, ordered created_at desc, id desc -- the same tie-breaking order
--      used everywhere else in this schema a "latest" row is resolved, e.g.
--      apply_raw_inventory_adjustment). Reversal then exactly undoes post_raw_purchase's own math:
--      quantity returns to the ledger row's own recorded quantity_before.
--
--      average_unit_cost is the one place naive reversal is unsound, and this migration fixes a
--      real defect found in independent review: quantity_before = 0 does NOT prove the ingredient's
--      average_unit_cost was 0 before this purchase. Cost Baseline Repair
--      (certify_ingredient_cost_baseline) can certify a positive average_unit_cost independent of
--      current_quantity -- an ingredient can be at 0 stock with a durably certified, evidenced cost.
--      A purchase posted from that state produces a new weighted average that mathematically erases
--      any trace of the prior value (its weight was zero), so nothing about the post-purchase state
--      alone can recover it. Resetting to 0 in that case (this migration's own first draft, and the
--      pre-existing local-only reverseSupplyPurchaseEffect's behavior) would silently destroy a real,
--      certified fact -- unacceptable for a database-authoritative deletion.
--
--      The fix: post_raw_purchase now stores a narrow purchase_reversal_snapshot on the ledger row
--      it inserts, capturing the ingredient's average_unit_cost (and cost_reconciled_at, for audit
--      completeness only -- see below) exactly as it was immediately before this purchase, before
--      any weighting math ran. Same pattern already established twice in this schema for the same
--      reason (reconciliation_snapshot for adjustment/count rows, cost_certification_snapshot for
--      cost_certification rows) -- a new, narrowly-scoped column set only by one producer, never a
--      reused field whose existing meaning would become ambiguous. Deletion then prefers this exact,
--      durably-recorded value over any derived arithmetic whenever it exists:
--
--        unpriced purchase (total_cost = 0): average_unit_cost is provably unchanged by the forward
--          math regardless of quantity_before (its weight in the weighted average is always zero) --
--          the ingredient's current value already IS the correct restored value, no snapshot needed.
--        priced, snapshot present (every purchase posted from this migration onward): restore
--          purchase_reversal_snapshot's own previous_average_unit_cost exactly, whether it was zero,
--          null, or positive, and regardless of quantity_before -- this is a durably recorded fact,
--          never inferred.
--        priced, no snapshot (a purchase posted before this migration), quantity_before > 0: the
--          algebraic inverse of post_raw_purchase's weighted-average formula --
--          (current_quantity * current_average_unit_cost - purchase.total_cost) / quantity_before --
--          is provably exact ONLY when the result is nonzero. average_unit_cost is nullable, and
--          the forward formula always reads it through coalesce(average_unit_cost, 0) -- so a prior
--          value of NULL and a prior value of exactly 0 drive the identical forward computation and
--          land on the identical current average, making the reconstructed value ambiguous between
--          those two cases whenever it comes out to exactly 0 (coalesce(null, 0) always contributes
--          0, so nothing about the post-purchase state can tell "null" apart from "0" once it has).
--          A nonzero reconstruction has no such ambiguity -- it can only have come from a real,
--          nonzero prior numeric value -- and is used as-is.
--        priced, no snapshot, quantity_before = 0, OR quantity_before > 0 but the reconstruction is
--          exactly 0: the prior average CANNOT be proven by any means available (either the defect
--          above, or the NULL/0 ambiguity just described, both for a purchase old enough to predate
--          the fix) -- the delete is refused outright rather than guessing null, zero, or anything
--          else.
--
--      cost_reconciled_at itself is never written by this function, in either direction --
--      certify_ingredient_cost_baseline's own documented invariant is that an ordinary purchase
--      never clears or changes it (post_raw_purchase/confirm_purchase_import_v2 already don't touch
--      it), so a reversal doesn't need to and must not either. This also can't be observably wrong:
--      if a cost certification happened after this purchase, that certification is itself a ledger
--      row, so the "still the latest movement" check above would already have refused the delete
--      before reaching any cost math.
--
-- Everything else is refused outright, deletion never proceeds even partially:
--   - A CSV-imported purchase: confirm_purchase_import_v2 posts ONE combined ledger row per
--     ingredient per upload, not one per supply_entries row -- there is no source_id linking a
--     ledger row back to one individual CSV row, so this purchase's own contribution cannot be
--     isolated. Even deleting just its supply_entries display row is refused: doing so would leave
--     that row's real, uncorrected quantity/cost contribution silently baked into current inventory
--     forever while the operator believes it was removed.
--   - A purchase whose own ledger row is no longer the latest movement for its ingredient --
--     reversing out of order would misattribute someone else's later change to this purchase, the
--     same invariant isSafeToRecalculate already encodes for the local-only path.
--   - A legacy (pre-snapshot) purchase whose prior average cost cannot be proven (see above).
do $$
begin
  if to_regprocedure('inventory_private.post_raw_purchase(uuid,uuid,numeric,text,numeric,numeric,text,text,date,numeric,text)') is null
     or to_regprocedure('inventory_private.claim_mutation(uuid,text,text)') is null then
    raise exception 'Safe Purchase Delete requires Wave 0A/0B (mutation_receipts, post_raw_purchase)';
  end if;
end;
$$;

-- ============================================================================================
-- 1. purchase_reversal_snapshot -- set only on transaction_type = 'purchase', source_type =
-- 'manual' rows (post_raw_purchase's own inserts), never on any other row. Deliberately not the
-- CSV-import purchase path (confirm_purchase_import_v2): those rows are never individually
-- reversible regardless (see file header), so they have no use for this snapshot.
-- ============================================================================================
alter table public.inventory_transactions add column if not exists purchase_reversal_snapshot jsonb;

comment on column public.inventory_transactions.purchase_reversal_snapshot is
  'Set only by inventory_private.post_raw_purchase, on the ledger row it inserts: {previous_average_unit_cost, previous_cost_reconciled_at}, the ingredient''s own values immediately before this purchase''s weighted-average math ran. Exists so delete_posted_purchase_if_reversible can restore the exact prior average_unit_cost even when quantity_before = 0, a case no arithmetic can recover from the post-purchase state alone (see that migration''s own comment). previous_cost_reconciled_at is captured for audit completeness only and is never written back on delete -- an ordinary purchase never changes cost_reconciled_at in either direction. Null on every row from before this column existed and on every non-post_raw_purchase row.';

-- ============================================================================================
-- 2. post_raw_purchase -- same signature, same body, plus one additional field on the same
-- existing insert into inventory_transactions. Everything above the marked line is byte-identical
-- to the Wave 0B original (20260910022601_selling_wave_0b_safe_mutations.sql) -- this is a
-- create-or-replace of the same signature adding one column to one existing INSERT, not a
-- redesign, matching the discipline Cost Baseline Repair already applied to
-- apply_raw_inventory_adjustment/confirm_bake_v3.
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
  v_reversal_snapshot jsonb;
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
  -- needs to restore later, independent of quantity_before.
  v_reversal_snapshot := jsonb_build_object(
    'previous_average_unit_cost', i.average_unit_cost,
    'previous_cost_reconciled_at', i.cost_reconciled_at
  );

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
    quantity_before, quantity_after, source_type, source_id, note, created_at, purchase_reversal_snapshot)
  values (i.id, 'purchase', p_base_quantity, v_qty_before, v_qty_after, 'manual', v_supply_id::text, '', v_now, v_reversal_snapshot)
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
grant execute on function inventory_private.post_raw_purchase(uuid,uuid,numeric,text,numeric,numeric,text,text,date,numeric,text)
  to authenticated;
-- public.post_raw_purchase (the invoker wrapper) is unchanged -- same signature, same body,
-- already delegates to the private function above and needs no edit of its own.

-- ============================================================================================
-- 3. delete_posted_purchase_if_reversible
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

  delete from public.inventory_transactions where id = v_tx.id;
  delete from public.supply_entries where id = p_supply_id;
  update public.ingredients set current_quantity = v_qty_after, average_unit_cost = v_avg_after, updated_at = clock_timestamp()
    where id = i.id;

  v_result := jsonb_build_object('supply_id', p_supply_id, 'reversed', true, 'transaction_id', v_tx.id,
    'ingredient_id', i.id, 'quantity_after', v_qty_after, 'average_unit_cost', v_avg_after);
  update inventory_private.mutation_receipts set result = v_result where operation_id = p_operation_id;
  return v_result;
end;
$$;
revoke all on function inventory_private.delete_posted_purchase_if_reversible(uuid,uuid)
  from public, anon, authenticated;
grant execute on function inventory_private.delete_posted_purchase_if_reversible(uuid,uuid)
  to authenticated;

create or replace function public.delete_posted_purchase_if_reversible(p_operation_id uuid, p_supply_id uuid)
returns jsonb language sql security invoker set search_path = '' as $$
  select inventory_private.delete_posted_purchase_if_reversible(p_operation_id, p_supply_id);
$$;
revoke all on function public.delete_posted_purchase_if_reversible(uuid,uuid)
  from public, anon, authenticated;
grant execute on function public.delete_posted_purchase_if_reversible(uuid,uuid)
  to authenticated;

notify pgrst, 'reload schema';
