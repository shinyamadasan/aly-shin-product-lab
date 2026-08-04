-- Migration sequence for Costing duplicate protection:
--
--   supabase-check-costing-duplicates.sql  (read-only, run first)
--                     |
--                     v
--            zero rows returned?
--                     |
--                     v
--   supabase-add-costing-batch-uniqueness.sql  (this file, creates the unique indexes)
--
-- Run once in the Supabase SQL editor. Safe to run more than once (idempotent).
--
-- IMPORTANT: run supabase-check-costing-duplicates.sql FIRST and confirm it returns 0 rows
-- (or that every returned group has been manually reconciled) before running this file.
--
-- Prevents two costing_summaries rows from existing for the same batch, or (for legacy
-- costings saved before batch-scoping existed) two unlinked costings for the same product --
-- see PRODUCT_LAB_CONTEXT.md's Costing section: "Costing is scoped to a specific proof
-- batch/version, not just a product." Mirrors the existing partial-unique-index pattern
-- already used in this repo (brand_profiles_only_one_active_idx).

create unique index if not exists costing_summaries_batch_unique_idx
  on costing_summaries (batch_id)
  where batch_id is not null;

create unique index if not exists costing_summaries_product_unlinked_unique_idx
  on costing_summaries (product_id)
  where batch_id is null;
