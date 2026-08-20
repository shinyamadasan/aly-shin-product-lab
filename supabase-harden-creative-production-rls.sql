-- Wave B authorization closure: replace permissive `authenticated` RLS on the creative/production
-- domain with owner-claim policies. Safe to run more than once in the Supabase SQL editor.
--
-- ============================================================================================
-- WHAT THIS FIXES, AND WHY IT IS NOT OPTIONAL
-- ============================================================================================
--
-- Every table below shipped with:
--
--     to authenticated using (true) with check (true)
--
-- which is a ROLE check, not an IDENTITY check. This project has THREE authenticated principals,
-- all holding the same `authenticated` role:
--
--   1. the Product Lab owner            (browser sign-in)
--   2. the public-order website user    (supabase-server.ts, serves an internet-facing surface)
--   3. the advisor/worker automation    (.env.advisor.local; runs the creative + asset workers)
--
-- Measured live before this migration: principal 2 could SELECT creative_jobs, creative_packages,
-- asset_jobs and assets, and could list, sign, download, upload and delete objects in the private
-- `generated-assets` bucket. That is the owner's entire creative history and every generated image,
-- readable and destroyable by the principal that exists to serve the public ordering page.
--
-- ============================================================================================
-- WHY TWO CLAIM VALUES AND NOT ONE
-- ============================================================================================
--
-- There is exactly ONE owner identity: app_metadata.app_role = 'owner'.
--
-- But the creative and asset WORKERS are separate OS processes that sign in with their own
-- credentials (scripts/creative-workers/run.ts, scripts/asset-workers/run.ts, both reading
-- .env.advisor.local). They are the code that actually claims Creative Jobs, writes Creative
-- Packages, finishes Asset Jobs, and materializes Assets and Asset Files into storage.
--
-- An owner-ONLY policy would therefore stop the generation pipeline dead: Create Now would queue
-- jobs that no principal is permitted to run. The alternative -- giving the worker the 'owner'
-- claim -- is worse, because the application gate (/api/owner) would then admit the worker's
-- credentials to the full owner UI.
--
-- So the worker gets a STRICTLY SEPARATE, NARROWER service claim: 'creative_worker'. It is not the
-- owner, cannot open the owner surface, and is refused by isProductionOwner() in application code.
-- Both claims are read from the SAME app_metadata.app_role path the application reads.
--
-- ============================================================================================
-- OUT OF SCOPE -- DELIBERATELY UNTOUCHED
-- ============================================================================================
--
-- Public ordering (customers, orders, order_lines, save_order) is NOT altered. Principal 2 keeps
-- exactly the access it has today on those tables. This migration changes only the creative /
-- production domain and the `generated-assets` bucket.
--
-- Every other permissively-policied Product Lab table (products, costing, inventory, journal, ...)
-- is also left alone. Those are pre-existing owner-data RLS debt, reported separately; hardening
-- them is not this slice and must not be implied by running this file.
--
-- ============================================================================================
-- ROLLBACK
-- ============================================================================================
--
-- Every statement below is reversible by re-running the ORIGINAL policy from the file that first
-- created it (supabase-add-creative-jobs.sql, -creative-packages, -asset-jobs, -assets,
-- -asset-files, -creative-job-attempts, -asset-job-attempts, -generated-assets-storage). Each of
-- those files begins with `drop policy if exists`, so re-running one restores the permissive policy
-- verbatim. No table, column, index, grant or row is modified by this migration -- policies only.
--
-- ============================================================================================
-- ORDER OF OPERATIONS -- READ BEFORE RUNNING
-- ============================================================================================
--
--   1. Run supabase-assign-owner-app-role.sql FIRST, for the owner AND for the worker principal.
--   2. Sign out and sign back in (both the browser and any running worker) so freshly issued
--      tokens carry the new claim. An existing access token does NOT gain the claim retroactively.
--   3. THEN run this file.
--
-- Running this file first will lock every principal out of the creative domain until step 1 is
-- done. That is a recoverable state (re-run step 1, refresh tokens), not data loss -- but it will
-- stop the workers in the meantime.

