-- Disposable adversarial fixtures only; all changes roll back.
begin;
create function pg_temp.assert(ok boolean, message text) returns void language plpgsql as $$
begin if ok is not true then raise exception 'TEST FAILED: %', message; end if; end; $$;
create temp table count_cases(name text, id uuid default gen_random_uuid(), changes jsonb);
insert into count_cases(name,changes) values
 ('valid','{}'),
 ('no snapshot','{"reconciliation_snapshot":null}'),
 ('wrong snapshot','{"reconciliation_snapshot":{"cache_quantity":0,"verified_quantity":404,"base_unit":"g"}}'),
 ('string snapshot','{"reconciliation_snapshot":{"cache_quantity":"0","verified_quantity":"405","base_unit":"g"}}'),
 ('wrong arithmetic','{"quantity_before":1}'),
 ('no reason','{"reason":null}'),
 ('ordinary positive','{"reason":"household_use","reconciliation_snapshot":null}'),
 ('waste','{"transaction_type":"waste"}'),
 ('not manual','{"source_type":"legacy"}'),
 ('explicit classification','{"financial_classification":"operating_loss"}'),
 ('negative count','{"quantity_change":-405,"quantity_before":405,"quantity_after":0,"reconciliation_snapshot":{"cache_quantity":405,"verified_quantity":0,"base_unit":"g"}}'),
 ('missing unit','{"reconciliation_snapshot":{"cache_quantity":0,"verified_quantity":405}}'),
 ('infinite','{"quantity_change":"Infinity","quantity_after":"Infinity"}');
insert into inventory_transactions
 select (jsonb_populate_record(null::inventory_transactions,
   to_jsonb(t) || c.changes || jsonb_build_object('id',c.id))).*
 from inventory_transactions t cross join count_cases c
 where t.id='9e3daa05-38a8-41de-98aa-57ffd45efaee';
select pg_temp.assert((select count(*)=1 and bool_and(c.name='valid')
 from count_cases c join stock_financial_events e on e.source_id=c.id
 where e.classification='stock_count_gain'), 'only complete original count evidence derives gain');

-- A positive linked reversal of a prior loss must retain its credit and original attribution.
insert into inventory_transactions(id,ingredient_id,transaction_type,quantity_before,quantity_after,quantity_change,source_type,reason,financial_classification,financial_unit_cost_snapshot)
 values('11111111-1111-4111-8111-111111111111','9e3daa05-38a8-41de-98aa-57ffd45efaee','adjustment',10,5,-5,'manual','waste_or_spoilage','operating_loss',2);
insert into inventory_transactions(ingredient_id,transaction_type,quantity_before,quantity_after,quantity_change,source_type,source_id,reason,financial_classification,financial_unit_cost_snapshot)
 values('9e3daa05-38a8-41de-98aa-57ffd45efaee','adjustment',5,10,5,'manual','11111111-1111-4111-8111-111111111111','waste_or_spoilage','operating_loss',2);
select pg_temp.assert((select count(*)=2 and sum(amount)=0 and bool_and(classification='operating_loss')
 from stock_financial_events where source_id in (select id from inventory_transactions
 where id='11111111-1111-4111-8111-111111111111' or source_id='11111111-1111-4111-8111-111111111111')), 'loss and reversal cancel exactly once');

-- Existing owner review remains effective; the hotfix cannot erase audit evidence.
set local role authenticated;
select set_config('request.jwt.claim.sub','99999999-9999-4999-8999-999999999999',true);
select set_config('request.jwt.claim.app_role','owner',true);
select public.classify_stock_financial_event(gen_random_uuid(),'raw','9e3daa05-38a8-41de-98aa-57ffd45efaee','household',null,'Disposable explicit review precedence');
reset role;
select pg_temp.assert((select classification='household' and review_id is not null and amount is null
 from stock_financial_events where source_id='9e3daa05-38a8-41de-98aa-57ffd45efaee'), 'explicit review and unknown valuation preserved');
select pg_temp.assert((select quantity_before=0 and quantity_after=405 and quantity_change=405 and financial_classification is null
 from inventory_transactions where id='9e3daa05-38a8-41de-98aa-57ffd45efaee'), 'review and reporting never change original count');
rollback;
