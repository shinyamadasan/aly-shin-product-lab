-- SECURITY S1 -- READ-ONLY inventory of every Supabase Auth account and the claim it holds.
--
-- ============================================================================================
-- RUN THIS IN THE SUPABASE SQL EDITOR (Dashboard -> SQL Editor). OWNER EXECUTION ONLY.
-- ============================================================================================
--
-- Follows the same convention as supabase-check-batch-duplicates.sql and
-- supabase-check-costing-duplicates.sql: a `check` file contains SELECTs and nothing else. There is
-- no INSERT, UPDATE, DELETE, DROP or ALTER anywhere below. Running it changes nothing.
--
-- WHY IT IS A FILE AND NOT A SCRIPT.
--
-- `auth.users` is not exposed through PostgREST, so no application credential can read it -- not the
-- anon key, not the owner's own session, not the worker's. Reading it needs either the service-role
-- key or the SQL Editor, and this project has deliberately never created a service-role key (see
-- supabase-assign-owner-app-role.sql). So the roster is something only the owner can pull, and this
-- file is the exact query to pull it with.
--
-- WHY IT MATTERS NOW.
--
-- Wave B recorded that this project holds FIVE Auth accounts: the owner, the advisor/worker
-- automation, the public-order website principal, and TWO with no known purpose. Before SECURITY S1
-- those two could read every Product Lab table -- recipes, costing, inventory, purchases, supplier
-- pricing, the customer list. After it they can read nothing, because they hold no app_role claim
-- and every policy now requires one.
--
-- That closes the exposure. It does not answer the question of why they exist, and an account
-- nobody can account for is still a credential in circulation. Answer it deliberately.
--
-- THIS FILE DOES NOT CHANGE ANYTHING. Deleting, disabling or re-claiming an account is a separate,
-- owner-only decision. Use supabase-assign-owner-app-role.sql STEP 4 to revoke a claim, and the
-- Dashboard (Authentication -> Users) to remove an account.

-- --------------------------------------------------------------------------------------------
-- 1. The roster.
-- --------------------------------------------------------------------------------------------
--
-- Read it as four questions, one per row:
--
--   Do I recognise this account?
--   Does its claim match what I believe it is for?
--   Has it signed in recently, and does that make sense?
--   If I cannot answer the first three, what is it doing in my project?
--
-- `expected_principal` is a reading of the CLAIM, not of the account. An account showing
-- "(no claim -- accounted for?)" is not necessarily wrong; it is necessarily unexplained.

select
  users.email,
  users.raw_app_meta_data ->> 'app_role' as app_role,
  case users.raw_app_meta_data ->> 'app_role'
    when 'owner'           then 'Product Lab owner. A ROLE, not a person -- one or more accounts may hold it, and every holder has identical access.'
    when 'creative_worker' then 'Advisor/worker automation -- .env.advisor.local. Runs daily-advisor, marketing-advisor, creative + asset workers, Creative Prep.'
    when 'public_order'    then 'Public ordering website -- .env.public-order.local, server-only, used by /order and /api/public-orders.'
    else                        '(no claim -- accounted for?)'
  end as expected_principal,
  users.created_at,
  users.last_sign_in_at,
  users.email_confirmed_at is not null as email_confirmed,
  users.banned_until is not null       as currently_banned
from auth.users users
order by
  case users.raw_app_meta_data ->> 'app_role'
    when 'owner' then 1 when 'creative_worker' then 2 when 'public_order' then 3 else 4
  end,
  users.last_sign_in_at desc nulls last;

-- --------------------------------------------------------------------------------------------
-- 2. The invariants, asserted rather than eyeballed.
-- --------------------------------------------------------------------------------------------
--
-- The roster above is easy to skim past. This says outright whether the shape is right.

select
  count(*) filter (where raw_app_meta_data ->> 'app_role' = 'owner')           as owner_accounts,
  count(*) filter (where raw_app_meta_data ->> 'app_role' = 'creative_worker') as worker_accounts,
  count(*) filter (where raw_app_meta_data ->> 'app_role' = 'public_order')    as website_accounts,
  count(*) filter (where raw_app_meta_data ->> 'app_role' is null)             as unclaimed_accounts,
  count(*) filter (where raw_app_meta_data ->> 'app_role' not in ('owner', 'creative_worker', 'public_order')) as unrecognised_claims,
  count(*) as total_accounts
from auth.users;

-- Expected after SECURITY S1 (owner cardinality corrected by SECURITY S1.2):
--
--   owner_accounts      >= 1   AT LEAST ONE. `owner` is a role, not a person: a business with
--                              co-owners assigns the claim to each of their accounts, and every
--                              holder gets identical access. There is no upper bound and no
--                              seniority. ZERO is the failure -- it means nobody can reach Product
--                              Lab at all. This project currently has two, which is a legitimate
--                              observed state and NOT a permanent maximum.
--   worker_accounts      1     the advisor/worker automation
--   website_accounts     1     the public ordering principal
--   unrecognised_claims  0     any other value is a typo or something nobody wrote down
--   unclaimed_accounts   ?     every one of these should have a name and a reason. They can read
--                              nothing after S1, but they can still sign in.
--
-- Every owner_accounts value above zero should still be RECONCILED -- each holder named and
-- accounted for. "More than one is allowed" is not "more than one is unexamined". What changed in
-- S1.2 is that a second legitimate owner is no longer reported as a failed security invariant.
--
-- If unrecognised_claims is not 0, stop and reconcile before trusting any policy in this project:
-- a claim value nobody recognises is a claim nobody has reviewed. That check is UNCHANGED and is
-- not weakened by the owner-count correction above.

-- --------------------------------------------------------------------------------------------
-- 3. Is any account referenced by this repository's configuration?
-- --------------------------------------------------------------------------------------------
--
-- The database cannot answer this one. Check it by hand, against the checkout, and note that NONE
-- of these files is committed -- they are gitignored, local-only credential files:
--
--   .env.advisor.local        ADVISOR_SUPABASE_EMAIL       -> should be the 'creative_worker' row
--   .env.public-order.local   PUBLIC_ORDER_SUPABASE_EMAIL  -> should be the 'public_order' row
--   Vercel project env        PUBLIC_ORDER_SUPABASE_EMAIL  -> must be the SAME account as above
--
-- The owner's own account appears in no file anywhere, by design: it signs in through the browser.
--
-- An account in the roster that matches none of the above, and is not the owner's own sign-in, is
-- the thing this section exists to surface.
