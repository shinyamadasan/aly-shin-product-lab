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
