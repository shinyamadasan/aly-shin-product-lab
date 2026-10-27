-- Order fulfillment expected-state and lot-stock guard.
--
-- Selling Wave 2's complete_order_with_fulfillment locks the order row and its active allocations,
-- then fulfils the frozen reservation. It never locks the products / production_executions rows that
-- every other finished-stock writer serializes on (confirm_order_with_reservation,
-- record_finished_stock_exception, apply_finished_stock_reconciliation_batch, reverse_finished_stock_
-- exception), and it never re-checks lot balances, so:
--   1. a lot holding fewer pieces than the reservation (legacy or out-of-band data) is fulfilled into a
--      negative on-hand/reserved balance;
--   2. a caller that reviewed the order (the Product Lab MCP preview) cannot have the database refuse
--      when the order changed -- e.g. a payment was recorded -- after that review.
--
-- This migration adds ONE new private function that takes the canonical lock order
-- (order row -> products -> production_executions, matching confirm and the stock-exception writers),
-- optionally checks the caller's expected order state under the order lock, and refuses before writing
-- anything if any reserved lot lacks the on-hand or reserved pieces it would fulfil.
--
-- The expected state is orders.updated_at AND every payment column (payment_status, payment_method,
-- paid_at, paid_amount, refunded_at), compared with IS DISTINCT FROM. updated_at alone is not enough:
-- no trigger maintains it (supabase-add-orders.sql), so a payment write that does not bump it -- a
-- direct PostgREST PATCH, or a future payload builder that omits it -- would otherwise slip through.
--
-- Backward compatibility:
--   * public.complete_order_with_fulfillment(uuid, uuid) keeps its signature, grants and wrapper. Its
--     private implementation now delegates with no expected state, so web-app callers behave exactly as
--     before except that a fulfilment that would make a lot negative is refused (23514).
--   * Receipt identity is unchanged: operation type 'order_fulfill', payload hash md5(order_id). An
--     operation id first used by either entry point replays identically through the other. A replay
--     returns before any expected-state check, so a retry after a lost response always replays.
--   * Error codes are unchanged for existing outcomes (42501, 22023, 23514 "has no active reservation",
--     55P03). The only new code is 40001 for an expected-state mismatch, which only the new checked
--     entry point can raise because the legacy path does not check expected state.
--   * No payment column is written.
--
-- New entry point: public.complete_order_with_fulfillment_checked(p_operation_id, p_order_id,
-- p_expected_updated_at, p_expected_payment_status, p_expected_payment_method, p_expected_paid_at,
-- p_expected_paid_amount, p_expected_refunded_at). The expected updated_at and payment_status are
-- required (22023 when null; both columns are NOT NULL); the other payment values may be NULL, which
-- means "expected to be NULL".
--
-- NOT APPLIED to any database. Before applying, run supabase-check-order-fulfillment-guard.sql (read
-- only) to confirm the live definition matches Wave 2 and to list any open order this guard would
-- refuse to complete.
--
-- ROLLBACK (only if this migration must be undone; it changes no data). Order matters: restore the
-- legacy body BEFORE dropping the checked functions it calls.
--   1. Re-run section 7 of supabase/migrations/20260910181827_selling_wave_2_order_reservation.sql
--      (the original inventory_private.complete_order_with_fulfillment body, unchanged since Wave 2).
--   2. drop function public.complete_order_with_fulfillment_checked(uuid, uuid, timestamptz, text, text, timestamptz, numeric, timestamptz);
--      drop function inventory_private.complete_order_with_fulfillment_checked(uuid, uuid, boolean, timestamptz, text, text, timestamptz, numeric, timestamptz);
--   3. notify pgrst, 'reload schema';
-- Receipts written through either function stay valid replays of the legacy function, because the
-- receipt identity is identical.
do $$
begin
  if to_regprocedure('inventory_private.complete_order_with_fulfillment(uuid,uuid)') is null
     or to_regprocedure('public.complete_order_with_fulfillment(uuid,uuid)') is null
     or to_regclass('public.order_stock_allocations') is null
     or to_regclass('public.production_executions') is null
     or to_regprocedure('inventory_private.claim_mutation(uuid,text,text)') is null then
    raise exception 'Requires Selling Wave 0B/1/2 (claim_mutation, production_executions, order_stock_allocations, complete_order_with_fulfillment)';
  end if;
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where p.proname = 'complete_order_with_fulfillment_checked' and n.nspname in ('public', 'inventory_private')) then
    raise exception 'The checked fulfillment functions already exist; this migration must not be re-applied over itself';
  end if;
