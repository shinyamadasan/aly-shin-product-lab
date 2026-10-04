-- TASK-072 single-shot invariants for correct_bake_actual_pieces ("Correct Bake"): upward and
-- downward correction, expected stays historical, frozen raw-cost total unchanged, cost per piece
-- recomputed, append-only ledger + audit row, decrease safety per LOT (reserved / fulfilled /
-- damaged), atomic rejection with no stuck claim, idempotent replay, changed-payload rejection,
-- opening-balance exclusion, input validation, stale guard, owner/grant authority, CHECK shapes,
-- Wave 3's positive-correction prohibition untouched, and sales/COGS/reservation consistency.
-- Concurrency runs in the .test.ts file (needs real overlapping connections). Everything here
-- rolls back -- one transaction, never committed.
begin;

-- Expected-failure helper: runs p_sql, requires it to raise SQLSTATE p_sqlstate, returns the message.
create function public.t072_fails(p_sql text, p_sqlstate text) returns text language plpgsql as $$
begin
  execute p_sql;
  raise exception 'TEST FAILED: expected SQLSTATE % but statement succeeded: %', p_sqlstate, p_sql;
exception when others then
  if sqlerrm like 'TEST FAILED%' then raise; end if;
  if sqlstate <> p_sqlstate then
    raise exception 'TEST FAILED: expected SQLSTATE % but got % (%): %', p_sqlstate, sqlstate, sqlerrm, p_sql;
  end if;
  return sqlerrm;
end;
$$;
grant execute on function public.t072_fails(text, text) to authenticated, anon;

create temporary table t72 as select
  't72-up'::text as up_product, gen_random_uuid() as up_batch, gen_random_uuid() as up_exec,
  't72-down'::text as down_product, gen_random_uuid() as down_batch, gen_random_uuid() as down_exec,
  't72-reserved'::text as res_product, gen_random_uuid() as res_batch, gen_random_uuid() as res_exec,
  't72-fulfilled'::text as ful_product, gen_random_uuid() as ful_batch, gen_random_uuid() as ful_exec,
  't72-damage'::text as dmg_product, gen_random_uuid() as dmg_batch, gen_random_uuid() as dmg_exec,
  't72-idem'::text as idem_product, gen_random_uuid() as idem_batch, gen_random_uuid() as idem_exec,
  't72-open'::text as open_product, gen_random_uuid() as open_exec,
  't72-recipe'::text as recipe_product, gen_random_uuid() as recipe_batch, gen_random_uuid() as recipe_exec,
  't72-cogs'::text as cogs_product, gen_random_uuid() as cogs_batch, gen_random_uuid() as cogs_exec,
  't72-lots'::text as lots_product, gen_random_uuid() as lots_batch_a, gen_random_uuid() as lots_batch_b,
  gen_random_uuid() as lots_exec_a, gen_random_uuid() as lots_exec_b,
  't72-valid'::text as valid_product, gen_random_uuid() as valid_batch, gen_random_uuid() as valid_exec,
  gen_random_uuid() as customer_id;
grant select on t72 to authenticated;

insert into public.products (id, name)
  select up_product, 'Up' from t72 union all select down_product, 'Down' from t72
  union all select res_product, 'Reserved' from t72 union all select ful_product, 'Fulfilled' from t72
  union all select dmg_product, 'Damage' from t72 union all select idem_product, 'Idem' from t72
  union all select open_product, 'Open' from t72 union all select recipe_product, 'Recipe' from t72
  union all select cogs_product, 'Cogs' from t72 union all select lots_product, 'Lots' from t72
  union all select valid_product, 'Valid' from t72;

insert into public.product_batches (id, product_id, batch_version, status, usable_pieces)
  select up_batch, up_product, 'v2', 'completed', 12 from t72
  union all select down_batch, down_product, 'v1', 'completed', 12 from t72
  union all select res_batch, res_product, 'v1', 'completed', 10 from t72
  union all select ful_batch, ful_product, 'v1', 'completed', 10 from t72
  union all select dmg_batch, dmg_product, 'v1', 'completed', 10 from t72
  union all select idem_batch, idem_product, 'v1', 'completed', 12 from t72
  union all select recipe_batch, recipe_product, 'v1', 'completed', 12 from t72
  union all select cogs_batch, cogs_product, 'v1', 'completed', 12 from t72
  union all select lots_batch_a, lots_product, 'v1', 'completed', 5 from t72
  union all select lots_batch_b, lots_product, 'v2', 'completed', 8 from t72
  union all select valid_batch, valid_product, 'v1', 'completed', 12 from t72;

