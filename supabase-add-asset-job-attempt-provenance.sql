-- Asset Job Attempt provider/model provenance: make execution provenance DURABLE for machine
-- generation attempts. Safe to run more than once in the Supabase SQL editor. This creates no table,
-- no column, no trigger, no index, no retry/recovery mechanism and no scheduler -- it adds exactly
-- one function beside the existing one.
--
-- THE GAP THIS CLOSES
--
-- asset_job_attempts.provider and .model already exist as nullable text columns (see
-- supabase-add-asset-job-attempts.sql, which created them for "the first-real-provider milestone to
-- populate"). fromAssetJobAttemptRow already reads them back. Nothing could WRITE them:
-- finish_asset_job_attempt takes exactly (p_attempt_id, p_outcome, p_error_code, p_error_message)
-- and sets neither column, and AssetJobAttemptClient deliberately exposes no from()/update() path.
-- So provider/model were structurally unreachable rather than merely unused.
--
-- This migration adds NO COLUMNS. The columns are already correct; only the writer was missing.
--
-- WHY A NEW FUNCTION RATHER THAN A WIDER SIGNATURE ON THE OLD ONE
--
-- This mirrors supabase-add-creative-job-ai-execution-trace.sql exactly, which faced the identical
-- problem (an attempt-finish RPC that needed one more piece of execution provenance) and solved it
-- by adding finish_creative_job_attempt_with_trace BESIDE finish_creative_job_attempt rather than
-- changing it. That is this repository's established convention for evolving a finish RPC, and the
-- reasons are concrete:
--
--   1. Adding `p_provider text default null, p_model text default null` to the EXISTING function
--      does not replace it -- `create or replace` matches on signature, so PostgreSQL would end up
--      holding BOTH a 4-argument and a 6-argument finish_asset_job_attempt. A 4-argument call then
--      matches both candidates equally and fails with "function ... is not unique", breaking every
--      existing caller. Avoiding that requires dropping the shipped 4-argument function first.
--
--   2. supabase-add-asset-job-finish-functions.sql is documented as additive and re-runnable, and
--      supabase-recover-prop023-asset-schema.sql recreates the 4-argument function and asserts its
--      existence as a postcondition. Changing the signature in one place would leave the recovery
--      script recreating a superseded function -- and, after this file had run, reintroducing the
--      exact ambiguity in (1). Adding a distinctly-named function keeps all three files true.
--
--   3. Rollback is a single drop that loses nothing (see ROLLBACK below).
--
-- finish_asset_job_attempt is neither renamed, dropped, replaced nor altered by this file, and an
-- attempt with no provider provenance still calls it byte for byte.
--
-- SINGLE-WRITER CONTRACT PRESERVED
--
-- asset_job_attempts is still written only through claim_asset_job_with_attempt (insert) and the two
-- finish RPCs. This file grants no table-level privilege, adds no policy, and creates no path for a
-- client to UPDATE asset_job_attempts directly.
--
-- SECURITY / PRIVACY
--
-- Only two short provider-neutral identifiers are stored: which provider was used and which model.
-- No prompt text, no reference image bytes, no credentials, no authorization header, no raw provider
-- request or response, no stack trace. That is the same bound asset_job_attempts' own header already
-- sets for error_message, and this migration deliberately does not widen it. The richer execution
-- provenance the application computes (prompt digest, reference identities, transport attempt count)
-- is deliberately NOT persisted here -- no column exists for it, and this file adds none.
--
-- TRUTHFULNESS
--
-- provider/model are written on every supported outcome, success and failure alike. A failed or
-- timed-out provider attempt is precisely when "which model did we actually call" matters most.
-- They are written only when the caller actually selected a provider and attempted a request; an
-- attempt that failed BEFORE provider selection passes NULL and stays NULL, so a null provider
-- truthfully means "no provider was contacted". coalesce is used so a re-run or a later finish can
-- never erase a value that was already recorded.
--
-- This function does not fabricate success, invoke a provider, choose a model, or retry. It records
-- what already happened.
--
-- ROLLBACK. To undo (nothing is lost -- the columns predate this file and existing rows keep
-- whatever they hold):
--   drop function if exists finish_asset_job_attempt_with_provenance(uuid, text, text, text, text, text);
-- finish_asset_job_attempt is untouched by this file, so it keeps working either way.

-- Preflight: refuse to run against a database that is not the shape this migration expects.
do $$
declare
  required_column text;
  actual_type text;
  actual_not_null boolean;
begin
  if to_regclass('public.asset_job_attempts') is null then
    raise exception 'asset_job_attempts does not exist; run supabase-add-asset-job-attempts.sql first.';
  end if;

  if to_regprocedure('public.finish_asset_job_attempt(uuid, text, text, text)') is null then
    raise exception 'finish_asset_job_attempt(uuid, text, text, text) is missing; run supabase-add-asset-job-finish-functions.sql first.';
  end if;

  -- Every column this migration's new function reads or writes must already exist, or the function
  -- it creates would break at first call rather than at install.
  for required_column in
    select expected.column_name
    from (values ('id'), ('status'), ('started_at'), ('completed_at'), ('latency_ms'), ('error_code'), ('error_message'), ('provider'), ('model')) as expected(column_name)
  loop
    if not exists (
      select 1
      from pg_attribute attribute
      join pg_class table_class on table_class.oid = attribute.attrelid
      join pg_namespace namespace on namespace.oid = table_class.relnamespace
      where namespace.nspname = 'public'
        and table_class.relname = 'asset_job_attempts'
        and attribute.attname = required_column
        and not attribute.attisdropped
    ) then
      raise exception 'asset_job_attempts is missing required column %; reconcile the table before continuing.', required_column;
    end if;
  end loop;

  -- provider/model must be exactly what supabase-add-asset-job-attempts.sql promised: nullable text.
  -- A different type, or a NOT NULL, is a stale draft an operator has to reconcile deliberately --
  -- this migration will not silently alter a column.
  for required_column in
    select expected.column_name from (values ('provider'), ('model')) as expected(column_name)
  loop
    select format_type(attribute.atttypid, attribute.atttypmod), attribute.attnotnull
      into actual_type, actual_not_null
    from pg_attribute attribute
    join pg_class table_class on table_class.oid = attribute.attrelid
    join pg_namespace namespace on namespace.oid = table_class.relnamespace
    where namespace.nspname = 'public'
      and table_class.relname = 'asset_job_attempts'
      and attribute.attname = required_column;

    if actual_type <> 'text' then
      raise exception 'asset_job_attempts.% must be text, found %.', required_column, actual_type;
    end if;

    if actual_not_null then
      raise exception 'asset_job_attempts.% must be nullable; an attempt that contacted no provider has no provider.', required_column;
    end if;
  end loop;
end;
$$;

-- The provenance-aware finish RPC, added BESIDE finish_asset_job_attempt, which this file neither
-- renames, drops, replaces nor alters.
--
-- Identical completion semantics to the original, plus the provenance: the same outcomes
-- ('completed', 'failed', 'timed_out'), the same status = 'running' precondition, the same
-- database-sourced completed_at/latency_ms, and the same guard style -- an invalid outcome matches
-- zero rows exactly like an already-terminal attempt does. There is no timestamptz parameter here
-- either, so a caller cannot override database time.
create or replace function finish_asset_job_attempt_with_provenance(
  p_attempt_id uuid,
  p_outcome text,
  p_error_code text,
  p_error_message text,
  p_provider text default null,
  p_model text default null
)
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
    error_message = case when p_outcome = 'completed' then null else p_error_message end,
    provider = coalesce(p_provider, provider),
    model = coalesce(p_model, model)
  where id = p_attempt_id
    and status = 'running'
    and p_outcome in ('completed', 'failed', 'timed_out')
  returning id, asset_job_id, attempt_number, worker_type, status, started_at,
    completed_at, latency_ms, error_code, error_message, provider, model, created_at;
$$;

grant execute on function finish_asset_job_attempt_with_provenance(uuid, text, text, text, text, text) to authenticated;

-- Verification: the shape this migration promised is the shape that now exists, and the function it
-- promised NOT to touch is still there.
do $$
begin
  if to_regprocedure('public.finish_asset_job_attempt_with_provenance(uuid, text, text, text, text, text)') is null then
    raise exception 'Postcondition failed: finish_asset_job_attempt_with_provenance(uuid, text, text, text, text, text) is missing.';
  end if;

  if to_regprocedure('public.finish_asset_job_attempt(uuid, text, text, text)') is null then
    raise exception 'Postcondition failed: this migration must leave finish_asset_job_attempt(uuid, text, text, text) intact.';
  end if;
end;
$$;
