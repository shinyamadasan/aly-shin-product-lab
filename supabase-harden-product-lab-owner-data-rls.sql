-- SECURITY S1: close the pre-existing owner-data RLS debt Wave B deliberately left open.
--
-- Safe to run more than once in the Supabase SQL editor. Policies, functions and function GRANTs
-- only: no table, column, index, constraint, trigger or row is created, altered or deleted.
--
-- ############################################################################################
-- #                                                                                          #
-- #   STOP -- THIS FILE ALONE IS NOT THE CURRENT AUTHORIZATION STATE.                        #
-- #                                                                                          #
-- #   SECURITY S1 is the HISTORICAL hardening stage. To reach the least-privilege state       #
-- #   production actually runs, apply SECURITY S1.1 IMMEDIATELY AFTER this file:              #
-- #                                                                                          #
-- #       1.  supabase-harden-product-lab-owner-data-rls.sql   (this file)                    #
-- #       2.  supabase-narrow-s1-least-privilege.sql           (S1.1 -- REQUIRED)             #
-- #                                                                                          #
-- #   The two together are the CANONICAL REPLAY UNIT. Stopping after this file leaves four    #
-- #   privileges broader than production has:                                                 #
-- #                                                                                          #
-- #       * public_order UPDATE on `orders`                                                   #
-- #       * public_order UPDATE on `order_lines`                                              #
-- #       * creative_worker DELETE on `opportunities` (via the `for all` policy below)        #
-- #       * the unused helper `is_ordering_principal()`                                        #
-- #                                                                                          #
-- #   S1.1 removes exactly those four and nothing else. Both files are idempotent, so the     #
-- #   pair can be replayed as often as needed and always converges on the same final state.   #
-- #   The postflight at the end of this file repeats this warning where you will see it.      #
-- #                                                                                          #
-- ############################################################################################
--
-- ============================================================================================
-- WHAT THIS FIXES
-- ============================================================================================
--
-- Wave B (supabase-harden-creative-production-rls.sql) replaced `to authenticated using (true)`
-- with claim-based policies on the seven creative/production tables and the `generated-assets`
-- bucket. It said so explicitly, and said just as explicitly that it was doing nothing else:
--
--     "Roughly twenty other Product Lab tables are still `to authenticated using (true)` and
--      remain readable by every authenticated account -- including the public-order principal."
--
-- This file is that twenty. Measured live on 2026-08-20 BEFORE applying it, signed in as the
-- public-order website principal -- an internet-facing service account that exists only to render
-- a menu and record an order:
--
--     ingredients             26 rows      purchase_import_rows   386 rows
--     ingredient_aliases      20 rows      inventory_transactions  38 rows
--     purchase_imports        32 rows      supply_entries          37 rows
--     costing_entries         98 rows      content_journal         33 rows
--     equipment                3 rows      content_drafts           2 rows
--     batch_photos             6 rows      customers                1 row
--     tasting_feedback         2 rows      brand_profiles           1 row
--     products/batches/costings/selling_formats -- all of them
--
-- All of it writable, too: every one of those policies is `for all ... with check (true)`, so the
-- same principal could DELETE the recipe book. And the project holds FIVE Supabase Auth accounts,
-- two of which have no known purpose -- each of them had exactly the same access.
--
-- ============================================================================================
-- THE MODEL -- ONE CLAIM FAMILY, FOUR PRINCIPALS
-- ============================================================================================
--
-- Authorization continues to derive from Supabase Auth's own app_metadata.app_role, read through
-- the helpers Wave B already installed. No new identity mechanism is introduced here: no email
-- allowlist, no hardcoded UUID, no user_metadata, no owner_id column, no client-side filter.
--
--   'owner'            the human. All Product Lab business data.
--   'creative_worker'  the automation account in .env.advisor.local. Wave B gave it the creative
--                      domain. This file additionally gives it READ -- and only read -- on the
--                      handful of business tables its advisor duties provably consult.
--   'public_order'     NEW. The server-only website principal in .env.public-order.local.
--                      The catalog it needs to build a menu, and the ordering tables it writes.
--   (no claim)         nothing. Which is what the two unexplained accounts should have had.
--
-- WHY 'creative_worker' GETS BUSINESS TABLES AT ALL. The default assumption for Product Lab
-- business data is owner-only, and it is applied everywhere below EXCEPT where current runtime
-- evidence proves otherwise. One automation account serves five entry points, all reading
-- .env.advisor.local through readSupabaseCredentials():
--
--   scripts/daily-advisor/supabase-read.ts:133-137
--       products, product_batches, costing_summaries, tasting_feedback, supply_entries
--   scripts/daily-advisor/opportunity-persistence.ts:102,110,168
--       opportunities -- select, update AND insert
--   scripts/marketing-advisor/marketing-advisor-read.ts:99-101
--       products, ingredients, content_journal
--   scripts/creative-workers/creative-ai-grounding.ts:109-113
--       products, ingredients, content_journal, brand_profiles
--
-- That is the whole list. It gets SELECT on exactly those tables and WRITE on none of them, except
-- `opportunities`, which it genuinely creates and updates. It gets NO access to inventory
-- (ingredient_aliases, inventory_transactions), purchases (purchase_imports,
-- purchase_import_rows), costing detail (costing_entries), equipment, batch photos, content
-- drafts, AI reviews, packaging lines, customers, orders or order lines.
--
-- WHY 'public_order' IS A NEW CLAIM VALUE AND NOT A FOURTH MECHANISM. Its access cannot be
-- expressed as "authenticated", because that is precisely the role two unexplained accounts also
-- hold. It cannot be expressed as owner or creative_worker without handing it the whole business.
-- The claim family Wave B established is the only place in this system where an identity can be
-- stated so that BOTH the application and the database read the same answer -- so it is stated
-- there. This is the same one-line admin operation Wave B performed for the worker.
--
-- Its access is narrowed on both axes:
--   * only the four catalog tables loadPublicCatalog() actually reads
--     (src/lib/public-catalog-repository.ts:57-62), and only SELECT on them;
--   * only the ordering tables save_public_order_once() actually writes, and NOT delete.
--
-- ============================================================================================
-- WHAT THIS DELIBERATELY DOES NOT DO
-- ============================================================================================
--
-- * The creative/production domain and the `generated-assets` bucket are NOT touched. Wave B
--   hardened them, live verification on 2026-08-20 confirms they are still hardened (public-order
--   sees 0 of 14 creative jobs), and re-stating those policies here for stylistic consistency
--   would put a working boundary at risk for no gain.
--
-- * The ordering architecture is unchanged. save_order and save_public_order_once keep their
--   bodies, their signatures and their `security invoker` behaviour. Nothing moves to service-role.
--
-- * No multi-tenancy, no owner_id column, no row-level ownership. There is one owner.
--
-- * `orders` and `order_lines` are NOT row-scoped to entry_method = 'website'. That narrowing is
--   real and available -- it would stop the public-order principal reading orders the owner typed
--   in by hand -- but it changes the behaviour of a replayed submission against a row the policy
--   hides (the ON CONFLICT path raises instead of returning an idempotent acceptance), and that is
--   a deliberate decision for the owner to make, not a side effect of this file. Reported as
--   remaining debt.
--
-- ============================================================================================
-- ORDER OF OPERATIONS -- READ BEFORE RUNNING
-- ============================================================================================
--
--   1. Run supabase-assign-owner-app-role.sql for the PUBLIC-ORDER account, assigning
--      app_role = 'public_order'. The owner and creative_worker claims already exist from Wave B.
--   2. Nothing else needs restarting by hand: the website principal and every worker call
--      signInWithPassword() on each cold start, so they mint a fresh token carrying the new claim.
--      The OWNER's browser session predates nothing here and is unaffected.
--   3. THEN run this file.
--   4. THEN run supabase-narrow-s1-least-privilege.sql (SECURITY S1.1). This step is NOT optional.
--      See the banner at the top: S1 and S1.1 together are the canonical replay unit, and stopping
--      after step 3 leaves four privileges broader than production grants.
--
-- Step 0 below REFUSES to run if step 1 has not happened, so getting the order wrong is a clean
-- error rather than an outage on the public ordering page. Nothing enforces step 4 from inside this
-- file -- a migration cannot compel the next one -- so the postflight ends by naming it explicitly.
--
-- One or more accounts may hold app_role = 'owner'. Step 0 requires at least one and imposes no
-- upper bound: `owner` is a role, not a person. (SECURITY S1.2.)
--
-- ============================================================================================
-- ROLLBACK
-- ============================================================================================
--
-- Every policy replaced below is restored by re-running the file that first created it. Each of
-- those files begins with its own `drop policy if exists` (or is a plain `create policy` on a
-- table whose S1 policies you drop first), so re-running one restores the permissive policy
-- verbatim:
--
--   supabase-fix-permissions.sql        products, product_batches, batch_photos, costing_entries,
--                                       costing_summaries, tasting_feedback, content_journal
--   supabase-add-inventory.sql          ingredients, ingredient_aliases, purchase_imports,
--                                       purchase_import_rows, inventory_transactions
--   supabase-add-supplies.sql           supply_entries
--   supabase-add-equipment.sql          equipment
--   supabase-add-ai-reviews.sql         ai_reviews
--   supabase-add-brand-profiles.sql     brand_profiles
--   supabase-add-content-drafts.sql     content_drafts
--   supabase-add-selling-formats.sql    selling_formats, selling_format_packaging_lines
--   supabase-add-opportunities.sql      opportunities
--   supabase-add-orders.sql             customers, orders, order_lines (+ save_order grants)
--   supabase-add-batch-photos-storage.sql   the batch-photos storage.objects policy
--
-- To roll back cleanly, first drop this file's policies (their names all begin with 'S1 '):
--
--   do $$
--   declare p record;
--   begin
--     for p in select schemaname, tablename, policyname from pg_policies where policyname like 'S1 %'
--     loop execute format('drop policy %I on %I.%I', p.policyname, p.schemaname, p.tablename); end loop;
--   end $$;
--
-- then re-run whichever original files you want back. The EXECUTE grants tightened in section 5
-- are reverted with `grant execute on function <signature> to public;` -- but note that restoring
-- them restores a boundary the save_order author already argued against, so prefer not to.
--
-- No data is touched by any of this, in either direction.

