-- Content Creation MVP S3E-A1: persist the S3C-D AI execution trace on the Creative Job attempt,
-- and add the trace-aware finish RPC that writes it. Safe to run more than once in the Supabase SQL
-- editor.
--
-- This migration is ADDITIVE ONLY. It creates no table, drops no column, drops no function, rewrites
-- no historical row, and changes no existing function's behaviour or signature. It exists so that
-- the AI executor built in the NEXT slice has somewhere honest to put what it already produces --
-- nothing here invokes AI, selects a provider, retries, or schedules anything.
--
-- WHAT THIS ADDS
--
--   1. creative_job_attempts.ai_execution_trace jsonb  (nullable, no default)
--   2. finish_creative_job_attempt_with_trace(...)     (new; the existing finish RPC is untouched)
--
-- Fresh installs get the column from supabase-add-creative-job-attempts.sql, which now declares it
-- and also carries the same idempotent `add column if not exists`. This file is what an
-- already-live S3C-D-era database runs, and it is written so that running it on a fresh install is
-- a harmless no-op for the column and the sole source of the RPC. Both paths converge on the same
-- logical schema.
--
-- NULL, NOT '[]'
--
-- Every attempt written before this migration keeps ai_execution_trace NULL, and nothing backfills
-- them. An attempt that ran no AI has no AI execution history; an empty array would assert that AI
-- ran and produced no invocations, which is a different -- and false -- claim. Non-AI workers stay
-- valid and keep calling the original finish_creative_job_attempt.
--
-- WHY A NEW FUNCTION RATHER THAN A CHANGED ONE
--
-- finish_creative_job_attempt is a live public interface with existing callers. PostgreSQL would
-- also reject CREATE OR REPLACE on a changed return type, forcing a DROP -- and dropping a working
-- function to add an optional argument trades a real outage risk for no benefit. The trace-aware
-- sibling is added beside it; the original is neither renamed nor removed, and application code
-- still calls it for every attempt that has no trace.
--
-- PHYSICAL COLUMN ORDER (the H1 lesson, applied deliberately rather than assumed away)
--
-- Adding a column to creative_job_attempts is only safe because nothing couples to that table's
-- physical order. Audited before writing this file:
--
--   * claim_creative_job_with_attempt  -- inserts with a NAMED column list, and its CTE returns
--                                         `id as attempt_id, creative_job_id, attempt_number` by
--                                         name. Its `returning *` is on creative_jobs, not on
--                                         creative_job_attempts, and is consumed by an explicitly
--                                         named final select (that IS the H1 fix). Unaffected.
--   * finish_creative_job_attempt      -- RETURNING names all 13 columns explicitly. A 14th column
--                                         is simply not returned. Unaffected.
--   * finish_creative_job              -- does not touch creative_job_attempts at all.
--   * application code                 -- creative-job-attempts.ts reads the RPC result by KEY into
--                                         a named row type; there is no positional decoding and no
--                                         `select *` against this table anywhere.
--
-- The new function below follows the same discipline: it names every column it returns, so a future
-- appended column is a no-op here rather than an outage.
--
-- SECURITY / PRIVACY. The trace stores only the provider-neutral operational metadata S3C-D already
-- defines (stage, provider id, model, invocation counters, outcome, failure reason, duration,
-- routing action). No credentials, tokens, auth state, prompts, raw model responses, stdout, stderr,
-- CLI logs or environment dumps. Bounding is the application's: S3C-D already caps invocations at 6
-- without a format hint and 4 with one, and this migration deliberately adds no second size system.
--
-- ROLLBACK. To undo (the column is additive and holds only diagnostics, so dropping it loses no
-- Creative Job, attempt or Creative Package):
--   drop function if exists finish_creative_job_attempt_with_trace(uuid, text, text, text, jsonb);
--   alter table creative_job_attempts drop column if exists ai_execution_trace;
-- finish_creative_job_attempt is untouched by this file, so it keeps working either way.

-- Preflight: refuse to run against a database that is not the shape this migration expects.
do $$
declare
  required_column text;
  actual_type text;
  actual_not_null boolean;
