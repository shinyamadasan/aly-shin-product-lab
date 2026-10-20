-- Financial Release 1 (T3): the operating-expense ledger.
--
-- Operating expenses were the one financial fact the app did not record at all: purchases are
-- inventory (an asset), orders are revenue, Bake freezes ingredient cost -- but rent, utilities,
-- delivery, fees, marketing and the like had no home, so no honest operating result could exist.
-- This migration adds exactly that and nothing else.
--
-- WHAT THIS ADDS (all new objects; no existing table, column, function, policy or grant is changed):
--   public.business_expenses                    append-only expense ledger
--   inventory_private.protect_business_expense_history   trigger function (immutability)
--   inventory_private.record_business_expense  } owner-checked, idempotent writers, each with a
--   inventory_private.void_business_expense    } public security-invoker wrapper -- the same
--   inventory_private.correct_business_expense } private/public pair every prior wave uses
--
-- HOW IT STAYS AUDITABLE
--   * Nothing is deleted. A mistake is VOIDED (a reason is mandatory) or CORRECTED (the original is
--     voided and a replacement row points back at it through corrects_expense_id). A BEFORE UPDATE
--     trigger lets only the three void columns change, exactly once, and only inside the void/correct
--     functions; a BEFORE DELETE/TRUNCATE trigger refuses removal. Like any trigger-based control, it can
--     be switched off by the table owner or a superuser (alter table ... disable trigger), so the
--     guarantee is: append-only for every API role, including service_role, whose write grants are revoked.
--   * The API roles have SELECT only. All writes go through the functions below.
--   * Owner-only: the sole policy is `using (public.is_product_lab_owner())`. anon has no grant at all.
--     This deliberately does NOT copy the older `using (true)` template -- this is financial data.
--
-- HOW IT STAYS IDEMPOTENT (enforced in the database, not the UI)
--   * Every write claims its operation id through inventory_private.claim_mutation (Wave 0B): the same
--     id + same payload replays the stored result, the same id + a different payload is refused.
--   * business_expenses.operation_id is also UNIQUE, so even a bug in the claim helper cannot store
--     one intent twice.
--   * A second, DIFFERENT intent that looks like the same expense (same date, amount and payee, not
--     voided) is refused with a distinguishable error until the caller explicitly confirms it. That
--     refusal raises, so its claim rolls back and the operation id stays reusable. Two simultaneous
--     entries are serialized with an advisory lock so both cannot pass the check. A CORRECTION is not
--     duplicate-checked (it replaces a specific row the owner chose); a replay returns the result stored
--     when the request was first answered, not the row's current state.
--
-- HOW IT AVOIDS COUNTING A PURCHASE TWICE
--   Ingredient, packaging and stock purchases are inventory, recorded through Purchases. They are NOT
--   an expense, so category is a closed list with no inventory category. A purchase reaches the profit
--   figure only as COGS, when an order is fulfilled -- never here. (A CHECK on a classification column
--   is a deliberate, narrow exception to this schema's usual "TypeScript is the source of truth"
--   convention, for the same reason ingredients_base_unit_check is one: this exact column being
--   unconstrained is how a purchase would get counted twice.)
--
-- MONEY: amount is exact numeric restricted to whole centavos, so sums never carry rounding drift.
--
-- NOT APPLIED. Created for review; leave unapplied until the Release 1 review gates pass.
-- Integration tests run against a disposable Postgres container only
-- (tests/smoke/postgres/business-expenses.smoke.test.ts).
--
-- ROLLBACK (this file only adds objects, so rollback only removes them; nothing existing is touched).
-- Run the indented block below as ONE script. Its first statement ABORTS, before anything is dropped,
-- if any expense has ever been recorded: export the ledger first (select * from public.business_expenses)
-- and have the removal reviewed, as AGENTS.md's Recovery Rules require. The last statement deletes this
-- feature's idempotency receipts; leaving them behind would make a later re-apply answer an old retry
-- with a stored "recorded" result for an expense that no longer exists.
--   do $rollback$ begin
--     if exists (select 1 from public.business_expenses) then
--       raise exception 'business_expenses is not empty: export it and get explicit review before rolling back';
--     end if;
--   end $rollback$;
--   drop function public.record_business_expense(uuid, date, text, numeric, text, text, text, text, boolean);
--   drop function public.void_business_expense(uuid, uuid, text);
--   drop function public.correct_business_expense(uuid, uuid, date, text, numeric, text, text, text, text, text);
--   drop function inventory_private.record_business_expense(uuid, date, text, numeric, text, text, text, text, boolean);
--   drop function inventory_private.void_business_expense(uuid, uuid, text);
--   drop function inventory_private.correct_business_expense(uuid, uuid, date, text, numeric, text, text, text, text, text);
--   drop table public.business_expenses;
--   drop function inventory_private.protect_business_expense_history();
--   delete from inventory_private.mutation_receipts where operation_type in ('expense_record', 'expense_void', 'expense_correct');
do $$
begin
  if to_regprocedure('public.is_product_lab_owner()') is null then
    raise exception 'Business expenses require the owner authorization function public.is_product_lab_owner()';
  end if;
  if to_regprocedure('inventory_private.claim_mutation(uuid,text,text)') is null then
    raise exception 'Business expenses require Wave 0B (inventory_private.claim_mutation)';
  end if;
  if to_regclass('public.business_expenses') is not null then
    raise exception 'Business expenses already exist; this migration must not be re-applied over itself';
  end if;