-- --------------------------------------------------------------------------------------------
-- 0. Preflight: refuse to run against a shape this file was not written for.
-- --------------------------------------------------------------------------------------------

do $$
declare
  missing_table text;
  missing_function text;
  owner_count integer;
  public_order_count integer;
  worker_count integer;
begin
  -- 0a. Every table this file writes a policy for must exist.
  for missing_table in
    select candidate
    from unnest(array[
      'products', 'product_batches', 'batch_photos', 'costing_entries', 'costing_summaries',
      'tasting_feedback', 'content_journal', 'supply_entries', 'equipment', 'ai_reviews',
      'ingredients', 'ingredient_aliases', 'purchase_imports', 'purchase_import_rows',
      'inventory_transactions', 'brand_profiles', 'content_drafts', 'selling_formats',
      'selling_format_packaging_lines', 'opportunities', 'customers', 'orders', 'order_lines'
    ]) as candidate
    where not exists (
      select 1
      from pg_class table_class
      join pg_namespace namespace on namespace.oid = table_class.relnamespace
      where namespace.nspname = 'public' and table_class.relname = candidate
    )
  loop
    raise exception 'Table public.% does not exist. Apply the Product Lab schema before hardening it.', missing_table;
  end loop;

  -- 0b. Wave B's claim readers must already exist. This file REUSES them rather than redefining
  -- them, so that there is exactly one place in the database that says where the claim lives.
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
    raise exception 'Function public.%() is missing. Apply supabase-harden-creative-production-rls.sql (Wave B) first.', missing_function;
  end loop;

  -- 0c. THE CLAIMS MUST EXIST BEFORE THE POLICIES DO.
  --
  -- Applying this file before assigning app_role = 'public_order' would take the public ordering
  -- page down until the claim landed -- recoverable, but an outage on the one customer-facing
  -- surface this project has. Refusing here makes the wrong order a no-op instead.
  --
  -- This reads auth.users, which the Supabase SQL editor can do and an application connection
  -- cannot. That is intentional: this file is owner-executed, by hand, in the editor.
  select count(*) into owner_count        from auth.users where raw_app_meta_data ->> 'app_role' = 'owner';
  select count(*) into worker_count       from auth.users where raw_app_meta_data ->> 'app_role' = 'creative_worker';
  select count(*) into public_order_count from auth.users where raw_app_meta_data ->> 'app_role' = 'public_order';

  -- AT LEAST ONE OWNER, NOT EXACTLY ONE. (SECURITY S1.2 -- replay guard repair.)
  --
  -- This check originally required `owner_count <> 1`, which was never an authorization property.
  -- Nothing in the model counts owners: `is_product_lab_owner()` is `current_app_role() = 'owner'`
  -- and `isProductionOwner()` is the same equality in TypeScript. `owner` is a ROLE, and a business
  -- with co-owners gives each of them their own account holding the same claim; every holder gets
  -- identical access, with no seniority and no per-row ownership anywhere in this schema.
  --
  -- Requiring exactly one made this file UNREPLAYABLE the moment a second legitimate owner existed
  -- -- which is what happened, and which is the defect S1.2 repairs. The case that actually protects
  -- something is ZERO: hardening on top of a claim nobody holds does not produce a locked-down
  -- database, it produces one with no way in, including for the humans who own it.
  if owner_count < 1 then
    raise exception 'No account holds app_role = owner. Assign it with supabase-assign-owner-app-role.sql BEFORE hardening -- applying this file first locks every human out of Product Lab.';
  end if;

  if public_order_count < 1 then
    raise exception 'No account holds app_role = public_order. Assign it to the public-order website account (supabase-assign-owner-app-role.sql) FIRST -- applying this file without it takes the public ordering page down.';
  end if;

  if worker_count < 1 then
    raise warning 'No account holds app_role = creative_worker. The daily advisor, marketing advisor and creative/asset workers will lose their reads. This is allowed but is almost certainly not what you want.';
  end if;

  raise notice 'Preflight passed: % owner, % creative_worker, % public_order account(s). One or more owners is expected; more than one is not an error.', owner_count, worker_count, public_order_count;
