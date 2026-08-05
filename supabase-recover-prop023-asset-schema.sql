-- One-time guarded recovery: remove the empty accidental direct creative_jobs -> assets draft
-- schema and restore the committed PROP-023/024 Asset Job schema. Do not run this against a
-- populated schema or an already-correct Asset Job schema.
--
-- Intended lineage:
--
-- creative_packages
-- └── asset_jobs
--     ├── asset_job_attempts
--     └── assets
--         └── asset_files
--
-- Do not use this file for Storage cleanup. It intentionally does not touch Storage buckets,
-- Storage policies, Storage objects, creative_jobs, creative_job_attempts, creative_packages, or
-- unrelated application tables.
--
-- Destructive statements in this file, all guarded by the preflight block below:
--   1. drop function if exists public.materialize_asset_with_files(uuid, uuid, jsonb, jsonb);
--      Removes only the incompatible accidental Creative Job based asset materialization RPC.
--   2. drop table public.asset_files;
--      Removes only the proven-empty accidental asset_files table.
--   3. drop table public.assets;
--      Removes only the proven-empty accidental assets table.
--
-- Read-only verification notes are at the bottom of this file. Run the initial to_regclass query
-- before any count query against public.assets or public.asset_files; those count queries are only
-- safe after confirming both tables exist.

begin;

do $$
declare
  required_column text;
  prohibited_column text;
  unexpected_fk record;
begin
  if to_regclass('public.assets') is null then
    raise exception 'Preflight failed: public.assets must exist before this recovery can run.';
  end if;

  if to_regclass('public.asset_files') is null then
    raise exception 'Preflight failed: public.asset_files must exist before this recovery can run.';
  end if;

  if (select count(*) from public.assets) <> 0 then
    raise exception 'Preflight failed: public.assets is not empty.';
  end if;

  if (select count(*) from public.asset_files) <> 0 then
    raise exception 'Preflight failed: public.asset_files is not empty.';
  end if;

  foreach required_column in array array['creative_job_id', 'creative_package_id']
  loop
    if not exists (
      select 1
      from information_schema.columns as columns_metadata
      where columns_metadata.table_schema = 'public'
        and columns_metadata.table_name = 'assets'
        and columns_metadata.column_name = required_column
    ) then
      raise exception 'Preflight failed: public.assets is missing accidental column %.', required_column;
    end if;
  end loop;

  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'assets'
      and column_name = 'asset_job_id'
  ) then
    raise exception 'Preflight failed: public.assets already has asset_job_id; refusing to drop a potentially correct table.';
  end if;

  foreach required_column in array array['bucket', 'object_path', 'byte_size', 'sha256', 'role']
  loop
    if not exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'asset_files'
        and column_name = required_column
    ) then
      raise exception 'Preflight failed: public.asset_files is missing accidental column %.', required_column;
    end if;
  end loop;

  foreach prohibited_column in array array[
    'position',
    'storage_bucket',
    'storage_path',
    'public_url',
    'file_size_bytes',
    'duration_ms',
    'checksum_sha256'
  ]
  loop
    if exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'asset_files'
        and column_name = prohibited_column
    ) then
      raise exception 'Preflight failed: public.asset_files already has intended PROP-023 column %; refusing to drop a potentially correct table.', prohibited_column;
    end if;
  end loop;

  for unexpected_fk in
    select conrelid::regclass as child_table, conname
    from pg_constraint
    where contype = 'f'
      and confrelid = to_regclass('public.assets')
      and conrelid <> to_regclass('public.asset_files')
  loop
    raise exception 'Preflight failed: unexpected foreign key % from % references public.assets.', unexpected_fk.conname, unexpected_fk.child_table;
  end loop;

  if not exists (
    select 1
    from pg_constraint
    where contype = 'f'
      and conrelid = to_regclass('public.asset_files')
      and confrelid = to_regclass('public.assets')
  ) then
    raise exception 'Preflight failed: public.asset_files is not the expected child dependency of public.assets.';
  end if;

  if to_regclass('public.asset_jobs') is not null then
    if (select count(*) from public.asset_jobs) <> 0 then
      raise exception 'Preflight failed: public.asset_jobs exists but is not empty.';
    end if;

    foreach required_column in array array[
      'id',
      'creative_package_id',
      'status',
      'worker_type',
      'asset_kind',
      'attempt_count',
      'result',
      'last_error',
      'created_at',
      'updated_at',
      'started_at',
      'completed_at',
      'failed_at'
    ]
    loop
      if not exists (
        select 1
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'asset_jobs'
          and column_name = required_column
      ) then
        raise exception 'Preflight failed: existing public.asset_jobs is missing required column %.', required_column;
      end if;
    end loop;
  end if;

  if to_regclass('public.asset_job_attempts') is not null then
    if (select count(*) from public.asset_job_attempts) <> 0 then
      raise exception 'Preflight failed: public.asset_job_attempts exists but is not empty.';
    end if;

    foreach required_column in array array[
      'id',
      'asset_job_id',
      'attempt_number',
      'worker_type',
      'status',
      'started_at',
      'completed_at',
      'latency_ms',
      'error_code',
      'error_message',
      'provider',
      'model',
      'created_at'
    ]
    loop
      if not exists (
        select 1
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'asset_job_attempts'
          and column_name = required_column
      ) then
        raise exception 'Preflight failed: existing public.asset_job_attempts is missing required column %.', required_column;
      end if;
    end loop;
  end if;