end;
$$;

-- ============================================================================================
-- 1. The ledger.
-- ============================================================================================
create table public.business_expenses (
  id uuid primary key default gen_random_uuid(),
  -- Idempotency key, minted once per entry form by the client.
  operation_id uuid not null unique,
  -- The business date the cost belongs to (a calendar date, entered in Manila terms).
  expense_date date not null,
  category text not null,
  -- PHP, whole centavos.
  amount numeric not null,
  -- Who was paid / what for. Required: an expense with no payee cannot be checked against a receipt.
  payee text not null,
  description text,
  -- cash | gcash | bank_transfer | other -- the same list orders.payment_method uses. Optional: the
  -- cash-account model is a later release, so this is a reference, not a balance.
  payment_method text,
  payment_reference text,
  -- Set on the replacement row of a correction; points at the row that was voided.
  corrects_expense_id uuid references public.business_expenses(id),
  recorded_at timestamptz not null default clock_timestamp(),
  recorded_by uuid not null,
  voided_at timestamptz,
  voided_by uuid,
  void_reason text,

  constraint business_expenses_category_check check (category in (
    'rent', 'utilities', 'delivery', 'fees', 'marketing', 'equipment',
    'supplies_non_inventory', 'software', 'permits_taxes', 'labor', 'other'
  )),
  constraint business_expenses_amount_check check (amount > 0 and amount < 1000000000 and amount = round(amount, 2)),
  constraint business_expenses_payee_check check (length(btrim(payee)) between 1 and 120),
  constraint business_expenses_date_check check (expense_date >= date '2000-01-01'),
  constraint business_expenses_payment_method_check check (payment_method is null or payment_method in ('cash', 'gcash', 'bank_transfer', 'other')),
  constraint business_expenses_text_length_check check (length(coalesce(description, '')) <= 500 and length(coalesce(payment_reference, '')) <= 120),
  -- A voided row always carries who, when and why; a live row carries none of them.
  constraint business_expenses_void_shape check (
    (voided_at is null and voided_by is null and void_reason is null)
    or (voided_at is not null and voided_by is not null and length(btrim(void_reason)) > 0)
  ),
  constraint business_expenses_no_self_correction check (corrects_expense_id is distinct from id)
);

create index business_expenses_date_idx on public.business_expenses (expense_date desc);
create index business_expenses_category_idx on public.business_expenses (category, expense_date desc);
-- Serves the duplicate-entry lookup, which only ever considers live rows.
create index business_expenses_live_duplicate_idx on public.business_expenses (expense_date, amount) where voided_at is null;

