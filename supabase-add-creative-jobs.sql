-- Creative Job Foundation: accepted Opportunity -> queued Creative Job -> mock runner result.
-- Safe to run more than once in the Supabase SQL editor. This creates no Content Package,
-- Asset, Approval, Worker registry, queue table, Remotion, provider, or publishing table.
--
-- The worker runner claim is intentionally a narrow SQL function instead of a queue system:
-- it atomically moves one queued creative_jobs row to running and increments attempt_count.
-- It is SECURITY INVOKER by default, so it follows the same authenticated RLS posture as the
-- rest of Product Lab.
--
-- Stale draft safety: this file intentionally does not drop columns or rewrite previously
-- applied draft tables. Guarded preflight blocks verify that the live creative_jobs table,
-- indexes, and claim function have the approved shape. If an older draft table exists with an
-- incompatible shape, the script raises and stops so the operator can reconcile deliberately.

create table if not exists creative_jobs (
  id uuid primary key default gen_random_uuid(),
  opportunity_id uuid not null references opportunities(id),
  status text not null default 'queued',
  worker_type text not null default 'mock',
  attempt_count integer not null default 0,
  result jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  failed_at timestamptz
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
      ('opportunity_id', 'uuid', true),
      ('status', 'text', true),
      ('worker_type', 'text', true),
      ('attempt_count', 'integer', true),
      ('result', 'jsonb', true),
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
      and table_class.relname = 'creative_jobs'
      and attribute.attname = required_column.column_name
      and not attribute.attisdropped;

    if actual_type is null then
      raise exception 'creative_jobs table is missing required column %; reconcile the stale draft table before continuing.', required_column.column_name;
    end if;

    if actual_type <> required_column.data_type then
      raise exception 'creative_jobs column % has type %, expected %; reconcile the stale draft table before continuing.', required_column.column_name, actual_type, required_column.data_type;
    end if;

    if actual_not_null <> required_column.is_required then
      raise exception 'creative_jobs column % nullability is %, expected %; reconcile the stale draft table before continuing.', required_column.column_name, actual_not_null, required_column.is_required;
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
      and table_class.relname = 'creative_jobs'
      and constraint_record.contype = 'p'
      and attribute.attname = 'id'
  ) then
    raise exception 'creative_jobs table is missing required id primary key; reconcile the stale draft table before continuing.';
  end if;

  if not exists (
    select 1
    from pg_constraint constraint_record
    join pg_class table_class on table_class.oid = constraint_record.conrelid
    join pg_namespace namespace on namespace.oid = table_class.relnamespace
    join pg_attribute attribute on attribute.attrelid = table_class.oid
      and attribute.attnum = any(constraint_record.conkey)
    where namespace.nspname = 'public'
      and table_class.relname = 'creative_jobs'
      and constraint_record.contype = 'f'
      and attribute.attname = 'opportunity_id'
      and constraint_record.confrelid = 'public.opportunities'::regclass
  ) then
    raise exception 'creative_jobs table is missing required opportunity_id foreign key to opportunities(id); reconcile the stale draft table before continuing.';
  end if;
end $$;

create unique index if not exists creative_jobs_opportunity_id_idx
  on creative_jobs (opportunity_id);

create index if not exists creative_jobs_status_created_at_idx
  on creative_jobs (status, created_at desc);

do $$
declare
  index_definition text;
begin
  select pg_get_indexdef(index_class.oid)
    into index_definition
  from pg_class index_class
  join pg_namespace namespace on namespace.oid = index_class.relnamespace
  where namespace.nspname = 'public'
    and index_class.relname = 'creative_jobs_opportunity_id_idx';

  if index_definition is null or index_definition !~* 'unique index.*\(opportunity_id\)' then
    raise exception 'creative_jobs_opportunity_id_idx is missing or incompatible; reconcile the stale draft index before continuing.';
  end if;

  select pg_get_indexdef(index_class.oid)
    into index_definition
  from pg_class index_class
  join pg_namespace namespace on namespace.oid = index_class.relnamespace
  where namespace.nspname = 'public'
    and index_class.relname = 'creative_jobs_status_created_at_idx';

  if index_definition is null or index_definition !~* '\(status, created_at desc\)' then
    raise exception 'creative_jobs_status_created_at_idx is missing or incompatible; reconcile the stale draft index before continuing.';
  end if;
end $$;

create or replace function claim_creative_job(p_job_id uuid)
returns setof creative_jobs
language sql
as $$
  update creative_jobs
  set
    status = 'running',
    started_at = now(),
    attempt_count = attempt_count + 1,
    updated_at = now()
  where id = p_job_id
    and status = 'queued'
  returning *;
$$;

alter table creative_jobs enable row level security;

grant select, insert, update, delete on table creative_jobs to authenticated;
grant execute on function claim_creative_job(uuid) to authenticated;

drop policy if exists "Authenticated users can manage creative jobs" on creative_jobs;

create policy "Authenticated users can manage creative jobs"
  on creative_jobs for all
  to authenticated
  using (true)
  with check (true);
