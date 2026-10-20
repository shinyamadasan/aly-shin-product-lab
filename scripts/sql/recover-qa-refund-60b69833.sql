-- ONE-OFF, GUARDED RECOVERY: order 60b69833-5b47-4b86-b970-1477d7f1a1eb was refunded a SECOND time by an automated
-- production QA test on 2026-10-20 00:12:02Z (no money was returned). correct_mistaken_refund refuses a second
-- correction of the same order by design, so this restores the legitimate paid sale from a maintenance session
-- (no JWT, which the refund-reversal trigger deliberately allows) -- and records the incident immutably first.
--
-- Requires migration 20261020120000_order_payment_incident_events.sql.
--
-- Run as ONE statement (this whole file is a single DO block, so it is one atomic transaction): any failed guard
-- or any mismatch raises and rolls EVERYTHING back, including the audit event. It changes exactly one order row,
-- exactly three columns: payment_status (refunded -> paid), refunded_at (-> NULL) and updated_at (-> now). It does
-- not restore or invent any historical timestamp. paid_at, paid_amount, payment method, status, completed_at, the
-- order line, the stock allocation, finished-stock movements, ingredients and COGS are asserted unchanged.
--
-- The existing first-correction audit row (order_refund_corrections) is only READ, never modified.
--
-- IF IT ABORTS: nothing was written. Read the message. "another order changed" / "lines, stock, ledger..." means a live user
-- wrote to the business tables between the two fingerprints: simply run it again. Any other abort means the order is not in the
-- state this script was reviewed against: STOP and re-review, do not edit the constants to make it pass.
-- NOTICES: a Management API call may not return the success NOTICE; always run the verification SELECTs in
-- docs/REFUND_CORRECTION_RUNBOOK.md afterwards.
--
-- UNDO / RECOVERY: the incident event is immutable and stays by design. If it ever turns out money really was returned, record
-- the refund again through the normal Refund button in the app (a new refunded_at, today); never restore a historical timestamp.
do $recovery$
declare
  -- The exact expected current state. Anything else aborts.
  c_order       constant uuid        := '60b69833-5b47-4b86-b970-1477d7f1a1eb';
  c_refunded_at constant timestamptz := '2026-10-20 00:12:02.314+00';   -- the erroneous (second) refund
  c_paid_amount constant numeric     := 200;
  c_paid_at     constant timestamptz := '2026-10-19 15:49:46.017+00';
  c_completed   constant timestamptz := '2026-10-19 15:50:12.953756+00';
  c_first_refund constant timestamptz := '2026-10-19 15:49:48.394+00';  -- the first (corrected) refund, held in the audit row
  c_actor       constant text := 'Claude Code (AI assistant) running a maintenance session through the Supabase Management API; no application user session';
  c_authorizer  constant text := 'shinyamadasan (owner), written approval in the QA REFUND INCIDENT RECOVERY instruction of 2026-10-20';
  c_reason      constant text := 'Accidental second refund caused by automated production QA testing on October 20, 2026 UTC (a browser smoke test clicked Refund on the live app, which has no confirmation). No money was returned to the customer. Restoring the legitimate paid sale of PHP 200 for 2 Chocolate Walnut Cookies.';

  v_o        public.orders%rowtype;
  v_lines    text;
  v_after    public.orders%rowtype;
  v_prior    public.order_refund_corrections%rowtype;
  v_n        integer;
  v_others_before text; v_others_after text;
  v_side_before   text; v_side_after   text;
