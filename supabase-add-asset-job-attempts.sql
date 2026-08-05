-- Asset Job Attempt Diagnostics: append-only, per-execution diagnostics for the trusted Asset Job
-- runner. Safe to run more than once in the Supabase SQL editor. This creates no repair/stale-
-- recovery function, no heartbeat, no retry mechanism, and no token/cost/provider-request
-- accounting columns -- those are deliberately deferred to the first-real-provider milestone,
-- mirroring creative_job_attempts' own deferral. This also creates no Storage bucket, no
-- Approval, or publishing table.
--
-- Ownership: asset_jobs remains the current-state aggregate (current status, current result,
-- attempt count, bounded last_error). This table stores per-attempt diagnostics only -- exactly
-- one row per atomic claim, appended by the trusted runner, never edited by browser code.
--
-- claim_asset_job_with_attempt is defined here, not in supabase-add-asset-jobs.sql -- see that
-- file's header comment for why there is no separate bare claim function to later deprecate.
--
-- AI-readiness note: error_message is intentionally plain nullable text, the same bounded,
-- redacted operator-facing diagnostic already produced by sanitizeAssetJobErrorMessage -- never
-- stack traces, prompts, raw provider requests/responses, or credentials. provider/model columns
-- exist now (nullable) for the first-real-provider milestone to populate; provider_request_id,
-- input_tokens, output_tokens, and estimated_cost are deliberately deferred until then, mirroring
-- creative_job_attempts exactly.
--
-- Stale draft safety: this file intentionally does not drop columns or rewrite previously
-- applied draft tables. Guarded preflight blocks verify that the live asset_job_attempts table,
-- index, and claim function have the approved shape. If an older draft table exists with an
-- incompatible shape, the script raises and stops so the operator can reconcile deliberately.

create table if not exists asset_job_attempts (
  id uuid primary key default gen_random_uuid(),
  asset_job_id uuid not null references asset_jobs(id) on delete cascade,
  attempt_number integer not null,
  worker_type text not null,
  status text not null default 'running',
  started_at timestamptz not null,
  completed_at timestamptz,
  latency_ms integer,
  error_code text,
  error_message text,
  provider text,
  model text,
  created_at timestamptz not null default now()
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
      ('asset_job_id', 'uuid', true),
      ('attempt_number', 'integer', true),
      ('worker_type', 'text', true),
      ('status', 'text', true),
      ('started_at', 'timestamp with time zone', true),
      ('completed_at', 'timestamp with time zone', false),
      ('latency_ms', 'integer', false),
      ('error_code', 'text', false),
      ('error_message', 'text', false),
      ('provider', 'text', false),
      ('model', 'text', false),
      ('created_at', 'timestamp with time zone', true)
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
      and table_class.relname = 'asset_job_attempts'
      and attribute.attname = required_column.column_name
      and not attribute.attisdropped;

    if actual_type is null then
      raise exception 'asset_job_attempts table is missing required column %; reconcile the stale draft table before continuing.', required_column.column_name;
    end if;

    if actual_type <> required_column.data_type then
      raise exception 'asset_job_attempts column % has type %, expected %; reconcile the stale draft table before continuing.', required_column.column_name, actual_type, required_column.data_type;
    end if;

    if actual_not_null <> required_column.is_required then
      raise exception 'asset_job_attempts column % nullability is %, expected %; reconcile the stale draft table before continuing.', required_column.column_name, actual_not_null, required_column.is_required;
    end if;
  end loop;

  for disallowed_column in
    select *
    from (values
      ('token_count'),
      ('tokens'),
      ('prompt'),
      ('raw_response'),
      ('api_request_id'),
      ('execution_history_id'),
      ('retry_after'),
      ('max_retries'),
      ('provider_request_id'),
      ('input_tokens'),
      ('output_tokens'),
      ('estimated_cost'),
      ('api_key'),
      ('secret'),
      ('access_token'),
      ('bearer_token'),
      ('authorization'),
      ('credentials'),
      ('stack_trace')
    ) as excluded(column_name)
  loop
    if exists (
      select 1
      from pg_attribute attribute
      join pg_class table_class on table_class.oid = attribute.attrelid
      join pg_namespace namespace on namespace.oid = table_class.relnamespace
      where namespace.nspname = 'public'
        and table_class.relname = 'asset_job_attempts'
        and attribute.attname = disallowed_column
        and not attribute.attisdropped
    ) then
      raise exception 'asset_job_attempts table has disallowed column %; reconcile the stale draft table before continuing.', disallowed_column;
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
      and table_class.relname = 'asset_job_attempts'
      and constraint_record.contype = 'p'
      and attribute.attname = 'id'
  ) then
    raise exception 'asset_job_attempts table is missing required id primary key; reconcile the stale draft table before continuing.';
  end if;

  if not exists (
    select 1
    from pg_constraint constraint_record
    join pg_class table_class on table_class.oid = constraint_record.conrelid
    join pg_namespace namespace on namespace.oid = table_class.relnamespace
    join pg_attribute attribute on attribute.attrelid = table_class.oid
      and attribute.attnum = any(constraint_record.conkey)
    where namespace.nspname = 'public'
      and table_class.relname = 'asset_job_attempts'
      and constraint_record.contype = 'f'
      and attribute.attname = 'asset_job_id'
      and constraint_record.confrelid = 'public.asset_jobs'::regclass
      and constraint_record.confdeltype = 'c'
  ) then
    raise exception 'asset_job_attempts table is missing required asset_job_id foreign key to asset_jobs(id) with on delete cascade; reconcile the stale draft table before continuing.';
  end if;
