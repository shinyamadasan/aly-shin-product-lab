-- Finished Stock Opening Balance / Physical Count Reconciliation.
--
-- Adds a narrow, auditable, BOOTSTRAP-ONLY way to record finished stock that physically exists but
-- predates reliable finished-stock tracking (no production_executions row explains it), plus a
-- bounded, atomic, idempotent, staleness-guarded batch reconciliation entry point that routes each
-- product to: no change, the existing (unmodified) negative correction, a new opening-balance lot,
-- or a hard failure requiring investigation.
--
-- Explicitly NOT a general "add stock" mechanism. record_finished_stock_exception's positive-
-- correction guard (Wave 3) is untouched and still rejects any positive delta before any lock is
-- taken -- see that migration's own header. Opening balance is a SEPARATE, ONE-TIME-PER-PRODUCT path
-- with its own eligibility gate (below), never a second way to add stock indefinitely.
--
-- Does not touch ingredients/inventory_transactions (no raw consumption), does not touch
-- product_batches (no fake Bake), does not change finished_stock_movements' shape (an opening-
-- balance receipt reuses movement_type = 'production_receipt' exactly as Wave 1 defined it --
-- provenance lives entirely on the lot's own source_type), and does not change FIFO, reservation,
-- or fulfillment logic in any way -- they already only ever read production_execution_id/
-- on_hand_delta/reserved_delta, which an opening-balance lot supplies in the same shape a Bake does.
--
-- NOT APPLIED. Created with `supabase migration new`; leave unapplied until independent review.
-- Integration tests run against disposable Postgres containers only.
do $$
begin
  if to_regprocedure('inventory_private.record_finished_stock_exception(uuid,text,text,numeric,uuid,text)') is null then
    raise exception 'Finished Stock Opening Balance requires Wave 3 (record_finished_stock_exception)';
  end if;
  if to_regclass('public.production_executions') is null
     or to_regclass('public.finished_stock_movements') is null then
    raise exception 'Finished Stock Opening Balance requires Wave 1''s production_executions and finished_stock_movements';
  end if;
  if to_regclass('public.costing_summaries') is null then
    raise exception 'Finished Stock Opening Balance requires costing_summaries (supabase-schema.sql)';
  end if;
  if to_regprocedure('inventory_private.create_finished_stock_opening_balance(uuid,uuid,text,integer,timestamptz,numeric,jsonb,text)') is not null then
    raise exception 'Finished Stock Opening Balance objects already exist; this migration must not be re-applied over itself';
  end if;
end;
$$;

-- ============================================================================================
-- 1. production_executions becomes a discriminated lot table. Existing rows backfill correctly to
-- source_type = 'bake' (the only thing that ever wrote this table before) and cost_basis_source =
-- 'production' -- both safe, correct defaults requiring no data migration. product_batch_id and
-- batch_version_snapshot become nullable (opening-balance rows have neither -- there is no recipe/
-- version behind pre-tracking stock; pretending otherwise would be exactly the "fake Bake" this
-- feature must not do). The shape CHECK below is the real, DB-level enforcement of the bake vs
-- opening_balance discrimination -- not just an application-layer convention.
-- ============================================================================================
alter table public.production_executions
  add column source_type text not null default 'bake' check (source_type in ('bake', 'opening_balance')),
  add column cost_basis_source text not null default 'production' check (cost_basis_source in ('production', 'historical_estimate')),
  add column cost_basis_snapshot jsonb;

alter table public.production_executions alter column product_batch_id drop not null;
alter table public.production_executions alter column batch_version_snapshot drop not null;

alter table public.production_executions
  add constraint production_executions_source_shape check (
    (source_type = 'bake'
      and product_batch_id is not null and batch_version_snapshot is not null
      and cost_basis_source = 'production' and cost_basis_snapshot is null)
    or
    (source_type = 'opening_balance'
      and product_batch_id is null and batch_version_snapshot is null
      and cost_basis_source = 'historical_estimate' and cost_basis_snapshot is not null)
  );

comment on constraint production_executions_source_shape on public.production_executions is
  'Enforces the bake/opening_balance discrimination at the database level, not just in application code. A bake lot always has a real recipe/version and production-derived cost provenance; an opening-balance lot never has a batch (it is never a fake Bake) and always carries a historical-estimate cost snapshot.';

