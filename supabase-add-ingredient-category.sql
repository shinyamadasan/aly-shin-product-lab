-- Adds a category to the ingredient master, for the unified Items view.
--
-- Safe to run more than once (add column if not exists). Purely additive: no column dropped, no
-- existing row changed -- every existing ingredient reads as category = null until edited.
--
-- Deliberately a plain text column, not a check constraint -- matches this app's existing
-- convention for classification columns (see match_method, row_status, launch_decision elsewhere
-- in this schema). The controlled set of values is enforced by the app's <select>, not the
-- database: ingredient | packaging | consumable | other. "equipment" is intentionally not one of
-- them -- Equipment already has its own table and workflow.

alter table ingredients add column if not exists category text;
