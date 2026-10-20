-- Business expense ledger single-shot invariants. Everything here rolls back -- one transaction,
-- never committed. Runs on a disposable Postgres with Wave 0A/0B applied (for the real
-- claim_mutation) and 20261016120000_business_expenses.sql on top.
begin;

-- Asserts a statement is refused with the given SQLSTATE and message pattern. The failing statement
-- runs in a sub-block, so any claim_mutation receipt it wrote rolls back with it.
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

set local role authenticated;
select set_config('request.jwt.claim.sub', '99999999-9999-4999-8999-999999999999', true);
select set_config('request.jwt.claim.app_role', 'owner', true);
select set_config('request.jwt.claims', '{"sub":"99999999-9999-4999-8999-999999999999","role":"authenticated","app_metadata":{"app_role":"owner"}}', true);

do $$
declare
  op1 uuid := gen_random_uuid(); op2 uuid := gen_random_uuid(); op3 uuid := gen_random_uuid(); op4 uuid; op5 uuid;
  v_today date := (clock_timestamp() at time zone 'Asia/Manila')::date;
  r jsonb; r2 jsonb; r3 jsonb; rn jsonb; rn2 jsonb; v_id uuid; n integer; v_sum numeric;
  e_rent uuid; e_util uuid; e_new uuid;