end $$;

drop function if exists public.materialize_asset_with_files(uuid, uuid, jsonb, jsonb);
drop table public.asset_files;
drop table public.assets;

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
  actual_index_columns text;
begin
  select string_agg(attribute.attname, ',' order by key_column.ordinality)
    into actual_index_columns
  from pg_class index_class
  join pg_namespace index_namespace on index_namespace.oid = index_class.relnamespace
  join pg_index index_record on index_record.indexrelid = index_class.oid
  join pg_class table_class on table_class.oid = index_record.indrelid
  join pg_namespace table_namespace on table_namespace.oid = table_class.relnamespace
  join lateral unnest(index_record.indkey) with ordinality as key_column(attnum, ordinality) on true
  join pg_attribute attribute on attribute.attrelid = index_record.indrelid
    and attribute.attnum = key_column.attnum
  where index_namespace.nspname = 'public'
    and index_class.relname = 'assets_asset_job_id_idx'
    and table_namespace.nspname = 'public'
    and table_class.relname = 'assets'
    and index_record.indisunique
    and index_record.indnkeyatts = 1
    and index_record.indexprs is null
    and index_record.indpred is null;

  if actual_index_columns is distinct from 'asset_job_id' then
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

-- Asset File Foundation: literal storage pointers for a durable Asset, 1..N ordered rows per
-- Asset (1 for single-file kinds such as image; N for multi-file kinds such as carousel, not
-- built yet -- asset_kind is restricted to "image" at the TypeScript layer in this milestone).
-- Safe to run more than once in the Supabase SQL editor.
--
-- Deliberately no Supabase Storage bucket, no storage.objects policy, and no real upload code in
-- this migration -- Storage integration is a later, separate milestone. This table's
-- storage_bucket/storage_path/public_url columns exist now so the full Asset Generation schema
-- is provably complete end to end; the mock worker populates them with clearly-labeled
-- placeholder values ("mock" bucket, never a real bucket) to prove the write path, exactly
-- mirroring how the Creative Job mock executor prefixes its output "MOCK ONLY" rather than
-- omitting the fields a real worker will eventually populate.
--
-- No status/lifecycle column here -- asset_files rows are immutable, append-only children of
-- their Asset, the same way creative_job_attempts rows are immutable children of their Creative
-- Job. Nothing in this milestone or any planned later one updates a asset_files row after insert.
--
-- Stale draft safety: this file intentionally does not drop columns or rewrite previously
-- applied draft tables. A guarded preflight block verifies that the live asset_files table,
-- foreign key, and index have the approved shape. If an older draft table exists with an
-- incompatible shape, the script raises and stops so the operator can reconcile deliberately.

