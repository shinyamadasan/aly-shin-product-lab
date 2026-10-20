-- Disposable fixtures only. Every fixture and mutation rolls back.
begin;
create function public.fr2_assert(p_condition boolean,p_message text) returns void language plpgsql as $$
begin if p_condition is not true then raise exception 'TEST FAILED: %',p_message; end if; end;
$$;
create function public.fr2_fails(p_sql text,p_state text) returns text language plpgsql as $$
begin execute p_sql; raise exception 'TEST FAILED: expected SQLSTATE %',p_state;
exception when others then
 if sqlerrm like 'TEST FAILED:%' then raise; end if;
 if sqlstate <> p_state then raise exception 'TEST FAILED: wanted %, got %: %',p_state,sqlstate,sqlerrm; end if;
 return sqlerrm;
end; $$;
grant execute on function public.fr2_assert(boolean,text),public.fr2_fails(text,text) to authenticated,anon;
create temporary table fr2_ids as select gen_random_uuid() as raw_id,gen_random_uuid() as unknown_id,gen_random_uuid() as legacy_id,gen_random_uuid() as equal_id,gen_random_uuid() as equal_movement;
grant select on fr2_ids to authenticated;
insert into public.ingredients(id,name,base_unit,current_quantity,average_unit_cost,inventory_reconciled_at,cost_reconciled_at)
 select raw_id,'FR2 flour','g',1000,0.5,clock_timestamp(),clock_timestamp() from fr2_ids
 union all select unknown_id,'FR2 unknown','g',100,0.75,clock_timestamp(),null from fr2_ids
 union all select legacy_id,'FR2 legacy','g',90,0.9,clock_timestamp(),clock_timestamp() from fr2_ids;
insert into public.ingredients(id,name,base_unit,current_quantity,average_unit_cost,inventory_reconciled_at,cost_reconciled_at)
 select equal_id,'FR2 equal boundary','g',99,0.5,'2026-10-01T01:00:00Z','2026-10-01T01:00:00Z' from fr2_ids;
insert into public.inventory_transactions(id,ingredient_id,transaction_type,quantity_change,quantity_before,quantity_after,source_type,reason,note,created_at,financial_classification,financial_unit_cost_snapshot)
 select equal_movement,equal_id,'adjustment',-1,100,99,'manual','spillage','equal fixture','2026-10-01T01:00:00Z','operating_loss',0.5 from fr2_ids;
insert into public.inventory_transactions(ingredient_id,transaction_type,quantity_change,quantity_before,quantity_after,source_type,reason,note,created_at)
 select legacy_id,'adjustment',-10,100,90,'manual','other','legacy ambiguous','2026-09-30T16:30:00Z' from fr2_ids;
create temporary table fr2_lots(product text,execution uuid,batch uuid);
grant select on fr2_lots to authenticated;
do $$ declare p text; b uuid; e uuid; begin
 foreach p in array array['fr2-main','fr2-count','fr2-direct','fr2-legacy','fr2-estimate','fr2-zero'] loop
  b:=gen_random_uuid(); e:=gen_random_uuid();
  insert into public.products(id,name) values(p,p);
  insert into public.product_batches(id,product_id,batch_version,status,usable_pieces) values(b,p,'v1','completed',10);
  insert into public.production_executions(id,product_id,product_batch_id,batch_version_snapshot,operation_id,multiplier,
    quantity_produced_pieces,expected_pieces,frozen_ingredient_cost_total,frozen_cost_per_piece,completed_at)
  values(e,p,b,'v1',gen_random_uuid(),1,10,10,120,12,'2026-10-01T01:00:00Z');
  insert into public.finished_stock_movements(product_id,production_execution_id,movement_type,on_hand_delta,reserved_delta,operation_id)
  values(p,e,'production_receipt',10,0,gen_random_uuid());
  insert into fr2_lots values(p,e,b);
 end loop;
 b:=gen_random_uuid(); e:=gen_random_uuid();
 insert into public.product_batches(id,product_id,batch_version,status,usable_pieces) values(b,'fr2-main','v2','completed',10);
 insert into public.production_executions(id,product_id,product_batch_id,batch_version_snapshot,operation_id,multiplier,
    quantity_produced_pieces,expected_pieces,frozen_ingredient_cost_total,frozen_cost_per_piece,completed_at)
 values(e,'fr2-main',b,'v2',gen_random_uuid(),1,10,10,200,20,'2026-10-02T01:00:00Z');
 insert into public.finished_stock_movements(product_id,production_execution_id,movement_type,on_hand_delta,reserved_delta,operation_id)
 values('fr2-main',e,'production_receipt',10,0,gen_random_uuid());
 insert into fr2_lots values('fr2-main',e,b);