-- --------------------------------------------------------------------------------------------
-- 0. Preflight: refuse to run against a shape this file was not written for.
-- --------------------------------------------------------------------------------------------

do $$
declare
  missing_table text;
begin
  for missing_table in
    select candidate
    from unnest(array[
      'creative_jobs', 'creative_job_attempts', 'creative_packages',
      'asset_jobs', 'asset_job_attempts', 'assets', 'asset_files'
    ]) as candidate
    where not exists (
      select 1
      from pg_class table_class
      join pg_namespace namespace on namespace.oid = table_class.relnamespace
      where namespace.nspname = 'public' and table_class.relname = candidate
    )
  loop
    raise exception 'Table public.% does not exist. Apply the Wave A/B creative and asset schema before hardening it.', missing_table;
  end loop;

  if not exists (select 1 from storage.buckets where id = 'generated-assets') then
    raise exception 'Storage bucket generated-assets does not exist. Apply supabase-add-generated-assets-storage.sql first.';
  end if;
end $$;

-- --------------------------------------------------------------------------------------------
-- 1. The claim readers.
-- --------------------------------------------------------------------------------------------
--
-- ONE definition of where the owner claim lives, mirroring the application's
-- OWNER_APP_ROLE_CLAIM_PATH constant exactly: app_metadata.app_role.
--
-- app_metadata (not user_metadata) is the source, because user_metadata is writable by the user
-- through supabase.auth.updateUser() -- a principal could grant itself the claim from the browser.
-- app_metadata is writable only via the Admin API or direct SQL.
--
-- `security invoker` + `set search_path = ''` so the function cannot be captured by a caller's
-- search_path. auth.jwt() is schema-qualified below and resolves regardless.
--
-- Returns NULL when there is no JWT, no app_metadata, or no app_role -- which every policy below
-- treats as "not permitted". Absence fails closed.

create or replace function public.current_app_role()
returns text
language sql
stable
security invoker
set search_path = ''
as $$
  select nullif(auth.jwt() -> 'app_metadata' ->> 'app_role', '')
$$;

comment on function public.current_app_role() is
  'The caller''s app_metadata.app_role claim, or NULL. Authorization source of truth for the creative/production domain. Mirrors OWNER_APP_ROLE_CLAIM_PATH in src/lib/production-auth.ts.';

-- The owner, and only the owner. Used where a decision is genuinely the owner's alone.
create or replace function public.is_product_lab_owner()
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select public.current_app_role() = 'owner'
$$;

-- The creative/production domain's trusted operators: the owner, plus the automation principal that
-- actually runs generation. Deliberately a SHORT, CLOSED list -- adding a value here grants access
-- to every table below at once, so it should be treated as a security review, not a config tweak.
create or replace function public.is_creative_domain_principal()
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select public.current_app_role() in ('owner', 'creative_worker')
$$;

comment on function public.is_creative_domain_principal() is
  'True for the owner and the creative/asset worker service principal. NOT true for the public-order website principal or any other authenticated user.';

grant execute on function public.current_app_role() to authenticated;
grant execute on function public.is_product_lab_owner() to authenticated;
grant execute on function public.is_creative_domain_principal() to authenticated;

-- --------------------------------------------------------------------------------------------
-- 2. Replace the permissive creative/production policies.
-- --------------------------------------------------------------------------------------------
--
-- Grants are intentionally LEFT AS THEY ARE. The `authenticated` role keeps its table grants; RLS
-- is what now enforces identity. Revoking the grant instead would produce 42501 for every principal
-- and would also break the ability to return a clean empty result, which the application's
-- missing-table detection distinguishes from a permission error.

drop policy if exists "Authenticated users can manage creative jobs" on creative_jobs;
create policy "Creative domain principals manage creative jobs"
  on creative_jobs for all
  to authenticated
  using (public.is_creative_domain_principal())
  with check (public.is_creative_domain_principal());