comment on column public.production_executions.source_type is
  'bake: a real physical Bake via confirm_bake_v3 (the only kind that existed before this migration). opening_balance: pre-reliable-tracking physical stock recorded via create_finished_stock_opening_balance. Never a general "add stock" path -- see that function''s own eligibility gate.';
comment on column public.production_executions.cost_basis_snapshot is
  'Opening-balance rows only. Structured, server-verified provenance for the estimated cost: {source_costing_id, ingredient_cost, costing_yield, computed_cost_per_piece, verified_ingredient_cost, batch_operation_id, computed_at}. computed_at and batch_operation_id are always server-stamped, never trusted from client JSON.';

-- Defense-in-depth backstop for the eligibility gate the RPC below enforces as the real business
-- rule (under the same products row lock every other wave uses to serialize this exact kind of
-- check). A partial unique index cannot express "no bake lot has ever existed", but it can express
-- the narrower, still-useful invariant that two concurrent/duplicate opening-balance attempts for
-- the same product can never both land, even if some future code path bypassed the RPC.
create unique index production_executions_one_active_opening_balance_idx
  on public.production_executions (product_id)
  where source_type = 'opening_balance';

-- ============================================================================================
-- 2. create_finished_stock_opening_balance -- the single writer for a bootstrap opening-balance
-- lot. One transaction:
--   auth -> validate inputs -> validate + server-verify the client-computed cost-basis snapshot
--   against the real costing_summaries row it claims to be derived from (relational ownership +
--   internal arithmetic consistency -- see below) -> claim operation identity -> lock the canonical
--   products row (same serialization anchor every wave uses) -> BOOTSTRAP ELIGIBILITY GATE: reject
--   if this product already has ANY production_executions row, of either source_type -> insert the
--   lot (server-stamped audit fields) -> insert its production_receipt movement.
--
-- ELIGIBILITY GATE, spelled out: a product qualifies for an opening-balance lot only the very first
-- time its production history is touched by ANYTHING -- no real Bake has ever completed for it, and
-- no earlier opening balance has ever been recorded for it either. This is the literal meaning of
-- "pre-reliable-tracking": the moment this product's production_executions history exists at all,
-- the bootstrap window closes PERMANENTLY for that product. A later positive physical-count
-- discrepancy for a product that already has a lot is never routed here again -- the caller
-- (apply_finished_stock_reconciliation_batch, below) surfaces that as a hard failure requiring
-- investigation, never a second automatic "add stock" event.
--
-- RECOVERY IF THE ONE ALLOWED ENTRY WAS ITSELF WRONG (documented, not automated -- a second
-- automated positive-adjustment path is exactly what this gate exists to prevent):
--   - Overcounted (too many pieces entered): use the existing, unmodified negative `correction`
--     exception to reduce this lot's on_hand down to the true count. Fully supported today.
--   - Undercounted, or the cost estimate was wrong: out of scope for this automated feature by
--     design. The bootstrap window has already closed for that product. Fixing a materially wrong
--     initial entry is a deliberate, human-reviewed manual data correction outside this workflow,
--     following this repo's own AGENTS.md "Recovery Rules" (guarded preflight checks, proof the
--     target state is as expected, rollback notes, explicit human review before execution) -- the
--     same discipline already used for this repo's supabase-check-*.sql / supabase-repair-*.sql
--     files. This function deliberately does not reopen its own gate to make that easier.
--
-- COST-BASIS SERVER VALIDATION. The costing yield lives inside a free-text `notes` field parsed by
-- JS regex in src/lib/costing.ts, not a structured SQL column, so re-deriving it in plpgsql would
-- fork the single source of truth -- this function does not re-parse costing.notes. What it DOES
-- verify, entirely in SQL, before trusting any client-supplied number:
--   1. Relational ownership: p_cost_basis_snapshot->>'source_costing_id' must name a real
--      costing_summaries row, and that row's product_id must equal p_product_id.
--   2. The snapshot's claimed ingredient_cost must match that real row's actual ingredient_cost
--      (a client cannot point at a real, owned costing row and then supply a fabricated cost
--      number disconnected from it).
--   3. Internal arithmetic consistency: computed_cost_per_piece must equal (ingredient_cost /
--      costing_yield) within a narrow tolerance -- the client's arithmetic is checked, not trusted.
--   4. p_estimated_cost_per_piece (the value actually frozen onto the lot) must agree with that
--      verified computed_cost_per_piece within the same tolerance.
-- The lot's frozen_cost_per_piece is set from the SERVER-VERIFIED value, not the raw client input,
-- once all four checks pass. Tolerance is a combined absolute+relative bound
-- (greatest(0.01, |reference| * 1e-6)) -- narrow enough to catch a real mismatch, wide enough to
-- absorb ordinary floating-point round-trip noise between JS doubles and Postgres numeric.
-- ============================================================================================
create or replace function inventory_private.create_finished_stock_opening_balance(
  p_operation_id uuid, p_batch_operation_id uuid, p_product_id text, p_quantity integer,
  p_effective_at timestamptz, p_estimated_cost_per_piece numeric, p_cost_basis_snapshot jsonb,
  p_note text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_hash text; v_replay jsonb; v_now timestamptz := clock_timestamp();
  v_effective_at timestamptz;
  v_costing_id uuid; v_real_ingredient_cost numeric;
  v_snap_ingredient_cost numeric; v_snap_yield numeric; v_snap_computed numeric;
  v_tolerance numeric;
  v_snapshot jsonb;
  v_exec_id uuid; v_fsm_id uuid; v_result jsonb;
begin
  if auth.uid() is null or public.is_product_lab_owner() is not true then
    raise exception 'Only the product lab owner may record a finished-stock opening balance' using errcode = '42501';
  end if;
  if p_product_id is null or length(trim(p_product_id)) = 0 then
    raise exception 'A product is required' using errcode = '22023';
  end if;
  if not exists (select 1 from public.products where id = p_product_id) then
    raise exception 'Product not found' using errcode = '22023';
  end if;
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'Opening balance quantity must be a whole number of at least 1' using errcode = '22023';
  end if;

  v_effective_at := coalesce(p_effective_at, v_now);
  if v_effective_at > v_now then
    raise exception 'Opening balance effective date cannot be in the future' using errcode = '22023';
  end if;

  if p_cost_basis_snapshot is null or jsonb_typeof(p_cost_basis_snapshot) <> 'object' then
    raise exception 'A cost-basis snapshot is required for an opening balance' using errcode = '22023';
  end if;
  begin
    v_costing_id := nullif(p_cost_basis_snapshot->>'source_costing_id', '')::uuid;
    v_snap_ingredient_cost := (p_cost_basis_snapshot->>'ingredient_cost')::numeric;
    v_snap_yield := (p_cost_basis_snapshot->>'costing_yield')::numeric;
    v_snap_computed := (p_cost_basis_snapshot->>'computed_cost_per_piece')::numeric;
  exception when invalid_text_representation or numeric_value_out_of_range then
    raise exception 'Cost-basis snapshot has invalid or missing fields' using errcode = '22023';
  end;
  if v_costing_id is null or v_snap_ingredient_cost is null or v_snap_yield is null or v_snap_computed is null then
    raise exception 'Cost-basis snapshot requires source_costing_id, ingredient_cost, costing_yield, and computed_cost_per_piece' using errcode = '22023';
  end if;
  if v_snap_ingredient_cost::text = any(array['NaN', 'Infinity', '-Infinity'])
     or v_snap_yield::text = any(array['NaN', 'Infinity', '-Infinity'])
     or v_snap_computed::text = any(array['NaN', 'Infinity', '-Infinity'])
     or p_estimated_cost_per_piece is null
     or p_estimated_cost_per_piece::text = any(array['NaN', 'Infinity', '-Infinity'])
     or v_snap_ingredient_cost < 0 or v_snap_yield <= 0 or v_snap_computed < 0 or p_estimated_cost_per_piece < 0 then
    raise exception 'Cost-basis snapshot has a non-finite, negative, or non-positive value where a positive one is required' using errcode = '22023';
  end if;

  -- Relational ownership: the referenced costing must exist and belong to THIS product.
  select ingredient_cost into v_real_ingredient_cost
  from public.costing_summaries where id = v_costing_id and product_id = p_product_id;
  if not found then
    raise exception 'The referenced costing does not exist or does not belong to this product' using errcode = '22023';
  end if;

  v_tolerance := greatest(0.01, abs(v_real_ingredient_cost) * 0.000001);
  if abs(v_snap_ingredient_cost - v_real_ingredient_cost) > v_tolerance then
    raise exception 'Cost-basis snapshot ingredient cost does not match the referenced costing record' using errcode = '23514';
  end if;

  v_tolerance := greatest(0.01, abs(v_snap_computed) * 0.000001);
  if abs(v_snap_computed - (v_snap_ingredient_cost / v_snap_yield)) > v_tolerance then
    raise exception 'Cost-basis snapshot is internally inconsistent: computed cost per piece does not match ingredient cost divided by yield' using errcode = '23514';
  end if;
  if abs(p_estimated_cost_per_piece - v_snap_computed) > v_tolerance then
    raise exception 'Estimated cost per piece does not match the verified cost-basis snapshot' using errcode = '23514';
  end if;

  v_hash := md5(concat_ws('|', p_product_id, p_quantity::text, v_effective_at::text,
    v_snap_computed::text, coalesce(p_note, '')));
  v_replay := inventory_private.claim_mutation(p_operation_id, 'finished_stock_opening_balance', v_hash);
  if v_replay is not null then return v_replay; end if;

  -- Serialization anchor: same canonical products row lock every wave takes before touching
  -- production-execution state for a product.
  perform id from public.products where id = p_product_id for update;

  -- BOOTSTRAP ELIGIBILITY GATE -- see this function's own header.
  if exists (select 1 from public.production_executions where product_id = p_product_id) then
    raise exception 'This product already has production history (a Bake or an earlier opening balance). A further stock increase must be investigated, not recorded as a new opening balance.' using errcode = '23514';
  end if;

  -- Server-stamped audit fields merged in last -- never trusted verbatim from client JSON, even
  -- though the client sends its own copies of these keys.
  v_snapshot := p_cost_basis_snapshot || jsonb_build_object(
    'verified_ingredient_cost', v_real_ingredient_cost,
    'computed_at', v_now,
    'batch_operation_id', p_batch_operation_id
  );

  insert into public.production_executions (
    product_id, product_batch_id, batch_version_snapshot, operation_id, multiplier,
    quantity_produced_pieces, expected_pieces, frozen_ingredient_cost_total, frozen_cost_per_piece,
    source_type, cost_basis_source, cost_basis_snapshot, note, completed_at
  ) values (
    p_product_id, null, null, p_operation_id, 1,
    p_quantity, p_quantity, v_snap_computed * p_quantity, v_snap_computed,
    'opening_balance', 'historical_estimate', v_snapshot,
    coalesce(nullif(trim(p_note), ''), 'Opening balance (pre-tracking physical stock)'), v_effective_at
  ) returning id into v_exec_id;

  insert into public.finished_stock_movements (
    product_id, production_execution_id, movement_type, on_hand_delta, reserved_delta, operation_id, note
  ) values (
    p_product_id, v_exec_id, 'production_receipt', p_quantity, 0, p_operation_id,
    format('Opening balance: %s pcs of %s', p_quantity, p_product_id)
  ) returning id into v_fsm_id;

  v_result := jsonb_build_object(
    'product_id', p_product_id, 'production_execution_id', v_exec_id,
    'finished_stock_movement_id', v_fsm_id, 'quantity', p_quantity,
    'frozen_cost_per_piece', v_snap_computed, 'frozen_ingredient_cost_total', v_snap_computed * p_quantity);
  update inventory_private.mutation_receipts set result = v_result where operation_id = p_operation_id;
  return v_result;
end;
$$;
revoke all on function inventory_private.create_finished_stock_opening_balance(uuid,uuid,text,integer,timestamptz,numeric,jsonb,text)
  from public, anon, authenticated;
grant execute on function inventory_private.create_finished_stock_opening_balance(uuid,uuid,text,integer,timestamptz,numeric,jsonb,text) to authenticated;

create or replace function public.create_finished_stock_opening_balance(
  p_operation_id uuid, p_batch_operation_id uuid, p_product_id text, p_quantity integer,
  p_effective_at timestamptz, p_estimated_cost_per_piece numeric, p_cost_basis_snapshot jsonb,
  p_note text
) returns jsonb language sql security invoker set search_path = '' as $$
  select inventory_private.create_finished_stock_opening_balance(
    p_operation_id, p_batch_operation_id, p_product_id, p_quantity, p_effective_at,
    p_estimated_cost_per_piece, p_cost_basis_snapshot, p_note);
$$;
revoke all on function public.create_finished_stock_opening_balance(uuid,uuid,text,integer,timestamptz,numeric,jsonb,text)
  from public, anon, authenticated;
grant execute on function public.create_finished_stock_opening_balance(uuid,uuid,text,integer,timestamptz,numeric,jsonb,text) to authenticated;

-- ============================================================================================
-- 3. apply_finished_stock_reconciliation_batch -- the single entry point for a Physical Count /
-- Reconcile apply, mirroring inventory_private.apply_inventory_physical_count_batch's shape (the
-- raw-inventory precedent): one claim_mutation for the WHOLE batch (atomic/idempotent as one unit),
-- deterministic per-product lock order, a staleness guard against on_hand/reserved/latest-movement
-- drift since preview, and per-item delegation to existing single-item writers rather than
-- reimplementing their logic.
--
-- IMPORTANT: the client sends the physical count and its EXPECTED starting state, never a
-- pre-classified action or a pre-computed delta magnitude. This function derives the action itself,
-- from the LIVE locked on_hand, the same way record_finished_stock_exception/
-- confirm_order_with_reservation never trust a client's own sufficiency judgment -- only its raw
-- inputs. difference = physical_count - on_hand (on_hand, NOT available -- a physical count
-- includes reserved pieces still physically present):
--   difference = 0            -> no_change, no writer called.
--   difference < 0            -> correction, magnitude = -difference, delegated verbatim to
--                                 record_finished_stock_exception('correction', -magnitude). That
--                                 function already refuses to touch reserved stock and already fails
--                                 the WHOLE exception if the magnitude exceeds total UNRESERVED
--                                 stock -- so "a shortage that would require consuming reserved
--                                 pieces fails loudly" is enforced there, unmodified, for free.
--   difference > 0             -> opening_balance IF this product has zero production_executions
--                                 rows (the bootstrap gate, re-checked here too, not only inside
--                                 create_finished_stock_opening_balance, since this function takes
--                                 its own row lock first); otherwise the WHOLE BATCH fails with an
--                                 explicit "needs investigation" error. The client is expected to
--                                 exclude any row it already knows will hit this from p_items, but
--                                 if one arrives anyway, failing loudly (not silently skipping it)
--                                 is the correct behavior.
-- ============================================================================================
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

    v_results := v_results || jsonb_build_object(
      'product_id', v_product_id, 'action', v_action, 'difference', v_difference,
      'correction_result', v_correction_result, 'opening_balance_result', v_opening_result);
    v_correction_result := null; v_opening_result := null;
  end loop;

  update inventory_private.mutation_receipts set result = to_jsonb(v_results) where operation_id = p_operation_id;
  return to_jsonb(v_results);
end;
$$;
revoke all on function inventory_private.apply_finished_stock_reconciliation_batch(uuid,text,jsonb)
  from public, anon, authenticated;
grant execute on function inventory_private.apply_finished_stock_reconciliation_batch(uuid,text,jsonb) to authenticated;

create or replace function public.apply_finished_stock_reconciliation_batch(
  p_operation_id uuid, p_payload_hash text, p_items jsonb
) returns jsonb language sql security invoker set search_path = '' as $$
  select inventory_private.apply_finished_stock_reconciliation_batch(p_operation_id, p_payload_hash, p_items);
$$;
revoke all on function public.apply_finished_stock_reconciliation_batch(uuid,text,jsonb)
  from public, anon, authenticated;
grant execute on function public.apply_finished_stock_reconciliation_batch(uuid,text,jsonb) to authenticated;

notify pgrst, 'reload schema';