end; $$;
update public.production_executions set source_type='opening_balance',cost_basis_source='historical_estimate',
 product_batch_id=null,batch_version_snapshot=null,cost_basis_snapshot='{"fixture":"historical estimate"}'::jsonb
 where product_id='fr2-estimate';
insert into public.finished_stock_movements(product_id,production_execution_id,movement_type,on_hand_delta,reserved_delta,operation_id,note)
 select 'fr2-legacy',execution,'giveaway',-1,0,gen_random_uuid(),'old ambiguous giveaway' from fr2_lots where product='fr2-legacy';
update public.production_executions set frozen_ingredient_cost_total=0,frozen_cost_per_piece=0 where product_id='fr2-zero';
insert into public.inventory_transactions(ingredient_id,transaction_type,quantity_change,quantity_before,quantity_after,source_type,note,created_at)
 select legacy_id,'waste',-1,91,90,'manual','old waste row','2026-09-01T00:00:00Z' from fr2_ids;
set local role authenticated;
select set_config('request.jwt.claim.sub','99999999-9999-4999-8999-999999999999',true);
select set_config('request.jwt.claim.app_role','owner',true);
select set_config('request.jwt.claims','{"sub":"99999999-9999-4999-8999-999999999999","role":"authenticated","app_metadata":{"app_role":"owner"}}',true);

