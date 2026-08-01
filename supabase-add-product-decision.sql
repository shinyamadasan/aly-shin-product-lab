-- Products become an app-editable entity (Add/Edit/Delete on the Product Admin page) instead of
-- the hardcoded src/lib/sample-data.ts array. The products table already exists and already has
-- every other Product field (name, category, product_role, status, description, main_photo_url)
-- -- this migration adds the one field it was missing: decision.
--
-- Safe to run more than once (add column if not exists). Purely additive: no column dropped, no
-- existing row changed. Defaults to 'Needs proof' (not null) so every existing seeded row (and any
-- row inserted before this migration runs) reads as a valid decision, matching the same value new
-- products get from the Add Product form.
--
-- Deliberately a plain text column, not a check constraint or enum -- matches this app's existing
-- convention for classification columns (see product_role/status on this same table, entry_type on
-- content_journal, launch_decision on product_batches). The TypeScript union
-- ("Needs proof" | "Retest" | "Candidate" | "Add-on test") is the source of truth for allowed
-- values, not the database.

alter table products add column if not exists decision text not null default 'Needs proof';
