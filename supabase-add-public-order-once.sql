-- S9 Public Ordering, slice PR-F2: an ATOMIC create-once gate for public submissions.
--
-- See planning/S9_PUBLIC_ORDERING_IMPLEMENTATION_PLAN.md (Revision 3, FROZEN) section 6 Q2 and
-- risk R1, and planning/PROPOSALS.md (PROP-037).
--
-- WHY THIS EXISTS. Revision 2 assumed an application-side existence check was enough:
--
--     read order -> if absent -> save_order
--
-- Live concurrency testing disproved it. The read and the write are separate transactions, so two
-- concurrent submissions for the same deterministic order id can BOTH observe "absent", and a
-- request can pause for an unbounded time between them. save_order's `on conflict (id) do update`
-- assigns every column from `excluded`, so the second caller's CREATION payload overwrites whatever
-- the order has since become -- reproduced live as status confirmed->new, payment_status
-- paid->unpaid, payment_method gcash->null, paid_at <ts>->null, paid_amount 22->null.
--
-- WHY THE CUSTOMER IS IN HERE TOO. The first version of this wrapper took only the order and its
-- lines, leaving the customer upsert in application code just outside the transaction. Adversarial
-- review reproduced the consequence, in both orderings: two submissions sharing one idempotency key
-- but carrying DIFFERENT contact details (a customer who edits the form and resubmits while the
-- first request is still in flight) derive the SAME customer id, so the loser's upsert overwrote the
-- winner's customer AFTER the winning order had been created --
--
--     A creates order + customer "Alice Race / 111111"
--     B (losing) upserts the same id as "Bob Race / 222222"
--     result: A's order now points at Bob's name and phone
--
-- Name and phone are the two fields the public flow requires, because they are how the order gets
-- confirmed. An order carrying the wrong person's number is a real delivery failure, so customer
-- persistence belongs inside the same create-once decision as the order.
--
-- WHAT THIS FUNCTION IS, AND IS NOT. It decides WHETHER to persist, and it persists the one row
-- that must be created together with the order. It does NOT reimplement order or line persistence:
-- there is no insert into orders, no insert into order_lines, and no order upsert below.
-- save_order remains the single canonical implementation of order + line persistence.
--
-- Safe to run more than once. Purely additive to the schema: no table altered, no existing function
-- changed, no existing grant or policy touched, and no anon privilege of any kind.

-- to_regprocedure resolves the exact signature and returns NULL when it does not exist. It is used
-- in preference to matching pg_get_function_identity_arguments against a literal string, which is
-- brittle: that text depends on how the server renders argument lists, and a formatting difference
-- would fail this guard on a database where save_order is present and perfectly callable.
do $$
begin
  if to_regprocedure('public.save_order(jsonb, jsonb, uuid[])') is null then
    raise exception 'save_order(jsonb, jsonb, uuid[]) is missing. Run supabase-add-orders.sql first.';
  end if;
end $$;

-- The signature changed when the customer moved inside the transaction. `create or replace` does
-- NOT replace a function whose argument list differs -- it would add a second overload and leave
-- the old two-argument version callable, still granted to authenticated, still able to create an
-- order without its customer. Drop it explicitly. Idempotent: `if exists` makes a first-time run a
-- no-op, and dropping a function drops its grants with it.
drop function if exists save_public_order_once(jsonb, jsonb);

create or replace function save_public_order_once(
  p_customer jsonb,  -- buildCustomerPayload's exact shape
  p_order    jsonb,  -- buildOrderPayload's exact shape, as save_order expects it
  p_lines    jsonb   -- array of buildOrderLinePayload's shape
) returns jsonb
language plpgsql
security invoker
as $$
declare
  v_order_id uuid;
  v_customer_id uuid;
  v_exists boolean;
begin
  v_order_id := nullif(p_order->>'id', '')::uuid;
  if v_order_id is null then
    raise exception 'Public order payload has no id';
  end if;

  v_customer_id := nullif(p_customer->>'id', '')::uuid;
  if v_customer_id is null then
    raise exception 'Public customer payload has no id';
  end if;

  -- THE CORRECTNESS BOUNDARY.
  --
  -- Serialize every concurrent submission that derives this same order id. The lock is
  -- transaction-scoped, so it is released automatically when this function's implicit transaction
  -- ends -- on commit, on rollback, and on an exception raised inside save_order. There is no
  -- unlock path to forget and no lock that can outlive a failed request.
  --
  -- An advisory lock rather than SELECT ... FOR UPDATE because in the case that matters there is no
  -- row to lock yet: the whole question is whether one should exist.
  --
  -- The key is derived from the order id alone, so it is identical for every caller racing for this
  -- order and different for every other order -- unrelated submissions never block each other. A
  -- 64-bit hash collision between two distinct order ids would merely make two unrelated callers
  -- take turns; it can cost a moment of waiting, never correctness.
  perform pg_advisory_xact_lock(hashtextextended(v_order_id::text, 0));

  -- Only NOW is existence meaningful: the lock guarantees no other public submission for this id is
  -- between its own check and its own write.
  select true into v_exists from orders where id = v_order_id;

  if v_exists then
    -- Replay, or a lost race. Write NOTHING -- not the customer, not the order, not its lines, not
    -- a timestamp. This is the branch that stops a loser from overwriting the winner's contact
    -- details. The caller turns it into the same generic acceptance a first submission receives.
    return jsonb_build_object('created', false);
  end if;

  -- Absent: this caller owns the creation. The customer is written first because
  -- orders.customer_id is `on delete restrict` and must reference an existing row -- and it is
  -- written HERE, inside the transaction, so that if save_order raises below, the customer rolls
  -- back with it and no orphan row survives.
  insert into customers (id, name, phone, messaging_handle, email, notes, updated_at)
  values (
    v_customer_id,
    p_customer->>'name',
    nullif(p_customer->>'phone', ''),
    nullif(p_customer->>'messaging_handle', ''),
    nullif(p_customer->>'email', ''),
    nullif(p_customer->>'notes', ''),
    coalesce(nullif(p_customer->>'updated_at', '')::timestamptz, now())
  )
  on conflict (id) do update set
    name = excluded.name,
    phone = excluded.phone,
    messaging_handle = excluded.messaging_handle,
    email = excluded.email,
    notes = excluded.notes,
    updated_at = excluded.updated_at;

  -- Delegate. Every order column, constraint, ownership check and line write is save_order's,
  -- unchanged. p_removed_line_ids is empty because a public submission only ever creates.
  perform save_order(p_order, p_lines, array[]::uuid[]);

  return jsonb_build_object('created', true);
end;
$$;

-- Same privilege boundary as save_order, targeting the NEW three-argument signature. PostgreSQL
-- grants EXECUTE on a new function to PUBLIC by default, which would hand this to `anon`; revoke
-- first, then grant only to authenticated. Both statements are idempotent -- revoking a grant that
-- is not present is a no-op, not an error.
revoke execute on function save_public_order_once(jsonb, jsonb, jsonb) from public;
grant  execute on function save_public_order_once(jsonb, jsonb, jsonb) to authenticated;