begin
  -- ---- 1. Record: stored exactly, attributed to the caller, live (not void) ---------------------
  r := public.record_business_expense(op1, v_today, 'rent', 1500.00, '  Landlord  ', 'October rent', 'bank_transfer', 'REF-1', false);
  e_rent := (r->>'id')::uuid;
  if (r->>'amount')::numeric <> 1500.00 or r->>'payee' <> 'Landlord' or r->>'category' <> 'rent' then
    raise exception 'TEST FAILED: recorded row not as submitted: %', r;
  end if;
  if r->>'voided_at' is not null then raise exception 'TEST FAILED: a new expense must be live'; end if;
  if (r->>'recorded_by')::uuid <> '99999999-9999-4999-8999-999999999999' then raise exception 'TEST FAILED: recorded_by must be the caller'; end if;
  if (r->>'operation_id')::uuid <> op1 then raise exception 'TEST FAILED: operation_id must be stored'; end if;

  -- ---- 1b. The call shape PostgREST (and so the app) uses: every argument by NAME -----------------
  -- The repository sends exactly these keys; a renamed SQL parameter would break the app silently.
  rn := public.record_business_expense(p_operation_id := gen_random_uuid(), p_expense_date := v_today, p_category := 'software',
    p_amount := 12.50, p_payee := 'Named args', p_description := null, p_payment_method := 'gcash', p_payment_reference := null,
    p_confirm_possible_duplicate := false);
  rn2 := public.correct_business_expense(p_operation_id := gen_random_uuid(), p_expense_id := (rn->>'id')::uuid, p_expense_date := v_today,
    p_category := 'software', p_amount := 13.00, p_payee := 'Named args', p_description := null, p_payment_method := null,
    p_payment_reference := null, p_reason := 'named correction');
  perform public.void_business_expense(p_operation_id := gen_random_uuid(), p_expense_id := (rn2->>'id')::uuid, p_reason := 'named void');
  if (select count(*) from public.business_expenses where payee = 'Named args' and voided_at is null) <> 0 then
    raise exception 'TEST FAILED: the named-argument calls must have recorded, corrected and voided';
  end if;

  -- ---- 2. Idempotency: same id + same request replays, adds nothing -----------------------------
  r2 := public.record_business_expense(op1, v_today, 'rent', 1500.00, 'Landlord', 'October rent', 'bank_transfer', 'REF-1', false);
  if r2 is distinct from r then raise exception 'TEST FAILED: a retry must replay the stored result, got %', r2; end if;
  select count(*) into n from public.business_expenses where operation_id = op1;
  if n <> 1 then raise exception 'TEST FAILED: a retry must not create a second row (got %)', n; end if;
  -- The confirm flag is not part of the request's identity: a retry that also confirms still replays.
  r2 := public.record_business_expense(op1, v_today, 'rent', 1500.00, 'Landlord', 'October rent', 'bank_transfer', 'REF-1', true);
  if r2 is distinct from r then raise exception 'TEST FAILED: a retry with the confirm flag must still replay'; end if;
  -- Same id, different request: refused, not replayed and not applied.
  perform public.t_expect(format('select public.record_business_expense(%L, %L, ''rent'', 9999, ''Landlord'', null, null, null, false)', op1, v_today),
    '23514', 'This operation id was already used%');

  -- ---- 3. Duplicate warning: refused, claim rolled back, then allowed once confirmed ------------
  perform public.t_expect(format('select public.record_business_expense(%L, %L, ''rent'', 1500.00, ''LANDLORD'', null, null, null, false)', op2, v_today),
    '23505', 'POSSIBLE_DUPLICATE%');
  -- The refusal raised, so its claim rolled back: the SAME operation id is still free, and using it
  -- for the confirmed retry succeeds (a leaked claim would fail here with 55P03).
  r3 := public.record_business_expense(op2, v_today, 'rent', 1500.00, 'LANDLORD', null, null, null, true);
  if r3->>'id' = r->>'id' then raise exception 'TEST FAILED: the confirmed duplicate is its own row'; end if;
  -- A different amount, date or payee is not a duplicate.
  perform public.record_business_expense(gen_random_uuid(), v_today, 'rent', 1500.01, 'Landlord', null, null, null, false);
  perform public.record_business_expense(gen_random_uuid(), v_today - 1, 'rent', 1500.00, 'Landlord', null, null, null, false);
  perform public.record_business_expense(gen_random_uuid(), v_today, 'rent', 1500.00, 'Other Landlord', null, null, null, false);

  -- ---- 4. Validation: inventory purchases can never be an expense; bad money is refused -----------
  perform public.t_expect(format('select public.record_business_expense(%L, %L, ''ingredients'', 10, ''X'', null, null, null, false)', gen_random_uuid(), v_today), '22023', 'Choose an expense category%');
  perform public.t_expect(format('select public.record_business_expense(%L, %L, ''packaging'', 10, ''X'', null, null, null, false)', gen_random_uuid(), v_today), '22023', 'Choose an expense category%');
  perform public.t_expect(format('select public.record_business_expense(%L, %L, ''inventory'', 10, ''X'', null, null, null, false)', gen_random_uuid(), v_today), '22023', 'Choose an expense category%');
  perform public.t_expect(format('select public.record_business_expense(%L, %L, null, 10, ''X'', null, null, null, false)', gen_random_uuid(), v_today), '22023', 'Choose an expense category%');
  perform public.t_expect(format('select public.record_business_expense(%L, %L, ''rent'', 0, ''X'', null, null, null, false)', gen_random_uuid(), v_today), '22023', 'The amount must be%');
  perform public.t_expect(format('select public.record_business_expense(%L, %L, ''rent'', -5, ''X'', null, null, null, false)', gen_random_uuid(), v_today), '22023', 'The amount must be%');
  perform public.t_expect(format('select public.record_business_expense(%L, %L, ''rent'', 10.005, ''X'', null, null, null, false)', gen_random_uuid(), v_today), '22023', 'The amount must be%');
  perform public.t_expect(format('select public.record_business_expense(%L, %L, ''rent'', ''NaN''::numeric, ''X'', null, null, null, false)', gen_random_uuid(), v_today), '22023', 'The amount must be%');
  perform public.t_expect(format('select public.record_business_expense(%L, %L, ''rent'', null, ''X'', null, null, null, false)', gen_random_uuid(), v_today), '22023', 'The amount must be%');
  perform public.t_expect(format('select public.record_business_expense(%L, %L, ''rent'', 10, ''   '', null, null, null, false)', gen_random_uuid(), v_today), '22023', 'Enter who was paid%');
  perform public.t_expect(format('select public.record_business_expense(%L, %L, ''rent'', 10, %L, null, null, null, false)', gen_random_uuid(), v_today, repeat('x', 121)), '22023', 'Enter who was paid%');
  perform public.t_expect(format('select public.record_business_expense(%L, %L, ''rent'', 10, ''X'', null, null, null, false)', gen_random_uuid(), v_today + 2), '22023', 'An expense cannot be dated in the future%');
  perform public.t_expect('select public.record_business_expense(gen_random_uuid(), null, ''rent'', 10, ''X'', null, null, null, false)', '22023', 'An expense date is required%');
  perform public.t_expect('select public.record_business_expense(null, current_date, ''rent'', 10, ''X'', null, null, null, false)', '22023', 'An operation id is required%');
  -- The table's own CHECKs back the function up (defence in depth): proven as the table owner below.

  -- ---- 4b. Findings from the independent security review ------------------------------------------
  -- Unvalidated values used to fall through to table CHECKs and surface as the wrong error class.
  perform public.t_expect(format('select public.record_business_expense(%L, %L, ''rent'', 10, ''X'', null, ''bitcoin'', null, false)', gen_random_uuid(), v_today), '22023', 'Choose cash, gcash%');
  perform public.t_expect(format('select public.record_business_expense(%L, ''1999-12-31'', ''rent'', 10, ''X'', null, null, null, false)', gen_random_uuid()), '22023', 'The expense date is not valid%');
  perform public.t_expect(format('select public.record_business_expense(%L, %L, ''rent'', 10, ''X'', %L, null, null, false)', gen_random_uuid(), v_today, repeat('n', 501)), '22023', 'The note%too long%');
  perform public.t_expect(format('select public.record_business_expense(%L, %L, ''rent'', 10, ''X'', null, null, %L, false)', gen_random_uuid(), v_today, repeat('r', 121)), '22023', 'The note%too long%');
  perform public.t_expect(format('select public.correct_business_expense(%L, %L, %L, ''rent'', 10, ''X'', null, ''bitcoin'', null, ''x'')', gen_random_uuid(), gen_random_uuid(), v_today), '22023', 'Choose cash, gcash%');
  -- A delimiter-joined hash let (payee 'A|B', note '') collide with (payee 'A', note 'B|'). A JSON hash does not.
  op4 := gen_random_uuid();
  perform public.record_business_expense(op4, v_today - 6, 'other', 5, 'A|B', '', null, null, false);
  perform public.t_expect(format('select public.record_business_expense(%L, %L, ''other'', 5, ''A'', ''B|'', null, null, false)', op4, v_today - 6), '23514', 'This operation id was already used%');
  -- ...while the SAME intent typed as 10 or 10.00 is one intent, not "different details".
  op5 := gen_random_uuid();
  rn := public.record_business_expense(op5, v_today - 7, 'other', 10, 'Scale', null, null, null, false);
  rn2 := public.record_business_expense(op5, v_today - 7, 'other', 10.00, 'Scale', null, null, null, false);
  if rn2 is distinct from rn then raise exception 'TEST FAILED: 10 and 10.00 must replay as the same request'; end if;

  -- ---- 5. Centavo exactness: no rounding drift in a sum ------------------------------------------
  perform public.record_business_expense(gen_random_uuid(), v_today - 3, 'fees', 0.10, 'Fee A', null, null, null, false);
  perform public.record_business_expense(gen_random_uuid(), v_today - 3, 'fees', 0.20, 'Fee B', null, null, null, false);
  perform public.record_business_expense(gen_random_uuid(), v_today - 3, 'fees', 0.30, 'Fee C', null, null, null, false);
  select sum(amount) into v_sum from public.business_expenses where category = 'fees' and voided_at is null;
  if v_sum <> 0.60 then raise exception 'TEST FAILED: 0.10 + 0.20 + 0.30 must be exactly 0.60, got %', v_sum; end if;

  -- ---- 6. Void: the row stays, stops counting, needs a reason, cannot repeat --------------------
  r := public.record_business_expense(gen_random_uuid(), v_today, 'delivery', 250.00, 'Rider', null, 'cash', null, false);
  v_id := (r->>'id')::uuid;
  perform public.t_expect(format('select public.void_business_expense(%L, %L, ''   '')', gen_random_uuid(), v_id), '22023', 'Say why this expense is being voided%');
  perform public.t_expect(format('select public.void_business_expense(%L, %L, ''x'')', gen_random_uuid(), gen_random_uuid()), '22023', 'Expense not found%');
  r2 := public.void_business_expense(op3, v_id, 'Entered twice');
  if r2->>'voided_at' is null or r2->>'void_reason' <> 'Entered twice' or (r2->>'voided_by')::uuid <> '99999999-9999-4999-8999-999999999999' then
    raise exception 'TEST FAILED: void must record when, who and why: %', r2;
  end if;
  if (select amount from public.business_expenses where id = v_id) <> 250.00 then raise exception 'TEST FAILED: voiding must not alter the original amount'; end if;
  if not exists (select 1 from public.business_expenses where id = v_id) then raise exception 'TEST FAILED: a voided expense must still exist'; end if;
  if public.void_business_expense(op3, v_id, 'Entered twice') is distinct from r2 then raise exception 'TEST FAILED: a void retry must replay'; end if;
  perform public.t_expect(format('select public.void_business_expense(%L, %L, ''again'')', gen_random_uuid(), v_id), '23514', 'This expense is already void%');
  select count(*) into n from public.business_expenses where category = 'delivery' and voided_at is null;
  if n <> 0 then raise exception 'TEST FAILED: a voided expense must not count as live (got %)', n; end if;

  -- ---- 7. Correct: original voided, replacement appended and linked, atomically ------------------
  r := public.record_business_expense(gen_random_uuid(), v_today, 'utilities', 900.00, 'Meralco', null, null, null, false);
  e_util := (r->>'id')::uuid;
  op3 := gen_random_uuid();
  r2 := public.correct_business_expense(op3, e_util, v_today, 'utilities', 950.50, 'Meralco', 'Typo fixed', 'gcash', null, 'Misread the bill');
  e_new := (r2->>'id')::uuid;
  if e_new = e_util or (r2->>'corrects_expense_id')::uuid <> e_util or (r2->>'amount')::numeric <> 950.50 then
    raise exception 'TEST FAILED: the replacement must be a new row pointing at the original: %', r2;
  end if;
  if (select void_reason from public.business_expenses where id = e_util) <> 'Corrected: Misread the bill' then
    raise exception 'TEST FAILED: the original must be voided with the correction reason';
  end if;
  if (select amount from public.business_expenses where id = e_util) <> 900.00 then raise exception 'TEST FAILED: the original amount must be preserved'; end if;
  select sum(amount) into v_sum from public.business_expenses where category = 'utilities' and voided_at is null;
  if v_sum <> 950.50 then raise exception 'TEST FAILED: only the replacement may count, got %', v_sum; end if;
  if public.correct_business_expense(op3, e_util, v_today, 'utilities', 950.50, 'Meralco', 'Typo fixed', 'gcash', null, 'Misread the bill') is distinct from r2 then
    raise exception 'TEST FAILED: a correction retry must replay the same replacement';
  end if;
  select count(*) into n from public.business_expenses where corrects_expense_id = e_util;
  if n <> 1 then raise exception 'TEST FAILED: a replayed correction must not append a second replacement (got %)', n; end if;
  perform public.t_expect(format('select public.correct_business_expense(%L, %L, %L, ''utilities'', 1, ''X'', null, null, null, ''again'')', gen_random_uuid(), e_util, v_today), '23514', 'This expense is already void%');
  perform public.t_expect(format('select public.correct_business_expense(%L, %L, %L, ''ingredients'', 1, ''X'', null, null, null, ''bad'')', gen_random_uuid(), e_new, v_today), '22023', 'Choose an expense category%');
  -- A refused correction (invalid replacement) must leave the original untouched and live.
  if (select voided_at from public.business_expenses where id = e_new) is not null then raise exception 'TEST FAILED: a refused correction must not void the original'; end if;

  -- ---- 8. Direct writes by the API role are not possible -----------------------------------------
  perform public.t_expect(format('insert into public.business_expenses (operation_id, expense_date, category, amount, payee, recorded_by) values (%L, current_date, ''rent'', 1, ''X'', %L)', gen_random_uuid(), gen_random_uuid()), '42501', 'permission denied%');
  perform public.t_expect('update public.business_expenses set amount = 1', '42501', 'permission denied%');
  perform public.t_expect('delete from public.business_expenses', '42501', 'permission denied%');
  perform public.t_expect('truncate public.business_expenses', '42501', 'permission denied%');
