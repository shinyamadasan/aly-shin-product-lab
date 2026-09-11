-- Wave 2 single-shot invariants: FIFO reservation, release, fulfillment, the Follow-One-Brownie
-- scenario, multi-product all-or-nothing, release-then-re-reserve, idempotency, state-based
-- duplicate protection, and the no-direct-write authority contract (orders.status trigger,
-- order_lines immutability trigger, table grants, CHECK shapes). Concurrency and fault injection
-- run in the .test.ts file (they need real overlapping connections / injected failures).
-- Everything here rolls back -- one transaction, never committed.
begin;

create temporary table w2 as select
  'w2-fob-brownie'::text as fob_product, gen_random_uuid() as fob_batch,
  gen_random_uuid() as fob_exec_a, gen_random_uuid() as fob_exec_b,
  'w2-mp-x'::text as mp_x, 'w2-mp-y'::text as mp_y,
  gen_random_uuid() as mp_x_batch, gen_random_uuid() as mp_y_batch,
  gen_random_uuid() as mp_x_exec, gen_random_uuid() as mp_y_exec,
  'w2-rr-z'::text as rr_product, gen_random_uuid() as rr_batch, gen_random_uuid() as rr_exec,
  'w2-idem-p'::text as idem_product, gen_random_uuid() as idem_batch, gen_random_uuid() as idem_exec,
  'w2-auth-p'::text as auth_product, gen_random_uuid() as auth_batch, gen_random_uuid() as auth_exec,
  gen_random_uuid() as customer_id;
grant select on w2 to authenticated;

insert into public.products (id, name)
  select fob_product, 'FOB Brownie' from w2
  union all select mp_x, 'MP X' from w2
  union all select mp_y, 'MP Y' from w2
  union all select rr_product, 'RR Z' from w2
  union all select idem_product, 'Idem P' from w2
  union all select auth_product, 'Auth P' from w2;

insert into public.product_batches (id, product_id, batch_version, status, usable_pieces)
  select fob_batch, fob_product, 'v1', 'completed', 8 from w2
  union all select mp_x_batch, mp_x, 'v1', 'completed', 20 from w2
  union all select mp_y_batch, mp_y, 'v1', 'completed', 2 from w2
  union all select rr_batch, rr_product, 'v1', 'completed', 10 from w2
  union all select idem_batch, idem_product, 'v1', 'completed', 10 from w2
  union all select auth_batch, auth_product, 'v1', 'completed', 10 from w2;

-- Follow-One-Brownie: Bake A (older, 8 pcs), Bake B (newer, 9 pcs) -> on hand 17.
insert into public.production_executions (id, product_id, product_batch_id, batch_version_snapshot, operation_id, multiplier, quantity_produced_pieces, expected_pieces, frozen_ingredient_cost_total, frozen_cost_per_piece, completed_at)
  select fob_exec_a, fob_product, fob_batch, 'v1', gen_random_uuid(), 1, 8, 8, 80, 10, now() - interval '2 days' from w2
  union all select fob_exec_b, fob_product, fob_batch, 'v1', gen_random_uuid(), 1, 9, 9, 90, 10, now() - interval '1 day' from w2
  union all select mp_x_exec, mp_x, mp_x_batch, 'v1', gen_random_uuid(), 1, 20, 20, 200, 10, now() from w2
  union all select mp_y_exec, mp_y, mp_y_batch, 'v1', gen_random_uuid(), 1, 2, 2, 20, 10, now() from w2
  union all select rr_exec, rr_product, rr_batch, 'v1', gen_random_uuid(), 1, 10, 10, 100, 10, now() from w2
  union all select idem_exec, idem_product, idem_batch, 'v1', gen_random_uuid(), 1, 10, 10, 100, 10, now() from w2
  union all select auth_exec, auth_product, auth_batch, 'v1', gen_random_uuid(), 1, 10, 10, 100, 10, now() from w2;

insert into public.finished_stock_movements (product_id, production_execution_id, movement_type, on_hand_delta, reserved_delta, operation_id, note)
  select fob_product, fob_exec_a, 'production_receipt', 8, 0, gen_random_uuid(), 'seed A' from w2
  union all select fob_product, fob_exec_b, 'production_receipt', 9, 0, gen_random_uuid(), 'seed B' from w2
  union all select mp_x, mp_x_exec, 'production_receipt', 20, 0, gen_random_uuid(), 'seed X' from w2
  union all select mp_y, mp_y_exec, 'production_receipt', 2, 0, gen_random_uuid(), 'seed Y' from w2
  union all select rr_product, rr_exec, 'production_receipt', 10, 0, gen_random_uuid(), 'seed Z' from w2
  union all select idem_product, idem_exec, 'production_receipt', 10, 0, gen_random_uuid(), 'seed idem' from w2
  union all select auth_product, auth_exec, 'production_receipt', 10, 0, gen_random_uuid(), 'seed auth' from w2;

