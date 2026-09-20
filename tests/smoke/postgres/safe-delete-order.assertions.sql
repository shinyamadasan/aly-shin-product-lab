-- Safe Delete Order single-shot invariants. Everything here rolls back -- one transaction, never
-- committed. Runs on a disposable Postgres with Wave 0A/0B/1/2 and supabase-add-orders.sql applied.
begin;

insert into public.products (id, name) values ('sd-p', 'SD Product');
insert into public.product_batches (id, product_id, batch_version, status, usable_pieces)
  values ('aaaaaaaa-0000-4000-8000-000000000001', 'sd-p', 'v1', 'completed', 20);
insert into public.production_executions (id, product_id, product_batch_id, batch_version_snapshot, operation_id, multiplier, quantity_produced_pieces, expected_pieces, frozen_ingredient_cost_total, frozen_cost_per_piece, completed_at)
  values ('bbbbbbbb-0000-4000-8000-000000000001', 'sd-p', 'aaaaaaaa-0000-4000-8000-000000000001', 'v1', gen_random_uuid(), 1, 20, 20, 200, 10, now());
insert into public.finished_stock_movements (product_id, production_execution_id, movement_type, on_hand_delta, reserved_delta, operation_id, note)
  values ('sd-p', 'bbbbbbbb-0000-4000-8000-000000000001', 'production_receipt', 20, 0, gen_random_uuid(), 'seed');
insert into public.customers (id, name) values ('cccccccc-0000-4000-8000-000000000001', 'SD Customer');

-- Asserts safe_delete_order refuses with the given SQLSTATE and message pattern. The failing call is
-- inside a sub-block, so its claim_mutation receipt rolls back with it (the operation id stays free).
create function public.t_expect_refused(p_state text, p_msg_like text, p_order uuid, p_expected timestamptz)
returns void language plpgsql as $$
declare v_state text; v_msg text;
begin
  perform public.safe_delete_order(gen_random_uuid(), p_order, p_expected);
  raise exception 'TEST FAILED: delete should have been refused (wanted % / %)', p_state, p_msg_like;
exception when others then
  get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
  if v_msg like 'TEST FAILED%' then raise; end if;
  if v_state <> p_state or v_msg not like p_msg_like then
    raise exception 'TEST FAILED: refused with % / "%", wanted % / "%"', v_state, v_msg, p_state, p_msg_like;
  end if;
end;
$$;
grant execute on function public.t_expect_refused(text, text, uuid, timestamptz) to authenticated;

set local role authenticated;
select set_config('request.jwt.claim.sub', '88888888-8888-4888-8888-888888888888', true);
select set_config('request.jwt.claim.app_role', 'owner', true);
select set_config('request.jwt.claims', '{"sub":"88888888-8888-4888-8888-888888888888","role":"authenticated","app_metadata":{"app_role":"owner"}}', true);

do $$
declare
  cust constant uuid := 'cccccccc-0000-4000-8000-000000000001';
  o_ok uuid := gen_random_uuid(); o_stale uuid := gen_random_uuid(); o_race uuid := gen_random_uuid();
  o_conf uuid := gen_random_uuid(); o_ready uuid := gen_random_uuid(); o_done uuid := gen_random_uuid();
  o_cancel uuid := gen_random_uuid(); o_paid uuid := gen_random_uuid(); o_refunded uuid := gen_random_uuid();
  o_cleared uuid := gen_random_uuid(); o_partial uuid := gen_random_uuid(); o_alloc uuid := gen_random_uuid();
  o_web uuid := gen_random_uuid(); o_direct uuid := gen_random_uuid(); o_replay uuid := gen_random_uuid();
  o_cancel_rpc uuid := gen_random_uuid();
  v_ts timestamptz; op uuid; r jsonb; r2 jsonb; n integer; v_available integer;
  v_alloc_before integer; v_mov_before integer;
