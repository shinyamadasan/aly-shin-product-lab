-- Selling MVP, Slice 1: the commercial record -- customers, orders, order_lines, and the atomic
-- save_order RPC. Implements planning/SELLING_MVP_IMPLEMENTATION_PLAN.md (Revision 3, FROZEN)
-- sections 4, 11, and 14/S1. See that document for the reasoning behind every decision below.
--
-- Safe to run more than once (create table if not exists / create index if not exists /
-- create or replace function). Purely additive: no existing table is altered, no existing row is
-- touched, and no existing policy or grant is changed. There is no backfill.
--
-- Three things in here are load-bearing and easy to "simplify" wrongly later:
--
--   1. order_lines points at products and selling_formats with ON DELETE SET NULL, never a hard
--      reference, and snapshots item_name / unit_price / pieces_per_unit_snapshot alongside.
--      selling_formats.costing_id is ON DELETE CASCADE (supabase-add-selling-formats.sql), so
--      deleting one costing deletes its selling formats -- and with them the only record that
--      "Box of 6" meant six. A hard FK here would let a routine costing cleanup destroy financial
--      history. This mirrors selling_format_packaging_lines, which already pairs a nullable
--      ingredient_id with a frozen unit_cost_snapshot for exactly the same reason.
--
--   2. There are NO check constraints on the classification columns (status, payment_status,
--      payment_method, fulfillment_method, source, entry_method). That is this schema's documented
--      convention (docs/DATA_MODEL.md): the TypeScript unions in src/lib/orders/types.ts are the
--      source of truth. It is also what makes adding a 'preparing' status or a new channel a
--      one-line TypeScript change with zero migration.
--
--   3. The three money constraints below ARE deliberate. They constrain a relationship between
--      columns rather than a classification's domain, and they make both revenue sums in the
--      plan's section 6.1 total by construction -- a refunded order can never be missing the
--      paid_amount that refunds(range) sums, so net revenue cannot be silently overstated.

-- ---------------------------------------------------------------------------------------------
-- Tables, in foreign-key dependency order.
-- ---------------------------------------------------------------------------------------------