insert into public.customers (id, name) select customer_id, 'Test Customer' from w2;

set local role authenticated;
select set_config('request.jwt.claim.sub', '66666666-6666-4666-8666-666666666666', true);
select set_config('request.jwt.claim.app_role', 'owner', true);
select set_config('request.jwt.claims', '{"sub":"66666666-6666-4666-8666-666666666666","role":"authenticated","app_metadata":{"app_role":"owner"}}', true);

do $$
declare
  w record;
  order1 uuid; order2 uuid; order3 uuid;
  op1 uuid := gen_random_uuid(); op2 uuid := gen_random_uuid(); op3 uuid := gen_random_uuid();
  op_release uuid := gen_random_uuid(); op_fulfill uuid := gen_random_uuid();
  r jsonb;
  v_available integer; v_onhand integer; v_reserved integer;
  v_alloc_count integer;
  order_mp uuid; order_rr_a uuid; order_rr_b uuid; order_idem uuid; order_auth uuid;
  order_auth_cancel uuid; order_new_x uuid;
  op uuid;
  msg text;
  v_avail_before integer;
begin
  select * into w from w2;

  -- ============================================================================================
  -- SECTION 0: the order-status transition-authority trigger (INSERT + UPDATE arms), tested FIRST
  -- and before any RPC in this transaction has run -- the reserve/release/fulfill functions set
  -- inventory_private.order_transition_authorized only for their own status write and clear it
  -- immediately after, so the trigger is default-closed here just as it is in production.
  --
  -- The complete direct-client authority contract:
  --   INSERT: status must be 'new'. confirmed/ready/completed/cancelled are all rejected.
  --   UPDATE: only new -> cancelled and confirmed -> ready. Everything else (new -> confirmed,
  --           new -> ready, new -> completed, any * -> ready that is not confirmed -> ready, and
  --           any resurrection of a terminal order) is rejected. Consequential transitions must
  --           go through the RPCs (proven in Sections A/D).
  -- ============================================================================================

  -- INSERT arm: a client-created order may only be born 'new'.
  for msg in select unnest(array['confirmed', 'ready', 'completed', 'cancelled']) loop
    begin
      insert into public.orders (id, customer_id, status) values (gen_random_uuid(), w.customer_id, msg);
      raise exception 'TEST FAILED: a direct INSERT starting as % must be rejected', msg;
    exception when insufficient_privilege then null; end;
  end loop;
  -- ...and a 'new' insert still works.
  order_new_x := gen_random_uuid();
  insert into public.orders (id, customer_id, status) values (order_new_x, w.customer_id, 'new');
  if (select status from public.orders where id = order_new_x) <> 'new' then
    raise exception 'TEST FAILED: a direct INSERT of a new order must still succeed'; end if;

  -- INSERT arm reaches save_order too (its INSERT ... ON CONFLICT re-proposes the row for
  -- insertion): creating a fresh order at a consequential status through the repository RPC is
  -- rejected, while the same call at 'new' succeeds.
  begin
    perform public.save_order(
      jsonb_build_object('id', gen_random_uuid()::text, 'customer_id', w.customer_id::text, 'status', 'confirmed',
        'payment_status', 'unpaid', 'fulfillment_method', 'pickup', 'source', 'unknown', 'entry_method', 'manual'),
      '[]'::jsonb, array[]::uuid[]);
    raise exception 'TEST FAILED: save_order must not be able to create an order that starts as confirmed';
  exception when insufficient_privilege then null; end;
  declare v_save_new uuid := gen_random_uuid();
  begin
    perform public.save_order(
      jsonb_build_object('id', v_save_new::text, 'customer_id', w.customer_id::text, 'status', 'new',
        'payment_status', 'unpaid', 'fulfillment_method', 'pickup', 'source', 'unknown', 'entry_method', 'manual'),
      '[]'::jsonb, array[]::uuid[]);
    if (select status from public.orders where id = v_save_new) <> 'new' then
      raise exception 'TEST FAILED: save_order creating a new order must still succeed'; end if;
  end;

  -- UPDATE arm: order_auth stays 'new' for Section D's RPC confirm (its status column is untouched
  -- until then). new -> confirmed and new -> ready are both rejected direct.
  order_auth := gen_random_uuid();
  insert into public.orders (id, customer_id, status) values (order_auth, w.customer_id, 'new');
  insert into public.order_lines (id, order_id, product_id, item_name, unit_price, pieces_per_unit_snapshot, quantity) values
    (gen_random_uuid(), order_auth, w.auth_product, 'Auth box', 100, 4, 1);

  begin
    update public.orders set status = 'confirmed', updated_at = now() where id = order_auth;
    raise exception 'TEST FAILED: a direct client UPDATE must not be able to set orders.status = confirmed';
  exception when insufficient_privilege then null; end;
  begin
    update public.orders set status = 'ready', updated_at = now() where id = order_auth;
    raise exception 'TEST FAILED: new -> ready must be rejected as a direct client write (only confirmed -> ready is allowed)';
  exception when insufficient_privilege then null; end;
  begin
    update public.orders set status = 'completed', updated_at = now() where id = order_auth;
    raise exception 'TEST FAILED: new -> completed must be rejected as a direct client write';
  exception when insufficient_privilege then null; end;
  if (select status from public.orders where id = order_auth) <> 'new' then
    raise exception 'TEST FAILED: the rejected direct updates must not have changed anything'; end if;

  -- new -> cancelled IS allowed direct (nothing reserved) and must have ZERO stock effect.
  order_auth_cancel := gen_random_uuid();
  insert into public.orders (id, customer_id, status) values (order_auth_cancel, w.customer_id, 'new');
  insert into public.order_lines (id, order_id, product_id, item_name, unit_price, pieces_per_unit_snapshot, quantity) values
    (gen_random_uuid(), order_auth_cancel, w.auth_product, 'Auth box', 100, 4, 1);
  select coalesce(sum(on_hand_delta),0) - coalesce(sum(reserved_delta),0) into v_avail_before
    from public.finished_stock_movements where product_id = w.auth_product;
  update public.orders set status = 'cancelled', cancelled_at = now(), cancel_reason = 'duplicate', updated_at = now()
    where id = order_auth_cancel and status = 'new';
  if (select status from public.orders where id = order_auth_cancel) <> 'cancelled' then
    raise exception 'TEST FAILED: new -> cancelled must be allowed as a direct client write'; end if;
  if exists (select 1 from public.order_stock_allocations where order_id = order_auth_cancel) then
    raise exception 'TEST FAILED: new -> cancelled must create zero allocations'; end if;
  if (select coalesce(sum(on_hand_delta),0) - coalesce(sum(reserved_delta),0)
        from public.finished_stock_movements where product_id = w.auth_product) <> v_avail_before then
    raise exception 'TEST FAILED: new -> cancelled must not move availability at all'; end if;
  if exists (select 1 from public.finished_stock_movements where order_id = order_auth_cancel) then
    raise exception 'TEST FAILED: new -> cancelled must write no reserve/release/fulfill movement'; end if;

  -- A cancelled (terminal) order cannot be resurrected by a direct write.
  begin
    update public.orders set status = 'ready', updated_at = now() where id = order_auth_cancel;
    raise exception 'TEST FAILED: cancelled -> ready must be rejected (terminal resurrection)';
  exception when insufficient_privilege then null; end;
  begin
    update public.orders set status = 'confirmed', updated_at = now() where id = order_auth_cancel;
    raise exception 'TEST FAILED: cancelled -> confirmed must be rejected (terminal resurrection)';
  exception when insufficient_privilege then null; end;

  -- ============================================================================================
  -- SECTION A: Follow One Brownie (spec section 35). on_hand=17, reserved=0, available=17.
  -- ============================================================================================
  order1 := gen_random_uuid(); order2 := gen_random_uuid(); order3 := gen_random_uuid();
  insert into public.orders (id, customer_id, status) values
    (order1, w.customer_id, 'new'), (order2, w.customer_id, 'new'), (order3, w.customer_id, 'new');
  insert into public.order_lines (id, order_id, product_id, item_name, unit_price, pieces_per_unit_snapshot, quantity) values
    (gen_random_uuid(), order1, w.fob_product, 'Box of 6', 480, 6, 1),
    (gen_random_uuid(), order2, w.fob_product, 'Box of 4', 320, 4, 2),
    (gen_random_uuid(), order3, w.fob_product, 'Box of 6', 480, 6, 1);

  select coalesce(sum(on_hand_delta),0), coalesce(sum(reserved_delta),0) into v_onhand, v_reserved
    from public.finished_stock_movements where product_id = w.fob_product;
  if v_onhand <> 17 or v_reserved <> 0 then raise exception 'TEST FAILED: FOB baseline must be on_hand=17 reserved=0, got %/%', v_onhand, v_reserved; end if;

  -- Confirm order 1 (needs 6): all from A (oldest). on_hand=17 reserved=6 available=11.
  r := public.confirm_order_with_reservation(op1, order1);
  if r->>'status' <> 'confirmed' then raise exception 'TEST FAILED: order1 must confirm, got %', r->>'status'; end if;
  select coalesce(sum(on_hand_delta),0), coalesce(sum(reserved_delta),0) into v_onhand, v_reserved
    from public.finished_stock_movements where product_id = w.fob_product;
  if v_onhand <> 17 or v_reserved <> 6 then raise exception 'TEST FAILED: after order1 confirm must be on_hand=17 reserved=6, got %/%', v_onhand, v_reserved; end if;
  if (select reserved_pieces from public.order_stock_allocations where order_id = order1 and production_execution_id = w.fob_exec_a) <> 6 then
    raise exception 'TEST FAILED: order1 must allocate all 6 from execution A (FIFO oldest first)'; end if;
  if exists (select 1 from public.order_stock_allocations where order_id = order1 and production_execution_id = w.fob_exec_b) then
    raise exception 'TEST FAILED: order1 must not touch execution B at all'; end if;

  -- Exact retry of order1's confirm: replays, does not double-reserve.
  r := public.confirm_order_with_reservation(op1, order1);
  select coalesce(sum(reserved_delta),0) into v_reserved from public.finished_stock_movements where product_id = w.fob_product;
  if v_reserved <> 6 then raise exception 'TEST FAILED: exact retry of confirm must not double-reserve, reserved = %', v_reserved; end if;
  if (select count(*) from public.order_stock_allocations where order_id = order1) <> 1 then
    raise exception 'TEST FAILED: exact retry must not create a second allocation row'; end if;

  -- Fresh operation id trying to re-confirm the ALREADY-confirmed order1: must be rejected, zero effect.
  begin
    perform public.confirm_order_with_reservation(gen_random_uuid(), order1);
    raise exception 'TEST FAILED: re-confirming an already-confirmed order under a fresh operation id must be rejected';
  exception when check_violation then null; end;
  select coalesce(sum(reserved_delta),0) into v_reserved from public.finished_stock_movements where product_id = w.fob_product;
  if v_reserved <> 6 then raise exception 'TEST FAILED: rejected re-confirm attempt must not change reserved, got %', v_reserved; end if;

  -- Changed replay: same op1 id, a DIFFERENT order -- must be rejected as a changed payload, not silently applied.
  begin
    perform public.confirm_order_with_reservation(op1, order2);
    raise exception 'TEST FAILED: reusing op1 for a different order must be rejected';
  exception when check_violation then null; end;

  -- Confirm order 2 (needs 8): A has 2 left (8-6), B has 9 -> A:2, B:6. on_hand=17 reserved=14 available=3.
  r := public.confirm_order_with_reservation(op2, order2);
  if r->>'status' <> 'confirmed' then raise exception 'TEST FAILED: order2 must confirm, got %', r->>'status'; end if;
  select coalesce(sum(on_hand_delta),0), coalesce(sum(reserved_delta),0) into v_onhand, v_reserved
    from public.finished_stock_movements where product_id = w.fob_product;
  if v_onhand <> 17 or v_reserved <> 14 then raise exception 'TEST FAILED: after order2 confirm must be on_hand=17 reserved=14, got %/%', v_onhand, v_reserved; end if;
  if (select reserved_pieces from public.order_stock_allocations where order_id = order2 and production_execution_id = w.fob_exec_a) <> 2 then
    raise exception 'TEST FAILED: order2 must take exactly the 2 remaining pieces from execution A'; end if;
  if (select reserved_pieces from public.order_stock_allocations where order_id = order2 and production_execution_id = w.fob_exec_b) <> 6 then
    raise exception 'TEST FAILED: order2 must take the remaining 6 needed from execution B'; end if;

  -- Confirm order 3 (needs 6, only 3 available): must be rejected WHOLESALE, zero allocations.
  begin
    perform public.confirm_order_with_reservation(op3, order3);
    raise exception 'TEST FAILED: order3 must be rejected for insufficient stock';
  exception when check_violation then
    get stacked diagnostics msg = message_text;
    if msg not like '%requires 6 pieces, but only 3 are available%' then
      raise exception 'TEST FAILED: insufficient-stock message must name the exact shortfall, got: %', msg;
    end if;
  end;
  if exists (select 1 from public.order_stock_allocations where order_id = order3) then
    raise exception 'TEST FAILED: a rejected confirmation must leave zero allocations'; end if;
  if (select status from public.orders where id = order3) <> 'new' then
    raise exception 'TEST FAILED: order3 must remain new after a rejected confirmation'; end if;

  -- Cancel order 2: release exactly its reservation (A:2, B:6). on_hand=17 reserved=6 available=11.
  r := public.cancel_order_with_release(op_release, order2, 'testing release');
  if r->>'status' <> 'cancelled' then raise exception 'TEST FAILED: order2 must cancel, got %', r->>'status'; end if;
  select coalesce(sum(on_hand_delta),0), coalesce(sum(reserved_delta),0) into v_onhand, v_reserved
    from public.finished_stock_movements where product_id = w.fob_product;
  if v_onhand <> 17 or v_reserved <> 6 then raise exception 'TEST FAILED: after order2 cancel must be on_hand=17 reserved=6, got %/%', v_onhand, v_reserved; end if;
  if exists (select 1 from public.order_stock_allocations where order_id = order2 and status <> 'released') then
    raise exception 'TEST FAILED: every order2 allocation must be released'; end if;
  -- order1's allocation is untouched by order2's release -- lots stay isolated per order.
  if (select status from public.order_stock_allocations where order_id = order1) <> 'active' then
    raise exception 'TEST FAILED: order1 allocation must stay active, unaffected by order2 cancelling'; end if;

  -- Exact retry of the release: replays, does not double-release.
  r := public.cancel_order_with_release(op_release, order2, 'testing release');
  select coalesce(sum(reserved_delta),0) into v_reserved from public.finished_stock_movements where product_id = w.fob_product;
  if v_reserved <> 6 then raise exception 'TEST FAILED: exact retry of release must not double-release, reserved = %', v_reserved; end if;

  -- A cancelled order cannot be fulfilled.
  begin
    perform public.complete_order_with_fulfillment(gen_random_uuid(), order2);
    raise exception 'TEST FAILED: a cancelled order must not be fulfillable';
  exception when check_violation then null; end;

  -- Fulfill order 1: consumes exactly its A:6 allocation. on_hand=11 reserved=0 available=11.
  r := public.complete_order_with_fulfillment(op_fulfill, order1);
  if r->>'status' <> 'completed' then raise exception 'TEST FAILED: order1 must complete, got %', r->>'status'; end if;
  select coalesce(sum(on_hand_delta),0), coalesce(sum(reserved_delta),0) into v_onhand, v_reserved
    from public.finished_stock_movements where product_id = w.fob_product;
  if v_onhand <> 11 or v_reserved <> 0 then raise exception 'TEST FAILED: after order1 fulfill must be on_hand=11 reserved=0, got %/%', v_onhand, v_reserved; end if;
  if (select status from public.order_stock_allocations where order_id = order1) <> 'fulfilled' then
    raise exception 'TEST FAILED: order1 allocation must be fulfilled'; end if;
  -- The database can explain which execution supplied order1: exactly A, exactly 6 pieces.
  if (select count(*) from public.order_stock_allocations where order_id = order1) <> 1
     or (select production_execution_id from public.order_stock_allocations where order_id = order1) <> w.fob_exec_a
     or (select reserved_pieces from public.order_stock_allocations where order_id = order1) <> 6 then
    raise exception 'TEST FAILED: order1 provenance must be exactly execution A, 6 pieces';
  end if;

  -- Exact retry of the fulfillment: replays, does not double-consume on-hand.
  r := public.complete_order_with_fulfillment(op_fulfill, order1);
  select coalesce(sum(on_hand_delta),0) into v_onhand from public.finished_stock_movements where product_id = w.fob_product;
  if v_onhand <> 11 then raise exception 'TEST FAILED: exact retry of fulfillment must not double-consume on_hand, got %', v_onhand; end if;

  -- A completed order cannot be cancelled/released.
  begin
    perform public.cancel_order_with_release(gen_random_uuid(), order1, 'too late');
    raise exception 'TEST FAILED: a completed order must not be cancellable';
  exception when check_violation then null; end;

  -- ============================================================================================
  -- SECTION B: multi-product atomicity (spec section 11). X has 20 available (order needs 6),
  -- Y has only 2 available (order needs 4). Confirmation must fail WHOLESALE: zero reservation on
  -- EITHER product, not just the short one.
  -- ============================================================================================
  order_mp := gen_random_uuid();
  insert into public.orders (id, customer_id, status) values (order_mp, w.customer_id, 'new');
  insert into public.order_lines (id, order_id, product_id, item_name, unit_price, pieces_per_unit_snapshot, quantity) values
    (gen_random_uuid(), order_mp, w.mp_x, 'X box', 100, 6, 1),
    (gen_random_uuid(), order_mp, w.mp_y, 'Y box', 100, 4, 1);

  begin
    perform public.confirm_order_with_reservation(gen_random_uuid(), order_mp);
    raise exception 'TEST FAILED: multi-product order must be rejected when any one product is short';
  exception when check_violation then null; end;

  if exists (select 1 from public.order_stock_allocations where order_id = order_mp) then
    raise exception 'TEST FAILED: a rejected multi-product confirmation must leave zero allocations, including for the SUFFICIENT product'; end if;
  select coalesce(sum(reserved_delta),0) into v_reserved from public.finished_stock_movements where product_id = w.mp_x;
  if v_reserved <> 0 then raise exception 'TEST FAILED: the sufficient product (X) must show zero reservation after the whole order was rejected, got %', v_reserved; end if;

  -- ============================================================================================
  -- SECTION C: release then re-reserve (spec section 34). Available 10. Order A reserves 6 ->
  -- available 4. Order B needs 6 -> rejected. Cancel A -> available restored to 10. Order B
  -- retried (fresh operation id, since its first attempt never reserved anything) succeeds.
  -- ============================================================================================
  order_rr_a := gen_random_uuid(); order_rr_b := gen_random_uuid();
  insert into public.orders (id, customer_id, status) values (order_rr_a, w.customer_id, 'new'), (order_rr_b, w.customer_id, 'new');
  insert into public.order_lines (id, order_id, product_id, item_name, unit_price, pieces_per_unit_snapshot, quantity) values
    (gen_random_uuid(), order_rr_a, w.rr_product, 'Z box', 100, 6, 1),
    (gen_random_uuid(), order_rr_b, w.rr_product, 'Z box', 100, 6, 1);

  perform public.confirm_order_with_reservation(gen_random_uuid(), order_rr_a);
  select coalesce(sum(on_hand_delta),0) - coalesce(sum(reserved_delta),0) into v_available from public.finished_stock_movements where product_id = w.rr_product;
  if v_available <> 4 then raise exception 'TEST FAILED: after A reserves 6 of 10, available must be 4, got %', v_available; end if;

  begin
    perform public.confirm_order_with_reservation(gen_random_uuid(), order_rr_b);
    raise exception 'TEST FAILED: order B must be rejected with only 4 available';
  exception when check_violation then null; end;

  perform public.cancel_order_with_release(gen_random_uuid(), order_rr_a, 'freeing stock for the re-reserve test');
  select coalesce(sum(on_hand_delta),0) - coalesce(sum(reserved_delta),0) into v_available from public.finished_stock_movements where product_id = w.rr_product;
  if v_available <> 10 then raise exception 'TEST FAILED: after cancelling A, available must be restored to 10, got %', v_available; end if;

  r := public.confirm_order_with_reservation(gen_random_uuid(), order_rr_b);
  if r->>'status' <> 'confirmed' then raise exception 'TEST FAILED: order B must now confirm successfully, got %', r->>'status'; end if;

  -- ============================================================================================
  -- SECTION D: order line immutability once reservation-consequential (spec sections 17/31/36).
  -- order_auth was created and status-authority-tested in Section 0, above, before any RPC in
  -- this transaction had run; it is still 'new' here.
  -- ============================================================================================
  perform public.confirm_order_with_reservation(gen_random_uuid(), order_auth);
  if (select status from public.orders where id = order_auth) <> 'confirmed' then
    raise exception 'TEST FAILED: order_auth must be confirmed via the RPC for the rest of this section'; end if;

  -- Once confirmed, order_lines become immutable to a direct client write.
  begin
    update public.order_lines set quantity = 99 where order_id = order_auth;
    raise exception 'TEST FAILED: order_lines must be immutable once the order is confirmed';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.order_lines (id, order_id, product_id, item_name, unit_price, pieces_per_unit_snapshot, quantity)
      values (gen_random_uuid(), order_auth, w.auth_product, 'sneaked in', 1, 1, 1);
    raise exception 'TEST FAILED: a new order_lines row must not be insertable once the order is confirmed';
  exception when insufficient_privilege then null; end;
  begin
    delete from public.order_lines where order_id = order_auth;
    raise exception 'TEST FAILED: order_lines must not be deletable once the order is confirmed';
  exception when insufficient_privilege then null; end;

  -- Ordinary clients cannot write the reservation ledger or allocation table directly, only read.
  begin
    insert into public.order_stock_allocations (order_id, product_id, production_execution_id, operation_id, reserved_pieces)
      values (order_auth, w.auth_product, w.auth_exec, gen_random_uuid(), 1);
    raise exception 'TEST FAILED: direct order_stock_allocations insert must be rejected';
  exception when insufficient_privilege then null; end;
  begin
    update public.order_stock_allocations set reserved_pieces = 999 where order_id = order_auth;
    raise exception 'TEST FAILED: direct order_stock_allocations update must be rejected';
  exception when insufficient_privilege then null; end;
  begin
    delete from public.order_stock_allocations where order_id = order_auth;
    raise exception 'TEST FAILED: direct order_stock_allocations delete must be rejected';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.finished_stock_movements (product_id, production_execution_id, movement_type, on_hand_delta, reserved_delta, operation_id, order_id, order_stock_allocation_id)
      values (w.auth_product, w.auth_exec, 'reserve', 0, 4, gen_random_uuid(), order_auth, (select id from public.order_stock_allocations where order_id = order_auth limit 1));
    raise exception 'TEST FAILED: direct finished_stock_movements reserve insert must be rejected';
  exception when insufficient_privilege then null; end;

  -- Owner can still read everything Wave 2 added.
  if not exists (select 1 from public.order_stock_allocations where order_id = order_auth) then
    raise exception 'TEST FAILED: owner must be able to read its own order_stock_allocations'; end if;
  if not exists (select 1 from public.finished_stock_movements where order_id = order_auth) then
    raise exception 'TEST FAILED: owner must be able to read its own order-linked finished_stock_movements'; end if;

  -- Wave 1's confirm_bake_v3 must remain unaffected by Wave 2.
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'confirm_bake_v3') then
    raise exception 'TEST FAILED: confirm_bake_v3 must still exist'; end if;

  -- ============================================================================================
  -- SECTION D.5: direct-client status authority AFTER the RPCs have run in this transaction --
  -- proves confirmed -> ready is the one allowed '* -> ready', that a `ready` order cannot be
  -- moved further by a direct write, that terminal orders cannot be resurrected, and (the flag
  -- lifetime) that a direct consequential write immediately after an RPC returns is still refused.
  -- ============================================================================================
  -- order_auth is 'confirmed' (Section D). confirmed -> ready is allowed direct, moves no stock.
  select coalesce(sum(reserved_delta),0) into v_reserved from public.finished_stock_movements where product_id = w.auth_product;
  update public.orders set status = 'ready', updated_at = now() where id = order_auth and status = 'confirmed';
  if (select status from public.orders where id = order_auth) <> 'ready' then
    raise exception 'TEST FAILED: confirmed -> ready must be allowed as a direct client write'; end if;
  if (select coalesce(sum(reserved_delta),0) from public.finished_stock_movements where product_id = w.auth_product) <> v_reserved then
    raise exception 'TEST FAILED: confirmed -> ready must not move the reservation'; end if;
  if (select count(*) from public.order_stock_allocations where order_id = order_auth and status = 'active') <> 1 then
    raise exception 'TEST FAILED: confirmed -> ready must leave the allocation active and unchanged'; end if;

  -- From `ready`, every direct status change is refused -- completed and cancelled are
  -- consequential (RPC-only), and ready -> confirmed is a backward move.
  begin
    update public.orders set status = 'completed', updated_at = now() where id = order_auth;
    raise exception 'TEST FAILED: ready -> completed must be rejected as a direct client write';
  exception when insufficient_privilege then null; end;
  begin
    update public.orders set status = 'cancelled', updated_at = now() where id = order_auth;
    raise exception 'TEST FAILED: ready -> cancelled must be rejected as a direct client write';
  exception when insufficient_privilege then null; end;
  begin
    update public.orders set status = 'confirmed', updated_at = now() where id = order_auth;
    raise exception 'TEST FAILED: ready -> confirmed must be rejected as a direct client write';
  exception when insufficient_privilege then null; end;
  if (select status from public.orders where id = order_auth) <> 'ready' then
    raise exception 'TEST FAILED: the rejected direct updates from ready must not have changed anything'; end if;

  -- order_rr_b is 'confirmed' (Section C). Fulfill it via the RPC, then prove the flag did NOT
  -- stay open: a direct new -> completed on a different order immediately afterwards is refused.
  perform public.complete_order_with_fulfillment(gen_random_uuid(), order_rr_b);
  begin
    update public.orders set status = 'completed', updated_at = now() where id = order_new_x;
    raise exception 'TEST FAILED: the order_transition_authorized flag must not survive the RPC that set it';
  exception when insufficient_privilege then null; end;

  -- A completed (terminal) order cannot be resurrected by a direct write.
  begin
    update public.orders set status = 'ready', updated_at = now() where id = order_rr_b;
    raise exception 'TEST FAILED: completed -> ready must be rejected (terminal resurrection)';
  exception when insufficient_privilege then null; end;
  begin
    update public.orders set status = 'confirmed', updated_at = now() where id = order_rr_b;
    raise exception 'TEST FAILED: completed -> confirmed must be rejected (terminal resurrection)';
  exception when insufficient_privilege then null; end;
