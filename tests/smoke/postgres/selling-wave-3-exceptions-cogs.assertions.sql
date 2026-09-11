-- Wave 3 single-shot invariants: damage/giveaway/correction reduce only unreserved stock, FIFO
-- protects active reservations, insufficient-across-lots rejects the WHOLE exception, positive
-- ("found more") correction is uniformly rejected (POST-REVIEW FIX -- see the migration's own
-- header for the cost-conservation defect this closes), idempotency, direct-write authority,
-- CHECK shapes, cost conservation under fulfillment, and derived raw production COGS (single-lot,
-- multi-lot FIFO, historical immutability, cancelled/manual-line zero-COGS). Concurrency and
-- fault injection run in the .test.ts file (they need real overlapping connections / injected
-- failures). Everything here rolls back -- one transaction, never committed.
begin;

create temporary table w3 as select
  'w3-damage-basic'::text as damage_product, gen_random_uuid() as damage_batch, gen_random_uuid() as damage_exec,
  'w3-giveaway-basic'::text as giveaway_product, gen_random_uuid() as giveaway_batch, gen_random_uuid() as giveaway_exec,
  'w3-fifo'::text as fifo_product, gen_random_uuid() as fifo_batch_a, gen_random_uuid() as fifo_batch_b,
  gen_random_uuid() as fifo_exec_a, gen_random_uuid() as fifo_exec_b,
  'w3-insuff'::text as insuff_product, gen_random_uuid() as insuff_batch, gen_random_uuid() as insuff_exec,
  'w3-negcorr'::text as negcorr_product, gen_random_uuid() as negcorr_batch, gen_random_uuid() as negcorr_exec,
  'w3-poscorr'::text as poscorr_product, gen_random_uuid() as poscorr_batch, gen_random_uuid() as poscorr_exec,
  'w3-poscorr-other'::text as poscorr_other_product, gen_random_uuid() as poscorr_other_batch, gen_random_uuid() as poscorr_other_exec,
  'w3-idem'::text as idem_product, gen_random_uuid() as idem_batch, gen_random_uuid() as idem_exec,
  'w3-cogs'::text as cogs_product, gen_random_uuid() as cogs_batch_a, gen_random_uuid() as cogs_batch_b,
  gen_random_uuid() as cogs_exec_a, gen_random_uuid() as cogs_exec_b,
  'w3-cancel'::text as cancel_product, gen_random_uuid() as cancel_batch, gen_random_uuid() as cancel_exec,
  'w3-manual'::text as manual_product, gen_random_uuid() as manual_batch, gen_random_uuid() as manual_exec,
  -- Cost-conservation regression fixtures (post-review fix): both executions match the
  -- Reviewer's exact reproduction numbers -- 8 pieces, PHP800 frozen ingredient cost total,
  -- PHP100 frozen cost per piece.
  'w3-costcons'::text as costcons_product, gen_random_uuid() as costcons_batch, gen_random_uuid() as costcons_exec,
  'w3-negcost'::text as negcost_product, gen_random_uuid() as negcost_batch, gen_random_uuid() as negcost_exec,
  gen_random_uuid() as customer_id;
grant select on w3 to authenticated;

insert into public.products (id, name)
  select damage_product, 'Damage Basic' from w3
  union all select giveaway_product, 'Giveaway Basic' from w3
  union all select fifo_product, 'FIFO Protect' from w3
  union all select insuff_product, 'Insufficient' from w3
  union all select negcorr_product, 'Negative Correction' from w3
  union all select poscorr_product, 'Positive Correction' from w3
  union all select poscorr_other_product, 'Positive Correction Other' from w3
  union all select idem_product, 'Idempotency' from w3
  union all select cogs_product, 'COGS Brownie' from w3
  union all select cancel_product, 'Cancel COGS' from w3
  union all select manual_product, 'Manual Line COGS' from w3
  union all select costcons_product, 'Cost Conservation' from w3
  union all select negcost_product, 'Negative Cost Conservation' from w3;

insert into public.product_batches (id, product_id, batch_version, status, usable_pieces)
  select damage_batch, damage_product, 'v1', 'completed', 12 from w3
  union all select giveaway_batch, giveaway_product, 'v1', 'completed', 10 from w3
  union all select fifo_batch_a, fifo_product, 'v1', 'completed', 8 from w3
  union all select fifo_batch_b, fifo_product, 'v1', 'completed', 9 from w3
  union all select insuff_batch, insuff_product, 'v1', 'completed', 8 from w3
  union all select negcorr_batch, negcorr_product, 'v1', 'completed', 10 from w3
  union all select poscorr_batch, poscorr_product, 'v1', 'completed', 5 from w3
  union all select poscorr_other_batch, poscorr_other_product, 'v1', 'completed', 5 from w3
  union all select idem_batch, idem_product, 'v1', 'completed', 10 from w3
  union all select cogs_batch_a, cogs_product, 'v1', 'completed', 2 from w3
  union all select cogs_batch_b, cogs_product, 'v1', 'completed', 9 from w3
  union all select cancel_batch, cancel_product, 'v1', 'completed', 10 from w3
  union all select manual_batch, manual_product, 'v1', 'completed', 10 from w3
  union all select costcons_batch, costcons_product, 'v1', 'completed', 8 from w3
  union all select negcost_batch, negcost_product, 'v1', 'completed', 8 from w3;