-- The minimum identity needed to associate orders with a person and make "repeat buyer"
-- computable later without a migration and an unreliable backfill. Deliberately not a CRM.
--
-- No unique index on name or phone: real people share names and change numbers, and a unique
-- constraint would surface as a raw Postgres error on a legitimate save. Duplicate detection is a
-- UI warning at entry time (S2), never a hard block.
create table if not exists customers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phone text,
  -- Most orders arrive through Messenger, where a display name is the real identifier.
  messaging_handle text,
  email text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists orders (
  -- Client-minted once per form (resolveOrderId, mirroring resolveCostingId in src/lib/costing.ts)
  -- so a double-submit upserts the same row instead of inserting two orders.
  id uuid primary key default gen_random_uuid(),
  -- Reference-gated delete, matching this repo's canDeleteProduct / canHardDeleteItem convention:
  -- a customer with orders cannot be deleted out from under their own history.
  customer_id uuid not null references customers(id) on delete restrict,
  -- new | confirmed | ready | completed | cancelled -- TS union is the source of truth.
  status text not null default 'new',
  -- unpaid | paid | refunded -- TS union is the source of truth.
  payment_status text not null default 'unpaid',
  -- cash | gcash | bank_transfer | other. Null until paid.
  payment_method text,
  -- When money arrived. NEVER cleared by a refund -- that is what keeps a past period's gross
  -- revenue immutable when a refund lands in a later period.
  paid_at timestamptz,
  -- The authoritative revenue figure, frozen at paid_at from the order's total at that instant.
  -- Never recomputed from order_lines: editing lines after payment must not rewrite what was
  -- banked. This is the one stored money value in the whole design.
  paid_amount numeric,
  -- When money left. A refund is full in this milestone, so its amount is paid_amount; a
  -- refunded_amount column is deferred until a partial refund actually happens.
  refunded_at timestamptz,
  -- pickup | delivery -- an attribute, not a state. The state of fulfilment is orders.status
  -- ('ready' = made and waiting, 'completed' = handed over). There is deliberately no second
  -- status column here, because a second status machine could contradict the first.
  fulfillment_method text not null default 'pickup',
  fulfillment_at timestamptz,
  fulfillment_address text,
  fulfillment_notes text,
  -- Acquisition channel: where the order came from. Defaults to 'unknown', never 'manual' --
  -- 'manual' describes how the record was typed in, which is entry_method's job. Defaulting this
  -- to 'manual' would silently attribute an Instagram customer to a non-channel.
  source text not null default 'unknown',
  -- Opaque. Holds a content id, campaign tag, referrer name, or post URL. Never joined, never
  -- parsed for meaning. A real content foreign key is added additively when Content -> Order is
  -- genuinely built.
  source_ref text,
  -- manual | website -- how the record entered the app. Constant today by design; 'website'
  -- arrives with the public ordering surface.
  entry_method text not null default 'manual',
  notes text,
  -- When the order was taken. Editable: backfilling yesterday's order is normal.
  placed_at timestamptz not null default now(),
  -- Written by the transition together with status, so the two can never disagree.
  completed_at timestamptz,
  cancelled_at timestamptz,
  cancel_reason text,
  created_at timestamptz not null default now(),
  -- Written explicitly by the application payload. No trigger maintains updated_at anywhere in
  -- this schema (see the Business Context Builder M1 plan's finding F1), so a payload builder
  -- that omits it silently leaves this column frozen at insert time.
  updated_at timestamptz not null default now(),

  -- A 'paid' order must carry both the instant and the amount, or grossRevenue(range) sums a NULL.
  constraint orders_paid_fields_present
    check (payment_status <> 'paid'
           or (paid_at is not null and paid_amount is not null)),

  -- A 'refunded' order must still carry paid_amount, because that is the figure refunds(range)
  -- sums. Without this, a refunded order missing its amount contributes nothing to the refund
  -- total and net revenue is overstated by exactly the refunded amount -- a plausible-looking
  -- wrong number, which is the worst kind.
  constraint orders_refund_fields_present
    check (payment_status <> 'refunded'
           or (paid_at is not null and paid_amount is not null and refunded_at is not null)),

  -- Written "is null or >= 0" rather than a bare ">= 0": NULL is legitimate (an unpaid order has
  -- no amount) and a bare check would reject every unpaid order. Money going out is a refund,
  -- recorded by refunded_at -- never a negative payment.
  constraint orders_paid_amount_nonnegative
    check (paid_amount is null or paid_amount >= 0)
);

create table if not exists order_lines (
  id uuid primary key default gen_random_uuid(),
  -- A line has no life without its order.
  order_id uuid not null references orders(id) on delete cascade,
  -- text, NOT uuid: products.id is a human-readable slug for the originally seeded products and a
  -- UUID string for everything added since (supabase-schema.sql). A uuid column here fails at
  -- apply time. Nullable pointer for analysis only -- item_name is what identifies the line.
  product_id text references products(id) on delete set null,
  -- Nullable pointer, set null on delete. See note 1 in this file's header.
  selling_format_id uuid references selling_formats(id) on delete set null,
  -- Snapshot. Authoritative for display, and survives both pointers going null.
  item_name text not null,
  -- Snapshot. Authoritative for the live quote. Full precision -- never rounded before storing,
  -- the same discipline selling_format_packaging_lines.unit_cost_snapshot documents.
  unit_price numeric not null check (unit_price >= 0),
  -- Copied from selling_formats.pieces_per_unit for a catalog line. NULL means "not recorded" --
  -- never 1 and never 0. A manual line (a delivery fee) has no pieces; a hand-priced product line
  -- may or may not, and the operator has not said. Defaulting either to 1 would invent data.
  -- Consumers report a null as unknown rather than assuming (see getPiecesToPrepare).
  pieces_per_unit_snapshot numeric check (pieces_per_unit_snapshot > 0),
  -- integer, not numeric: bakery selling units are discrete. 2.5 boxes is unrepresentable rather
  -- than merely discouraged. A weight-priced item is a unit-label problem, not a reason to loosen
  -- this back to numeric.
  quantity integer not null default 1 check (quantity > 0),
  sort_order integer not null default 0,
  note text,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------------------------
-- Indexes. paid_at and refunded_at are indexed because the revenue queries filter on those
-- timestamps, not on payment_status.
-- ---------------------------------------------------------------------------------------------

create index if not exists orders_status_idx on orders (status);
create index if not exists orders_customer_id_idx on orders (customer_id);
create index if not exists orders_placed_at_idx on orders (placed_at desc);
create index if not exists orders_payment_status_idx on orders (payment_status);
create index if not exists orders_paid_at_idx on orders (paid_at);
create index if not exists orders_refunded_at_idx on orders (refunded_at);
create index if not exists order_lines_order_id_idx on order_lines (order_id);

-- ---------------------------------------------------------------------------------------------
-- Guarded preflight. Mirrors supabase-add-opportunities.sql: if a table already exists with a
-- different shape (a stale draft from an earlier attempt), fail loudly here rather than letting
-- the rest of this file run against a schema it does not match.
-- ---------------------------------------------------------------------------------------------

do $$
declare
  required_column record;
  actual_type text;
  actual_not_null boolean;
begin
  for required_column in
    select *
    from (values
      ('customers', 'id', 'uuid', true),
      ('customers', 'name', 'text', true),
      ('customers', 'phone', 'text', false),
      ('customers', 'messaging_handle', 'text', false),
      ('customers', 'email', 'text', false),
      ('customers', 'notes', 'text', false),
      ('customers', 'created_at', 'timestamp with time zone', true),
      ('customers', 'updated_at', 'timestamp with time zone', true),

      ('orders', 'id', 'uuid', true),
      ('orders', 'customer_id', 'uuid', true),
      ('orders', 'status', 'text', true),
      ('orders', 'payment_status', 'text', true),
      ('orders', 'payment_method', 'text', false),
      ('orders', 'paid_at', 'timestamp with time zone', false),
      ('orders', 'paid_amount', 'numeric', false),
      ('orders', 'refunded_at', 'timestamp with time zone', false),
      ('orders', 'fulfillment_method', 'text', true),
      ('orders', 'fulfillment_at', 'timestamp with time zone', false),
      ('orders', 'fulfillment_address', 'text', false),
      ('orders', 'fulfillment_notes', 'text', false),
      ('orders', 'source', 'text', true),
      ('orders', 'source_ref', 'text', false),
      ('orders', 'entry_method', 'text', true),
      ('orders', 'notes', 'text', false),
      ('orders', 'placed_at', 'timestamp with time zone', true),
      ('orders', 'completed_at', 'timestamp with time zone', false),
      ('orders', 'cancelled_at', 'timestamp with time zone', false),
      ('orders', 'cancel_reason', 'text', false),
      ('orders', 'created_at', 'timestamp with time zone', true),
      ('orders', 'updated_at', 'timestamp with time zone', true),

      ('order_lines', 'id', 'uuid', true),
      ('order_lines', 'order_id', 'uuid', true),
      ('order_lines', 'product_id', 'text', false),
      ('order_lines', 'selling_format_id', 'uuid', false),
      ('order_lines', 'item_name', 'text', true),
      ('order_lines', 'unit_price', 'numeric', true),
      ('order_lines', 'pieces_per_unit_snapshot', 'numeric', false),
      ('order_lines', 'quantity', 'integer', true),
      ('order_lines', 'sort_order', 'integer', true),
      ('order_lines', 'note', 'text', false),
      ('order_lines', 'created_at', 'timestamp with time zone', true)
    ) as expected(table_name, column_name, data_type, is_required)
  loop
    actual_type := null;
    actual_not_null := null;

    select format_type(attribute.atttypid, attribute.atttypmod), attribute.attnotnull
      into actual_type, actual_not_null
    from pg_attribute attribute
    join pg_class table_class on table_class.oid = attribute.attrelid
    join pg_namespace namespace on namespace.oid = table_class.relnamespace
    where namespace.nspname = 'public'
      and table_class.relname = required_column.table_name
      and attribute.attname = required_column.column_name
      and not attribute.attisdropped;

    if actual_type is null then
      raise exception '% table is missing required column %; reconcile the stale table before continuing.', required_column.table_name, required_column.column_name;
    end if;

    if actual_type <> required_column.data_type then
      raise exception '% column % has type %, expected %; reconcile the stale table before continuing.', required_column.table_name, required_column.column_name, actual_type, required_column.data_type;
    end if;

    if actual_not_null <> required_column.is_required then
      raise exception '% column % nullability is %, expected %; reconcile the stale table before continuing.', required_column.table_name, required_column.column_name, actual_not_null, required_column.is_required;
    end if;
  end loop;
end $$;

-- Constraint preflight, separate from the column preflight above because a table can have every
-- column right and still have lost the delete actions or the money checks that make the data
-- trustworthy. These are the invariants the plan's sections 4.2, 4.3 and 6.1 depend on.
do $$
declare
  required_constraint record;
  actual_delete_action char;
begin
  -- Foreign-key delete actions. 'r' = restrict, 'c' = cascade, 'n' = set null.
  for required_constraint in
    select *
    from (values
      ('orders', 'customer_id', 'r'),
      ('order_lines', 'order_id', 'c'),
      ('order_lines', 'product_id', 'n'),
      ('order_lines', 'selling_format_id', 'n')
    ) as expected(table_name, column_name, delete_action)
  loop
    -- Reset per iteration rather than relying on SELECT INTO's null-on-no-rows behaviour, matching
    -- the column guard above. A stale value here would report the previous column's delete action
    -- as this one's, which is exactly the kind of false pass a guard must not produce.
    actual_delete_action := null;

    select constraint_record.confdeltype
      into actual_delete_action
    from pg_constraint constraint_record
    join pg_class table_class on table_class.oid = constraint_record.conrelid
    join pg_namespace namespace on namespace.oid = table_class.relnamespace
    join pg_attribute attribute on attribute.attrelid = table_class.oid
      and attribute.attnum = any(constraint_record.conkey)
    where namespace.nspname = 'public'
      and table_class.relname = required_constraint.table_name
      and constraint_record.contype = 'f'
      and attribute.attname = required_constraint.column_name
    limit 1;

    if actual_delete_action is null then
      raise exception '%.% is missing its required foreign key; historical order facts depend on it.', required_constraint.table_name, required_constraint.column_name;
    end if;

    if actual_delete_action <> required_constraint.delete_action then
      raise exception '%.% has delete action %, expected % -- a wrong delete action here can destroy financial history.', required_constraint.table_name, required_constraint.column_name, actual_delete_action, required_constraint.delete_action;
    end if;
  end loop;

  -- The three money invariants. Named checks, so their absence is detectable.
  for required_constraint in
    select *
    from (values
      ('orders', 'orders_paid_fields_present'),
      ('orders', 'orders_refund_fields_present'),
      ('orders', 'orders_paid_amount_nonnegative')
    ) as expected(table_name, constraint_name)
  loop
    if not exists (
      select 1
      from pg_constraint constraint_record
      join pg_class table_class on table_class.oid = constraint_record.conrelid
      join pg_namespace namespace on namespace.oid = table_class.relnamespace
      where namespace.nspname = 'public'
        and table_class.relname = required_constraint.table_name
        and constraint_record.contype = 'c'
        and constraint_record.conname = required_constraint.constraint_name
    ) then
      raise exception '% is missing money constraint % -- revenue totals depend on it.', required_constraint.table_name, required_constraint.constraint_name;
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------------------------
-- save_order: the atomic persistence boundary for one order and its lines.
--
-- An order plus its lines is one logical transaction. Persisting them as a sequence of separate
-- writes means a mid-sequence failure can leave a three-line order holding two lines -- which is
-- NOT visibly broken. It looks like a complete, smaller order with a plausible total. That is
-- silent corruption of the commercial record, and it is exactly the failure class the existing
-- confirm_bake / confirm_purchase_import / apply_inventory_adjustment RPCs were added to prevent.
-- This is a sixth instance of that established template, not new architecture.
--
-- Contains NO business logic, matching every existing RPC in this schema: no pricing, no order or
-- payment transition rules, no revenue calculation, no inventory effect, no attribution or
-- fulfilment decision. The application computes the payload; this function validates its shape and
-- its parent-child ownership, then applies it. All of those rules live in src/lib/orders/.
--
-- Trust boundary, restated rather than assumed: this function does not re-validate business rules,
-- exactly as confirm_bake does not re-check insufficient stock. This app's RLS already grants
-- authenticated users unrestricted access (using (true)), so the RPC trusts the application layer
-- for the same reason and with the same documented caveat. If a non-first-party writer is ever
-- introduced, server-side validation must become authoritative at that point.
-- ---------------------------------------------------------------------------------------------

create or replace function save_order(
  -- buildOrderPayload's exact shape: every orders column, snake_case.
  p_order jsonb,
  -- Array of buildOrderLinePayload's shape. May be empty; validation of "an order needs at least
  -- one line" is a business rule and lives in validateOrderForSave, not here.
  p_lines jsonb,
  -- getRemovedOrderLineIds' output: lines that existed before this save and are gone now.
  p_removed_line_ids uuid[]
) returns void
language plpgsql
security invoker
as $$
declare
  v_order_id uuid;
  v_line jsonb;
begin
  if p_order is null then
    raise exception 'Order payload is required';
  end if;

  if nullif(p_order->>'id', '') is null then
    raise exception 'Order id is required';
  end if;
  v_order_id := (p_order->>'id')::uuid;

  if nullif(p_order->>'customer_id', '') is null then
    raise exception 'Order customer_id is required';
  end if;

  if nullif(p_order->>'status', '') is null then
    raise exception 'Order status is required';
  end if;

  if nullif(p_order->>'payment_status', '') is null then
    raise exception 'Order payment_status is required';
  end if;

  if nullif(p_order->>'fulfillment_method', '') is null then
    raise exception 'Order fulfillment_method is required';
  end if;

  if nullif(p_order->>'source', '') is null then
    raise exception 'Order source is required';
  end if;

  if nullif(p_order->>'entry_method', '') is null then
    raise exception 'Order entry_method is required';
  end if;

  if p_lines is null or jsonb_typeof(p_lines) <> 'array' then
    raise exception 'Order lines payload must be a json array';
  end if;

  -- Parent-child ownership, checked for every submitted line BEFORE anything is written. A line
  -- carrying a different order_id is unambiguously a caller bug with no benign reading, so this
  -- raises and rolls the whole function back rather than silently repointing the line. This is the
  -- same cross-payload identity check apply_inventory_adjustment already performs between its
  -- ingredient update and its transaction.
  for v_line in select value from jsonb_array_elements(p_lines) as elements(value) loop
    if nullif(v_line->>'id', '') is null then
      raise exception 'Order line id is required';
    end if;

    if nullif(v_line->>'order_id', '') is null
       or (v_line->>'order_id')::uuid is distinct from v_order_id then
      raise exception 'Order line does not belong to the order being saved';
    end if;

    if nullif(v_line->>'item_name', '') is null then
      raise exception 'Order line item_name is required';
    end if;

    if nullif(v_line->>'unit_price', '') is null then
      raise exception 'Order line unit_price is required';
    end if;

    if nullif(v_line->>'quantity', '') is null then
      raise exception 'Order line quantity is required';
    end if;
  end loop;

  -- Upsert the order. created_at is deliberately not in the update list: an existing order keeps
  -- the instant it was first recorded. updated_at comes from the payload, never from now(), so the
  -- application stays the single writer of that column.
  insert into orders (
    id, customer_id, status, payment_status, payment_method,
    paid_at, paid_amount, refunded_at,
    fulfillment_method, fulfillment_at, fulfillment_address, fulfillment_notes,
    source, source_ref, entry_method,
    notes, placed_at, completed_at, cancelled_at, cancel_reason,
    updated_at
  )
  values (
    v_order_id,
    (p_order->>'customer_id')::uuid,
    p_order->>'status',
    p_order->>'payment_status',
    nullif(p_order->>'payment_method', ''),
    nullif(p_order->>'paid_at', '')::timestamptz,
    nullif(p_order->>'paid_amount', '')::numeric,
    nullif(p_order->>'refunded_at', '')::timestamptz,
    p_order->>'fulfillment_method',
    nullif(p_order->>'fulfillment_at', '')::timestamptz,
    nullif(p_order->>'fulfillment_address', ''),
    nullif(p_order->>'fulfillment_notes', ''),
    p_order->>'source',
    nullif(p_order->>'source_ref', ''),
    p_order->>'entry_method',
    nullif(p_order->>'notes', ''),
    coalesce(nullif(p_order->>'placed_at', '')::timestamptz, now()),
    nullif(p_order->>'completed_at', '')::timestamptz,
    nullif(p_order->>'cancelled_at', '')::timestamptz,
    nullif(p_order->>'cancel_reason', ''),
    coalesce(nullif(p_order->>'updated_at', '')::timestamptz, now())
  )
  on conflict (id) do update set
    customer_id = excluded.customer_id,
    status = excluded.status,
    payment_status = excluded.payment_status,
    payment_method = excluded.payment_method,
    paid_at = excluded.paid_at,
    paid_amount = excluded.paid_amount,
    refunded_at = excluded.refunded_at,
    fulfillment_method = excluded.fulfillment_method,
    fulfillment_at = excluded.fulfillment_at,
    fulfillment_address = excluded.fulfillment_address,
    fulfillment_notes = excluded.fulfillment_notes,
    source = excluded.source,
    source_ref = excluded.source_ref,
    entry_method = excluded.entry_method,
    notes = excluded.notes,
    placed_at = excluded.placed_at,
    completed_at = excluded.completed_at,
    cancelled_at = excluded.cancelled_at,
    cancel_reason = excluded.cancel_reason,
    updated_at = excluded.updated_at;

  -- Upsert every submitted line. order_id is taken from v_order_id, not from the line payload,
  -- so even a payload that passed validation cannot repoint a line at a different order.
  for v_line in select value from jsonb_array_elements(p_lines) as elements(value) loop
    insert into order_lines (
      id, order_id, product_id, selling_format_id,
      item_name, unit_price, pieces_per_unit_snapshot, quantity, sort_order, note
    )
    values (
      (v_line->>'id')::uuid,
      v_order_id,
      nullif(v_line->>'product_id', ''),
      nullif(v_line->>'selling_format_id', '')::uuid,
      v_line->>'item_name',
      (v_line->>'unit_price')::numeric,
      nullif(v_line->>'pieces_per_unit_snapshot', '')::numeric,
      (v_line->>'quantity')::integer,
      coalesce(nullif(v_line->>'sort_order', '')::integer, 0),
      nullif(v_line->>'note', '')
    )
    on conflict (id) do update set
      order_id = excluded.order_id,
      product_id = excluded.product_id,
      selling_format_id = excluded.selling_format_id,
      item_name = excluded.item_name,
      unit_price = excluded.unit_price,
      pieces_per_unit_snapshot = excluded.pieces_per_unit_snapshot,
      quantity = excluded.quantity,
      sort_order = excluded.sort_order,
      note = excluded.note;
  end loop;

  -- The delete is SCOPED, not merely validated. An id belonging to another order matches nothing
  -- and is ignored rather than deleting that order's line, so cross-order deletion is impossible
  -- by construction. An id that no longer exists is a harmless no-op -- deliberately not an error,
  -- because raising there would turn a benign retry into a failure.
  if p_removed_line_ids is not null and array_length(p_removed_line_ids, 1) is not null then
    delete from order_lines
     where id = any(p_removed_line_ids)
       and order_id = v_order_id;
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------
-- RLS, grants, policies. Same template as every other table in this schema.
--
-- No anon grant: the public ordering surface is a separate milestone that requires a real
-- server-side execution boundary first. Nothing here is reachable without an authenticated session.
-- ---------------------------------------------------------------------------------------------

alter table customers enable row level security;
alter table orders enable row level security;
alter table order_lines enable row level security;

grant select, insert, update, delete on table customers to authenticated;
grant select, insert, update, delete on table orders to authenticated;
grant select, insert, update, delete on table order_lines to authenticated;

-- PostgreSQL grants EXECUTE on a new function to PUBLIC by default, so `create function` alone
-- leaves save_order anonymously *callable*. Verified live during S1 verification: an anon caller
-- reached the function body and was stopped only later, by table permissions, with
-- "42501 permission denied for table orders".
--
-- That indirect denial is real but it is not the intended boundary. save_order is meant to be
-- available to authenticated users, full stop -- not "callable by anyone, and happens to fail
-- downstream". Relying on the table grants to hold the line means any future change to those
-- grants silently widens who can execute this function.
--
-- Revoke first, then grant: the two target different grantees, so the order does not affect the
-- outcome, but revoke-then-grant states the intent in the order it is meant to be read. Both
-- statements are idempotent -- revoking a grant that is not present is a no-op, not an error.
revoke execute on function save_order(jsonb, jsonb, uuid[]) from public;
grant execute on function save_order(jsonb, jsonb, uuid[]) to authenticated;

drop policy if exists "Authenticated users can manage customers" on customers;
drop policy if exists "Authenticated users can manage orders" on orders;
drop policy if exists "Authenticated users can manage order lines" on order_lines;

create policy "Authenticated users can manage customers"
  on customers for all
  to authenticated
  using (true)
  with check (true);

create policy "Authenticated users can manage orders"
  on orders for all
  to authenticated
  using (true)
  with check (true);

create policy "Authenticated users can manage order lines"
  on order_lines for all
  to authenticated
  using (true)
  with check (true);

comment on column orders.paid_amount is 'The authoritative revenue figure, frozen at paid_at from the order total at that instant. Never recomputed from order_lines -- editing lines after payment must not rewrite what was banked. Revenue reads this column and never a line.';
comment on column order_lines.pieces_per_unit_snapshot is 'Copied from selling_formats.pieces_per_unit when the line is created. NULL means "not recorded" -- never 1 and never 0. Snapshotted because selling_formats cascades away with its costing, taking the only record of what "Box of 6" meant with it.';
