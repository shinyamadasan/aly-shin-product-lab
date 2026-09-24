-- Finished Stock Opening Balance / Physical Count Reconciliation -- single-shot invariants.
-- Everything here runs in one transaction and rolls back at the end (never committed). Mirrors
-- tests/smoke/postgres/selling-wave-3-exceptions-cogs.assertions.sql's shape and idiom.
begin;

create temporary table f as select
  'fsob-open'::text as open_product,
  'fsob-reserved'::text as reserved_product, gen_random_uuid() as reserved_batch, gen_random_uuid() as reserved_exec,
  'fsob-existing'::text as existing_product, gen_random_uuid() as existing_batch, gen_random_uuid() as existing_exec,
  'fsob-posreject'::text as posreject_product, gen_random_uuid() as posreject_batch, gen_random_uuid() as posreject_exec,
  'fsob-brownie'::text as brownie_product,
  'fsob-blondie'::text as blondie_product, gen_random_uuid() as blondie_batch, gen_random_uuid() as blondie_exec,
  'fsob-cookie'::text as cookie_product,
  'fsob-costbasis'::text as costbasis_product, gen_random_uuid() as costbasis_costing,
  'fsob-costbasis-other'::text as costbasis_other_product, gen_random_uuid() as costbasis_other_costing,
  'fsob-shapecheck'::text as shapecheck_product,
  'fsob-stale'::text as stale_product, gen_random_uuid() as stale_batch, gen_random_uuid() as stale_exec,
  'fsob-idem'::text as idem_product,
  'fsob-orderflow'::text as orderflow_product,
  gen_random_uuid() as customer_id;
grant select on f to authenticated;

insert into public.products (id, name)
  select open_product, 'Open Balance Basic' from f
  union all select reserved_product, 'Reserved Protect' from f
  union all select existing_product, 'Existing Lot' from f
  union all select posreject_product, 'Positive Reject' from f
  union all select brownie_product, 'Mixed Brownie' from f
  union all select blondie_product, 'Mixed Blondie' from f
  union all select cookie_product, 'Mixed Cookie' from f
  union all select costbasis_product, 'Cost Basis' from f
  union all select costbasis_other_product, 'Cost Basis Other' from f
  union all select shapecheck_product, 'Shape Check' from f
  union all select stale_product, 'Stale Guard' from f
  union all select idem_product, 'Idempotency' from f
  union all select orderflow_product, 'Order Flow' from f;

insert into public.product_batches (id, product_id, batch_version, status, usable_pieces)
  select reserved_batch, reserved_product, 'v1', 'completed', 10 from f
  union all select existing_batch, existing_product, 'v1', 'completed', 5 from f
  union all select posreject_batch, posreject_product, 'v1', 'completed', 5 from f
  union all select blondie_batch, blondie_product, 'v1', 'completed', 14 from f
  union all select stale_batch, stale_product, 'v1', 'completed', 5 from f;

insert into public.production_executions (id, product_id, product_batch_id, batch_version_snapshot, operation_id, multiplier, quantity_produced_pieces, expected_pieces, frozen_ingredient_cost_total, frozen_cost_per_piece, completed_at)
  select reserved_exec, reserved_product, reserved_batch, 'v1', gen_random_uuid(), 1, 10, 10, 100, 10, now() from f
  union all select existing_exec, existing_product, existing_batch, 'v1', gen_random_uuid(), 1, 5, 5, 50, 10, now() from f
  union all select posreject_exec, posreject_product, posreject_batch, 'v1', gen_random_uuid(), 1, 5, 5, 50, 10, now() from f
  union all select blondie_exec, blondie_product, blondie_batch, 'v1', gen_random_uuid(), 1, 14, 14, 140, 10, now() from f
  union all select stale_exec, stale_product, stale_batch, 'v1', gen_random_uuid(), 1, 5, 5, 50, 10, now() from f;

insert into public.finished_stock_movements (product_id, production_execution_id, movement_type, on_hand_delta, reserved_delta, operation_id, note)
  select reserved_product, reserved_exec, 'production_receipt', 10, 0, gen_random_uuid(), 'seed' from f
  union all select existing_product, existing_exec, 'production_receipt', 3, 0, gen_random_uuid(), 'seed' from f
  union all select posreject_product, posreject_exec, 'production_receipt', 5, 0, gen_random_uuid(), 'seed' from f
  union all select blondie_product, blondie_exec, 'production_receipt', 14, 0, gen_random_uuid(), 'seed' from f
  union all select stale_product, stale_exec, 'production_receipt', 5, 0, gen_random_uuid(), 'seed' from f;

