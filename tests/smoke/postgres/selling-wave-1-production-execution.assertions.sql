-- Wave 1 single-shot invariants: atomic production, observed-piece finished quantity, idempotency
-- (observed count in the payload), reconciliation gate, all-or-nothing sufficiency, cost freeze,
-- historical immutability, product isolation, and the no-direct-write authority contract.
-- Concurrency and fault injection run in the .test.ts file (they need real overlapping
-- connections / injected failures). Everything here rolls back.
begin;

create temporary table w1 as select
  'brownie'::text as brownie_id, 'blondie'::text as blondie_id,
  gen_random_uuid() as brownie_batch, gen_random_uuid() as blondie_batch,
  gen_random_uuid() as flour, gen_random_uuid() as egg, gen_random_uuid() as sugar,
  gen_random_uuid() as cocoa;
grant select on w1 to authenticated;

insert into public.products (id, name) select brownie_id, 'Premium Brownie' from w1
  union all select blondie_id, 'Biscoff Blondie' from w1;

insert into public.product_batches (id, product_id, batch_version, status, usable_pieces)
  select brownie_batch, brownie_id, 'v3', 'completed', 9 from w1
  union all select blondie_batch, blondie_id, 'v1', 'completed', 6 from w1;

insert into public.ingredients (id, name, base_unit, current_quantity, average_unit_cost, inventory_reconciled_at)
  select flour, 'W1 Flour', 'g', 2000, 2.0, now() from w1
  union all select egg, 'W1 Egg', 'pcs', 100, 10.0, now() from w1
  union all select sugar, 'W1 Sugar', 'g', 500, 1.0, now() from w1
  -- unreconciled on purpose
  union all select cocoa, 'W1 Cocoa', 'g', 300, 3.0, null from w1;

set local role authenticated;
select set_config('request.jwt.claim.sub', '44444444-4444-4444-8444-444444444444', true);
select set_config('request.jwt.claim.app_role', 'owner', true);
select set_config('request.jwt.claims', '{"sub":"44444444-4444-4444-8444-444444444444","role":"authenticated","app_metadata":{"app_role":"owner"}}', true);

do $$
declare
  w record; op1 uuid := gen_random_uuid(); op2 uuid := gen_random_uuid();
  op_frac_a uuid := gen_random_uuid(); op_frac_b uuid := gen_random_uuid();
  r1 jsonb; r2 jsonb; r3 jsonb;
  deductions jsonb;
  v_exec_id uuid; v_pieces integer; v_expected integer; v_cost numeric; v_per_piece numeric;
  v_flour_qty numeric; v_egg_qty numeric;
  v_onhand integer; v_consume_count bigint; v_exec_count bigint;
  bad numeric;