end $$;

-- --------------------------------------------------------------------------------------------
-- 1. Two additional claim readers, in the SAME family and the same style as Wave B's.
-- --------------------------------------------------------------------------------------------
--
-- `stable`, `security invoker`, `set search_path = ''` for the same reasons Wave B gives: the
-- function cannot be captured by a caller's search_path, and it runs with the caller's own
-- privileges so it can never become a privilege-escalation vector of its own.
--
-- Both delegate to public.current_app_role(). The claim path itself is stated in exactly one
-- place in this database, and that place is Wave B's function. Absence returns NULL, which fails
-- every comparison below -- absence fails closed.

-- The catalog is the ONE thing an internet-facing menu genuinely needs from Product Lab. It is
-- deliberately a short, closed list: adding a value here is a security review, not a config tweak.
create or replace function public.is_catalog_read_principal()
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select public.current_app_role() in ('owner', 'creative_worker', 'public_order')
$$;

comment on function public.is_catalog_read_principal() is
  'True for the owner, the creative/asset worker, and the public-order website principal. Gates SELECT on the four catalog tables loadPublicCatalog() reads (products, product_batches, costing_summaries, selling_formats). Grants no write anywhere.';

-- The ordering domain: the owner (who runs the Orders screen) and the website principal (which
-- records public submissions). NOT the worker -- no automation reads or writes an order.
create or replace function public.is_ordering_principal()
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select public.current_app_role() in ('owner', 'public_order')
$$;

