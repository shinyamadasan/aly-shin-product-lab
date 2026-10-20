-- Correct Mistaken Refund: an owner-only, audited way to undo a refund that was recorded by accident.
--
-- WHY THIS EXISTS. A refund is deliberately terminal in the order state machine (transitions.ts): once
-- recorded it keeps paid_at and paid_amount, and nothing may move it back. That is right for a real
-- refund -- and wrong for a button pressed by mistake, where the recorded fact ("money went back") is
-- FALSE. The existing answer to a false payment fact is a CORRECTION that rewrites it, but the one
-- correction that exists (clear-record) leaves no trace of what it erased. This adds the missing case:
-- refunded -> paid, with the erased refund preserved in an append-only audit row.
--
-- WHAT IT DOES, exactly (one transaction, owner-only, idempotent):
--   1. verifies the order is refunded, is not cancelled, was refunded within the last 7 days, has not been
--      corrected before, and that the caller's echo of refunded_at and paid_amount matches the live row;
--   2. writes an order_refund_corrections row snapshotting the order as it stood (original payment status,
--      method, paid_at, paid_amount, refunded_at, order status) with the owner's reason;
--   3. sets orders.payment_status = 'paid' and orders.refunded_at = NULL.
--   It touches NOTHING else: status, completed_at, paid_at, paid_amount, payment_method, order lines, stock
--   allocations, finished-stock movements, ingredients and raw COGS are all left exactly as they were. No
--   second payment is created. Because revenue reads refunded_at and COGS reads fulfilled allocations, the
--   order simply stops counting as refunded and keeps its sale and its ingredient cost.
--
-- WHY THE SAFEGUARDS. The database cannot know whether money really went back, so it cannot prove a refund
-- was mistaken. It can make the shortcut hard to misuse: owner only; a written reason (10-300 chars); the
-- caller must echo the exact refunded_at and amount it is looking at (stale or wrong-order clicks fail); a
-- 7-day window (an older refund needs manual review, not a button); never for a CANCELLED order (refunding
-- a cancelled order is the normal way to give a deposit back); and once per order (no flip-flopping). A
-- narrow trigger also stops any OTHER client write from reversing a refund, so this audited path is the
-- only one. Sessions with no JWT (the SQL editor / maintenance) are not gated, exactly like
-- enforce_order_delete_authority (safe_delete_order), so owner maintenance is never locked out.
--
-- REVERSIBLE. Re-recording a refund with the normal Refund button puts the order back to refunded (with a
-- new refunded_at); the audit row remains as history. The migration itself only adds objects; see ROLLBACK.
--
-- NOT APPLIED. Created for review; leave unapplied until explicitly authorized. Independent of the
-- business_expenses migration (20261016120000): either may be applied first.
--
-- ROLLBACK (this file only adds objects, so rollback only removes them; nothing existing is touched).
-- Run the indented block as ONE script, INCLUDING its begin/commit: inside the transaction the first
-- statement ABORTS, before anything is dropped, if any correction has ever been recorded (without the
-- transaction a plain psql run would carry on past the failed guard and drop the table anyway) (the audit rows are the only record of the original refund): export
-- them first and have the removal reviewed, per AGENTS.md's Recovery Rules. The last statement removes this
-- feature's idempotency receipts so a later re-apply cannot answer an old retry with a phantom success.
--   begin;
--   do $rollback$ begin
--     if exists (select 1 from public.order_refund_corrections) then
--       raise exception 'order_refund_corrections is not empty: export it and get explicit review before rolling back';
--     end if;
--   end $rollback$;
--   drop trigger orders_enforce_refund_reversal_authority on public.orders;
--   drop function public.correct_mistaken_refund(uuid, uuid, text, timestamptz, numeric);
--   drop function inventory_private.correct_mistaken_refund(uuid, uuid, text, timestamptz, numeric);
--   drop function inventory_private.enforce_refund_reversal_authority();
--   drop table public.order_refund_corrections;
--   drop function inventory_private.protect_order_refund_correction_history();
--   delete from inventory_private.mutation_receipts where operation_type = 'refund_correct';
--   commit;
do $$
begin
  if to_regprocedure('public.is_product_lab_owner()') is null then
    raise exception 'Refund correction requires public.is_product_lab_owner()';
  end if;
  if to_regprocedure('inventory_private.claim_mutation(uuid,text,text)') is null then
    raise exception 'Refund correction requires Wave 0B (inventory_private.claim_mutation)';
  end if;
  if to_regclass('public.orders') is null then
    raise exception 'Refund correction requires public.orders';
  end if;
  if to_regclass('public.order_refund_corrections') is not null then
    raise exception 'Refund correction already exists; this migration must not be re-applied over itself';
  end if;
