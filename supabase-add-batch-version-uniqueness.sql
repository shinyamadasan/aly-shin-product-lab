-- Run once in the Supabase SQL editor. Safe to run more than once (idempotent).
--
-- IMPORTANT: run supabase-check-batch-duplicates.sql FIRST and confirm it returns 0 rows
-- (or that every returned group has been manually reconciled) before running this file.
--
-- Prevents two product_batches rows from existing for the same product with the same batch
-- version, compared with whitespace trimmed and case ignored -- see PRODUCT_LAB_CONTEXT.md's
-- Batches section. Mirrors the existing expression-index pattern already used in this repo
-- (ingredients_name_unique_idx).

create unique index if not exists product_batches_version_unique_idx
  on product_batches (product_id, lower(trim(batch_version)));
