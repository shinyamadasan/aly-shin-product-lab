-- Opportunity Pipeline Foundation (PROP-016): structured Opportunity persistence only.
-- Safe to run more than once in the Supabase SQL editor. This creates no Creative Job,
-- Content Package, Asset, Approval, Worker, Event, Remotion, provider, or publishing table.
--
-- Product identity is intentionally stored as evidence/source metadata rather than a
-- foreign key in this milestone. The live app still has split product identity: the UI and
-- Daily Advisor use the static product catalog, while supabase-schema.sql also contains a
-- products table. Opportunity rows preserve product/batch/costing IDs in evidence and the
-- deduplication key without forcing that wider product-identity decision here.
--
-- Stale draft safety: this file intentionally does not drop columns or rewrite previously
-- applied draft tables. After the create-table statement below, guarded preflight blocks
-- verify that the live opportunities table and indexes have the approved shape. If an older
-- draft table exists with an incompatible shape, the script raises and stops so the operator
-- can reconcile deliberately instead of silently continuing.

create table if not exists opportunities (
  id uuid primary key default gen_random_uuid(),
  opportunity_type text not null,
  producer text not null,
  source_type text not null,
  source_id text not null,
  title text not null,
  summary text,
  reason text not null,
  recommended_action text not null,
  evidence_version text not null,
  evidence jsonb not null default '{}'::jsonb,
  source_rule_ids text[] not null default '{}'::text[],
  source_findings jsonb not null default '[]'::jsonb,
  status text not null default 'new',
  detected_at timestamptz not null,
  expires_at timestamptz not null,
  deduplication_key text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

do $$
declare
  required_column record;
  actual_type text;
  actual_not_null boolean;
begin
  for required_column in
    select *
    from (values
      ('id', 'uuid', true),
      ('opportunity_type', 'text', true),
      ('producer', 'text', true),
      ('source_type', 'text', true),
      ('source_id', 'text', true),
      ('title', 'text', true),
      ('summary', 'text', false),
      ('reason', 'text', true),
      ('recommended_action', 'text', true),
      ('evidence_version', 'text', true),
      ('evidence', 'jsonb', true),
      ('source_rule_ids', 'text[]', true),
      ('source_findings', 'jsonb', true),
      ('status', 'text', true),
      ('detected_at', 'timestamp with time zone', true),
      ('expires_at', 'timestamp with time zone', true),
      ('deduplication_key', 'text', true),
      ('created_at', 'timestamp with time zone', true),
      ('updated_at', 'timestamp with time zone', true)
    ) as expected(column_name, data_type, is_required)
  loop
    actual_type := null;
    actual_not_null := null;

    select format_type(attribute.atttypid, attribute.atttypmod), attribute.attnotnull
      into actual_type, actual_not_null
    from pg_attribute attribute
    join pg_class table_class on table_class.oid = attribute.attrelid
    join pg_namespace namespace on namespace.oid = table_class.relnamespace
    where namespace.nspname = 'public'
      and table_class.relname = 'opportunities'
      and attribute.attname = required_column.column_name
      and not attribute.attisdropped;

    if actual_type is null then
      raise exception 'opportunities table is missing required column %; reconcile the stale draft table before continuing.', required_column.column_name;
    end if;

    if actual_type <> required_column.data_type then
      raise exception 'opportunities column % has type %, expected %; reconcile the stale draft table before continuing.', required_column.column_name, actual_type, required_column.data_type;
    end if;

    if actual_not_null <> required_column.is_required then
      raise exception 'opportunities column % nullability is %, expected %; reconcile the stale draft table before continuing.', required_column.column_name, actual_not_null, required_column.is_required;
    end if;
  end loop;

  if not exists (
    select 1
    from pg_constraint constraint_record
    join pg_class table_class on table_class.oid = constraint_record.conrelid
    join pg_namespace namespace on namespace.oid = table_class.relnamespace
    join pg_attribute attribute on attribute.attrelid = table_class.oid
      and attribute.attnum = any(constraint_record.conkey)
    where namespace.nspname = 'public'
      and table_class.relname = 'opportunities'
      and constraint_record.contype = 'p'
      and attribute.attname = 'id'
  ) then
    raise exception 'opportunities table is missing required id primary key; reconcile the stale draft table before continuing.';
  end if;

  if exists (
    select 1
    from pg_attribute attribute
    join pg_class table_class on table_class.oid = attribute.attrelid
    join pg_namespace namespace on namespace.oid = table_class.relnamespace
    where namespace.nspname = 'public'
      and table_class.relname = 'opportunities'
      and attribute.attname = 'priority'
      and not attribute.attisdropped
  ) then
    raise exception 'opportunities table contains retired priority column; reconcile the stale draft table before continuing.';
  end if;
end $$;

create unique index if not exists opportunities_deduplication_key_idx
  on opportunities (deduplication_key);

create index if not exists opportunities_status_detected_at_idx
  on opportunities (status, detected_at desc);

create index if not exists opportunities_source_idx
  on opportunities (source_type, source_id);

create index if not exists opportunities_new_expires_at_idx
  on opportunities (expires_at)
  where status = 'new';

do $$
declare
  index_definition text;
begin
  select pg_get_indexdef(index_class.oid)
    into index_definition
  from pg_class index_class
  join pg_namespace namespace on namespace.oid = index_class.relnamespace
  where namespace.nspname = 'public'
    and index_class.relname = 'opportunities_deduplication_key_idx';

  if index_definition is null or index_definition !~* 'unique index.*\(deduplication_key\)' then
    raise exception 'opportunities_deduplication_key_idx is missing or incompatible; reconcile the stale draft index before continuing.';
  end if;

  select pg_get_indexdef(index_class.oid)
    into index_definition
  from pg_class index_class
  join pg_namespace namespace on namespace.oid = index_class.relnamespace
  where namespace.nspname = 'public'
    and index_class.relname = 'opportunities_status_detected_at_idx';

  if index_definition is null or index_definition !~* '\(status, detected_at desc\)' then
    raise exception 'opportunities_status_detected_at_idx is missing or incompatible; reconcile the stale draft index before continuing.';
  end if;

  select pg_get_indexdef(index_class.oid)
    into index_definition
  from pg_class index_class
  join pg_namespace namespace on namespace.oid = index_class.relnamespace
  where namespace.nspname = 'public'
    and index_class.relname = 'opportunities_source_idx';

  if index_definition is null or index_definition !~* '\(source_type, source_id\)' then
    raise exception 'opportunities_source_idx is missing or incompatible; reconcile the stale draft index before continuing.';
  end if;

  select pg_get_indexdef(index_class.oid)
    into index_definition
  from pg_class index_class
  join pg_namespace namespace on namespace.oid = index_class.relnamespace
  where namespace.nspname = 'public'
    and index_class.relname = 'opportunities_new_expires_at_idx';

  if index_definition is null or index_definition !~* '\(expires_at\).*where.*status = ''new''' then
    raise exception 'opportunities_new_expires_at_idx is missing or incompatible; reconcile the stale draft index before continuing.';
  end if;
end $$;

alter table opportunities enable row level security;

grant select, insert, update, delete on table opportunities to authenticated;

drop policy if exists "Authenticated users can manage opportunities" on opportunities;

create policy "Authenticated users can manage opportunities"
  on opportunities for all
  to authenticated
  using (true)
  with check (true);