begin
  -- Fixture helper (inline): a 'new', manual, unpaid order with N lines of the stock product.
  -- ---- 1. Eligible order: deleted with its lines, customer survives -----------------------------
  insert into public.orders (id, customer_id, status) values (o_ok, cust, 'new');
  insert into public.order_lines (id, order_id, product_id, item_name, unit_price, pieces_per_unit_snapshot, quantity) values
    (gen_random_uuid(), o_ok, 'sd-p', 'Line A', 100, 2, 1),
    (gen_random_uuid(), o_ok, null, 'Custom', 50, null, 1);
  select updated_at into v_ts from public.orders where id = o_ok;
  op := gen_random_uuid();
  r := public.safe_delete_order(op, o_ok, v_ts);
  if (r->>'deleted') <> 'true' or (r->>'lines_deleted')::int <> 2 then raise exception 'TEST FAILED: eligible delete result %', r; end if;
  if exists (select 1 from public.orders where id = o_ok) then raise exception 'TEST FAILED: order must be gone'; end if;
  if exists (select 1 from public.order_lines where order_id = o_ok) then raise exception 'TEST FAILED: its lines must be gone'; end if;
  if not exists (select 1 from public.customers where id = cust) then raise exception 'TEST FAILED: the customer must survive an order delete'; end if;

  -- ---- 2. Retry after success: same op id replays; a new op id finds no order -------------------
  r2 := public.safe_delete_order(op, o_ok, v_ts);
  if r2 is distinct from r then raise exception 'TEST FAILED: same-operation retry must replay the stored result, got %', r2; end if;
  perform public.t_expect_refused('22023', 'Order not found', o_ok, v_ts);
  -- Reusing the op id for a different order is refused, not replayed.
  begin
    perform public.safe_delete_order(op, gen_random_uuid(), v_ts);
    raise exception 'TEST FAILED: an operation id reused for a different order must be refused';
  exception when others then
    if sqlerrm like 'TEST FAILED%' then raise; end if;
    if sqlstate <> '23514' then raise exception 'TEST FAILED: reused op id gave %', sqlstate; end if;
  end;

  -- ---- 3. Stale expected updated_at --------------------------------------------------------------
  insert into public.orders (id, customer_id, status) values (o_stale, cust, 'new');
  select updated_at into v_ts from public.orders where id = o_stale;
  update public.orders set notes = 'edited after the screen loaded', updated_at = v_ts + interval '1 second' where id = o_stale;
  perform public.t_expect_refused('40001', 'This order changed since you opened it%', o_stale, v_ts);
  if not exists (select 1 from public.orders where id = o_stale) then raise exception 'TEST FAILED: a stale delete must leave the order'; end if;

  -- ---- 4. NEW -> CONFIRMED between the UI read and the delete -----------------------------------
  insert into public.orders (id, customer_id, status) values (o_race, cust, 'new');
  insert into public.order_lines (id, order_id, product_id, item_name, unit_price, pieces_per_unit_snapshot, quantity)
    values (gen_random_uuid(), o_race, 'sd-p', 'Race line', 100, 2, 1);
  select updated_at into v_ts from public.orders where id = o_race;   -- what the screen held
  perform public.confirm_order_with_reservation(gen_random_uuid(), o_race);
  perform public.t_expect_refused('40001', 'This order changed since you opened it%', o_race, v_ts);
  -- Even with the CURRENT version, a confirmed order is refused on status.
  select updated_at into v_ts from public.orders where id = o_race;
  perform public.t_expect_refused('23514', 'Only new orders can be permanently deleted%', o_race, v_ts);

  -- ---- 5-8. confirmed / ready / completed / cancelled ---------------------------------------------
  insert into public.orders (id, customer_id, status) values (o_conf, cust, 'new');
  insert into public.order_lines (id, order_id, product_id, item_name, unit_price, pieces_per_unit_snapshot, quantity) values (gen_random_uuid(), o_conf, 'sd-p', 'L', 100, 1, 1);
  perform public.confirm_order_with_reservation(gen_random_uuid(), o_conf);
  select updated_at into v_ts from public.orders where id = o_conf;
  perform public.t_expect_refused('23514', 'Only new orders can be permanently deleted%', o_conf, v_ts);

  insert into public.orders (id, customer_id, status) values (o_ready, cust, 'new');
  insert into public.order_lines (id, order_id, product_id, item_name, unit_price, pieces_per_unit_snapshot, quantity) values (gen_random_uuid(), o_ready, 'sd-p', 'L', 100, 1, 1);
  perform public.confirm_order_with_reservation(gen_random_uuid(), o_ready);
  update public.orders set status = 'ready', updated_at = now() where id = o_ready;
  select updated_at into v_ts from public.orders where id = o_ready;
  perform public.t_expect_refused('23514', 'Only new orders can be permanently deleted%', o_ready, v_ts);

  insert into public.orders (id, customer_id, status) values (o_done, cust, 'new');
  insert into public.order_lines (id, order_id, product_id, item_name, unit_price, pieces_per_unit_snapshot, quantity) values (gen_random_uuid(), o_done, 'sd-p', 'L', 100, 1, 1);
  perform public.confirm_order_with_reservation(gen_random_uuid(), o_done);
  perform public.complete_order_with_fulfillment(gen_random_uuid(), o_done);
  select updated_at into v_ts from public.orders where id = o_done;
  perform public.t_expect_refused('23514', 'Only new orders can be permanently deleted%', o_done, v_ts);

  insert into public.orders (id, customer_id, status) values (o_cancel, cust, 'new');
  update public.orders set status = 'cancelled', cancelled_at = now(), updated_at = now() where id = o_cancel;
  select updated_at into v_ts from public.orders where id = o_cancel;
  perform public.t_expect_refused('23514', 'Only new orders can be permanently deleted%', o_cancel, v_ts);

  -- ---- 9-11. Payment on record: paid, refunded, and partial payment evidence ---------------------
  insert into public.orders (id, customer_id, status, payment_status, payment_method, paid_at, paid_amount)
    values (o_paid, cust, 'new', 'paid', 'cash', now(), 100);
  select updated_at into v_ts from public.orders where id = o_paid;
  perform public.t_expect_refused('23514', 'This order has a payment on record%', o_paid, v_ts);

  insert into public.orders (id, customer_id, status, payment_status, payment_method, paid_at, paid_amount, refunded_at)
    values (o_refunded, cust, 'new', 'refunded', 'cash', now(), 100, now());
  select updated_at into v_ts from public.orders where id = o_refunded;
  perform public.t_expect_refused('23514', 'This order has a payment on record%', o_refunded, v_ts);

  -- 'unpaid' with a leftover payment field is still evidence of a payment -- blocked.
  insert into public.orders (id, customer_id, status, payment_method) values (o_partial, cust, 'new', 'gcash');
  select updated_at into v_ts from public.orders where id = o_partial;
  perform public.t_expect_refused('23514', 'This order has a payment on record%', o_partial, v_ts);

  -- KNOWN LIMIT, asserted so it cannot be forgotten: a payment that was recorded and then CLEARED
  -- (paid -> "Clear payment record" -> unpaid, all fields null) leaves no trace, so the schema cannot
  -- tell this order from one that was never paid. It is therefore deletable, and the wording only
  -- ever claims "no payment on record", never "never paid".
  insert into public.orders (id, customer_id, status, payment_status, payment_method, paid_at, paid_amount)
    values (o_cleared, cust, 'new', 'paid', 'cash', now(), 100);
  update public.orders set payment_status = 'unpaid', payment_method = null, paid_at = null, paid_amount = null, updated_at = now() where id = o_cleared;
  select updated_at into v_ts from public.orders where id = o_cleared;
  r := public.safe_delete_order(gen_random_uuid(), o_cleared, v_ts);
  if (r->>'deleted') <> 'true' then raise exception 'TEST FAILED: a cleared-payment order is (knowingly) deletable'; end if;

  -- ---- 12. Stock allocation on the order ---------------------------------------------------------
  -- A NEW order can never legitimately hold one (only confirm creates them), so this row is forged
  -- as the table owner to prove the guard itself.
  insert into public.orders (id, customer_id, status) values (o_alloc, cust, 'new');
  reset role;
  insert into public.order_stock_allocations (order_id, product_id, production_execution_id, operation_id, reserved_pieces)
    values (o_alloc, 'sd-p', 'bbbbbbbb-0000-4000-8000-000000000001', gen_random_uuid(), 1);
  set local role authenticated;
  select updated_at into v_ts from public.orders where id = o_alloc;
  perform public.t_expect_refused('23514', 'This order has stock reservation records%', o_alloc, v_ts);

  -- ---- 14. Website orders ------------------------------------------------------------------------
  insert into public.orders (id, customer_id, status, entry_method) values (o_web, cust, 'new', 'website');
  select updated_at into v_ts from public.orders where id = o_web;
  perform public.t_expect_refused('23514', 'Orders that came in through the website%', o_web, v_ts);

  -- ---- 15. Direct table delete is closed to API callers ------------------------------------------
  insert into public.orders (id, customer_id, status) values (o_direct, cust, 'new');
  begin
    delete from public.orders where id = o_direct;
    raise exception 'TEST FAILED: a direct client DELETE must be refused';
  exception when insufficient_privilege then null; end;
  begin
    delete from public.orders where id = o_conf;
    raise exception 'TEST FAILED: a direct client DELETE of a confirmed order must be refused';
  exception when insufficient_privilege then null; end;
  if not exists (select 1 from public.orders where id = o_direct) then raise exception 'TEST FAILED: refused direct delete must leave the row'; end if;

  -- The flag is cleared after a safe delete: a direct delete right afterwards is still refused.
  begin
    delete from public.orders where id = o_direct;
    raise exception 'TEST FAILED: the delete flag must not leak past safe_delete_order';
  exception when insufficient_privilege then null; end;

  -- A session with no JWT (SQL editor / maintenance) is not gated by the trigger.
  perform set_config('request.jwt.claim.sub', '', true);
  reset role;
  delete from public.orders where id = o_direct;
  if exists (select 1 from public.orders where id = o_direct) then raise exception 'TEST FAILED: maintenance delete without a JWT must still work'; end if;
  perform set_config('request.jwt.claim.sub', '88888888-8888-4888-8888-888888888888', true);
  set local role authenticated;

  -- ---- 16. Authorization -------------------------------------------------------------------------
  insert into public.orders (id, customer_id, status) values (o_replay, cust, 'new');
  select updated_at into v_ts from public.orders where id = o_replay;
  perform set_config('request.jwt.claim.app_role', 'staff', true);
  perform public.t_expect_refused('42501', 'Only the product lab owner may delete an order', o_replay, v_ts);
  perform set_config('request.jwt.claim.app_role', 'owner', true);
  if not exists (select 1 from public.orders where id = o_replay) then raise exception 'TEST FAILED: unauthorized call must leave the order'; end if;

  -- ---- 17. No stock or allocation side effects from any refused/successful delete -----------------
  select count(*) into v_alloc_before from public.order_stock_allocations;
  select count(*) into v_mov_before from public.finished_stock_movements;
  select updated_at into v_ts from public.orders where id = o_replay;
  perform public.safe_delete_order(gen_random_uuid(), o_replay, v_ts);
  if (select count(*) from public.order_stock_allocations) <> v_alloc_before
     or (select count(*) from public.finished_stock_movements) <> v_mov_before then
    raise exception 'TEST FAILED: deleting a new order must not touch allocations or the stock ledger';
  end if;

  -- ---- 20. Cancel behaviour unchanged: a reserved order still cancels and releases ------------------
  insert into public.orders (id, customer_id, status) values (o_cancel_rpc, cust, 'new');
  insert into public.order_lines (id, order_id, product_id, item_name, unit_price, pieces_per_unit_snapshot, quantity) values (gen_random_uuid(), o_cancel_rpc, 'sd-p', 'L', 100, 2, 1);
  perform public.confirm_order_with_reservation(gen_random_uuid(), o_cancel_rpc);
  perform public.cancel_order_with_release(gen_random_uuid(), o_cancel_rpc, 'changed mind');
  if (select status from public.orders where id = o_cancel_rpc) <> 'cancelled' then raise exception 'TEST FAILED: cancel must still work'; end if;
  select count(*) into n from public.order_stock_allocations where order_id = o_cancel_rpc and status = 'released';
  if n <> 1 then raise exception 'TEST FAILED: cancel must still release its allocation (got %)', n; end if;
end;
$$;

rollback;
select 'safe_delete_order_assertions_passed';
