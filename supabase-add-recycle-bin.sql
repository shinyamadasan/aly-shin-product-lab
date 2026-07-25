-- Recycle Bin (soft delete) — run once in the Supabase SQL editor.
--
-- Adds a nullable `deleted_at` timestamp to the user-record tables the Recycle Bin covers.
-- Deleting a record sets `deleted_at`; the app hides those rows from every normal view and lists
-- them in the Recycle Bin, where they can be restored (deleted_at -> null) or removed for good.
--
-- Safe to run more than once (all statements are IF NOT EXISTS). Idempotent and additive: no data
-- is changed, no column is dropped, existing rows get deleted_at = NULL (i.e. "not deleted").
--
-- Scope of v1: single-row records only. Costing (two tables), ingredients/inventory, and batch
-- photos are intentionally NOT covered yet — see PRODUCT_LAB_CONTEXT.md "Recycle Bin".

alter table product_batches add column if not exists deleted_at timestamptz;
alter table supply_entries  add column if not exists deleted_at timestamptz;
alter table equipment       add column if not exists deleted_at timestamptz;
alter table tasting_feedback add column if not exists deleted_at timestamptz;
alter table content_journal add column if not exists deleted_at timestamptz;

-- Partial indexes keep the common "active rows only" scan fast without indexing every row.
create index if not exists idx_product_batches_active on product_batches (created_at) where deleted_at is null;
create index if not exists idx_supply_entries_active  on supply_entries  (created_at) where deleted_at is null;
create index if not exists idx_equipment_active       on equipment       (created_at) where deleted_at is null;
create index if not exists idx_tasting_feedback_active on tasting_feedback (created_at) where deleted_at is null;
create index if not exists idx_content_journal_active on content_journal (created_at) where deleted_at is null;