-- up:   expected 12, operator typed 10, total 120 -> cps 12
-- down: expected 12, actual 12, total 120 -> cps 10
insert into public.production_executions (id, product_id, product_batch_id, batch_version_snapshot, operation_id, multiplier, quantity_produced_pieces, expected_pieces, frozen_ingredient_cost_total, frozen_cost_per_piece, completed_at)
  select up_exec, up_product, up_batch, 'v2', gen_random_uuid(), 1, 10, 12, 120, 12, now() from t72
  union all select down_exec, down_product, down_batch, 'v1', gen_random_uuid(), 1, 12, 12, 120, 10, now() from t72
  union all select res_exec, res_product, res_batch, 'v1', gen_random_uuid(), 1, 10, 10, 100, 10, now() from t72
  union all select ful_exec, ful_product, ful_batch, 'v1', gen_random_uuid(), 1, 10, 10, 100, 10, now() from t72
  union all select dmg_exec, dmg_product, dmg_batch, 'v1', gen_random_uuid(), 1, 10, 10, 100, 10, now() from t72
  union all select idem_exec, idem_product, idem_batch, 'v1', gen_random_uuid(), 1, 10, 12, 120, 12, now() from t72
  union all select recipe_exec, recipe_product, recipe_batch, 'v1', gen_random_uuid(), 1, 10, 12, 120, 12, now() from t72
  union all select cogs_exec, cogs_product, cogs_batch, 'v1', gen_random_uuid(), 1, 10, 12, 120, 12, now() from t72
  union all select lots_exec_a, lots_product, lots_batch_a, 'v1', gen_random_uuid(), 1, 5, 5, 50, 10, now() - interval '2 days' from t72
  union all select lots_exec_b, lots_product, lots_batch_b, 'v2', gen_random_uuid(), 1, 8, 8, 80, 10, now() - interval '1 day' from t72
  union all select valid_exec, valid_product, valid_batch, 'v1', gen_random_uuid(), 1, 10, 12, 120, 12, now() from t72;

-- Opening-balance lot: no batch, historical-estimate cost, snapshot present (production_executions_source_shape).
insert into public.production_executions (id, product_id, product_batch_id, batch_version_snapshot, operation_id, multiplier, quantity_produced_pieces, expected_pieces, frozen_ingredient_cost_total, frozen_cost_per_piece, source_type, cost_basis_source, cost_basis_snapshot, completed_at)
  select open_exec, open_product, null, null, gen_random_uuid(), 1, 6, 6, 60, 10, 'opening_balance', 'historical_estimate', '{"computed_cost_per_piece":10}'::jsonb, now() from t72;

insert into public.finished_stock_movements (product_id, production_execution_id, movement_type, on_hand_delta, reserved_delta, operation_id, note)
  select up_product, up_exec, 'production_receipt', 10, 0, gen_random_uuid(), 'seed' from t72
  union all select down_product, down_exec, 'production_receipt', 12, 0, gen_random_uuid(), 'seed' from t72
  union all select res_product, res_exec, 'production_receipt', 10, 0, gen_random_uuid(), 'seed' from t72
  union all select ful_product, ful_exec, 'production_receipt', 10, 0, gen_random_uuid(), 'seed' from t72
  union all select dmg_product, dmg_exec, 'production_receipt', 10, 0, gen_random_uuid(), 'seed' from t72
  union all select idem_product, idem_exec, 'production_receipt', 10, 0, gen_random_uuid(), 'seed' from t72
  union all select open_product, open_exec, 'production_receipt', 6, 0, gen_random_uuid(), 'seed' from t72
  union all select recipe_product, recipe_exec, 'production_receipt', 10, 0, gen_random_uuid(), 'seed' from t72
  union all select cogs_product, cogs_exec, 'production_receipt', 10, 0, gen_random_uuid(), 'seed' from t72
  union all select lots_product, lots_exec_a, 'production_receipt', 5, 0, gen_random_uuid(), 'seed A' from t72
  union all select lots_product, lots_exec_b, 'production_receipt', 8, 0, gen_random_uuid(), 'seed B' from t72
  union all select valid_product, valid_exec, 'production_receipt', 10, 0, gen_random_uuid(), 'seed' from t72;
-- damage lot: 3 pieces already damaged -> on_hand 7
insert into public.finished_stock_movements (product_id, production_execution_id, movement_type, on_hand_delta, reserved_delta, operation_id, note)
  select dmg_product, dmg_exec, 'damage', -3, 0, gen_random_uuid(), 'dropped' from t72;

insert into public.customers (id, name) select customer_id, 'T72 Customer' from t72;

set local role authenticated;
select set_config('request.jwt.claim.sub', '66666666-6666-4666-8666-666666666666', true);
select set_config('request.jwt.claim.app_role', 'owner', true);
select set_config('request.jwt.claims', '{"sub":"66666666-6666-4666-8666-666666666666","role":"authenticated","app_metadata":{"app_role":"owner"}}', true);

do $$
declare
  w record; r jsonb; r2 jsonb; msg text; op uuid;
  v_qty integer; v_exp integer; v_total numeric; v_cpp numeric;
  v_onhand integer; v_reserved integer; v_n integer; v_n2 integer;
  v_order uuid; v_order2 uuid; v_cogs numeric; v_pieces integer; v_alloc_before integer; v_alloc_after integer;
  v_recpt integer;