do $$
declare i uuid; u uuid; legacy uuid; movement uuid; latest uuid; reversed uuid; review uuid; op uuid; result jsonb; before_state jsonb; equal_item uuid; equal_movement_id uuid;
begin
 select raw_id,unknown_id,legacy_id into i,u,legacy from fr2_ids;
 movement:=public.apply_raw_inventory_adjustment(i,-100,'delta','waste_or_spoilage','flour spoiled',1000,null,'g');
 perform public.fr2_assert((select amount=50 and quantity=100 and classification='operating_loss' from public.stock_financial_events where source_id=movement),'raw spoilage captured at trusted cost');
 perform public.post_raw_purchase(gen_random_uuid(),i,900,'g',900,900,'B','S',current_date,5,'new price');
 select id into latest from public.inventory_transactions where ingredient_id=i order by created_at desc,id desc limit 1;
 perform public.fr2_assert((select amount=50 from public.stock_financial_events where source_id=movement),'later average cannot reprice old raw loss');
 reversed:=public.apply_raw_inventory_adjustment(i,0,'reverse',null,'undo old loss',1800,latest,'g',movement);
 perform public.fr2_assert((select amount=-50 and quantity=-100 and classification='operating_loss' from public.stock_financial_events where source_id=reversed),'raw reversal negates original cost rather than current average');
 perform public.fr2_assert((select sum(amount)=0 from public.stock_financial_events where source_id in(movement,reversed)),'raw event and reversal net exactly once');
 op:=gen_random_uuid(); result:=public.classify_stock_financial_event(op,'raw',movement,'household',null,'Owner confirms personal use');
 review:=(result->>'review_id')::uuid;
 perform public.fr2_assert(public.classify_stock_financial_event(op,'raw',movement,'household',null,'Owner confirms personal use')=result,'review receipt retry unchanged');
 perform public.fr2_assert((select count(*)=2 and bool_and(classification='household' and review_id=review) from public.stock_financial_events where source_id in(movement,reversed)),'review inherited by reversal');
 perform public.fr2_fails(format('select public.classify_stock_financial_event(%L,''raw'',%L,''marketing'',null,''stale'')',gen_random_uuid(),movement),'PT409');
 perform public.fr2_fails(format('select public.classify_stock_financial_event(%L,''raw'',%L,''marketing'',%L,''changed'')',op,movement,review),'23514');
 perform public.fr2_assert((select count(*)=1 from public.stock_financial_event_reviews where source_id=movement),'failed review and retry append nothing');
 latest:=public.apply_raw_inventory_adjustment(u,-10,'delta','recipe_testing','test batter',100,null,'g');
 perform public.fr2_assert((select amount is null and classification='business_testing' from public.stock_financial_events where source_id=latest),'untrusted present price never invents event cost');
 reversed:=public.apply_raw_inventory_adjustment(u,0,'reverse',null,'undo test',90,latest,'g',latest);
 perform public.fr2_assert((select amount is null from public.stock_financial_events where source_id=reversed),'unknown reversal stays unknown');
 latest:=public.apply_raw_inventory_adjustment(u,10,'delta','household_use','unpriced addition',100,reversed,'g');
 perform public.fr2_assert((select amount is null and classification='unclassified' from public.stock_financial_events where source_id=latest),'positive additions never use prior average');
 select id into latest from public.inventory_transactions where ingredient_id=legacy and transaction_type='adjustment' order by created_at desc,id desc limit 1;
 perform public.fr2_assert((select amount is null and classification='unclassified' from public.stock_financial_events where source_id=latest),'legacy raw cost not backfilled');
 perform public.classify_stock_financial_event(gen_random_uuid(),'raw',latest,'household',null,'Owner identifies legacy usage');
 perform public.fr2_assert((select amount is null and classification='household' from public.stock_financial_events where source_id=latest),'review never fills unknown amount');
 reversed:=public.apply_raw_inventory_adjustment(legacy,80,'count',null,'found fewer',90,latest,'g');
 perform public.fr2_assert((select amount=9 and classification='unclassified' from public.stock_financial_events where source_id=reversed),'physical raw loss snapshots but remains unclassified');
 perform public.fr2_assert((select to_char(occurred_at at time zone 'Asia/Manila','YYYY-MM')='2026-10' from public.stock_financial_events where source_id=latest),'Manila month includes UTC September30 evening');
 perform public.fr2_assert((select count(*)=0 from public.stock_financial_events e join public.inventory_transactions t on e.source_id=t.id where t.transaction_type in('purchase','consume')),'purchases and Bake consumption excluded');
 perform public.fr2_assert((select count(*)=0 from public.business_expenses),'stock events never duplicate expense ledger');
 -- The final FR2 replacement must retain the separately restored exact raw count boundary.
 select equal_id,equal_movement into equal_item,equal_movement_id from fr2_ids;
 select jsonb_build_object('ingredient',(select to_jsonb(r) from public.ingredients r where id=equal_item),
   'ledger',(select jsonb_agg(to_jsonb(r) order by id) from public.inventory_transactions r where ingredient_id=equal_item)) into before_state;
 perform public.fr2_fails(format('select public.apply_raw_inventory_adjustment(%L,0,''reverse'',null,''equal count'',99,%L,''g'',%L)',equal_item,equal_movement_id,equal_movement_id),'23514');
 perform public.fr2_assert(before_state=(select jsonb_build_object('ingredient',(select to_jsonb(r) from public.ingredients r where id=equal_item),
   'ledger',(select jsonb_agg(to_jsonb(r) order by id) from public.inventory_transactions r where ingredient_id=equal_item))),'equal boundary rejection changes no raw stock, cost trust or ledger');
 select id into latest from public.inventory_transactions where ingredient_id=i order by created_at desc,id desc limit 1;
 movement:=public.apply_raw_inventory_adjustment(i,10,'delta','other','new unpriced units',1900,latest,'g');
 perform public.fr2_assert((select cost_reconciled_at is null from public.ingredients where id=i),'positive delta withdraws V4 cost trust after FR2');
 reversed:=public.apply_raw_inventory_adjustment(i,0,'reverse',null,'undo added units',1910,movement,'g',movement);
 perform public.fr2_assert((select current_quantity=1900 and cost_reconciled_at is null from public.ingredients where id=i),'reversing an increase does not invent restored cost trust');