end;
$$;

-- ============================================================================================
-- 1. The audit table. Append-only: no update, delete or truncate, for any caller.
-- ============================================================================================
create table public.order_refund_corrections (
  id uuid primary key default gen_random_uuid(),
  operation_id uuid not null unique,
  -- One correction per order, ever. A second mistaken refund on the same order needs manual review.
  order_id uuid not null unique references public.orders(id) on delete restrict,
  corrected_at timestamptz not null default clock_timestamp(),
  corrected_by uuid not null,
  reason text not null,
  -- The order exactly as it stood before the correction: the refund this row erased from the active order.
  order_status text not null,
  original_payment_status text not null,
  original_payment_method text,
  original_paid_at timestamptz not null,
  original_paid_amount numeric not null,
  original_refunded_at timestamptz not null,
  original_order_updated_at timestamptz not null,

  constraint order_refund_corrections_was_refunded check (original_payment_status = 'refunded'),
  constraint order_refund_corrections_reason_check check (length(btrim(reason, E' \t\r\n')) between 10 and 300)
);

comment on table public.order_refund_corrections is
  'Append-only record of refunds that were recorded by mistake and then corrected. Preserves the erased refund (when it was recorded, the payment facts) and the owner''s reason. One row per order, ever. Owner-only.';

create or replace function inventory_private.protect_order_refund_correction_history()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'The refund correction history is append-only.' using errcode = '42501';
end;
$$;
revoke all on function inventory_private.protect_order_refund_correction_history() from public, anon, authenticated;

create trigger order_refund_corrections_protect_history
  before update or delete on public.order_refund_corrections
  for each row execute function inventory_private.protect_order_refund_correction_history();
create trigger order_refund_corrections_protect_truncate
  before truncate on public.order_refund_corrections
  for each statement execute function inventory_private.protect_order_refund_correction_history();

alter table public.order_refund_corrections enable row level security;
revoke all on public.order_refund_corrections from public, anon, authenticated;
-- Supabase's default privileges give service_role ALL on new tables; writes go only through the function.
revoke insert, update, delete, truncate, trigger, references on public.order_refund_corrections from service_role;
grant select on public.order_refund_corrections to authenticated;
create policy "owner reads order refund corrections" on public.order_refund_corrections
  for select to authenticated using (public.is_product_lab_owner());

-- ============================================================================================
-- 2. A refund can be reversed ONLY through correct_mistaken_refund. Direct client writes that move an
--    order out of 'refunded' are refused (this also stops a stale browser tab silently re-marking a
--    refunded order as paid through save_order). The refund's own facts (refunded_at, paid_amount) are
--    protected too: the 7-day window and the echo check trust them, so an ordinary write must not be able to
--    make an old refund look new.
-- ============================================================================================
create or replace function inventory_private.enforce_refund_reversal_authority()
returns trigger language plpgsql set search_path = '' as $$
begin
  if old.payment_status = 'refunded'
     and coalesce(current_setting('inventory_private.refund_correction_authorized', true), '') <> 'true'
     and auth.uid() is not null then
    if new.payment_status is distinct from 'refunded' then
      raise exception 'A refund cannot be reversed directly. Use Correct Mistaken Refund, which records why.' using errcode = '42501';
    end if;
    if new.refunded_at is distinct from old.refunded_at or new.paid_amount is distinct from old.paid_amount then
      raise exception 'A recorded refund cannot be edited directly. Use Correct Mistaken Refund, which records why.' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function inventory_private.enforce_refund_reversal_authority() from public, anon, authenticated;

create trigger orders_enforce_refund_reversal_authority
  before update of payment_status, refunded_at, paid_amount on public.orders
  for each row execute function inventory_private.enforce_refund_reversal_authority();