create table if not exists asset_files (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references assets(id) on delete cascade,
  position integer not null default 0,
  storage_bucket text not null,
  storage_path text not null,
  public_url text not null,
  mime_type text not null,
  file_size_bytes integer not null,
  width integer,
  height integer,
  duration_ms integer,
  checksum_sha256 text,
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
      ('asset_id', 'uuid', true),
      ('position', 'integer', true),
      ('storage_bucket', 'text', true),
      ('storage_path', 'text', true),
      ('public_url', 'text', true),
      ('mime_type', 'text', true),
      ('file_size_bytes', 'integer', true),
      ('width', 'integer', false),
      ('height', 'integer', false),
      ('duration_ms', 'integer', false),
      ('checksum_sha256', 'text', false),
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
      and table_class.relname = 'asset_files'
      and attribute.attname = required_column.column_name
      and not attribute.attisdropped;

    if actual_type is null then
      raise exception 'asset_files table is missing required column %; reconcile the stale draft table before continuing.', required_column.column_name;
    end if;

    if actual_type <> required_column.data_type then
      raise exception 'asset_files column % has type %, expected %; reconcile the stale draft table before continuing.', required_column.column_name, actual_type, required_column.data_type;
    end if;

    if actual_not_null <> required_column.is_required then
      raise exception 'asset_files column % nullability is %, expected %; reconcile the stale draft table before continuing.', required_column.column_name, actual_not_null, required_column.is_required;
    end if;
  end loop;

  for disallowed_column in
    select *
    from (values
      ('status'),
      ('provider'),
      ('model'),
      ('approved_at'),
      ('rejected_at')
    ) as excluded(column_name)
  loop
    if exists (
      select 1
      from pg_attribute attribute
      join pg_class table_class on table_class.oid = attribute.attrelid
      join pg_namespace namespace on namespace.oid = table_class.relnamespace
      where namespace.nspname = 'public'
        and table_class.relname = 'asset_files'
        and attribute.attname = disallowed_column
        and not attribute.attisdropped
    ) then
      raise exception 'asset_files table has disallowed column %; a file record has no lifecycle of its own -- reconcile the stale draft table before continuing.', disallowed_column;
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
      and table_class.relname = 'asset_files'
      and constraint_record.contype = 'p'
      and attribute.attname = 'id'
  ) then
    raise exception 'asset_files table is missing required id primary key; reconcile the stale draft table before continuing.';
  end if;

  if not exists (
    select 1
    from pg_constraint constraint_record
    join pg_class table_class on table_class.oid = constraint_record.conrelid
    join pg_namespace namespace on namespace.oid = table_class.relnamespace
    join pg_attribute attribute on attribute.attrelid = table_class.oid
      and attribute.attnum = any(constraint_record.conkey)
    where namespace.nspname = 'public'
      and table_class.relname = 'asset_files'
      and constraint_record.contype = 'f'
      and attribute.attname = 'asset_id'
      and constraint_record.confrelid = 'public.assets'::regclass
      and constraint_record.confdeltype = 'c'
  ) then
    raise exception 'asset_files table is missing required asset_id foreign key to assets(id) with on delete cascade; reconcile the stale draft table before continuing.';
  end if;
end $$;

create unique index if not exists asset_files_asset_id_position_idx
  on asset_files (asset_id, position);

do $$
declare
  actual_index_columns text;