comment on function public.is_ordering_principal() is
  'True for the owner and the public-order website principal. The ordering domain (customers, orders, order_lines) only. NOT the creative_worker, which touches no order.';

-- Used only in the ordering policies below, to hand the website principal insert/update without
-- also handing it delete. Kept separate from is_ordering_principal() so the two intents cannot
-- drift into one another.
create or replace function public.is_public_order_principal()
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select public.current_app_role() = 'public_order'
$$;

comment on function public.is_public_order_principal() is
  'True only for the public-order website principal (src/lib/supabase-server.ts). Never the owner, never the worker.';

grant execute on function public.is_catalog_read_principal() to authenticated;
grant execute on function public.is_ordering_principal() to authenticated;
grant execute on function public.is_public_order_principal() to authenticated;

-- --------------------------------------------------------------------------------------------
-- 2. The business tables.
-- --------------------------------------------------------------------------------------------
--
-- Grants are intentionally LEFT AS THEY ARE, exactly as Wave B left them. The `authenticated` role
-- keeps its table grants; RLS is what now enforces identity. Revoking the grant instead would
-- produce 42501 for every principal and would also break the application's ability to tell a
-- missing table from a permission error (src/lib/database-errors.ts depends on that distinction).
--
-- The three tiers are written as loops over EXPLICIT table lists rather than as ~70 hand-copied
-- policy statements. The lists are the audit surface: what a reviewer needs to check is which
-- table is in which tier, and that is the only thing there is to read.
--
-- Policy names all begin with 'S1 ' so this file's work can be identified -- and rolled back -- as
-- a set.

do $$
declare
  target text;

  -- TIER 1 -- OWNER ONLY. The default for Product Lab business data. No automation reads these,
  -- no public surface reads these, and nothing in this repository's runtime touches them with any
  -- credential other than the owner's browser session.
  owner_only constant text[] := array[
    'ingredient_aliases',              -- inventory: alias resolution table
    'purchase_imports',                -- purchases: supplier receipts
    'purchase_import_rows',            -- purchases: 386 rows of line-item supplier pricing
    'inventory_transactions',          -- inventory: the full stock ledger
    'equipment',                       -- costing inputs: owned equipment and depreciation
    'costing_entries',                 -- costing: per-ingredient cost lines (the recipe economics)
    'batch_photos',                    -- proof/batch photo metadata, incl. storage paths
    'content_drafts',                  -- unpublished marketing drafts
    'ai_reviews',                      -- owner-only AI review notes
    'selling_format_packaging_lines',  -- packaging cost breakdown behind a selling price
    'customers'                        -- PII. See section 3 for the ONE narrow exception.
  ];

  -- TIER 2 -- OWNER WRITES, WORKER READS. Every entry here is justified by a specific line of
  -- runtime code, cited in the header. The worker gets SELECT and nothing else.
  worker_read constant text[] := array[
    'ingredients',        -- marketing-advisor-read.ts:100, creative-ai-grounding.ts:110
    'content_journal',    -- marketing-advisor-read.ts:101, creative-ai-grounding.ts:111
    'supply_entries',     -- daily-advisor/supabase-read.ts:137
    'tasting_feedback',   -- daily-advisor/supabase-read.ts:136
    'brand_profiles'      -- creative-ai-grounding.ts:113
  ];

  -- TIER 3 -- THE CATALOG. Read by the owner, the worker AND the public-order principal; written
  -- by the owner alone. This is what stops the website account editing or deleting the catalog,
  -- which today it can do.
  catalog constant text[] := array[
    'products',           -- public-catalog-repository.ts:58, daily-advisor:133, marketing:99, grounding:109
    'product_batches',    -- public-catalog-repository.ts:59, daily-advisor:134
    'costing_summaries',  -- public-catalog-repository.ts:60, daily-advisor:135
    'selling_formats'     -- public-catalog-repository.ts:61
  ];
