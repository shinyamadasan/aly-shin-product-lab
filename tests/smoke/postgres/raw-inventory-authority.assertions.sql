-- Run only after the Wave 0A migration. All fixtures and injected failures roll back.
begin;
create temporary table wave0a_ids as select gen_random_uuid() as ingredient_id, gen_random_uuid() as old_id, gen_random_uuid() as import_id;
grant select on wave0a_ids to authenticated;
insert into public.ingredients(id,name,base_unit,current_quantity,average_unit_cost)
  select ingredient_id, 'Wave 0A test ' || ingredient_id, 'g',4000,0.075 from wave0a_ids;
insert into public.purchase_imports(id,file_name,status) select import_id,'Wave 0A test source','draft' from wave0a_ids;
insert into public.inventory_transactions(id,ingredient_id,transaction_type,quantity_change,quantity_before,quantity_after,source_type,source_id,note)
  select old_id,ingredient_id,'purchase',3000,0,3000,'purchase_import',import_id::text,'Historical discrepancy fixture' from wave0a_ids;
create temporary table wave0a_old_history as select t.* from public.inventory_transactions t join wave0a_ids x on t.id=x.old_id;
grant select on wave0a_old_history to authenticated;

set local role authenticated;
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',true);
select set_config('request.jwt.claim.app_role','owner',true);
select set_config('request.jwt.claims','{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated","app_metadata":{"app_role":"owner"}}',true);