begin
  select string_agg(attribute.attname, ',' order by key_column.ordinality)
    into actual_index_columns
  from pg_class index_class
  join pg_namespace index_namespace on index_namespace.oid = index_class.relnamespace
  join pg_index index_record on index_record.indexrelid = index_class.oid
  join pg_class table_class on table_class.oid = index_record.indrelid
  join pg_namespace table_namespace on table_namespace.oid = table_class.relnamespace
  join lateral unnest(index_record.indkey) with ordinality as key_column(attnum, ordinality) on true
  join pg_attribute attribute on attribute.attrelid = index_record.indrelid
    and attribute.attnum = key_column.attnum
  where index_namespace.nspname = 'public'
    and index_class.relname = 'asset_files_asset_id_position_idx'
    and table_namespace.nspname = 'public'
    and table_class.relname = 'asset_files'
    and index_record.indisunique
    and index_record.indnkeyatts = 2
    and index_record.indexprs is null
    and index_record.indpred is null;

  if actual_index_columns is distinct from 'asset_id,position' then
    raise exception 'asset_files_asset_id_position_idx is missing or incompatible; reconcile the stale draft index before continuing.';
  end if;
end $$;

alter table asset_files enable row level security;

grant select, insert, update, delete on table asset_files to authenticated;

drop policy if exists "Authenticated users can manage asset files" on asset_files;

create policy "Authenticated users can manage asset files"
  on asset_files for all
  to authenticated
  using (true)
  with check (true);

-- Asset Job / Attempt terminal timestamps: single database clock source, mirroring
-- supabase-add-creative-job-finish-functions.sql exactly for the Asset Job pipeline. Safe to run
-- more than once in the Supabase SQL editor. This creates no table, no trigger, no retry/recovery
-- mechanism -- purely additive functions layered on the existing asset_jobs and
-- asset_job_attempts tables.
--
-- Why: started_at (set inside claim_asset_job_with_attempt) is already database-sourced via
-- now(). completed_at/failed_at are computed the same way here from the start, so an Asset Job
-- never has the chance to develop the mixed-clock bug the Creative Job pipeline had to fix after
-- the fact -- there is no applicaton-sourced predecessor to migrate away from.
--
-- No application-supplied timestamp is accepted by either function -- there is no timestamptz
-- parameter on either signature, so a caller cannot override database time even if it wanted to.
--
-- p_outcome is guarded in the WHERE clause rather than with a trigger or CHECK constraint: an
-- invalid outcome value matches zero rows, exactly like an already-terminal job does, so an
-- out-of-band caller (these functions are callable independently of the application) cannot write
-- a job or attempt into a status these functions weren't designed to produce.
--
-- Job and attempt finishing remain two separate calls (job first, then its attempt), matching
-- creative_jobs/creative_job_attempts' own job-first/attempt-second ordering.

create or replace function finish_asset_job(p_job_id uuid, p_outcome text, p_result jsonb, p_last_error text)
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
  failed_at timestamptz
)
language sql
as $$
  update asset_jobs
  set
    status = p_outcome,
    result = case when p_outcome = 'completed' then p_result else result end,
    last_error = case when p_outcome = 'failed' then p_last_error else null end,
    completed_at = case when p_outcome = 'completed' then now() else null end,
    failed_at = case when p_outcome = 'failed' then now() else null end,
    updated_at = now()
  where id = p_job_id
    and status = 'running'
    and p_outcome in ('completed', 'failed')
  returning id, creative_package_id, status, worker_type, asset_kind, attempt_count, result,
    last_error, created_at, updated_at, started_at, completed_at, failed_at;
$$;

create or replace function finish_asset_job_attempt(p_attempt_id uuid, p_outcome text, p_error_code text, p_error_message text)
returns table (
  id uuid,
  asset_job_id uuid,
  attempt_number integer,
  worker_type text,
  status text,
  started_at timestamptz,
  completed_at timestamptz,
  latency_ms integer,
  error_code text,
  error_message text,
  provider text,
  model text,
  created_at timestamptz
)
language sql
as $$
  update asset_job_attempts
  set
    status = p_outcome,
    completed_at = now(),
    latency_ms = (extract(epoch from (now() - started_at)) * 1000)::integer,
    error_code = case when p_outcome = 'completed' then null else p_error_code end,
    error_message = case when p_outcome = 'completed' then null else p_error_message end
  where id = p_attempt_id
    and status = 'running'
    and p_outcome in ('completed', 'failed', 'timed_out')
  returning id, asset_job_id, attempt_number, worker_type, status, started_at,
    completed_at, latency_ms, error_code, error_message, provider, model, created_at;
