-- SECURITY S1.1: narrow three permissions that SECURITY S1 granted more broadly than runtime needs.
--
-- Safe to run more than once in the Supabase SQL editor. Policies and one function only: no table,
-- column, index, constraint, trigger, grant or row is created, altered or deleted.
--
-- ============================================================================================
-- WHAT THIS IS, AND WHAT IT IS NOT
-- ============================================================================================
--
-- S1 (supabase-harden-product-lab-owner-data-rls.sql, applied live 2026-08-20) moved 23 tables off
-- `to authenticated using (true)`. Its independent review passed with no P0 and no P1, and found
-- three grants that are wider than the runtime evidence supports. This file closes those three and
-- NOTHING else.
--
-- It does NOT revisit the S1 architecture, the claim family, the ordering design, or any decision
-- the review accepted. In particular `customers` keeps SELECT *and* UPDATE for the public-order
-- principal -- both are load-bearing for the `insert ... on conflict (id) do update` path in
-- save_public_order_once, and S1's own smoke test proves ordering breaks without them.
--
-- S1 IS ALREADY APPLIED IN PRODUCTION AND IS NOT REWRITTEN. That file still creates the broader
-- policies; this one narrows them afterwards. The repository history reads S1 -> S1.1, which is what
-- actually happened, rather than pretending the applied migration was something else.
--
-- ============================================================================================
-- 1. public_order UPDATE on `orders` and `order_lines` -- REMOVED
-- ============================================================================================
--
-- S1 granted the website principal select/insert/update on both, reasoning that save_order's
-- `insert ... on conflict (id) do update` needs the UPDATE policy.
--
-- It does not, and the reason is worth writing down because it is the opposite of the customers
-- case and the two look identical from a distance.
--
-- PostgreSQL evaluates an INSERT's UPDATE policies only when a row ACTUALLY CONFLICTS. It evaluates
-- the SELECT policy either way (which is why `customers` genuinely needs SELECT). And the conflict
-- can never happen on the public path:
--
--   save_public_order_once takes a transaction-scoped advisory lock on the derived order id, checks
--   existence UNDER that lock, and returns created:false without calling save_order if the row is
--   there. save_order therefore only ever runs when the order does NOT exist -- so its ON CONFLICT
--   branch is unreachable for this principal, on a first submission and on a replay alike.
--
-- Independent review measured this in throwaway PostgreSQL with both policies dropped: first
-- submission created=true, identical replay created=false, no duplicate. This migration is that
-- finding applied, and tests/smoke/postgres/owner-data-rls.smoke.test.ts now proves it on every run
-- rather than leaving it as a claim.
--
-- What the website principal keeps: SELECT (the replay/existence check) and INSERT (the write). It
-- has no UPDATE and no DELETE anywhere in the ordering domain. It cannot alter an order after
-- creating it -- not its status, not its payment, not its lines.
--
-- ============================================================================================
-- 2. creative_worker DELETE on `opportunities` -- REMOVED
-- ============================================================================================
--
-- S1 gave the creative/production principals `for all` on opportunities, which is the one business
-- table the daily advisor genuinely writes. `for all` includes DELETE, and no runtime path deletes
-- an Opportunity. scripts/daily-advisor/opportunity-persistence.ts uses exactly three verbs:
--
--   :102  select ... eq(deduplication_key)      -- find an existing row
--   :110  update ... eq(id).eq(status,'new')    -- refresh a still-new row
--   :168  insert ... select().single()          -- create a new one
--
-- So the worker gets those three and not the fourth. The owner keeps everything, including DELETE:
-- removing an Opportunity stays a decision a human makes.
--
-- ============================================================================================
-- 3. `is_ordering_principal()` -- DROPPED
-- ============================================================================================
--
-- S1 created three helpers and used two. `is_ordering_principal()` (owner + public_order) was
-- written for an ordering-policy shape that the final design did not use -- the ordering policies
-- name `is_product_lab_owner()` and `is_public_order_principal()` separately instead.
--
-- A dead authorization primitive is worth removing rather than leaving: it reads as though something
-- depends on it, and the next person to need "owner or website" will reach for it without checking
-- whether it is wired to anything. Verified unreferenced by any policy before dropping -- and
-- PostgreSQL enforces that independently, since it refuses to drop a function a policy depends on.
--
-- ============================================================================================
-- ROLLBACK
-- ============================================================================================
--
-- Re-running supabase-harden-product-lab-owner-data-rls.sql restores all three: it recreates
-- `S1 public order updates orders`, `S1 public order updates order_lines`, the `for all`
-- opportunities policy, and `is_ordering_principal()`. Drop this file's own policies first so the
-- names do not collide with the ones S1 recreates:
--
--   do $$
--   declare p record;
--   begin
--     for p in select schemaname, tablename, policyname from pg_policies where policyname like 'S1.1 %'
--     loop execute format('drop policy %I on %I.%I', p.policyname, p.schemaname, p.tablename); end loop;
--   end $$;
--
-- No data is touched by this migration or by its rollback, in either direction.

