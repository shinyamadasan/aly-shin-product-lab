-- Product Lab MCP: add the three nullable marker columns loadProductLabReadState() already selects
-- on public.ingredients, so inventory_count_preview/apply/verify stop failing with a generic
-- read_failed error caused by a missing column.
--
-- WHY THIS IS SPLIT OUT OF supabase-migrate-canonical-base-units.sql (repo root, historical context
-- only -- not edited or re-run by this migration).
--
-- That older script (committed 2026-08-03) also converts any pre-existing kg/L ingredient to
-- canonical g/ml by updating ingredients.base_unit. Since then, Wave 0A's raw-authority migration
-- (supabase/migrations/20260909132327_selling_wave_0a_raw_authority.sql, 2026-09-10) added
-- inventory_private.protect_base_unit() / trigger raw_inventory_base_unit_guard, which unconditionally
-- rejects any base_unit change on an ingredient that already has inventory_reconciled_at set or any
-- inventory_transactions row -- a reviewed, intentional invariant (confirmed enabled by
-- planning/SELLING_WAVE_0B.md's own review checklist), not a bug. Running the older script's UPDATE
-- against production now fails with 23514 ("Base unit cannot change after inventory history exists")
-- for exactly the ingredients it would touch (observed: Sea Salt, Caramel Biscuit).
--
-- The three marker columns below are the ONLY part of that script inventory_count_preview's
-- loadProductLabReadState() actually needs -- they are pure metadata, never written to by anything
-- in this repo today, and adding them never touches base_unit, so raw_inventory_base_unit_guard never
-- fires. The kg/L conversion itself (and the older script's later NOT VALID CHECK constraint, which
-- would break the very next write to Sea Salt or Caramel Biscuit if added before that conversion is
-- resolved) is a separate, not-yet-designed decision, deliberately left out of this migration.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS. No UPDATE, INSERT, or DELETE. No CHECK constraint. No trigger
-- or RPC change. No row's base_unit, current_quantity, average_unit_cost, or ledger history is read
-- or written by this migration.
--
-- Rollback: drop the three columns (all nullable, never written to by application code, so nothing
-- depends on their presence except this one SELECT list):
--   alter table public.ingredients
--     drop column if exists base_unit_migrated_from,
--     drop column if exists base_unit_migrated_at,
--     drop column if exists base_unit_migration_flagged_reason;

alter table public.ingredients
  add column if not exists base_unit_migrated_from text,
  add column if not exists base_unit_migrated_at timestamptz,
  add column if not exists base_unit_migration_flagged_reason text;

notify pgrst, 'reload schema';