end; $$;

do $$
declare op uuid; result jsonb; loss uuid; reversed uuid; exec uuid; orderid uuid; customer uuid; latest uuid; countop uuid; items jsonb;
begin
 op:=gen_random_uuid(); result:=public.record_finished_stock_exception(op,'fr2-main','damage',-12,null,'spoiled brownies');
 perform public.fr2_assert(jsonb_array_length(result->'movements')=2,'FIFO spans actual two lots');
 perform public.fr2_assert((select sum(amount)=160 and sum(quantity)=12 from public.stock_financial_events where source_id in(select id from public.finished_stock_movements where operation_id=op)),'10 at12 plus2 at20 is160, never sale price');
 perform public.fr2_assert(public.record_finished_stock_exception(op,'fr2-main','damage',-12,null,'spoiled brownies')=result,'finished idempotent retry does not deduct twice');
 select id,production_execution_id into loss,exec from public.finished_stock_movements where operation_id=op order by on_hand_delta limit 1;
 perform public.correct_bake_actual_pieces(gen_random_uuid(),exec,10,20,'Actual yield was20');
 perform public.fr2_assert((select sum(amount)=100 from public.stock_financial_events where source_id in(select id from public.finished_stock_movements where operation_id=op)),'Bake correction revalues allocated losses like sales COGS');
 result:=public.reverse_finished_stock_exception(gen_random_uuid(),loss,'incorrect spoiled count'); reversed:=(result->>'movement_id')::uuid;
 perform public.fr2_assert((select amount=-60 and quantity=-10 from public.stock_financial_events where source_id=reversed),'finished reversal restores exact first lot at effective cost');
 perform public.fr2_fails(format('select public.reverse_finished_stock_exception(%L,%L,''duplicate'')',gen_random_uuid(),loss),'23505');
 perform public.fr2_fails(format('select public.reverse_finished_stock_exception(%L,%L,''reverse reversal'')',gen_random_uuid(),reversed),'23514');
 perform public.fr2_fails(format('select public.reverse_finished_stock_exception(%L,%L,''legacy ambiguous'')',gen_random_uuid(),(select id from public.finished_stock_movements where product_id='fr2-legacy' and movement_type='giveaway')),'23514');
 perform public.fr2_assert((select classification='unclassified' from public.stock_financial_events where source_id=(select id from public.finished_stock_movements where product_id='fr2-legacy' and movement_type='giveaway')),'historical giveaway not automatically marketing');
 perform public.record_finished_stock_exception(gen_random_uuid(),'fr2-main','household',-1,null,'family');
 perform public.record_finished_stock_exception(gen_random_uuid(),'fr2-main','giveaway',-1,null,'promotion');
 perform public.record_finished_stock_exception(gen_random_uuid(),'fr2-estimate','damage',-1,null,'old stock');
 perform public.record_finished_stock_exception(gen_random_uuid(),'fr2-zero','damage',-1,null,'uncosted historical lot');
 perform public.fr2_assert((select amount is null from public.stock_financial_events where source_id=(select id from public.finished_stock_movements where product_id='fr2-zero' and movement_type='damage')),'historical zero cost is unvalued, never free');
 perform public.fr2_assert((select count(*)=1 and bool_and(amount is null and classification='unclassified') from public.stock_financial_events e join public.inventory_transactions t on e.source_id=t.id where t.transaction_type='waste'),'legacy manual waste remains visible for review');
 perform public.fr2_assert((select count(*)=1 from public.stock_financial_events where classification='household' and source_kind='finished'),'household is separate category');
 perform public.fr2_assert((select count(*)=1 from public.stock_financial_events where classification='marketing' and source_kind='finished'),'promotional samples classified');
 perform public.fr2_assert((select estimated and amount=12 from public.stock_financial_events where source_id=(select id from public.finished_stock_movements where product_id='fr2-estimate' and movement_type='damage')),'opening lot retains estimate disclosure');
 customer:=gen_random_uuid(); orderid:=gen_random_uuid();
 insert into public.customers(id,name) values(customer,'FR2 buyer');
 insert into public.orders(id,customer_id,status) values(orderid,customer,'new');
 insert into public.order_lines(id,order_id,product_id,item_name,unit_price,pieces_per_unit_snapshot,quantity)
 values(gen_random_uuid(),orderid,'fr2-main','brownies',999,1,1);
 perform public.confirm_order_with_reservation(gen_random_uuid(),orderid);
 perform public.complete_order_with_fulfillment(gen_random_uuid(),orderid);
 perform public.fr2_assert((select count(*)=0 from public.stock_financial_events e join public.finished_stock_movements m on e.source_id=m.id where m.order_id=orderid),'sale never counted as giveaway or spoilage');
 perform public.fr2_assert((select count(*)=1 from public.order_raw_cogs where order_id=orderid),'sales COGS preserved');
 perform public.record_finished_stock_exception(gen_random_uuid(),'fr2-count','damage',-1,null,'before exact count');
 select id into loss from public.finished_stock_movements where product_id='fr2-count' and movement_type='damage';
 select id into latest from public.finished_stock_movements where product_id='fr2-count' order by created_at desc,id desc limit 1;
 countop:=gen_random_uuid(); items:=jsonb_build_array(jsonb_build_object('product_id','fr2-count','physical_count',9,'expected_on_hand_pieces',9,'expected_reserved_pieces',0,'expected_latest_movement_id',latest));
 result:=public.apply_finished_stock_reconciliation_batch(countop,repeat('a',64),items);
 perform public.fr2_assert(result->0->>'action'='no_change','exact count no movement required');
 perform public.fr2_assert(public.apply_finished_stock_reconciliation_batch(countop,repeat('a',64),items)=result,'count replay idempotent');
 perform public.fr2_assert((select count(*)=1 from public.finished_stock_count_boundaries where product_id='fr2-count'),'no_change boundary written exactly once');
 perform public.fr2_fails(format('select public.reverse_finished_stock_exception(%L,%L,''after count'')',gen_random_uuid(),loss),'23514');
 perform public.record_finished_stock_exception(gen_random_uuid(),'fr2-count','household',-1,null,'after count');
 select id into loss from public.finished_stock_movements where product_id='fr2-count' and movement_type='household';
 perform public.reverse_finished_stock_exception(gen_random_uuid(),loss,'post-count allowed');
 perform public.record_finished_stock_exception(gen_random_uuid(),'fr2-direct','damage',-1,null,'before direct count');
 select id into loss from public.finished_stock_movements where product_id='fr2-direct' and movement_type='damage';
 perform public.record_finished_stock_exception(gen_random_uuid(),'fr2-direct','correction',-1,null,'found fewer');
 perform public.fr2_fails(format('select public.reverse_finished_stock_exception(%L,%L,''past direct count'')',gen_random_uuid(),loss),'23514');
 select id into loss from public.finished_stock_movements where product_id='fr2-direct' and movement_type='correction';
 perform public.fr2_fails(format('select public.reverse_finished_stock_exception(%L,%L,''undo count'')',gen_random_uuid(),loss),'23514');
