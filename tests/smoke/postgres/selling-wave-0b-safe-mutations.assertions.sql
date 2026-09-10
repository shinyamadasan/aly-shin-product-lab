-- Wave 0B single-shot assertions: idempotency, reconciliation gate, all-or-nothing sufficiency,
-- direct-write authority regression. Concurrency itself is exercised separately in the .test.ts
-- file (it needs two real overlapping connections, not a single script). Everything here runs
-- inside one transaction and rolls back.
begin;

create temporary table wave0b_ids as select
  gen_random_uuid() as flour_id, gen_random_uuid() as egg_id, gen_random_uuid() as sugar_id,
  gen_random_uuid() as cocoa_id, gen_random_uuid() as import_ok_id, gen_random_uuid() as import_gate_id,
  gen_random_uuid() as import_bad_row_id;
grant select on wave0b_ids to authenticated;

insert into public.ingredients (id, name, base_unit, current_quantity, average_unit_cost, inventory_reconciled_at)
  select flour_id, 'Wave 0B Flour', 'g', 1000, 2.0, now() from wave0b_ids
  union all select egg_id, 'Wave 0B Egg', 'pcs', 50, 10.0, now() from wave0b_ids
  union all select sugar_id, 'Wave 0B Sugar', 'g', 300, 1.0, now() from wave0b_ids
  -- Deliberately unreconciled: no physical count has ever been recorded for it.
  union all select cocoa_id, 'Wave 0B Cocoa', 'g', 200, 3.0, null from wave0b_ids;

insert into public.purchase_imports (id, file_name, status, supplier_name, receipt_number, purchase_date)
  select import_ok_id, 'wave0b-ok.csv', 'draft', 'SM', 'R-1', current_date from wave0b_ids
  union all select import_gate_id, 'wave0b-gate.csv', 'draft', 'SM', 'R-2', current_date from wave0b_ids
  union all select import_bad_row_id, 'wave0b-badrow.csv', 'draft', 'SM', 'R-3', current_date from wave0b_ids;

insert into public.purchase_import_rows (import_id, row_index, raw_item_name, raw_quantity, raw_unit, raw_total_price,
  parsed_quantity, parsed_total_price, ingredient_id, match_method, converted_quantity, row_status, brand_name)
  select import_ok_id, 0, 'Flour', '500', 'g', '1000', 500, 1000, flour_id, 'exact', 500, 'matched', 'Local' from wave0b_ids
  union all
  select import_ok_id, 1, 'Egg', '10', 'pcs', '0', 10, 0, egg_id, 'exact', 10, 'matched', 'Local' from wave0b_ids
  union all
  select import_gate_id, 0, 'Cocoa', '100', 'g', '300', 100, 300, cocoa_id, 'exact', 100, 'matched', 'Local' from wave0b_ids
  union all
  select import_bad_row_id, 0, 'Sugar', '100', 'g', '100', 100, 100, sugar_id, 'exact', 100, 'pending', 'Local' from wave0b_ids;

set local role authenticated;
select set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', true);
select set_config('request.jwt.claim.app_role', 'owner', true);
select set_config('request.jwt.claims', '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated","app_metadata":{"app_role":"owner"}}', true);

-- ================================ post_raw_purchase ================================
do $$
declare ids record; op1 uuid := gen_random_uuid(); op2 uuid := gen_random_uuid();
  r1 jsonb; r2 jsonb; r3 jsonb; qty numeric; avgc numeric; tx_count bigint;
