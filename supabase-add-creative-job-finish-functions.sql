-- Creative Job / Attempt terminal timestamps: single database clock source. Safe to run more
-- than once in the Supabase SQL editor. This creates no table, no trigger, no retry/recovery
-- mechanism -- purely additive functions layered on the existing creative_jobs and
-- creative_job_attempts tables.
--
-- Why: started_at (set inside claim_creative_job_with_attempt) was always database-sourced via
-- now(). completed_at/failed_at were previously application-sourced (new Date().toISOString() on
-- the calling Node process), a different clock that can drift from the database's, producing a
-- terminal record where completed_at appears earlier than started_at. These two functions move
-- job and attempt completion/failure onto the same now() the claim already uses, eliminating the
-- possibility of a mixed-clock terminal record structurally, not just by convention.
--
-- No application-supplied timestamp is accepted by either function -- there is no timestamptz
-- parameter on either signature, so a caller cannot override database time even if it wanted to.
--
-- p_outcome is guarded in the WHERE clause rather than with a trigger or CHECK constraint: an
-- invalid outcome value matches zero rows, exactly like an already-terminal job does, so an
-- out-of-band caller (these functions are callable independently of the application) cannot write
-- a job or attempt into a status these functions weren't designed to produce.
--
-- Job and attempt finishing remain two separate calls (job first, then its attempt), matching the
-- existing job-first/attempt-second ordering from supabase-add-creative-job-attempts.sql -- this
-- file does not reopen that atomicity boundary, only the clock source each individual write uses.

create or replace function finish_creative_job(p_job_id uuid, p_outcome text, p_result jsonb, p_last_error text)
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
  failed_at timestamptz
)
language sql
as $$
  update creative_jobs
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
  returning id, opportunity_id, status, worker_type, attempt_count, result,
    last_error, created_at, updated_at, started_at, completed_at, failed_at;
$$;

create or replace function finish_creative_job_attempt(p_attempt_id uuid, p_outcome text, p_error_code text, p_error_message text)
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
    error_message = case when p_outcome = 'completed' then null else p_error_message end
  where id = p_attempt_id
    and status = 'running'
    and p_outcome in ('completed', 'failed', 'timed_out')
  returning id, creative_job_id, attempt_number, worker_type, status, started_at,
    completed_at, latency_ms, error_code, error_message, provider, model, created_at;
$$;

grant execute on function finish_creative_job(uuid, text, jsonb, text) to authenticated;
grant execute on function finish_creative_job_attempt(uuid, text, text, text) to authenticated;
