-- Safe Delete Order: permanent removal of a genuinely accidental order, decided by the database.
--
-- Cancel stays the right action for any real order: it keeps history and, for a confirmed/ready
-- order, releases its reservation. This function exists only for the "I created this by mistake a
-- moment ago" case, and it deletes only when Postgres itself can see that nothing downstream has
-- ever attached to the order.
--
-- WHAT REFERENCES AN ORDER (inspected, not assumed):
--   order_lines.order_id               ON DELETE CASCADE  (supabase-add-orders.sql)
--   order_stock_allocations.order_id   ON DELETE RESTRICT (Wave 2)
--   finished_stock_movements.order_id  no ON DELETE clause = NO ACTION (Wave 2)
--   order_raw_cogs                     a VIEW over fulfilled allocations (Wave 3) -- no rows of its own
--   orders.customer_id -> customers    ON DELETE RESTRICT: the customer is the PARENT; deleting an
--                                      order never touches it
--   inventory_private.mutation_receipts keeps operation ids only, no order foreign key
-- Nothing else in the schema carries an order id.
--
-- ELIGIBILITY (all must hold, re-checked under a row lock):
--   status = 'new'                       never confirmed/ready/completed/cancelled
--   entry_method = 'manual'              a website order is a customer's request, and the public form's
--                                        retry (save_public_order_once) treats "row exists" as "already
--                                        saved" -- deleting it would let a retry resurrect it
--   payment_status = 'unpaid' and payment_method, paid_at, paid_amount, refunded_at all null
--   no order_stock_allocations row       of ANY status
--   no finished_stock_movements row      for this order
-- Anything else is refused with a plain-language reason and nothing is changed.
--
-- PAYMENT-HISTORY LIMIT (read this before trusting the word "unpaid"): the schema has no payment
-- event/history table. "Clear payment record" (applyPaymentCorrection) sets a paid order back to
-- unpaid and nulls paid_at/paid_amount/payment_method -- by design it declares "the payment never
-- happened" and leaves no trace. So an order that PASSES the payment checks above proves only "no
-- payment is on record NOW", NOT "no payment was ever recorded". The function and its messages are
-- worded that way on purpose. A stronger claim would need an append-only payment log, which this
-- migration deliberately does not invent.
--
-- DATABASE AUTHORITY: orders/order_lines have always granted `authenticated` unrestricted table
-- access, so a client could `delete from orders` directly and skip any RPC. A BEFORE DELETE trigger
-- closes that for API callers (a JWT is present): they may delete an order only inside
-- safe_delete_order, which announces itself with a transaction-local flag it sets immediately
-- before its delete and clears immediately after -- the same pattern as Wave 2's
-- order_transition_authorized. A session with no JWT (SQL editor / postgres role) is not gated, so
-- owner maintenance is not locked out.
--
-- CONCURRENCY: the order row is locked FOR UPDATE (confirm/cancel/complete lock the same row, so a
-- concurrent confirm serializes with this), and p_expected_updated_at must equal the version the
-- caller's screen was rendered from -- every order write sets updated_at explicitly, so any newer
-- write of any kind moves it.
--
-- IDEMPOTENCY: inventory_private.claim_mutation, like every other privileged mutation here. A retry
-- with the same operation id after success replays the stored result; with a NEW operation id it
-- finds no order and says so.
--
-- ROLLBACK (this file is additive; nothing existing is altered):
--   drop function public.safe_delete_order(uuid, uuid, timestamptz);
--   drop function inventory_private.safe_delete_order(uuid, uuid, timestamptz);
--   drop trigger safe_delete_enforce_order_delete_authority on public.orders;
--   drop function public.enforce_order_delete_authority();
-- Deleted orders are not recoverable from this function; that is what the confirmation dialog and
-- the eligibility rule are for.
--
-- NOT APPLIED. Verified only against a disposable Postgres container.
do $$
begin
  if to_regprocedure('inventory_private.claim_mutation(uuid,text,text)') is null then
    raise exception 'Safe Delete Order requires Wave 0B (claim_mutation)';
  end if;
  if to_regclass('public.orders') is null or to_regclass('public.order_lines') is null
     or to_regclass('public.order_stock_allocations') is null
     or to_regclass('public.finished_stock_movements') is null then
    raise exception 'Safe Delete Order requires the orders tables and Wave 2 (order_stock_allocations, finished_stock_movements.order_id)';
  end if;
  if to_regprocedure('public.safe_delete_order(uuid,uuid,timestamptz)') is not null then
    raise exception 'Safe Delete Order objects already exist; this migration must not be re-applied over itself';
  end if;
