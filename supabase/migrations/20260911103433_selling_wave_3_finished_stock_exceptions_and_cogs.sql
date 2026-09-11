-- Wave 3: Finished-Stock Exceptions + Historical Fulfilled Raw COGS.
--
-- Closes two remaining truth gaps left after Wave 0A/0B/1/2:
--
--   1. Physical finished-stock exceptions -- damage, giveaway/sample, and a found-fewer stock
--      correction -- so the ledger can explain every piece that ever existed, not just the ones
--      that were sold.
--   2. Historical raw-production COGS for FULFILLED orders, computed from the exact production
--      lots Wave 2 actually allocated and Wave 1's frozen per-piece cost -- never today's recipe,
--      today's ingredient cost, or today's product price.
--
-- Continues the append-only ledger model exactly as Wave 1/2 left it: finished_stock_movements
-- grows THREE new movement_type verbs (damage, giveaway, correction) and two new defensive shape
-- CHECK constraints; no existing row is ever edited, no production_executions row is ever
-- rewritten, no order_stock_allocations row is ever edited. One new narrow RPC
-- (record_finished_stock_exception, the same definer-private + invoker-public pair every prior
-- wave uses) is the only writer for the three new verbs. COGS is NOT a new stored table -- it is
-- a security-invoker VIEW deriving straight from order_stock_allocations (Wave 2, immutable once
-- fulfilled) joined to production_executions.frozen_cost_per_piece (Wave 1, immutable) -- both
-- already RLS-owner-only, so the view adds no new authority surface.
--
-- POST-REVIEW FIX (still unreviewed/unapplied): the independent Wave 3 review's activation
-- blocker -- a "found more than recorded" POSITIVE correction let an operator attribute extra
-- pieces to an existing production execution, which breaks cost conservation. Reproduced exactly:
-- an execution that actually cost PHP800 for 8 pieces (PHP100/piece frozen) could receive a +2
-- positive correction and then have all 10 pieces fulfilled, deriving PHP1,000 of raw COGS from a
-- Bake that only ever cost PHP800 -- fulfilled COGS attributed to one execution must never exceed
-- that execution's own frozen raw cost total, and a positive correction has no trustworthy cost
-- basis of its own to avoid that. Positive correction is REMOVED from this migration entirely
-- (not merely gated): damage, giveaway, and correction are now uniformly negative-only, exactly
-- like every other Wave 3 exception. Found-more/unattributed physical stock remains explicitly
-- unsupported -- see this file's own note on record_finished_stock_exception for why, and
-- planning/SELLING_WAVE_3.md's Known Limitations for the operator-facing statement.
--
-- Security matches every prior wave: the three exception movement types get no client write path
-- at all (finished_stock_movements already revokes all client writes; this migration does not
-- change that). The view is security_invoker so it inherits the caller's own RLS evaluation on
-- both base tables rather than running with the view owner's privileges.
--
-- NOT APPLIED. Created with `supabase migration new`; leave unapplied until independent Wave 3
-- review. Integration tests run against disposable Postgres containers only.
do $$
begin
  if to_regprocedure('inventory_private.confirm_order_with_reservation(uuid,uuid)') is null
     or to_regclass('inventory_private.mutation_receipts') is null then
    raise exception 'Wave 3 requires Wave 0B (mutation_receipts) and Wave 2 (confirm_order_with_reservation)';
  end if;
  if to_regclass('public.production_executions') is null
     or to_regclass('public.finished_stock_movements') is null then
    raise exception 'Wave 3 requires Wave 1''s production_executions and finished_stock_movements';
  end if;
  if to_regclass('public.order_stock_allocations') is null then
    raise exception 'Wave 3 requires Wave 2''s order_stock_allocations';
  end if;
  if to_regprocedure('inventory_private.record_finished_stock_exception(uuid,text,text,numeric,uuid,text)') is not null then
    raise exception 'Wave 3 objects already exist; this migration must not be re-applied over itself';
  end if;
end;
$$;

