-- Closes the one gap left in the ingredient hard-delete guard's defense-in-depth (see the
-- ingredient_hard_delete_guard migration): supply_entries.ingredient_id is the only
-- ingredient-referencing column with no foreign key at all. hard_delete_ingredient_if_unreferenced
-- already blocks a delete whenever any supply_entries row currently points at the target
-- ingredient, but that check and the DELETE statement are not the same instant -- without a real
-- FK, a new purchase logged for this ingredient in the split second between them would have
-- nothing at the database level stopping the delete from proceeding anyway, orphaning that new row.
--
-- Added NOT VALID, on purpose: this constraint is enforced for every write from the moment this
-- migration runs onward -- which is exactly what closes the race above -- but Postgres does NOT
-- check it against rows that already exist in supply_entries. Whether any pre-existing row would
-- fail it (a dangling ingredient_id pointing at an ingredient that no longer exists, most plausibly
-- from before this column had any real matching behind it) is unknown until
-- supabase-check-supply-entries-ingredient-fk.sql (read-only) is run and its results reviewed by
-- hand. Only after that should anyone consider running
-- `alter table supply_entries validate constraint supply_entries_ingredient_id_fkey;` -- a separate,
-- deliberate, later step, not part of this migration. Until that validate step runs, this migration
-- makes no claim about historical data -- it only protects new writes.
--
-- ON DELETE RESTRICT matches inventory_transactions' existing FK and the guard's own intent: a real
-- purchase reference should block the delete outright, never silently disappear or get nulled out.
--
-- Idempotent: drop-by-lookup-then-recreate, safe to run more than once.
do $$
declare
  constraint_name text;
begin
  select tc.constraint_name
  into constraint_name
  from information_schema.table_constraints tc
  join information_schema.key_column_usage kcu
    on tc.constraint_schema = kcu.constraint_schema
    and tc.constraint_name = kcu.constraint_name
  join information_schema.constraint_column_usage ccu
    on tc.constraint_schema = ccu.constraint_schema
    and tc.constraint_name = ccu.constraint_name
  where tc.table_schema = 'public'
    and tc.table_name = 'supply_entries'
    and tc.constraint_type = 'FOREIGN KEY'
    and kcu.column_name = 'ingredient_id'
    and ccu.table_name = 'ingredients'
    and ccu.column_name = 'id'
  limit 1;

  if constraint_name is not null then
    execute format('alter table supply_entries drop constraint %I', constraint_name);
  end if;

  alter table supply_entries
    add constraint supply_entries_ingredient_id_fkey
    foreign key (ingredient_id) references ingredients(id) on delete restrict
    not valid;
end $$;

notify pgrst, 'reload schema';