begin
  -- 1. Lock the order and require its EXACT current state.
  select * into v_o from public.orders where id = c_order for update;
  if not found then raise exception 'RECOVERY ABORTED: order not found'; end if;
  if v_o.status is distinct from 'completed' or v_o.completed_at is distinct from c_completed then
    raise exception 'RECOVERY ABORTED: order is not the expected completed order (status %, completed_at %)', v_o.status, v_o.completed_at;
  end if;
  if v_o.payment_status is distinct from 'refunded' then
    raise exception 'RECOVERY ABORTED: order is "%", not refunded (already recovered?)', v_o.payment_status;
  end if;
  if v_o.paid_amount is distinct from c_paid_amount or v_o.paid_at is distinct from c_paid_at then
    raise exception 'RECOVERY ABORTED: payment facts differ (paid_amount %, paid_at %)', v_o.paid_amount, v_o.paid_at;
  end if;
  if v_o.refunded_at is distinct from c_refunded_at or v_o.updated_at is distinct from c_refunded_at then
    raise exception 'RECOVERY ABORTED: refund timestamp differs (refunded_at %, updated_at %)', v_o.refunded_at, v_o.updated_at;
  end if;

  -- The reason below says what was sold, so the order's lines must really be that: one line, 2 x Chocolate Walnut Cookies at 100 (production names it 'Chocolate Walnut Cookies - 1 Cookie').
  select string_agg(item_name || ' x' || quantity || ' @' || unit_price, '; ') into v_lines from public.order_lines where order_id = c_order;
  if v_lines is null or v_lines not like 'Chocolate Walnut Cookies%x2 @100' or v_lines like '%;%' then
    raise exception 'RECOVERY ABORTED: the order lines are not 2 x Chocolate Walnut Cookies at 100 (found: %)', v_lines;
  end if;

  -- 2. The first correction must exist exactly as recorded, and must be preserved.
  select * into v_prior from public.order_refund_corrections where order_id = c_order;
  if not found then raise exception 'RECOVERY ABORTED: the first-correction audit row is missing'; end if;
  if v_prior.original_refunded_at is distinct from c_first_refund or v_prior.original_paid_amount is distinct from c_paid_amount
     or v_prior.original_payment_status is distinct from 'refunded' then
    raise exception 'RECOVERY ABORTED: the first-correction audit row does not describe the first refund';
  end if;
  if exists (select 1 from public.order_payment_incident_events where order_id = c_order and event_type = 'second_refund_reversed' and incident_refunded_at = c_refunded_at) then
    raise exception 'RECOVERY ABORTED: this incident is already recorded';
  end if;

  -- 3. Fingerprint everything that must NOT change, before.
  select md5(coalesce(string_agg(t::text, '|' order by t.id), '')) into v_others_before from public.orders t where t.id <> c_order;
  select md5(
    coalesce((select string_agg(t::text, '|' order by t::text) from public.order_lines t), '') ||
    coalesce((select string_agg(t::text, '|' order by t::text) from public.order_stock_allocations t), '') ||
    coalesce((select string_agg(t::text, '|' order by t::text) from public.finished_stock_movements t), '') ||
    coalesce((select string_agg(t::text, '|' order by t::text) from public.inventory_transactions t), '') ||
    coalesce((select string_agg(t::text, '|' order by t::text) from public.production_executions t), '') ||
    coalesce((select string_agg(t::text, '|' order by t::text) from public.ingredients t), '') ||
    coalesce((select string_agg(t::text, '|' order by t::text) from public.order_refund_corrections t), '')) into v_side_before;

  -- 4. Record the incident IMMUTABLY first (it is rolled back with everything else if any later guard fails).
  insert into public.order_payment_incident_events (
    order_id, event_type, recorded_by, authorized_by, reason, incident_refunded_at, order_status, payment_status_before,
    payment_method_before, paid_at_before, paid_amount_before, order_updated_at_before, prior_correction_id)
  values (c_order, 'second_refund_reversed', c_actor, c_authorizer, c_reason, v_o.refunded_at, v_o.status, v_o.payment_status,
    v_o.payment_method, v_o.paid_at, v_o.paid_amount, v_o.updated_at, v_prior.id);

  -- 5. The one intended change: three columns on one row.
  update public.orders
     set payment_status = 'paid', refunded_at = null, updated_at = clock_timestamp()
   where id = c_order and payment_status = 'refunded' and refunded_at = c_refunded_at;
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception 'RECOVERY ABORTED: expected to modify exactly 1 order, modified %', v_n; end if;

  -- 6. Verify, and abort (rolling everything back) on any mismatch.
  select * into v_after from public.orders where id = c_order;
  if v_after.payment_status is distinct from 'paid' or v_after.refunded_at is not null then
    raise exception 'RECOVERY ABORTED: order is not paid with no refund after the update';
  end if;
  if v_after.updated_at <= v_o.updated_at then raise exception 'RECOVERY ABORTED: updated_at did not move forward'; end if;
  if (to_jsonb(v_after) - 'payment_status' - 'refunded_at' - 'updated_at') is distinct from (to_jsonb(v_o) - 'payment_status' - 'refunded_at' - 'updated_at') then
    raise exception 'RECOVERY ABORTED: a column other than payment_status, refunded_at, updated_at changed';
  end if;
  select md5(coalesce(string_agg(t::text, '|' order by t.id), '')) into v_others_after from public.orders t where t.id <> c_order;
  if v_others_after is distinct from v_others_before then raise exception 'RECOVERY ABORTED: another order changed'; end if;
  select md5(
    coalesce((select string_agg(t::text, '|' order by t::text) from public.order_lines t), '') ||
    coalesce((select string_agg(t::text, '|' order by t::text) from public.order_stock_allocations t), '') ||
    coalesce((select string_agg(t::text, '|' order by t::text) from public.finished_stock_movements t), '') ||
    coalesce((select string_agg(t::text, '|' order by t::text) from public.inventory_transactions t), '') ||
    coalesce((select string_agg(t::text, '|' order by t::text) from public.production_executions t), '') ||
    coalesce((select string_agg(t::text, '|' order by t::text) from public.ingredients t), '') ||
    coalesce((select string_agg(t::text, '|' order by t::text) from public.order_refund_corrections t), '')) into v_side_after;
  if v_side_after is distinct from v_side_before then raise exception 'RECOVERY ABORTED: lines, stock, ledger, ingredients or the first-correction audit changed'; end if;
  if (select count(*) from public.order_payment_incident_events where order_id = c_order) <> 1 then
    raise exception 'RECOVERY ABORTED: expected exactly one incident event';
  end if;

  raise notice 'RECOVERY OK: order % is paid again; incident event recorded; nothing else changed', c_order;
end;
$recovery$;