$$;

grant execute on function finish_asset_job(uuid, text, jsonb, text) to authenticated;
grant execute on function finish_asset_job_attempt(uuid, text, text, text) to authenticated;

do $$
declare
  table_name text;
  required_column text;
  prohibited_column text;
  actual_index_columns text;
begin
  foreach table_name in array array['asset_jobs', 'asset_job_attempts', 'assets', 'asset_files']
  loop
    if to_regclass('public.' || table_name) is null then
      raise exception 'Postcondition failed: public.% does not exist.', table_name;
    end if;
  end loop;

  if (select count(*) from public.asset_jobs) <> 0 then
    raise exception 'Postcondition failed: public.asset_jobs is not empty.';
  end if;

  if (select count(*) from public.asset_job_attempts) <> 0 then
    raise exception 'Postcondition failed: public.asset_job_attempts is not empty.';
  end if;

  if (select count(*) from public.assets) <> 0 then
    raise exception 'Postcondition failed: public.assets is not empty.';
  end if;

  if (select count(*) from public.asset_files) <> 0 then
    raise exception 'Postcondition failed: public.asset_files is not empty.';
  end if;

  foreach required_column in array array['asset_job_id']
  loop
    if not exists (
      select 1
      from information_schema.columns as columns_metadata
      where columns_metadata.table_schema = 'public'
        and columns_metadata.table_name = 'assets'
        and columns_metadata.column_name = required_column
    ) then
      raise exception 'Postcondition failed: public.assets is missing column %.', required_column;
    end if;
  end loop;

  foreach prohibited_column in array array['creative_job_id', 'creative_package_id']
  loop
    if exists (
      select 1
      from information_schema.columns as columns_metadata
      where columns_metadata.table_schema = 'public'
        and columns_metadata.table_name = 'assets'
        and columns_metadata.column_name = prohibited_column
    ) then
      raise exception 'Postcondition failed: public.assets still has prohibited column %.', prohibited_column;
    end if;
  end loop;

  foreach required_column in array array[
    'position',
    'storage_bucket',
    'storage_path',
    'public_url',
    'file_size_bytes',
    'duration_ms',
    'checksum_sha256'
  ]
  loop
    if not exists (
      select 1
      from information_schema.columns as columns_metadata
      where columns_metadata.table_schema = 'public'
        and columns_metadata.table_name = 'asset_files'
        and columns_metadata.column_name = required_column
    ) then
      raise exception 'Postcondition failed: public.asset_files is missing column %.', required_column;
    end if;
  end loop;

  if not exists (
    select 1
    from pg_constraint constraint_record
    join pg_attribute attribute on attribute.attrelid = constraint_record.conrelid
      and attribute.attnum = any(constraint_record.conkey)
    join pg_attribute referenced_attribute on referenced_attribute.attrelid = constraint_record.confrelid
      and referenced_attribute.attnum = any(constraint_record.confkey)
    where constraint_record.contype = 'f'
      and constraint_record.conrelid = to_regclass('public.asset_jobs')
      and constraint_record.confrelid = to_regclass('public.creative_packages')
      and array_length(constraint_record.conkey, 1) = 1
      and array_length(constraint_record.confkey, 1) = 1
      and constraint_record.confdeltype = 'a'
      and attribute.attname = 'creative_package_id'
      and referenced_attribute.attname = 'id'
  ) then
    raise exception 'Postcondition failed: asset_jobs.creative_package_id does not reference creative_packages(id) with expected delete behavior.';
  end if;

  if not exists (
    select 1
    from pg_constraint constraint_record
    join pg_attribute attribute on attribute.attrelid = constraint_record.conrelid
      and attribute.attnum = any(constraint_record.conkey)
    join pg_attribute referenced_attribute on referenced_attribute.attrelid = constraint_record.confrelid
      and referenced_attribute.attnum = any(constraint_record.confkey)
    where constraint_record.contype = 'f'
      and constraint_record.conrelid = to_regclass('public.asset_job_attempts')
      and constraint_record.confrelid = to_regclass('public.asset_jobs')
      and array_length(constraint_record.conkey, 1) = 1
      and array_length(constraint_record.confkey, 1) = 1
      and constraint_record.confdeltype = 'c'
      and attribute.attname = 'asset_job_id'
      and referenced_attribute.attname = 'id'
  ) then
    raise exception 'Postcondition failed: asset_job_attempts.asset_job_id does not reference asset_jobs(id) with on delete cascade.';
  end if;

  if not exists (
    select 1
    from pg_constraint constraint_record
    join pg_attribute attribute on attribute.attrelid = constraint_record.conrelid
      and attribute.attnum = any(constraint_record.conkey)
    join pg_attribute referenced_attribute on referenced_attribute.attrelid = constraint_record.confrelid
      and referenced_attribute.attnum = any(constraint_record.confkey)
    where constraint_record.contype = 'f'
      and constraint_record.conrelid = to_regclass('public.assets')
      and constraint_record.confrelid = to_regclass('public.asset_jobs')
      and array_length(constraint_record.conkey, 1) = 1
      and array_length(constraint_record.confkey, 1) = 1
      and constraint_record.confdeltype = 'r'
      and attribute.attname = 'asset_job_id'
      and referenced_attribute.attname = 'id'
  ) then
    raise exception 'Postcondition failed: assets.asset_job_id does not reference asset_jobs(id) with on delete restrict.';
  end if;

  if not exists (
    select 1
    from pg_constraint constraint_record
    join pg_attribute attribute on attribute.attrelid = constraint_record.conrelid
      and attribute.attnum = any(constraint_record.conkey)
    join pg_attribute referenced_attribute on referenced_attribute.attrelid = constraint_record.confrelid
      and referenced_attribute.attnum = any(constraint_record.confkey)
    where constraint_record.contype = 'f'
      and constraint_record.conrelid = to_regclass('public.asset_files')
      and constraint_record.confrelid = to_regclass('public.assets')
      and array_length(constraint_record.conkey, 1) = 1
      and array_length(constraint_record.confkey, 1) = 1
      and constraint_record.confdeltype = 'c'
      and attribute.attname = 'asset_id'
      and referenced_attribute.attname = 'id'
  ) then
    raise exception 'Postcondition failed: asset_files.asset_id does not reference assets(id) with on delete cascade.';
  end if;

  select string_agg(attribute.attname, ',' order by key_column.ordinality)
    into actual_index_columns
  from pg_class index_class
  join pg_index index_record on index_record.indexrelid = index_class.oid
  join lateral unnest(index_record.indkey) with ordinality as key_column(attnum, ordinality) on true
  join pg_attribute attribute on attribute.attrelid = index_record.indrelid
    and attribute.attnum = key_column.attnum
  where index_class.relname = 'assets_asset_job_id_idx'
    and index_record.indisunique;

  if actual_index_columns is distinct from 'asset_job_id' then
    raise exception 'Postcondition failed: assets_asset_job_id_idx is not unique on exactly asset_job_id.';
  end if;

  select string_agg(attribute.attname, ',' order by key_column.ordinality)
    into actual_index_columns
  from pg_class index_class
  join pg_index index_record on index_record.indexrelid = index_class.oid
  join lateral unnest(index_record.indkey) with ordinality as key_column(attnum, ordinality) on true
  join pg_attribute attribute on attribute.attrelid = index_record.indrelid
    and attribute.attnum = key_column.attnum
  where index_class.relname = 'asset_files_asset_id_position_idx'
    and index_record.indisunique;

  if actual_index_columns is distinct from 'asset_id,position' then
    raise exception 'Postcondition failed: asset_files_asset_id_position_idx is not unique on exactly asset_id, position.';
  end if;

  if to_regprocedure('public.materialize_asset_with_files(uuid, uuid, jsonb, jsonb)') is not null then
    raise exception 'Postcondition failed: incompatible materialize_asset_with_files RPC still exists.';
  end if;

  if to_regprocedure('public.claim_asset_job_with_attempt(uuid)') is null then
    raise exception 'Postcondition failed: claim_asset_job_with_attempt(uuid) is missing.';
  end if;

  if to_regprocedure('public.finish_asset_job(uuid, text, jsonb, text)') is null then
    raise exception 'Postcondition failed: finish_asset_job(uuid, text, jsonb, text) is missing.';
  end if;

  if to_regprocedure('public.finish_asset_job_attempt(uuid, text, text, text)') is null then
    raise exception 'Postcondition failed: finish_asset_job_attempt(uuid, text, text, text) is missing.';
  end if;
