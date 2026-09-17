-- Run this FIRST, in the Supabase SQL Editor, before applying
-- supabase/migrations/20260917090200_supply_entries_ingredient_fk.sql (and again before running
-- `alter table supply_entries validate constraint supply_entries_ingredient_id_fkey;` afterward).
-- Safe to run more than once -- read-only, no schema changes.
--
-- supply_entries.ingredient_id has never had a foreign key. This checks what shape the real data
-- is actually in before that constraint is added (not valid, so it cannot fail outright) and
-- before anyone considers validating it against existing rows.

-- 1. Overall shape: how many rows are matched by id versus intentionally unmatched (legacy/
--    name-only rows the hard-delete guard already treats as a name-matched reference, not an id
--    match). Neither category is a problem by itself.
select
  count(*) filter (where ingredient_id is not null) as matched_by_id,
  count(*) filter (where ingredient_id is null) as unmatched_name_only,
  count(*) as total_rows
from supply_entries;

-- 2. Dangling ids: rows whose ingredient_id does not exist in ingredients. These are exactly what
--    would make `validate constraint` fail. If this returns any rows, STOP before validating --
--    resolve each one by hand (most likely: set ingredient_id back to null, which simply folds the
--    row into the existing unmatched/name-only category the guard already checks by name). Do not
--    auto-null or auto-delete anything.
select se.id, se.ingredient_id, se.ingredient_name, se.purchase_date, se.created_at
from supply_entries se
left join ingredients i on i.id = se.ingredient_id
where se.ingredient_id is not null
  and i.id is null
order by se.created_at desc;

-- 3. Not a data-integrity problem (ingredient_name is a frozen purchase-time snapshot, never a
--    live reference) but a directly useful list: every purchase whose stored name no longer
--    matches its matched ingredient's CURRENT name -- i.e. every ingredient that has been renamed
--    since at least one of its purchases was logged. Cross-check this against ingredient_aliases
--    (source = 'rename') to confirm the rename-alias guard (the ingredients_preserve_rename_history
--    trigger) is catching all of them going forward.
select se.id as supply_entry_id, se.ingredient_name as name_at_purchase_time, i.id as ingredient_id, i.name as current_name
from supply_entries se
join ingredients i on i.id = se.ingredient_id
where lower(trim(se.ingredient_name)) <> lower(trim(i.name))
order by se.created_at desc;