-- --------------------------------------------------------------------------------------------
-- 0. Preflight: refuse to run against a shape this file was not written for.
-- --------------------------------------------------------------------------------------------

do $$
declare
  missing_function text;
  owner_count integer;
  public_order_count integer;
begin
  -- 0a. S1's claim readers must exist. This file narrows S1's policies; it does not replace its
  -- authorization model, and every policy below is written in terms of S1's helpers.
  for missing_function in
    select candidate
    from unnest(array['current_app_role', 'is_product_lab_owner', 'is_creative_domain_principal']) as candidate
    where not exists (
      select 1
      from pg_proc procedure
      join pg_namespace namespace on namespace.oid = procedure.pronamespace
      where namespace.nspname = 'public' and procedure.proname = candidate
    )
  loop
    raise exception 'Function public.%() is missing. Apply supabase-harden-creative-production-rls.sql (Wave B) and supabase-harden-product-lab-owner-data-rls.sql (S1) before narrowing them.', missing_function;
  end loop;

  -- 0b. S1 itself must have been applied. Each check accepts EITHER the S1 policy this file
  -- replaces OR the replacement it installs, so a second run is a no-op rather than a refusal.
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'opportunities'
      and policyname in ('S1 creative domain manages opportunities', 'S1.1 owner manages opportunities')
  ) then
    raise exception 'Neither the S1 opportunities policy nor its S1.1 replacement is present. Apply supabase-harden-product-lab-owner-data-rls.sql first.';
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'orders' and policyname = 'S1 public order inserts orders'
  ) then
    raise exception 'The S1 ordering policies are not present. Apply supabase-harden-product-lab-owner-data-rls.sql first.';
  end if;

  -- 0c. The claims must still exist. Narrowing on top of a claim nobody holds would leave the
  -- ordering page unable to read its own catalog.
  select count(*) into owner_count        from auth.users where raw_app_meta_data ->> 'app_role' = 'owner';
  select count(*) into public_order_count from auth.users where raw_app_meta_data ->> 'app_role' = 'public_order';

  if owner_count < 1 then
    raise exception 'No account holds app_role = owner. Fix that before narrowing anything.';
  end if;

  if public_order_count < 1 then
    raise exception 'No account holds app_role = public_order. The ordering page would be reading a catalog it has no claim for.';
  end if;

  raise notice 'Preflight passed: S1 is applied, % owner and % public_order account(s) present.', owner_count, public_order_count;
end $$;

-- --------------------------------------------------------------------------------------------
-- 1. The website principal loses UPDATE on the ordering tables.
-- --------------------------------------------------------------------------------------------
--
-- SELECT and INSERT are untouched, and so is every `customers` policy. After this the public-order
-- principal can create an order and read one back, and can change nothing that already exists.

drop policy if exists "S1 public order updates orders" on public.orders;
drop policy if exists "S1 public order updates order_lines" on public.order_lines;

-- --------------------------------------------------------------------------------------------
-- 2. The worker loses DELETE on opportunities; the owner keeps it.
-- --------------------------------------------------------------------------------------------
--
-- One `for all` policy becomes four: the owner's, unchanged in effect, plus the worker's three
-- verbs written out individually. They are permissive and therefore OR'd, so the owner still
-- satisfies every one of them -- the owner policy is what carries DELETE, and it is the only one
-- that does.

drop policy if exists "S1 creative domain manages opportunities" on public.opportunities;

drop policy if exists "S1.1 owner manages opportunities" on public.opportunities;
drop policy if exists "S1.1 creative domain reads opportunities" on public.opportunities;
drop policy if exists "S1.1 creative domain inserts opportunities" on public.opportunities;
drop policy if exists "S1.1 creative domain updates opportunities" on public.opportunities;

create policy "S1.1 owner manages opportunities"
  on public.opportunities for all
  to authenticated
  using (public.is_product_lab_owner())
  with check (public.is_product_lab_owner());

-- daily-advisor/opportunity-persistence.ts:102 -- find an existing row by deduplication_key
create policy "S1.1 creative domain reads opportunities"
  on public.opportunities for select
  to authenticated
  using (public.is_creative_domain_principal());

-- daily-advisor/opportunity-persistence.ts:168 -- create a new Opportunity
create policy "S1.1 creative domain inserts opportunities"
  on public.opportunities for insert
  to authenticated
  with check (public.is_creative_domain_principal());

-- daily-advisor/opportunity-persistence.ts:110 -- refresh a still-'new' row
create policy "S1.1 creative domain updates opportunities"
  on public.opportunities for update
  to authenticated
  using (public.is_creative_domain_principal())
  with check (public.is_creative_domain_principal());

-- Deliberately no DELETE policy for the creative domain. The owner's `for all` above is the only
-- policy that permits a delete, so the worker's deletes match no row and remove nothing.