-- ============================================================================================
-- 3. correct_mistaken_refund.
-- Error contract: 42501 not the owner; 22023 invalid input or no such order; 23514 a refusal with the
-- reason in the message (not refunded / cancelled / too old / already corrected / the echoed refunded_at
-- or amount does not match / operation id reused for a different request); 55P03 still running.
-- ============================================================================================
create or replace function inventory_private.correct_mistaken_refund(
  p_operation_id uuid, p_order_id uuid, p_reason text, p_expected_refunded_at timestamptz, p_expected_paid_amount numeric
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_hash text; v_replay jsonb; v_order public.orders%rowtype;
  v_reason text := btrim(coalesce(p_reason, ''), E' \t\r\n');
  v_window constant interval := interval '7 days';
begin
  if auth.uid() is null or public.is_product_lab_owner() is not true then
    raise exception 'Only the product lab owner may correct a refund' using errcode = '42501';
  end if;
  if p_order_id is null or p_expected_refunded_at is null or p_expected_paid_amount is null then
    raise exception 'The order, its refund time and its amount are required' using errcode = '22023';
  end if;
  if length(v_reason) < 10 or length(v_reason) > 300 then
    raise exception 'Explain why this refund was a mistake (10 to 300 characters)' using errcode = '22023';
  end if;

  v_hash := md5(jsonb_build_array(p_order_id, v_reason, extract(epoch from p_expected_refunded_at)::text, trim_scale(p_expected_paid_amount))::text);
  v_replay := inventory_private.claim_mutation(p_operation_id, 'refund_correct', v_hash);
  if v_replay is not null then return v_replay; end if;

  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'Order not found' using errcode = '22023';
  end if;
  if v_order.payment_status <> 'refunded' or v_order.refunded_at is null then
    raise exception 'This order is not marked refunded, so there is nothing to correct.' using errcode = '23514';
  end if;
  if exists (select 1 from public.order_refund_corrections where order_id = p_order_id) then
    raise exception 'This order''s refund was already corrected once. A second correction needs manual review.' using errcode = '23514';
  end if;
  if v_order.status = 'cancelled' then
    raise exception 'A refund on a cancelled order is the normal way to give the money back, so it cannot be undone here. Review it manually.' using errcode = '23514';
  end if;
  if v_order.paid_at is null or v_order.paid_amount is null then
    raise exception 'This order has no payment on record to restore.' using errcode = '23514';
  end if;
  if date_trunc('milliseconds', v_order.refunded_at) is distinct from date_trunc('milliseconds', p_expected_refunded_at)
     or v_order.paid_amount is distinct from p_expected_paid_amount then
    raise exception 'The refund on screen no longer matches this order. Reload and check it again.' using errcode = '23514';
  end if;
  if clock_timestamp() - v_order.refunded_at > v_window then
    raise exception 'This refund is more than 7 days old. It needs a manual review, not this shortcut.' using errcode = '23514';
  end if;

  insert into public.order_refund_corrections (operation_id, order_id, corrected_by, reason, order_status, original_payment_status,
    original_payment_method, original_paid_at, original_paid_amount, original_refunded_at, original_order_updated_at)
  values (p_operation_id, p_order_id, auth.uid(), v_reason, v_order.status, v_order.payment_status,
    v_order.payment_method, v_order.paid_at, v_order.paid_amount, v_order.refunded_at, v_order.updated_at);

  -- Only these two columns change. paid_at, paid_amount, payment_method, status, completed_at: untouched.
  perform set_config('inventory_private.refund_correction_authorized', 'true', true);
  update public.orders set payment_status = 'paid', refunded_at = null, updated_at = clock_timestamp()
    where id = p_order_id
  returning * into v_order;
  perform set_config('inventory_private.refund_correction_authorized', 'false', true);

  update inventory_private.mutation_receipts set result = to_jsonb(v_order) where operation_id = p_operation_id;
  return to_jsonb(v_order);
end;
$$;
revoke all on function inventory_private.correct_mistaken_refund(uuid,uuid,text,timestamptz,numeric) from public, anon, authenticated;
grant execute on function inventory_private.correct_mistaken_refund(uuid,uuid,text,timestamptz,numeric) to authenticated;

create or replace function public.correct_mistaken_refund(
  p_operation_id uuid, p_order_id uuid, p_reason text, p_expected_refunded_at timestamptz, p_expected_paid_amount numeric
) returns jsonb language sql security invoker set search_path = '' as $$
  select inventory_private.correct_mistaken_refund(p_operation_id, p_order_id, p_reason, p_expected_refunded_at, p_expected_paid_amount);
$$;
revoke all on function public.correct_mistaken_refund(uuid,uuid,text,timestamptz,numeric) from public, anon, authenticated;
grant execute on function public.correct_mistaken_refund(uuid,uuid,text,timestamptz,numeric) to authenticated;

notify pgrst, 'reload schema';