end; $$;

do $$ declare t text; f record; begin
 perform public.fr2_assert((select 'security_invoker=true'=any(reloptions) from pg_class where oid='public.stock_financial_events'::regclass),'view honors underlying RLS');
 foreach t in array array['stock_financial_event_reviews','finished_stock_count_boundaries'] loop
  perform public.fr2_assert(not has_table_privilege('authenticated','public.'||t,'INSERT,UPDATE,DELETE,TRUNCATE'),'audit owner SELECT only');
  perform public.fr2_assert(not has_table_privilege('anon','public.'||t,'SELECT'),'anonymous audit access denied');
  perform public.fr2_assert(not has_table_privilege('service_role','public.'||t,'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES'),'service role has no audit write side door');
  perform public.fr2_assert((select relrowsecurity from pg_class where oid=('public.'||t)::regclass),'audit RLS enabled');
 end loop;
 for f in select p.oid,p.prosecdef,p.proconfig,n.nspname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where p.proname in('classify_stock_financial_event','reverse_finished_stock_exception') and n.nspname in('public','inventory_private') loop
  perform public.fr2_assert(not has_function_privilege('anon',f.oid,'EXECUTE'),'anon RPC denied');
  perform public.fr2_assert(has_function_privilege('authenticated',f.oid,'EXECUTE'),'authenticated RPC intent allowed');
  perform public.fr2_assert(f.prosecdef=(f.nspname='inventory_private'),'private definer public invoker');
  perform public.fr2_assert(f.proconfig=array['search_path=""'],'fixed empty search path');
 end loop;
 perform public.fr2_fails('update public.stock_financial_event_reviews set note=''rewrite''','42501');
 perform public.fr2_fails('delete from public.finished_stock_count_boundaries','42501');
