-- READ-ONLY postflight for supabase/migrations/20261027120000_order_fulfillment_expected_state_guard.sql
--
-- RUN IN THE SUPABASE SQL EDITOR (or psql -X) AFTER the migration transaction commits. SELECTs only.
-- Every row below must read `ok = t`. Any `f` means STOP: do not deploy the Worker; see the rollback
-- steps in the migration header. Expectations are pinned against a real database by
-- tests/smoke/postgres/selling-wave-2-order-reservation.smoke.test.ts.

with checks(check_name, ok) as (
  values
  -- The web app's entry point now delegates to the guard (md5 of its new one-line body).
  ('legacy body delegates to guard',
    (select md5(prosrc) = '90fa29932fe66108b0e50ef6008e9706' from pg_proc
      where oid = to_regprocedure('inventory_private.complete_order_with_fulfillment(uuid,uuid)'))),
  ('legacy public wrapper unchanged and executable by authenticated',
    has_function_privilege('authenticated', 'public.complete_order_with_fulfillment(uuid,uuid)', 'execute')),
  ('private guard exists, security definer, empty search_path',
    (select prosecdef and proconfig = array['search_path=""'] from pg_proc
      where oid = to_regprocedure('inventory_private.complete_order_with_fulfillment_checked(uuid,uuid,boolean,timestamptz,text,text,timestamptz,numeric,timestamptz)'))),
  ('public guard exists, security invoker, empty search_path',
    (select not prosecdef and proconfig = array['search_path=""'] from pg_proc
      where oid = to_regprocedure('public.complete_order_with_fulfillment_checked(uuid,uuid,timestamptz,text,text,timestamptz,numeric,timestamptz)'))),
  ('authenticated may execute public guard',
    has_function_privilege('authenticated', 'public.complete_order_with_fulfillment_checked(uuid,uuid,timestamptz,text,text,timestamptz,numeric,timestamptz)', 'execute')),
  ('anon may NOT execute public guard',
    not has_function_privilege('anon', 'public.complete_order_with_fulfillment_checked(uuid,uuid,timestamptz,text,text,timestamptz,numeric,timestamptz)', 'execute')),
  ('anon may NOT execute private guard',
    not has_function_privilege('anon', 'inventory_private.complete_order_with_fulfillment_checked(uuid,uuid,boolean,timestamptz,text,text,timestamptz,numeric,timestamptz)', 'execute')),
  ('exactly two checked functions exist',
    (select count(*) = 2 from pg_proc where proname = 'complete_order_with_fulfillment_checked')),
  ('no lot is negative',
    not exists (select 1 from public.finished_stock_movements where production_execution_id is not null
                group by production_execution_id having sum(on_hand_delta) < 0 or sum(reserved_delta) < 0))
)
select check_name, coalesce(ok, false) as ok from checks;

-- Migration history (Supabase-managed projects). Expect exactly one row once `migration repair` has
-- recorded the version; zero rows before that step. This query is separate because the table only
-- exists on Supabase.
-- select version from supabase_migrations.schema_migrations where version = '20261027120000';
