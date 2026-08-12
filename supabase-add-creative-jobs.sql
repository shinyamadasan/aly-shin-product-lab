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
--
-- AI-readiness note: last_error is intentionally plain nullable text. It stores bounded
-- operator-facing failure diagnostics only, not stack traces, prompts, raw responses, credentials,
-- provider names, model names, tokens, or execution history.

create table if not exists creative_jobs (
  id uuid primary key default gen_random_uuid(),
  -- Nullable since Content Creation MVP S1: a Creative Job may originate from an Opportunity OR
  -- from a direct owner request, never both and never neither (creative_jobs_origin_check below).
  -- A request-backed job genuinely has no Opportunity, and the schema says so rather than pointing
  -- at a fabricated one. Existing projects get here via supabase-add-creative-job-manual-origin.sql.
  opportunity_id uuid references opportunities(id),
  -- The owner's request, for request-backed jobs only: '{}' for Opportunity-backed jobs. Holds the
  -- typed context (subject/requestText), never a generated creative decision.
  intent jsonb not null default '{}'::jsonb,
  status text not null default 'queued',
  worker_type text not null default 'mock',
  attempt_count integer not null default 0,
  result jsonb not null default '{}'::jsonb,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  failed_at timestamptz
);

alter table creative_jobs
  add column if not exists last_error text;

-- Same idempotent-add convention as last_error above, so a project that created this table before
-- S1 picks up `intent` by re-running this file. Dropping opportunity_id's NOT NULL and installing
-- the XOR constraint are handled by supabase-add-creative-job-manual-origin.sql, which is the
-- migration for already-live tables; this file only ever adds.
alter table creative_jobs
  add column if not exists intent jsonb not null default '{}'::jsonb;

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
      -- Nullable as of S1 -- see the column comment above. Asserted as nullable on purpose: a
      -- project still carrying NOT NULL here has not run
      -- supabase-add-creative-job-manual-origin.sql, and request-backed jobs would fail at insert.
      ('opportunity_id', 'uuid', false),
      ('intent', 'jsonb', true),
      ('status', 'text', true),
      ('worker_type', 'text', true),
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
      -- The one nullability mismatch with a known, one-command fix: a pre-S1 project still has
      -- opportunity_id NOT NULL. "Reconcile the stale draft table" would send the operator into
      -- manual surgery when the migration shipping beside this file is the whole answer.
      if required_column.column_name = 'opportunity_id' and actual_not_null then
        raise exception 'creative_jobs.opportunity_id is still NOT NULL, so this project predates Content Creation MVP S1. Run supabase-add-creative-job-manual-origin.sql once, then re-run this file.';
      end if;

      raise exception 'creative_jobs column % nullability is %, expected %; reconcile the stale draft table before continuing.', required_column.column_name, actual_not_null, required_column.is_required;
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
      ('max_retries')
    ) as excluded(column_name)
  loop
    if exists (
      select 1
      from pg_attribute attribute
      join pg_class table_class on table_class.oid = attribute.attrelid
      join pg_namespace namespace on namespace.oid = table_class.relnamespace
      where namespace.nspname = 'public'
        and table_class.relname = 'creative_jobs'
        and attribute.attname = disallowed_column
        and not attribute.attisdropped
    ) then
      raise exception 'creative_jobs table has disallowed column %; reconcile the stale draft table before continuing.', disallowed_column;
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

-- Exactly one origin per job, enforced by the database rather than by application convention.
-- Both-at-once would make "what caused this job" ambiguous; neither-at-all would make it
-- unanswerable. Added conditionally rather than dropped-and-re-added, so this file keeps its
-- "only ever adds, never drops" property (asserted by tests/creative-jobs-schema.test.ts).
do $$
begin
  if not exists (
    select 1
    from pg_constraint constraint_record
    join pg_class table_class on table_class.oid = constraint_record.conrelid
    join pg_namespace namespace on namespace.oid = table_class.relnamespace
    where namespace.nspname = 'public'
      and table_class.relname = 'creative_jobs'
      and constraint_record.contype = 'c'
      and constraint_record.conname = 'creative_jobs_origin_check'
  ) then
    alter table creative_jobs
      add constraint creative_jobs_origin_check
      check (
        (opportunity_id is not null and intent = '{}'::jsonb)
        or (opportunity_id is null and intent <> '{}'::jsonb)
      );
  end if;
end $$;

-- Partial: one Creative Job per Opportunity still holds, while request-backed jobs (opportunity_id
-- null) are deliberately unconstrained -- asking twice for the same thing on the same day is an
-- ordinary action and must produce two distinct jobs. Postgres already treats NULLs as distinct in
-- a unique index; the predicate states that intent explicitly and survives a later NULLS NOT DISTINCT.
create unique index if not exists creative_jobs_opportunity_id_idx
  on creative_jobs (opportunity_id)
  where opportunity_id is not null;

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

  -- The WHERE predicate is asserted, not just the uniqueness: a project still carrying the old
  -- unconditional unique index would reject a second request-backed job under NULLS NOT DISTINCT,
  -- so "unique on opportunity_id" alone is no longer a sufficient check.
  if index_definition is null or index_definition !~* 'unique index.*\(opportunity_id\).*where.*opportunity_id is not null' then
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

  -- Verified here rather than in the preflight block above, because this file adds the constraint
  -- itself a few statements earlier -- checking before that point would fail every fresh install.
  if not exists (
    select 1
    from pg_constraint constraint_record
    join pg_class table_class on table_class.oid = constraint_record.conrelid
    join pg_namespace namespace on namespace.oid = table_class.relnamespace
    where namespace.nspname = 'public'
      and table_class.relname = 'creative_jobs'
      and constraint_record.contype = 'c'
      and constraint_record.conname = 'creative_jobs_origin_check'
  ) then
    raise exception 'creative_jobs_origin_check is missing; a pre-S1 table needs supabase-add-creative-job-manual-origin.sql before request-backed Creative Jobs will work.';
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