begin
  -- Drop every permissive policy this file replaces, by its exact shipped name. Anything that is
  -- NOT dropped here and is still permissive is caught by the postflight in section 6 -- which is
  -- the point: an unknown permissive policy must fail the run loudly, not be silently overwritten.
  foreach target in array owner_only || worker_read || catalog loop
    execute format('drop policy if exists %I on public.%I', 'Authenticated users can manage ' || target, target);
  end loop;

  -- The shipped names that do not follow the table-name pattern above.
  drop policy if exists "Authenticated users can manage ingredient aliases" on public.ingredient_aliases;
  drop policy if exists "Authenticated users can manage purchase imports" on public.purchase_imports;
  drop policy if exists "Authenticated users can manage purchase import rows" on public.purchase_import_rows;
  drop policy if exists "Authenticated users can manage inventory transactions" on public.inventory_transactions;
  drop policy if exists "Authenticated users can manage costing entries" on public.costing_entries;
  drop policy if exists "Authenticated users can manage batch photos" on public.batch_photos;
  drop policy if exists "Authenticated users can manage content drafts" on public.content_drafts;
  drop policy if exists "Authenticated users can manage selling format packaging lines" on public.selling_format_packaging_lines;
  drop policy if exists "Authenticated users can manage supply entries" on public.supply_entries;
  drop policy if exists "Authenticated users can manage tasting feedback" on public.tasting_feedback;
  drop policy if exists "Authenticated users can manage content journal" on public.content_journal;
  drop policy if exists "Authenticated users can manage brand profiles" on public.brand_profiles;
  drop policy if exists "Authenticated users can manage product batches" on public.product_batches;
  drop policy if exists "Authenticated users can manage costing summaries" on public.costing_summaries;
  drop policy if exists "Authenticated users can manage selling formats" on public.selling_formats;
  drop policy if exists "Authenticated users can read products" on public.products;

  -- Idempotency: drop this file's own policies before recreating them.
  foreach target in array owner_only || worker_read || catalog loop
    execute format('drop policy if exists %I on public.%I', 'S1 owner manages ' || target, target);
    execute format('drop policy if exists %I on public.%I', 'S1 reads ' || target, target);
    execute format('drop policy if exists %I on public.%I', 'S1 owner inserts ' || target, target);
    execute format('drop policy if exists %I on public.%I', 'S1 owner updates ' || target, target);
    execute format('drop policy if exists %I on public.%I', 'S1 owner deletes ' || target, target);
  end loop;

  -- TIER 1.
  foreach target in array owner_only loop
    execute format(
      'create policy %I on public.%I for all to authenticated using (public.is_product_lab_owner()) with check (public.is_product_lab_owner())',
      'S1 owner manages ' || target, target);
  end loop;

  -- TIER 2 and TIER 3 share the write half; only the read predicate differs.
  foreach target in array worker_read loop
    execute format('create policy %I on public.%I for select to authenticated using (public.is_creative_domain_principal())', 'S1 reads ' || target, target);
  end loop;

  foreach target in array catalog loop
    execute format('create policy %I on public.%I for select to authenticated using (public.is_catalog_read_principal())', 'S1 reads ' || target, target);
  end loop;

  foreach target in array worker_read || catalog loop
    execute format('create policy %I on public.%I for insert to authenticated with check (public.is_product_lab_owner())', 'S1 owner inserts ' || target, target);
    execute format('create policy %I on public.%I for update to authenticated using (public.is_product_lab_owner()) with check (public.is_product_lab_owner())', 'S1 owner updates ' || target, target);
    execute format('create policy %I on public.%I for delete to authenticated using (public.is_product_lab_owner())', 'S1 owner deletes ' || target, target);
  end loop;
end $$;