comment on table public.business_expenses is
  'Append-only operating-expense ledger. Never deleted: voided or corrected, with the original retained. Excludes inventory purchases by construction (see category check). Owner-only.';
comment on column public.business_expenses.amount is
  'PHP, exact whole centavos (CHECK amount = round(amount, 2)). Summed as exact numeric; never rounded in aggregation.';
comment on column public.business_expenses.corrects_expense_id is
  'On a correction''s replacement row: the voided row it replaces. Null for an original entry.';

-- ============================================================================================
-- 2. Immutability. Only the void columns may change, once, inside the void/correct functions.
-- ============================================================================================
create or replace function inventory_private.protect_business_expense_history()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'The expense ledger cannot be truncated; void the expense instead.' using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Expenses cannot be deleted; void the expense instead.' using errcode = '42501';
  end if;
  -- UPDATE
  if coalesce(current_setting('inventory_private.expense_void_authorized', true), '') <> 'true' then
    raise exception 'Expenses are append-only; use void or correct.' using errcode = '42501';
  end if;
  if old.voided_at is not null then
    raise exception 'This expense is already void.' using errcode = '23514';
  end if;
  if (to_jsonb(new) - 'voided_at' - 'voided_by' - 'void_reason')
     is distinct from (to_jsonb(old) - 'voided_at' - 'voided_by' - 'void_reason') then
    raise exception 'Only the void fields of an expense may change.' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function inventory_private.protect_business_expense_history() from public, anon, authenticated;

create trigger business_expenses_protect_history
  before update or delete on public.business_expenses
  for each row execute function inventory_private.protect_business_expense_history();
create trigger business_expenses_protect_truncate
  before truncate on public.business_expenses
  for each statement execute function inventory_private.protect_business_expense_history();

-- ============================================================================================
-- 3. Authority: owner SELECT only. No client role gets any write grant.
-- ============================================================================================
alter table public.business_expenses enable row level security;
revoke all on public.business_expenses from public, anon, authenticated;
-- Supabase's default privileges grant service_role ALL on new tables. Writes go only through the owner-
-- checked functions, so the service key does not get a side door either; it keeps SELECT.
revoke insert, update, delete, truncate, trigger, references on public.business_expenses from service_role;
grant select on public.business_expenses to authenticated;
create policy "financial owner reads business expenses" on public.business_expenses
  for select to authenticated using (public.is_product_lab_owner());