end;
$$;

-- ---- 9. Non-owner authenticated session: sees nothing, can write nothing --------------------------
select set_config('request.jwt.claim.app_role', 'member', true);
select set_config('request.jwt.claims', '{"sub":"99999999-9999-4999-8999-999999999999","role":"authenticated","app_metadata":{"app_role":"member"}}', true);
do $$
declare n integer;
begin
  select count(*) into n from public.business_expenses;
  if n <> 0 then raise exception 'TEST FAILED: a non-owner must read zero expense rows (got %)', n; end if;
  perform public.t_expect('select public.record_business_expense(gen_random_uuid(), current_date, ''rent'', 10, ''X'', null, null, null, false)', '42501', 'Only the product lab owner%');
  perform public.t_expect('select public.void_business_expense(gen_random_uuid(), gen_random_uuid(), ''x'')', '42501', 'Only the product lab owner%');
  perform public.t_expect('select public.correct_business_expense(gen_random_uuid(), gen_random_uuid(), current_date, ''rent'', 1, ''X'', null, null, null, ''x'')', '42501', 'Only the product lab owner%');
end;
$$;

-- ---- 10. Anonymous: no grant at all (table or functions) ---------------------------------------------
reset role;
set local role anon;
do $$
begin
  perform public.t_expect('select count(*) from public.business_expenses', '42501', 'permission denied%');
  perform public.t_expect('select public.record_business_expense(gen_random_uuid(), current_date, ''rent'', 10, ''X'', null, null, null, false)', '42501', 'permission denied%');