-- TIER 4 -- opportunities. The one business table the worker genuinely WRITES: the daily advisor
-- produces Opportunity rows and updates their status (opportunity-persistence.ts:102,110,168).
-- Owner + creative_worker, full access. Written out rather than looped because it is the single
-- exception to "the worker never writes business data" and deserves to be visible as one.
drop policy if exists "Authenticated users can manage opportunities" on public.opportunities;
drop policy if exists "S1 creative domain manages opportunities" on public.opportunities;
create policy "S1 creative domain manages opportunities"
  on public.opportunities for all
  to authenticated
  using (public.is_creative_domain_principal())
  with check (public.is_creative_domain_principal());

-- --------------------------------------------------------------------------------------------
-- 3. The ordering domain.
-- --------------------------------------------------------------------------------------------
--
-- Hand-written, not looped: each of the three tables needs a different set of verbs, and the
-- differences ARE the security decision.
--
-- What the website principal actually does, traced rather than guessed:
--
--   src/app/order/page.tsx:51            loadPublicCatalog  -> catalog SELECT (section 2, tier 3)
--   public-order-service.ts:87           getOrderDetail     -> orders SELECT
--   public-order-service.ts:118          submitPublicOrderOnce
--     -> rpc save_public_order_once      -> orders SELECT (the existence check under the lock)
--                                        -> customers INSERT ... ON CONFLICT DO UPDATE
--                                        -> save_order: orders INSERT ... ON CONFLICT DO UPDATE
--                                                       order_lines INSERT ... ON CONFLICT DO UPDATE
--
-- and nothing else. In particular:
--
--   * It never DELETEs. save_order's delete branch is guarded by
--     `array_length(p_removed_line_ids, 1) is not null`, and the public path passes an empty
--     array (public-order-service.ts -> savePublicOrderOnce -> `array[]::uuid[]`). So the website
--     principal gets no DELETE anywhere in this domain -- it cannot erase an order or a customer.
--
--   * It DOES get SELECT on `customers` and `order_lines` -- and this is worth stating plainly,
--     because the first draft of this file withheld both.
--
--     Neither table is ever read by the application on the public path: the website principal
--     upserts a customer by an id it derived itself and inserts lines it just built. Withholding
--     SELECT looked free, and it is the most valuable thing to withhold -- `customers` holds the
--     name, phone, messaging handle and email of every person who has ever ordered.
--
--     PostgreSQL does not allow it. `INSERT ... ON CONFLICT DO UPDATE` requires a SELECT policy on
--     the target table that PASSES for the row being written -- not only when a row actually
--     conflicts, and not only when there is a RETURNING clause. Both save_public_order_once
--     (customers) and save_order (order_lines) use that form. Measured, in isolation, on
--     postgres:16:
--
--         no SELECT policy at all      -> ERROR: new row violates row-level security policy
--         SELECT policy using (false)  -> ERROR: new row violates row-level security policy
--         SELECT policy using (true)   -> INSERT 0 1
--
--     The error names the WITH CHECK expression, which is misleading; the cause is the SELECT
--     policy. A row-scoped predicate is no help either, because a brand-new customer has no order
--     to scope against yet, so any such predicate is false at exactly the moment it is evaluated.
--
--     So the SELECT is granted, deliberately and with its reason recorded. The alternative --
--     rewriting save_public_order_once to avoid the upsert -- is a change to the ordering
--     architecture, which SECURITY S1 is explicitly not doing. The residual exposure (a compromised
--     website principal can read the customer list) is reported as remaining debt, and
--     tests/smoke/postgres/owner-data-rls.smoke.test.ts asserts that the policy is LOAD-BEARING:
--     it removes the policy, proves public ordering breaks, and puts it back. Nobody can delete it
--     believing it was decorative, and nobody should widen it believing it was free.
--
--   * It still never DELETEs, and it still cannot read a single row of Product Lab business data.

drop policy if exists "Authenticated users can manage customers" on public.customers;
drop policy if exists "Authenticated users can manage orders" on public.orders;
drop policy if exists "Authenticated users can manage order lines" on public.order_lines;

drop policy if exists "S1 owner manages orders" on public.orders;
drop policy if exists "S1 owner manages order_lines" on public.order_lines;
drop policy if exists "S1 public order reads orders" on public.orders;
drop policy if exists "S1 public order inserts orders" on public.orders;
drop policy if exists "S1 public order updates orders" on public.orders;
drop policy if exists "S1 public order reads customers" on public.customers;
drop policy if exists "S1 public order inserts customers" on public.customers;
drop policy if exists "S1 public order updates customers" on public.customers;
drop policy if exists "S1 public order reads order_lines" on public.order_lines;
drop policy if exists "S1 public order inserts order_lines" on public.order_lines;
drop policy if exists "S1 public order updates order_lines" on public.order_lines;

