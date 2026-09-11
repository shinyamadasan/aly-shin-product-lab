-- Wave 2: Order Reservation + Release + Fulfillment.
--
-- Connects customer orders to the physical finished-stock truth Wave 1 created. Confirming an
-- order reserves the exact physical pieces it needs from FIFO-oldest production executions;
-- cancelling a reserved order releases exactly those pieces; completing a reserved order fulfills
-- exactly those pieces (on-hand truly decreases only here). No sale COGS, no accounting, no
-- waste/damage, no packaging inventory -- see planning/SELLING_WAVE_2.md.
--
-- New writer for the movement_type verbs Wave 1 already reserved room for ('reserve', 'release',
-- 'fulfill'). New table order_stock_allocations is the minimum durable link answering "which
-- physical production execution(s) supplied this order" -- FIFO decided once at confirm time and
-- replayed unchanged at cancel/complete, never recomputed.
--
-- Security matches Wave 0A/0B/1: order_stock_allocations gets SELECT-only for the owner and no
-- write path for any client role; three private security-definer functions (fixed empty
-- search_path) are the only writers, each behind a narrowly-granted public invoker wrapper.
-- Two new triggers close a real authority gap that predates Wave 2: orders/order_lines have
-- always granted `authenticated` unrestricted table access (this schema's documented trust
-- model), which would otherwise let a client set orders.status = 'confirmed' directly -- or
-- INSERT a row that starts there -- and skip reservation entirely. The triggers are narrow.
-- enforce_order_status_transition_authority lets a client:
--   (a) create an order only as 'new';
--   (b) directly move new -> cancelled (nothing is reserved, so there is no stock effect) and
--       confirmed -> ready (the reservation already exists and does not change);
-- and NOTHING else. Every other status change -- new -> confirmed, confirmed/ready -> completed,
-- confirmed/ready -> cancelled -- must go through the reserve/release/fulfill functions, which
-- authorize their own status write with a transaction-local flag they set immediately before it
-- and clear immediately after. enforce_order_lines_immutable_after_reservation blocks any direct
-- client write to order_lines once the parent order is confirmed/ready/completed. Neither invents
-- a general state machine or workflow engine; both are gates around the one thing that changed
-- (stock now depends on status). The legal state machine itself is unchanged and still lives in
-- src/lib/orders/transitions.ts.
--
-- NOT APPLIED. Created with `supabase migration new`; leave unapplied until independent Wave 2
-- review. Integration tests run against disposable Postgres containers only.
do $$
begin
  if to_regprocedure('inventory_private.confirm_bake_v3(uuid,uuid,text,text,numeric,numeric,jsonb)') is null
     or to_regclass('inventory_private.mutation_receipts') is null then
    raise exception 'Wave 2 requires Wave 0B (mutation_receipts) and Wave 1 (confirm_bake_v3)';
  end if;
  if to_regclass('public.production_executions') is null
     or to_regclass('public.finished_stock_movements') is null then
    raise exception 'Wave 2 requires Wave 1''s production_executions and finished_stock_movements';
  end if;
  if to_regclass('public.orders') is null or to_regclass('public.order_lines') is null then
    raise exception 'Wave 2 requires the Selling orders/order_lines tables (supabase-add-orders.sql)';
  end if;
  if to_regclass('public.order_stock_allocations') is not null then
    raise exception 'Wave 2 objects already exist; this migration must not be re-applied over itself';
  end if;
end;
$$;