begin
  select * into w from t72;

  -- ============================================================================================
  -- 1. 10 -> 12 (operator typed 10, actually made 12): +2 pieces, expected unchanged, frozen total
  -- unchanged, cost per piece = total / 12, one audit row, one bake_correction movement, original
  -- receipt untouched.
  -- ============================================================================================
  op := gen_random_uuid();
  r := public.correct_bake_actual_pieces(op, w.up_exec, 10, 12, 'Entered wrong piece count');
  select quantity_produced_pieces, expected_pieces, frozen_ingredient_cost_total, frozen_cost_per_piece
    into v_qty, v_exp, v_total, v_cpp from public.production_executions where id = w.up_exec;
  if v_qty <> 12 then raise exception 'TEST FAILED: actual must be 12, got %', v_qty; end if;
  if v_exp <> 12 then raise exception 'TEST FAILED: expected_pieces must stay 12, got %', v_exp; end if;
  if v_total <> 120 then raise exception 'TEST FAILED: frozen raw cost total must stay 120, got %', v_total; end if;
  if v_cpp <> 10 then raise exception 'TEST FAILED: cost per piece must be 120/12 = 10, got %', v_cpp; end if;
  select coalesce(sum(on_hand_delta),0) into v_onhand from public.finished_stock_movements where product_id = w.up_product;
  if v_onhand <> 12 then raise exception 'TEST FAILED: finished stock must rise by exactly +2 to 12, got %', v_onhand; end if;
  select count(*), coalesce(sum(on_hand_delta),0) into v_n, v_recpt from public.finished_stock_movements
    where production_execution_id = w.up_exec and movement_type = 'production_receipt';
  if v_n <> 1 or v_recpt <> 10 then raise exception 'TEST FAILED: the original production receipt must remain a single +10 row, got n=% sum=%', v_n, v_recpt; end if;
  select count(*) into v_n from public.finished_stock_movements
    where production_execution_id = w.up_exec and movement_type = 'bake_correction' and on_hand_delta = 2 and reserved_delta = 0;
  if v_n <> 1 then raise exception 'TEST FAILED: exactly one +2 bake_correction movement expected, got %', v_n; end if;
  select count(*) into v_n from public.production_execution_corrections
    where production_execution_id = w.up_exec and previous_actual = 10 and corrected_actual = 12 and delta = 2
      and reason = 'Entered wrong piece count' and frozen_ingredient_cost_total = 120
      and previous_cost_per_piece = 12 and corrected_cost_per_piece = 10 and operation_id = op
      and actor = '66666666-6666-4666-8666-666666666666'::uuid;
  if v_n <> 1 then raise exception 'TEST FAILED: exactly one complete audit row expected, got %', v_n; end if;
  if (r->>'delta')::integer <> 2 or (r->>'corrected_actual')::integer <> 12 or (r->>'previous_actual')::integer <> 10 then
    raise exception 'TEST FAILED: result payload wrong: %', r; end if;
  -- ledger invariant: effective produced == receipt + corrections
  select coalesce(sum(on_hand_delta),0) into v_n from public.finished_stock_movements
    where production_execution_id = w.up_exec and movement_type in ('production_receipt','bake_correction');
  if v_n <> 12 then raise exception 'TEST FAILED: receipt + corrections must equal effective actual 12, got %', v_n; end if;

  -- ============================================================================================
  -- 2. Idempotent replay: same op + same payload returns the stored result, writes nothing more.
  -- ============================================================================================
  r2 := public.correct_bake_actual_pieces(op, w.up_exec, 10, 12, 'Entered wrong piece count');
  if r2 is distinct from r then raise exception 'TEST FAILED: replay must return the identical stored result'; end if;
  select count(*) into v_n from public.finished_stock_movements where production_execution_id = w.up_exec and movement_type = 'bake_correction';
  select count(*) into v_n2 from public.production_execution_corrections where production_execution_id = w.up_exec;
  if v_n <> 1 or v_n2 <> 1 then raise exception 'TEST FAILED: replay must not duplicate movement/audit rows (% / %)', v_n, v_n2; end if;
  select coalesce(sum(on_hand_delta),0) into v_onhand from public.finished_stock_movements where product_id = w.up_product;
  if v_onhand <> 12 then raise exception 'TEST FAILED: replay must not move stock again, got %', v_onhand; end if;

  -- 3. Same operation id + changed corrected count -> rejected, nothing changes.
  msg := public.t072_fails(format('select public.correct_bake_actual_pieces(%L,%L,10,13,%L)', op, w.up_exec, 'Entered wrong piece count'), '23514');
  if msg not like '%different request%' then raise exception 'TEST FAILED: changed-payload reuse message wrong: %', msg; end if;
  -- ...also a changed reason is a changed payload.
  perform public.t072_fails(format('select public.correct_bake_actual_pieces(%L,%L,10,12,%L)', op, w.up_exec, 'different reason'), '23514');
  select quantity_produced_pieces into v_qty from public.production_executions where id = w.up_exec;
  if v_qty <> 12 then raise exception 'TEST FAILED: rejected changed payload must not mutate, got %', v_qty; end if;

  -- ============================================================================================
  -- 4. 12 -> 10 with enough uncommitted lot stock: -2 pieces, cost recalculated, one audit row.
  -- ============================================================================================
  r := public.correct_bake_actual_pieces(gen_random_uuid(), w.down_exec, 12, 10, 'Counted again: only 10');
  select quantity_produced_pieces, expected_pieces, frozen_ingredient_cost_total, frozen_cost_per_piece
    into v_qty, v_exp, v_total, v_cpp from public.production_executions where id = w.down_exec;
  if v_qty <> 10 or v_exp <> 12 or v_total <> 120 or v_cpp <> 12 then
    raise exception 'TEST FAILED: down correction wrong: qty=% exp=% total=% cpp=%', v_qty, v_exp, v_total, v_cpp; end if;
  select coalesce(sum(on_hand_delta),0) into v_onhand from public.finished_stock_movements where product_id = w.down_product;
  if v_onhand <> 10 then raise exception 'TEST FAILED: finished stock must fall by exactly 2 to 10, got %', v_onhand; end if;
  select count(*) into v_n from public.production_execution_corrections
    where production_execution_id = w.down_exec and previous_actual = 12 and corrected_actual = 10 and delta = -2;
  if v_n <> 1 then raise exception 'TEST FAILED: one -2 audit row expected, got %', v_n; end if;

  -- A second correction on the same Bake chains: original receipt still +12 and two audit rows.
  r := public.correct_bake_actual_pieces(gen_random_uuid(), w.down_exec, 10, 11, 'Actually 11');
  select count(*) into v_n from public.production_execution_corrections where production_execution_id = w.down_exec;
  select coalesce(sum(on_hand_delta),0) into v_onhand from public.finished_stock_movements where production_execution_id = w.down_exec and movement_type in ('production_receipt','bake_correction');
  select frozen_cost_per_piece into v_cpp from public.production_executions where id = w.down_exec;
  if v_n <> 2 or v_onhand <> 11 or abs(v_cpp - (120.0/11)) > 1e-9 then
    raise exception 'TEST FAILED: chained correction wrong: audit rows=% produced=% cpp=%', v_n, v_onhand, v_cpp; end if;

  -- ============================================================================================
  -- 5. Decrease conflicting with RESERVED stock: lot 10, 4 reserved -> only 6 removable.
  -- ============================================================================================
  v_order := gen_random_uuid();
  insert into public.orders (id, customer_id, status) values (v_order, w.customer_id, 'new');
  insert into public.order_lines (id, order_id, product_id, item_name, unit_price, pieces_per_unit_snapshot, quantity)
    values (gen_random_uuid(), v_order, w.res_product, 'Line', 100, 4, 1);
  perform public.confirm_order_with_reservation(gen_random_uuid(), v_order);

  op := gen_random_uuid();
  select count(*) into v_n from public.finished_stock_movements where production_execution_id = w.res_exec;
  msg := public.t072_fails(format('select public.correct_bake_actual_pieces(%L,%L,10,2,%L)', op, w.res_exec, 'too low'), '23514');
  if msg not like 'Cannot lower this Bake from 10 to 2 pieces: only 6%' then raise exception 'TEST FAILED: reserved rejection message wrong: %', msg; end if;
  select quantity_produced_pieces, frozen_cost_per_piece into v_qty, v_cpp from public.production_executions where id = w.res_exec;
  select count(*) into v_n2 from public.finished_stock_movements where production_execution_id = w.res_exec;
  if v_qty <> 10 or v_cpp <> 10 or v_n2 <> v_n then raise exception 'TEST FAILED: rejected decrease must be atomic (qty=% cpp=% movements % -> %)', v_qty, v_cpp, v_n, v_n2; end if;
  if exists (select 1 from public.production_execution_corrections where production_execution_id = w.res_exec) then
    raise exception 'TEST FAILED: rejected decrease must leave no audit row'; end if;
  -- The rejected attempt left no stuck claim: the SAME operation id works for a valid payload.
  r := public.correct_bake_actual_pieces(op, w.res_exec, 10, 4, 'exactly the unreserved remainder');
  select coalesce(sum(on_hand_delta),0), coalesce(sum(reserved_delta),0) into v_onhand, v_reserved
    from public.finished_stock_movements where production_execution_id = w.res_exec;
  if v_onhand <> 4 or v_reserved <> 4 then raise exception 'TEST FAILED: after lowering to the reserved floor on_hand=reserved=4, got %/%', v_onhand, v_reserved; end if;

  -- ============================================================================================
  -- 6. Decrease conflicting with FULFILLED (sold) stock: lot 10, order of 4 fulfilled -> on_hand 6.
  -- ============================================================================================
  v_order := gen_random_uuid();
  insert into public.orders (id, customer_id, status) values (v_order, w.customer_id, 'new');
  insert into public.order_lines (id, order_id, product_id, item_name, unit_price, pieces_per_unit_snapshot, quantity)
    values (gen_random_uuid(), v_order, w.ful_product, 'Line', 100, 4, 1);
  perform public.confirm_order_with_reservation(gen_random_uuid(), v_order);
  perform public.complete_order_with_fulfillment(gen_random_uuid(), v_order);
  perform public.t072_fails(format('select public.correct_bake_actual_pieces(%L,%L,10,3,%L)', gen_random_uuid(), w.ful_exec, 'below sold'), '23514');
  r := public.correct_bake_actual_pieces(gen_random_uuid(), w.ful_exec, 10, 4, 'down to exactly what was sold');
  select coalesce(sum(on_hand_delta),0), coalesce(sum(reserved_delta),0) into v_onhand, v_reserved
    from public.finished_stock_movements where production_execution_id = w.ful_exec;
  if v_onhand <> 0 or v_reserved <> 0 then raise exception 'TEST FAILED: lot fully sold: on_hand=reserved=0, got %/%', v_onhand, v_reserved; end if;
  select frozen_cost_per_piece into v_cpp from public.production_executions where id = w.ful_exec;
  select raw_production_cogs, fulfilled_pieces into v_cogs, v_pieces from public.order_raw_cogs where order_id = v_order;
  if v_cpp <> 25 or v_pieces <> 4 or v_cogs <> 100 then
    raise exception 'TEST FAILED: sold-out lot: cpp must be 100/4=25 and COGS 4x25=100 (== frozen total, never above), got cpp=% pieces=% cogs=%', v_cpp, v_pieces, v_cogs; end if;

  -- 7. Decrease conflicting with damaged stock: lot 10 with 3 damaged -> 7 removable.
  perform public.t072_fails(format('select public.correct_bake_actual_pieces(%L,%L,10,2,%L)', gen_random_uuid(), w.dmg_exec, 'below damage'), '23514');
  r := public.correct_bake_actual_pieces(gen_random_uuid(), w.dmg_exec, 10, 3, 'down to damaged amount');
  select coalesce(sum(on_hand_delta),0) into v_onhand from public.finished_stock_movements where production_execution_id = w.dmg_exec;
  if v_onhand <> 0 then raise exception 'TEST FAILED: damaged lot floor: on_hand must be 0, got %', v_onhand; end if;

  -- 8. The decrease rule is per LOT, not per product: lot A (older, 5) fully reserved; lot B (8)
  -- free. Product-wide available is 8, but lot A cannot be lowered by even 1.
  v_order := gen_random_uuid();
  insert into public.orders (id, customer_id, status) values (v_order, w.customer_id, 'new');
  insert into public.order_lines (id, order_id, product_id, item_name, unit_price, pieces_per_unit_snapshot, quantity)
    values (gen_random_uuid(), v_order, w.lots_product, 'Line', 100, 5, 1);
  perform public.confirm_order_with_reservation(gen_random_uuid(), v_order);  -- FIFO takes all 5 of lot A
  perform public.t072_fails(format('select public.correct_bake_actual_pieces(%L,%L,5,4,%L)', gen_random_uuid(), w.lots_exec_a, 'lot A is reserved'), '23514');
  r := public.correct_bake_actual_pieces(gen_random_uuid(), w.lots_exec_b, 8, 5, 'lot B is free');
  select coalesce(sum(on_hand_delta),0) into v_onhand from public.finished_stock_movements where production_execution_id = w.lots_exec_a;
  if v_onhand <> 5 then raise exception 'TEST FAILED: correcting lot B must not touch lot A, A on_hand=%', v_onhand; end if;

  -- ============================================================================================
  -- 9. Opening-balance lots cannot be corrected through Correct Bake.
  -- ============================================================================================
  msg := public.t072_fails(format('select public.correct_bake_actual_pieces(%L,%L,6,8,%L)', gen_random_uuid(), w.open_exec, 'try opening'), '23514');
  if msg not like 'Only a real Bake can be corrected here%' then raise exception 'TEST FAILED: opening-balance message wrong: %', msg; end if;
  select quantity_produced_pieces into v_qty from public.production_executions where id = w.open_exec;
  if v_qty <> 6 then raise exception 'TEST FAILED: opening balance must be untouched'; end if;

  -- ============================================================================================
  -- 10. Invalid values: null / zero / negative / fractional / NaN / huge corrected count; missing
  -- or blank reason; null/unknown execution; bad expected-current; no-op same count; stale guard.
  -- ============================================================================================
  perform public.t072_fails(format('select public.correct_bake_actual_pieces(%L,%L,10,null,%L)', gen_random_uuid(), w.valid_exec, 'r'), '22023');
  perform public.t072_fails(format('select public.correct_bake_actual_pieces(%L,%L,10,0,%L)', gen_random_uuid(), w.valid_exec, 'r'), '22023');
  perform public.t072_fails(format('select public.correct_bake_actual_pieces(%L,%L,10,-3,%L)', gen_random_uuid(), w.valid_exec, 'r'), '22023');
  perform public.t072_fails(format('select public.correct_bake_actual_pieces(%L,%L,10,11.5,%L)', gen_random_uuid(), w.valid_exec, 'r'), '22023');
  perform public.t072_fails(format('select public.correct_bake_actual_pieces(%L,%L,10,%L::numeric,%L)', gen_random_uuid(), w.valid_exec, 'NaN', 'r'), '22023');
  perform public.t072_fails(format('select public.correct_bake_actual_pieces(%L,%L,10,99999999999,%L)', gen_random_uuid(), w.valid_exec, 'r'), '22023');
  perform public.t072_fails(format('select public.correct_bake_actual_pieces(%L,%L,10,12,null)', gen_random_uuid(), w.valid_exec), '22023');
  perform public.t072_fails(format('select public.correct_bake_actual_pieces(%L,%L,10,12,%L)', gen_random_uuid(), w.valid_exec, ''), '22023');
  perform public.t072_fails(format('select public.correct_bake_actual_pieces(%L,%L,10,12,%L)', gen_random_uuid(), w.valid_exec, '   '), '22023');
  perform public.t072_fails(format('select public.correct_bake_actual_pieces(%L,null,10,12,%L)', gen_random_uuid(), 'r'), '22023');
  perform public.t072_fails(format('select public.correct_bake_actual_pieces(%L,%L,10,12,%L)', gen_random_uuid(), gen_random_uuid(), 'r'), '22023');
  perform public.t072_fails(format('select public.correct_bake_actual_pieces(%L,%L,null,12,%L)', gen_random_uuid(), w.valid_exec, 'r'), '22023');
  perform public.t072_fails(format('select public.correct_bake_actual_pieces(%L,%L,0,12,%L)', gen_random_uuid(), w.valid_exec, 'r'), '22023');
  perform public.t072_fails(format('select public.correct_bake_actual_pieces(null,%L,10,12,%L)', w.valid_exec, 'r'), '22023');
  perform public.t072_fails(format('select public.correct_bake_actual_pieces(%L,%L,10,10,%L)', gen_random_uuid(), w.valid_exec, 'same'), '22023');
  -- stale guard: the operator saw 9, the Bake is recorded as 10
  msg := public.t072_fails(format('select public.correct_bake_actual_pieces(%L,%L,9,12,%L)', gen_random_uuid(), w.valid_exec, 'stale'), 'PT409');
  if msg not like '%Reload and try again%' then raise exception 'TEST FAILED: stale message wrong: %', msg; end if;
  -- TASK-072A regression: PostgREST 14 retries SQLSTATE 40001, so the RPC must never raise it.
  if pg_get_functiondef('inventory_private.correct_bake_actual_pieces(uuid,uuid,integer,numeric,text)'::regprocedure) like '%40001%' then
    raise exception 'TEST FAILED: correct_bake_actual_pieces must not use SQLSTATE 40001'; end if;
  select quantity_produced_pieces, frozen_cost_per_piece into v_qty, v_cpp from public.production_executions where id = w.valid_exec;
  if v_qty <> 10 or v_cpp <> 12 or exists (select 1 from public.production_execution_corrections where production_execution_id = w.valid_exec) then
    raise exception 'TEST FAILED: every rejected call above must leave the Bake untouched'; end if;

  -- ============================================================================================
  -- 11. Recipe edited after production: historical Expected stays frozen, before AND after a correction.
  -- ============================================================================================
  reset role;
  update public.product_batches set usable_pieces = 14 where id = w.recipe_batch;
  set local role authenticated;
  select expected_pieces into v_exp from public.production_executions where id = w.recipe_exec;
  if v_exp <> 12 then raise exception 'TEST FAILED: a recipe edit must not change a historical Expected, got %', v_exp; end if;
  r := public.correct_bake_actual_pieces(gen_random_uuid(), w.recipe_exec, 10, 12, 'typo');
  select expected_pieces, quantity_produced_pieces into v_exp, v_qty from public.production_executions where id = w.recipe_exec;
  if v_exp <> 12 or v_qty <> 12 or (r->>'expected_pieces')::integer <> 12 then
    raise exception 'TEST FAILED: Correct Bake must not recompute Expected from the (now 14) recipe: exp=% qty=%', v_exp, v_qty; end if;

  -- ============================================================================================
  -- 12. Sales / COGS / reservation consistency. Lot 10, total 120 (cps 12). Order of 4 fulfilled.
  -- Correct 10 -> 12: allocations and fulfill movement untouched; fulfilled raw COGS restates to
  -- the true corrected yield (4 x 10 = 40, never above the frozen total); the two extra pieces
  -- become reservable.
  -- ============================================================================================
  v_order := gen_random_uuid();
  insert into public.orders (id, customer_id, status) values (v_order, w.customer_id, 'new');
  insert into public.order_lines (id, order_id, product_id, item_name, unit_price, pieces_per_unit_snapshot, quantity)
    values (gen_random_uuid(), v_order, w.cogs_product, 'Line', 100, 4, 1);
  perform public.confirm_order_with_reservation(gen_random_uuid(), v_order);
  perform public.complete_order_with_fulfillment(gen_random_uuid(), v_order);
  select raw_production_cogs into v_cogs from public.order_raw_cogs where order_id = v_order;
  if v_cogs <> 48 then raise exception 'TEST FAILED: pre-correction COGS must be 4 x 12 = 48, got %', v_cogs; end if;
  select count(*) into v_alloc_before from public.order_stock_allocations where order_id = v_order and status = 'fulfilled' and reserved_pieces = 4;

  r := public.correct_bake_actual_pieces(gen_random_uuid(), w.cogs_exec, 10, 12, 'typo');

  select count(*) into v_alloc_after from public.order_stock_allocations where order_id = v_order and status = 'fulfilled' and reserved_pieces = 4;
  if v_alloc_before <> 1 or v_alloc_after <> 1 then raise exception 'TEST FAILED: allocations must be untouched by a correction'; end if;
  select raw_production_cogs, fulfilled_pieces into v_cogs, v_pieces from public.order_raw_cogs where order_id = v_order;
  if v_cogs <> 40 or v_pieces <> 4 then raise exception 'TEST FAILED: restated COGS must be 4 x 10 = 40 over 4 pieces, got % over %', v_cogs, v_pieces; end if;
  if v_cogs > 120 then raise exception 'TEST FAILED: COGS must never exceed the frozen raw cost total'; end if;
  select count(*) into v_n from public.finished_stock_movements where production_execution_id = w.cogs_exec and movement_type = 'fulfill';
  if v_n <> 1 then raise exception 'TEST FAILED: fulfill movement count must be unchanged, got %', v_n; end if;
  -- available is now 12 - 4 = 8: a new order of 8 reserves; it would have been refused at 6 before.
  v_order2 := gen_random_uuid();
  insert into public.orders (id, customer_id, status) values (v_order2, w.customer_id, 'new');
  insert into public.order_lines (id, order_id, product_id, item_name, unit_price, pieces_per_unit_snapshot, quantity)
    values (gen_random_uuid(), v_order2, w.cogs_product, 'Line', 100, 8, 1);
  perform public.confirm_order_with_reservation(gen_random_uuid(), v_order2);
  select coalesce(sum(on_hand_delta),0), coalesce(sum(reserved_delta),0) into v_onhand, v_reserved
    from public.finished_stock_movements where product_id = w.cogs_product;
  if v_onhand <> 8 or v_reserved <> 8 then raise exception 'TEST FAILED: after fulfilling 4 and reserving 8 of 12: on_hand=8 reserved=8, got %/%', v_onhand, v_reserved; end if;

  -- ============================================================================================
  -- 13. Authority: owner-only, no client DML on protected history, no anon execute, Wave 3's
  -- positive-correction prohibition untouched.
  -- ============================================================================================
  perform set_config('request.jwt.claim.app_role', 'staff', true);
  perform public.t072_fails(format('select public.correct_bake_actual_pieces(%L,%L,10,12,%L)', gen_random_uuid(), w.valid_exec, 'not owner'), '42501');
  perform set_config('request.jwt.claim.app_role', 'owner', true);

  perform public.t072_fails(format('update public.production_executions set quantity_produced_pieces = 99 where id = %L', w.valid_exec), '42501');
  perform public.t072_fails(format('update public.production_executions set frozen_cost_per_piece = 0 where id = %L', w.valid_exec), '42501');
  perform public.t072_fails(format('insert into public.production_execution_corrections (production_execution_id, operation_id, previous_actual, corrected_actual, delta, reason, frozen_ingredient_cost_total, previous_cost_per_piece, corrected_cost_per_piece, finished_stock_movement_id, actor, corrected_at) values (%L, gen_random_uuid(), 10, 12, 2, %L, 120, 12, 10, gen_random_uuid(), gen_random_uuid(), now())', w.valid_exec, 'forged'), '42501');
  perform public.t072_fails(format('delete from public.production_execution_corrections where production_execution_id = %L', w.up_exec), '42501');
  perform public.t072_fails(format('update public.production_execution_corrections set reason = %L where production_execution_id = %L', 'rewritten', w.up_exec), '42501');
  perform public.t072_fails(format('insert into public.finished_stock_movements (product_id, production_execution_id, movement_type, on_hand_delta, reserved_delta, operation_id) values (%L, %L, %L, 5, 0, gen_random_uuid())', w.valid_product, w.valid_exec, 'bake_correction'), '42501');
  -- owner can READ the audit trail
  select count(*) into v_n from public.production_execution_corrections where production_execution_id = w.up_exec;
  if v_n <> 1 then raise exception 'TEST FAILED: owner must be able to read the audit row, got %', v_n; end if;
  -- Wave 3's prohibition is untouched: arbitrary "found more" positive correction still rejected.
  perform public.t072_fails(format('select public.record_finished_stock_exception(%L,%L,%L,2,null,%L)', gen_random_uuid(), w.valid_product, 'correction', 'found more'), '22023');

  -- anon cannot execute either function layer
  reset role;
  set local role anon;
  perform public.t072_fails(format('select public.correct_bake_actual_pieces(%L,%L,10,12,%L)', gen_random_uuid(), w.valid_exec, 'anon'), '42501');
  reset role;
  set local role authenticated;