end;
$$;
reset role;
-- ---- 10b. service_role (Supabase grants it ALL on new tables by default) has no write side door ------
set local role service_role;
do $$
begin
  perform public.t_expect('insert into public.business_expenses (operation_id, expense_date, category, amount, payee, recorded_by) values (gen_random_uuid(), current_date, ''rent'', 1, ''X'', gen_random_uuid())', '42501', 'permission denied%');
  perform public.t_expect('update public.business_expenses set amount = 1', '42501', 'permission denied%');
  perform public.t_expect('delete from public.business_expenses', '42501', 'permission denied%');
  perform public.t_expect('truncate public.business_expenses', '42501', 'permission denied%');
end;
$$;
reset role;

-- ---- 11. History is immutable even for the table owner / superuser -----------------------------------
do $$
declare v_id uuid; v_amount numeric;
begin
  select id, amount into v_id, v_amount from public.business_expenses where voided_at is null limit 1;
  perform public.t_expect(format('update public.business_expenses set amount = amount + 1 where id = %L', v_id), '42501', 'Expenses are append-only%');
  perform public.t_expect(format('update public.business_expenses set voided_at = now(), voided_by = gen_random_uuid(), void_reason = ''sneaky'' where id = %L', v_id), '42501', 'Expenses are append-only%');
  perform public.t_expect(format('delete from public.business_expenses where id = %L', v_id), '42501', 'Expenses cannot be deleted%');
  perform public.t_expect('truncate public.business_expenses', '42501', 'The expense ledger cannot be truncated%');
  -- Even with the void flag raised, only the void columns may change.
  perform set_config('inventory_private.expense_void_authorized', 'true', true);
  perform public.t_expect(format('update public.business_expenses set amount = amount + 1, voided_at = now(), voided_by = gen_random_uuid(), void_reason = ''x'' where id = %L', v_id), '42501', 'Only the void fields%');
  perform set_config('inventory_private.expense_void_authorized', 'false', true);
  if (select amount from public.business_expenses where id = v_id) <> v_amount then raise exception 'TEST FAILED: a refused write changed an amount'; end if;
  -- The table's own CHECKs hold when the functions are bypassed.
  perform public.t_expect('insert into public.business_expenses (operation_id, expense_date, category, amount, payee, recorded_by) values (gen_random_uuid(), current_date, ''ingredients'', 1, ''X'', gen_random_uuid())', '23514', '%business_expenses_category_check%');
  perform public.t_expect('insert into public.business_expenses (operation_id, expense_date, category, amount, payee, recorded_by) values (gen_random_uuid(), current_date, ''rent'', 1.005, ''X'', gen_random_uuid())', '23514', '%business_expenses_amount_check%');
  perform public.t_expect('insert into public.business_expenses (operation_id, expense_date, category, amount, payee, recorded_by, voided_at) values (gen_random_uuid(), current_date, ''rent'', 1, ''X'', gen_random_uuid(), now())', '23514', '%business_expenses_void_shape%');
end;
$$;

rollback;
select 'business_expenses_assertions_passed';
