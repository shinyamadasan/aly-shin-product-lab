-- Correct Mistaken Refund: single-shot invariants. One transaction, never committed.
-- Runs on a disposable Postgres with Waves 0A-3 and supabase-add-orders.sql applied, plus
-- 20261019120000_order_refund_correction.sql.
begin;

create function public.t_expect(p_sql text, p_state text, p_msg_like text)
returns void language plpgsql as $$
declare v_state text; v_msg text;
begin
  execute p_sql;
  raise exception 'TEST FAILED: should have been refused (wanted % / %): %', p_state, p_msg_like, p_sql;
exception when others then
  get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
  if v_msg like 'TEST FAILED%' then raise; end if;
  if v_state <> p_state or v_msg not like p_msg_like then
    raise exception 'TEST FAILED: refused with % / "%", wanted % / "%" for: %', v_state, v_msg, p_state, p_msg_like, p_sql;
  end if;
end;
$$;
grant execute on function public.t_expect(text, text, text) to authenticated, anon;

-- ---- Fixture (as the maintenance role: no JWT, so the refund-reversal trigger does not apply) ----------
insert into public.customers (id, name) values ('c0000000-0000-4000-8000-000000000001', 'Refund QA');

-- All start 'new'; a Wave 2 guard only lets its own functions move status, so announce like they do.
insert into public.orders (id, customer_id, status, payment_status, payment_method, paid_at, paid_amount, refunded_at) values
  ('a1000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000001', 'new', 'refunded', 'other', now() - interval '2 minutes', 200, now() - interval '2 minutes' + interval '2 seconds'), -- the real incident: refunded 2 s after payment
  ('a1000000-0000-4000-8000-000000000002', 'c0000000-0000-4000-8000-000000000001', 'new', 'refunded', 'gcash', now() - interval '1 day', 150, now() - interval '1 day' + interval '1 hour'),             -- cancelled: a genuine refund
  ('a1000000-0000-4000-8000-000000000003', 'c0000000-0000-4000-8000-000000000001', 'new', 'refunded', 'cash', now() - interval '9 days', 300, now() - interval '8 days'),                             -- refunded 8 days ago
  ('a1000000-0000-4000-8000-000000000004', 'c0000000-0000-4000-8000-000000000001', 'new', 'refunded', 'gcash', now() - interval '3 hours', 120, now() - interval '1 hour'),                          -- still open (never completed)
  ('a1000000-0000-4000-8000-000000000005', 'c0000000-0000-4000-8000-000000000001', 'new', 'paid', 'cash', now() - interval '1 hour', 90, null),                                                         -- completed and paid, never refunded
  ('a1000000-0000-4000-8000-000000000006', 'c0000000-0000-4000-8000-000000000001', 'new', 'unpaid', null, null, null, null),                                                                          -- completed, unpaid
  ('a1000000-0000-4000-8000-000000000007', 'c0000000-0000-4000-8000-000000000001', 'new', 'refunded', 'other', now() - interval '3 hours', 250, now() - interval '2 hours'),                         -- completed, for echo mismatches
  ('a1000000-0000-4000-8000-000000000008', 'c0000000-0000-4000-8000-000000000001', 'new', 'refunded', 'other', now() - interval '4 days', 400, now() - interval '3 days'),
  ('a1000000-0000-4000-8000-000000000009', 'c0000000-0000-4000-8000-000000000001', 'new', 'refunded', 'cash', now() - interval '2 hours', 60, now() - interval '1 hour');                              -- open, for the replay-under-another-timezone check                           -- completed, refunded 3 days ago
-- Lines first: they are immutable once an order is completed.
insert into public.order_lines (id, order_id, item_name, unit_price, quantity)
  select gen_random_uuid(), id, 'Chocolate Walnut Cookies', 100, 2 from public.orders where customer_id = 'c0000000-0000-4000-8000-000000000001';
