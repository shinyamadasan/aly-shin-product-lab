-- Content Creation MVP S1: a Creative Job may originate from an Opportunity OR from a direct owner
-- request. Safe to run more than once in the Supabase SQL editor.
--
-- Before this migration, creative_jobs.opportunity_id was NOT NULL with an unconditional unique
-- index, so every Creative Job required an Opportunity. Opportunities recommend content; they were
-- never meant to authorize it. This migration removes that gate without weakening the invariant
-- that still matters -- one Creative Job per Opportunity.
--
-- What this does, and does not do:
--   * drops NOT NULL from opportunity_id            (widening -- no data is read, written, or lost)
--   * adds `intent jsonb not null default '{}'`     (additive)
--   * replaces the unique index with a PARTIAL one  (index-only; the Opportunity rule is preserved)
--   * adds creative_jobs_origin_check               (constraint-only)
--
-- It creates no table, drops no column, and touches no row. Every existing row keeps a non-null
-- opportunity_id and the default '{}' intent, so every existing row already satisfies the new
-- constraint -- the preflight below proves that before the constraint is added, rather than
-- assuming it.
--
-- ROLLBACK. To undo (only valid while no request-backed job exists -- the first guard below is the
-- same check in reverse):
--   alter table creative_jobs drop constraint if exists creative_jobs_origin_check;
--   drop index if exists creative_jobs_opportunity_id_idx;
--   create unique index creative_jobs_opportunity_id_idx on creative_jobs (opportunity_id);
--   alter table creative_jobs alter column opportunity_id set not null;
--   alter table creative_jobs drop column if exists intent;
-- The SET NOT NULL will fail if any request-backed job exists; delete or re-home those rows first.

-- Preflight: refuse to run against a table that is not the shape this migration expects.
do $$
declare
  opportunity_id_type text;
  violating_rows bigint;
begin
  if to_regclass('public.creative_jobs') is null then
    raise exception 'creative_jobs table does not exist; run supabase-add-creative-jobs.sql first.';
  end if;

  select format_type(attribute.atttypid, attribute.atttypmod)
    into opportunity_id_type
  from pg_attribute attribute
  join pg_class table_class on table_class.oid = attribute.attrelid
  join pg_namespace namespace on namespace.oid = table_class.relnamespace
  where namespace.nspname = 'public'
    and table_class.relname = 'creative_jobs'
    and attribute.attname = 'opportunity_id'
    and not attribute.attisdropped;

  if opportunity_id_type is null then
    raise exception 'creative_jobs.opportunity_id does not exist; reconcile the table before continuing.';
  end if;

  if opportunity_id_type <> 'uuid' then
    raise exception 'creative_jobs.opportunity_id has type %, expected uuid; reconcile the table before continuing.', opportunity_id_type;
  end if;

  -- Proof, not assumption, that every existing row already satisfies the constraint added below.
  -- Only meaningful once `intent` exists; on a pre-S1 table there is nothing yet to violate.
  if exists (
    select 1
    from pg_attribute attribute
    join pg_class table_class on table_class.oid = attribute.attrelid
    join pg_namespace namespace on namespace.oid = table_class.relnamespace
    where namespace.nspname = 'public'
      and table_class.relname = 'creative_jobs'
      and attribute.attname = 'intent'
      and not attribute.attisdropped
  ) then
    execute $check$
      select count(*)
      from creative_jobs
      where not (
        (opportunity_id is not null and intent = '{}'::jsonb)
        or (opportunity_id is null and intent <> '{}'::jsonb)
      )
    $check$ into violating_rows;

    if violating_rows > 0 then
      raise exception 'creative_jobs has % row(s) that satisfy neither origin (an Opportunity, or a non-empty intent); reconcile them before adding creative_jobs_origin_check.', violating_rows;
    end if;
  end if;
end $$;

alter table creative_jobs
  add column if not exists intent jsonb not null default '{}'::jsonb;

alter table creative_jobs
  alter column opportunity_id drop not null;

-- One Creative Job per Opportunity still holds. Request-backed jobs (opportunity_id null) are
-- deliberately unconstrained: asking twice for the same thing on the same day is an ordinary
-- action and must produce two distinct jobs. Postgres already treats NULLs as distinct in a unique
-- index; the predicate states that intent explicitly and survives a later NULLS NOT DISTINCT.
drop index if exists creative_jobs_opportunity_id_idx;
create unique index creative_jobs_opportunity_id_idx
  on creative_jobs (opportunity_id)
  where opportunity_id is not null;

-- Exactly one origin per job, enforced by the database rather than by application convention.
alter table creative_jobs
  drop constraint if exists creative_jobs_origin_check;
alter table creative_jobs
  add constraint creative_jobs_origin_check
  check (
    (opportunity_id is not null and intent = '{}'::jsonb)
    or (opportunity_id is null and intent <> '{}'::jsonb)
  );

-- Verification: the shape this migration promised is the shape that now exists.
do $$
declare
  index_definition text;
begin
  if (
    select attribute.attnotnull
    from pg_attribute attribute
    join pg_class table_class on table_class.oid = attribute.attrelid
    join pg_namespace namespace on namespace.oid = table_class.relnamespace
    where namespace.nspname = 'public'
      and table_class.relname = 'creative_jobs'
      and attribute.attname = 'opportunity_id'
  ) then
    raise exception 'creative_jobs.opportunity_id is still NOT NULL after this migration; investigate before relying on request-backed Creative Jobs.';
  end if;

  select pg_get_indexdef(index_class.oid)
    into index_definition
  from pg_class index_class
  join pg_namespace namespace on namespace.oid = index_class.relnamespace
  where namespace.nspname = 'public'
    and index_class.relname = 'creative_jobs_opportunity_id_idx';

  if index_definition is null or index_definition !~* 'unique index.*\(opportunity_id\).*where.*opportunity_id is not null' then
    raise exception 'creative_jobs_opportunity_id_idx is missing or is not the expected partial unique index; investigate before relying on request-backed Creative Jobs.';
  end if;

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
    raise exception 'creative_jobs_origin_check was not created; investigate before relying on request-backed Creative Jobs.';
  end if;
end $$;