-- Every product that will receive an opening balance in this suite needs its OWN costing row
-- (the server verifies the referenced costing belongs to the exact product an opening balance is
-- being recorded for -- see the cost-basis relational-ownership tests below, which deliberately
-- point at the WRONG product's costing to prove that check fires). ingredient_cost=40 throughout
-- except costbasis_other_product, which must be a distinct, clearly-wrong value.
insert into public.costing_summaries (id, product_id, ingredient_cost)
  select costbasis_costing, costbasis_product, 40 from f
  union all select costbasis_other_costing, costbasis_other_product, 999 from f
  union all select gen_random_uuid(), open_product, 40 from f
  union all select gen_random_uuid(), existing_product, 40 from f
  union all select gen_random_uuid(), brownie_product, 40 from f
  union all select gen_random_uuid(), cookie_product, 40 from f
  union all select gen_random_uuid(), orderflow_product, 40 from f
  union all select gen_random_uuid(), idem_product, 40 from f;

insert into public.customers (id, name) select customer_id, 'Test Customer' from f;
insert into public.orders (id, customer_id, status) select gen_random_uuid(), customer_id, 'new' from f;

-------------------------------------------------------------------------------------------
-- 20. SQL CHECK constraint enforces the bake/opening_balance shape directly, at the raw table
-- level -- not just an application convention, and not just something the security-definer RPCs
-- happen to respect. Run here, as the table owner (before switching to the authenticated role
-- below, which has no direct INSERT grant on production_executions at all -- see Wave 1's revoke),
-- so this specifically isolates the CHECK constraint itself from the separate RLS/grant authority
-- layer the RPCs also enforce.
-------------------------------------------------------------------------------------------
do $$
declare v_shapecheck_product text;
begin
  select shapecheck_product into v_shapecheck_product from f;
  begin
    insert into public.production_executions (product_id, product_batch_id, batch_version_snapshot, operation_id, multiplier, quantity_produced_pieces, expected_pieces, frozen_ingredient_cost_total, frozen_cost_per_piece, source_type, cost_basis_source, cost_basis_snapshot, completed_at)
      values (v_shapecheck_product, gen_random_uuid(), 'v9', gen_random_uuid(), 1, 3, 3, 30, 10, 'opening_balance', 'historical_estimate', '{}'::jsonb, now());
    raise exception 'TEST FAILED: an opening_balance row must never carry a product_batch_id';
  exception when check_violation then null; end;
  begin
    insert into public.production_executions (product_id, product_batch_id, batch_version_snapshot, operation_id, multiplier, quantity_produced_pieces, expected_pieces, frozen_ingredient_cost_total, frozen_cost_per_piece, source_type, cost_basis_source, cost_basis_snapshot, completed_at)
      values (v_shapecheck_product, null, null, gen_random_uuid(), 1, 3, 3, 30, 10, 'opening_balance', 'historical_estimate', null, now());
    raise exception 'TEST FAILED: an opening_balance row must require a non-null cost_basis_snapshot';
  exception when check_violation then null; end;
  begin
    insert into public.production_executions (product_id, product_batch_id, batch_version_snapshot, operation_id, multiplier, quantity_produced_pieces, expected_pieces, frozen_ingredient_cost_total, frozen_cost_per_piece, source_type, cost_basis_source, cost_basis_snapshot, completed_at)
      values (v_shapecheck_product, null, null, gen_random_uuid(), 1, 3, 3, 30, 10, 'bake', 'production', null, now());
    raise exception 'TEST FAILED: a bake row must require a non-null product_batch_id/batch_version_snapshot';
  exception when check_violation then null; end;
  raise notice 'CHECK constraint enforces bake/opening_balance shape directly: OK';
end $$;

set local role authenticated;
select set_config('request.jwt.claim.sub', '77777777-7777-4777-8777-777777777777', true);
select set_config('request.jwt.claim.app_role', 'owner', true);
select set_config('request.jwt.claims', '{"sub":"77777777-7777-4777-8777-777777777777","role":"authenticated","app_metadata":{"app_role":"owner"}}', true);

-- Real reservation fixture for reserved_product: 10 on_hand, 4 reserved, via the actual Wave 2
-- confirm_order_with_reservation path (not a hand-inserted movement row -- Wave 2's own CHECK
-- constraints require real order/allocation linkage for a 'reserve' movement anyway).
do $$
declare v_customer uuid; v_order uuid; v_product text;
begin
  select customer_id, reserved_product into v_customer, v_product from f;
  v_order := gen_random_uuid();
  insert into public.orders (id, customer_id, status) values (v_order, v_customer, 'new');
  insert into public.order_lines (id, order_id, product_id, item_name, unit_price, pieces_per_unit_snapshot, quantity)
    values (gen_random_uuid(), v_order, v_product, 'Test line', 100, 4, 1);
  perform public.confirm_order_with_reservation(gen_random_uuid(), v_order);
end $$;

do $$
declare v record;
begin
  select * into v from f;

  -------------------------------------------------------------------------------------------
  -- 1/8/9. On_hand 0, physical 4, zero production history -> opening balance +4, exactly once,
  -- server-verified cost basis stored, provenance explicit, no ingredients/inventory_transactions
  -- table touched (they do not even exist in this harness -- structurally impossible).
  -------------------------------------------------------------------------------------------
  declare
    v_snapshot jsonb := jsonb_build_object('source_costing_id', (select id from public.costing_summaries where product_id = v.open_product), 'ingredient_cost', 40, 'costing_yield', 8, 'computed_cost_per_piece', 5);
    v_exec_id uuid; v_source_type text; v_batch_id uuid; v_version text; v_cbs text; v_snap jsonb; v_cost numeric; v_total numeric;
  begin
    perform public.create_finished_stock_opening_balance(gen_random_uuid(), gen_random_uuid(), v.open_product, 4, null, 5, v_snapshot, 'bootstrap test');
    select coalesce(sum(on_hand_delta), 0) into v_total from public.finished_stock_movements where product_id = v.open_product;
    if v_total <> 4 then raise exception 'TEST FAILED: opening balance must add exactly the requested quantity once, got on_hand=%', v_total; end if;

    select id, source_type, product_batch_id, batch_version_snapshot, cost_basis_source, cost_basis_snapshot, frozen_cost_per_piece, frozen_ingredient_cost_total
      into v_exec_id, v_source_type, v_batch_id, v_version, v_cbs, v_snap, v_cost, v_total
      from public.production_executions where product_id = v.open_product;
    if v_source_type <> 'opening_balance' then raise exception 'TEST FAILED: source_type must be opening_balance, got %', v_source_type; end if;
    if v_batch_id is not null or v_version is not null then raise exception 'TEST FAILED: an opening-balance lot must never carry a product_batch_id/batch_version_snapshot -- it is never a fake Bake'; end if;
    if v_cbs <> 'historical_estimate' then raise exception 'TEST FAILED: cost_basis_source must be historical_estimate'; end if;
    if v_cost <> 5 then raise exception 'TEST FAILED: frozen_cost_per_piece must equal the server-verified estimate (5), got %', v_cost; end if;
    if v_total <> 20 then raise exception 'TEST FAILED: frozen_ingredient_cost_total must be cost_per_piece * quantity (5*4=20), got %', v_total; end if;
    if v_snap->>'computed_at' is null or v_snap->>'batch_operation_id' is null then raise exception 'TEST FAILED: computed_at/batch_operation_id must be server-stamped into the snapshot'; end if;
    if not exists (select 1 from public.product_batches where id = v_batch_id) and v_batch_id is not null then raise exception 'TEST FAILED: impossible'; end if;
  end;
  raise notice 'opening balance creation, cost freeze, provenance: OK';

  -------------------------------------------------------------------------------------------
  -- Regression: an opening balance must never be mistaken for a real Bake. product_batches is
  -- completely untouched (no row exists, no completed_at set anywhere) by an opening-balance
  -- creation -- structurally proving it, since open_product has zero product_batches rows at all.
  -------------------------------------------------------------------------------------------
  if exists (select 1 from public.product_batches where product_id = v.open_product) then
    raise exception 'TEST FAILED: an opening balance must never create or touch a product_batches row (that would be faking a Bake)';
  end if;
  raise notice 'opening balance never touches product_batches: OK';

  -------------------------------------------------------------------------------------------
  -- 10. Ordinary positive correction remains rejected, unmodified.
  -------------------------------------------------------------------------------------------
  begin
    perform public.record_finished_stock_exception(gen_random_uuid(), v.posreject_product, 'correction', 3, null, 'should be rejected');
    raise exception 'TEST FAILED: a positive correction must still be rejected';
  exception when others then
    if sqlstate <> '22023' then raise; end if;
  end;
  raise notice 'positive correction still rejected: OK';

  -------------------------------------------------------------------------------------------
  -- BOOTSTRAP ELIGIBILITY GATE: a product that already has production history (here, a real Bake)
  -- is rejected outright for a further opening balance -- both at the low-level function directly,
  -- and via the batch entry point (which must surface it as investigate_required, i.e. a hard
  -- failure of the whole batch, never a silent opening balance).
  -------------------------------------------------------------------------------------------
  begin
    perform public.create_finished_stock_opening_balance(gen_random_uuid(), gen_random_uuid(), v.existing_product, 7,
      null, 5, jsonb_build_object('source_costing_id', (select id from public.costing_summaries where product_id = v.existing_product), 'ingredient_cost', 40, 'costing_yield', 8, 'computed_cost_per_piece', 5), 'should be rejected');
    raise exception 'TEST FAILED: a product with existing production history must never receive a second opening balance';
  exception when others then
    if sqlstate <> '23514' then raise; end if;
  end;

  declare v_before numeric;
  begin
    select coalesce(sum(on_hand_delta),0) into v_before from public.finished_stock_movements where product_id = v.existing_product;
    begin
      perform public.apply_finished_stock_reconciliation_batch(gen_random_uuid(), (md5('gate-test') || md5('gate-test-2')),
        jsonb_build_array(jsonb_build_object('product_id', v.existing_product, 'physical_count', 10, 'expected_on_hand_pieces', 3, 'expected_reserved_pieces', 0, 'expected_latest_movement_id', null)));
      raise exception 'TEST FAILED: a positive discrepancy for a product with existing production history must fail the whole batch, not silently reconcile';
    exception when others then
      if sqlstate <> '23514' then raise; end if;
    end;
    if (select coalesce(sum(on_hand_delta),0) from public.finished_stock_movements where product_id = v.existing_product) <> v_before then
      raise exception 'TEST FAILED: on_hand for the rejected product must be completely unchanged';
    end if;
  end;
  raise notice 'bootstrap eligibility gate (direct + via batch): OK';

  -------------------------------------------------------------------------------------------
  -- COST-BASIS SERVER VALIDATION (relational ownership + internal arithmetic consistency).
  -------------------------------------------------------------------------------------------
  -- (a) referenced costing exists but belongs to a DIFFERENT product.
  begin
    perform public.create_finished_stock_opening_balance(gen_random_uuid(), gen_random_uuid(), v.costbasis_product, 2, null, 5,
      jsonb_build_object('source_costing_id', v.costbasis_other_costing, 'ingredient_cost', 999, 'costing_yield', 8, 'computed_cost_per_piece', 124.875), 'wrong owner');
    raise exception 'TEST FAILED: a costing belonging to a different product must be rejected';
  exception when others then
    if sqlstate <> '22023' then raise; end if;
  end;
  -- (b) claimed ingredient_cost does not match the real costing row.
  begin
    perform public.create_finished_stock_opening_balance(gen_random_uuid(), gen_random_uuid(), v.costbasis_product, 2, null, 5,
      jsonb_build_object('source_costing_id', v.costbasis_costing, 'ingredient_cost', 999, 'costing_yield', 8, 'computed_cost_per_piece', 124.875), 'fabricated ingredient cost');
    raise exception 'TEST FAILED: a fabricated ingredient_cost disconnected from the real costing row must be rejected';
  exception when others then
    if sqlstate <> '23514' then raise; end if;
  end;
  -- (c) internal arithmetic inconsistency (computed_cost_per_piece does not equal ingredient_cost / costing_yield).
  begin
    perform public.create_finished_stock_opening_balance(gen_random_uuid(), gen_random_uuid(), v.costbasis_product, 2, null, 999,
      jsonb_build_object('source_costing_id', v.costbasis_costing, 'ingredient_cost', 40, 'costing_yield', 8, 'computed_cost_per_piece', 999), 'bad arithmetic');
    raise exception 'TEST FAILED: an internally inconsistent computed_cost_per_piece must be rejected';
  exception when others then
    if sqlstate <> '23514' then raise; end if;
  end;
  -- (d) p_estimated_cost_per_piece disagrees with the verified snapshot.
  begin
    perform public.create_finished_stock_opening_balance(gen_random_uuid(), gen_random_uuid(), v.costbasis_product, 2, null, 12345,
      jsonb_build_object('source_costing_id', v.costbasis_costing, 'ingredient_cost', 40, 'costing_yield', 8, 'computed_cost_per_piece', 5), 'estimate disagrees');
    raise exception 'TEST FAILED: p_estimated_cost_per_piece disagreeing with the verified snapshot must be rejected';
  exception when others then
    if sqlstate <> '23514' then raise; end if;
  end;
  -- (e) a valid, internally consistent, correctly-owned snapshot succeeds.
  perform public.create_finished_stock_opening_balance(gen_random_uuid(), gen_random_uuid(), v.costbasis_product, 2, null, 5,
    jsonb_build_object('source_costing_id', v.costbasis_costing, 'ingredient_cost', 40, 'costing_yield', 8, 'computed_cost_per_piece', 5), 'valid');
  if (select frozen_cost_per_piece from public.production_executions where product_id = v.costbasis_product) <> 5 then
    raise exception 'TEST FAILED: a valid cost-basis snapshot must succeed with the verified cost frozen';
  end if;
  raise notice 'cost-basis server validation (ownership + arithmetic consistency): OK';

  -------------------------------------------------------------------------------------------
  -- The eventual acceptance scenario's exact numbers, as a single atomic batch:
  --   Brownies 0 -> 4 (opening balance), Blondies 14 -> 6 (correction -8), Cookies 0 -> 8 (opening
  --   balance). 4/19: mixed multi-product batch -> correct action per product, atomic, and the
  --   read-back after apply exactly matches the intended final quantities.
  -------------------------------------------------------------------------------------------
  declare v_hash text;
  begin
    v_hash := (md5('mixed-batch-1') || md5('mixed-batch-1-2'));
    perform public.apply_finished_stock_reconciliation_batch(gen_random_uuid(), v_hash, jsonb_build_array(
      jsonb_build_object('product_id', v.brownie_product, 'physical_count', 4, 'expected_on_hand_pieces', 0, 'expected_reserved_pieces', 0, 'expected_latest_movement_id', null,
        'estimated_cost_per_piece', 5, 'cost_basis_snapshot', jsonb_build_object('source_costing_id', (select id from public.costing_summaries where product_id = v.brownie_product), 'ingredient_cost', 40, 'costing_yield', 8, 'computed_cost_per_piece', 5)),
      jsonb_build_object('product_id', v.blondie_product, 'physical_count', 6, 'expected_on_hand_pieces', 14, 'expected_reserved_pieces', 0, 'expected_latest_movement_id',
        (select id from public.finished_stock_movements where product_id = v.blondie_product order by created_at desc, id desc limit 1)),
      jsonb_build_object('product_id', v.cookie_product, 'physical_count', 8, 'expected_on_hand_pieces', 0, 'expected_reserved_pieces', 0, 'expected_latest_movement_id', null,
        'estimated_cost_per_piece', 5, 'cost_basis_snapshot', jsonb_build_object('source_costing_id', (select id from public.costing_summaries where product_id = v.cookie_product), 'ingredient_cost', 40, 'costing_yield', 8, 'computed_cost_per_piece', 5))
    ));
  end;
  if (select coalesce(sum(on_hand_delta),0) from public.finished_stock_movements where product_id = v.brownie_product) <> 4 then
    raise exception 'TEST FAILED: brownie on_hand must be exactly 4 after the mixed batch';
  end if;
  if (select coalesce(sum(on_hand_delta),0) from public.finished_stock_movements where product_id = v.blondie_product) <> 6 then
    raise exception 'TEST FAILED: blondie on_hand must be exactly 6 after the mixed batch';
  end if;
  if (select coalesce(sum(on_hand_delta),0) from public.finished_stock_movements where product_id = v.cookie_product) <> 8 then
    raise exception 'TEST FAILED: cookie on_hand must be exactly 8 after the mixed batch';
  end if;
  if (select source_type from public.production_executions where product_id = v.brownie_product) <> 'opening_balance' then
    raise exception 'TEST FAILED: brownie must be an opening balance';
  end if;
  if (select source_type from public.production_executions where product_id = v.cookie_product) <> 'opening_balance' then
    raise exception 'TEST FAILED: cookie must be an opening balance';
  end if;
  if exists (select 1 from public.production_executions where product_id = v.blondie_product and source_type = 'opening_balance') then
    raise exception 'TEST FAILED: blondie must never receive an opening balance -- it was a negative correction';
  end if;
  raise notice 'mixed multi-product batch (4/6/8/-8 acceptance numbers), atomic, exact read-back: OK';

  -------------------------------------------------------------------------------------------
  -- 15/16 (REQUIRED). Reserved-stock distinction. reserved_product: on_hand=10, reserved=4.
  --   on_hand=10, physical=10 -> difference 0 (already proven at the pure-fn level; re-proven
  --     here against the real function: no movement written).
  --   on_hand=10, physical=8 -> difference -2, satisfiable from the 6 unreserved pieces.
  --   A shortage that would require consuming reserved stock (physical=0, needs -10, only 6
  --     unreserved) must fail the WHOLE batch safely -- reserved stock is protected, unmodified,
  --     by record_finished_stock_exception itself.
  -------------------------------------------------------------------------------------------
  declare v_on_hand numeric; v_reserved numeric; v_latest uuid; v_before_count integer;
  begin
    select coalesce(sum(on_hand_delta),0), coalesce(sum(reserved_delta),0) into v_on_hand, v_reserved
      from public.finished_stock_movements where product_id = v.reserved_product;
    if v_on_hand <> 10 or v_reserved <> 4 then raise exception 'TEST FAILED: reservation fixture must be on_hand=10, reserved=4, got on_hand=%, reserved=%', v_on_hand, v_reserved; end if;
    select id into v_latest from public.finished_stock_movements where product_id = v.reserved_product order by created_at desc, id desc limit 1;

    -- physical=10 (== on_hand): no_change, nothing written.
    select count(*) into v_before_count from public.finished_stock_movements where product_id = v.reserved_product;
    perform public.apply_finished_stock_reconciliation_batch(gen_random_uuid(), (md5('reserved-nochange') || md5('reserved-nochange-2')),
      jsonb_build_array(jsonb_build_object('product_id', v.reserved_product, 'physical_count', 10, 'expected_on_hand_pieces', 10, 'expected_reserved_pieces', 4, 'expected_latest_movement_id', v_latest)));
    if (select count(*) from public.finished_stock_movements where product_id = v.reserved_product) <> v_before_count then
      raise exception 'TEST FAILED: physical_count == on_hand must write nothing, even though reserved is nonzero';
    end if;

    -- physical=8 -> correction of 2, drawn from the 6 unreserved pieces.
    perform public.apply_finished_stock_reconciliation_batch(gen_random_uuid(), (md5('reserved-correction') || md5('reserved-correction-2')),
      jsonb_build_array(jsonb_build_object('product_id', v.reserved_product, 'physical_count', 8, 'expected_on_hand_pieces', 10, 'expected_reserved_pieces', 4, 'expected_latest_movement_id', v_latest)));
    select coalesce(sum(on_hand_delta),0), coalesce(sum(reserved_delta),0) into v_on_hand, v_reserved
      from public.finished_stock_movements where product_id = v.reserved_product;
    if v_on_hand <> 8 then raise exception 'TEST FAILED: on_hand must be 8 after the correction, got %', v_on_hand; end if;
    if v_reserved <> 4 then raise exception 'TEST FAILED: reserved must be untouched (still 4), got %', v_reserved; end if;

    -- Now on_hand=8, reserved=4, available=4. physical=0 needs a correction of 8, but only 4 are
    -- unreserved -- must fail the WHOLE batch, never partially apply, never touch reserved.
    select id into v_latest from public.finished_stock_movements where product_id = v.reserved_product order by created_at desc, id desc limit 1;
    select count(*) into v_before_count from public.finished_stock_movements where product_id = v.reserved_product;
    begin
      perform public.apply_finished_stock_reconciliation_batch(gen_random_uuid(), (md5('reserved-shortage') || md5('reserved-shortage-2')),
        jsonb_build_array(jsonb_build_object('product_id', v.reserved_product, 'physical_count', 0, 'expected_on_hand_pieces', 8, 'expected_reserved_pieces', 4, 'expected_latest_movement_id', v_latest)));
      raise exception 'TEST FAILED: a shortage requiring reserved stock must fail loudly';
    exception when others then
      if sqlstate <> '23514' then raise; end if;
    end;
    if (select count(*) from public.finished_stock_movements where product_id = v.reserved_product) <> v_before_count then
      raise exception 'TEST FAILED: nothing must be written when a shortage would require consuming reserved stock';
    end if;
    select coalesce(sum(on_hand_delta),0), coalesce(sum(reserved_delta),0) into v_on_hand, v_reserved
      from public.finished_stock_movements where product_id = v.reserved_product;
    if v_on_hand <> 8 or v_reserved <> 4 then raise exception 'TEST FAILED: on_hand/reserved must be unchanged after the rejected shortage'; end if;
  end;
  raise notice 'reserved-stock distinction (on_hand basis, protected reservations, safe shortage failure): OK';

  -------------------------------------------------------------------------------------------
  -- 13/14. Staleness: on_hand changed since "preview" -> apply rejected, nothing written.
  -------------------------------------------------------------------------------------------
  declare v_count_before integer; v_on_hand_before numeric; v_latest_before uuid;
  begin
    -- Capture the "preview" snapshot (on_hand=5, one seed movement), then simulate drift: a damage
    -- exception lands on stale_product after the (simulated) preview was taken -- a realistic
    -- source of drift, and one that also moves the "latest movement" identity, not just the count.
    select coalesce(sum(on_hand_delta),0), count(*) into v_on_hand_before, v_count_before from public.finished_stock_movements where product_id = v.stale_product;
    select id into v_latest_before from public.finished_stock_movements where product_id = v.stale_product order by created_at desc, id desc limit 1;

    perform public.record_finished_stock_exception(gen_random_uuid(), v.stale_product, 'damage', -1, null, 'simulated drift');

    begin
      -- The stale preview still believes on_hand=5 and the pre-drift latest movement id.
      perform public.apply_finished_stock_reconciliation_batch(gen_random_uuid(), (md5('stale-test') || md5('stale-test-2')),
        jsonb_build_array(jsonb_build_object('product_id', v.stale_product, 'physical_count', 5, 'expected_on_hand_pieces', v_on_hand_before, 'expected_reserved_pieces', 0, 'expected_latest_movement_id', v_latest_before)));
      raise exception 'TEST FAILED: apply must reject a stale expected_on_hand_pieces/expected_latest_movement_id';
    exception when others then
      if sqlstate <> '23514' then raise; end if;
    end;
    -- Nothing from the rejected apply itself was written (the drift's own damage movement, inserted
    -- deliberately above, is expected and excluded from this comparison).
    if (select coalesce(sum(on_hand_delta),0) from public.finished_stock_movements where product_id = v.stale_product) <> v_on_hand_before - 1
       or (select count(*) from public.finished_stock_movements where product_id = v.stale_product) <> v_count_before + 1 then
      raise exception 'TEST FAILED: a rejected stale apply must write nothing';
    end if;
  end;
  raise notice 'staleness guard rejects a changed on_hand and writes nothing: OK';

  -------------------------------------------------------------------------------------------
  -- 6/11/12. Idempotent replay: same operation id + same payload hash replays the prior result
  -- without double-adding stock; same operation id + a DIFFERENT payload hash fails.
  -------------------------------------------------------------------------------------------
  declare v_op uuid := gen_random_uuid(); v_hash text := (md5('idem-test') || md5('idem-test-2'));
    v_payload jsonb := jsonb_build_array(jsonb_build_object('product_id', v.idem_product, 'physical_count', 6, 'expected_on_hand_pieces', 0, 'expected_reserved_pieces', 0, 'expected_latest_movement_id', null,
      'estimated_cost_per_piece', 5, 'cost_basis_snapshot', jsonb_build_object('source_costing_id', (select id from public.costing_summaries where product_id = v.idem_product), 'ingredient_cost', 40, 'costing_yield', 8, 'computed_cost_per_piece', 5)));
    v_result1 jsonb; v_result2 jsonb;
  begin
    v_result1 := public.apply_finished_stock_reconciliation_batch(v_op, v_hash, v_payload);
    if (select coalesce(sum(on_hand_delta),0) from public.finished_stock_movements where product_id = v.idem_product) <> 6 then
      raise exception 'TEST FAILED: idem_product on_hand must be 6 after the first apply';
    end if;
    v_result2 := public.apply_finished_stock_reconciliation_batch(v_op, v_hash, v_payload);
    if v_result1 <> v_result2 then raise exception 'TEST FAILED: a replay with the same operation id and hash must return the identical prior result'; end if;
    if (select coalesce(sum(on_hand_delta),0) from public.finished_stock_movements where product_id = v.idem_product) <> 6 then
      raise exception 'TEST FAILED: replay must not double-add stock -- on_hand must still be exactly 6';
    end if;
    if (select count(*) from public.production_executions where product_id = v.idem_product) <> 1 then
      raise exception 'TEST FAILED: replay must not create a second production_executions row';
    end if;

    begin
      perform public.apply_finished_stock_reconciliation_batch(v_op, (md5('idem-test-DIFFERENT') || md5('idem-test-DIFFERENT-2')), v_payload);
      raise exception 'TEST FAILED: the same operation id with an altered payload hash must be rejected';
    exception when others then
      if sqlstate <> '23514' then raise; end if;
    end;
  end;
  raise notice 'idempotent replay (same result, no double-add) and altered-payload rejection: OK';

  -------------------------------------------------------------------------------------------
  -- 17/18. Opening-balance lot participates in FIFO reservation and fulfillment exactly like a
  -- Bake lot, and fulfilling from it reduces on_hand normally.
  -------------------------------------------------------------------------------------------
  declare v_order uuid; v_customer uuid;
  begin
    perform public.create_finished_stock_opening_balance(gen_random_uuid(), gen_random_uuid(), v.orderflow_product, 6, null, 5,
      jsonb_build_object('source_costing_id', (select id from public.costing_summaries where product_id = v.orderflow_product), 'ingredient_cost', 40, 'costing_yield', 8, 'computed_cost_per_piece', 5), 'orderflow seed');

    select customer_id into v_customer from f;
    v_order := gen_random_uuid();
    insert into public.orders (id, customer_id, status) values (v_order, v_customer, 'new');
    insert into public.order_lines (id, order_id, product_id, item_name, unit_price, pieces_per_unit_snapshot, quantity)
      values (gen_random_uuid(), v_order, v.orderflow_product, 'Test line', 100, 4, 1);
    perform public.confirm_order_with_reservation(gen_random_uuid(), v_order);

    if (select coalesce(sum(reserved_delta),0) from public.finished_stock_movements where product_id = v.orderflow_product) <> 4 then
      raise exception 'TEST FAILED: an opening-balance lot must be reservable via the ordinary FIFO reservation path';
    end if;

    perform public.complete_order_with_fulfillment(gen_random_uuid(), v_order);
    if (select coalesce(sum(on_hand_delta),0) from public.finished_stock_movements where product_id = v.orderflow_product) <> 2 then
      raise exception 'TEST FAILED: fulfilling from an opening-balance lot must reduce on_hand normally (6 - 4 = 2)';
    end if;
    if (select coalesce(sum(reserved_delta),0) from public.finished_stock_movements where product_id = v.orderflow_product) <> 0 then
      raise exception 'TEST FAILED: fulfillment must release the reservation (reserved back to 0)';
    end if;
    if not exists (select 1 from public.order_raw_cogs where order_id = v_order and raw_production_cogs = 4 * 5) then
      raise exception 'TEST FAILED: order_raw_cogs must derive raw COGS from the opening balance''s own frozen (estimated) cost per piece';
    end if;
  end;
  raise notice 'opening-balance lot participates in FIFO reservation and fulfillment; raw COGS derives from its frozen estimate: OK';

end $$;

reset role;
rollback;
select 'finished_stock_opening_balance_assertions_passed';