-- ============================================================================================
-- 1. order_stock_allocations -- the minimum durable link between an order and the physical
-- production execution(s) that supply it. One row per (order, product, production_execution)
-- slice the FIFO allocator drew from at confirm time. reserved_pieces is frozen at that instant
-- and never recomputed; status moves active -> released XOR active -> fulfilled exactly once,
-- driven by the SAME order-wide transition (an order's allocations all move together, because
-- order_lines are immutable once confirmed -- see the order_lines trigger below -- so there is
-- never a partial re-allocation to reconcile).
-- ============================================================================================
create table public.order_stock_allocations (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete restrict,
  product_id text not null references public.products(id),
  production_execution_id uuid not null references public.production_executions(id),
  operation_id uuid not null,
  reserved_pieces integer not null check (reserved_pieces > 0),
  status text not null default 'active' check (status in ('active', 'released', 'fulfilled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index order_stock_allocations_order_idx on public.order_stock_allocations (order_id);
create index order_stock_allocations_execution_idx on public.order_stock_allocations (production_execution_id);
create index order_stock_allocations_active_idx on public.order_stock_allocations (order_id, status) where status = 'active';
-- Schema-level backstop for what claim_mutation + the status='new' gate + the order-row lock
-- already prevent in practice: one confirmation writes at most one row per (order, execution),
-- and no lifecycle step ever adds a second (cancel/complete only flip status, re-confirm is
-- refused because the order is no longer 'new'). Full uniqueness -- simpler and stronger than a
-- partial one, and correct because a duplicate is never legitimate.
create unique index order_stock_allocations_order_execution_uq on public.order_stock_allocations (order_id, production_execution_id);

comment on table public.order_stock_allocations is
  'FIFO-decided link from an order to the production execution(s) supplying it. reserved_pieces is frozen at confirm time; status moves active -> released or active -> fulfilled once, replaying the same allocation rather than recomputing FIFO.';

alter table public.order_stock_allocations enable row level security;
revoke all on public.order_stock_allocations from public, anon, authenticated;
grant select on public.order_stock_allocations to authenticated;
create policy "wave2 owner reads order stock allocations" on public.order_stock_allocations
  for select to authenticated using (public.is_product_lab_owner());

-- ============================================================================================
-- 2. finished_stock_movements grows order linkage columns (nullable -- production_receipt rows
-- never carry them) and defensive shape checks for the three verbs Wave 1 left unconstrained.
-- Existing production_receipt rows satisfy both new checks trivially (their new columns default
-- to null, and the first check requires exactly that for that movement type).
-- ============================================================================================
alter table public.finished_stock_movements
  add column order_id uuid references public.orders(id),
  add column order_stock_allocation_id uuid references public.order_stock_allocations(id);

create index finished_stock_movements_order_idx on public.finished_stock_movements (order_id);
create index finished_stock_movements_allocation_idx on public.finished_stock_movements (order_stock_allocation_id);

alter table public.finished_stock_movements
  add constraint finished_stock_movements_production_receipt_no_order_linkage check (
    movement_type <> 'production_receipt'
    or (order_id is null and order_stock_allocation_id is null)
  );

-- reserve: reserved +Q only. release: reserved -Q only. fulfill: on-hand and reserved both -Q,
-- the SAME Q (a fulfillment can never claim to consume more/less on-hand than it releases from
-- reserved -- that would let fulfilled stock and reserved stock silently diverge).
alter table public.finished_stock_movements
  add constraint finished_stock_movements_order_movement_shape check (
    movement_type not in ('reserve', 'release', 'fulfill')
    or (
      order_id is not null
      and order_stock_allocation_id is not null
      and production_execution_id is not null
      and (
        (movement_type = 'reserve' and on_hand_delta = 0 and reserved_delta > 0)
        or (movement_type = 'release' and on_hand_delta = 0 and reserved_delta < 0)
        or (movement_type = 'fulfill' and on_hand_delta < 0 and reserved_delta < 0 and on_hand_delta = reserved_delta)
      )
    )
  );

comment on column public.finished_stock_movements.order_id is 'Set only for reserve/release/fulfill movements -- which order the stock commitment belongs to. Null for production_receipt.';
comment on column public.finished_stock_movements.order_stock_allocation_id is 'Set only for reserve/release/fulfill movements -- the specific (order, production execution) allocation this movement replays. Null for production_receipt.';

-- ============================================================================================
-- 3. Order status transition authority. orders/order_lines have always granted `authenticated`
-- unrestricted table access (documented trust model, supabase-add-orders.sql). That was safe
-- while no status transition had a side effect; Wave 2 makes three of them consequential.
--
-- On INSERT: a client-created order may only start as 'new'. The one exception is save_order's
-- `INSERT ... ON CONFLICT DO UPDATE`, which re-proposes an already-existing row for insertion
-- before falling through to its update -- that is an edit, not a creation (the row already
-- exists), so it passes here and the UPDATE arm judges it.
--
-- On UPDATE: the only status changes a direct client write may make are new -> cancelled (nothing
-- reserved, no stock effect) and confirmed -> ready (reservation already exists, unchanged).
-- Every other status change -- including every '* -> ready' that is not confirmed -> ready, and
-- any resurrection of a terminal order -- is refused unless the caller is one of the three
-- reserve/release/fulfill functions, which announce themselves with the transaction-local
-- inventory_private.order_transition_authorized flag (set immediately before their status write,
-- cleared immediately after). A plain client update can never set that flag: it is a namespaced
-- custom GUC and no function reachable from PostgREST calls set_config on it.
-- ============================================================================================
create or replace function public.enforce_order_status_transition_authority()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_authorized boolean := coalesce(current_setting('inventory_private.order_transition_authorized', true), '') = 'true';
begin
  if tg_op = 'INSERT' then
    if new.status <> 'new'
       and not v_authorized
       and not exists (select 1 from public.orders o where o.id = new.id) then
      raise exception 'A new order can only be created with status ''new''.' using errcode = '42501';
    end if;
    return new;
  end if;

  if new.status is distinct from old.status
     and not (old.status = 'new' and new.status = 'cancelled')
     and not (old.status = 'confirmed' and new.status = 'ready')
     and not v_authorized then
    raise exception 'This order status change must go through the order reservation/release/fulfillment functions.' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger wave2_enforce_order_status_transition_authority
  before insert or update on public.orders
  for each row execute function public.enforce_order_status_transition_authority();

-- ============================================================================================
-- 4. Order line snapshot immutability once stock is reserved. Order lines were already never
-- edited after creation at the application layer (orders-page.tsx's own header comment); this
-- makes that boundary real at the database layer too, the moment it starts having a stock
-- consequence. A 'new' order's lines stay freely editable through save_order, matching today.
-- ============================================================================================
create or replace function public.enforce_order_lines_immutable_after_reservation()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_status text;
begin
  select status into v_status from public.orders where id = coalesce(new.order_id, old.order_id);
  if v_status in ('confirmed', 'ready', 'completed') then
    raise exception 'This order''s stock has been reserved or fulfilled; its lines can no longer be changed directly.' using errcode = '42501';
  end if;
  return coalesce(new, old);
end;
$$;

create trigger wave2_enforce_order_lines_immutable_after_reservation
  before insert or update or delete on public.order_lines
  for each row execute function public.enforce_order_lines_immutable_after_reservation();

-- ============================================================================================
-- 5. confirm_order_with_reservation -- new -> confirmed. Steps, all in one transaction:
--   auth -> claim operation identity -> lock the order -> verify status = 'new' -> lock the
--   canonical products row for every product the order needs (the always-present serialization
--   anchor) -> lock every candidate production execution for those products (deterministic
--   product_id/completed_at/id order, serializing concurrent confirmations that contend for the
--   same stock) -> compute required pieces per product from order_lines.quantity x
--   pieces_per_unit_snapshot (lines with no product or no recorded snapshot are skipped -- a
--   manual/hand-priced line is not stock-reservable) -> reject the WHOLE confirmation if any
--   product is short, before allocating anything -> FIFO-allocate each product across its
--   production executions oldest first, writing one order_stock_allocations row and one
--   'reserve' movement per execution actually drawn from -> flip status to confirmed -> store the
--   receipt. Any failure rolls the whole thing back; the operation id stays retryable.
--
-- An order with no stock-trackable lines at all (fully manual/custom) confirms with zero
-- allocations and zero movements -- there is nothing to reserve, not an error.
-- ============================================================================================
create or replace function inventory_private.confirm_order_with_reservation(
  p_operation_id uuid, p_order_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_hash text; v_replay jsonb; v_now timestamptz := clock_timestamp();
  v_order public.orders%rowtype;
  v_bad_products text; v_insufficient text;
  v_required record; v_exec record;
  v_remaining integer; v_take integer; v_alloc_id uuid;
  v_result jsonb;
begin
  if auth.uid() is null or public.is_product_lab_owner() is not true then
    raise exception 'Only the product lab owner may confirm an order' using errcode = '42501';
  end if;
  if p_order_id is null then
    raise exception 'An order is required' using errcode = '22023';
  end if;

  v_hash := md5(concat_ws('|', p_order_id::text));
  v_replay := inventory_private.claim_mutation(p_operation_id, 'order_reserve', v_hash);
  if v_replay is not null then return v_replay; end if;

  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'Order not found' using errcode = '22023';
  end if;
  if v_order.status <> 'new' then
    raise exception 'This order is % and cannot be confirmed from here.', v_order.status using errcode = '23514';
  end if;

  -- Serialization anchor. Lock the canonical products row for every product this order needs, in
  -- deterministic id order, BEFORE touching production executions. products rows always exist;
  -- production_executions rows may not (a product that has never been baked has zero), and a
  -- SELECT ... FOR UPDATE over an empty set locks nothing -- which would let two confirmations for
  -- a never-baked product run without a shared anchor while its first Bake lands concurrently.
  -- Locking the product row closes that: the second confirmation blocks here until the first
  -- commits, then sees its reservation, exactly as it already does when executions exist.
  perform p.id
  from public.products p
  where p.id in (
    select distinct ol.product_id
    from public.order_lines ol
    where ol.order_id = p_order_id and ol.product_id is not null and ol.pieces_per_unit_snapshot is not null
  )
  order by p.id
  for update;

  -- Lock every candidate production execution for every product this order needs, in one
  -- deterministic order, before reading any availability. This is what serializes two orders
  -- confirming against the same stock: the second blocks here until the first commits, then sees
  -- its committed reservations.
  perform pe.id
  from public.production_executions pe
  where pe.product_id in (
    select distinct ol.product_id
    from public.order_lines ol
    where ol.order_id = p_order_id and ol.product_id is not null and ol.pieces_per_unit_snapshot is not null
  )
  order by pe.product_id, pe.completed_at, pe.id
  for update;

  -- Whole-order validation, against the now-locked snapshot: every stock-tracked product line's
  -- quantity x snapshot must be a whole positive piece count, and none may exceed on_hand -
  -- reserved. ANY failure rejects the ENTIRE confirmation -- nothing allocates below this point.
  select string_agg(distinct product_id, ', ') into v_bad_products
  from (
    select ol.product_id, sum(ol.quantity * ol.pieces_per_unit_snapshot) as required_pieces
    from public.order_lines ol
    where ol.order_id = p_order_id and ol.product_id is not null and ol.pieces_per_unit_snapshot is not null
    group by ol.product_id
  ) req
  where req.required_pieces <> trunc(req.required_pieces) or req.required_pieces <= 0;
  if v_bad_products is not null then
    raise exception 'This order has an invalid piece requirement for: %. Fix the order lines before confirming.', v_bad_products using errcode = '23514';
  end if;

  select string_agg(msg, '; ') into v_insufficient
  from (
    select format('%s requires %s pieces, but only %s are available', req.product_id, req.required_pieces::integer, coalesce(avail.available_pieces, 0)) as msg
    from (
      select ol.product_id, sum(ol.quantity * ol.pieces_per_unit_snapshot)::integer as required_pieces
      from public.order_lines ol
      where ol.order_id = p_order_id and ol.product_id is not null and ol.pieces_per_unit_snapshot is not null
      group by ol.product_id
    ) req
    left join (
      select fsm.product_id, coalesce(sum(fsm.on_hand_delta), 0) - coalesce(sum(fsm.reserved_delta), 0) as available_pieces
      from public.finished_stock_movements fsm
      group by fsm.product_id
    ) avail on avail.product_id = req.product_id
    where req.required_pieces > coalesce(avail.available_pieces, 0)
  ) shortfalls;
  if v_insufficient is not null then
    raise exception 'Cannot confirm this order. %.', v_insufficient using errcode = '23514';
  end if;

  -- Availability confirmed for every product; allocate. Nothing changes the locked stock state
  -- between the check above and this loop, so it cannot fail from insufficiency now.
  for v_required in
    select ol.product_id, sum(ol.quantity * ol.pieces_per_unit_snapshot)::integer as required_pieces
    from public.order_lines ol
    where ol.order_id = p_order_id and ol.product_id is not null and ol.pieces_per_unit_snapshot is not null
    group by ol.product_id
    order by ol.product_id
  loop
    v_remaining := v_required.required_pieces;

    for v_exec in
      select pe.id as execution_id,
             coalesce(sum(fsm.on_hand_delta), 0) - coalesce(sum(fsm.reserved_delta), 0) as lot_available
      from public.production_executions pe
      left join public.finished_stock_movements fsm on fsm.production_execution_id = pe.id
      where pe.product_id = v_required.product_id
      group by pe.id, pe.completed_at
      order by pe.completed_at, pe.id
    loop
      exit when v_remaining <= 0;
      continue when v_exec.lot_available <= 0;
      v_take := least(v_remaining, v_exec.lot_available);

      insert into public.order_stock_allocations (order_id, product_id, production_execution_id, operation_id, reserved_pieces, status)
      values (p_order_id, v_required.product_id, v_exec.execution_id, p_operation_id, v_take, 'active')
      returning id into v_alloc_id;

      insert into public.finished_stock_movements (product_id, production_execution_id, movement_type, on_hand_delta, reserved_delta, operation_id, order_id, order_stock_allocation_id, note)
      values (v_required.product_id, v_exec.execution_id, 'reserve', 0, v_take, p_operation_id, p_order_id, v_alloc_id, format('Reserve %s pcs of %s for order %s', v_take, v_required.product_id, p_order_id));

      v_remaining := v_remaining - v_take;
    end loop;

    if v_remaining > 0 then
      -- Unreachable given the availability check above ran against the same locked snapshot;
      -- guarded anyway rather than silently under-reserving.
      raise exception 'Could not allocate % pieces of % from available production lots (internal consistency error).', v_required.required_pieces, v_required.product_id using errcode = '23514';
    end if;
  end loop;

  -- Authorize exactly one status write, then close the window again immediately. The flag is
  -- transaction-local; clearing it here means a later unrelated write in the same transaction
  -- (PostgREST runs one per request, but a batch or a future caller might not) cannot inherit it.
  perform set_config('inventory_private.order_transition_authorized', 'true', true);
  update public.orders set status = 'confirmed', updated_at = v_now where id = p_order_id
  returning * into v_order;
  perform set_config('inventory_private.order_transition_authorized', 'false', true);

  v_result := to_jsonb(v_order);
  update inventory_private.mutation_receipts set result = v_result where operation_id = p_operation_id;
  return v_result;
end;
$$;
revoke all on function inventory_private.confirm_order_with_reservation(uuid, uuid) from public, anon, authenticated;
grant execute on function inventory_private.confirm_order_with_reservation(uuid, uuid) to authenticated;

create or replace function public.confirm_order_with_reservation(p_operation_id uuid, p_order_id uuid) returns jsonb
language sql security invoker set search_path = '' as $$
  select inventory_private.confirm_order_with_reservation(p_operation_id, p_order_id);
$$;
revoke all on function public.confirm_order_with_reservation(uuid, uuid) from public, anon, authenticated;
grant execute on function public.confirm_order_with_reservation(uuid, uuid) to authenticated;

-- ============================================================================================
-- 6. cancel_order_with_release -- confirmed/ready -> cancelled, releasing exactly the existing
-- reservation. Never recomputes required pieces or re-runs FIFO -- it replays
-- order_stock_allocations rows written at confirm time. new -> cancelled has no active
-- allocations and stays on the plain update path (src/lib/orders-repository.ts), matching "no
-- stock effect because nothing was reserved".
-- ============================================================================================
create or replace function inventory_private.cancel_order_with_release(
  p_operation_id uuid, p_order_id uuid, p_cancel_reason text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_hash text; v_replay jsonb; v_order public.orders%rowtype; v_now timestamptz := clock_timestamp();
  v_alloc record; v_result jsonb;
begin
  if auth.uid() is null or public.is_product_lab_owner() is not true then
    raise exception 'Only the product lab owner may cancel an order' using errcode = '42501';
  end if;
  if p_order_id is null then
    raise exception 'An order is required' using errcode = '22023';
  end if;

  v_hash := md5(concat_ws('|', p_order_id::text, coalesce(p_cancel_reason, '')));
  v_replay := inventory_private.claim_mutation(p_operation_id, 'order_release', v_hash);
  if v_replay is not null then return v_replay; end if;

  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'Order not found' using errcode = '22023';
  end if;
  if v_order.status not in ('confirmed', 'ready') then
    raise exception 'This % order has no active reservation to release.', v_order.status using errcode = '23514';
  end if;

  for v_alloc in
    select * from public.order_stock_allocations
    where order_id = p_order_id and status = 'active'
    order by id
    for update
  loop
    insert into public.finished_stock_movements (product_id, production_execution_id, movement_type, on_hand_delta, reserved_delta, operation_id, order_id, order_stock_allocation_id, note)
    values (v_alloc.product_id, v_alloc.production_execution_id, 'release', 0, -v_alloc.reserved_pieces, p_operation_id, p_order_id, v_alloc.id, format('Release %s pcs of %s for cancelled order %s', v_alloc.reserved_pieces, v_alloc.product_id, p_order_id));

    update public.order_stock_allocations set status = 'released', updated_at = v_now where id = v_alloc.id;
  end loop;

  -- Authorize exactly one status write, then close the window again immediately (see confirm).
  perform set_config('inventory_private.order_transition_authorized', 'true', true);
  update public.orders
    set status = 'cancelled', cancelled_at = v_now, cancel_reason = nullif(trim(coalesce(p_cancel_reason, '')), ''), updated_at = v_now
    where id = p_order_id
  returning * into v_order;
  perform set_config('inventory_private.order_transition_authorized', 'false', true);

  v_result := to_jsonb(v_order);
  update inventory_private.mutation_receipts set result = v_result where operation_id = p_operation_id;
  return v_result;
end;
$$;
revoke all on function inventory_private.cancel_order_with_release(uuid, uuid, text) from public, anon, authenticated;
grant execute on function inventory_private.cancel_order_with_release(uuid, uuid, text) to authenticated;

create or replace function public.cancel_order_with_release(p_operation_id uuid, p_order_id uuid, p_cancel_reason text) returns jsonb
language sql security invoker set search_path = '' as $$
  select inventory_private.cancel_order_with_release(p_operation_id, p_order_id, p_cancel_reason);
$$;
revoke all on function public.cancel_order_with_release(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.cancel_order_with_release(uuid, uuid, text) to authenticated;

-- ============================================================================================
-- 7. complete_order_with_fulfillment -- confirmed/ready -> completed, fulfilling exactly the
-- existing reservation from the SAME lots reserved at confirm time. Never re-runs FIFO.
-- ============================================================================================
create or replace function inventory_private.complete_order_with_fulfillment(
  p_operation_id uuid, p_order_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_hash text; v_replay jsonb; v_order public.orders%rowtype; v_now timestamptz := clock_timestamp();
  v_alloc record; v_result jsonb;
begin
  if auth.uid() is null or public.is_product_lab_owner() is not true then
    raise exception 'Only the product lab owner may complete an order' using errcode = '42501';
  end if;
  if p_order_id is null then
    raise exception 'An order is required' using errcode = '22023';
  end if;

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

  -- Authorize exactly one status write, then close the window again immediately (see confirm).
  perform set_config('inventory_private.order_transition_authorized', 'true', true);
  update public.orders set status = 'completed', completed_at = v_now, updated_at = v_now where id = p_order_id
  returning * into v_order;
  perform set_config('inventory_private.order_transition_authorized', 'false', true);

  v_result := to_jsonb(v_order);
  update inventory_private.mutation_receipts set result = v_result where operation_id = p_operation_id;
  return v_result;
end;
$$;
revoke all on function inventory_private.complete_order_with_fulfillment(uuid, uuid) from public, anon, authenticated;
grant execute on function inventory_private.complete_order_with_fulfillment(uuid, uuid) to authenticated;

create or replace function public.complete_order_with_fulfillment(p_operation_id uuid, p_order_id uuid) returns jsonb
language sql security invoker set search_path = '' as $$
  select inventory_private.complete_order_with_fulfillment(p_operation_id, p_order_id);
$$;
revoke all on function public.complete_order_with_fulfillment(uuid, uuid) from public, anon, authenticated;
grant execute on function public.complete_order_with_fulfillment(uuid, uuid) to authenticated;

notify pgrst, 'reload schema';