begin
  select * into ids from wave0b_ids;

  -- Happy path: 1000g @ avg 2.0 + 500g @ total 1000 (cost 2.0/g) -> new avg stays 2.0, qty 1500.
  r1 := public.post_raw_purchase(op1, ids.flour_id, 500, 'g', 500, 1000, 'Local', 'SM', current_date, 5, 'ok');
  select current_quantity, average_unit_cost into qty, avgc from public.ingredients where id = ids.flour_id;
  if qty <> 1500 or avgc <> 2.0 then raise exception 'TEST FAILED: wrong quantity/cost after manual purchase (got % / %)', qty, avgc; end if;

  -- Exact retry, same operation id: must return the identical stored result and apply nothing again.
  r2 := public.post_raw_purchase(op1, ids.flour_id, 500, 'g', 500, 1000, 'Local', 'SM', current_date, 5, 'ok');
  if r1 <> r2 then raise exception 'TEST FAILED: retry did not replay the stored result'; end if;
  select current_quantity into qty from public.ingredients where id = ids.flour_id;
  if qty <> 1500 then raise exception 'TEST FAILED: retry double-applied the purchase (qty %)', qty; end if;
  select count(*) into tx_count from public.inventory_transactions where ingredient_id = ids.flour_id and source_type = 'manual';
  if tx_count <> 1 then raise exception 'TEST FAILED: retry created a second ledger row (count %)', tx_count; end if;

  -- Same operation id, different payload: rejected, nothing applied.
  begin
    perform public.post_raw_purchase(op1, ids.flour_id, 999, 'g', 999, 999, 'Local', 'SM', current_date, 5, 'changed');
    raise exception 'TEST FAILED: changed-payload replay accepted';
  exception when check_violation then null; end;
  select current_quantity into qty from public.ingredients where id = ids.flour_id;
  if qty <> 1500 then raise exception 'TEST FAILED: rejected changed-payload retry still mutated stock'; end if;

  -- A second, genuinely distinct purchase (a fresh operation id, a different payload) must
  -- succeed normally -- the UI-side fix (rotate the operation id after a successful new purchase)
  -- depends on this: a fresh id for a deliberately different purchase is never treated as a
  -- replay of the first.
  -- Priced at the same PHP 2.0/g as the fixture's running average, so this purchase's own math
  -- stays predictable for the CSV-confirm assertions that follow it below.
  r3 := public.post_raw_purchase(gen_random_uuid(), ids.flour_id, 100, 'g', 100, 200, 'Local', 'SM', current_date, 5, 'second purchase');
  select current_quantity, average_unit_cost into qty, avgc from public.ingredients where id = ids.flour_id;
  if qty <> 1600 or avgc <> 2.0 then raise exception 'TEST FAILED: a second, genuinely distinct purchase under a fresh operation id did not apply (qty % / avg %)', qty, avgc; end if;

  -- Reconciliation gate: Cocoa has no verified opening count.
  begin
    perform public.post_raw_purchase(op2, ids.cocoa_id, 50, 'g', 50, 150, 'Local', 'SM', current_date, 5, 'blocked');
    raise exception 'TEST FAILED: purchase posted against an unreconciled Item';
  exception when check_violation then null; end;
  select current_quantity into qty from public.ingredients where id = ids.cocoa_id;
  if qty <> 200 then raise exception 'TEST FAILED: rejected unreconciled purchase still mutated stock'; end if;

  -- A zero/negative purchase quantity or a negative cost is rejected outright.
  begin perform public.post_raw_purchase(gen_random_uuid(), ids.flour_id, 0, 'g', 0, 10, 'Local', 'SM', current_date, 5, 'x');
    raise exception 'TEST FAILED: zero-quantity purchase accepted'; exception when others then
      if sqlerrm like 'TEST FAILED:%' then raise; end if; end;
  begin perform public.post_raw_purchase(gen_random_uuid(), ids.flour_id, 10, 'g', 10, -1, 'Local', 'SM', current_date, 5, 'x');
    raise exception 'TEST FAILED: negative-cost purchase accepted'; exception when others then
      if sqlerrm like 'TEST FAILED:%' then raise; end if; end;
end;
$$;

-- ============================ confirm_purchase_import_v2 ============================
do $$
declare ids record; op1 uuid := gen_random_uuid();
  r1 jsonb; r2 jsonb; flour_qty numeric; flour_avg numeric; egg_qty numeric; import_status text;
  supply_count bigint; tx_count bigint;