end;
$$;

-- ==============================================================================================
-- SECTION E: CHECK constraint shapes. Run as the table owner (superuser session, RLS/grants do
-- not apply) so a malformed row can actually reach the constraint instead of being stopped by
-- authority first -- this isolates "does the constraint itself work" from "can a client reach it".
-- ==============================================================================================
reset role;

do $$
declare
  w record;
  -- A real, already-existing allocation (order_auth's, from Section D) so these rows only violate
  -- the SHAPE check under test and not an unrelated foreign key -- isolating what is being proven.
  real_alloc record;
begin
  select * into w from w2;
  select id as alloc_id, order_id, product_id, production_execution_id
    into real_alloc
    from public.order_stock_allocations
    limit 1;

  -- reserve must have on_hand_delta = 0 and reserved_delta > 0.
  begin
    insert into public.finished_stock_movements (product_id, production_execution_id, movement_type, on_hand_delta, reserved_delta, operation_id, order_id, order_stock_allocation_id)
      values (real_alloc.product_id, real_alloc.production_execution_id, 'reserve', 1, 4, gen_random_uuid(), real_alloc.order_id, real_alloc.alloc_id);
    raise exception 'TEST FAILED: a reserve row with a nonzero on_hand_delta must be rejected by the constraint';
  exception when check_violation then null; end;

  -- release must have reserved_delta < 0.
  begin
    insert into public.finished_stock_movements (product_id, production_execution_id, movement_type, on_hand_delta, reserved_delta, operation_id, order_id, order_stock_allocation_id)
      values (real_alloc.product_id, real_alloc.production_execution_id, 'release', 0, 4, gen_random_uuid(), real_alloc.order_id, real_alloc.alloc_id);
    raise exception 'TEST FAILED: a release row with a positive reserved_delta must be rejected';
  exception when check_violation then null; end;

  -- fulfill's on_hand_delta and reserved_delta must be the SAME negative quantity.
  begin
    insert into public.finished_stock_movements (product_id, production_execution_id, movement_type, on_hand_delta, reserved_delta, operation_id, order_id, order_stock_allocation_id)
      values (real_alloc.product_id, real_alloc.production_execution_id, 'fulfill', -6, -4, gen_random_uuid(), real_alloc.order_id, real_alloc.alloc_id);
    raise exception 'TEST FAILED: a fulfill row whose on_hand_delta and reserved_delta disagree must be rejected';
  exception when check_violation then null; end;

  -- reserve/release/fulfill all require order_id + order_stock_allocation_id + production_execution_id.
  begin
    insert into public.finished_stock_movements (product_id, movement_type, on_hand_delta, reserved_delta, operation_id)
      values (w.fob_product, 'reserve', 0, 4, gen_random_uuid());
    raise exception 'TEST FAILED: a reserve row with no order/allocation/execution linkage must be rejected';
  exception when check_violation then null; end;

  -- production_receipt must NOT carry order linkage.
  begin
    insert into public.finished_stock_movements (product_id, production_execution_id, movement_type, on_hand_delta, reserved_delta, operation_id, order_id)
      values (w.fob_product, w.fob_exec_a, 'production_receipt', 5, 0, gen_random_uuid(), real_alloc.order_id);
    raise exception 'TEST FAILED: a production_receipt row must not be allowed to carry an order_id';
  exception when check_violation then null; end;

  -- order_stock_allocations uniqueness backstop: the same order cannot allocate the same
  -- production execution twice.
  begin
    insert into public.order_stock_allocations (order_id, product_id, production_execution_id, operation_id, reserved_pieces)
      values (real_alloc.order_id, real_alloc.product_id, real_alloc.production_execution_id, gen_random_uuid(), 1);
    raise exception 'TEST FAILED: a duplicate (order_id, production_execution_id) allocation must be rejected';
  exception when unique_violation then null; end;
end;
$$;

rollback;
select 'wave_2_assertions_passed';
