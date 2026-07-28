-- Marketing Module M1 (narrowed scope): Brand Profile persistence only. See
-- MARKETING_MODULE.md and planning/PROPOSALS.md (PROP-012) for the full architecture
-- proposal and the owner decisions that narrowed M1 to this table alone. No other
-- Marketing table (campaigns, content drafts, etc.) is created here -- those remain
-- blocked on later decisions. Run this once (or again, it's idempotent) in the
-- Supabase SQL editor.
--
-- Ownership model: this app has no per-user/workspace identity anywhere in its schema
-- today -- every existing table uses `using (true) to authenticated` RLS with no owner
-- column. brand_profiles follows that same, already-established pattern rather than
-- inventing a new one: any authenticated user (Aly or Shin) can read/manage the one
-- shared business profile, exactly like every other table in this app. There is no
-- "another owner's profile" to protect against, because there is only one business.
--
-- Single-active-profile rule: enforced by a partial unique index on is_active, not by a
-- workspace/tenant column -- this business has exactly one active brand at a time, so no
-- scoping dimension is needed. Older profiles can be kept (is_active = false) for history
-- instead of being overwritten in place.
--
-- Logo storage: no Storage bucket is created by this migration. logo_storage_path is a
-- nullable reference column only, storing a path -- never binary image data. A bucket
-- (mirroring the batch-photos pattern in supabase-add-batch-photos-storage.sql) is a
-- separate, later migration once actually needed.

create table if not exists brand_profiles (
  id uuid primary key default gen_random_uuid(),
  business_name text not null,
  short_description text,
  target_audience text,
  brand_voice_notes text,
  primary_cta text,
  preferred_phrases text,
  prohibited_phrases text,
  primary_color text,
  secondary_color text,
  heading_font text,
  body_font text,
  logo_storage_path text,
  social_links text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists brand_profiles_only_one_active_idx
  on brand_profiles (is_active)
  where is_active = true;

alter table brand_profiles enable row level security;

grant select, insert, update, delete on table brand_profiles to authenticated;

drop policy if exists "Authenticated users can manage brand profiles" on brand_profiles;

create policy "Authenticated users can manage brand profiles"
  on brand_profiles for all
  to authenticated
  using (true)
  with check (true);