begin
  select * into w from w1;
  deductions := jsonb_build_array(
    jsonb_build_object('ingredient_id', w.flour, 'quantity', 500),
    jsonb_build_object('ingredient_id', w.egg, 'quantity', 6));

  -- ---- Expected 9, actual 8: finished stock follows the operator's observed count ----
  r1 := public.confirm_bake_v3(op1, w.brownie_batch, w.brownie_id, 'Premium Brownie v3', 1, 8, deductions);
  v_exec_id := (r1->>'production_execution_id')::uuid;
  v_pieces := (r1->>'quantity_produced_pieces')::integer;
  v_expected := (r1->>'expected_pieces')::integer;
  v_cost := (r1->>'frozen_ingredient_cost_total')::numeric;
  v_per_piece := (r1->>'frozen_cost_per_piece')::numeric;

  if v_pieces <> 8 then raise exception 'TEST FAILED: finished quantity must be the observed 8, got %', v_pieces; end if;
  if v_expected <> 9 then raise exception 'TEST FAILED: expected_pieces reference should be 9 (yield 9 x mult 1), got %', v_expected; end if;
  if (select quantity_produced_pieces from public.production_executions where operation_id = op1) <> 8 then
    raise exception 'TEST FAILED: execution row did not store the observed count'; end if;
  if (select expected_pieces from public.production_executions where operation_id = op1) <> 9 then
    raise exception 'TEST FAILED: execution row did not freeze the expected yield'; end if;

  -- raw deducted for the requested Bake (unchanged by the observed-count decision)
  select current_quantity into v_flour_qty from public.ingredients where id = w.flour;
  select current_quantity into v_egg_qty from public.ingredients where id = w.egg;
  if v_flour_qty <> 1500 or v_egg_qty <> 94 then
    raise exception 'TEST FAILED: raw not consumed correctly (flour % / egg %)', v_flour_qty, v_egg_qty; end if;

  select count(*) into v_consume_count from public.inventory_transactions
    where source_type = 'bake' and source_id = w.brownie_batch::text and transaction_type = 'consume';
  if v_consume_count <> 2 then raise exception 'TEST FAILED: expected 2 consume rows, got %', v_consume_count; end if;

  -- cost total is the raw actually consumed (1000 + 60 = 1060); per piece divides by the OBSERVED 8
  if v_cost <> 1060 then raise exception 'TEST FAILED: frozen cost total should be 1060, got %', v_cost; end if;
  if round(v_per_piece, 4) <> round(1060.0/8, 4) then
    raise exception 'TEST FAILED: per-piece cost must divide by the observed 8, got %', v_per_piece; end if;

  select coalesce(sum(on_hand_delta), 0) into v_onhand from public.finished_stock_movements where product_id = w.brownie_id;
  if v_onhand <> 8 then raise exception 'TEST FAILED: finished on-hand should be the observed 8, got %', v_onhand; end if;

  if (select completed_at from public.product_batches where id = w.brownie_batch) is null then
    raise exception 'TEST FAILED: proof completion timestamp not set on first Bake'; end if;

  -- ---- Exact retry (same op id, same observed count): replay, no second effect ----
  r2 := public.confirm_bake_v3(op1, w.brownie_batch, w.brownie_id, 'Premium Brownie v3', 1, 8, deductions);
  if r1 <> r2 then raise exception 'TEST FAILED: retry did not replay the stored result'; end if;
  select current_quantity into v_flour_qty from public.ingredients where id = w.flour;
  select coalesce(sum(on_hand_delta), 0) into v_onhand from public.finished_stock_movements where product_id = w.brownie_id;
  select count(*) into v_exec_count from public.production_executions where product_id = w.brownie_id;
  if v_flour_qty <> 1500 or v_onhand <> 8 or v_exec_count <> 1 then
    raise exception 'TEST FAILED: retry double-applied (flour % / onhand % / execs %)', v_flour_qty, v_onhand, v_exec_count; end if;

  -- ---- Changed replay: same op id, different observed count -> rejected as a changed payload ----
  begin
    perform public.confirm_bake_v3(op1, w.brownie_batch, w.brownie_id, 'Premium Brownie v3', 1, 9, deductions);
    raise exception 'TEST FAILED: changed observed-count replay accepted';
  exception when check_violation then null; end;

  -- ---- Changed replay: same op id, different multiplier -> rejected ----
  begin
    perform public.confirm_bake_v3(op1, w.brownie_batch, w.brownie_id, 'Premium Brownie v3', 2, 8, deductions);
    raise exception 'TEST FAILED: changed-multiplier replay accepted';
  exception when check_violation then null; end;

  -- ---- Historical immutability: edit the recipe yield, past execution unchanged ----
  update public.product_batches set usable_pieces = 99 where id = w.brownie_batch;
  if (select quantity_produced_pieces from public.production_executions where operation_id = op1) <> 8 then
    raise exception 'TEST FAILED: recipe edit rewrote historical observed quantity'; end if;
  if (select expected_pieces from public.production_executions where operation_id = op1) <> 9 then
    raise exception 'TEST FAILED: recipe edit rewrote historical expected yield'; end if;
  if (select frozen_ingredient_cost_total from public.production_executions where operation_id = op1) <> 1060 then
    raise exception 'TEST FAILED: recipe edit rewrote historical production cost'; end if;
  update public.product_batches set usable_pieces = 9 where id = w.brownie_batch;

  -- ---- Expected 9, actual 10: a run that beat the recipe is accepted, not rejected for differing ----
  r3 := public.confirm_bake_v3(op2, w.brownie_batch, w.brownie_id, 'Premium Brownie v3', 1, 10, deductions);
  if (r3->>'quantity_produced_pieces')::integer <> 10 then
    raise exception 'TEST FAILED: observed 10 not recorded, got %', r3->>'quantity_produced_pieces'; end if;
  select coalesce(sum(on_hand_delta), 0) into v_onhand from public.finished_stock_movements where product_id = w.brownie_id;
  if v_onhand <> 18 then raise exception 'TEST FAILED: finished stock should be 8 + 10 = 18, got %', v_onhand; end if;

  -- ---- Product isolation: Blondie stock untouched ----
  select coalesce(sum(on_hand_delta), 0) into v_onhand from public.finished_stock_movements where product_id = w.blondie_id;
  if v_onhand <> 0 then raise exception 'TEST FAILED: Blondie finished stock changed (onhand %)', v_onhand; end if;

  -- ---- Reconciliation gate: a deduction touching unreconciled Cocoa rejects the whole Bake ----
  begin
    perform public.confirm_bake_v3(gen_random_uuid(), w.brownie_batch, w.brownie_id, 'x', 1, 5,
      jsonb_build_array(jsonb_build_object('ingredient_id', w.flour, 'quantity', 10),
                        jsonb_build_object('ingredient_id', w.cocoa, 'quantity', 10)));
    raise exception 'TEST FAILED: Bake against an unreconciled Item was accepted';
  exception when check_violation then null; end;
  if (select current_quantity from public.ingredients where id = w.cocoa) <> 300 then
    raise exception 'TEST FAILED: rejected reconciliation-gated Bake still moved Cocoa'; end if;

  -- ---- All-or-nothing sufficiency: Sugar short -> nothing moves, no execution, no finished stock ----
  select coalesce(sum(on_hand_delta), 0) into v_onhand from public.finished_stock_movements where product_id = w.brownie_id;
  select current_quantity into v_flour_qty from public.ingredients where id = w.flour;
  begin
    perform public.confirm_bake_v3(gen_random_uuid(), w.brownie_batch, w.brownie_id, 'x', 1, 5,
      jsonb_build_array(jsonb_build_object('ingredient_id', w.flour, 'quantity', 10),
                        jsonb_build_object('ingredient_id', w.sugar, 'quantity', 99999)));
    raise exception 'TEST FAILED: insufficient-stock Bake was accepted';
  exception when check_violation then null; end;
  if (select current_quantity from public.ingredients where id = w.flour) <> v_flour_qty then
    raise exception 'TEST FAILED: rejected insufficient Bake still consumed Flour'; end if;
  if (select coalesce(sum(on_hand_delta), 0) from public.finished_stock_movements where product_id = w.brownie_id) <> v_onhand then
    raise exception 'TEST FAILED: rejected insufficient Bake still received finished stock'; end if;

  -- ---- Batch/product mismatch rejected ----
  begin
    perform public.confirm_bake_v3(gen_random_uuid(), w.brownie_batch, w.blondie_id, 'x', 1, 5, deductions);
    raise exception 'TEST FAILED: batch/product mismatch accepted';
  exception when others then if sqlerrm like 'TEST FAILED:%' then raise; end if; end;

  -- ---- No usable-pieces yield -> blocked (a proven recipe/version is still required) ----
  update public.product_batches set usable_pieces = null where id = w.blondie_batch;
  begin
    perform public.confirm_bake_v3(gen_random_uuid(), w.blondie_batch, w.blondie_id, 'x', 1, 4,
      jsonb_build_array(jsonb_build_object('ingredient_id', w.flour, 'quantity', 10)));
    raise exception 'TEST FAILED: Bake with no recorded yield accepted';
  exception when others then if sqlerrm like 'TEST FAILED:%' then raise; end if; end;
  update public.product_batches set usable_pieces = 6 where id = w.blondie_batch;

  -- ---- Invalid observed counts: rejected before any effect ----
  select coalesce(sum(on_hand_delta), 0) into v_onhand from public.finished_stock_movements where product_id = w.blondie_id;
  select count(*) into v_exec_count from public.production_executions where product_id = w.blondie_id;
  foreach bad in array array[0, -3, 4.5]::numeric[]
  loop
    begin
      perform public.confirm_bake_v3(gen_random_uuid(), w.blondie_batch, w.blondie_id, 'x', 1, bad,
        jsonb_build_array(jsonb_build_object('ingredient_id', w.sugar, 'quantity', 10)));
      raise exception 'TEST FAILED: invalid observed count % accepted', bad;
    exception when sqlstate '22023' then null; end;
  end loop;
  -- explicit null
  begin
    perform public.confirm_bake_v3(gen_random_uuid(), w.blondie_batch, w.blondie_id, 'x', 1, null,
      jsonb_build_array(jsonb_build_object('ingredient_id', w.sugar, 'quantity', 10)));
    raise exception 'TEST FAILED: null observed count accepted';
  exception when sqlstate '22023' then null; end;
  -- NaN
  begin
    perform public.confirm_bake_v3(gen_random_uuid(), w.blondie_batch, w.blondie_id, 'x', 1, 'NaN'::numeric,
      jsonb_build_array(jsonb_build_object('ingredient_id', w.sugar, 'quantity', 10)));
    raise exception 'TEST FAILED: NaN observed count accepted';
  exception when sqlstate '22023' then null; end;
  if (select current_quantity from public.ingredients where id = w.sugar) <> 500 then
    raise exception 'TEST FAILED: a rejected invalid-count Bake still consumed raw stock'; end if;
  if (select coalesce(sum(on_hand_delta), 0) from public.finished_stock_movements where product_id = w.blondie_id) <> v_onhand
     or (select count(*) from public.production_executions where product_id = w.blondie_id) <> v_exec_count then
    raise exception 'TEST FAILED: a rejected invalid-count Bake still produced an execution or receipt'; end if;

  -- ---- Malformed multiplier gets a clean 22023 rejection, not a raw cast error ----
  begin
    perform public.confirm_bake_v3(gen_random_uuid(), w.blondie_batch, w.blondie_id, 'x', 'NaN'::numeric, 4,
      jsonb_build_array(jsonb_build_object('ingredient_id', w.sugar, 'quantity', 10)));
    raise exception 'TEST FAILED: NaN multiplier accepted';
  exception when sqlstate '22023' then null; end;

  -- ---- Fractional multiplier: the operator's count is finished stock, no server rounding ----
  -- yield 6 x 0.5 -> expected reference round(3); operator records 4, then a separate run records 5.
  r1 := public.confirm_bake_v3(op_frac_a, w.blondie_batch, w.blondie_id, 'Biscoff Blondie v1', 0.5, 4,
    jsonb_build_array(jsonb_build_object('ingredient_id', w.sugar, 'quantity', 10)));
  if (r1->>'quantity_produced_pieces')::integer <> 4 then
    raise exception 'TEST FAILED: fractional-multiplier Bake did not use the observed 4, got %', r1->>'quantity_produced_pieces'; end if;
  if (r1->>'expected_pieces')::integer <> 3 then
    raise exception 'TEST FAILED: expected reference for 6 x 0.5 should be round(3), got %', r1->>'expected_pieces'; end if;
  select coalesce(sum(on_hand_delta), 0) into v_onhand from public.finished_stock_movements where product_id = w.blondie_id;
  if v_onhand <> 4 then raise exception 'TEST FAILED: Blondie finished stock should be 4, got %', v_onhand; end if;

  r2 := public.confirm_bake_v3(op_frac_b, w.blondie_batch, w.blondie_id, 'Biscoff Blondie v1', 0.5, 5,
    jsonb_build_array(jsonb_build_object('ingredient_id', w.sugar, 'quantity', 10)));
  select coalesce(sum(on_hand_delta), 0) into v_onhand from public.finished_stock_movements where product_id = w.blondie_id;
  if v_onhand <> 9 then raise exception 'TEST FAILED: Blondie finished stock should be 4 + 5 = 9, got %', v_onhand; end if;
