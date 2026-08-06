-- Brand Foundation MVP (see PROP-032 in planning/PROPOSALS.md and MARKETING_MODULE.md's "M1-UI
-- implementation record"). Adds the small set of fields the Brand Foundation page needs on top of
-- the existing brand_profiles table (PROP-012) -- no new table, no Storage bucket. Run this once
-- (or again, it's idempotent) in the Supabase SQL editor.
--
-- brand_status describes the maturity of the branding *decisions themselves* (Exploring /
-- Provisional / Final), not the business's operating stage -- distinct from any future
-- business-lifecycle field.
--
-- brand_guidelines is one freeform field covering overall aesthetic, photography style, design
-- keywords, mood, inspiration, and things to avoid -- deliberately one textarea, not five separate
-- columns, per the approved MVP scope.
--
-- No default is set for background_color/accent_color: this app has no approved hex palette on
-- record anywhere (only color *names* in docs/BRAND_BIBLE_V1.md), so these stay null/unset until
-- Aly or Shin picks real values in the UI, rather than guessing at hex codes here.

alter table brand_profiles add column if not exists brand_status text not null default 'Exploring';
alter table brand_profiles add column if not exists background_color text;
alter table brand_profiles add column if not exists accent_color text;
alter table brand_profiles add column if not exists brand_guidelines text;