-- customers: the owner owns it outright. (The tier-1 loop in section 2 already created
-- "S1 owner manages customers".) The website principal gets the three verbs the upsert needs --
-- select included, for the ON CONFLICT reason argued at length above.
create policy "S1 public order reads customers"
  on public.customers for select
  to authenticated
  using (public.is_public_order_principal());

create policy "S1 public order inserts customers"
  on public.customers for insert
  to authenticated
  with check (public.is_public_order_principal());

create policy "S1 public order updates customers"
  on public.customers for update
  to authenticated
  using (public.is_public_order_principal())
  with check (public.is_public_order_principal());

-- orders: owner full; website principal reads (replay + existence check), inserts and updates.
create policy "S1 owner manages orders"
  on public.orders for all
  to authenticated
  using (public.is_product_lab_owner())
  with check (public.is_product_lab_owner());

create policy "S1 public order reads orders"
  on public.orders for select
  to authenticated
  using (public.is_public_order_principal());

create policy "S1 public order inserts orders"
  on public.orders for insert
  to authenticated
  with check (public.is_public_order_principal());

create policy "S1 public order updates orders"
  on public.orders for update
  to authenticated
  using (public.is_public_order_principal())
  with check (public.is_public_order_principal());

-- order_lines: owner full; website principal reads (ON CONFLICT), inserts and updates. No delete.
create policy "S1 owner manages order_lines"
  on public.order_lines for all
  to authenticated
  using (public.is_product_lab_owner())
  with check (public.is_product_lab_owner());

create policy "S1 public order reads order_lines"
  on public.order_lines for select
  to authenticated
  using (public.is_public_order_principal());

create policy "S1 public order inserts order_lines"
  on public.order_lines for insert
  to authenticated
  with check (public.is_public_order_principal());

create policy "S1 public order updates order_lines"
  on public.order_lines for update
  to authenticated
  using (public.is_public_order_principal())
  with check (public.is_public_order_principal());

-- --------------------------------------------------------------------------------------------
-- 4. Storage: the batch-photos bucket.
-- --------------------------------------------------------------------------------------------
--
-- The bucket is PUBLIC (supabase-add-batch-photos-storage.sql sets public = true) so the app can
-- use getPublicUrl() with no signed-URL refresh logic. Public reads go through Storage's public
-- object endpoint, which does not consult storage.objects RLS -- so tightening the policy below
-- does NOT break any image the owner app or the public order page displays.
--
-- What it DOES stop is the write side, which was wide open. `to authenticated using (bucket_id =
-- 'batch-photos')` let every signed-in principal -- the website account and both unexplained
-- accounts included -- list, upload, overwrite and DELETE the owner's proof-day photographs. Live
-- on 2026-08-20 the public-order principal could list the bucket's contents.
--
-- Only src/app/product-lab.tsx writes here (lines 987, 1001, 1031), and only the owner reaches it.
--
-- Scoped strictly to this bucket_id. Wave B's `generated-assets` policy is a separate policy on
-- the same table and is NOT touched.

drop policy if exists "Authenticated users can manage batch photo files" on storage.objects;
drop policy if exists "S1 owner manages batch photo files" on storage.objects;
create policy "S1 owner manages batch photo files"
  on storage.objects for all
  to authenticated
  using (bucket_id = 'batch-photos' and public.is_product_lab_owner())
  with check (bucket_id = 'batch-photos' and public.is_product_lab_owner());

-- --------------------------------------------------------------------------------------------
-- 5. RPC EXECUTE boundaries.
-- --------------------------------------------------------------------------------------------
--
-- Every function in this schema is `security invoker`, so RLS is respected inside them and
-- section 2 already closes the data path: an inventory RPC called by a non-owner now finds nothing
-- to read and cannot write. There is no SECURITY DEFINER function anywhere in this repository.
--
-- The remaining gap is EXECUTE itself. PostgreSQL grants EXECUTE on a new function to PUBLIC by
-- default, so `create function` alone leaves these callable by `anon`. save_order's author already
-- made this argument in supabase-add-orders.sql and fixed it there:
--
--     "That indirect denial is real but it is not the intended boundary. [...] Relying on the
--      table grants to hold the line means any future change to those grants silently widens who
--      can execute this function."
--
-- The same fix, applied to the owner-domain RPCs that never received it. Revoke from PUBLIC, grant
-- to authenticated. Nothing an authenticated principal could legitimately do changes.
--
-- Done by signature lookup rather than by hardcoded argument lists, because confirm_purchase_import
-- exists in two signatures (supabase-add-inventory.sql and supabase-add-purchase-import-packages.sql
-- each define one) and a hardcoded list would silently miss whichever is not installed.

do $$
declare
  target record;
