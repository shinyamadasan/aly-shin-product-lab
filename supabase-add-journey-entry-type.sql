-- Journey / content_journal readiness (M2A) -- see MARKETING_MODULE.md's "Journey /
-- content_journal Readiness Audit" section for the full analysis. content_journal is
-- becoming the canonical Journey persistence table; no separate journey_entries table
-- is created, now or later.
--
-- Safe to run more than once (add column if not exists). Purely additive: no column
-- dropped, no existing row changed, no backfill -- every existing entry reads as
-- entry_type = null until classified. Null means legacy or unclassified, not a real
-- "no type" value.
--
-- Deliberately a plain nullable text column, not a check constraint or enum -- matches
-- this app's existing convention for classification columns (see category on
-- ingredients in supabase-add-ingredient-category.sql, plus match_method, row_status,
-- and launch_decision elsewhere in this schema). The controlled set of values (e.g.
-- recipe_test, equipment, construction, coffee_experiment, mistake_lesson, team_update,
-- daily_progress, other) is a UI/TypeScript-layer concern for a later milestone (M2B),
-- not enforced by the database here.

alter table content_journal add column if not exists entry_type text;