insert into public.production_executions (id, product_id, product_batch_id, batch_version_snapshot, operation_id, multiplier, quantity_produced_pieces, expected_pieces, frozen_ingredient_cost_total, frozen_cost_per_piece, completed_at)
  select damage_exec, damage_product, damage_batch, 'v1', gen_random_uuid(), 1, 12, 12, 120, 10, now() from w3
  union all select giveaway_exec, giveaway_product, giveaway_batch, 'v1', gen_random_uuid(), 1, 10, 10, 100, 10, now() from w3
  union all select fifo_exec_a, fifo_product, fifo_batch_a, 'v1', gen_random_uuid(), 1, 8, 8, 80, 10, now() - interval '2 days' from w3
  union all select fifo_exec_b, fifo_product, fifo_batch_b, 'v1', gen_random_uuid(), 1, 9, 9, 90, 10, now() - interval '1 day' from w3
  union all select insuff_exec, insuff_product, insuff_batch, 'v1', gen_random_uuid(), 1, 8, 8, 80, 10, now() from w3
  union all select negcorr_exec, negcorr_product, negcorr_batch, 'v1', gen_random_uuid(), 1, 10, 10, 100, 10, now() from w3
  union all select poscorr_exec, poscorr_product, poscorr_batch, 'v1', gen_random_uuid(), 1, 5, 5, 50, 10, now() from w3
  union all select poscorr_other_exec, poscorr_other_product, poscorr_other_batch, 'v1', gen_random_uuid(), 1, 5, 5, 50, 10, now() from w3
  union all select idem_exec, idem_product, idem_batch, 'v1', gen_random_uuid(), 1, 10, 10, 100, 10, now() from w3
  union all select cogs_exec_a, cogs_product, cogs_batch_a, 'v1', gen_random_uuid(), 1, 2, 2, 80, 40, now() - interval '2 days' from w3
  union all select cogs_exec_b, cogs_product, cogs_batch_b, 'v1', gen_random_uuid(), 1, 9, 9, 387, 43, now() - interval '1 day' from w3
  union all select cancel_exec, cancel_product, cancel_batch, 'v1', gen_random_uuid(), 1, 10, 10, 100, 10, now() from w3
  union all select manual_exec, manual_product, manual_batch, 'v1', gen_random_uuid(), 1, 10, 10, 100, 10, now() from w3
  union all select costcons_exec, costcons_product, costcons_batch, 'v1', gen_random_uuid(), 1, 8, 8, 800, 100, now() from w3
  union all select negcost_exec, negcost_product, negcost_batch, 'v1', gen_random_uuid(), 1, 8, 8, 800, 100, now() from w3;

insert into public.finished_stock_movements (product_id, production_execution_id, movement_type, on_hand_delta, reserved_delta, operation_id, note)
  select damage_product, damage_exec, 'production_receipt', 12, 0, gen_random_uuid(), 'seed' from w3
  union all select giveaway_product, giveaway_exec, 'production_receipt', 10, 0, gen_random_uuid(), 'seed' from w3
  union all select fifo_product, fifo_exec_a, 'production_receipt', 8, 0, gen_random_uuid(), 'seed A' from w3
  union all select fifo_product, fifo_exec_b, 'production_receipt', 9, 0, gen_random_uuid(), 'seed B' from w3
  union all select insuff_product, insuff_exec, 'production_receipt', 8, 0, gen_random_uuid(), 'seed' from w3
  union all select negcorr_product, negcorr_exec, 'production_receipt', 10, 0, gen_random_uuid(), 'seed' from w3
  union all select poscorr_product, poscorr_exec, 'production_receipt', 5, 0, gen_random_uuid(), 'seed' from w3
  union all select poscorr_other_product, poscorr_other_exec, 'production_receipt', 5, 0, gen_random_uuid(), 'seed' from w3
  union all select idem_product, idem_exec, 'production_receipt', 10, 0, gen_random_uuid(), 'seed' from w3
  union all select cogs_product, cogs_exec_a, 'production_receipt', 2, 0, gen_random_uuid(), 'seed A' from w3
  union all select cogs_product, cogs_exec_b, 'production_receipt', 9, 0, gen_random_uuid(), 'seed B' from w3
  union all select cancel_product, cancel_exec, 'production_receipt', 10, 0, gen_random_uuid(), 'seed' from w3
  union all select manual_product, manual_exec, 'production_receipt', 10, 0, gen_random_uuid(), 'seed' from w3
  union all select costcons_product, costcons_exec, 'production_receipt', 8, 0, gen_random_uuid(), 'seed' from w3
  union all select negcost_product, negcost_exec, 'production_receipt', 8, 0, gen_random_uuid(), 'seed' from w3;

insert into public.customers (id, name) select customer_id, 'Test Customer' from w3;

set local role authenticated;
select set_config('request.jwt.claim.sub', '55555555-5555-4555-8555-555555555555', true);
select set_config('request.jwt.claim.app_role', 'owner', true);
select set_config('request.jwt.claims', '{"sub":"55555555-5555-4555-8555-555555555555","role":"authenticated","app_metadata":{"app_role":"owner"}}', true);

do $$
declare
  w record;
  r jsonb;
  v_onhand integer; v_reserved integer; v_available integer;
  order_damage uuid; order_giveaway uuid; order_fifo uuid; order_insuff uuid; order_negcorr uuid;
  order_idem uuid; order_cogs uuid; order_cancel uuid; order_manual uuid;
  op_cogs_fulfill uuid;
  msg text;
  v_cogs numeric; v_pieces integer;
