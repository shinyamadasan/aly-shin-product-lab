-- Asset Generation Foundation: ready Creative Package -> queued Asset Job -> mock runner result.
-- Safe to run more than once in the Supabase SQL editor. This creates no Storage bucket, no real
-- provider integration, no Approval, no publishing, no carousel/video/story-graphic kind, and no
-- worker-registry or queue-system table.
--
-- Cardinality, deliberately different from creative_jobs: a Creative Package may have zero, one,
-- or many Asset Jobs over time (regenerations, retries, different asset kinds) -- there is no
-- unique index on creative_package_id here, unlike creative_jobs' unique opportunity_id.
--
-- This migration does not define a bare "claim one row" function the way supabase-add-creative-
-- jobs.sql originally did (later superseded by claim_creative_job_with_attempt). Asset Job
-- attempt-diagnostics ship in the same milestone as this table, not a later one, so there is no
-- claim_asset_job to later deprecate -- claim_asset_job_with_attempt is defined directly in
-- supabase-add-asset-job-attempts.sql.
--
-- Stale draft safety: this file intentionally does not drop columns or rewrite previously
-- applied draft tables. Guarded preflight blocks verify that the live asset_jobs table, foreign
-- key, and indexes have the approved shape. If an older draft table exists with an incompatible
-- shape, the script raises and stops so the operator can reconcile deliberately.
--
-- AI-readiness note: last_error is intentionally plain nullable text. It stores bounded
-- operator-facing failure diagnostics only, not stack traces, prompts, raw responses, credentials,
-- provider names, model names, tokens, or execution history -- the same discipline
-- creative_jobs.last_error already established.

create table if not exists asset_jobs (
  id uuid primary key default gen_random_uuid(),
  creative_package_id uuid not null references creative_packages(id),
  status text not null default 'queued',
  worker_type text not null default 'mock',
  asset_kind text not null default 'image',
  attempt_count integer not null default 0,
  result jsonb not null default '{}'::jsonb,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  failed_at timestamptz
);

do $$
declare
  required_column record;
  disallowed_column text;
  actual_type text;
  actual_not_null boolean;
begin
  for required_column in
    select *
    from (values
      ('id', 'uuid', true),
      ('creative_package_id', 'uuid', true),
      ('status', 'text', true),
      ('worker_type', 'text', true),
      ('asset_kind', 'text', true),
      ('attempt_count', 'integer', true),
      ('result', 'jsonb', true),
      ('last_error', 'text', false),
      ('created_at', 'timestamp with time zone', true),
      ('updated_at', 'timestamp with time zone', true),
      ('started_at', 'timestamp with time zone', false),
      ('completed_at', 'timestamp with time zone', false),
      ('failed_at', 'timestamp with time zone', false)
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
      and table_class.relname = 'asset_jobs'
      and attribute.attname = required_column.column_name
      and not attribute.attisdropped;

    if actual_type is null then
      raise exception 'asset_jobs table is missing required column %; reconcile the stale draft table before continuing.', required_column.column_name;
    end if;

    if actual_type <> required_column.data_type then
      raise exception 'asset_jobs column % has type %, expected %; reconcile the stale draft table before continuing.', required_column.column_name, actual_type, required_column.data_type;
    end if;

    if actual_not_null <> required_column.is_required then
      raise exception 'asset_jobs column % nullability is %, expected %; reconcile the stale draft table before continuing.', required_column.column_name, actual_not_null, required_column.is_required;
    end if;
  end loop;

  for disallowed_column in
    select *
    from (values
      ('provider'),
      ('model'),
      ('token_count'),
      ('tokens'),
      ('prompt'),
      ('raw_response'),
      ('api_request_id'),
      ('execution_history_id'),
      ('retry_after'),
      ('max_retries'),
      ('cost'),
      ('estimated_cost')
    ) as excluded(column_name)
  loop
    if exists (
      select 1
      from pg_attribute attribute
      join pg_class table_class on table_class.oid = attribute.attrelid
      join pg_namespace namespace on namespace.oid = table_class.relnamespace
      where namespace.nspname = 'public'
        and table_class.relname = 'asset_jobs'
        and attribute.attname = disallowed_column
        and not attribute.attisdropped
    ) then
      raise exception 'asset_jobs table has disallowed column %; reconcile the stale draft table before continuing.', disallowed_column;
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
      and table_class.relname = 'asset_jobs'
      and constraint_record.contype = 'p'
      and attribute.attname = 'id'
  ) then
    raise exception 'asset_jobs table is missing required id primary key; reconcile the stale draft table before continuing.';
  end if;

  if not exists (
    select 1
    from pg_constraint constraint_record
    join pg_class table_class on table_class.oid = constraint_record.conrelid
    join pg_namespace namespace on namespace.oid = table_class.relnamespace
    join pg_attribute attribute on attribute.attrelid = table_class.oid
      and attribute.attnum = any(constraint_record.conkey)
    where namespace.nspname = 'public'
      and table_class.relname = 'asset_jobs'
      and constraint_record.contype = 'f'
      and attribute.attname = 'creative_package_id'
      and constraint_record.confrelid = 'public.creative_packages'::regclass
  ) then
    raise exception 'asset_jobs table is missing required creative_package_id foreign key to creative_packages(id); reconcile the stale draft table before continuing.';
  end if;

  if exists (
    select 1
    from pg_class index_class
    join pg_namespace namespace on namespace.oid = index_class.relnamespace
    join pg_index index_record on index_record.indexrelid = index_class.oid
    where namespace.nspname = 'public'
      and index_class.relname = 'asset_jobs_creative_package_id_idx'
      and index_record.indisunique
  ) then
    raise exception 'asset_jobs_creative_package_id_idx must not be unique -- a Creative Package may have many Asset Jobs; reconcile the stale draft index before continuing.';
  end if;
end $$;

create index if not exists asset_jobs_creative_package_id_idx
  on asset_jobs (creative_package_id);

create index if not exists asset_jobs_status_created_at_idx
  on asset_jobs (status, created_at desc);

do $$
declare
  index_definition text;
begin
  select pg_get_indexdef(index_class.oid)
    into index_definition
  from pg_class index_class
  join pg_namespace namespace on namespace.oid = index_class.relnamespace
  where namespace.nspname = 'public'
    and index_class.relname = 'asset_jobs_creative_package_id_idx';

  if index_definition is null or index_definition !~* '\(creative_package_id\)' then
    raise exception 'asset_jobs_creative_package_id_idx is missing or incompatible; reconcile the stale draft index before continuing.';
  end if;

  select pg_get_indexdef(index_class.oid)
    into index_definition
  from pg_class index_class
  join pg_namespace namespace on namespace.oid = index_class.relnamespace
  where namespace.nspname = 'public'
    and index_class.relname = 'asset_jobs_status_created_at_idx';

  if index_definition is null or index_definition !~* '\(status, created_at desc\)' then
    raise exception 'asset_jobs_status_created_at_idx is missing or incompatible; reconcile the stale draft index before continuing.';
  end if;
end $$;

alter table asset_jobs enable row level security;

grant select, insert, update, delete on table asset_jobs to authenticated;

drop policy if exists "Authenticated users can manage asset jobs" on asset_jobs;

create policy "Authenticated users can manage asset jobs"
  on asset_jobs for all
  to authenticated
  using (true)
  with check (true);