end $$;

commit;

-- Read-only verification: run before the migration.
--
-- 1. Initial existence check. Run this first.
--
-- select to_regclass('public.assets') as assets_table,
--        to_regclass('public.asset_files') as asset_files_table,
--        to_regclass('public.asset_jobs') as asset_jobs_table,
--        to_regclass('public.asset_job_attempts') as asset_job_attempts_table;
--
-- 2. Run these count queries only after the initial to_regclass query confirms public.assets and
--    public.asset_files both exist.
--
-- select count(*) as assets_rows from public.assets;
-- select count(*) as asset_files_rows from public.asset_files;
--
-- 3. Metadata checks.
--
-- select table_name, column_name, data_type
-- from information_schema.columns
-- where table_schema = 'public'
--   and table_name in ('asset_jobs', 'asset_job_attempts', 'assets', 'asset_files')
-- order by table_name, ordinal_position;
--
-- select conrelid::regclass as child_table,
--        confrelid::regclass as parent_table,
--        conname,
--        confdeltype
-- from pg_constraint
-- where contype = 'f'
--   and (
--     confrelid = to_regclass('public.assets')
--     or conrelid = to_regclass('public.assets')
--     or conrelid = to_regclass('public.asset_files')
--     or conrelid = to_regclass('public.asset_jobs')
--     or conrelid = to_regclass('public.asset_job_attempts')
--   );
--
-- select indexname, indexdef
-- from pg_indexes
-- where schemaname = 'public'
--   and tablename in ('asset_jobs', 'asset_job_attempts', 'assets', 'asset_files')
-- order by tablename, indexname;
--
-- select p.proname, pg_get_function_identity_arguments(p.oid) as args
-- from pg_proc p
-- join pg_namespace n on n.oid = p.pronamespace
-- where n.nspname = 'public'
--   and p.proname in (
--     'materialize_asset_with_files',
--     'claim_asset_job_with_attempt',
--     'finish_asset_job',
--     'finish_asset_job_attempt'
--   );
--
-- Read-only verification: run after the migration.
--
-- Rerun the initial existence check and metadata checks above, then run:
--
-- select count(*) as asset_jobs_rows from public.asset_jobs;
-- select count(*) as asset_job_attempts_rows from public.asset_job_attempts;
-- select count(*) as assets_rows from public.assets;
-- select count(*) as asset_files_rows from public.asset_files;
--
-- Supabase SQL Editor execution order:
--
-- 1. Run the initial to_regclass verification query.
-- 2. If public.assets and public.asset_files both exist, run the count queries.
-- 3. Run the metadata/function/index verification queries.
-- 4. Run this full recovery migration file once.
-- 5. Run the post-repair verification queries.
-- 6. Preserve the SQL Editor output for review.
--
-- Retry instructions:
--
-- If the preflight block raises, stop and report the exact message. Do not edit the live schema
-- manually to make the migration pass. If execution fails before commit, PostgreSQL rolls back the
-- transaction; rerun the read-only verification queries before retrying. If any Asset subsystem
-- table contains rows, do not retry this migration without a separate preservation plan.
