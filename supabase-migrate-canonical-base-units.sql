-- Canonical-unit migration: ingredients.base_unit is being restricted from five values
-- (g, kg, ml, L, pcs) to exactly three canonical units (g, ml, pcs) -- mass, volume, and count.
-- kg/L remain valid *purchase/recipe input* units forever (converted before ever touching
-- inventory, via unit-conversion.ts's convertToBaseUnit); they are simply no longer valid as an
-- ingredient's own stored base_unit, since letting the canonical unit itself be ambiguous (kg vs
-- g) was the root cause of a class of silent bugs across unit-conversion.ts, supplies.ts, and
-- purchase-history.ts.
--
-- Idempotent: kg/L rows are rescaled and their base_unit flipped to g/ml in the same statement, so
-- a second run's own `where base_unit = 'kg'/'L'` predicate matches zero rows and the ledger
-- rescale (scoped to exactly the ids converted in *this* run, not "any historically-migrated
-- ingredient") touches nothing. Safe to run more than once.
--
-- Never touches supply_entries or purchase_import_rows -- those are purchase history / import
-- audit trail and must keep their original package_count/package_size/package_unit/price/unit
-- exactly as entered, forever. Only two things are normalized: the inventory effect
-- (ingredients.current_quantity, inventory_transactions' ledger quantities) and cost per canonical
-- unit (ingredients.average_unit_cost).

alter table ingredients
  add column if not exists base_unit_migrated_from text,
  add column if not exists base_unit_migrated_at timestamptz,
  add column if not exists base_unit_migration_flagged_reason text;

do $$
declare
  v_kg_ids uuid[];
  v_l_ids uuid[];
begin
  -- 1. Flag ambiguous rows first, and never overwrite an existing flag -- if an operator has
  --    manually reconciled a row and cleared its flag, a re-run must not reflag it. Flagged rows
  --    are excluded from the rescale below, isolated for manual review rather than guessed at.
  update ingredients
  set base_unit_migration_flagged_reason = 'unrecognized_base_unit:' || base_unit
  where base_unit not in ('g', 'kg', 'ml', 'L', 'pcs')
    and base_unit_migration_flagged_reason is null;

  update ingredients
  set base_unit_migration_flagged_reason = 'non_finite_numeric_field'
  where base_unit in ('kg', 'L')
    and (current_quantity is null or current_quantity = 'NaN'::numeric or average_unit_cost = 'NaN'::numeric)
    and base_unit_migration_flagged_reason is null;

  -- 2. Rescale kg -> g. A null average_unit_cost (never priced yet) stays null -- it is not
  --    flagged above and must never be coalesced to zero, which would fabricate a cost basis that
  --    was never there. Capturing exactly which ids this statement touched (not re-deriving them
  --    from base_unit afterward, which would already read 'g') is what lets step 4 scope the
  --    ledger rescale correctly on every run, including a no-op second run.
  with kg_targets as (
    select id, current_quantity, average_unit_cost
    from ingredients
    where base_unit = 'kg'
      and base_unit_migration_flagged_reason is null
  ), updated as (
    update ingredients i
    set current_quantity = t.current_quantity * 1000,
        average_unit_cost = t.average_unit_cost / 1000,
        base_unit = 'g',
        base_unit_migrated_from = 'kg',
        base_unit_migrated_at = now(),
        updated_at = now()
    from kg_targets t
    where i.id = t.id
    returning i.id
  )
  select coalesce(array_agg(id), array[]::uuid[]) into v_kg_ids from updated;

  -- 3. Rescale L -> ml, same shape.
  with l_targets as (
    select id, current_quantity, average_unit_cost
    from ingredients
    where base_unit = 'L'
      and base_unit_migration_flagged_reason is null
  ), updated as (
    update ingredients i
    set current_quantity = t.current_quantity * 1000,
        average_unit_cost = t.average_unit_cost / 1000,
        base_unit = 'ml',
        base_unit_migrated_from = 'L',
        base_unit_migrated_at = now(),
        updated_at = now()
    from l_targets t
    where i.id = t.id
    returning i.id
  )
  select coalesce(array_agg(id), array[]::uuid[]) into v_l_ids from updated;

  -- 4. Rescale the ledger for exactly the ingredients converted in *this* run. On a re-run,
  --    step 2/3's own `where base_unit = 'kg'/'L'` predicate matches zero rows (base_unit is
  --    already canonical), so v_kg_ids/v_l_ids are empty and this update touches nothing --
  --    that's the idempotency mechanism, not a separate marker check.
  update inventory_transactions
  set quantity_change = quantity_change * 1000,
      quantity_before = quantity_before * 1000,
      quantity_after = quantity_after * 1000
  where ingredient_id = any(v_kg_ids) or ingredient_id = any(v_l_ids);
end $$;

-- Enforced on every new write immediately; NOT VALID means it never scans/fails against
-- pre-existing flagged rows, so this migration can never be aborted by data it isolated rather
-- than converted. Once every base_unit_migration_flagged_reason row has been manually reconciled,
-- run separately, by hand:
--   alter table ingredients validate constraint ingredients_base_unit_check;
do $$
begin
  if not exists (
    select 1 from information_schema.table_constraints
    where table_schema = 'public'
      and table_name = 'ingredients'
      and constraint_name = 'ingredients_base_unit_check'
  ) then
    alter table ingredients
      add constraint ingredients_base_unit_check
      check (base_unit in ('g', 'ml', 'pcs'))
      not valid;
  end if;
end $$;

notify pgrst, 'reload schema';