begin
  select * into ids from wave0b_ids;

  -- Happy path: Flour +500g priced at 1000 (avg stays 2.0 -- the manual-purchase block above
  -- already moved Flour to 1600@2.0 via two purchases; this import adds another 500g@1000,
  -- landing at 2100@2.0), Egg +10pcs unpriced (dilutes quantity only, cost unchanged).
  r1 := public.confirm_purchase_import_v2(op1, ids.import_ok_id);
  select current_quantity, average_unit_cost into flour_qty, flour_avg from public.ingredients where id = ids.flour_id;
  select current_quantity into egg_qty from public.ingredients where id = ids.egg_id;
  select status into import_status from public.purchase_imports where id = ids.import_ok_id;
  if flour_qty <> 2100 or flour_avg <> 2.0 then raise exception 'TEST FAILED: wrong Flour result after CSV confirm (got % / %)', flour_qty, flour_avg; end if;
  if egg_qty <> 60 then raise exception 'TEST FAILED: wrong Egg quantity after CSV confirm (got %)', egg_qty; end if;
  if import_status <> 'confirmed' then raise exception 'TEST FAILED: import not marked confirmed'; end if;
  -- Filtered to this CSV import's own rows -- the earlier manual-purchase block already created
  -- its own supply_entries row for Flour, which must not be counted here.
  select count(*) into supply_count from public.supply_entries
    where ingredient_id in (ids.flour_id, ids.egg_id) and notes like 'Imported via CSV%';
  if supply_count <> 2 then raise exception 'TEST FAILED: expected one supply_entries row per applicable CSV row (got %)', supply_count; end if;

  -- Exact retry: replays the stored result, no second application.
  r2 := public.confirm_purchase_import_v2(op1, ids.import_ok_id);
  if r1 <> r2 then raise exception 'TEST FAILED: CSV confirm retry did not replay the stored result'; end if;
  select current_quantity into flour_qty from public.ingredients where id = ids.flour_id;
  if flour_qty <> 2100 then raise exception 'TEST FAILED: CSV confirm retry double-applied (qty %)', flour_qty; end if;

  -- A different operation id against the now-confirmed import (no receipt to replay against):
  -- rejected outright, not silently re-applied.
  begin
    perform public.confirm_purchase_import_v2(gen_random_uuid(), ids.import_ok_id);
    raise exception 'TEST FAILED: re-confirming an already-confirmed import (fresh operation id) was accepted';
  exception when serialization_failure then null; end;

  -- Reconciliation gate: the whole import is rejected because Cocoa has no verified opening count.
  begin
    perform public.confirm_purchase_import_v2(gen_random_uuid(), ids.import_gate_id);
    raise exception 'TEST FAILED: CSV confirm posted against an unreconciled Item';
  exception when check_violation then null; end;
  if (select current_quantity from public.ingredients where id = ids.cocoa_id) <> 200 then
    raise exception 'TEST FAILED: rejected CSV confirm still mutated Cocoa'; end if;
  if (select status from public.purchase_imports where id = ids.import_gate_id) <> 'draft' then
    raise exception 'TEST FAILED: rejected CSV confirm still marked the import confirmed'; end if;

  -- An unresolved (pending) row blocks the whole confirm -- nothing is applied.
  begin
    perform public.confirm_purchase_import_v2(gen_random_uuid(), ids.import_bad_row_id);
    raise exception 'TEST FAILED: CSV confirm posted with an unresolved row';
  exception when others then if sqlerrm like 'TEST FAILED:%' then raise; end if; end;
  if (select current_quantity from public.ingredients where id = ids.sugar_id) <> 300 then
    raise exception 'TEST FAILED: rejected CSV confirm with a bad row still mutated Sugar'; end if;

  -- Direct client write still cannot forge a confirmation -- the GUC-flag authorization only ever
  -- comes from inside confirm_purchase_import_v2 itself.
  begin
    update public.purchase_imports set status = 'confirmed' where id = ids.import_gate_id;
    raise exception 'TEST FAILED: direct status=confirmed update bypassed the posting guard';
  exception when insufficient_privilege then null; end;
end;
$$;

-- ================================== confirm_bake_v2 ==================================
do $$
declare ids record; op1 uuid := gen_random_uuid(); op2 uuid := gen_random_uuid();
  r1 jsonb; r2 jsonb; flour_qty numeric; egg_qty numeric; sugar_qty numeric; tx_count bigint;