begin
  for target in
    select procedure.oid::regprocedure as signature
    from pg_proc procedure
    join pg_namespace namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'public'
      and procedure.proname in (
        'apply_inventory_adjustment',
        'confirm_purchase_import',
        'confirm_bake',
        'save_supply_with_inventory_effect',
        'delete_supply_with_inventory_effect',
        'repair_supply_inventory_effects',
        'create_batch_with_costing'
      )
  loop
    execute format('revoke execute on function %s from public', target.signature);
    execute format('grant execute on function %s to authenticated', target.signature);
    raise notice 'EXECUTE narrowed to authenticated: %', target.signature;
  end loop;
end $$;

-- --------------------------------------------------------------------------------------------
-- 6. Postflight. Asserts the shape rather than trusting it.
-- --------------------------------------------------------------------------------------------

do $$
declare
  permissive_count integer;
  offender text;
  hardened_tables constant text[] := array[
    'products', 'product_batches', 'batch_photos', 'costing_entries', 'costing_summaries',
    'tasting_feedback', 'content_journal', 'supply_entries', 'equipment', 'ai_reviews',
    'ingredients', 'ingredient_aliases', 'purchase_imports', 'purchase_import_rows',
    'inventory_transactions', 'brand_profiles', 'content_drafts', 'selling_formats',
    'selling_format_packaging_lines', 'opportunities', 'customers', 'orders', 'order_lines'
  ];
begin
  -- 6a. No `using (true)` / `with check (true)` may survive on any table this file hardened --
  -- including one created by a file this repository does not know about.
  select count(*) into permissive_count
  from pg_policies
  where schemaname = 'public'
    and tablename = any(hardened_tables)
    and (coalesce(qual, '') = 'true' or coalesce(with_check, '') = 'true');

  if permissive_count > 0 then
    select string_agg(tablename || '.' || policyname, ', ')
      into offender
    from pg_policies
    where schemaname = 'public'
      and tablename = any(hardened_tables)
      and (coalesce(qual, '') = 'true' or coalesce(with_check, '') = 'true');
    raise exception 'Hardening incomplete: % permissive policy expression(s) remain -- %', permissive_count, offender;
  end if;

  -- 6b. Every hardened table must still HAVE a policy. A table with RLS on and no policy denies
  -- everyone including the owner, which would be a silent outage rather than a security win.
  for offender in
    select candidate
    from unnest(hardened_tables) as candidate
    where not exists (select 1 from pg_policies where schemaname = 'public' and tablename = candidate)
  loop
    raise exception 'Table public.% has RLS enabled and NO policy -- the owner is locked out. Investigate before continuing.', offender;
  end loop;

  -- 6c. Wave B must be untouched. This file changes nothing in the creative domain, and if it has,
  -- that is a defect in this file.
  select count(*) into permissive_count
  from pg_policies
  where schemaname = 'public'
    and tablename in ('creative_jobs', 'creative_job_attempts', 'creative_packages',
                      'asset_jobs', 'asset_job_attempts', 'assets', 'asset_files')
    and (coalesce(qual, '') = 'true' or coalesce(with_check, '') = 'true');

  if permissive_count > 0 then
    raise exception 'Wave B regression: % permissive policy expression(s) appeared on the creative/production tables.', permissive_count;
  end if;

  -- 6d. The permissive batch-photos storage policy must be gone, and generated-assets must NOT be.
  if exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'Authenticated users can manage batch photo files'
  ) then
    raise exception 'Hardening incomplete: the permissive batch-photos storage policy still exists.';
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'Creative domain principals manage generated asset files'
  ) then
    raise exception 'Wave B regression: the generated-assets storage policy is missing.';
  end if;

  raise notice 'SECURITY S1 owner-data RLS hardening verified.';
  raise notice '---';
  raise notice 'NOT FINISHED. S1 is the historical stage, not the current authorization state.';
  raise notice 'Now apply supabase-narrow-s1-least-privilege.sql (SECURITY S1.1) to remove the four';
  raise notice 'privileges this file creates that production no longer grants: public_order UPDATE on';
  raise notice 'orders and order_lines, creative_worker DELETE on opportunities, and is_ordering_principal().';
end $$;

-- Post-apply inspection (read-only; run separately if you want to eyeball the result):
--
--   select tablename, policyname, cmd, qual, with_check
--   from pg_policies
--   where schemaname = 'public' and policyname like 'S1 %'
--   order by tablename, cmd, policyname;
--
--   select p.oid::regprocedure as signature,
--          has_function_privilege('anon',  p.oid, 'execute') as anon_can_execute,
--          has_function_privilege('authenticated', p.oid, 'execute') as authenticated_can_execute
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'public' and p.prokind = 'f'
--   order by 1;