begin
  if to_regclass('public.creative_job_attempts') is null then
    raise exception 'creative_job_attempts does not exist; run supabase-add-creative-job-attempts.sql first.';
  end if;

  if to_regclass('public.creative_jobs') is null then
    raise exception 'creative_jobs does not exist; run supabase-add-creative-jobs.sql first.';
  end if;

  -- The columns this migration's new function reads and writes must already exist and be the shape
  -- it assumes, or the function it creates would be broken at first call rather than at install.
  for required_column in
    select expected.column_name
    from (values ('id'), ('status'), ('started_at'), ('completed_at'), ('latency_ms'), ('error_code'), ('error_message')) as expected(column_name)
  loop
    if not exists (
      select 1
      from pg_attribute attribute
      join pg_class table_class on table_class.oid = attribute.attrelid
      join pg_namespace namespace on namespace.oid = table_class.relnamespace
      where namespace.nspname = 'public'
        and table_class.relname = 'creative_job_attempts'
        and attribute.attname = required_column
        and not attribute.attisdropped
    ) then
      raise exception 'creative_job_attempts is missing required column %; reconcile the table before continuing.', required_column;
    end if;
  end loop;

  -- If ai_execution_trace already exists (fresh install, or a re-run of this file), it must be
  -- nullable jsonb. A pre-existing column of another type or with NOT NULL is a stale draft that an
  -- operator has to reconcile deliberately -- this migration will not silently alter it.
  select format_type(attribute.atttypid, attribute.atttypmod), attribute.attnotnull
    into actual_type, actual_not_null
  from pg_attribute attribute
  join pg_class table_class on table_class.oid = attribute.attrelid
  join pg_namespace namespace on namespace.oid = table_class.relnamespace
  where namespace.nspname = 'public'
    and table_class.relname = 'creative_job_attempts'
    and attribute.attname = 'ai_execution_trace'
    and not attribute.attisdropped;

  if actual_type is not null and actual_type <> 'jsonb' then
    raise exception 'creative_job_attempts.ai_execution_trace already exists with type %, expected jsonb; reconcile the stale draft column before continuing.', actual_type;
  end if;

  if actual_not_null then
    raise exception 'creative_job_attempts.ai_execution_trace already exists as NOT NULL; it must be nullable so attempts that ran no AI can state that absence rather than fabricate an empty trace.';
  end if;
end $$;

-- 1. The additive column. No default: an attempt that ran no AI has no trace, and NULL says so.
alter table creative_job_attempts
  add column if not exists ai_execution_trace jsonb;

-- 2. The trace-aware finish RPC, added BESIDE finish_creative_job_attempt, which this file neither
-- renames, drops, replaces nor alters.
--
-- Identical completion semantics to the original, plus the trace: the same outcomes ('completed',
-- 'failed', 'timed_out'), the same status = 'running' precondition, the same database-sourced
-- completed_at/latency_ms, and the same guard style -- an invalid outcome matches zero rows exactly
-- like an already-terminal attempt does. There is no timestamptz parameter here either, so a caller
-- cannot override database time.
--
-- The trace is written on EVERY supported outcome, success and failure alike. A failed or timed-out
-- AI attempt is precisely when the execution history matters most, and discarding it on failure
-- would leave the operator with a bounded error message and no account of what was tried.
--
-- This function does not fabricate success, create Creative Packages, invoke AI, choose providers,
-- or retry. It records what already happened.
create or replace function finish_creative_job_attempt_with_trace(
  p_attempt_id uuid,
  p_outcome text,
  p_error_code text,
  p_error_message text,
  p_ai_execution_trace jsonb
)
returns table (
  id uuid,
  creative_job_id uuid,
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
  ai_execution_trace jsonb,
  created_at timestamptz
)
language sql
as $$
  update creative_job_attempts
  set
    status = p_outcome,
    completed_at = now(),
    latency_ms = (extract(epoch from (now() - started_at)) * 1000)::integer,
    error_code = case when p_outcome = 'completed' then null else p_error_code end,
    error_message = case when p_outcome = 'completed' then null else p_error_message end,
    ai_execution_trace = p_ai_execution_trace
  where id = p_attempt_id
    and status = 'running'
    and p_outcome in ('completed', 'failed', 'timed_out')
  returning id, creative_job_id, attempt_number, worker_type, status, started_at,
    completed_at, latency_ms, error_code, error_message, provider, model,
    ai_execution_trace, created_at;
$$;

grant execute on function finish_creative_job_attempt_with_trace(uuid, text, text, text, jsonb) to authenticated;

-- Verification: the shape this migration promised is the shape that now exists.
do $$
declare
  actual_type text;
  actual_not_null boolean;
begin
  select format_type(attribute.atttypid, attribute.atttypmod), attribute.attnotnull
    into actual_type, actual_not_null
  from pg_attribute attribute
  join pg_class table_class on table_class.oid = attribute.attrelid
  join pg_namespace namespace on namespace.oid = table_class.relnamespace
  where namespace.nspname = 'public'
    and table_class.relname = 'creative_job_attempts'
    and attribute.attname = 'ai_execution_trace'
    and not attribute.attisdropped;

  if actual_type is null then
    raise exception 'creative_job_attempts.ai_execution_trace was not created; investigate before relying on AI execution traces.';
  end if;
  if actual_type <> 'jsonb' then
    raise exception 'creative_job_attempts.ai_execution_trace has type %, expected jsonb.', actual_type;
  end if;
  if actual_not_null then
    raise exception 'creative_job_attempts.ai_execution_trace is NOT NULL; it must be nullable so attempts that ran no AI can state that absence.';
  end if;

  -- The original must still be there. This migration adds a sibling; it does not supersede.
  if to_regprocedure('public.finish_creative_job_attempt(uuid, text, text, text)') is null then
    raise exception 'finish_creative_job_attempt is missing; this migration must never remove it -- run supabase-add-creative-job-finish-functions.sql.';
  end if;
  if to_regprocedure('public.finish_creative_job_attempt_with_trace(uuid, text, text, text, jsonb)') is null then
    raise exception 'finish_creative_job_attempt_with_trace was not created; investigate before relying on AI execution traces.';
  end if;
end $$;
