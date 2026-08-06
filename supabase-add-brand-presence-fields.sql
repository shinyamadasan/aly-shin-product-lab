-- Brand Foundation MVP, small enhancement: Brand Presence (see PROP-033 in
-- planning/PROPOSALS.md and MARKETING_MODULE.md's "M1-UI Brand Presence implementation
-- record"). Adds Aly & Pon's canonical online-presence fields to the same brand_profiles
-- table (PROP-012, PROP-032) -- no new table, no Storage bucket. Run this once (or again,
-- it's idempotent) in the Supabase SQL editor.
--
-- Flat columns, not a jsonb list: this table's every other field is a flat column, and the
-- set of platforms here is small and known (Website, Email, Facebook, Instagram, TikTok,
-- YouTube) rather than open-ended -- jsonb in this schema is reserved for genuinely
-- variable-shaped/opaque payloads (see asset_jobs.result, opportunities.evidence). The
-- reusability the owner asked for is implemented at the app/UI layer instead (a small
-- internal "brand link" render model in src/components/brand-foundation-page.tsx), so
-- adding a future platform (Threads, Pinterest, LinkedIn, a menu link) is still a small,
-- additive change here -- one migration adding that platform's 1-2 columns -- not a
-- redesign of this table or the page.
--
-- Each social platform stores its display handle and its destination URL separately, per
-- the owner's explicit instruction not to assume URL formats: the UI shows only the handle
-- (e.g. "@alyandpon"), the URL is used only when that handle is clicked.
--
-- website_url/email/preferred_handle have no separate "handle" column -- a website has one
-- URL (its own text is both the display value and the destination); an email address is
-- itself the display value (the mailto: link is derived at render/click time, never
-- stored); preferred_handle is a plain reference value with no destination to click.

alter table brand_profiles add column if not exists website_url text;
alter table brand_profiles add column if not exists email text;
alter table brand_profiles add column if not exists preferred_handle text;
alter table brand_profiles add column if not exists facebook_handle text;
alter table brand_profiles add column if not exists facebook_url text;
alter table brand_profiles add column if not exists instagram_handle text;
alter table brand_profiles add column if not exists instagram_url text;
alter table brand_profiles add column if not exists tiktok_handle text;
alter table brand_profiles add column if not exists tiktok_url text;
alter table brand_profiles add column if not exists youtube_handle text;
alter table brand_profiles add column if not exists youtube_url text;
