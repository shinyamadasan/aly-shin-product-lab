// Schema assertions against supabase-add-orders.sql's own text -- the same convention
// tests/opportunities-schema.test.ts and tests/brand-profiles-schema.test.ts already use.
//
// These exist because the migration encodes decisions that are expensive to discover are wrong
// later: a delete action that destroys financial history, a check constraint whose absence
// overstates revenue, or a business rule quietly smuggled into the RPC.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const sql = readFileSync(new URL("../supabase-add-orders.sql", import.meta.url), "utf8");
const sqlStatementsOnly = sql
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n");

const customersTable = sqlStatementsOnly.match(/create table if not exists customers \([\s\S]*?\n\);/i)?.[0] ?? "";
const ordersTable = sqlStatementsOnly.match(/create table if not exists orders \([\s\S]*?\n\);/i)?.[0] ?? "";
const orderLinesTable = sqlStatementsOnly.match(/create table if not exists order_lines \([\s\S]*?\n\);/i)?.[0] ?? "";
const guardStatements = Array.from(sqlStatementsOnly.matchAll(/do \$\$[\s\S]*?end \$\$;/gi), (match) => match[0]);
const columnGuardStatement = guardStatements[0] ?? "";
const constraintGuardStatement = guardStatements[1] ?? "";
const saveOrderFunction = sqlStatementsOnly.match(/create or replace function save_order\([\s\S]*?\nend \$\$;/i)?.[0] ?? "";

test("orders migration creates all three approved tables", () => {
  assert.notEqual(customersTable, "", "customers table statement not found");
  assert.notEqual(ordersTable, "", "orders table statement not found");
  assert.notEqual(orderLinesTable, "", "order_lines table statement not found");
});

test("orders migration is idempotent and purely additive", () => {
  // Safe to run more than once, the same guarantee every other migration in this repo makes.
  assert.match(sql, /create table if not exists customers/i);
  assert.match(sql, /create table if not exists orders/i);
  assert.match(sql, /create table if not exists order_lines/i);
  assert.match(sql, /create or replace function save_order/i);
  for (const indexName of [
    "orders_status_idx",
    "orders_customer_id_idx",
    "orders_placed_at_idx",
    "orders_payment_status_idx",
    "orders_paid_at_idx",
    "orders_refunded_at_idx",
    "order_lines_order_id_idx",
  ]) {
    assert.ok(sql.includes(`create index if not exists ${indexName}`), `missing idempotent index: ${indexName}`);
  }

  // Nothing existing may be altered or dropped. `drop policy if exists` is exempt: it targets only
  // this migration's own three policies, immediately before recreating them, which is the exact
  // template every other table in this schema uses.
  const droppedPolicies = Array.from(sqlStatementsOnly.matchAll(/drop policy if exists "([^"]+)"/gi), (match) => match[1]);
  assert.deepEqual(droppedPolicies, [
    "Authenticated users can manage customers",
    "Authenticated users can manage orders",
    "Authenticated users can manage order lines",
  ]);
  assert.doesNotMatch(sqlStatementsOnly, /\balter table (?!customers|orders|order_lines)/i);
  assert.doesNotMatch(sqlStatementsOnly, /\bdrop table\b/i);
  assert.doesNotMatch(sqlStatementsOnly, /\bdrop column\b/i);
});

test("customers carries the approved minimum identity and nothing more", () => {
  for (const requiredColumn of [
    "id uuid primary key default gen_random_uuid()",
    "name text not null",
    "phone text",
    "messaging_handle text",
    "email text",
    "notes text",
    "created_at timestamptz not null default now()",
    "updated_at timestamptz not null default now()",
  ]) {
    assert.ok(customersTable.includes(requiredColumn), `missing customers column: ${requiredColumn}`);
  }

  // Not a CRM: no lifecycle, segments, tags, or loyalty fields.
  assert.doesNotMatch(customersTable, /\b(segment|tag|loyalty|points|lifecycle|status)\b/i);
});

test("customers has no unique index on name or phone", () => {
  // Real people share names and change numbers. Duplicate detection is a UI warning at entry time
  // (findPossibleDuplicateCustomer), never a hard block that surfaces as a raw Postgres error.
  assert.doesNotMatch(sqlStatementsOnly, /create unique index[^;]*on customers/i);
});

test("orders carries every approved column with the approved defaults", () => {
  for (const requiredColumn of [
    "id uuid primary key default gen_random_uuid()",
    "customer_id uuid not null references customers(id) on delete restrict",
    "status text not null default 'new'",
    "payment_status text not null default 'unpaid'",
    "payment_method text",
    "paid_at timestamptz",
    "paid_amount numeric",
    "refunded_at timestamptz",
    "fulfillment_method text not null default 'pickup'",
    "fulfillment_at timestamptz",
    "fulfillment_address text",
    "fulfillment_notes text",
    "source text not null default 'unknown'",
    "source_ref text",
    "entry_method text not null default 'manual'",
    "notes text",
    "placed_at timestamptz not null default now()",
    "completed_at timestamptz",
    "cancelled_at timestamptz",
    "cancel_reason text",
    "created_at timestamptz not null default now()",
    "updated_at timestamptz not null default now()",
  ]) {
    assert.ok(ordersTable.includes(requiredColumn), `missing orders column: ${requiredColumn}`);
  }
});

test("orders defaults source to unknown, never to manual", () => {
  // `manual` describes how the record was typed in, which is entry_method's job. Defaulting the
  // acquisition channel to it would silently attribute an Instagram customer to a non-channel.
  assert.ok(ordersTable.includes("source text not null default 'unknown'"));
  assert.ok(ordersTable.includes("entry_method text not null default 'manual'"));
  assert.doesNotMatch(ordersTable, /source text not null default 'manual'/i);
});

test("orders has no order_code, fulfillment status, or second state machine", () => {
  assert.doesNotMatch(ordersTable, /\border_code\b/i);
  assert.doesNotMatch(ordersTable, /\bfulfillment_status\b/i);
  assert.doesNotMatch(ordersTable, /\brefunded_amount\b/i);
});

test("order_lines snapshots everything it needs from rows that can be orphaned", () => {
  for (const requiredColumn of [
    "id uuid primary key default gen_random_uuid()",
    "order_id uuid not null references orders(id) on delete cascade",
    "product_id text references products(id) on delete set null",
    "selling_format_id uuid references selling_formats(id) on delete set null",
    "item_name text not null",
    "unit_price numeric not null check (unit_price >= 0)",
    "pieces_per_unit_snapshot numeric check (pieces_per_unit_snapshot > 0)",
    "quantity integer not null default 1 check (quantity > 0)",
    "sort_order integer not null default 0",
    "note text",
    "created_at timestamptz not null default now()",
  ]) {
    assert.ok(orderLinesTable.includes(requiredColumn), `missing order_lines column: ${requiredColumn}`);
  }
});

test("order_lines.product_id is text, not uuid", () => {
  // products.id is a human-readable slug for the originally seeded products and a UUID string for
  // everything since (supabase-schema.sql). A uuid column here fails at apply time.
  assert.ok(orderLinesTable.includes("product_id text references products(id)"));
  assert.doesNotMatch(orderLinesTable, /product_id uuid/i);
});

test("order_lines.quantity is integer, so a fractional selling unit is unrepresentable", () => {
  assert.ok(orderLinesTable.includes("quantity integer not null default 1 check (quantity > 0)"));
  assert.doesNotMatch(orderLinesTable, /quantity numeric/i);
});

test("pieces_per_unit_snapshot is nullable with a positive check and no default", () => {
  // Nullable because NULL means "not recorded". No default, because defaulting to 1 would silently
  // under-count a box of six as a single piece -- inventing data.
  assert.ok(orderLinesTable.includes("pieces_per_unit_snapshot numeric check (pieces_per_unit_snapshot > 0)"));
  assert.doesNotMatch(orderLinesTable, /pieces_per_unit_snapshot numeric not null/i);
  assert.doesNotMatch(orderLinesTable, /pieces_per_unit_snapshot numeric[^,]*default/i);
});

test("catalog pointers are ON DELETE SET NULL so a costing cleanup cannot destroy order history", () => {
  // selling_formats.costing_id is ON DELETE CASCADE, so deleting a costing deletes its formats.
  // A hard reference from an order line would take financial history with it.
  assert.ok(orderLinesTable.includes("references products(id) on delete set null"));
  assert.ok(orderLinesTable.includes("references selling_formats(id) on delete set null"));
  assert.doesNotMatch(orderLinesTable, /references selling_formats\(id\) on delete cascade/i);
  assert.doesNotMatch(orderLinesTable, /references products\(id\) on delete cascade/i);
});

test("orders.customer_id is ON DELETE RESTRICT and order_lines.order_id is ON DELETE CASCADE", () => {
  assert.ok(ordersTable.includes("references customers(id) on delete restrict"));
  assert.ok(orderLinesTable.includes("references orders(id) on delete cascade"));
});

test("all three money constraints exist, and the refund check names paid_amount", () => {
  assert.ok(ordersTable.includes("constraint orders_paid_fields_present"));
  assert.ok(ordersTable.includes("constraint orders_refund_fields_present"));
  assert.ok(ordersTable.includes("constraint orders_paid_amount_nonnegative"));

  const refundCheck = ordersTable.match(/constraint orders_refund_fields_present\s*check \(([\s\S]*?)\)\s*,/i)?.[1] ?? "";
  // Without paid_amount in this predicate, a refunded order could lose the very figure the refund
  // total sums, and net revenue would be overstated by exactly the refunded amount.
  assert.match(refundCheck, /paid_at is not null/i);
  assert.match(refundCheck, /paid_amount is not null/i);
  assert.match(refundCheck, /refunded_at is not null/i);

  const paidCheck = ordersTable.match(/constraint orders_paid_fields_present\s*check \(([\s\S]*?)\)\s*,/i)?.[1] ?? "";
  assert.match(paidCheck, /paid_at is not null/i);
  assert.match(paidCheck, /paid_amount is not null/i);

  // Nullable-safe: a bare `>= 0` would reject every unpaid order, whose amount is legitimately null.
  assert.ok(ordersTable.includes("check (paid_amount is null or paid_amount >= 0)"));
});

test("no CHECK constraint restricts any classification column", () => {
  // TypeScript unions are the source of truth (docs/DATA_MODEL.md). This is what makes adding a
  // 'preparing' status or a new channel a one-line change with zero migration.
  for (const classificationColumn of ["status", "payment_status", "payment_method", "fulfillment_method", "source", "entry_method"]) {
    const inPredicate = new RegExp(`check\\s*\\([^)]*\\b${classificationColumn}\\s+in\\s*\\(`, "i");
    assert.doesNotMatch(ordersTable, inPredicate, `${classificationColumn} must not carry a value CHECK`);
  }
  // The three money checks legitimately mention payment_status; they constrain a relationship
  // between columns, not the column's domain. Assert the distinction holds by checking that every
  // occurrence is one of those three named constraints.
  const statusMentions = (ordersTable.match(/payment_status/g) ?? []).length;
  assert.equal(statusMentions, 3, "payment_status should appear only in the three money constraints");
});

test("column preflight fails loudly instead of silently accepting a stale table", () => {
  assert.match(columnGuardStatement, /pg_attribute/i);
  assert.match(columnGuardStatement, /format_type/i);
  assert.match(columnGuardStatement, /attnotnull/i);
  assert.match(columnGuardStatement, /raise exception/i);

  for (const requiredEntry of [
    "('orders', 'paid_amount', 'numeric', false)",
    "('orders', 'refunded_at', 'timestamp with time zone', false)",
    "('orders', 'source', 'text', true)",
    "('orders', 'entry_method', 'text', true)",
    "('order_lines', 'product_id', 'text', false)",
    "('order_lines', 'pieces_per_unit_snapshot', 'numeric', false)",
    "('order_lines', 'quantity', 'integer', true)",
  ]) {
    assert.ok(columnGuardStatement.includes(requiredEntry), `preflight missing expectation: ${requiredEntry}`);
  }
});

test("constraint preflight verifies delete actions and the money checks", () => {
  assert.match(constraintGuardStatement, /confdeltype/i);
  assert.match(constraintGuardStatement, /raise exception/i);
  // 'r' = restrict, 'c' = cascade, 'n' = set null.
  assert.ok(constraintGuardStatement.includes("('orders', 'customer_id', 'r')"));
  assert.ok(constraintGuardStatement.includes("('order_lines', 'order_id', 'c')"));
  assert.ok(constraintGuardStatement.includes("('order_lines', 'product_id', 'n')"));
  assert.ok(constraintGuardStatement.includes("('order_lines', 'selling_format_id', 'n')"));
  assert.ok(constraintGuardStatement.includes("orders_paid_fields_present"));
  assert.ok(constraintGuardStatement.includes("orders_refund_fields_present"));
  assert.ok(constraintGuardStatement.includes("orders_paid_amount_nonnegative"));
});

test("save_order is plpgsql and security invoker", () => {
  assert.notEqual(saveOrderFunction, "", "save_order function not found");
  assert.match(saveOrderFunction, /language plpgsql/i);
  assert.match(saveOrderFunction, /security invoker/i);
  assert.doesNotMatch(saveOrderFunction, /security definer/i);
});

test("save_order takes already-computed payloads and validates their shape", () => {
  assert.match(saveOrderFunction, /p_order jsonb/i);
  assert.match(saveOrderFunction, /p_lines jsonb/i);
  assert.match(saveOrderFunction, /p_removed_line_ids uuid\[\]/i);
  assert.match(saveOrderFunction, /raise exception 'Order id is required'/i);
  assert.match(saveOrderFunction, /raise exception 'Order lines payload must be a json array'/i);
});

test("save_order raises on a submitted line that belongs to another order", () => {
  assert.match(saveOrderFunction, /raise exception 'Order line does not belong to the order being saved'/i);
  // The check must compare against the saved order's own id, extracted once.
  assert.match(saveOrderFunction, /v_order_id := \(p_order->>'id'\)::uuid/i);
  assert.match(saveOrderFunction, /\(v_line->>'order_id'\)::uuid is distinct from v_order_id/i);
});

test("save_order scopes its delete so cross-order deletion is impossible", () => {
  const deleteStatement = saveOrderFunction.match(/delete from order_lines[\s\S]*?;/i)?.[0] ?? "";
  assert.notEqual(deleteStatement, "", "save_order has no delete statement");
  assert.match(deleteStatement, /id = any\(p_removed_line_ids\)/i);
  // The scoping clause is the protection: a foreign id matches nothing rather than deleting
  // another order's line. Validation alone would not be enough.
  assert.match(deleteStatement, /and order_id = v_order_id/i);
});

test("save_order writes each line's order_id from the verified order id, not from the payload", () => {
  const lineInsert = saveOrderFunction.match(/insert into order_lines \([\s\S]*?on conflict \(id\) do update set[\s\S]*?;/i)?.[0] ?? "";
  assert.notEqual(lineInsert, "", "save_order has no order_lines upsert");
  // Belt and braces alongside the ownership raise: even a payload that passed validation cannot
  // repoint a line at a different order.
  assert.match(lineInsert, /v_order_id,/);
  assert.doesNotMatch(lineInsert, /\(v_line->>'order_id'\)::uuid,/);
});

test("save_order upserts rather than inserting, so a double-submit cannot duplicate an order", () => {
  assert.match(saveOrderFunction, /insert into orders \([\s\S]*?on conflict \(id\) do update set/i);
  assert.match(saveOrderFunction, /insert into order_lines \([\s\S]*?on conflict \(id\) do update set/i);
});

test("save_order does not overwrite created_at on update", () => {
  const orderUpsert = saveOrderFunction.match(/insert into orders \([\s\S]*?on conflict \(id\) do update set([\s\S]*?);/i)?.[1] ?? "";
  assert.notEqual(orderUpsert, "", "save_order has no orders upsert");
  assert.doesNotMatch(orderUpsert, /created_at\s*=/i);
  // updated_at comes from the payload, never from now(), so the application stays its single writer.
  assert.match(orderUpsert, /updated_at = excluded\.updated_at/i);
});

test("save_order contains no business logic", () => {
  // The application computes the payload; this function validates shape and ownership, then
  // applies it. Every existing RPC in this schema follows the same rule -- confirm_bake does not
  // re-check insufficient stock either.
  //
  // No pricing, no totals:
  assert.doesNotMatch(saveOrderFunction, /unit_price\s*\*/i);
  assert.doesNotMatch(saveOrderFunction, /\bsum\(/i);
  // No transition rules:
  assert.doesNotMatch(saveOrderFunction, /'confirmed'|'ready'|'completed'|'cancelled'/i);
  assert.doesNotMatch(saveOrderFunction, /'paid'|'refunded'|'unpaid'/i);
  // No revenue, inventory, attribution, or fulfilment decisions:
  assert.doesNotMatch(saveOrderFunction, /\bingredients\b|\binventory_transactions\b/i);
  assert.doesNotMatch(saveOrderFunction, /'pickup'|'delivery'/i);
  assert.doesNotMatch(saveOrderFunction, /'facebook'|'instagram'|'unknown'/i);
});

test("Selling writes nothing to inventory", () => {
  assert.doesNotMatch(sqlStatementsOnly, /\binsert into inventory_transactions\b/i);
  assert.doesNotMatch(sqlStatementsOnly, /\bupdate ingredients\b/i);
});

test("RLS, grants and policies follow the repo template, with no anon grant", () => {
  for (const table of ["customers", "orders", "order_lines"]) {
    assert.ok(sql.includes(`alter table ${table} enable row level security`), `${table} missing RLS`);
    assert.ok(sql.includes(`grant select, insert, update, delete on table ${table} to authenticated`), `${table} missing grant`);
  }
  assert.match(sql, /grant execute on function save_order\(jsonb, jsonb, uuid\[\]\) to authenticated/i);
  // The public ordering surface is a separate milestone requiring a real server-side boundary.
  assert.doesNotMatch(sqlStatementsOnly, /\bto anon\b/i);
});