drop policy if exists "Authenticated users can manage creative job attempts" on creative_job_attempts;
create policy "Creative domain principals manage creative job attempts"
  on creative_job_attempts for all
  to authenticated
  using (public.is_creative_domain_principal())
  with check (public.is_creative_domain_principal());

drop policy if exists "Authenticated users can manage creative packages" on creative_packages;
create policy "Creative domain principals manage creative packages"
  on creative_packages for all
  to authenticated
  using (public.is_creative_domain_principal())
  with check (public.is_creative_domain_principal());

drop policy if exists "Authenticated users can manage asset jobs" on asset_jobs;
create policy "Creative domain principals manage asset jobs"
  on asset_jobs for all
  to authenticated
  using (public.is_creative_domain_principal())
  with check (public.is_creative_domain_principal());

drop policy if exists "Authenticated users can manage asset job attempts" on asset_job_attempts;
create policy "Creative domain principals manage asset job attempts"
  on asset_job_attempts for all
  to authenticated
  using (public.is_creative_domain_principal())
  with check (public.is_creative_domain_principal());

drop policy if exists "Authenticated users can manage assets" on assets;
create policy "Creative domain principals manage assets"
  on assets for all
  to authenticated
  using (public.is_creative_domain_principal())
  with check (public.is_creative_domain_principal());

-- asset_files is included even though the brief named only four tables: it carries the storage
-- PATHS of every generated image. Leaving it open would hand a non-owner the map to the bucket.
drop policy if exists "Authenticated users can manage asset files" on asset_files;
create policy "Creative domain principals manage asset files"
  on asset_files for all
  to authenticated
  using (public.is_creative_domain_principal())
  with check (public.is_creative_domain_principal());

-- --------------------------------------------------------------------------------------------
-- 3. Storage: the generated-assets bucket.
-- --------------------------------------------------------------------------------------------
--
-- The bucket is already `public = false`, so anonymous callers cannot read it. The gap was the
-- POLICY: `to authenticated using (bucket_id = 'generated-assets')` let every signed-in principal
-- list, sign, download, upload, overwrite and delete. All six were confirmed live.
--
-- Scoped strictly to this bucket_id. The batch-photos policy from
-- supabase-add-batch-photos-storage.sql is a separate policy on the same table and is NOT touched
-- here -- batch photos are a different domain with different expectations.

drop policy if exists "Authenticated users can manage generated asset files" on storage.objects;
create policy "Creative domain principals manage generated asset files"
  on storage.objects for all
  to authenticated
  using (bucket_id = 'generated-assets' and public.is_creative_domain_principal())
  with check (bucket_id = 'generated-assets' and public.is_creative_domain_principal());

-- --------------------------------------------------------------------------------------------
-- 4. Verification. Run this after applying; it asserts the shape rather than trusting it.
-- --------------------------------------------------------------------------------------------

do $$
declare
  permissive_count integer;
begin
  select count(*)
    into permissive_count
  from pg_policies
  where schemaname = 'public'
    and tablename in (
      'creative_jobs', 'creative_job_attempts', 'creative_packages',
      'asset_jobs', 'asset_job_attempts', 'assets', 'asset_files'
    )
    and (coalesce(qual, '') = 'true' or coalesce(with_check, '') = 'true');

  if permissive_count > 0 then
    raise exception 'Hardening incomplete: % permissive policy expression(s) remain on the creative/production tables.', permissive_count;
  end if;

  if exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'Authenticated users can manage generated asset files'
  ) then
    raise exception 'Hardening incomplete: the permissive generated-assets storage policy still exists.';
  end if;

  raise notice 'Creative/production RLS hardening verified.';
end $$;

-- Post-apply inspection (read-only; run separately if you want to eyeball the result):
--
--   select tablename, policyname, qual, with_check
--   from pg_policies
--   where schemaname = 'public'
--     and tablename in ('creative_jobs','creative_job_attempts','creative_packages',
--                       'asset_jobs','asset_job_attempts','assets','asset_files')
--   order by tablename;