end;
$$;

-- ============================================================================================
-- 1. Direct-delete authority. Only API callers (a JWT is present) are gated.
-- ============================================================================================
create or replace function public.enforce_order_delete_authority()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if coalesce(current_setting('inventory_private.order_delete_authorized', true), '') = 'true' then
    return old;
  end if;
  if auth.uid() is not null then
    raise exception 'Orders can only be deleted through the safe delete function.' using errcode = '42501';
  end if;
  return old;
end;
$$;

create trigger safe_delete_enforce_order_delete_authority
  before delete on public.orders
  for each row execute function public.enforce_order_delete_authority();

-- ============================================================================================
-- 2. safe_delete_order
-- ============================================================================================
create or replace function inventory_private.safe_delete_order(
  p_operation_id uuid, p_order_id uuid, p_expected_updated_at timestamptz
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_hash text; v_replay jsonb;
  v_order public.orders%rowtype;
  v_lines_deleted integer;
  v_result jsonb;
begin
  if auth.uid() is null or public.is_product_lab_owner() is not true then
    raise exception 'Only the product lab owner may delete an order' using errcode = '42501';
  end if;
  if p_order_id is null or p_expected_updated_at is null then
    raise exception 'An order and the version you opened are required' using errcode = '22023';
  end if;

  v_hash := md5(concat_ws('|', p_order_id::text, p_expected_updated_at::text));
  v_replay := inventory_private.claim_mutation(p_operation_id, 'order_safe_delete', v_hash);
  if v_replay is not null then return v_replay; end if;

  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'Order not found' using errcode = '22023';
  end if;

  if v_order.updated_at is distinct from p_expected_updated_at then
    raise exception 'This order changed since you opened it. Refresh and try again.' using errcode = '40001';
  end if;
  if v_order.status <> 'new' then
    raise exception 'Only new orders can be permanently deleted. Cancel this order instead.' using errcode = '23514';
  end if;
  if v_order.entry_method <> 'manual' then
    raise exception 'Orders that came in through the website cannot be permanently deleted. Cancel this order instead.' using errcode = '23514';
  end if;
  if v_order.payment_status <> 'unpaid'
     or v_order.payment_method is not null or v_order.paid_at is not null
     or v_order.paid_amount is not null or v_order.refunded_at is not null then
    raise exception 'This order has a payment on record. Cancel or refund it instead.' using errcode = '23514';
  end if;
  if exists (select 1 from public.order_stock_allocations where order_id = p_order_id) then
    raise exception 'This order has stock reservation records. Cancel it instead.' using errcode = '23514';
  end if;
  if exists (select 1 from public.finished_stock_movements where order_id = p_order_id) then
    raise exception 'This order already affected finished stock. Cancel it instead.' using errcode = '23514';
  end if;

  -- Explicit and atomic: lines first (the order_lines immutability trigger allows this because the
  -- parent is still 'new'), then the order. The customer row is never referenced here.
  perform set_config('inventory_private.order_delete_authorized', 'true', true);
  delete from public.order_lines where order_id = p_order_id;
  get diagnostics v_lines_deleted = row_count;
  delete from public.orders where id = p_order_id;
  perform set_config('inventory_private.order_delete_authorized', '', true);

  v_result := jsonb_build_object('order_id', p_order_id, 'deleted', true, 'lines_deleted', v_lines_deleted);
  update inventory_private.mutation_receipts set result = v_result where operation_id = p_operation_id;
  return v_result;
end;
$$;
revoke all on function inventory_private.safe_delete_order(uuid, uuid, timestamptz) from public, anon, authenticated;
grant execute on function inventory_private.safe_delete_order(uuid, uuid, timestamptz) to authenticated;

create or replace function public.safe_delete_order(p_operation_id uuid, p_order_id uuid, p_expected_updated_at timestamptz)
returns jsonb language sql security invoker set search_path = '' as $$
  select inventory_private.safe_delete_order(p_operation_id, p_order_id, p_expected_updated_at);
$$;
revoke all on function public.safe_delete_order(uuid, uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.safe_delete_order(uuid, uuid, timestamptz) to authenticated;

notify pgrst, 'reload schema';