end;
$$;

-- ---- Direct-write authority: ordinary client cannot mutate production/finished-stock truth ----
do $$
declare w record;
begin
  select * into w from w1;
  begin insert into public.production_executions (product_id, product_batch_id, batch_version_snapshot,
      operation_id, multiplier, quantity_produced_pieces, expected_pieces, frozen_ingredient_cost_total, frozen_cost_per_piece, completed_at)
      values (w.brownie_id, w.brownie_batch, 'v3', gen_random_uuid(), 1, 9, 9, 0, 0, now());
    raise exception 'TEST FAILED: direct production_executions insert accepted';
  exception when insufficient_privilege then null; end;

  begin update public.production_executions set quantity_produced_pieces = 1 where product_id = w.brownie_id;
    raise exception 'TEST FAILED: direct production_executions update accepted';
  exception when insufficient_privilege then null; end;

  begin delete from public.production_executions where product_id = w.brownie_id;
    raise exception 'TEST FAILED: direct production_executions delete accepted';
  exception when insufficient_privilege then null; end;

  begin insert into public.finished_stock_movements (product_id, movement_type, on_hand_delta, reserved_delta, operation_id)
      values (w.brownie_id, 'production_receipt', 100, 0, gen_random_uuid());
    raise exception 'TEST FAILED: direct finished_stock_movements insert accepted';
  exception when insufficient_privilege then null; end;

  begin update public.finished_stock_movements set on_hand_delta = 999 where product_id = w.brownie_id;
    raise exception 'TEST FAILED: direct finished_stock_movements update accepted';
  exception when insufficient_privilege then null; end;

  begin delete from public.finished_stock_movements where product_id = w.brownie_id;
    raise exception 'TEST FAILED: direct finished_stock_movements delete accepted';
  exception when insufficient_privilege then null; end;

  -- retired Wave 0B raw-only Bake is no longer callable by the client
  begin perform public.confirm_bake_v2(gen_random_uuid(), 'x', 'x', 1, '[]'::jsonb);
    raise exception 'TEST FAILED: retired confirm_bake_v2 still callable';
  exception when insufficient_privilege then null; end;

  -- owner can still read
  if not exists (select 1 from public.production_executions where product_id = w.brownie_id) then
    raise exception 'TEST FAILED: owner cannot read its own production executions'; end if;
  if not exists (select 1 from public.finished_stock_movements where product_id = w.brownie_id) then
    raise exception 'TEST FAILED: owner cannot read its own finished-stock movements'; end if;
end;
$$;

reset role;
rollback;
select 'wave_1_assertions_passed';
