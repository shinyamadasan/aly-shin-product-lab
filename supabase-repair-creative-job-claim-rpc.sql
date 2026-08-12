-- H1: repair claim_creative_job_with_attempt after S1 added creative_jobs.intent.
-- Safe to run more than once in the Supabase SQL editor.
--
-- WHY THIS EXISTS
--
-- The function paired a hand-written RETURNS TABLE with `select claimed.*`, which coupled its
-- declared result shape to the table's physical column order. S1
-- (supabase-add-creative-job-manual-origin.sql) appended `intent`, so `claimed.*` began returning
-- one more column than the declaration allowed and EVERY call started failing:
--
--   ERROR: return type mismatch in function declared to return record
--   DETAIL: Final statement returns jsonb instead of uuid at column 13.
--
-- That breaks BOTH Opportunity-backed and request-backed Creative Jobs -- claimQueuedCreativeJob-
-- WithAttempt is the only claim path runCreativeJobWithExecutors uses, so no Creative Job can
-- execute at all. It has gone unnoticed only because no Creative Job exists yet.
--
-- WHAT THIS CHANGES
--
-- Only the function. No table, column, index, constraint, policy, grant or row is touched, and no
-- claim semantics change: the same atomic `update ... where status = 'queued'`, the same attempt
-- insert, the same attempt numbering. The final select now NAMES each column instead of using
-- `claimed.*`, which is what makes it independent of physical column order -- necessary because a
-- fresh install declares `intent` third while a migrated table has it appended last, and no single
-- star-expansion can satisfy both.
--
-- DROP is required: PostgreSQL rejects CREATE OR REPLACE when the declared return type changes
-- ("cannot change return type of existing function"). DDL is transactional in PostgreSQL, so the
-- drop and create below commit together -- there is no window where the function is missing.
--
-- ROLLBACK. This function is strictly more correct than what it replaces and the previous
-- definition is broken on any S1-migrated database, so rolling back is not advised. If you must,
-- re-run the copy in supabase-add-creative-job-attempts.sql as it existed before H1.

-- Preflight: refuse to run unless the expected objects are present and the expected shape holds.
do $$
declare
  intent_type text;
begin
  if to_regclass('public.creative_jobs') is null then
    raise exception 'creative_jobs does not exist; run supabase-add-creative-jobs.sql first.';
  end if;

  if to_regclass('public.creative_job_attempts') is null then
    raise exception 'creative_job_attempts does not exist; run supabase-add-creative-job-attempts.sql first.';
  end if;

  select format_type(attribute.atttypid, attribute.atttypmod)
    into intent_type
  from pg_attribute attribute
  join pg_class table_class on table_class.oid = attribute.attrelid
  join pg_namespace namespace on namespace.oid = table_class.relnamespace
  where namespace.nspname = 'public'
    and table_class.relname = 'creative_jobs'
    and attribute.attname = 'intent'
    and not attribute.attisdropped;

  -- The repaired function returns `intent`, so the column has to exist first. A database that has
  -- not run S1 yet does not have the defect this file repairs.
  if intent_type is null then
    raise exception 'creative_jobs.intent does not exist, so this database predates S1 and does not need this repair. Run supabase-add-creative-job-manual-origin.sql first if you intended to migrate it.';
  end if;

  if intent_type <> 'jsonb' then
    raise exception 'creative_jobs.intent has type %, expected jsonb; reconcile the table before repairing this function.', intent_type;
  end if;
end $$;

drop function if exists claim_creative_job_with_attempt(uuid);

create function claim_creative_job_with_attempt(p_job_id uuid)
returns table (
  id uuid,
  opportunity_id uuid,
  status text,
  worker_type text,
  attempt_count integer,
  result jsonb,
  last_error text,
  created_at timestamptz,
  updated_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  failed_at timestamptz,
  intent jsonb,
  attempt_id uuid,
  attempt_number integer
)
language sql
as $$
  with claimed as (
    update creative_jobs
    set
      status = 'running',
      started_at = now(),
      attempt_count = attempt_count + 1,
      updated_at = now()
    where id = p_job_id
      and status = 'queued'
    returning *
  ), inserted_attempt as (
    insert into creative_job_attempts (creative_job_id, attempt_number, worker_type, status, started_at)
    select claimed.id, claimed.attempt_count, claimed.worker_type, 'running', claimed.started_at
    from claimed
    returning id as attempt_id, creative_job_id, attempt_number
  )
  select
    claimed.id,
    claimed.opportunity_id,
    claimed.status,
    claimed.worker_type,
    claimed.attempt_count,
    claimed.result,
    claimed.last_error,
    claimed.created_at,
    claimed.updated_at,
    claimed.started_at,
    claimed.completed_at,
    claimed.failed_at,
    claimed.intent,
    inserted_attempt.attempt_id,
    inserted_attempt.attempt_number
  from claimed
  join inserted_attempt on inserted_attempt.creative_job_id = claimed.id;
$$;

-- The grant is re-applied because DROP FUNCTION discards privileges with the function.
grant execute on function claim_creative_job_with_attempt(uuid) to authenticated;

-- Verification: the repaired function exists, returns `intent`, and is actually callable. The call
-- below targets an all-zero UUID that cannot match a real row, so it claims nothing and writes
-- nothing -- but it still forces PostgreSQL to resolve the function's result shape, which is
-- exactly the step that was failing before this repair.
do $$
declare
  returns_intent boolean;
  claimed_count integer;
begin
  select exists (
    select 1
    from pg_proc proc
    join pg_namespace namespace on namespace.oid = proc.pronamespace
    join lateral unnest(proc.proallargtypes, proc.proargnames) as arg(type_oid, arg_name) on true
    where namespace.nspname = 'public'
      and proc.proname = 'claim_creative_job_with_attempt'
      and arg.arg_name = 'intent'
  ) into returns_intent;

  if not returns_intent then
    raise exception 'claim_creative_job_with_attempt was not recreated with an intent output column.';
  end if;

  select count(*) into claimed_count
  from claim_creative_job_with_attempt('00000000-0000-0000-0000-000000000000'::uuid);

  if claimed_count <> 0 then
    raise exception 'claim_creative_job_with_attempt claimed % row(s) for a non-existent job id; investigate before relying on it.', claimed_count;
  end if;
end $$;