end;
$$;

-- ============================================================================================
-- 14. CHECK shapes (as superuser, bypassing grants -- defense in depth if a future writer skipped the RPC)
-- ============================================================================================
reset role;
do $$
declare w record; msg text;
begin
  select * into w from t72;
  -- bake_correction must be on-hand only, lot-linked, non-zero, never order-linked.
  msg := public.t072_fails(format('insert into public.finished_stock_movements (product_id, production_execution_id, movement_type, on_hand_delta, reserved_delta, operation_id) values (%L, %L, %L, 2, 1, gen_random_uuid())', w.valid_product, w.valid_exec, 'bake_correction'), '23514');
  msg := public.t072_fails(format('insert into public.finished_stock_movements (product_id, production_execution_id, movement_type, on_hand_delta, reserved_delta, operation_id) values (%L, %L, %L, 0, 0, gen_random_uuid())', w.valid_product, w.valid_exec, 'bake_correction'), '23514');
  msg := public.t072_fails(format('insert into public.finished_stock_movements (product_id, production_execution_id, movement_type, on_hand_delta, reserved_delta, operation_id) values (%L, null, %L, 2, 0, gen_random_uuid())', w.valid_product, 'bake_correction'), '23514');
  -- the Wave 3 exception shape is unchanged: a positive damage/giveaway/correction row is still impossible
  msg := public.t072_fails(format('insert into public.finished_stock_movements (product_id, production_execution_id, movement_type, on_hand_delta, reserved_delta, operation_id) values (%L, %L, %L, 2, 0, gen_random_uuid())', w.valid_product, w.valid_exec, 'correction'), '23514');
  -- the audit row's own checks
  msg := public.t072_fails(format('insert into public.production_execution_corrections (production_execution_id, operation_id, previous_actual, corrected_actual, delta, reason, frozen_ingredient_cost_total, previous_cost_per_piece, corrected_cost_per_piece, finished_stock_movement_id, actor, corrected_at) select %L, gen_random_uuid(), 10, 12, 5, %L, 120, 12, 10, id, gen_random_uuid(), now() from public.finished_stock_movements limit 1', w.valid_exec, 'delta mismatch'), '23514');
  msg := public.t072_fails(format('insert into public.production_execution_corrections (production_execution_id, operation_id, previous_actual, corrected_actual, delta, reason, frozen_ingredient_cost_total, previous_cost_per_piece, corrected_cost_per_piece, finished_stock_movement_id, actor, corrected_at) select %L, gen_random_uuid(), 10, 12, 2, %L, 120, 12, 10, id, gen_random_uuid(), now() from public.finished_stock_movements limit 1', w.valid_exec, '  '), '23514');