end $$;

create unique index if not exists asset_job_attempts_job_attempt_idx
  on asset_job_attempts (asset_job_id, attempt_number);

do $$
declare
  index_definition text;
begin
  select pg_get_indexdef(index_class.oid)
    into index_definition
  from pg_class index_class
  join pg_namespace namespace on namespace.oid = index_class.relnamespace
  where namespace.nspname = 'public'
    and index_class.relname = 'asset_job_attempts_job_attempt_idx';

  if index_definition is null or index_definition !~* 'unique index.*\(asset_job_id, attempt_number\)' then
    raise exception 'asset_job_attempts_job_attempt_idx is missing or incompatible; reconcile the stale draft index before continuing.';
  end if;
end $$;

create or replace function claim_asset_job_with_attempt(p_job_id uuid)
returns table (
  id uuid,
  creative_package_id uuid,
  status text,
  worker_type text,
  asset_kind text,
  attempt_count integer,
  result jsonb,
  last_error text,
  created_at timestamptz,
  updated_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  failed_at timestamptz,
  attempt_id uuid,
  attempt_number integer
)
language sql
as $$
  with claimed as (
    update asset_jobs
    set
      status = 'running',
      started_at = now(),
      attempt_count = attempt_count + 1,
      updated_at = now()
    where id = p_job_id
      and status = 'queued'
    returning *
  ), inserted_attempt as (
    insert into asset_job_attempts (asset_job_id, attempt_number, worker_type, status, started_at)
    select claimed.id, claimed.attempt_count, claimed.worker_type, 'running', claimed.started_at
    from claimed
    returning id as attempt_id, asset_job_id, attempt_number
  )
  select claimed.*, inserted_attempt.attempt_id, inserted_attempt.attempt_number
  from claimed
  join inserted_attempt on inserted_attempt.asset_job_id = claimed.id;
$$;

alter table asset_job_attempts enable row level security;

grant select, insert, update, delete on table asset_job_attempts to authenticated;
grant execute on function claim_asset_job_with_attempt(uuid) to authenticated;

drop policy if exists "Authenticated users can manage asset job attempts" on asset_job_attempts;

create policy "Authenticated users can manage asset job attempts"
  on asset_job_attempts for all
  to authenticated
  using (true)
  with check (true);