end; $$;
select set_config('request.jwt.claim.app_role','viewer',true);
do $$ begin
 perform public.fr2_assert((select count(*)=0 from public.stock_financial_events),'nonowner cannot read events');
 perform public.fr2_assert((select count(*)=0 from public.stock_financial_event_reviews),'nonowner cannot read evidence');
 perform public.fr2_fails(format('select public.reverse_finished_stock_exception(%L,%L,''unauthorized'')',gen_random_uuid(),gen_random_uuid()),'42501');
 perform public.fr2_fails(format('select public.classify_stock_financial_event(%L,''raw'',%L,''household'',null,''unauthorized'')',gen_random_uuid(),gen_random_uuid()),'42501');
end; $$;
reset role;
create temporary table fr2_security_snapshot as select
 (select jsonb_agg(to_jsonb(r) order by id) from public.stock_financial_event_reviews r) as reviews,
 (select jsonb_agg(to_jsonb(b) order by id) from public.finished_stock_count_boundaries b) as boundaries,
 (select jsonb_agg(to_jsonb(e) order by id) from public.stock_financial_events e) as events;
set local role service_role;
select public.fr2_fails('insert into public.stock_financial_event_reviews(operation_id,source_kind,source_id,classification,note,actor) values(gen_random_uuid(),''raw'',gen_random_uuid(),''household'',''forged'',gen_random_uuid())','42501');
select public.fr2_fails('insert into public.finished_stock_count_boundaries(product_id,operation_id,reconciled_at) values(''fr2-count'',gen_random_uuid(),clock_timestamp())','42501');
reset role;
select public.fr2_assert(
 (select jsonb_agg(to_jsonb(r) order by id) from public.stock_financial_event_reviews r) = (select reviews from fr2_security_snapshot)
 and (select jsonb_agg(to_jsonb(b) order by id) from public.finished_stock_count_boundaries b) = (select boundaries from fr2_security_snapshot)
 and (select jsonb_agg(to_jsonb(e) order by id) from public.stock_financial_events e) = (select events from fr2_security_snapshot),
 'denied service-role forgeries preserve audit rows and effective event outputs');
select public.fr2_fails('update public.stock_financial_event_reviews set note=''rewrite''','42501');
select public.fr2_fails('delete from public.finished_stock_count_boundaries','42501');
select public.fr2_fails('truncate public.stock_financial_event_reviews','42501');
rollback;
select 'stock_financial_events_assertions_passed';