do $$
declare i uuid; old_id uuid; movement uuid; reversed uuid; fresh uuid; snapshot jsonb; v numeric;
begin
  select ingredient_id,x.old_id into i,old_id from wave0a_ids x;
  -- Authority: actual attempted writes, not just inspection of GRANT statements.
  begin update public.ingredients set current_quantity=999 where id=i;
    raise exception 'TEST FAILED: direct quantity write accepted'; exception when insufficient_privilege then null; end;
  begin update public.ingredients set average_unit_cost=999 where id=i;
    raise exception 'TEST FAILED: direct cost write accepted'; exception when insufficient_privilege then null; end;
  begin update public.ingredients set inventory_reconciled_at=now() where id=i;
    raise exception 'TEST FAILED: direct opening claim accepted'; exception when insufficient_privilege then null; end;
  begin insert into public.ingredients(name,base_unit,current_quantity) values ('bad','g',999);
    raise exception 'TEST FAILED: direct opening quantity accepted'; exception when insufficient_privilege then null; end;
  begin update public.inventory_transactions set quantity_after=4000 where id=old_id;
    raise exception 'TEST FAILED: historical rewrite accepted'; exception when insufficient_privilege then null; end;
  begin delete from public.inventory_transactions where id=old_id;
    raise exception 'TEST FAILED: historical delete accepted'; exception when insufficient_privilege then null; end;
  begin insert into public.inventory_transactions(ingredient_id,transaction_type,quantity_change,quantity_before,quantity_after,source_type)
      values (i,'adjustment',100,4000,4100,'manual');
    raise exception 'TEST FAILED: direct ledger insert accepted'; exception when insufficient_privilege then null; end;
  begin perform public.confirm_bake('[]','[]');
    raise exception 'TEST FAILED: legacy Bake accepted'; exception when insufficient_privilege then null; end;
  begin update public.purchase_imports set file_name='Rewrite source' where id=(select import_id from wave0a_ids);
    raise exception 'TEST FAILED: posted source edited through draft status'; exception when raise_exception then
      if sqlerrm like 'TEST FAILED:%' then raise; end if; end;
  begin delete from public.purchase_imports where id=(select import_id from wave0a_ids);
    raise exception 'TEST FAILED: posted source deleted'; exception when raise_exception then
      if sqlerrm like 'TEST FAILED:%' then raise; end if; end;
  if has_table_privilege('authenticated','public.inventory_transactions','TRUNCATE')
    or has_table_privilege('anon','public.inventory_transactions','TRUNCATE') then
    raise exception 'TEST FAILED: truncate permission remains'; end if;
  if exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname in ('confirm_bake','confirm_purchase_import','save_supply_with_inventory_effect','delete_supply_with_inventory_effect','repair_supply_inventory_effects','apply_inventory_adjustment')
      and (has_function_privilege('authenticated',p.oid,'EXECUTE') or has_function_privilege('anon',p.oid,'EXECUTE'))) then
    raise exception 'TEST FAILED: legacy RPC overload remains executable'; end if;
  if has_table_privilege('authenticated','public.supply_entries','UPDATE')
    or has_table_privilege('authenticated','public.supply_entries','DELETE') then
    raise exception 'TEST FAILED: purchase history remains editable'; end if;

  fresh := gen_random_uuid();
  insert into public.ingredients(id,name,base_unit) values (fresh,'New test ingredient ' || fresh,'g');
  update public.ingredients set base_unit='ml',category='ingredient' where id=fresh;
  if (select current_quantity from public.ingredients where id=fresh)<>0 then
    raise exception 'TEST FAILED: new metadata item did not start at zero'; end if;
  begin perform public.apply_raw_inventory_adjustment(fresh,1,'delta','other','Unverified item',0,null,'ml');
    raise exception 'TEST FAILED: unverified item accepted ordinary movement'; exception when raise_exception then
      if sqlerrm like 'TEST FAILED:%' then raise; end if; end;
  perform public.apply_raw_inventory_adjustment(fresh,0,'count','stock_count_correction','Verified empty',0,null,'ml');
  if (select inventory_reconciled_at from public.ingredients where id=fresh) is null then
    raise exception 'TEST FAILED: verified zero count was lost'; end if;

  update public.ingredients set name = name || ' metadata', category='ingredient', notes='Metadata works' where id=i;
  if not found then raise exception 'TEST FAILED: owner metadata edit affected no row'; end if;
  begin update public.ingredients set base_unit='ml' where id=i;
    raise exception 'TEST FAILED: historical unit change accepted'; exception when check_violation then null; end;

  movement := public.apply_raw_inventory_adjustment(i,2700,'count','stock_count_correction','Verified test count',4000,old_id,'g');
  select current_quantity into v from public.ingredients where id=i;
  if v<>2700 then raise exception 'TEST FAILED: wrong reconciled quantity'; end if;
  select reconciliation_snapshot into snapshot from public.inventory_transactions where id=movement;
  if (snapshot->>'cache_quantity')::numeric<>4000 or (snapshot->>'latest_ledger_quantity')::numeric<>3000
     or (snapshot->>'verified_quantity')::numeric<>2700 then raise exception 'TEST FAILED: discrepancy not preserved'; end if;
  if (select to_jsonb(t) from public.inventory_transactions t where id=old_id)
      is distinct from (select to_jsonb(t) from wave0a_old_history t) then raise exception 'TEST FAILED: old history changed'; end if;
  begin perform public.apply_raw_inventory_adjustment(i,2800,'count','stock_count_correction','Stale count',4000,old_id,'g');
    raise exception 'TEST FAILED: stale count accepted'; exception when serialization_failure then null; end;
  begin perform public.apply_raw_inventory_adjustment(i,0,'reverse','other','Cannot undo opening',2700,movement,'g',movement);
    raise exception 'TEST FAILED: opening reversal accepted'; exception when raise_exception then
      if sqlerrm like 'TEST FAILED:%' then raise; end if; end;

  movement := public.apply_raw_inventory_adjustment(i,-200,'delta','household_use','Test usage',2700,movement,'g');
  select current_quantity into v from public.ingredients where id=i;
  if v<>2500 or (select quantity_after from public.inventory_transactions where id=movement)<>2500 then
    raise exception 'TEST FAILED: adjustment and cache disagree'; end if;
  reversed := public.apply_raw_inventory_adjustment(i,0,'reverse','other','Undo test usage',2500,movement,'g',movement);
  begin perform public.apply_raw_inventory_adjustment(i,0,'reverse','other','Second reversal',2700,reversed,'g',movement);
    raise exception 'TEST FAILED: duplicate reversal accepted'; exception when unique_violation then null; end;
  if (select average_unit_cost from public.ingredients where id=i)<>0.075 then raise exception 'TEST FAILED: cost changed'; end if;
  begin perform public.apply_raw_inventory_adjustment(i,-9999,'delta','other','Too much',2700,reversed,'g');
    raise exception 'TEST FAILED: negative stock accepted'; exception when raise_exception then
      if sqlerrm like 'TEST FAILED:%' then raise; end if; end;
end;
$$;

-- Reviewer regression: a physical count supersedes earlier ordinary adjustments.
do $$
declare i uuid := gen_random_uuid(); movement uuid; old_adjustment uuid; counted uuid;
  history_before jsonb; ingredient_before jsonb; reversed uuid;