select set_config('inventory_private.order_transition_authorized', 'true', true);
update public.orders set status = 'completed', completed_at = now() - interval '1 minute'
  where id in ('a1000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000003', 'a1000000-0000-4000-8000-000000000005',
               'a1000000-0000-4000-8000-000000000006', 'a1000000-0000-4000-8000-000000000007', 'a1000000-0000-4000-8000-000000000008');
update public.orders set status = 'cancelled', cancelled_at = now() - interval '1 hour' where id = 'a1000000-0000-4000-8000-000000000002';
select set_config('inventory_private.order_transition_authorized', 'false', true);

set local role authenticated;
select set_config('request.jwt.claim.sub', '44444444-4444-4444-8444-444444444444', true);
select set_config('request.jwt.claim.app_role', 'owner', true);
select set_config('request.jwt.claims', '{"sub":"44444444-4444-4444-8444-444444444444","role":"authenticated","app_metadata":{"app_role":"owner"}}', true);

do $$
declare
  o1 constant uuid := 'a1000000-0000-4000-8000-000000000001'; o2 constant uuid := 'a1000000-0000-4000-8000-000000000002';
  o3 constant uuid := 'a1000000-0000-4000-8000-000000000003'; o4 constant uuid := 'a1000000-0000-4000-8000-000000000004';
  o5 constant uuid := 'a1000000-0000-4000-8000-000000000005'; o6 constant uuid := 'a1000000-0000-4000-8000-000000000006';
  o7 constant uuid := 'a1000000-0000-4000-8000-000000000007'; o8 constant uuid := 'a1000000-0000-4000-8000-000000000008';
  o9 constant uuid := 'a1000000-0000-4000-8000-000000000009';
  before_row jsonb; after_row jsonb; r jsonb; r2 jsonb; op uuid := gen_random_uuid(); ts timestamptz; n integer;
  line_hash_before text; line_hash_after text; v_reason constant text := 'Refund button clicked by mistake; no money was returned';