-- ============================================================================================
-- 4. record_business_expense.
-- Error contract: 42501 not the owner, 22023 invalid input, 23514 an operation id reused for a
-- different request, 55P03 the same operation is still running, 23505 a possible duplicate (the
-- message starts "POSSIBLE_DUPLICATE" and the caller may retry with p_confirm_possible_duplicate).
-- ============================================================================================
create or replace function inventory_private.record_business_expense(
  p_operation_id uuid, p_expense_date date, p_category text, p_amount numeric, p_payee text,
  p_description text, p_payment_method text, p_payment_reference text, p_confirm_possible_duplicate boolean
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_hash text; v_replay jsonb; v_row public.business_expenses%rowtype;
  v_payee text := btrim(coalesce(p_payee, ''));
  v_duplicate record;
begin
  if auth.uid() is null or public.is_product_lab_owner() is not true then
    raise exception 'Only the product lab owner may record an expense' using errcode = '42501';
  end if;
  if p_expense_date is null then
    raise exception 'An expense date is required' using errcode = '22023';
  end if;
  if p_expense_date > (clock_timestamp() at time zone 'Asia/Manila')::date then
    raise exception 'An expense cannot be dated in the future' using errcode = '22023';
  end if;
  if p_category is null or p_category not in ('rent', 'utilities', 'delivery', 'fees', 'marketing', 'equipment',
       'supplies_non_inventory', 'software', 'permits_taxes', 'labor', 'other') then
    raise exception 'Choose an expense category. Ingredient and packaging purchases are recorded as Purchases, not expenses.' using errcode = '22023';
  end if;
  if p_amount is null or p_amount::text = any(array['NaN','Infinity','-Infinity']) or p_amount <= 0
     or p_amount >= 1000000000 or p_amount <> round(p_amount, 2) then
    raise exception 'The amount must be a positive peso amount with at most two decimals' using errcode = '22023';
  end if;
  if length(v_payee) = 0 or length(v_payee) > 120 then
    raise exception 'Enter who was paid (up to 120 characters)' using errcode = '22023';
  end if;

  if p_payment_method is not null and p_payment_method <> '' and p_payment_method not in ('cash', 'gcash', 'bank_transfer', 'other') then
    raise exception 'Choose cash, gcash, bank transfer or other, or leave the payment method blank' using errcode = '22023';
  end if;
  if p_expense_date < date '2000-01-01' then
    raise exception 'The expense date is not valid' using errcode = '22023';
  end if;
  if length(coalesce(p_description, '')) > 500 or length(coalesce(p_payment_reference, '')) > 120 then
    raise exception 'The note (up to 500 characters) or reference (up to 120) is too long' using errcode = '22023';
  end if;

  -- The confirm flag is a decision about the warning, not part of the request's identity. The hash is a
  -- JSON array (unambiguous field boundaries, unlike a delimiter-joined string) over the amount with its
  -- trailing zeros trimmed, so 10 and 10.00 are the same intent.
  v_hash := md5(jsonb_build_array(p_expense_date, p_category, trim_scale(p_amount), v_payee,
    coalesce(btrim(p_description), ''), coalesce(p_payment_method, ''), coalesce(btrim(p_payment_reference), ''))::text);
  v_replay := inventory_private.claim_mutation(p_operation_id, 'expense_record', v_hash);
  if v_replay is not null then return v_replay; end if;

  if not coalesce(p_confirm_possible_duplicate, false) then
    -- Serialize look-alike entries so two simultaneous submissions cannot both pass this check.
    perform pg_advisory_xact_lock(hashtextextended(concat_ws('|', p_expense_date::text, trim_scale(p_amount)::text, lower(v_payee)), 0));
    select id, recorded_at into v_duplicate
    from public.business_expenses
    where voided_at is null and expense_date = p_expense_date and amount = p_amount
      and lower(btrim(payee)) = lower(v_payee)
    order by recorded_at desc limit 1;
    if found then
      -- Raising rolls back the claim above, so this operation id is still free for the confirmed retry.
      raise exception 'POSSIBLE_DUPLICATE: an expense with the same date, amount and payee was already recorded at %.', v_duplicate.recorded_at
        using errcode = '23505', detail = v_duplicate.id::text;
    end if;
  end if;

  insert into public.business_expenses (operation_id, expense_date, category, amount, payee, description,
    payment_method, payment_reference, recorded_by)
  values (p_operation_id, p_expense_date, p_category, p_amount, v_payee, nullif(btrim(coalesce(p_description, '')), ''),
    nullif(p_payment_method, ''), nullif(btrim(coalesce(p_payment_reference, '')), ''), auth.uid())
  returning * into v_row;

  update inventory_private.mutation_receipts set result = to_jsonb(v_row) where operation_id = p_operation_id;
  return to_jsonb(v_row);
end;
$$;
revoke all on function inventory_private.record_business_expense(uuid,date,text,numeric,text,text,text,text,boolean)
  from public, anon, authenticated;
grant execute on function inventory_private.record_business_expense(uuid,date,text,numeric,text,text,text,text,boolean) to authenticated;

create or replace function public.record_business_expense(
  p_operation_id uuid, p_expense_date date, p_category text, p_amount numeric, p_payee text,
  p_description text, p_payment_method text, p_payment_reference text, p_confirm_possible_duplicate boolean
) returns jsonb language sql security invoker set search_path = '' as $$
  select inventory_private.record_business_expense(p_operation_id, p_expense_date, p_category, p_amount, p_payee,
    p_description, p_payment_method, p_payment_reference, p_confirm_possible_duplicate);
$$;
revoke all on function public.record_business_expense(uuid,date,text,numeric,text,text,text,text,boolean)
  from public, anon, authenticated;
grant execute on function public.record_business_expense(uuid,date,text,numeric,text,text,text,text,boolean) to authenticated;

-- ============================================================================================
-- 5. void_business_expense -- the row stays; it stops counting.
-- ============================================================================================
create or replace function inventory_private.void_business_expense(
  p_operation_id uuid, p_expense_id uuid, p_reason text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_hash text; v_replay jsonb; v_row public.business_expenses%rowtype;
  v_reason text := btrim(coalesce(p_reason, ''));
begin
  if auth.uid() is null or public.is_product_lab_owner() is not true then
    raise exception 'Only the product lab owner may void an expense' using errcode = '42501';
  end if;
  if p_expense_id is null then
    raise exception 'An expense is required' using errcode = '22023';
  end if;
  if length(v_reason) = 0 or length(v_reason) > 300 then
    raise exception 'Say why this expense is being voided (up to 300 characters)' using errcode = '22023';
  end if;

  v_hash := md5(jsonb_build_array(p_expense_id, v_reason)::text);
  v_replay := inventory_private.claim_mutation(p_operation_id, 'expense_void', v_hash);
  if v_replay is not null then return v_replay; end if;

  select * into v_row from public.business_expenses where id = p_expense_id for update;
  if not found then
    raise exception 'Expense not found' using errcode = '22023';
  end if;
  if v_row.voided_at is not null then
    raise exception 'This expense is already void.' using errcode = '23514';
  end if;

  perform set_config('inventory_private.expense_void_authorized', 'true', true);
  update public.business_expenses
    set voided_at = clock_timestamp(), voided_by = auth.uid(), void_reason = v_reason
    where id = p_expense_id
  returning * into v_row;
  perform set_config('inventory_private.expense_void_authorized', 'false', true);

  update inventory_private.mutation_receipts set result = to_jsonb(v_row) where operation_id = p_operation_id;
  return to_jsonb(v_row);
end;
$$;
revoke all on function inventory_private.void_business_expense(uuid,uuid,text) from public, anon, authenticated;
grant execute on function inventory_private.void_business_expense(uuid,uuid,text) to authenticated;

create or replace function public.void_business_expense(p_operation_id uuid, p_expense_id uuid, p_reason text)
returns jsonb language sql security invoker set search_path = '' as $$
  select inventory_private.void_business_expense(p_operation_id, p_expense_id, p_reason);
$$;
revoke all on function public.void_business_expense(uuid,uuid,text) from public, anon, authenticated;
grant execute on function public.void_business_expense(uuid,uuid,text) to authenticated;

-- ============================================================================================
-- 6. correct_business_expense -- void the original and append the replacement, atomically. Returns
-- the REPLACEMENT row. The replacement reuses the correction's own operation id as its key.
-- ============================================================================================
create or replace function inventory_private.correct_business_expense(
  p_operation_id uuid, p_expense_id uuid, p_expense_date date, p_category text, p_amount numeric,
  p_payee text, p_description text, p_payment_method text, p_payment_reference text, p_reason text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_hash text; v_replay jsonb; v_old public.business_expenses%rowtype; v_new public.business_expenses%rowtype;
  v_payee text := btrim(coalesce(p_payee, ''));
  v_reason text := btrim(coalesce(p_reason, ''));
begin
  if auth.uid() is null or public.is_product_lab_owner() is not true then
    raise exception 'Only the product lab owner may correct an expense' using errcode = '42501';
  end if;
  if p_expense_id is null then
    raise exception 'An expense is required' using errcode = '22023';
  end if;
  if length(v_reason) = 0 or length(v_reason) > 300 then
    raise exception 'Say why this expense is being corrected (up to 300 characters)' using errcode = '22023';
  end if;
  if p_expense_date is null or p_expense_date > (clock_timestamp() at time zone 'Asia/Manila')::date then
    raise exception 'The corrected date must be present and not in the future' using errcode = '22023';
  end if;
  if p_category is null or p_category not in ('rent', 'utilities', 'delivery', 'fees', 'marketing', 'equipment',
       'supplies_non_inventory', 'software', 'permits_taxes', 'labor', 'other') then
    raise exception 'Choose an expense category. Ingredient and packaging purchases are recorded as Purchases, not expenses.' using errcode = '22023';
  end if;
  if p_amount is null or p_amount::text = any(array['NaN','Infinity','-Infinity']) or p_amount <= 0
     or p_amount >= 1000000000 or p_amount <> round(p_amount, 2) then
    raise exception 'The amount must be a positive peso amount with at most two decimals' using errcode = '22023';
  end if;
  if length(v_payee) = 0 or length(v_payee) > 120 then
    raise exception 'Enter who was paid (up to 120 characters)' using errcode = '22023';
  end if;

  if p_payment_method is not null and p_payment_method <> '' and p_payment_method not in ('cash', 'gcash', 'bank_transfer', 'other') then
    raise exception 'Choose cash, gcash, bank transfer or other, or leave the payment method blank' using errcode = '22023';
  end if;
  if p_expense_date < date '2000-01-01' then
    raise exception 'The expense date is not valid' using errcode = '22023';
  end if;
  if length(coalesce(p_description, '')) > 500 or length(coalesce(p_payment_reference, '')) > 120 then
    raise exception 'The note (up to 500 characters) or reference (up to 120) is too long' using errcode = '22023';
  end if;

  v_hash := md5(jsonb_build_array(p_expense_id, p_expense_date, p_category, trim_scale(p_amount), v_payee,
    coalesce(btrim(p_description), ''), coalesce(p_payment_method, ''), coalesce(btrim(p_payment_reference), ''), v_reason)::text);
  v_replay := inventory_private.claim_mutation(p_operation_id, 'expense_correct', v_hash);
  if v_replay is not null then return v_replay; end if;

  select * into v_old from public.business_expenses where id = p_expense_id for update;
  if not found then
    raise exception 'Expense not found' using errcode = '22023';
  end if;
  if v_old.voided_at is not null then
    raise exception 'This expense is already void and cannot be corrected.' using errcode = '23514';
  end if;

  perform set_config('inventory_private.expense_void_authorized', 'true', true);
  update public.business_expenses
    set voided_at = clock_timestamp(), voided_by = auth.uid(), void_reason = 'Corrected: ' || v_reason
    where id = p_expense_id;
  perform set_config('inventory_private.expense_void_authorized', 'false', true);

  insert into public.business_expenses (operation_id, expense_date, category, amount, payee, description,
    payment_method, payment_reference, corrects_expense_id, recorded_by)
  values (p_operation_id, p_expense_date, p_category, p_amount, v_payee, nullif(btrim(coalesce(p_description, '')), ''),
    nullif(p_payment_method, ''), nullif(btrim(coalesce(p_payment_reference, '')), ''), p_expense_id, auth.uid())
  returning * into v_new;

  update inventory_private.mutation_receipts set result = to_jsonb(v_new) where operation_id = p_operation_id;
  return to_jsonb(v_new);
end;
$$;
revoke all on function inventory_private.correct_business_expense(uuid,uuid,date,text,numeric,text,text,text,text,text)
  from public, anon, authenticated;
grant execute on function inventory_private.correct_business_expense(uuid,uuid,date,text,numeric,text,text,text,text,text) to authenticated;

create or replace function public.correct_business_expense(
  p_operation_id uuid, p_expense_id uuid, p_expense_date date, p_category text, p_amount numeric,
  p_payee text, p_description text, p_payment_method text, p_payment_reference text, p_reason text
) returns jsonb language sql security invoker set search_path = '' as $$
  select inventory_private.correct_business_expense(p_operation_id, p_expense_id, p_expense_date, p_category,
    p_amount, p_payee, p_description, p_payment_method, p_payment_reference, p_reason);
$$;
revoke all on function public.correct_business_expense(uuid,uuid,date,text,numeric,text,text,text,text,text)
  from public, anon, authenticated;
grant execute on function public.correct_business_expense(uuid,uuid,date,text,numeric,text,text,text,text,text) to authenticated;

notify pgrst, 'reload schema';
