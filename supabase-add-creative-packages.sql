-- Creative Package Foundation: completed Creative Job -> durable read-only package output.
-- Safe to run more than once in the Supabase SQL editor. This creates no Asset, Approval,
-- publishing, social platform, scheduling, provider, Remotion, queue, or worker-registry table.
--
-- Delete behavior: creative_package rows restrict deletion of their source creative_jobs row.
-- Test data cleanup should delete the package first, then the job, then the Opportunity. This
-- protects completed output history from accidental source-job deletion.
--
-- Stale draft safety: this file intentionally does not drop columns or rewrite previously
-- applied draft tables. Guarded preflight blocks verify that the live creative_packages table,
-- foreign key, and indexes have the approved shape. If an older draft table exists with an
-- incompatible shape, the script raises and stops so the operator can reconcile deliberately.

create table if not exists creative_packages (
  id uuid primary key default gen_random_uuid(),
  creative_job_id uuid not null references creative_jobs(id) on delete restrict,
  status text not null default 'ready',
  schema_version text not null default 'v1',
  content jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

do $$
declare
  required_column record;
  actual_type text;
  actual_not_null boolean;
  disallowed_column text;
begin
  for required_column in
    select *
    from (values
      ('id', 'uuid', true),
      ('creative_job_id', 'uuid', true),
      ('status', 'text', true),
      ('schema_version', 'text', true),
      ('content', 'jsonb', true),
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
      and table_class.relname = 'creative_packages'
      and attribute.attname = required_column.column_name
      and not attribute.attisdropped;

    if actual_type is null then
      raise exception 'creative_packages table is missing required column %; reconcile the stale draft table before continuing.', required_column.column_name;
    end if;

    if actual_type <> required_column.data_type then
      raise exception 'creative_packages column % has type %, expected %; reconcile the stale draft table before continuing.', required_column.column_name, actual_type, required_column.data_type;
    end if;

    if actual_not_null <> required_column.is_required then
      raise exception 'creative_packages column % nullability is %, expected %; reconcile the stale draft table before continuing.', required_column.column_name, actual_not_null, required_column.is_required;
    end if;
  end loop;

  for disallowed_column in
    select attribute.attname
    from pg_attribute attribute
    join pg_class table_class on table_class.oid = attribute.attrelid
    join pg_namespace namespace on namespace.oid = table_class.relnamespace
    where namespace.nspname = 'public'
      and table_class.relname = 'creative_packages'
      and not attribute.attisdropped
      and attribute.attnum > 0
      and attribute.attname in (
        'opportunity_id',
        'asset_id',
        'approval_id',
        'publishing_job_id',
        'provider',
        'model',
        'platform',
        'scheduled_at',
        'version',
        'package_version'
      )
  loop
    raise exception 'creative_packages table has unsupported future-domain column %; reconcile the stale draft table before continuing.', disallowed_column;
  end loop;

  if not exists (
    select 1
    from pg_constraint constraint_record
    join pg_class table_class on table_class.oid = constraint_record.conrelid
    join pg_namespace namespace on namespace.oid = table_class.relnamespace
    join pg_attribute attribute on attribute.attrelid = table_class.oid
      and attribute.attnum = any(constraint_record.conkey)
    where namespace.nspname = 'public'
      and table_class.relname = 'creative_packages'
      and constraint_record.contype = 'p'
      and attribute.attname = 'id'
  ) then
    raise exception 'creative_packages table is missing required id primary key; reconcile the stale draft table before continuing.';
  end if;

  if not exists (
    select 1
    from pg_constraint constraint_record
    join pg_class table_class on table_class.oid = constraint_record.conrelid
    join pg_namespace namespace on namespace.oid = table_class.relnamespace
    join pg_attribute attribute on attribute.attrelid = table_class.oid
      and attribute.attnum = any(constraint_record.conkey)
    where namespace.nspname = 'public'
      and table_class.relname = 'creative_packages'
      and constraint_record.contype = 'f'
      and attribute.attname = 'creative_job_id'
      and constraint_record.confrelid = 'public.creative_jobs'::regclass
      and constraint_record.confdeltype = 'r'
  ) then
    raise exception 'creative_packages table is missing required creative_job_id foreign key to creative_jobs(id) with on delete restrict; reconcile the stale draft table before continuing.';
  end if;
end $$;

create unique index if not exists creative_packages_creative_job_id_idx
  on creative_packages (creative_job_id);

create index if not exists creative_packages_status_created_at_idx
  on creative_packages (status, created_at desc);

do $$
declare
  index_definition text;
begin
  select pg_get_indexdef(index_class.oid)
    into index_definition
  from pg_class index_class
  join pg_namespace namespace on namespace.oid = index_class.relnamespace
  where namespace.nspname = 'public'
    and index_class.relname = 'creative_packages_creative_job_id_idx';

  if index_definition is null or index_definition !~* 'unique index.*\(creative_job_id\)' then
    raise exception 'creative_packages_creative_job_id_idx is missing or incompatible; reconcile the stale draft index before continuing.';
  end if;

  select pg_get_indexdef(index_class.oid)
    into index_definition
  from pg_class index_class
  join pg_namespace namespace on namespace.oid = index_class.relnamespace
  where namespace.nspname = 'public'
    and index_class.relname = 'creative_packages_status_created_at_idx';

  if index_definition is null or index_definition !~* '\(status, created_at desc\)' then
    raise exception 'creative_packages_status_created_at_idx is missing or incompatible; reconcile the stale draft index before continuing.';
  end if;
end $$;

alter table creative_packages enable row level security;

grant select, insert, update, delete on table creative_packages to authenticated;

drop policy if exists "Authenticated users can manage creative packages" on creative_packages;

create policy "Authenticated users can manage creative packages"
  on creative_packages for all
  to authenticated
  using (true)
  with check (true);