begin
  -- ---- 1. The mistaken refund is corrected: paid again, refund gone from the active order, all else intact ----
  select to_jsonb(o) into before_row from public.orders o where id = o1;
  select md5(string_agg(l::text, '|' order by l.id)) into line_hash_before from public.order_lines l where order_id = o1;
  ts := (before_row->>'refunded_at')::timestamptz;
  r := public.correct_mistaken_refund(op, o1, v_reason, ts, 200);
  select to_jsonb(o) into after_row from public.orders o where id = o1;
  if after_row->>'payment_status' <> 'paid' or after_row->>'refunded_at' is not null then raise exception 'TEST FAILED: must be paid with no refund, got %', after_row; end if;
  if r is distinct from after_row then raise exception 'TEST FAILED: the function must return the corrected order'; end if;
  -- everything except the two corrected columns (and the version stamp) is byte-identical
  if (before_row - 'payment_status' - 'refunded_at' - 'updated_at') is distinct from (after_row - 'payment_status' - 'refunded_at' - 'updated_at') then
    raise exception 'TEST FAILED: only payment_status, refunded_at and updated_at may change. before % after %', before_row, after_row;
  end if;
  if after_row->>'status' <> 'completed' or after_row->>'completed_at' is distinct from before_row->>'completed_at' then raise exception 'TEST FAILED: the order must stay completed'; end if;
  if (after_row->>'paid_amount')::numeric <> 200 or after_row->>'paid_at' is distinct from before_row->>'paid_at' or after_row->>'payment_method' <> 'other' then
    raise exception 'TEST FAILED: the original payment facts must be preserved';
  end if;
  select md5(string_agg(l::text, '|' order by l.id)) into line_hash_after from public.order_lines l where order_id = o1;
  if line_hash_before is distinct from line_hash_after then raise exception 'TEST FAILED: order lines must not change'; end if;

  -- ---- 2. The audit row preserves the erased refund and the reason ----------------------------------------
  select count(*) into n from public.order_refund_corrections where order_id = o1
    and reason = v_reason and original_payment_status = 'refunded' and original_refunded_at = ts and original_paid_amount = 200
    and original_payment_method = 'other' and original_paid_at = (before_row->>'paid_at')::timestamptz and order_status = 'completed'
    and corrected_by = '44444444-4444-4444-8444-444444444444' and operation_id = op;
  if n <> 1 then raise exception 'TEST FAILED: the audit row must snapshot the original refund (got % matching rows)', n; end if;

  -- ---- 3. Idempotency and duplicate actions ------------------------------------------------------------------
  r2 := public.correct_mistaken_refund(op, o1, v_reason, ts, 200);
  if r2 is distinct from r then raise exception 'TEST FAILED: a retry must replay the stored result'; end if;
  select count(*) into n from public.order_refund_corrections where order_id = o1;
  if n <> 1 then raise exception 'TEST FAILED: a retry must not add an audit row (got %)', n; end if;
  perform public.t_expect(format('select public.correct_mistaken_refund(%L, %L, %L, %L, 200)', op, o1, 'A different reason entirely', ts), '23514', 'This operation id was already used%');
  perform public.t_expect(format('select public.correct_mistaken_refund(%L, %L, %L, %L, 200)', gen_random_uuid(), o1, v_reason, ts), '23514', 'This order is not marked refunded%');

  -- ---- 4. A genuinely NEW refund after the correction is possible; the order cannot then be corrected twice -----
  update public.orders set payment_status = 'refunded', refunded_at = clock_timestamp() where id = o1;  -- the normal refund path (paid -> refunded)
  select refunded_at into ts from public.orders where id = o1;
  perform public.t_expect(format('select public.correct_mistaken_refund(%L, %L, %L, %L, 200)', gen_random_uuid(), o1, v_reason, ts), '23514', '%already corrected once%');
  update public.orders set payment_status = 'refunded' where id = o1; -- no-op write keeps it refunded (allowed)

  -- ---- 5. Safeguards against reversing genuine refunds -------------------------------------------------------
  select refunded_at into ts from public.orders where id = o2;
  perform public.t_expect(format('select public.correct_mistaken_refund(%L, %L, %L, %L, 150)', gen_random_uuid(), o2, v_reason, ts), '23514', 'A refund on a cancelled order%');
  select refunded_at into ts from public.orders where id = o3;
  perform public.t_expect(format('select public.correct_mistaken_refund(%L, %L, %L, %L, 300)', gen_random_uuid(), o3, v_reason, ts), '23514', 'This refund is more than 7 days old%');
  select refunded_at into ts from public.orders where id = o7;
  perform public.t_expect(format('select public.correct_mistaken_refund(%L, %L, %L, %L, 249.99)', gen_random_uuid(), o7, v_reason, ts), '23514', 'The refund on screen no longer matches%');
  perform public.t_expect(format('select public.correct_mistaken_refund(%L, %L, %L, %L, 250)', gen_random_uuid(), o7, v_reason, ts + interval '1 second'), '23514', 'The refund on screen no longer matches%');
  perform public.t_expect(format('select public.correct_mistaken_refund(%L, %L, %L, %L, 250)', gen_random_uuid(), o5, v_reason, now()), '23514', 'This order is not marked refunded%');
  perform public.t_expect(format('select public.correct_mistaken_refund(%L, %L, %L, %L, 1)', gen_random_uuid(), o6, v_reason, now()), '23514', 'This order is not marked refunded%');
  perform public.t_expect(format('select public.correct_mistaken_refund(%L, %L, %L, %L, 250)', gen_random_uuid(), o7, 'too short', ts), '22023', 'Explain why%');
  perform public.t_expect(format('select public.correct_mistaken_refund(%L, %L, null, %L, 250)', gen_random_uuid(), o7, ts), '22023', 'Explain why%');
  perform public.t_expect(format('select public.correct_mistaken_refund(%L, %L, %L, %L, 250)', gen_random_uuid(), o7, E'										', ts), '22023', 'Explain why%');  -- ten tabs are not a reason
  perform public.t_expect(format('select public.correct_mistaken_refund(%L, %L, %L, %L, 250)', gen_random_uuid(), o7, repeat('x', 301), ts), '22023', 'Explain why%');
  perform public.t_expect(format('select public.correct_mistaken_refund(%L, %L, %L, null, 250)', gen_random_uuid(), o7, v_reason), '22023', 'The order, its refund time%');
  perform public.t_expect(format('select public.correct_mistaken_refund(%L, %L, %L, %L, 1)', gen_random_uuid(), gen_random_uuid(), v_reason, ts), '22023', 'Order not found%');
  perform public.t_expect(format('select public.correct_mistaken_refund(null, %L, %L, %L, 250)', o7, v_reason, ts), '22023', 'An operation id is required%');
  -- none of the refusals changed anything
  select count(*) into n from public.orders where id in (o2, o3, o7) and payment_status = 'refunded' and refunded_at is not null;
  if n <> 3 then raise exception 'TEST FAILED: a refused correction must leave the refund untouched (got %)', n; end if;
  select count(*) into n from public.order_refund_corrections;
  if n <> 1 then raise exception 'TEST FAILED: refusals must add no audit rows (got %)', n; end if;

  -- ---- 6. An open (never completed) prepaid order refunded by mistake can be corrected ------------------------
  select refunded_at into ts from public.orders where id = o4;
  r := public.correct_mistaken_refund(gen_random_uuid(), o4, v_reason, ts, 120);
  if r->>'payment_status' <> 'paid' or r->>'status' <> 'new' then raise exception 'TEST FAILED: open order must be paid and still open, got %', r; end if;

  -- ---- 6b. A retry of the same operation replays the same answer whatever the session TimeZone is -------------
  select refunded_at into ts from public.orders where id = o9;
  op := gen_random_uuid();
  set local timezone = 'UTC';
  r := public.correct_mistaken_refund(op, o9, v_reason, ts, 60);
  set local timezone = 'Asia/Manila';
  r2 := public.correct_mistaken_refund(op, o9, v_reason, ts, 60);
  set local timezone = 'UTC';
  if r2 is distinct from r then raise exception 'TEST FAILED: a replay under another TimeZone must return the first answer'; end if;

  -- ---- 7. No other client write can reverse a refund (the audit path is the only one) --------------------------
  perform public.t_expect(format('update public.orders set payment_status = ''paid'' where id = %L', o8), '42501', 'A refund cannot be reversed directly%');
  perform public.t_expect(format('update public.orders set payment_status = ''unpaid'', refunded_at = null where id = %L', o8), '42501', 'A refund cannot be reversed directly%');
  perform public.t_expect(format('update public.orders set payment_status = ''paid'', refunded_at = null, paid_amount = 1 where id = %L', o8), '42501', 'A refund cannot be reversed directly%');
  select count(*) into n from public.orders where id = o8 and payment_status = 'refunded';
  if n <> 1 then raise exception 'TEST FAILED: the refunded order must be unchanged'; end if;
  -- ...but ordinary writes are unaffected: a paid order can still be refunded, a refunded order can still be edited.
  update public.orders set payment_status = 'refunded', refunded_at = clock_timestamp() where id = o5;
  update public.orders set notes = 'edited while refunded' where id = o8;
  update public.orders set payment_status = 'refunded', refunded_at = refunded_at where id = o8;
  -- ...but the refund's own facts cannot be edited to make an old refund look new: the 7-day window trusts them.
  perform public.t_expect(format('update public.orders set refunded_at = now() where id = %L', o3), '42501', 'A recorded refund cannot be edited directly%');
  perform public.t_expect(format('update public.orders set paid_amount = 1 where id = %L', o3), '42501', 'A recorded refund cannot be edited directly%');
  select refunded_at into ts from public.orders where id = o3;
  perform public.t_expect(format('select public.correct_mistaken_refund(%L, %L, %L, %L, 300)', gen_random_uuid(), o3, v_reason, ts), '23514', 'This refund is more than 7 days old%');

  -- ---- 8. A refund a few days old (inside the window) still corrects, and what was edited meanwhile is kept ----
  select refunded_at into ts from public.orders where id = o8;
  r := public.correct_mistaken_refund(gen_random_uuid(), o8, v_reason, ts, 400);
  if r->>'payment_status' <> 'paid' or r->>'notes' <> 'edited while refunded' then raise exception 'TEST FAILED: corrected order wrong: %', r; end if;
