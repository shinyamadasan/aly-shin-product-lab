-- Asset Foundation: completed Asset Job -> durable review unit. Safe to run more than once in
-- the Supabase SQL editor. This creates no Approval, publishing, social platform, scheduling,
-- provider, or worker-registry table.
--
-- Delete behavior: asset rows restrict deletion of their source asset_jobs row, mirroring
-- creative_packages restricting deletion of its source creative_jobs row. Test data cleanup
-- should delete the asset (and its asset_files, which cascade) first, then the asset job, then
-- the Creative Package.
--
-- Review lifecycle deliberately not built here: status defaults to 'generated' and no other
-- value is producible by any code in this milestone -- 'approved'/'rejected' and the
-- reviewed_by/reviewed_at/rejection_reason columns they need are explicitly out of scope (see the
-- disallowed-column guard below) and ship in the milestone that actually builds the human review
-- gate. This mirrors creative_packages shipping CREATIVE_PACKAGE_STATUSES as the single value
-- ["ready"] in its own foundation milestone.
--
-- Stale draft safety: this file intentionally does not drop columns or rewrite previously
-- applied draft tables. Guarded preflight blocks verify that the live assets table, foreign key,
-- and indexes have the approved shape. If an older draft table exists with an incompatible
-- shape, the script raises and stops so the operator can reconcile deliberately.

create table if not exists assets (
  id uuid primary key default gen_random_uuid(),
  asset_job_id uuid not null references asset_jobs(id) on delete restrict,
  status text not null default 'generated',
  asset_kind text not null default 'image',
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
      ('asset_job_id', 'uuid', true),
      ('status', 'text', true),
      ('asset_kind', 'text', true),
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
      and table_class.relname = 'assets'
      and attribute.attname = required_column.column_name
      and not attribute.attisdropped;

    if actual_type is null then
      raise exception 'assets table is missing required column %; reconcile the stale draft table before continuing.', required_column.column_name;
    end if;

    if actual_type <> required_column.data_type then
      raise exception 'assets column % has type %, expected %; reconcile the stale draft table before continuing.', required_column.column_name, actual_type, required_column.data_type;
    end if;

    if actual_not_null <> required_column.is_required then
      raise exception 'assets column % nullability is %, expected %; reconcile the stale draft table before continuing.', required_column.column_name, actual_not_null, required_column.is_required;
    end if;
  end loop;

  for disallowed_column in
    select attribute.attname
    from pg_attribute attribute
    join pg_class table_class on table_class.oid = attribute.attrelid
    join pg_namespace namespace on namespace.oid = table_class.relnamespace
    where namespace.nspname = 'public'
      and table_class.relname = 'assets'
      and not attribute.attisdropped
      and attribute.attnum > 0
      and attribute.attname in (
        'reviewed_by',
        'reviewed_at',
        'rejection_reason',
        'provider',
        'model',
        'platform',
        'scheduled_at',
        'approval_id',
        'publishing_job_id',
        'campaign_id'
      )
  loop
    raise exception 'assets table has unsupported future-domain column %; reconcile the stale draft table before continuing.', disallowed_column;
  end loop;

  if not exists (
    select 1
    from pg_constraint constraint_record
    join pg_class table_class on table_class.oid = constraint_record.conrelid
    join pg_namespace namespace on namespace.oid = table_class.relnamespace
    join pg_attribute attribute on attribute.attrelid = table_class.oid
      and attribute.attnum = any(constraint_record.conkey)
    where namespace.nspname = 'public'
      and table_class.relname = 'assets'
      and constraint_record.contype = 'p'
      and attribute.attname = 'id'
  ) then
    raise exception 'assets table is missing required id primary key; reconcile the stale draft table before continuing.';
  end if;

  if not exists (
    select 1
    from pg_constraint constraint_record
    join pg_class table_class on table_class.oid = constraint_record.conrelid
    join pg_namespace namespace on namespace.oid = table_class.relnamespace
    join pg_attribute attribute on attribute.attrelid = table_class.oid
      and attribute.attnum = any(constraint_record.conkey)
    where namespace.nspname = 'public'
      and table_class.relname = 'assets'
      and constraint_record.contype = 'f'
      and attribute.attname = 'asset_job_id'
      and constraint_record.confrelid = 'public.asset_jobs'::regclass
      and constraint_record.confdeltype = 'r'
  ) then
    raise exception 'assets table is missing required asset_job_id foreign key to asset_jobs(id) with on delete restrict; reconcile the stale draft table before continuing.';
  end if;
end $$;

create unique index if not exists assets_asset_job_id_idx
  on assets (asset_job_id);

create index if not exists assets_status_created_at_idx
  on assets (status, created_at desc);

do $$
declare
  index_definition text;
begin
  select pg_get_indexdef(index_class.oid)
    into index_definition
  from pg_class index_class
  join pg_namespace namespace on namespace.oid = index_class.relnamespace
  where namespace.nspname = 'public'
    and index_class.relname = 'assets_asset_job_id_idx';

  if index_definition is null or index_definition !~* 'unique index.*\(asset_job_id\)' then
    raise exception 'assets_asset_job_id_idx is missing or incompatible; reconcile the stale draft index before continuing.';
  end if;

  select pg_get_indexdef(index_class.oid)
    into index_definition
  from pg_class index_class
  join pg_namespace namespace on namespace.oid = index_class.relnamespace
  where namespace.nspname = 'public'
    and index_class.relname = 'assets_status_created_at_idx';

  if index_definition is null or index_definition !~* '\(status, created_at desc\)' then
    raise exception 'assets_status_created_at_idx is missing or incompatible; reconcile the stale draft index before continuing.';
  end if;
end $$;

alter table assets enable row level security;

grant select, insert, update, delete on table assets to authenticated;

drop policy if exists "Authenticated users can manage assets" on assets;

create policy "Authenticated users can manage assets"
  on assets for all
  to authenticated
  using (true)
  with check (true);