end;
$$;

create function inventory_private.complete_order_with_fulfillment_checked(
  p_operation_id uuid, p_order_id uuid, p_check_expected boolean,
  p_expected_updated_at timestamptz, p_expected_payment_status text, p_expected_payment_method text,
  p_expected_paid_at timestamptz, p_expected_paid_amount numeric, p_expected_refunded_at timestamptz
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_hash text; v_replay jsonb; v_order public.orders%rowtype; v_now timestamptz := clock_timestamp();
  v_alloc record; v_shortfall text; v_result jsonb;
begin
  if auth.uid() is null or public.is_product_lab_owner() is not true then
    raise exception 'Only the product lab owner may complete an order' using errcode = '42501';
  end if;
  if p_order_id is null then
    raise exception 'An order is required' using errcode = '22023';
  end if;

  -- Same receipt identity as Wave 2, so a replay is identical through either entry point.
  v_hash := md5(concat_ws('|', p_order_id::text));
  v_replay := inventory_private.claim_mutation(p_operation_id, 'order_fulfill', v_hash);
  if v_replay is not null then return v_replay; end if;

  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'Order not found' using errcode = '22023';
  end if;
  if v_order.status not in ('confirmed', 'ready') then
    raise exception 'This % order has no active reservation to fulfill.', v_order.status using errcode = '23514';
  end if;
  if p_check_expected and (
       v_order.updated_at is distinct from p_expected_updated_at
    or v_order.payment_status is distinct from p_expected_payment_status
    or v_order.payment_method is distinct from p_expected_payment_method
    or v_order.paid_at is distinct from p_expected_paid_at
    or v_order.paid_amount is distinct from p_expected_paid_amount
    or v_order.refunded_at is distinct from p_expected_refunded_at
  ) then
    raise exception 'This order changed since it was reviewed. Review it again before completing.' using errcode = '40001';
  end if;

  -- Canonical finished-stock lock order: products first, then their production executions in
  -- (product_id, completed_at, id) order -- identical to confirm_order_with_reservation and the
  -- stock-exception / reconciliation writers, so this serializes with them without deadlocking.
  perform p.id from public.products p
  where p.id in (select a.product_id from public.order_stock_allocations a where a.order_id = p_order_id and a.status = 'active')
  order by p.id
  for update;
  perform pe.id from public.production_executions pe
  where pe.id in (select a.production_execution_id from public.order_stock_allocations a where a.order_id = p_order_id and a.status = 'active')
  order by pe.product_id, pe.completed_at, pe.id
  for update;

  -- Against the now-locked lots: every lot must still physically hold, and still show reserved, the
  -- pieces this order fulfils from it. Refuse the whole completion before writing anything.
  select string_agg(format('lot %s holds %s on hand and %s reserved but this order fulfils %s', need.production_execution_id, coalesce(lot.on_hand, 0), coalesce(lot.reserved, 0), need.pieces), '; ' order by need.production_execution_id)
    into v_shortfall
  from (
    select a.production_execution_id, sum(a.reserved_pieces) as pieces
    from public.order_stock_allocations a
    where a.order_id = p_order_id and a.status = 'active'
    group by a.production_execution_id
  ) need
  left join (
    select fsm.production_execution_id, sum(fsm.on_hand_delta) as on_hand, sum(fsm.reserved_delta) as reserved
    from public.finished_stock_movements fsm
    where fsm.production_execution_id in (select a.production_execution_id from public.order_stock_allocations a where a.order_id = p_order_id and a.status = 'active')
    group by fsm.production_execution_id
  ) lot on lot.production_execution_id = need.production_execution_id
  where coalesce(lot.on_hand, 0) < need.pieces or coalesce(lot.reserved, 0) < need.pieces;
  if v_shortfall is not null then
    raise exception 'Cannot complete this order without making finished stock negative: %.', v_shortfall using errcode = '23514';
  end if;

  for v_alloc in
    select * from public.order_stock_allocations
    where order_id = p_order_id and status = 'active'
    order by id
    for update
  loop
    insert into public.finished_stock_movements (product_id, production_execution_id, movement_type, on_hand_delta, reserved_delta, operation_id, order_id, order_stock_allocation_id, note)
    values (v_alloc.product_id, v_alloc.production_execution_id, 'fulfill', -v_alloc.reserved_pieces, -v_alloc.reserved_pieces, p_operation_id, p_order_id, v_alloc.id, format('Fulfill %s pcs of %s for order %s', v_alloc.reserved_pieces, v_alloc.product_id, p_order_id));

    update public.order_stock_allocations set status = 'fulfilled', updated_at = v_now where id = v_alloc.id;
  end loop;

  -- Authorize exactly one status write, then close the window again immediately (see Wave 2 confirm).
  perform set_config('inventory_private.order_transition_authorized', 'true', true);
  update public.orders set status = 'completed', completed_at = v_now, updated_at = v_now where id = p_order_id
  returning * into v_order;
  perform set_config('inventory_private.order_transition_authorized', 'false', true);

  v_result := to_jsonb(v_order);
  update inventory_private.mutation_receipts set result = v_result where operation_id = p_operation_id;
  return v_result;
end;
$$;
revoke all on function inventory_private.complete_order_with_fulfillment_checked(uuid, uuid, boolean, timestamptz, text, text, timestamptz, numeric, timestamptz) from public, anon, authenticated;
grant execute on function inventory_private.complete_order_with_fulfillment_checked(uuid, uuid, boolean, timestamptz, text, text, timestamptz, numeric, timestamptz) to authenticated;

-- The legacy private implementation keeps its signature (and therefore its existing grants and the
-- public wrapper that calls it) and delegates without checking expected state.
create or replace function inventory_private.complete_order_with_fulfillment(
  p_operation_id uuid, p_order_id uuid
) returns jsonb language sql security definer set search_path = '' as $$
  select inventory_private.complete_order_with_fulfillment_checked(p_operation_id, p_order_id, false, null, null, null, null, null, null);
$$;

create function public.complete_order_with_fulfillment_checked(
  p_operation_id uuid, p_order_id uuid,
  p_expected_updated_at timestamptz, p_expected_payment_status text, p_expected_payment_method text,
  p_expected_paid_at timestamptz, p_expected_paid_amount numeric, p_expected_refunded_at timestamptz
) returns jsonb
language plpgsql security invoker set search_path = '' as $$
begin
  if p_expected_updated_at is null or p_expected_payment_status is null then
    raise exception 'The reviewed order version and payment state are required' using errcode = '22023';
  end if;
  return inventory_private.complete_order_with_fulfillment_checked(
    p_operation_id, p_order_id, true,
    p_expected_updated_at, p_expected_payment_status, p_expected_payment_method,
    p_expected_paid_at, p_expected_paid_amount, p_expected_refunded_at);
end;
$$;
revoke all on function public.complete_order_with_fulfillment_checked(uuid, uuid, timestamptz, text, text, timestamptz, numeric, timestamptz) from public, anon, authenticated;
grant execute on function public.complete_order_with_fulfillment_checked(uuid, uuid, timestamptz, text, text, timestamptz, numeric, timestamptz) to authenticated;

notify pgrst, 'reload schema';