end;
$$;

-- ---- 9. Non-owner sessions -------------------------------------------------------------------------------------
select set_config('request.jwt.claim.app_role', 'member', true);
select set_config('request.jwt.claims', '{"sub":"44444444-4444-4444-8444-444444444444","role":"authenticated","app_metadata":{"app_role":"member"}}', true);
do $$
declare n integer;
begin
  perform public.t_expect('select public.correct_mistaken_refund(gen_random_uuid(), ''a1000000-0000-4000-8000-000000000007'', ''Refund button clicked by mistake'', now(), 250)', '42501', 'Only the product lab owner%');
  select count(*) into n from public.order_refund_corrections;
  if n <> 0 then raise exception 'TEST FAILED: a non-owner must read zero audit rows (got %)', n; end if;
end;
$$;

-- ---- 10. Anonymous ----------------------------------------------------------------------------------------------
reset role;
set local role anon;
do $$
begin
  perform public.t_expect('select count(*) from public.order_refund_corrections', '42501', 'permission denied%');
  perform public.t_expect('select public.correct_mistaken_refund(gen_random_uuid(), gen_random_uuid(), ''Refund button clicked by mistake'', now(), 1)', '42501', 'permission denied%');
end;
$$;
reset role;

-- ---- 11. The audit table: no client writes; immutable even for the maintenance role -----------------------------
set local role authenticated;
select set_config('request.jwt.claim.app_role', 'owner', true);
select set_config('request.jwt.claims', '{"sub":"44444444-4444-4444-8444-444444444444","role":"authenticated","app_metadata":{"app_role":"owner"}}', true);
do $$
begin
  perform public.t_expect('insert into public.order_refund_corrections (operation_id, order_id, corrected_by, reason, order_status, original_payment_status, original_paid_at, original_paid_amount, original_refunded_at, original_order_updated_at) values (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), ''aaaaaaaaaaaa'', ''new'', ''refunded'', now(), 1, now(), now())', '42501', 'permission denied%');
  perform public.t_expect('update public.order_refund_corrections set reason = ''tampered tampered''', '42501', 'permission denied%');
  perform public.t_expect('delete from public.order_refund_corrections', '42501', 'permission denied%');
  perform public.t_expect('truncate public.order_refund_corrections', '42501', 'permission denied%');