begin
  select * into ids from wave0b_ids;

  -- Happy path: consume Flour and Egg together for one Bake.
  r1 := public.confirm_bake_v2(op1, 'batch-1', 'Test Brownie v1', 1, jsonb_build_array(
    jsonb_build_object('ingredient_id', ids.flour_id, 'quantity', 200),
    jsonb_build_object('ingredient_id', ids.egg_id, 'quantity', 4)
  ));
  select current_quantity into flour_qty from public.ingredients where id = ids.flour_id;
  select current_quantity into egg_qty from public.ingredients where id = ids.egg_id;
  if flour_qty <> 1900 or egg_qty <> 56 then raise exception 'TEST FAILED: wrong post-Bake quantities (Flour % / Egg %)', flour_qty, egg_qty; end if;

  -- Exact retry: replays the stored result, no second deduction.
  r2 := public.confirm_bake_v2(op1, 'batch-1', 'Test Brownie v1', 1, jsonb_build_array(
    jsonb_build_object('ingredient_id', ids.flour_id, 'quantity', 200),
    jsonb_build_object('ingredient_id', ids.egg_id, 'quantity', 4)
  ));
  if r1 <> r2 then raise exception 'TEST FAILED: Bake retry did not replay the stored result'; end if;
  select current_quantity into flour_qty from public.ingredients where id = ids.flour_id;
  if flour_qty <> 1900 then raise exception 'TEST FAILED: Bake retry double-deducted (Flour %)', flour_qty; end if;

  -- Changed payload, same operation id: rejected.
  begin
    perform public.confirm_bake_v2(op1, 'batch-1', 'Test Brownie v1', 2, jsonb_build_array(jsonb_build_object('ingredient_id', ids.flour_id, 'quantity', 200)));
    raise exception 'TEST FAILED: changed-payload Bake replay accepted';
  exception when check_violation then null; end;

  -- All-or-nothing: Sugar has only 300g, asking for 10000g must reject the WHOLE Bake -- Flour
  -- (which has plenty) must be untouched too.
  begin
    perform public.confirm_bake_v2(op2, 'batch-2', 'Test Brownie v2', 1, jsonb_build_array(
      jsonb_build_object('ingredient_id', ids.flour_id, 'quantity', 100),
      jsonb_build_object('ingredient_id', ids.sugar_id, 'quantity', 10000)
    ));
    raise exception 'TEST FAILED: insufficient-stock Bake was accepted';
  exception when check_violation then null; end;
  select current_quantity into flour_qty from public.ingredients where id = ids.flour_id;
  select current_quantity into sugar_qty from public.ingredients where id = ids.sugar_id;
  if flour_qty <> 1900 or sugar_qty <> 300 then
    raise exception 'TEST FAILED: rejected all-or-nothing Bake still mutated stock (Flour % / Sugar %)', flour_qty, sugar_qty; end if;

  -- Reconciliation gate: a Bake touching Cocoa (unreconciled) is rejected entirely.
  begin
    perform public.confirm_bake_v2(gen_random_uuid(), 'batch-3', 'Test Brownie v3', 1, jsonb_build_array(
      jsonb_build_object('ingredient_id', ids.flour_id, 'quantity', 10),
      jsonb_build_object('ingredient_id', ids.cocoa_id, 'quantity', 10)
    ));
    raise exception 'TEST FAILED: Bake posted against an unreconciled Item';
  exception when check_violation then null; end;
  if (select current_quantity from public.ingredients where id = ids.cocoa_id) <> 200 then
    raise exception 'TEST FAILED: rejected reconciliation-gated Bake still mutated Cocoa'; end if;

  -- Duplicate ingredient in one Bake's deduction list is rejected.
  begin
    perform public.confirm_bake_v2(gen_random_uuid(), 'batch-4', 'Test Brownie v4', 1, jsonb_build_array(
      jsonb_build_object('ingredient_id', ids.flour_id, 'quantity', 10),
      jsonb_build_object('ingredient_id', ids.flour_id, 'quantity', 20)
    ));
    raise exception 'TEST FAILED: duplicate-ingredient Bake accepted';
  exception when others then if sqlerrm like 'TEST FAILED:%' then raise; end if; end;

  -- An unknown ingredient id is rejected.
  begin
    perform public.confirm_bake_v2(gen_random_uuid(), 'batch-5', 'Test Brownie v5', 1, jsonb_build_array(
      jsonb_build_object('ingredient_id', gen_random_uuid(), 'quantity', 10)
    ));
    raise exception 'TEST FAILED: unknown-ingredient Bake accepted';
  exception when others then if sqlerrm like 'TEST FAILED:%' then raise; end if; end;
end;
$$;

-- =================== Wave 0A authority regression (no legacy bypass reopened) ===================
do $$
declare ids record;
begin
  select * into ids from wave0b_ids;
  begin update public.ingredients set current_quantity = 1 where id = ids.flour_id;
    raise exception 'TEST FAILED: direct quantity write accepted'; exception when insufficient_privilege then null; end;
  begin update public.ingredients set average_unit_cost = 1 where id = ids.flour_id;
    raise exception 'TEST FAILED: direct cost write accepted'; exception when insufficient_privilege then null; end;
  begin perform public.confirm_bake('[]', '[]');
    raise exception 'TEST FAILED: legacy confirm_bake still callable'; exception when insufficient_privilege then null; end;
  begin perform public.confirm_purchase_import(ids.import_ok_id, '[]', '[]');
    raise exception 'TEST FAILED: legacy confirm_purchase_import still callable'; exception when insufficient_privilege then null; end;
  begin perform public.save_supply_with_inventory_effect(gen_random_uuid(), true, '{}', null, null);
    raise exception 'TEST FAILED: legacy save_supply_with_inventory_effect still callable'; exception when insufficient_privilege then null; end;
  begin perform public.repair_supply_inventory_effects('[]', '[]');
    raise exception 'TEST FAILED: legacy repair_supply_inventory_effects still callable'; exception when insufficient_privilege then null; end;
  begin update public.ingredients set base_unit = 'ml' where id = ids.flour_id;
    raise exception 'TEST FAILED: base-unit guard no longer enforced'; exception when check_violation then null; end;
  -- Metadata edits and verified counts remain exactly as Wave 0A left them.
  update public.ingredients set notes = 'still editable' where id = ids.sugar_id;
  if not found then raise exception 'TEST FAILED: ordinary metadata edit stopped working'; end if;
  perform public.apply_raw_inventory_adjustment(ids.sugar_id, 300, 'count', 'stock_count_correction', 'still works', 300, null, 'g');
end;
$$;

reset role;
rollback;
select 'wave_0b_assertions_passed';