begin
  select * into w from w3;

  -- ============================================================================================
  -- SECTION A: damage reduces only UNRESERVED stock (spec section 4's worked example, generalized
  -- with a real reservation instead of a bare number: on hand 12, reserve 4 via a real confirmed
  -- order -> available 8. Damage 2 -> on hand 10, reserved 4, available 6.
  -- ============================================================================================
  order_damage := gen_random_uuid();
  insert into public.orders (id, customer_id, status) values (order_damage, w.customer_id, 'new');
  insert into public.order_lines (id, order_id, product_id, item_name, unit_price, pieces_per_unit_snapshot, quantity)
    values (gen_random_uuid(), order_damage, w.damage_product, 'Line', 100, 4, 1);
  perform public.confirm_order_with_reservation(gen_random_uuid(), order_damage);
  select coalesce(sum(on_hand_delta),0), coalesce(sum(reserved_delta),0) into v_onhand, v_reserved
    from public.finished_stock_movements where product_id = w.damage_product;
  if v_onhand <> 12 or v_reserved <> 4 then raise exception 'TEST FAILED: setup must be on_hand=12 reserved=4, got %/%', v_onhand, v_reserved; end if;

  r := public.record_finished_stock_exception(gen_random_uuid(), w.damage_product, 'damage', -2, null, 'dropped tray');
  select coalesce(sum(on_hand_delta),0), coalesce(sum(reserved_delta),0) into v_onhand, v_reserved
    from public.finished_stock_movements where product_id = w.damage_product;
  if v_onhand <> 10 or v_reserved <> 4 then raise exception 'TEST FAILED: after damage(2) must be on_hand=10 reserved=4, got %/%', v_onhand, v_reserved; end if;
  if v_onhand - v_reserved <> 6 then raise exception 'TEST FAILED: available must be 6, got %', v_onhand - v_reserved; end if;
  if (r->'movements'->0->>'production_execution_id') <> w.damage_exec::text then
    raise exception 'TEST FAILED: the damage movement must be linked to the only production execution'; end if;

  -- ============================================================================================
  -- SECTION B: giveaway has the exact same physical semantics as damage (spec section 5's worked
  -- example): on hand 10, reserve 4 -> available 6. Giveaway 2 -> on hand 8, reserved 4, available 4.
  -- ============================================================================================
  order_giveaway := gen_random_uuid();
  insert into public.orders (id, customer_id, status) values (order_giveaway, w.customer_id, 'new');
  insert into public.order_lines (id, order_id, product_id, item_name, unit_price, pieces_per_unit_snapshot, quantity)
    values (gen_random_uuid(), order_giveaway, w.giveaway_product, 'Line', 100, 4, 1);
  perform public.confirm_order_with_reservation(gen_random_uuid(), order_giveaway);

  perform public.record_finished_stock_exception(gen_random_uuid(), w.giveaway_product, 'giveaway', -2, null, 'sample for a customer');
  select coalesce(sum(on_hand_delta),0), coalesce(sum(reserved_delta),0) into v_onhand, v_reserved
    from public.finished_stock_movements where product_id = w.giveaway_product;
  if v_onhand <> 8 or v_reserved <> 4 then raise exception 'TEST FAILED: after giveaway(2) must be on_hand=8 reserved=4, got %/%', v_onhand, v_reserved; end if;

  -- ============================================================================================
  -- SECTION C: FIFO protects reservations across lots (spec sections 8/33). Lot A: 8 produced, 6
  -- reserved via a real confirmed order, 2 unreserved. Lot B: 9 produced, 0 reserved, 9 unreserved.
  -- Damage 5 must draw exactly 2 from A (all of its unreserved slice) and 3 from B -- NEVER more
  -- than 2 from A, which would reach into the 6 reserved for the order.
  -- ============================================================================================
  order_fifo := gen_random_uuid();
  insert into public.orders (id, customer_id, status) values (order_fifo, w.customer_id, 'new');
  insert into public.order_lines (id, order_id, product_id, item_name, unit_price, pieces_per_unit_snapshot, quantity)
    values (gen_random_uuid(), order_fifo, w.fifo_product, 'Line', 100, 6, 1);
  perform public.confirm_order_with_reservation(gen_random_uuid(), order_fifo);
  if (select reserved_pieces from public.order_stock_allocations where order_id = order_fifo and production_execution_id = w.fifo_exec_a) <> 6 then
    raise exception 'TEST FAILED: setup must reserve exactly 6 from the older lot A'; end if;

  r := public.record_finished_stock_exception(gen_random_uuid(), w.fifo_product, 'damage', -5, null, 'shelf collapse');
  if jsonb_array_length(r->'movements') <> 2 then
    raise exception 'TEST FAILED: damaging 5 across a 2-unreserved/9-unreserved split must write exactly 2 movement rows, got %', jsonb_array_length(r->'movements'); end if;
  if (select coalesce(sum(-on_hand_delta),0) from public.finished_stock_movements
      where product_id = w.fifo_product and production_execution_id = w.fifo_exec_a and movement_type = 'damage') <> 2 then
    raise exception 'TEST FAILED: exactly 2 must come from lot A (its unreserved slice), never the 6 reserved'; end if;
  if (select coalesce(sum(-on_hand_delta),0) from public.finished_stock_movements
      where product_id = w.fifo_product and production_execution_id = w.fifo_exec_b and movement_type = 'damage') <> 3 then
    raise exception 'TEST FAILED: the remaining 3 must come from lot B'; end if;
  select coalesce(sum(on_hand_delta),0), coalesce(sum(reserved_delta),0) into v_onhand, v_reserved
    from public.finished_stock_movements where product_id = w.fifo_product;
  if v_onhand <> 12 or v_reserved <> 6 then raise exception 'TEST FAILED: after the FIFO damage, on_hand must be 12 (17-5) and reserved untouched at 6, got %/%', v_onhand, v_reserved; end if;

  -- ============================================================================================
  -- SECTION D: insufficient-across-lots rejects the WHOLE exception (spec section 33's second
  -- half). Only lot: 8 produced, 6 reserved via a real order, 2 unreserved. Damage 3 (more than
  -- the 2 unreserved) must be rejected entirely -- zero movements, nothing partially applied.
  -- ============================================================================================
  order_insuff := gen_random_uuid();
  insert into public.orders (id, customer_id, status) values (order_insuff, w.customer_id, 'new');
  insert into public.order_lines (id, order_id, product_id, item_name, unit_price, pieces_per_unit_snapshot, quantity)
    values (gen_random_uuid(), order_insuff, w.insuff_product, 'Line', 100, 6, 1);
  perform public.confirm_order_with_reservation(gen_random_uuid(), order_insuff);

  begin
    perform public.record_finished_stock_exception(gen_random_uuid(), w.insuff_product, 'damage', -3, null, 'too much');
    raise exception 'TEST FAILED: damaging 3 with only 2 unreserved must be rejected';
  exception when check_violation then
    get stacked diagnostics msg = message_text;
    if msg not like '%reserved pieces are protected%' then
      raise exception 'TEST FAILED: rejection message must explain reserved pieces are protected, got: %', msg; end if;
  end;
  if exists (select 1 from public.finished_stock_movements where product_id = w.insuff_product and movement_type = 'damage') then
    raise exception 'TEST FAILED: a rejected exception must leave zero damage movements, not a partial one'; end if;
  select coalesce(sum(on_hand_delta),0), coalesce(sum(reserved_delta),0) into v_onhand, v_reserved
    from public.finished_stock_movements where product_id = w.insuff_product;
  if v_onhand <> 8 or v_reserved <> 6 then raise exception 'TEST FAILED: a rejected exception must leave stock exactly as it was, got %/%', v_onhand, v_reserved; end if;

  -- ============================================================================================
  -- SECTION E: negative correction cannot destroy a reservation either (spec section 35). on hand
  -- 10, reserve 8 via a real order -> available 2. Correction -3 must be rejected. Correction -2
  -- (exactly the unreserved amount) must succeed.
  -- ============================================================================================
  order_negcorr := gen_random_uuid();
  insert into public.orders (id, customer_id, status) values (order_negcorr, w.customer_id, 'new');
  insert into public.order_lines (id, order_id, product_id, item_name, unit_price, pieces_per_unit_snapshot, quantity)
    values (gen_random_uuid(), order_negcorr, w.negcorr_product, 'Line', 100, 8, 1);
  perform public.confirm_order_with_reservation(gen_random_uuid(), order_negcorr);

  begin
    perform public.record_finished_stock_exception(gen_random_uuid(), w.negcorr_product, 'correction', -3, null, 'recount: 3 fewer than expected');
    raise exception 'TEST FAILED: a negative correction of 3 with only 2 unreserved must be rejected';
  exception when check_violation then null; end;
  select coalesce(sum(on_hand_delta),0), coalesce(sum(reserved_delta),0) into v_onhand, v_reserved
    from public.finished_stock_movements where product_id = w.negcorr_product;
  if v_onhand <> 10 or v_reserved <> 8 then raise exception 'TEST FAILED: the rejected correction must not have changed anything, got %/%', v_onhand, v_reserved; end if;

  perform public.record_finished_stock_exception(gen_random_uuid(), w.negcorr_product, 'correction', -2, null, 'recount: 2 fewer, exactly the unreserved amount');
  select coalesce(sum(on_hand_delta),0), coalesce(sum(reserved_delta),0) into v_onhand, v_reserved
    from public.finished_stock_movements where product_id = w.negcorr_product;
  if v_onhand <> 8 or v_reserved <> 8 then raise exception 'TEST FAILED: a correction of exactly the unreserved amount must succeed, got %/%', v_onhand, v_reserved; end if;
  if v_onhand - v_reserved <> 0 then raise exception 'TEST FAILED: available must land exactly at 0, never negative, got %', v_onhand - v_reserved; end if;

  -- ============================================================================================
  -- SECTION F: positive ("found more than recorded") correction is UNIFORMLY REJECTED
  -- (POST-REVIEW FIX -- the independent Wave 3 review's activation blocker; see the migration's
  -- own header for the reproduced cost-conservation defect this closes). Rejected regardless of
  -- whether a production execution is named, whether that execution belongs to the same product,
  -- or which exception type is requested -- there is no longer any path that accepts a positive
  -- quantity. Damage/giveaway/correction must also never accept an operator-chosen lot (the
  -- database always FIFO-allocates automatically). Every rejection here must leave ZERO movements
  -- and no stuck mutation receipt, and the SAME operation id must still be cleanly usable
  -- afterwards for a genuinely different (valid, negative) request -- proving a rejected positive
  -- attempt never claims the operation id.
  -- ============================================================================================
  begin
    perform public.record_finished_stock_exception(gen_random_uuid(), w.poscorr_product, 'correction', 3, w.poscorr_exec, 'found more, attributed to a real lot -- still rejected');
    raise exception 'TEST FAILED: a positive correction must be rejected even when attributed to a valid same-product production execution';
  exception when others then
    if sqlstate <> '22023' then raise exception 'TEST FAILED: attributed positive correction must fail 22023, got %', sqlstate; end if;
  end;

  begin
    perform public.record_finished_stock_exception(gen_random_uuid(), w.poscorr_product, 'correction', 1, null, 'no lot named');
    raise exception 'TEST FAILED: an unattributed positive correction must be rejected';
  exception when others then
    if sqlstate <> '22023' then raise exception 'TEST FAILED: unattributed positive correction must fail 22023, got %', sqlstate; end if;
  end;

  begin
    perform public.record_finished_stock_exception(gen_random_uuid(), w.poscorr_product, 'correction', 1, w.poscorr_other_exec, 'wrong product''s lot, and positive');
    raise exception 'TEST FAILED: a positive correction linked to another product''s execution must be rejected';
  exception when others then
    if sqlstate <> '22023' then raise exception 'TEST FAILED: cross-product-lot positive correction must fail 22023, got %', sqlstate; end if;
  end;

  begin
    perform public.record_finished_stock_exception(gen_random_uuid(), w.poscorr_product, 'damage', 1, null, 'positive damage makes no sense');
    raise exception 'TEST FAILED: damage can never be positive';
  exception when others then
    if sqlstate <> '22023' then raise exception 'TEST FAILED: positive damage must fail 22023, got %', sqlstate; end if;
  end;

  begin
    perform public.record_finished_stock_exception(gen_random_uuid(), w.poscorr_product, 'giveaway', 1, null, 'positive giveaway makes no sense');
    raise exception 'TEST FAILED: giveaway can never be positive';
  exception when others then
    if sqlstate <> '22023' then raise exception 'TEST FAILED: positive giveaway must fail 22023, got %', sqlstate; end if;
  end;

  begin
    perform public.record_finished_stock_exception(gen_random_uuid(), w.poscorr_product, 'damage', -1, w.poscorr_exec, 'operator must not choose a lot for damage');
    raise exception 'TEST FAILED: damage/giveaway/correction must reject an operator-chosen production execution';
  exception when others then
    if sqlstate <> '22023' then raise exception 'TEST FAILED: operator-chosen-lot damage must fail 22023, got %', sqlstate; end if;
  end;

  begin
    perform public.record_finished_stock_exception(gen_random_uuid(), w.poscorr_product, 'correction', -1, w.poscorr_exec, 'operator must not choose a lot for negative correction either');
    raise exception 'TEST FAILED: negative correction must also reject an operator-chosen production execution';
  exception when others then
    if sqlstate <> '22023' then raise exception 'TEST FAILED: operator-chosen-lot negative correction must fail 22023, got %', sqlstate; end if;
  end;

  -- Nothing from any of the rejections above may have been persisted: zero movements, on_hand
  -- untouched at its seeded 5.
  if exists (select 1 from public.finished_stock_movements where product_id = w.poscorr_product and movement_type in ('damage', 'giveaway', 'correction')) then
    raise exception 'TEST FAILED: every rejected exception in this section must have written zero movements'; end if;
  select coalesce(sum(on_hand_delta),0) into v_onhand from public.finished_stock_movements where product_id = w.poscorr_product;
  if v_onhand <> 5 then raise exception 'TEST FAILED: on_hand for the positive-correction product must remain at its seeded 5, got %', v_onhand; end if;

  -- Operation-id retry safety: a rejected positive attempt validates and fails BEFORE
  -- claim_mutation runs, so it never claims the operation id. The exact same id must still work
  -- cleanly for a genuinely different, VALID (negative) request afterwards.
  declare op_retry_after_reject uuid := gen_random_uuid();
  begin
    begin
      perform public.record_finished_stock_exception(op_retry_after_reject, w.poscorr_product, 'correction', 2, w.poscorr_exec, 'rejected positive attempt');
      raise exception 'TEST FAILED: this positive attempt must be rejected';
    exception when others then
      if sqlstate <> '22023' then raise exception 'TEST FAILED: expected 22023, got %', sqlstate; end if;
    end;
    r := public.record_finished_stock_exception(op_retry_after_reject, w.poscorr_product, 'damage', -1, null, 'the same operation id, now a valid negative request');
    select coalesce(sum(on_hand_delta),0) into v_onhand from public.finished_stock_movements where product_id = w.poscorr_product;
    if v_onhand <> 4 then raise exception 'TEST FAILED: the operation id must not be stuck after a rejected positive attempt -- expected on_hand 4, got %', v_onhand; end if;
  end;

  -- ============================================================================================
  -- SECTION G: idempotency (spec section 12). Exact retry replays without double-applying; the
  -- same operation id with a different quantity is a changed-payload rejection, not a silent
  -- rewrite; a fresh operation id is a genuinely new, separate exception.
  -- ============================================================================================
  declare op_idem uuid := gen_random_uuid();
  begin
    perform public.record_finished_stock_exception(op_idem, w.idem_product, 'damage', -2, null, 'idempotency test');
    select coalesce(sum(on_hand_delta),0) into v_onhand from public.finished_stock_movements where product_id = w.idem_product;
    if v_onhand <> 8 then raise exception 'TEST FAILED: first damage(2) must bring on_hand to 8, got %', v_onhand; end if;

    -- Exact retry: replays, no second deduction.
    perform public.record_finished_stock_exception(op_idem, w.idem_product, 'damage', -2, null, 'idempotency test');
    select coalesce(sum(on_hand_delta),0) into v_onhand from public.finished_stock_movements where product_id = w.idem_product;
    if v_onhand <> 8 then raise exception 'TEST FAILED: exact retry must not double-apply, on_hand must stay 8, got %', v_onhand; end if;
    if (select count(*) from public.finished_stock_movements where product_id = w.idem_product and movement_type = 'damage') <> 1 then
      raise exception 'TEST FAILED: exact retry must not create a second movement row'; end if;

    -- Same operation id, different quantity: rejected as a changed payload.
    begin
      perform public.record_finished_stock_exception(op_idem, w.idem_product, 'damage', -3, null, 'idempotency test');
      raise exception 'TEST FAILED: reusing the operation id with a different quantity must be rejected';
    exception when check_violation then null; end;
    select coalesce(sum(on_hand_delta),0) into v_onhand from public.finished_stock_movements where product_id = w.idem_product;
    if v_onhand <> 8 then raise exception 'TEST FAILED: the rejected changed-payload retry must not have changed anything, got %', v_onhand; end if;

    -- A fresh operation id is a genuinely new, separate exception.
    perform public.record_finished_stock_exception(gen_random_uuid(), w.idem_product, 'giveaway', -1, null, 'a separate, later giveaway');
    select coalesce(sum(on_hand_delta),0) into v_onhand from public.finished_stock_movements where product_id = w.idem_product;
    if v_onhand <> 7 then raise exception 'TEST FAILED: a fresh operation id must apply as a genuinely new exception, on_hand must be 7, got %', v_onhand; end if;
  end;

  -- ============================================================================================
  -- SECTION H: fulfilled raw-production COGS, multi-lot FIFO (spec section 37's exact worked
  -- example). Lot A: 2 remaining @ PHP40/pc. Lot B: 9 remaining @ PHP43/pc. Order needs 6 -> FIFO
  -- A:2, B:4. Expected raw COGS = 2*40 + 4*43 = 252.
  -- ============================================================================================
  order_cogs := gen_random_uuid();
  insert into public.orders (id, customer_id, status) values (order_cogs, w.customer_id, 'new');
  insert into public.order_lines (id, order_id, product_id, item_name, unit_price, pieces_per_unit_snapshot, quantity)
    values (gen_random_uuid(), order_cogs, w.cogs_product, 'Line', 100, 6, 1);
  perform public.confirm_order_with_reservation(gen_random_uuid(), order_cogs);
  if (select reserved_pieces from public.order_stock_allocations where order_id = order_cogs and production_execution_id = w.cogs_exec_a) <> 2
     or (select reserved_pieces from public.order_stock_allocations where order_id = order_cogs and production_execution_id = w.cogs_exec_b) <> 4 then
    raise exception 'TEST FAILED: FIFO setup for the COGS test must allocate exactly A:2, B:4'; end if;

  -- Not yet fulfilled: order_raw_cogs must show no row (spec section 23 -- confirmed/ready never
  -- recognize fulfilled COGS).
  if exists (select 1 from public.order_raw_cogs where order_id = order_cogs) then
    raise exception 'TEST FAILED: a confirmed-but-not-fulfilled order must have no order_raw_cogs row'; end if;

  op_cogs_fulfill := gen_random_uuid();
  perform public.complete_order_with_fulfillment(op_cogs_fulfill, order_cogs);
  select fulfilled_pieces, raw_production_cogs into v_pieces, v_cogs from public.order_raw_cogs where order_id = order_cogs;
  if v_pieces <> 6 then raise exception 'TEST FAILED: fulfilled_pieces must be exactly 6, got %', v_pieces; end if;
  if v_cogs <> 252 then raise exception 'TEST FAILED: raw_production_cogs must be exactly 252 (2*40 + 4*43), got %', v_cogs; end if;

  -- Historical immutability (spec sections 21/31/37): editing the recipe/version's yield after
  -- the fact must not move the already-fulfilled order's COGS by one centavo -- it is derived
  -- entirely from the FROZEN production_executions.frozen_cost_per_piece and the immutable
  -- fulfilled allocation, neither of which this update touches.
  update public.product_batches set usable_pieces = 999 where id in (w.cogs_batch_a, w.cogs_batch_b);
  select raw_production_cogs into v_cogs from public.order_raw_cogs where order_id = order_cogs;
  if v_cogs <> 252 then raise exception 'TEST FAILED: historical COGS must remain 252 after a later recipe edit, got %', v_cogs; end if;

  -- Exact retry of the SAME fulfillment operation id: replays, still 252, no double-fulfillment.
  perform public.complete_order_with_fulfillment(op_cogs_fulfill, order_cogs);
  select raw_production_cogs into v_cogs from public.order_raw_cogs where order_id = order_cogs;
  if v_cogs <> 252 then raise exception 'TEST FAILED: COGS must remain 252 after a redundant fulfillment call, got %', v_cogs; end if;

  -- ============================================================================================
  -- SECTION H2: COST CONSERVATION, positive path (post-review fix regression). This is the exact
  -- scenario the independent review reproduced: an execution that actually cost PHP800 for 8
  -- pieces (PHP100/piece frozen). A +2 positive correction must be rejected -- proven again here
  -- specifically against these numbers, end to end through a real order fulfillment -- and the
  -- execution's own frozen facts must be completely untouched by the rejected attempt. Fulfilling
  -- every one of the 8 pieces that were ACTUALLY produced must derive raw COGS of exactly 800,
  -- never 1000: fulfilled raw COGS attributable to one execution can never exceed that execution's
  -- own frozen raw cost total under any supported Wave 3 operation.
  -- ============================================================================================
  begin
    perform public.record_finished_stock_exception(gen_random_uuid(), w.costcons_product, 'correction', 2, w.costcons_exec, 'found 2 more -- must be rejected');
    raise exception 'TEST FAILED: the +2 positive correction from the reviewer''s reproduction must be rejected';
  exception when others then
    if sqlstate <> '22023' then raise exception 'TEST FAILED: expected 22023, got %', sqlstate; end if;
  end;
  -- The execution's own frozen facts are completely unchanged by the rejected attempt -- Wave 1's
  -- immutability guarantee, reconfirmed here.
  if (select quantity_produced_pieces from public.production_executions where id = w.costcons_exec) <> 8
     or (select frozen_ingredient_cost_total from public.production_executions where id = w.costcons_exec) <> 800
     or (select frozen_cost_per_piece from public.production_executions where id = w.costcons_exec) <> 100 then
    raise exception 'TEST FAILED: the rejected correction must not have touched the execution''s frozen quantity/cost facts'; end if;
  select coalesce(sum(on_hand_delta),0) into v_onhand from public.finished_stock_movements where product_id = w.costcons_product;
  if v_onhand <> 8 then raise exception 'TEST FAILED: on_hand must remain exactly 8 (the rejected correction wrote nothing), got %', v_onhand; end if;

  -- Fulfill the maximum legitimately available quantity (all 8 real pieces) and prove the derived
  -- COGS is exactly what the Bake cost -- never the inflated 1000 the defect would have produced.
  declare order_costcons uuid := gen_random_uuid();
  begin
    insert into public.orders (id, customer_id, status) values (order_costcons, w.customer_id, 'new');
    insert into public.order_lines (id, order_id, product_id, item_name, unit_price, pieces_per_unit_snapshot, quantity)
      values (gen_random_uuid(), order_costcons, w.costcons_product, 'Line', 100, 8, 1);
    perform public.confirm_order_with_reservation(gen_random_uuid(), order_costcons);
    perform public.complete_order_with_fulfillment(gen_random_uuid(), order_costcons);
    select fulfilled_pieces, raw_production_cogs into v_pieces, v_cogs from public.order_raw_cogs where order_id = order_costcons;
    if v_pieces <> 8 then raise exception 'TEST FAILED: expected 8 fulfilled pieces, got %', v_pieces; end if;
    if v_cogs <> 800 then raise exception 'TEST FAILED: fulfilled raw COGS must be exactly 800 -- the execution''s actual frozen cost -- never 1000, got %', v_cogs; end if;
  end;

  -- ============================================================================================
  -- SECTION H3: COST CONSERVATION, negative path. A second, independent 8-piece/PHP800/PHP100-
  -- per-piece execution: damage removes 2 (unreserved, no order yet), leaving 6 legitimately
  -- fulfillable. Fulfilling those 6 must derive raw COGS of exactly 600 -- the damaged pieces
  -- contribute nothing to any order's cost -- and cumulative fulfilled raw COGS attributable to
  -- this execution can never exceed its own 800 frozen total (6 fulfilled x PHP100 = 600 < 800).
  -- ============================================================================================
  perform public.record_finished_stock_exception(gen_random_uuid(), w.negcost_product, 'damage', -2, null, 'damaged before any order touches this lot');
  select coalesce(sum(on_hand_delta),0) into v_onhand from public.finished_stock_movements where product_id = w.negcost_product;
  if v_onhand <> 6 then raise exception 'TEST FAILED: after damaging 2 of 8, on_hand must be 6, got %', v_onhand; end if;

  declare order_negcost uuid := gen_random_uuid();
  begin
    insert into public.orders (id, customer_id, status) values (order_negcost, w.customer_id, 'new');
    insert into public.order_lines (id, order_id, product_id, item_name, unit_price, pieces_per_unit_snapshot, quantity)
      values (gen_random_uuid(), order_negcost, w.negcost_product, 'Line', 100, 6, 1);
    perform public.confirm_order_with_reservation(gen_random_uuid(), order_negcost);
    perform public.complete_order_with_fulfillment(gen_random_uuid(), order_negcost);
    select fulfilled_pieces, raw_production_cogs into v_pieces, v_cogs from public.order_raw_cogs where order_id = order_negcost;
    if v_pieces <> 6 then raise exception 'TEST FAILED: expected 6 fulfilled pieces (8 produced - 2 damaged), got %', v_pieces; end if;
    if v_cogs <> 600 then raise exception 'TEST FAILED: fulfilled raw COGS must be exactly 600 (6 x PHP100) -- the 2 damaged pieces contribute no COGS to any order, got %', v_cogs; end if;
    if v_cogs > 800 then raise exception 'TEST FAILED: cumulative fulfilled raw COGS for this execution must never exceed its own frozen total of 800, got %', v_cogs; end if;
  end;

  -- ============================================================================================
  -- SECTION I: cancelled orders recognize zero COGS (spec section 22) -- released allocations
  -- never count, only fulfilled ones do.
  -- ============================================================================================
  order_cancel := gen_random_uuid();
  insert into public.orders (id, customer_id, status) values (order_cancel, w.customer_id, 'new');
  insert into public.order_lines (id, order_id, product_id, item_name, unit_price, pieces_per_unit_snapshot, quantity)
    values (gen_random_uuid(), order_cancel, w.cancel_product, 'Line', 100, 6, 1);
  perform public.confirm_order_with_reservation(gen_random_uuid(), order_cancel);
  perform public.cancel_order_with_release(gen_random_uuid(), order_cancel, 'testing zero COGS on cancel');
  if exists (select 1 from public.order_raw_cogs where order_id = order_cancel) then
    raise exception 'TEST FAILED: a cancelled order must have no order_raw_cogs row (released pieces are never cost)'; end if;

  -- ============================================================================================
  -- SECTION J: a manual/non-stock line never invents COGS (spec section 24). An order mixing one
  -- stock-tracked fulfilled line with one manual line (product_id null) must report COGS for only
  -- the stock-tracked line's fulfilled pieces.
  -- ============================================================================================
  order_manual := gen_random_uuid();
  insert into public.orders (id, customer_id, status) values (order_manual, w.customer_id, 'new');
  insert into public.order_lines (id, order_id, product_id, item_name, unit_price, pieces_per_unit_snapshot, quantity) values
    (gen_random_uuid(), order_manual, w.manual_product, 'Stock line', 100, 6, 1),
    (gen_random_uuid(), order_manual, null, 'Hand-priced custom item', 500, null, 1);
  perform public.confirm_order_with_reservation(gen_random_uuid(), order_manual);
  perform public.complete_order_with_fulfillment(gen_random_uuid(), order_manual);
  select fulfilled_pieces, raw_production_cogs into v_pieces, v_cogs from public.order_raw_cogs where order_id = order_manual;
  if v_pieces <> 6 or v_cogs <> 60 then
    raise exception 'TEST FAILED: only the stock-tracked line''s 6 fulfilled pieces at PHP10/pc = 60 may count; the manual line must contribute nothing, got pieces=% cogs=%', v_pieces, v_cogs; end if;

  -- ============================================================================================
  -- SECTION K: direct-write authority. Ordinary clients cannot write the exception verbs
  -- directly, only read them; a non-owner authenticated user cannot call the RPC at all.
  -- ============================================================================================
  begin
    insert into public.finished_stock_movements (product_id, production_execution_id, movement_type, on_hand_delta, reserved_delta, operation_id, note)
      values (w.idem_product, w.idem_exec, 'damage', -1, 0, gen_random_uuid(), 'sneaked in');
    raise exception 'TEST FAILED: a direct client insert of a damage movement must be rejected';
  exception when insufficient_privilege then null; end;

  if not exists (select 1 from public.finished_stock_movements where product_id = w.damage_product and movement_type = 'damage') then
    raise exception 'TEST FAILED: owner must be able to read its own exception movements'; end if;

  -- Non-owner authenticated caller.
  perform set_config('request.jwt.claim.app_role', 'staff', true);
  begin
    perform public.record_finished_stock_exception(gen_random_uuid(), w.damage_product, 'damage', -1, null, 'not the owner');
    raise exception 'TEST FAILED: a non-owner authenticated caller must not be able to record an exception';
  exception when insufficient_privilege then null; end;
  perform set_config('request.jwt.claim.app_role', 'owner', true);
end;
$$;

-- ==============================================================================================
-- SECTION L: CHECK constraint shapes. Run as the table owner (superuser session, RLS/grants do
-- not apply) so a malformed row can actually reach the constraint instead of being stopped by
-- authority first -- isolates "does the constraint itself work" from "can a client reach it".
-- ==============================================================================================
reset role;

do $$
declare
  w record;
begin
  select * into w from w3;

  -- damage/giveaway must be strictly negative on_hand_delta.
  begin
    insert into public.finished_stock_movements (product_id, production_execution_id, movement_type, on_hand_delta, reserved_delta, operation_id)
      values (w.damage_product, w.damage_exec, 'damage', 1, 0, gen_random_uuid());
    raise exception 'TEST FAILED: a damage row with a positive on_hand_delta must be rejected';
  exception when check_violation then null; end;
  begin
    insert into public.finished_stock_movements (product_id, production_execution_id, movement_type, on_hand_delta, reserved_delta, operation_id)
      values (w.giveaway_product, w.giveaway_exec, 'giveaway', 0, 0, gen_random_uuid());
    raise exception 'TEST FAILED: a giveaway row with a zero on_hand_delta must be rejected';
  exception when check_violation then null; end;

  -- damage/giveaway/correction must never touch reserved_delta.
  begin
    insert into public.finished_stock_movements (product_id, production_execution_id, movement_type, on_hand_delta, reserved_delta, operation_id)
      values (w.damage_product, w.damage_exec, 'damage', -1, -1, gen_random_uuid());
    raise exception 'TEST FAILED: a damage row with a nonzero reserved_delta must be rejected';
  exception when check_violation then null; end;

  -- correction must be strictly negative, exactly like damage/giveaway (POST-REVIEW FIX: the
  -- CHECK no longer permits either zero or a positive on_hand_delta for any of the three verbs).
  begin
    insert into public.finished_stock_movements (product_id, production_execution_id, movement_type, on_hand_delta, reserved_delta, operation_id)
      values (w.idem_product, w.idem_exec, 'correction', 0, 0, gen_random_uuid());
    raise exception 'TEST FAILED: a correction row with a zero on_hand_delta must be rejected';
  exception when check_violation then null; end;

  -- Defense in depth (reviewer's targeted regression): a POSITIVE correction must be rejected by
  -- the schema CHECK itself, directly, independent of the RPC -- so even a future writer that
  -- bypassed record_finished_stock_exception could not persist the cost-conservation defect.
  begin
    insert into public.finished_stock_movements (product_id, production_execution_id, movement_type, on_hand_delta, reserved_delta, operation_id)
      values (w.idem_product, w.idem_exec, 'correction', 2, 0, gen_random_uuid());
    raise exception 'TEST FAILED: a correction row with a POSITIVE on_hand_delta must be rejected by the CHECK constraint directly';
  exception when check_violation then null; end;
  begin
    insert into public.finished_stock_movements (product_id, production_execution_id, movement_type, on_hand_delta, reserved_delta, operation_id)
      values (w.damage_product, w.damage_exec, 'giveaway', 3, 0, gen_random_uuid());
    raise exception 'TEST FAILED: a giveaway row with a POSITIVE on_hand_delta must be rejected by the CHECK constraint directly';
  exception when check_violation then null; end;

  -- all three require a production_execution_id (lot linkage is mandatory).
  begin
    insert into public.finished_stock_movements (product_id, movement_type, on_hand_delta, reserved_delta, operation_id)
      values (w.damage_product, 'damage', -1, 0, gen_random_uuid());
    raise exception 'TEST FAILED: a damage row with no production_execution_id must be rejected';
  exception when check_violation then null; end;

  -- none of the three may carry order linkage -- they are not orders.
  begin
    insert into public.finished_stock_movements (product_id, production_execution_id, movement_type, on_hand_delta, reserved_delta, operation_id, order_id)
      values (w.damage_product, w.damage_exec, 'damage', -1, 0, gen_random_uuid(), (select order_id from public.order_stock_allocations limit 1));
    raise exception 'TEST FAILED: a damage row must not be allowed to carry an order_id';
  exception when check_violation then null; end;

  -- A well-formed (negative) row of each type is accepted -- proves the constraint is not overly
  -- strict. There is no "well-formed positive" case any more for any of the three verbs.
  insert into public.finished_stock_movements (product_id, production_execution_id, movement_type, on_hand_delta, reserved_delta, operation_id, note)
    values (w.damage_product, w.damage_exec, 'damage', -1, 0, gen_random_uuid(), 'well-formed');
  insert into public.finished_stock_movements (product_id, production_execution_id, movement_type, on_hand_delta, reserved_delta, operation_id, note)
    values (w.giveaway_product, w.giveaway_exec, 'giveaway', -1, 0, gen_random_uuid(), 'well-formed');
  insert into public.finished_stock_movements (product_id, production_execution_id, movement_type, on_hand_delta, reserved_delta, operation_id, note)
    values (w.idem_product, w.idem_exec, 'correction', -1, 0, gen_random_uuid(), 'well-formed negative');
end;
$$;

rollback;
select 'wave_3_assertions_passed';