-- ============================================================================================
-- 1. finished_stock_movements grows three exception verbs. No new columns -- the existing
-- production_execution_id (lot linkage), on_hand_delta, reserved_delta and note columns are
-- exactly what an exception needs; the operator-entered reason travels in `note`, matching Wave
-- 0A/0B/1's own convention of a free-text note rather than a second reason taxonomy.
--
--   damage / giveaway / correction -- always a physical LOSS of UNRESERVED stock:
--     on_hand_delta < 0, reserved_delta = 0 (never touches a customer reservation -- see Wave
--     3's central invariant), production_execution_id required (which lot the loss came from),
--     never order-linked. correction is "found fewer than recorded" only -- a positive
--     ("found more") correction is deliberately NOT supported by any of the three verbs; see
--     record_finished_stock_exception's own header for why.
-- ============================================================================================
alter table public.finished_stock_movements
  drop constraint finished_stock_movements_movement_type_check;
alter table public.finished_stock_movements
  add constraint finished_stock_movements_movement_type_check check (
    movement_type in ('production_receipt', 'reserve', 'release', 'fulfill', 'damage', 'giveaway', 'correction')
  );

alter table public.finished_stock_movements
  add constraint finished_stock_movements_exception_shape check (
    movement_type not in ('damage', 'giveaway', 'correction')
    or (
      order_id is null
      and order_stock_allocation_id is null
      and reserved_delta = 0
      and production_execution_id is not null
      and on_hand_delta < 0
    )
  );

comment on constraint finished_stock_movements_exception_shape on public.finished_stock_movements is
  'damage, giveaway, and correction (found-fewer only -- positive/found-more is not supported) are always a negative on-hand delta from a specific lot, never touch reserved_delta, and are never order-linked. Defense in depth: this CHECK rejects a positive on_hand_delta for any of the three even if a future writer bypassed record_finished_stock_exception.';

-- ============================================================================================
-- 2. record_finished_stock_exception -- the single narrow writer for damage, giveaway, and
-- correction. One transaction:
--
--   auth -> validate inputs (p_quantity_delta must be NEGATIVE -- see below -- and
--   p_production_execution_id must be null for every exception type) -> claim operation identity
--   -> lock the canonical products row for p_product_id (the same always-present serialization
--   anchor Wave 2 uses -- this is what serializes a damage/giveaway/correction against a
--   concurrent order reservation OR another concurrent exception on the same product) -> lock
--   every candidate production_executions row for that product, in the same deterministic
--   (completed_at, id) order Wave 2's FIFO allocator uses -> compute each lot's currently
--   UNRESERVED availability from that locked snapshot (on_hand - reserved per execution,
--   identical math to Wave 2's lot_available) -> reject the WHOLE request up front if the
--   unreserved total across all lots is short (protecting active reservations is the point -- a
--   damage/giveaway/correction must never be able to reach into reserved pieces) -> FIFO-deduct
--   oldest-lot-first, writing one movement row per lot actually drawn from. Nothing is written if
--   the check fails -- no partial exception.
--
--   POSITIVE ("found more than recorded") IS NOT SUPPORTED, for any of the three exception types,
--   and is rejected before any lock is taken. This was the independent Wave 3 review's activation
--   blocker: a positive correction attributed extra pieces to an EXISTING production execution
--   without adding to that execution's frozen raw cost, so fulfilling the inflated quantity could
--   derive more raw COGS than the Bake it is attributed to ever actually cost (reproduced exactly:
--   an 8-piece/PHP800 execution + a +2 correction + fulfilling all 10 pieces would derive
--   PHP1,000 of raw COGS from a Bake that cost PHP800). There is no trustworthy way to give found
--   stock its own cost basis without either rewriting a frozen Wave 1 fact (never -- see Wave 1's
--   own immutability guarantee) or inventing a second cost-basis/inventory-lot model (explicitly
--   out of scope -- planning/SELLING_WAVE_3.md's task brief instructs deferring this sub-case
--   rather than building unsafely for it). If physical stock is found in excess of what the
--   ledger shows, Wave 3 deliberately offers no way to add it as sellable stock; that gap is
--   documented, not silently worked around.
--
-- Any failure rolls back everything; the operation id stays retryable. p_quantity_delta is part
-- of the idempotency payload hash -- a retry with a different quantity is a changed-payload
-- rejection, not a silent rewrite of what was recorded.
-- ============================================================================================
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
  if p_exception_type is null or p_exception_type not in ('damage', 'giveaway', 'correction') then
    raise exception 'Exception type must be damage, giveaway, or correction' using errcode = '22023';
  end if;
  if p_quantity_delta is null or p_quantity_delta::text = any(array['NaN','Infinity','-Infinity'])
     or p_quantity_delta <> trunc(p_quantity_delta) or p_quantity_delta = 0 then
    raise exception 'Quantity must be a non-zero whole number' using errcode = '22023';
  end if;
  -- POST-REVIEW FIX: positive ("found more than recorded") is not supported for any exception
  -- type -- see this function's own header for why (cost conservation: a positive correction has
  -- no trustworthy cost basis of its own, and attributing it to an existing execution can inflate
  -- that execution's fulfilled raw COGS beyond what it actually cost). Rejected before any lock.
  if p_quantity_delta > 0 then
    raise exception 'Positive finished-stock correction is not supported because found-more stock does not yet have a trustworthy raw-cost basis.' using errcode = '22023';
  end if;
  -- The operator never chooses a lot for any of the three exception types -- damage, giveaway,
  -- and (now exclusively negative) correction are all FIFO-allocated automatically from the
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

  -- Always negative from here: damage, giveaway, or a "found fewer" correction. FIFO-deduct from
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

    insert into public.finished_stock_movements (product_id, production_execution_id, movement_type, on_hand_delta, reserved_delta, operation_id, note)
    values (p_product_id, v_exec.execution_id, p_exception_type, -v_take::integer, 0, p_operation_id, v_note)
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
revoke all on function inventory_private.record_finished_stock_exception(uuid,text,text,numeric,uuid,text)
  from public, anon, authenticated;
grant execute on function inventory_private.record_finished_stock_exception(uuid,text,text,numeric,uuid,text) to authenticated;

create or replace function public.record_finished_stock_exception(
  p_operation_id uuid, p_product_id text, p_exception_type text, p_quantity_delta numeric,
  p_production_execution_id uuid, p_note text
) returns jsonb language sql security invoker set search_path = '' as $$
  select inventory_private.record_finished_stock_exception(p_operation_id, p_product_id, p_exception_type, p_quantity_delta, p_production_execution_id, p_note);
$$;
revoke all on function public.record_finished_stock_exception(uuid,text,text,numeric,uuid,text)
  from public, anon, authenticated;
grant execute on function public.record_finished_stock_exception(uuid,text,text,numeric,uuid,text) to authenticated;

-- ============================================================================================
-- 3. order_raw_cogs -- historical raw-production COGS for FULFILLED orders, fully derived, never
-- stored. fulfilled allocations are immutable (Wave 2: status moves to 'fulfilled' exactly once
-- and is never edited) and frozen_cost_per_piece is immutable (Wave 1: a production execution's
-- cost is frozen at Bake time and never rewritten by a later recipe/ingredient-cost edit), so
-- this join is safely computable forever without a snapshot table. security_invoker means this
-- view runs with the CALLER's own RLS evaluation against order_stock_allocations and
-- production_executions (both already owner-SELECT-only), not the view owner's -- it grants no
-- authority beyond what the caller already has on the underlying tables.
--
-- Deliberately named "raw" -- this covers ingredient cost only (Wave 1's frozen_ingredient_cost_total),
-- never packaging, labor, utilities, delivery, or payment fees. It is not a P&L figure and must
-- never be presented as one; see planning/SELLING_WAVE_3.md section 19.
--
-- Only 'fulfilled' allocations are summed: 'active' (reserved but not yet fulfilled) and
-- 'released' (cancelled) allocations contribute nothing, so a new/confirmed/ready order shows no
-- row here at all, and a cancelled order's released pieces never count as cost. An order that is
-- 100% manual/non-stock lines has zero allocations of any status and likewise has no row.
-- ============================================================================================
create view public.order_raw_cogs with (security_invoker = true) as
select
  osa.order_id,
  sum(osa.reserved_pieces)::integer as fulfilled_pieces,
  sum(osa.reserved_pieces * pe.frozen_cost_per_piece) as raw_production_cogs,
  jsonb_agg(
    jsonb_build_object(
      'production_execution_id', osa.production_execution_id,
      'product_id', osa.product_id,
      'fulfilled_pieces', osa.reserved_pieces,
      'frozen_cost_per_piece', pe.frozen_cost_per_piece,
      'lot_raw_cogs', osa.reserved_pieces * pe.frozen_cost_per_piece
    )
    order by pe.completed_at, pe.id
  ) as lots
from public.order_stock_allocations osa
join public.production_executions pe on pe.id = osa.production_execution_id
where osa.status = 'fulfilled'
group by osa.order_id;

comment on view public.order_raw_cogs is
  'Historical raw-production (ingredient-only) COGS for fulfilled orders, derived from Wave 2''s immutable fulfilled allocations and Wave 1''s frozen per-piece production cost. No row for an order with no fulfilled stock-tracked lines. security_invoker: runs under the caller''s own RLS on the base tables, grants no new authority.';

grant select on public.order_raw_cogs to authenticated;

notify pgrst, 'reload schema';
