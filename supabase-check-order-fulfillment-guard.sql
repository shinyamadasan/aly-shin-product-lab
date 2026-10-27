-- READ-ONLY preflight for supabase/migrations/20261027120000_order_fulfillment_expected_state_guard.sql
--
-- RUN IN THE SUPABASE SQL EDITOR (Dashboard -> SQL Editor). OWNER EXECUTION ONLY.
-- Same convention as the other supabase-check-*.sql files: SELECTs only. Running it changes nothing.
--
-- Run it BEFORE applying the guard migration, and keep the output with the approval record.

-- 1. The live fulfillment function must still be exactly Selling Wave 2's definition.
--    Expected: guard_installed = false, wave2_body_md5 = 'f11078872e13ecc80cb6c0b571fdc11d'
--    (md5 of the LF-terminated body in 20260910181827_selling_wave_2_order_reservation.sql, pinned by
--    tests/smoke/postgres/selling-wave-2-order-reservation.smoke.test.ts). A different md5 means the
--    live body differs -- possibly only by line endings if it was pasted into the SQL editor. STOP and
--    compare `wave2_body` with section 7 of that migration before applying anything.
select
  exists (select 1 from pg_proc g join pg_namespace n on n.oid = g.pronamespace
          where g.proname = 'complete_order_with_fulfillment_checked' and n.nspname = 'inventory_private') as guard_installed,
  md5(p.prosrc) as wave2_body_md5,
  p.prosecdef as security_definer,
  p.prosrc as wave2_body
from pg_proc p
where p.oid = to_regprocedure('inventory_private.complete_order_with_fulfillment(uuid,uuid)');

-- 2. Callers keep the same grants: authenticated may execute the public wrapper; anon may not.
--    Expected: t, f.
select
  has_function_privilege('authenticated', 'public.complete_order_with_fulfillment(uuid,uuid)', 'execute') as authenticated_can_complete,
  has_function_privilege('anon', 'public.complete_order_with_fulfillment(uuid,uuid)', 'execute') as anon_can_complete;

-- 3. Open orders the guard would REFUSE to complete, because a reserved lot no longer holds the
--    on-hand or reserved pieces the order would fulfil. Today these would complete into a negative lot.
--    Expected: zero rows. Any row is a stock-record problem to investigate before (or regardless of)
--    applying the guard; the guard itself changes no data.
select o.id as order_id, o.status, need.production_execution_id, need.pieces as pieces_to_fulfil,
       coalesce(lot.on_hand, 0) as lot_on_hand, coalesce(lot.reserved, 0) as lot_reserved
from public.orders o
join (
  select a.order_id, a.production_execution_id, sum(a.reserved_pieces) as pieces
  from public.order_stock_allocations a
  where a.status = 'active'
  group by a.order_id, a.production_execution_id
) need on need.order_id = o.id
left join (
  select production_execution_id, sum(on_hand_delta) as on_hand, sum(reserved_delta) as reserved
  from public.finished_stock_movements
  group by production_execution_id
) lot on lot.production_execution_id = need.production_execution_id
where o.status in ('confirmed', 'ready')
  and (coalesce(lot.on_hand, 0) < need.pieces or coalesce(lot.reserved, 0) < need.pieces)
order by o.id, need.production_execution_id;

-- 4. Any lot that is ALREADY negative (pre-existing damage this guard cannot undo). Expected: zero rows.
select production_execution_id, sum(on_hand_delta) as on_hand, sum(reserved_delta) as reserved
from public.finished_stock_movements
where production_execution_id is not null
group by production_execution_id
having sum(on_hand_delta) < 0 or sum(reserved_delta) < 0
order by production_execution_id;