end;
$$;
reset role;
set local role service_role;
do $$
begin
  perform public.t_expect('delete from public.order_refund_corrections', '42501', 'permission denied%');
  perform public.t_expect('update public.order_refund_corrections set reason = ''tampered tampered''', '42501', 'permission denied%');
end;
$$;
reset role;
select set_config('request.jwt.claim.sub', '', true);  -- a maintenance session carries no JWT
select set_config('request.jwt.claims', '', true);
do $$
begin
  perform public.t_expect('update public.order_refund_corrections set reason = ''tampered tampered''', '42501', 'The refund correction history is append-only%');
  perform public.t_expect('delete from public.order_refund_corrections', '42501', 'The refund correction history is append-only%');
  perform public.t_expect('truncate public.order_refund_corrections', '42501', 'The refund correction history is append-only%');
  -- the maintenance role (no JWT) is deliberately NOT blocked from reversing a refund, as with safe_delete_order,
  -- so owner recovery is never locked out; it is the only path besides the audited function.
  update public.orders set payment_status = 'paid', refunded_at = null where id = 'a1000000-0000-4000-8000-000000000007';
  if (select payment_status from public.orders where id = 'a1000000-0000-4000-8000-000000000007') <> 'paid' then raise exception 'TEST FAILED: maintenance recovery must remain possible'; end if;
end;
$$;

rollback;
select 'order_refund_correction_assertions_passed';