end;
$$;

-- ============================================================================================
-- 15. Global ledger/lot consistency across every fixture: effective actual == receipt + corrections;
-- no lot ever has reserved > on_hand or negative on_hand; fulfilled+reserved cost never exceeds the
-- frozen raw-cost total; cost per piece == total / actual for every corrected Bake.
-- ============================================================================================
do $$
declare bad integer;
begin
  select count(*) into bad from public.production_executions pe
    where pe.product_id like 't72-%'
      and pe.quantity_produced_pieces <> (select coalesce(sum(on_hand_delta),0) from public.finished_stock_movements m
        where m.production_execution_id = pe.id and m.movement_type in ('production_receipt','bake_correction'));
  if bad <> 0 then raise exception 'TEST FAILED: % lot(s) where effective actual != receipt + corrections', bad; end if;

  select count(*) into bad from (
    select pe.id from public.production_executions pe
    left join public.finished_stock_movements m on m.production_execution_id = pe.id
    where pe.product_id like 't72-%'
    group by pe.id having coalesce(sum(m.on_hand_delta),0) < 0 or coalesce(sum(m.reserved_delta),0) < 0
      or coalesce(sum(m.reserved_delta),0) > coalesce(sum(m.on_hand_delta),0)) x;
  if bad <> 0 then raise exception 'TEST FAILED: % lot(s) with negative or over-reserved stock', bad; end if;

  select count(*) into bad from public.production_executions pe
    where pe.product_id like 't72-%' and pe.source_type = 'bake'
      and abs(pe.frozen_cost_per_piece * pe.quantity_produced_pieces - pe.frozen_ingredient_cost_total) > 1e-9;
  if bad <> 0 then raise exception 'TEST FAILED: % Bake(s) where cost per piece x actual != frozen total', bad; end if;

  select count(*) into bad from public.production_executions pe
    where pe.product_id like 't72-%'
      and pe.frozen_cost_per_piece * (select coalesce(sum(osa.reserved_pieces),0) from public.order_stock_allocations osa
          where osa.production_execution_id = pe.id and osa.status in ('active','fulfilled')) > pe.frozen_ingredient_cost_total + 1e-9;
  if bad <> 0 then raise exception 'TEST FAILED: % lot(s) where allocated cost exceeds the frozen total', bad; end if;

  -- every correction movement has exactly one audit row and vice versa
  select count(*) into bad from public.finished_stock_movements m
    where m.movement_type = 'bake_correction'
      and (select count(*) from public.production_execution_corrections c where c.finished_stock_movement_id = m.id and c.delta = m.on_hand_delta) <> 1;
  if bad <> 0 then raise exception 'TEST FAILED: % bake_correction movement(s) without exactly one matching audit row', bad; end if;
end;
$$;

select 'bake_actual_correction_assertions_passed';
rollback;