-- --------------------------------------------------------------------------------------------
-- 3. Drop the unused helper.
-- --------------------------------------------------------------------------------------------
--
-- `drop function` fails loudly if any policy still depends on it, which is the check that matters
-- and is stronger than anything this file could assert for itself. Dropping a function drops its
-- grants with it, so the `grant execute ... to authenticated` from S1 goes too.

drop function if exists public.is_ordering_principal();

-- --------------------------------------------------------------------------------------------
-- 4. Postflight. Asserts the shape rather than trusting it.
-- --------------------------------------------------------------------------------------------

do $$
declare
  offender text;
  policy_count integer;
begin
  -- 4a. The website principal must have no UPDATE and no DELETE policy on the ordering tables.
  select string_agg(tablename || '.' || policyname || ' (' || cmd || ')', ', ')
    into offender
  from pg_policies
  where schemaname = 'public'
    and tablename in ('orders', 'order_lines')
    and policyname like '%public order%'
    and cmd in ('UPDATE', 'DELETE');

  if offender is not null then
    raise exception 'Narrowing incomplete: the public-order principal still holds % on the ordering tables.', offender;
  end if;

  -- 4b. ...but must keep the two verbs it genuinely uses, on both tables.
  select count(*) into policy_count
  from pg_policies
  where schemaname = 'public'
    and tablename in ('orders', 'order_lines')
    and policyname like '%public order%'
    and cmd in ('SELECT', 'INSERT');

  if policy_count <> 4 then
    raise exception 'Expected 4 public-order SELECT/INSERT policies across orders and order_lines, found %. The ordering page cannot work without them.', policy_count;
  end if;

  -- 4c. `customers` is NOT narrowed. Its SELECT and UPDATE are load-bearing for the ON CONFLICT
  -- path, and a future edit that removes them would break public ordering silently.
  select count(*) into policy_count
  from pg_policies
  where schemaname = 'public' and tablename = 'customers' and policyname like '%public order%'
    and cmd in ('SELECT', 'INSERT', 'UPDATE');

  if policy_count <> 3 then
    raise exception 'The customers policies changed. S1.1 must leave all three in place -- SELECT and UPDATE are required by insert ... on conflict do update.';
  end if;

  -- 4d. The creative domain must have no DELETE path to opportunities.
  if exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'opportunities'
      and cmd in ('ALL', 'DELETE')
      and qual like '%is_creative_domain_principal%'
  ) then
    raise exception 'Narrowing incomplete: a policy still grants the creative domain DELETE on opportunities.';
  end if;

  -- 4e. ...and must keep the three verbs the daily advisor uses.
  select count(*) into policy_count
  from pg_policies
  where schemaname = 'public' and tablename = 'opportunities'
    and cmd in ('SELECT', 'INSERT', 'UPDATE')
    and coalesce(qual, with_check) like '%is_creative_domain_principal%';

  if policy_count <> 3 then
    raise exception 'Expected 3 creative-domain SELECT/INSERT/UPDATE policies on opportunities, found %. The daily advisor cannot produce Opportunities without them.', policy_count;
  end if;

  -- 4f. The owner must still hold opportunities outright, DELETE included.
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'opportunities'
      and cmd = 'ALL' and qual like '%is_product_lab_owner%'
  ) then
    raise exception 'The owner lost full access to opportunities. That is not a narrowing, it is a regression.';
  end if;

  -- 4g. The dead helper is gone, and the two live ones are not.
  if exists (
    select 1 from pg_proc procedure
    join pg_namespace namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'public' and procedure.proname = 'is_ordering_principal'
  ) then
    raise exception 'public.is_ordering_principal() still exists.';
  end if;

  for offender in
    select candidate
    from unnest(array['current_app_role', 'is_product_lab_owner', 'is_creative_domain_principal', 'is_catalog_read_principal', 'is_public_order_principal']) as candidate
    where not exists (
      select 1 from pg_proc procedure
      join pg_namespace namespace on namespace.oid = procedure.pronamespace
      where namespace.nspname = 'public' and procedure.proname = candidate
    )
  loop
    raise exception 'public.%() went missing. S1.1 drops exactly one helper and it is not this one.', offender;
  end loop;

  -- 4h. S1 and Wave B are otherwise untouched: nothing permissive may have reappeared anywhere.
  select count(*) into policy_count
  from pg_policies
  where schemaname = 'public'
    and (coalesce(qual, '') = 'true' or coalesce(with_check, '') = 'true');

  if policy_count > 0 then
    raise exception 'A permissive using(true)/with check(true) policy exists in the public schema. S1.1 creates none -- investigate before continuing.';
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'Creative domain principals manage generated asset files'
  ) then
    raise exception 'Wave B regression: the generated-assets storage policy is missing.';
  end if;

  raise notice 'SECURITY S1.1 least-privilege narrowing verified.';
end $$;

-- Post-apply inspection (read-only; run separately if you want to eyeball the result):
--
--   select tablename, cmd, policyname, qual, with_check
--   from pg_policies
--   where schemaname = 'public' and tablename in ('orders', 'order_lines', 'customers', 'opportunities')
--   order by tablename, cmd, policyname;