begin
  insert into public.ingredients(id,name,base_unit) values(i,'Reversal boundary test ' || i,'g');
  movement := public.apply_raw_inventory_adjustment(i,2700,'count','stock_count_correction','Opening count',0,null,'g');
  old_adjustment := public.apply_raw_inventory_adjustment(i,-50,'delta','other','Before count',2700,movement,'g');
  if (select current_quantity from public.ingredients where id=i) <> 2650 then
    raise exception 'TEST FAILED: reviewer starting adjustment incorrect'; end if;
  counted := public.apply_raw_inventory_adjustment(i,2600,'count','stock_count_correction','Later physical count',2650,old_adjustment,'g');
  select jsonb_agg(to_jsonb(t) order by id) into history_before from public.inventory_transactions t where ingredient_id=i;
  select to_jsonb(t) into ingredient_before from public.ingredients t where id=i;
  begin
    perform public.apply_raw_inventory_adjustment(i,0,'reverse','other','Old adjustment reversal',2600,counted,'g',old_adjustment);
    raise exception 'TEST FAILED: reversal crossed later physical count';
  exception when check_violation then
    if sqlerrm <> 'This adjustment cannot be reversed because a later physical reconciliation superseded it.' then raise; end if;
  end;
  if (select current_quantity from public.ingredients where id=i) <> 2600
    or (select to_jsonb(t) from public.ingredients t where id=i) is distinct from ingredient_before
    or (select jsonb_agg(to_jsonb(t) order by id) from public.inventory_transactions t where ingredient_id=i) is distinct from history_before then
    raise exception 'TEST FAILED: rejected reversal changed balance or history'; end if;
  movement := public.apply_raw_inventory_adjustment(i,-25,'delta','other','After count',2600,counted,'g');
  reversed := public.apply_raw_inventory_adjustment(i,0,'reverse','other','Undo post-count adjustment',2575,movement,'g',movement);
  select jsonb_agg(to_jsonb(t) order by id) into history_before from public.inventory_transactions t where ingredient_id=i;
  begin
    perform public.apply_raw_inventory_adjustment(i,0,'reverse','other','Duplicate post-count reversal',2600,reversed,'g',movement);
    raise exception 'TEST FAILED: duplicate post-count reversal accepted';
  exception when unique_violation then null; end;
  if (select current_quantity from public.ingredients where id=i) <> 2600
    or (select jsonb_agg(to_jsonb(t) order by id) from public.inventory_transactions t where ingredient_id=i) is distinct from history_before then
    raise exception 'TEST FAILED: duplicate reversal changed balance or history'; end if;
end;
$$;

-- Non-owner authenticated calls must fail even through the privileged implementation.
select set_config('request.jwt.claim.app_role','viewer',true);
select set_config('request.jwt.claims','{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated","app_metadata":{"app_role":"viewer"}}',true);
do $$ begin
  perform public.apply_raw_inventory_adjustment((select ingredient_id from wave0a_ids),1,'count','stock_count_correction','Not authorized',2700,null,'g');
  raise exception 'TEST FAILED: non-owner adjustment accepted';
exception when insufficient_privilege then null; end; $$;
reset role;

-- Fail after ledger insertion, during cache update: the ledger insert must roll back too.
create function pg_temp.fail_wave0a_cache_update() returns trigger language plpgsql as $$
begin raise exception 'Injected cache update failure'; end; $$;
create trigger wave0a_injected_failure before update of current_quantity on public.ingredients
  for each row execute function pg_temp.fail_wave0a_cache_update();
set local role authenticated;
select set_config('request.jwt.claim.app_role','owner',true);
select set_config('request.jwt.claims','{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated","app_metadata":{"app_role":"owner"}}',true);
do $$
declare i uuid; latest_id uuid; before_count bigint;
begin
  select ingredient_id into i from wave0a_ids;
  select id into latest_id from public.inventory_transactions where ingredient_id=i order by created_at desc,id desc limit 1;
  select count(*) into before_count from public.inventory_transactions where ingredient_id=i;
  begin perform public.apply_raw_inventory_adjustment(i,-1,'delta','other','Must roll back',2700,latest_id,'g');
    raise exception 'TEST FAILED: injected failure did not fire';
  exception when raise_exception then if sqlerrm <> 'Injected cache update failure' then raise; end if; end;
  if (select current_quantity from public.ingredients where id=i)<>2700
    or (select count(*) from public.inventory_transactions where ingredient_id=i)<>before_count then
    raise exception 'TEST FAILED: partial adjustment persisted'; end if;
end;
$$;
reset role;
rollback;
select 'wave_0a_assertions_passed';
